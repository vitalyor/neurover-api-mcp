import {ApiError} from './errors.js';
export async function vaultEntry(account,email){
 try{
  const {AsyncEntry}=await import('@napi-rs/keyring');
  // Require persistent Secret Service on Linux instead of a volatile kernel fallback.
  return new AsyncEntry('neurover-api-mcp:'+account,email,{linux:{store:'secret-service'}});
 }catch{throw new ApiError('vault_unavailable','System credential storage is unavailable. Unlock/configure it or choose manual sign-in. No file fallback is used.');}
}
export async function vaultOperation(vault,account,email,action,password){
 try{const entry=await vault(account,email);return await entry[action](...password===undefined?[]:[password]);}
 catch{throw new ApiError('vault_unavailable','System credential storage is unavailable or access was denied. Unlock it or choose manual sign-in. No file fallback is used.');}
}
