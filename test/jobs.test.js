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
