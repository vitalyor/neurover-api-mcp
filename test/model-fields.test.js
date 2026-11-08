import test from 'node:test';
import assert from 'node:assert/strict';
import {isFileField,fileFields} from '../src/prompt-refs.js';
import {referenceField,settingsFor,userSettable,prepare,messageForm} from '../src/generation.js';

const file=(extra={})=>({type:'file_array',roles:['generic'],default_role:'generic',media_type:'image',media_types:['image'],mime_types:['image/jpeg','image/png','image/webp'],...extra});
// Shaped like the live Midjourney schema (2026-11-03): images up to 4, character (cref) and style (sref) one each.
const midjourney={id:108,display_name:'Midjourney',media_type:'image',input_schema_json:{
 prompt:{key:'prompt',type:'text',min:1,max:1024,required:true},
 version:{key:'version',type:'select',default:'默认',options:['默认','8.2','6.1'],omit_default:true},
 aspect_ratio:{key:'aspect_ratio',type:'select',default:'1:1',options:['1:1','16:9']},
 n:{key:'n',type:'select',default:'1',options:['1','4']},
 legacy_toggle:{key:'legacy_toggle',type:'boolean',default:true,disabled:true},
 images:file({field:'images',max_count:4}),cref:file({field:'cref',max_count:1}),sref:file({field:'sref',max_count:1})}};

test('file fields are recognised like the site does, by type and not by name',()=>{
 assert.equal(isFileField('cref',{type:'file_array'}),true);
 assert.equal(isFileField('anything_new',{type:'file_array'}),true,'a future file field needs no code change');
 assert.equal(isFileField('reference_masks',{type:'array'}),true);
 assert.equal(isFileField('frames',{type:'array',media_types:['image']}),true);
 assert.equal(isFileField('tags',{type:'array'}),false,'a plain array is a setting');
 assert.equal(isFileField('audio_url',{type:'text',media_type:'image'}),false,'Suno audio_url is a text field on the site too');
 assert.deepEqual(fileFields(midjourney.input_schema_json).map(([k])=>k),['images','cref','sref']);
});

test('reference field: standard by default, any named file field on request, never a mismatching kind',()=>{
 assert.equal(referenceField(midjourney,'image'),'images');
 assert.equal(referenceField(midjourney,'image','cref'),'cref');
 assert.equal(referenceField(midjourney,'image','sref'),'sref');
 assert.equal(referenceField(midjourney,'video','cref'),null,'cref accepts images only');
 assert.equal(referenceField(midjourney,'image','version'),null,'a setting is not a file field');
 assert.equal(referenceField(midjourney,'video'),null);
 const onlyCustom={input_schema_json:{prompt:{},style_ref:file()}};
 assert.equal(referenceField(onlyCustom,'image'),'style_ref','falls back to any file field that accepts the kind');
 const untyped={input_schema_json:{source:{type:'file_array'}}};
 assert.equal(referenceField(untyped,'audio'),'source','no declared media kind accepts any kind');
});

test('settings: files, output counts and disabled fields are not user settings',()=>{
 assert.equal(userSettable('version',midjourney.input_schema_json.version),true);
 for(const k of ['prompt','cref','images','n','legacy_toggle'])assert.equal(userSettable(k,midjourney.input_schema_json[k]),false,k);
 assert.throws(()=>settingsFor(midjourney,{cref:'5'}),{code:'invalid_setting'});
 assert.throws(()=>settingsFor(midjourney,{n:'4'}),{code:'invalid_setting'},'agent cannot multiply the cost');
 const defaults=settingsFor(midjourney,{});
 assert.equal(defaults.n,'1','site default for the output count is still sent');
 assert.equal('legacy_toggle' in defaults,false,'disabled fields are not sent');
 assert.equal('version' in defaults,false,'omit_default is respected');
 assert.equal(settingsFor(midjourney,{version:'6.1'}).version,'6.1');
});

