import {dataDir} from './paths.js';
import path from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {mkdir} from 'node:fs/promises';
import {root,ApiError,privateJson,readJson} from './client.js';
import {lockDirectory} from './media-dedup.js';
import {mediaResponse} from './media-source.js';
import {writeReport,libraryGroups} from './cleanup-report.js';

const base=path.join(dataDir,'cleanup');
const pause=ms=>new Promise(r=>setTimeout(r,ms));
const pendingState=x=>['submitting','awaiting_confirmation','uncertain'].includes(x.state);
const missing=e=>['http_404','http_410','media_unavailable'].includes(e.code);
const sig=m=>JSON.stringify([m.name,m.media_type,m.mime_type,m.size_bytes,m.width??null,m.height??null,m.duration_seconds??null]);
const accountDir=c=>path.join(dataDir,'accounts',c.account);
const validJob=id=>{if(!/^[0-9a-f-]{36}$/.test(id))throw new ApiError('invalid_job','Invalid cleanup job ID.');return path.join(base,id);};
export async function loadCleanup(id){return readJson(path.join(validJob(id),'job.json'));}
async function save(j){j.updatedAt=new Date().toISOString();await privateJson(path.join(validJob(j.id),'job.json'),j);}
const compact=j=>({jobId:j.id,updatedAt:j.updatedAt,status:j.status,phase:j.phase,scanned:j.items.length,groups:j.groups.length,candidates:j.groups.reduce((n,g)=>n+g.deleteIds.length,0),potentialBytes:j.groups.reduce((n,g)=>n+g.deleteIds.length*g.items[0].size_bytes,0),verifiedGroups:j.groups.filter(g=>g.verified).length,groupsWithDifferentOriginals:j.groups.filter(g=>g.verified&&g.hashSets.length>1).length,originalBytesToVerify:j.groups.flatMap(g=>g.items).filter(m=>!m.sha256).reduce((n,m)=>n+m.size_bytes,0),downloadedOriginalBytes:j.downloadedBytes||0,reportPath:path.join(validJob(j.id),'report.html'),thumbnailsReady:j.report?.thumbnailsReady??0,...j.plan?{mode:j.plan.mode,retentions:j.plan.retentions,approved:j.plan.items.length,confirmedDeleted:j.plan.items.filter(x=>x.state==='deleted').length,skipped:j.plan.items.filter(x=>x.state==='skipped').length,failed:j.plan.items.filter(x=>x.state==='failed').length,uncertain:j.plan.items.filter(x=>pendingState(x)).length}:{} ,lastError:j.lastError||undefined});
function meta(m){return {id:m.id,name:m.name,media_type:m.media_type,mime_type:m.mime_type,size_bytes:m.size_bytes,width:m.width,height:m.height,duration_seconds:m.duration_seconds,source_kind:m.source_kind,created_at:m.created_at,available:m.available,thumbnail_url:m.thumbnail_url,poster_url:m.poster_url};}
export function candidateGroups(items){
 const by=new Map();
 for(const m of items){if(m.available===false||!Number.isSafeInteger(m.size_bytes)||m.size_bytes<=0||!m.mime_type)continue;
  if(m.media_type!=='audio'&&(!(m.width>0)||!(m.height>0)))continue;
  if(m.media_type!=='image'&&!(m.duration_seconds>0))continue;
  const key=JSON.stringify([m.media_type,m.mime_type,m.size_bytes,m.width??null,m.height??null,m.duration_seconds??null]);
  if(!by.has(key))by.set(key,[]);by.get(key).push(m);
 }
 return [...by].filter(([,xs])=>xs.length>1).map(([key,xs])=>{xs.sort((a,b)=>a.id-b.id);return {id:createHash('sha256').update(key).digest('hex').slice(0,12),items:xs,keepId:xs[0].id,deleteIds:xs.slice(1).map(x=>x.id),verified:false};});
}
function chooseKeeper(g){const sorted=[...g.items].sort((a,b)=>(b.usages?.length||0)-(a.usages?.length||0)||a.id-b.id);g.keepId=sorted[0].id;g.deleteIds=sorted.slice(1).map(x=>x.id);}
export function checkedPreview(response,ids){
 const p=response.preview;if(!p||!Array.isArray(p.items)||typeof p.blocked!=='boolean'||typeof p.requires_usage_confirmation!=='boolean')throw new ApiError('preview_schema_changed','Deletion preview changed; nothing deleted.');
 if(p.items.length!==ids.length||p.items.some(x=>!ids.includes(x.id)||!Array.isArray(x.usages)||!Array.isArray(x.blockers))||new Set(p.items.map(x=>x.id)).size!==ids.length)throw new ApiError('preview_incomplete','Deletion preview does not match the exact requested files; nothing deleted.');return p;
}
// The site spends ~1.5 s per file here, so previews go in chunks of 10 and are merged; flags are OR-ed, blockers stay per file.
const preview=async(c,j,ids)=>{const parts=[];for(let i=0;i<ids.length;i+=10){const chunk=ids.slice(i,i+10);parts.push(checkedPreview(await c.http(`/workflows/${j.workflowId}/media-library/deletion-preview`,{method:'POST',data:{media_asset_ids:chunk}}),chunk));}
 return {...parts[0],items:parts.flatMap(p=>p.items),blocked:parts.some(p=>p.blocked),requires_usage_confirmation:parts.some(p=>p.requires_usage_confirmation)};};
