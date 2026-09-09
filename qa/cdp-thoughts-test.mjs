/**
 * 所思重构 · CDP 浏览器验证脚本
 * 用法: node qa/cdp-thoughts-test.mjs [phase]
 *   phase=full   （默认）桌面 + 交互 + 移动端验证（需要有种子数据）
 *   phase=empty  （可选）历史空状态验证（需要 data.json 为空记录）
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(__dirname, '..', 'qa');
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const DEBUG_PORT = 9333;
const APP = 'http://127.0.0.1:4000/';
const phase = process.argv[2] || 'full';

const failures = [];
const consoleErrors = [];
const http404 = [];
let chrome = null;

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function waitForHttp(url, timeout = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    try {
      const res = await fetch(url);
      if (res.ok) return res;
    } catch (_) { /* retry */ }
    await sleep(200);
  }
  throw new Error(`等待 ${url} 超时`);
}

class CDP {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.listeners = new Map();
    ws.onmessage = (event) => {
      const msg = JSON.parse(event.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message));
        else resolve(msg.result);
        return;
      }
      if (msg.method) {
        for (const cb of this.listeners.get(msg.method) || []) cb(msg.params);
      }
    };
  }
  static async connect(url) {
    const ws = new WebSocket(url);
    await new Promise((resolve, reject) => {
      ws.onopen = resolve;
      ws.onerror = reject;
    });
    return new CDP(ws);
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  on(method, cb) {
    if (!this.listeners.has(method)) this.listeners.set(method, []);
    this.listeners.get(method).push(cb);
  }
  close() { try { this.ws.close(); } catch (_) { /* ignore */ } }
}

async function evaluate(cdp, expression) {
  const result = await cdp.send('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  if (result.exceptionDetails) {
    throw new Error(`页面执行出错: ${JSON.stringify(result.exceptionDetails.exception?.description || result.exceptionDetails.text)}`);
  }
  return result.result?.value;
}

async function waitFor(cdp, expression, timeout = 8000, label = '条件') {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const ok = await evaluate(cdp, expression);
    if (ok) return;
    await sleep(120);
  }
  throw new Error(`等待超时: ${label}`);
}

async function shot(cdp, name) {
  const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' });
  const file = path.join(OUT, name);
  fs.writeFileSync(file, Buffer.from(data, 'base64'));
  console.log(`  [截图] ${name}`);
}

