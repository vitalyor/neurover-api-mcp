// Offline UI fixtures, never connected to the user's cleanup job or API.
import {mkdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {renderReport} from '../src/cleanup-report.js';
const out=process.argv[2];
if(!out||!path.isAbsolute(out))throw Error('Provide an absolute, dedicated fixture output directory.');
await mkdir(out,{recursive:true});
const names=['IMG_20250914_183022_HDR_portrait_edited_edited.HEIC','نور الهدى عبد الرحمن.png','王秀英.png','👩🏽‍💻 🦊.png','','<script>alert(1)</script>.png','A'.repeat(2000)+'.png'];
const group=i=>({id:'fixture-'+i,keepId:i*10,verified:i%3===0,hashSets:i%3===0?[[i*10,i*10+1],[i*10+2]]:[],items:Array.from({length:3},(_,k)=>({id:i*10+k,name:names[i%names.length],media_type:i%4===0?'audio':'image',mime_type:i%4===0?'audio/mpeg':'image/png',width:4000,height:200,size_bytes:i%5===0?0:1284000,usages:i%3===1&&k===1?[{project_title:'Длинное название полотна '.repeat(8),node_title:'Элемент'}]:[],blockers:i%3===2&&k===2?['busy']:[],verifyError:i%7===0?'Сеть недоступна':undefined}))});
for(const [name,count] of [['empty',0],['one',1],['worst',18],['many',1000]]){
 const groups=Array.from({length:count},(_,i)=>group(i+1));
 await writeFile(path.join(out,name+'.html'),await renderReport({id:'fixture-'+name,account:'ТЕСТОВЫЕ ДАННЫЕ · '+name,groups,items:groups.flatMap(g=>g.items),updatedAt:'2026-10-16T09:00:00Z',status:'ready'}));
}
const g=group(1);
await writeFile(path.join(out,'plan.html'),await renderReport({id:'fixture-plan',account:'ТЕСТОВЫЕ ДАННЫЕ · план',groups:[g],items:g.items,updatedAt:'2026-10-16',status:'needs_attention',plan:{retentions:{[g.id]:'delete_all'},items:g.items.map((m,i)=>({...m,groupId:g.id,state:['deleted','uncertain','skipped'][i],reason:i===1?'Ответ потерян, повторное удаление заблокировано':null}))}}));
await writeFile(path.join(out,'index.html'),'<!doctype html><html lang="ru"><meta charset="utf-8"><title>Тестовые состояния галереи</title><h1>Только синтетические данные</h1><p>Эти страницы не связаны с MCP и ничего не удаляют.</p><nav>'+['empty','one','worst','many','plan'].map(n=>`<p><a href="${n}.html">${n}</a></p>`).join('')+'</nav></html>');
console.log('Fixture pages: '+out);
