import path from 'node:path';
import {existsSync} from 'node:fs';
import {root,dataDir} from './paths.js';
import {installLayout} from './update.js';
import {codexBlock} from './clients.js';
// Managed installs point clients at the stable launcher so updates never change their config.
export function entryPoint(){const layout=installLayout();return layout.kind==='managed'?path.join(layout.app,'neurover.mjs'):path.join(root,'bin/neurover.mjs');}
export function mcpServer(){return {command:process.execPath,args:[entryPoint(),'start'],env:{NEUROVER_DATA_DIR:dataDir}};}
export function mcpConfig(){return {mcpServers:{neurover:mcpServer()}};}
// The exact Node that runs us: the installer may have set up a private copy that is not on PATH. PowerShell needs & before a quoted program.
export const wrapperPath=(platform=process.platform,dir=dataDir)=>path.join(dir,platform==='win32'?'neurover.cmd':'neurover');
export function cliCommand(entry=entryPoint(),{platform=process.platform,node=process.execPath,wrapper=existsSync(wrapperPath(platform))?wrapperPath(platform):null}={}){
 return `${platform==='win32'?'& ':''}${wrapper?`"${wrapper}"`:`"${node}" "${entry}"`}`;
}
// One text that lets a person or agent connect any MCP harness: the universal stdio fields plus the common config shapes.
export function connectionGuide(entry=mcpServer()){
 const q=s=>/[\s"']/.test(s)?JSON.stringify(s):s,json=v=>JSON.stringify(v,null,2);
 return `Neurover MCP — локальный stdio-сервер. В любом приложении с поддержкой MCP добавьте сервер с такими полями:
  name:    neurover
  type:    stdio (local / command)
  command: ${entry.command}
  args:    ${entry.args.map(q).join(' ')}
  env:     ${Object.entries(entry.env).map(([k,v])=>`${k}=${v}`).join(' ')}
Затем полностью перезапустите приложение.

Claude Desktop, Cursor, Windsurf, Cline, Gemini CLI и большинство других — блок mcpServers в их JSON-настройках:
${json({mcpServers:{neurover:entry}})}

VS Code (Copilot), файл mcp.json — ключ servers:
${json({servers:{neurover:{type:'stdio',...entry}}})}

Codex, ~/.codex/config.toml:
${codexBlock(entry)}
Claude Code:
  claude mcp add --scope user neurover ${Object.entries(entry.env).map(([k,v])=>`-e ${q(k+'='+v)}`).join(' ')} -- ${[entry.command,...entry.args].map(q).join(' ')}

Агент: если вашего приложения здесь нет, найдите в его документации, как добавить локальный stdio MCP-сервер, и перенесите поля выше. Правьте настройки только с согласия пользователя и сохраните копию файла.`;
}
