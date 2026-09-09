/**
 * 计划页左侧卡片横向溢出 · 复现/验证脚本（只读，不改动数据）
 * 用法: node qa/cdp-plan-overflow-test.mjs
 * 前置: 服务器已在 4001 端口运行，且 data.json 里有「8.19每日学习计划」这条长描述计划。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(__dirname, '..', 'qa');
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const DEBUG_PORT = 9341;
const APP = 'http://127.0.0.1:4001/';

const failures = [];
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
    this.ws = ws; this.id = 0; this.pending = new Map();
    ws.onmessage = (event) => {
      const msg = JSON.parse(event.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
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

const MEASURE = `
  (() => {
    const rail = document.querySelector('.plan-rail');
    const list = document.querySelector('.plan-list');
    const row = document.querySelector('.plan-list-row');
    const select = row.querySelector('.plan-select');
    const name = row.querySelector('.plan-name');
    const preview = row.querySelector('.plan-preview');
    const r = (el) => { const b = el.getBoundingClientRect(); return { left: Math.round(b.left), right: Math.round(b.right), width: Math.round(b.width) }; };
    return {
      rail: r(rail),
      list: r(list),
      row: r(row),
      select: r(select),
      nameScrollWidth: name.scrollWidth,
      nameClientWidth: name.clientWidth,
      previewScrollWidth: preview.scrollWidth,
      previewClientWidth: preview.clientWidth,
      nameEllipsized: name.scrollWidth > name.clientWidth,
      previewEllipsized: preview.scrollWidth > preview.clientWidth,
      docNoHScroll: document.scrollingElement.scrollWidth <= document.scrollingElement.clientWidth + 1,
      rowComputed: {
        minWidth: getComputedStyle(row).minWidth,
        overflow: getComputedStyle(row).overflow,
      },
      selectComputed: {
        minWidth: getComputedStyle(select).minWidth,
        overflow: getComputedStyle(select).overflow,
      },
    };
  })()
`;

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const profile = path.join(os.tmpdir(), `dsh-overflow-test-${Date.now()}`);
  chrome = spawn(CHROME, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--disable-http-cache',
    `--remote-debugging-port=${DEBUG_PORT}`, `--user-data-dir=${profile}`,
    '--window-size=1600,1000', 'about:blank',
  ], { stdio: 'ignore' });

  const list = await waitForHttp(`http://127.0.0.1:${DEBUG_PORT}/json/list`);
  const page = (await list.json()).find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
  const cdp = await CDP.connect(page.webSocketDebuggerUrl);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');

  await cdp.send('Page.navigate', { url: APP });
  await waitFor(cdp, `document.querySelector('#app .page') !== null`, 12000, '首页');
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false });
  await cdp.send('Page.reload', { ignoreCache: true });
  await waitFor(cdp, `document.querySelector('#app .page') !== null`, 12000, '重载');
  await sleep(400);
  await evaluate(cdp, `document.querySelector('.nav-item[data-view="plans"]').click()`);
  await waitFor(cdp, `document.querySelector('.plan-list-row') !== null`, 8000, '计划列表');
  await sleep(400);

  const m = await evaluate(cdp, MEASURE);
  console.log('  测量:', JSON.stringify(m));
  const rowOverRail = m.row.right - m.rail.right;
  check('卡片右缘不超出左栏右缘', rowOverRail <= 1, `超出 ${rowOverRail}px`);
  check('卡片宽度 ≤ 左栏宽度', m.row.width <= m.rail.width + 1, `卡片 ${m.row.width} vs 左栏 ${m.rail.width}`);
  check('计划名称省略号截断', m.nameEllipsized || m.nameScrollWidth <= m.select.width, `scroll ${m.nameScrollWidth} / client ${m.nameClientWidth}`);
  check('计划预览省略号截断', m.previewEllipsized, `scroll ${m.previewScrollWidth} / client ${m.previewClientWidth}`);
  check('页面无横向滚动', m.docNoHScroll);
  await shot(cdp, 'overflow-check.png');

  // 打开「更多」菜单，确认不被裁剪
  await evaluate(cdp, `document.querySelector('[data-action="open-plan-menu"]').click()`);
  await waitFor(cdp, `document.querySelector('.plan-menu') !== null`, 5000, '更多菜单');
  await sleep(200);
  const menu = await evaluate(cdp, `
    (() => {
      const menu = document.querySelector('.plan-menu');
      const row = document.querySelector('.plan-list-row');
      const mb = menu.getBoundingClientRect();
      const rb = row.getBoundingClientRect();
      const items = [...document.querySelectorAll('.plan-menu-item')].map((i) => i.textContent.trim());
      return { menuBottom: Math.round(mb.bottom), rowBottom: Math.round(rb.bottom), menuHeight: Math.round(mb.height), items };
    })()
  `);
  console.log('  菜单:', JSON.stringify(menu));
  check('更多菜单完整展开（3 项，超出卡片底部仍可见）', menu.items.length === 3 && menu.menuBottom > menu.rowBottom + 100, JSON.stringify(menu));
  await shot(cdp, 'overflow-menu-check.png');

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
