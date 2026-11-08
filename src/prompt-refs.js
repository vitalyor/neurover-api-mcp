// Prompt reference labels, settings linkage, reference limits and output orientation.
// Pure helpers (no I/O) so prepare/submit/history share one interpretation; see docs/API-CONTRACTS.md "Prompt references".
import {ApiError} from './errors.js';

const KINDS=['image','video','audio'];
const LABEL=/(?<![\w.@])@(ref|image|video|audio)_(\d+)\b/g;

// Site tile names: the chat composer numbers attachments per media type (image_1, image_2, video_1 …) in attach order.
// A freshly loaded composer starts at 1, so the canonical tile of the K-th reference is its ordinal among same-kind references.
export function tileNames(references) {
  const seen={image:0,video:0,audio:0};
  return references.map(r=>`${r.kind}_${++seen[r.kind]}`);
}

// Rewrites @ref_K (K = 1-based index in references) to the tile name the server/model expects.
// Legacy @image_N/@video_N/@audio_N labels are renumbered per kind in ascending N order and reported as a warning.
export function rewritePrompt(prompt,references) {
  const tiles=tileNames(references),warnings=[];
  const found=[...prompt.matchAll(LABEL)].map(m=>({text:m[0],type:m[1],n:Number(m[2])}));
  const neutral=found.filter(f=>f.type==='ref'),legacy=found.filter(f=>f.type!=='ref');
  if(neutral.length&&legacy.length)throw new ApiError('mixed_reference_labels','Use either @ref_K or legacy @image_N labels in one prompt, not both. Nothing was reserved.',{neutral:[...new Set(neutral.map(f=>f.text))],legacy:[...new Set(legacy.map(f=>f.text))]});
  const map=new Map();
  if(neutral.length) {
    const missing=[...new Set(neutral.filter(f=>f.n<1||f.n>references.length).map(f=>f.text))];
    if(missing.length)throw new ApiError('unknown_reference_label','The prompt mentions a reference that is not attached. Nothing was reserved.',{labels:missing,attached:references.length});
    for(const f of neutral)map.set(f.text,'@'+tiles[f.n-1]);
  } else if(legacy.length) {
    for(const kind of KINDS) {
      const numbers=[...new Set(legacy.filter(f=>f.type===kind).map(f=>f.n))].sort((a,b)=>a-b);
      const indexes=references.map((r,i)=>r.kind===kind?i:-1).filter(i=>i>=0);
      if(numbers.length>indexes.length)throw new ApiError('unknown_reference_label',`The prompt mentions ${numbers.length} ${kind} label(s) but only ${indexes.length} ${kind} reference(s) are attached. Nothing was reserved.`,{labels:numbers.map(n=>`@${kind}_${n}`),attached:indexes.length});
      // Exact 1..N already matches the tiles: keep it; otherwise renumber by ascending label order.
      numbers.forEach((n,j)=>map.set(`@${kind}_${n}`,'@'+tiles[indexes[j]]));
    }
    const changed=[...map].filter(([a,b])=>a!==b);
    if(changed.length)warnings.push({code:'LEGACY_LABELS_RENUMBERED',message:'Legacy @image_N labels were renumbered by reference order. Prefer @ref_K.',mapping:Object.fromEntries(changed)});
  }
  const finalPrompt=prompt.replace(LABEL,t=>map.get(t)??t);
  const usedTiles=new Set([...finalPrompt.matchAll(LABEL)].map(m=>`${m[1]}_${m[2]}`));
  const labelsByIndex=references.map((_,i)=>[...map].filter(([,b])=>b==='@'+tiles[i]).map(([a])=>a));
  references.forEach((r,i)=>{if(!usedTiles.has(tiles[i]))warnings.push({code:'REFERENCE_NOT_MENTIONED',message:`Reference ${i+1} (@ref_${i+1} → @${tiles[i]}, ${r.name||'#'+r.mediaAssetId}) is attached but not mentioned in the prompt.`,index:i+1,mediaAssetId:r.mediaAssetId});});
  return {prompt:finalPrompt,tiles,labelsByIndex,warnings,style:neutral.length?'ref':legacy.length?'legacy':'none'};
}

