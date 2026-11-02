import test from 'node:test';
import assert from 'node:assert/strict';
import {generationSummary,submissionSummary} from '../src/summaries.js';
test('compact status keeps error, refund and IDs but omits prompt and signed URLs',()=>{
  const raw={id:700002,role:'assistant',status:'failed',generation_request_id:700001,input:{prompt:'long prompt '.repeat(500)},error_code:'generation_failed',error_message:'Provider failed',final_price:{credits_minor:0},generation:{settlement_status:'refunded',moderation_status:'pending',prompt:'long prompt '.repeat(500)},outputs:[{id:1,mime_type:'image/png',download_url:'https://private?signature=secret'}]};
  const r=generationSummary(raw);assert.equal(r.generationFailed,true);assert.equal(r.finalCredits,0);assert.equal(r.settlementStatus,'refunded');assert.equal(r.error_code,'generation_failed');assert.equal(r.messageId,700002);assert.equal(r.generationId,700001);assert.equal(r.outputs[0].id,1);
  const encoded=JSON.stringify(r);assert.ok(!encoded.includes('long prompt'));assert.ok(!encoded.includes('signature'));assert.ok(encoded.length<JSON.stringify(raw).length/10);
});
test('submission summary preserves the assistant selector for later status checks',()=>{
  const r=submissionSummary({status:'submitted',requestId:'req',workflowId:7,user_message:{id:1,body:'long prompt'},assistant_message:{id:2,role:'assistant',status:'queued',generation_request_id:3,input:{prompt:'long prompt'}}});
  assert.equal(r.assistant_message.id,2);assert.equal(r.assistant_message.generationId,3);assert.equal(r.requestId,'req');assert.ok(!JSON.stringify(r).includes('long prompt'));
});

import {referenceRole} from '../src/generation.js';
test('reference role follows the live model schema rather than a generic hard-coded value',()=>{
 assert.equal(referenceRole({default_role:'generic',allowed_roles:['generic']},'image'),'generic');
 assert.equal(referenceRole({allowed_roles:['first_frame','last_frame']},'image','last_frame'),'last_frame');
 assert.throws(()=>referenceRole({allowed_roles:['generic']},'image','reference'),{code:'invalid_reference_role'});
});
