/**
 * 所思 · 删除功能专项测试
 * 自由思考清空 / 反思回答清空 / 历史记录删除 + 防抖覆盖回归
 * 用法: node qa/cdp-thoughts-delete-test.mjs
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(__dirname, '..', 'qa');
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const DEBUG_PORT = 9345;
const API = 'http://127.0.0.1:4000';

const failures = [];
const consoleErrors = [];
let chrome = null;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForHttp(url, timeout = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    try { const res = await fetch(url); if (res.ok) return res; } catch (_) { /* retry */ }
    await sleep(200);
  }
  throw new Error(`等待 ${url} 超时`);
}

class CDP {
  constructor(ws) {
    this.ws = ws; this.id = 0; this.pending = new Map(); this.listeners = new Map();
    ws.onmessage = (event) => {
      const msg = JSON.parse(event.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
        return;
      }
      if (msg.method) for (const cb of this.listeners.get(msg.method) || []) cb(msg.params);
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
  on(method, cb) { if (!this.listeners.has(method)) this.listeners.set(method, []); this.listeners.get(method).push(cb); }
  close() { try { this.ws.close(); } catch (_) { /* ignore */ } }
}

async function evaluate(cdp, expression) {
  const result = await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (result.exceptionDetails) throw new Error(`页面执行出错: ${JSON.stringify(result.exceptionDetails.exception?.description || result.exceptionDetails.text)}`);
  return result.result?.value;
}

async function waitFor(cdp, expression, timeout = 8000, label = '条件') {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (await evaluate(cdp, expression)) return;
    await sleep(120);
  }
  throw new Error(`等待超时: ${label}`);
}

function check(name, cond, detail = '') {
  if (cond) console.log(`  [通过] ${name}`);
  else { failures.push(name); console.log(`  [失败] ${name} ${detail}`); }
}

async function setInputValue(cdp, selector, value) {
  await evaluate(cdp, `
    (() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return;
      const proto = el instanceof HTMLTextAreaElement ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
      setter.call(el, ${JSON.stringify(value)});
      el.dispatchEvent(new Event('input', { bubbles: true }));
    })()
  `);
}

async function stateField() {
  const st = await (await fetch(`${API}/api/state`)).json();
  return st;
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const profile = path.join(os.tmpdir(), `dsh-thoughts-del-${Date.now()}`);
  chrome = spawn(CHROME, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--disable-http-cache',
    `--remote-debugging-port=${DEBUG_PORT}`, `--user-data-dir=${profile}`,
    '--window-size=1440,900', 'about:blank',
  ], { stdio: 'ignore' });

  const list = await waitForHttp(`http://127.0.0.1:${DEBUG_PORT}/json/list`);
  const page = (await list.json()).find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
  const cdp = await CDP.connect(page.webSocketDebuggerUrl);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Log.enable');
  cdp.on('Runtime.exceptionThrown', (p) => consoleErrors.push(p.exceptionDetails?.exception?.description || p.exceptionDetails?.text || 'exception'));
  cdp.on('Log.entryAdded', (p) => { if (p.entry?.level === 'error' && !String(p.entry.text || '').includes('favicon')) consoleErrors.push(p.entry.text); });

