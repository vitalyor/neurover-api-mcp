// Shared with the offline report: only live pages can request originals or run jobs.
let previewAssetId = null, liveStatus = null, pollTimer, statusEtag = null, polling = 0, actionBusy = false, reviewVersion = data.updatedAt, pollEpoch = 0, resultLimit = 100;
function stopMedia(suspend=false) {
  $$('#viewer-media audio, #viewer-media video, #viewer-media img[data-original]').forEach(element=>{
    const src=element.getAttribute('src');
    if(suspend&&src)element.dataset.suspendedSrc=src;else if(!suspend)delete element.dataset.suspendedSrc;
    element.pause?.();element.removeAttribute('src');element.load?.();
  });
}
function restoreMedia() {
  $$('#viewer-media [data-suspended-src]').forEach(element=>{element.setAttribute('src',element.dataset.suspendedSrc);delete element.dataset.suspendedSrc;});
}
function showMedia(group,item,original=false) {
  stopMedia();previewAssetId=item.id;
  const kind=item.media_type,src=data.web?`${data.web.base}/media/${item.id}`:null;
  $('#viewer-note').textContent=`Файл #${item.id} · ${kind==='image'&&!original?'миниатюра':'просмотр по запросу'}`;
  if(!data.web||kind==='image'&&!original){
    $('#viewer-media').innerHTML=group.image?`<div class="image-preview"><img src="${group.image}" alt="Миниатюра: ${escapeHTML(item.name)}" width="800" height="800">${data.web?`<button class="viewer-original" data-original-button>${icon('image')}Открыть оригинал</button>`:''}</div>`:placeholder(group);return;
  }
  if(kind==='image')$('#viewer-media').innerHTML=`<div class="image-preview"><img data-original src="${src}" alt="${escapeHTML(item.name)}" width="800" height="800"><span class="media-caption">Оригинал · ${byteSize(item.size_bytes)}</span></div>`;
  else if(kind==='audio')$('#viewer-media').innerHTML=`<div class="audio-preview">${icon('audio')}<h3 dir="auto">${escapeHTML(item.name||'Аудиофайл')}</h3><p>${item.duration_seconds?number(item.duration_seconds)+' с · ':''}${byteSize(item.size_bytes)}</p><audio id="media-player" controls preload="none" src="${src}" aria-label="Прослушать ${escapeHTML(item.name)}"></audio><span>Нажмите Play для прослушивания</span></div>`;
  else $('#viewer-media').innerHTML=`<video id="media-player" controls playsinline preload="none" ${group.image?`poster="${group.image}"`:''} src="${src}" aria-label="Посмотреть ${escapeHTML(item.name)}"></video>`;
  const element=$('#viewer-media audio,#viewer-media video,#viewer-media img[data-original]');
  element?.addEventListener('error',()=>{
    if($('#viewer-media .media-error'))return;
    $('#viewer-media').insertAdjacentHTML('beforeend',`<div class="media-error" role="alert"><p>Не удалось открыть файл. Возможно, он удалён, сессия истекла или формат не поддерживается браузером.</p><button class="secondary" data-media-retry>Повторить просмотр</button></div>`);
  },{once:true});
  $$('.file-preview').forEach(button=>button.setAttribute('aria-pressed',String(Number(button.dataset.preview)===item.id)));
}
$('#viewer-media').addEventListener('click',event=>{
  if(!event.target.closest('[data-original-button],[data-media-retry]'))return;
  const group=byId.get(openId),item=group?.items.find(m=>m.id===previewAssetId);if(item)showMedia(group,item,true);
});
$('#files').addEventListener('click',event=>{
  const button=event.target.closest('[data-preview]');if(!button)return;
  const group=byId.get(openId),item=group?.items.find(m=>m.id===Number(button.dataset.preview));if(item)showMedia(group,item,true);
});

