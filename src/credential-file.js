import {randomBytes,scrypt,createCipheriv,createDecipheriv,createHash} from 'node:crypto';
import {promisify} from 'node:util';
import {z} from 'zod';
import {ApiError} from './errors.js';
const derive=promisify(scrypt);
const base64=z.string().max(8192).regex(/^[A-Za-z0-9+/]*={0,2}$/);
const encrypted=z.object({version:z.literal(1),kind:z.literal('encrypted'),salt:base64,iv:base64,tag:base64,ciphertext:base64}).strict();
const plain=z.object({version:z.literal(1),kind:z.literal('plain'),password:z.string().min(1).max(4096)}).strict();
export function validateCredential(value){
 const result=z.union([encrypted,plain]).safeParse(value);
 if(!result.success)throw new ApiError('credential_file_invalid','Credential file is invalid; no password was used.');
 const r=result.data;if(r.kind==='encrypted'&&(Buffer.from(r.salt,'base64').length!==32||Buffer.from(r.iv,'base64').length!==12||Buffer.from(r.tag,'base64').length!==16||Buffer.from(r.ciphertext,'base64').length>4096))throw new ApiError('credential_file_invalid','Encrypted credential is invalid.');return r;
}
const aad=(account,email)=>Buffer.from(JSON.stringify([account,email]));
export const credentialVersion=record=>createHash('sha256').update(JSON.stringify(record)).digest('hex');
async function keyFor(masterPassword,salt){
 if(typeof masterPassword!=='string'||masterPassword.length<10||masterPassword.length>4096)throw new ApiError('master_password_required','Use a master password of at least 10 characters.');
 return derive(masterPassword,Buffer.from(salt,'base64'),32,{N:32768,r:8,p:1,maxmem:64*1024*1024});
}
export async function encryptCredential(password,masterPassword,account,email){
 if(typeof password!=='string'||!password.length||Buffer.byteLength(password)>4096)throw new ApiError('invalid_password','Password must be nonempty and at most 4096 bytes.');
 const salt=randomBytes(32).toString('base64'),iv=randomBytes(12),key=await keyFor(masterPassword,salt);
 try{const cipher=createCipheriv('aes-256-gcm',key,iv);cipher.setAAD(aad(account,email));const bytes=Buffer.concat([cipher.update(password,'utf8'),cipher.final()]);return {version:1,kind:'encrypted',salt,iv:iv.toString('base64'),tag:cipher.getAuthTag().toString('base64'),ciphertext:bytes.toString('base64')};}finally{key.fill(0);}
}
export function decryptCredential(record,key,account,email){
 validateCredential(record);if(record.kind!=='encrypted')throw new ApiError('credential_file_invalid','Expected an encrypted credential.');
 try{const cipher=createDecipheriv('aes-256-gcm',key,Buffer.from(record.iv,'base64'));cipher.setAAD(aad(account,email));cipher.setAuthTag(Buffer.from(record.tag,'base64'));return Buffer.concat([cipher.update(Buffer.from(record.ciphertext,'base64')),cipher.final()]).toString('utf8');}
 catch{throw new ApiError('vault_unlock_failed','Incorrect master password or modified credential file.');}
}
export async function unlockCredential(record,masterPassword,account,email){
 validateCredential(record);if(record.kind!=='encrypted')throw new ApiError('credential_file_invalid','Expected encrypted storage.');const key=await keyFor(masterPassword,record.salt);
 try{decryptCredential(record,key,account,email);return key;}catch(e){key.fill(0);throw e;}
}
