import {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js';
import {StdioServerTransport} from '@modelcontextprotocol/sdk/server/stdio.js';
import {z} from 'zod';
import {readFile} from 'node:fs/promises';
import {root,accounts,selectAccount,clientFor,serial,closeClients,ApiError} from './client.js';
import {prepare,submit,loadDraft,resolveModel,settingsFor,ensureReference,draftReport} from './generation.js';
import {readJournal,orientationWarnings} from './journal.js';
import {download,compactMedia} from './media.js';
import {generationSummary,submissionSummary} from './summaries.js';
import {prepareJob,submitJob} from './jobs.js';
import {browserLogin,captureBrowserSession,closeAuthBrowsers} from './browser-auth.js';
import {library} from './media-dedup.js';
import {startCleanup,startVerification,pauseCleanup,nextCleanup,startScan,deleteExact,loadCleanup,scanCleanup,reviewCleanup,verifyCleanup,approveCleanup,approveFiles,stepCleanup,cleanupStatus,cancelCleanup} from './cleanup.js';
import {ensureCleanupWeb} from './cleanup-web.js';
import {accountSettings,accountName} from './accounts.js';
import {mcpConfig} from './setup-config.js';
const server=new McpServer({name:'neurover-api',version:'0.8.1'});
const routes=JSON.parse(await readFile(new URL('./routes.json',import.meta.url),'utf8'));
const account=z.string().optional();const id=z.number().int().positive();
const wf={account,workflowId:id};const node={...wf,nodeId:id};
const position=z.object({x:z.number().finite(),y:z.number().finite()});
const json=z.record(z.string(),z.unknown());
function scrub(v){if(Array.isArray(v))return v.map(scrub);if(v&&typeof v==='object')return Object.fromEntries(Object.entries(v).filter(([k])=>!['csrfToken','csrf_token','password','password_confirmation'].includes(k)).map(([k,x])=>[k,scrub(x)]));return v;}
function result(v,isError=false){return {content:[{type:'text',text:JSON.stringify(scrub(v),null,2)}],isError};}
// Clear descriptions for the main generation flow (override the short originals).
const DESCRIPTIONS={
 // Вход
 neurover_accounts:'Список настроенных аккаунтов Neurover (пароли не возвращаются).',
 neurover_login:'Войти в аккаунт через системное хранилище пароля. Первое, что делать при ошибке авторизации.',
 neurover_auth_status:'Проверить, активна ли сессия, без входа и без браузера.',
 neurover_browser_login:'Резервный вход через видимое окно браузера, когда обычный вход просит CAPTCHA. Шаг 1: вызвать без finish — откроется окно, пользователь входит. Шаг 2: вызвать с finish=true — сессия сохраняется, окно закрывается.',
 neurover_logout:'Выйти из сессии MCP.',
 neurover_account_setup:'Добавить новый аккаунт: возвращает команду для терминала пользователя (пароль в чат не передаётся).',
 neurover_account_settings:'Режим входа уже настроенного аккаунта (ручной / системное хранилище).',
 // Аккаунт и деньги
 neurover_account_overview:'Баланс кредитов, подписка и занятое место в хранилище — короткая сводка. Для вопроса «сколько кредитов» использовать это.',
 neurover_balance:'Страница «Баланс» целиком: тарифы, текущая подписка, история платежей.',
 neurover_charges:'История списаний кредитов (сколько стоила каждая генерация).',
 neurover_subscriptions:'Страница подписок сайта.',
 neurover_profile:'Страница профиля пользователя.',
 neurover_audit:'Журнал действий/безопасности аккаунта.',
 neurover_statistics:'Статистика генераций по моделям за период.',
 neurover_notifications:'Уведомления сайта и число непрочитанных; markRead=true — отметить все прочитанными.',
 // Полотна
 neurover_workflows:'Список полотен (id, название). Поиск по названию через search.',
 neurover_create_workflow:'Создать новое пустое полотно.',
 neurover_rename_workflow:'Переименовать полотно.',
 neurover_clone_workflow:'Создать копию полотна.',
 neurover_delete_workflow:'Удалить полотно (на сервере оно уходит в архив, из списка пропадает). Только по прямой просьбе пользователя, confirm=true.',
 neurover_workflow_graph:'Всё содержимое полотна: плитки (узлы), связи, версия, настройки полотна.',
 // Модели
 neurover_models:'ШАГ 0. Список моделей полотна: id, название, лимит символов промта. Лимит у каждой модели свой (Seedance Линия 18 — 30000, Kling-4.0 и Линия 42 — 5000): пиши промт под него.',
 neurover_model_settings:'ШАГ 0. Схема одной модели: какие настройки есть (mode, duration, resolution, aspect_ratio…), их варианты и поля для референсов.',
 // Медиатека (файлы)
 neurover_media:'Найти файлы в медиатеке (по типу и имени) и их mediaAssetId — чтобы взять уже загруженную картинку без повторной загрузки.',
 neurover_media_access:'Подробности одного файла медиатеки по mediaAssetId: имя, размер, разрешение, ссылки.',
 neurover_ensure_media:'Получить mediaAssetId локального файла: найти в медиатеке по содержимому или загрузить ТОЛЬКО в медиатеку (на полотне ничего не появляется). Обычно не нужен — prepare_generation сам принимает filePath.',
 neurover_download_media:'Скачать файл из медиатеки по mediaAssetId. Для результата генерации удобнее download_generation.',
 neurover_delete_media:'Удалить конкретный файл из медиатеки по id и точному имени. Сначала dryRun, удаление только по прямой просьбе пользователя.',
 neurover_delete_reference_copies:'Удалить служебные копии референсов (source_kind=reference_copy), которые сайт создаёт сам. Исходники и результаты не трогает. Сначала dryRun.',
 // Генерация через чат полотна (основной путь)
 neurover_prepare_generation:'ШАГ 1 основного процесса. Собрать запрос генерации и узнать цену; кредиты НЕ списываются. references — в нужном порядке, каждая {mediaAssetId} или {filePath}; field и role можно не указывать (подберутся по схеме модели). В промте ссылайся на них @ref_1, @ref_2… — MCP сам подставит имена @image_N по порядку. Видео Seedance: mode=reference + aspect_ratio, а в промте напиши, что @ref_1 — первый кадр (mode=first-frame даёт вертикальное видео). Настройки, которых у модели нет, отбрасываются с предупреждением. Перед оплатой проверь в ответе finalPrompt, таблицу references и warnings.',
 neurover_draft_view:'Показать подготовленный запрос по токену: итоговый промт, таблица референсов, настройки, предупреждения — ровно то, что уйдёт на сервер.',
 neurover_submit_generation:'ШАГ 2. Платный запуск токена из prepare_generation / prepare_run / prepare_prompt_enhancement, один раз. Только когда пользователь попросил; maxCredits ≥ estimatedCredits. Не повторять при неясном результате — сначала wait_generation.',
 neurover_wait_generation:'ШАГ 3. Статус генерации по messageId (или nodeId). timeoutSeconds — сколько ждать (до 45 с, повторять вызов, пока не готово); timeoutSeconds=0 — просто проверить статус. По готовности сверяет ориентацию результата.',
 neurover_download_generation:'ШАГ 4. Скачать готовый результат генерации по messageId в outputDir с именем fileName. mediaAssetId — только чтобы выбрать один из нескольких результатов.',
 neurover_generations:'История генераций полотна: промты, настройки, реально отправленные референсы, цена, результаты, messageId.',
 neurover_reset_context:'Сбросить контекст выбранной модели в чате полотна (модель «забывает» прошлые сообщения).',
 // Плитки на полотне (работа с графом)
 neurover_add_node:'Добавить на полотно плитку генерации или текста (без запуска).',
 neurover_add_media_to_workflow:'Поставить на полотно плитку с уже существующим файлом медиатеки.',
 neurover_set_text_node:'Записать текст в текстовую плитку.',
 neurover_rename_node:'Переименовать плитку.',
 neurover_update_node:'Изменить настройки, промт, положение или размер плитки (без запуска).',
 neurover_delete_node:'Удалить плитку с полотна (файл в медиатеке остаётся).',
 neurover_connect_nodes:'Соединить две плитки связью (handles брать из графа/схемы модели).',
 neurover_delete_edge:'Удалить связь между плитками.',
 neurover_node_duplicate:'Дублировать плитку.',
 neurover_node_restore_last_success:'Вернуть плитке последний успешный результат.',
 neurover_node_cancel:'Отменить генерацию, идущую в плитке.',
 neurover_prepare_run:'Узнать цену запуска плитки, её зависимостей или всего полотна (без запуска). Запуск — submit_generation.',
 neurover_prepare_prompt_enhancement:'Узнать цену платного улучшения промта плитки (без запуска). Запуск — submit_generation.',
 // Очистка дублей в медиатеке (по порядку)
 neurover_cleanup_scan:'Очистка дублей, шаг 1: найти похожие файлы по метаданным, ничего не удаляет. При status=scanning повторить с тем же jobId.',
 neurover_cleanup_report:'Очистка дублей, шаг 2: открыть галерею для пользователя (reportUrl). view=duplicates — похожие файлы, view=library — вся медиатека.',
 neurover_cleanup_verify:'Очистка дублей, шаг 3 (по желанию): сверить SHA-256 оригиналов выбранных групп. background=true — в фоне, без ожидания. Ничего не удаляет.',
 neurover_cleanup_approve:'Очистка дублей, шаг 4: зафиксировать выбор пользователя по группам (оставить одну копию / удалить все). Ничего не удаляет.',
 neurover_cleanup_approve_files:'Очистка, шаг 4 (вариант): зафиксировать точные id отдельных файлов на удаление. Ничего не удаляет.',
 neurover_cleanup_start:'Очистка, шаг 5: запустить одобренное удаление в фоне (порциями, переживает перезапуск).',
 neurover_cleanup_step:'Очистка, шаг 5 (ручной режим): удалить одну порцию одобренного; также проверка неясного результата после сбоя.',
 neurover_cleanup_status:'Статус очистки по jobId.',
 neurover_cleanup_pause:'Приостановить фоновую очистку после текущей порции.',
 neurover_cleanup_cancel:'Отменить оставшуюся очистку.',
 neurover_cleanup_new:'Начать новый разбор после завершённой или отменённой очистки.',
 // Прямой доступ к API сайта (когда для действия нет своего инструмента)
 neurover_api_catalog:'Список известных маршрутов API сайта. Только если для задачи нет отдельного инструмента.',
 neurover_api_read:'Прочитать любой GET-маршрут сайта. Только если нет отдельного инструмента.',
 neurover_api_write:'Изменяющий запрос к маршруту сайта. Только если нет отдельного инструмента; платные запуски — только через prepare/submit.'
};
function tool(name,description,schema,fn,{readOnly=true,destructive=false,noAccount=false}={}){
 description=DESCRIPTIONS[name]||description;
 server.registerTool(name,{description,inputSchema:schema,annotations:{readOnlyHint:readOnly,destructiveHint:destructive,openWorldHint:true}},async input=>{
  try{if(noAccount)return result(await fn(input));const selected=await selectAccount(input.account);return result(await serial(selected,async()=>fn(input,await clientFor(selected))));}
  catch(e){return result({status:e.code||'error',message:e instanceof ApiError?e.message:'Operation failed; see local diagnostics.',...(e.details||{})},true);}
 });
}
const query=o=>{const p=new URLSearchParams();for(const[k,v]of Object.entries(o))if(v!==undefined&&v!==null)p.set(k,String(v));return p.size?'?'+p:'';};
tool('neurover_accounts','Настроенные аккаунты; пароли не возвращаются.',{},()=>accounts().then(accounts=>({accounts})),{noAccount:true});
tool('neurover_login','Войти через системное хранилище аккаунта; ОС может запросить разрешение или разблокировку. Для ручного входа локальный login/browser_login. Пароли не передавать в чат.',{account},(_,c)=>c.login(),{readOnly:false});
tool('neurover_account_setup','Инструкция безопасного добавления аккаунта или изменения режима входа в локальном терминале. Не принимает паролей.',{account},async i=>{if(i.account)accountName(i.account);return {command:process.execPath,args:[root+'/bin/neurover.mjs',i.account?'settings':'setup',...i.account?[i.account]:[]],connection:mcpConfig(),message:'Run in your own terminal. Never send passwords to chat. settings switches between manual sign-in and system credential storage; OS permission/unlock prompts may appear. No plaintext fallback.'};},{noAccount:true});
tool('neurover_account_settings','Режим входа и предупреждение об удалении пароля; секреты не возвращаются.',{account},async(i,c)=>{const config=await accountSettings(c.account);return {account:c.account,mode:config?.mode||'setup_required',passwordRemovalPending:!!config?.passwordRemovalPending};});
tool('neurover_browser_login','Резервный вход через отдельное видимое окно, если HTTP-вход требует CAPTCHA. После входа окно закрывается и операции снова идут по HTTP.',{account,finish:z.boolean().default(false)},(i,c)=>i.finish?captureBrowserSession(c):browserLogin(c),{readOnly:false});
tool('neurover_auth_status','Проверить HTTP-сессию без запуска браузера.',{account},(_,c)=>c.authStatus());
tool('neurover_logout','Завершить только сессию нового MCP.',{account},async(_,c)=>{const r=await c.http('/logout',{method:'POST',data:{},allowAnonymous:true});c.csrf=null;return {status:'logged_out'};},{readOnly:false});
tool('neurover_workflows','Список полотен с поиском и пагинацией.',{account,search:z.string().optional(),page:id.optional()},(i,c)=>c.http('/workflows'+query({search:i.search,page:i.page})));
tool('neurover_create_workflow','Создать пустое полотно.',{account,name:z.string().trim().min(1).max(120)},(i,c)=>c.http('/workflows',{method:'POST',data:{title:i.name,viewport:{x:0,y:0,zoom:1}}}),{readOnly:false});
tool('neurover_rename_workflow','Переименовать полотно.',{...wf,name:z.string().trim().min(1).max(120)},(i,c)=>c.mutateWorkflow(i.workflowId,'','PATCH',{title:i.name}),{readOnly:false});
tool('neurover_delete_workflow','Удалить полотно после явного confirm=true.',{...wf,confirm:z.literal(true)},(i,c)=>c.mutateWorkflow(i.workflowId,'','DELETE',{}),{readOnly:false,destructive:true});
tool('neurover_clone_workflow','Создать копию полотна.',wf,(i,c)=>c.mutateWorkflow(i.workflowId,'/clone','POST',{}),{readOnly:false});
tool('neurover_workflow_graph','Полный граф полотна, версии, узлы и связи.',wf,(i,c)=>c.workflow(i.workflowId));
tool('neurover_models','Модели и лимит промта каждой модели из живого каталога.',{...wf,type:z.enum(['image','video','audio','text']).optional()},async(i,c)=>{const p=await c.page(`/workflows/${i.workflowId}`);return {models:p.modelOptions.filter(m=>!i.type||m.media_type===i.type).map(m=>({id:m.id,name:m.display_name,type:m.media_type,isDefault:m.is_default,promptLimit:m.input_schema_json?.prompt?.max??null,operation:m.operation_kind}))};});
tool('neurover_model_settings','Полная актуальная схема выбранной модели с defaults, options и reference constraints.',{...wf,modelId:id.optional(),model:z.string().optional(),type:z.enum(['image','video','audio','text']).optional()},(i,c)=>resolveModel(c,i.workflowId,i));
tool('neurover_account_overview','Баланс, подписка и место в хранилище.',{account},async(_,c)=>{const p=await c.page('/workflows');return {creditBalance:p.creditBalance,subscriptionAccess:p.subscriptionAccess,...await c.http('/storage/usage')};});
tool('neurover_statistics','Статистика генераций; фильтры передаются в запрос страницы.',{account,page:id.optional(),modelId:id.optional(),filters:json.optional()},async(i,c)=>{const p=await c.page('/statistics'+query({...i.filters,page:i.page,model:i.modelId}));return {generations:p.generations,models:p.models,filters:p.filters,hasUnknownModel:p.hasUnknownModel};});
tool('neurover_notifications','Лента уведомлений и количество непрочитанных.',{account,markRead:z.boolean().default(false)},async(i,c)=>{if(i.markRead)await c.http('/notifications/read',{method:'POST',data:{}});return c.http('/notifications/feed');},{readOnly:false});
for(const [name,url]of [['balance','/balance'],['charges','/credits/charges'],['audit','/audit'],['subscriptions','/subscriptions'],['profile','/profile']]) tool('neurover_'+name,'Прочитать '+name+' без браузера.',{account,page:id.optional()},(i,c)=>c.page(url+query({page:i.page})));
tool('neurover_media','Медиатека с типом, поиском и курсором beforeId.',{account,workflowId:id.optional(),kind:z.enum(['image','video','audio']),query:z.string().optional(),beforeId:id.optional(),limit:z.number().int().min(1).max(50).optional()},(i,c)=>c.http((i.workflowId?`/workflows/${i.workflowId}`:'')+'/media-library'+query({type:i.kind,search:i.query,before_id:i.beforeId,limit:i.limit})));
tool('neurover_media_access','Метаданные и ссылки конкретного медиа по ID.',{account,workflowId:id.optional(),mediaAssetId:id},(i,c)=>c.http((i.workflowId?`/workflows/${i.workflowId}`:'')+`/media-library/${i.mediaAssetId}/access`));
tool('neurover_download_media','Скачать существующее медиа потоком, не перезаписывая файлы.',{account,mediaAssetId:id,outputDir:z.string().min(1),fileName:z.string().optional()},(i,c)=>download(c,i),{readOnly:false});
tool('neurover_ensure_media','Получить ID референса по локальному файлу: повторно использовать существующий файл по содержимому или один раз загрузить новый — только в медиатеку, как кнопка «Загрузить» в чате, без узла на полотне. modelId/model и referenceField необязательны (по умолчанию модель воркфлоу, принимающая этот тип). Не возвращает список медиатеки.',{...wf,filePath:z.string().min(1),mimeType:z.string().optional(),modelId:id.optional(),model:z.string().optional(),referenceField:z.string().optional()},async(i,c)=>compactMedia(await ensureReference(c,i)),{readOnly:false});
tool('neurover_delete_media','Просмотр последствий удаления; удаление требует confirm, точное имя и разрешение на использование на полотнах.',{...wf,mediaAssetId:id,expectedName:z.string().min(1),dryRun:z.boolean().default(true),confirm:z.boolean().optional(),allowUsedOnCanvas:z.boolean().default(false)},async(i,c)=>{
 return deleteExact(c,i);
},{readOnly:false,destructive:true});
tool('neurover_delete_reference_copies','Удалить только медиа с серверным source_kind=reference_copy. Сначала dryRun; не выбирает исходные загрузки или результаты.',{...wf,kind:z.enum(['image','video','audio']),maxItems:z.number().int().min(1).max(20).default(20),dryRun:z.boolean().default(true),confirm:z.boolean().optional(),allowUsedOnCanvas:z.boolean().default(false)},async(i,c)=>{
 const copies=[];let before;let complete=false;
 for(let page=0;page<100;page++){
  const r=await c.http(`/workflows/${i.workflowId}/media-library`+query({type:i.kind,before_id:before,limit:50}));
  copies.push(...r.items.filter(m=>m.source_kind==='reference_copy'));
  if(!r.pagination.has_more){complete=true;break;}const next=r.pagination.next_before_id;if(!next||next===before)break;before=next;
 }
 const ids=copies.sort((a,b)=>a.id-b.id).slice(0,i.maxItems).map(m=>m.id);
 if(i.dryRun||!ids.length)return {status:'preview',mediaAssetIds:ids,referenceCopies:copies.length,scanComplete:complete};
 if(!i.confirm)throw new ApiError('confirmation_required','Set confirm=true to delete reference copies.');
 const r=await deleteExact(c,i,copies.filter(m=>ids.includes(m.id)));
 return {...r,remainingReferenceCopies:complete?copies.length-r.deleted_ids.length:null,scanComplete:complete};
},{readOnly:false,destructive:true});
const cleanupCall=async(i,fn)=>{const j=await loadCleanup(i.jobId);const account=await selectAccount(j.account);return serial(account,async()=>fn(await clientFor(account),i));};
const cleanupId={jobId:z.string().uuid()};
tool('neurover_cleanup_scan','Найти кандидатов в дубли только по метаданным оригиналов, без скачивания оригиналов. Сохраняет отчёт с миниатюрами. При status=scanning продолжить с тем же jobId. Ничего не удаляет.',{account,workflowId:id.optional(),jobId:z.string().uuid().optional(),kind:z.enum(['all','image','video','audio']).default('all')},async i=>{if(i.jobId)return cleanupCall(i,(c,i)=>scanCleanup(c,i));if(!i.workflowId)throw new ApiError('workflow_required','Choose a workflow for dependency checks.');const a=await selectAccount(i.account);return serial(a,async()=>scanCleanup(await clientFor(a),i));},{readOnly:false,noAccount:true});
tool('neurover_cleanup_report','Обновить галерею и вернуть reportUrl локального сервиса. Открыть reportUrl: пользователь выбирает группы, проверку и запускает очистку на странице. reportPath — автономная резервная копия.',{...cleanupId,view:z.enum(['library','duplicates']).optional(),groupRetention:z.record(z.string(),z.enum(['keep_one','delete_all'])).optional()},async i=>{const r=await cleanupCall(i,(c,i)=>reviewCleanup(c,i.jobId,i.groupRetention));try{const w=await ensureCleanupWeb(i.jobId);return {...r,...w,reportUrl:w.reportUrl+(i.view?'?view='+i.view:'')};}catch(e){return {...r,webError:e.code||'web_start_failed'};}},{readOnly:false,noAccount:true});
tool('neurover_cleanup_verify','Сравнить SHA-256 оригиналов выбранных групп по решению пользователя. Потоковая загрузка в пределах maxBytes, сохранение прогресса и хешей; при verificationPending продолжить тот же jobId. Ничего не удаляет.',{...cleanupId,groupIds:z.array(z.string()).min(1).optional(),groupRetention:z.record(z.string(),z.enum(['keep_one','delete_all'])).optional(),maxBytes:z.number().int().min(1).max(1024*1024*1024).default(100*1024*1024),background:z.boolean().default(false)},i=>{if(i.background&&!i.groupIds?.length)throw new ApiError('groups_required','background=true needs groupIds.');return cleanupCall(i,i.background?startVerification:verifyCleanup);},{readOnly:false,noAccount:true});
tool('neurover_cleanup_approve','Зафиксировать конкретные группы и решение пользователя. mode=metadata допускает разные оригиналы: нужно явное согласие пользователя именно на этот режим. mode=hash допускает только подтверждённые хешем копии. retention=keep_one сохраняет одну копию, delete_all удаляет все копии в выбранных группах; groupRetention задаёт выбор отдельно для каждой группы. В hash-режиме уникальные SHA-варианты сохраняются. Не отправляет удаление.',{...cleanupId,groupIds:z.array(z.string()).min(1).optional(),mode:z.enum(['metadata','hash']),retention:z.enum(['keep_one','delete_all']).optional(),groupRetention:z.record(z.string(),z.enum(['keep_one','delete_all'])).optional(),confirm:z.literal(true),allowUsedOnCanvas:z.boolean().default(false)},i=>cleanupCall(i,approveCleanup),{readOnly:false,destructive:true,noAccount:true});
tool('neurover_cleanup_step','Выполнить одну порцию уже одобренной очистки (до 50 файлов): повторная проверка, удаление один раз, подтверждение результата. После обрыва продолжать только тот же jobId. Не повторяет неопределённый DELETE. Неизвестные результаты требуют дальнейшей проверки.',{...cleanupId,batchSize:z.number().int().min(1).max(50).default(10),waitSeconds:z.number().int().min(0).max(20).default(10)},i=>cleanupCall(i,stepCleanup),{readOnly:false,destructive:true,noAccount:true});
tool('neurover_cleanup_start','Запустить уже одобренную очистку в отдельном локальном процессе: порции по 10, ожидание и проверки без участия модели. Переживает закрытие MCP; после перезагрузки компьютера продолжить тот же jobId. При нерешённой ошибке останавливается, результат читать через cleanup_status.',cleanupId,i=>cleanupCall(i,(c,i)=>startCleanup(c,i.jobId)),{readOnly:false,destructive:true,noAccount:true});
tool('neurover_cleanup_status','Короткий статус сохранённой очистки; не скачивает оригиналы и не удаляет файлы.',cleanupId,i=>cleanupCall(i,(c,i)=>cleanupStatus(c,i.jobId)),{noAccount:true});
tool('neurover_cleanup_approve_files','Зафиксировать точные ID отдельных файлов из готового снимка. Нужно отдельное согласие пользователя, confirm=true и expectedUpdatedAt из статуса. SHA не нужен. Файлы на полотнах и с ограничениями защищены. Не отправляет удаление; далее cleanup_start. Повтор той же зафиксированной выборки возвращает прежний план.',{...cleanupId,mediaAssetIds:z.array(id).min(1).max(10000),confirm:z.literal(true),expectedUpdatedAt:z.string().min(1)},i=>cleanupCall(i,approveFiles),{readOnly:false,destructive:true,noAccount:true});
tool('neurover_cleanup_new','Начать новый разбор после завершённой или отменённой очистки. Сохраняет историю, обновляет все типы файлов в фоне, ничего не удаляет. Повтор возвращает то же следующее задание.',cleanupId,i=>cleanupCall(i,async(c,i)=>{const next=await nextCleanup(c,i.jobId);return next.status==='scanning'?startScan(c,next.jobId):next;}),{readOnly:false,noAccount:true});
tool('neurover_cleanup_pause','Остановить дальнейшие порции после текущего запроса. Уже отправленное удаление не отменяется.',cleanupId,i=>cleanupCall(i,(c,i)=>pauseCleanup(c,i.jobId)),{readOnly:false,noAccount:true});
tool('neurover_cleanup_cancel','Остановить оставшуюся очистку. Уже отправленное удаление сначала нужно проверить через cleanup_step.',cleanupId,i=>cleanupCall(i,(c,i)=>cancelCleanup(c,i.jobId)),{readOnly:false,noAccount:true});
tool('neurover_add_node','Добавить узел; генерация не запускается.',{...wf,type:z.enum(['text','image','video','audio']),name:z.string().optional(),modelId:id.optional(),position:position.optional()},async(i,c)=>{
 let model=null;if(i.type!=='text')model=await resolveModel(c,i.workflowId,{modelId:i.modelId,type:i.type});
 return c.mutateWorkflow(i.workflowId,'/nodes','POST',{type:i.type,title:i.name||i.type,ai_model_id:model?.id??null,position:i.position||{x:100,y:100},size:{width:320,height:240},prompt:'',settings:model?settingsFor(model):{},references:[],output:{}});
},{readOnly:false});
tool('neurover_set_text_node','Сохранить содержимое текстового узла.',{...node,text:z.string()},async(i,c)=>{const w=await c.workflow(i.workflowId);if(w.workflow.graph.nodes.find(n=>n.id===i.nodeId)?.type!=='text')throw new ApiError('invalid_node','Select a text node.');return c.mutateWorkflow(i.workflowId,`/nodes/${i.nodeId}`,'PATCH',{prompt:i.text});},{readOnly:false});
tool('neurover_rename_node','Переименовать узел.',{...node,name:z.string().min(1)},(i,c)=>c.mutateWorkflow(i.workflowId,`/nodes/${i.nodeId}`,'PATCH',{title:i.name}),{readOnly:false});
tool('neurover_update_node','Изменить параметры, положение, размер или промпт узла; генерация не запускается.',{...node,changes:json},(i,c)=>c.mutateWorkflow(i.workflowId,`/nodes/${i.nodeId}`,'PATCH',i.changes),{readOnly:false});
for(const action of ['duplicate','restore-last-success','cancel'])tool('neurover_node_'+action.replaceAll('-','_'),'Выполнить '+action+' для узла.',node,(i,c)=>c.mutateWorkflow(i.workflowId,`/nodes/${i.nodeId}/${action}`,'POST',{}),{readOnly:false});
tool('neurover_delete_node','Удалить узел с явным подтверждением.',{...node,confirm:z.literal(true)},(i,c)=>c.mutateWorkflow(i.workflowId,`/nodes/${i.nodeId}`,'DELETE',{}),{readOnly:false,destructive:true});
tool('neurover_connect_nodes','Соединить узлы по точным handles из графа/схемы модели.',{...wf,sourceNodeId:id,targetNodeId:id,sourceHandle:z.string().min(1),targetHandle:z.string().min(1)},(i,c)=>c.mutateWorkflow(i.workflowId,'/edges','POST',{source_node_id:i.sourceNodeId,target_node_id:i.targetNodeId,source_handle:i.sourceHandle,target_handle:i.targetHandle,type:'derived_from',metadata:{created_from:'mcp',reference_field:i.targetHandle.startsWith('in:')?i.targetHandle.slice(3):null}}),{readOnly:false});
tool('neurover_delete_edge','Удалить связь узлов.',{...wf,edgeId:id,confirm:z.literal(true)},(i,c)=>c.mutateWorkflow(i.workflowId,`/edges/${i.edgeId}`,'DELETE',{}),{readOnly:false,destructive:true});
tool('neurover_add_media_to_workflow','Добавить существующее медиа в узел без повторной загрузки.',{...wf,mediaAssetId:id,position:position.optional()},async(i,c)=>{const {media}=await c.http(`/workflows/${i.workflowId}/media-library/${i.mediaAssetId}/access`);return c.mutateWorkflow(i.workflowId,'/nodes','POST',{type:'asset',title:media.name,position:i.position||{x:100,y:100},size:{width:320,height:240},prompt:'',settings:{},references:[],output:{media_asset_id:media.id,mime_type:media.mime_type,size_bytes:media.size_bytes,preview_label:media.name}});},{readOnly:false});
const generationSchema={...wf,modelId:id.optional(),model:z.string().optional(),type:z.enum(['image','video','audio','text']).optional(),prompt:z.string().min(1),settings:json.optional(),mode:z.string().optional(),aspectRatio:z.string().optional(),resolution:z.string().optional(),quality:z.string().optional(),durationSeconds:z.number().positive().optional(),outputFormat:z.string().optional(),references:z.array(z.object({mediaAssetId:id.optional(),filePath:z.string().optional(),kind:z.enum(['image','video','audio']).optional(),field:z.string().optional(),role:z.string().optional()})).optional()};
tool('neurover_prepare_generation','Подготовить HTTP-запрос и получить актуальную цену; НЕ запускает генерацию. Референсы принимаются по mediaAssetId или filePath; файлы автоматически проверяются на дубли без участия модели. В промте ссылайся на референсы метками @ref_1, @ref_2… (номер = позиция в references); MCP сам подставит имена плиток сайта (@image_1…). Старые @image_N перенумеровываются с предупреждением. Ответ: finalPrompt ровно как уйдёт, таблица references (метка → mediaAssetId → файл → плитка → поле/кадр), settings и settingsNotSent (скрытые сайтом поля, например aspect_ratio в first-frame), expectedOutput и warnings. Ошибки до оплаты: метка без референса, лимиты модели (число файлов для режима, размер, MIME, пиксели).',generationSchema,(i,c)=>prepare(c,i),{readOnly:false});
tool('neurover_prepare_run','Получить цену запуска узла, его зависимостей или всего полотна. Не запускает генерацию.',{...wf,scope:z.enum(['target','dependencies','all']).default('target'),nodeId:id.optional()},(i,c)=>{if(i.scope!=='all'&&!i.nodeId)throw new ApiError('node_required','Choose a start node.');return prepareJob(c,i,'workflow_run');},{readOnly:false});
tool('neurover_prepare_prompt_enhancement','Оценить платное улучшение промпта узла, без запуска. Запуск — через submit_generation с лимитом.',node,(i,c)=>prepareJob(c,i,'prompt_enhancement'),{readOnly:false});
tool('neurover_submit_generation','Платный запуск подготовленного запроса один раз; maxCredits обязателен. Не повторять при неопределённом результате.',{token:z.string().uuid(),maxCredits:z.number().finite().nonnegative(),details:z.boolean().default(false)},async i=>{const item=await loadDraft(i.token);const account=await selectAccount(item.account);const r=await serial(account,async()=>(item.kind?submitJob:submit)(await clientFor(account),i.token,i.maxCredits));return i.details?r:submissionSummary(r);},{readOnly:false,noAccount:true});
tool('neurover_draft_view','Посмотреть сохранённый MCP-черновик: итоговый промт, таблица референсов, settings и предупреждения — ровно то, что уйдёт на сервер.',{token:z.string().uuid()},async i=>{const d=await loadDraft(i.token);if(d.kind)return d;return {token:i.token,account:d.account,workflowId:d.workflowId,modelId:d.modelId,model:d.modelName,requestId:d.requestId,createdAt:new Date(d.createdAt).toISOString(),originalPrompt:d.originalPrompt,...draftReport(d)};},{noAccount:true});
const messages=async(c,i)=>c.http(`/workflows/${i.workflowId}/messages`+query({limit:i.limit||30,before_id:i.beforeId}));
// Server snapshot references when present; otherwise the local MCP journal of what was actually sent.
function sentReferences(m,journal){
 const server=m.input?.references||[];const seen={image:0,video:0,audio:0};
 if(server.length)return {source:'server',references:server.map(r=>({mediaAssetId:r.media_asset_id,name:r.name,field:r.field,role:r.reference_role,tile:'@'+(r.media_type||'image')+'_'+(++seen[r.media_type||'image'])}))};
 const id=journal.byMessage[m.id];const e=id&&journal.requests[id];
 if(e)return {source:'mcp_journal',requestId:e.requestId,references:(e.referenceTable||[]).map(r=>({mediaAssetId:r.mediaAssetId,name:r.name,field:r.field,role:r.role,tile:r.tile,frame:r.frame}))};
 return {source:server.length===0&&m.input?'server_empty':'unknown',references:[]};
}
tool('neurover_generations','История сообщений и генераций с server ID, результатами и ценой. referencesSent — реально отправленные референсы (снимок сервера или локальный журнал MCP, если сервер их не сохранил), с именами плиток.',{...wf,limit:z.number().int().min(1).max(50).optional(),beforeId:id.optional(),details:z.boolean().default(false)},async(i,c)=>{const r=await messages(c,i);const journal=await readJournal(c.account,i.workflowId);
 if(i.details)return {...r,messages:r.messages.map(m=>{const sent=sentReferences(m,journal);const e=journal.requests[journal.byMessage[m.id]];return {...m,referencesSent:sent,...(e?{mcpJournal:e}:{})};})};
 return {messages:r.messages.map(m=>({...generationSummary(m),role:m.role,promptPreview:m.role==='user'?m.body?.slice(0,120):undefined,settings:m.input?.settings,referencesSent:sentReferences(m,journal)})),pagination:r.pagination};});
async function generation(c,i){if(i.nodeId){const w=await c.workflow(i.workflowId);const n=w.workflow.graph.nodes.find(n=>n.id===i.nodeId);if(!n)throw new ApiError('not_found','Node not found.');return n;}
 const m=await c.http(`/workflows/${i.workflowId}/messages/status`+query({'ids[]':i.messageId}));const g=m.messages?.find(m=>m.id===i.messageId);if(!g)throw new ApiError('not_found','Message not found.');return g;}
const statusSchema={...wf,messageId:id.optional(),nodeId:id.optional(),details:z.boolean().default(false)};
function ensureSelector(i){if(!i.messageId&&!i.nodeId)throw new ApiError('selector_required','Provide messageId or nodeId.');}
const withChecks=async(c,i,g,body)=>{if(!i.messageId||g.status!=='completed')return body;const w=await orientationWarnings(c,i.workflowId,g).catch(()=>[]);return w.length?{...body,warnings:w}:body;};
tool('neurover_wait_generation','Ждать конкретную генерацию до 45 секунд, без повторного запуска. По завершении сверяет ширину/высоту с ожидаемым aspect_ratio или первым кадром; при расхождении warnings[].code=ORIENTATION_MISMATCH с параметрами запроса.',{...statusSchema,timeoutSeconds:z.number().int().min(0).max(45).default(45)},async(i,c)=>{ensureSelector(i);const end=Date.now()+i.timeoutSeconds*1000;let g;do{g=await generation(c,i);if(['completed','failed','cancelled','moderated','awaiting_payment','review'].includes(g.status))return withChecks(c,i,g,i.details?g:generationSummary(g));if(Date.now()+1500>=end)break;await new Promise(r=>setTimeout(r,1500));}while(Date.now()<end);return i.details?{...g,timedOut:true}:generationSummary({...g,timedOut:true});});
tool('neurover_download_generation','Скачать завершённый результат по messageId/nodeId или точному mediaAssetId.',{...statusSchema,mediaAssetId:id.optional(),outputDir:z.string().min(1),fileName:z.string().optional()},async(i,c)=>{let asset=i.mediaAssetId,g;if(!asset){ensureSelector(i);g=await generation(c,i);if(g.status!=='completed')throw new ApiError('not_completed','Wait for completion.');asset=g.primary_media_asset_id||g.outputs?.[0]?.media_asset_id||g.outputs?.[0]?.id;}if(!asset)throw new ApiError('result_required','Choose mediaAssetId from generation outputs.');const saved=await download(c,{...i,mediaAssetId:asset});return g?withChecks(c,i,g,saved):saved;},{readOnly:false});
tool('neurover_reset_context','Сбросить контекст выбранной модели в чате полотна.',{...wf,modelId:id,confirm:z.literal(true)},(i,c)=>c.http(`/workflows/${i.workflowId}/messages/context/reset`,{method:'POST',data:{ai_model_id:i.modelId,reset_request_id:crypto.randomUUID()}}),{readOnly:false});
const paidRoutes=new Set(['client.workflows.messages.store','client.workflows.runs.store','client.workflows.runs.budget.update','client.workflows.runs.steps.retry','client.workflows.prompt-enhancements.store','client.workflows.assistant-actions.store']);
function routePath(name,params={},q={}){
 const route=routes[name];if(!route)throw new ApiError('unknown_route','Route is not in the client allowlist.');
 const uri=route.uri.replace(/\{([^}]+)\}/g,(_,key)=>{if(params[key]===undefined||!/^[\w-]+$/.test(String(params[key])))throw new ApiError('missing_parameter',`Provide route parameter ${key}.`);return encodeURIComponent(String(params[key]));});return '/'+uri.replace(/^\//,'')+query(q);
}
tool('neurover_api_catalog','Каталог обнаруженных клиентских API. Наличие маршрута ещё не означает live-проверку его payload.',{},()=>({routes:Object.entries(routes).map(([name,r])=>({name,path:r.uri,methods:r.methods,paid:paidRoutes.has(name)}))}),{noAccount:true});
tool('neurover_api_read','Прочитать любой GET-маршрут из клиентского allowlist; page=true для Inertia props.',{account,route:z.string(),params:json.optional(),query:json.optional(),page:z.boolean().default(false)},(i,c)=>{if(!routes[i.route]?.methods.includes('GET'))throw new ApiError('invalid_method','Select a GET route.');const p=routePath(i.route,i.params,i.query);return i.page?c.page(p):c.http(p);});
tool('neurover_api_write','Расширенные операции по обнаруженному клиентскому маршруту. Точные payload — из схемы/исследования; платные запуски доступны только через prepare/submit.',{account,route:z.string(),params:json.optional(),method:z.enum(['POST','PATCH','PUT','DELETE']),data:json.default({}),expectedWorkflowVersion:z.number().int().nonnegative().optional(),confirm:z.boolean().optional()},(i,c)=>{const r=routes[i.route];if(!r||!r.methods.includes(i.method))throw new ApiError('invalid_method','Method does not match allowed route.');if(i.route==='client.workflows.media-library.destroy'){const ids=i.data.media_asset_ids;if(!Array.isArray(ids)||!ids.length||ids.length>50||ids.some(x=>!Number.isSafeInteger(x)||x<=0)||!i.confirm)throw new ApiError('confirmation_required','Provide 1–50 media IDs and confirm=true.');return (async()=>{const wf=Number(i.params?.workflowProject);const r=await c.http(`/workflows/${wf}/media-library/deletion-preview`,{method:'POST',data:{media_asset_ids:ids}});const ms=[];for(const item of r.preview?.items||[]){const {media}=await c.http(`/media-library/${item.id}/access`);ms.push({id:item.id,name:item.name,media_type:media.mime_type?.split('/')[0]});}if(ms.length!==ids.length)throw new ApiError('preview_incomplete','Preview did not match the request.');const all=[];for(const kind of new Set(ms.map(m=>m.media_type)))for await(const m of library(c,kind))if(ids.includes(m.id))all.push(m);if(all.length!==ids.length)throw new ApiError('preview_incomplete','Requested media not found.');return deleteExact(c,{workflowId:wf,dryRun:false,confirm:true},all);})();} if(paidRoutes.has(i.route))throw new ApiError('paid_route_blocked','Use the protected prepare/submit generation tools; chain budgets require a dedicated implementation.');if(i.method==='DELETE'&&!i.confirm)throw new ApiError('confirmation_required','Deletion requires confirm=true.');return c.http(routePath(i.route,i.params),{method:i.method,data:i.data,version:i.expectedWorkflowVersion});},{readOnly:false,destructive:true});
for(const sig of ['SIGINT','SIGTERM'])process.on(sig,async()=>{await closeAuthBrowsers();await closeClients();process.exit(0);});
await server.connect(new StdioServerTransport());
