#!/usr/bin/env node
import path from 'node:path';
import {createInterface} from 'node:readline/promises';
import {Writable} from 'node:stream';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {root,dataDir,accounts,clientFor,closeClients,ApiError} from '../src/client.js';
import {accountName,accountSettings,configureAccount} from '../src/accounts.js';
import {browserLogin,captureBrowserSession,closeAuthBrowsers} from '../src/browser-auth.js';
import {mcpConfig} from '../src/setup-config.js';
import {callBroker} from '../src/auth-broker.js';
const help=`Neurover MCP
  setup              Добавить аккаунт и выбрать способ входа
  settings ACCOUNT   Изменить сохранение пароля существующего аккаунта
  login ACCOUNT      Войти вручную; пароль не попадает в чат
  unlock ACCOUNT     Совместимость: разблокировать прежний зашифрованный файл
  lock ACCOUNT       Совместимость: удалить ключ прежнего файла из памяти
  accounts           Показать аккаунты и режимы, без паролей
  config             Показать настройки подключения MCP
  install-browser    Установить Chromium для ручного входа
  doctor             Проверить Node, папку данных и наличие браузера
  start              Запустить MCP через stdio (по умолчанию)
Пароли вводятся только в локальном терминале или на neurover.io.
`;
async function ask(label,{secret=false}={}){
 if(!process.stdin.isTTY)throw new ApiError('terminal_required','Open this command in your own interactive terminal; never pass passwords in command arguments or chat.');
 const output=secret?new Writable({write(chunk,encoding,done){done();}}):process.stdout;
 if(secret)process.stdout.write(label);
 const rl=createInterface({input:process.stdin,output,terminal:true});
 try{return await rl.question(secret?'':label);}finally{rl.close();if(secret)process.stdout.write('\n');}
}
async function signIn(c){
 const method=(await ask('Вход: 1 — браузер, 2 — пароль однократно в этом терминале [1]: ')).trim()||'1';
 if(method==='2'){
  const config=await accountSettings(c.account);let password=await ask('Пароль (не сохраняется и не отображается): ',{secret:true});
  try{return await c.login({email:config.email,password});}finally{password=null;}
 }
 if(method!=='1')throw new ApiError('invalid_choice','Choose 1 or 2.');
 let result=await browserLogin(c);
 while(result.status==='needs_attention'){
  console.log('Войдите на neurover.io в открывшемся окне. Пароль вводите только там.');
  await ask('После входа нажмите Enter здесь (Ctrl+C — отмена): ');result=await captureBrowserSession(c);
 }
 return result;
}
async function run(){
 const [command='start',name,...extra]=process.argv.slice(2);
 if(extra.length||name&&!['settings','login','unlock','lock'].includes(command))throw new ApiError('invalid_command','Use --help. Passwords are never accepted in arguments.');
 if(command==='start'){await import('../src/server.js');return;}
 if(['--help','help','-h'].includes(command)){console.log(help);return;}
 if(command==='config'){console.log(JSON.stringify(mcpConfig(),null,2));return;}
 if(command==='install-browser'){
  const child=spawn(process.execPath,[path.join(root,'node_modules/playwright/cli.js'),'install','chromium'],{stdio:'inherit'});
  const code=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',resolve);});process.exitCode=code??1;return;
 }
 if(command==='doctor'){
  const {chromium}=await import('playwright');const {existsSync}=await import('node:fs');
  console.log(JSON.stringify({node:process.versions.node,platform:process.platform,dataDirectory:dataDir,chromiumInstalled:existsSync(chromium.executablePath()),passwordStorage:'manual / system credential store'},null,2));return;
 }
 if(command==='accounts'){
  for(const account of await accounts()){const config=await accountSettings(account);console.log(`${account}: ${config?.mode||'setup_required'}${config?.passwordRemovalPending?' (password removal pending)':''}`);}return;
 }
 if(!['setup','settings','login','unlock','lock'].includes(command))throw new ApiError('invalid_command','Use --help.');
 if(command==='lock'){accountName(name);await callBroker('lock',name);console.log('Ключ расшифровки удалён из памяти. Существующая сессия сайта не завершается.');return;}
 if(command==='unlock'){
  accountName(name);if((await accountSettings(name))?.mode!=='encrypted')throw new ApiError('invalid_mode','This account does not use encrypted storage.');
  let masterPassword=await ask('Мастер-пароль (не отображается): ',{secret:true});
  try{await callBroker('unlock',name,masterPassword);await callBroker('login',name);}finally{masterPassword=null;}
  console.log('Разблокировано. Автовход работает до lock или завершения локального помощника/компьютера.');return;
 }
 if(command==='login'){
  accountName(name);if(!await accountSettings(name))throw new ApiError('account_setup_required','Run setup first.');
  const c=await clientFor(name);await signIn(c);console.log('Вход выполнен. Сессия сохранена локально.');return;
 }
 const account=accountName(command==='settings'?name:(await ask('Имя аккаунта (латиница, цифры, _ и -): ')).trim());
 const previous=await accountSettings(account);
 if(command==='settings'&&!previous)throw new ApiError('account_setup_required','Run setup first.');
 if(command==='setup'&&previous)throw new ApiError('account_exists','Use settings to change this account.');
 const email=previous?.email||(await ask('Email Neurover: ')).trim();
 console.log('\n1 — Ручной вход: пароль не сохраняется.\n2 — Системное хранилище: macOS Keychain / Windows Credential Manager / Linux Secret Service.\nОС может запросить разрешение или разблокировку. В файл пароль не записывается.\nСессия (cookies) сохраняется локально в обоих режимах для фоновых заданий.\nНастройку можно изменить командой settings.');
 const choice=(await ask('Выберите 1 или 2 [1]: ')).trim()||'1';
 if(!['1','2'].includes(choice))throw new ApiError('invalid_choice','Choose 1 or 2.');
 if(choice==='1'){
  await configureAccount(account,{email,mode:'manual'});
  console.log('Ручной вход включён. Сохранённый пароль этой реализации удалён. Старое хранилище другой реализации не изменяется.');
  if(!previous)await signIn(await clientFor(account));
 }else{
  let password=await ask('Пароль Neurover (не отображается): ',{secret:true});
  try{
   if(!previous)await configureAccount(account,{email,mode:'manual'});
   const c=await clientFor(account);await c.login({email,password});
   await configureAccount(account,{email,mode:'vault',password});
  }finally{password=null;}
  console.log('Пароль сохранён в системном хранилище. Автовход зависит от его доступности и разрешений ОС.');
 }
 console.log('\nПодключение к MCP-клиенту:');console.log(JSON.stringify(mcpConfig(),null,2));
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 try{await run();}catch(error){console.error(`${error.code||'setup_failed'}: ${error instanceof ApiError?error.message:'Setup failed. No credentials are printed; check your local installation and vault.'}`);process.exitCode=1;}
 finally{if((process.argv[2]||'start')!=='start'){await closeAuthBrowsers();await closeClients();}}
}
