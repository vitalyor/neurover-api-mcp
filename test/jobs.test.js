import test from 'node:test';
import assert from 'node:assert/strict';
import {unlink} from 'node:fs/promises';
import {prepareJob,submitJob} from '../src/jobs.js';
import {draftFile} from '../src/generation.js';
test('workflow submit stops when graph changes and cannot send twice',async()=>{
 let version=1,sends=0;const c={account:'test',workflow:async()=>({workflow:{version,graph:{nodes:[],edges:[]}}}),http:async(path)=>path.endsWith('/preview')?{preview:{startable:true,nodes_to_generate:[{workflow_node_id:7,price_quote_id:'q'}],price_summary:{suggested_budget:{credits_minor:200}}}}:(sends++,{run:{id:1}})};
 const d=await prepareJob(c,{workflowId:1,nodeId:7,scope:'target'},'workflow_run');
 try{version=2;await assert.rejects(submitJob(c,d.token,3),{code:'workflow_changed'});assert.equal(sends,0);version=1;await submitJob(c,d.token,3);await assert.rejects(submitJob(c,d.token,3),{code:'already_submitted'});assert.equal(sends,1);}finally{await unlink(draftFile(d.token)).catch(()=>{});await unlink(draftFile(d.token)+'.claimed').catch(()=>{});}
});
test('draft finalization prices, refuses a dearer quote and sends the quote once',async()=>{
 let credits=13875,sends=[];const ep='/workflows/5/generations/9/finalization';
 const c={account:'test',workflow:async()=>{throw Error('no workflow read');},http:async(path,o={})=>{
  if(path===ep&&!o.method)return {generation_id:null};
  if(path===ep+'/price-preview')return {price_quote_id:'q1',status:'pricing'};
  if(path==='/price-quotes/q1')return {price_quote_id:'q1',status:'ready',credits_minor:credits,formatted:'x'};
  if(path===ep&&o.method==='POST'){sends.push(o.data);return {generation_id:77};}
  throw Error('unexpected '+path);}};
 const d=await prepareJob(c,{workflowId:5,generationId:9},'draft_finalization');
 try{assert.equal(d.estimatedCredits,138.75);
  credits=14000;await assert.rejects(submitJob(c,d.token,200),{code:'price_changed'});assert.equal(sends.length,0);
  credits=13875;const r=await submitJob(c,d.token,200);assert.equal(r.generation_id,77);
  assert.deepEqual(Object.keys(sends[0]).sort(),['client_request_id','price_quote_id']);assert.equal(sends[0].price_quote_id,'q1');
 }finally{await unlink(draftFile(d.token)).catch(()=>{});await unlink(draftFile(d.token)+'.claimed').catch(()=>{});}
 const done={...c,http:async()=>({generation_id:77})};
 assert.equal((await prepareJob(done,{workflowId:5,generationId:9},'draft_finalization')).status,'already_finalized');
});
