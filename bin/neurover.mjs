#!/usr/bin/env node
import path from 'node:path';
import {createInterface} from 'node:readline/promises';
import {Writable} from 'node:stream';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {root,dataDir,accounts,clientFor,closeClients,ApiError} from '../src/client.js';
import {accountName,accountSettings,configureAccount} from '../src/accounts.js';
import {browserLogin,captureBrowserSession,closeAuthBrowsers} from '../src/browser-auth.js';
import {mcpConfig,mcpServer,entryPoint} from '../src/setup-config.js';
import {installedClients,addToClient} from '../src/clients.js';
import {currentVersion,checkForUpdate,applyUpdate} from '../src/update.js';
const cli=`node "${entryPoint()}"`;
import {callBroker} from '../src/auth-broker.js';
const help=`Neurover MCP
  setup              Добавить аккаунт и выбрать способ входа
  settings ACCOUNT   Изменить сохранение пароля существующего аккаунта
  login ACCOUNT      Войти вручную; пароль не попадает в чат
  unlock ACCOUNT     Совместимость: разблокировать прежний зашифрованный файл
  lock ACCOUNT       Совместимость: удалить ключ прежнего файла из памяти
  accounts           Показать аккаунты и режимы, без паролей
  config             Показать настройки подключения MCP
  connect            Добавить Neurover в Claude Desktop, Cursor, Windsurf
  update             Проверить и установить новую версию
  version            Показать установленную версию
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
const manualDone=name=>`Вход выполнен. Сессия сохранена, пароль нет.\nКогда Neurover завершит сессию, войдите снова: ${cli} login ${name}\nЧтобы MCP входил сам, включите хранение пароля: ${cli} settings ${name}`;
const agentHandoff=(command,name)=>`этот шаг выполняет человек в своём терминале.
Агент: не вводи пароль за пользователя и не проси его прислать пароль в чат.
${command==='setup'||command==='settings'?`
1. Спроси пользователя, как MCP будет входить в Neurover, объяснив разницу.
   MCP работает по сессии сайта; Neurover завершает её, часто после бездействия.
   1 — Вручную: хранится только сессия. Когда она закончится, MCP ответит
       login_required, и пользователь снова войдёт командой login.
   2 — Автоматически: пароль хранится в системном хранилище ОС (macOS Keychain,
       Windows Credential Manager, Linux Secret Service), MCP сам входит заново.
       Удобнее при регулярной работе и долгих фоновых заданиях.
2. Попроси пользователя выполнить в своём терминале и выбрать там этот вариант:
   ${cli} ${command}${name?' '+name:''}
3. Затем выполни: ${cli} config — и с согласия пользователя добавь
   показанные command/args/env в настройки его MCP-клиента; клиент нужно перезапустить.`:`
Попроси пользователя выполнить в своём терминале:
   ${cli} ${command}${name?' '+name:''}
Для ручного входа без терминала есть MCP-инструмент neurover_browser_login:
окно браузера откроется у пользователя, и он войдёт на сайте сам.`}`;
async function signIn(c){
 console.log('\nСейчас нужно войти один раз, чтобы получить сессию. Пароль при этом не сохраняется.\n  1 — в окне браузера: откроется neurover.io, вы входите там сами\n  2 — ввести пароль здесь, в терминале (не отображается); если браузер недоступен');
 const method=(await ask('Выберите 1 или 2 [1]: ')).trim()||'1';
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
async function connectClients(){
 const found=installedClients(),entry=mcpServer();
 console.log('\nПодключение к AI-приложениям');
 for(const c of found){
  const answer=(await ask(`Добавить Neurover в ${c.name}? [Д/н]: `)).trim().toLowerCase();
  if(answer&&!['д','да','y','yes'].includes(answer)){console.log(`  ${c.name}: пропущено.`);continue;}
  try{const r=await addToClient(c.file,entry);console.log(`  ${c.name}: ${r.status==='unchanged'?'уже подключено':'подключено'}${r.backup?`; прежние настройки сохранены в ${r.backup}`:''}.`);}
  catch(e){console.log(`  ${c.name}: ${e.message}`);}
 }
 if(!found.length)console.log('Claude Desktop, Cursor и Windsurf на этом компьютере не найдены.');
 console.log(`\nДругие приложения: добавьте вручную этот блок в их настройки MCP:\n${JSON.stringify(mcpConfig(),null,2)}`);
 console.log(`Claude Code: claude mcp add neurover --scope user -e NEUROVER_DATA_DIR="${dataDir}" -- "${process.execPath}" "${entryPoint()}" start`);
 console.log('\nГотово. Полностью закройте и снова откройте приложение, и Neurover появится в его инструментах.');
}
async function run(){
 const [command='start',name,...extra]=process.argv.slice(2);
 if(extra.length||name&&!['settings','login','unlock','lock'].includes(command))throw new ApiError('invalid_command','Use --help. Passwords are never accepted in arguments.');
 if(command==='start'){await import('../src/server.js');return;}
 if(['--help','help','-h'].includes(command)){console.log(help);return;}
 if(command==='config'){console.log(JSON.stringify(mcpConfig(),null,2));return;}
 if(command==='version'){console.log(currentVersion);return;}
 if(command==='update'){
  const r=await checkForUpdate({force:true});
  if(!r.updateAvailable){console.log(`Установлена последняя версия: ${r.current}.`);return;}
  console.log(`Доступна новая версия ${r.latest} (установлена ${r.current}).`);
  if(!process.stdin.isTTY){console.log(`Обновить: ${cli} update в своём терминале или инструментом neurover_update_apply с согласия пользователя.`);return;}
  const answer=(await ask('Обновить сейчас? [Д/н]: ')).trim().toLowerCase();
  if(answer&&!['д','да','y','yes'].includes(answer))return;
  console.log((await applyUpdate()).message);return;
 }
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
 if(!['setup','settings','login','unlock','lock','connect'].includes(command))throw new ApiError('invalid_command','Use --help.');
 if(command==='lock'){accountName(name);await callBroker('lock',name);console.log('Ключ расшифровки удалён из памяти. Существующая сессия сайта не завершается.');return;}
 // Agents run installers without a terminal; stop with instructions instead of waiting for input nobody can give.
 if(!process.stdin.isTTY)throw new ApiError('interactive_terminal_required',agentHandoff(command,name));
 if(command==='connect'){await connectClients();return;}
 if(command==='unlock'){
  accountName(name);if((await accountSettings(name))?.mode!=='encrypted')throw new ApiError('invalid_mode','This account does not use encrypted storage.');
  let masterPassword=await ask('Мастер-пароль (не отображается): ',{secret:true});
  try{await callBroker('unlock',name,masterPassword);await callBroker('login',name);}finally{masterPassword=null;}
  console.log('Разблокировано. Автовход работает до lock или завершения локального помощника/компьютера.');return;
 }
 if(command==='login'){
  accountName(name);const config=await accountSettings(name);if(!config)throw new ApiError('account_setup_required','Run setup first.');
  const c=await clientFor(name);await signIn(c);console.log(config.mode==='manual'?manualDone(name):'Вход выполнен. Сессия сохранена локально.');return;
 }
 const account=accountName(command==='settings'?name:(await ask('Имя аккаунта (латиница, цифры, _ и -): ')).trim());
 const previous=await accountSettings(account);
 if(command==='settings'&&!previous)throw new ApiError('account_setup_required','Run setup first.');
 if(command==='setup'&&previous)throw new ApiError('account_exists','Use settings to change this account.');
 const email=previous?.email||(await ask('Email Neurover: ')).trim();
 console.log(`
