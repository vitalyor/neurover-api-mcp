import path from 'node:path';
import {root,dataDir} from './paths.js';
import {installLayout} from './update.js';
// Managed installs point clients at the stable launcher so updates never change their config.
export function entryPoint(){const layout=installLayout();return layout.kind==='managed'?path.join(layout.app,'neurover.mjs'):path.join(root,'bin/neurover.mjs');}
export function mcpServer(){return {command:process.execPath,args:[entryPoint(),'start'],env:{NEUROVER_DATA_DIR:dataDir}};}
export function mcpConfig(){return {mcpServers:{neurover:mcpServer()}};}
