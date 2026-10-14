'use strict';

const LifeDrawings = (() => {
  const titles = new Map(), sessions = new Map(), pending = new Map(), deleting = new Set();
  const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
  let active = null, manager = { revision: 0, pinnedIds: [] }, preferencesQueue = Promise.resolve(), libraryQueue = Promise.resolve();
  let preview = null, previewTimer = null;
  function clearPreview() { clearTimeout(previewTimer); previewTimer = null; preview?.remove(); preview = null; }
  const name = id => titles.get(id)?.title || '未命名图稿';
  const searchText = blocks => (blocks || []).filter(b => b.type === 'drawing').map(b => name(b.drawingId)).join(' ');
  const pinned = id => manager.pinnedIds.includes(id);
  const send = (source, type, extra = {}) => source?.frame.contentWindow?.postMessage({ channel: 'life-drawing', session: source.session, type, ...extra }, location.origin);
  function update(drawing) {
    if ((titles.get(drawing.id)?.revision ?? -1) > drawing.revision) return;
    titles.set(drawing.id, { ...titles.get(drawing.id), ...drawing });
    document.querySelectorAll('.drawing-link[data-drawing-id]').forEach(link => {
      if (link.dataset.drawingId === drawing.id) {
        link.querySelector('.drawing-link-label').textContent = name(drawing.id);
        link.title = name(drawing.id) + ' · 点击查看或继续编辑';
        link.setAttribute('aria-label', '打开图稿：' + name(drawing.id));
      }
    });
    renderTabs();
  }
  function adopt(result) {
    if (dataEpoch && result.dataEpoch && result.dataEpoch !== dataEpoch) {
      requireDataReload(); return { drawings: [...titles.values()], manager, dataEpoch };
    }
    if (result.manager.revision < manager.revision) return { drawings: [...titles.values()], manager, dataEpoch };
    manager = result.manager;
    const previous = new Map(titles); titles.clear();
    result.drawings.forEach(d => {
      const old = previous.get(d.id);
      titles.set(d.id, old && old.revision > d.revision ? { ...d, title: old.title, revision: old.revision, updatedAt: old.updatedAt, searchText: old.searchText ?? d.searchText } : d);
    });
    renderTabs();
    return result;
  }
  async function load() { return adopt(await api('GET', '/api/drawings/manager')); }
  function preference(change) {
    const task = preferencesQueue.catch(() => {}).then(async () => {
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const patch = typeof change === 'function' ? change(manager) : change;
          return adopt(await api('PATCH', '/api/drawings/manager', { baseRevision: manager.revision, ...patch }));
        } catch (e) { if (e.status !== 409 || attempt === 2) throw e; await load(); }
      }
    });
    preferencesQueue = task; return task;
  }
  function markup(block, key = '') {
    if (!uuid.test(block.drawingId || '')) return '';
    return '<a href="/?drawing=' + block.drawingId + '" class="drawing-link" contenteditable="false" data-drawing-id="' + block.drawingId + '"' +
      (key ? ' data-rich-block-id="' + escapeHtml(block.id) + '" data-drawing-key="' + escapeHtml(key) + '"' : '') +
      ' title="' + escapeHtml(name(block.drawingId)) + ' · 点击查看或继续编辑" aria-label="打开图稿：' + escapeHtml(name(block.drawingId)) +
      '"><span aria-hidden="true">✎</span><span class="drawing-link-label">' + escapeHtml(name(block.drawingId)) + '</span><span aria-hidden="true">↗</span></a>';
  }
  function removeSession(source) {
    if (!source) return;
    source.frame.contentWindow?.lifeDrawing?.dispose();
    send(source, 'dispose'); source.host.remove(); sessions.delete(source.id);
    if (active === source) active = null;
    for (const [id, entry] of pending) if (entry.source === source) { clearTimeout(entry.timer); entry.resolve(false); pending.delete(id); }
    renderTabs();
  }
  function dismiss() { if (active) removeSession(active); }
  function leaveForNavigation() {
    clearPreview();
    if (!active) return;
    if (pinned(active.id)) { active.host.hidden = true; active = null; renderTabs(); }
    else removeSession(active);
  }
  function context(key) {
    return { workspace: currentWorkspace, view: currentView, key, item: key ? richCurrentDefinition(key)?.getItem()?.id : null,
      bookmark: key ? richSelection(key) : null, scroll: $('#app').scrollTop,
      selectedPlanId, selectedTemplateId, selectedProblemId, selectedThoughtId, selectedHistoryKey, thoughtSurface, thoughtMode, selectedDate,
      libraries: Object.fromEntries(Object.entries(libraryRuntime).map(([id, rt]) => [id, rt.selectedId])) };
  }
  function validContext(c) {
    if (!c || c.view === 'drawingManager') return false;
    const collections = { plans: [state.plans, c.selectedPlanId], templates: [state.templates, c.selectedTemplateId], problems: [state.problems, c.selectedProblemId],
      thoughts: [state.thoughtEntries, c.item || c.selectedHistoryKey?.split(':').at(-1) || c.selectedThoughtId] };
    if (collections[c.view]) {
      const [list, id] = collections[c.view];
      return list.some(item => item.id === id) || (c.view === 'thoughts' && c.thoughtSurface === 'history' && !c.selectedHistoryKey);
    }
    if (LIBRARY_MODULES[c.view]) return libraryTemplates(c.view).some(item => item.id === c.libraries[c.view]);
    return c.view === 'settings' || isModuleView(c.view);
  }
  async function close() {
    if (!active) return true;
    const source = active;
    if (source.ready && !await flushOne(source)) return false;
    leaveForNavigation();
    const c = source.context;
    if (validContext(c)) {
      currentWorkspace = isModuleView(c.view) ? placementOfModule(c.view) : c.workspace;
      currentView = c.view;
      selectedPlanId = c.selectedPlanId; selectedTemplateId = c.selectedTemplateId; selectedProblemId = c.selectedProblemId;
      selectedThoughtId = c.selectedThoughtId; selectedHistoryKey = c.selectedHistoryKey; thoughtSurface = c.thoughtSurface; thoughtMode = c.thoughtMode; selectedDate = c.selectedDate;
      for (const [id, selectedId] of Object.entries(c.libraries)) if (libraryRuntime[id]) libraryRuntime[id].selectedId = selectedId;
      render(); $('#app').scrollTop = c.scroll;
      if (c.key && richBody(c.key)) richRestoreSelection(c.key, c.bookmark);
    } else await changeView('drawingManager');
    return true;
  }
  async function open(id, key = '', mode = 'view', library = '') {
    clearPreview();
    if (!uuid.test(id || '') || deleting.has(id)) return;
    if (currentView === 'settings' && settingsDirty) { openLeaveSettingsModal(() => open(id, key, mode, library)); return; }
    let origin = key || !sessions.has(id) ? context(key) : null;
    if (!await flushPendingSaves()) return;
    // First save assigns a real article ID to a draft; retain its pre-save caret.
    if (origin) {
      const before = origin;
      origin = { ...context(key), bookmark: before.bookmark, scroll: before.scroll };
      if (key === 'review:draft' && origin.item && origin.item !== 'draft') origin.key = 'review:' + origin.item;
    }
    if (active?.id !== id) leaveForNavigation();
    let source = sessions.get(id);
    if (!source) {
      const session = crypto.randomUUID(), host = document.createElement('section'), frame = document.createElement('iframe');
      host.className = 'drawing-host'; host.setAttribute('aria-label', '图稿画布');
      frame.title = 'Excalidraw 图稿'; frame.allow = 'clipboard-read; clipboard-write';
      frame.src = '/drawing/index.html?id=' + id + '&mode=' + mode + '&session=' + session + (library ? '&library=' + encodeURIComponent(library) : '');
      host.append(frame); $('.workspace').append(host);
      source = { id, session, host, frame, context: origin, ready: false, dirty: false, error: null, deleting: false };
      sessions.set(id, source);
    } else {
      if (origin && key) source.context = origin;
      if (library && source.ready) send(source, 'library', { url: library });
      if (mode === 'edit') send(source, 'mode', { view: false });
    }
    active = source; source.host.hidden = false; renderTabs();
    preference({ visit: id }).catch(e => toast(e.message, true));
  }
  async function pin(id) {
    await preference(m => ({ pinnedIds: m.pinnedIds.includes(id) ? m.pinnedIds : [...m.pinnedIds, id] }));
    send(sessions.get(id), 'pinned', { value: true }); renderTabs();
  }
  async function unpin(id) {
    const source = sessions.get(id);
    if (source?.ready && !await flushOne(source)) return;
    await preference(m => ({ pinnedIds: m.pinnedIds.filter(x => x !== id) }));
    removeSession(source); renderTabs();
  }
  async function create(suspend = false) {
    if (!await flushPendingSaves()) return;
    const result = await api('POST', '/api/drawings', { requestId: crypto.randomUUID(), title: '未命名画布' });
    update(result.drawing); if (suspend) await pin(result.drawing.id);
    await open(result.drawing.id, '', 'edit'); return result.drawing.id;
  }
  async function insert(key) {
    const def = richCurrentDefinition(key), rt = richEditorState(key), body = richBody(key);
    if (!def || !body || rt.composing) return;
    if (rt.drawingCreation) return rt.drawingCreation;
    const at = richSelection(key).end; rt.drawingRequestId ||= crypto.randomUUID();
    body.contentEditable = 'false'; const button = body.parentElement.querySelector('[data-insert-drawing]'); if (button) button.disabled = true;
    rt.drawingCreation = (async () => {
      try {
        const result = await api('POST', '/api/drawings', { requestId: rt.drawingRequestId, title: '未命名图稿' }); update(result.drawing);
        body.contentEditable = 'true'; richReplaceSelection(key, [{ id: richBlockId(), type: 'drawing', drawingId: result.drawing.id }], { start: at, end: at });
        rt.drawingRequestId = null; return true;
      } catch (e) { toast(e.message + '，可点击插入画图重试。', true); return false; }
      finally { body.contentEditable = 'true'; if (button) button.disabled = false; rt.drawingCreation = null; }
    })(); return rt.drawingCreation;
  }
  function flushOne(source) {
    if (!source || source.deleting) return Promise.resolve(true);
    if (!source.ready) { if (active && active !== source) active.host.hidden = true; active = source; source.host.hidden = false; renderTabs(); toast(source.error || '图稿正在加载，请稍候或返回原文。', true); return Promise.resolve(false); }
    const requestId = crypto.randomUUID();
    return new Promise(resolve => {
      const timer = setTimeout(() => { pending.delete(requestId); resolve(false); toast('图稿保存超时，请在画布中重试或导出。', true); }, 25000);
      pending.set(requestId, { source, resolve, timer }); send(source, 'flush', { requestId });
    });
  }
  async function flush() {
    await preferencesQueue.catch(() => {});
    for (const source of sessions.values()) {
      if (!await flushOne(source)) {
        if (active && active !== source) active.host.hidden = true;
        active = source; source.host.hidden = false; renderTabs(); return false;
      }
    }
    return true;
  }
  function renderTabs() {
    // Replaced tab nodes cannot emit pointerout; discard their detached hover card.
    clearPreview();
    const bar = document.getElementById('drawingTabs'); if (!bar) return;
    bar.hidden = !manager.pinnedIds.length; $('.workspace').classList.toggle('has-drawing-tabs', !bar.hidden);
    const pageTitle = document.querySelector('#topbar h1')?.textContent || '当前页面';
    bar.innerHTML = '<button class="drawing-page-tab ' + (!active ? 'active' : '') + '" data-drawing-page role="tab" aria-selected="' + !active + '">' + escapeHtml(pageTitle) + '</button>' +
      manager.pinnedIds.map(id => '<div class="drawing-tab ' + (active?.id === id ? 'active' : '') + '" draggable="true" data-tab-id="' + id + '">' +
        '<button data-drawing-open="' + id + '" role="tab" aria-selected="' + (active?.id === id) + '" title="' + escapeHtml(name(id)) + '">' +
        '<span aria-hidden="true">▧</span><span class="drawing-tab-title">' + escapeHtml(name(id)) + '</span>' +
        '<span class="drawing-tab-dot ' + (sessions.get(id)?.error ? 'error' : '') + '" aria-label="' + (sessions.get(id)?.dirty ? '未保存' : '已保存') + '">' + (sessions.get(id)?.dirty ? '●' : '') + '</span></button>' +
        '<button class="drawing-tab-close" data-drawing-unpin="' + id + '" aria-label="关闭标签：' + escapeHtml(name(id)) + '">×</button></div>').join('') +
      '<button class="drawing-tab-add" data-drawing-create aria-label="新建并悬挂画布">＋</button>';
    bar.querySelector('.drawing-tab.active')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }
  function removeReferences(value, ids, seen = new WeakSet()) {
    if (!value || typeof value !== 'object' || seen.has(value)) return; seen.add(value);
    for (const [key, child] of Object.entries(value)) {
      if (Array.isArray(child)) {
        value[key] = child.filter(b => !(b?.type === 'drawing' && ids.has(b.drawingId)));
        value[key].forEach(x => removeReferences(x, ids, seen));
      } else removeReferences(child, ids, seen);
    }
  }
  async function deleteDrawings(ids) {
    ids = [...new Set(ids)];
    for (const id of ids) { deleting.add(id); const s = sessions.get(id); if (s) { s.deleting = true; send(s, 'pause'); } }
    try {
      if (!await flushPendingSaves()) throw Error('其他内容尚未保存成功，请重试');
      const result = await api('POST', '/api/drawings/delete', { ids });
      const set = new Set(ids); removeReferences(state, set);
      for (const rt of richEditorRuntime.values()) { removeReferences(rt, set); }
      // Retry snapshots have already been flushed; discard history references too.
      for (const id of ids) removeSession(sessions.get(id));
      adopt(result); render(); return result;
    } catch (e) { for (const id of ids) { const s = sessions.get(id); if (s) { s.deleting = false; send(s, 'resume'); } } throw e; }
    finally { ids.forEach(id => deleting.delete(id)); }
  }
  async function rename(id, title) {
    if (!await flushPendingSaves()) return;
    const current = await api('GET', '/api/drawings/' + id);
    const result = await api('PATCH', '/api/drawings/' + id, { baseRevision: current.drawing.revision, title });
    update(result.drawing); send(sessions.get(id), 'metadata', { drawing: result.drawing }); return result;
  }
  function exportFailed() {
    const source = [...sessions.values()].find(s => s.error || s.dirty) || active;
    if (source) send(source, 'export');
  }
  async function librarySave(source, message) {
    const task = libraryQueue.catch(() => {}).then(async () => {
      for (let attempt = 0; attempt < 3; attempt++) {
        const current = (await api('GET', '/api/drawings/library')).library;
        const before = new Map((message.before || []).map(x => [x.id, x])), next = new Map(message.items.map(x => [x.id, x]));
        const merged = new Map(current.items.map(x => [x.id, x]));
        for (const id of before.keys()) if (!next.has(id)) merged.delete(id);
        for (const [id, item] of next) if (!before.has(id) || JSON.stringify(before.get(id)) !== JSON.stringify(item)) merged.set(id, item);
        try {
          const result = await api('PATCH', '/api/drawings/library', { baseRevision: current.revision, items: [...merged.values()] });
          for (const s of sessions.values()) send(s, 'library-sync', { library: result.library });
          send(source, 'library-saved', { requestId: message.requestId, library: result.library }); return;
        } catch (e) { if (e.status !== 409 || attempt === 2) throw e; }
      }
    });
    libraryQueue = task; try { await task; } catch (e) { send(source, 'library-saved', { requestId: message.requestId, error: e.message }); }
  }
  window.addEventListener('message', event => {
    if (event.origin !== location.origin || event.data?.channel !== 'life-drawing') return;
    const source = [...sessions.values()].find(s => event.source === s.frame.contentWindow && event.data.session === s.session);
    if (!source) return;
    const message = event.data;
    if (message.type === 'ready') { source.ready = true; send(source, 'pinned', { value: pinned(source.id) }); }
    if (message.type === 'status') { source.dirty = message.dirty; source.error = message.error; renderTabs(); }
    if (message.type === 'metadata') update(message.drawing);
    if (message.type === 'pin') pin(source.id).catch(e => toast(e.message, true));
    if (message.type === 'back' && active === source) void close();
    if (message.type === 'flushed') { const entry = pending.get(message.requestId); if (entry?.source === source) { clearTimeout(entry.timer); pending.delete(message.requestId); entry.resolve(message.ok); } }
    if (message.type === 'library-save') void librarySave(source, message);
  });
  document.addEventListener('pointerdown', event => {
    const button = event.target?.closest?.('[data-insert-drawing]');
    if (button) { event.preventDefault(); richSelection(button.dataset.insertDrawing); }
    if (event.target?.closest?.('.drawing-link')?.dataset.drawingKey) event.preventDefault();
  });
  document.addEventListener('click', event => {
    const target = event.target;
    let task;
    const insertButton = target.closest?.('[data-insert-drawing]'), link = target.closest?.('.drawing-link'), openButton = target.closest?.('[data-drawing-open]'), closeButton = target.closest?.('[data-drawing-unpin]');
    if (insertButton) { event.preventDefault(); task = insert(insertButton.dataset.insertDrawing); }
    else if (link) { event.preventDefault(); task = open(link.dataset.drawingId, link.dataset.drawingKey || '', link.dataset.drawingKey ? 'edit' : 'view'); }
    else if (closeButton) task = unpin(closeButton.dataset.drawingUnpin);
    else if (openButton) task = open(openButton.dataset.drawingOpen);
    else if (target.closest?.('[data-drawing-create]')) task = create(true);
    else if (target.closest?.('[data-drawing-page]')) task = (async () => { if (await flushPendingSaves()) leaveForNavigation(); })();
    task?.catch(e => toast(e.message, true));
  });
  document.addEventListener('keydown', event => {
    const body = event.target?.closest?.('[data-rich-body]'), link = event.target?.closest?.('.drawing-link');
    if (body && event.ctrlKey && event.altKey && !event.shiftKey && event.code === 'KeyD' && !event.isComposing) { event.preventDefault(); void insert(body.dataset.richBody); }
    if (link && event.key === 'Enter') { event.preventDefault(); link.click(); }
    if (link?.dataset.drawingKey && ['Backspace', 'Delete'].includes(event.key)) { event.preventDefault(); richRemoveImage(link.dataset.drawingKey, link.dataset.richBlockId); }
  });
  let dragged = null;
  document.addEventListener('dragstart', e => { const tab = e.target.closest?.('[data-tab-id]'); if (tab) { dragged = tab.dataset.tabId; e.dataTransfer.setData('text/plain', dragged); } });
  document.addEventListener('dragover', e => { if (dragged && e.target.closest?.('[data-tab-id]')) e.preventDefault(); });
  document.addEventListener('drop', e => {
    const id = e.target.closest?.('[data-tab-id]')?.dataset.tabId; if (!dragged || !id || dragged === id) return;
    e.preventDefault(); const moving = dragged; dragged = null;
    preference(m => { const ids = m.pinnedIds.filter(x => x !== moving); ids.splice(ids.indexOf(id), 0, moving); return { pinnedIds: ids }; }).catch(err => toast(err.message, true));
  });
  document.addEventListener('dragend', () => { dragged = null; });
  document.addEventListener('pointerover', e => {
    const tab = e.target.closest?.('[data-tab-id]'); if (!tab || document.getElementById('drawingTabs').hidden || tab.contains(e.relatedTarget) || active?.id === tab.dataset.tabId) return;
    clearPreview();
    previewTimer = setTimeout(() => {
      previewTimer = null;
      if (!tab.isConnected || !tab.matches(':hover') || document.getElementById('drawingTabs').hidden || active?.id === tab.dataset.tabId) return;
      const id = tab.dataset.tabId, d = titles.get(id); preview = document.createElement('div'); preview.className = 'drawing-tab-preview';
      preview.innerHTML = '<strong>' + escapeHtml(name(id)) + '</strong><img alt="画布预览" src="/api/drawings/' + id + '/thumbnail?r=' + (d?.revision || 0) + '"><small>' + (sessions.get(id)?.dirty ? '正在保存' : '已保存') + ' · 点击标签返回画布</small>';
      preview.querySelector('img').onerror = ev => { ev.target.hidden = true; };
      document.body.append(preview); const box = tab.getBoundingClientRect();
      preview.style.left = Math.max(8, Math.min(box.left, innerWidth - 328)) + 'px'; preview.style.top = box.bottom + 6 + 'px';
    }, 300);
  });
  document.addEventListener('pointerout', e => { const tab = e.target.closest?.('[data-tab-id]'); if (tab && !tab.contains(e.relatedTarget)) clearPreview(); });
  document.addEventListener('pointerdown', clearPreview);
  document.addEventListener('scroll', clearPreview, true);
  document.addEventListener('visibilitychange', () => { if (document.hidden) clearPreview(); });
  window.addEventListener('blur', clearPreview);
  async function receiveLibraryUrl(url) {
    const parsed = new URL(url), library = new URLSearchParams(parsed.hash.slice(1)).get('addLibrary'), id = parsed.searchParams.get('drawing');
    if (!library || !uuid.test(id || '')) return;
    const source = sessions.get(id);
    if (source?.ready) send(source, 'library', { url: library }); else await open(id, '', 'edit', library);
  }
  return { name, searchText, markup, load, open, insert, flush, close, dismiss, pin, unpin, create, preference, rename, deleteDrawings, leaveForNavigation, renderTabs, receiveLibraryUrl, exportFailed,
    get active() { return active; }, get sessions() { return sessions; }, get manager() { return manager; }, get drawings() { return [...titles.values()]; },
    get dirty() { return [...sessions.values()].some(s => !s.ready || s.dirty); } };
})();

