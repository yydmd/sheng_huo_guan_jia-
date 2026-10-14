'use strict';

const DrawingManagerUI = (() => {
  let drawings = [], query = '', source = 'all', filter = 'all', sort = 'updated', layout = 'grid', page = 1, selected = new Set(), busy = false;
  const thumbnailJobs = new Set(); let thumbnailQueue = Promise.resolve();
  const date = value => value ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '时间未知';
  async function load() { const result = await LifeDrawings.load(); drawings = result.drawings; selected = new Set([...selected].filter(id => drawings.some(d => d.id === id))); }
  function visible() {
    const term = query.trim().toLocaleLowerCase();
    return drawings.filter(d => (!term || (d.title + ' ' + d.searchText).toLocaleLowerCase().includes(term)) &&
      (filter !== 'favorite' || d.favorite) && (filter !== 'recent' || d.lastOpenedAt) &&
      (source === 'all' || (source === 'independent' ? !d.sources.length : d.sources.some(s => s.moduleId === source))))
      .sort((a, b) => sort === 'name' ? a.title.localeCompare(b.title, 'zh-CN') :
        String((filter === 'recent' ? b.lastOpenedAt : sort === 'created' ? b.createdAt : b.updatedAt) || '').localeCompare(String((filter === 'recent' ? a.lastOpenedAt : sort === 'created' ? a.createdAt : a.updatedAt) || '')) || a.id.localeCompare(b.id));
  }
  function card(d) {
    const sources = d.sources.map(s => s.moduleName + ' / ' + s.title).join('\n') || '独立画布';
    return `<article class="canvas-card ${selected.has(d.id) ? 'selected' : ''}" data-canvas-id="${d.id}">
      <div class="canvas-card-image"><button class="canvas-preview-open" data-canvas-action="open" data-id="${d.id}" aria-label="打开画布：${escapeHtml(d.title)}"><span class="canvas-preview-placeholder">${d.error ? '画布暂时无法读取' : '画布预览'}</span>${d.error ? '' : `<img loading="lazy" data-canvas-thumb="${d.id}" src="/api/drawings/${d.id}/thumbnail?r=${d.revision}" alt="${escapeHtml(d.title)}的预览" />`}</button>
      <input class="canvas-select" type="checkbox" data-canvas-select="${d.id}" aria-label="选择${escapeHtml(d.title)}" ${selected.has(d.id) ? 'checked' : ''}></div>
      <div class="canvas-card-info"><div class="canvas-card-title"><button data-canvas-action="open" data-id="${d.id}">${escapeHtml(d.title)}</button>${LifeDrawings.manager.pinnedIds.includes(d.id) ? '<span class="canvas-pin-badge">已悬挂</span>' : ''}</div>
      <div class="canvas-source" title="${escapeHtml(sources)}">${escapeHtml(sources.split('\n')[0])}${d.sources.length > 1 ? ` 等 ${d.sources.length} 处` : ''}</div><small>${d.error ? escapeHtml(d.error) : date(d.updatedAt) + ' 更新'}</small>
      <div class="canvas-card-actions"><button data-canvas-action="favorite" data-id="${d.id}" aria-label="${d.favorite ? '取消收藏' : '收藏'}" aria-pressed="${d.favorite}" ${d.error ? 'disabled' : ''}>${d.favorite ? '★' : '☆'}</button>
      <details class="canvas-menu"><summary aria-label="画布更多操作">•••</summary><div>
      <button data-canvas-action="open" data-id="${d.id}">打开画布</button><button data-canvas-action="pin" data-id="${d.id}" ${d.error ? 'disabled' : ''}>${LifeDrawings.manager.pinnedIds.includes(d.id) ? '解除悬挂' : '悬挂到顶部'}</button>
      <button data-canvas-action="rename" data-id="${d.id}" ${d.error ? 'disabled' : ''}>重命名</button><button class="canvas-danger" data-canvas-action="delete" data-id="${d.id}">删除画布</button></div></details></div></div></article>`;
  }
  function render() {
    const list = visible(), pages = Math.max(1, Math.ceil(list.length / 24)); page = Math.min(page, pages);
    const slice = list.slice((page - 1) * 24, page * 24);
    const modules = new Map(drawings.flatMap(d => d.sources.map(s => [s.moduleId, s.moduleName])));
    $('#app').innerHTML = `<section class="page canvas-manager ${busy ? 'canvas-busy' : ''}">
      <div class="canvas-manager-toolbar"><input id="canvasSearch" type="search" placeholder="搜索画布名称、内容…" aria-label="搜索画布" value="${escapeHtml(query)}">
      <select id="canvasSource" aria-label="画布来源"><option value="all">全部来源</option><option value="independent">独立画布</option>${[...modules].map(([id, label]) => `<option value="${escapeHtml(id)}">${escapeHtml(label)}</option>`).join('')}</select>
      <select id="canvasSort" aria-label="排序"><option value="updated">最近更新</option><option value="created">最近创建</option><option value="name">名称排序</option></select>
      <button class="button primary" data-canvas-action="create"><i data-lucide="plus"></i>新建画布</button></div>
      <div class="canvas-manager-filters"><div>${[['all', '全部画布 ' + drawings.length], ['recent', '最近使用'], ['favorite', '已收藏']].map(([id, label]) => `<button class="button ${filter === id ? 'canvas-filter-active' : 'ghost'}" data-canvas-filter="${id}">${label}</button>`).join('')}</div>
      <div><button class="icon-button ${layout === 'grid' ? 'canvas-filter-active' : ''}" data-canvas-layout="grid" aria-label="网格视图"><i data-lucide="layout-grid"></i></button><button class="icon-button ${layout === 'list' ? 'canvas-filter-active' : ''}" data-canvas-layout="list" aria-label="列表视图"><i data-lucide="list"></i></button></div></div>
      <div class="canvas-batch"><label><input id="canvasSelectPage" type="checkbox" ${slice.length && slice.every(d => selected.has(d.id)) ? 'checked' : ''}> 选择本页</label><span>${selected.size ? `已选择 ${selected.size} 张` : '批量管理'}</span>${selected.size ? '<button class="button ghost small canvas-danger" data-canvas-action="delete-selected">删除所选</button>' : ''}<span class="canvas-count">共 ${list.length} 个画布</span></div>
      ${slice.length ? `<div class="canvas-cards ${layout === 'list' ? 'canvas-list' : ''}">${slice.map(card).join('')}</div>` : emptyState('panels-top-left', drawings.length ? '没有符合条件的画布' : '还没有画布', drawings.length ? '试试其他关键词或来源。' : '新建独立画布，或在文章里插入画图。')}
      <div class="canvas-pagination"><button class="button ghost small" data-canvas-page="${page - 1}" ${page === 1 ? 'disabled' : ''}>上一页</button><span>${page} / ${pages}</span><button class="button ghost small" data-canvas-page="${page + 1}" ${page === pages ? 'disabled' : ''}>下一页</button></div></section>`;
    $('#canvasSource').value = source; $('#canvasSort').value = sort;
    $('#canvasSearch').oninput = event => { query = event.target.value; page = 1; const at = event.target.selectionStart; render(); const field = $('#canvasSearch'); field.focus(); field.setSelectionRange(at, at); };
    $('#canvasSource').onchange = event => { source = event.target.value; page = 1; render(); };
    $('#canvasSort').onchange = event => { sort = event.target.value; page = 1; render(); };
    $('#canvasSelectPage').onchange = event => { slice.forEach(d => event.target.checked ? selected.add(d.id) : selected.delete(d.id)); render(); };
    document.querySelectorAll('[data-canvas-select]').forEach(input => input.onchange = () => { input.checked ? selected.add(input.dataset.canvasSelect) : selected.delete(input.dataset.canvasSelect); render(); });
    document.querySelectorAll('[data-canvas-thumb]').forEach(img => {
      img.onload = () => { img.parentElement.querySelector('.canvas-preview-placeholder').hidden = true; };
      img.onerror = () => { img.hidden = true; generateThumbnail(img.dataset.canvasThumb); };
      if (img.complete) img.naturalWidth ? img.onload() : img.onerror();
    });
    renderIcons();
  }
  function generateThumbnail(id) {
    const drawing = drawings.find(d => d.id === id); if (!drawing || drawing.error) return;
    const key = id + ':' + drawing.revision; if (thumbnailJobs.has(key)) return; thumbnailJobs.add(key);
    thumbnailQueue = thumbnailQueue.catch(() => {}).then(() => new Promise(resolve => {
      const frame = document.createElement('iframe'), token = crypto.randomUUID(); frame.className = 'canvas-thumbnail-worker'; frame.title = '生成画布预览'; frame.tabIndex = -1;
      const finish = () => { clearTimeout(timer); window.removeEventListener('message', received); frame.remove(); resolve(); };
      const received = event => {
        if (event.origin !== location.origin || event.source !== frame.contentWindow || event.data?.channel !== 'life-thumbnail' || event.data.token !== token) return;
        if (event.data.ok) document.querySelectorAll('[data-canvas-thumb="' + id + '"]').forEach(img => { img.hidden = false; img.src = '/api/drawings/' + id + '/thumbnail?r=' + drawing.revision; });
        finish();
      };
      const timer = setTimeout(finish, 30000); window.addEventListener('message', received);
      frame.src = '/drawing/thumbnail.html?id=' + id + '&token=' + token; document.body.append(frame);
    }));
  }
  function rename(id) {
    const drawing = drawings.find(d => d.id === id);
    $('#modalEyebrow').textContent = '画布管理'; $('#modalTitle').textContent = '重命名画布';
    $('#modalBody').innerHTML = `<label>画布名称<input class="input" id="canvasRenameInput" maxlength="100" value="${escapeHtml(drawing.title)}"></label>`;
    $('#modalActions').innerHTML = '<button class="button ghost" id="canvasRenameCancel">取消</button><button class="button primary" id="canvasRenameSave">保存</button>';
    $('#modalBackdrop').classList.remove('hidden'); $('#canvasRenameCancel').onclick = closeModal;
    $('#canvasRenameSave').onclick = async () => {
      const button = $('#canvasRenameSave'); button.disabled = true;
      try { await LifeDrawings.rename(id, $('#canvasRenameInput').value); closeModal(); await load(); render(); } catch (e) { toast(e.message, true); } finally { button.disabled = false; }
    };
    $('#canvasRenameInput').focus(); $('#canvasRenameInput').select();
  }
  document.addEventListener('click', async event => {
    if (currentView !== 'drawingManager' || busy) return;
    const filterButton = event.target.closest('[data-canvas-filter]'), layoutButton = event.target.closest('[data-canvas-layout]'), pageButton = event.target.closest('[data-canvas-page]');
    if (filterButton) { filter = filterButton.dataset.canvasFilter; page = 1; render(); return; }
    if (layoutButton) { layout = layoutButton.dataset.canvasLayout; render(); return; }
    if (pageButton && !pageButton.disabled) { page = Number(pageButton.dataset.canvasPage); render(); $('#app').scrollTop = 0; return; }
    const button = event.target.closest('[data-canvas-action]'); if (!button || button.disabled) return;
    const { canvasAction: action, id } = button.dataset;
    if (action === 'rename') { rename(id); return; }
    busy = true; button.disabled = true;
    try {
      if (action === 'open') await LifeDrawings.open(id);
      if (action === 'create') await LifeDrawings.create();
      if (action === 'pin') { LifeDrawings.manager.pinnedIds.includes(id) ? await LifeDrawings.unpin(id) : await LifeDrawings.pin(id); }
      if (action === 'favorite') await LifeDrawings.preference({ favorite: { id, value: !drawings.find(d => d.id === id).favorite } });
      if (action === 'delete' || action === 'delete-selected') { await LifeDrawings.deleteDrawings(action === 'delete' ? [id] : [...selected]); selected.clear(); }
      await load();
    } catch (e) { toast(e.message, true); }
    finally { busy = false; button.disabled = false; if (currentView === 'drawingManager') render(); }
  });
  return { load, render };
})();