const rulesOf=schema=>{const seen=new Map();for(const spec of Object.values(schema||{}))for(const r of spec?.linkage_rules?.rules||[])seen.set(JSON.stringify(r),r);return [...seen.values()];};
const str=v=>typeof v==='boolean'?String(v):v===undefined||v===null?'':String(v);
// Mirrors the site composer: fields hidden by linkage rules for the current values are not sent.
export function applyLinkage(schema,settings) {
  const values={...settings},dropped=[];
  for(const r of rulesOf(schema)) {
    if(r.action!=='hide'||!(r.target_field in values))continue;
    if(str(values[r.controller_field])===str(r.controller_value)){dropped.push({field:r.target_field,value:values[r.target_field],because:{[r.controller_field]:r.controller_value}});delete values[r.target_field];}
  }
  return {settings:values,dropped};
}

// Same rule as the site's chat composer: any file_array, or an array that is a reference_* or declares media types.
// Field names are not hardcoded, so new file fields (Midjourney cref/sref, future ones) work without code changes.
export const isFileField=(key,spec)=>{const t=String(spec?.type??'');return t==='file_array'||t==='array'&&(String(key).startsWith('reference_')||spec.media_type!==undefined||Array.isArray(spec.media_types));};
export const fileFields=schema=>Object.entries(schema||{}).filter(([k,s])=>isFileField(k,s));
function scenarioCounts(schema,settings) {
  const c=Object.values(schema||{}).find(s=>s?.input_constraints)?.input_constraints;
  const hit=(c?.scenarios||[]).find(s=>Object.entries(s.when||{}).every(([k,v])=>str(settings[k])===str(v)));
  return hit?.reference_counts||{};
}
// The site composer's rule: fields in auto_resolve_fields (usually mode) follow from the attached references unless the user chose them.
// One fitting scenario wins; several: the model's default among them; none or unclear: nothing changes and validateReferences explains why.
export function autoResolve(schema,settings,chosen,references) {
  const fields=constraintsOf(schema)?.auto_resolve_fields||[];
  if(!fields.length||fields.every(k=>k in chosen||schema[k]?.options?.length===1))return {};
  const list=fittingChoices(schema,settings,references);
  return list.length===1?list[0]:list.find(p=>fields.every(k=>schema[k]?.default!==undefined&&str(schema[k].default)===str(p[k])))||{};
}
const constraintsOf=schema=>Object.values(schema||{}).find(s=>s?.input_constraints)?.input_constraints;
// Values of the auto-resolved fields (e.g. {mode:'image-edit'}) that accept these references.
export function fittingChoices(schema,settings,references) {
  const c=constraintsOf(schema),fields=c?.auto_resolve_fields||[];
  if(!fields.length||!c.scenarios?.length)return [];
  const counts={};for(const r of references)counts[r.field]=(counts[r.field]||0)+1;
  const combos=Object.values(schema).map(s=>s?.allowed_combinations).find(x=>Array.isArray(x)&&x.length);
  const value=(from,k)=>str(from[k]??schema[k]?.default);
  const fits=s=>{const limits=Object.entries(s.reference_counts||{}),total=limits.reduce((n,[f])=>n+(counts[f]||0),0);return limits.every(([f,l])=>(counts[f]||0)>=Number(l.min)&&(counts[f]||0)<=Number(l.max))&&!(total<s.min_total_count)&&!(total>s.max_total_count);};
  const found=new Map();
  for(const s of c.scenarios){
    if(!fits(s)||!fields.every(k=>s.when?.[k]!==undefined)||!Object.entries(s.when).every(([k,v])=>fields.includes(k)||value(settings,k)===str(v)))continue;
    const pick=Object.fromEntries(fields.map(k=>[k,s.when[k]])),merged={...settings,...pick};
    if(!combos||combos.some(x=>Object.entries(x).every(([k,v])=>value(merged,k)===str(v))))found.set(JSON.stringify(pick),pick);
  }
  return [...found.values()];
}
const ratio=v=>{if(v===undefined||v===null||v==='')return null;const s=String(v);if(s.includes(':')){const [a,b]=s.split(':').map(Number);return a>0&&b>0?a/b:null;}const n=Number(s);return n>0?n:null;};
export function orientation(w,h){if(!(w>0&&h>0))return null;const r=w/h;return r>1.05?'landscape':r<0.95?'portrait':'square';}

