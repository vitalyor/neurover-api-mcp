import {mkdtemp,rm,readdir} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const tests=fileURLToPath(new URL('../test/',import.meta.url));
const directory=await mkdtemp(path.join(os.tmpdir(),'neurover-tests-'));
try{
 const files=(await readdir(tests)).filter(name=>name.endsWith('.test.js')).map(name=>path.join(tests,name));
 const child=spawn(process.execPath,['--test',...files],{stdio:'inherit',env:{...process.env,NEUROVER_DATA_DIR:directory,NEUROVER_SOURCE_DIR:path.join(directory,'no-legacy')}});
 process.exitCode=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',code=>resolve(code??1));});
}finally{await rm(directory,{recursive:true,force:true});}
