/**
 * 事件备注展示验证：日程预览/展开、固定安排显示
 * 用法: node qa/cdp-event-note-test.mjs
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const DEBUG_PORT = 9346;
const API = 'http://127.0.0.1:4000';
const failures = [];
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
}
async function ev(cdp, expression) {
  const r = await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error('页面异常: ' + JSON.stringify(r.exceptionDetails.exception?.description || r.exceptionDetails.text));
  return r.result?.value;
}
async function waitFor(cdp, expr, t = 8000) { const s = Date.now(); while (Date.now() - s < t) { if (await ev(cdp, expr)) return; await sleep(120); } throw new Error('wait timeout: ' + expr.slice(0, 90)); }
async function setVal(cdp, selector, value) {
  await ev(cdp, `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return; const proto = el instanceof HTMLTextAreaElement ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype; const setter = Object.getOwnPropertyDescriptor(proto, 'value').set; setter.call(el, ${JSON.stringify(value)}); el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); })()`);
}
function check(name, cond, detail = '') { if (cond) console.log(`  [通过] ${name}`); else { failures.push(name); console.log(`  [失败] ${name} ${detail}`); } }

const chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-first-run', '--disable-http-cache', `--remote-debugging-port=${DEBUG_PORT}`, `--user-data-dir=${path.join(os.tmpdir(), 'note-' + Date.now())}`, '--window-size=1440,900', 'about:blank'], { stdio: 'ignore' });
try {
  const list = await waitForHttp(`http://127.0.0.1:${DEBUG_PORT}/json/list`);
  const page = (await list.json()).find((t) => t.type === 'page');
  const cdp = await CDP.connect(page.webSocketDebuggerUrl);
  await cdp.send('Page.enable'); await cdp.send('Runtime.enable'); await cdp.send('Log.enable');
  const errs = [];
  cdp.on('Runtime.exceptionThrown', (p) => errs.push(p.exceptionDetails?.exception?.description || p.exceptionDetails?.text));
  cdp.on('Log.entryAdded', (p) => { if (p.entry?.level === 'error') errs.push(p.entry.text); });
  await cdp.send('Page.navigate', { url: `${API}/` });
  await waitFor(cdp, `document.querySelector('#app .page') !== null`);
  await sleep(600);

  console.log('=== 添加带备注的事件 ===');
  await ev(cdp, `document.querySelector('[data-action="open-event-drawer"]').click()`);
  await waitFor(cdp, `document.querySelector('#eventTitleInput') !== null`);
  await setVal(cdp, '#eventTitleInput', '带备注的事件');
  await setVal(cdp, '#eventTimeField', '14:00');
  await setVal(cdp, '#eventNoteInput', '第一行备注：记得带上方案文档。\n第二行：会议结束后同步给团队。\n第三行：这是超长的备注内容，用于验证预览省略与展开效果。');
  await ev(cdp, `document.querySelector('#eventDrawerSave').click()`);
  await waitFor(cdp, `[...document.querySelectorAll('.event-title')].some((e) => e.textContent === '带备注的事件')`, 8000, '事件出现');

  console.log('=== 日程页备注预览与展开 ===');
  const noteInfo = await ev(cdp, `
    (() => {
      const row = [...document.querySelectorAll('.event-row')].find((r) => r.querySelector('.event-title')?.textContent === '带备注的事件');
      const note = row.querySelector('.event-note');
      if (!note) return { exists: false };
      const cs = getComputedStyle(note);
      return {
        exists: true,
        text: note.textContent,
        clamp: cs.webkitLineClamp,
        overflow: cs.overflow,
        expanded: note.classList.contains('expanded'),
      };
    })()
  `);
  console.log('  备注信息:', JSON.stringify(noteInfo));
  check('事件行显示备注', noteInfo.exists);
  check('备注默认预览（最多 2 行省略）', noteInfo.clamp === '2' && noteInfo.overflow === 'hidden', JSON.stringify(noteInfo));
  check('预览包含第一行内容', noteInfo.text.includes('记得带上方案文档'));
  // 展开
  await ev(cdp, `[...document.querySelectorAll('.event-row')].find((r) => r.querySelector('.event-title')?.textContent === '带备注的事件').querySelector('.event-note').click()`);
  await sleep(300);
  const expandedInfo = await ev(cdp, `
    (() => {
      const row = [...document.querySelectorAll('.event-row')].find((r) => r.querySelector('.event-title')?.textContent === '带备注的事件');
      const note = row.querySelector('.event-note');
      const cs = getComputedStyle(note);
      return { expanded: note.classList.contains('expanded'), clamp: cs.webkitLineClamp, text: note.textContent };
    })()
  `);
  console.log('  展开后:', JSON.stringify(expandedInfo));
  check('点击备注后展开完整内容', expandedInfo.expanded && expandedInfo.clamp !== '2' && expandedInfo.text.includes('超长的备注内容'), JSON.stringify(expandedInfo));
  // 收起
  await ev(cdp, `[...document.querySelectorAll('.event-row')].find((r) => r.querySelector('.event-title')?.textContent === '带备注的事件').querySelector('.event-note').click()`);
  await sleep(300);
  check('再次点击收起', await ev(cdp, `![...document.querySelectorAll('.event-row')].find((r) => r.querySelector('.event-title')?.textContent === '带备注的事件').querySelector('.event-note').classList.contains('expanded')`));
  // 无备注事件不显示备注区
  await ev(cdp, `document.querySelector('[data-action="open-event-drawer"]').click()`);
  await waitFor(cdp, `document.querySelector('#eventTitleInput') !== null`);
  await setVal(cdp, '#eventTitleInput', '无备注事件');
  await ev(cdp, `document.querySelector('#eventDrawerSave').click()`);
  await waitFor(cdp, `[...document.querySelectorAll('.event-title')].some((e) => e.textContent === '无备注事件')`, 8000, '无备注事件');
  check('无备注的事件不显示备注区', await ev(cdp, `![...document.querySelectorAll('.event-row')].find((r) => r.querySelector('.event-title')?.textContent === '无备注事件').querySelector('.event-note')`));

  console.log('=== 固定安排页备注 ===');
  // 把带备注的事件改成每天，验证固定安排显示备注
  await ev(cdp, `[...document.querySelectorAll('.event-row')].find((r) => r.querySelector('.event-title')?.textContent === '带备注的事件').querySelector('[data-action="open-event-menu"]').click()`);
  await waitFor(cdp, `document.querySelector('.event-menu') !== null`);
  await ev(cdp, `document.querySelector('.event-menu [data-action="edit-event-instance"]').click()`);
  await waitFor(cdp, `document.querySelector('#eventTitleInput') !== null`);
  await ev(cdp, `(() => { const el = document.querySelector('#eventRepeatSelect'); el.value = 'daily'; el.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  await ev(cdp, `document.querySelector('#eventDrawerSave').click()`);
  await sleep(1200);
  await ev(cdp, `document.querySelector('[data-action="event-mode"][data-mode="recurring"]').click()`);
  await waitFor(cdp, `[...document.querySelectorAll('.recurring-title')].some((e) => e.textContent === '带备注的事件')`, 8000, '固定安排');
  const recNote = await ev(cdp, `[...document.querySelectorAll('.recurring-row')].find((r) => r.querySelector('.recurring-title')?.textContent === '带备注的事件').querySelector('.recurring-note')?.textContent || null`);
  check('固定安排页显示模板备注', recNote && recNote.includes('记得带上方案文档'), recNote);

  console.log('\n页面 JS 错误:', JSON.stringify(errs));
  if (errs.length) failures.push('JS 错误');
  chrome.kill();
  console.log(`\n结果: ${failures.length ? 'FAIL' : 'PASS'}（失败 ${failures.length} 项）`);
  process.exit(failures.length ? 1 : 0);
} catch (e) { console.error('ERR', e.message); chrome.kill(); process.exit(2); }
