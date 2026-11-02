import {dataDir} from './paths.js';
import path from 'node:path';
import {loadCleanup,verifyCleanup,cleanupPauseRequested} from './cleanup.js';
import {clientFor,closeClients,privateJson,readJson,root} from './client.js';
const id=process.argv[2],file=path.join(dataDir,'cleanup',id,'verification.json');
let reason='interrupted',config;
try{
 config=await readJson(file);const job=await loadCleanup(id),c=await clientFor(job.account);
 for(;;){
  if(await cleanupPauseRequested(id)){reason='paused';break;}
  const before=await loadCleanup(id),selected=before.groups.filter(g=>config.groupIds.includes(g.id));
  const pending=selected.flatMap(g=>g.items).filter(m=>!m.sha256);
  const maxBytes=pending.reduce((n,m)=>Math.max(n,m.size_bytes),256*1024*1024);
  const r=await verifyCleanup(c,{jobId:id,groupIds:config.groupIds,groupRetention:config.groupRetention,maxBytes,shouldPause:()=>cleanupPauseRequested(id)});
  if(r.paused){reason='paused';break;}
  if(r.lastError){reason=r.lastError.code||'verification_failed';break;}
  if(!r.verificationPending){reason='completed';break;}
  const after=await loadCleanup(id),left=after.groups.filter(g=>config.groupIds.includes(g.id)).flatMap(g=>g.items).filter(m=>!m.sha256);
  if(left.length>=pending.length){reason='verification_stalled';break;}
 }
}catch(e){reason=e.code||'verification_failed';}
finally{
 const current=await readJson(file).catch(()=>config||{});
 await privateJson(file,{...current,pid:process.pid,endedAt:new Date().toISOString(),reason}).catch(()=>{});
 await closeClients();
}
// Do not linger as a ghost process: exit once the job is finished, even if a keep-alive socket or timer is still open.
setTimeout(()=>process.exit(0),2000).unref();
process.exitCode??=0;
