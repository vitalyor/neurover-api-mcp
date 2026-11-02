// Release check and self-update. Node built-ins only: the one-line installer runs this before dependencies exist.
import {readFile,writeFile,mkdir,rename,rm,readdir,cp,access} from 'node:fs/promises';
import {readFileSync,existsSync} from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {root,dataDir} from './paths.js';
import {privateJson,readJson} from './state.js';
import {ApiError} from './errors.js';

const pkg=JSON.parse(readFileSync(path.join(root,'package.json'),'utf8'));
export const currentVersion=pkg.version;
export const repository=/github\.com\/([^/]+\/[^/.]+)/.exec(pkg.repository?.url||'')?.[1]||'vitalyor/neurover-api-mcp';
const DAY=24*3600*1000,WEEK=7*DAY;
const stateFile=()=>path.join(dataDir,'update-check.json');

const parts=v=>String(v).replace(/^v/,'').split('.').map(Number);
export function isNewer(candidate,current){
 const a=parts(candidate),b=parts(current);
 for(let i=0;i<3;i++){if((a[i]||0)!==(b[i]||0))return (a[i]||0)>(b[i]||0);}
 return false;
}

// Releases are git tags vX.Y.Z; ordinary pushes to main never trigger an update notice.
export async function latestVersion({fetchImpl=fetch}={}){
 const r=await fetchImpl(`https://api.github.com/repos/${repository}/tags?per_page=100`,{headers:{Accept:'application/vnd.github+json','User-Agent':'neurover-mcp-update-check'},signal:AbortSignal.timeout(10000)});
 if(!r.ok)throw new ApiError('update_check_failed',`GitHub answered ${r.status}.`);
 const versions=(await r.json()).map(t=>/^v(\d+\.\d+\.\d+)$/.exec(t?.name||'')?.[1]).filter(Boolean);
 return versions.reduce((best,v)=>!best||isNewer(v,best)?v:best,null);
}

const summary=(latest,checkedAt)=>({current:currentVersion,latest:latest||null,updateAvailable:!!latest&&isNewer(latest,currentVersion),checkedAt:checkedAt?new Date(checkedAt).toISOString():null});

// At most one GitHub request per week unless forced; a failed check retries after a day and never throws.
export async function checkForUpdate({force=false,now=Date.now(),fetchImpl}={}){
 if(!force&&process.env.NEUROVER_UPDATE_CHECK==='0')return {...summary(null,null),status:'disabled'};
 let state={};try{state=await readJson(stateFile());}catch{}
 if(!force&&state.checkedAt&&now-state.checkedAt<(state.failed?DAY:WEEK))return summary(state.latest,state.checkedAt);
 try{const latest=await latestVersion({fetchImpl});await privateJson(stateFile(),{checkedAt:now,latest});return summary(latest,now);}
 catch(e){await privateJson(stateFile(),{checkedAt:now,latest:state.latest||null,failed:true}).catch(()=>{});
  if(force)throw e instanceof ApiError?e:new ApiError('update_check_failed','Could not reach GitHub to check for updates.');
  return summary(state.latest,now);}
}

// Installation layouts. "managed": <app>/versions/<v>/ with a stable <app>/neurover.mjs launcher. "git": a clone.
export function installLayout(dir=root){
 const versions=path.dirname(dir);
 if(path.basename(versions)==='versions')return {kind:'managed',app:path.dirname(versions)};
 if(existsSync(path.join(dir,'.git')))return {kind:'git',dir};
 return {kind:'manual',dir};
}
export const managedAppDir=()=>path.join(dataDir,'app');

async function run(command,args,options={}){
 // stdout belongs to the MCP stdio protocol when this runs inside the server; child output goes to stderr.
 const child=spawn(command,args,{stdio:options.quiet?'ignore':['ignore',2,2],...options});
 const code=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',resolve);});
 if(code!==0)throw new ApiError('update_step_failed',`${path.basename(command)} ${args[0]} failed.`);
}
async function capture(command,args,cwd){
 const child=spawn(command,args,{cwd,stdio:['ignore','pipe','ignore']});let out='';child.stdout.on('data',d=>out+=d);
 const code=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',resolve);});
 if(code!==0)throw new ApiError('update_step_failed',`${command} ${args[0]} failed.`);return out;
}
// MCP clients may start us without npm on PATH, so run npm-cli.js with this same Node.
export function npmCli(){
 const bin=path.dirname(process.execPath);
 const found=[process.env.npm_execpath,path.join(bin,'node_modules/npm/bin/npm-cli.js'),path.join(bin,'../lib/node_modules/npm/bin/npm-cli.js')].find(p=>p&&/npm-cli\.js$/.test(p)&&existsSync(p));
 if(!found)throw new ApiError('npm_not_found','npm was not found next to this Node.js; reinstall Node.js from nodejs.org.');
 return found;
}
const npmCi=async dir=>run(process.execPath,[npmCli(),'ci','--omit=dev','--ignore-scripts','--no-audit','--no-fund'],{cwd:dir});

