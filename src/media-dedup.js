import {dataDir} from './paths.js';
import path from 'node:path';
import {createReadStream} from 'node:fs';
import {stat,readFile,mkdir,open,unlink} from 'node:fs/promises';
import {createHash,randomUUID} from 'node:crypto';
import {root,ApiError,privateJson,readJson} from './client.js';
import {mediaResponse} from './media-source.js';

const missing=e=>['http_404','http_410','media_unavailable'].includes(e.code);
const mimeTypes={'.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.webp':'image/webp','.mp4':'video/mp4','.webm':'video/webm','.mp3':'audio/mpeg','.wav':'audio/wav','.m4a':'audio/mp4'};
export function mimeFor(filePath,mimeType) {return mimeType||mimeTypes[path.extname(filePath).toLowerCase()];}
export async function localFingerprint(filePath,mimeType) {
  if(!path.isAbsolute(filePath))throw new ApiError('invalid_path','Use an absolute file path.');
  const before=await stat(filePath,{bigint:true});
  if(!before.isFile()||before.size===0n)throw new ApiError('invalid_file','Select a nonempty regular media file.');
  const mime=mimeFor(filePath,mimeType);
  if(!mime||!/^(image|video|audio)\//.test(mime))throw new ApiError('invalid_file','Specify an image, video or audio MIME type.');
  const hash=createHash('sha256');let bytes=0;
  for await(const chunk of createReadStream(filePath)){hash.update(chunk);bytes+=chunk.length;}
  const after=await stat(filePath,{bigint:true});
  if(before.ino!==after.ino||before.size!==after.size||before.mtimeNs!==after.mtimeNs||BigInt(bytes)!==after.size)throw new ApiError('file_changed','Local file changed during duplicate checking. Try again after saving it.');
  return {sha256:hash.digest('hex'),bytes,name:path.basename(filePath),mime,kind:mime.split('/')[0]};
}
export async function lockDirectory(directory,fn) {
  await mkdir(directory,{recursive:true,mode:0o700});
  const lock=path.join(directory,'media-index.lock'),owner={pid:process.pid,token:randomUUID()};const until=Date.now()+55000;
  for(;;) {
    try {const f=await open(lock,'wx',0o600);try{await f.writeFile(JSON.stringify(owner));}finally{await f.close();}break;}
    catch(e) {
      if(e.code!=='EEXIST')throw e;
      let stale=false,previous;
      try {previous=await readFile(lock,'utf8');const p=JSON.parse(previous);if(!Number.isSafeInteger(p.pid)||p.pid<=0)throw Error('invalid owner');try{process.kill(p.pid,0);}catch(e){if(e.code==='ESRCH')stale=true;}}
      catch(e) {if(e.code==='ENOENT')continue;try{stale=Date.now()-(await stat(lock)).mtimeMs>60000;}catch{}}
      if(stale) {try{if(previous===await readFile(lock,'utf8'))await unlink(lock);}catch{}continue;}
      if(Date.now()>=until)throw new ApiError('upload_busy','Another media check/upload is still running; no new upload was started.');
      await new Promise(r=>setTimeout(r,200));
    }
  }
  try{return await fn();}finally{try{if(JSON.parse(await readFile(lock,'utf8')).token===owner.token)await unlink(lock);}catch{}}
}
async function accessMedia(client,id) {
  try {const {media}=await client.http(`/media-library/${id}/access`);return media&&media.available!==false&&(!media.content_status||media.content_status==='active')?media:null;}
  catch(e){if(missing(e))return null;throw e;}
}
async function originalHash(client,media) {
  const response=await mediaResponse(client,media);const hash=createHash('sha256');let bytes=0;
  for await(const chunk of response.body){hash.update(chunk);bytes+=chunk.length;}
  return {sha256:hash.digest('hex'),bytes};
}
export async function* library(client,kind,search) {
  let before;const seen=new Set();
  for(;;) {
    const q=new URLSearchParams({type:kind,limit:'50'});if(search)q.set('search',search);if(before)q.set('before_id',String(before));
    const r=await client.http('/media-library?'+q);
    if(!Array.isArray(r.items)||!r.pagination)throw new ApiError('dedup_check_incomplete','Media library response changed; upload was not started.');
    for(const m of r.items)if(!seen.has(m.id)){seen.add(m.id);yield m;}
    if(!r.pagination.has_more)return;
    const next=r.pagination.next_before_id;
    if(!next||next===before)throw new ApiError('dedup_check_incomplete','Media library pagination stalled; upload was not started.');
    before=next;
  }
}
function remember(index,media,file,hash=file.sha256) {
  index.assets[media.id]={sha256:hash,sizeBytes:media.size_bytes??file.bytes,kind:file.kind,name:media.name,mimeType:media.mime_type};
}
function assetId(r) {return r?.asset?.id||r?.node?.primary_media_asset_id||r?.node?.primary_media?.id||r?.node?.output?.media_asset_id;}

export async function ensureFile(client,input,uploadNew,indexDirectory=path.join(dataDir,'accounts',client.account)) {
  const file=await localFingerprint(input.filePath,input.mimeType);
  return lockDirectory(indexDirectory,async()=>{
    const indexFile=path.join(indexDirectory,'media-index.json');let index;
    try{index=await readJson(indexFile);}catch(e){if(e.code!=='ENOENT')throw new ApiError('media_index_unreadable','Cannot read duplicate index; upload was not started.');index={version:1,assets:{},pending:{}};}
    if(index.version!==1||!index.assets||!index.pending)throw new ApiError('media_index_unreadable','Unsupported duplicate index; upload was not started.');
    const save=()=>privateJson(indexFile,index);
    const result=(media,reused,reason,extra={})=>({status:reused?'reused':'uploaded',reused,reason,mediaAssetId:media.id,sha256:file.sha256,bytes:file.bytes,media,...extra});
    const seen=new Set();
    for(const [id,entry] of Object.entries(index.assets))if(entry.sha256===file.sha256&&entry.kind===file.kind) {
      const found=await accessMedia(client,Number(id));
      const media=found?{name:entry.name||file.name,size_bytes:entry.sizeBytes,media_type:file.kind,...found}:null;
      if(media&&(media.size_bytes===undefined||media.size_bytes===entry.sizeBytes)){delete index.pending[file.sha256];await save();return result(media,true,'persistent_content_match');}
      delete index.assets[id];seen.add(Number(id));
    }
    const pending=index.pending[file.sha256];let pendingNode;
    // Library (chat) uploads have no canvas node; they are recovered by replaying the same client_upload_id.
    if(pending&&pending.mode!=='library') {
      try {
        const r=await client.http(`/workflows/${pending.workflowId}`);
        const node=r.workflow?.graph?.nodes?.find(n=>n.id===pending.nodeId||n.uuid===pending.uuid);
        pendingNode=node;
        const id=assetId({node});
        if(id&&node.status==='completed') {
          const found=await accessMedia(client,id);
          const media=found?{name:pending.name||file.name,size_bytes:file.bytes,media_type:file.kind,...found}:null;
          if(media){remember(index,media,file);delete index.pending[file.sha256];await save();return result(media,true,'recovered_upload',{nodeId:node.id,workflowId:pending.workflowId});}
        }
      }catch(e){if(!missing(e))throw e;}
    }
    for(const search of [file.name,undefined])for await(const m of library(client,file.kind,search)) {
      if(seen.has(m.id))continue;seen.add(m.id);
      if(m.available===false||m.size_bytes!==file.bytes&&!(m.name===file.name&&!m.size_bytes))continue;
      const known=index.assets[m.id];
      if(known&&known.sizeBytes===m.size_bytes&&known.sha256!==file.sha256)continue;
      const found=await accessMedia(client,m.id);if(!found)continue;
      const media={...m,...found};
      let hash;
      try{hash=await originalHash(client,media);}catch(e){if(missing(e))continue;throw e;}
      remember(index,media,file,hash.sha256);await save();
      if(hash.bytes===file.bytes&&hash.sha256===file.sha256){delete index.pending[file.sha256];await save();return result(media,true,'existing_library_content_match');}
    }
    const resume=pending?.mode==='library'&&input.library;
    if(pending&&!resume) {await save();throw new ApiError('upload_pending',pending.mode==='library'?'An earlier chat upload is incomplete. Repeat it through a generation reference so it can be resumed with the same upload ID.':'An earlier upload is incomplete or uncertain. It was not repeated; inspect its existing node.',{workflowId:pending.workflowId,nodeId:pendingNode?.id||pending.nodeId,uploadUuid:pending.uuid});}
    // Hash again before any server write so a changed local file cannot poison the index.
    const buffer=await readFile(input.filePath);
    if(createHash('sha256').update(buffer).digest('hex')!==file.sha256)throw new ApiError('file_changed','Local file changed; no upload was started.');
    // A resumed library attempt keeps its client_upload_id, so the server replays instead of storing a second copy.
    const attempt=resume?pending:{uuid:randomUUID(),workflowId:input.workflowId,name:file.name,createdAt:Date.now(),...(input.library?{mode:'library',aiModelId:input.library.aiModelId,referenceField:input.library.referenceField}:{})};
    index.pending[file.sha256]=attempt;await save();
    const uploadInput=resume?{...input,workflowId:pending.workflowId,library:{aiModelId:pending.aiModelId,referenceField:pending.referenceField}}:input;
    let uploaded;
    try {
      uploaded=await uploadNew({...uploadInput,mimeType:file.mime},buffer,{uuid:attempt.uuid,resumed:Boolean(resume),onStarted:async r=>{if(r?.node?.id)attempt.nodeId=r.node.id;if(r?.attempt_key)attempt.attemptKey=r.attempt_key;await save();}});
      const id=assetId(uploaded);
      if(!id)throw new ApiError('upload_pending','Upload has not returned a completed media asset yet.',{nodeId:attempt.nodeId,workflowId:attempt.workflowId});
      const found=uploaded.asset||await accessMedia(client,id);
      const media=found?{name:file.name,size_bytes:file.bytes,media_type:file.kind,...found}:null;
      if(!media)throw new ApiError('upload_pending','Upload finished but the media is not available yet.',{nodeId:attempt.nodeId,workflowId:attempt.workflowId});
      remember(index,media,file);delete index.pending[file.sha256];await save();
      return result(media,Boolean(resume),resume?'resumed_library_upload':'new_content',uploaded.node?.id?{nodeId:uploaded.node.id,workflowId:uploadInput.workflowId}:{});
    }catch(e){await save();throw e;}
  });
}
