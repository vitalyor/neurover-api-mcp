import test from 'node:test';
import assert from 'node:assert/strict';
import {disposition,filterGroups,restoreState,selectionSummary,decisionText} from '../src/cleanup-ui/model.js';
import {renderReport,libraryGroups} from '../src/cleanup-report.js';
const media = id => ({id,name:'Ёлка.png',size_bytes:1000,media_type:'image',usages:[],blockers:[]});
const group = (id='g',items=[media(1),media(2),media(3)]) => ({id,items,keepId:items[0].id,verified:false});
const state = {query:'',type:'all',filter:'all',sort:'space',selected:new Set(),retention:{},mode:'hash'};
test('library includes unique files and merges known protections without inferring SHA equality',()=>{
 const a=media(1),b=media(2),unique={...media(3),name:'А уникальный.png'};
 const job={items:[a,b,unique],groups:[group('duplicate',[a,{...b,usages:[{node_title:'Canvas'}]}])]};
 const groups=libraryGroups(job),data={id:'job',view:'library',groups};
 assert.deepEqual(groups.map(g=>g.items[0].id),[1,2,3]);assert.ok(groups.every(g=>g.explicit&&g.items.length===1));
 const restored=restoreState(data,{retention:{[groups[0].id]:'keep_one'},mode:'hash',selected:[groups[1].id,groups[2].id]});
 assert.equal(restored.mode,'explicit');assert.equal(restored.retention[groups[0].id],'delete_all');
 const total=selectionSummary(groups,restored.selected,restored.retention,restored.mode);assert.equal(total.files,2);assert.equal(total.remove,1);assert.equal(total.protected,1);assert.equal(total.pending,0);
 assert.deepEqual(filterGroups(groups,{...state,sort:'copies'}).map(g=>g.items[0].id),[3,1,2]);
});
test('gallery estimates exclude known canvas dependencies and server blockers',()=>{
 const g=group();g.items[1].usages=[{project_title:'A'}];g.items[2].blockers=['busy'];
 assert.equal(disposition(g,'delete_all').bytes,1000);assert.equal(disposition(g,'keep_one').bytes,0);
 assert.equal(selectionSummary([g],new Set(['g']),{},'hash').protected,2);
});
test('hash selection preserves all unique SHA variants and the best keeper in each matching set',()=>{
 const g=group('g',[media(1),media(2),media(3),media(4),media(5)]);g.verified=true;g.hashSets=[[1,2],[3,4],[5]];g.items[1].usages=[{}];
 assert.deepEqual(disposition(g,'keep_one').deletable.map(m=>m.id),[1,4]);
 assert.deepEqual(disposition(g,'delete_all').deletable.map(m=>m.id),[1,3,4]);
 assert.equal(disposition(g,'delete_all','metadata').deletable.length,4);
});
test('metadata candidates are explicitly provisional until original hashing',()=>{
 assert.equal(disposition(group()).provisional,true);assert.equal(disposition(group(),'keep_one','metadata').provisional,false);
});
test('search handles Unicode, IDs, renamed files and combined filters without changing selection',()=>{
 const a=group('a'),b=group('b',[{...media(4),media_type:'audio',name:'One'},media(5)]);a.verified=true;
 assert.deepEqual(filterGroups([a,b],{...state,query:'елка',filter:'verified'}).map(g=>g.id),['a']);
 assert.deepEqual(filterGroups([a,b],{...state,query:'4',type:'audio'}).map(g=>g.id),['b']);
 assert.deepEqual(filterGroups([a,b],{...state,filter:'selected',selected:new Set(['b'])}).map(g=>g.id),['b']);
});
test('restored state removes stale group IDs, validates policies, respects frozen plans',()=>{
 const d={groups:[group()],updatedAt:'new',reviewRetention:{g:'delete_all'}};
 assert.deepEqual([...restoreState(d,{selected:['g','stale'],retention:{g:'bogus'}}).selected],['g']);
 assert.equal(restoreState(d,{}).retention.g,'delete_all');
 assert.equal(restoreState({...d,plan:{retentions:{g:'keep_one'}}},{retention:{g:'delete_all'}}).retention.g,'keep_one');
});
test('export names exact selected groups and per-group policy; hash verification is never deletion approval',()=>{
 const d={id:'job',groups:[group('a'),group('b')]},s={...state,selected:new Set(['b']),retention:{b:'delete_all'}};
 const text=decisionText(d,s);assert.ok(text.includes('groupRetention: {"b":"delete_all"}'));assert.ok(text.includes('удаление пока не запускай'));assert.ok(!text.includes('"a"'));
 assert.equal(decisionText({...d,plan:{}},s),'');assert.equal(decisionText({...d,status:'scanning'},s),'');assert.equal(decisionText(d,{...s,selected:new Set()}),'');
});
test('metadata choice exports explicit risk acknowledgement and protections',()=>{
 const text=decisionText({id:'job',groups:[group()]},{...state,selected:new Set(['g']),mode:'metadata'});
 assert.ok(text.includes('риск различий понимаю'));assert.ok(text.includes('блокированные сервером'));
});
test('summary retains selections hidden by filters and counts zero size safely',()=>{
 const a=group('a'),b=group('b');b.items.forEach(m=>m.size_bytes=null);
 const s=selectionSummary([a,b],new Set(['a','b']),{b:'delete_all'},'hash');
 assert.equal(s.groups,2);assert.equal(s.remove,5);assert.equal(s.bytes,2000);assert.equal(s.all,1);
});
test('render embeds safe data without remote media URLs, cookies or executable filenames',async()=>{
 const g=group();g.items[0].name='</script><script>alert(1)</script>';g.items[0].download_url='https://secret.test/token';
 const html=await renderReport({id:'job',account:'test',items:g.items,groups:[g],updatedAt:'2026-10-16',context:{cookies:'secret'}});
 assert.ok(!html.includes('</script><script>alert(1)'));assert.ok(!html.includes('secret.test'));assert.ok(!html.includes('cookies'));
 const payload=JSON.parse(html.match(/<script id="report-data" type="application\/json">([\s\S]*?)<\/script>/)[1]);
 assert.equal(payload.groups[0].items[0].name,g.items[0].name);
});
test('empty and large reports render without network dependencies',async()=>{
 for(const n of [0,1,49,1000]){
  const groups=Array.from({length:n},(_,i)=>group('g'+i));const html=await renderReport({id:'job',account:'test',items:[],groups,updatedAt:'2026-10-16'});
  assert.ok(html.includes('id="empty"'));assert.ok(!html.includes('<script src='));
  assert.equal(JSON.parse(html.match(/<script id="report-data" type="application\/json">([\s\S]*?)<\/script>/)[1]).groups.length,n);
 }
});
