/**
 * 问题归纳模块 · 综合验证脚本（兼容 / 接口 / UI / 移动端）
 * 用法: node qa/cdp-problems-test.mjs
 * 前置: 4001 端口已启动新 server.js；data.json 为 v3 旧格式数据。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(__dirname, '..', 'qa');
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const DEBUG_PORT = 9339;
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

async function shot(cdp, name) {
  const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(OUT, name), Buffer.from(data, 'base64'));
  console.log(`  [截图] ${name}`);
}

function check(name, cond, detail = '') {
  if (cond) console.log(`  [通过] ${name}`);
  else { failures.push(name); console.log(`  [失败] ${name} ${detail}`); }
}

async function apiCall(method, url, body) {
  const res = await fetch(API + url, {
    method,
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try { data = await res.json(); } catch (_) { /* ignore */ }
  return { status: res.status, data };
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

async function submitModal(cdp) {
  await evaluate(cdp, `document.querySelector('#modalSubmit').click()`);
  await sleep(250);
}

async function main() {
  console.log('===== 阶段 1：旧数据兼容 =====');
  const state1 = await (await fetch(`${API}/api/state`)).json();
  check('/api/state 返回 problemTopics 且为空数组', Array.isArray(state1.problemTopics) && state1.problemTopics.length === 0, JSON.stringify(state1.problemTopics));
  check('旧数据其他字段原样保留', state1.sections.length === 1 && state1.plans.length === 1 && state1.reflectFrameworks.length === 1 && Object.keys(state1.thinkEntries).length === 1 && Object.keys(state1.records).length === 1, JSON.stringify({ s: state1.sections.length, p: state1.plans.length, r: state1.reflectFrameworks.length }));
  const rawFile = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'data.json'), 'utf8'));
  check('数据文件 version 已升级（≥4）', rawFile.version >= 4, `version=${rawFile.version}`);
  check('升级后原字段内容未丢失', rawFile.plans[0]?.name === '个人作品集' && rawFile.thinkEntries['2026-08-13']?.includes('原样保留'), JSON.stringify(rawFile.plans?.[0]?.name));

  console.log('\n===== 阶段 2：接口直测 =====');
  const emptyName = await apiCall('POST', '/api/problem-topics', { name: '   ' });
  check('空主题名返回 400', emptyName.status === 400, `status=${emptyName.status}`);
  const badTopic = await apiCall('PATCH', '/api/problem-topics/nope', { name: 'x' });
  check('不存在的主题返回 404', badTopic.status === 404, `status=${badTopic.status}`);
  const badItem = await apiCall('DELETE', '/api/problem-topics/nope/items/nope');
  check('不存在主题下的条目删除返回 404', badItem.status === 404, `status=${badItem.status}`);
  const created = await apiCall('POST', '/api/problem-topics', { name: '接口主题' });
  check('创建主题返回 201 且 items 为空', created.status === 201 && Array.isArray(created.data.topic.items) && created.data.topic.items.length === 0, JSON.stringify(created.data));
  const topicId = created.data.topic.id;
  const emptyItem = await apiCall('POST', `/api/problem-topics/${topicId}/items`, { text: '' });
  check('空问题返回 400', emptyItem.status === 400, `status=${emptyItem.status}`);
  const itemCreated = await apiCall('POST', `/api/problem-topics/${topicId}/items`, { text: '这是一个多行问题\n第二行内容' });
  check('创建问题返回 201 且保留多行', itemCreated.status === 201 && itemCreated.data.item.text.includes('\n'), JSON.stringify(itemCreated.data));
  const itemId = itemCreated.data.item.id;
  const itemEdited = await apiCall('PATCH', `/api/problem-topics/${topicId}/items/${itemId}`, { text: '修改后的问题' });
  check('编辑问题返回 200', itemEdited.status === 200 && itemEdited.data.item.text === '修改后的问题', JSON.stringify(itemEdited.data));
  const badItemEdit = await apiCall('PATCH', `/api/problem-topics/${topicId}/items/nope`, { text: 'x' });
  check('不存在的条目返回 404', badItemEdit.status === 404, `status=${badItemEdit.status}`);
  const renamed = await apiCall('PATCH', `/api/problem-topics/${topicId}`, { name: '接口主题-改名' });
  check('重命名主题返回 200', renamed.status === 200 && renamed.data.topic.name === '接口主题-改名', JSON.stringify(renamed.data));
  const delItem = await apiCall('DELETE', `/api/problem-topics/${topicId}/items/${itemId}`);
  check('删除条目返回 200', delItem.status === 200, `status=${delItem.status}`);
  const delTopic = await apiCall('DELETE', `/api/problem-topics/${topicId}`);
  check('删除主题返回 200', delTopic.status === 200, `status=${delTopic.status}`);
  const state2 = await (await fetch(`${API}/api/state`)).json();
  check('清理后 problemTopics 恢复为空', state2.problemTopics.length === 0);

  console.log('\n===== 阶段 3：UI 流程（桌面 1440x900） =====');
  fs.mkdirSync(OUT, { recursive: true });
  const profile = path.join(os.tmpdir(), `dsh-problems-test-${Date.now()}`);
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
  await cdp.send('Network.enable');
  cdp.on('Runtime.exceptionThrown', (p) => consoleErrors.push(p.exceptionDetails?.exception?.description || p.exceptionDetails?.text || 'exception'));
  cdp.on('Log.entryAdded', (p) => { if (p.entry?.level === 'error' && !String(p.entry.text || '').includes('favicon')) consoleErrors.push(p.entry.text); });

  await cdp.send('Page.navigate', { url: `${API}/` });
  await waitFor(cdp, `document.querySelector('#app .page') !== null`, 12000, '首页');
  await sleep(500);

  // 导航
  const navInfo = await evaluate(cdp, `
    (() => {
      const btn = document.querySelector('.nav-item[data-view="problems"]');
      const order = [...document.querySelectorAll('.primary-nav .nav-item')].map((b) => b.dataset.view);
      return {
        exists: !!btn,
        order,
        hasIcon: !!btn?.querySelector('[data-lucide="folder-tree"]'),
        text: btn?.querySelector('span')?.textContent,
      };
    })()
  `);
  console.log('  导航:', JSON.stringify(navInfo));
  check('导航出现在原则打卡与所思之间', navInfo.order[1] === 'principles' && navInfo.order[2] === 'problems' && navInfo.order[3] === 'thoughts', JSON.stringify(navInfo.order));
  check('导航使用 folder-tree 图标且文字为「问题归纳」', navInfo.hasIcon && navInfo.text === '问题归纳', JSON.stringify(navInfo));

  // 进入问题归纳：空状态 + 无日期控件
  await evaluate(cdp, `document.querySelector('.nav-item[data-view="problems"]').click()`);
  await waitFor(cdp, `document.querySelector('.empty-state h3') !== null`, 8000, '空状态');
  const empty = await evaluate(cdp, `
    (() => {
      return {
        title: document.querySelector('.empty-state h3')?.textContent,
        hasDateControl: document.querySelector('#topbar .date-control') !== null,
        topbarTitle: document.querySelector('#topbar h1')?.textContent,
        hasBtn: document.querySelector('.empty-state [data-action="add-problem-topic"]') !== null,
      };
    })()
  `);
  console.log('  空状态:', JSON.stringify(empty));
  check('空状态标题「还没有问题主题」', empty.title === '还没有问题主题');
  check('有「建立第一个主题」按钮', empty.hasBtn);
  check('顶部无日期控件', !empty.hasDateControl);
  check('顶部标题为「问题归纳」', empty.topbarTitle === '问题归纳');
  await shot(cdp, 'pr-01-empty.png');

  // 建立第一个主题
  await evaluate(cdp, `document.querySelector('.empty-state [data-action="add-problem-topic"]').click()`);
  await waitFor(cdp, `document.querySelector('#modalBackdrop:not(.hidden)') !== null`, 5000, '新建主题弹窗');
  await setInputValue(cdp, '#modalInput', '工作与职业');
  await submitModal(cdp);
  await waitFor(cdp, `document.querySelector('.problem-detail') !== null`, 8000, '主题详情');
  await waitFor(cdp, `document.activeElement?.id === 'problemComposer'`, 5000, '焦点到新增问题');
  const topicCreated = await evaluate(cdp, `
    (() => {
      const activeRow = document.querySelector('.problem-topic-row.active');
      return {
        detailTitle: document.querySelector('.problem-detail-title h2')?.textContent,
        activeName: activeRow?.querySelector('.problem-topic-name')?.textContent,
        activeCount: activeRow?.querySelector('.problem-topic-meta')?.textContent,
        railCount: document.querySelector('.problem-rail-title .problem-count')?.textContent,
        current: activeRow?.querySelector('.problem-topic-select')?.getAttribute('aria-current'),
        focused: document.activeElement?.id,
      };
    })()
  `);
  console.log('  建主题:', JSON.stringify(topicCreated));
  check('创建后自动选中新主题', topicCreated.detailTitle === '工作与职业' && topicCreated.activeName === '工作与职业', JSON.stringify(topicCreated));
  check('主题行显示 0 个问题 + aria-current', topicCreated.activeCount === '0 个问题' && topicCreated.current === 'true', JSON.stringify(topicCreated));
  check('焦点进入新增问题输入框', topicCreated.focused === 'problemComposer');

  // 添加问题（按钮 + 多行）
  await setInputValue(cdp, '#problemComposer', '目前真正阻碍我的是什么？\n第二行继续追问细节。');
  await evaluate(cdp, `document.querySelector('[data-action="add-problem-item"]').click()`);
  await waitFor(cdp, `document.querySelectorAll('.problem-item').length === 1`, 8000, '问题1');
  const item1 = await evaluate(cdp, `
    (() => {
      const item = document.querySelector('.problem-item');
      return {
        index: item?.querySelector('.problem-item-index')?.textContent,
        text: item?.querySelector('.problem-item-text')?.textContent,
        composerEmpty: document.querySelector('#problemComposer')?.value === '',
        focused: document.activeElement?.id,
        count: document.querySelector('.problem-topic-meta')?.textContent,
      };
    })()
  `);
  console.log('  问题1:', JSON.stringify(item1));
  check('问题显示序号 01', item1.index === '01');
  check('多行问题文本完整显示（含换行）', item1.text.includes('\n') && item1.text.includes('第二行'), JSON.stringify(item1.text));
  check('添加成功后输入框清空且焦点回输入框', item1.composerEmpty && item1.focused === 'problemComposer');
  check('主题计数更新为 1 个问题', item1.count === '1 个问题');

  // Ctrl+Enter 添加第二个问题
  await setInputValue(cdp, '#problemComposer', '是否把精力放错了地方？');
  await evaluate(cdp, `
    (() => {
      const el = document.querySelector('#problemComposer');
      el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true }));
    })()
  `);
  await waitFor(cdp, `document.querySelectorAll('.problem-item').length === 2`, 8000, '问题2');
  const indexes = await evaluate(cdp, `[...document.querySelectorAll('.problem-item-index')].map((i) => i.textContent)`);
  check('Ctrl+Enter 添加成功，序号 01/02', JSON.stringify(indexes) === JSON.stringify(['01', '02']), JSON.stringify(indexes));

  // 空输入不提交
  await setInputValue(cdp, '#problemComposer', '   ');
  await evaluate(cdp, `document.querySelector('[data-action="add-problem-item"]').click()`);
  await sleep(500);
  check('空白输入不新增问题', await evaluate(cdp, `document.querySelectorAll('.problem-item').length === 2`));

  // 第二个主题
  await evaluate(cdp, `document.querySelector('.problem-rail [data-action="add-problem-topic"]').click()`);
  await waitFor(cdp, `document.querySelector('#modalBackdrop:not(.hidden)') !== null`, 5000, '新建主题2');
  await setInputValue(cdp, '#modalInput', '健康管理');
  await submitModal(cdp);
  await waitFor(cdp, `document.querySelector('.problem-detail-title h2')?.textContent === '健康管理'`, 8000, '主题2选中');
  check('第二个主题自动选中', await evaluate(cdp, `document.querySelector('.problem-topic-row.active .problem-topic-name')?.textContent === '健康管理'`));

  // 切换主题
  await evaluate(cdp, `[...document.querySelectorAll('.problem-topic-select')].find((b) => b.textContent.includes('工作与职业')).click()`);
  await waitFor(cdp, `document.querySelector('.problem-detail-title h2')?.textContent === '工作与职业'`, 5000, '切回主题1');
  check('切换主题后显示正确问题列表', await evaluate(cdp, `document.querySelectorAll('.problem-item').length === 2`));
  await shot(cdp, 'pr-02-topics.png');

  // 编辑问题（多行弹窗）
  await evaluate(cdp, `document.querySelector('.problem-item [data-action="edit-problem-item"]').click()`);
  await waitFor(cdp, `document.querySelector('#modalBackdrop:not(.hidden)') !== null`, 5000, '编辑弹窗');
  check('编辑弹窗输入为多行 textarea', await evaluate(cdp, `document.querySelector('#modalInput')?.tagName === 'TEXTAREA'`));
  await setInputValue(cdp, '#modalInput', '编辑后的问题：真正阻碍我的是什么？\n补充一行。');
  await submitModal(cdp);
  await waitFor(cdp, `document.querySelector('.problem-item-text')?.textContent.includes('编辑后的问题')`, 5000, '编辑生效');
  check('编辑问题后文本更新且序号不变', await evaluate(cdp, `document.querySelector('.problem-item-index')?.textContent === '01' && document.querySelectorAll('.problem-item').length === 2`));

  console.log('\n===== 阶段 4：移动端（390x844） =====');
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await cdp.send('Page.reload', { ignoreCache: true });
  await waitFor(cdp, `document.querySelector('#app .page') !== null`, 12000, '移动端首页');
  await sleep(500);
  const mobileNav = await evaluate(cdp, `
    (() => {
      const items = [...document.querySelectorAll('.primary-nav .nav-item')];
      const widths = items.map((b) => Math.round(b.getBoundingClientRect().width));
      return { count: items.length, widths, allClickable: items.every((b) => b.getBoundingClientRect().width >= 40) };
    })()
  `);
  console.log('  移动导航:', JSON.stringify(mobileNav));
  check('手机端 5 个导航等宽分布', mobileNav.count === 5 && Math.max(...mobileNav.widths) - Math.min(...mobileNav.widths) <= 3, JSON.stringify(mobileNav.widths));
  await evaluate(cdp, `document.querySelector('.nav-item[data-view="problems"]').click()`);
  await waitFor(cdp, `document.querySelector('.problem-topic-row') !== null`, 8000, '移动端问题页');
  const mobile = await evaluate(cdp, `
    (() => {
      const page = document.querySelector('.problems-page');
      const list = document.querySelector('.problem-topic-list');
      return {
        columns: getComputedStyle(page).gridTemplateColumns,
        listDisplay: getComputedStyle(list).display,
        listOverflow: getComputedStyle(list).overflowX,
        cardWidth: document.querySelector('.problem-topic-row').getBoundingClientRect().width,
        noHScroll: document.scrollingElement.scrollWidth <= document.scrollingElement.clientWidth + 1,
        detailWidth: document.querySelector('.problem-detail').getBoundingClientRect().width,
        composerWidth: document.querySelector('#problemComposer').getBoundingClientRect().width,
      };
    })()
  `);
  console.log('  移动端:', JSON.stringify(mobile));
  check('860 以下单列布局', mobile.columns.split(' ').length === 1, mobile.columns);
  check('主题为横向滚动条', mobile.listDisplay === 'flex' && mobile.listOverflow === 'auto', JSON.stringify({ d: mobile.listDisplay, o: mobile.listOverflow }));
  check('主题卡片宽约 200px+', mobile.cardWidth >= 190, `实际 ${mobile.cardWidth}`);
  check('无横向溢出', mobile.noHScroll);
  check('详情占满宽度、输入框在容器内满宽', mobile.detailWidth > 300 && mobile.composerWidth >= mobile.detailWidth - 80, JSON.stringify({ d: mobile.detailWidth, c: mobile.composerWidth }));
  await shot(cdp, 'pr-03-mobile.png');

  // 移动端点击主题卡片切换
  await evaluate(cdp, `[...document.querySelectorAll('.problem-topic-select')].find((b) => b.textContent.includes('健康管理')).click()`);
  await waitFor(cdp, `document.querySelector('.problem-detail-title h2')?.textContent === '健康管理'`, 5000, '移动端切换');
  check('移动端可切换主题', true);

  console.log('\n===== 阶段 5：删除与空状态回归（桌面） =====');
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await cdp.send('Page.reload', { ignoreCache: true });
  await waitFor(cdp, `document.querySelector('#app .page') !== null`, 12000, '桌面回归');
  await sleep(500);
  await evaluate(cdp, `document.querySelector('.nav-item[data-view="problems"]').click()`);
  await waitFor(cdp, `document.querySelector('.problem-topic-row') !== null`, 8000, '问题页');
  // 删除问题（当前主题是健康管理，0 个问题——先切回工作与职业删问题）
  await evaluate(cdp, `[...document.querySelectorAll('.problem-topic-select')].find((b) => b.textContent.includes('工作与职业')).click()`);
  await waitFor(cdp, `document.querySelector('.problem-detail-title h2')?.textContent === '工作与职业'`, 5000, '切回');
  const scrollBefore = await evaluate(cdp, `document.querySelector('#app').scrollTop`);
  await evaluate(cdp, `document.querySelector('.problem-item [data-action="delete-problem-item"]').click()`);
  await waitFor(cdp, `document.querySelector('#modalBackdrop:not(.hidden)') !== null`, 5000, '删除问题确认');
  check('删除问题确认展示问题前段', await evaluate(cdp, `document.querySelector('.modal-message')?.textContent.includes('编辑后的问题')`));
  await evaluate(cdp, `document.querySelector('#modalSubmit').click()`);
  await waitFor(cdp, `document.querySelectorAll('.problem-item').length === 1`, 8000, '问题删除');
  check('删除问题后保持当前主题', await evaluate(cdp, `document.querySelector('.problem-detail-title h2')?.textContent === '工作与职业' && document.querySelectorAll('.problem-item').length === 1`));

  // 重命名主题（rail 菜单）
  await evaluate(cdp, `document.querySelector('[data-action="open-problem-menu"][data-anchor="rail"]').click()`);
  await waitFor(cdp, `document.querySelector('.problem-menu') !== null`, 5000, '主题菜单');
  const menuInfo = await evaluate(cdp, `[...document.querySelectorAll('.problem-menu-item')].map((i) => i.textContent.trim())`);
  check('更多菜单含重命名/删除主题', menuInfo.includes('重命名主题') && menuInfo.includes('删除主题'), JSON.stringify(menuInfo));
  await evaluate(cdp, `document.querySelector('.problem-menu [data-action="rename-problem-topic"]').click()`);
  await waitFor(cdp, `document.querySelector('#modalBackdrop:not(.hidden)') !== null`, 5000, '重命名弹窗');
  await setInputValue(cdp, '#modalInput', '工作与职业-改名');
  await submitModal(cdp);
  await waitFor(cdp, `document.querySelector('.problem-detail-title h2')?.textContent === '工作与职业-改名'`, 8000, '重命名生效');
  check('重命名主题后详情与列表同步', await evaluate(cdp, `document.querySelector('.problem-topic-row.active .problem-topic-name')?.textContent === '工作与职业-改名'`));

  // 删除当前主题（detail 菜单）→ 选中相邻
  await evaluate(cdp, `document.querySelector('[data-action="open-problem-menu"][data-anchor="detail"]').click()`);
  await waitFor(cdp, `document.querySelector('.problem-menu') !== null`, 5000, '详情菜单');
  await evaluate(cdp, `document.querySelector('.problem-menu [data-action="delete-problem-topic"]').click()`);
  await waitFor(cdp, `document.querySelector('#modalBackdrop:not(.hidden)') !== null`, 5000, '删除主题确认');
  check('删除确认含问题数量说明', await evaluate(cdp, `document.querySelector('.modal-message')?.textContent.includes('1 个问题')`));
  await evaluate(cdp, `document.querySelector('#modalSubmit').click()`);
  await waitFor(cdp, `document.querySelector('.problem-topic-row')?.getAttribute('data-id') !== 'works-not-deleted'`, 3000, '占位');
  await sleep(500);
  const afterDel = await evaluate(cdp, `({ count: document.querySelectorAll('.problem-topic-row').length, selected: document.querySelector('.problem-topic-row.active .problem-topic-name')?.textContent, detail: document.querySelector('.problem-detail-title h2')?.textContent })`);
  console.log('  删除主题后:', JSON.stringify(afterDel));
  check('删除当前主题后自动选择相邻主题', afterDel.count === 1 && afterDel.selected === '健康管理' && afterDel.detail === '健康管理', JSON.stringify(afterDel));

  // 删除最后一个主题 → 全局空状态
  await evaluate(cdp, `document.querySelector('[data-action="open-problem-menu"][data-anchor="detail"]').click()`);
  await waitFor(cdp, `document.querySelector('.problem-menu') !== null`, 5000, '菜单3');
  await evaluate(cdp, `document.querySelector('.problem-menu [data-action="delete-problem-topic"]').click()`);
  await waitFor(cdp, `document.querySelector('#modalBackdrop:not(.hidden)') !== null`, 5000, '确认3');
  await evaluate(cdp, `document.querySelector('#modalSubmit').click()`);
  await waitFor(cdp, `document.querySelector('.empty-state h3') !== null`, 8000, '全局空状态');
  check('删除最后一个主题后回到全局空状态', await evaluate(cdp, `document.querySelector('.empty-state h3')?.textContent === '还没有问题主题'`));
  await shot(cdp, 'pr-04-empty-again.png');

  console.log('\n===== 阶段 6：持久化检查 =====');
  const raw = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'data.json'), 'utf8'));
  check('删除全部后 problemTopics 持久化为空数组', Array.isArray(raw.problemTopics) && raw.problemTopics.length === 0, JSON.stringify(raw.problemTopics));
  check('旧字段仍保留（原则/思考/计划）', raw.sections?.length === 1 && raw.plans?.length === 1 && raw.reflectFrameworks?.length === 1, JSON.stringify({ s: raw.sections?.length, p: raw.plans?.length, f: raw.reflectFrameworks?.length }));

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
