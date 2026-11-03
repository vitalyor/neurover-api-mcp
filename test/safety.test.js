import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {legacySourceDir} from '../src/paths.js';
import {onNeurover} from '../src/browser-auth.js';
import {isOwnEntry} from '../src/clients.js';

test('clean installs never look at a sibling folder; old in-place installs and explicit settings do',async t=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'neurover-legacy-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const code=path.join(dir,'app');await mkdir(code);
 assert.equal(legacySourceDir({},code),null);
 await mkdir(path.join(code,'.data'));
 assert.equal(legacySourceDir({},code),path.join(dir,'neurover-io-mcp'));
 assert.equal(legacySourceDir({NEUROVER_SOURCE_DIR:'/explicit'},code),'/explicit');
});

test('credentials are typed only on neurover.io',()=>{
 assert.equal(onNeurover('https://neurover.io/login?next=/workflows'),true);
 for(const url of ['https://neurover.io.evil.example/login','https://evil.example/?u=https://neurover.io','http://neurover.io/login','https://accounts.google.com/','about:blank','not a url'])
  assert.equal(onNeurover(url),false,url);
});

test('only our own Claude Code entry may be replaced',()=>{
 assert.equal(isOwnEntry('neurover:\n  Command: /usr/bin/node\n  Args: /Users/u/Library/Application Support/NeuroverMCP/app/neurover.mjs start'),true);
 assert.equal(isOwnEntry('neurover:\n  Command: echo\n  Args: other'),false);
 assert.equal(isOwnEntry(''),false);
});
