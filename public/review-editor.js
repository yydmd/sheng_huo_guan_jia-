'use strict';

// 每日复盘的图文块编辑器。文字仍是普通文本，不执行或保存任意 HTML。
let reviewSelection = null;
let reviewUploadPromise = null;
let reviewUploadFailure = null;
let reviewViewerItems = [];
let reviewViewerIndex = 0;
let reviewViewerTrigger = null;

function reviewBlockId() { return `b-${crypto.randomUUID()}`; }
function reviewBlocks(thought) {
  return Array.isArray(thought?.blocks) && thought.blocks.length
    ? thought.blocks : [{ id: 'review-text', type: 'text', text: thought?.text || '' }];
}
function reviewImages(thought) { return thought?.kind === 'review' ? reviewBlocks(thought).filter((block) => block.type === 'image') : []; }
function hasThoughtContent(thought) {
  return Boolean(thought && (String(thought.title || '').trim() || String(thought.text || '').trim() || reviewImages(thought).length));
}
function reviewImageUrl(id) {
  return /^[a-f0-9-]{36}\.(png|jpg|webp|gif)$/.test(id || '') ? `/api/review-images/${id}` : '';
}
function syncReviewText(thought) {
  thought.text = reviewBlocks(thought).filter((block) => block.type === 'text').map((block) => block.text).join('');
  if ($('#thoughtCount')) $('#thoughtCount').textContent = `${thought.text.replace(/\s/g, '').length} 字 · ${reviewImages(thought).length} 张图片`;
}
function normalizeReviewEditorBlocks(thought) {
  const blocks = reviewBlocks(thought).map((block) => ({ ...block }));
  if (blocks[0]?.type !== 'text') blocks.unshift({ id: reviewBlockId(), type: 'text', text: '' });
  if (blocks.at(-1)?.type !== 'text') blocks.push({ id: reviewBlockId(), type: 'text', text: '' });
  thought.blocks = blocks;
  return blocks;
}

function renderReviewImage(block, editing = false) {
  const caption = escapeHtml(block.caption || '');
  return `<figure class="review-image" data-block-id="${escapeHtml(block.id)}">
    <button class="review-image-open" data-action="review-open-image" data-image-id="${escapeHtml(block.imageId)}" data-caption="${caption}" aria-label="放大查看${caption || '复盘图片'}">
      <img src="${reviewImageUrl(block.imageId)}" alt="${caption || '复盘配图'}" loading="lazy" />
      <span class="review-image-expand"><i data-lucide="expand"></i>查看大图</span>
      <span class="review-image-missing" hidden>图片暂时无法显示，请检查本地图片文件</span>
    </button>
    ${editing ? `<div class="review-image-footer">
      <input class="review-image-caption" data-review-caption="${escapeHtml(block.id)}" value="${caption}" maxlength="500" placeholder="添加图片说明（可选）" aria-label="图片说明" />
      <button class="icon-button review-image-remove" data-action="review-remove-image" data-block-id="${escapeHtml(block.id)}" aria-label="移除这张图片" title="移除图片"><i data-lucide="trash-2"></i></button>
    </div>` : block.caption ? `<figcaption>${caption}</figcaption>` : ''}
  </figure>`;
}

function renderReviewEditor(thought) {
  return `<div class="review-tools">
    <button class="button ghost small" data-action="review-add-image"><i data-lucide="image-plus"></i>插入图片</button>
    <span class="review-tools-hint">也可粘贴截图或拖入图片</span>
    <input type="file" id="reviewImageInput" accept="image/png,image/jpeg,image/webp,image/gif" multiple hidden />
  </div>
  <div id="reviewUploadStatus" class="review-upload-status" role="status" aria-live="polite"></div>
  <div class="review-body" id="reviewBody" aria-label="图文复盘正文">${renderReviewEditorBlocks(thought)}</div>`;
}

