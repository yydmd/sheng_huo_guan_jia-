'use strict';

// 每日复盘复用连续编辑器；历史阅读和原有复盘图片接口仍保持兼容。
let reviewViewerItems = [];
let reviewViewerIndex = 0;
let reviewViewerTrigger = null;

function reviewBlocks(thought) {
  return Array.isArray(thought?.blocks) && thought.blocks.length
    ? thought.blocks : [{ id: 'review-text', type: 'text', text: thought?.text || '' }];
}
function reviewImages(thought) { return thought ? reviewBlocks(thought).filter((b) => b.type === 'image') : []; }
function hasThoughtContent(thought) { return Boolean(thought && (String(thought.title || '').trim() || String(thought.text || '').trim() || reviewImages(thought).length || reviewBlocks(thought).some((b) => b.type === 'drawing'))); }
function reviewImageUrl(id) { return /^[a-f0-9-]{36}\.(png|jpg|webp|gif)$/.test(id || '') ? `/api/review-images/${id}` : ''; }
function reviewWidth(b) { return Math.max(20, Math.min(100, Math.round(Number(b?.widthPercent) || 100))); }
function syncReviewText(thought) {
  thought.text = reviewBlocks(thought).filter((b) => b.type === 'text').map((b) => b.text).join('');
  if ($('#thoughtCount')) $('#thoughtCount').textContent = `${thought.text.replace(/\s/g, '').length} 字 · ${reviewImages(thought).length} 张图片${reviewBlocks(thought).some((b) => b.type === 'drawing') ? ' · 含图稿' : ''}`;
}

function renderReviewEditor(thought) {
  return richEditorMarkup({ key: `review:${thought.id}`, legacyId: 'thoughtEditor', shellId: 'reviewBody', review: true,
    getItem: () => thought, blocksKey: 'blocks', textKey: 'text', label: thoughtKindLabel(thoughtKind(thought)) + '内容',
    placeholder: thoughtKind(thought) === 'review' ? '回顾今天：发生了什么、有哪些收获、明天想怎样改进……' : thoughtKind(thought) === 'extraction' ? '从文章、对话或笔记里摘出关键思想，写下出处和自己的理解……' : '此刻在想什么？写下今天的想法、灵感或目标……',
    uploadUrl: '/api/review-images', imageUrl: reviewImageUrl,
    onChange: () => { syncReviewText(thought); scheduleThinkSave(); },
  });
}
function bindReviewEditor() { const body = $('#reviewBody [data-rich-body]'); if (body) richBindOne(body.dataset.richBody); }

function renderReviewImage(b) {
  const caption = escapeHtml(b.caption || '');
  return `<figure class="review-image" data-block-id="${escapeHtml(b.id)}" style="--review-image-width:${reviewWidth(b)}%"><button class="review-image-open" data-action="review-open-image" data-image-id="${escapeHtml(b.imageId)}" data-caption="${caption}" aria-label="放大查看${caption || '复盘图片'}"><img src="${reviewImageUrl(b.imageId)}" alt="${caption || '复盘配图'}" loading="lazy" /><span class="review-image-expand"><i data-lucide="expand"></i>查看大图</span><span class="review-image-missing" hidden>图片暂时无法显示，请检查本地图片文件</span></button>${caption ? `<figcaption>${caption}</figcaption>` : ''}</figure>`;
}
function renderReviewDocument(thought) {
  return `<div class="review-document">${reviewBlocks(thought).map((b) => b.type === 'image' ? renderReviewImage(b) : b.type === 'drawing' ? LifeDrawings.markup(b) : b.text ? `<span class="history-text">${escapeHtml(b.text)}</span>` : '').join('')}</div>`;
}
function bindReviewImageErrors() {
  $$('.review-image img').forEach((img) => {
    const fail = () => { img.hidden = true; img.parentElement.querySelector('.review-image-missing').hidden = false; };
    img.addEventListener('error', fail, { once: true }); if (img.complete && !img.naturalWidth) fail();
  });
}

async function handleReviewImageAction(button) {
  const action = button.dataset.action;
  if (action === 'review-open-image') {
    reviewViewerItems = $$('.review-image-open').map((item) => ({ id: item.dataset.imageId, caption: item.dataset.caption || '' }));
    reviewViewerIndex = reviewViewerItems.findIndex((item) => item.id === button.dataset.imageId);
    reviewViewerTrigger = button; showReviewViewerImage(); $('#reviewImageViewer').showModal();
  }
  if (action === 'review-close-viewer') $('#reviewImageViewer').close();
  if (action === 'review-prev-image' || action === 'review-next-image') {
    reviewViewerIndex = (reviewViewerIndex + (action === 'review-next-image' ? 1 : -1) + reviewViewerItems.length) % reviewViewerItems.length;
    showReviewViewerImage();
  }
  if (action === 'review-zoom-image') {
    const zoomed = $('#reviewViewerStage').classList.toggle('is-zoomed');
    button.setAttribute('aria-pressed', String(zoomed)); button.textContent = zoomed ? '适应屏幕' : '查看原尺寸';
  }
}
function showReviewViewerImage() {
  const item = reviewViewerItems[reviewViewerIndex]; if (!item) return;
  $('#reviewViewerImage').src = reviewImageUrl(item.id); $('#reviewViewerImage').hidden = false; $('#reviewViewerError').hidden = true;
  $('#reviewViewerImage').alt = item.caption || '复盘配图'; $('#reviewViewerCaption').textContent = item.caption;
  $('#reviewViewerCount').textContent = `${reviewViewerIndex + 1} / ${reviewViewerItems.length}`;
  $('#reviewViewerStage').classList.remove('is-zoomed');
  const zoom = $('[data-action="review-zoom-image"]'); zoom.textContent = '查看原尺寸'; zoom.setAttribute('aria-pressed', 'false');
  for (const action of ['review-prev-image', 'review-next-image']) $(`[data-action="${action}"]`).disabled = reviewViewerItems.length < 2;
}
function bindReviewViewer() {
  const dialog = $('#reviewImageViewer');
  $('#reviewViewerImage').addEventListener('error', () => { $('#reviewViewerImage').hidden = true; $('#reviewViewerError').hidden = false; });
  dialog.addEventListener('close', () => { if (reviewViewerTrigger?.isConnected) reviewViewerTrigger.focus({ preventScroll: true }); });
  dialog.addEventListener('click', (event) => { if (event.target === dialog) dialog.close(); });
  dialog.addEventListener('keydown', (event) => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    event.preventDefault(); $(`[data-action="${event.key === 'ArrowLeft' ? 'review-prev-image' : 'review-next-image'}"]`).click();
  });
}
