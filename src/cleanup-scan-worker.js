import {dataDir} from './paths.js';
import {loadCleanup,scanCleanup} from './cleanup.js';
import {clientFor,closeClients,privateJson,root} from './client.js';
import path from 'node:path';
const id=process.argv[2];let reason='interrupted';
try{
 const j=await loadCleanup(id),c=await clientFor(j.account);
 for(;;){const r=await scanCleanup(c,{jobId:id});
  if(r.status==='ready'){reason='completed';break;}
  if(r.lastError){reason=r.lastError.code||'scan_failed';break;}
  if(r.status!=='scanning'){reason='invalid_state';break;}
 }
}catch(e){reason=e.code||'scan_failed';}
finally{await privateJson(path.join(dataDir,'cleanup',id,'scan-worker.json'),{pid:process.pid,endedAt:new Date().toISOString(),reason}).catch(()=>{});await closeClients();}
// Do not linger as a ghost process: exit once the job is finished, even if a keep-alive socket or timer is still open.
setTimeout(()=>process.exit(0),2000).unref();
process.exitCode??=0;
