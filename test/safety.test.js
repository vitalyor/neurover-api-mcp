import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {legacySourceDir} from '../src/paths.js';
import {onNeurover} from '../src/browser-auth.js';
import {isOwnEntry} from '../src/clients.js';

test('clean installs never look at a sibling folder; old in-place installs and explicit settings do',async t=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'neurover-legacy-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const code=path.join(dir,'app');await mkdir(code);
 assert.equal(legacySourceDir({},code),null);
 await mkdir(path.join(code,'.data'));
 assert.equal(legacySourceDir({},code),path.join(dir,'neurover-io-mcp'));
 assert.equal(legacySourceDir({NEUROVER_SOURCE_DIR:'/explicit'},code),'/explicit');
});

test('credentials are typed only on neurover.io',()=>{
 assert.equal(onNeurover('https://neurover.io/login?next=/workflows'),true);
 for(const url of ['https://neurover.io.evil.example/login','https://evil.example/?u=https://neurover.io','http://neurover.io/login','https://accounts.google.com/','about:blank','not a url'])
  assert.equal(onNeurover(url),false,url);
});

test('only our own Claude Code entry may be replaced',()=>{
 assert.equal(isOwnEntry('neurover:\n  Command: /usr/bin/node\n  Args: /Users/u/Library/Application Support/NeuroverMCP/app/neurover.mjs start'),true);
 assert.equal(isOwnEntry('neurover:\n  Command: echo\n  Args: other'),false);
 assert.equal(isOwnEntry(''),false);
});

test('Windows file locks are retried briefly; real errors are not',async()=>{
 const {retryTransient}=await import('../src/state.js');
 let calls=0;const locked=async()=>{calls++;if(calls<3)throw Object.assign(new Error('locked'),{code:'EPERM'});return 'ok';};
 assert.equal(await retryTransient(locked,{delayMs:1}),'ok');assert.equal(calls,3);
 let missing=0;await assert.rejects(retryTransient(async()=>{missing++;throw Object.assign(new Error('gone'),{code:'ENOENT'});},{delayMs:1}),e=>e.code==='ENOENT');assert.equal(missing,1,'non-transient errors are not retried');
 let stuck=0;await assert.rejects(retryTransient(async()=>{stuck++;throw Object.assign(new Error('busy'),{code:'EBUSY'});},{attempts:4,delayMs:1}),e=>e.code==='EBUSY');assert.equal(stuck,4,'gives up after the limit');
});

test('printed commands name the exact Node that runs MCP, ready for the user’s shell',async()=>{
 const {cliCommand}=await import('../src/setup-config.js');
 assert.equal(cliCommand('/a b/neurover.mjs',{platform:'darwin',node:'/x y/node',wrapper:null}),'"/x y/node" "/a b/neurover.mjs"');
 assert.equal(cliCommand('/a/neurover.mjs',{platform:'darwin',wrapper:'/d d/neurover'}),'"/d d/neurover"','the short wrapper wins when installed');
 assert.equal(cliCommand('C:\\N\\neurover.mjs',{platform:'win32',node:'C:\\N\\node\\node.exe',wrapper:null}),'& "C:\\N\\node\\node.exe" "C:\\N\\neurover.mjs"','PowerShell needs & before a quoted program');
});

test('connection guide works for any MCP harness: universal fields and the common config shapes',async()=>{
 const {connectionGuide}=await import('../src/setup-config.js');
 const g=connectionGuide({command:'/x y/node',args:['/a/neurover.mjs','start'],env:{NEUROVER_DATA_DIR:'/d'}});
 for(const part of ['type:    stdio','command: /x y/node','"mcpServers"','"servers"','[mcp_servers.neurover]','claude mcp add --scope user neurover -e NEUROVER_DATA_DIR=/d -- "/x y/node" /a/neurover.mjs start','найдите в его документации'])assert.ok(g.includes(part),part);
});

test('connecting clients: only an explicit "no" skips, a typo asks again',async()=>{
 const {parseYesNo}=await import('../bin/neurover.mjs');
 for(const a of ['','д','Да','y','YES'])assert.equal(parseYesNo(a),true,a);
 for(const a of ['н','нет','n','No'])assert.equal(parseYesNo(a),false,a);
 for(const a of ['l','ыв','1','da'])assert.equal(parseYesNo(a),null,a);
});
