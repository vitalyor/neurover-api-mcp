import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {runInNewContext} from 'node:vm';

test('hidden media releases its source and restores without autoplay; closing forgets it',async()=>{
  const source=await readFile(new URL('../src/cleanup-ui/live.js',import.meta.url),'utf8');
  const lifecycle=source.slice(source.indexOf('function stopMedia('),source.indexOf('function showMedia('));
  for(const kind of ['audio','video','image']){
    let src='/media/123',paused=0,loaded=0;
    const element={dataset:{},preload:'none',getAttribute:()=>src,removeAttribute:()=>{src=null;},setAttribute:(_,value)=>{src=value;}};
    if(kind!=='image')Object.assign(element,{pause:()=>paused++,load:()=>loaded++});
    const {stopMedia,restoreMedia}=runInNewContext(lifecycle+';({stopMedia,restoreMedia})',{$$:selector=>selector.includes('[data-suspended-src]')?(element.dataset.suspendedSrc?[element]:[]):[element]});
    stopMedia(true);assert.equal(src,null);assert.equal(element.dataset.suspendedSrc,'/media/123');
    restoreMedia();assert.equal(src,'/media/123');assert.equal(element.dataset.suspendedSrc,undefined);assert.equal(element.preload,'none');
    if(kind!=='image'){assert.equal(paused,1);assert.equal(loaded,1);}
    stopMedia(true);stopMedia();restoreMedia();assert.equal(src,null);assert.equal(element.dataset.suspendedSrc,undefined);
  }
});