// Frame roles: in first-frame / first-last modes the provider takes frames from the image field in upload order.
export function frameRoles(settings,references) {
  const mode=str(settings.mode),images=references.map((r,i)=>r.kind==='image'?i:-1).filter(i=>i>=0),roles=references.map(()=>null);
  if(mode==='first-frame'&&images.length)roles[images[0]]='first_frame';
  if(mode==='first-last'){if(images[0]!==undefined)roles[images[0]]='first_frame';if(images[1]!==undefined)roles[images[1]]='last_frame';}
  return roles;
}

// Validation before any reservation. errors block preparation; warnings are returned to the caller.
export function validateReferences(schema,settings,references) {
  const errors=[],warnings=[],counts=scenarioCounts(schema,settings),byField={};
  for(const r of references)(byField[r.field]??=[]).push(r);
  for(const [field,spec] of fileFields(schema)) {
    const n=(byField[field]||[]).length,lim=counts[field]||{};
    const min=Math.max(Number(spec.min_count)||0,Number(lim.min)||0),maxes=[spec.max_count,lim.max].filter(x=>Number.isFinite(Number(x))&&x!==null&&x!==undefined).map(Number),max=maxes.length?Math.min(...maxes):null;
    if(n<min)errors.push({code:'REFERENCE_COUNT',field,attached:n,min,max,message:`${field}: at least ${min} file(s) required for the selected settings, attached ${n}.`});
    if(max!==null&&n>max)errors.push({code:'REFERENCE_COUNT',field,attached:n,min,max,message:`${field}: at most ${max} file(s) allowed for the selected settings, attached ${n}.`});
  }
  references.forEach((r,i)=>{
    const spec=schema?.[r.field]||{},label=`reference ${i+1} (${r.name||'#'+r.mediaAssetId})`;
    const maxBytes=Number(spec.max_size_bytes)||(Number(spec.max_size_kb)?Number(spec.max_size_kb)*1024:null);
    if(maxBytes&&r.sizeBytes>maxBytes)errors.push({code:'REFERENCE_TOO_LARGE',index:i+1,bytes:r.sizeBytes,maxBytes,message:`${label} is ${r.sizeBytes} bytes; ${r.field} allows ${maxBytes}.`});
    if(Array.isArray(spec.mime_types)&&spec.mime_types.length&&r.mimeType&&!spec.mime_types.includes(r.mimeType))errors.push({code:'REFERENCE_MIME',index:i+1,mimeType:r.mimeType,allowed:spec.mime_types,message:`${label} is ${r.mimeType}; ${r.field} accepts ${spec.mime_types.join(', ')}.`});
    if(r.width>0&&r.height>0) {
      const lo=Math.min(r.width,r.height),hi=Math.max(r.width,r.height),ar=r.width/r.height;
      if(Number(spec.min_side_pixels)&&lo<Number(spec.min_side_pixels))errors.push({code:'REFERENCE_DIMENSIONS',index:i+1,message:`${label} short side ${lo}px < ${spec.min_side_pixels}px.`});
      if(Number(spec.max_side_pixels)&&hi>Number(spec.max_side_pixels))errors.push({code:'REFERENCE_DIMENSIONS',index:i+1,message:`${label} long side ${hi}px > ${spec.max_side_pixels}px.`});
      const minAr=ratio(spec.min_aspect_ratio),maxAr=ratio(spec.max_aspect_ratio);
      if(minAr&&ar<minAr-1e-6||maxAr&&ar>maxAr+1e-6)errors.push({code:'REFERENCE_DIMENSIONS',index:i+1,message:`${label} aspect ratio ${ar.toFixed(2)} outside ${spec.min_aspect_ratio}–${spec.max_aspect_ratio}.`});
    }
    if(r.durationSeconds>0) {
      if(Number(spec.min_duration_seconds)&&r.durationSeconds<Number(spec.min_duration_seconds)||Number(spec.max_duration_seconds)&&r.durationSeconds>Number(spec.max_duration_seconds))errors.push({code:'REFERENCE_DURATION',index:i+1,message:`${label} duration ${r.durationSeconds}s outside ${spec.min_duration_seconds??0}–${spec.max_duration_seconds??'∞'}s.`});
    }
  });
  const mode=str(settings.mode),images=references.filter(r=>r.kind==='image');
  if(mode==='first-frame'&&images.length>1)warnings.push({code:'FIRST_FRAME_EXTRA_IMAGES',message:`Mode first-frame: image 1 (${images[0].name||'#'+images[0].mediaAssetId}) becomes the first frame; the other ${images.length-1} image(s) are sent as additional images.`});
  if(mode==='first-last'&&images.length>2)warnings.push({code:'FIRST_LAST_EXTRA_IMAGES',message:'Mode first-last: images 1 and 2 become the first and last frames; the rest are sent as additional images.'});
  return {errors,warnings};
}

