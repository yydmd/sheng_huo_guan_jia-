import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

// 接在隔离的所思浏览器测试后运行；图片由测试画布生成，不读取用户文件。
export async function runReviewImageTests({ cdp, evaluate, setValue, waitFor, reloadPage, screenshot, base, temp }) {
  const state = async () => (await (await fetch(`${base}/api/state`)).json());
  const gotoList = async () => {
    await evaluate(cdp, `document.querySelector('[data-action="open-thought-history"]').click()`);
    await waitFor(cdp, `document.querySelector('#historyPageTitle') !== null`, '图文返回记录');
  };
  await evaluate(cdp, `document.querySelector('[data-action="new-review"]').click()`);
  await waitFor(cdp, `document.querySelector('#reviewImageInput') !== null`, '复盘插图入口');
  const picture = await evaluate(cdp, `(() => {
    const c = document.createElement('canvas'); c.width = 1200; c.height = 640;
    const x = c.getContext('2d');
    const g = x.createLinearGradient(0, 0, 1200, 640); g.addColorStop(0, '#e7f1e8'); g.addColorStop(1, '#bccfc0');
    x.fillStyle = g; x.fillRect(0, 0, 1200, 640);
    x.fillStyle = '#f7d997'; x.beginPath(); x.arc(890, 160, 80, 0, Math.PI * 2); x.fill();
    x.fillStyle = '#759e8d'; x.beginPath(); x.moveTo(0, 440); x.lineTo(350, 220); x.lineTo(750, 500); x.lineTo(1200, 270); x.lineTo(1200, 640); x.lineTo(0, 640); x.fill();
    x.fillStyle = '#3c6e61'; x.beginPath(); x.moveTo(0, 570); x.lineTo(450, 340); x.lineTo(900, 600); x.lineTo(1200, 470); x.lineTo(1200, 640); x.lineTo(0, 640); x.fill();
    x.fillStyle = '#244d43'; x.font = '32px sans-serif'; x.fillText('A MOMENT TO REFLECT', 72, 100);
    return c.toDataURL('image/png').split(',')[1];
  })()`);
  const imagePath = path.join(temp, 'review-ui-fixture.png');
  fs.writeFileSync(imagePath, Buffer.from(picture, 'base64'));
  const uploadFile = async () => {
    const { root } = await cdp.send('DOM.getDocument');
    const { nodeId } = await cdp.send('DOM.querySelector', { nodeId: root.nodeId, selector: '#reviewImageInput' });
    await cdp.send('DOM.setFileInputFiles', { nodeId, files: [imagePath] });
  };
  await uploadFile();
  await waitFor(cdp, `document.querySelectorAll('#reviewBody .review-image').length === 1`, '文件选择插入图片');
  await waitFor(cdp, `document.querySelector('#thoughtStatus')?.textContent.includes('已保存')`, '仅图片也能保存复盘');
  let saved = (await state()).thoughtEntries.find((entry) => entry.kind === 'review');
  const id = saved.id;
  assert.equal(saved.text, '');
  assert.equal(saved.blocks.filter((block) => block.type === 'image').length, 1);
  await gotoList();
  assert.equal(await evaluate(cdp, `document.querySelector('.history-record strong').textContent`), '未命名复盘');
  assert.equal(await evaluate(cdp, `document.querySelector('.history-review-cover') !== null`), true);
  await reloadPage(cdp);
  await waitFor(cdp, `document.querySelector('#app .page') !== null`, '图文刷新读取');
  await evaluate(cdp, `document.querySelector('[data-view="thoughts"]').click()`);
  await waitFor(cdp, `document.querySelector('.history-record-main') !== null`, '图片复盘未丢失');
  await evaluate(cdp, `document.querySelector('.history-record-main').click()`);
  await waitFor(cdp, `document.querySelector('.review-document img')?.naturalWidth === 1200`, '历史显示本地图片');
  await evaluate(cdp, `document.querySelector('[data-action="edit-history-record"]').click()`);
  await waitFor(cdp, `document.querySelector('#reviewBody') !== null`, '编辑准确的图文复盘');
  await setValue(cdp, '#thoughtTitle', '今天，把节奏慢下来');
  await setValue(cdp, '#thoughtEditor', '今天的收获\n\n散步时，把注意力放在眼前的风景。');
  await setValue(cdp, '#reviewBody [data-review-text]:last-child', '\n\n下一步：留一点时间，整理自己的想法。');
  const fullText = await evaluate(cdp, `[...document.querySelectorAll('[data-review-text]')].map(e => e.value).join('')`);
  await setValue(cdp, '.review-image-caption', '傍晚的片刻 · 测试配图');
  await waitFor(cdp, `document.querySelector('#thoughtStatus')?.textContent.includes('已保存')`, '图注与分段文字自动保存');
  saved = (await state()).thoughtEntries.find(e => e.id === id);
  assert.equal(saved.text, fullText);
  assert.equal(saved.blocks.find(b => b.type === 'image').caption, '傍晚的片刻 · 测试配图');
  await evaluate(cdp, `document.querySelector('#app').scrollTop = 260`);
  await screenshot(cdp, 'review-images-editor-desktop.png');
  await gotoList();
  await setValue(cdp, '#historySearch', '傍晚的片刻');
  assert.equal(await evaluate(cdp, `document.querySelectorAll('.history-record').length`), 1, '可以搜索图片说明');
  await evaluate(cdp, `document.querySelector('.history-record-main').click()`);
  await waitFor(cdp, `document.querySelector('.review-document img')?.naturalWidth === 1200`, '图文阅读图片加载');
  await screenshot(cdp, 'review-images-reader-desktop.png');
  await evaluate(cdp, `document.querySelector('[data-action="review-open-image"]').click()`);
  await waitFor(cdp, `document.querySelector('#reviewImageViewer').open && document.querySelector('#reviewViewerImage').naturalWidth === 1200`, '点击放大图片');
  await screenshot(cdp, 'review-images-lightbox.png');
  await evaluate(cdp, `document.querySelector('[data-action="review-zoom-image"]').click()`);
  assert.equal(await evaluate(cdp, `document.querySelector('#reviewViewerStage').classList.contains('is-zoomed')`), true);
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape' });
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape' });
  await waitFor(cdp, `!document.querySelector('#reviewImageViewer').open`, 'Escape 关闭大图');
  assert.equal(await evaluate(cdp, `document.activeElement.dataset.action`), 'review-open-image');

  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await evaluate(cdp, `window.scrollTo(0, 100)`);
  await screenshot(cdp, 'review-images-reader-mobile.png');
  assert.equal(await evaluate(cdp, `document.documentElement.scrollWidth <= innerWidth + 1`), true);
  const imageRatio = await evaluate(cdp, `(() => { const r = document.querySelector('.review-document img').getBoundingClientRect(); return r.width / r.height; })()`);
  assert.ok(Math.abs(imageRatio - 1200 / 640) < 0.02, '正文图片应保留原比例，不裁切');
  await evaluate(cdp, `document.querySelector('[data-action="edit-history-record"]').click()`);
  await waitFor(cdp, `document.querySelector('#reviewBody') !== null`, '手机编辑图文');
  await evaluate(cdp, `window.scrollTo(0, 400)`);
  await screenshot(cdp, 'review-images-editor-mobile.png');

  // 粘贴与拖入：图片插入光标位置，原文字不丢失；批量顺序与标题不受影响。
  const makeClipboard = `const bytes = Uint8Array.from(atob(${JSON.stringify(picture)}), ch => ch.charCodeAt(0)); const transfer = new DataTransfer(); transfer.items.add(new File([bytes], 'paste.png', {type: 'image/png'}));`;
  await evaluate(cdp, `(() => { ${makeClipboard} const editor = document.querySelector('#thoughtEditor'); editor.focus(); editor.setSelectionRange(6, 6); editor.dispatchEvent(new ClipboardEvent('paste', {bubbles: true, cancelable: true, clipboardData: transfer})); })()`);
  await waitFor(cdp, `document.querySelectorAll('#reviewBody .review-image').length === 2`, '粘贴截图');
  assert.equal(await evaluate(cdp, `document.querySelector('#thoughtEditor').value`), '今天的收获\n');
  await evaluate(cdp, `(() => { ${makeClipboard} document.querySelector('#reviewBody').dispatchEvent(new DragEvent('drop', {bubbles: true, cancelable: true, dataTransfer: transfer})); })()`);
  await waitFor(cdp, `document.querySelectorAll('#reviewBody .review-image').length === 3`, '拖入图片');
  await gotoList();
  saved = (await state()).thoughtEntries.find(e => e.id === id);
  assert.equal(saved.text, fullText, '插图不应吞掉光标后面的文字');
  assert.equal(saved.blocks.filter(b => b.type === 'image').length, 3);
  await evaluate(cdp, `document.querySelector('.history-record-main').click()`);
  await evaluate(cdp, `document.querySelector('[data-action="review-open-image"]').click()`);
  await evaluate(cdp, `document.querySelector('[data-action="review-next-image"]').click()`);
  assert.equal(await evaluate(cdp, `document.querySelector('#reviewViewerCount').textContent`), '2 / 3');
  await evaluate(cdp, `document.querySelector('[data-action="review-close-viewer"]').click()`);
  await evaluate(cdp, `document.querySelector('[data-action="edit-history-record"]').click()`);
  await evaluate(cdp, `document.querySelector('[data-action="review-remove-image"]').click()`);
  await waitFor(cdp, `!document.querySelector('#modalBackdrop').classList.contains('hidden')`, '移除图片需确认');
  await evaluate(cdp, `document.querySelector('#modalSubmit').click()`);
  await waitFor(cdp, `document.querySelectorAll('#reviewBody .review-image').length === 2`, '只移除选定图片');
  await gotoList();
  saved = (await state()).thoughtEntries.find(e => e.id === id);
  assert.equal(saved.text, fullText);
  assert.equal(saved.blocks.filter(b => b.type === 'image').length, 2);
  assert.equal((await fetch(`${base}/api/review-images/${saved.blocks.find(b => b.type === 'image').imageId}`)).status, 200);

  // 网络失败不得静默丢图；取消或重试前拦住离开，重试后只保存到原文章。
  await evaluate(cdp, `document.querySelector('.history-record-main').click()`);
  await evaluate(cdp, `document.querySelector('[data-action="edit-history-record"]').click()`);
  await evaluate(cdp, `(() => { const original = window.fetch; window.fetch = (...args) => { if (args[0] === '/api/review-images') { window.fetch = original; return Promise.resolve(new Response(JSON.stringify({error:'测试上传失败'}), {status:503})); } return original(...args); }; })()`);
  await uploadFile();
  await waitFor(cdp, `document.querySelector('[data-action="review-retry-upload"]') !== null`, '失败显示重试');
  await evaluate(cdp, `document.querySelector('[data-action="open-thought-history"]').click()`);
  assert.equal(await evaluate(cdp, `document.querySelector('#reviewBody') !== null`), true);
  await evaluate(cdp, `document.querySelector('[data-action="review-retry-upload"]').click()`);
  await waitFor(cdp, `document.querySelectorAll('#reviewBody .review-image').length === 3`, '重试插入到原复盘');
  // 上传尚未返回时继续输入并切页：必须等图片插好，再保存完整图文快照。
  await evaluate(cdp, `(() => { const original = window.fetch; window.fetch = async (...args) => {
    const response = await original(...args);
    if (args[0] === '/api/review-images') { window.fetch = original; await new Promise(resolve => { window.releaseImageUpload = resolve; }); }
    return response;
  }; })()`);
  await uploadFile();
  await waitFor(cdp, `typeof window.releaseImageUpload === 'function'`, '延迟图片上传响应');
  await setValue(cdp, '#thoughtTitle', '上传时继续输入的标题');
  await evaluate(cdp, `document.querySelector('[data-action="open-thought-history"]').click()`);
  assert.equal(await evaluate(cdp, `document.querySelector('#reviewBody') !== null`), true, '插图中切页应等待');
  await evaluate(cdp, `window.releaseImageUpload()`);
  await waitFor(cdp, `document.querySelector('#historyPageTitle') !== null`, '图文保存完成后切页');
  saved = (await state()).thoughtEntries.find(e => e.id === id);
  assert.equal(saved.blocks.filter(b => b.type === 'image').length, 4);
  assert.equal(saved.title, '上传时继续输入的标题');
  assert.equal(saved.text, fullText);
  await evaluate(cdp, `document.querySelector('.history-record-main').click()`);
  await evaluate(cdp, `document.querySelector('[data-action="edit-history-record"]').click()`);
  await evaluate(cdp, `(() => { const transfer = new DataTransfer(); transfer.items.add(new File(['<svg></svg>'], 'unsafe.svg', {type:'image/svg+xml'})); document.querySelector('#thoughtEditor').dispatchEvent(new ClipboardEvent('paste', {bubbles:true, cancelable:true, clipboardData:transfer})); })()`);
  await waitFor(cdp, `document.querySelector('[data-action="review-cancel-upload"]') !== null`, '不支持的格式明确提示');
  await evaluate(cdp, `document.querySelector('[data-action="review-cancel-upload"]').click()`);
  await gotoList();
  assert.equal((await state()).thoughtEntries.length, 1);
  assert.equal((await state()).thoughtEntries[0].id, id);
  await evaluate(cdp, `document.querySelector('[data-action="new-thought"]').click()`);
  await waitFor(cdp, `document.querySelector('#thoughtEditor') !== null`, '自由思考仍可正常编辑');
  assert.equal(await evaluate(cdp, `document.querySelector('[data-action="review-add-image"]') === null`), true, '图片只影响每日复盘');
}
