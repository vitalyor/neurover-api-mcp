import test from 'node:test';
import assert from 'node:assert/strict';
import {unlink} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {parsePage,privateJson} from '../src/client.js';
import {charCount,validatePrompt,validateBudget,messageForm,submit,draftFile} from '../src/generation.js';
import {safeDestination} from '../src/media.js';
import {createHash} from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
test('Inertia page preserves quotes, Unicode and ampersands',()=>{
 const p=parsePage('<div data-page="{&quot;props&quot;:{&quot;name&quot;:&quot;Тест &amp; &#x1F600;&quot;}}"></div>');assert.equal(p.props.name,'Тест & 😀');
 assert.throws(()=>parsePage('<html>Error</html>'));
});
test('limits follow selected model and count Unicode code points',()=>{
 assert.equal(charCount('Я😀'),2);validatePrompt({input_schema_json:{prompt:{min:1,max:30000}}},'x'.repeat(20000));assert.throws(()=>validatePrompt({input_schema_json:{prompt:{max:5000}}},'x'.repeat(5001)));
});
test('budget uses credits minor units and never rounds up permission',()=>{
 assert.equal(validateBudget(3116,31.16),3116);assert.throws(()=>validateBudget(3116,31.159));assert.throws(()=>validateBudget(NaN,100));
});
test('multipart retains reference order and duplicate field names',()=>{
 const f=messageForm({requestId:'x',modelId:64,prompt:'test',settings:{draft:false},references:[{mediaAssetId:7,field:'images'},{mediaAssetId:8,field:'images'}]},'quote');assert.deepEqual(f.getAll('reference_asset_ids[images][]'),['7','8']);assert.equal(f.get('settings[draft]'),'0');assert.equal(f.get('price_quote_id'),'quote');
});
test('download refuses relative directories and filename traversal',()=>{
 const dir=os.tmpdir();assert.throws(()=>safeDestination('relative','x.png'));assert.throws(()=>safeDestination(dir,'../x'));assert.throws(()=>safeDestination(dir,'a\\b'));assert.equal(safeDestination(dir,'test.png'),path.join(dir,'test.png'));
});
test('paid submit rejects over-budget, claims once and survives another call',async()=>{
 const token=randomUUID(),file=draftFile(token);const schema={prompt:{max:30000}};let sends=0;
 const model={id:64,input_schema_json:schema};const c={account:'test',page:async()=>({modelOptions:[model]}),http:async(path)=>path.endsWith('/price-preview')?{status:'completed',credits_minor:250,price_quote_id:'q'}:(sends++,{assistant_message:{id:1}})};
 const item={account:'test',workflowId:1,modelId:64,prompt:'test',settings:{},references:[],requestId:randomUUID(),createdAt:Date.now(),quote:{credits_minor:250},schemaHash:createHash('sha256').update(JSON.stringify(schema)).digest('hex')};
 try{
  await privateJson(file,item);await assert.rejects(submit(c,token,2),{code:'over_limit'});assert.equal(sends,0);
  await submit(c,token,3);assert.equal(sends,1);await assert.rejects(submit(c,token,3),{code:'already_submitted'});assert.equal(sends,1);
 }finally{await unlink(file).catch(()=>{});await unlink(file+'.claimed').catch(()=>{});}
});
test('uncertain paid request cannot be repeated',async()=>{
 const token=randomUUID(),file=draftFile(token);const schema={prompt:{max:5000}};let sends=0;
 const c={account:'test',page:async()=>({modelOptions:[{id:60,input_schema_json:schema}]}),http:async(path)=>{if(path.endsWith('/price-preview'))return {credits_minor:100};sends++;throw Error('connection lost');}};
 try{await privateJson(file,{account:'test',workflowId:1,modelId:60,prompt:'test',settings:{},references:[],requestId:randomUUID(),createdAt:Date.now(),quote:{credits_minor:100},schemaHash:createHash('sha256').update(JSON.stringify(schema)).digest('hex')});await assert.rejects(submit(c,token,2),{code:'request_uncertain'});await assert.rejects(submit(c,token,2),{code:'already_submitted'});assert.equal(sends,1);}finally{await unlink(file).catch(()=>{});await unlink(file+'.claimed').catch(()=>{});}
});