async function report(c,j){j.report=await writeReport(c,j,validJob(j.id));await save(j);}
function cleanupClient(c){return {account:c.account,context:c.context,http:(url,options={})=>c.http(url,{...options,timeoutMs:options.method==='DELETE'?60000:url.endsWith('/deletion-preview')?90000:15000})};}
async function withJob(c,id,fn){return lockDirectory(path.join(accountDir(c),'cleanup-lock'),async()=>{const j=await loadCleanup(id);if(j.account!==c.account)throw new ApiError('wrong_account','Cleanup belongs to another account.');return fn(j);});}
async function createInventory(c,input){
 const id=randomUUID();await mkdir(validJob(id),{recursive:true,mode:0o700});await save({version:1,id,account:c.account,workflowId:input.workflowId,previousJobId:input.previousJobId,createdAt:new Date().toISOString(),status:'scanning',phase:'inventory',kinds:input.kind&&input.kind!=='all'?[input.kind]:['image','video','audio'],kindIndex:0,items:[],groups:[],cursor:null,previewOffset:0,downloadedBytes:0});return id;
}
export async function nextCleanup(c,jobId){return withJob(c,jobId,async j=>{
 if(!['completed','cancelled'].includes(j.status)||j.plan?.items.some(pendingState))throw new ApiError('cleanup_not_finished','Finish or resolve the previous cleanup before starting a new review.');
 if(j.nextJobId)return compact(await loadCleanup(j.nextJobId));
 const active=await readJson(path.join(accountDir(c),'cleanup-active.json')).catch(e=>{if(e.code==='ENOENT')return null;throw e;});
 if(active?.jobId&&active.jobId!==j.id&&!['completed','cancelled'].includes((await loadCleanup(active.jobId)).status))throw new ApiError('cleanup_busy','Another cleanup must finish first.');
 j.nextJobId=await createInventory(c,{workflowId:j.workflowId,previousJobId:j.id});await save(j);return compact(await loadCleanup(j.nextJobId));
});}
export async function startScan(c,jobId){return withJob(c,jobId,async j=>{
 if(j.status==='ready'&&!j.plan)return compact(j);
 if(j.status!=='scanning'||j.plan)throw new ApiError('invalid_state','Only an unfinished inventory can be resumed.');
 const file=path.join(validJob(jobId),'scan-worker.json'),previous=await workerInfo(file);
 if(previous?.running)return {...compact(j),background:true,pid:previous.pid};
 const {spawn}=await import('node:child_process');const child=spawn(process.execPath,[path.join(root,'src/cleanup-scan-worker.js'),jobId],{detached:true,stdio:'ignore'});
 await new Promise((resolve,reject)=>{child.once('spawn',resolve);child.once('error',reject);});await privateJson(file,{pid:child.pid,startedAt:new Date().toISOString()});child.unref();return {...compact(j),background:true,pid:child.pid};
});}
export async function scanCleanup(c,input){c=cleanupClient(c);
 const id=input.jobId||await createInventory(c,input);
 return withJob(c,id,async j=>{
  try{
  if(j.status!=='scanning')return compact(j);delete j.lastError;const end=Date.now()+30000;
  while(j.phase==='inventory'&&Date.now()<end){const kind=j.kinds[j.kindIndex];const q=new URLSearchParams({type:kind,limit:'50'});if(j.cursor)q.set('before_id',j.cursor);
   const r=await c.http('/media-library?'+q);if(!Array.isArray(r.items)||!r.pagination)throw new ApiError('scan_incomplete','Unexpected media listing; cleanup is blocked.');
   const seen=new Set(j.items.map(x=>x.id));for(const m of r.items)if(!seen.has(m.id))j.items.push(meta(m));
   if(r.pagination.has_more){const next=r.pagination.next_before_id;if(!next||next===j.cursor)throw new ApiError('scan_incomplete','Media pagination stalled.');j.cursor=next;}
   else{j.kindIndex++;j.cursor=null;if(j.kindIndex===j.kinds.length){j.groups=candidateGroups(j.items);j.phase='dependencies';}}
   await save(j);
  }
  const candidates=j.groups.flatMap(g=>g.items);
  while(j.phase==='dependencies'&&j.previewOffset<candidates.length&&Date.now()<end){const chunk=candidates.slice(j.previewOffset,j.previewOffset+10);const p=await preview(c,j,chunk.map(x=>x.id));for(const m of chunk){const x=p.items.find(x=>x.id===m.id);m.usages=x.usages;m.blockers=x.blockers;if(x.name!==m.name)throw new ApiError('media_changed','File changed during scanning; start a new cleanup.');}j.previewOffset+=chunk.length;await save(j);}
  if(j.phase==='dependencies'&&j.previewOffset===candidates.length){j.groups.forEach(chooseKeeper);j.phase='review';j.status='ready';await save(j);await report(c,j);}
  return compact(j);
  }catch(e){j.lastError={code:e.code||'scan_failed',message:e instanceof ApiError?e.message:'Scan interrupted; continue the same job.'};await save(j);return compact(j);}
 });
}
function reviewChoices(j,choices){if(!choices)return;if(j.plan)throw new ApiError('plan_already_approved','Approved actions cannot be changed.');if(Object.entries(choices).some(([id,value])=>!j.groups.some(g=>g.id===id)||!['keep_one','delete_all'].includes(value)))throw new ApiError('invalid_retention','Invalid group action.');j.reviewRetention={...j.reviewRetention,...choices};}
export async function reviewCleanup(c,id,groupRetention){c=cleanupClient(c);return withJob(c,id,async j=>{if(j.phase==='inventory'||j.phase==='dependencies')throw new ApiError('scan_incomplete','Finish scanning before review.');reviewChoices(j,groupRetention);await report(c,j);return compact(j);});}
async function hashRemote(c,m,j,budget){
 const {media}=await c.http(`/media-library/${m.id}/access`);const response=await mediaResponse(c,media,{signal:AbortSignal.timeout(35000)});const hash=createHash('sha256');let bytes=0;const reader=response.body.getReader();const timer=setTimeout(()=>reader.cancel(),35000);
 try{for(;;){const r=await reader.read();if(r.done)break;bytes+=r.value.length;j.downloadedBytes+=r.value.length;if(bytes>m.size_bytes||j.downloadedBytes-budget.start>budget.max)throw new ApiError('download_budget_exceeded','Original download exceeded the allowed byte budget.');hash.update(r.value);}if(bytes!==m.size_bytes)throw new ApiError('original_incomplete','Original transfer incomplete or file size changed.');return hash.digest('hex');}
 finally{clearTimeout(timer);await reader.cancel().catch(()=>{});await save(j);}
}
export async function verifyCleanup(c,{jobId,groupIds,groupRetention,maxBytes=100*1024*1024,shouldPause}){c=cleanupClient(c);return withJob(c,jobId,async j=>{
 if(j.status!=='ready')throw new ApiError('invalid_state','Only a reviewed, unapproved cleanup can be verified.');
 delete j.lastError;reviewChoices(j,groupRetention);const selected=selectGroups(j,groupIds);const end=Date.now()+30000,budget={start:j.downloadedBytes,max:maxBytes};let neededBytes=0;
 for(const g of selected){for(const m of g.items){if(m.sha256)continue;
  if(await shouldPause?.()){delete j.verifyingAssetId;await save(j);await report(c,j);return {...compact(j),verificationPending:true,paused:true};}
  const cached=await readJson(path.join(accountDir(c),'media-index.json')).catch(e=>{if(e.code==='ENOENT')return null;throw e;});const known=cached?.assets?.[m.id];
  if(known?.sizeBytes===m.size_bytes&&/^[a-f0-9]{64}$/.test(known.sha256)){m.sha256=known.sha256;continue;}
  if(Date.now()>end||j.downloadedBytes-budget.start+m.size_bytes>maxBytes){neededBytes+=m.size_bytes;continue;}
  j.verifyingAssetId=m.id;await save(j);
  try{m.sha256=await hashRemote(c,m,j,budget);await lockDirectory(accountDir(c),async()=>{const f=path.join(accountDir(c),'media-index.json');const index=await readJson(f).catch(e=>{if(e.code!=='ENOENT')throw e;return {version:1,assets:{},pending:{}};});if(index.version!==1||!index.assets||!index.pending)throw new ApiError('media_index_unreadable','Invalid media index.');index.assets[m.id]={sha256:m.sha256,sizeBytes:m.size_bytes,kind:m.media_type,name:m.name,mimeType:m.mime_type};await privateJson(f,index);});delete m.verifyError;}
  catch(e){delete j.verifyingAssetId;m.verifyError=e.code||'hash_failed';j.lastError={code:e.code||'hash_failed',mediaAssetId:m.id};await save(j);await report(c,j);return {...compact(j),verificationPending:true};}
  await save(j);
 }
  if(g.items.every(m=>m.sha256)){g.verified=true;g.hashSets=Object.values(Object.groupBy(g.items,m=>m.sha256)).map(xs=>xs.map(x=>x.id));}
 }
 delete j.verifyingAssetId;await save(j);await report(c,j);return {...compact(j),verificationPending:selected.some(g=>!g.verified),remainingBytes:neededBytes};
 });}
