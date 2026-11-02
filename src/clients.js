// Add the neurover entry to MCP client configs (JSON with "mcpServers"). Built-ins only.
import {readFile,writeFile,rename,copyFile} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {ApiError} from './errors.js';

export function knownClients(platform=process.platform,env=process.env,home=os.homedir()){
 const p=platform==='win32'?path.win32:path.posix;
 const appConfig=platform==='win32'?(env.APPDATA||p.join(home,'AppData','Roaming')):platform==='darwin'?p.join(home,'Library','Application Support'):(env.XDG_CONFIG_HOME||p.join(home,'.config'));
 return [
  {name:'Claude Desktop',file:p.join(appConfig,'Claude','claude_desktop_config.json')},
  {name:'Cursor',file:p.join(home,'.cursor','mcp.json')},
  {name:'Windsurf',file:p.join(home,'.codeium','windsurf','mcp_config.json')}
 ];
}
// A client counts as installed when its config folder exists; we never create folders for absent apps.
export const installedClients=(list=knownClients())=>list.filter(c=>existsSync(path.dirname(c.file)));

export async function addToClient(file,entry,name='neurover'){
 let text=null;try{text=await readFile(file,'utf8');}catch(e){if(e.code!=='ENOENT')throw e;}
 let config={};
 if(text?.trim()){
  try{config=JSON.parse(text);}catch{throw new ApiError('client_config_invalid',`${file} is not valid JSON; it was left untouched. Add the server by hand.`);}
  if(!config||typeof config!=='object'||Array.isArray(config))throw new ApiError('client_config_invalid',`${file} has an unexpected format; it was left untouched.`);
 }
 const servers=config.mcpServers&&typeof config.mcpServers==='object'&&!Array.isArray(config.mcpServers)?config.mcpServers:{};
 if(JSON.stringify(servers[name])===JSON.stringify(entry))return {status:'unchanged',file};
 const backup=text===null?null:file+'.bak-neurover';
 if(backup)await copyFile(file,backup);
 config.mcpServers={...servers,[name]:entry};
 const tmp=file+'.tmp-neurover';await writeFile(tmp,JSON.stringify(config,null,2)+'\n');await rename(tmp,file);
 return {status:servers[name]?'replaced':'added',file,backup};
}
