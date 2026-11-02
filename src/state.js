import path from 'node:path';
import {mkdir,writeFile,rename,chmod,readFile} from 'node:fs/promises';
export async function privateJson(file,value){
 await mkdir(path.dirname(file),{recursive:true,mode:0o700});
 const tmp=`${file}.${process.pid}.tmp`;
 await writeFile(tmp,JSON.stringify(value),{mode:0o600});await rename(tmp,file);await chmod(file,0o600);
}
export async function readJson(file){return JSON.parse(await readFile(file,'utf8'));}