function selectGroups(j,ids){if(ids?.length&&ids.some(id=>!j.groups.some(g=>g.id===id)))throw new ApiError('unknown_group','Unknown group ID.');return ids?.length?j.groups.filter(g=>ids.includes(g.id)):j.groups;}
export async function approveCleanup(c,{jobId,mode,groupIds,retention,groupRetention={},allowUsedOnCanvas=false,confirm,expectedUpdatedAt}){c=cleanupClient(c);if(!['metadata','hash'].includes(mode))throw new ApiError('invalid_mode','Choose metadata or hash.');return withJob(c,jobId,async j=>{
 if(expectedUpdatedAt && !j.plan && expectedUpdatedAt!==j.updatedAt)throw new ApiError('stale_review','The report changed. Refresh and review before deleting.');
 if(!confirm)throw new ApiError('confirmation_required','Explicit user choice of metadata or hash mode is required.');
 const requested=groupIds||j.plan?.groupIds||j.groups.map(g=>g.id);
 if(retention!==undefined&&!['keep_one','delete_all'].includes(retention)||Object.entries(groupRetention).some(([id,value])=>!requested.includes(id)||!['keep_one','delete_all'].includes(value)))throw new ApiError('invalid_retention','Choose keep_one or delete_all for selected groups only.');
 const retentions=Object.fromEntries(requested.map(id=>[id,groupRetention[id]||retention||j.reviewRetention?.[id]||'keep_one']));
 if(j.plan){const previous=j.plan.retentions||Object.fromEntries((j.plan.groupIds||[]).map(id=>[id,'keep_one']));if(j.plan.mode!==mode||j.plan.allowUsedOnCanvas!==allowUsedOnCanvas||JSON.stringify([...requested].sort())!==JSON.stringify([...(j.plan.groupIds||[])].sort())||requested.some(id=>previous[id]!==retentions[id]))throw new ApiError('plan_already_approved','Approval is already frozen; cancel and create a new cleanup to change it.');return compact(j);}if(j.status!=='ready')throw new ApiError('invalid_state','Finish reviewing first.');
 const activeFile=path.join(accountDir(c),'cleanup-active.json');const active=await readJson(activeFile).catch(e=>{if(e.code==='ENOENT')return null;throw e;});
 if(active?.jobId!==j.id&&active?.jobId){const previous=await loadCleanup(active.jobId);if(!['completed','cancelled'].includes(previous.status))throw new ApiError('cleanup_busy','Another approved cleanup must finish or be cancelled first.',{jobId:active.jobId});}
 const groups=selectGroups(j,groupIds);if(mode==='hash'&&groups.some(g=>!g.verified))throw new ApiError('verification_required','Selected groups must be fully hashed first.');
 const items=[];for(const g of groups){const sets=mode==='hash'?g.hashSets:[g.items.map(x=>x.id)];for(const ids of sets){if(ids.length<2)continue;const subset={items:g.items.filter(m=>ids.includes(m.id))};chooseKeeper(subset);const removeAll=retentions[g.id]==='delete_all';for(const id of removeAll?ids:subset.deleteIds){const m=g.items.find(x=>x.id===id);items.push({...m,groupId:g.id,keepId:removeAll?null:subset.keepId,expectedSignature:sig(m),state:'queued'});}}}
 if(!items.length)throw new ApiError('no_duplicates','No duplicate candidates remain for the selected mode.');
 j.plan={mode,allowUsedOnCanvas,retentions,groupIds:groups.map(g=>g.id),approvedAt:new Date().toISOString(),items};j.status='approved';await privateJson(activeFile,{jobId:j.id});await save(j);await report(c,j);return compact(j);
 });}