// Expected output geometry: explicit aspect_ratio, or the first frame when the mode derives it from the image.
export function expectedGeometry(settings,references,requestedAspect) {
  const roles=frameRoles(settings,references),first=references[roles.indexOf('first_frame')];
  if(first&&first.width>0&&first.height>0)return {source:'first_frame',mediaAssetId:first.mediaAssetId,ratio:first.width/first.height,orientation:orientation(first.width,first.height),requestedAspectRatio:requestedAspect??null};
  const ar=ratio(settings.aspect_ratio??settings.ratio);
  if(ar)return {source:'aspect_ratio',aspectRatio:String(settings.aspect_ratio??settings.ratio),ratio:ar,orientation:ar>1.05?'landscape':ar<0.95?'portrait':'square'};
  return null;
}
export function firstFrameWarning(expected) {
  if(expected?.source!=='first_frame'||!expected.requestedAspectRatio)return null;
  const want=ratio(expected.requestedAspectRatio);if(!want)return null;
  const o=want>1.05?'landscape':want<0.95?'portrait':'square';
  return o===expected.orientation?null:{code:'FIRST_FRAME_ORIENTATION',message:`Requested ${expected.requestedAspectRatio} (${o}) but the first frame is ${expected.orientation}; in this mode the frame decides the output shape.`};
}

// Compare a finished output with the expected geometry.
export function checkOrientation(expected,outputs,request) {
  if(!expected)return [];
  const out=(outputs||[]).filter(o=>o.width>0&&o.height>0&&['image','video'].includes(o.media_type||o.type||String(o.mime_type||o.mimeType||'').split('/')[0]));
  return out.flatMap(o=>{
    const actual=o.width/o.height,orient=orientation(o.width,o.height);
    if(orient===expected.orientation&&Math.abs(actual-expected.ratio)/expected.ratio<0.12)return [];
    return [{code:'ORIENTATION_MISMATCH',message:`Output ${o.id} is ${o.width}×${o.height} (${orient}); expected ${expected.orientation}${expected.aspectRatio?' '+expected.aspectRatio:''} from ${expected.source}.`,outputId:o.id,actual:{width:o.width,height:o.height,orientation:orient},expected,request}];
  });
}
