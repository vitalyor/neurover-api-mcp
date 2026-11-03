// One text file a user can send to the author: setup facts and the recent log, without emails, passwords, cookies or prompts.
import {readFile,writeFile} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {dataDir} from './paths.js';
import {accountNames,accountSettings} from './accounts.js';
import {knownClients,isOwnEntry} from './clients.js';
import {currentVersion,installLayout,runningWorkers} from './update.js';
import {wrapperPath} from './setup-config.js';
import {tail,redact} from './log.js';

export async function diagnosticsText({dir=dataDir,clients=knownClients(),lines=300}={}){
 const out=[`Neurover MCP ${currentVersion} — диагностика ${new Date().toISOString()}`,
  `Система: ${process.platform} ${os.release()} ${process.arch}, Node ${process.versions.node}`,
  `Установка: ${installLayout().kind}; папка данных: ${dir}; команда neurover: ${existsSync(wrapperPath(process.platform,dir))?'есть':'нет'}; Node: ${process.execPath}`,''];
 out.push('Аккаунты (без email и паролей):');
 const names=await accountNames().catch(()=>[]);
 for(const name of names){const c=await accountSettings(name).catch(e=>({mode:'ошибка '+e.code}));out.push(`  ${name}: режим ${c?.mode||'нет настроек'}${c?.passwordRemovalPending?', удаление пароля не завершено':''}; сессия ${existsSync(path.join(dir,'accounts',name,'session.json'))?'есть':'нет'}`);}
 if(!names.length)out.push('  нет');
 out.push('','Приложения:');
 for(const c of clients){
  if(!existsSync(c.file)){out.push(`  ${c.name}: ${existsSync(path.dirname(c.file))?'установлено, настроек MCP нет':'не найдено'}`);continue;}
  const text=await readFile(c.file,'utf8').catch(()=>'');
  out.push(`  ${c.name}: ${/neurover/.test(text)?(isOwnEntry(text)?'neurover подключён':'есть запись neurover, но не от этой установки'):'neurover не подключён'} (${c.file})`);
 }
 const update=await readFile(path.join(dir,'update-check.json'),'utf8').catch(()=>null);
 out.push('',`Проверка обновлений: ${update||'не было'}`);
 const busy=await runningWorkers(path.join(dir,'cleanup')).catch(()=>[]);
 out.push(`Фоновые задания: ${busy.length?busy.map(b=>`${b.kind} ${b.jobId}`).join(', '):'нет'}`);
 out.push('',`Журнал (последние ${lines} строк):`,tail(lines,dir)||'  пусто');
 return redact(out.join('\n'));
}

// Saved where people find files: Downloads, else Desktop, else home.
export async function writeDiagnostics(options){
 const home=os.homedir(),folder=[path.join(home,'Downloads'),path.join(home,'Desktop'),home].find(d=>existsSync(d));
 const file=path.join(folder,`neurover-diagnostics-${new Date().toISOString().slice(0,19).replace(/[:T]/g,'-')}.txt`);
 const text=await diagnosticsText(options);await writeFile(file,text+'\n',{mode:0o600});
 return {file,text};
}
