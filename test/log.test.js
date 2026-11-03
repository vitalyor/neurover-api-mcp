import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile,writeFile,mkdir,stat} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {redact,log,tail,logFile,errorInfo} from '../src/log.js';
import {diagnosticsText} from '../src/diagnostics.js';

test('log redaction keeps support details and drops secrets',()=>{
 const s=redact('C:\\Users\\Алиса\\x user@mail.ru https://cdn.neurover.io/f.png?X-Amz-Signature=abc cookie=abc123 "password":"p@ss" csrfToken: zzz','C:\\Users\\Алиса');
 assert.ok(s.includes('~\\x'),s);
 for(const secret of ['Алиса','user@mail.ru','X-Amz-Signature','abc123','p@ss','zzz'])assert.ok(!s.includes(secret),secret+' leaked: '+s);
 assert.ok(s.includes('https://cdn.neurover.io/f.png?<query>'));
});

test('log appends JSON lines, rotates at about 1 MB and never throws',async t=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'neurover-log-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 log('tool',{name:'neurover_balance',keys:['account'],ok:true},{dir});
 const line=JSON.parse((await readFile(logFile(dir),'utf8')).trim());
 assert.equal(line.event,'tool');assert.equal(line.name,'neurover_balance');assert.ok(line.v&&line.t);
 await writeFile(logFile(dir),'x'.repeat(1_000_001));log('after',{},{dir});
 assert.ok((await stat(logFile(dir)+'.1')).size>1_000_000);assert.match(await readFile(logFile(dir),'utf8'),/"after"/);
 assert.match(tail(5,dir),/"after"/);
 assert.doesNotThrow(()=>log('x',{},{dir:'\0bad'}));
 assert.equal(errorInfo(Object.assign(new Error('boom'),{code:'E1'}),true).stack,undefined,'expected errors carry no stack');
 assert.match(errorInfo(new Error('boom'),false).stack,/boom/);
});

test('diagnostics report: setup facts and log, no emails',async t=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'neurover-diag-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const cfg=path.join(dir,'claude.json');await writeFile(cfg,JSON.stringify({mcpServers:{neurover:{command:'node',args:['/x/app/neurover.mjs','start']}}}));
 log('tool',{name:'neurover_media',ok:false,code:'login_required',message:'for someone@example.com'},{dir});
 const text=await diagnosticsText({dir,clients:[{name:'Claude Desktop',file:cfg},{name:'Cursor',file:path.join(dir,'nope','mcp.json')}]});
 assert.match(text,/Neurover MCP \d/);assert.match(text,/Claude Desktop: neurover подключён/);assert.match(text,/Cursor: не найдено/);
 assert.match(text,/login_required/);assert.ok(!text.includes('someone@example.com'));
});