function renderReviewEditorBlocks(thought) {
  const blocks = normalizeReviewEditorBlocks(thought);
  let first = true;
  return blocks.map((block) => {
    if (block.type === 'image') return renderReviewImage(block, true);
    const id = first ? ' id="thoughtEditor"' : '';
    first = false;
    return `<textarea${id} class="review-text ${blocks.length === 1 ? 'review-text-solo' : ''}" data-review-text="${escapeHtml(block.id)}" aria-label="每日复盘内容" placeholder="${blocks.length === 1 ? '回顾今天：发生了什么、有哪些收获、明天想怎样改进……' : '继续写下你的复盘……'}">${escapeHtml(block.text)}</textarea>`;
  }).join('');
}

function renderReviewDocument(thought) {
  return `<div class="review-document">${reviewBlocks(thought).map((block) => block.type === 'image'
    ? renderReviewImage(block)
    : block.text ? `<div class="history-text">${escapeHtml(block.text)}</div>` : '').join('')}</div>`;
}

function resizeReviewText(editor) {
  editor.style.height = 'auto';
  editor.style.height = `${editor.scrollHeight}px`;
}

function bindReviewBody() {
  const thought = currentThought();
  if (!thought || thoughtKind(thought) !== 'review') return;
  $$('#reviewBody [data-review-text]').forEach((editor) => {
    const remember = () => { reviewSelection = { blockId: editor.dataset.reviewText, offset: editor.selectionStart }; };
    for (const event of ['focus', 'click', 'keyup', 'select']) editor.addEventListener(event, remember);
    editor.addEventListener('input', () => {
      const target = currentThought();
      const block = target.blocks.find((item) => item.id === editor.dataset.reviewText);
      if (block) block.text = editor.value;
      remember();
      resizeReviewText(editor);
      syncReviewText(target);
      scheduleThinkSave();
    });
    editor.addEventListener('paste', (event) => {
      const files = [...(event.clipboardData?.files || [])];
      if (!files.length) return;
      event.preventDefault(); remember(); startReviewImageUpload(files);
    });
    resizeReviewText(editor);
  });
  $$('#reviewBody [data-review-caption]').forEach((input) => input.addEventListener('input', () => {
    const block = currentThought().blocks.find((item) => item.id === input.dataset.reviewCaption);
    if (!block) return;
    block.caption = input.value;
    const trigger = input.closest('figure').querySelector('.review-image-open');
    trigger.dataset.caption = input.value;
    trigger.querySelector('img').alt = input.value || '复盘配图';
    scheduleThinkSave();
  }));
  const body = $('#reviewBody');
  body.addEventListener('dragover', (event) => {
    if (!event.dataTransfer?.types.includes('Files')) return;
    event.preventDefault(); body.classList.add('is-dragging');
  });
  body.addEventListener('dragleave', (event) => { if (!body.contains(event.relatedTarget)) body.classList.remove('is-dragging'); });
  body.addEventListener('drop', (event) => {
    event.preventDefault(); body.classList.remove('is-dragging');
    if (event.target.matches('[data-review-text]')) reviewSelection = { blockId: event.target.dataset.reviewText, offset: event.target.selectionStart };
    startReviewImageUpload([...(event.dataTransfer?.files || [])]);
  });
  bindReviewImageErrors();
}

function bindReviewEditor() {
  reviewSelection = null;
  $('#reviewImageInput')?.addEventListener('change', (event) => {
    startReviewImageUpload([...event.target.files]);
    event.target.value = '';
  });
  bindReviewBody();
  syncReviewUploadStatus();
}

function bindReviewImageErrors() {
  $$('.review-image img').forEach((img) => {
    const showError = () => { img.hidden = true; img.parentElement.querySelector('.review-image-missing').hidden = false; };
    img.addEventListener('error', showError, { once: true });
    if (img.complete && !img.naturalWidth) showError();
  });
}

