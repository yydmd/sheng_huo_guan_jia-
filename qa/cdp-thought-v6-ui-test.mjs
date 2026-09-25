/** 自由思考 v6 浏览器冒烟测试；使用临时项目副本，不触碰真实数据。 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runReviewImageTests } from './review-images-ui.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'life-steward-thought-ui-'));
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'life-steward-chrome-'));
const appPort = 45000 + Math.floor(Math.random() * 500);
const debugPort = 45500 + Math.floor(Math.random() * 400);
const base = `http://127.0.0.1:${appPort}`;
const longThoughtText = '第一篇正文\n\n  保留原文的缩进与空行。\n\n' +
  Array.from({ length: 36 }, (_, index) => `第 ${index + 1} 段：回看过去的想法，把注意力放在正文上。宽松的阅读空间让复盘更连贯，也更容易看见自己思考的变化。`).join('\n\n') +
  '\n\n' + 'continuous-text-'.repeat(30) + '\n全文结束：最后一段也应完整可读。';
const chromePath = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
let server;
let chrome;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

class CDP {
  constructor(ws) {
    this.ws = ws; this.id = 0; this.pending = new Map(); this.listeners = new Map();
    ws.onmessage = (event) => {
      const message = JSON.parse(event.data);
      if (message.id && this.pending.has(message.id)) {
        const { resolve, reject } = this.pending.get(message.id);
        this.pending.delete(message.id);
        message.error ? reject(new Error(message.error.message)) : resolve(message.result);
      } else if (message.method) {
        for (const listener of this.listeners.get(message.method) || []) listener(message.params);
      }
    };
  }
  static async connect(url) {
    const ws = new WebSocket(url);
    await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
    return new CDP(ws);
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  on(method, listener) {
    if (!this.listeners.has(method)) this.listeners.set(method, []);
    this.listeners.get(method).push(listener);
  }
  close() { this.ws.close(); }
}

async function waitHttp(url, timeout = 12000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    try { const response = await fetch(url); if (response.ok) return response; } catch (_) { /* retry */ }
    await sleep(120);
  }
  throw new Error(`等待超时：${url}`);
}

async function evaluate(cdp, expression) {
  const result = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
  return result.result?.value;
}

async function waitFor(cdp, expression, label, timeout = 8000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await evaluate(cdp, expression)) return;
    await sleep(100);
  }
  const diagnostic = await evaluate(cdp, `(async () => ({
    body: document.body.innerText.slice(0, 1200),
    thoughts: (await (await fetch('/api/state')).json()).thoughtEntries.map(({id, kind, title, text}) => ({id, kind, title, length: text.length}))
  }))()`);
  throw new Error(`等待超时：${label} ${JSON.stringify(diagnostic)}`);
}