function stubClient(){
 const sent=[];const media={11:'hero.png',12:'style.png',13:'scene.png',14:'hero2.png'};
 return {sent,account:'fields-test',
  page:async()=>({modelOptions:[midjourney]}),
  http:async(url,opts={})=>{
   let m;
   if((m=/media-library\/(\d+)\/access$/.exec(url)))return {media:{media_type:'image',mime_type:'image/png',available:true,name:media[m[1]]}};
   if(url.startsWith('/media-library?')){const id=Number(new URLSearchParams(url.split('?')[1]).get('before_id'))-1;return {items:[{id,name:media[id],mime_type:'image/png',size_bytes:4096,width:1024,height:1024}]};}
   if(url.endsWith('/messages/price-preview')){sent.push([...opts.multipart.entries()]);return {status:'ready',credits_minor:350,price_quote_id:'q-1'};}
   throw new Error('unexpected request '+url);
  }};
}

test('Midjourney with character and style references sends the same form as the site',async()=>{
 const c=stubClient();
 const r=await prepare(c,{workflowId:1,modelId:108,prompt:'a knight in the rain',settings:{version:'6.1',n:'4'},references:[{mediaAssetId:13},{mediaAssetId:11,field:'cref'},{mediaAssetId:12,field:'sref'}]});
 assert.equal(r.status,'prepared');
 const form=c.sent[0];const get=k=>form.filter(([key])=>key===k).map(([,v])=>v);
 assert.deepEqual(get('reference_asset_ids[images][]'),['13']);
 assert.deepEqual(get('reference_asset_ids[cref][]'),['11']);
 assert.deepEqual(get('reference_asset_ids[sref][]'),['12']);
 assert.deepEqual(get('reference_asset_roles[cref][]'),['generic']);
 assert.deepEqual(get('settings[version]'),['6.1']);
 assert.deepEqual(get('settings[n]'),['1'],'the requested n=4 was not sent');
 assert.equal(form.some(([k])=>/settings\[(cref|sref|images)\]/.test(k)),false,'files are never sent as settings');
 assert.ok(r.warnings.some(w=>w.code==='SETTING_IGNORED'&&/controlled by the site/.test(w.message)),'the agent is told why n was dropped');
});

test('per-field limits apply to new fields too: two character references are rejected before any price request',async()=>{
 const c=stubClient();
 await assert.rejects(prepare(c,{workflowId:1,modelId:108,prompt:'two heroes',references:[{mediaAssetId:11,field:'cref'},{mediaAssetId:14,field:'cref'}]}),e=>e.code==='invalid_references'&&e.details.problems.some(p=>p.field==='cref'&&p.max===1));
 assert.equal(c.sent.length,0);
});

test('multi_select settings are lists, validated like the site and sent as one JSON field',()=>{
 const model={input_schema_json:{prompt:{type:'text'},mode:{type:'select',default:'reference',options:['reference']},skill_preset:{key:'skill_preset',type:'multi_select',options:['none','wipe','orbit','dolly'],max_items:2,exclusive_options:['none']}}};
 assert.deepEqual(settingsFor(model,{skill_preset:['wipe','orbit']}).skill_preset,['wipe','orbit']);
 assert.deepEqual(settingsFor(model,{skill_preset:'wipe'}).skill_preset,['wipe'],'a single value becomes a list');
 for(const bad of [['wipe','unknown'],['wipe','orbit','dolly'],['none','wipe'],['wipe','wipe']])assert.throws(()=>settingsFor(model,{skill_preset:bad}),{code:'invalid_setting'},String(bad));
 const entries=f=>[...f.entries()];
 const list=entries(messageForm({requestId:'r',modelId:1,prompt:'p',settings:{mode:'reference',skill_preset:['wipe']},references:[]}));
 assert.deepEqual(JSON.parse(list.find(([k])=>k==='settings')[1]),{mode:'reference',skill_preset:['wipe']});
 assert.equal(list.some(([k])=>k.startsWith('settings[')),false);
 const plain=entries(messageForm({requestId:'r',modelId:1,prompt:'p',settings:{mode:'reference',sound:true},references:[]}));
 assert.deepEqual(plain.filter(([k])=>k.startsWith('settings')),[['settings[mode]','reference'],['settings[sound]','1']],'without lists the form stays as before');
});
