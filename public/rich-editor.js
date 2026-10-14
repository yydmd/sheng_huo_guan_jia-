'use strict';

// 连续编辑区保存文字、本地图片及图稿引用。上传占位、选中状态与撤销历史均只存在内存。
const richEditorDefinitions = new Map();
const richEditorRuntime = new Map();
const richImagePattern = /^[a-f0-9-]{36}\.(png|jpg|webp|gif)$/;
const richDirections = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];
let richMenu = null;
let richViewerTrigger = null;

function richBlockId() { return `r-${crypto.randomUUID()}`; }
function richImageUrl(id) { return richImagePattern.test(id || '') ? `/api/content-images/${id}` : ''; }
function richText(blocks) { return blocks.filter((b) => b.type === 'text').map((b) => b.text).join(''); }
function richCopyBlocks(event, blocks) {
  event.clipboardData.setData('application/x-life-rich-blocks', JSON.stringify(blocks));
  event.clipboardData.setData('text/plain', blocks.map((b) => b.type === 'text' ? b.text : b.type === 'drawing' ? `${LifeDrawings.name(b.drawingId)} (/?drawing=${b.drawingId})` : b.caption || '').join(''));
}
function richImageCount(blocks) { return blocks.filter((b) => b.type === 'image' || b.type === 'pending').length; }
function richWidth(block) {
  const width = block?.widthPercent == null ? 100 : Number(block.widthPercent);
  return Math.max(20, Math.min(100, Math.round(Number.isFinite(width) ? width : 100)));
}
function richClone(doc) { return doc.map((b) => ({ ...b })); }
function richLength(doc) { return doc.reduce((n, b) => n + (b.type === 'text' ? b.text.length : 1), 0); }
function richBody(key) { return document.querySelector(`[data-rich-body="${CSS.escape(key)}"]`); }
function richCurrentDefinition(key) { return richEditorDefinitions.get(key); }

function richNormalize(doc) {
  const out = [];
  const ids = new Set();
  for (const raw of doc) {
    const b = { ...raw };
    if (b.type === 'text' && out.at(-1)?.type === 'text') { out.at(-1).text += b.text; continue; }
    if (!b.id || ids.has(b.id)) b.id = richBlockId();
    ids.add(b.id); out.push(b);
  }
  if (out[0]?.type !== 'text') out.unshift({ id: richBlockId(), type: 'text', text: '' });
  if (out.at(-1)?.type !== 'text') out.push({ id: richBlockId(), type: 'text', text: '' });
  return out;
}

function richEditorState(key) {
  if (!richEditorRuntime.has(key)) richEditorRuntime.set(key, {
    doc: [], selection: { start: 0, end: 0 }, selected: null, undo: [], redo: [],
    jobs: new Map(), composing: false, before: null, item: null,
  });
  return richEditorRuntime.get(key);
}

function richEditorBlocks(definition) {
  const item = definition.getItem();
  return Array.isArray(item[definition.blocksKey]) ? item[definition.blocksKey]
    : [{ id: richBlockId(), type: 'text', text: String(item[definition.textKey] || '') }];
}

function richCombinedImageCount(definition) {
  const item = definition.getItem();
  const fields = new Set();
  let count = 0;
  for (const candidate of richEditorDefinitions.values()) {
    if (candidate.getItem() !== item || fields.has(candidate.blocksKey)) continue;
    fields.add(candidate.blocksKey);
    count += richImageCount(richEditorState(candidate.key).doc);
  }
  // 也计算当前页面尚未初始化的另一个字段，不依赖两个编辑器是否同时可见。
  for (const field of ['contentBlocks', 'descriptionBlocks', 'noteBlocks', 'blocks']) {
    if (!fields.has(field) && Array.isArray(item[field])) count += richImageCount(item[field]);
  }
  return count;
}

function richImageMarkup(definition, b) {
  const key = escapeHtml(definition.key);
  const selected = richEditorState(definition.key).selected === b.id;
  const caption = escapeHtml(b.caption || '');
  const src = (definition.imageUrl || richImageUrl)(b.imageId);
  return `<figure class="rich-image${selected ? ' is-selected' : ''}" contenteditable="false" tabindex="0" role="button" aria-label="${caption || '内容图片'}，双击查看原图，方向键调整宽度" data-rich-block-id="${escapeHtml(b.id)}" style="--rich-image-width:${richWidth(b)}%"><div class="rich-image-stage"><img src="${src}" alt="${caption || '内容配图'}" draggable="false" /><span class="rich-image-missing" hidden>图片无法读取，请检查本地图片文件。</span>${richDirections.map((direction) => `<button type="button" class="rich-resize-point point-${direction}" data-rich-resize="${direction}" data-rich-key="${key}" aria-label="${direction} 缩放点，左右方向键调整宽度" tabindex="${selected ? 0 : -1}"></button>`).join('')}</div>${caption ? `<figcaption>${caption}</figcaption>` : ''}</figure>`;
}

