import path from 'node:path';
import {mkdir, stat, unlink, copyFile} from 'node:fs/promises';
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
  const ext={'image/png':'.png','image/jpeg':'.jpg','image/webp':'.webp','image/gif':'.gif','video/mp4':'.mp4','video/webm':'.webm','audio/mpeg':'.mp3','audio/wav':'.wav','audio/mp4':'.m4a'}[contentType.split(';')[0]] || '.bin';
  const name=(media.name||'media').replace(/[^\p{L}\p{N}._-]+/gu,'_').replace(/^\.+/,'').slice(0,100)||'media';
  const fileName=input.fileName?(path.extname(input.fileName)?input.fileName:input.fileName+ext):`${name}-${input.mediaAssetId}${ext}`;
  const destination=safeDestination(input.outputDir,fileName);await mkdir(input.outputDir,{recursive:true});
  const temp=path.join(input.outputDir,`.neurover-${randomUUID()}.part`);
  try{await pipeline(Readable.fromWeb(response.body),createWriteStream(temp,{flags:'wx',mode:0o600}));await copyFile(temp,destination,constants.COPYFILE_EXCL);}finally{await unlink(temp).catch(()=>{});}
  return {status:'saved',mediaAssetId:input.mediaAssetId,path:destination,bytes:(await stat(destination)).size,contentType};
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
// Every upload goes to the media library like the chat button; input.library={aiModelId,referenceField} is required.
// The canvas upload (/uploads/start) was removed: it added an asset node to the workflow.
export async function ensureMedia(client,input) {
  return ensureFile(client,input,(data,buffer,attempt)=>uploadToLibrary(client,data,buffer,attempt));
}
export function compactMedia(r) {
  return {status:r.status,reused:r.reused,reason:r.reason,mediaAssetId:r.mediaAssetId,sha256:r.sha256,bytes:r.bytes,name:r.media.name,mimeType:r.media.mime_type,...r.nodeId?{nodeId:r.nodeId,workflowId:r.workflowId}:{}};
}
