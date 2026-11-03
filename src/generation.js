import {dataDir} from './paths.js';
import { randomUUID, createHash } from 'node:crypto';
import path from 'node:path';
import { open, mkdir } from 'node:fs/promises';
import { root, privateJson, readJson, ApiError } from './client.js';
import {ensureMedia} from './media.js';
import {mimeFor} from './media-dedup.js';
import {rewritePrompt,applyLinkage,validateReferences,frameRoles,expectedGeometry,firstFrameWarning,isFileField,fileFields} from './prompt-refs.js';
// Prompt and file fields are filled by their own inputs, never as plain settings.
const reserved=(key,spec)=>key==='prompt'||isFileField(key,spec);
// The site never lets users change output counts or disabled fields (they go with their defaults only), so neither does MCP:
// otherwise an agent could multiply the cost of one request.
const SITE_HIDDEN=new Set(['prompt','count','n','max_images','quantity','output_count','numberofruns','sequential_image_generation','sequential_generation','multi_output','multiple_outputs']);
export const userSettable=(key,spec)=>!reserved(key,spec)&&!SITE_HIDDEN.has(String(key).toLowerCase())&&spec?.disabled!==true;
import {recordSubmission,priorMismatches} from './journal.js';
export const charCount = text => Array.from(text).length;
export function settingsFor(model, settings = {}) {
  const schema=model.input_schema_json || {};
  const result={};
  for (const [key, spec] of Object.entries(schema)) if (!reserved(key,spec) && !String(key).startsWith('reference_') && spec.disabled!==true && spec.default !== undefined && spec.omit_default !== true) result[key]=spec.default;
  for (let [key,value] of Object.entries(settings)) {
    const spec=schema[key];
    // Options are often strings ("5"); accept the same value given as a number/boolean.
    if(spec?.options?.length&&typeof value!=='string'&&!spec.options.some(x=>(typeof x==='object'?x.value:x)===value)){const m=spec.options.map(x=>typeof x==='object'?x.value:x).find(x=>String(x)===String(value));if(m!==undefined)value=m;}
    if(!spec || !userSettable(key,spec)) throw new ApiError('invalid_setting',`Unknown, reserved or site-controlled model setting: ${key}`);
    if(spec.options?.length && !spec.options.some(x=>(typeof x==='object'?x.value:x)===value)) throw new ApiError('invalid_setting',`Unsupported value for ${key}.`,{options:spec.options});
    result[key]=value;
  }
  return result;
}
export function validatePrompt(model, prompt) {
  const spec=model.input_schema_json?.prompt || {};
  const count=charCount(prompt);
  if(!prompt.trim() || Number.isFinite(spec.min) && count<spec.min || Number.isFinite(spec.max) && count>spec.max) throw new ApiError('invalid_prompt_length','Prompt exceeds the selected model limits.',{characters:count,min:spec.min,max:spec.max});
  return count;
}
export async function resolveModel(client, workflowId, {model,modelId,type}={}) {
  const page=await client.page(`/workflows/${workflowId}`);
  const models=page.modelOptions || [];
  const matches=models.filter(m => (!type || m.media_type===type) && (modelId ? m.id===modelId : model ? m.display_name===model : m.is_default));
  if(matches.length!==1) throw new ApiError('model_required','Choose an exact model ID or name.',{models:models.filter(m=>!type||m.media_type===type).map(m=>({id:m.id,name:m.display_name,type:m.media_type}))});
  return matches[0];
}
export function referenceRole(spec,kind,requested) {
  const allowed=spec.allowed_roles||spec.roles||[];
  const role=requested||spec.default_role||allowed[0]||{image:'reference_image',video:'reference_video',audio:'reference_audio'}[kind];
  if(!role||allowed.length&&!allowed.includes(role))throw new ApiError('invalid_reference_role','Reference role is not supported by this model.',{allowedRoles:allowed});
  return role;
}
// Any file field of the model may be named explicitly (e.g. Midjourney cref/sref). Without a name, the standard
// images/reference_images (videos, audios) field is used, then any other file field that accepts this media kind.
export function acceptsKind(spec,kind){
  const kinds=[spec?.media_type,...(Array.isArray(spec?.media_types)?spec.media_types:[])].filter(Boolean),mimes=(spec?.mime_types||[]).map(m=>String(m).split('/')[0]);
  return !kind||!kinds.length&&!mimes.length||kinds.includes(kind)||mimes.includes(kind);
}
export function referenceField(model,kind,field) {
  const schema=model.input_schema_json||{},fits=k=>isFileField(k,schema[k])&&acceptsKind(schema[k],kind);
  if(field)return schema[field]&&fits(field)?field:null;
  const plural={image:'images',video:'videos',audio:'audios'}[kind];
  return [plural,'reference_'+plural].find(k=>schema[k]&&fits(k))??fileFields(schema).map(([k])=>k).find(fits)??null;
}
// Chat-style reference upload: the target model/field are resolved first because the media-library route
// (the chat "Загрузить" button) requires them; it creates no canvas node.
export async function ensureLibraryMedia(client,model,{workflowId,filePath,mimeType,kind,referenceField:field}) {
  const localKind=kind||mimeFor(filePath,mimeType)?.split('/')[0];
  const chosen=referenceField(model,localKind,field)||referenceField(model,localKind);
  if(!chosen)throw new ApiError('incompatible_reference','Model has no matching reference field; nothing was uploaded.',{kind:localKind,field});
  return ensureMedia(client,{workflowId,filePath,mimeType,library:{aiModelId:model.id,referenceField:chosen}});
}
// neurover_ensure_media: without an explicit model, use the default (else first) workflow model that accepts this media kind.
export async function ensureReference(client,input) {
  let model;
  if(input.modelId||input.model)model=await resolveModel(client,input.workflowId,input);
  else {
    const kind=mimeFor(input.filePath,input.mimeType)?.split('/')[0];
    const models=((await client.page(`/workflows/${input.workflowId}`)).modelOptions||[]).filter(m=>referenceField(m,kind,input.referenceField));
    model=models.find(m=>m.is_default)||models[0];
    if(!model)throw new ApiError('model_required','No workflow model accepts this reference kind; pass modelId. Nothing was uploaded.',{kind});
  }
  return ensureLibraryMedia(client,model,input);
}
function encode(value) { return typeof value==='boolean' ? value?'1':'0' : typeof value==='object' ? JSON.stringify(value) : String(value); }
export function messageForm(item, quoteId) {
  const form=new FormData();
  form.append('client_request_id',item.requestId);form.append('ai_model_id',String(item.modelId));form.append('body',item.prompt);
  if(quoteId)form.append('price_quote_id',quoteId);
  for(const [k,v] of Object.entries(item.settings)) form.append(`settings[${k}]`,encode(v));
  for(const r of item.references || []) {form.append(`reference_asset_ids[${r.field}][]`,String(r.mediaAssetId));form.append(`reference_asset_roles[${r.field}][]`,r.role || 'reference');}
  return form;
}
export async function quote(client,item) {
  let q=await client.http(`/workflows/${item.workflowId}/messages/price-preview`,{method:'POST',multipart:messageForm(item)});
  const until=Date.now()+30000;
  while(q.status==='pricing' && q.price_quote_id && Date.now()<until) {await new Promise(r=>setTimeout(r,1000));q=await client.http('/price-quotes/'+encodeURIComponent(q.price_quote_id));}
  if(!Number.isSafeInteger(q.credits_minor) || q.credits_minor<0 || q.status==='failed' || q.status==='pricing') throw new ApiError('quote_unavailable','No completed price quote; generation is blocked.',{status:q.status,errorCode:q.error_code});
  return q;
}
// Media metadata for limit checks: access gives availability/MIME; the library page just below the ID gives size/dimensions.
export async function mediaInfo(client,workflowId,mediaAssetId,hint) {
  const {media}=await client.http(`/workflows/${workflowId}/media-library/${mediaAssetId}/access`);
  if(!media||media.available===false)throw new ApiError('reference_unavailable','Reference is unavailable.',{mediaAssetId});
  const kind=media.media_type||hint||media.mime_type?.split('/')[0];
  let item=null;
  try{const r=await client.http('/media-library?'+new URLSearchParams({type:kind,limit:'1',before_id:String(mediaAssetId+1)}));item=r.items?.find(m=>m.id===mediaAssetId)||null;}catch{}
  return {kind,name:item?.name??media.name??null,mimeType:media.mime_type??item?.mime_type??null,sizeBytes:item?.size_bytes??media.size_bytes??null,width:item?.width??null,height:item?.height??null,durationSeconds:item?.duration_seconds??null};
}
// Final prompt + reference table; shared by prepare and submit so both always agree.
export function compose(model,settingsIn,references,prompt,requestedAspect) {
  const {settings,dropped}=applyLinkage(model.input_schema_json,settingsIn);
  const check=validateReferences(model.input_schema_json,settings,references);
  if(check.errors.length)throw new ApiError('invalid_references','References do not fit the model limits; nothing was reserved.',{problems:check.errors});
  const rewritten=rewritePrompt(prompt,references);
  const characters=validatePrompt(model,rewritten.prompt);
  const roles=frameRoles(settings,references);
  const referenceTable=references.map((r,i)=>({ref:`@ref_${i+1}`,promptLabels:rewritten.labelsByIndex[i],tile:'@'+rewritten.tiles[i],mediaAssetId:r.mediaAssetId,name:r.name,field:r.field,role:r.role,frame:roles[i],kind:r.kind,width:r.width,height:r.height,sizeBytes:r.sizeBytes,mimeType:r.mimeType}));
  const expected=expectedGeometry(settings,references,requestedAspect);
  const warnings=[...rewritten.warnings,...check.warnings,...dropped.map(d=>({code:'SETTING_NOT_SENT',message:d.field==='aspect_ratio'?`aspect_ratio=${d.value} is not sent: with ${Object.entries(d.because).map(([k,v])=>k+'='+v).join(', ')} the site hides it and the output shape comes from the first frame.`:`${d.field}=${d.value} is not sent: the site hides it for ${Object.entries(d.because).map(([k,v])=>k+'='+v).join(', ')}.`,field:d.field,value:d.value})),firstFrameWarning(expected)].filter(Boolean);
  return {prompt:rewritten.prompt,characters,settings,dropped,referenceTable,expected,warnings};
}
export async function prepare(client,input) {
  const model=await resolveModel(client,input.workflowId,input);
  const requestedAspect=input.aspectRatio??input.settings?.aspect_ratio;
  // Settings this model does not have (e.g. mode for Kling or Line 42) are dropped with a warning instead of failing.
  const schemaKeys=model.input_schema_json||{};
  const ignored=[];const rawSettings={...input.settings,...(input.mode?{mode:input.mode}:{}),...(input.aspectRatio?{aspect_ratio:input.aspectRatio}:{}),...(input.resolution?{resolution:input.resolution}:{}),...(input.quality?{quality:input.quality}:{}),...(input.durationSeconds?{duration:input.durationSeconds}:{}),...(input.outputFormat?{output_format:input.outputFormat}:{})};
  for(const k of Object.keys(rawSettings))if(!schemaKeys[k]||!userSettable(k,schemaKeys[k])){ignored.push({field:k,value:rawSettings[k]});delete rawSettings[k];}
  const fixups=[];
  const settings=settingsFor(model,rawSettings);
  const references=[];
  for(const ref of input.references || []) {
    if(Boolean(ref.mediaAssetId)===Boolean(ref.filePath))throw new ApiError('reference_required','Provide exactly one mediaAssetId or filePath for each reference.');
    let mediaAssetId=ref.mediaAssetId;
    if(ref.filePath)mediaAssetId=(await ensureLibraryMedia(client,model,{workflowId:input.workflowId,filePath:ref.filePath,kind:ref.kind,referenceField:ref.field})).mediaAssetId;
    const info=await mediaInfo(client,input.workflowId,mediaAssetId,ref.kind);
    const kind=info.kind;
    let field=referenceField(model,kind,ref.field);
    if(!field&&ref.field){field=referenceField(model,kind);if(field)fixups.push({code:'REFERENCE_FIELD_FIXED',message:`Field "${ref.field}" does not exist for this model; using "${field}".`});}
    if(!field) throw new ApiError('incompatible_reference','Model has no matching reference field.',{kind,field:ref.field});
    let role;try{role=referenceRole(model.input_schema_json[field],kind,ref.role);}
    catch(e){if(!ref.role)throw e;role=referenceRole(model.input_schema_json[field],kind);fixups.push({code:'REFERENCE_ROLE_FIXED',message:`Role "${ref.role}" is not allowed for ${field}; using "${role}".`});}
    references.push({mediaAssetId,field,role,...info});
  }
  const c=compose(model,settings,references,input.prompt,requestedAspect);
  for(const x of ignored)c.warnings.push({code:'SETTING_IGNORED',message:schemaKeys[x.field]?`Setting ${x.field} is controlled by the site (file field, output count or disabled) and was not sent; attach files as references.`:`Setting ${x.field}=${JSON.stringify(x.value)} does not exist for ${model.display_name} and was not sent.`});
  c.warnings.push(...fixups);
  if(model.media_type==='video'&&c.settings.mode==='first-frame')c.warnings.push({code:'FIRST_FRAME_VERTICAL',message:'Known issue (01.11.2026): Seedance on Neurover in mode=first-frame returns vertical video regardless of the frame. Use mode=reference with aspect_ratio and say in the prompt that @ref_1 is the first frame.'});
  const prior=await priorMismatches(client.account,model.id,c.settings.mode).catch(()=>[]);
  if(prior.length)c.warnings.push({code:'PREVIOUS_ORIENTATION_MISMATCH',message:`Earlier runs of this model with mode=${c.settings.mode??'—'} returned the wrong orientation (${prior.length}×). The request matches the site's; this looks provider-side. Consider another mode/model before paying.`,runs:prior.slice(-5)});
  const item={account:client.account,workflowId:input.workflowId,modelId:model.id,modelName:model.display_name,type:model.media_type,prompt:c.prompt,originalPrompt:input.prompt,requestedAspect:requestedAspect??null,settings:c.settings,droppedSettings:c.dropped,references,referenceTable:c.referenceTable,expected:c.expected,warnings:c.warnings,requestId:randomUUID(),createdAt:Date.now(),schemaHash:createHash('sha256').update(JSON.stringify(model.input_schema_json)).digest('hex')};
  item.quote=await quote(client,item);const token=randomUUID();
  await privateJson(path.join(dataDir,'drafts',token+'.json'),item);
  return {status:'prepared',token,account:client.account,workflowId:input.workflowId,modelId:model.id,model:model.display_name,promptLimit:model.input_schema_json?.prompt?.max??null,...draftReport(item)};
}
// What exactly will be sent (also shown by neurover_draft_view).
export function draftReport(item) {
  return {finalPrompt:item.prompt,characters:charCount(item.prompt),promptChanged:item.originalPrompt!==undefined&&item.originalPrompt!==item.prompt,references:item.referenceTable??item.references,settings:item.settings,settingsNotSent:item.droppedSettings??[],aspectRatioSent:item.settings?.aspect_ratio??null,expectedOutput:item.expected??null,warnings:item.warnings??[],estimatedCredits:item.quote?item.quote.credits_minor/100:undefined,creditsMinor:item.quote?.credits_minor,quote:item.quote,transport:'http'};
}
export function validateBudget(minor,maxCredits) {
  const maxMinor=Math.floor(maxCredits*100+1e-7);
  if(!Number.isSafeInteger(minor) || minor<0 || !Number.isFinite(maxCredits) || maxMinor<minor) throw new ApiError('over_limit','Generation was not started.',{estimatedCredits:minor/100,maxCredits});
  return maxMinor;
}
export function draftFile(token) {
  if(!/^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/i.test(token))throw new ApiError('invalid_token','Invalid preparation token.');
  return path.join(dataDir,'drafts',token+'.json');
}
export async function loadDraft(token) {try{return await readJson(draftFile(token));}catch(e){if(e.code==='ENOENT')throw new ApiError('preparation_missing','Prepare the generation first.');throw e;}}
export async function submit(client,token,maxCredits) {
  const item=await loadDraft(token);
  if(item.account!==client.account) throw new ApiError('account_mismatch','Wrong account for preparation.');
  if(Date.now()-item.createdAt>600000)throw new ApiError('estimate_expired','Prepare again.');
  const claim=draftFile(token)+'.claimed';
  const {access}=await import('node:fs/promises');
  try{await access(claim);throw new ApiError('already_submitted','This preparation has already been submitted or has an uncertain result. Do not retry it.');}catch(e){if(e.code!=='ENOENT')throw e;}
  const currentModel=await resolveModel(client,item.workflowId,{modelId:item.modelId});
  if(createHash('sha256').update(JSON.stringify(currentModel.input_schema_json)).digest('hex')!==item.schemaHash)throw new ApiError('model_changed','Model settings changed. Prepare again.');
  // Recompute labels/settings from the original prompt against the current model; any drift blocks the paid request.
  if(item.originalPrompt!==undefined) {
    const again=compose(currentModel,{...item.settings,...Object.fromEntries((item.droppedSettings||[]).map(d=>[d.field,d.value]))},item.references,item.originalPrompt,item.requestedAspect);
    if(again.prompt!==item.prompt||JSON.stringify(again.settings)!==JSON.stringify(item.settings))throw new ApiError('model_changed','Reference labels or settings would change. Prepare again.');
  }
  const current=await quote(client,item);validateBudget(current.credits_minor,maxCredits);
  if(current.credits_minor>item.quote.credits_minor)throw new ApiError('price_changed','The estimate increased. Prepare again.',{estimatedCredits:current.credits_minor/100});
  await mkdir(path.dirname(claim),{recursive:true,mode:0o700});
  try {const fd=await open(claim,'wx',0o600);await fd.writeFile(JSON.stringify({status:'submitting',requestId:item.requestId,at:Date.now()}));await fd.close();}
  catch(e){if(e.code==='EEXIST')throw new ApiError('already_submitted','This preparation was already submitted.');throw e;}
  try {
    const result=await client.http(`/workflows/${item.workflowId}/messages`,{method:'POST',multipart:messageForm(item,current.price_quote_id)});
    await privateJson(claim,{status:'submitted',requestId:item.requestId,result});
    try{await recordSubmission(item,result);}catch{}
    return {status:'submitted',account:item.account,workflowId:item.workflowId,requestId:item.requestId,estimatedCredits:current.credits_minor/100,...result};
  }catch(e){await privateJson(claim,{status:'request_uncertain',requestId:item.requestId,at:Date.now()});throw new ApiError('request_uncertain','Submission was attempted once. Inspect messages using requestId; do not retry this token.',{requestId:item.requestId,cause:e.code});}
}
