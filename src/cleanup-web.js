import {dataDir} from './paths.js';
import http from 'node:http';
import path from 'node:path';
import {randomBytes,timingSafeEqual,createHash} from 'node:crypto';
import {readFile,access} from 'node:fs/promises';
import {Readable} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import {fileURLToPath} from 'node:url';
import {z} from 'zod';
import {ApiError,root,clientFor,privateJson,serial} from './client.js';
import {loadCleanup,cleanupStatus,startVerification,approveCleanup,approveFiles,startCleanup,pauseCleanup,nextCleanup,startScan} from './cleanup.js';
import {renderReport,libraryGroups,thumbnail} from './cleanup-report.js';
import {mediaResponse} from './media-source.js';

const choices=z.object({groupIds:z.array(z.string().regex(/^[a-f0-9]{12}$/)).min(1).max(10000),groupRetention:z.record(z.string(),z.enum(['keep_one','delete_all'])).default({})});
const verifySchema=choices.strict();
const deleteSchema=choices.extend({mode:z.enum(['hash','metadata']),confirmed:z.literal(true),riskAccepted:z.boolean().optional(),expectedUpdatedAt:z.string().min(1)}).strict();
const emptySchema=z.object({}).strict();
const filesSchema=z.object({mediaAssetIds:z.array(z.number().int().positive().safe()).min(1).max(10000),confirmed:z.literal(true),expectedUpdatedAt:z.string().min(1)}).strict();
const jobDirectory=id=>path.join(dataDir,'cleanup',id);
const send=(res,status,value,headers={})=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff',...headers});res.end(JSON.stringify(value));};
const equal=(a,b)=>typeof a==='string'&&Buffer.byteLength(a)===Buffer.byteLength(b)&&timingSafeEqual(Buffer.from(a),Buffer.from(b));
export function requestedRange(range,size){
 if(!range||!Number.isSafeInteger(size)||size<1)return null;
 const [,a,b]=/^bytes=(\d*)-(\d*)$/.exec(range)||[];
 if(a===undefined)return null;
 const start=a?Number(a):Math.max(0,size-Number(b)),end=a&&b?Math.min(Number(b),size-1):size-1;
 if(!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||start>=size||end<start||!a&&Number(b)===0)return {invalid:true,size};
 return {start,end,size,length:end-start+1};
}
async function* sliceStream(source,start,length){
 let skip=start,left=length;
 try{for await(const chunk of source){if(skip>=chunk.length){skip-=chunk.length;continue;}const part=chunk.subarray(skip,skip+left);skip=0;left-=part.length;if(part.length)yield part;if(!left)break;}}
 finally{source.destroy();}
}
function body(req){return new Promise((resolve,reject)=>{
 let length=0,failed=false;const chunks=[];
 req.on('data',chunk=>{length+=chunk.length;if(length>65536){if(!failed)reject(new ApiError('body_too_large','Request is too large.'));failed=true;return;}if(!failed)chunks.push(chunk);});
 req.on('end',()=>{if(failed)return;try{resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));}catch{reject(new ApiError('invalid_json','Expected JSON.'));}});
 req.on('error',reject);
});}
export async function cachedImages(j,view){
 const images=new Map();
 if(view==='library'){for(const g of libraryGroups(j))if(g.items[0].thumbnail_url||g.items[0].poster_url)images.set(g.id,`/api/jobs/${j.id}/thumb/${g.items[0].id}`);return images;}
 await Promise.all(j.groups.map(async g=>{try{await access(path.join(jobDirectory(j.id),`thumbnail-${g.keepId}.json`));images.set(g.id,`/api/jobs/${j.id}/thumb/${g.keepId}`);}catch{}}));
 return images;
}
export function createCleanupWeb({defaultJobId,token=randomBytes(32).toString('hex'),getJob=loadCleanup,getClient=clientFor,operations={},openMedia=mediaResponse}={}){
 const ops={status:cleanupStatus,verify:startVerification,approve:approveCleanup,approveFiles,start:startCleanup,pause:pauseCleanup,next:nextCleanup,scan:startScan,...operations};
 const thumbnails=new Map();let thumbnailCount=0;const thumbnailQueue=[];
 let streams=0;
 const server=http.createServer(async(req,res)=>{
  res.setHeader('Referrer-Policy','same-origin');res.setHeader('X-Frame-Options','DENY');
  try{
   const base=`http://127.0.0.1:${server.address().port}`;
   if(req.headers.host!==new URL(base).host||req.headers.origin&&req.headers.origin!==base||req.headers['sec-fetch-site']==='cross-site')throw new ApiError('forbidden_origin','Only the local gallery can access this service.');
   const url=new URL(req.url,base);
   if(req.method==='GET'&&url.pathname==='/api/health')return send(res,200,{service:'neurover-cleanup',version:'0.8.1'});
   if(req.method==='GET'&&url.pathname==='/favicon.ico'){res.writeHead(204);return res.end();}
   const page=url.pathname.match(/^\/jobs\/([0-9a-f-]{36})$/);
   if(req.method==='GET'&&(page||['/','/report.html'].includes(url.pathname))){
    const j=await getJob(page?.[1]||defaultJobId),view=url.searchParams.get('view')||(j.plan?.mode==='explicit'?'library':'duplicates');
    if(!['library','duplicates'].includes(view))throw new ApiError('invalid_view','Unknown gallery view.');
    const images=await cachedImages(j,view);
    const html=await renderReport(j,images,{base:`/api/jobs/${j.id}`,token},view);
    res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});return res.end(html);
   }
   const route=url.pathname.match(/^\/api\/jobs\/([0-9a-f-]{36})(?:\/(verify|delete|files-delete|pause|resume|new|media\/\d+|thumb\/\d+))?$/);
   if(!route)throw new ApiError('not_found','Unknown local route.');
   const [,id,action]=route,j=await getJob(id);
   if(req.method==='GET'&&!action){
    const status=await ops.status({account:j.account},id);
    const etag='"'+createHash('sha256').update(JSON.stringify([j.updatedAt,status.worker,status.verification,status.scanner,status.pauseRequested])).digest('hex')+'"';
    if(req.headers['if-none-match']===etag){res.writeHead(304,{'Cache-Control':'no-store',ETag:etag});return res.end();}
    const plan=j.plan?{mode:j.plan.mode,retentions:j.plan.retentions,items:j.plan.items.map(m=>({id:m.id,groupId:m.groupId,state:m.state,reason:m.reason}))}:null;
    return send(res,200,{...status,updatedAt:j.updatedAt,plan},{ETag:etag});
   }
   if(['GET','HEAD'].includes(req.method)&&action?.startsWith('thumb/')){
    const asset=Number(action.split('/')[1]),item=j.items.find(m=>m.id===asset)||j.groups.flatMap(g=>g.items).find(m=>m.id===asset);if(!item)throw new ApiError('not_found','Preview does not belong to this report.');
    const file=path.join(jobDirectory(id),`thumbnail-${asset}.json`);
    let cached;try{cached=JSON.parse(await readFile(file,'utf8'));}catch(e){if(e.code!=='ENOENT'&&!(e instanceof SyntaxError))throw e;
     const key=id+':'+asset;if(!thumbnails.has(key)){const task=(async()=>{if(thumbnailCount>=4)await new Promise(resolve=>thumbnailQueue.push(resolve));thumbnailCount++;try{return await thumbnail(await getClient(j.account),{keepId:asset,items:[item]},jobDirectory(id));}finally{thumbnailCount--;thumbnailQueue.shift()?.();}})();thumbnails.set(key,task);task.finally(()=>thumbnails.delete(key)).catch(()=>{});}
     cached={data:await thumbnails.get(key)};
    }
    const match=/^data:(image\/(?:webp|jpeg|png));base64,([a-zA-Z0-9+/=]+)$/.exec(cached.data||'');
    if(!match||cached.data.length>360000)throw new ApiError('not_found','Preview is not available.');
    const bytes=Buffer.from(match[2],'base64');res.writeHead(200,{'Content-Type':match[1],'Content-Length':bytes.length,'Cache-Control':'private, max-age=86400','X-Content-Type-Options':'nosniff'});return res.end(req.method==='HEAD'?undefined:bytes);
   }
   if(['GET','HEAD'].includes(req.method)&&action?.startsWith('media/')){
    const asset=Number(action.split('/')[1]);if(!j.items.some(m=>m.id===asset)&&!j.groups.some(g=>g.items.some(m=>m.id===asset)))throw new ApiError('not_found','Media does not belong to this report.');
    if(streams>=4)throw new ApiError('media_busy','Close another player and retry.');
    const range=req.headers.range;if(range&&!/^bytes=(?:\d+-\d*|-\d+)$/.test(range))throw new ApiError('invalid_range','Only a single byte range is supported.');
    streams++;const abort=new AbortController();res.on('close',()=>{if(!res.writableEnded)abort.abort();});req.on('aborted',()=>abort.abort());
    try{
     const c=await getClient(j.account),{media}=await serial(j.account,()=>c.http(`/media-library/${asset}/access`));
     const remote=await openMedia(c,{...media,download_url:media.mime_type?.startsWith('image/')?media.download_url:media.preview_url||media.download_url},{signal:abort.signal,range,method:req.method});
     const headers={'Content-Type':remote.headers.get('content-type'),'Content-Disposition':'inline','Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff'};
     for(const key of ['content-length','content-range','accept-ranges'])if(remote.headers.get(key))headers[key]=remote.headers.get(key);
     // Neurover ignores Range; Safari still requires a correct 206 response to play.
     const partial=remote.status===200?requestedRange(range,Number(remote.headers.get('content-length'))):null;
     if(partial?.invalid){await remote.body?.cancel();res.writeHead(416,{'Content-Range':`bytes */${partial.size}`});return res.end();}
     if(partial){headers['content-range']=`bytes ${partial.start}-${partial.end}/${partial.size}`;headers['content-length']=partial.length;headers['accept-ranges']='bytes';}
     res.writeHead(partial?206:remote.status,headers);
     if(req.method==='HEAD'){await remote.body?.cancel();return res.end();}
     const source=Readable.fromWeb(remote.body);
     await pipeline(partial?sliceStream(source,partial.start,partial.length):source,res,{signal:abort.signal});return;
    }finally{streams--;}
   }
   if(req.method!=='POST'||!['verify','delete','files-delete','pause','resume','new'].includes(action))throw new ApiError('not_found','Unknown operation.');
   if(req.headers.origin!==base||!equal(req.headers['x-cleanup-token'],token))throw new ApiError('forbidden_token','Reload the local gallery before continuing.');
   if(req.headers['content-type']?.split(';')[0]!=='application/json')throw new ApiError('invalid_json','Expected application/json.');
   const input=(action==='verify'?verifySchema:action==='delete'?deleteSchema:action==='files-delete'?filesSchema:emptySchema).parse(await body(req));
   if(input.groupIds&&new Set(input.groupIds).size!==input.groupIds.length)throw new ApiError('invalid_groups','Duplicate group IDs are not accepted.');
   const c=await getClient(j.account);
   if(action==='new'){const next=await ops.next(c,id);return send(res,202,next.status==='scanning'?await ops.scan(c,next.jobId):next);}
   if(action==='verify')return send(res,202,await ops.verify(c,{jobId:id,...input}));
   if(action==='pause')return send(res,202,await ops.pause(c,id));
   if(action==='resume'){
    if(j.status==='scanning')return send(res,202,await ops.scan(c,id));
    if(j.plan)return send(res,202,await ops.start(c,id));
    const status=await ops.status(c,id),v=status.verification;if(!v)throw new ApiError('invalid_state','There is no saved operation to resume.');
    return send(res,202,await ops.verify(c,{jobId:id,groupIds:v.groupIds,groupRetention:v.groupRetention}));
   }
   if(action==='files-delete'){
    const current=await ops.status(c,id);if(current.verification?.running)throw new ApiError('verification_busy','Wait for verification before deleting.');
    await ops.approveFiles(c,{jobId:id,mediaAssetIds:input.mediaAssetIds,confirm:true,expectedUpdatedAt:input.expectedUpdatedAt});
    if((await ops.status(c,id)).status==='completed')return send(res,200,await ops.status(c,id));
    return send(res,202,await ops.start(c,id));
   }
   if(input.mode==='metadata'&&!input.riskAccepted)throw new ApiError('risk_confirmation_required','Acknowledge the risk of different original contents.');
   const current=await ops.status(c,id);if(current.verification?.running)throw new ApiError('verification_busy','Wait for verification or pause it before deleting.');
   await ops.approve(c,{jobId:id,groupIds:input.groupIds,groupRetention:input.groupRetention,mode:input.mode,confirm:true,allowUsedOnCanvas:false,expectedUpdatedAt:input.expectedUpdatedAt});
   return send(res,202,await ops.start(c,id));
  }catch(e){
   if(res.headersSent){res.destroy();return;}
   const code=e instanceof z.ZodError?'invalid_request':e.code==='ENOENT'?'not_found':e.code||'operation_failed';
   const status=code.startsWith('forbidden')?403:code==='not_found'?404:code==='body_too_large'?413:code==='invalid_range'?416:code==='media_busy'?429:e instanceof ApiError?409:e instanceof z.ZodError?400:500;
   send(res,status,{error:{code,message:e instanceof ApiError?e.message:'Операция не выполнена. Обновите состояние и попробуйте снова.'}});
  }
 });
 server.headersTimeout=15000;server.requestTimeout=30000;return server;
}
export async function runCleanupWeb({defaultJobId,port=8876,idleMs=Number(process.env.NEUROVER_GALLERY_IDLE_MS??600000)}={}){
 await loadCleanup(defaultJobId);const server=createCleanupWeb({defaultJobId});
 await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,'127.0.0.1',resolve);});
 await privateJson(path.join(dataDir,'cleanup-web.json'),{pid:process.pid,port:server.address().port,defaultJobId,startedAt:new Date().toISOString()});
 // Idle shutdown: the open gallery polls every 2.5–10 s, so 10 min without any request means no page is open.
 // The next ensureCleanupWeb() call starts a fresh server. Background workers are separate processes and are not affected.
 if(idleMs>0)stopWhenIdle(server,{idleMs,onIdle:()=>{server.close(()=>process.exit(0));server.closeAllConnections?.();setTimeout(()=>process.exit(0),3000).unref();}});
 return server;
}
export function stopWhenIdle(server,{idleMs,checkMs=60000,onIdle}){
 let last=Date.now(),inflight=0;
 server.on('request',(req,res)=>{last=Date.now();inflight++;res.on('close',()=>{inflight--;last=Date.now();});});
 const timer=setInterval(()=>{if(inflight===0&&Date.now()-last>idleMs){clearInterval(timer);onIdle();}},checkMs);timer.unref();
 return timer;
}
export async function ensureCleanupWeb(jobId,{port=8876}={}){
 await loadCleanup(jobId);const url=`http://127.0.0.1:${port}`;
 try{const r=await fetch(url+'/api/health',{signal:AbortSignal.timeout(1500)});const j=await r.json();if(j.service==='neurover-cleanup')return {reportUrl:url+'/jobs/'+jobId};throw new ApiError('port_in_use','Local gallery port is occupied by another service.');}
 catch(e){if(e instanceof ApiError)throw e;}
 const {spawn}=await import('node:child_process');const child=spawn(process.execPath,[fileURLToPath(import.meta.url),jobId,String(port)],{detached:true,stdio:'ignore'});
 await new Promise((resolve,reject)=>{child.once('spawn',resolve);child.once('error',reject);});child.unref();
 for(let attempt=0;attempt<25;attempt++){try{const r=await fetch(url+'/api/health',{signal:AbortSignal.timeout(500)});if((await r.json()).service==='neurover-cleanup')return {reportUrl:url+'/jobs/'+jobId};}catch{}await new Promise(resolve=>setTimeout(resolve,100));}
 throw new ApiError('web_start_failed','Could not start the local gallery.');
}
if(process.argv[1]===fileURLToPath(import.meta.url))runCleanupWeb({defaultJobId:process.argv[2],port:Number(process.argv[3]||8876)}).catch(e=>{console.error(e.code||'web_start_failed');process.exitCode=1;});