function richDocumentMarkup(definition) {
  return richEditorState(definition.key).doc.map((b) => {
    if (b.type === 'image') return richImageMarkup(definition, b);
    if (b.type === 'drawing') return LifeDrawings.markup(b, definition.key);
    if (b.type === 'pending') {
      const task = richEditorState(definition.key).jobs.get(b.id);
      return `<div class="rich-pending" contenteditable="false" data-rich-pending="${escapeHtml(b.id)}" role="status" aria-live="polite">${task?.error ? `<span class="save-error">${escapeHtml(task.error)}</span><button type="button" data-action="rich-retry-upload" data-rich-key="${escapeHtml(definition.key)}" data-rich-block-id="${b.id}">重试</button>` : '<span>正在保存图片到本机…</span>'}<button type="button" data-action="rich-cancel-upload" data-rich-key="${escapeHtml(definition.key)}" data-rich-block-id="${b.id}">取消</button></div>`;
    }
    return `<span data-rich-text-node="${escapeHtml(b.id)}">${b.text ? escapeHtml(b.text) : '<br data-rich-empty />'}</span>`;
  }).join('');
}

function richEditorMarkup(options) {
  const definition = { ...options, key: String(options.key) };
  richEditorDefinitions.set(definition.key, definition);
  const rt = richEditorState(definition.key);
  const item = definition.getItem();
  if (rt.item !== item) {
    for (const task of rt.jobs.values()) task.controller?.abort();
    rt.item = item; rt.doc = richNormalize(richEditorBlocks(definition));
    rt.jobs.clear(); rt.undo = []; rt.redo = []; rt.selected = null;
  }
  const id = definition.legacyId ? ` id="${escapeHtml(definition.legacyId)}"` : '';
  return `<div class="rich-editor${definition.review ? ' rich-review-editor' : ''}"${definition.shellId ? ` id="${definition.shellId}"` : ''} data-rich-editor="${escapeHtml(definition.key)}"><div class="drawing-insert-bar"><button type="button" class="button ghost small" data-insert-drawing="${escapeHtml(definition.key)}" title="在光标处插入画图链接（Ctrl+Alt+D）">✎ 插入画图</button><small>Ctrl+Alt+D</small></div><div${id} class="rich-body${definition.legacyClass ? ` ${escapeHtml(definition.legacyClass)}` : ''}" contenteditable="true" role="textbox" aria-multiline="true" aria-label="${escapeHtml(definition.label)}" data-placeholder="${escapeHtml(definition.placeholder || '')}" data-rich-empty="${rt.doc.every((b) => b.type === 'text' && !b.text)}" data-rich-body="${escapeHtml(definition.key)}">${richDocumentMarkup(definition)}</div></div>`;
}

// Enter 与粘贴均转成普通文字；遍历器仍兼容浏览器在删除/输入法中生成的段落节点。
function richReadDOM(key, root = richBody(key)) {
  const rt = richEditorState(key);
  const known = new Map(rt.doc.map((b) => [b.id, b]));
  const doc = []; let text = ''; let textId = null;
  const flush = () => { if (text || !doc.length) doc.push({ id: textId || richBlockId(), type: 'text', text }); text = ''; textId = null; };
  const walk = (node) => {
    if (node.nodeType === Node.TEXT_NODE) { text += node.data; return; }
    if (node.nodeType !== Node.ELEMENT_NODE && node.nodeType !== Node.DOCUMENT_FRAGMENT_NODE) return;
    const id = node.dataset?.richBlockId || node.dataset?.richPending;
    if (id && known.has(id)) { flush(); doc.push({ ...known.get(id) }); return; }
    if (node.tagName === 'BR') { if (!node.hasAttribute('data-rich-empty')) text += '\n'; return; }
    if (node.dataset?.richTextNode && !textId) textId = node.dataset.richTextNode;
    if (['SCRIPT', 'STYLE', 'IMG', 'BUTTON', 'FIGCAPTION'].includes(node.tagName)) return;
    if (['DIV', 'P', 'LI'].includes(node.tagName) && text && !text.endsWith('\n')) text += '\n';
    for (const child of node.childNodes) walk(child);
  };
  if (root) for (const child of root.childNodes) walk(child);
  flush(); return richNormalize(doc);
}

