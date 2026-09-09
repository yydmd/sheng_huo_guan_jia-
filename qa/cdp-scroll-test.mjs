/**
 * 纵向滚动容器修复 · 验证脚本
 * 用法: node qa/cdp-scroll-test.mjs
 * 前置: data.json 中已有超长内容（多反思卡片 / 长记录），桌面 + 移动端分别验证。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(__dirname, '..', 'qa');
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const DEBUG_PORT = 9336;
const APP = 'http://127.0.0.1:4000/';

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

async function shot(cdp, name) {
  const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(OUT, name), Buffer.from(data, 'base64'));
  console.log(`  [截图] ${name}`);
}

function check(name, cond, detail = '') {
  if (cond) console.log(`  [通过] ${name}`);
  else { failures.push(name); console.log(`  [失败] ${name} ${detail}`); }
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const profile = path.join(os.tmpdir(), `dsh-scroll-test-${Date.now()}`);
  chrome = spawn(CHROME, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--disable-http-cache',
    `--remote-debugging-port=${DEBUG_PORT}`, `--user-data-dir=${profile}`,
    '--window-size=1280,900', 'about:blank',
  ], { stdio: 'ignore' });

  const list = await waitForHttp(`http://127.0.0.1:${DEBUG_PORT}/json/list`);
  const page = (await list.json()).find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
  const cdp = await CDP.connect(page.webSocketDebuggerUrl);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Log.enable');
  await cdp.send('Network.enable');
  cdp.on('Runtime.exceptionThrown', (p) => consoleErrors.push(p.exceptionDetails?.exception?.description || p.exceptionDetails?.text || 'exception'));
  cdp.on('Log.entryAdded', (p) => { if (p.entry?.level === 'error' && !String(p.entry.text || '').includes('favicon')) consoleErrors.push(p.entry.text); });

  console.log('\n===== 滚动容器验证（桌面 1280x900） =====');

  await cdp.send('Page.navigate', { url: APP });
  await waitFor(cdp, `document.querySelector('#app .page') !== null`, 12000, '首页');
  await sleep(500);

  // 桌面：结构断言 —— #app 必须拿到确定高度（= 视口 - 顶栏），body 不滚动
  const desktopStructure = await evaluate(cdp, `
    (() => {
      const app = document.querySelector('#app');
      const ws = document.querySelector('.workspace');
      return {
        appClient: app.clientHeight,
        appScroll: app.scrollHeight,
        workspaceHeight: ws.getBoundingClientRect().height,
        viewport: window.innerHeight,
        bodyOverflow: getComputedStyle(document.body).overflow,
        appOverflow: getComputedStyle(app).overflowY,
      };
    })()
  `);
  console.log('  结构:', JSON.stringify(desktopStructure));
  check('workspace 高度锁定为视口高度', Math.abs(desktopStructure.workspaceHeight - desktopStructure.viewport) <= 2, JSON.stringify(desktopStructure));
  check('body 不参与滚动（overflow hidden）', desktopStructure.bodyOverflow === 'hidden');

  // 反思模式：7 张卡片 + 长回答 → 必须超高并在 #app 内滚动
  await evaluate(cdp, `document.querySelector('.nav-item[data-view="thoughts"]').click()`);
  await waitFor(cdp, `document.querySelector('.thought-tab') !== null`, 8000, '所思');
  await evaluate(cdp, `document.querySelector('.thought-tab[data-mode="reflection"]').click()`);
  await waitFor(cdp, `document.querySelectorAll('.reflect-editor').length === 7`, 8000, '反思卡片');
  await sleep(300);

  const reflectScroll = await evaluate(cdp, `
    (() => {
      const app = document.querySelector('#app');
      const ws = document.querySelector('.workspace');
      const cards = [...document.querySelectorAll('.reflection-card')];
      const lastCard = cards[cards.length - 1];
      return {
        client: app.clientHeight,
        scroll: app.scrollHeight,
        overflowY: getComputedStyle(app).overflowY,
        workspaceHeight: ws.getBoundingClientRect().height,
        innerHeight: window.innerHeight,
        lastCardBottom: lastCard.getBoundingClientRect().bottom,
      };
    })()
  `);
  console.log('  反思滚动:', JSON.stringify(reflectScroll));
  check('workspace 在反思页仍锁定为视口高度', Math.abs(reflectScroll.workspaceHeight - reflectScroll.innerHeight) <= 2, JSON.stringify(reflectScroll));
  check('反思内容超高（scrollHeight > clientHeight）', reflectScroll.scroll > reflectScroll.client, `scroll=${reflectScroll.scroll} client=${reflectScroll.client}`);
  check('滚动容器是 #app（overflow-y auto）', reflectScroll.overflowY === 'auto');
  check('未滚动时最后一张卡片在视口下方', reflectScroll.lastCardBottom > reflectScroll.innerHeight - 1, `bottom=${reflectScroll.lastCardBottom}`);
  await shot(cdp, 's-01-reflection-overflow.png');

  // 滚到底：最后一张卡片应完整进入视口
  await evaluate(cdp, `document.querySelector('#app').scrollTop = document.querySelector('#app').scrollHeight`);
  await sleep(400);
  const afterScroll = await evaluate(cdp, `
    (() => {
      const cards = [...document.querySelectorAll('.reflection-card')];
      const lastCard = cards[cards.length - 1];
      const app = document.querySelector('#app');
      return {
        lastCardTop: lastCard.getBoundingClientRect().top,
        lastCardBottom: lastCard.getBoundingClientRect().bottom,
        appScrollTop: app.scrollTop,
        appMax: app.scrollHeight - app.clientHeight,
        innerHeight: window.innerHeight,
      };
    })()
  `);
  console.log('  滚动到底:', JSON.stringify(afterScroll));
  check('可滚动到底（scrollTop 到达最大值）', Math.abs(afterScroll.appScrollTop - afterScroll.appMax) <= 2, JSON.stringify(afterScroll));
  check('滚动到底后最后一张卡片可见', afterScroll.lastCardBottom <= afterScroll.innerHeight + 2 && afterScroll.lastCardTop < afterScroll.innerHeight, JSON.stringify(afterScroll));
  await shot(cdp, 's-02-reflection-scrolled-bottom.png');

  // 历史详情（长记录）：#app 内部滚动且能滚到底
  await evaluate(cdp, `document.querySelector('[data-action="open-thought-history"]').click()`);
  await waitFor(cdp, `document.querySelector('.history-record') !== null`, 8000, '历史列表');
  await evaluate(cdp, `document.querySelector('.history-record[data-date="2026-08-14"] .history-record-main').click()`);
  await waitFor(cdp, `document.querySelector('.history-detail') !== null`, 5000, '历史详情');
  await sleep(300);
  const historyScroll = await evaluate(cdp, `
    (() => {
      const app = document.querySelector('#app');
      const detail = document.querySelector('.history-detail');
      return {
        client: app.clientHeight,
        scroll: app.scrollHeight,
        detailBottom: detail.getBoundingClientRect().bottom,
        innerHeight: window.innerHeight,
      };
    })()
  `);
  console.log('  历史详情滚动:', JSON.stringify(historyScroll));
  check('历史详情内容超高', historyScroll.scroll > historyScroll.client, JSON.stringify(historyScroll));
  await evaluate(cdp, `document.querySelector('#app').scrollTop = document.querySelector('#app').scrollHeight`);
  await sleep(400);
  const historyBottom = await evaluate(cdp, `document.querySelector('.history-detail').getBoundingClientRect().bottom`);
  check('历史详情可滚动到底', historyBottom <= historyScroll.innerHeight + 2, `bottom=${historyBottom}`);
  await shot(cdp, 's-03-history-detail-scrolled.png');

  // 自由模式：编辑区内容也由 #app 统一滚动（520px 编辑器在 900 视口下略超高属正常）
  await evaluate(cdp, `document.querySelector('[data-action="close-thought-history"]').click()`);
  await waitFor(cdp, `document.querySelector('.thought-tab') !== null`, 5000, '返回写作');
  await evaluate(cdp, `document.querySelector('.thought-tab[data-mode="free"]').click()`);
  await sleep(300);
  const freeScroll = await evaluate(cdp, `
    (() => {
      const app = document.querySelector('#app');
      const editor = document.querySelector('#thoughtEditor');
      return { client: app.clientHeight, scroll: app.scrollHeight, editorBottom: editor.getBoundingClientRect().bottom, innerHeight: window.innerHeight };
    })()
  `);
  check('自由模式使用 #app 统一滚动（无独立滚动条）', freeScroll.scroll > freeScroll.client ? freeScroll.editorBottom > freeScroll.innerHeight : true, JSON.stringify(freeScroll));
  await evaluate(cdp, `document.querySelector('#app').scrollTop = document.querySelector('#app').scrollHeight`);
  await sleep(300);
  const freeBottom = await evaluate(cdp, `document.querySelector('#thoughtEditor').getBoundingClientRect().bottom`);
  check('自由模式可滚动到底', freeBottom <= freeScroll.innerHeight + 2, `bottom=${freeBottom}`);

  console.log('\n===== 移动端（390x844，body 滚动） =====');
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await cdp.send('Page.reload', { ignoreCache: true });
  await waitFor(cdp, `document.querySelector('#app .page') !== null`, 12000, '移动端首页');
  await sleep(500);
  await evaluate(cdp, `document.querySelector('.nav-item[data-view="thoughts"]').click()`);
  await waitFor(cdp, `document.querySelector('.thought-tab') !== null`, 8000, '移动端所思');
  await evaluate(cdp, `document.querySelector('.thought-tab[data-mode="reflection"]').click()`);
  await waitFor(cdp, `document.querySelectorAll('.reflect-editor').length === 7`, 8000, '移动端反思卡片');
  await sleep(300);

  const mobile = await evaluate(cdp, `
    (() => {
      const se = document.scrollingElement;
      const app = document.querySelector('#app');
      const cards = [...document.querySelectorAll('.reflection-card')];
      const lastCard = cards[cards.length - 1];
      return {
        pageScroll: se.scrollHeight,
        viewport: window.innerHeight,
        appOverflow: getComputedStyle(app).overflowY,
        lastCardBottom: lastCard.getBoundingClientRect().bottom,
        bodyOverflow: getComputedStyle(document.body).overflow,
      };
    })()
  `);
  console.log('  移动端:', JSON.stringify(mobile));
  check('移动端由 body/页面滚动（#app 不内部滚动）', mobile.appOverflow !== 'auto', JSON.stringify(mobile));
  check('页面整体超高（scrollingElement.scrollHeight > 视口）', mobile.pageScroll > mobile.viewport, JSON.stringify(mobile));
  check('移动端无横向滚动', await evaluate(cdp, `document.scrollingElement.scrollWidth <= document.scrollingElement.clientWidth + 1`));

  await evaluate(cdp, `window.scrollTo(0, document.scrollingElement.scrollHeight)`);
  await sleep(400);
  const mobileBottom = await evaluate(cdp, `
    (() => {
      const cards = [...document.querySelectorAll('.reflection-card')];
      const lastCard = cards[cards.length - 1];
      return {
        lastBottom: lastCard.getBoundingClientRect().bottom,
        scrollY: window.scrollY,
        maxScroll: document.scrollingElement.scrollHeight - window.innerHeight,
        innerHeight: window.innerHeight,
      };
    })()
  `);
  console.log('  移动端滚动到底:', JSON.stringify(mobileBottom));
  check('移动端可滚动到底', Math.abs(mobileBottom.scrollY - mobileBottom.maxScroll) <= 4 && mobileBottom.lastBottom <= mobileBottom.innerHeight + 2, JSON.stringify(mobileBottom));
  await shot(cdp, 's-04-mobile-scrolled-bottom.png');

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
