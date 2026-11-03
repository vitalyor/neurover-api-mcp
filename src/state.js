import path from 'node:path';
import {mkdir,writeFile,rename,chmod,readFile} from 'node:fs/promises';
// Windows refuses to replace or read a file for a few ms while another process (status polling) has it open.
// ponytail: fixed backoff ~1.5 s total, same idea as graceful-fs; raise attempts if slow antivirus scans still win.
const transient=new Set(['EPERM','EACCES','EBUSY']);
export async function retryTransient(fn,{attempts=10,delayMs=15}={}){
 for(let i=1;;i++){
  try{return await fn();}
  catch(e){if(!transient.has(e.code)||i>=attempts)throw e;await new Promise(resolve=>setTimeout(resolve,delayMs*i));}
 }
}
export async function privateJson(file,value){
 await mkdir(path.dirname(file),{recursive:true,mode:0o700});
 const tmp=`${file}.${process.pid}.tmp`;
 await writeFile(tmp,JSON.stringify(value),{mode:0o600});await retryTransient(()=>rename(tmp,file));await chmod(file,0o600);
}
export async function readJson(file){return JSON.parse(await retryTransient(()=>readFile(file,'utf8')));}
