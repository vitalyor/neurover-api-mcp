import {mkdtemp,mkdir,cp,readFile,writeFile,readdir,lstat,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {root} from '../src/paths.js';
export const releaseFiles=['src','bin','test','scripts/test.mjs','scripts/bundle.mjs','scripts/check-readonly.mjs','scripts/install.mjs','scripts/launcher.mjs','get.sh','get.ps1','package.json','package-lock.json','LICENSE','install.sh','install.command','install.cmd','docs/INSTALL.md','docs/PRIVACY.md'];
async function rejectLinks(target){const s=await lstat(target);if(s.isSymbolicLink())throw Error('Release inputs must not contain symlinks.');if(s.isDirectory())for(const name of await readdir(target))await rejectLinks(path.join(target,name));}
export async function stageRelease(destination){
 await mkdir(destination,{recursive:true});
 for(const file of releaseFiles){let source=path.join(root,file);if(file==='package-lock.json')try{await lstat(source);}catch(e){if(e.code!=='ENOENT')throw e;source=path.join(root,'npm-shrinkwrap.json');}await rejectLinks(source);await mkdir(path.dirname(path.join(destination,file)),{recursive:true});await cp(source,path.join(destination,file),{recursive:true});}
 await writeFile(path.join(destination,'README.md'),(await readFile(path.join(root,'docs/INSTALL.md'),'utf8')).replace('(PRIVACY.md)','(docs/PRIVACY.md)'));
 // npm omits package-lock from tarballs; shrinkwrap preserves the same locked graph.
 await cp(path.join(destination,'package-lock.json'),path.join(destination,'npm-shrinkwrap.json'));
}
if(process.argv[1]&&path.resolve(process.argv[1])===path.join(root,'scripts/bundle.mjs')){
 const out=path.resolve(process.argv[2]||path.join(root,'dist'));await mkdir(out,{recursive:true});
 if(!process.env.npm_execpath)throw Error('Run this script using npm run bundle.');
 const temporary=await mkdtemp(path.join(os.tmpdir(),'neurover-release-'));
 try{
  const stage=path.join(temporary,'neurover-api-mcp');await stageRelease(stage);
  const child=spawn(process.execPath,[process.env.npm_execpath,'pack','--ignore-scripts','--pack-destination',out],{cwd:stage,stdio:'inherit'});
  const code=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',resolve);});if(code!==0)throw Error('Packaging failed.');
  const folder=path.join(out,'neurover-api-mcp');
  try{await mkdir(folder);}catch(e){if(e.code==='EEXIST')throw Error('Share folder exists; choose a new output directory rather than overwriting it.');throw e;}
  await cp(stage,folder,{recursive:true});console.log('Share only this clean folder or the generated tgz: '+out);
 }finally{await rm(temporary,{recursive:true,force:true});}
}