export async function approveFiles(c,{jobId,mediaAssetIds,confirm,expectedUpdatedAt}){return withJob(c,jobId,async j=>{
 if(confirm!==true)throw new ApiError('confirmation_required','Explicit confirmation is required.');
 if(!Array.isArray(mediaAssetIds)||!mediaAssetIds.length||mediaAssetIds.length>10000||mediaAssetIds.some(id=>!Number.isSafeInteger(id)||id<1)||new Set(mediaAssetIds).size!==mediaAssetIds.length)throw new ApiError('invalid_files','Choose explicit unique file IDs.');
 const ids=[...mediaAssetIds].sort((a,b)=>a-b);
 if(j.plan){if(j.plan.mode!=='explicit'||JSON.stringify(j.plan.items.map(m=>m.id).sort((a,b)=>a-b))!==JSON.stringify(ids))throw new ApiError('plan_already_approved','The approved selection cannot change.');return compact(j);}
 if(j.status!=='ready')throw new ApiError('invalid_state','Finish the inventory before deletion.');
 if((await workerInfo(path.join(validJob(jobId),'verification.json')))?.running)throw new ApiError('verification_busy','Wait for verification before approving file deletion.');
 if(!expectedUpdatedAt||expectedUpdatedAt!==j.updatedAt)throw new ApiError('stale_review','The report changed. Refresh before deleting.');
 const groups=libraryGroups(j).filter(g=>ids.includes(g.items[0].id));
 if(groups.length!==ids.length)throw new ApiError('unknown_file','A selected file is not in this inventory.');
 const activeFile=path.join(accountDir(c),'cleanup-active.json'),active=await readJson(activeFile).catch(e=>{if(e.code==='ENOENT')return null;throw e;});
 if(active?.jobId&&active.jobId!==j.id&&!['completed','cancelled'].includes((await loadCleanup(active.jobId)).status))throw new ApiError('cleanup_busy','Finish the existing cleanup first.',{jobId:active.jobId});
 j.plan={mode:'explicit',allowUsedOnCanvas:false,groupIds:groups.map(g=>g.id),retentions:Object.fromEntries(groups.map(g=>[g.id,'delete_all'])),approvedAt:new Date().toISOString(),items:groups.map(g=>({...g.items[0],groupId:g.id,keepId:null,expectedSignature:sig(g.items[0]),state:'queued'}))};
 j.status='approved';await save(j);await privateJson(activeFile,{jobId:j.id});return compact(j);
});}
// Library entries for exactly these ids. Name search is not used: the site's search misses long generated names.
// Pages start just above the highest id and stop once the lowest one is passed, so a batch costs a page or two.
async function currentEntries(c,items){
 const out=new Map();
 for(const kind of new Set(items.map(x=>x.media_type))){
  const ids=new Set(items.filter(x=>x.media_type===kind).map(x=>x.id)),low=Math.min(...ids);let before=Math.max(...ids)+1;
  for(;;){
   const r=await c.http('/media-library?'+new URLSearchParams({type:kind,limit:'50',before_id:String(before)}));
   if(!Array.isArray(r.items)||!r.pagination)throw new ApiError('scan_incomplete','Unexpected media listing; nothing deleted.');
   for(const m of r.items)if(ids.has(m.id))out.set(m.id,meta(m));
   const next=r.pagination.next_before_id;
   if(!r.pagination.has_more||!next||next>=before||next<=low||[...ids].every(id=>out.has(id)))break;before=next;
  }
 }
 return out;
}
export const sameName=(a,b)=>typeof a==='string'&&typeof b==='string'&&a.normalize('NFC')===b.normalize('NFC');
async function keeperPresent(c,j,item,current){const m=j.groups.flatMap(g=>g.items).find(m=>m.id===item.keepId);if(!m)return false;const live=current?.get(m.id)||null;if(!live||sig(live)!==sig(m)||live.available===false)return false;const {media}=await c.http(`/media-library/${m.id}/access`);return !!media&&media.available!==false;}
async function reconcile(c,j){
 const pending=j.plan.items.filter(x=>pendingState(x));if(!pending.length)return;
 const visible=new Set((await currentEntries(c,pending)).keys());
 for(const x of pending){let absent=false;try{const r=await c.http(`/media-library/${x.id}/access`);absent=r.media?.available===false;}catch(e){if(missing(e))absent=true;else{j.lastError={code:e.code||'check_failed',mediaAssetId:x.id};continue;}}
  if(absent&&!visible.has(x.id)){x.state='deleted';x.confirmedAt=new Date().toISOString();}else{x.state='awaiting_confirmation';}
 }await save(j);
}
export async function stepCleanup(c,{jobId,batchSize=10,waitSeconds=10}){c=cleanupClient(c);if(!Number.isInteger(batchSize)||batchSize<1||batchSize>50)throw new ApiError('invalid_batch','Batch size must be 1–50.');return withJob(c,jobId,async j=>{
 if(!j.plan||!['approved','running','completed','needs_attention'].includes(j.status))throw new ApiError('invalid_state','Approve a reviewed cleanup before deleting.');
 if(j.status==='completed')return compact(j);j.status='running';delete j.lastError;
 try{
  await reconcile(c,j);
  // A lost response must be reconciled before any further destructive request.
  if(j.plan.items.some(x=>pendingState(x))){const end=Date.now()+Math.min(waitSeconds,20)*1000;while(Date.now()<end){await pause(Math.min(2000,Math.max(0,end-Date.now())));await reconcile(c,j);if(!j.plan.items.some(pendingState))break;}if(j.plan.items.some(pendingState)){j.status='needs_attention';await save(j);return compact(j);}}
  const queued=j.plan.items.filter(x=>x.state==='queued').slice(0,Math.min(batchSize,50));
  const keepers=j.groups.flatMap(g=>g.items).filter(m=>queued.some(x=>x.keepId===m.id));const current=await currentEntries(c,[...queued,...keepers]);
  const keeperChecks=new Map();const eligible=[];const until=Date.now()+20000;
  for(const x of queued){if(Date.now()>until)break;const live=current.get(x.id);if(!live){x.state='skipped';x.reason='not_in_library';continue;}if(sig(live)!==x.expectedSignature){x.state='skipped';x.reason='metadata_changed';continue;}if(x.keepId!=null&&!keeperChecks.has(x.keepId))keeperChecks.set(x.keepId,await keeperPresent(c,j,x,current));if(x.keepId!=null&&!keeperChecks.get(x.keepId)){x.state='skipped';x.reason='keeper_unavailable';continue;}eligible.push(x);}
  if(eligible.length){const p=await preview(c,j,eligible.map(x=>x.id));const safe=[];for(const x of eligible){const item=p.items.find(m=>m.id===x.id);if(item.name!==x.name||item.blockers.length||!j.plan.allowUsedOnCanvas&&(item.usages.length||p.requires_usage_confirmation&&!p.items.some(m=>m.usages.length))){x.state='skipped';x.reason=item.blockers.length?'blocked_by_dependencies':item.name!==x.name?'name_changed':'used_on_canvas';}else safe.push(x);}
   // Re-preview the final subset so one blocked file cannot poison an otherwise safe batch.
   if(safe.length){const last=await preview(c,j,safe.map(x=>x.id));if(last.blocked||last.items.some(x=>x.blockers.length||x.name!==safe.find(m=>m.id===x.id).name||!j.plan.allowUsedOnCanvas&&x.usages.length)||!j.plan.allowUsedOnCanvas&&last.requires_usage_confirmation)throw new ApiError('dependencies_changed','Dependencies changed; nothing in this batch was deleted.');
    const attempt={id:randomUUID(),ids:safe.map(x=>x.id),startedAt:new Date().toISOString()};j.attempts??=[];j.attempts.push(attempt);for(const x of safe)x.state='submitting';await save(j);
    try{const r=await c.http(`/workflows/${j.workflowId}/media-library`,{method:'DELETE',data:{media_asset_ids:attempt.ids,confirmed:true,response:'summary'}});attempt.response=r;
     if(!Array.isArray(r.deleted_ids)||!Array.isArray(r.failures)||r.deleted_ids.some(id=>!attempt.ids.includes(id)))throw new ApiError('delete_response_changed','Deletion response changed; checking actual state.');
     for(const x of safe){const f=r.failures.find(f=>(f.id??f.media_asset_id)===x.id);x.state=f?'failed':'awaiting_confirmation';if(f)x.reason=f.message||f.code||'server_failure';}
    }catch(e){attempt.error={code:e.code||'error',message:e instanceof ApiError?e.message:'Deletion interrupted'};for(const x of safe)x.state='uncertain';j.lastError=attempt.error;}
    await save(j);await reconcile(c,j);
   }
  }
  j.status=j.plan.items.some(x=>pendingState(x))?'needs_attention':j.plan.items.some(x=>x.state==='queued')?'running':'completed';
 }catch(e){j.status='needs_attention';j.lastError={code:e.code||'error',message:e instanceof ApiError?e.message:'Cleanup interrupted; resume the same job.'};}
 await save(j);if(j.plan.mode!=='explicit')await report(c,j);return compact(j);
 });}
