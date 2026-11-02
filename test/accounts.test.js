import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm,readdir,mkdir} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {accountName,accountSettings,configureAccount,credentialsFor,readCredential,verifyAccountIdentity} from '../src/accounts.js';
import {privateJson} from '../src/state.js';
import {userDataDirectory} from '../src/paths.js';
import {NeuroverClient} from '../src/client.js';
import {request} from 'playwright';
import {stageRelease} from '../scripts/bundle.mjs';
import {unlockCredential,decryptCredential,encryptCredential} from '../src/credential-file.js';
const master='test master password 2026';
test('login identity must match the configured email before accepting the session',()=>{
 verifyAccountIdentity({email:'User@example.com'},{email:'user@example.com'});
 assert.throws(()=>verifyAccountIdentity({email:'user@example.com'},{email:'other@example.com'}),{code:'account_identity_mismatch'});
 assert.throws(()=>verifyAccountIdentity({email:'user@example.com'},{id:1}),{code:'account_identity_unverified'});
});
async function fixture(t){const directory=await mkdtemp(path.join(os.tmpdir(),'neurover-account-'));t.after(()=>rm(directory,{recursive:true,force:true}));const secrets=new Map();return {directory,secrets,settings:name=>accountSettings(name,directory),vault:async(name,email)=>({getPassword:async()=>secrets.get(name+email)??null,setPassword:async p=>{secrets.set(name+email,p);},deletePassword:async()=>secrets.delete(name+email)})};}
test('account names reject traversal, empty, long and unsafe aliases',()=>{
 for(const name of ['../x','a/b','a\\b','',null,'a'.repeat(65),'a.b'])assert.throws(()=>accountName(name));assert.equal(accountName('work_2-main'),'work_2-main');
});
test('system storage and manual mode switch both ways without a password file',async t=>{
 const f=await fixture(t),input={email:'user@example.com',mode:'manual'};await configureAccount('work',input,f);
 await assert.rejects(credentialsFor('work',f),{code:'manual_login_required'});
 await configureAccount('work',{...input,mode:'vault',password:'test-secret'},f);assert.equal((await credentialsFor('work',f)).password,'test-secret');
 await assert.rejects(readFile(path.join(f.directory,'accounts/work/credential.json')),{code:'ENOENT'});
 assert.ok(!(await readFile(path.join(f.directory,'accounts/work/account.json'),'utf8')).includes('test-secret'));
 await configureAccount('work',input,f);await assert.rejects(readFile(path.join(f.directory,'accounts/work/credential.json')),{code:'ENOENT'});await assert.rejects(credentialsFor('work',f),{code:'manual_login_required'});
 assert.equal(f.secrets.size,0);
 await configureAccount('work',{...input,mode:'vault',password:'new-secret'},f);assert.equal((await credentialsFor('work',f)).password,'new-secret');
});
test('wrong master, modified ciphertext and another account cannot decrypt a credential',async()=>{
 const record=await encryptCredential('password',master,'work','u@example.com');
 await assert.rejects(unlockCredential(record,'wrong master password','work','u@example.com'),{code:'vault_unlock_failed'});
 const key=await unlockCredential(record,master,'work','u@example.com');
 assert.throws(()=>decryptCredential(record,key,'other','u@example.com'),{code:'vault_unlock_failed'});
 assert.throws(()=>decryptCredential({...record,ciphertext:Buffer.from('modified').toString('base64')},key,'work','u@example.com'),{code:'vault_unlock_failed'});key.fill(0);
});
test('encryption uses fresh salt/IV and rejects a weak master before changing settings',async t=>{
 const a=await encryptCredential('password',master,'work','u@example.com'),b=await encryptCredential('password',master,'work','u@example.com');assert.notEqual(a.salt,b.salt);assert.notEqual(a.iv,b.iv);assert.notEqual(a.ciphertext,b.ciphertext);
 await assert.rejects(encryptCredential('secret','short','work','u@example.com'),{code:'master_password_required'});
});
test('failed removal disables automatic login and records an actionable warning',async t=>{
 const f=await fixture(t);await configureAccount('work',{email:'u@example.com',mode:'manual'},f);const file=path.join(f.directory,'accounts/work/credential.json');await mkdir(file);
 await assert.rejects(configureAccount('work',{email:'u@example.com',mode:'manual'},f),{code:'credential_update_failed'});assert.equal((await f.settings('work')).passwordRemovalPending,true);await assert.rejects(credentialsFor('work',f),{code:'manual_login_required'});
 await rm(file,{recursive:true});await configureAccount('work',{email:'u@example.com',mode:'manual'},f);assert.equal((await f.settings('work')).passwordRemovalPending,undefined);
});
test('corrupt settings and alias/email reassignment fail closed',async t=>{
 const f=await fixture(t);await configureAccount('work',{email:'u@example.com',mode:'manual'},f);await assert.rejects(configureAccount('work',{email:'other@example.com',mode:'vault',password:'secret'},f),{code:'account_identity_changed'});
 await privateJson(path.join(f.directory,'accounts/work/account.json'),{version:1,email:'u@example.com',mode:'plain',password:'forbidden'});await assert.rejects(f.settings('work'),{code:'account_config_invalid'});
});
test('denied system storage never falls back to a password file and reports pending cleanup',async t=>{
 const f=await fixture(t),input={email:'u@example.com',mode:'vault',password:'never-log-this-secret'};
 const denied={...f,vault:async()=>{throw Error(input.password);}};
 await assert.rejects(configureAccount('work',input,denied),e=>e.code==='credential_update_failed'&&!e.message.includes(input.password));
 assert.equal((await f.settings('work')).mode,'manual');assert.equal((await f.settings('work')).vaultRemovalPending,true);
 await assert.rejects(readFile(path.join(f.directory,'accounts/work/credential.json')),{code:'ENOENT'});
 await configureAccount('work',input,f);
 await assert.rejects(credentialsFor('work',denied),{code:'vault_unavailable'});
 await assert.rejects(configureAccount('work',{email:input.email,mode:'manual'},denied),{code:'credential_update_failed'});
 assert.equal((await f.settings('work')).vaultRemovalPending,true);
 await configureAccount('work',{email:input.email,mode:'manual'},f);assert.equal(f.secrets.size,0);assert.equal((await f.settings('work')).vaultRemovalPending,undefined);
});
test('a failed system-vault readback never commits automatic login',async t=>{
 const f=await fixture(t),vault=async()=>({setPassword:async()=>{},getPassword:async()=>null});
 await assert.rejects(configureAccount('work',{email:'u@example.com',mode:'vault',password:'secret'},{...f,vault}),{code:'credential_update_failed'});
 assert.equal((await f.settings('work')).mode,'manual');
});
test('old plaintext accounts require migration; settings removes the old password file',async t=>{
 const f=await fixture(t),email='u@example.com',folder=path.join(f.directory,'accounts/work');
 await privateJson(path.join(folder,'account.json'),{version:1,email,mode:'plain'});await privateJson(path.join(folder,'credential.json'),{version:1,kind:'plain',password:'old-secret'});
 await assert.rejects(credentialsFor('work',f),{code:'credential_migration_required'});
 await assert.rejects(configureAccount('work',{email,mode:'plain',password:'new-secret'},f),{code:'invalid_account_settings'});
 await configureAccount('work',{email,mode:'vault',password:'new-secret'},f);await assert.rejects(readFile(path.join(folder,'credential.json')),{code:'ENOENT'});assert.equal((await credentialsFor('work',f)).password,'new-secret');
});
test('user data paths are platform-specific and support spaces and non-Latin names',()=>{
 assert.equal(userDataDirectory('darwin',{},'/Users/Имя'),' /Users/Имя/Library/Application Support/NeuroverMCP'.trim());
 assert.equal(userDataDirectory('win32',{LOCALAPPDATA:'C:\\Users\\Name\\AppData\\Local'},'C:\\Users\\Name'),'C:\\Users\\Name\\AppData\\Local\\NeuroverMCP');
 assert.equal(userDataDirectory('linux',{XDG_DATA_HOME:'/tmp/Мои данные'},'/home/u'),'/tmp/Мои данные/neurover-mcp');
});
test('a stale process cannot overwrite a freshly captured session and can import it',async t=>{
 const f=await fixture(t),file=path.join(f.directory,'session.json');const old={cookies:[],origins:[]};const fresh={cookies:[{name:'session',value:'new-session',domain:'neurover.io',path:'/',expires:-1,httpOnly:true,secure:true,sameSite:'Lax'}],origins:[]};
 await privateJson(file,old);const c=new NeuroverClient('fixture',{storageState:async()=>old,dispose:async()=>{}},JSON.stringify(old));c.sessionFile=()=>file;
 await privateJson(file,fresh);await c.save();assert.deepEqual(JSON.parse(await readFile(file)),fresh);
 await c.syncSession();assert.equal((await c.context.storageState()).cookies[0].value,'new-session');await c.context.dispose();
});
test('credential POST cannot follow a cross-origin redirect or return the secret',async t=>{
 const f=await fixture(t);let posts=0;
 const context={dispose:async()=>{},post:async(url,options)=>{posts++;assert.equal(url,'https://neurover.io/');assert.equal(options.maxRedirects,0);assert.equal(options.form.password,'only-in-memory');return {headers:()=>({location:'https://evil.example/'}),status:()=>307,dispose:async()=>{}};}};
 t.mock.method(request,'newContext',async()=>context);
 const c=new NeuroverClient('fixture',context);c.refreshCsrf=async()=>({auth:{user:null},csrfToken:'fixture'});c.csrf='fixture';
 await assert.rejects(c.login({email:'u@example.com',password:'only-in-memory'}),error=>error.code==='unsafe_login_redirect'&&!error.message.includes('only-in-memory'));assert.equal(posts,1);
});
test('a login for another email is rejected without persisting its session',async t=>{
 let saves=0;
 const page=user=>'<div data-page="'+JSON.stringify({props:{csrfToken:'fixture',auth:{user}}}).replaceAll('"','&quot;')+'"></div>';
 const context={dispose:async()=>{},get:async()=>({text:async()=>page(null),dispose:async()=>{}}),post:async()=>({headers:()=>({}),status:()=>200,text:async()=>page({email:'other@example.com'}),dispose:async()=>{}})};
 t.mock.method(request,'newContext',async()=>context);
 const c=new NeuroverClient('fixture',context);c.save=async()=>{saves++;};
 await assert.rejects(c.login({email:'user@example.com',password:'test-secret'}),{code:'account_identity_mismatch'});assert.equal(saves,0);
});
test('share staging includes source and tests but excludes personal state, research and local reports',async t=>{
 const f=await fixture(t),stage=path.join(f.directory,'share');await stageRelease(stage);
 const files=[];async function walk(dir,prefix=''){for(const name of await readdir(dir,{withFileTypes:true})){const p=prefix+name.name;if(name.isDirectory())await walk(path.join(dir,name.name),p+'/');else files.push(p);}}await walk(stage);
 assert.ok(files.includes('src/client.js'));assert.ok(files.includes('test/accounts.test.js'));assert.ok(files.includes('package-lock.json'));assert.ok(files.includes('npm-shrinkwrap.json'));assert.ok(files.every(p=>!/(^|\/)(\.data|research|node_modules|browser-profile|dist)(\/|$)|session\.json|report\.html|\.log$/.test(p)));
 assert.ok(!(await readFile(path.join(stage,'README.md'),'utf8')).includes(os.homedir()));
});
