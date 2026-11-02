import {ApiError,origin,authenticatedRead} from './client.js';

export async function mediaResponse(client,media,{signal,range,method='GET'}={}) {
  return authenticatedRead(client,()=>readMedia(client,media,{signal,range,method}));
}
async function readMedia(client,media,{signal,range,method}) {
  if(!media?.download_url || media.available===false)throw new ApiError('media_unavailable','No original media download is available.');
  let url=new URL(media.download_url,origin);
  const state=await client.context.storageState();
  for(let hop=0;hop<6;hop++) {
    if(url.protocol!=='https:' || url.username || url.password || /^(localhost|127\.|\[|0\.|169\.254\.)/i.test(url.hostname))throw new ApiError('invalid_download','Unsupported media download URL.');
    const cookies=url.origin===origin?state.cookies.filter(c=>(c.domain.startsWith('.')?url.hostname===c.domain.slice(1)||url.hostname.endsWith(c.domain):url.hostname===c.domain)&&url.pathname.startsWith(c.path)&&(c.expires<0||c.expires>Date.now()/1000)).map(c=>`${c.name}=${c.value}`).join('; '):'';
    const response=await fetch(url,{redirect:'manual',method,headers:{...(cookies?{Cookie:cookies}:{}),...(range?{Range:range}:{})},signal:signal?AbortSignal.any([signal,AbortSignal.timeout(90000)]):AbortSignal.timeout(90000)});
    if([301,302,303,307,308].includes(response.status)) {
      const location=response.headers.get('location');await response.body?.cancel();
      if(!location)throw new ApiError('download_failed','Redirect has no location.');url=new URL(location,url);continue;
    }
    if(url.origin===origin&&[401,419].includes(response.status)){await response.body?.cancel();throw new ApiError('login_required','Media session expired.');}
    if(!response.ok || method!=='HEAD'&&!response.body) {await response.body?.cancel();throw new ApiError([404,410].includes(response.status)?'media_unavailable':'download_failed',`Download returned HTTP ${response.status}.`);}
    const ct=response.headers.get('content-type')||'';
    if(!/^(image|video|audio)\//.test(ct)&&!ct.includes('octet-stream')) {await response.body?.cancel();throw new ApiError(url.origin===origin&&ct.includes('text/html')?'login_required':'unexpected_download','Server did not return an original media file.');}
    return response;
  }
  throw new ApiError('download_failed','Too many media redirects.');
}
