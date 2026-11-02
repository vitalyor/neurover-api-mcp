import {dataDir} from '../src/paths.js';
import test from 'node:test';
import http from 'node:http';
import assert from 'node:assert/strict';
import {mkdir,rm} from 'node:fs/promises';
import path from 'node:path';
import {createCleanupWeb,requestedRange,stopWhenIdle} from '../src/cleanup-web.js';
import {ApiError,root} from '../src/client.js';
const id='11111111-1111-4111-8111-111111111111',groupId='aaaaaaaaaaaa',token='a'.repeat(64);
const asset=n=>({id:n,name:'Clip '+n,media_type:'audio',mime_type:'audio/mpeg',size_bytes:8,usages:[],blockers:[]});
async function web(t,overrides={}){
 const job={id,account:'fixture',status:'ready',updatedAt:'revision-1',items:[asset(1),asset(2)],groups:[{id:groupId,keepId:1,items:[asset(1),asset(2)],deleteIds:[2],verified:false}]};
 const calls=[];
 const status=async()=>({jobId:id,status:job.status,worker:null,verification:null,pauseRequested:false});
 const server=createCleanupWeb({defaultJobId:id,token,getJob:async jobId=>{if(jobId!==id)throw new ApiError('not_found','Missing fixture');return job;},getClient:async()=>({account:'fixture',http:async()=>({media:{mime_type:'audio/mpeg',preview_url:'https://neurover.io/preview',download_url:'https://neurover.io/download'}})}),operations:{status,verify:async(c,p)=>{calls.push(['verify',p]);return {jobId:id};},approve:async(c,p)=>{calls.push(['approve',p]);return {jobId:id};},start:async()=>{calls.push(['start']);return {jobId:id};},pause:async()=>{calls.push(['pause']);return {jobId:id};},...overrides.operations},...overrides});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 t.after(()=>new Promise(resolve=>{server.close(resolve);server.closeAllConnections();}));
 const base='http://127.0.0.1:'+server.address().port;
 const post=(action,input={},headers={})=>fetch(`${base}/api/jobs/${id}/${action}`,{method:'POST',headers:{Origin:base,'Content-Type':'application/json','X-Cleanup-Token':token,...headers},body:JSON.stringify(input)});
 return {base,post,calls,job};
}
const choice={groupIds:[groupId],groupRetention:{[groupId]:'delete_all'}};
test('new review uses strict authenticated empty command and never approves deletion',async t=>{
 const calls=[],child='22222222-2222-4222-8222-222222222222';const w=await web(t,{operations:{next:async(c,source)=>{calls.push(['next',source]);return {jobId:child,status:'scanning'};},scan:async(c,target)=>{calls.push(['scan',target]);return {jobId:target,background:true};}}});
 assert.equal((await fetch(w.base+'/api/jobs/'+id+'/new')).status,404);assert.equal(calls.length,0);
 assert.equal((await w.post('new',{}, {'X-Cleanup-Token':''})).status,403);assert.equal((await w.post('new',{confirmed:true})).status,400);assert.equal(calls.length,0);
 const r=await w.post('new');assert.equal(r.status,202);assert.equal((await r.json()).jobId,child);assert.deepEqual(calls,[['next',id],['scan',child]]);
});
test('resume restarts scanning without starting deletion or verification',async t=>{
 const calls=[],w=await web(t,{operations:{scan:async(c,target)=>{calls.push(target);return {jobId:target};}}});w.job.status='scanning';assert.equal((await w.post('resume')).status,202);assert.deepEqual(calls,[id]);
});
test('reopening an existing next review never restarts a completed or approved operation',async t=>{
 const calls=[],w=await web(t,{operations:{next:async()=>({jobId:id,status:'running'}),scan:async()=>calls.push('scan'),start:async()=>calls.push('delete')}});const r=await w.post('new');assert.equal(r.status,202);assert.equal((await r.json()).status,'running');assert.equal(calls.length,0);
});
test('inventory worker status changes invalidate ETag even without metadata changes',async t=>{
 let running=true;const w=await web(t,{operations:{status:async()=>({scanner:{running}})}});const first=await fetch(w.base+'/api/jobs/'+id);const etag=first.headers.get('etag');running=false;const second=await fetch(w.base+'/api/jobs/'+id,{headers:{'If-None-Match':etag}});assert.equal(second.status,200);assert.notEqual(second.headers.get('etag'),etag);
});
test('unique file thumbnails are lazy, coalesce concurrent loads and never request originals',async t=>{
 const dir=path.join(dataDir,'cleanup',id);await mkdir(dir,{recursive:true});t.after(()=>rm(dir,{recursive:true,force:true}));
 const w=await web(t,{getClient:async()=>({context:{storageState:async()=>({cookies:[]})}})});w.job.items.push({...asset(3),thumbnail_url:'/media-assets/3/thumbnail'});
 const originalFetch=globalThis.fetch,requests=[];t.mock.method(globalThis,'fetch',async(url,options)=>{if(String(url).startsWith('https://neurover.io/')){requests.push(String(url));return new Response(new Uint8Array([1,2,3]),{headers:{'content-type':'image/webp'}});}return originalFetch(url,options);});
 assert.equal((await fetch(w.base+'/report.html?view=library')).status,200);assert.equal(requests.length,0);
 const responses=await Promise.all([fetch(w.base+'/api/jobs/'+id+'/thumb/3'),fetch(w.base+'/api/jobs/'+id+'/thumb/3')]);for(const response of responses){assert.equal(response.status,200);assert.equal((await response.arrayBuffer()).byteLength,3);}
 assert.deepEqual(requests,['https://neurover.io/media-assets/3/thumbnail']);assert.equal((await fetch(w.base+'/api/jobs/'+id+'/thumb/999')).status,404);
});
test('whole-library page contains every inventory file once without duplicate evidence or remote URLs',async t=>{
 const w=await web(t);w.job.items.push({...asset(3),name:'Unique original'});
 const r=await fetch(w.base+'/report.html?view=library'),html=await r.text();
 const data=JSON.parse(html.match(/<script id="report-data" type="application\/json">([\s\S]*?)<\/script>/)[1]);
 assert.equal(data.view,'library');assert.equal(data.groups.length,3);assert.ok(data.groups.every(g=>g.explicit&&g.items.length===1));assert.equal(data.groups[2].items[0].name,'Unique original');assert.equal(w.calls.length,0);
});
test('exact-file endpoint requires consent and passes only explicit IDs to the durable engine',async t=>{
 const calls=[],w=await web(t,{operations:{status:async()=>({status:'ready'}),approveFiles:async(c,p)=>calls.push(p),start:async()=>calls.push('start')}});
 for(const input of [{mediaAssetIds:[1],expectedUpdatedAt:'revision-1'},{mediaAssetIds:[],confirmed:true,expectedUpdatedAt:'revision-1'},{mediaAssetIds:[1],confirmed:true,expectedUpdatedAt:'revision-1',allowUsedOnCanvas:true}])assert.equal((await w.post('files-delete',input)).status,400);
 assert.equal(calls.length,0);assert.equal((await w.post('files-delete',{mediaAssetIds:[1],confirmed:true,expectedUpdatedAt:'revision-1'})).status,202);
 assert.deepEqual(calls,[{jobId:id,mediaAssetIds:[1],confirm:true,expectedUpdatedAt:'revision-1'},'start']);
});
test('exact-file endpoint never launches after stale approval or during verification',async t=>{
 const calls=[],w=await web(t,{operations:{status:async()=>({verification:{running:true}}),approveFiles:async()=>calls.push('approve'),start:async()=>calls.push('start')}});
 assert.equal((await w.post('files-delete',{mediaAssetIds:[1],confirmed:true,expectedUpdatedAt:'revision-1'})).status,409);assert.equal(calls.length,0);
});
test('local report exposes live capability without remote source URLs or embedded original data',async t=>{
 const w=await web(t),r=await fetch(w.base+'/report.html'),html=await r.text();assert.equal(r.status,200);
 assert.ok(html.includes('connect-src'));assert.ok(html.includes('media-src'));assert.ok(html.includes('"token":"'+token+'"'));assert.ok(!html.includes('https://neurover.io/preview'));
});
test('foreign Origin, missing token, cross-site and rebinding Host cannot start operations',async t=>{
 const w=await web(t);
 for(const headers of [{Origin:'https://evil.test'},{'X-Cleanup-Token':''},{'Sec-Fetch-Site':'cross-site'}]){
  const r=await w.post('verify',choice,headers);assert.equal(r.status,403,JSON.stringify(headers));assert.equal(w.calls.length,0);
 }
 const rebinding=await new Promise((resolve,reject)=>{const req=http.request(w.base+'/api/jobs/'+id,{headers:{Host:'evil.test'}},res=>{res.resume();resolve(res.statusCode);});req.on('error',reject);req.end();});assert.equal(rebinding,403);assert.equal(w.calls.length,0);
});
test('verification dispatches an exact selection and never approves deletion',async t=>{
 const w=await web(t),r=await w.post('verify',choice);assert.equal(r.status,202);
 assert.deepEqual(w.calls,[['verify',{jobId:id,...choice}]]);
});
test('empty, repeated and unexpected request fields cannot widen a selection',async t=>{
 const w=await web(t);
 for(const input of [{groupIds:[]},{groupIds:[groupId,groupId]},{...choice,allowUsedOnCanvas:true},{...choice,mode:'metadata'}]){
  const r=await w.post('verify',input);assert.ok(r.status>=400);assert.equal(w.calls.length,0);
 }
});
test('metadata deletion requires separate risk acknowledgement and freezes protected-file behavior',async t=>{
 const w=await web(t),input={...choice,mode:'metadata',confirmed:true,expectedUpdatedAt:'revision-1'};
 assert.equal((await w.post('delete',input)).status,409);assert.equal(w.calls.length,0);
 assert.equal((await w.post('delete',{...input,riskAccepted:true})).status,202);
 assert.deepEqual(w.calls[0],['approve',{jobId:id,...choice,mode:'metadata',confirm:true,allowUsedOnCanvas:false,expectedUpdatedAt:'revision-1'}]);assert.equal(w.calls[1][0],'start');
});
test('unconfirmed deletion and approval failures never launch a worker',async t=>{
 const calls=[],w=await web(t,{operations:{status:async()=>({}),approve:async()=>{calls.push('approve');throw new ApiError('stale_review','Changed');},start:async()=>calls.push('start')}});
 assert.equal((await w.post('delete',{...choice,mode:'hash',expectedUpdatedAt:'revision-1'})).status,400);
 const r=await w.post('delete',{...choice,mode:'hash',confirmed:true,expectedUpdatedAt:'revision-1'});assert.equal(r.status,409);assert.deepEqual(calls,['approve']);
});
test('deletion is blocked during verification and pause is a separate bounded command',async t=>{
 const calls=[],w=await web(t,{operations:{status:async()=>({verification:{running:true}}),approve:async()=>calls.push('approve'),pause:async()=>{calls.push('pause');return {};}}});
 assert.equal((await w.post('delete',{...choice,mode:'hash',confirmed:true,expectedUpdatedAt:'revision-1'})).status,409);
 assert.equal((await w.post('pause')).status,202);assert.deepEqual(calls,['pause']);
});
test('status polling has a compact stable ETag and no mutations',async t=>{
 const w=await web(t),r=await fetch(w.base+'/api/jobs/'+id),etag=r.headers.get('etag');await r.json();
 assert.equal(etag.length,66);assert.equal((await fetch(w.base+'/api/jobs/'+id,{headers:{'If-None-Match':etag}})).status,304);assert.equal(w.calls.length,0);
});
test('media streams bytes on request, preserves Range, and does not expose server URLs',async t=>{
 let requested;
 const w=await web(t,{openMedia:async(c,m,options)=>{requested={m,options};return new Response('abcd',{status:206,headers:{'Content-Type':'audio/mpeg','Content-Range':'bytes 0-3/8','Content-Length':'4','Accept-Ranges':'bytes'}});}});
 const r=await fetch(w.base+`/api/jobs/${id}/media/1`,{headers:{Range:'bytes=0-3'}});
 assert.equal(r.status,206);assert.equal(await r.text(),'abcd');assert.equal(r.headers.get('content-range'),'bytes 0-3/8');assert.equal(r.headers.get('cache-control'),'private, no-store');assert.equal(requested.options.range,'bytes=0-3');assert.equal(requested.m.download_url,'https://neurover.io/preview');
});
test('foreign asset IDs and multi-range requests never reach the media source',async t=>{
 let opens=0;const w=await web(t,{openMedia:async()=>{opens++;return new Response('no');}});
 assert.equal((await fetch(w.base+`/api/jobs/${id}/media/99`)).status,404);
 assert.equal((await fetch(w.base+`/api/jobs/${id}/media/1`,{headers:{Range:'bytes=0-3,5-6'}})).status,416);assert.equal(opens,0);
});
test('byte ranges handle initial metadata probes, suffixes and unsatisfiable positions',()=>{
 assert.deepEqual(requestedRange('bytes=0-1',8),{start:0,end:1,size:8,length:2});
 assert.deepEqual(requestedRange('bytes=-3',8),{start:5,end:7,size:8,length:3});
 assert.deepEqual(requestedRange('bytes=5-',8),{start:5,end:7,size:8,length:3});
 assert.equal(requestedRange('bytes=8-',8).invalid,true);assert.equal(requestedRange('bytes=-0',8).invalid,true);
});
test('an upstream server ignoring Range still produces exact streaming 206 responses',async t=>{
 const w=await web(t,{openMedia:async()=>new Response('abcdefgh',{headers:{'Content-Type':'audio/mpeg','Content-Length':'8'}})});
 const base=w.base+`/api/jobs/${id}/media/1`;
 const r=await fetch(base,{headers:{Range:'bytes=0-1'}});assert.equal(r.status,206);assert.equal(r.headers.get('content-range'),'bytes 0-1/8');assert.equal(await r.text(),'ab');
 const tail=await fetch(base,{headers:{Range:'bytes=-3'}});assert.equal(await tail.text(),'fgh');
 const missing=await fetch(base,{headers:{Range:'bytes=8-'}});assert.equal(missing.status,416);
});
test('closing media playback aborts the upstream stream instead of downloading it to completion',async t=>{
 let aborted=false,pulls=0;
 const w=await web(t,{openMedia:async(c,m,{signal})=>{signal.addEventListener('abort',()=>aborted=true);return new Response(new ReadableStream({async pull(controller){pulls++;await new Promise(resolve=>setTimeout(resolve,2));if(signal.aborted){controller.close();return;}controller.enqueue(new Uint8Array(1024));}}),{headers:{'Content-Type':'audio/mpeg'}});}});
 const r=await fetch(w.base+`/api/jobs/${id}/media/1`);const reader=r.body.getReader();await reader.read();await reader.cancel();
 for(let n=0;n<40&&!aborted;n++)await new Promise(resolve=>setTimeout(resolve,5));
 assert.equal(aborted,true);assert.ok(pulls<100);
});

