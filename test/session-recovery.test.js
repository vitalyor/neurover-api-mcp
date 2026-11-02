import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {NeuroverClient,ApiError,authenticatedRead} from '../src/client.js';
import {mediaResponse} from '../src/media-source.js';
import {thumbnail} from '../src/cleanup-report.js';

test('an old client recovers successive expired GET sessions without a process or page reload',async()=>{
 let authenticated=false,logins=0,reads=0,expiredStatus=401;
 const c=new NeuroverClient('fixture',{fetch:async()=>{reads++;const status=authenticated?200:expiredStatus;return {status:()=>status,headers:()=>({'content-type':'application/json'}),json:async()=>authenticated?{media:{id:1}}:{},dispose:async()=>{}};}});
 c.save=async()=>{};c.login=async()=>{logins++;authenticated=true;};
 for(const status of [401,419]){expiredStatus=status;authenticated=false;assert.deepEqual(await c.http('/media-library/1/access'),{media:{id:1}});}
 assert.equal(logins,2);assert.equal(reads,4);
});
test('concurrent expired reads share one login and retry using the refreshed session',async()=>{
 let authenticated=false,logins=0;
 const c={login:async()=>{logins++;authenticated=true;}};
 const read=async()=>{if(!authenticated)throw new ApiError('login_required','Expired');return 'ok';};
 assert.deepEqual(await Promise.all(Array.from({length:12},()=>authenticatedRead(c,read))),Array(12).fill('ok'));assert.equal(logins,1);
});
test('failed reauthentication is bounded and briefly shared instead of hammering login',async()=>{
 let logins=0,reads=0;const c={login:async()=>{logins++;throw new ApiError('needs_attention','Maintenance or CAPTCHA');}};
 const read=async()=>{reads++;throw new ApiError('login_required','Expired');};
 for(let i=0;i<3;i++)await assert.rejects(authenticatedRead(c,read),{code:'needs_attention'});
 assert.equal(logins,1);assert.equal(reads,3);
});
test('a still-unauthorized retry stops after one login; writes and transport errors are never replayed',async()=>{
 let logins=0,reads=0;
 const c=new NeuroverClient('fixture',{fetch:async()=>{reads++;return {status:()=>401,headers:()=>({'content-type':'application/json'}),json:async()=>({}),dispose:async()=>{}};}});
 c.save=async()=>{};c.csrf='fixture';c.login=async()=>{logins++;};
 await assert.rejects(c.http('/media-library/1/access'),{code:'login_required'});assert.equal(reads,2);assert.equal(logins,1);
 await assert.rejects(c.http('/workflows/1/media-library',{method:'DELETE',data:{}}),{code:'login_required'});assert.equal(reads,3);assert.equal(logins,1);
 c.context.fetch=async()=>{reads++;throw Error('Disconnected');};
 await assert.rejects(c.http('/media-library/1/access'),{code:'network_error'});assert.equal(reads,4);assert.equal(logins,1);
});
test('successful login followed by another unauthorized read also cools down recovery',async()=>{
 let logins=0,reads=0;const c={login:async()=>{logins++;}};const read=async()=>{reads++;throw new ApiError('login_required','Still unavailable');};
 await assert.rejects(authenticatedRead(c,read),{code:'login_required'});await assert.rejects(authenticatedRead(c,read),{code:'login_required'});assert.equal(logins,1);assert.equal(reads,3);
});
test('media HEAD and Range survive cookie expiry and use refreshed cookies on the same request',async t=>{
 let authenticated=false,logins=0;const requests=[];
 const c={login:async()=>{logins++;authenticated=true;},context:{storageState:async()=>({cookies:[{name:'session',value:authenticated?'new':'old',domain:'neurover.io',path:'/',expires:-1}]})}};
 t.mock.method(globalThis,'fetch',async(url,options)=>{requests.push(options);return authenticated?new Response(null,{status:206,headers:{'content-type':'video/mp4','content-range':'bytes 0-1/100'}}):new Response(null,{status:401});});
 const r=await mediaResponse(c,{download_url:'https://neurover.io/video'},{method:'HEAD',range:'bytes=0-1'});
 assert.equal(r.status,206);assert.equal(logins,1);assert.equal(requests.length,2);assert.equal(requests[1].headers.Cookie,'session=new');assert.equal(requests[1].headers.Range,'bytes=0-1');assert.equal(requests[1].method,'HEAD');
});
test('thumbnail cookie expiry recovers automatically without fetching an original',async t=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'neurover-session-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 let authenticated=false,logins=0;const urls=[];
 const c={login:async()=>{logins++;authenticated=true;},context:{storageState:async()=>({cookies:[]})}};
 t.mock.method(globalThis,'fetch',async url=>{urls.push(String(url));return authenticated?new Response(new Uint8Array([1,2]),{headers:{'content-type':'image/webp'}}):new Response(null,{status:302,headers:{location:'/?auth=login'}});});
 const value=await thumbnail(c,{keepId:1,items:[{id:1,thumbnail_url:'/media-assets/1/thumbnail'}]},dir);
 assert.ok(value.startsWith('data:image/webp;base64,'));assert.equal(logins,1);assert.deepEqual(urls,['https://neurover.io/media-assets/1/thumbnail','https://neurover.io/media-assets/1/thumbnail']);
});
test('foreign-host authentication errors do not send credentials or start a Neurover login',async t=>{
 let logins=0;const c={login:async()=>{logins++;},context:{storageState:async()=>({cookies:[]})}};
 t.mock.method(globalThis,'fetch',async()=>new Response(null,{status:401}));
 await assert.rejects(mediaResponse(c,{download_url:'https://cdn.example.com/video'}),{code:'download_failed'});assert.equal(logins,0);
});
