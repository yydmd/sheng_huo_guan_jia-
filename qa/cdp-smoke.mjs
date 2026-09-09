/**
 * 快速冒烟：真实用户数据下遍历所有视图，确认无 JS 错误与关键渲染。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9338;
const APP = 'http://127.0.0.1:4000/';
const failures = [];
const consoleErrors = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitForHttp(url, t = 15000) { const s = Date.now(); while (Date.now() - s < t) { try { const r = await fetch(url); if (r.ok) return r; } catch (_) {} await sleep(200); } throw new Error('timeout'); }
class CDP {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map(); this.listeners = new Map();
    ws.onmessage = (e) => { const m = JSON.parse(e.data);
      if (m.id && this.pending.has(m.id)) { const p = this.pending.get(m.id); this.pending.delete(m.id); m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result); return; }
      if (m.method) for (const cb of this.listeners.get(m.method) || []) cb(m.params); }; }
  static async connect(url) { const ws = new WebSocket(url); await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; }); return new CDP(ws); }
  send(method, params = {}) { const id = ++this.id; return new Promise((resolve, reject) => { this.pending.set(id, { resolve, reject }); this.ws.send(JSON.stringify({ id, method, params })); }); }
  on(method, cb) { if (!this.listeners.has(method)) this.listeners.set(method, []); this.listeners.get(method).push(cb); }
  close() { try { this.ws.close(); } catch (_) { /* ignore */ } }
}
async function ev(cdp, expression) {
  const r = await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error('页面异常: ' + JSON.stringify(r.exceptionDetails.exception?.description || r.exceptionDetails.text));
  return r.result?.value;
}
async function waitFor(cdp, expr, t = 8000, label = '') {
  const s = Date.now(); while (Date.now() - s < t) { if (await ev(cdp, expr)) return; await sleep(120); }
  throw new Error('等待超时: ' + label);
}
function check(name, cond, detail = '') {
  if (cond) console.log(`  [通过] ${name}`); else { failures.push(name); console.log(`  [失败] ${name} ${detail}`); }
}

const chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-first-run', '--disable-http-cache', `--remote-debugging-port=${PORT}`, `--user-data-dir=${path.join(os.tmpdir(), 'smoke-' + Date.now())}`, '--window-size=1440,900', 'about:blank'], { stdio: 'ignore' });
try {
  const list = await waitForHttp(`http://127.0.0.1:${PORT}/json/list`);
  const page = (await list.json()).find((t) => t.type === 'page');
  const cdp = await CDP.connect(page.webSocketDebuggerUrl);
  await cdp.send('Page.enable'); await cdp.send('Runtime.enable'); await cdp.send('Log.enable');
  cdp.on('Runtime.exceptionThrown', (p) => consoleErrors.push(p.exceptionDetails?.exception?.description || p.exceptionDetails?.text));
  cdp.on('Log.entryAdded', (p) => { if (p.entry?.level === 'error' && !String(p.entry.text || '').includes('favicon')) consoleErrors.push(p.entry.text); });
  await cdp.send('Page.navigate', { url: APP });
  await waitFor(cdp, `document.querySelector('#app .page') !== null`, 12000, '首页');

  const views = [
    ['events', `document.querySelector('.events-page') !== null`],
    ['thoughts', `document.querySelector('.thought-tab') !== null`],
    ['plans', `document.querySelector('.plan-workspace-panel') !== null`],
  ];
  for (const [view, cond] of views) {
    await ev(cdp, `document.querySelector('.nav-item[data-view="${view}"]').click()`);
    await waitFor(cdp, cond, 8000, view);
    check(`${view} 视图正常渲染`, true);
  }
  // 所思：自由/反思切换 + 历史空状态
  await ev(cdp, `document.querySelector('.nav-item[data-view="thoughts"]').click()`);
  await waitFor(cdp, `document.querySelector('.thought-tab') !== null`, 8000, '所思');
  await ev(cdp, `(async () => { const d = await (await fetch('/api/state')).json(); window.__smokeFw = d.reflectFrameworks.length; return d.reflectFrameworks.length; })()`);
  await ev(cdp, `document.querySelector('.thought-tab[data-mode="reflection"]').click()`);
  await waitFor(cdp, `document.querySelectorAll('.reflect-editor').length === window.__smokeFw`, 5000, '反思编辑器');
  check('反思模式显示全部问题卡片', await ev(cdp, `document.querySelectorAll('.reflect-editor').length === window.__smokeFw`));
  await ev(cdp, `document.querySelector('[data-action="open-thought-history"]').click()`);
  await waitFor(cdp, `document.querySelector('.empty-state h3') !== null || document.querySelector('.history-record') !== null`, 8000, '历史视图');
  check('历史视图可打开', true);
  await ev(cdp, `document.querySelector('.empty-state [data-action="close-thought-history"], [data-action="close-thought-history"]')?.click()`);
  await waitFor(cdp, `document.querySelector('.thought-tab') !== null`, 5000, '返回写作');
  check('返回写作正常', await ev(cdp, `document.querySelector('.thought-tab') !== null`));

  // 计划：渲染 + 更多菜单
  await ev(cdp, `document.querySelector('.nav-item[data-view="plans"]').click()`);
  await waitFor(cdp, `document.querySelector('.plan-workspace-panel') !== null`, 8000, '计划');
  check('计划列表正常渲染', await ev(cdp, `document.querySelectorAll('.plan-list-row').length >= 1`));
  await ev(cdp, `document.querySelector('[data-action="open-plan-menu"]').click()`);
  await waitFor(cdp, `document.querySelector('.plan-menu') !== null`, 5000, '更多菜单');
  check('更多菜单可打开', true);
  await ev(cdp, `document.querySelector('.plan-menu [data-action="move-plan"][data-dir="up"]')?.click()`);
  await sleep(400);
  check('禁用项点击无异常', true);

  console.log('\n----- JS 错误 -----');
  if (consoleErrors.length) { for (const e of consoleErrors.slice(0, 10)) console.log('  ', String(e).slice(0, 200)); failures.push('JS 错误'); }
  else console.log('  无');
  cdp.close(); chrome.kill();
  console.log(`\n结果: ${failures.length ? 'FAIL' : 'PASS'}`);
  process.exit(failures.length ? 1 : 0);
} catch (e) { console.error('异常:', e.message); chrome.kill(); process.exit(2); }