async function workerInfo(file){
 let value;try{value=await readJson(file);}catch(e){if(e.code==='ENOENT')return null;throw e;}
 value.running=false;if(value.pid&&!value.endedAt){try{process.kill(value.pid,0);value.running=true;}catch{}}
 return value;
}
export async function cleanupStatus(c,jobId){
 const j=await loadCleanup(jobId);if(j.account!==c.account)throw new ApiError('wrong_account','Cleanup belongs to another account.');
 const [worker,verification,control,scanner]=await Promise.all([workerInfo(path.join(validJob(jobId),'worker.json')),workerInfo(path.join(validJob(jobId),'verification.json')),readJson(path.join(validJob(jobId),'control.json')).catch(e=>{if(e.code==='ENOENT')return null;throw e;}),workerInfo(path.join(validJob(jobId),'scan-worker.json'))]);
 const selected=verification?j.groups.filter(g=>verification.groupIds.includes(g.id)):[],files=selected.flatMap(g=>g.items);
 return {...compact(j),previousJobId:j.previousJobId,nextJobId:j.nextJobId,scanner,scanProgress:{checkedDependencies:j.previewOffset||0,totalDependencies:j.groups.reduce((n,g)=>n+g.items.length,0)},worker,verification:verification?{...verification,totalFiles:files.length,hashedFiles:files.filter(m=>m.sha256).length,currentAssetId:j.verifyingAssetId||null}:null,pauseRequested:!!control?.pause};
}
export async function pauseCleanup(c,jobId){
 const j=await loadCleanup(jobId);if(j.account!==c.account)throw new ApiError('wrong_account','Cleanup belongs to another account.');
 await privateJson(path.join(validJob(jobId),'control.json'),{pause:true,requestedAt:new Date().toISOString()});return cleanupStatus(c,jobId);
}
export async function cleanupPauseRequested(jobId){return !!(await readJson(path.join(validJob(jobId),'control.json')).catch(e=>{if(e.code==='ENOENT')return null;throw e;}))?.pause;}
export async function startVerification(c,{jobId,groupIds,groupRetention={}}){return withJob(c,jobId,async j=>{
 if(j.status!=='ready'||j.plan)throw new ApiError('invalid_state','Only an unapproved review can be verified.');
 if(!Array.isArray(groupIds)||!groupIds.length||new Set(groupIds).size!==groupIds.length)throw new ApiError('invalid_groups','Choose explicit unique group IDs.');
 const selected=selectGroups(j,groupIds);if(Object.keys(groupRetention).some(id=>!groupIds.includes(id)))throw new ApiError('invalid_retention','Actions must refer only to selected groups.');
 const file=path.join(validJob(jobId),'verification.json'),previous=await workerInfo(file);
 if(previous?.running){if(JSON.stringify([...previous.groupIds].sort())!==JSON.stringify([...groupIds].sort())||Object.entries(groupRetention).some(([id,value])=>(previous.groupRetention?.[id]||j.reviewRetention?.[id]||'keep_one')!==value))throw new ApiError('verification_busy','A verification is already running for another selection.');return {jobId,background:true,pid:previous.pid};}
 reviewChoices(j,groupRetention);await save(j);await privateJson(path.join(validJob(jobId),'control.json'),{pause:false});
 const config={groupIds,groupRetention,startedAt:new Date().toISOString()};await privateJson(file,config);
 const {spawn}=await import('node:child_process');const child=spawn(process.execPath,[path.join(root,'src/cleanup-verify-worker.js'),jobId],{detached:true,stdio:'ignore'});
 await new Promise((resolve,reject)=>{child.once('spawn',resolve);child.once('error',reject);});await privateJson(file,{...config,pid:child.pid});child.unref();return {jobId,background:true,pid:child.pid};
});}
export async function cancelCleanup(c,jobId){c=cleanupClient(c);return withJob(c,jobId,async j=>{if(j.plan?.items.some(x=>pendingState(x)))throw new ApiError('deletion_uncertain','Reconcile pending deletion before cancelling.');j.status='cancelled';await save(j);return compact(j);});}

