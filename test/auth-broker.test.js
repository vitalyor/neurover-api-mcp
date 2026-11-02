import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
const exec=promisify(execFile);
const moduleURL=name=>new URL('../src/'+name,import.meta.url).href;
async function isolated(t,script){
 const directory=await mkdtemp(path.join(os.tmpdir(),'neurover-broker-test-'));t.after(()=>rm(directory,{recursive:true,force:true}));
 return exec(process.execPath,['--input-type=module','-e',script],{env:{...process.env,NEUROVER_DATA_DIR:directory,NEUROVER_SOURCE_DIR:path.join(directory,'none')},timeout:20000});
}
test('local IPC helper unlocks, logs in without returning secrets, rejects bad tokens and honors changed modes',async t=>{
 const script=`
 import assert from 'node:assert/strict';import net from 'node:net';import {readFile} from 'node:fs/promises';import path from 'node:path';
 import {configureAccount} from ${JSON.stringify(moduleURL('accounts.js'))};
 import {privateJson} from ${JSON.stringify(moduleURL('state.js'))};
 import {encryptCredential} from ${JSON.stringify(moduleURL('credential-file.js'))};
 import {runBroker,callBroker} from ${JSON.stringify(moduleURL('auth-broker.js'))};
 const account='fixture',email='fixture@example.com',masterPassword='длинный мастер-пароль 🔒';let logins=0;
 await privateJson(path.join(process.env.NEUROVER_DATA_DIR,'accounts',account,'account.json'),{version:1,email,mode:'encrypted'});
 await privateJson(path.join(process.env.NEUROVER_DATA_DIR,'accounts',account,'credential.json'),await encryptCredential('synthetic-secret',masterPassword,account,email));
 const helper=await runBroker({authenticate:async(name,value)=>{assert.equal(name,account);assert.equal(value.password,'synthetic-secret');logins++;}});
 try{
  await assert.rejects(callBroker('login',account),{code:'vault_locked'});
  await assert.rejects(callBroker('unlock',account,'incorrect master password'),{code:'vault_unlock_failed'});
  assert.equal((await callBroker('unlock',account,masterPassword)).unlocked,true);
  const result=await callBroker('login',account);assert.equal(result.status,'authenticated');assert.ok(!JSON.stringify(result).includes('synthetic-secret'));assert.equal(logins,1);
  const info=JSON.parse(await readFile(path.join(process.env.NEUROVER_DATA_DIR,'auth-broker.json')));
  const rejected=await new Promise((resolve,reject)=>{const s=net.createConnection(info.address);let text='';s.setEncoding('utf8');s.on('error',reject);s.on('connect',()=>s.write(JSON.stringify({token:'0'.repeat(64),action:'login',account})+'\\n'));s.on('data',b=>text+=b);s.on('end',()=>resolve(JSON.parse(text)));});
  assert.equal(rejected.error.code,'forbidden_token');assert.equal(logins,1);
  await configureAccount(account,{email,mode:'manual'});assert.equal((await callBroker('status',account)).unlocked,false);await assert.rejects(callBroker('login',account),{code:'vault_locked'});
 }finally{await helper.close();}
 console.log('ipc checks passed');`;
 const {stdout}=await isolated(t,script);assert.match(stdout,/ipc checks passed/);
});
test('encrypted unlock helper survives its caller and can be explicitly locked without a password endpoint',async t=>{
 const script=`
 import assert from 'node:assert/strict';import {readFile} from 'node:fs/promises';import path from 'node:path';
 import {privateJson} from ${JSON.stringify(moduleURL('state.js'))};
 import {encryptCredential} from ${JSON.stringify(moduleURL('credential-file.js'))};
 import {callBroker} from ${JSON.stringify(moduleURL('auth-broker.js'))};
 const account='fixture',masterPassword='a test master password';
 await privateJson(path.join(process.env.NEUROVER_DATA_DIR,'accounts',account,'account.json'),{version:1,email:'fixture@example.com',mode:'encrypted'});
 await privateJson(path.join(process.env.NEUROVER_DATA_DIR,'accounts',account,'credential.json'),await encryptCredential('synthetic-secret',masterPassword,account,'fixture@example.com'));
 let pid;
 try{assert.equal((await callBroker('unlock',account,masterPassword)).unlocked,true);pid=JSON.parse(await readFile(path.join(process.env.NEUROVER_DATA_DIR,'auth-broker.json'))).pid;assert.notEqual(pid,process.pid);assert.equal((await callBroker('status',account)).unlocked,true);await callBroker('lock',account);assert.equal((await callBroker('status',account)).unlocked,false);}
 finally{if(pid)try{process.kill(pid,'SIGTERM');}catch{}}
 console.log('detached helper checks passed');`;
 const {stdout}=await isolated(t,script);assert.match(stdout,/detached helper checks passed/);
});