function richSelection(key) {
  const body = richBody(key); const sel = window.getSelection(); const rt = richEditorState(key);
  if (!body || !sel?.rangeCount || !body.contains(sel.anchorNode) || !body.contains(sel.focusNode)) return { ...rt.selection };
  const range = sel.getRangeAt(0);
  const offset = (node, at) => {
    const prefix = document.createRange(); prefix.selectNodeContents(body); prefix.setEnd(node, at);
    return richLength(richReadDOM(key, prefix.cloneContents()));
  };
  rt.selection = { start: offset(range.startContainer, range.startOffset), end: offset(range.endContainer, range.endOffset) };
  return { ...rt.selection };
}

function richCaretPoint(body, position) {
  let at = 0;
  for (let index = 0; index < body.childNodes.length; index += 1) {
    const node = body.childNodes[index];
    if (node.nodeType === Node.ELEMENT_NODE && (node.dataset.richBlockId || node.dataset.richPending)) {
      if (position <= at) return [body, index];
      at += 1; continue;
    }
    const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
    const nodes = node.nodeType === Node.TEXT_NODE ? [node] : [];
    let child; while ((child = walker.nextNode())) nodes.push(child);
    for (const leaf of nodes) { if (position <= at + leaf.data.length) return [leaf, Math.max(0, position - at)]; at += leaf.data.length; }
    if (!nodes.length && position === at && node.dataset?.richTextNode) return [node, 0];
  }
  return [body, body.childNodes.length];
}

function richRestoreSelection(key, bookmark) {
  const body = richBody(key); if (!body) return;
  const rt = richEditorState(key); const max = richLength(rt.doc);
  const start = Math.max(0, Math.min(max, bookmark?.start ?? rt.selection.start));
  const end = Math.max(start, Math.min(max, bookmark?.end ?? start));
  const range = document.createRange();
  range.setStart(...richCaretPoint(body, start)); range.setEnd(...richCaretPoint(body, end));
  body.focus({ preventScroll: true }); const sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(range);
  rt.selection = { start, end };
}

function richSnapshot(key) {
  const rt = richEditorState(key);
  return { doc: richClone(rt.doc), selection: richSelection(key), selected: rt.selected };
}

function richRecord(key, before) {
  const rt = richEditorState(key);
  if (!before || JSON.stringify(before.doc) === JSON.stringify(rt.doc)) return;
  rt.undo.push({ before, after: richSnapshot(key) });
  if (rt.undo.length > 100) rt.undo.shift(); rt.redo = [];
}

function richPublish(key) {
  const def = richCurrentDefinition(key); const rt = richEditorState(key); if (!def) return;
  const doc = richNormalize(rt.doc.filter((b) => b.type !== 'pending'));
  const item = def.getItem(); item[def.blocksKey] = richClone(doc); item[def.textKey] = richText(doc);
  const body = richBody(key); if (body) body.dataset.richEmpty = String(rt.doc.every((b) => b.type === 'text' && !b.text));
  def.onChange?.();
}

function richRefresh(key, bookmark = null) {
  const def = richCurrentDefinition(key); const body = richBody(key); if (!def || !body) return;
  const appScroll = $('#app')?.scrollTop; const pageScroll = window.scrollY;
  body.innerHTML = richDocumentMarkup(def); richBindImageErrors(body);
  body.dataset.richEmpty = String(richEditorState(key).doc.every((b) => b.type === 'text' && !b.text));
  if (bookmark) richRestoreSelection(key, bookmark);
  if ($('#app') && appScroll !== undefined) $('#app').scrollTop = appScroll;
  window.scrollTo(0, pageScroll);
}

function richSlice(doc, start, end) {
  const out = []; let position = 0;
  for (const b of doc) {
    const size = b.type === 'text' ? b.text.length : 1;
    if (position < end && position + size > start) {
      if (b.type === 'text') out.push({ ...b, id: richBlockId(), text: b.text.slice(Math.max(0, start - position), Math.min(size, end - position)) });
      else out.push({ ...b });
    }
    position += size;
  }
  return out;
}

function richReplaceSelection(key, inserted, bookmark = richSelection(key)) {
  const rt = richEditorState(key); const before = richSnapshot(key); const size = richLength(rt.doc);
  rt.doc = richNormalize([...richSlice(rt.doc, 0, bookmark.start), ...inserted, ...richSlice(rt.doc, bookmark.end, size)]);
  rt.selected = null;
  const at = bookmark.start + richLength(inserted);
  richRefresh(key, { start: at, end: at }); richReconcileJobs(key); richPublish(key); richRecord(key, before);
}

