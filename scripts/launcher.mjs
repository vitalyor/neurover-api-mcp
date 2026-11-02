// Stable entry point copied to <app>/neurover.mjs. MCP clients point here, so updates never change their config.
// It runs whichever version current.json names; keep this file tiny and backward compatible.
import {readFileSync} from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
const {version}=JSON.parse(readFileSync(path.join(import.meta.dirname,'current.json'),'utf8'));
globalThis.neuroverLauncher=true;
await import(pathToFileURL(path.join(import.meta.dirname,'versions',version,'bin','neurover.mjs')).href);