async function downloadSource(version,dest){
 const r=await fetch(`https://codeload.github.com/${repository}/tar.gz/refs/tags/v${version}`,{signal:AbortSignal.timeout(120000)});
 if(!r.ok)throw new ApiError('update_download_failed',`Download of v${version} failed (${r.status}).`);
 const archive=dest+'.tgz';await writeFile(archive,Buffer.from(await r.arrayBuffer()));
 try{await mkdir(dest,{recursive:true});await run('tar',['-xzf',archive,'-C',dest,'--strip-components=1'],{quiet:true});}finally{await rm(archive,{force:true});}
}

// Install one version beside the others and switch the launcher to it. Older folders stay for workers still running from them.
export async function installManaged(app,version,{fetchSource=downloadSource,installDeps=npmCi}={}){
 const versions=path.join(app,'versions'),target=path.join(versions,version);
 await mkdir(versions,{recursive:true});
 if(!existsSync(path.join(target,'package.json'))){
  const partial=`${target}.partial-${process.pid}`;await rm(partial,{recursive:true,force:true});
  try{
   await fetchSource(version,partial);
   if(JSON.parse(await readFile(path.join(partial,'package.json'),'utf8')).version!==version)throw new ApiError('update_version_mismatch',`Downloaded files are not v${version}.`);
   await installDeps(partial);await rename(partial,target);
  }catch(e){await rm(partial,{recursive:true,force:true});throw e;}
 }
 await cp(path.join(target,'scripts/launcher.mjs'),path.join(app,'neurover.mjs'));
 const previous=await readJson(path.join(app,'current.json')).then(v=>v.version).catch(()=>null);
 await writeFile(path.join(app,'current.json.tmp'),JSON.stringify({version,previous},null,1));await rename(path.join(app,'current.json.tmp'),path.join(app,'current.json'));
 // ponytail: keep current + previous only; a worker still running from an older folder keeps its loaded code.
 for(const name of await readdir(versions))if(name!==version&&name!==previous&&!name.includes('.partial-'))await rm(path.join(versions,name),{recursive:true,force:true});
 return {version,previous,dir:target};
}

// Background cleanup/verify/scan workers run code from the current folder; never swap code under them.
export async function runningWorkers(){
 const base=path.join(dataDir,'cleanup');let jobs=[];try{jobs=await readdir(base);}catch{return [];}
 const running=[];
 for(const job of jobs)for(const file of ['worker.json','verification.json','scan-worker.json']){
  let v;try{v=await readJson(path.join(base,job,file));}catch{continue;}
  if(v?.pid&&!v.endedAt){try{process.kill(v.pid,0);running.push({jobId:job,kind:file.replace('.json','')});}catch{}}
 }
 return running;
}

export async function applyUpdate({layout=installLayout(),version,...deps}={}){
 const busy=await runningWorkers();
 if(busy.length)throw new ApiError('cleanup_running','Cleanup is running in the background; update after it finishes or is paused.',{running:busy});
 if(layout.kind==='manual')throw new ApiError('update_manual',`This copy was unpacked by hand and cannot update itself. Reinstall with the one-line installer from https://github.com/${repository}`);
 const target=version||(await checkForUpdate({force:true})).latest;
 if(!target||!isNewer(target,currentVersion))return {status:'up_to_date',current:currentVersion};
 if(layout.kind==='git'){
  if((await capture('git',['status','--porcelain'],layout.dir)).trim())throw new ApiError('update_local_changes','This folder has local changes; commit or discard them, then update with git yourself.');
  await run('git',['fetch','--tags','--quiet','origin'],{cwd:layout.dir});
  await run('git',['merge','--ff-only','--quiet',`v${target}`],{cwd:layout.dir});
  await (deps.installDeps||npmCi)(layout.dir);
 }else await installManaged(layout.app,target,deps);
 await privateJson(stateFile(),{checkedAt:Date.now(),latest:target}).catch(()=>{});
 return {status:'updated',from:currentVersion,to:target,restartRequired:true,message:`Updated to ${target}. Restart the MCP client (fully quit and reopen it) to use the new version.`};
}

// One notice per MCP session: the weekly check starts in the background and the first tool result after it resolves carries it.
export function updateNotifier(check=()=>checkForUpdate()){
 let notice=null;
 check().then(r=>{if(r.updateAvailable)notice={current:r.current,latest:r.latest,message:`Вышла новая версия Neurover MCP ${r.latest} (установлена ${r.current}). Сообщите пользователю и предложите обновить; обновлять только с его согласия через neurover_update_apply.`};}).catch(()=>{});
 return v=>{if(!notice||!v||typeof v!=='object'||Array.isArray(v))return v;const n=notice;notice=null;return {...v,updateAvailable:n};};
}