function richUndo(key, redo = false) {
  const rt = richEditorState(key); const source = redo ? rt.redo : rt.undo; const entry = source.pop(); if (!entry) return;
  const snapshot = redo ? entry.after : entry.before;
  (redo ? rt.undo : rt.redo).push(entry); rt.doc = richClone(snapshot.doc); rt.selected = snapshot.selected;
  richRefresh(key, snapshot.selection); richReconcileJobs(key); richPublish(key);
}

function richClearSelected(key) {
  const rt = richEditorState(key); rt.selected = null;
  richBody(key)?.querySelectorAll('.rich-image').forEach((figure) => {
    figure.classList.remove('is-selected'); figure.querySelectorAll('[data-rich-resize]').forEach((p) => { p.tabIndex = -1; });
  });
}

function richSelectImage(key, id) {
  for (const other of richEditorRuntime.keys()) richClearSelected(other);
  const rt = richEditorState(key); rt.selected = id;
  const figure = richBody(key)?.querySelector(`[data-rich-block-id="${CSS.escape(id)}"]`);
  if (figure) { figure.classList.add('is-selected'); figure.querySelectorAll('[data-rich-resize]').forEach((p) => { p.tabIndex = 0; }); figure.focus({ preventScroll: true }); }
}

function richImagePosition(key, id) {
  let at = 0; for (const b of richEditorState(key).doc) { if (b.id === id) return at; at += b.type === 'text' ? b.text.length : 1; } return at;
}

function richRemoveImage(key, id) {
  const position = richImagePosition(key, id);
  richReplaceSelection(key, [], { start: position, end: position + 1 }); richCloseMenu();
}

function richApplyWidth(key, id, value, notify = true) {
  const rt = richEditorState(key); const b = rt.doc.find((block) => block.id === id && block.type === 'image'); if (!b) return;
  b.widthPercent = richWidth({ widthPercent: value });
  const figure = richBody(key)?.querySelector(`[data-rich-block-id="${CSS.escape(id)}"]`);
  figure?.style.setProperty('--rich-image-width', `${b.widthPercent}%`);
  figure?.setAttribute('aria-label', `内容图片，宽度 ${b.widthPercent}%，左右方向键调整`);
  if (notify) richPublish(key);
}

function richResizeStart(key, handle, event) {
  event.preventDefault(); event.stopPropagation();
  const rt = richEditorState(key); const figure = handle.closest('.rich-image'); const id = figure.dataset.richBlockId;
  if (rt.selected !== id) richSelectImage(key, id);
  const before = richSnapshot(key); const rect = figure.querySelector('img').getBoundingClientRect();
  const width = richWidth(rt.doc.find((b) => b.id === id)); const direction = handle.dataset.richResize;
  const x = event.clientX; const y = event.clientY;
  handle.setPointerCapture?.(event.pointerId);
  const move = (e) => {
    const dx = (e.clientX - x) * (direction.includes('w') ? -1 : 1);
    const dy = (e.clientY - y) * (direction.includes('n') ? -1 : 1);
    const horizontal = direction.includes('e') || direction.includes('w');
    const vertical = direction.includes('n') || direction.includes('s');
    const scale = horizontal && vertical ? (dx * rect.width + dy * rect.height) / Math.max(1, rect.width ** 2 + rect.height ** 2)
      : horizontal ? dx / Math.max(1, rect.width) : dy / Math.max(1, rect.height);
    richApplyWidth(key, id, width * (1 + scale), false);
  };
  const end = () => {
    window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', end); window.removeEventListener('pointercancel', end);
    richPublish(key); richRecord(key, before);
  };
  window.addEventListener('pointermove', move); window.addEventListener('pointerup', end); window.addEventListener('pointercancel', end);
}

