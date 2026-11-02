import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {ensureFile} from '../src/media-dedup.js';
import {uploadToLibrary} from '../src/media.js';
import {ensureLibraryMedia,referenceField} from '../src/generation.js';
import {ApiError} from '../src/client.js';

// Fake Neurover: chat-style uploads go to /media-library/uploads*, never to canvas routes.
async function fixture(t,mode='asset') {
  const dir=await mkdtemp(path.join(os.tmpdir(),'neurover-library-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  const bytes=Buffer.from('chat-reference-image');const file=path.join(dir,'ref.png');await writeFile(file,bytes);
  const assets=new Map(),calls=[],byClientId=new Map();let next=500,loseResponse=false;
  const store=(clientId,data)=>{if(byClientId.has(clientId))return {asset:assets.get(byClientId.get(clientId)),replayed:true};const id=next++;const a={id,name:'ref.png',media_type:'image',mime_type:'image/png',size_bytes:data.length,available:true,download_url:'https://neurover.io/file/'+id,data};assets.set(id,a);byClientId.set(clientId,id);return {asset:a};};
  let pendingBody=null;
  const client={account:'test',context:{storageState:async()=>({cookies:[]})},http:async(url,o={})=>{
    calls.push({url,method:o.method||'GET',data:o.data,multipart:o.multipart});
    if(/uploads\/start|\/nodes|\/uploads\/\d+\/file/.test(url))throw new Error('canvas route used: '+url);
    if(url.endsWith('/media-library/uploads/direct')) {
      const d=o.data;if(byClientId.has(d.client_upload_id))return {asset:assets.get(byClientId.get(d.client_upload_id)),replayed:true};
      if(mode==='asset'){const r=store(d.client_upload_id,bytes);if(loseResponse){loseResponse=false;throw new ApiError('request_uncertain','lost');}return r;}
      if(mode==='presigned')return {available:true,upload:{url:'https://storage.example/put/'+d.client_upload_id,headers:{'Content-Type':'image/png',Host:'evil'},token:'tok-'+d.client_upload_id}};
      return {available:false};
    }
    if(url.endsWith('/media-library/uploads/direct/complete')){assert.equal(o.data.token,'tok-'+o.data.client_upload_id);return store(o.data.client_upload_id,pendingBody);}
    if(url.endsWith('/media-library/uploads')){const f=o.multipart;return store(f.get('client_upload_id'),Buffer.from(await f.get('file').arrayBuffer()));}
    if(url.includes('/access')){const a=assets.get(Number(url.match(/\/(\d+)\/access/)[1]));if(!a)throw new ApiError('http_404','missing');return {media:a};}
    if(url.startsWith('/media-library?'))return {items:[...assets.values()],pagination:{has_more:false}};
    throw new Error('unexpected '+url);
  }};
  t.mock.method(globalThis,'fetch',async(url,o={})=>{
    const u=new URL(url);
    if(u.hostname==='storage.example'){assert.equal(o.method,'PUT');assert.equal(o.headers.get('host'),null);pendingBody=Buffer.from(o.body);return new Response(null,{status:200});}
    const a=assets.get(Number(u.pathname.split('/').at(-1)));return new Response(a?.data,{status:a?200:404,headers:{'content-type':'image/png'}});
  });
  const upload=(d,b,a)=>uploadToLibrary(client,d,b,a);
  const run=(input={},u=upload)=>ensureFile(client,{workflowId:1,filePath:file,library:{aiModelId:7,referenceField:'images'},...input},u,path.join(dir,'index'));
  return {dir,file,assets,calls,run,client,lose:()=>loseResponse=true};
}
const writes=f=>f.calls.filter(c=>c.method!=='GET');
test('chat reference upload uses the media-library route and creates no canvas node',async t=>{
  const f=await fixture(t);const r=await f.run();
  assert.equal(r.reused,false);assert.equal(r.reason,'new_content');assert.equal(r.nodeId,undefined);
  const w=writes(f);assert.equal(w.length,1);assert.equal(w[0].url,'/workflows/1/media-library/uploads/direct');
  assert.deepEqual({...w[0].data,client_upload_id:undefined},{client_upload_id:undefined,ai_model_id:7,reference_field:'images',original_name:'ref.png',mime_type:'image/png',size_bytes:20});
});
test('presigned direct upload PUTs to storage and completes with the token',async t=>{
  const f=await fixture(t,'presigned');const r=await f.run();
  assert.equal(r.reason,'new_content');assert.deepEqual(writes(f).map(c=>c.url),['/workflows/1/media-library/uploads/direct','/workflows/1/media-library/uploads/direct/complete']);
  assert.equal(f.assets.get(r.mediaAssetId).data.toString(),'chat-reference-image');
});
test('falls back to multipart library upload when direct storage is unavailable',async t=>{
  const f=await fixture(t,'multipart');const r=await f.run();
  assert.deepEqual(writes(f).map(c=>c.url),['/workflows/1/media-library/uploads/direct','/workflows/1/media-library/uploads']);
  assert.equal(r.nodeId,undefined);assert.equal(f.assets.size,1);
});
test('identical content already in the library is reused without any upload',async t=>{
  const f=await fixture(t);const first=await f.run();f.calls.length=0;const second=await f.run();
  assert.equal(second.mediaAssetId,first.mediaAssetId);assert.equal(second.reused,true);assert.equal(writes(f).length,0);
});
test('a lost chat upload response is resumed with the same client_upload_id, never duplicated',async t=>{
  const f=await fixture(t);f.lose();await assert.rejects(f.run(),{code:'request_uncertain'});
  // The library scan already finds the stored bytes, so no second write is needed.
  const r=await f.run();assert.equal(f.assets.size,1);assert.equal(r.reused,true);
});
test('a pending chat upload whose bytes never landed resumes with the same upload ID',async t=>{
  const f=await fixture(t);let firstId;
  const failing=async(d,b,a)=>{firstId=a.uuid;throw new ApiError('upload_incomplete','storage failed');};
  await assert.rejects(f.run({},failing),{code:'upload_incomplete'});f.calls.length=0;
  const r=await f.run();assert.equal(r.reason,'resumed_library_upload');assert.equal(writes(f)[0].data.client_upload_id,firstId);assert.equal(f.assets.size,1);
});
test('the canvas uploader does not resume a pending chat upload',async t=>{
  const f=await fixture(t);
  await assert.rejects(f.run({},async()=>{throw new ApiError('upload_incomplete','x');}),{code:'upload_incomplete'});
  await assert.rejects(f.run({library:undefined},async()=>{throw new Error('must not upload');}),{code:'upload_pending'});
});
test('reference field is resolved before upload; incompatible models upload nothing',async t=>{
  const f=await fixture(t);const model={id:7,input_schema_json:{prompt:{},reference_images:{}}};
  assert.equal(referenceField(model,'image'),'reference_images');assert.equal(referenceField(model,'video'),null);
  await assert.rejects(ensureLibraryMedia(f.client,{id:8,input_schema_json:{prompt:{}}},{workflowId:1,filePath:f.file}),{code:'incompatible_reference'});
  assert.equal(writes(f).length,0);
});
