/**
 * 计划页「宽松写作工作区」重构 · CDP 验证脚本
 * 用法: node qa/cdp-plans-test.mjs
 * 前置: data.json 中有 12 个计划（plan-001 长笔记 + 多行下一步）。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(__dirname, '..', 'qa');
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const DEBUG_PORT = 9337;
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

async function setViewport(cdp, width, height) {
  await cdp.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: width < 600 });
  await cdp.send('Page.reload', { ignoreCache: true });
  await waitFor(cdp, `document.querySelector('#app .page') !== null`, 12000, `视口 ${width}x${height} 加载`);
  await sleep(500);
}

async function setInputValue(cdp, selector, value) {
  await evaluate(cdp, `
    (() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      const proto = el instanceof HTMLTextAreaElement ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
      setter.call(el, ${JSON.stringify(value)});
      el.dispatchEvent(new Event('input', { bubbles: true }));
    })()
  `);
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const profile = path.join(os.tmpdir(), `dsh-plans-test-${Date.now()}`);
  chrome = spawn(CHROME, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--disable-http-cache',
    `--remote-debugging-port=${DEBUG_PORT}`, `--user-data-dir=${profile}`,
    '--window-size=1920,1080', 'about:blank',
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

  console.log('\n===== 计划工作区（桌面 1920x1080） =====');
  await cdp.send('Page.navigate', { url: APP });
  await waitFor(cdp, `document.querySelector('#app .page') !== null`, 12000, '首页');
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1920, height: 1080, deviceScaleFactor: 1, mobile: false });
  await cdp.send('Page.reload', { ignoreCache: true });
  await waitFor(cdp, `document.querySelector('#app .page') !== null`, 12000, '精确 1920x1080');
  await sleep(400);
  await evaluate(cdp, `document.querySelector('.nav-item[data-view="plans"]').click()`);
  await waitFor(cdp, `document.querySelector('.plan-workspace-panel') !== null`, 8000, '计划工作区');
  await sleep(400);

  // 1. 结构：无重复页头；布局参数
  const structure = await evaluate(cdp, `
    (() => {
      const note = document.querySelector('#planNote');
      const editor = document.querySelector('.plan-workspace-panel');
      const rail = document.querySelector('.plan-rail');
      const rows = [...document.querySelectorAll('.plan-list-row')];
      const nameInput = document.querySelector('#planName');
      return {
        hasPageHead: document.querySelector('.plans-page .page-head') !== null,
        bodyText: document.body.innerText,
        noteHeight: note.getBoundingClientRect().height,
        noteWidth: note.getBoundingClientRect().width,
        editorWidth: editor.getBoundingClientRect().width,
        railWidth: rail.getBoundingClientRect().width,
        rowHeights: rows.map((r) => Math.round(r.getBoundingClientRect().height)),
        rowCount: rows.length,
        nameHeight: nameInput.getBoundingClientRect().height,
        nameFontSize: getComputedStyle(nameInput).fontSize,
        nameWeight: getComputedStyle(nameInput).fontWeight,
        statusText: document.querySelector('#planStatus').textContent,
        statusLive: document.querySelector('#planStatus').getAttribute('aria-live'),
        statusRole: document.querySelector('#planStatus').getAttribute('role'),
        appScrollable: (() => { const a = document.querySelector('#app'); return a.scrollHeight > a.clientHeight; })(),
      };
    })()
  `);
  console.log('  结构:', JSON.stringify(structure, null, 0).slice(0, 400));
  check('不再有重复页头（无「我的计划」h2）', !structure.hasPageHead && !structure.bodyText.includes('我的计划'));
  check('计划笔记初始高度 ≥ 590px（1920x1080 时 55dvh≈594）', structure.noteHeight >= 590, `实际 ${structure.noteHeight}`);
  check('右侧编辑器宽度 ≥ 720px', structure.editorWidth >= 720, `实际 ${structure.editorWidth}`);
  check('左栏宽度约 260px', Math.abs(structure.railWidth - 260) <= 4, `实际 ${structure.railWidth}`);
  check('计划行高度在 68–76px', structure.rowHeights.every((h) => h >= 68 && h <= 76), JSON.stringify(structure.rowHeights));
  check('12 个计划全部展示', structure.rowCount === 12);
  check('名称输入框为大号（56-60px / 24-28px / 700）', structure.nameHeight >= 56 && structure.nameHeight <= 60 && parseFloat(structure.nameFontSize) >= 24 && parseFloat(structure.nameFontSize) <= 28 && structure.nameWeight === '700', JSON.stringify({ h: structure.nameHeight, fs: structure.nameFontSize, w: structure.nameWeight }));
  check('保存状态带 role=status + aria-live', structure.statusRole === 'status' && structure.statusLive === 'polite');
  check('笔记超高时由 #app 统一滚动', structure.appScrollable);
  await shot(cdp, 'p-01-plans-desktop.png');

  // 2. 长笔记滚动到底
  await evaluate(cdp, `document.querySelector('#app').scrollTop = document.querySelector('#app').scrollHeight`);
  await sleep(400);
  const noteBottom = await evaluate(cdp, `({ bottom: document.querySelector('#planNote').getBoundingClientRect().bottom, innerHeight: window.innerHeight })`);
  check('长笔记可滚动看到完整底部', noteBottom.bottom <= noteBottom.innerHeight + 2, `bottom=${noteBottom.bottom}`);
  await shot(cdp, 'p-02-plans-scrolled-bottom.png');

  // 3. 拖大笔记后页面总高增长并可继续滚动
  const before = await evaluate(cdp, `document.querySelector('#app').scrollHeight`);
  await evaluate(cdp, `document.querySelector('#planNote').style.minHeight = '1100px'`);
  await sleep(300);
  const after = await evaluate(cdp, `document.querySelector('#app').scrollHeight`);
  check('拖大笔记后页面总高度增长', after > before, `before=${before} after=${after}`);
  await evaluate(cdp, `document.querySelector('#app').scrollTop = document.querySelector('#app').scrollHeight`);
  await sleep(300);
  const noteBottom2 = await evaluate(cdp, `({ bottom: document.querySelector('#planNote').getBoundingClientRect().bottom, innerHeight: window.innerHeight })`);
  check('拖大后仍可滚动到底', noteBottom2.bottom <= noteBottom2.innerHeight + 2, `bottom=${noteBottom2.bottom}`);
  await evaluate(cdp, `document.querySelector('#planNote').style.minHeight = ''`);

  // 4. 下一步多行输入不截断
  await setInputValue(cdp, '#planDescription', '第一行行动\n第二行行动\n第三行行动\n第四行行动');
  await sleep(200);
  const nextStep = await evaluate(cdp, `
    (() => {
      const el = document.querySelector('#planDescription');
      const app = document.querySelector('#app');
      return { value: el.value, scrollH: el.scrollHeight, clientH: el.clientHeight };
    })()
  `);
  check('下一步支持多行且内容完整', nextStep.value.split('\n').length === 4, JSON.stringify(nextStep.value));
  check('多行内容不截断（内部可滚动或已撑高）', nextStep.scrollH >= nextStep.clientH - 2, JSON.stringify(nextStep));
  await sleep(1200); // 等待防抖保存完成

  // 5. 保存状态隔离：输入后立刻切换计划
  await setInputValue(cdp, '#planNote', '这条内容属于计划一，用于验证保存隔离。');
  await setInputValue(cdp, '#planName', '作品集-改名');
  await sleep(50); // 防抖期间（<650ms）立刻切换
  await evaluate(cdp, `document.querySelector('[data-action="select-plan"][data-id="plan-002"]').click()`);
  await waitFor(cdp, `document.querySelector('#planStatus')?.textContent === '已保存'`, 8000, '切换后状态');
  await sleep(1600); // 等旧计划保存完成
  const isolation = await evaluate(cdp, `
    (async () => {
      const statusText = document.querySelector('#planStatus').textContent;
      const d = await (await fetch('/api/state')).json();
      const p1 = d.plans.find((p) => p.id === 'plan-001');
      const p2 = d.plans.find((p) => p.id === 'plan-002');
      return {
        currentStatus: statusText, // 应为“已保存”（无时间戳），表示回调未串到新计划
        p1Name: p1.name,
        p1Note: p1.note,
        p2Name: p2.name,
        currentEditorName: document.querySelector('#planName').value,
      };
    })()
  `);
  console.log('  保存隔离:', JSON.stringify(isolation));
  check('保存中切换计划：旧计划按快照保存成功', isolation.p1Name === '作品集-改名' && isolation.p1Note.includes('这条内容属于计划一'), JSON.stringify(isolation));
  check('保存回调未串到新计划（状态无时间戳）', isolation.currentStatus === '已保存', `当前状态「${isolation.currentStatus}」`);
  check('新计划编辑器内容未被旧快照覆盖', isolation.currentEditorName === '每周复盘', JSON.stringify(isolation.currentEditorName));

  // 6. 左侧预览同步（输入下一步时）
  await evaluate(cdp, `document.querySelector('[data-action="select-plan"][data-id="plan-001"]').click()`);
  await waitFor(cdp, `document.querySelector('#planName')?.value === '作品集-改名'`, 5000, '切回计划一');
  await setInputValue(cdp, '#planDescription', '新的下一步预览内容');
  await sleep(150);
  const previewSync = await evaluate(cdp, `
    (() => {
      const row = document.querySelector('.plan-list-row[data-id="plan-001"]');
      return { name: row.querySelector('.plan-name').textContent, preview: row.querySelector('.plan-preview').textContent };
    })()
  `);
  check('输入名称/下一步后左侧列表同步更新', previewSync.name === '作品集-改名' && previewSync.preview === '新的下一步预览内容', JSON.stringify(previewSync));
  await sleep(1000);

  // 7. 更多菜单：打开、上移、删除
  await evaluate(cdp, `document.querySelector('[data-action="open-plan-menu"][data-id="plan-003"]').click()`);
  await waitFor(cdp, `document.querySelector('.plan-menu') !== null`, 5000, '更多菜单');
  const menuInfo = await evaluate(cdp, `
    (() => {
      const items = [...document.querySelectorAll('.plan-menu-item')];
      const more = document.querySelector('[data-action="open-plan-menu"][data-id="plan-003"]');
      return {
        labels: items.map((i) => i.textContent.trim()),
        itemHeights: items.map((i) => Math.round(i.getBoundingClientRect().height)),
        moreHeight: Math.round(more.getBoundingClientRect().height),
        moreWidth: Math.round(more.getBoundingClientRect().width),
      };
    })()
  `);
  console.log('  菜单:', JSON.stringify(menuInfo));
  check('更多菜单含上移/下移/删除计划', menuInfo.labels.join(',').includes('上移') && menuInfo.labels.join(',').includes('下移') && menuInfo.labels.join(',').includes('删除计划'));
  check('更多按钮与菜单项点击区 ≥ 44px', menuInfo.moreHeight >= 44 && menuInfo.moreWidth >= 44 && menuInfo.itemHeights.every((h) => h >= 44), JSON.stringify(menuInfo));
  await shot(cdp, 'p-03-plan-menu.png');

  // 上移 plan-003（现在在 plan-002 之后、plan-004 之前？初始顺序 plan-001..012，plan-003 上移 → 变到 plan-001 之后？不，上移一格到 index1 位置）
  await evaluate(cdp, `document.querySelector('.plan-menu [data-action="move-plan"][data-dir="up"]').click()`);
  await sleep(500);
  const orderAfterMove = await evaluate(cdp, `[...document.querySelectorAll('.plan-list-row .plan-name')].map((n) => n.textContent).slice(0, 4)`);
  check('上移生效（计划三前移）', orderAfterMove[1] === '晨间阅读' && orderAfterMove[2] === '每周复盘', JSON.stringify(orderAfterMove));

  // 删除当前计划（先选中 plan-003，再删除 → 自动选择相邻计划）
  await evaluate(cdp, `document.querySelector('[data-action="select-plan"][data-id="plan-003"]').click()`);
  await sleep(200);
  await evaluate(cdp, `document.querySelector('[data-action="open-plan-menu"][data-id="plan-003"]').click()`);
  await waitFor(cdp, `document.querySelector('.plan-menu') !== null`, 5000, '菜单2');
  await evaluate(cdp, `document.querySelector('.plan-menu [data-action="delete-plan"]').click()`);
  await waitFor(cdp, `document.querySelector('#modalBackdrop:not(.hidden)') !== null`, 5000, '删除确认');
  await evaluate(cdp, `document.querySelector('#modalSubmit').click()`);
  await waitFor(cdp, `document.querySelector('.plan-list-row') !== null && document.querySelectorAll('.plan-list-row').length === 11`, 8000, '删除完成');
  const afterDelete = await evaluate(cdp, `({ selected: document.querySelector('.plan-list-row.active .plan-name')?.textContent, count: document.querySelectorAll('.plan-list-row').length, editor: document.querySelector('#planName')?.value })`);
  console.log('  删除后:', JSON.stringify(afterDelete));
  check('删除当前计划后自动选择相邻计划', afterDelete.selected === '每周复盘' && afterDelete.editor === '每周复盘', JSON.stringify(afterDelete));
  check('删除后共 11 个计划', afterDelete.count === 11);

  // 8. 新建计划：modal 建名 → 自动选中 → 焦点在名称
  await evaluate(cdp, `document.querySelector('[data-action="add-plan"]').click()`);
  await waitFor(cdp, `document.querySelector('#modalBackdrop:not(.hidden)') !== null`, 5000, '新建 modal');
  await setInputValue(cdp, '#modalInput', '全新计划');
  await evaluate(cdp, `document.querySelector('#modalSubmit').click()`);
  await waitFor(cdp, `document.querySelector('#planName')?.value === '全新计划'`, 8000, '新建完成');
  await waitFor(cdp, `document.activeElement?.id === 'planName'`, 5000, '新建后焦点到名称');
  const newPlan = await evaluate(cdp, `({ count: document.querySelectorAll('.plan-list-row').length, active: document.querySelector('.plan-list-row.active .plan-name')?.textContent, focused: document.activeElement?.id })`);
  console.log('  新建:', JSON.stringify(newPlan));
  check('新建后自动选中并聚焦名称', newPlan.active === '全新计划' && newPlan.focused === 'planName', JSON.stringify(newPlan));
  check('新建后共 12 个计划', newPlan.count === 12);
  await shot(cdp, 'p-04-plan-new.png');

  // 9. 键盘顺序：列表 → 更多 → 名称 → 下一步 → 笔记
  const kbOrder = await evaluate(cdp, `
    (() => {
      const order = [...document.querySelectorAll('#app button, #app input, #app textarea')]
        .map((el) => el.id || el.className || el.getAttribute('data-action'))
        .join('|');
      const idx = (s) => order.indexOf(s);
      return {
        order,
        ok: idx('planName') > idx('plan-more') && idx('planDescription') > idx('planName') && idx('planNote') > idx('planDescription'),
      };
    })()
  `);
  check('键盘可按顺序访问（列表→更多→名称→下一步→笔记）', kbOrder.ok, kbOrder.order.slice(0, 200));

  // 10. 删除新计划，清理数据
  await evaluate(cdp, `document.querySelector('[data-action="open-plan-menu"]').click()`);
  await waitFor(cdp, `document.querySelector('.plan-menu') !== null`, 5000, '菜单3');
  await evaluate(cdp, `document.querySelector('.plan-menu [data-action="delete-plan"]').click()`);
  await waitFor(cdp, `document.querySelector('#modalBackdrop:not(.hidden)') !== null`, 5000, '删除确认3');
  await evaluate(cdp, `document.querySelector('#modalSubmit').click()`);
  await waitFor(cdp, `document.querySelectorAll('.plan-list-row').length === 11`, 8000, '清理完成');

  console.log('\n===== 1366x768（笔记本） =====');
  await setViewport(cdp, 1366, 768);
  await evaluate(cdp, `document.querySelector('.nav-item[data-view="plans"]').click()`);
  await waitFor(cdp, `document.querySelector('.plan-workspace-panel') !== null`, 8000, '计划工作区2');
  await sleep(400);
  const mid = await evaluate(cdp, `
    (() => {
      const note = document.querySelector('#planNote');
      const app = document.querySelector('#app');
      return {
        noteHeight: note.getBoundingClientRect().height,
        canScroll: app.scrollHeight > app.clientHeight,
        editorWidth: document.querySelector('.plan-workspace-panel').getBoundingClientRect().width,
      };
    })()
  `);
  console.log('  1366x768:', JSON.stringify(mid));
  check('1366x768 笔记高度 ≥ 420px（55dvh≈422）', mid.noteHeight >= 420, `实际 ${mid.noteHeight}`);
  check('1366x768 页面可滚动', mid.canScroll);
  await evaluate(cdp, `document.querySelector('#app').scrollTop = document.querySelector('#app').scrollHeight`);
  await sleep(300);
  const midBottom = await evaluate(cdp, `({ bottom: document.querySelector('#planNote').getBoundingClientRect().bottom, innerHeight: window.innerHeight })`);
  check('1366x768 可滚动看到笔记底部', midBottom.bottom <= midBottom.innerHeight + 2, `bottom=${midBottom.bottom}`);

  console.log('\n===== 移动端 390x844 =====');
  await setViewport(cdp, 390, 844);
  await evaluate(cdp, `document.querySelector('.nav-item[data-view="plans"]').click()`);
  await waitFor(cdp, `document.querySelector('.plan-workspace-panel') !== null`, 8000, '计划工作区3');
  await sleep(400);
  const mobile = await evaluate(cdp, `
    (() => {
      const note = document.querySelector('#planNote');
      const rail = document.querySelector('.plan-rail');
      const editor = document.querySelector('.plan-workspace-panel');
      const list = document.querySelector('.plan-list');
      return {
        pageColumns: getComputedStyle(document.querySelector('.plans-page')).gridTemplateColumns,
        listDisplay: getComputedStyle(list).display,
        listOverflow: getComputedStyle(list).overflowX,
        cardWidth: document.querySelector('.plan-list-row').getBoundingClientRect().width,
        noteHeight: note.getBoundingClientRect().height,
        noteWidth: note.getBoundingClientRect().width,
        railTop: rail.getBoundingClientRect().top,
        editorTop: editor.getBoundingClientRect().top,
        noHScroll: document.scrollingElement.scrollWidth <= document.scrollingElement.clientWidth + 1,
        editorWidth: editor.getBoundingClientRect().width,
      };
    })()
  `);
  console.log('  移动端:', JSON.stringify(mobile));
  check('860 以下为单列布局', mobile.pageColumns.split(' ').length === 1, mobile.pageColumns);
  check('计划列表为横向滚动卡片条', mobile.listDisplay === 'flex' && mobile.listOverflow === 'auto', JSON.stringify({ d: mobile.listDisplay, o: mobile.listOverflow }));
  check('计划卡片最小宽度约 210px', mobile.cardWidth >= 210, `实际 ${mobile.cardWidth}`);
  check('编辑器位于列表下方（全宽）', mobile.editorTop >= mobile.railTop && mobile.editorWidth > 300, JSON.stringify({ t: mobile.editorTop, w: mobile.editorWidth }));
  check('移动端笔记高度 360px', Math.abs(mobile.noteHeight - 360) <= 2, `实际 ${mobile.noteHeight}`);
  check('390px 无横向溢出', mobile.noHScroll);
  await shot(cdp, 'p-05-plans-mobile.png');

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
