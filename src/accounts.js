import path from 'node:path';
import {readFile,readdir,unlink} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {z} from 'zod';
import {dataDir,sourceDir} from './paths.js';
import {privateJson,readJson} from './state.js';
import {ApiError} from './errors.js';
import {validateCredential} from './credential-file.js';
import {vaultEntry,vaultOperation} from './vault.js';
const schema=z.object({version:z.literal(1),email:z.string().email().max(254),mode:z.enum(['manual','vault','plain','encrypted']),passwordRemovalPending:z.literal(true).optional(),vaultRemovalPending:z.literal(true).optional()}).strict();
export function accountName(name){if(typeof name!=='string'||!/^\w[\w-]{0,63}$/.test(name))throw new ApiError('invalid_account','Use 1–64 letters, digits, underscores or hyphens for the account name.');return name;}
export function verifyAccountIdentity(config,user){
 if(!config?.email||typeof user?.email!=='string')throw new ApiError('account_identity_unverified','Cannot verify the signed-in account. The session was not accepted.');
 if(config.email.trim().toLowerCase()!==user.email.trim().toLowerCase())throw new ApiError('account_identity_mismatch','The signed-in email does not match this account. Sign in with the configured email.');
}
export async function accountNames(){
 const result=new Set();
 for(const dir of [path.join(dataDir,'accounts'),path.join(sourceDir,'.data/accounts')]){
  let entries;try{entries=await readdir(dir,{withFileTypes:true});}catch(e){if(e.code==='ENOENT')continue;throw e;}
  for(const e of entries)if(e.isDirectory()&&/^\w[\w-]{0,63}$/.test(e.name))result.add(e.name);
 }
 return [...result].sort();
}
export async function accountSettings(name,directory=dataDir){
 accountName(name);let value;
 try{value=await readJson(path.join(directory,'accounts',name,'account.json'));}
 catch(e){if(e.code!=='ENOENT')throw new ApiError('account_config_invalid','Cannot read account settings; credentials were not used.');
  if(directory===dataDir){try{const email=(await readFile(path.join(sourceDir,'.data/accounts',name,'email'),'utf8')).trim();if(!z.string().email().safeParse(email).success)throw Error('Invalid legacy email');return {version:1,email,mode:'legacy'};}catch(error){if(error.code!=='ENOENT')throw new ApiError('account_config_invalid','Legacy account settings are invalid.');}}
  return null;
 }
 const parsed=schema.safeParse(value);if(!parsed.success)throw new ApiError('account_config_invalid','Invalid account settings; credentials were not used.');return parsed.data;
}
export async function readCredential(name,directory=dataDir){
 accountName(name);let value;try{value=await readJson(path.join(directory,'accounts',name,'credential.json'));}catch{throw new ApiError('credentials_unavailable','No readable credential file. Open local settings or sign in manually.');}return validateCredential(value);
}
export async function credentialsFor(name,{settings=accountSettings,directory=dataDir,vault=vaultEntry}={}){
 const config=await settings(name);
 if(!config)throw new ApiError('account_setup_required','Add this account using the local setup command.');
 if(config.mode==='manual')throw new ApiError('manual_login_required','This account uses manual sign-in. Run the local login command or open the sign-in browser.');
 if(config.mode==='vault'){
  const password=await vaultOperation(vault,name,config.email,'getPassword');
  if(typeof password!=='string'||!password.length)throw new ApiError('credentials_unavailable','No saved system credential. Run local settings or sign in manually.');
  return {email:config.email,password};
 }
 if(config.mode==='encrypted')throw new ApiError('vault_locked','Unlock this account locally using the unlock command. Never send the master password in chat.');
 if(config.mode==='legacy'){
  // Compatibility only for the existing old Mac installation; new accounts never use Keychain.
  if(process.platform!=='darwin')throw new ApiError('account_setup_required','Configure a portable account using setup/settings.');
  try{const {stdout}=await promisify(execFile)('security',['find-generic-password','-a',config.email,'-s','neurover-io-mcp:'+name,'-w']);return {email:config.email,password:stdout.replace(/\r?\n$/,'')};}
  catch{throw new ApiError('credentials_unavailable','Legacy credential unavailable. Use local settings to select a portable mode.');}
 }
 throw new ApiError('credential_migration_required','Plaintext storage is disabled. Run local settings to choose system storage or manual sign-in.');
}
export async function configureAccount(name,input,{directory=dataDir,vault=vaultEntry}={}){
 accountName(name);const parsed=schema.safeParse({version:1,email:input.email,mode:input.mode});
 if(!parsed.success||!['manual','vault'].includes(input.mode))throw new ApiError('invalid_account_settings','Provide a valid email and manual/vault mode.');
 const config=parsed.data,previous=await accountSettings(name,directory),folder=path.join(directory,'accounts',name),file=path.join(folder,'account.json'),secretFile=path.join(folder,'credential.json');
 if(previous&&previous.email!==config.email)throw new ApiError('account_identity_changed','Use a new account name for another email address.');
 if(config.mode==='vault'&&(typeof input.password!=='string'||!input.password.length||Buffer.byteLength(input.password)>4096))throw new ApiError('invalid_password','Provide a nonempty password of at most 4096 bytes.');
 const touchesVault=config.mode==='vault'||previous?.mode==='vault'||previous?.vaultRemovalPending;
 // Disable automatic reads first; interrupted changes remain explicit and fail closed.
 await privateJson(file,{...config,mode:'manual',passwordRemovalPending:true,...touchesVault?{vaultRemovalPending:true}:{}});
 if(directory===dataDir){const {callBroker}=await import('./auth-broker.js');await callBroker('lock',name).catch(()=>{});}
 try{
  if(config.mode==='vault'){
   await vaultOperation(vault,name,config.email,'setPassword',input.password);
   if(await vaultOperation(vault,name,config.email,'getPassword')!==input.password)throw Error('Credential verification failed');
  }else if(touchesVault)await vaultOperation(vault,name,config.email,'deletePassword');
  await unlink(secretFile).catch(e=>{if(e.code!=='ENOENT')throw e;});
 }catch{throw new ApiError('credential_update_failed','Manual mode is enabled, but credential storage could not be updated/removed. Unlock the system store, check file access and repeat settings. No file fallback is used.');}
 await privateJson(file,config);return config;
}
