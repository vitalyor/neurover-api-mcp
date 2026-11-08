import test from 'node:test';
import assert from 'node:assert/strict';
import {autoResolve,rewritePrompt,applyLinkage,validateReferences,expectedGeometry,firstFrameWarning,checkOrientation,tileNames} from '../src/prompt-refs.js';
import {compose,messageForm} from '../src/generation.js';
import {expectedFromServer} from '../src/journal.js';

// Shape of "Линия 18 / Seedance 2.5" (model 64) as served on 2026-11-01, trimmed to what matters.
const hide=(f,v)=>({action:'hide',target_field:f,controller_field:'mode',controller_value:v});
const rules={version:1,rules:[hide('aspect_ratio','first-frame'),hide('aspect_ratio','first-last'),hide('draft','first-frame'),hide('draft','first-last')]};
const constraints={version:1,auto_resolve_fields:[],scenarios:[
  {when:{mode:'first-frame'},reference_counts:{images:{min:1,max:30},videos:{min:0,max:0},audios:{min:0,max:0}}},
  {when:{mode:'first-last'},reference_counts:{images:{min:2,max:2},videos:{min:0,max:0},audios:{min:0,max:0}}},
  {when:{mode:'reference'},reference_counts:{images:{min:0,max:9},videos:{min:0,max:3},audios:{min:0,max:3}}}]};
const seedance={id:64,input_schema_json:{
  prompt:{max:4000},
  mode:{type:'select',default:'first-frame',options:['text-to-video','first-frame','reference','first-last'],linkage_rules:rules,input_constraints:constraints},
  draft:{type:'boolean',linkage_rules:rules},
  aspect_ratio:{type:'select',default:'16:9',options:['16:9','9:16','1:1'],linkage_rules:rules},
  images:{type:'file_array',media_type:'image',max_count:30,mime_types:['image/jpeg','image/png','image/webp'],max_size_kb:5120,max_size_bytes:5242880,min_side_pixels:300,max_side_pixels:6000,min_aspect_ratio:'0.4',max_aspect_ratio:'2.5',roles:['generic'],default_role:'generic'},
  videos:{type:'file_array',media_type:'video',max_count:10,roles:['generic']}}};
const img=(id,name,w=2752,h=1536,extra={})=>({mediaAssetId:id,kind:'image',field:'images',role:'generic',name,mimeType:'image/jpeg',sizeBytes:1547622,width:w,height:h,...extra});
const frame=img(900003,'first.jpg'),suit=img(900001,'subject.jpg',2560,1707),mask=img(900002,'mask.jpg',1024,1024);

