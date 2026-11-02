import {readFile,writeFile,mkdir} from 'node:fs/promises';
import path from 'node:path';
import {authenticatedRead,ApiError} from './client.js';
export async function thumbnail(c,g,dir){
 const m=g.items.find(x=>x.id===g.keepId)||g.items[0],file=path.join(dir,`thumbnail-${m.id}.json`);
 try{return JSON.parse(await readFile(file,'utf8')).data;}catch{}
 if(!m.thumbnail_url&&!m.poster_url)return null;
 const u=new URL(m.thumbnail_url||m.poster_url,'https://neurover.io');if(u.origin!=='https://neurover.io'||!/^\/media-assets\/\d+\/(thumbnail|poster)$/.test(u.pathname))return null;
 try{const r=await authenticatedRead(c,async()=>{
 const state=await c.context.storageState();const cookie=state.cookies.filter(x=>x.domain.replace(/^\./,'')==='neurover.io').map(x=>x.name+'='+x.value).join('; ');
 const response=await fetch(u,{headers:{Cookie:cookie},redirect:'manual',signal:AbortSignal.timeout(5000)});
 const location=new URL(response.headers.get('location')||u,u),loginRedirect=[301,302,303,307,308].includes(response.status)&&location.origin===u.origin&&(location.pathname==='/'||location.pathname==='/login'||location.searchParams.get('auth')==='login');
 if([401,419].includes(response.status)||loginRedirect||response.headers.get('content-type')?.includes('text/html')){await response.body?.cancel();throw new ApiError('login_required','Thumbnail session expired.');}return response;
 });const type=r.headers.get('content-type')?.split(';')[0];if(!r.ok||!['image/webp','image/jpeg','image/png'].includes(type)){await r.body?.cancel();return null;}
 const chunks=[];let size=0;for await(const b of r.body){size+=b.length;if(size>256*1024)return null;chunks.push(b);}const data=`data:${type};base64,${Buffer.concat(chunks).toString('base64')}`;await writeFile(file,JSON.stringify({data}),{mode:0o600});return data;}catch{return null;}
}
const ui = name => readFile(new URL('./cleanup-ui/' + name, import.meta.url), 'utf8');
export function libraryGroups(j){
 const known=new Map(j.groups.flatMap(g=>g.items).map(m=>[m.id,m]));
 return j.items.map(m=>{const item={...m,...known.get(m.id)};return {id:m.id.toString(16).padStart(12,'0'),keepId:null,explicit:true,items:[item],deleteIds:[m.id],verified:false};});
}
export async function renderReport(j, images = new Map(), web = null, view = j.plan?.mode==='explicit'?'library':'duplicates') {
 const [shell, css, model, application, live] = await Promise.all(['shell.html','gallery.css','model.js','app.js','live.js'].map(ui));
 // Keep this artifact shareable without leaking source URLs, cookies or session state.
 const media = m => Object.fromEntries(['id','name','media_type','mime_type','size_bytes','width','height','duration_seconds','usages','blockers','sha256','verifyError'].filter(k=>m[k]!==undefined).map(k=>[k,m[k]]));
 const groups=view==='library'?libraryGroups(j):j.groups;
 const data = {web,view,id:j.id,previousJobId:j.previousJobId,account:j.account,status:j.status,updatedAt:j.updatedAt,scannedCount:j.items.length,reviewRetention:j.reviewRetention||{},groups:groups.map(g=>({id:g.id,explicit:!!g.explicit,keepId:g.keepId,verified:!!g.verified,hashSets:g.hashSets||[],items:g.items.map(media),image:images.get(g.id)||null})),plan:j.plan?{mode:j.plan.mode,retentions:j.plan.retentions||{},items:j.plan.items.map(m=>({id:m.id,groupId:m.groupId,state:m.state,reason:m.reason}))}:null};
 const json = JSON.stringify(data).replace(/</g,'\\u003c').replace(/>/g,'\\u003e').replace(/&/g,'\\u0026').replace(/\u2028/g,'\\u2028').replace(/\u2029/g,'\\u2029');
 return (web?shell.replace("img-src data:;","img-src data: 'self'; media-src 'self'; connect-src 'self';"):shell).replace('/* STYLES */',()=>css).replace('/* DATA */',()=>json).replace('/* MODEL */',()=>model.replace(/^export /gm,'')).replace('/* APPLICATION */',()=>application).replace('/* LIVE */',()=>live);
}
export async function writeReport(c,j,dir){
 await mkdir(dir,{recursive:true,mode:0o700});const images=new Map();
 const end=Date.now()+15000;
 for(let i=0;i<j.groups.length&&Date.now()<end;i+=6)await Promise.all(j.groups.slice(i,i+6).map(async g=>images.set(g.id,await thumbnail(c,g,dir))));
 await writeFile(path.join(dir,'report.html'),await renderReport(j,images),{mode:0o600});return {thumbnailsReady:[...images.values()].filter(Boolean).length,totalGroups:j.groups.length};
}
