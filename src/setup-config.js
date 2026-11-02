import path from 'node:path';
import {root,dataDir} from './paths.js';
export function mcpConfig(){return {mcpServers:{neurover:{command:process.execPath,args:[path.join(root,'bin/neurover.mjs'),'start'],env:{NEUROVER_DATA_DIR:dataDir}}}};}
