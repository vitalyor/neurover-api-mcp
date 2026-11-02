// Local journal of what MCP actually sent: requestId → final prompt, reference table, settings, expected geometry.
// The server snapshot (message.input.references) is empty for some fields (observed for `images`), so history uses this as fallback.
import path from 'node:path';
import {dataDir} from './paths.js';
import {privateJson,readJson,ApiError} from './client.js';
import {checkOrientation} from './prompt-refs.js';

const file=(account,workflowId)=>path.join(dataDir,'journal',String(account).replace(/[^\w-]/g,'_'),`${Number(workflowId)}.json`);
export async function readJournal(account,workflowId) {
  try{const j=await readJson(file(account,workflowId));if(j?.version!==1)throw new ApiError('journal_unreadable','Unsupported generation journal.');return j;}
  catch(e){if(e.code==='ENOENT')return {version:1,requests:{},byMessage:{}};throw e;}
}
export async function recordSubmission(item,result) {
  const j=await readJournal(item.account,item.workflowId);
  const ids=[result?.user_message?.id,result?.assistant_message?.id].filter(Number.isSafeInteger);
  j.requests[item.requestId]={requestId:item.requestId,messageIds:ids,generationId:result?.assistant_message?.generation_request_id??null,modelId:item.modelId,modelName:item.modelName,prompt:item.prompt,originalPrompt:item.originalPrompt??item.prompt,settings:item.settings,droppedSettings:item.droppedSettings??[],referenceTable:item.referenceTable??item.references,expected:item.expected??null,submittedAt:new Date().toISOString()};
  for(const id of ids)j.byMessage[id]=item.requestId;
  await privateJson(file(item.account,item.workflowId),j);
}
export async function journalFor(account,workflowId,messageId) {
  const j=await readJournal(account,workflowId);const id=j.byMessage[messageId];return id?j.requests[id]:null;
}
// Fallback when there is no journal entry: the server snapshot's explicit aspect_ratio (not for frame-driven modes).
export function expectedFromServer(message) {
  const s=message?.input?.settings||{};const mode=String(s.mode??'');
  if(['first-frame','first-last','edit','extend'].includes(mode))return null;
  const v=s.aspect_ratio??s.ratio;if(!v||!String(v).includes(':'))return null;
  const [a,b]=String(v).split(':').map(Number);if(!(a>0&&b>0))return null;
  const r=a/b;return {source:'server_aspect_ratio',aspectRatio:String(v),ratio:r,orientation:r>1.05?'landscape':r<0.95?'portrait':'square'};
}
export async function orientationWarnings(client,workflowId,message) {
  const outputs=message?.outputs||message?.generation?.outputs||[];
  if(!outputs.length)return [];
  const entry=message?.id?await journalFor(client.account,workflowId,message.id):null;
  const expected=entry?.expected||expectedFromServer(message);
  const request={workflowId,messageId:message.id,generationId:message.generation_request_id??message.generation?.id??null,requestId:entry?.requestId??null,modelId:entry?.modelId??message.model_id,model:entry?.modelName??message.model_name,settings:entry?.settings??message.input?.settings,references:entry?.referenceTable?.map(r=>({mediaAssetId:r.mediaAssetId,tile:r.tile,frame:r.frame}))};
  const warnings=checkOrientation(expected,outputs,request);
  if(entry&&!entry.outcome)await recordOutcome(client.account,workflowId,entry.requestId,{checkedAt:new Date().toISOString(),orientationMismatch:warnings.length>0,outputs:outputs.map(o=>({id:o.id,width:o.width,height:o.height}))}).catch(()=>{});
  return warnings;
}
export async function recordOutcome(account,workflowId,requestId,outcome) {
  const j=await readJournal(account,workflowId);if(!j.requests[requestId])return;
  j.requests[requestId].outcome=outcome;await privateJson(file(account,workflowId),j);
}
// Earlier MCP runs of the same model+mode whose output shape did not match: warn before paying again.
export async function priorMismatches(account,modelId,mode) {
  const {readdir}=await import('node:fs/promises');const dir=path.dirname(file(account,1));let names=[];
  try{names=await readdir(dir);}catch{return [];}
  const hits=[];
  for(const n of names.filter(n=>/^\d+\.json$/.test(n))) {
    let j;try{j=await readJson(path.join(dir,n));}catch{continue;}
    for(const e of Object.values(j.requests||{}))if(e.modelId===modelId&&String(e.settings?.mode??'')===String(mode??'')&&e.outcome?.orientationMismatch)hits.push({workflowId:Number(n.slice(0,-5)),messageIds:e.messageIds,generationId:e.generationId,outputs:e.outcome.outputs,expected:e.expected?.orientation});
  }
  return hits;
}
