// One-line installer entry, run by get.sh / get.ps1 from a temporary copy. Built-ins only: dependencies do not exist yet.
import {spawnSync} from 'node:child_process';
import {readdirSync} from 'node:fs';
import path from 'node:path';
import {latestVersion,installManaged,managedAppDir,repository} from '../src/update.js';
import {dataDir} from '../src/paths.js';
import {cliCommand} from '../src/setup-config.js';

const app=managedAppDir();
const version=await latestVersion().catch(()=>null);
if(!version){console.error(`Не удалось узнать последнюю версию на GitHub (${repository}). Проверьте интернет и запустите команду снова.`);process.exit(1);}
console.log(`\nУстанавливаю Neurover MCP ${version}\nПапка: ${app}\n`);
await installManaged(app,version);

const launcher=path.join(app,'neurover.mjs');
const step=(...args)=>spawnSync(process.execPath,[launcher,...args],{stdio:'inherit'}).status;
console.log('\nСтавлю браузер для входа через сайт…');
if(step('install-browser')!==0)console.log('Браузер не установился. Войти можно и без него: вводом пароля в терминале.');

let hasAccounts=false;try{hasAccounts=readdirSync(path.join(dataDir,'accounts')).length>0;}catch{}
if(!process.stdin.isTTY){
 // Run by an agent: stop here and hand the interactive part to the person.
 console.log(`\nПрограмма установлена. Дальше нужен человек.\nАгент: объясни пользователю два режима входа (см. README) и попроси выполнить в его терминале:\n  ${cliCommand(launcher)} ${hasAccounts?'connect':'setup'}`);
 process.exit(0);
}
process.exit(step(hasAccounts?'connect':'setup')??1);
