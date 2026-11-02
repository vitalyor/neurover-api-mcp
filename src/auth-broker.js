import net from 'node:net';
import path from 'node:path';
import os from 'node:os';
import {randomBytes,randomUUID,timingSafeEqual} from 'node:crypto';
import {readFile,chmod,unlink} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {z} from 'zod';
import {root,dataDir} from './paths.js';
import {privateJson,readJson} from './state.js';
import {ApiError} from './errors.js';
import {accountName,accountSettings,readCredential} from './accounts.js';
import {unlockCredential,decryptCredential,credentialVersion} from './credential-file.js';
const metadata=path.join(dataDir,'auth-broker.json');
const packet=z.object({token:z.string().regex(/^[a-f0-9]{64}$/),action:z.enum(['status','unlock','login','lock']),account:z.string().min(1).max(64),masterPassword:z.string().max(4096).optional()}).strict();
const equal=(a,b)=>Buffer.byteLength(a)===Buffer.byteLength(b)&&timingSafeEqual(Buffer.from(a),Buffer.from(b));
function rpc(info,message){return new Promise((resolve,reject)=>{
 if(typeof info.address!=='string'||!info.address.startsWith(process.platform==='win32'?'\\\\.\\pipe\\neurover-':path.join(os.tmpdir(),'neurover-')))return reject(new ApiError('vault_locked','Local unlock helper is unavailable. Run unlock again.'));
 const socket=net.createConnection(info.address);socket.setEncoding('utf8');let bytes='';
 socket.setTimeout(70000,()=>socket.destroy(new Error('timeout')));
 socket.on('connect',()=>socket.write(JSON.stringify({...message,token:info.token})+'\n'));
 socket.on('data',chunk=>{bytes+=chunk.toString('utf8');if(bytes.length>32768){socket.destroy();reject(new ApiError('broker_unavailable','Invalid helper response.'));return;}if(!bytes.includes('\n'))return;
  try{const value=JSON.parse(bytes.split('\n')[0]);socket.end();if(value.error)reject(new ApiError(value.error.code,value.error.message));else resolve(value);}catch{socket.destroy();reject(new ApiError('broker_unavailable','Invalid helper response.'));}
 });
 socket.on('error',()=>reject(new ApiError('broker_unavailable','Local unlock helper is unavailable. Run unlock again.')));
 socket.on('end',()=>{if(!bytes.includes('\n'))reject(new ApiError('broker_unavailable','Local unlock helper disconnected.'));});
});}
async function brokerInfo(){try{return await readJson(metadata);}catch(e){if(e.code==='ENOENT')return null;throw new ApiError('broker_unavailable','Cannot read local unlock helper state.');}}
async function ensureBroker(){
 const {lockDirectory}=await import('./media-dedup.js');
 return lockDirectory(path.join(dataDir,'auth-broker-start'),async()=>{
  const previous=await brokerInfo();if(previous)try{await rpc(previous,{action:'status',account:'probe'});return previous;}catch{}
  const child=spawn(process.execPath,[path.join(root,'src/auth-broker.js')],{detached:true,stdio:'ignore'});
  await new Promise((resolve,reject)=>{child.once('spawn',resolve);child.once('error',reject);});child.unref();
  for(let i=0;i<60;i++){const next=await brokerInfo();if(next?.pid===child.pid)try{await rpc(next,{action:'status',account:'probe'});return next;}catch{}await new Promise(r=>setTimeout(r,100));}
  throw new ApiError('broker_unavailable','Could not start the local unlock helper.');
 });
}
export async function callBroker(action,account,masterPassword){
 accountName(account);const info=action==='unlock'?await ensureBroker():await brokerInfo();
 if(!info){if(action==='status'||action==='lock')return {unlocked:false};throw new ApiError('vault_locked','Unlock this account locally first; no password was sent.');}
 return rpc(info,{action,account,...masterPassword===undefined?{}:{masterPassword}});
}
export async function runBroker({authenticate=async(account,credentials)=>{const {clientFor}=await import('./client.js');await (await clientFor(account)).login(credentials);}}={}){
 const keys=new Map(),token=randomBytes(32).toString('hex');let closing=false;
 const address=process.platform==='win32'?'\\\\.\\pipe\\neurover-'+randomUUID():path.join(os.tmpdir(),'neurover-'+randomUUID()+'.sock');
 function forget(account){const entry=keys.get(account);entry?.key.fill(0);keys.delete(account);}
 async function close(){if(closing)return;closing=true;for(const account of keys.keys())forget(account);server.close();
  const info=await brokerInfo().catch(()=>null);if(info?.pid===process.pid)await unlink(metadata).catch(()=>{});
  if(process.platform!=='win32')await unlink(address).catch(()=>{});
  const {closeClients}=await import('./client.js');await closeClients();
 }
 async function execute(input){
  const p=packet.parse(input);if(!equal(p.token,token))throw new ApiError('forbidden_token','Invalid local helper token.');accountName(p.account);
  if(p.action==='status')return {unlocked:keys.has(p.account)};
  if(p.action==='lock'){forget(p.account);return {unlocked:false};}
  const config=await accountSettings(p.account);if(config?.mode!=='encrypted'){forget(p.account);throw new ApiError('vault_locked','This account is not configured for encrypted storage.');}
  const record=await readCredential(p.account),version=credentialVersion(record);
  if(p.action==='unlock'){
   const key=await unlockCredential(record,p.masterPassword,p.account,config.email);forget(p.account);keys.set(p.account,{key,version});return {unlocked:true};
  }
  const cached=keys.get(p.account);if(!cached||cached.version!==version){forget(p.account);throw new ApiError('vault_locked','Run the local unlock command for this account.');}
  let password=decryptCredential(record,cached.key,p.account,config.email);
  try{await authenticate(p.account,{email:config.email,password});return {status:'authenticated',account:p.account};}finally{password=null;}
 }
 const server=net.createServer(socket=>{
  let text='',handled=false;socket.setEncoding('utf8');socket.setTimeout(75000,()=>socket.destroy());
  socket.on('error',()=>{});socket.on('data',chunk=>{
   if(handled)return;text+=chunk.toString('utf8');if(text.length>32768){handled=true;socket.destroy();return;}if(!text.includes('\n'))return;handled=true;
   let input;try{input=JSON.parse(text.split('\n')[0]);}catch{socket.destroy();return;}
   // Serialize login/lock so a completed lock cannot leave a queued credential login behind.
   queue=queue.catch(()=>{}).then(async()=>{
    try{const result=await execute(input);socket.end(JSON.stringify(result)+'\n');}
    catch(e){socket.end(JSON.stringify({error:{code:e instanceof ApiError?e.code:'broker_request_failed',message:e instanceof ApiError?e.message:'Local unlock request failed.'}})+'\n');}
    finally{input=null;text='';}
   });
  });
 });let queue=Promise.resolve();
 await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(address,resolve);});
 if(process.platform!=='win32')await chmod(address,0o600);
 await privateJson(metadata,{pid:process.pid,address,token});
 // Unused helpers exit; unlocked keys stay only in memory until lock or process exit.
 const idle=setInterval(()=>{if(!keys.size)close().catch(()=>{});},60000);idle.unref();
 for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>close().catch(()=>{}));
 return {server,close};
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))runBroker().catch(()=>{process.exitCode=1;});