test('tile names follow the site composer: per media type, in attach order',()=>{
  assert.deepEqual(tileNames([frame,{kind:'video'},suit,{kind:'audio'},mask]),['image_1','video_1','image_2','audio_1','image_3']);
});
test('@ref_K is replaced by the K-th reference tile, across media types',()=>{
  const r=rewritePrompt('Start on @ref_1, motion from @ref_2, outfit @ref_3; again @ref_1.',[frame,{mediaAssetId:9,kind:'video'},suit]);
  assert.equal(r.prompt,'Start on @image_1, motion from @video_1, outfit @image_2; again @image_1.');assert.deepEqual(r.warnings,[]);
});
test('a label without a reference is an error before any reservation',()=>{
  assert.throws(()=>rewritePrompt('@ref_1 and @ref_4',[frame,suit,mask]),{code:'unknown_reference_label'});
  assert.throws(()=>rewritePrompt('@image_1 @image_2 @image_3 @image_4',[frame,suit,mask]),{code:'unknown_reference_label'});
});
test('legacy @image_4..6 are renumbered by reference order with a warning',()=>{
  const r=rewritePrompt('@image_4 first frame, @image_5 outfit, @image_6 mask, @image_4 again',[frame,suit,mask]);
  assert.equal(r.prompt,'@image_1 first frame, @image_2 outfit, @image_3 mask, @image_1 again');
  assert.equal(r.warnings[0].code,'LEGACY_LABELS_RENUMBERED');assert.deepEqual(r.warnings[0].mapping,{'@image_4':'@image_1','@image_5':'@image_2','@image_6':'@image_3'});
});
test('old prompts already using @image_1..N keep working without warnings',()=>{
  const r=rewritePrompt('@image_1 then @image_2 and @image_3',[frame,suit,mask]);assert.equal(r.prompt,'@image_1 then @image_2 and @image_3');assert.deepEqual(r.warnings,[]);
});
test('mixing @ref_K and @image_N is rejected; e-mails are not labels',()=>{
  assert.throws(()=>rewritePrompt('@ref_1 and @image_2',[frame,suit]),{code:'mixed_reference_labels'});
  assert.equal(rewritePrompt('mail me@image_1.com',[frame]).prompt,'mail me@image_1.com');
});
test('an attached but unmentioned reference produces a warning',()=>{
  const r=rewritePrompt('Only @ref_1 matters',[frame,suit]);assert.equal(r.warnings[0].code,'REFERENCE_NOT_MENTIONED');assert.equal(r.warnings[0].index,2);
});
test('first-frame mode drops aspect_ratio and draft like the site composer',()=>{
  const r=applyLinkage(seedance.input_schema_json,{mode:'first-frame',draft:false,duration:'5',resolution:'480p',aspect_ratio:'16:9'});
  assert.deepEqual(r.settings,{mode:'first-frame',duration:'5',resolution:'480p'});assert.deepEqual(r.dropped.map(d=>d.field).sort(),['aspect_ratio','draft']);
  assert.deepEqual(applyLinkage(seedance.input_schema_json,{mode:'reference',aspect_ratio:'16:9'}).settings,{mode:'reference',aspect_ratio:'16:9'});
});
test('mode reference counts, size, MIME and pixel limits are checked',()=>{
  assert.equal(validateReferences(seedance.input_schema_json,{mode:'first-frame'},[]).errors[0].code,'REFERENCE_COUNT');
  assert.equal(validateReferences(seedance.input_schema_json,{mode:'first-last'},[frame]).errors[0].code,'REFERENCE_COUNT');
  assert.equal(validateReferences(seedance.input_schema_json,{mode:'first-last'},[frame,suit]).errors.length,0);
  const big=img(1,'big.jpg',2000,1000,{sizeBytes:6*1024*1024}),gif=img(2,'a.gif',800,800,{mimeType:'image/gif'}),tiny=img(3,'t.jpg',200,200),wide=img(4,'w.jpg',3000,1000);
  assert.deepEqual(validateReferences(seedance.input_schema_json,{mode:'first-frame'},[big,gif,tiny,wide]).errors.map(e=>e.code),['REFERENCE_TOO_LARGE','REFERENCE_MIME','REFERENCE_DIMENSIONS','REFERENCE_DIMENSIONS']);
  assert.equal(validateReferences(seedance.input_schema_json,{mode:'first-frame'},[frame,suit,mask]).warnings[0].code,'FIRST_FRAME_EXTRA_IMAGES');
});
test('first frame decides the expected shape; a conflicting aspect_ratio is flagged',()=>{
  const e=expectedGeometry({mode:'first-frame'},[frame],'16:9');assert.equal(e.orientation,'landscape');assert.equal(firstFrameWarning(e),null);
  const v=expectedGeometry({mode:'first-frame'},[img(5,'v.jpg',1080,1920)],'16:9');assert.equal(firstFrameWarning(v).code,'FIRST_FRAME_ORIENTATION');
  assert.equal(expectedGeometry({mode:'reference',aspect_ratio:'16:9'},[frame]).source,'aspect_ratio');
});
test('480×854 for a landscape request is reported as ORIENTATION_MISMATCH with request data',()=>{
  const e=expectedGeometry({mode:'first-frame'},[frame]);
  const w=checkOrientation(e,[{id:900004,media_type:'video',width:480,height:854}],{messageId:2002});
  assert.equal(w[0].code,'ORIENTATION_MISMATCH');assert.equal(w[0].request.messageId,2002);
  assert.deepEqual(checkOrientation(e,[{id:1,media_type:'video',width:856,height:478}],{}),[]);
  assert.deepEqual(checkOrientation(expectedFromServer({input:{settings:{mode:'reference',aspect_ratio:'16:9'}}}),[{id:2,media_type:'video',width:854,height:480}],{}),[]);
  assert.equal(expectedFromServer({input:{settings:{mode:'first-frame',aspect_ratio:'16:9'}}}),null);
});
test('compose: final prompt, table and sent settings match; invalid input reserves nothing',()=>{
  const c=compose(seedance,{mode:'first-frame',draft:false,duration:'5',resolution:'480p',aspect_ratio:'16:9'},[frame,suit,mask],'@ref_1 frame, @ref_2 suit, @ref_3 mask','16:9');
  assert.equal(c.prompt,'@image_1 frame, @image_2 suit, @image_3 mask');
  assert.deepEqual(c.referenceTable.map(r=>[r.ref,r.tile,r.mediaAssetId,r.name,r.field,r.frame]),[['@ref_1','@image_1',900003,'first.jpg','images','first_frame'],['@ref_2','@image_2',900001,'subject.jpg','images',null],['@ref_3','@image_3',900002,'mask.jpg','images',null]]);
  assert.equal('aspect_ratio' in c.settings,false);assert.ok(c.warnings.some(w=>w.code==='SETTING_NOT_SENT'&&w.field==='aspect_ratio'));
  const form=messageForm({requestId:'r',modelId:64,prompt:c.prompt,settings:c.settings,references:[frame,suit,mask]});
  assert.equal(form.get('body'),c.prompt);assert.equal(form.get('settings[aspect_ratio]'),null);assert.deepEqual(form.getAll('reference_asset_ids[images][]'),['900003','900001','900002']);
  assert.throws(()=>compose(seedance,{mode:'first-frame'},[frame],'@ref_2','16:9'),{code:'unknown_reference_label'});
  assert.throws(()=>compose(seedance,{mode:'first-frame'},[],'text only'),{code:'invalid_references'});
});