function check(name, cond, detail = '') {
  if (cond) console.log(`  [通过] ${name}`);
  else { failures.push(name); console.log(`  [失败] ${name} ${detail}`); }
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const profile = path.join(os.tmpdir(), `dsh-thoughts-test-${Date.now()}`);

  chrome = spawn(CHROME, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    `--remote-debugging-port=${DEBUG_PORT}`, `--user-data-dir=${profile}`,
    '--window-size=1280,900', 'about:blank',
  ], { stdio: 'ignore' });

  const list = await waitForHttp(`http://127.0.0.1:${DEBUG_PORT}/json/list`);
  const targets = await list.json();
  const page = targets.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
  if (!page) throw new Error('未找到页面 target');
  const cdp = await CDP.connect(page.webSocketDebuggerUrl);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Log.enable');
  await cdp.send('Network.enable');
  cdp.on('Network.responseReceived', (p) => {
    if (p.response && p.response.status >= 400) http404.push(`${p.response.status} ${p.response.url}`);
  });
  cdp.on('Runtime.exceptionThrown', (p) => {
    consoleErrors.push(p.exceptionDetails?.exception?.description || p.exceptionDetails?.text || 'exception');
  });
  cdp.on('Log.entryAdded', (p) => {
    if (p.entry && p.entry.level === 'error' && !String(p.entry.text || '').includes('favicon')) consoleErrors.push(p.entry.text);
  });
  cdp.on('Runtime.consoleAPICalled', (p) => {
    if (p.type === 'error') consoleErrors.push('console.error');
  });

  console.log(`\n===== 阶段: ${phase} =====`);

  await cdp.send('Page.navigate', { url: APP });
  await waitFor(cdp, `document.querySelector('#app .page') !== null`, 12000, '首页渲染');
  await sleep(600);

  if (phase === 'full') {
    await shot(cdp, 't-01-home.png');

    // --- 进入所思：自由思考 ---
    await evaluate(cdp, `document.querySelector('.nav-item[data-view="thoughts"]').click()`);
    await waitFor(cdp, `document.querySelector('#thoughtEditor') !== null`, 8000, '自由思考编辑器');
    await sleep(300);
    check('进入所思默认自由思考模式', await evaluate(cdp, `document.querySelector('.thought-tab[data-mode="free"]')?.getAttribute('aria-selected') === 'true'`));
    check('不再使用双栏 thought-layout', await evaluate(cdp, `document.querySelector('.thought-layout') === null`));
    const freeHeight = await evaluate(cdp, `document.querySelector('#thoughtEditor').getBoundingClientRect().height`);
    check('自由思考输入框高度 >= 520px', freeHeight >= 520, `实际 ${Math.round(freeHeight)}px`);
    check('自由模式不显示「添加反思问题」', await evaluate(cdp, `document.querySelector('[data-action="add-framework"]') === null`));
    check('顶部有「历史记录」入口', await evaluate(cdp, `document.querySelector('[data-action="open-thought-history"]') !== null`));
    check('模式标签为 tablist/tab', await evaluate(cdp, `document.querySelector('.thought-toolbar')?.getAttribute('role') === 'tablist' && document.querySelectorAll('.thought-tab[role="tab"]').length === 2`));
    await shot(cdp, 't-02-thoughts-free.png');

    // --- 自由思考输入与保存状态 ---
    await evaluate(cdp, `
      (() => {
        const el = document.querySelector('#thoughtEditor');
        const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
        setter.call(el, '这是一条新的自由思考内容，用于验证保存状态与字数统计。');
        el.dispatchEvent(new Event('input', { bubbles: true }));
      })()
    `);
    await sleep(200);
    check('输入后状态显示「正在保存…」', await evaluate(cdp, `document.querySelector('#thoughtStatus')?.textContent === '正在保存…'`));
    check('字数统计更新', await evaluate(cdp, `document.querySelector('#thoughtCount')?.textContent.includes('字')`));
    await sleep(900);
    check('保存完成后显示「已保存」', await evaluate(cdp, `document.querySelector('#thoughtStatus')?.textContent.includes('已保存')`));
    check('保存状态带 aria-live', await evaluate(cdp, `document.querySelector('#thoughtStatus')?.getAttribute('aria-live') === 'polite'`));

    // --- 切换到每日反思 ---
    await evaluate(cdp, `document.querySelector('.thought-tab[data-mode="reflection"]').click()`);
    await waitFor(cdp, `document.querySelectorAll('.reflect-editor').length === 2`, 8000, '反思编辑器');
    await sleep(300);
    check('反思模式隐藏自由编辑器', await evaluate(cdp, `document.querySelector('#thoughtEditor') === null`));
    check('反思模式显示「添加反思问题」', await evaluate(cdp, `document.querySelector('[data-action="add-framework"]') !== null`));
    const reflectHeights = await evaluate(cdp, `[...document.querySelectorAll('.reflect-editor')].map((e) => e.getBoundingClientRect().height)`);
    check('反思回答框高度 >= 180px', reflectHeights.every((h) => h >= 180), `实际 ${reflectHeights.map((h) => Math.round(h)).join(', ')}px`);
    await shot(cdp, 't-03-thoughts-reflection.png');

    // --- tab 方向键切换 ---
    await evaluate(cdp, `
      (() => {
        const tab = document.querySelector('.thought-tab[data-mode="reflection"]');
        tab.focus();
        tab.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
      })()
    `);
    await waitFor(cdp, `document.querySelector('.thought-tab[data-mode="free"]')?.getAttribute('aria-selected') === 'true'`, 5000, '方向键切换');
    check('方向键可切换模式', true);
    await sleep(200);

    // --- 打开历史记录（桌面） ---
    await evaluate(cdp, `document.querySelector('[data-action="open-thought-history"]').click()`);
    await waitFor(cdp, `document.querySelector('.history-record') !== null`, 8000, '历史列表');
    await sleep(400);
    const recordInfo = await evaluate(cdp, `
      (() => {
        const items = [...document.querySelectorAll('.history-record')];
        const dates = items.map((it) => it.dataset.date);
        const aug8 = items.find((it) => it.dataset.date === '2026-08-08');
        return {
          count: items.length,
          dates,
          sorted: dates.every((d, i) => i === 0 || dates[i - 1] >= d),
          aug8Tags: [...aug8.querySelectorAll('.history-tag')].map((t) => t.textContent),
          todayTags: [...items[0].querySelectorAll('.history-tag')].map((t) => t.textContent),
          desktopDetail: document.querySelector('.history-detail') !== null,
          detailTitle: document.querySelector('.history-detail-title')?.textContent || '',
          detailMatchesFirst: document.querySelector('.history-detail-title')?.textContent === dateLabel(items[0].dataset.date),
        };
      })()
    `);
    check('历史按日期倒序合并（今天 → 8月8日 → 8月7日）', recordInfo.sorted && recordInfo.dates[0] === '2026-08-14' && recordInfo.dates[1] === '2026-08-08' && recordInfo.dates[2] === '2026-08-07', JSON.stringify(recordInfo.dates));
    check('8月8日两种类型都显示标签', recordInfo.aug8Tags.includes('自由思考') && recordInfo.aug8Tags.includes('每日反思'), JSON.stringify(recordInfo.aug8Tags));
    check('今天（仅有思考）只显示自由思考标签', recordInfo.todayTags.length === 1 && recordInfo.todayTags[0] === '自由思考', JSON.stringify(recordInfo.todayTags));
    check('桌面端默认选中首条并展示详情', recordInfo.desktopDetail && recordInfo.detailMatchesFirst, JSON.stringify(recordInfo));
    await shot(cdp, 't-04-history-desktop.png');

    // --- 历史搜索 ---
    await evaluate(cdp, `
      (() => {
        const el = document.querySelector('#historySearch');
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
        setter.call(el, '运动习惯');
        el.dispatchEvent(new Event('input', { bubbles: true }));
      })()
    `);
    await waitFor(cdp, `document.querySelectorAll('.history-record').length === 1`, 8000, '搜索过滤');
    check('搜索「运动习惯」只剩 1 条（8月7日）', await evaluate(cdp, `document.querySelector('.history-record')?.dataset.date === '2026-08-07'`));
    await shot(cdp, 't-05-history-search.png');

    // --- 清除搜索，类型筛选 ---
    await evaluate(cdp, `
      (() => {
        const el = document.querySelector('#historySearch');
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
        setter.call(el, '');
        el.dispatchEvent(new Event('input', { bubbles: true }));
      })()
    `);
    await waitFor(cdp, `document.querySelectorAll('.history-record').length === 3`, 8000, '恢复列表');
    await evaluate(cdp, `document.querySelector('[data-action="filter-thought-history"][data-filter="reflection"]').click()`);
    await waitFor(cdp, `document.querySelectorAll('.history-record').length === 2`, 5000, '类型筛选');
    check('筛选「每日反思」后只剩有反思的日期', await evaluate(cdp, `[...document.querySelectorAll('.history-record')].every((it) => ['2026-08-08','2026-08-07'].includes(it.dataset.date))`));
    await evaluate(cdp, `document.querySelector('[data-action="filter-thought-history"][data-filter="all"]').click()`);
    await waitFor(cdp, `document.querySelectorAll('.history-record').length === 3`, 5000, '恢复全部');

    // --- 从历史详情「编辑自由思考」（选择 8月8日） ---
    await evaluate(cdp, `document.querySelector('.history-record[data-date="2026-08-08"] .history-record-main').click()`);
    await waitFor(cdp, `document.querySelector('.history-detail') !== null`, 5000, '选中记录');
    await sleep(250);
    check('详情包含自由思考部分', await evaluate(cdp, `[...document.querySelectorAll('.history-section-head h4')].some((h) => h.textContent === '自由思考')`));
    check('详情包含每日反思部分', await evaluate(cdp, `[...document.querySelectorAll('.history-section-head h4')].some((h) => h.textContent === '每日反思')`));
    await shot(cdp, 't-06-history-detail.png');
    await evaluate(cdp, `document.querySelector('.history-record[data-date="2026-08-08"] .history-record-main').click()`);
    await sleep(200);
    await evaluate(cdp, `document.querySelector('[data-action="edit-history-record"][data-mode="free"]').click()`);
    await waitFor(cdp, `document.querySelector('#thoughtEditor') !== null`, 8000, '回到自由编辑器');
    await sleep(250);
    check('点击「编辑自由思考」回到自由模式', await evaluate(cdp, `document.querySelector('.thought-tab[data-mode="free"]')?.getAttribute('aria-selected') === 'true'`));
    check('日期切换到记录日期', await evaluate(cdp, `document.querySelector('.thoughts-page .page-head h2')?.textContent.includes('8月8日')`));
    check('焦点在编辑区', await evaluate(cdp, `document.activeElement?.id === 'thoughtEditor'`));
    await shot(cdp, 't-07-edit-back-free.png');

    // --- 从历史「继续每日反思」（选择 8月8日） ---
    await evaluate(cdp, `document.querySelector('[data-action="open-thought-history"]').click()`);
    await waitFor(cdp, `document.querySelector('.history-record') !== null`, 8000, '历史列表2');
    await evaluate(cdp, `document.querySelector('.history-record[data-date="2026-08-08"] .history-record-main').click()`);
    await waitFor(cdp, `document.querySelector('.history-detail') !== null`, 5000, '详情2');
    await evaluate(cdp, `document.querySelector('[data-action="edit-history-record"][data-mode="reflection"]').click()`);
    await waitFor(cdp, `document.querySelector('.reflect-editor') !== null`, 8000, '反思编辑器2');
    await sleep(250);
    check('点击「继续每日反思」回到反思模式', await evaluate(cdp, `document.querySelector('.thought-tab[data-mode="reflection"]')?.getAttribute('aria-selected') === 'true'`));
    check('反思编辑框已填入历史回答', await evaluate(cdp, `[...document.querySelectorAll('.reflect-editor')].some((e) => e.value.includes('完成了关键任务'))`));

    // --- 返回写作：恢复之前日期和模式 ---
    await evaluate(cdp, `document.querySelector('[data-action="open-thought-history"]').click()`);
    await waitFor(cdp, `document.querySelector('.history-record') !== null`, 8000, '历史列表3');
    await evaluate(cdp, `document.querySelector('[data-action="close-thought-history"]').click()`);
    await waitFor(cdp, `document.querySelector('.thought-tab') !== null`, 5000, '返回写作');
    check('返回写作后仍是反思模式', await evaluate(cdp, `document.querySelector('.thought-tab[data-mode="reflection"]')?.getAttribute('aria-selected') === 'true'`));
    check('返回写作后日期未变', await evaluate(cdp, `document.querySelector('.thoughts-page .page-head h2')?.textContent.includes('8月8日')`));

    // --- 移动端（390px） ---
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
    await cdp.send('Page.reload', { ignoreCache: true });
    await waitFor(cdp, `document.querySelector('#app .page') !== null`, 12000, '移动端首页');
    await sleep(500);
    await evaluate(cdp, `document.querySelector('.nav-item[data-view="thoughts"]').click()`);
    await waitFor(cdp, `document.querySelector('.thought-tab') !== null`, 8000, '移动端所思');
    await evaluate(cdp, `document.querySelector('[data-action="open-thought-history"]').click()`);
    await waitFor(cdp, `document.querySelector('.history-record') !== null`, 8000, '移动端历史列表');
    await sleep(300);
    check('移动端仅显示列表（无详情栏）', await evaluate(cdp, `document.querySelector('.history-detail') === null`));
    check('移动端无横向滚动', await evaluate(cdp, `document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1`));
    await shot(cdp, 't-08-mobile-history-list.png');
    await evaluate(cdp, `document.querySelector('.history-record:first-child .history-record-main').click()`);
    await waitFor(cdp, `document.querySelector('.history-detail') !== null`, 5000, '移动端详情');
    await sleep(250);
    check('移动端详情含「返回记录列表」', await evaluate(cdp, `document.querySelector('[data-action="back-history-list"]') !== null`));
    check('移动端详情标题获得焦点', await evaluate(cdp, `document.activeElement?.id === 'historyDetailTitle'`));
    await shot(cdp, 't-09-mobile-history-detail.png');
    await evaluate(cdp, `document.querySelector('[data-action="back-history-list"]').click()`);
    await waitFor(cdp, `document.querySelector('.history-record') !== null && document.querySelector('.history-detail') === null`, 5000, '返回列表');
    check('返回记录列表后回到列表视图', true);
    await shot(cdp, 't-10-mobile-history-list-back.png');

    // --- 移动端编辑器 ---
    await evaluate(cdp, `document.querySelector('[data-action="close-thought-history"]').click()`);
    await waitFor(cdp, `document.querySelector('.thought-tab') !== null`, 5000, '移动端写作');
    const mobileFreeHeight = await evaluate(cdp, `document.querySelector('#thoughtEditor')?.getBoundingClientRect().height || 0`);
    check('移动端自由思考高度 >= 320px', mobileFreeHeight >= 320, `实际 ${Math.round(mobileFreeHeight)}px`);
    check('移动端无横向滚动(编辑器)', await evaluate(cdp, `document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1`));
    await shot(cdp, 't-11-mobile-editor.png');
  }

  if (phase === 'empty') {
    // --- 历史空状态（空数据） ---
    await evaluate(cdp, `document.querySelector('.nav-item[data-view="thoughts"]').click()`);
    await waitFor(cdp, `document.querySelector('.thought-tab') !== null`, 8000, '所思');
    await evaluate(cdp, `document.querySelector('[data-action="open-thought-history"]').click()`);
    await waitFor(cdp, `document.querySelector('.empty-state h3') !== null`, 8000, '历史空状态');
    check('空历史显示「还没有所思记录」', await evaluate(cdp, `document.querySelector('.empty-state h3')?.textContent === '还没有所思记录'`));
    check('空历史有「开始自由思考」按钮', await evaluate(cdp, `document.querySelector('.empty-state [data-action="close-thought-history"]') !== null`));
    await shot(cdp, 't-12-history-empty.png');
    // 空状态按钮返回写作
    await evaluate(cdp, `document.querySelector('.empty-state [data-action="close-thought-history"]').click()`);
    await waitFor(cdp, `document.querySelector('#thoughtEditor') !== null`, 8000, '空状态返回写作');
    check('「开始自由思考」回到自由编辑器', true);
    await shot(cdp, 't-13-empty-back-editor.png');

    // --- 无反思问题空状态（先删除唯一框架，再刷新） ---
    const fwId = await evaluate(cdp, `(async () => { const r = await fetch('/api/state'); const d = await r.json(); return (d.reflectFrameworks[0] && d.reflectFrameworks[0].id) || ''; })()`);
    if (fwId) {
      await evaluate(cdp, `fetch('/api/reflect/frameworks/${fwId}', { method: 'DELETE' })`);
      await sleep(300);
    }
    await cdp.send('Page.reload', { ignoreCache: true });
    await waitFor(cdp, `document.querySelector('#app .page') !== null`, 12000, '刷新后首页');
    await sleep(400);
    await evaluate(cdp, `document.querySelector('.nav-item[data-view="thoughts"]').click()`);
    await waitFor(cdp, `document.querySelector('.thought-tab') !== null`, 8000, '所思2');
    await evaluate(cdp, `document.querySelector('.thought-tab[data-mode="reflection"]').click()`);
    await waitFor(cdp, `document.querySelector('.empty-state h3') !== null`, 8000, '反思空状态');
    check('无反思问题显示「还没有反思问题」', await evaluate(cdp, `document.querySelector('.empty-state h3')?.textContent === '还没有反思问题'`));
    check('空状态有「添加第一个问题」按钮', await evaluate(cdp, `document.querySelector('.empty-state [data-action="add-framework"]') !== null`));
    await shot(cdp, 't-14-reflection-empty.png');
  }

  console.log('\n----- 页面 JS 错误 / 404 -----');
  const relevant404 = http404.filter((u) => !u.includes('/favicon.ico'));
  if (consoleErrors.length || relevant404.length) {
    for (const err of consoleErrors.slice(0, 10)) console.log('  [JS错误]', String(err).slice(0, 300));
    for (const u of relevant404) console.log('  [404]', u);
    if (consoleErrors.length) failures.push(`页面 JS 错误 ${consoleErrors.length} 条`);
    if (relevant404.length) failures.push(`资源 404 ${relevant404.length} 条`);
  } else {
    console.log('  无（favicon.ico 404 为浏览器自动请求，忽略）');
  }

  cdp.close();
  chrome.kill();
  await sleep(800);
  fs.rmSync(profile, { recursive: true, force: true });

  console.log(`\n===== 结果: ${failures.length ? 'FAIL' : 'PASS'}（失败 ${failures.length} 项） =====`);
  for (const f of failures) console.log('  -', f);
  process.exit(failures.length ? 1 : 0);
}

main().catch((err) => {
  console.error('测试脚本异常:', err);
  if (chrome) { try { chrome.kill(); } catch (_) { /* ignore */ } }
  process.exit(2);
});