async function setValue(cdp, selector, value) {
  await evaluate(cdp, `(() => {
    const element = document.querySelector(${JSON.stringify(selector)});
    const prototype = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, 'value').set.call(element, ${JSON.stringify(value)});
    element.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
}

async function screenshot(cdp, name) {
  if (!process.env.THOUGHT_QA_SCREENSHOTS) return;
  const shot = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  fs.writeFileSync(path.join(here, name), Buffer.from(shot.data, 'base64'));
}

async function newThoughtFromList(cdp) {
  await evaluate(cdp, `document.querySelector('[data-action="open-thought-history"]').click()`);
  await waitFor(cdp, `document.querySelector('#historyPageTitle') !== null`, '返回记录列表后再新建');
  await evaluate(cdp, `document.querySelector('[data-action="new-thought"]').click()`);
  await waitFor(cdp, `document.querySelector('.free-editor-card[data-thought-id="draft"]') !== null`, '单篇临时草稿');
}

async function reloadPage(cdp) {
  // Page.reload 只表示已发起刷新；等新文档加载后再点击，避免操作旧页面。
  const loaded = new Promise((resolve) => cdp.on('Page.loadEventFired', resolve));
  await cdp.send('Page.reload', { ignoreCache: true });
  await loaded;
}

try {
  fs.copyFileSync(path.join(root, 'server.js'), path.join(temp, 'server.js'));
  fs.cpSync(path.join(root, 'public'), path.join(temp, 'public'), { recursive: true });
  fs.mkdirSync(path.join(temp, 'data'));
  fs.writeFileSync(path.join(temp, 'data', 'data.json'), JSON.stringify({
    version: 6, sections: [], records: {}, thoughtEntries: [], thoughtCategories: [],
    reflectFrameworks: [{ id: 'qa-reflection', name: '今天学到了什么？' }],
    reflectEntries: { '2026-08-01': { 'qa-reflection': '反思第一行\n\n反思第二行' } },
    plans: [], problems: [], events: [], eventCheckins: {}, eventExceptions: [],
  }, null, 2));
  server = spawn(process.execPath, ['server.js', '--port', String(appPort), '--no-open'], { cwd: temp, stdio: 'ignore' });
  await waitHttp(`${base}/api/state`);

  chrome = spawn(chromePath, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--disable-http-cache',
    `--remote-debugging-port=${debugPort}`, `--user-data-dir=${profile}`, '--window-size=1400,900', 'about:blank',
  ], { stdio: 'ignore' });
  const pages = await (await waitHttp(`http://127.0.0.1:${debugPort}/json/list`)).json();
  const target = pages.find((page) => page.type === 'page' && !String(page.url || '').startsWith('chrome-extension://'));
  const cdp = await CDP.connect(target.webSocketDebuggerUrl);
  const errors = [];
  await cdp.send('Page.enable'); await cdp.send('Runtime.enable');
  cdp.on('Runtime.exceptionThrown', (event) => errors.push(event.exceptionDetails?.exception?.description || event.exceptionDetails?.text));
  await cdp.send('Page.navigate', { url: base });
  try {
    await waitFor(cdp, `document.querySelector('#app .page') !== null`, '首页');
  } catch (error) {
    const diagnostic = await evaluate(cdp, `({ url: location.href, title: document.title, body: document.body?.innerText?.slice(0, 500) || '' })`);
    throw new Error(`${error.message} ${JSON.stringify(diagnostic)} JS=${JSON.stringify(errors)}`);
  }
  await evaluate(cdp, `document.querySelector('[data-view="thoughts"]').click()`);
  await waitFor(cdp, `document.querySelector('.history-list') === null`, '默认显示自由思考筛选');
  assert.equal(await evaluate(cdp, `document.querySelector('#thoughtEditor') === null`), true);
  assert.equal(await evaluate(cdp, `document.querySelector('#globalDate, .thought-entry-rail') === null`), true, '入口不应限制在当天写作');
  assert.equal(await evaluate(cdp, `document.querySelector('.empty-state') !== null`), true);
  assert.equal(await evaluate(cdp, `document.querySelectorAll('[data-action="new-thought"]').length`), 1);
  assert.equal(await evaluate(cdp, `document.querySelector('[data-action="new-thought"]').classList.contains('small')`), true);
  await evaluate(cdp, `document.querySelector('[data-filter="review"]').click()`);
  assert.equal(await evaluate(cdp, `document.querySelectorAll('.history-record').length`), 0);
  assert.equal(await evaluate(cdp, `document.querySelectorAll('.history-type-filter button').length`), 4, '空复盘列表仍保留四种类型筛选');
  await evaluate(cdp, `document.querySelector('[data-filter="free"]').click()`);
  await evaluate(cdp, `document.querySelector('[data-action="write-daily-reflection"]').click()`);
  await waitFor(cdp, `document.querySelector('.reflect-editor') !== null`, '首页可直接写每日反思');
  await evaluate(cdp, `document.querySelector('[data-view="thoughts"]').click()`);
  await waitFor(cdp, `document.querySelector('.history-filter') !== null`, '再次点击所思返回自由思考筛选');
  await evaluate(cdp, `document.querySelector('[data-action="new-thought"]').click()`);
  await waitFor(cdp, `document.querySelector('#thoughtEditor') !== null`, '从列表新建临时草稿');
  await evaluate(cdp, `document.querySelector('[data-view="events"]').click()`);
  await waitFor(cdp, `document.querySelector('.thoughts-page') === null`, '离开所思');
  await evaluate(cdp, `document.querySelector('[data-view="thoughts"]').click()`);
  await waitFor(cdp, `document.querySelector('.history-filter') !== null`, '重进所思默认列表');
  assert.equal((await (await fetch(`${base}/api/state`)).json()).thoughtEntries.length, 0, '打开所思或空白新建不得落盘');

  await evaluate(cdp, `document.querySelector('[data-action="new-thought"]').click()`);
  await waitFor(cdp, `document.querySelector('#thoughtEditor') !== null`, '新文章编辑器');
  const editorSize = await evaluate(cdp, `(() => { const r = document.querySelector('#thoughtEditor').getBoundingClientRect(); return { width: r.width, height: r.height }; })()`);
  assert.ok(editorSize.width >= 950, `桌面写作区应使用侧栏释放的宽度：${editorSize.width}`);
  assert.ok(editorSize.height >= 560, `桌面写作区高度不足：${editorSize.height}`);
  assert.equal(await evaluate(cdp, `document.querySelector('.thought-entry-rail, .thought-entry-list, .free-thought-workspace .mode-head, [data-action="new-thought"]') === null`), true, '编辑时不应显示重复的篇目、说明或新建入口');
  await screenshot(cdp, 'thought-editor-focused-desktop.png');
  await setValue(cdp, '#thoughtTitle', '第一篇标题');
  await setValue(cdp, '#thoughtEditor', longThoughtText);
  await waitFor(cdp, `(async () => (await (await fetch('/api/state')).json()).thoughtEntries.length === 1)()`, '第一篇保存');

  await evaluate(cdp, `(() => { const s = document.querySelector('#thoughtCategory'); s.value = '__new__'; s.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  await waitFor(cdp, `document.querySelector('#modalInput') !== null`, '新建类别弹窗');
  await setValue(cdp, '#modalInput', '学习');
  await evaluate(cdp, `document.querySelector('#modalSubmit').click()`);
  await waitFor(cdp, `(async () => { const s = await (await fetch('/api/state')).json(); return s.thoughtCategories.length === 1 && s.thoughtCategories[0].kind === 'free' && s.thoughtEntries[0].categoryId === s.thoughtCategories[0].id; })()`, '自由思考类别保存');

  await newThoughtFromList(cdp);
  await waitFor(cdp, `document.querySelector('#thoughtTitle').value === ''`, '第二篇草稿');
  await setValue(cdp, '#thoughtEditor', '第二篇自动标题\n第二行');
  // 不等待自动保存：返回列表必须先提交第二篇，才能安全新建第三篇。
  await newThoughtFromList(cdp);
  const savedAfterSwitch = await (await fetch(`${base}/api/state`)).json();
  assert.equal(savedAfterSwitch.thoughtEntries.length, 2);
  assert.equal(savedAfterSwitch.thoughtEntries.find((entry) => entry.title === '第一篇标题').text, longThoughtText);
  assert.equal(savedAfterSwitch.thoughtEntries.some((entry) => entry.text === '第二篇自动标题\n第二行'), true);
  await evaluate(cdp, `document.querySelector('[data-action="open-thought-history"]').click()`);
  await waitFor(cdp, `document.querySelector('.history-list') !== null`, '空白草稿丢弃后回到记录');
  assert.equal((await (await fetch(`${base}/api/state`)).json()).thoughtEntries.length, 2);

  await evaluate(cdp, `document.querySelector('[data-view="thoughts"]').click()`);
  await waitFor(cdp, `document.querySelectorAll('.history-record').length === 2`, '自由思考历史列表');
  await screenshot(cdp, 'thoughts-home-desktop.png');
  assert.equal(await evaluate(cdp, `document.querySelector('.history-detail') === null`), true, '列表页不应挤出小型预览栏');
  assert.equal(await evaluate(cdp, `[...document.querySelectorAll('.history-record strong')].some((el) => el.textContent.includes('第二篇自动标题'))`), true);
  assert.equal(await evaluate(cdp, `document.querySelector('#historyCategoryFilter') !== null`), true);
  await evaluate(cdp, `(() => { const s = document.querySelector('#historyCategoryFilter'); s.value = [...s.options].find((o) => !['all', 'uncategorized'].includes(o.value)).value; s.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  await waitFor(cdp, `document.querySelectorAll('.history-record').length === 1`, '类别筛选');
  await setValue(cdp, '#historySearch', '第一篇');
  const categoryFilter = await evaluate(cdp, `document.querySelector('#historyCategoryFilter').value`);
  const recordKey = await evaluate(cdp, `document.querySelector('.history-record-main').dataset.key`);
  await evaluate(cdp, `document.querySelector('.history-record-main').click()`);
  await waitFor(cdp, `document.querySelector('.history-reading-page') !== null`, '桌面独立阅读页');
  assert.equal(await evaluate(cdp, `document.querySelector('.history-list, .history-filter') === null`), true, '阅读时应隐藏列表和筛选');
  assert.equal(await evaluate(cdp, `document.querySelector('.history-text').textContent`), longThoughtText, '原文与空行不得变化');
  assert.equal(await evaluate(cdp, `document.activeElement.id`), 'historyDetailTitle');
  const readingSize = await evaluate(cdp, `(() => {
    const detail = document.querySelector('.history-detail'); const text = document.querySelector('.history-text');
    return { width: text.getBoundingClientRect().width, height: detail.getBoundingClientRect().height,
      font: parseFloat(getComputedStyle(text).fontSize), overflow: getComputedStyle(detail).overflowY };
  })()`);
  assert.ok(readingSize.width >= 900, `正文阅读区宽度不足：${readingSize.width}`);
  assert.ok(readingSize.height >= 640, '阅读页应有充分的纵向空间');
  assert.equal(readingSize.font, 18);
  assert.equal(readingSize.overflow, 'visible', '文章内不应套小滚动框');
  await screenshot(cdp, 'history-reader-desktop.png');
  await evaluate(cdp, `document.querySelector('#app').scrollTop = document.querySelector('#app').scrollHeight`);
  assert.equal(await evaluate(cdp, `document.querySelector('.history-text').getBoundingClientRect().bottom <= document.querySelector('#app').getBoundingClientRect().bottom`), true, '长文章可以滚到末尾');
  await evaluate(cdp, `document.querySelector('[data-action="back-history-list"]').click()`);
  await waitFor(cdp, `document.querySelector('#historySearch') !== null`, '返回筛选列表');
  assert.equal(await evaluate(cdp, `document.querySelector('#historySearch').value`), '第一篇');
  assert.equal(await evaluate(cdp, `document.querySelector('#historyCategoryFilter').value`), categoryFilter);
  assert.equal(await evaluate(cdp, `document.activeElement.dataset.key`), recordKey);
  await evaluate(cdp, `document.querySelector('.history-record-main').click()`);
  await evaluate(cdp, `document.querySelector('[data-action="edit-history-record"]').click()`);
  await waitFor(cdp, `document.querySelector('#thoughtEditor') !== null`, '准确编辑所读文章');
  assert.equal(await evaluate(cdp, `document.querySelector('.free-editor-card').dataset.thoughtId`), recordKey.slice('thought:'.length));
  assert.equal(await evaluate(cdp, `document.querySelector('#thoughtEditor').value`), longThoughtText);
  for (const width of [900, 1280, 1400]) {
    await cdp.send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: false });
    const metrics = await evaluate(cdp, `({
      editorWidth: document.querySelector('#thoughtEditor').getBoundingClientRect().width,
      pageWidth: document.querySelector('#app').getBoundingClientRect().width,
      hasRail: !!document.querySelector('.thought-entry-rail'),
      noOverflow: document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1
    })`);
    assert.ok(metrics.editorWidth / metrics.pageWidth >= 0.75, `${width}px 屏幕编辑区未充分展开`);
    assert.equal(metrics.hasRail, false);
    assert.equal(metrics.noOverflow, true);
  }
  await evaluate(cdp, `document.querySelector('[data-action="open-thought-history"]').click()`);
  await waitFor(cdp, `document.querySelector('.history-filter') !== null`, '再次进入历史');
  await evaluate(cdp, `document.querySelector('[data-filter="reflection"]').click()`);
  assert.equal(await evaluate(cdp, `document.querySelector('#historyCategoryFilter') === null`), true, '每日反思不应显示文章类别筛选');
  await evaluate(cdp, `document.querySelector('.history-record-main').click()`);
  await waitFor(cdp, `document.querySelector('.history-reading-page .history-qa') !== null`, '每日反思同样宽幅阅读');
  assert.equal(await evaluate(cdp, `document.querySelector('.history-qa p').textContent`), '反思第一行\n\n反思第二行');
  await evaluate(cdp, `document.querySelector('[data-action="back-history-list"]').click()`);
  assert.equal(await evaluate(cdp, `document.querySelector('[data-filter="reflection"]').getAttribute('aria-pressed')`), 'true');

  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await reloadPage(cdp);
  await waitFor(cdp, `document.querySelector('#app .page') !== null`, '移动端首页');
  await evaluate(cdp, `document.querySelector('[data-view="thoughts"]').click()`);
  await waitFor(cdp, `document.querySelectorAll('.history-record').length === 2`, '移动端默认自由思考记录');
  assert.equal(await evaluate(cdp, `document.querySelector('#thoughtEditor') === null`), true);
  await screenshot(cdp, 'thoughts-home-mobile.png');
  await evaluate(cdp, `document.querySelector('.history-record-main[data-key^="thought:"]').click()`);
  await waitFor(cdp, `document.querySelector('.history-reading-page') !== null`, '移动端从首页阅读');
  await evaluate(cdp, `document.querySelector('[data-action="edit-history-record"]').click()`);
  await waitFor(cdp, `document.querySelector('#thoughtEditor') !== null`, '移动端编辑页');
  assert.equal(await evaluate(cdp, `document.querySelector('.thought-entry-rail, [data-action="back-thought-list"]') === null`), true);
  assert.equal(await evaluate(cdp, `document.querySelector('[data-action="open-thought-history"]') !== null`), true, '手机也统一返回全部记录');
  assert.equal(await evaluate(cdp, `document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1`), true);
  await evaluate(cdp, `window.scrollTo(0, 0)`);
  await screenshot(cdp, 'thought-editor-focused-mobile.png');
  await evaluate(cdp, `document.querySelector('[data-action="open-thought-history"]').click()`);
  await waitFor(cdp, `document.querySelector('.history-record-main') !== null`, '移动端历史列表');
  await evaluate(cdp, `document.querySelector('.history-record-main').click()`);
  await waitFor(cdp, `document.querySelector('.history-reading-page') !== null`, '移动端独立阅读页');
  assert.equal(await evaluate(cdp, `document.querySelector('.history-list, .history-filter') === null`), true);
  assert.equal(await evaluate(cdp, `document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1`), true);
  await screenshot(cdp, 'history-reader-mobile.png');
  await evaluate(cdp, `window.scrollTo(0, document.documentElement.scrollHeight)`);
  assert.equal(await evaluate(cdp, `document.querySelector('.history-detail-actions').getBoundingClientRect().bottom <= innerHeight`), true);
  await evaluate(cdp, `document.querySelector('[data-action="back-history-list"]').click()`);
  assert.equal(await evaluate(cdp, `document.querySelector('.history-reading-page') === null`), true);
  // 较长列表：打开短篇、跨断点阅读，再返回原来的条目与滚动位置。
  const beforeScrollFixtures = await (await fetch(`${base}/api/state`)).json();
  const fixtureDate = beforeScrollFixtures.thoughtEntries[0].date;
  for (let i = 0; i < 14; i += 1) {
    const response = await fetch(`${base}/api/thoughts`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ date: fixtureDate, title: `阅读位置测试 ${i + 1}`, text: '短篇内容仍然使用宽松的独立阅读页。' }),
    });
    assert.equal(response.ok, true);
  }
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1400, height: 900, deviceScaleFactor: 1, mobile: false });
  await reloadPage(cdp);
  await waitFor(cdp, `document.querySelector('#app .page') !== null`, '列表位置测试首页');
  await evaluate(cdp, `document.querySelector('[data-view="thoughts"]').click()`);
  await waitFor(cdp, `document.querySelectorAll('.history-record').length === 16`, '完整自由思考历史列表');
  const listPosition = await evaluate(cdp, `(() => {
    const app = document.querySelector('#app'); app.scrollTop = 400;
    const button = [...document.querySelectorAll('.history-record-main')].find((el) => el.getBoundingClientRect().top > 300);
    return { scroll: app.scrollTop, key: button.dataset.key };
  })()`);
  await evaluate(cdp, `[...document.querySelectorAll('.history-record-main')].find((el) => el.dataset.key === ${JSON.stringify(listPosition.key)}).click()`);
  await waitFor(cdp, `document.querySelector('.history-reading-page') !== null`, '短篇阅读');
  assert.equal(await evaluate(cdp, `document.querySelector('#app').scrollTop`), 0);
  assert.ok(await evaluate(cdp, `document.querySelector('.history-detail').getBoundingClientRect().height >= 640`));
  for (const width of [900, 1280]) {
    await cdp.send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: false });
    const metrics = await evaluate(cdp, `({
      textWidth: document.querySelector('.history-text').getBoundingClientRect().width,
      pageWidth: document.querySelector('#app').getBoundingClientRect().width,
      noOverflow: document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1
    })`);
    assert.ok(metrics.textWidth / metrics.pageWidth >= 0.72, `${width}px 屏幕阅读区过窄`);
    assert.equal(metrics.noOverflow, true);
  }
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1400, height: 900, deviceScaleFactor: 1, mobile: false });
  await evaluate(cdp, `document.querySelector('[data-action="back-history-list"]').click()`);
  assert.equal(await evaluate(cdp, `document.activeElement.dataset.key`), listPosition.key);
  assert.ok(Math.abs(await evaluate(cdp, `document.querySelector('#app').scrollTop`) - listPosition.scroll) <= 1);

  // 每日复盘：同款全宽编辑器、独立类型、快速切换保存、类别与精确删除。
  const beforeReviews = await (await fetch(`${base}/api/state`)).json();
  await evaluate(cdp, `document.querySelector('[data-action="new-review"]').click()`);
  await waitFor(cdp, `document.querySelector('#thoughtEditor')?.getAttribute('aria-label') === '每日复盘内容'`, '新建每日复盘');
  assert.equal(await evaluate(cdp, `document.querySelector('.thought-tab.active').dataset.mode`), 'review');
  assert.equal(await evaluate(cdp, `document.querySelector('.thought-entry-rail') === null`), true);
  assert.ok(await evaluate(cdp, `document.querySelector('#thoughtEditor').getBoundingClientRect().width >= 950`));
  await evaluate(cdp, `document.querySelector('[data-action="open-thought-history"]').click()`);
  await waitFor(cdp, `document.querySelector('#historyPageTitle') !== null`, '丢弃空白复盘');
  assert.equal((await (await fetch(`${base}/api/state`)).json()).thoughtEntries.length, beforeReviews.thoughtEntries.length);
  await evaluate(cdp, `document.querySelector('[data-action="new-review"]').click()`);
  await waitFor(cdp, `document.querySelector('#thoughtEditor') !== null`, '复盘编辑器');
  const reviewText = '今天的收获\n\n  保留空行与缩进。\n明天继续改进。';
  await evaluate(cdp, `(() => {
    const originalFetch = window.fetch;
    window.fetch = async (...args) => {
      const response = await originalFetch(...args);
      if (String(args[0]) === '/api/thoughts' && args[1]?.method === 'POST') {
        window.fetch = originalFetch;
        await new Promise(resolve => { window.releaseReviewPost = resolve; });
      }
      return response;
    };
  })()`);
  await setValue(cdp, '#thoughtEditor', '正在书写中的首句');
  await waitFor(cdp, `typeof window.releaseReviewPost === 'function'`, '延迟首次保存响应');
  await setValue(cdp, '#thoughtEditor', reviewText);
  await evaluate(cdp, `document.querySelector('[data-mode="free"]').click(); window.releaseReviewPost();`);
  await waitFor(cdp, `document.querySelector('.thought-tab.active').dataset.mode === 'free'`, '切换前提交复盘');
  let reviewState = await (await fetch(`${base}/api/state`)).json();
  const firstReview = reviewState.thoughtEntries.find((entry) => entry.kind === 'review');
  assert.equal(firstReview.text, reviewText);
  assert.notEqual(await evaluate(cdp, `document.querySelector('#thoughtEditor').value`), reviewText);
  await evaluate(cdp, `document.querySelector('[data-mode="review"]').click()`);
  await waitFor(cdp, `document.querySelector('.thought-tab.active').dataset.mode === 'review'`, '切回复盘');
  assert.equal(await evaluate(cdp, `document.querySelector('.free-editor-card').dataset.thoughtId`), firstReview.id);
  await setValue(cdp, '#thoughtTitle', '今天值得记下的变化');
  await evaluate(cdp, `(() => { const s = document.querySelector('#thoughtCategory'); s.value = '__new__'; s.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  await waitFor(cdp, `document.querySelector('#modalInput') !== null`, '复盘快捷新建类别');
  await setValue(cdp, '#modalInput', '日常成长');
  await evaluate(cdp, `document.querySelector('#modalSubmit').click()`);
  await waitFor(cdp, `(async () => { const s = await (await fetch('/api/state')).json(); return s.thoughtEntries.find(e => e.id === ${JSON.stringify(firstReview.id)}).categoryId === s.thoughtCategories.find(c => c.name === '日常成长' && c.kind === 'review')?.id; })()`, '复盘类别保存');
  assert.equal(await evaluate(cdp, `([...document.querySelectorAll('#thoughtCategory option')].some((option) => option.textContent === '学习'))`), false, '每日复盘不应显示自由思考类别');
  await evaluate(cdp, `document.querySelector('[data-action="open-thought-history"]').click()`);
  await waitFor(cdp, `document.querySelector('.history-filter') !== null`, '复盘返回记录');
  await evaluate(cdp, `document.querySelector('[data-filter="review"]').click()`);
  assert.equal(await evaluate(cdp, `document.querySelectorAll('.history-record').length`), 1);
  assert.equal(await evaluate(cdp, `document.querySelector('.history-tag.review').textContent`), '每日复盘');
  await setValue(cdp, '#historySearch', '日常成长');
  assert.equal(await evaluate(cdp, `document.querySelectorAll('.history-record').length`), 1);
  await screenshot(cdp, 'daily-review-list-desktop.png');
  await evaluate(cdp, `document.querySelector('.history-record-main').click()`);
  assert.equal(await evaluate(cdp, `document.querySelector('.history-text').textContent`), reviewText);
  assert.equal(await evaluate(cdp, `document.querySelector('#historyDetailTitle').textContent`), '今天值得记下的变化');
  await evaluate(cdp, `document.querySelector('[data-action="edit-history-record"]').click()`);
  await waitFor(cdp, `document.querySelector('#thoughtEditor') !== null`, '精确编辑复盘');
  assert.equal(await evaluate(cdp, `document.querySelector('.free-editor-card').dataset.thoughtId`), firstReview.id);
  await screenshot(cdp, 'daily-review-editor-desktop.png');

  // 模拟保存失败：返回被阻止，重试仍然保存同一篇复盘。
  await evaluate(cdp, `(() => {
    const originalFetch = window.fetch;
    window.fetch = (...args) => {
      if (String(args[0]).includes('/api/thoughts/') && args[1]?.method === 'PATCH') {
        window.fetch = originalFetch;
        return Promise.resolve(new Response(JSON.stringify({ error: '测试保存失败' }), { status: 503, headers: { 'Content-Type': 'application/json' } }));
      }
      return originalFetch(...args);
    };
  })()`);
  await setValue(cdp, '#thoughtTitle', '复盘重试后标题');
  await evaluate(cdp, `document.querySelector('[data-action="open-thought-history"]').click()`);
  await waitFor(cdp, `document.querySelector('#thoughtStatus')?.textContent.includes('保存失败')`, '保存失败留在复盘');
  assert.equal(await evaluate(cdp, `document.querySelector('.free-editor-card').dataset.thoughtId`), firstReview.id);
  await evaluate(cdp, `document.querySelector('[data-action="retry-think-save"]').click()`);
  await waitFor(cdp, `document.querySelector('#thoughtStatus')?.textContent.includes('已保存')`, '原复盘重试成功');
  await evaluate(cdp, `document.querySelector('[data-action="open-thought-history"]').click()`);
  await waitFor(cdp, `document.querySelector('#historyPageTitle') !== null`, '重试后返回');
  await evaluate(cdp, `document.querySelector('[data-action="new-review"]').click()`);
  await waitFor(cdp, `document.querySelector('#thoughtEditor') !== null`, '同日第二篇复盘');
  await setValue(cdp, '#thoughtEditor', '第二篇复盘首行\n独立内容');
  await evaluate(cdp, `document.querySelector('[data-action="prev-date"]').click()`);
  await waitFor(cdp, `document.querySelector('#thoughtEditor') === null`, '换日期前保存复盘且不串日');
  await evaluate(cdp, `document.querySelector('[data-action="today-date"]').click()`);
  await waitFor(cdp, `document.querySelector('#thoughtEditor') !== null`, '回到今天的复盘');
  assert.equal(await evaluate(cdp, `document.querySelector('#thoughtEditor').value`), '第二篇复盘首行\n独立内容');
  await evaluate(cdp, `document.querySelector('[data-mode="reflection"]').click()`);
  await waitFor(cdp, `document.querySelector('.reflect-editor') !== null`, '每日反思仍是问答编辑');
  assert.equal(await evaluate(cdp, `document.querySelector('#thoughtEditor') === null`), true);
  await evaluate(cdp, `document.querySelector('[data-action="open-thought-history"]').click()`);
  await waitFor(cdp, `document.querySelector('#historyPageTitle') !== null`, '查看全部复盘');
  await evaluate(cdp, `document.querySelector('[data-filter="review"]').click()`);
  assert.equal(await evaluate(cdp, `document.querySelectorAll('.history-record').length`), 2);
  assert.equal(await evaluate(cdp, `document.querySelector('.history-record strong').textContent`), '第二篇复盘首行');

  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await reloadPage(cdp);
  await waitFor(cdp, `document.querySelector('#app .page') !== null`, '刷新验证复盘持久化');
  await evaluate(cdp, `document.querySelector('[data-view="thoughts"]').click()`);
  await evaluate(cdp, `document.querySelector('[data-filter="review"]').click()`);
  assert.equal(await evaluate(cdp, `document.querySelectorAll('.history-record').length`), 2);
  for (const width of [320, 390]) {
    await cdp.send('Emulation.setDeviceMetricsOverride', { width, height: 844, deviceScaleFactor: 1, mobile: true });
    assert.equal(await evaluate(cdp, `document.documentElement.scrollWidth <= innerWidth + 1`), true, '四种类型筛选不能撑出手机屏幕');
  }
  await screenshot(cdp, 'daily-review-list-mobile.png');
  await evaluate(cdp, `document.querySelector('.history-record-main').click()`);
  await evaluate(cdp, `document.querySelector('[data-action="edit-history-record"]').click()`);
  await waitFor(cdp, `document.querySelector('#thoughtEditor') !== null`, '手机复盘编辑器');
  await evaluate(cdp, `window.scrollTo(0, 0)`);
  await screenshot(cdp, 'daily-review-editor-mobile.png');
  assert.equal(await evaluate(cdp, `document.querySelector('#thoughtEditor').getAttribute('aria-label')`), '每日复盘内容');
  await evaluate(cdp, `document.querySelector('[data-action="delete-thought"]').click()`);
  await waitFor(cdp, `!document.querySelector('#modalBackdrop').classList.contains('hidden')`, '删除复盘确认');
  assert.equal(await evaluate(cdp, `document.querySelector('#modalSubmit').textContent`), '删除复盘');
  await evaluate(cdp, `document.querySelector('#modalSubmit').click()`);
  await waitFor(cdp, `(async () => (await (await fetch('/api/state')).json()).thoughtEntries.filter(e => e.kind === 'review').length === 1)()`, '仅删除第二篇复盘');
  await evaluate(cdp, `document.querySelector('[data-action="open-thought-history"]').click()`);
  await waitFor(cdp, `document.querySelector('#historyPageTitle') !== null`, '回列表删除另一篇');
  await evaluate(cdp, `document.querySelector('[data-filter="review"]').click()`);
  await evaluate(cdp, `document.querySelector('.history-record-main').click()`);
  await evaluate(cdp, `document.querySelector('[data-action="delete-history-thought"]').click()`);
  await evaluate(cdp, `document.querySelector('#modalSubmit').click()`);
  await waitFor(cdp, `document.querySelector('.history-filter') !== null`, '删除后复盘筛选保留');
  reviewState = await (await fetch(`${base}/api/state`)).json();
  assert.equal(reviewState.thoughtEntries.filter(e => e.kind === 'review').length, 0);
  assert.deepEqual(reviewState.thoughtEntries.map(({ updatedAt, ...entry }) => entry), beforeReviews.thoughtEntries.map(({ updatedAt, ...entry }) => entry), '自由思考内容不受复盘操作影响');
  assert.deepEqual(reviewState.reflectEntries, beforeReviews.reflectEntries, '每日反思不受复盘操作影响');
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1400, height: 900, deviceScaleFactor: 1, mobile: false });
  // 空列表也只有页头的小新建按钮，不回退到以新建为主的大页面。
  const existing = await (await fetch(`${base}/api/state`)).json();
  for (const thought of existing.thoughtEntries) {
    assert.equal((await fetch(`${base}/api/thoughts/${thought.id}`, { method: 'DELETE' })).ok, true);
  }
  await fetch(`${base}/api/reflect`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ date: '2026-08-01', entries: {} }) });
  await reloadPage(cdp);
  await waitFor(cdp, `document.querySelector('#app .page') !== null`, '空记录首页');
  await evaluate(cdp, `document.querySelector('[data-view="thoughts"]').click()`);
  await waitFor(cdp, `document.querySelector('#historyPageTitle') !== null`, '空记录也默认记录页面');
  assert.equal(await evaluate(cdp, `document.querySelector('#thoughtEditor, .empty-state [data-action="new-thought"]') === null`), true);
  assert.equal(await evaluate(cdp, `document.querySelectorAll('[data-action="new-thought"]').length`), 1);
  const newButton = await evaluate(cdp, `(() => { const r = document.querySelector('[data-action="new-thought"]').getBoundingClientRect(); return { width: r.width, height: r.height }; })()`);
  assert.ok(newButton.width <= 180 && newButton.height <= 44, '新建应保持小按钮');
  await runReviewImageTests({ cdp, evaluate, setValue, waitFor, reloadPage, screenshot, base, temp });
  assert.deepEqual(errors, []);
  cdp.close();
  console.log('PASS cdp-thought-v6-ui-test');
} finally {
  if (chrome) chrome.kill();
  if (server) server.kill();
  await sleep(800);
  try { fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch (_) { /* Chrome may release files later */ }
  fs.rmSync(temp, { recursive: true, force: true });
}