test('mode follows the references like the site composer, unless the user chose it',()=>{
  const c={version:1,auto_resolve_fields:['mode'],scenarios:[
    {when:{mode:'text-to-image'},reference_counts:{images:{min:0,max:0}}},
    {when:{mode:'image-edit'},reference_counts:{images:{min:1,max:1}}},
    {when:{mode:'multi-reference'},reference_counts:{images:{min:2,max:14}}}]};
  const schema={mode:{type:'select',default:'text-to-image',options:['text-to-image','image-edit','multi-reference'],input_constraints:c},images:{type:'file_array'}};
  const refs=n=>Array.from({length:n},()=>({field:'images'})),base={mode:'text-to-image'};
  assert.deepEqual(autoResolve(schema,base,{},refs(0)),{mode:'text-to-image'});
  assert.deepEqual(autoResolve(schema,base,{},refs(1)),{mode:'image-edit'});
  assert.deepEqual(autoResolve(schema,base,{},refs(3)),{mode:'multi-reference'});
  assert.deepEqual(autoResolve(schema,base,{mode:'text-to-image'},refs(1)),{},'an explicit choice is never overridden');
  assert.deepEqual(autoResolve(schema,base,{},refs(15)),{},'no fitting mode: left for validation to explain');
  // Several fit: the default wins, as on the site (Midjourney with images stays text-to-image).
  const open={...schema,mode:{...schema.mode,input_constraints:{...c,scenarios:[{when:{mode:'text-to-image'},reference_counts:{images:{min:0,max:4}}},{when:{mode:'multi-reference'},reference_counts:{images:{min:2,max:4}}}]}}};
  assert.deepEqual(autoResolve(open,base,{},refs(2)),{mode:'text-to-image'});
  assert.deepEqual(autoResolve({prompt:{}},{}, {},refs(1)),{},'models without constraints are untouched');
  assert.throws(()=>compose({id:1,input_schema_json:{...schema,prompt:{max:100}}},{mode:'text-to-image'},[{field:'images',kind:'image',mediaAssetId:1}],'x'),e=>e.details.fittingChoices[0].mode==='image-edit');
});