// Deletion previews get 90 s: with 15 s, scans stayed stuck in 'dependencies' on request_uncertain.
// Explicit single-file and legacy reference-copy deletion share the same durable journal.
export async function deleteExact(c,input,provided){
 const wanted=input.items||[{mediaAssetId:input.mediaAssetId,expectedName:input.expectedName}];
 const ids=provided?.map(x=>x.id)||wanted.map(x=>x.mediaAssetId);
 if(!ids.length||ids.length>50||new Set(ids).size!==ids.length)throw new ApiError('invalid_batch','Give 1–50 different files per request.');
 const p=await preview(cleanupClient(c),{workflowId:input.workflowId},ids);
 if(!provided){
  // Names are compared in NFC: files uploaded from macOS Finder keep decomposed letters (й = и + ◌̆).
  const wrong=wanted.map(w=>({mediaAssetId:w.mediaAssetId,expectedName:w.expectedName,actualName:p.items.find(x=>x.id===w.mediaAssetId)?.name??null})).filter(w=>!sameName(w.actualName,w.expectedName));
  if(wrong.length)throw new ApiError('name_mismatch','Media name does not match; nothing deleted.',{mismatches:wrong});
 }
 if(input.dryRun!==false)return {preview:p};if(!input.confirm)throw new ApiError('confirmation_required','Set confirm=true to delete.');
 if(p.blocked)throw new ApiError('blocked_by_dependencies','Site blocks deletion; nothing deleted.',{blocked:p.items.filter(x=>x.blockers.length).map(x=>x.id),preview:p});
 if(p.requires_usage_confirmation&&!input.allowUsedOnCanvas)throw new ApiError('usage_confirmation_required','Canvas usage requires explicit permission; nothing deleted.',{usedOnCanvas:p.items.filter(x=>x.usages.length).map(x=>x.id),preview:p});
 const id=await lockDirectory(path.join(accountDir(c),'cleanup-lock'),async()=>{
  const activeFile=path.join(accountDir(c),'cleanup-active.json');const active=await readJson(activeFile).catch(e=>{if(e.code==='ENOENT')return null;throw e;});
  if(active?.jobId){const previous=await loadCleanup(active.jobId);if(!['completed','cancelled'].includes(previous.status))throw new ApiError('cleanup_busy','Resume the existing cleanup first.',{jobId:active.jobId});}
  let found=provided;
  if(!found){const kinds=[];for(const x of p.items){const {media}=await c.http(`/media-library/${x.id}/access`);kinds.push({id:x.id,media_type:media?.media_type||media?.mime_type?.split('/')[0]});}found=[...(await currentEntries(c,kinds)).values()];}
  const changed=p.items.map(x=>({mediaAssetId:x.id,previewName:x.name,libraryName:found.find(m=>m.id===x.id)?.name??null})).filter(x=>x.libraryName!==x.previewName);
  if(changed.length)throw new ApiError('media_changed','Media no longer matches the preview; nothing deleted.',{changed});
  const items=p.items.map(x=>{const m=found.find(m=>m.id===x.id);return {...meta(m),expectedSignature:sig(m),state:'queued'};});
  const jobId=randomUUID();const j={version:1,id:jobId,account:c.account,workflowId:input.workflowId,status:'approved',phase:'review',createdAt:new Date().toISOString(),items:items.map(meta),groups:[],downloadedBytes:0,plan:{mode:'explicit',allowUsedOnCanvas:!!input.allowUsedOnCanvas,approvedAt:new Date().toISOString(),items}};await save(j);await privateJson(activeFile,{jobId});return jobId;
 });
 const r=await stepCleanup(c,{jobId:id,batchSize:ids.length,waitSeconds:0});const j=await loadCleanup(id);return {...r,deleted_ids:j.plan.items.filter(x=>x.state==='deleted').map(x=>x.id),failures:j.plan.items.filter(x=>['failed','skipped'].includes(x.state)).map(x=>({id:x.id,message:x.reason}))};
}

export async function startCleanup(c,jobId){return withJob(c,jobId,async j=>{
 if(!j.plan||!['approved','running','needs_attention'].includes(j.status))throw new ApiError('invalid_state','Approve the cleanup before starting it in the background.');
 const file=path.join(validJob(jobId),'worker.json');let previous;try{previous=await readJson(file);}catch(e){if(e.code!=='ENOENT')throw e;}
 if(previous?.pid&&!previous.endedAt){try{process.kill(previous.pid,0);return {...compact(j),background:true,pid:previous.pid};}catch(e){if(e.code!=='ESRCH')throw e;}}
 await privateJson(path.join(validJob(jobId),'control.json'),{pause:false});
 const {spawn}=await import('node:child_process');const child=spawn(process.execPath,[path.join(root,'src/cleanup-worker.js'),jobId],{detached:true,stdio:'ignore'});
 await new Promise((resolve,reject)=>{child.once('spawn',resolve);child.once('error',reject);});await privateJson(file,{pid:child.pid,startedAt:new Date().toISOString()});child.unref();return {...compact(j),background:true,pid:child.pid};
});}