function renderLiveReview(summary) {
  const verification=state.mode==='hash'&&summary.pending>0;
  $('#review-subtitle').textContent=verification?'Сначала сравнение, затем отдельное подтверждение удаления':'Последняя проверка перед удалением';
  $('.handoff').hidden=true;$('#copy-decision').hidden=true;$('#run-operation').hidden=false;
  $('#run-operation').classList.toggle('danger-primary',!verification);
  $('#run-operation').textContent=verification?'Проверить оригиналы':summary.remove?`Удалить ${filesText(summary.remove)}`:'Совпадающих копий нет';
  $('#run-consent-label').hidden=verification||!summary.remove;
  $('#run-consent').checked=false;
  $('#run-consent-copy').textContent=isLibrary?`Подтверждаю удаление выбранных файлов: ${filesText(summary.files)}. Защищённые будут пропущены. Удаление необратимо.`:state.mode==='metadata'?`Подтверждаю удаление и понимаю риск различий содержимого. К удалению: ${filesText(summary.remove)}. Отменить удаление нельзя.`:`Подтверждаю удаление копий с совпавшим SHA-256. К удалению: ${filesText(summary.remove)}. Отменить удаление нельзя.`;
  $('#run-operation').disabled=actionBusy||!verification;
  $('#review-error').hidden=true;$('#review-reload').hidden=true;reviewVersion=data.updatedAt;
}
$('#run-consent').onchange=()=>{$('#run-operation').disabled=!$('#run-consent').checked||actionBusy;};
const errors={
 cleanup_not_finished:'Предыдущая очистка ещё не завершена. Дождитесь результата или проверьте неопределённые удаления.',
 stale_review:'Отчёт изменился. Обновите его и проверьте выбор ещё раз.',forbidden_token:'Сервис был перезапущен. Обновите страницу.',verification_busy:'Проверка уже выполняется. Дождитесь результата или остановите её.',cleanup_busy:'Другая очистка этого аккаунта ещё не завершена.',verification_required:'Сначала дождитесь сравнения всех выбранных оригиналов.',no_duplicates:'В этом выборе не осталось подтверждённых копий для удаления.',login_required:'Нужно заново войти в Neurover через MCP.',session_expired:'Сессия Neurover истекла. Попросите агента обновить вход.',network_error:'Нет связи с Neurover. Прогресс сохранён.',request_uncertain:'Ответ сервера потерялся. Сначала проверим результат; повторного удаления не отправляем.',verification_stalled:'Проверка не продвинулась. Сохранённый прогресс можно продолжить.',original_incomplete:'Оригинал загрузился не полностью. Проверка остановлена без удаления.',download_failed:'Не удалось получить оригинал. Проверка остановлена.',invalid_state:'Состояние задания изменилось. Обновите страницу.',deletion_uncertain:'Результат части удалений ещё проверяется. Повторно они не отправляются.'
};
const errorText=code=>errors[code]||'Операция остановлена. Прогресс сохранён; можно проверить состояние или обратиться к агенту.';
async function postOperation(action,payload={}) {
  if(actionBusy)throw Error('busy');actionBusy=true;pollEpoch++;
  try{
    const response=await fetch(`${data.web.base}/${action}`,{method:'POST',headers:{'Content-Type':'application/json','X-Cleanup-Token':data.web.token},body:JSON.stringify(payload),signal:AbortSignal.timeout(65000)});
    const result=await response.json();if(!response.ok){const error=Error(errorText(result.error?.code));error.code=result.error?.code;throw error;}statusEtag=null;return result;
  }finally{actionBusy=false;}
}
$('#run-operation').onclick=async()=>{
  const summary=selectionSummary(data.groups,state.selected,state.retention,state.mode),verify=state.mode==='hash'&&summary.pending>0;
  if(actionBusy||!summary.groups||!verify&&!$('#run-consent').checked)return;
  const payload=isLibrary?{mediaAssetIds:[...state.selected].map(id=>byId.get(id).items[0].id),confirmed:true,expectedUpdatedAt:reviewVersion}:{groupIds:[...state.selected],groupRetention:Object.fromEntries([...state.selected].map(id=>[id,state.retention[id]]))};
  if(!verify&&!isLibrary)Object.assign(payload,{mode:state.mode,confirmed:true,riskAccepted:state.mode==='metadata',expectedUpdatedAt:reviewVersion});
  $('#run-operation').disabled=true;$('#run-operation').textContent=verify?'Запускаем проверку…':'Запускаем очистку…';$('#review-error').hidden=true;
  try{
    save();await postOperation(isLibrary?'files-delete':verify?'verify':'delete',payload);$('#review-dialog').close();locked=true;render();await pollStatus(true);
    $('#operation-panel').scrollIntoView({block:'start',behavior:'auto'});$('#operation-title').focus({preventScroll:true});
  }catch(error){
    $('#review-error').textContent=error.code?error.message:'Не получили подтверждение запуска. Проверьте состояние задания; не создавайте другую очистку.';$('#review-error').hidden=false;
    $('#review-reload').hidden=false;$('#run-operation').textContent='Проверить состояние';$('#run-operation').disabled=true;await pollStatus();
  }
};
$('#review-reload').onclick=()=>location.reload();
function renderOperation(status) {
  if(status.status==='scanning'){renderScan(status);return;}
  $('#new-cleanup').hidden=!['completed','cancelled'].includes(status.status);$('#next-cleanup-note').hidden=$('#new-cleanup').hidden;
  const v=status.verification,plan=status.plan,active=!!(plan?status.worker?.running:v?.running);
  const visible=!!(plan||v);$('#operation-panel').hidden=!visible;if(!visible)return;$('#operation-progress').hidden=false;
  $('#plan-notice').hidden=true;
  const paused=!active&&(plan?status.worker?.reason:v?.reason)==='paused';
  const completed=plan?status.status==='completed':v?.reason==='completed';
  const failed=!!plan?.items.some(m=>m.state==='failed');
  const total=plan?plan.items.length:v.totalFiles,done=plan?plan.items.filter(m=>['deleted','skipped','failed'].includes(m.state)).length:v.hashedFiles;
  $('#operation-title').textContent=plan?(completed?(failed?'Очистка завершена с ошибками':'Очистка завершена'):active?(status.pauseRequested?'Завершаем текущую порцию':'Очищаем медиатеку'):paused?'Очистка приостановлена':'Очистка требует внимания'):(completed?'Оригиналы проверены':active?(status.pauseRequested?'Останавливаем проверку':'Сравниваем оригиналы'):paused?'Проверка приостановлена':'Проверка остановлена');
  $('#operation-state').textContent=completed?(failed?'Есть ошибки':'Готово'):active?'Выполняется':paused?'Пауза':'Можно продолжить';
  $('#operation-panel').classList.toggle('operation-complete',completed&&!failed);
  $('#operation-copy').textContent=plan?`Обработано файлов: ${number(done)} из ${number(total)}. Подтверждённые удаления учитываются отдельно от ожидания сервера.`:completed?'Посмотрите уточнённый итог и отдельно подтвердите удаление.':`Сравнено файлов: ${number(done)} из ${number(total)} · скачано ${byteSize(status.downloadedOriginalBytes)}${v.currentAssetId?' · сейчас файл #'+v.currentAssetId:''}`;
  $('#operation-progress').max=Math.max(1,total);$('#operation-progress').value=done;
  const count=state=>plan?.items.filter(m=>m.state===state).length||0;
  const metrics=plan?[['Удалено',count('deleted')],['В очереди',count('queued')],['Проверяется',plan.items.filter(m=>['submitting','uncertain','awaiting_confirmation'].includes(m.state)).length],['Пропущено',count('skipped')],['Ошибки',count('failed')]]:[['Сравнено',v.hashedFiles],['Осталось',Math.max(0,v.totalFiles-v.hashedFiles)]];
  $('#operation-metrics').innerHTML=metrics.map(([label,value])=>`<div><strong>${number(value)}</strong><span>${label}</span></div>`).join('');
  $('#pause-operation').hidden=!active;$('#pause-operation').disabled=status.pauseRequested||actionBusy;
  $('#pause-operation').textContent=status.pauseRequested?'Остановка запрошена…':plan?'Остановить после порции':'Остановить после файла';
  $('#resume-operation').hidden=active||completed;$('#resume-operation').disabled=actionBusy;
  $('#resume-operation').textContent=plan?(status.uncertain?'Проверить и продолжить':'Продолжить очистку'):'Продолжить проверку';
  $('#review-verified').hidden=!!plan||!completed;
  const issue=status.lastError?.code||(!active&&!completed&&!paused?(plan?status.worker?.reason:v?.reason):null);
  $('#operation-error').hidden=!issue&&!failed;$('#operation-error').textContent=issue?errorText(issue):failed?'Часть файлов не удалена. Они остались в медиатеке; причины указаны в результатах по файлам.':'';
  $('#operation-results').hidden=!plan;
  if(plan&&$('#operation-results').open)renderOperationFiles(plan);
}
function renderScan(status){
 const active=!!status.scanner?.running,progress=status.scanProgress||{},dependencies=status.phase==='dependencies';
 $('#operation-panel').hidden=false;$('#plan-notice').hidden=true;$('#operation-panel').classList.remove('operation-complete');
 $('#operation-title').textContent=active?'Обновляем медиатеку':'Обновление остановлено';$('#operation-state').textContent=active?'Новый разбор':'Можно продолжить';
 $('#operation-copy').textContent=dependencies?`Проверено использование: ${number(progress.checkedDependencies||0)} из ${number(progress.totalDependencies||0)} файлов. Ничего не удаляем.`:`Получаем актуальный список: найдено ${filesText(status.scanned)}. Ничего не удаляем.`;
 $('#scan-summary').textContent=`Обновляем снимок медиатеки · найдено ${filesText(status.scanned)}`;$('#total-space').textContent='…';
 $('#operation-progress').hidden=false;if(dependencies){$('#operation-progress').max=Math.max(1,progress.totalDependencies||0);$('#operation-progress').value=progress.checkedDependencies||0;}else $('#operation-progress').removeAttribute('value');
 $('#operation-metrics').innerHTML='';$('#pause-operation').hidden=true;$('#review-verified').hidden=true;$('#operation-results').hidden=true;$('#new-cleanup').hidden=true;$('#next-cleanup-note').hidden=true;
 $('#resume-operation').hidden=active;$('#resume-operation').disabled=actionBusy;$('#resume-operation').textContent='Продолжить обновление';
 const issue=status.lastError?.code||(!active?status.scanner?.reason:null);$('#operation-error').hidden=!issue;$('#operation-error').textContent=issue?errorText(issue):'';
 if(!data.groups.length){$('#empty-title').textContent=active?'Обновляем список файлов':'Обновление остановлено';$('#empty-copy').textContent='Готовая медиатека появится здесь автоматически. Можно закрыть вкладку и вернуться к этому заданию.';$('#empty-reset').hidden=true;}
}
$('#new-cleanup').onclick=async()=>{
 if(actionBusy)return;$('#new-cleanup').disabled=true;$('#next-cleanup-error').hidden=true;
 try{const next=await postOperation('new');location.assign(`/jobs/${encodeURIComponent(next.jobId)}?view=library`);}
 catch(error){$('#next-cleanup-error').textContent=error.code?error.message:'Не удалось открыть новый разбор. Повторите: существующее задание будет использовано повторно.';$('#next-cleanup-error').hidden=false;$('#new-cleanup').disabled=false;}
};
function renderOperationFiles(plan) {
  const labels={deleted:'Удалено',queued:'В очереди',submitting:'Запрос отправлен',awaiting_confirmation:'Проверяется',uncertain:'Результат неизвестен',skipped:'Пропущено',failed:'Ошибка'};
  const reasons={used_on_canvas:'используется на полотне',blocked_by_dependencies:'защищён сервером',keeper_unavailable:'не удалось подтвердить сохраняемую копию',metadata_changed:'файл изменился',not_in_library:'файла уже нет в медиатеке',name_changed:'имя изменилось'};
  $('#operation-files').innerHTML=plan.items.slice(0,resultLimit).map(item=>{
    const group=byId.get(item.groupId),file=group?.items.find(m=>m.id===item.id);
    return `<li><span><strong dir="auto">${escapeHTML(file?.name||'#'+item.id)}</strong><small>#${item.id}${item.reason?' · '+escapeHTML(reasons[item.reason]||item.reason):''}</small></span><span>${labels[item.state]||'Проверяется'}</span>${group?`<button class="quiet" data-result-group="${group.id}">Детали</button>`:''}</li>`;
  }).join('')+(plan.items.length>resultLimit?`<li><button class="quiet" data-results-more>Показать ещё ${number(Math.min(100,plan.items.length-resultLimit))}</button></li>`:'');
}
$('#operation-results').ontoggle=()=>{if($('#operation-results').open&&liveStatus?.plan)renderOperationFiles(liveStatus.plan);};
$('#operation-files').onclick=event=>{if(event.target.closest('[data-results-more]')){resultLimit+=100;renderOperationFiles(liveStatus.plan);return;}const button=event.target.closest('[data-result-group]');if(button)openDetail(button.dataset.resultGroup);};
async function controlOperation(action) {
  if(actionBusy)return;
  try{await postOperation(action);await pollStatus();}catch(error){$('#operation-error').textContent=error.code?error.message:'Связь прервалась. Обновите состояние задания.';$('#operation-error').hidden=false;}
}
$('#pause-operation').onclick=()=>controlOperation('pause');$('#resume-operation').onclick=()=>controlOperation('resume');
$('#review-verified').onclick=()=>{renderReview();$('#review-dialog').showModal();};
async function pollStatus(force=false) {
  if(!data.web||polling&&!force||document.hidden)return;
  polling++;const epoch=pollEpoch;
  try{
    const response=await fetch(data.web.base,{headers:statusEtag?{'If-None-Match':statusEtag}:{},signal:AbortSignal.timeout(10000)});
    if(epoch!==pollEpoch)return;if(response.status===304){$('#connection-state').textContent='Состояние обновляется автоматически';return;}
    const status=await response.json();if(!response.ok)throw Error('status');statusEtag=response.headers.get('etag');
    if(data.status==='scanning'&&status.status==='ready'){location.reload();return;}
    if(status.verification?.reason==='completed'&&status.verification.groupIds.some(id=>byId.has(id)&&!byId.get(id).verified)){save();location.reload();return;}
    const previous=JSON.stringify([locked,data.plan?.items]),previousStatus=data.status;
    data.status=status.status;data.plan=status.plan;data.updatedAt=status.updatedAt;
    locked=!!data.plan||data.status!=='ready'||!!status.verification?.running;
    liveStatus=status;renderOperation(status);
    if(previous!==JSON.stringify([locked,data.plan?.items])||previousStatus!==data.status){render();if(openId)renderDetail(false);}
    $('#connection-state').textContent='Состояние обновляется автоматически';
  }catch{if(!liveStatus?.plan&&!liveStatus?.verification&&!liveStatus?.scanner){$('#operation-panel').hidden=false;$('#operation-title').textContent='Нет связи с локальным сервисом';$('#operation-copy').textContent='Для запуска нужно восстановить соединение. Ваш выбор сохранён в браузере.';$('#operation-progress').hidden=true;}$('#connection-state').textContent='Нет связи с локальным сервисом. Показано последнее известное состояние. Задание может продолжать выполняться.';}
  finally{polling--;clearTimeout(pollTimer);if(!polling&&!document.hidden)pollTimer=setTimeout(pollStatus,liveStatus?.worker?.running||liveStatus?.verification?.running||liveStatus?.scanner?.running?2500:10000);}
}
if(data.web){
  if(data.previousJobId){$('#previous-report').hidden=false;$('#previous-report').href=`/jobs/${encodeURIComponent(data.previousJobId)}`;}
  $('#report-info').textContent=`Отчёт ${data.id}. Страница и MCP используют одно сохранённое задание. Закрытие вкладки не останавливает работу.`;
  $('.account div>span').textContent='Локальный сервис';
  if(isLibrary){
   $$('.help-step').forEach(step=>step.remove());
   $('.help-content').insertAdjacentHTML('afterbegin','<div class="help-step"><span>'+icon('image')+'</span><div><h3>Каждая карточка — отдельный файл</h3><p>Отметьте конкретные файлы кружком. Shift выбирает диапазон, «Выбрать найденные» охватывает все результаты, включая ещё не показанные карточки. Скрытый фильтрами выбор входит в итог и указан внизу. В режиме «Похожие файлы» хранится отдельный выбор. SHA для обычного удаления не нужен.</p></div></div><div class="help-step"><span>'+icon('shield')+'</span><div><h3>Проверьте итог перед запуском</h3><p>В подтверждении перечислены точные ID, имена и размеры. Использование и ограничения проверяются снова перед удалением; защищённые или изменившиеся файлы будут пропущены.</p></div></div><div class="help-step"><span>'+icon('checkcircle')+'</span><div><h3>Следите за сохранённым заданием</h3><p>Прогресс, пропуски и ошибки появятся на странице. Закрытие вкладки не останавливает очистку. Компьютер и локальный сервис должны работать. После завершения для новой очистки попросите агента обновить снимок медиатеки.</p></div></div>');
  }
  $('.help-content').insertAdjacentHTML('afterbegin','<div class="help-step"><span>'+icon('video')+'</span><div><h3>Просмотр и очистка прямо здесь</h3><p>Откройте карточку для просмотра видео или прослушивания аудио. В списке файлов можно открыть каждую копию отдельно. Плеер получает поток только для просмотра; оригиналы не сохраняются отдельными файлами. Для SHA-проверки потребуется передать полное содержимое выбранных оригиналов. Проверка и очистка идут в фоне; после SHA-проверки удаление требует отдельного подтверждения.</p></div></div>');
  $$('.help-step').forEach(el=>{const p=el.querySelector('p');if(p?.textContent.includes('Итоговый выбор отправляется в чат'))p.textContent='SHA-256 сравнивает байты оригиналов: потребуется их передать целиком. Проверка по характеристикам экономит трафик, но допускает различия. Вы запускаете выбранный шаг на странице, а MCP может прочитать то же сохранённое задание.';});
  document.addEventListener('visibilitychange',()=>{clearTimeout(pollTimer);if(document.hidden)stopMedia(true);else{restoreMedia();pollStatus();}});
  window.addEventListener('pagehide',()=>{clearTimeout(pollTimer);stopMedia();});
  pollStatus();
}
