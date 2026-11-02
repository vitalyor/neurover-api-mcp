const data = JSON.parse(document.getElementById('report-data').textContent);
const isLibrary=data.view==='library';
let locked = !!data.plan || data.status !== 'ready';
const $ = selector => document.querySelector(selector);
const $$ = selector => [...document.querySelectorAll(selector)];
const escapeHTML = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const number = value => new Intl.NumberFormat('ru-RU').format(value);
const byteSize = value => { const n = Math.max(0, Number(value) || 0), index = n >= 1073741824 ? 3 : n >= 1048576 ? 2 : n >= 1024 ? 1 : 0; return new Intl.NumberFormat('ru-RU', {maximumFractionDigits: index > 1 ? 1 : 0}).format(n / 1024 ** index) + ' ' + ['Б','КБ','МБ','ГБ'][index]; };
const plurals = (n, forms) => `${number(n)} ${forms[new Intl.PluralRules('ru-RU').select(n)] || forms.other}`;
const groupsText = n => plurals(n, {one:'группа',few:'группы',many:'групп',other:'группы'});
const filesText = n => plurals(n, {one:'файл',few:'файла',many:'файлов',other:'файла'});
const icons = {
 layers:'<path d="m12 3 9 5-9 5-9-5 9-5Z"/><path d="m3 12 9 5 9-5M3 16l9 5 9-5"/>',
 grid:'<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
 gridSmall:'<path d="M3 3h4v4H3zm7 0h4v4h-4zm7 0h4v4h-4zM3 10h4v4H3zm7 0h4v4h-4zm7 0h4v4h-4zM3 17h4v4H3zm7 0h4v4h-4zm7 0h4v4h-4z"/>',
 image:'<rect x="3" y="3" width="18" height="18" rx="3"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="m21 15-5-5L6 21"/>',
 video:'<rect x="3" y="5" width="14" height="14" rx="3"/><path d="m17 10 4-3v10l-4-3"/>',
 audio:'<path d="M9 18V5l12-2v13M9 9l12-2"/><ellipse cx="6" cy="18" rx="3" ry="3"/><ellipse cx="18" cy="16" rx="3" ry="3"/>',
 checkcircle:'<circle cx="12" cy="12" r="9"/><path d="m8 12 3 3 5-6"/>',
 check:'<path d="m5 12 4 4L19 6"/>', close:'<path d="m6 6 12 12M6 18 18 6"/>',
 help:'<circle cx="12" cy="12" r="9"/><path d="M9.5 9a2.5 2.5 0 1 1 4.7 1.2c-.8.9-2.2 1-2.2 2.8M12 17h.01"/>',
 info:'<circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7h.01"/>',
 search:'<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/>',
 sort:'<path d="M4 6h16M4 12h11M4 18h6"/>',
 arrowRight:'<path d="M4 12h16m-6-6 6 6-6 6"/>',
 chevronLeft:'<path d="m15 6-6 6 6 6"/>', chevronRight:'<path d="m9 6 6 6-6 6"/>',
 copy:'<rect x="8" y="8" width="13" height="13" rx="2"/><path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3"/>',
 trash:'<path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7M14 10v7"/>',
 lock:'<rect x="5" y="10" width="14" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3M12 14v3"/>',
 shield:'<path d="m12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6l8-3Z"/><path d="m8 12 3 3 5-6"/>',
 chat:'<path d="M21 11a8 8 0 0 1-8 8H7l-4 3V11a8 8 0 0 1 8-8h2a8 8 0 0 1 8 8Z"/><path d="M7 9h10M7 13h7"/>',
 download:'<path d="M12 3v12m-5-5 5 5 5-5M4 16v5h16v-5"/>'
};
const icon = name => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icons[name] || icons.image}</svg>`;
$$('[data-icon]').forEach(el => { el.innerHTML = icon(el.dataset.icon); });
const storageKey = `neurover.cleanup.gallery.v1.${data.id}${isLibrary?'.library':''}`;
let stored = {}, storageAvailable = true;
try { stored = JSON.parse(localStorage.getItem(storageKey) || '{}') || {}; } catch { storageAvailable = false; }
const state = {...restoreState(data, stored), query:'', type:'all', filter:'all', sort:'space', limit:48, compact:!!stored.compact};
const params = new URLSearchParams(location.hash.slice(1));
state.query = params.get('q') || '';
if (['all','image','video','audio'].includes(params.get('type'))) state.type = params.get('type');
if (['all','pending','verified','protected','selected'].includes(params.get('filter'))) state.filter = params.get('filter');
if (['space','copies','oldest'].includes(params.get('sort'))) state.sort = params.get('sort');
let matches = [], openId = null, modalOrder = [], lastSelected = null, undoSnapshot = null, toastTimer;
const byId = new Map(data.groups.map(g => [g.id, g]));
const title = g => g.items.find(m => m.id === g.keepId)?.name?.trim() || g.items[0]?.name?.trim() || `Группа ${g.id}`;
const mediaTitle = {image:'Изображения',video:'Видео',audio:'Аудио'};
function save() {
  try { localStorage.setItem(storageKey, JSON.stringify({selected:[...state.selected], retention:state.retention, mode:state.mode, compact:state.compact, sourceUpdatedAt:data.updatedAt})); }
  catch { storageAvailable = false; }
  $('#saved').innerHTML = icon(storageAvailable ? 'check' : 'info') + (storageAvailable ? 'Выбор сохранён' : 'Выбор только до закрытия страницы');
}
function syncURL() {
  const p = new URLSearchParams();
  if (state.query) p.set('q', state.query);
  if (state.type !== 'all') p.set('type', state.type);
  if (state.filter !== 'all') p.set('filter', state.filter);
  if (state.sort !== 'space') p.set('sort', state.sort);
  try { history.replaceState(null, '', location.pathname + location.search + (p.size ? '#' + p : '')); } catch {}
}
function notify(message, allowUndo = false) {
  clearTimeout(toastTimer); $('#toast-text').textContent = message; $('#undo').hidden = !allowUndo; $('#toast').hidden = false;
  toastTimer = setTimeout(() => { $('#toast').hidden = true; }, allowUndo ? 9000 : 5000);
}
function changeSelection(change, message) {
  undoSnapshot = {selected:new Set(state.selected), retention:{...state.retention}};
  change(); save(); render(); if (openId) renderDetail(false);
  if (message) notify(message, true);
}
function placeholder(g) { return `<div class="no-thumb">${icon(g.items[0]?.media_type || 'image')}<span>${g.items[0]?.media_type === 'audio' ? 'Аудиофайлы' : 'Нет миниатюры'}</span></div>`; }
function card(g) {
  const kind=g.items[0]?.media_type,typeLabel={image:'Фото',video:'Видео',audio:'Аудио'}[kind]||'Файл';
  const d = disposition(g, state.retention[g.id], state.mode), name = title(g), selected = state.selected.has(g.id), all = state.retention[g.id] === 'delete_all';
  const proof = isLibrary?(protectedFile(g.items[0])?'Используется / защищён':'Защиту проверим перед удалением'):g.verified ? (g.hashSets?.length > 1 ? 'Разные SHA-варианты' : 'SHA-256 совпадает') : 'Без проверки SHA-256';
  const plan = data.plan?.items.filter(m => m.groupId === g.id);
  const done = plan?.filter(m => m.state === 'deleted').length || 0;
  return `<article class="card${selected ? ' selected' : ''}" data-id="${escapeHTML(g.id)}"><button class="media-button" data-open="${escapeHTML(g.id)}" aria-label="${isLibrary?'Открыть файл: ':'Открыть группу: '}${escapeHTML(name)}, ${filesText(g.items.length)}, ${typeLabel}">${g.image ? `<img class="card-image" src="${g.image}" alt="" width="400" height="300" loading="lazy" decoding="async">` : placeholder(g)}<span class="card-type" title="${typeLabel}" role="img" aria-label="Тип файла: ${typeLabel}">${icon(kind)}<span>${typeLabel}</span></span><span class="copies">${isLibrary?'#'+g.items[0].id:icon('copy')+filesText(g.items.length)}</span>${g.items.some(protectedFile) ? `<span class="card-protected" title="Есть защищённые файлы">${icon('lock')}</span>` : ''}</button><label class="card-select" title="${isLibrary?'Выбрать файл':'Выбрать группу'}"><input type="checkbox" data-select="${escapeHTML(g.id)}" aria-label="${isLibrary?'Выбрать файл: ':'Выбрать группу: '}${escapeHTML(name)}" ${selected ? 'checked' : ''} ${locked ? 'disabled' : ''}></label><div class="card-heading"><h2 class="card-title" dir="auto" title="${escapeHTML(name)}">${escapeHTML(name)}</h2><span class="card-size">${data.plan ? (plan?.length ? `${done}/${plan.length}` : 'Вне плана') : (isLibrary?byteSize(g.items[0].size_bytes):'до ' + byteSize(d.bytes))}</span></div><div class="card-description"><span class="status-dot ${g.verified ? 'verified' : ''}"></span>${proof}</div><button class="card-policy${all&&!isLibrary ? ' danger' : ''}" data-policy="${escapeHTML(g.id)}">${icon(isLibrary?kind:all ? 'trash' : 'copy')}${data.plan ? 'Посмотреть результат' : isLibrary?'Посмотреть файл':all ? 'Удалить все копии' : 'Оставить одну копию'}${icon('chevronRight')}</button></article>`;
}
function renderNav() {
  const entries = [['all','Все файлы','layers'],['image','Изображения','image'],['video','Видео','video'],['audio','Аудио','audio']];
  $('#collections').innerHTML = entries.map(([type,label,i]) => `<button class="nav-item${state.type === type && state.filter !== 'selected' ? ' active' : ''}" data-type="${type}" aria-label="${label}" data-nav-label="${label}" title="${label}" aria-pressed="${state.type === type && state.filter !== 'selected'}">${icon(i)}<span>${label}</span><span class="nav-count">${number(data.groups.filter(g => type === 'all' || g.items[0]?.media_type === type).length)}</span></button>`).join('');
  $('#selected-count').textContent = number(state.selected.size); $('#selected-nav').classList.toggle('active', state.filter === 'selected'); $('#selected-nav').setAttribute('aria-pressed', String(state.filter === 'selected'));
}
function renderFilters() {
  const list = isLibrary?[['all','Все файлы'],['protected','Известная защита'],['selected','Выбранные']]:[['all','Все группы'],['pending','Без SHA-проверки'],['verified','SHA проверен'],['protected','На полотнах / защита'],['selected','Выбранные']];
  $('#filters').innerHTML = list.map(([value,label]) => `<button class="filter${state.filter === value ? ' active' : ''}" data-filter="${value}" aria-pressed="${state.filter === value}">${label}<span class="filter-count">${number(filterGroups(data.groups, {...state, query:'', filter:value}).length)}</span></button>`).join('');
  $('#reset-filters').hidden = !state.query && state.type === 'all' && state.filter === 'all';
}
function renderSelection() {
  const s = selectionSummary(data.groups, state.selected, state.retention, state.mode), hidden = s.groups - matches.filter(g => state.selected.has(g.id)).length;
  $('#selection-bar').hidden = !s.groups || locked;
  $('#bar-count').textContent = `Выбрано: ${isLibrary?filesText(s.files):groupsText(s.groups)}`;
  $('#bar-size').textContent = `до ${byteSize(s.bytes)}${hidden ? ` · ${number(hidden)} вне фильтра` : ''}`;
  $('#select-all').checked = matches.length > 0 && matches.every(g => state.selected.has(g.id));
  $('#select-all').indeterminate = matches.some(g => state.selected.has(g.id)) && !$('#select-all').checked;
  $('#select-all').disabled = !matches.length || locked;
  $('#select-label').textContent = `Выбрать ${state.query || state.filter !== 'all' || state.type !== 'all' ? 'найденные' : 'все'} (${number(matches.length)})`;
  $('#review').textContent = isLibrary?'Проверить удаление':'Проверить выбор'; $('#review').insertAdjacentHTML('beforeend', icon('arrowRight'));
}
function render() {
  matches = filterGroups(data.groups, state);
  const active = document.activeElement, focusId = active?.dataset?.select, focusType = active?.dataset?.type, focusFilter = active?.dataset?.filter;
  renderNav(); renderFilters();
  $('#gallery').classList.toggle('compact', state.compact);
  $('#comfortable').classList.toggle('active', !state.compact); $('#comfortable').setAttribute('aria-pressed', String(!state.compact));
  $('#compact').classList.toggle('active', state.compact); $('#compact').setAttribute('aria-pressed', String(state.compact));
  $('#gallery').innerHTML = matches.slice(0,state.limit).map(card).join('');
  $('#result-count').textContent = isLibrary?filesText(matches.length):groupsText(matches.length);
  $('#empty').hidden = !!matches.length;
  const noGroups = !data.groups.length;
  $('#empty-title').textContent = locked && !data.plan ? 'Отчёт ещё не готов' : noGroups ? (isLibrary?'Медиатека пуста':'Лишних копий не найдено') : state.filter === 'selected' && !state.selected.size ? (isLibrary?'Здесь будут выбранные файлы':'Здесь будут выбранные группы') : 'Ничего не найдено';
  $('#empty-copy').textContent = locked && !data.plan ? 'Попросите агента продолжить проверку медиатеки и обновить отчёт.' : noGroups ? (isLibrary?'В этом снимке медиатеки файлов нет.':'В этой проверке нет файлов с одинаковыми характеристиками.') : state.filter === 'selected' && !state.selected.size ? (isLibrary?'Отметьте нужные файлы кружком на карточке.':'Вернитесь ко всем группам и отметьте нужные кружком на карточке.') : 'Попробуйте другое имя или уберите фильтры.';
  $('#empty-reset').hidden = noGroups;
  $('#empty-reset').textContent = state.filter === 'selected' ? 'Ко всем группам' : 'Сбросить фильтры';
  $('#load-more').hidden = state.limit >= matches.length;
  $('#load-more').textContent = `Показать ещё ${number(Math.min(48, Math.max(0,matches.length-state.limit)))}`;
  $('#page-count').textContent = matches.length ? `Показано ${number(Math.min(state.limit,matches.length))} из ${number(matches.length)} ${isLibrary?'файлов':'групп'}` : '';
  const total = data.groups.reduce((n,g) => n + (isLibrary?Number(g.items[0].size_bytes)||0:disposition(g,'keep_one','hash').bytes),0);
  $('#total-space').textContent = data.plan ? filesText(data.plan.items.filter(m=>m.state==='deleted').length) : byteSize(total);
  if(data.plan) $('.space-summary>span').textContent='удалено, подтверждено MCP';
  if(isLibrary){$('#select-label').textContent=`Выбрать найденные (${number(matches.length)})`;$('#bar-count').textContent=filesText(state.selected.size)+' выбрано';$('#bulk-policy').closest('label').hidden=true;$('#review').textContent='Проверить удаление';}renderSelection();if(isLibrary){$('#bar-count').textContent=filesText(state.selected.size)+' выбрано';} syncURL();
  const focusSelector = focusId ? `[data-select="${focusId}"]` : focusType ? `[data-type="${focusType}"]` : focusFilter ? `[data-filter="${focusFilter}"]` : null;
  if (focusSelector) $(focusSelector)?.focus({preventScroll:true});
}
function resetFilters() { state.query=''; state.filter='all'; state.type='all'; state.limit=48; $('#search').value=''; render(); }
function setFilter(value) { state.filter=value; state.limit=48; render(); }
function toggleGroup(id, shift = false) {
  if (locked) return;
  const checked = !state.selected.has(id), a = matches.findIndex(g => g.id === lastSelected), b = matches.findIndex(g => g.id === id);
  changeSelection(() => { const ids = shift && a >= 0 && b >= 0 ? matches.slice(Math.min(a,b),Math.max(a,b)+1).map(g=>g.id) : [id]; ids.forEach(key => checked ? state.selected.add(key) : state.selected.delete(key)); }, checked ? (isLibrary?'Файлы добавлены в выбор':'Группы добавлены в выбор') : (isLibrary?'Файлы убраны из выбора':'Группы убраны из выбора'));
  lastSelected=id;
}
function renderDetail(reset = true) {
  const g = byId.get(openId); if (!g) return;
  const m = g.items[0] || {}, pos = modalOrder.indexOf(g.id), d = disposition(g,state.retention[g.id],state.mode);
  $('#viewer-position').textContent = isLibrary?`Файл ${number(pos+1)} из ${number(modalOrder.length)}`:`Группа ${number(pos+1)} из ${number(modalOrder.length)} · ${filesText(g.items.length)}`;
  if (reset) showMedia(g,g.items.find(m=>m.id===g.keepId)||g.items[0]);
  $('#detail-type').textContent = mediaTitle[m.media_type] || 'Медиафайлы';
  $('#detail-title').textContent = isLibrary?title(g):filesText(g.items.length) + ' в группе';
  $('#detail-meta').textContent = [m.mime_type, m.width && m.height ? `${number(m.width)} × ${number(m.height)}` : null, m.duration_seconds ? `${number(m.duration_seconds)} с` : null, byteSize(m.size_bytes) + (isLibrary?'':' каждый')].filter(Boolean).join(' · ');
  $('#detail-policy').hidden=isLibrary;$('.files-heading h3').textContent=isLibrary?'Данные файла':'Файлы в группе';$('#evidence').classList.toggle('verified',!!g.verified);
  $('#evidence').innerHTML = icon(g.verified ? 'shield' : 'info') + `<span>${isLibrary?(protectedFile(m)?'Известно использование на полотне или ограничение сервера. Файл будет защищён от удаления.':'Перед удалением повторно проверим использование и ограничения сервера. SHA не требуется — вы выбираете конкретный файл.'):g.verified ? (g.hashSets?.length > 1 ? `Найдены разные оригиналы: ${number(g.hashSets.length)} SHA-варианта. Уникальные варианты в SHA-режиме сохраняются.` : 'SHA-256 оригиналов совпадает. Содержимое файлов одинаковое.') : 'Совпали характеристики оригиналов. Содержимое ещё не проверяли.'}</span>`;
  $$('#detail-policy input').forEach(input => {input.checked=input.value===state.retention[g.id];input.disabled=locked;});
  $('#files-count').textContent = number(g.items.length);
  $('.files-note').textContent=isLibrary?'Использование может измениться после создания снимка медиатеки.':data.web?'Выберите копию в списке, чтобы открыть её. Сам просмотр не доказывает совпадение.':'Изображение слева — превью одной копии, а не сравнение файлов.';
  $('#detail-policy input[value=delete_all]').closest('label').querySelector('small').textContent=state.mode==='hash'?'Защищённые и уникальные SHA-варианты сохранятся':'Защищённые файлы сохранятся; содержимое не сравниваем';
  const removeIds = new Set(d.deletable.map(x=>x.id));
  const planStates = {deleted:'Удалено',queued:'Ожидает удаления',skipped:'Пропущено',failed:'Ошибка',awaiting_confirmation:'Проверяется удаление',uncertain:'Результат неизвестен',submitting:'Запрос отправлен'};
  $('#files').innerHTML = g.items.map(item => {
    const plan = data.plan?.items.find(p=>p.id===item.id), protectedItem = protectedFile(item), removing = removeIds.has(item.id);
    const label = !plan&&isLibrary&&!protectedItem ? (state.selected.has(g.id)?'Выбран к удалению':'Не выбран') : plan ? planStates[plan.state] || 'Статус уточняется' : data.plan ? 'Вне плана' : protectedItem ? 'Защищён' : removing ? (d.provisional ? 'Кандидат' : 'К удалению') : 'Сохранить';
    const cls = plan?.state === 'failed' || plan?.state === 'uncertain' ? 'failed' : protectedItem ? 'protected' : (data.plan && !plan || !removing && !plan) ? 'keep' : '';
    return `<li class="file-item" data-asset="${item.id}"><div class="file-name" dir="auto">${escapeHTML(item.name || 'Без имени')}</div><div class="file-info"><span>#${escapeHTML(item.id)} · ${byteSize(item.size_bytes)}</span><span class="file-state ${cls}">${label}</span></div>${item.usages?.length ? `<div class="file-usage">${icon('lock')}<span>${item.usages.map(u=>escapeHTML(u.project_title || 'Полотно') + ' / ' + escapeHTML(u.node_title || 'Элемент')).join('<br>')}</span></div>` : ''}${item.blockers?.length ? `<div class="file-usage">${icon('lock')}<span>Сервер блокирует удаление</span></div>` : ''}${item.sha256 ? `<div class="file-hash">SHA-256 ${escapeHTML(item.sha256)}</div>` : ''}${item.verifyError ? `<div class="file-usage">${icon('info')}<span>Хэш не проверен: ${escapeHTML(typeof item.verifyError === 'string' ? item.verifyError : item.verifyError.message || 'ошибка загрузки оригинала')}</span></div>` : ''}${plan?.reason ? `<div class="file-usage">${icon('info')}<span>${escapeHTML(plan.reason)}</span></div>` : ''}${data.web?`<button class="file-preview quiet" data-preview="${item.id}" aria-label="${item.media_type==='audio'?'Слушать':'Посмотреть'} файл #${item.id}">${icon(item.media_type||'image')}${item.media_type==='audio'?'Слушать':item.media_type==='video'?'Смотреть видео':'Открыть оригинал'}</button>`:''}</li>`;
  }).join('');
  $('#detail-space').textContent = data.plan ? 'План очистки зафиксирован' : `До ${byteSize(d.bytes)} к освобождению`;
  $('#detail-remaining').textContent = data.plan ? 'Результат последнего обновления' : `${filesText(d.deletable.length)}${d.provisional ? ' · до SHA-проверки' : ''}${d.protected.length ? ` · защищено: ${number(d.protected.length)}` : ''}`;
  $('#detail-select').textContent = state.selected.has(g.id) ? 'Убрать из выбора' : (isLibrary?'Выбрать файл':'Выбрать группу');
  $('#detail-select').classList.toggle('is-selected',state.selected.has(g.id)); $('#detail-select').disabled=locked;
  $('#previous').disabled=pos<=0; $('#next').disabled=pos>=modalOrder.length-1;
  if (reset) $('.detail-scroll').scrollTop=0;
}
function openDetail(id, policy = false) { openId=id; modalOrder=matches.map(g=>g.id); if(!modalOrder.includes(id))modalOrder=[id]; renderDetail(); $('#detail').showModal(); if(policy&&!isLibrary)$('#detail-policy input:checked')?.focus(); }
function navigateDetail(step) { const next=modalOrder[modalOrder.indexOf(openId)+step]; if(next){openId=next;renderDetail();} }
function renderReview() {
  const s = selectionSummary(data.groups,state.selected,state.retention,state.mode);
  $('#review-summary').innerHTML = `<div><strong>${number(s.groups)}</strong><span>групп выбрано</span></div><div><strong>${number(s.remove)}</strong><span>${s.pending ? 'кандидатов к удалению' : 'файлов к удалению'}</span></div><div><strong>${byteSize(s.bytes)}</strong><span>до проверки, максимум</span></div>`;
  $$('input[name=mode]').forEach(el=>el.checked=el.value===state.mode);
  $('#hash-copy').textContent = s.pending ? `Скачаем до ${byteSize(s.hashBytes)} оригиналов выбранных групп. Сравним байты, покажем результат. Удаление пока не запускаем.` : 'Оригиналы уже проверены. Разрешение будет действовать только для совпавших SHA-256 копий; уникальные варианты сохранятся.';
  $('#risk').hidden=state.mode!=='metadata';
  $('#review-policies').innerHTML = `<div>Оставить одну копию: <strong>${groupsText(s.groups-s.all)}</strong></div><div class="${s.all?'danger-text':''}">Удалить все копии: <strong>${groupsText(s.all)}</strong></div>`;
  $('#review-list-count').textContent=`(${number(s.groups)})`;
  $('#review-groups').innerHTML=data.groups.filter(g=>state.selected.has(g.id)).map(g=>`<li>${g.image?`<img src="${g.image}" alt="" width="36" height="36" loading="lazy">`:`<span class="review-mini">${icon(g.items[0]?.media_type)}</span>`}<div><strong dir="auto">${escapeHTML(title(g))}</strong><small>${escapeHTML(g.id)} · ${filesText(g.items.length)}</small></div><span>${state.retention[g.id]==='delete_all'?'Удалить все':'Оставить одну'}</span></li>`).join('');
  $('#review-protection').textContent=s.protected ? `Защищено файлов: ${number(s.protected)}. Они останутся. Перед удалением MCP повторно проверит использование и ограничения сервера.` : 'Файлы, которые используются на полотнах или блокируются сервером, останутся. MCP повторно проверит защиту перед удалением.';
  if(data.web)renderLiveReview(s);
  if(isLibrary){$('#review-title').textContent='Удалить выбранные файлы?';$('#review-summary').innerHTML=`<div><strong>${number(s.files)}</strong><span>файлов выбрано</span></div><div><strong>${number(s.remove)}</strong><span>до удаления, максимум</span></div><div><strong>${byteSize(s.bytes)}</strong><span>можно освободить</span></div>`;$('.mode-options').hidden=true;$('.mode-options').previousElementSibling.hidden=true;$('#risk').hidden=true;$('#review-policies').hidden=true;$('.review-list summary').firstChild.textContent='Выбранные файлы ';$('#review-groups').innerHTML=data.groups.filter(g=>state.selected.has(g.id)).map(g=>`<li>${g.image?`<img src="${g.image}" alt="" width="36" height="36" loading="lazy">`:`<span class="review-mini">${icon(g.items[0].media_type)}</span>`}<div><strong dir="auto">${escapeHTML(title(g))}</strong><small>#${g.items[0].id} · ${byteSize(g.items[0].size_bytes)}</small></div><span>${protectedFile(g.items[0])?'Защищён':'Удалить'}</span></li>`).join('');$('.review-list').open=true;}
  $('#decision-output').hidden=true; $('#decision').value=''; $('#copy-decision').innerHTML=icon('copy')+'Скопировать решение';
}
$('#account').textContent=data.account;
$('#avatar').textContent=[...(data.account||'N')].slice(0,2).join('').toUpperCase();
$('#scan-summary').textContent=isLibrary?`Снимок медиатеки · ${filesText(data.scannedCount)} · защита проверяется перед удалением`:`Просмотрено ${filesText(data.scannedCount)} · найдено ${groupsText(data.groups.length)}`;
const date = new Date(data.updatedAt);
$('#scan-date').textContent=Number.isNaN(date.getTime())?'':new Intl.DateTimeFormat('ru-RU',{day:'numeric',month:'long',hour:'2-digit',minute:'2-digit'}).format(date);
$('#report-info').textContent=`Отчёт ${data.id}. ${data.plan?'План уже утверждён. Выбор не меняет утверждённое удаление.':'Состояние — на момент формирования отчёта. Для свежих данных попросите агента обновить его.'}`;
if(data.plan){$('#plan-notice').hidden=false;$('#plan-notice').textContent=`План очистки уже зафиксирован. Подтверждено удаление: ${filesText(data.plan.items.filter(m=>m.state==='deleted').length)} из ${number(data.plan.items.length)}. Статус: ${{approved:'утверждён',running:'выполняется',completed:'завершён',needs_attention:'нужно внимание',cancelled:'отменён'}[data.status]||data.status}. Для актуальных результатов попросите обновить отчёт.`;}
if(locked&&!data.plan){$('#plan-notice').hidden=false;$('#plan-notice').textContent='Проверка медиатеки ещё не завершена. Выбор и очистка станут доступны после готового отчёта. Попросите агента продолжить сканирование.';}
$('#search').value=state.query; $('#sort').value=state.sort;
$('#search').addEventListener('input',e=>{state.query=e.target.value;state.limit=48;render();});
$('#sort').addEventListener('change',e=>{state.sort=e.target.value;render();});
$('#collections').addEventListener('click',e=>{const button=e.target.closest('[data-type]');if(button){state.type=button.dataset.type;state.filter='all';state.limit=48;render();}});
$('#filters').addEventListener('click',e=>{const button=e.target.closest('[data-filter]');if(button)setFilter(button.dataset.filter);});
$('#selected-nav').onclick=()=>setFilter('selected');
$('#reset-filters').onclick=resetFilters;$('#empty-reset').onclick=resetFilters;
$('#comfortable').onclick=()=>{state.compact=false;save();render();};$('#compact').onclick=()=>{state.compact=true;save();render();};
$('#select-all').onchange=e=>{const checked=e.target.checked;changeSelection(()=>matches.forEach(g=>checked?state.selected.add(g.id):state.selected.delete(g.id)),checked?'Все найденные группы выбраны':'Выбор найденных групп снят');};
$('#gallery').addEventListener('click',e=>{const input=e.target.closest('[data-select]');if(input){toggleGroup(input.dataset.select,e.shiftKey);return;}const button=e.target.closest('[data-open],[data-policy]');if(button)openDetail(button.dataset.open||button.dataset.policy,!!button.dataset.policy);});
$('#gallery').addEventListener('error',e=>{if(e.target.matches('img')){const g=byId.get(e.target.closest('[data-id]').dataset.id);e.target.outerHTML=placeholder(g);}},true);
$('#clear-selection').onclick=()=>changeSelection(()=>state.selected.clear(),'Выбор очищен');
$('#bulk-policy').onchange=e=>{const value=e.target.value;if(value){changeSelection(()=>state.selected.forEach(id=>state.retention[id]=validRetention(value)),value==='delete_all'?'Выбранным группам назначено: удалить все копии':'Выбранным группам назначено: оставить одну копию');e.target.value='';}};
$('#load-more').onclick=()=>{state.limit+=48;render();};
$('#undo').onclick=()=>{if(!undoSnapshot)return;state.selected=new Set(undoSnapshot.selected);state.retention={...undoSnapshot.retention};undoSnapshot=null;save();render();if(openId)renderDetail(false);notify('Последнее изменение отменено');};
$$('[data-help]').forEach(button=>button.onclick=()=>$('#help-dialog').showModal());
$$('[data-close]').forEach(button=>button.onclick=()=>document.getElementById(button.dataset.close).close());
$$('dialog').forEach(dialog=>dialog.addEventListener('click',e=>{if(e.target!==dialog)return;const r=dialog.getBoundingClientRect();if(e.clientX<r.left||e.clientX>r.right||e.clientY<r.top||e.clientY>r.bottom)dialog.close();}));
$('#detail').addEventListener('close',()=>{stopMedia();const id=openId;openId=null;$(`[data-open="${id}"]`)?.focus({preventScroll:true});});
$('#previous').onclick=()=>navigateDetail(-1);$('#next').onclick=()=>navigateDetail(1);
$('#detail-select').onclick=()=>toggleGroup(openId);
$('#detail-policy').onchange=e=>{if(e.target.name==='retention'&&!locked)changeSelection(()=>{state.retention[openId]=validRetention(e.target.value);state.selected.add(openId);},'Действие сохранено, группа выбрана');};
$('#review').onclick=()=>{renderReview();$('#review-dialog').showModal();};
$$('input[name=mode]').forEach(input=>input.onchange=e=>{state.mode=e.target.value;save();render();renderReview();});
$('#copy-decision').onclick=async()=>{
  const text=decisionText(data,state);if(!text)return;
  $('#decision').value=text;$('#decision-output').hidden=false;
  let copied=false;try{if(navigator.clipboard){await navigator.clipboard.writeText(text);copied=true;}}catch{}
  if(!copied){$('#decision').focus();$('#decision').select();}
  $('#copy-decision').innerHTML=icon(copied?'check':'copy')+(copied?'Скопировано':'Повторить копирование');
  notify(copied?'Решение скопировано. Отправьте его в чат.':'Не удалось скопировать. Текст выделен — скопируйте вручную.');
  $('#decision-output').scrollIntoView({block:'nearest',behavior:'auto'});
};
$('#download-decision').onclick=()=>{const blob=new Blob([decisionText(data,state)],{type:'text/plain;charset=utf-8'}),url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download=`neurover-cleanup-${data.id}.txt`;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);};
document.addEventListener('keydown',e=>{
  const editing=/^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName), modal=$('dialog[open]');
  if(modal){if(modal.id==='detail'&&!editing&&(e.key==='ArrowLeft'||e.key==='ArrowRight')){e.preventDefault();navigateDetail(e.key==='ArrowLeft'?-1:1);}return;}
  if(editing)return;
  if(e.key==='/'){e.preventDefault();$('#search').focus();}
  if((e.metaKey||e.ctrlKey)&&e.key.toLowerCase()==='a'&&!locked){e.preventDefault();changeSelection(()=>matches.forEach(g=>state.selected.add(g.id)),'Все найденные группы выбраны');}
  if(e.key==='Escape'&&state.selected.size&&!locked)changeSelection(()=>state.selected.clear(),'Выбор очищен');
});
if(isLibrary){$('h1').textContent='Вся медиатека';$('#intro-copy').textContent='Посмотрите файлы и выберите то, что больше не нужно.';$('.space-summary>span').textContent=data.plan?'удалено, подтверждено MCP':'в этом снимке медиатеки';$('#gallery').setAttribute('aria-label','Файлы медиатеки');$('#sort').setAttribute('aria-label','Порядок файлов');$('#sort option[value=space]').textContent='Сначала крупные';$('#sort option[value=copies]').textContent='По имени';$('.page-footer>span:last-child').textContent='Выбираете конкретные файлы. Перед удалением проверим защиту; на полотнах и при ограничениях сервера файлы останутся.';$('#selection-bar').setAttribute('aria-label','Действия с выбранными файлами');}
if(isLibrary){$('#previous').setAttribute('aria-label','Предыдущий файл');$('#next').setAttribute('aria-label','Следующий файл');$('.shortcuts').innerHTML=$('.shortcuts').innerHTML.replace('Предыдущая / следующая группа','Предыдущий / следующий файл');}
$('#view-switch').hidden=!data.web;$$('[data-view]').forEach(a=>a.setAttribute('aria-current',a.dataset.view===data.view?'page':'false'));
if(!storageAvailable)$('#saved').innerHTML=icon('info')+'Выбор только до закрытия страницы';
render();