async function validateRichImage(file) {
  if (!['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(file.type)) throw new Error('请选择 PNG、JPG、WebP 或 GIF 图片');
  if (!file.size || file.size > 10 * 1024 * 1024) throw new Error('单张图片最多 10 MB，且不能是空文件');
  const url = URL.createObjectURL(file);
  try {
    const img = new Image(); await new Promise((resolve, reject) => { img.onload = resolve; img.onerror = () => reject(new Error('图片无法读取，请换一张图片')); img.src = url; });
    if (img.naturalWidth * img.naturalHeight > 40_000_000) throw new Error('图片尺寸过大，请缩小至 4000 万像素以内');
    return { width: img.naturalWidth, height: img.naturalHeight };
  } finally { URL.revokeObjectURL(url); }
}

function richReplacePending(key, task) {
  const rt = richEditorState(key); const index = rt.doc.findIndex((b) => b.id === task.id && b.type === 'pending');
  if (index < 0 || !task.result) return;
  const bookmark = richSelection(key); rt.doc[index] = { ...task.result };
  // 上传完成不增加一次撤销；把插图操作的历史占位替换成同一张已保存图片。
  for (const stack of [rt.undo, rt.redo]) for (const entry of stack) for (const snapshot of [entry.before, entry.after]) {
    snapshot.doc = snapshot.doc.map((b) => b.id === task.id && b.type === 'pending' ? { ...task.result } : b);
  }
  richRefresh(key, document.activeElement && richBody(key)?.contains(document.activeElement) ? bookmark : null); richPublish(key);
}

function richRunTask(key, task) {
  const rt = richEditorState(key); if (task.promise || task.result) return task.promise;
  task.controller = new AbortController(); task.error = null; const controller = task.controller;
  task.promise = (async () => {
    try {
      const size = await validateRichImage(task.file);
      if (controller.signal.aborted) return true;
      const def = richCurrentDefinition(key);
      const res = await fetch(def.uploadUrl || '/api/content-images', { method: 'POST', headers: { 'Content-Type': task.file.type }, body: task.file, signal: controller.signal });
      const data = await res.json(); if (!res.ok) throw new Error(data.error || '图片上传失败');
      if (!richImagePattern.test(data.image?.id || '')) throw new Error('图片保存响应异常');
      if (controller.signal.aborted || !rt.doc.some((b) => b.id === task.id && b.type === 'pending')) return true;
      const body = richBody(key); const style = body && getComputedStyle(body);
      const available = Math.max(1, (body?.clientWidth || 800) - Number.parseFloat(style?.paddingLeft || 0) - Number.parseFloat(style?.paddingRight || 0));
      task.result = { id: task.id, type: 'image', imageId: data.image.id, caption: '', widthPercent: richWidth({ widthPercent: size.width / available * 100 }) };
      if (!rt.composing) richReplacePending(key, task);
      return true;
    } catch (error) {
      if (controller.signal.aborted) return true;
      task.error = `图片未插入：${error.message}`;
      if (!rt.composing) richRefresh(key, richBody(key)?.contains(document.activeElement) ? richSelection(key) : null);
      return false;
    } finally {
      task.promise = null;
      // 撤销取消请求后立即重做时，先等取消结束，再为仍存在的占位重新上传。
      if (controller.signal.aborted && rt.doc.some((b) => b.id === task.id && b.type === 'pending')) {
        queueMicrotask(() => richReconcileJobs(key));
      }
    }
  })();
  return task.promise;
}

function richReconcileJobs(key) {
  const rt = richEditorState(key); const visible = new Set(rt.doc.filter((b) => b.type === 'pending').map((b) => b.id));
  for (const task of rt.jobs.values()) {
    if (!visible.has(task.id)) { task.controller?.abort(); continue; }
    if (task.result) { if (!rt.composing) richReplacePending(key, task); }
    else if (!task.promise && !task.error) richRunTask(key, task);
  }
}

function richStartUpload(key, files, anchor = richSelection(key)) {
  const def = richCurrentDefinition(key); const rt = richEditorState(key);
  if (!def || !files.length) return Promise.resolve(false);
  if (richCombinedImageCount(def) + files.length > 20) { toast('每条内容的正文和备注合计最多插入 20 张图片', true); return Promise.resolve(false); }
  const pending = files.map((file) => {
    const id = richBlockId(); rt.jobs.set(id, { id, file, result: null, error: null, promise: null });
    return { id, type: 'pending' };
  });
  richReplaceSelection(key, pending, anchor);
  return Promise.all(pending.map((b) => rt.jobs.get(b.id).promise || Promise.resolve(true))).then((values) => values.every(Boolean));
}

function richCloseMenu() { richMenu?.remove(); richMenu = null; }
function richShowMenu(key, id, x, y) {
  richCloseMenu(); richSelectImage(key, id); richMenu = document.createElement('div');
  richMenu.className = 'rich-context-menu'; richMenu.setAttribute('role', 'menu');
  richMenu.innerHTML = [['rich-fit-image', '适应宽度'], ['rich-caption-image', '图片说明'], ['rich-remove-image', '移除图片']].map(([action, label]) => `<button type="button" role="menuitem" data-action="${action}" data-rich-key="${escapeHtml(key)}" data-rich-block-id="${escapeHtml(id)}">${label}</button>`).join('');
  document.body.append(richMenu);
  richMenu.style.left = `${Math.max(8, Math.min(x, innerWidth - richMenu.offsetWidth - 8))}px`;
  richMenu.style.top = `${Math.max(8, Math.min(y, innerHeight - richMenu.offsetHeight - 8))}px`;
  richMenu.addEventListener('click', (e) => { const button = e.target.closest('button'); if (button) { e.stopPropagation(); handleRichAction(button); } });
  richMenu.addEventListener('keydown', (e) => {
    const buttons = [...richMenu.querySelectorAll('button')];
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); richCloseMenu(); richSelectImage(key, id); }
    if (['ArrowUp', 'ArrowDown'].includes(e.key)) { e.preventDefault(); buttons[(buttons.indexOf(document.activeElement) + (e.key === 'ArrowDown' ? 1 : buttons.length - 1)) % buttons.length].focus(); }
  });
  richMenu.querySelector('button').focus();
}