  const today = await evaluate(cdp, `(() => { const d = new Date(); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); })()`);
  // 先清空今天的所思，从干净状态开始
  await fetch(`${API}/api/think`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ date: today, text: '' }) });
  await fetch(`${API}/api/reflect`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ date: today, entries: {} }) });

  await cdp.send('Page.navigate', { url: `${API}/` });
  await waitFor(cdp, `document.querySelector('#app .page') !== null`, 12000, '首页');
  await sleep(600);
  await evaluate(cdp, `document.querySelector('.nav-item[data-view="thoughts"]').click()`);
  await waitFor(cdp, `document.querySelector('#thoughtEditor') !== null`, 8000, '所思自由思考');

  console.log('===== 1. 自由思考清空 =====');
  await setInputValue(cdp, '#thoughtEditor', '这是一段待清空的自由思考内容。');
  await sleep(1000); // 等待防抖保存
  check('有内容时显示「清空今天的内容」', await evaluate(cdp, `document.querySelector('[data-action="clear-think"]') !== null`));
  await evaluate(cdp, `document.querySelector('[data-action="clear-think"]').click()`);
  await waitFor(cdp, `document.querySelector('#modalBackdrop:not(.hidden)') !== null`, 5000, '清空确认');
  check('清空需要二次确认', await evaluate(cdp, `document.querySelector('#modalTitle')?.textContent.includes('清空')`));
  await evaluate(cdp, `document.querySelector('#modalSubmit').click()`);
  await waitFor(cdp, `document.querySelector('#thoughtEditor')?.value === ''`, 8000, '清空完成');
  check('清空后输入框为空', true);
  check('清空后按钮消失', await evaluate(cdp, `document.querySelector('[data-action="clear-think"]') === null`));
  check('服务端已清空', (await stateField()).thinkEntries[today] === '');

  console.log('===== 2. 防抖回归：输入后立即清空不被覆盖 =====');
  await setInputValue(cdp, '#thoughtEditor', '刚输入的旧内容，马上清空。');
  await evaluate(cdp, `document.querySelector('[data-action="clear-think"]').click()`);
  await waitFor(cdp, `document.querySelector('#modalBackdrop:not(.hidden)') !== null`, 5000, '确认2');
  await evaluate(cdp, `document.querySelector('#modalSubmit').click()`);
  await sleep(1800); // 超过防抖窗口
  check('清空后内容仍为空（旧防抖未覆盖）', await evaluate(cdp, `document.querySelector('#thoughtEditor')?.value === ''`), await evaluate(cdp, `document.querySelector('#thoughtEditor')?.value`));
  check('服务端仍为空', (await stateField()).thinkEntries[today] === '');

  console.log('===== 3. 反思回答清空 =====');
  // 确保至少 2 个反思问题（不足则补充测试问题）
  {
    const st0 = await stateField();
    for (let i = st0.reflectFrameworks.length; i < 2; i += 1) {
      const r = await fetch(`${API}/api/reflect/frameworks`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: `测试问题${i + 1}` }) });
      st0.reflectFrameworks.push((await r.json()).framework);
    }
  }
  await cdp.send('Page.reload', { ignoreCache: true });
  await waitFor(cdp, `document.querySelector('#app .page') !== null`, 12000, '刷新');
  await sleep(500);
  await evaluate(cdp, `document.querySelector('.nav-item[data-view="thoughts"]').click()`);
  await waitFor(cdp, `document.querySelector('#thoughtEditor') !== null`, 8000, '所思2');
  await evaluate(cdp, `document.querySelector('.thought-tab[data-mode="reflection"]').click()`);
  await waitFor(cdp, `document.querySelectorAll('.reflect-editor').length >= 1`, 8000, '反思编辑器');
  // 给第一个问题填回答并保存
  const fwCount = await evaluate(cdp, `document.querySelectorAll('.reflect-editor').length`);
  await setInputValue(cdp, '.reflect-editor', '这是一个待清空的反思回答。');
  await sleep(1000);
  check('有回答时显示「清空回答」', await evaluate(cdp, `document.querySelector('[data-action="clear-reflect-answer"]') !== null`));
  await evaluate(cdp, `document.querySelector('[data-action="clear-reflect-answer"]').click()`);
  await waitFor(cdp, `document.querySelector('#modalBackdrop:not(.hidden)') !== null`, 5000, '回答确认');
  await evaluate(cdp, `document.querySelector('#modalSubmit').click()`);
  await waitFor(cdp, `document.querySelector('.reflect-editor')?.value === ''`, 8000, '回答清空');
  check('清空后回答为空', true);
  check('清空后按钮消失', await evaluate(cdp, `document.querySelector('[data-action="clear-reflect-answer"]') === null`));

  console.log('===== 4. 防抖回归：反思输入后立即清空 =====');
  await setInputValue(cdp, '.reflect-editor', '反思旧内容，马上清空。');
  await evaluate(cdp, `document.querySelector('[data-action="clear-reflect-answer"]').click()`);
  await waitFor(cdp, `document.querySelector('#modalBackdrop:not(.hidden)') !== null`, 5000, '确认4');
  await evaluate(cdp, `document.querySelector('#modalSubmit').click()`);
  await sleep(1800);
  check('反思清空后不被旧防抖覆盖', await evaluate(cdp, `document.querySelector('.reflect-editor')?.value === ''`), await evaluate(cdp, `document.querySelector('.reflect-editor')?.value`));

  console.log('===== 5. 历史记录删除 =====');
  // 造一条 2026-08-01 的历史记录（API 写入后刷新页面同步前端 state）
  await fetch(`${API}/api/think`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ date: '2026-08-01', text: '这是一条待删除的历史自由思考。' }) });
  await cdp.send('Page.reload', { ignoreCache: true });
  await waitFor(cdp, `document.querySelector('#app .page') !== null`, 12000, '刷新2');
  await sleep(500);
  await evaluate(cdp, `document.querySelector('.nav-item[data-view="thoughts"]').click()`);
  await waitFor(cdp, `document.querySelector('.thought-tab') !== null`, 8000, '所思3');
  await evaluate(cdp, `document.querySelector('[data-action="open-thought-history"]').click()`);
  await waitFor(cdp, `document.querySelector('.history-record') !== null`, 8000, '历史列表');
  await evaluate(cdp, `document.querySelector('.history-record[data-date="2026-08-01"] .history-record-main').click()`);
  await waitFor(cdp, `document.querySelector('.history-detail') !== null`, 5000, '历史详情');
  check('历史详情有「删除这条记录」', await evaluate(cdp, `document.querySelector('[data-action="delete-history-record"]') !== null`));
  await evaluate(cdp, `document.querySelector('[data-action="delete-history-record"]').click()`);
  await waitFor(cdp, `document.querySelector('#modalBackdrop:not(.hidden)') !== null`, 5000, '删除确认');
  check('删除提示包含日期', await evaluate(cdp, `(document.querySelector('#modalTitle')?.textContent + document.querySelector('.modal-message')?.textContent).includes('8月1日')`));
  await evaluate(cdp, `document.querySelector('#modalSubmit').click()`);
  await waitFor(cdp, `document.querySelector('.empty-state h3')?.textContent === '还没有所思记录' || document.querySelectorAll('.history-record').length === 0`, 8000, '删除完成');
  check('删除后记录消失（回到空状态或列表不含该日期）', await evaluate(cdp, `!document.querySelector('.history-record[data-date="2026-08-01"]')`));
  check('服务端已清空该日期', !((await stateField()).thinkEntries['2026-08-01'] || '').trim());

  console.log('\n----- 页面 JS 错误 -----');
  if (consoleErrors.length) {
    for (const err of consoleErrors.slice(0, 10)) console.log('  [JS错误]', String(err).slice(0, 300));
    failures.push(`页面 JS 错误 ${consoleErrors.length} 条`);
  } else {
    console.log('  无');
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