function syncReviewUploadStatus(message = '') {
  const status = $('#reviewUploadStatus');
  if (!status) return;
  if (reviewUploadFailure) {
    status.innerHTML = `<span class="save-error">${escapeHtml(reviewUploadFailure.message)}</span><button class="text-button" data-action="review-retry-upload">重试</button><button class="text-button" data-action="review-cancel-upload">取消待插入图片</button>`;
  } else status.textContent = message || (reviewUploadPromise ? '正在保存图片到本机…' : '');
  const button = $('[data-action="review-add-image"]');
  if (button) button.disabled = Boolean(reviewUploadPromise);
}

async function validateReviewImage(file) {
  if (!['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(file.type)) throw new Error('请选择 PNG、JPG、WebP 或 GIF 图片');
  if (!file.size || file.size > 10 * 1024 * 1024) throw new Error('单张图片最多 10 MB，且不能是空文件');
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    await new Promise((resolve, reject) => { img.onload = resolve; img.onerror = () => reject(new Error('图片无法读取，请换一张图片')); img.src = url; });
    if (img.naturalWidth * img.naturalHeight > 40_000_000) throw new Error('图片尺寸过大，请缩小至 4000 万像素以内');
  } finally { URL.revokeObjectURL(url); }
}

function refreshReviewBody() {
  const thought = currentThought();
  if (!thought || !$('#reviewBody')) return;
  const appScroll = $('#app').scrollTop;
  const pageScroll = window.scrollY;
  $('#reviewBody').innerHTML = renderReviewEditorBlocks(thought);
  bindReviewBody(); renderIcons();
  $('#app').scrollTop = appScroll; window.scrollTo(0, pageScroll);
}

async function startReviewImageUpload(files, anchor = reviewSelection) {
  const thought = currentThought();
  if (!files.length || !thought || thoughtKind(thought) !== 'review') return;
  if (state.version < 8) { toast('请先重启生活管家服务并刷新页面，以启用复盘图片。', true); return; }
  if (reviewUploadPromise) { toast('请等待当前图片插入完成'); return; }
  if (reviewImages(thought).length + files.length > 20) { toast('每篇复盘最多插入 20 张图片', true); return; }
  reviewUploadFailure = null;
  const operation = (async () => {
    for (let index = 0; index < files.length; index += 1) {
      try {
        await validateReviewImage(files[index]);
        syncReviewUploadStatus(`正在插入图片 ${index + 1} / ${files.length}…`);
        const response = await fetch('/api/review-images', { method: 'POST', headers: { 'Content-Type': files[index].type }, body: files[index] });
        const result = await response.json();
        if (!response.ok) throw new Error(result.error || '图片上传失败');
        if (!reviewImageUrl(result.image?.id)) throw new Error('图片保存响应异常');
        // 首次文章保存可能在上传期间完成；重新取当前对象以保持同一个文章 ID。
        const target = currentThought();
        const blocks = normalizeReviewEditorBlocks(target);
        let at = blocks.findIndex((block) => block.type === 'text' && block.id === anchor?.blockId);
        if (at < 0) at = blocks.length - 1;
        const original = blocks[at];
        const offset = Math.min(original.text.length, Math.max(0, anchor?.offset ?? original.text.length));
        const after = { id: reviewBlockId(), type: 'text', text: original.text.slice(offset) };
        blocks.splice(at, 1, { ...original, text: original.text.slice(0, offset) }, { id: reviewBlockId(), type: 'image', imageId: result.image.id, caption: '' }, after);
        anchor = { blockId: after.id, offset: 0 };
        reviewSelection = anchor;
        syncReviewText(target); scheduleThinkSave(); refreshReviewBody();
      } catch (error) {
        reviewUploadFailure = { files: files.slice(index), anchor, message: `图片未插入：${error.message}` };
        toast(reviewUploadFailure.message, true);
        return false;
      }
    }
    return true;
  })();
  reviewUploadPromise = operation;
  syncReviewUploadStatus();
  try {
    const saved = await operation;
    if (saved && anchor) {
      const next = $(`[data-review-text="${anchor.blockId}"]`);
      next?.focus({ preventScroll: true });
      next?.setSelectionRange(0, 0);
    }
    return saved;
  } finally { reviewUploadPromise = null; syncReviewUploadStatus(); }
}

async function handleReviewImageAction(button) {
  const action = button.dataset.action;
  if (action === 'review-add-image') $('#reviewImageInput')?.click();
  if (action === 'review-retry-upload' && reviewUploadFailure) {
    const failed = reviewUploadFailure;
    await startReviewImageUpload(failed.files, failed.anchor);
  }
  if (action === 'review-cancel-upload') { reviewUploadFailure = null; syncReviewUploadStatus(); }
  if (action === 'review-remove-image') {
    if (reviewUploadPromise) { toast('请等待图片插入完成'); return; }
    const thought = currentThought();
    const block = reviewBlocks(thought).find((item) => item.id === button.dataset.blockId && item.type === 'image');
    if (!block) return;
    openConfirmModal({ title: '移除这张图片？', message: '只从当前复盘中移除，正文和本地图片文件会保留。', confirmText: '移除图片', onConfirm: async () => {
      const target = currentThought();
      target.blocks = target.blocks.filter((item) => item.id !== block.id);
      const merged = [];
      for (const item of target.blocks) {
        if (item.type === 'text' && merged.at(-1)?.type === 'text') merged.at(-1).text += item.text;
        else merged.push({ ...item });
      }
      target.blocks = merged;
      syncReviewText(target); scheduleThinkSave(); refreshReviewBody();
    } });
  }
  if (action === 'review-open-image') {
    reviewViewerItems = $$('.review-image-open').map((item) => ({ id: item.dataset.imageId, caption: item.dataset.caption || '' }));
    reviewViewerIndex = reviewViewerItems.findIndex((item) => item.id === button.dataset.imageId);
    reviewViewerTrigger = button;
    showReviewViewerImage(); $('#reviewImageViewer').showModal();
  }
  if (action === 'review-close-viewer') $('#reviewImageViewer').close();
  if (action === 'review-prev-image' || action === 'review-next-image') {
    reviewViewerIndex = (reviewViewerIndex + (action === 'review-next-image' ? 1 : -1) + reviewViewerItems.length) % reviewViewerItems.length;
    showReviewViewerImage();
  }
  if (action === 'review-zoom-image') {
    const zoomed = $('#reviewViewerStage').classList.toggle('is-zoomed');
    button.setAttribute('aria-pressed', String(zoomed));
    button.textContent = zoomed ? '适应屏幕' : '查看原尺寸';
  }
}

function showReviewViewerImage() {
  const item = reviewViewerItems[reviewViewerIndex];
  if (!item) return;
  $('#reviewViewerImage').src = reviewImageUrl(item.id);
  $('#reviewViewerImage').hidden = false;
  $('#reviewViewerError').hidden = true;
  $('#reviewViewerImage').alt = item.caption || '复盘配图';
  $('#reviewViewerCaption').textContent = item.caption;
  $('#reviewViewerCount').textContent = `${reviewViewerIndex + 1} / ${reviewViewerItems.length}`;
  $('#reviewViewerStage').classList.remove('is-zoomed');
  const zoom = $('[data-action="review-zoom-image"]');
  zoom.textContent = '查看原尺寸'; zoom.setAttribute('aria-pressed', 'false');
  for (const action of ['review-prev-image', 'review-next-image']) $(`[data-action="${action}"]`).disabled = reviewViewerItems.length < 2;
}

function bindReviewViewer() {
  const dialog = $('#reviewImageViewer');
  $('#reviewViewerImage').addEventListener('error', () => { $('#reviewViewerImage').hidden = true; $('#reviewViewerError').hidden = false; });
  dialog.addEventListener('close', () => { if (reviewViewerTrigger?.isConnected) reviewViewerTrigger.focus({ preventScroll: true }); });
  dialog.addEventListener('click', (event) => { if (event.target === dialog) dialog.close(); });
  dialog.addEventListener('keydown', (event) => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    event.preventDefault();
    $(`[data-action="${event.key === 'ArrowLeft' ? 'review-prev-image' : 'review-next-image'}"]`).click();
  });
}