function richOpenImage(key, id) {
  const def = richCurrentDefinition(key); const b = richEditorState(key).doc.find((block) => block.id === id && block.type === 'image'); if (!def || !b) return;
  richViewerTrigger = richBody(key)?.querySelector(`[data-rich-block-id="${CSS.escape(id)}"]`);
  $('#richViewerImage').hidden = false; $('#richViewerError').hidden = true;
  $('#richViewerImage').src = (def.imageUrl || richImageUrl)(b.imageId); $('#richViewerImage').alt = b.caption || '内容配图';
  $('#richViewerCaption').textContent = b.caption || '';
  $('#richViewerStage').classList.add('is-zoomed');
  $('[data-action="rich-viewer-zoom"]').textContent = '适应屏幕';
  $('#richImageViewer').showModal();
}

async function handleRichAction(button) {
  const action = button.dataset.action; const key = button.dataset.richKey; const id = button.dataset.richBlockId;
  if (action === 'rich-close-viewer') { $('#richImageViewer')?.close(); return; }
  if (action === 'rich-viewer-zoom') {
    const zoomed = $('#richViewerStage').classList.toggle('is-zoomed'); button.textContent = zoomed ? '适应屏幕' : '查看原尺寸'; return;
  }
  const rt = richEditorRuntime.get(key); if (!rt) return;
  if (action === 'rich-retry-upload') { const task = rt.jobs.get(id); if (task) { task.error = null; richRunTask(key, task); richRefresh(key); } return; }
  if (action === 'rich-cancel-upload' || action === 'rich-remove-image') { richRemoveImage(key, id); return; }
  richCloseMenu();
  if (action === 'rich-fit-image') { const before = richSnapshot(key); richApplyWidth(key, id, 100); richRecord(key, before); richSelectImage(key, id); }
  if (action === 'rich-caption-image') {
    const block = rt.doc.find((b) => b.id === id && b.type === 'image'); if (!block) return;
    openFormModal({ title: '图片说明', label: '说明（可留空）', allowEmpty: true, value: block.caption || '', onSubmit: async (caption) => {
      if (caption.length > 500) throw new Error('图片说明最多 500 字');
      const before = richSnapshot(key); block.caption = caption; richPublish(key); richRefresh(key); richRecord(key, before); richSelectImage(key, id);
    } });
  }
}

function richBindImageErrors(body) {
  body.querySelectorAll('.rich-image img').forEach((img) => {
    const fail = () => { img.hidden = true; img.parentElement.querySelector('.rich-image-missing').hidden = false; };
    img.addEventListener('error', fail, { once: true }); if (img.complete && !img.naturalWidth) fail();
  });
}

