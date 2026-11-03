import path from 'node:path';
import os from 'node:os';
import {existsSync} from 'node:fs';
export const root=path.resolve(import.meta.dirname,'..');
export function userDataDirectory(platform=process.platform,env=process.env,home=os.homedir()){
 const p=platform==='win32'?path.win32:path.posix;
 if(platform==='win32')return p.join(env.LOCALAPPDATA||p.join(home,'AppData','Local'),'NeuroverMCP');
 if(platform==='darwin')return p.join(home,'Library','Application Support','NeuroverMCP');
 return p.join(env.XDG_DATA_HOME||p.join(home,'.local','share'),'neurover-mcp');
}
const override=process.env.NEUROVER_DATA_DIR;
if(override&&!path.isAbsolute(override))throw Error('NEUROVER_DATA_DIR must be an absolute path.');
// Preserve this existing installation; clean distributions use the user's data folder.
export const dataDir=override||(existsSync(path.join(root,'.data'))?path.join(root,'.data'):userDataDirectory());
// Compatibility with the author's earlier browser MCP. Only an old in-place install (data in <code>/.data) or an explicit
// NEUROVER_SOURCE_DIR looks at that sibling folder; clean installs never read outside their own folders.
export function legacySourceDir(env=process.env,codeRoot=root){
 if(env.NEUROVER_SOURCE_DIR)return env.NEUROVER_SOURCE_DIR;
 return existsSync(path.join(codeRoot,'.data'))?path.resolve(codeRoot,'../neurover-io-mcp'):null;
}
export const sourceDir=legacySourceDir();
