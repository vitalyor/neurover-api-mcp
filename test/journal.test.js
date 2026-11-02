import test from 'node:test';
import assert from 'node:assert/strict';
import {recordSubmission,journalFor,orientationWarnings} from '../src/journal.js';

test('journal keeps what was sent and drives the orientation check',async()=>{
  const item={account:'journal-test',workflowId:1001,requestId:'req-1',modelId:64,modelName:'Seedance',prompt:'@image_1 frame',originalPrompt:'@ref_1 frame',settings:{mode:'first-frame',duration:'5'},droppedSettings:[{field:'aspect_ratio',value:'16:9'}],
    referenceTable:[{ref:'@ref_1',tile:'@image_1',mediaAssetId:900003,name:'first.jpg',field:'images',frame:'first_frame'}],expected:{source:'first_frame',ratio:2752/1536,orientation:'landscape',mediaAssetId:900003}};
  await recordSubmission(item,{user_message:{id:2001},assistant_message:{id:2002,generation_request_id:3001}});
  const e=await journalFor('journal-test',1001,2002);assert.equal(e.prompt,'@image_1 frame');assert.equal(e.referenceTable[0].mediaAssetId,900003);assert.equal(e.generationId,3001);
  const w=await orientationWarnings({account:'journal-test'},1001,{id:2002,status:'completed',outputs:[{id:900004,media_type:'video',width:480,height:854}]});
  assert.equal(w[0].code,'ORIENTATION_MISMATCH');assert.equal(w[0].request.requestId,'req-1');assert.equal(w[0].request.references[0].frame,'first_frame');
  assert.deepEqual(await orientationWarnings({account:'journal-test'},1001,{id:2002,outputs:[{id:1,media_type:'video',width:856,height:478}]}),[]);
});
test('a recorded mismatch warns the next preparation of the same model and mode',async()=>{
  const {priorMismatches}=await import('../src/journal.js');
  const hits=await priorMismatches('journal-test',64,'first-frame');
  assert.equal(hits.length,1);assert.deepEqual(hits[0].messageIds,[2001,2002]);assert.equal(hits[0].outputs[0].height,854);
  assert.deepEqual(await priorMismatches('journal-test',64,'reference'),[]);
});
