import {request} from 'playwright';
import path from 'node:path';
import {readFile} from 'node:fs/promises';
import {root,dataDir,sourceDir} from './paths.js';
import {ApiError} from './errors.js';
import {privateJson,readJson} from './state.js';
import {accountNames,accountName,credentialsFor,accountSettings,verifyAccountIdentity} from './accounts.js';
export {root,dataDir,sourceDir,ApiError,privateJson,readJson};
export const origin='https://neurover.io';
const contexts = new Map();
const queues = new Map();
const sessionRecovery = new WeakMap();
// Only replay reads: a lost write must keep its uncertain result.
export async function authenticatedRead(client,read) {
  await client.syncSession?.();
  let state=sessionRecovery.get(client);
  if(!state){state={version:0};sessionRecovery.set(client,state);}
  const version=state.version;
  try{return await read();}catch(error){
    if(!['login_required','session_expired'].includes(error.code)||!client.login)throw error;
    if(state.version===version){
      if(state.failedUntil>Date.now())throw state.error;
      if(!state.pending)state.pending=Promise.resolve().then(()=>client.login()).then(()=>{state.version++;state.failedUntil=0;},failure=>{state.error=failure;state.failedUntil=Date.now()+30000;throw failure;}).finally(()=>{state.pending=null;});
      await state.pending;
    }
    try{return await read();}catch(failure){
      if(['login_required','session_expired'].includes(failure.code)){state.error=failure;state.failedUntil=Date.now()+30000;}
      throw failure;
    }
  }
}
export function decodeEntities(s) {
  return s.replace(/&(#x[\da-f]+|#\d+|quot|amp|lt|gt|apos);/gi, (_, v) => v[0] === '#' ? String.fromCodePoint(v[1].toLowerCase() === 'x' ? parseInt(v.slice(2), 16) : Number(v.slice(1))) : ({quot:'"',amp:'&',lt:'<',gt:'>',apos:"'"})[v.toLowerCase()]);
}
export function parsePage(html) {
  const m = html.match(/\bdata-page="([^"]+)"/);
  if (!m) throw new ApiError('unexpected_response', 'Expected an Inertia page; the service may have changed.');
  return JSON.parse(decodeEntities(m[1]));
}
export const accounts=accountNames;
export async function selectAccount(name) {
  const names = await accounts();
  if (!name && names.length === 1) name = names[0];
  if (!name || !names.includes(name)) throw new ApiError('account_required', 'Select a configured account.', {accounts:names});
  return name;
}
export async function serial(account, fn) {
  const previous = queues.get(account) || Promise.resolve();
  const task = previous.catch(() => {}).then(fn);
  queues.set(account, task);
  try { return await task; } finally { if (queues.get(account) === task) queues.delete(account); }
}
export class NeuroverClient {
  constructor(account, context,sessionVersion=null) { this.account = account; this.context = context; this.csrf = null;this.sessionVersion=sessionVersion; }
  sessionFile() { return path.join(dataDir, 'accounts', this.account, 'session.json'); }
  async syncSession(){
    if(this.sessionSync)return this.sessionSync;
    this.sessionSync=(async()=>{
      const raw=await readFile(this.sessionFile(),'utf8').catch(e=>{if(e.code==='ENOENT')return null;throw e;});
      if(raw===null||raw===this.sessionVersion)return;
      const next=await request.newContext({storageState:JSON.parse(raw),ignoreHTTPSErrors:false});
      await this.context.dispose();this.context=next;this.csrf=null;this.sessionVersion=raw;
    })().finally(()=>{this.sessionSync=null;});return this.sessionSync;
  }
  async save({replace=false}={}) {
    const {lockDirectory}=await import('./media-dedup.js');
    await lockDirectory(path.join(dataDir,'accounts',this.account,'session-lock'),async()=>{
      const raw=await readFile(this.sessionFile(),'utf8').catch(e=>{if(e.code==='ENOENT')return null;throw e;});
      if(!replace&&raw!==this.sessionVersion)return;
      const state=await this.context.storageState();await privateJson(this.sessionFile(),state);this.sessionVersion=JSON.stringify(state);
    });
  }
  async http(urlPath, {method='GET', data, multipart, page=false, version, allowAnonymous=false, timeoutMs=45000,recoverSession=true} = {}) {
    if (!urlPath.startsWith('/') || urlPath.startsWith('//') || new URL(urlPath, origin).origin !== origin) throw new ApiError('invalid_path','Only Neurover paths are accepted.');
    if(method==='GET'&&!allowAnonymous&&recoverSession)return authenticatedRead(this,()=>this.http(urlPath,{method,data,multipart,page,version,allowAnonymous,timeoutMs,recoverSession:false}));
    const headers = {Accept:page?'text/html':'application/json', 'X-Requested-With':'XMLHttpRequest'};
    if (method !== 'GET') {
      if (!this.csrf) await this.page('/');
      if (!this.csrf) throw new ApiError('csrf_unavailable', 'No CSRF token. Sign in again.');
      headers['X-CSRF-TOKEN'] = this.csrf;
      if (version !== undefined) headers['X-Workflow-Version'] = String(version);
    }
    let res;
    try { res = await this.context.fetch(origin+urlPath, {method, headers, ...(multipart ? {multipart} : data !== undefined ? {data} : {}), timeout:Math.min(Math.max(timeoutMs,1000),90000), maxRetries:0}); }
    catch { throw new ApiError(method === 'GET' ? 'network_error' : 'request_uncertain', method === 'GET' ? 'Could not reach Neurover.' : 'Request outcome is uncertain. Check the current server state before making another write.'); }
    const status = res.status();
    const ct = res.headers()['content-type'] || '';
    let value;
    try { value = ct.includes('json') ? await res.json() : status >= 400 ? {} : parsePage(await res.text()); }
    finally { await res.dispose(); await this.save(); }
    if (!allowAnonymous && (status === 401 || value?.props?.auth?.user === null || /[?&]auth=login/.test(value?.url || ''))) throw new ApiError('login_required','Sign in to Neurover first.');
    if (status === 419) {this.csrf=null;throw new ApiError('session_expired','CSRF/session expired. Sign in again; the request was not retried.');}
    if (status < 200 || status >= 300) throw new ApiError(value?.code || `http_${status}`, value?.message || `Neurover returned HTTP ${status}.`, {httpStatus:status,errors:value?.errors});
    if (value?.props?.csrfToken) this.csrf=value.props.csrfToken;
    return value;
  }
  async page(urlPath) { const p = await this.http(urlPath,{page:true}); this.csrf=p.props?.csrfToken || this.csrf; return p.props; }
  async refreshCsrf({sync=true,saveSession=true}={}) {
    if(sync)await this.syncSession();
    const r=await this.context.get(origin+'/',{headers:{Accept:'text/html'},timeout:45000});
    try {const p=parsePage(await r.text());this.csrf=p.props.csrfToken;return p.props;} finally{await r.dispose();if(saveSession)await this.save();}
  }
  async login(credentials) {
    if(credentials){const next=await request.newContext();await this.context.dispose();this.context=next;this.csrf=null;}
    const info=await this.refreshCsrf({sync:!credentials,saveSession:false});
    if(info.auth?.user){verifyAccountIdentity(credentials||await accountSettings(this.account),info.auth.user);return {account:this.account,status:'already_authenticated',transport:'http'};}
    if(!credentials&&(await accountSettings(this.account))?.mode==='encrypted'){
      const {callBroker}=await import('./auth-broker.js');const result=await callBroker('login',this.account);await this.syncSession();return {...result,transport:'http'};
    }
    let {email,password}=credentials||await credentialsFor(this.account);
    const r=await this.context.post(origin+'/',{headers:{Accept:'text/html','X-CSRF-TOKEN':this.csrf,'X-Requested-With':'XMLHttpRequest'},form:{email,password,remember:'1'},timeout:45000,maxRetries:0,maxRedirects:0});
    password=null;
    try {const redirect=r.headers().location;
      if(redirect&&new URL(redirect,origin).origin!==origin)throw new ApiError('unsafe_login_redirect','Login tried to redirect outside Neurover; the password was not forwarded.');
      const p=[301,302,303].includes(r.status())?await this.refreshCsrf({sync:false,saveSession:false}):parsePage(await r.text()).props;this.csrf=p.csrfToken || this.csrf;
      if(!p.auth?.user) throw new ApiError('needs_attention','Direct login did not authenticate. Complete sign-in using the isolated browser login tool.',{httpStatus:r.status(),errors:p.errors});
      verifyAccountIdentity({email},p.auth.user);
      await this.save({replace:true});
      return {account:this.account,status:'authenticated',transport:'http'};
    } finally {await r.dispose();}
  }
  async authStatus() {const p=await this.refreshCsrf();return {account:this.account,status:p.auth?.user?'authenticated':'login_required',transport:'http'};}
  async workflow(id) {return this.http(`/workflows/${id}`);}
  async mutateWorkflow(id, suffix, method, data) {const current=await this.workflow(id);return this.http(`/workflows/${id}${suffix}`,{method,data,version:current.workflow.version});}
}
export async function clientFor(account) {
  accountName(account);
  if(contexts.has(account)) return contexts.get(account);
  const file=path.join(dataDir,'accounts',account,'session.json');
  let raw=null;try {raw=await readFile(file,'utf8');}catch(e){if(e.code!=='ENOENT') throw e;}
  const c=new NeuroverClient(account,await request.newContext({storageState:raw?JSON.parse(raw):undefined,ignoreHTTPSErrors:false}),raw);contexts.set(account,c);return c;
}
export async function closeClients() {await Promise.all([...contexts.values()].map(c=>c.context.dispose()));contexts.clear();}
