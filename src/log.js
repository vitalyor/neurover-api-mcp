// Local diagnostic log for support: <dataDir>/logs/neurover.log, ~1 MB plus one previous file. Built-ins only (the installer uses it).
// Never written: passwords, cookies, tokens, prompts, tool argument values, emails, signed-URL queries, the user's home path.
import {appendFileSync,statSync,renameSync,mkdirSync,readFileSync,existsSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {dataDir} from './paths.js';
import {currentVersion} from './update.js';

export const logFile=(dir=dataDir)=>path.join(dir,'logs','neurover.log');
const LIMIT=1_000_000;

export function redact(text,home=os.homedir()){
 let s=String(text);
 if(home&&home.length>1)s=s.split(home).join('~').split(home.replaceAll('\\','\\\\')).join('~');
 return s
  .replace(/[\w.+-]+@[\w-]+(\.[\w-]+)+/g,'<email>')
  .replace(/(https?:\/\/[^\s"'?]+)\?[^\s"']*/g,'$1?<query>')
  .replace(/((?:cookie|authorization|csrf|token|password|secret)[\w-]*)(["']?\s*[:=]\s*["']?)[^\s,"'}&]+/gi,'$1$2<hidden>');
}

export function log(event,data={},{dir=dataDir}={}){
 try{
  const file=logFile(dir);mkdirSync(path.dirname(file),{recursive:true});
  try{if(statSync(file).size>LIMIT)renameSync(file,file+'.1');}catch{}
  appendFileSync(file,redact(JSON.stringify({t:new Date().toISOString(),v:currentVersion,pid:process.pid,event,...data}))+'\n',{mode:0o600});
 }catch{} // logging must never break the MCP
}

// Error details worth sending: code and message always, the stack only for unexpected (non-ApiError) failures.
export const errorInfo=(e,expected)=>({code:e?.code||'error',message:String(e?.message||e).slice(0,500),...expected?{}:{stack:String(e?.stack||'').split('\n').slice(0,8).join('\n')}});

export function tail(lines=300,dir=dataDir){
 const file=logFile(dir),parts=[];
 for(const f of [file+'.1',file])if(existsSync(f))parts.push(readFileSync(f,'utf8'));
 return parts.join('').trimEnd().split('\n').slice(-lines).join('\n');
}
