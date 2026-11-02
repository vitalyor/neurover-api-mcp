import {dataDir} from './paths.js';
import {loadCleanup,stepCleanup,cleanupPauseRequested} from './cleanup.js';
import {clientFor,closeClients,privateJson,root} from './client.js';
import path from 'node:path';
const id=process.argv[2];let reason='interrupted';
try{
 const j=await loadCleanup(id),c=await clientFor(j.account);let retries=0;
 for(;;){if(await cleanupPauseRequested(id)){reason='paused';break;}const r=await stepCleanup(c,{jobId:id,batchSize:10,waitSeconds:0});
  if(r.status==='completed'){reason='completed';break;}
  if(['login_required','session_expired','credentials_unavailable','manual_login_required','vault_locked','vault_unavailable','credential_migration_required','credential_file_invalid'].includes(r.lastError?.code)){reason=r.lastError.code;break;}
  if(r.status==='needs_attention'){if(++retries>3){reason='needs_attention';break;}await new Promise(resolve=>setTimeout(resolve,[5000,15000,30000][retries-1]));}
  else{retries=0;await new Promise(resolve=>setTimeout(resolve,1000));}
 }
}catch(e){reason=e.code||'worker_error';}
finally{await privateJson(path.join(dataDir,'cleanup',id,'worker.json'),{pid:process.pid,endedAt:new Date().toISOString(),reason}).catch(()=>{});await closeClients();}
// Do not linger as a ghost process: exit once the job is finished, even if a keep-alive socket or timer is still open.
setTimeout(()=>process.exit(0),2000).unref();
process.exitCode??=0;