function richBindOne(key) {
  const body = richBody(key); const rt = richEditorState(key); if (!body || body.dataset.bound === 'true') return;
  body.dataset.bound = 'true'; richBindImageErrors(body);
  body.addEventListener('beforeinput', (e) => {
    if (e.inputType === 'historyUndo' || e.inputType === 'historyRedo') { e.preventDefault(); richUndo(key, e.inputType === 'historyRedo'); return; }
    if (e.inputType.startsWith('format')) { e.preventDefault(); return; }
    if (!rt.composing && e.inputType.startsWith('delete')) {
      const bookmark = richSelection(key);
      if (bookmark.start !== bookmark.end) { e.preventDefault(); richReplaceSelection(key, [], bookmark); return; }
      const at = e.inputType.includes('Backward') ? bookmark.start - 1 : bookmark.start;
      const drawing = rt.doc.find((b) => b.type === 'drawing' && richImagePosition(key, b.id) === at);
      if (drawing) { e.preventDefault(); richRemoveImage(key, drawing.id); return; }
    }
    if (['insertParagraph', 'insertLineBreak'].includes(e.inputType)) { e.preventDefault(); richReplaceSelection(key, [{ id: richBlockId(), type: 'text', text: '\n' }]); return; }
    if (!rt.composing) rt.before = richSnapshot(key);
  });
  body.addEventListener('input', () => {
    rt.doc = richReadDOM(key); rt.selection = richSelection(key); richReconcileJobs(key); richPublish(key);
    if (!rt.composing) { richRecord(key, rt.before); rt.before = null; }
  });
  body.addEventListener('compositionstart', () => { rt.before = richSnapshot(key); rt.composing = true; });
  body.addEventListener('compositionend', () => {
    rt.doc = richReadDOM(key); rt.composing = false; richRecord(key, rt.before); rt.before = null;
    richReconcileJobs(key); richPublish(key);
  });
  body.addEventListener('paste', (e) => {
    e.preventDefault(); const files = [...(e.clipboardData?.files || [])];
    const copied = e.clipboardData?.getData('application/x-life-rich-blocks');
    if (copied) { try { const blocks = JSON.parse(copied); if (Array.isArray(blocks) && blocks.every((b) => b && ((b.type === 'text' && typeof b.text === 'string') || (b.type === 'drawing' && /^[a-f0-9-]{36}$/.test(b.drawingId)) || (b.type === 'image' && richImagePattern.test(b.imageId))))) { richReplaceSelection(key, blocks.map((b) => ({ ...b, id: richBlockId() }))); return; } } catch {} }
    if (files.length) richStartUpload(key, files);
    else richReplaceSelection(key, [{ id: richBlockId(), type: 'text', text: e.clipboardData?.getData('text/plain') || '' }]);
  });
  body.addEventListener('copy', (e) => {
    const range = richSelection(key); if (range.start === range.end) return;
    e.preventDefault(); richCopyBlocks(e, richSlice(rt.doc, range.start, range.end));
  });
  body.addEventListener('cut', (e) => {
    const bookmark = richSelection(key); if (bookmark.start === bookmark.end) return;
    e.preventDefault(); richCopyBlocks(e, richSlice(rt.doc, bookmark.start, bookmark.end)); richReplaceSelection(key, [], bookmark);
  });
  body.addEventListener('keydown', (e) => {
    if (e.isComposing || rt.composing) return;
    if ((e.ctrlKey || e.metaKey) && !e.altKey && ['z', 'y'].includes(e.key.toLowerCase())) { e.preventDefault(); e.stopPropagation(); richUndo(key, e.key.toLowerCase() === 'y' || e.shiftKey); return; }
    if (!rt.selected) {
      if (e.target.closest('.drawing-link')) return;
      if (e.key === 'Escape') richCloseMenu();
      // 在图片边界按删除先选中图片，下一次按删除只移除该图片。
      if (['Backspace', 'Delete'].includes(e.key)) {
        const sel = richSelection(key);
        if (sel.start !== sel.end) { e.preventDefault(); richReplaceSelection(key, [], sel); return; }
        if (sel.start === sel.end) {
          const at = e.key === 'Backspace' ? sel.start - 1 : sel.start;
          const image = rt.doc.find((b) => b.type === 'image' && richImagePosition(key, b.id) === at);
          if (image) { e.preventDefault(); richSelectImage(key, image.id); }
          const drawing = rt.doc.find((b) => b.type === 'drawing' && richImagePosition(key, b.id) === at);
          if (drawing) { e.preventDefault(); richRemoveImage(key, drawing.id); }
        }
      }
      return;
    }
    const id = rt.selected;
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); richClearSelected(key); richCloseMenu(); richRestoreSelection(key, { start: richImagePosition(key, id) + 1 }); }
    else if (['Backspace', 'Delete'].includes(e.key)) { e.preventDefault(); richRemoveImage(key, id); }
    else if (['ArrowLeft', 'ArrowRight'].includes(e.key)) {
      e.preventDefault(); e.stopPropagation(); const before = richSnapshot(key); const b = rt.doc.find((block) => block.id === id);
      richApplyWidth(key, id, richWidth(b) + (e.key === 'ArrowRight' ? 1 : -1) * (e.shiftKey ? 5 : 1)); richRecord(key, before);
    } else if (e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10')) {
      e.preventDefault(); const rect = body.querySelector(`[data-rich-block-id="${CSS.escape(id)}"]`).getBoundingClientRect(); richShowMenu(key, id, rect.left, rect.bottom);
    } else if (['ArrowUp', 'ArrowDown', 'Enter'].includes(e.key) || (e.key.length === 1 && !e.ctrlKey && !e.metaKey)) {
      const at = richImagePosition(key, id) + (e.key === 'ArrowUp' ? 0 : 1);
      richClearSelected(key); richRestoreSelection(key, { start: at });
      if (['ArrowUp', 'ArrowDown'].includes(e.key)) e.preventDefault();
    }
  });
  body.addEventListener('pointerdown', (e) => {
    const handle = e.target.closest('[data-rich-resize]'); if (handle) { richResizeStart(key, handle, e); return; }
    const image = e.target.closest('.rich-image');
    if (!image) { richClearSelected(key); richCloseMenu(); return; }
    if (e.button === 0) { if (e.pointerType !== 'touch') e.preventDefault(); richSelectImage(key, image.dataset.richBlockId); }
    if (e.pointerType === 'touch') {
      const timer = setTimeout(() => richShowMenu(key, image.dataset.richBlockId, e.clientX, e.clientY), 600);
      const cancel = () => { clearTimeout(timer); window.removeEventListener('pointerup', cancel); window.removeEventListener('pointermove', cancel); window.removeEventListener('pointercancel', cancel); };
      window.addEventListener('pointerup', cancel); window.addEventListener('pointermove', cancel); window.addEventListener('pointercancel', cancel);
    }
  });
  body.addEventListener('click', (e) => { const image = e.target.closest('.rich-image'); if (image && !e.target.closest('[data-rich-resize]')) richSelectImage(key, image.dataset.richBlockId); });
  body.addEventListener('focusin', (e) => { const image = e.target.closest('.rich-image'); if (image && rt.selected !== image.dataset.richBlockId) richSelectImage(key, image.dataset.richBlockId); });
  body.addEventListener('dblclick', (e) => { const image = e.target.closest('.rich-image'); if (image && !e.target.closest('[data-rich-resize]')) { e.preventDefault(); richOpenImage(key, image.dataset.richBlockId); } });
  body.addEventListener('contextmenu', (e) => { const image = e.target.closest('.rich-image'); if (image) { e.preventDefault(); richShowMenu(key, image.dataset.richBlockId, e.clientX, e.clientY); } });
  body.addEventListener('keyup', () => { if (!rt.selected) richSelection(key); });
  body.addEventListener('dragover', (e) => { if (e.dataTransfer?.types.includes('Files')) { e.preventDefault(); body.classList.add('is-dragging'); } });
  body.addEventListener('dragleave', (e) => { if (!body.contains(e.relatedTarget)) body.classList.remove('is-dragging'); });
  body.addEventListener('drop', (e) => {
    if (!e.dataTransfer?.files.length) return; e.preventDefault(); body.classList.remove('is-dragging');
    const caret = document.caretRangeFromPoint?.(e.clientX, e.clientY);
    let anchor = { start: richLength(rt.doc), end: richLength(rt.doc) };
    if (caret && body.contains(caret.startContainer) && !caret.startContainer.parentElement?.closest('.rich-image')) {
      const sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(caret); anchor = richSelection(key);
    }
    richStartUpload(key, [...e.dataTransfer.files], anchor);
  });
}

