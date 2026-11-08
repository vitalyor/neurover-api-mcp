import {randomUUID,createHash} from 'node:crypto';
import {open,access} from 'node:fs/promises';
import {ApiError,privateJson} from './client.js';
import {siteRefused} from './errors.js';
import {draftFile,loadDraft,validateBudget} from './generation.js';
const hash=w=>createHash('sha256').update(JSON.stringify({version:w.version,graph:w.graph})).digest('hex');
async function price(client,item){
 if(item.kind==='workflow_run'){
  let r=await client.http(`/workflows/${item.workflowId}/runs/preview`,{method:'POST',data:item.payload});
  const until=Date.now()+30000;
  while(r.preview?.nodes_to_generate?.some(n=>n.pricing_status==='pricing')&&Date.now()<until){
   for(const n of r.preview.nodes_to_generate)if(n.pricing_status==='pricing'&&n.price_quote_id)await client.http('/price-quotes/'+encodeURIComponent(n.price_quote_id));
   await new Promise(resolve=>setTimeout(resolve,1000));r=await client.http(`/workflows/${item.workflowId}/runs/preview`,{method:'POST',data:item.payload});
  }
  if(r.preview?.startable===false||r.preview?.nodes_to_generate?.some(n=>n.pricing_status==='pricing'))throw new ApiError('not_startable','Run is not ready.',{preview:r.preview});
  const minor=r.preview?.price_summary?.suggested_budget?.credits_minor;
  if(!Number.isSafeInteger(minor)||minor<0)throw new ApiError('quote_unavailable','No valid run budget.');
  return {credits_minor:minor,preview:r.preview};
 }
 let q=await client.http(`/workflows/${item.workflowId}/nodes/${item.nodeId}/prompt-enhancements/price-preview`,{method:'POST'});
 const until=Date.now()+30000;
 while(q.status==='pricing'&&q.price_quote_id&&Date.now()<until){await new Promise(r=>setTimeout(r,1000));q=await client.http('/price-quotes/'+encodeURIComponent(q.price_quote_id));}
 if(!Number.isSafeInteger(q.credits_minor)||q.credits_minor<0||['failed','pricing'].includes(q.status))throw new ApiError('quote_unavailable','Prompt enhancement has no completed quote.');
 return q;
}
export async function prepareJob(client,input,kind){
 const w=(await client.workflow(input.workflowId)).workflow;
 const item={kind,account:client.account,workflowId:input.workflowId,createdAt:Date.now(),requestId:randomUUID(),workflowHash:hash(w)};
 if(kind==='workflow_run')item.payload=input.scope==='all'?{}:{start_node_id:input.nodeId,run_mode:input.scope};
 else {if(!w.graph.nodes.some(n=>n.id===input.nodeId))throw new ApiError('not_found','Node not found.');const p=await client.page(`/workflows/${input.workflowId}`);item.nodeId=input.nodeId;item.modelId=p.workflowSettings?.prompt_enhancement_model_id;if(!item.modelId)throw new ApiError('unavailable','No prompt enhancement model configured.');}
 item.quote=await price(client,item);const token=randomUUID();await privateJson(draftFile(token),item);
 return {status:'prepared',token,kind,workflowId:item.workflowId,estimatedCredits:item.quote.credits_minor/100,quote:item.quote};
}
export async function submitJob(client,token,maxCredits){
 const item=await loadDraft(token);if(item.account!==client.account)throw new ApiError('account_mismatch','Wrong account.');
 if(Date.now()-item.createdAt>600000)throw new ApiError('estimate_expired','Prepare again.');
 const claim=draftFile(token)+'.claimed';try{await access(claim);throw new ApiError('already_submitted','This token has already been used.');}catch(e){if(e.code!=='ENOENT')throw e;}
 const w=(await client.workflow(item.workflowId)).workflow;if(hash(w)!==item.workflowHash)throw new ApiError('workflow_changed','Workflow changed; prepare again.');
 const q=await price(client,item);const budget=validateBudget(q.credits_minor,maxCredits);
 if(q.credits_minor>item.quote.credits_minor)throw new ApiError('price_changed','Estimate increased; prepare again.');
 let payload,url;
 if(item.kind==='workflow_run'){
  const quoteId=q.preview?.nodes_to_generate?.find(n=>n.workflow_node_id===item.payload.start_node_id)?.price_quote_id;
  payload={...item.payload,client_request_id:item.requestId,max_budget_credits_minor:budget,...item.payload.start_node_id?{}:{confirm_all:true},...quoteId?{price_quote_id:quoteId}:{}};
  url=`/workflows/${item.workflowId}/runs`;
 }else{payload={client_request_id:item.requestId,ai_model_id:item.modelId,price_quote_id:q.price_quote_id};url=`/workflows/${item.workflowId}/nodes/${item.nodeId}/prompt-enhancements`;}
 try{const f=await open(claim,'wx',0o600);await f.writeFile(JSON.stringify({status:'submitting',requestId:item.requestId}));await f.close();}catch(e){if(e.code==='EEXIST')throw new ApiError('already_submitted','This token has already been used.');throw e;}
 try{const result=await client.http(url,{method:'POST',data:payload,version:w.version});await privateJson(claim,{status:'submitted',requestId:item.requestId,result});return {status:'submitted',requestId:item.requestId,...result};}
 catch(e){if(siteRefused(e)){await privateJson(claim,{status:'rejected',requestId:item.requestId,cause:e.code});throw new ApiError('submit_rejected',`Neurover refused this request, nothing was started: ${e.message} Fix the cause or wait for running generations, then prepare again.`,{requestId:item.requestId,cause:e.code,httpStatus:e.details?.httpStatus,errors:e.details?.errors});}
  await privateJson(claim,{status:'request_uncertain',requestId:item.requestId});throw new ApiError('request_uncertain','A single submit attempt was made; inspect run/enhancement state before any new request.',{requestId:item.requestId,cause:e.code});}
}
