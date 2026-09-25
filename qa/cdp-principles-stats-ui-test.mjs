/** 统计回顾 UI 回归：临时数据、临时服务、无真实记录写入。 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'life-steward-stats-ui-'));
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'life-steward-stats-chrome-'));
const appPort = 47000 + Math.floor(Math.random() * 400);
const debugPort = 47400 + Math.floor(Math.random() * 400);
const base = `http://127.0.0.1:${appPort}`;
const chromePath = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
let server;
let chrome;

function iso(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function offsetDate(amount) {
  const date = new Date();
  date.setDate(date.getDate() + amount);
  return iso(date);
}

async function waitHttp(url) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return response;
    } catch (_) { /* retry */ }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`等待服务超时：${url}`);
}

class CDP {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    ws.onmessage = (event) => {
      const message = JSON.parse(event.data);
      if (!message.id || !this.pending.has(message.id)) return;
      const { resolve, reject } = this.pending.get(message.id);
      this.pending.delete(message.id);
      message.error ? reject(new Error(message.error.message)) : resolve(message.result);
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
}

async function evaluate(cdp, expression) {
  const result = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
  return result.result.value;
}

async function waitFor(cdp, expression, label) {
  const deadline = Date.now() + 7000;
  while (Date.now() < deadline) {
    if (await evaluate(cdp, expression)) return;
    await new Promise((resolve) => setTimeout(resolve, 80));
  }
  throw new Error(`等待失败：${label}`);
}

const yesterday = offsetDate(-1);
const beforeChildren = offsetDate(-3);
const seed = {
  version: 10,
  sections: [{
    id: 'section-review', name: '复盘原则', items: [{
      id: 'parent-review', name: '父条目', activeSince: offsetDate(-20), children: [
        { id: 'child-done', name: '子节点一', activeSince: yesterday },
        { id: 'child-incomplete', name: '子节点二', activeSince: yesterday },
        { id: 'child-missed', name: '子节点三', activeSince: yesterday },
      ],
    }],
  }],
  records: {
    [beforeChildren]: { 'parent-review': true },
    [yesterday]: { 'child-done': true, 'child-incomplete': false },
  },
  checkinReasons: {
    [yesterday]: { 'child-incomplete': '没有留出完整时间', 'child-missed': '临时会议打断' },
  },
  thoughtEntries: [], thoughtCategories: [], reflectFrameworks: [], reflectEntries: {}, plans: [], problems: [],
  events: [], eventCheckins: {}, eventExceptions: [],
};

try {
  fs.copyFileSync(path.join(root, 'server.js'), path.join(temp, 'server.js'));
  fs.cpSync(path.join(root, 'public'), path.join(temp, 'public'), { recursive: true });
  fs.mkdirSync(path.join(temp, 'data'));
  fs.writeFileSync(path.join(temp, 'data', 'data.json'), JSON.stringify(seed, null, 2));
  server = spawn(process.execPath, ['server.js', '--port', String(appPort), '--no-open'], { cwd: temp, stdio: 'ignore' });
  await waitHttp(`${base}/api/state`);

  chrome = spawn(chromePath, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--disable-http-cache',
    `--remote-debugging-port=${debugPort}`, `--user-data-dir=${profile}`, '--window-size=1400,1000', 'about:blank',
  ], { stdio: 'ignore' });
  const pages = await (await waitHttp(`http://127.0.0.1:${debugPort}/json/list`)).json();
  const target = pages.find((page) => page.type === 'page');
  const cdp = await CDP.connect(target.webSocketDebuggerUrl);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Page.navigate', { url: base });
  await waitFor(cdp, `document.querySelector('[data-view="principles"]') && document.querySelector('#app [data-action="open-event-drawer"]')`, '应用加载');
  await evaluate(cdp, `document.querySelector('[data-view="principles"]').click()`);
  await waitFor(cdp, `document.querySelector('[data-action="principle-tab"][data-tab="stats"]')`, '原则页加载');
  await evaluate(cdp, `document.querySelector('[data-action="principle-tab"][data-tab="stats"]').click()`);
  await waitFor(cdp, `document.querySelector('.stats-review-page')`, '统计回顾加载');

  assert.equal(await evaluate(cdp, `document.querySelectorAll('.heat-day').length`), 60, '热力图应展示 60 天');
  assert.equal(await evaluate(cdp, `document.querySelector('.heat-day.selected').dataset.date`), yesterday, '默认应选中昨天');
  assert.equal(await evaluate(cdp, `document.querySelectorAll('.daily-review-row.done').length`), 0, '已完成项默认应折叠');
  assert.equal(await evaluate(cdp, `document.querySelectorAll('.daily-review-row.incomplete').length`), 1);
  assert.equal(await evaluate(cdp, `document.querySelectorAll('.daily-review-row.missed').length`), 1);
  assert.equal(await evaluate(cdp, `document.querySelectorAll('.reason-timeline-item').length`), 2);

  await evaluate(cdp, `document.querySelector('[data-action="stats-filter"][data-filter="missed"]').click()`);
  assert.equal(await evaluate(cdp, `document.querySelectorAll('.daily-review-row').length`), 1, '未打卡筛选应只保留未打卡条目');
  assert.equal(await evaluate(cdp, `document.querySelector('.daily-review-row').id`), 'review-node-child-missed');

  await evaluate(cdp, `document.querySelector('.heat-day[data-date="${beforeChildren}"]').click()`);
  await waitFor(cdp, `document.querySelector('[data-action="stats-toggle-completed"]')`, '历史日期完成汇总');
  await evaluate(cdp, `document.querySelector('[data-action="stats-toggle-completed"]').click()`);
  await waitFor(cdp, `document.querySelector('#review-node-parent-review')`, '子节点启用前展示父条目');
  assert.equal(await evaluate(cdp, `document.querySelectorAll('[id^="review-node-child-"]').length`), 0, '历史日期不应提前展示子节点');

  await evaluate(cdp, `document.querySelector('.heat-day[data-date="${yesterday}"]').click()`);
  await evaluate(cdp, `(() => { const input = document.querySelector('#reasonTimelineSearch'); input.value = '子节点三'; input.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  assert.equal(await evaluate(cdp, `document.querySelectorAll('.reason-timeline-item').length`), 1, '原因时间线搜索应立即过滤');

  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  assert.equal(await evaluate(cdp, `document.documentElement.scrollWidth <= innerWidth + 1`), true, '窄屏不应产生页面横向溢出');
  assert.equal(await evaluate(cdp, `document.querySelector('.heat-calendar-scroll').scrollWidth > 0`), true);
  console.log('统计回顾 UI 测试通过');
  cdp.ws.close();
} finally {
  if (chrome && chrome.exitCode === null) { chrome.kill(); await once(chrome, 'exit'); }
  if (server && server.exitCode === null) { server.kill(); await once(server, 'exit'); }
  try { fs.rmSync(temp, { recursive: true, force: true, maxRetries: 10, retryDelay: 150 }); } catch (_) { /* Windows may briefly retain a handle */ }
  try { fs.rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 150 }); } catch (_) { /* Windows may briefly retain a handle */ }
}