async function idleServer(t,handler=(req,res)=>res.end('ok')){
 const server=http.createServer(handler);await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 let idleAt=null;const timer=stopWhenIdle(server,{idleMs:300,checkMs:10,onIdle:()=>{idleAt=Date.now();}});
 t.after(()=>{clearInterval(timer);server.closeAllConnections();server.close();});
 return {base:`http://127.0.0.1:${server.address().port}`,idle:()=>idleAt};
}
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
test('idle gallery shuts down after the configured quiet period',async t=>{
 const s=await idleServer(t);await fetch(s.base);
 await pause(100);assert.equal(s.idle(),null);
 for(let n=0;n<100&&!s.idle();n++)await pause(10);
 assert.ok(s.idle(),'server should report idle after quiet period');
});
test('an open page polling the gallery keeps it alive',async t=>{
 const s=await idleServer(t);
 for(let n=0;n<12;n++){await fetch(s.base);await pause(50);}
 assert.equal(s.idle(),null,"polling every 50 ms must keep a 300 ms idle timer from firing");
 for(let n=0;n<100&&!s.idle();n++)await pause(10);
 assert.ok(s.idle(),'idle timer fires once polling stops');
});
test('a long request in flight blocks idle shutdown until it finishes',async t=>{
 let release;const held=new Promise(resolve=>release=resolve);
 const s=await idleServer(t,async(req,res)=>{await held;res.end('done');});
 const pending=fetch(s.base);await pause(600);
 assert.equal(s.idle(),null,'shutdown must wait for the open request');
 release();await (await pending).text();
 for(let n=0;n<100&&!s.idle();n++)await pause(10);
 assert.ok(s.idle());
});
