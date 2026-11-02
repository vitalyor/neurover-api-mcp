import {chromium,request} from 'playwright';
import {origin,ApiError,parsePage} from './client.js';
import {accountSettings,credentialsFor,verifyAccountIdentity} from './accounts.js';
const windows=new Map();
export async function captureBrowserSession(c){
 const browser=windows.get(c.account);if(!browser)throw new ApiError('browser_closed','Open the sign-in browser first.');
 const state=await browser.context.storageState();
 const next=await request.newContext({storageState:state});
 const r=await next.get(origin+'/workflows',{headers:{Accept:'application/json','X-Requested-With':'XMLHttpRequest'},timeout:45000});
 let authenticated=false;try{authenticated=r.status()===200&&(await r.json()).projects!==undefined;}catch{}finally{await r.dispose();}
 if(!authenticated){await next.dispose();return {status:'needs_attention',account:c.account,message:'Finish sign-in in the open browser, then capture again.'};}
 try{
  const identity=await next.get(origin+'/',{headers:{Accept:'text/html'},timeout:45000});
  try{verifyAccountIdentity(await accountSettings(c.account),parsePage(await identity.text()).props.auth?.user);}finally{await identity.dispose();}
 }catch(error){await next.dispose();throw error;}
 await c.context.dispose();c.context=next;c.csrf=null;await c.save({replace:true});await browser.browser.close();windows.delete(c.account);
 return {status:'authenticated',account:c.account,transport:'http',browserClosed:true};
}
export async function browserLogin(c){
 if(windows.has(c.account))return captureBrowserSession(c);
 const browser=await chromium.launch({headless:false});
 const context=await browser.newContext({locale:'ru-RU',viewport:{width:1200,height:900},acceptDownloads:false});
 const page=await context.newPage();windows.set(c.account,{context,page,browser});
 await page.goto(origin+'/workflows',{waitUntil:'domcontentloaded'});
 if(!await page.locator('input[type="password"]').isVisible().catch(()=>false)){
  if(await page.getByRole('button',{name:'Войти',exact:true}).first().isVisible().catch(()=>false))await page.getByRole('button',{name:'Войти',exact:true}).first().click();else return captureBrowserSession(c);
 }
 const config=await accountSettings(c.account);
 if(config?.email)await page.getByRole('textbox',{name:'Email'}).fill(config.email);
 if(!config||!['vault','legacy'].includes(config.mode))return {status:'needs_attention',account:c.account,message:'Sign in directly in the browser, then capture the session. Do not send your password in chat.'};
 let {email,password}=await credentialsFor(c.account);
 await page.getByRole('textbox',{name:'Email'}).fill(email);await page.locator('input[type="password"]').fill(password);password=null;
 await page.getByRole('button',{name:'Войти',exact:true}).last().click();
 await page.locator('input[type="password"]').waitFor({state:'hidden',timeout:15000}).catch(()=>{});
 return captureBrowserSession(c);
}
export async function closeAuthBrowsers(){await Promise.all([...windows.values()].map(x=>x.browser.close()));windows.clear();}
