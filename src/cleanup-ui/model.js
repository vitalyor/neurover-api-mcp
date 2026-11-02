// Shared by the browser and Node tests. Previews never count as duplicate evidence.
export const validRetention = value => value === 'delete_all' ? 'delete_all' : 'keep_one';
export const protectedFile = item => !!(item.usages?.length || item.blockers?.length);
export function disposition(group, retention = 'keep_one', mode = 'hash') {
  if(group.explicit){const candidates=group.items,deletable=candidates.filter(item=>!protectedFile(item));return {candidates,deletable,protected:candidates.filter(protectedFile),kept:[],bytes:deletable.reduce((n,m)=>n+(Number(m.size_bytes)||0),0),provisional:false};}
  const remove = new Set();
  if (mode === 'hash' && group.verified) {
    for (const ids of group.hashSets || []) {
      if (ids.length < 2) continue;
      const members = group.items.filter(item => ids.includes(item.id));
      const keeper = [...members].sort((a, b) => (b.usages?.length || 0) - (a.usages?.length || 0) || a.id - b.id)[0];
      members.forEach(item => { if (retention === 'delete_all' || item.id !== keeper?.id) remove.add(item.id); });
    }
  } else {
    group.items.forEach(item => { if (retention === 'delete_all' || item.id !== group.keepId) remove.add(item.id); });
  }
  const candidates = group.items.filter(item => remove.has(item.id));
  const deletable = candidates.filter(item => !protectedFile(item));
  return {candidates, deletable, protected: candidates.filter(protectedFile), kept: group.items.filter(item => !remove.has(item.id)), bytes: deletable.reduce((n, item) => n + (Number(item.size_bytes) || 0), 0), provisional: mode === 'hash' && !group.verified};
}
export const normalize = value => String(value ?? '').normalize('NFKC').toLocaleLowerCase('ru').replace(/ё/g, 'е');
export function filterGroups(groups, state) {
  const query = normalize(state.query).trim();
  const result = groups.filter(g => {
    if (state.type !== 'all' && g.items[0]?.media_type !== state.type) return false;
    if (state.filter === 'selected' && !state.selected.has(g.id)) return false;
    if (state.filter === 'pending' && g.verified) return false;
    if (state.filter === 'verified' && !g.verified) return false;
    if (state.filter === 'protected' && !g.items.some(protectedFile)) return false;
    return !query || normalize(g.items.map(m => `${m.name || ''} ${m.id}`).join(' ') + ' ' + g.id).includes(query);
  });
  return result.sort((a, b) => state.sort === 'copies' ? (a.explicit?normalize(a.items[0].name).localeCompare(normalize(b.items[0].name),'ru'):b.items.length - a.items.length) || a.id.localeCompare(b.id) : state.sort === 'oldest' ? Math.min(...a.items.map(m => m.id)) - Math.min(...b.items.map(m => m.id)) : disposition(b, state.retention[b.id], state.mode).bytes - disposition(a, state.retention[a.id], state.mode).bytes || a.id.localeCompare(b.id));
}
export function selectionSummary(groups, selected, retention, mode) {
  return groups.filter(g => selected.has(g.id)).reduce((s, g) => {
    const d = disposition(g, retention[g.id], mode);
    s.groups++; s.files += g.items.length; s.remove += d.deletable.length; s.bytes += d.bytes; s.protected += d.protected.length; s.pending += Number(d.provisional); s.all += Number(retention[g.id] === 'delete_all');
    s.hashBytes += g.items.filter(m => !m.sha256).reduce((n, m) => n + (Number(m.size_bytes) || 0), 0);
    return s;
  }, {groups: 0, files: 0, remove: 0, bytes: 0, protected: 0, pending: 0, all: 0, hashBytes: 0});
}
export function restoreState(data, stored = {}) {
  const ids = new Set(data.groups.map(g => g.id));
  const retention = Object.fromEntries(data.groups.map(g => [g.id, g.explicit?'delete_all':validRetention(data.plan?.retentions?.[g.id] || stored.retention?.[g.id] || data.reviewRetention?.[g.id])]));
  // A newly generated server review takes precedence over an older local choice.
  for (const [id, value] of Object.entries(data.reviewRetention || {})) if (!data.plan && ids.has(id) && stored.sourceUpdatedAt !== data.updatedAt) retention[id] = validRetention(value);
  return {selected: new Set((Array.isArray(stored.selected) ? stored.selected : []).filter(id => ids.has(id))), retention, mode: data.view==='library'?'explicit':stored.mode === 'metadata' ? 'metadata' : 'hash'};
}
export function decisionText(data, state) {
  const selected = data.groups.filter(g => state.selected.has(g.id));
  if (!selected.length || data.plan || data.status && data.status !== 'ready') return '';
  const choices = Object.fromEntries(selected.map(g => [g.id, validRetention(state.retention[g.id])]));
  const action = state.mode === 'metadata' ? 'Разрешаю выполнить выбранные действия по метаданным без проверки SHA-256; риск различий понимаю.' : selected.every(g => g.verified) ? 'Разрешаю выполнить выбранные действия только для подтверждённых SHA-256 копий. Уникальные варианты сохраняй.' : 'Сначала сравни SHA-256 оригиналов и покажи обновлённый отчёт, сохранив мой выбор действий; удаление пока не запускай.';
  return `Очистка ${data.id}. Выбраны только группы: ${selected.map(g => g.id).join(', ')}. groupRetention: ${JSON.stringify(choices)}. ${action} Используемые на полотнах файлы и заблокированные сервером файлы пропускай. Не расширяй выбор.`;
}
