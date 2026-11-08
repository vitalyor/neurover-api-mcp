import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
const client=new Client({name:'neurover-readonly-check',version:'1'});
const root=fileURLToPath(new URL('../',import.meta.url));
try{
 await client.connect(new StdioClientTransport({command:process.execPath,args:[root+'src/server.js'],cwd:root,stderr:'pipe'}));
 const {tools}=await client.listTools(),catalog=new Map(tools.map(tool=>[tool.name,tool]));
 console.log(JSON.stringify({check:'tool_catalog',ok:true,count:tools.length}));
 async function call(name,args={}){
  assert.equal(catalog.get(name)?.annotations?.readOnlyHint,true,'Health checks must remain read-only: '+name);
  const r=await client.callTool({name,arguments:args},undefined,{timeout:60000}),value=JSON.parse(r.content[0].text);
  if(r.isError)throw Error(name+': '+value.status);
  console.log(JSON.stringify({tool:name,ok:true,keys:Object.keys(value)}));return value;
 }
 const {accounts}=await call('neurover_accounts');
 const account=process.argv[2]||(accounts.length===1?accounts[0]:null);assert.ok(account&&accounts.includes(account),'Provide a configured account as the first argument.');
 for(const name of ['neurover_auth_status','neurover_account_overview','neurover_statistics','neurover_profile','neurover_subscriptions'])await call(name,{account});
 const list=await call('neurover_workflows',{account});
 const workflowId=Number(process.argv[3]||list.projects?.[0]?.id);assert.ok(Number.isSafeInteger(workflowId)&&workflowId>0,'Provide a workflow ID as the second argument.');
 for(const name of ['neurover_models','neurover_workflow_graph','neurover_generations'])await call(name,{account,workflowId});
 const media=await call('neurover_media',{account,kind:'image'});assert.ok(Array.isArray(media.items)&&media.pagination,'Media inventory schema changed.');
}catch(error){console.error(JSON.stringify({ok:false,message:error.message}));process.exitCode=1;}
finally{await client.close();}