function bindRichEditors() { document.querySelectorAll('[data-rich-body]').forEach((body) => richBindOne(body.dataset.richBody)); }

async function flushRichEditorUploads() {
  for (const [key, rt] of richEditorRuntime) {
    if (rt.drawingCreation && !await rt.drawingCreation) return false;
    for (const task of rt.jobs.values()) {
      if (!rt.doc.some((b) => b.id === task.id && b.type === 'pending')) continue;
      if (task.promise) await task.promise;
      if (task.error || rt.composing || rt.doc.some((b) => b.id === task.id && b.type === 'pending')) {
        toast('有图片尚未插入，请先重试或取消待插入图片。', true); return false;
      }
    }
    if (richBody(key) && !rt.composing) rt.selection = richSelection(key);
  }
  return true;
}

function hasPendingRichEditorUploads() { return [...richEditorRuntime.values()].some((rt) => rt.drawingCreation || rt.doc.some((b) => b.type === 'pending')); }

function bindRichViewer() {
  const dialog = $('#richImageViewer'); if (!dialog || dialog.dataset.bound === 'true') return; dialog.dataset.bound = 'true';
  dialog.addEventListener('click', (e) => { if (e.target === dialog) dialog.close(); });
  dialog.addEventListener('close', () => richViewerTrigger?.isConnected && richViewerTrigger.focus({ preventScroll: true }));
  $('#richViewerImage').addEventListener('error', () => { $('#richViewerImage').hidden = true; $('#richViewerError').hidden = false; });
  document.addEventListener('pointerdown', (e) => {
    if (e.target.closest('.rich-context-menu') || e.target.closest('.rich-image') || e.target.closest('#modalBackdrop') || e.target.closest('dialog')) return;
    richCloseMenu(); for (const key of richEditorRuntime.keys()) richClearSelected(key);
  });
}
