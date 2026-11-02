import path from 'node:path';
import {mkdir, stat, readFile, unlink, copyFile} from 'node:fs/promises';
import {createWriteStream,constants} from 'node:fs';
import {Readable} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import {randomUUID} from 'node:crypto';
import {ApiError} from './client.js';
import {mediaResponse} from './media-source.js';
import {ensureFile} from './media-dedup.js';
export function safeDestination(outputDir,fileName) {
  if(!path.isAbsolute(outputDir) || !fileName || fileName=== '.' || fileName==='..' || path.basename(fileName)!==fileName || /[\\\x00]/.test(fileName))throw new ApiError('invalid_path','Use an absolute output directory and a single file name.');
  return path.join(outputDir,fileName);
}
export async function download(client,input) {
  const {media}=await client.http(`/media-library/${input.mediaAssetId}/access`);
  const response=await mediaResponse(client,media);
  const contentType=response.headers.get('content-type') || '';
  if(!/^(image|video|audio)\//.test(contentType) && !contentType.includes('octet-stream')){await response.body.cancel();throw new ApiError('unexpected_download','Server did not return media.');}
  const ext={'image/png':'.png','image/jpeg':'.jpg','image/webp':'.webp','video/mp4':'.mp4','video/webm':'.webm','audio/mpeg':'.mp3','audio/wav':'.wav','audio/mp4':'.m4a'}[contentType.split(';')[0]] || '.bin';
  const name=(media.name||'media').replace(/[^\p{L}\p{N}._-]+/gu,'_').replace(/^\.+/,'').slice(0,100)||'media';
  const fileName=input.fileName||`${name}-${input.mediaAssetId}${ext}`;
  const destination=safeDestination(input.outputDir,fileName);await mkdir(input.outputDir,{recursive:true});
  const temp=path.join(input.outputDir,`.neurover-${randomUUID()}.part`);
  try{await pipeline(Readable.fromWeb(response.body),createWriteStream(temp,{flags:'wx',mode:0o600}));await copyFile(temp,destination,constants.COPYFILE_EXCL);}finally{await unlink(temp).catch(()=>{});}
  return {status:'saved',mediaAssetId:input.mediaAssetId,path:destination,bytes:(await stat(destination)).size,contentType};
}
async function uploadNew(client,input,buffer,attempt) {
  const start=await client.http(`/workflows/${input.workflowId}/uploads/start`,{method:'POST',data:{uuid:attempt.uuid,original_name:path.basename(input.filePath),position:input.position||{x:100,y:100},size:{width:320,height:240},reference_target_node_id:null}});
  await attempt.onStarted(start);
  if(start.node?.status==='completed')return start;
  if(!start.node?.id||!start.attempt_key)throw new ApiError('upload_uncertain','Upload placeholder could not be confirmed. Inspect the workflow before retrying.');
  const form=new FormData();form.append('attempt_key',start.attempt_key);form.append('file',new Blob([buffer],{type:input.mimeType}),path.basename(input.filePath));
  try{return await client.http(`/workflows/${input.workflowId}/uploads/${start.node.id}/file`,{method:'POST',multipart:form});}
  catch(e){throw new ApiError('upload_incomplete','Upload outcome is uncertain; it will not be automatically repeated.',{nodeId:start.node.id,cause:e.code});}
}
// Same route as the chat "Прикрепить референсы → Загрузить" button: media-library only, no canvas node.
const storageHeaders=new Set(['host','content-length','cookie','authorization']);
export async function uploadToLibrary(client,input,buffer,attempt) {
  const base=`/workflows/${input.workflowId}/media-library/uploads`,name=path.basename(input.filePath),{aiModelId,referenceField}=input.library||{};
  if(!aiModelId||!referenceField)throw new ApiError('reference_field_required','Library upload needs the target model and reference field.');
  const start=await client.http(base+'/direct',{method:'POST',data:{client_upload_id:attempt.uuid,ai_model_id:aiModelId,reference_field:referenceField,original_name:name,mime_type:input.mimeType,size_bytes:buffer.length}});
  await attempt.onStarted?.(start);
  if(start?.asset)return {asset:start.asset,replayed:start.replayed===true};
  if(start?.available&&start.upload) {
    let url;try{url=new URL(start.upload.url);}catch{throw new ApiError('upload_uncertain','Storage upload URL is invalid; nothing was sent.');}
    if(url.protocol!=='https:'||url.username||url.password)throw new ApiError('upload_uncertain','Unsupported storage upload URL; nothing was sent.');
    const headers=new Headers();
    for(const [k,v] of Object.entries(start.upload.headers??{})){if(storageHeaders.has(k.toLowerCase()))continue;const value=Array.isArray(v)?v.join(','):String(v);if(value!=='')headers.set(k,value);}
    if(!headers.has('content-type')&&input.mimeType)headers.set('Content-Type',input.mimeType);
    let put;
    try{put=await fetch(url,{method:'PUT',body:buffer,headers,redirect:'error',signal:AbortSignal.timeout(300000)});}
    catch{throw new ApiError('upload_incomplete','Storage upload outcome is uncertain; the next attempt resumes the same upload ID.',{uploadUuid:attempt.uuid});}
    await put.body?.cancel();
    if(!put.ok)throw new ApiError('upload_incomplete',`Storage returned HTTP ${put.status}; the next attempt resumes the same upload ID.`,{uploadUuid:attempt.uuid});
    const done=await client.http(base+'/direct/complete',{method:'POST',data:{client_upload_id:attempt.uuid,token:start.upload.token}});
    return {asset:done?.asset,replayed:done?.replayed===true};
  }
  const form=new FormData();form.append('client_upload_id',attempt.uuid);form.append('ai_model_id',String(aiModelId));form.append('reference_field',referenceField);form.append('file',new Blob([buffer],{type:input.mimeType}),name);
  const r=await client.http(base,{method:'POST',multipart:form,timeoutMs:90000});
  return {asset:r?.asset,replayed:r?.replayed===true};
}
// input.library={aiModelId,referenceField} → chat/library upload; otherwise the canvas upload used by neurover_upload_media.
export async function ensureMedia(client,input) {
  return ensureFile(client,input,(data,buffer,attempt)=>data.library?uploadToLibrary(client,data,buffer,attempt):uploadNew(client,data,buffer,attempt));
}
export function compactMedia(r) {
  return {status:r.status,reused:r.reused,reason:r.reason,mediaAssetId:r.mediaAssetId,sha256:r.sha256,bytes:r.bytes,name:r.media.name,mimeType:r.media.mime_type,...r.nodeId?{nodeId:r.nodeId,workflowId:r.workflowId}:{}};
}
export async function upload(client,input) {
  let field=input.referenceField;
  if(input.referenceTargetNodeId){
    const {workflow}=await client.workflow(input.workflowId);
    const target=workflow.graph.nodes.find(n=>n.id===input.referenceTargetNodeId);
    if(!target)throw new ApiError('not_found','Reference target node not found.');
    if(!field){
      const page=await client.page(`/workflows/${input.workflowId}`);
      const model=page.modelOptions?.find(m=>m.id===target.ai_model_id);
      const kind=(input.mimeType||({'.png':'image/', '.jpg':'image/', '.jpeg':'image/', '.webp':'image/', '.mp4':'video/', '.webm':'video/', '.mp3':'audio/', '.wav':'audio/', '.m4a':'audio/'})[path.extname(input.filePath).toLowerCase()]||'').split('/')[0];
      const plural={image:'images',video:'videos',audio:'audios'}[kind];
      field=[plural,'reference_'+plural].find(k=>model?.input_schema_json?.[k]);
    }
    if(!field)throw new ApiError('reference_field_required','Provide referenceField from the target model schema.');
  }
  const r=await ensureMedia(client,input);
  const {workflow}=await client.workflow(input.workflowId);
  let node=workflow.graph.nodes.find(n=>n.type==='asset'&&Number(n.primary_media_asset_id||n.primary_media?.id||n.output?.media_asset_id)===r.mediaAssetId);
  if(!node){
    const added=await client.mutateWorkflow(input.workflowId,'/nodes','POST',{type:'asset',title:r.media.name,position:input.position||{x:100,y:100},size:{width:320,height:240},prompt:'',settings:{},references:[],output:{media_asset_id:r.mediaAssetId,mime_type:r.media.mime_type,size_bytes:r.media.size_bytes,preview_label:r.media.name}});
    node=added.node||added.workflow.graph.nodes.find(n=>n.type==='asset'&&Number(n.primary_media_asset_id||n.primary_media?.id||n.output?.media_asset_id)===r.mediaAssetId);
  }
  if(!node)throw new ApiError('node_uncertain','Media exists but its canvas node could not be confirmed.',{mediaAssetId:r.mediaAssetId});
  if(input.referenceTargetNodeId){
    const current=await client.workflow(input.workflowId);
    if(!current.workflow.graph.edges.some(e=>e.source_node_id===node.id&&e.target_node_id===input.referenceTargetNodeId&&e.target_handle===`in:${field}`))await client.mutateWorkflow(input.workflowId,'/edges','POST',{source_node_id:node.id,target_node_id:input.referenceTargetNodeId,source_handle:'out:'+r.media.mime_type.split('/')[0],target_handle:'in:'+field,type:'derived_from',metadata:{created_from:'mcp',reference_field:field}});
  }
  return {...compactMedia(r),workflowId:input.workflowId,nodeId:node.id,asset:{id:r.mediaAssetId,name:r.media.name},node:{id:node.id,status:node.status,primary_media_asset_id:r.mediaAssetId}};
}