Как MCP будет входить в Neurover

MCP работает по сессии сайта (cookies). Она сохраняется на этом компьютере
после любого входа, и пока она действует, пароль не нужен. Но Neurover
завершает сессию, например после бездействия, и тогда нужен новый вход.
Выберите, кто будет входить заново:

  1 — Я сам, вручную. Пароль нигде не сохраняется.
      Когда сессия закончится, MCP сообщит login_required, и нужно будет
      выполнить в терминале: ${cli} login ${account}
      Подходит, если пользуетесь MCP редко или не хотите хранить пароль.

  2 — MCP сам, автоматически. Пароль хранится в системном хранилище
      (macOS Keychain / Windows Credential Manager / Linux Secret Service),
      а не в файлах MCP. Когда сессия закончится, MCP сам войдёт заново
      и повторит запрос. Подходит для регулярной работы и долгих фоновых
      заданий (очистка, генерации). ОС может спросить разрешение на доступ.

В обоих режимах сохранённая сессия даёт доступ к аккаунту: не делитесь папкой данных.
Режим можно поменять позже: ${cli} settings ${account}`);
 const choice=(await ask('Выберите 1 или 2 [1]: ')).trim()||'1';
 if(!['1','2'].includes(choice))throw new ApiError('invalid_choice','Choose 1 or 2.');
 if(choice==='1'){
  await configureAccount(account,{email,mode:'manual'});
  console.log(previous?'Ручной вход включён. Сохранённый пароль этой реализации удалён. Старое хранилище другой реализации не изменяется.':'Ручной вход включён.');
  if(!previous){await signIn(await clientFor(account));console.log(manualDone(account));}
 }else{
  let password=await ask('Пароль Neurover (не отображается): ',{secret:true});
  try{
   if(!previous)await configureAccount(account,{email,mode:'manual'});
   const c=await clientFor(account);await c.login({email,password});
   await configureAccount(account,{email,mode:'vault',password});
  }finally{password=null;}
  console.log('Вход выполнен, пароль сохранён в системном хранилище. Когда Neurover завершит сессию, MCP войдёт заново сам, если хранилище доступно и ОС разрешает доступ.');
 }
 if(command==='setup')await connectClients();else console.log('\nПодключение к MCP-клиенту:\n'+JSON.stringify(mcpConfig(),null,2));
}
if(globalThis.neuroverLauncher||process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 try{await run();}catch(error){console.error(`${error.code||'setup_failed'}: ${error instanceof ApiError?error.message:'Setup failed. No credentials are printed; check your local installation and vault.'}`);process.exitCode=1;}
 finally{if((process.argv[2]||'start')!=='start'){await closeAuthBrowsers();await closeClients();}}
}
