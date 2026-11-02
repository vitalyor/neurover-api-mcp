// In-memory UI fixture: no account client, network API, worker spawn or real deletion.
import {createCleanupWeb} from '../src/cleanup-web.js';
import {libraryGroups} from '../src/cleanup-report.js';
import {disposition} from '../src/cleanup-ui/model.js';
import {ApiError} from '../src/client.js';
const id='33333333-3333-4333-8333-333333333333',groupId='bbbbbbbbbbbb';
const items=[1,2,3,4].map(id=>({id,name:id===3?'Уникальный файл.png':`Тестовый файл ${id}.png`,media_type:'image',mime_type:'image/png',size_bytes:1024,width:100,height:100,usages:id===4?[{project_title:'Тестовое полотно',node_title:'Используется здесь'}]:[],blockers:[]}));
const job={id,account:'ТЕСТ · СИМУЛЯЦИЯ',status:'ready',updatedAt:new Date().toISOString(),items,groups:[{id:groupId,keepId:1,items:items.slice(0,2),deleteIds:[2],verified:false}]};
let worker=null,verification=null,pauseRequested=false,startAt=0;
const touch=()=>{job.updatedAt=new Date().toISOString();};
const status=async()=>{
 if(worker?.running&&Date.now()-startAt>7000){job.plan.items.forEach(m=>{m.state=m.usages.length?'skipped':m.id===3?'failed':'deleted';if(m.state!=='deleted')m.reason=m.usages.length?'used_on_canvas':'fixture_server_error';});job.status='completed';worker={...worker,running:false,reason:'completed',endedAt:new Date().toISOString()};touch();}
 return {jobId:id,updatedAt:job.updatedAt,status:job.status,worker,verification,pauseRequested,downloadedOriginalBytes:0};
};
const operations={status,
 approveFiles:async(c,p)=>{
  if(!p.confirm||p.expectedUpdatedAt!==job.updatedAt||job.plan)throw new ApiError('stale_review','Reload the fixture.');
  const groups=libraryGroups(job).filter(g=>p.mediaAssetIds.includes(g.items[0].id));
  if(groups.length!==p.mediaAssetIds.length)throw new ApiError('unknown_file','Unknown fixture file.');
  job.plan={mode:'explicit',retentions:{},items:groups.map(g=>({...g.items[0],groupId:g.id,state:'queued'}))};job.status='approved';touch();return {jobId:id};
 },
 approve:async(c,p)=>{job.plan={mode:p.mode,retentions:p.groupRetention,items:disposition(job.groups[0],p.groupRetention[groupId],p.mode).deletable.map(m=>({...m,groupId,state:'queued'}))};job.status='approved';touch();return {jobId:id};},
 verify:async()=>{job.groups[0].verified=true;job.groups[0].hashSets=[[1,2]];verification={running:false,reason:'completed',groupIds:[groupId],totalFiles:2,hashedFiles:2};touch();return {jobId:id};},
 start:async()=>{job.status='running';pauseRequested=false;worker={running:true,startedAt:new Date().toISOString()};startAt=Date.now();touch();return {jobId:id};},
 pause:async()=>{pauseRequested=true;worker={...worker,running:false,reason:'paused'};return {jobId:id};}
};
const server=createCleanupWeb({defaultJobId:id,getJob:async value=>{if(value!==id)throw new ApiError('not_found','Synthetic job only.');return job;},getClient:async()=>({account:'TEST_ONLY_NO_REMOTE_CLIENT'}),operations});
server.listen(8877,'127.0.0.1',()=>console.log('Synthetic-only gallery: http://127.0.0.1:8877/report.html?view=library — no real files or deletion.'));
