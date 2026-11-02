import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm,readdir} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import {dataDir,root} from '../src/paths.js';
import {isNewer,latestVersion,checkForUpdate,installManaged,installLayout,applyUpdate,runningWorkers,currentVersion} from '../src/update.js';
import {addToClient,knownClients} from '../src/clients.js';

const tags=names=>async()=>({ok:true,json:async()=>names.map(name=>({name}))});
const counting=names=>{const f=async(...a)=>{f.calls++;return tags(names)(...a);};f.calls=0;return f;};
const temp=async t=>{const d=await mkdtemp(path.join(os.tmpdir(),'neurover-update-'));t.after(()=>rm(d,{recursive:true,force:true}));return d;};
const resetCheck=()=>rm(path.join(dataDir,'update-check.json'),{force:true});

test('versions compare numerically, not as text',()=>{
 assert.equal(isNewer('0.10.0','0.9.9'),true);
 assert.equal(isNewer('v1.0.0','0.9.0'),true);
 assert.equal(isNewer('0.9.0','0.9.0'),false);
 assert.equal(isNewer('0.8.9','0.9.0'),false);
});

test('latest version comes from vX.Y.Z tags only',async()=>{
 assert.equal(await latestVersion({fetchImpl:tags(['v0.9.0','v0.10.1','nightly','v2.0.0-beta','v0.10.0'])}),'0.10.1');
 assert.equal(await latestVersion({fetchImpl:tags(['main'])}),null);
});

test('automatic check asks GitHub at most once a week',async t=>{
 await resetCheck();t.after(resetCheck);
 const f=counting(['v99.0.0']),now=Date.UTC(2026,10,1);
 const first=await checkForUpdate({now,fetchImpl:f});
 assert.equal(first.updateAvailable,true);assert.equal(first.latest,'99.0.0');assert.equal(f.calls,1);
 const cached=await checkForUpdate({now:now+6*864e5,fetchImpl:f});
 assert.equal(cached.updateAvailable,true);assert.equal(f.calls,1,'within a week the cached answer is used');
 await checkForUpdate({now:now+8*864e5,fetchImpl:f});assert.equal(f.calls,2,'after a week it checks again');
 await checkForUpdate({force:true,now:now+8*864e5,fetchImpl:f});assert.equal(f.calls,3,'manual check always asks');
});

test('a failed automatic check never throws and retries after a day',async t=>{
 await resetCheck();t.after(resetCheck);
 let calls=0;const broken=async()=>{calls++;throw new Error('offline');};
 const r=await checkForUpdate({now:1000,fetchImpl:broken});
 assert.equal(r.updateAvailable,false);
 await checkForUpdate({now:1000+23*3600e3,fetchImpl:broken});assert.equal(calls,1,'not again within a day');
 await checkForUpdate({now:1000+25*3600e3,fetchImpl:broken});assert.equal(calls,2,'retried the next day');
 await assert.rejects(checkForUpdate({force:true,now:2e8,fetchImpl:broken}),e=>e.code==='update_check_failed');
});

test('NEUROVER_UPDATE_CHECK=0 disables the automatic check but not the manual one',async t=>{
 await resetCheck();t.after(()=>{delete process.env.NEUROVER_UPDATE_CHECK;return resetCheck();});
 process.env.NEUROVER_UPDATE_CHECK='0';const f=counting(['v99.0.0']);
 assert.equal((await checkForUpdate({fetchImpl:f})).status,'disabled');assert.equal(f.calls,0);
 assert.equal((await checkForUpdate({force:true,fetchImpl:f})).updateAvailable,true);assert.equal(f.calls,1);
});

const fakeSource=async(version,dest)=>{
 await mkdir(path.join(dest,'scripts'),{recursive:true});await mkdir(path.join(dest,'bin'),{recursive:true});
 await writeFile(path.join(dest,'package.json'),JSON.stringify({version}));
 await writeFile(path.join(dest,'scripts/launcher.mjs'),await readFile(path.join(root,'scripts/launcher.mjs')));
 await writeFile(path.join(dest,'bin/neurover.mjs'),`if(globalThis.neuroverLauncher)console.log('ran ${version} '+process.argv.slice(2).join(' '));`);
};

test('managed install switches versions through a stable launcher and keeps the previous one',async t=>{
 const app=await temp(t),noDeps=async()=>{};
 await installManaged(app,'1.0.0',{fetchSource:fakeSource,installDeps:noDeps});
 const run=()=>spawnSync(process.execPath,[path.join(app,'neurover.mjs'),'start'],{encoding:'utf8'}).stdout.trim();
 assert.equal(run(),'ran 1.0.0 start');
 await installManaged(app,'1.1.0',{fetchSource:fakeSource,installDeps:noDeps});
 assert.equal(run(),'ran 1.1.0 start','the same launcher path now runs the new version');
 await installManaged(app,'1.2.0',{fetchSource:fakeSource,installDeps:noDeps});
 assert.deepEqual((await readdir(path.join(app,'versions'))).sort(),['1.1.0','1.2.0'],'only current and previous remain');
 assert.equal(installLayout(path.join(app,'versions','1.2.0')).kind,'managed');
});

