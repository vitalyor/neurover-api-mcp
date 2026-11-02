import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm,copyFile} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {ensureFile} from '../src/media-dedup.js';
import {ApiError} from '../src/client.js';

async function fixture(t) {
  const dir=await mkdtemp(path.join(os.tmpdir(),'neurover-dedup-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  const bytes=Buffer.from('same-original-image');const file=path.join(dir,'ref.png');await writeFile(file,bytes);
  const assets=new Map(),nodes=[];let count=0,next=100;let unavailable=false,failAccess=false,failList=false;
  const client={account:'test',context:{storageState:async()=>({cookies:[]})},http:async(url)=>{
    if(url.startsWith('/workflows/'))return {workflow:{graph:{nodes}}};
    if(url.includes('/access')) {
      if(failAccess)throw new ApiError('network_error','test network failure');
      const id=Number(url.match(/\/(\d+)\/access/)[1]),a=assets.get(id);
      if(!a)throw new ApiError('http_404','missing');return {media:{id:a.id,mime_type:a.mime_type,available:!unavailable,download_url:'https://neurover.io/file/'+id}};
    }
    if(failList)throw new ApiError('network_error','test inventory failure');
    const u=new URL(url,'https://neurover.io');const search=u.searchParams.get('search');
    return {items:[...assets.values()].filter(a=>!search||a.name.includes(search)),pagination:{has_more:false}};
  }};
  const add=(id,name,data=bytes)=>assets.set(id,{id,name,media_type:'image',mime_type:'image/png',size_bytes:data.length,available:true,data});
  t.mock.method(globalThis,'fetch',async url=>{const a=assets.get(Number(new URL(url).pathname.split('/').at(-1)));return new Response(a?.data,{status:a?200:404,headers:{'content-type':'image/png'}});});
  const upload=async(input,buffer,attempt)=>{
    count++;const id=next++;const node={id:id+1000,uuid:attempt.uuid,status:'completed',primary_media_asset_id:id};nodes.push(node);await attempt.onStarted({node,attempt_key:'test-key'});
    add(id,path.basename(input.filePath),buffer);return {asset:{id,mime_type:'image/png',download_url:'https://neurover.io/file/'+id},node};
  };
  const run=(input={},u=upload,index=path.join(dir,'index'))=>ensureFile(client,{workflowId:1,filePath:file,...input},u,index);
  return {dir,file,bytes,assets,nodes,add,run,upload,client,count:()=>count,setFailAccess:v=>failAccess=v,setFailList:v=>failList=v};
}
test('finds an existing byte-identical library file despite duplicate names',async t=>{
  const f=await fixture(t);f.add(1,'ref.png');f.add(2,'ref.png');const r=await f.run();assert.equal(r.reused,true);assert.equal(f.count(),0);assert.equal(r.mediaAssetId,1);assert.equal(r.media.name,'ref.png');assert.equal(r.media.media_type,'image');
});
test('persistent hash index reuses a renamed local file without listing the library',async t=>{
  const f=await fixture(t);const first=await f.run();const other=path.join(f.dir,'renamed.png');await copyFile(f.file,other);f.setFailList(true);
  const second=await f.run({filePath:other});assert.equal(first.mediaAssetId,second.mediaAssetId);assert.equal(second.reason,'persistent_content_match');assert.equal(f.count(),1);
  const index=JSON.parse(await readFile(path.join(f.dir,'index/media-index.json'),'utf8'));assert.equal(index.assets[first.mediaAssetId].sha256,first.sha256);
});
test('cold index finds identical contents under a different remote name',async t=>{
  const f=await fixture(t);f.add(7,'different-name.png');const r=await f.run();assert.equal(r.mediaAssetId,7);assert.equal(f.count(),0);
});
test('same filename and size with different contents must not match',async t=>{
  const f=await fixture(t);f.add(7,'ref.png',Buffer.alloc(f.bytes.length,65));const r=await f.run();assert.equal(r.reused,false);assert.notEqual(r.mediaAssetId,7);assert.equal(f.count(),1);
});
test('changing bytes at the same local path produces a new asset',async t=>{
  const f=await fixture(t);const first=await f.run();await writeFile(f.file,Buffer.alloc(f.bytes.length,66));const second=await f.run();assert.notEqual(first.mediaAssetId,second.mediaAssetId);assert.equal(f.count(),2);
});
test('deleted cached asset is detected and replacement is remembered',async t=>{
  const f=await fixture(t);const first=await f.run();f.assets.delete(first.mediaAssetId);const second=await f.run();assert.notEqual(first.mediaAssetId,second.mediaAssetId);assert.equal(f.count(),2);assert.equal((await f.run()).mediaAssetId,second.mediaAssetId);
});
test('network failure while checking cached media never falls back to uploading',async t=>{
  const f=await fixture(t);await f.run();f.setFailAccess(true);await assert.rejects(f.run(),{code:'network_error'});assert.equal(f.count(),1);
});
test('incomplete inventory blocks a new upload',async t=>{
  const f=await fixture(t);f.setFailList(true);await assert.rejects(f.run(),{code:'network_error'});assert.equal(f.count(),0);
});
test('two concurrent callers upload identical content once',async t=>{
  const f=await fixture(t);const results=await Promise.all([f.run(),f.run()]);assert.equal(results[0].mediaAssetId,results[1].mediaAssetId);assert.equal(f.count(),1);
});
test('separate account indexes do not share upload identities',async t=>{
  const f=await fixture(t);await f.run();f.assets.clear();await f.run({},f.upload,path.join(f.dir,'other-account'));assert.equal(f.count(),2);
});
test('lost successful upload response is recovered without another upload',async t=>{
  const f=await fixture(t);const uncertain=async(...args)=>{await f.upload(...args);throw new ApiError('request_uncertain','lost response');};
  await assert.rejects(f.run({},uncertain),{code:'request_uncertain'});const r=await f.run();assert.equal(r.reason,'recovered_upload');assert.equal(f.count(),1);
});
test('an uncertain upload with no confirmed result is never repeated',async t=>{
  const f=await fixture(t);let attempts=0;const uncertain=async()=>{attempts++;throw new ApiError('request_uncertain','unknown');};
  await assert.rejects(f.run({},uncertain),{code:'request_uncertain'});await assert.rejects(f.run({},uncertain),{code:'upload_pending'});assert.equal(attempts,1);
});
test('a file changed during remote checking is rejected before any server write',async t=>{
  const f=await fixture(t);const original=f.client.http;f.client.http=async url=>{await writeFile(f.file,'changed content');return original(url);};
  await assert.rejects(f.run(),{code:'file_changed'});assert.equal(f.count(),0);
});
test('corrupt persistent index cannot silently cause duplicate uploads',async t=>{
  const f=await fixture(t);await f.run();await writeFile(path.join(f.dir,'index/media-index.json'),'invalid json');await assert.rejects(f.run(),{code:'media_index_unreadable'});assert.equal(f.count(),1);
});
