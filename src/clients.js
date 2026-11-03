// Add the neurover entry to MCP clients: JSON "mcpServers" files, Codex config.toml, Claude Code via its CLI. Built-ins only.
import {readFile,writeFile,rename,copyFile} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {spawnSync} from 'node:child_process';
import {ApiError} from './errors.js';

export function knownClients(platform=process.platform,env=process.env,home=os.homedir()){
 const p=platform==='win32'?path.win32:path.posix;
 const appConfig=platform==='win32'?(env.APPDATA||p.join(home,'AppData','Roaming')):platform==='darwin'?p.join(home,'Library','Application Support'):(env.XDG_CONFIG_HOME||p.join(home,'.config'));
 return [
  {name:'Claude Desktop',file:p.join(appConfig,'Claude','claude_desktop_config.json')},
  {name:'Cursor',file:p.join(home,'.cursor','mcp.json')},
  {name:'Windsurf',file:p.join(home,'.codeium','windsurf','mcp_config.json')},
  {name:'Codex',file:p.join(env.CODEX_HOME||p.join(home,'.codex'),'config.toml')}
 ];
}
// A client counts as installed when its config folder exists; we never create folders for absent apps.
export const installedClients=(list=knownClients())=>list.filter(c=>existsSync(path.dirname(c.file)));

async function save(file,text,content){
 const backup=text===null?null:file+'.bak-neurover';
 if(backup)await copyFile(file,backup);
 const tmp=file+'.tmp-neurover';await writeFile(tmp,content);await rename(tmp,file);
 return backup;
}

// Codex keeps MCP servers in TOML. JSON string escaping is valid TOML basic-string escaping, so paths survive on Windows.
export function codexBlock(entry,name='neurover'){
 const s=JSON.stringify;
 return `[mcp_servers.${name}]\ncommand = ${s(entry.command)}\nargs = [${entry.args.map(a=>s(a)).join(', ')}]\nstartup_timeout_sec = 20\ntool_timeout_sec = 120\n`+
  (entry.env?`\n[mcp_servers.${name}.env]\n${Object.entries(entry.env).map(([k,v])=>`${k} = ${s(v)}`).join('\n')}\n`:'');
}
async function addToToml(file,entry,name){
 let text=null;try{text=await readFile(file,'utf8');}catch(e){if(e.code!=='ENOENT')throw e;}
 const block=codexBlock(entry,name),lines=(text||'').split('\n');
 // Our section plus its sub-tables (e.g. .env) run until the next unrelated [table] header.
 const own=l=>l.trim()===`[mcp_servers.${name}]`||l.trim().startsWith(`[mcp_servers.${name}.`);
 const start=lines.findIndex(own);
 let content;
 if(start<0)content=(text&&!text.endsWith('\n')?text+'\n':text||'')+(text?.trim()?'\n':'')+block;
 else{
  let end=start+1;while(end<lines.length&&!(/^\s*\[/.test(lines[end])&&!own(lines[end])))end++;
  const current=lines.slice(start,end).join('\n').trimEnd()+'\n';
  if(current===block.trimEnd()+'\n')return {status:'unchanged',file};
  content=[...lines.slice(0,start),...block.trimEnd().split('\n'),'',...lines.slice(end)].join('\n');
 }
 return {status:start<0?'added':'replaced',file,backup:await save(file,text,content)};
}

export async function addToClient(file,entry,name='neurover'){
 if(file.endsWith('.toml'))return addToToml(file,entry,name);
 let text=null;try{text=await readFile(file,'utf8');}catch(e){if(e.code!=='ENOENT')throw e;}
 let config={};
 if(text?.trim()){
  try{config=JSON.parse(text);}catch{throw new ApiError('client_config_invalid',`${file} is not valid JSON; it was left untouched. Add the server by hand.`);}
  if(!config||typeof config!=='object'||Array.isArray(config))throw new ApiError('client_config_invalid',`${file} has an unexpected format; it was left untouched.`);
 }
 const servers=config.mcpServers&&typeof config.mcpServers==='object'&&!Array.isArray(config.mcpServers)?config.mcpServers:{};
 if(JSON.stringify(servers[name])===JSON.stringify(entry))return {status:'unchanged',file};
 config.mcpServers={...servers,[name]:entry};
 return {status:servers[name]?'replaced':'added',file,backup:await save(file,text,JSON.stringify(config,null,2)+'\n')};
}

// Claude Code stores servers itself; use its CLI when present. On Windows "claude" is a .cmd shim that needs a shell.
const shell=process.platform==='win32',quote=a=>shell?`"${a}"`:a;
const claude=args=>spawnSync('claude',args.map(quote),{encoding:'utf8',shell});
export const hasClaudeCode=()=>{try{return claude(['--version']).status===0;}catch{return false;}};
// Our entry runs neurover.mjs; anything else under the same name belongs to someone else and is left alone.
export const isOwnEntry=text=>/neurover\.mjs/.test(text||'');
export function addToClaudeCode(entry,name='neurover'){
 const existing=claude(['mcp','get',name]);
 if(existing.status===0){
  if(!isOwnEntry(existing.stdout))throw new ApiError('claude_code_conflict',`Claude Code already has a different MCP server named "${name}"; it was left untouched.`);
  claude(['mcp','remove','--scope','user',name]);
 }
 const env=Object.entries(entry.env||{}).flatMap(([k,v])=>['-e',`${k}=${v}`]);
 const r=claude(['mcp','add','--scope','user',name,...env,'--',entry.command,...entry.args]);
 if(r.status!==0)throw new ApiError('claude_code_failed',(r.stderr||r.stdout||'claude mcp add failed').trim().slice(0,300));
 return {status:'added',file:'Claude Code'};
}