test('a failed download or dependency install leaves the current version untouched',async t=>{
 const app=await temp(t);
 await installManaged(app,'1.0.0',{fetchSource:fakeSource,installDeps:async()=>{}});
 await assert.rejects(installManaged(app,'2.0.0',{fetchSource:fakeSource,installDeps:async()=>{throw new Error('npm failed');}}));
 assert.equal(JSON.parse(await readFile(path.join(app,'current.json'),'utf8')).version,'1.0.0');
 assert.deepEqual(await readdir(path.join(app,'versions')),['1.0.0'],'no partial folder is left behind');
 await assert.rejects(installManaged(app,'3.0.0',{fetchSource:(v,d)=>fakeSource('9.9.9',d),installDeps:async()=>{}}),e=>e.code==='update_version_mismatch');
});

// Own cleanup folder: other test files run in parallel and create live workers in the shared data dir.
test('update refuses while a cleanup worker is running',async t=>{
 const cleanupDir=await temp(t),job=path.join(cleanupDir,'99999999-9999-4999-8999-999999999999');
 await mkdir(job,{recursive:true});
 await writeFile(path.join(job,'worker.json'),JSON.stringify({pid:process.pid,startedAt:new Date().toISOString()}));
 assert.equal((await runningWorkers(cleanupDir)).length,1);
 await assert.rejects(applyUpdate({layout:{kind:'managed',app:'/nonexistent'},version:'99.0.0',cleanupDir}),e=>e.code==='cleanup_running');
 await writeFile(path.join(job,'worker.json'),JSON.stringify({pid:process.pid,endedAt:new Date().toISOString()}));
 assert.equal((await runningWorkers(cleanupDir)).length,0,'a finished worker does not block');
});

test('update reports up to date and refuses hand-unpacked copies',async t=>{
 const cleanupDir=await temp(t);
 assert.equal((await applyUpdate({layout:{kind:'managed',app:'/nonexistent'},version:currentVersion,cleanupDir})).status,'up_to_date');
 await assert.rejects(applyUpdate({layout:{kind:'manual',dir:'/x'},cleanupDir}),e=>e.code==='update_manual');
});

test('client config gets the neurover entry, keeps other servers and a backup',async t=>{
 const dir=await temp(t),file=path.join(dir,'claude_desktop_config.json');
 const original={theme:'dark',mcpServers:{other:{command:'other'}}};
 await writeFile(file,JSON.stringify(original));
 const entry={command:'node',args:['/app/neurover.mjs','start'],env:{NEUROVER_DATA_DIR:'/data'}};
 const r=await addToClient(file,entry);
 assert.equal(r.status,'added');
 const saved=JSON.parse(await readFile(file,'utf8'));
 assert.deepEqual(saved.mcpServers.other,{command:'other'});assert.equal(saved.theme,'dark');assert.deepEqual(saved.mcpServers.neurover,entry);
 assert.deepEqual(JSON.parse(await readFile(r.backup,'utf8')),original);
 assert.equal((await addToClient(file,entry)).status,'unchanged');
 assert.equal((await addToClient(file,{...entry,args:['/new','start']})).status,'replaced');
});

test('client config: missing file is created, broken JSON is left untouched',async t=>{
 const dir=await temp(t);
 const fresh=path.join(dir,'mcp.json');
 assert.equal((await addToClient(fresh,{command:'node'})).backup,null);
 assert.deepEqual(JSON.parse(await readFile(fresh,'utf8')),{mcpServers:{neurover:{command:'node'}}});
 const broken=path.join(dir,'broken.json');await writeFile(broken,'{ not json');
 await assert.rejects(addToClient(broken,{command:'node'}),e=>e.code==='client_config_invalid');
 assert.equal(await readFile(broken,'utf8'),'{ not json');
});

test('client config locations per platform',()=>{
 const mac=knownClients('darwin',{},'/Users/u').map(c=>c.file);
 assert.ok(mac.includes('/Users/u/Library/Application Support/Claude/claude_desktop_config.json'));
 assert.ok(mac.includes('/Users/u/.cursor/mcp.json'));
 const win=knownClients('win32',{APPDATA:'C:\\Users\\u\\AppData\\Roaming'},'C:\\Users\\u').map(c=>c.file);
 assert.ok(win.includes('C:\\Users\\u\\AppData\\Roaming\\Claude\\claude_desktop_config.json'));
 assert.ok(knownClients('linux',{},'/home/u').some(c=>c.file==='/home/u/.config/Claude/claude_desktop_config.json'));
});

test('update notice is attached to exactly one tool result per session',async()=>{
 let resolve;const attach=(await import('../src/update.js')).updateNotifier(()=>new Promise(r=>resolve=r));
 assert.deepEqual(attach({ok:1}),{ok:1},'nothing before the check finishes');
 resolve({updateAvailable:true,current:'0.9.0',latest:'1.0.0'});await new Promise(r=>setImmediate(r));
 assert.equal(attach([1]).updateAvailable,undefined,'arrays are left alone');
 assert.equal(attach({ok:1}).updateAvailable.latest,'1.0.0');
 assert.equal(attach({ok:2}).updateAvailable,undefined,'only once');
 const quiet=(await import('../src/update.js')).updateNotifier(async()=>({updateAvailable:false}));await new Promise(r=>setImmediate(r));
 assert.equal(quiet({ok:1}).updateAvailable,undefined);
});
