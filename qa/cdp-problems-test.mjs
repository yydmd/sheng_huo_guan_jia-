/**
 * 问题拆解模块 · 综合验证脚本（迁移 / 接口 / UI 桌面 / 移动端）
 * 用法: node qa/cdp-problems-test.mjs
 * 说明: 脚本自启动 server.js（临时数据目录 + 预置旧版 problemTopics 种子），不依赖外部端口、不触碰真实 data/data.json。
 *   阶段 1 验证 v12 迁移（problemTopics → problems、备份、幂等）；
 *   阶段 2 直测 /api/problems 四个端点的正常与异常分支；
 *   阶段 3 验证桌面 UI（导航「问题拆解」、列表+编辑器、自动保存、上移/下移/删除、刷新保留）；
 *   阶段 4 验证移动端单栏布局。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const OUT = path.join(__dirname);
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const DEBUG_PORT = 9344;
const APP_PORT = 4130;
const API = `http://127.0.0.1:${APP_PORT}`;

const failures = [];
const consoleErrors = [];
let chrome = null;
let server = null;
let dataDir = null;
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

function startServer() {
  server = spawn(process.execPath, ['server.js', '--port', String(APP_PORT), '--no-open'], {
    cwd: ROOT, env: { ...process.env, LIFE_STEWARD_DATA_DIR: dataDir }, stdio: 'ignore',
  });
}

async function stopServer() {
  if (server) { server.kill(); server = null; await sleep(600); }
}

// 旧版 v10 数据：problemTopics 三个主题（含多行文本与空主题）
const legacySeed = {
  version: 10,
  sections: [{ id: 'sec-keep', name: '原则', items: [{ id: 'item-keep', name: '保持的条目', activeSince: '2026-08-01', children: [] }] }],
  records: { '2026-08-14': { 'item-keep': true } },
  thoughtEntries: [], thoughtCategories: [], reflectFrameworks: [], reflectEntries: {},
  plans: [], templates: [],
  problemTopics: [
    { id: 'topic-life', name: '生活', items: [{ id: 'pi-1', text: '夫妻之间的感情问题影响到个人的学习' }] },
    { id: 'topic-focus', name: '专注力', items: [{ id: 'pi-2', text: '被不重要的东西转移注意力\n如何避免一再的错误:专一专注' }] },
    { id: 'topic-empty', name: '未归类', items: [] },
  ],
  events: [], eventCheckins: {}, eventExceptions: [],
};

async function stage1Migration() {
  console.log('===== 阶段 1：v12 迁移（problemTopics → problems） =====');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'data.json'), JSON.stringify(legacySeed, null, 2), 'utf8');
  startServer();
  await waitForHttp(`${API}/api/state`);
  const st = await (await fetch(`${API}/api/state`)).json();
  check('/api/state 返回 problems（3 条）', Array.isArray(st.problems) && st.problems.length === 3, JSON.stringify(st.problems?.length));
  check('/api/state 不再返回 problemTopics', !('problemTopics' in st));
  const life = st.problems?.find((p) => p.name === '生活');
  const focus = st.problems?.find((p) => p.name === '专注力');
  check('迁移保留旧主题 id 与名称', life?.id === 'topic-life' && focus?.id === 'topic-focus');
  check('items 文本按行拼接为 content', focus?.content === '被不重要的东西转移注意力\n如何避免一再的错误:专一专注', JSON.stringify(focus?.content));
  check('note 迁移为空串', life?.note === '' && focus?.note === '' && st.problems.find((p) => p.name === '未归类')?.content === '');

  const raw = JSON.parse(fs.readFileSync(path.join(dataDir, 'data.json'), 'utf8'));
  check('落盘后 problemTopics 字段已删除', !('problemTopics' in raw));
  check('落盘后 problems 已写入', Array.isArray(raw.problems) && raw.problems.length === 3);
  check('其他用户数据无损（sections/records 保留）', raw.sections?.length === 1 && raw.records?.['2026-08-14']?.['item-keep'] === true);
  check('版本号已随既有迁移升级（version=11）', raw.version === 11, `version=${raw.version}`);
  const baks = fs.readdirSync(dataDir).filter((f) => f.startsWith('data.json.bak-v12-'));
  check('生成 data.json.bak-v12-{timestamp} 备份（恰好 1 个）', baks.length === 1, baks.join(','));
  if (baks.length === 1) {
    const bak = JSON.parse(fs.readFileSync(path.join(dataDir, baks[0]), 'utf8'));
    check('备份内容为迁移前原数据（含 problemTopics、无 problems）', Array.isArray(bak.problemTopics) && bak.problemTopics.length === 3 && !('problems' in bak));
  }

  console.log('  -- 幂等性：重启服务 --');
  const bakCount = baks.length;
  await stopServer();
  startServer();
  await waitForHttp(`${API}/api/state`);
  const st2 = await (await fetch(`${API}/api/state`)).json();
  check('重启后 problems 数量不变（未重复迁移）', st2.problems.length === 3);
  check('重启后仍无 problemTopics 字段', !('problemTopics' in st2));
  const baks2 = fs.readdirSync(dataDir).filter((f) => f.startsWith('data.json.bak-v12-'));
  check('重启未新增 bak-v12 备份', baks2.length === bakCount, `${bakCount} → ${baks2.length}`);
}

async function clearProblems() {
  const st = await (await fetch(`${API}/api/state`)).json();
  for (const p of st.problems || []) await apiCall('DELETE', `/api/problems/${p.id}`);
  return (st.problems || []).length;
}

async function stage2Api() {
  console.log('\n===== 阶段 2：/api/problems 接口直测 =====');
  const leftover = await clearProblems();
  check('清理迁移遗留数据（3 条）', leftover === 3, `实际 ${leftover}`);
  const emptyName = await apiCall('POST', '/api/problems', { name: '   ' });
  check('POST 空标题 → 400 问题标题不能为空', emptyName.status === 400 && emptyName.data?.error === '问题标题不能为空', JSON.stringify(emptyName.data));

  const created = await apiCall('POST', '/api/problems', { name: '  接口问题A  ' });
  check('POST 正常 → 201 {problem} 含全部字段', created.status === 201 && created.data?.problem?.name === '接口问题A' && created.data.problem.content === '' && created.data.problem.note === '' && typeof created.data.problem.id === 'string', JSON.stringify(created.data));
  const idA = created.data.problem.id;
  const createdB = await apiCall('POST', '/api/problems', { name: '接口问题B' });
  const idB = createdB.data.problem.id;
  check('POST 第二条 → 201', createdB.status === 201);

  const badPatch = await apiCall('PATCH', '/api/problems/not-exist', { name: 'x' });
  check('PATCH 不存在 id → 404 问题不存在', badPatch.status === 404 && badPatch.data?.error === '问题不存在', JSON.stringify(badPatch.data));
  const patchEmpty = await apiCall('PATCH', `/api/problems/${idA}`, { name: '' });
  check('PATCH 空标题 → 400 问题标题不能为空', patchEmpty.status === 400 && patchEmpty.data?.error === '问题标题不能为空', JSON.stringify(patchEmpty.data));
  const patched = await apiCall('PATCH', `/api/problems/${idA}`, { name: '接口问题A-改名', content: '第一行\n第二行', note: '备注N' });
  check('PATCH 单请求保存全部字段 → 200', patched.status === 200 && patched.data?.problem?.name === '接口问题A-改名' && patched.data.problem.content === '第一行\n第二行' && patched.data.problem.note === '备注N', JSON.stringify(patched.data));

  const badReorder1 = await apiCall('POST', '/api/problems/reorder', { orderedIds: 'x' });
  check('reorder 非数组 → 400 参数错误', badReorder1.status === 400 && badReorder1.data?.error === '参数错误', JSON.stringify(badReorder1.data));
  const badReorder2 = await apiCall('POST', '/api/problems/reorder', { orderedIds: ['nope'] });
  check('reorder 列表不一致 → 400', badReorder2.status === 400, JSON.stringify(badReorder2.data));
  const reorder = await apiCall('POST', '/api/problems/reorder', { orderedIds: [idB, idA] });
  check('reorder 正常 → 200 {problems} 顺序生效', reorder.status === 200 && JSON.stringify(reorder.data?.problems?.map((p) => p.id)) === JSON.stringify([idB, idA]), JSON.stringify(reorder.data));

  const del = await apiCall('DELETE', `/api/problems/${idB}`);
  check('DELETE → 200 {ok:true}', del.status === 200 && del.data?.ok === true, JSON.stringify(del.data));
  const st = await (await fetch(`${API}/api/state`)).json();
  check('删除后 state 中已无该条', st.problems.length === 1 && st.problems[0].id === idA);

  // 清空，为 UI 阶段空态做准备
  await clearProblems();
  const st2 = await (await fetch(`${API}/api/state`)).json();
  check('清理后 problems 为空数组', Array.isArray(st2.problems) && st2.problems.length === 0);
}

async function stage3UiDesktop(cdp) {
  console.log('\n===== 阶段 3：UI 桌面（1440x900） =====');
  await cdp.send('Page.navigate', { url: `${API}/` });
  await waitFor(cdp, `document.querySelector('#app .page') !== null`, 12000, '首页');
  await sleep(500);

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
  check('导航使用 folder-tree 图标且文字为「问题拆解」', navInfo.hasIcon && navInfo.text === '问题拆解', JSON.stringify(navInfo));

  // 进入问题拆解：空状态 + 无日期控件
  await evaluate(cdp, `document.querySelector('.nav-item[data-view="problems"]').click()`);
  await waitFor(cdp, `document.querySelector('.plans-page .empty-state h3') !== null`, 8000, '空状态');
  const empty = await evaluate(cdp, `
    (() => ({
      title: document.querySelector('.plans-page .empty-state h3')?.textContent,
      railTitle: document.querySelector('.plan-rail-title h2')?.textContent,
      hasDateControl: document.querySelector('#topbar .date-control') !== null,
      topbarTitle: document.querySelector('#topbar h1')?.textContent,
      hasBtn: document.querySelector('.empty-state [data-action="add-problem"]') !== null,
    }))()
  `);
  console.log('  空状态:', JSON.stringify(empty));
  check('空态标题「建立第一个问题」', empty.title === '建立第一个问题');
  check('左栏标题「全部问题」', empty.railTitle === '全部问题');
  check('顶部无日期控件', !empty.hasDateControl);
  check('顶部标题为「问题拆解」', empty.topbarTitle === '问题拆解');
  check('有「新建问题」按钮', empty.hasBtn);
  await shot(cdp, 'pr-01-empty.png');

  // 新建问题（弹窗）
  await evaluate(cdp, `document.querySelector('.empty-state [data-action="add-problem"]').click()`);
  await waitFor(cdp, `document.querySelector('#modalBackdrop:not(.hidden)') !== null`, 5000, '新建问题弹窗');
  const modal = await evaluate(cdp, `
    (() => ({
      eyebrow: document.querySelector('#modalEyebrow')?.textContent,
      title: document.querySelector('#modalTitle')?.textContent,
      label: document.querySelector('#modalBody label')?.textContent,
    }))()
  `);
  check('弹窗 eyebrow「问题拆解」/ label「问题标题」', modal.eyebrow === '问题拆解' && modal.label === '问题标题', JSON.stringify(modal));
  await setInputValue(cdp, '#modalInput', '工作与职业');
  await submitModal(cdp);
  await waitFor(cdp, `document.querySelector('#problemName') !== null`, 8000, '编辑器出现');
  await waitFor(cdp, `document.activeElement?.id === 'problemName'`, 5000, '焦点到标题框');
  check('创建后自动选中并聚焦标题框', await evaluate(cdp, `document.activeElement?.id === 'problemName' && document.querySelector('#problemName')?.value === '工作与职业'`));
  check('列表出现 plan-list-row 且为 active', await evaluate(cdp, `document.querySelectorAll('.plan-list .plan-list-row').length === 1 && document.querySelector('.plan-list-row')?.classList.contains('active')`));

  // 编辑器：自动保存状态流转 + 列表摘要同步
  await setInputValue(cdp, '#problemContent', '第一步：记录时间开销\n第二步：找出耗时段落');
  const typing = await evaluate(cdp, `document.querySelector('#problemStatus')?.textContent`);
  check('输入时状态「输入中…」', typing === '输入中…', typing);
  await waitFor(cdp, `/^已保存 \\d{2}:\\d{2}$/.test(document.querySelector('#problemStatus')?.textContent || '')`, 10000, '已保存 HH:MM');
  check('保存完成显示「已保存 HH:MM」', await evaluate(cdp, `/^已保存 \\d{2}:\\d{2}$/.test(document.querySelector('#problemStatus')?.textContent || '')`));
  const preview = await evaluate(cdp, `document.querySelector('.plan-list-row .plan-preview')?.textContent`);
  check('列表摘要实时同步（textContent）', preview === '第一步：记录时间开销\n第二步：找出耗时段落', JSON.stringify(preview));
  await setInputValue(cdp, '#problemNote', '备注：先坚持一周');
  await waitFor(cdp, `/^已保存 \\d{2}:\\d{2}$/.test(document.querySelector('#problemStatus')?.textContent || '')`, 10000, '备注已保存');
  const saved = await (await fetch(`${API}/api/state`)).json();
  check('PATCH 全字段落盘（content/note）', saved.problems?.[0]?.content.includes('第二步') && saved.problems?.[0]?.note === '备注：先坚持一周', JSON.stringify(saved.problems?.[0]));
  await shot(cdp, 'pr-02-list-editor.png');

  // 第二条 + 上移/下移
  await evaluate(cdp, `document.querySelector('.plan-rail [data-action="add-problem"]').click()`);
  await waitFor(cdp, `document.querySelector('#modalBackdrop:not(.hidden)') !== null`, 5000, '弹窗2');
  await setInputValue(cdp, '#modalInput', '健康管理');
  await submitModal(cdp);
  await waitFor(cdp, `document.querySelectorAll('.plan-list .plan-list-row').length === 2`, 8000, '第二条');
  check('新建第二条自动选中', await evaluate(cdp, `document.querySelector('#problemName')?.value === '健康管理'`));
  await evaluate(cdp, `[...document.querySelectorAll('.plan-list-row')].find((r) => r.textContent.includes('健康管理'))?.querySelector('.plan-more')?.click()`);
  await waitFor(cdp, `document.querySelector('[data-problem-menu]') !== null`, 5000, '菜单打开');
  const menuInfo = await evaluate(cdp, `[...document.querySelectorAll('.plan-menu-item')].map((i) => i.textContent.trim())`);
  check('更多菜单含上移/下移/删除', menuInfo.includes('上移') && menuInfo.includes('下移') && menuInfo.includes('删除问题'), JSON.stringify(menuInfo));
  await evaluate(cdp, `document.querySelector('[data-problem-menu] [data-action="move-problem"][data-dir="up"]')?.click()`);
  await waitFor(cdp, `[...document.querySelectorAll('.plan-list .plan-list-row .plan-name')].map((el) => el.textContent)[0] === '健康管理'`, 5000, '上移生效');
  check('上移后健康管理在首位且仍选中', await evaluate(cdp, `[...document.querySelectorAll('.plan-list-row')][0]?.classList.contains('active') && document.querySelector('#problemName')?.value === '健康管理'`));
  await evaluate(cdp, `[...document.querySelectorAll('.plan-list-row')].find((r) => r.textContent.includes('健康管理'))?.querySelector('.plan-more')?.click()`);
  await waitFor(cdp, `document.querySelector('[data-problem-menu]') !== null`, 5000, '菜单再次打开');
  await evaluate(cdp, `document.querySelector('[data-problem-menu] [data-action="move-problem"][data-dir="down"]')?.click()`);
  await waitFor(cdp, `[...document.querySelectorAll('.plan-list .plan-list-row .plan-name')].map((el) => el.textContent)[1] === '健康管理'`, 5000, '下移生效');
  check('下移后顺序恢复 [工作与职业, 健康管理]', await evaluate(cdp, `JSON.stringify([...document.querySelectorAll('.plan-list .plan-list-row .plan-name')].map((el) => el.textContent)) === JSON.stringify(['工作与职业', '健康管理'])`));

  // 刷新后数据保留
  await cdp.send('Page.reload', { ignoreCache: true });
  await waitFor(cdp, `document.querySelector('#app .page') !== null`, 12000, '刷新首页');
  await evaluate(cdp, `document.querySelector('.nav-item[data-view="problems"]').click()`);
  await waitFor(cdp, `document.querySelectorAll('.plan-list .plan-list-row').length === 2`, 10000, '刷新后列表');
  const reloaded = await evaluate(cdp, `
    (() => ({
      names: [...document.querySelectorAll('.plan-list .plan-list-row .plan-name')].map((el) => el.textContent),
      title: document.querySelector('#problemName')?.value,
      content: document.querySelector('#problemContent')?.value,
      note: document.querySelector('#problemNote')?.value,
    }))()
  `);
  check('刷新后 2 条保留、顺序不变', JSON.stringify(reloaded.names) === JSON.stringify(['工作与职业', '健康管理']), JSON.stringify(reloaded.names));
  check('刷新后选中第一条且内容完整', reloaded.title === '工作与职业' && reloaded.content.includes('第二步') && reloaded.note === '备注：先坚持一周', JSON.stringify({ t: reloaded.title, n: reloaded.note }));

  // 删除第二条（确认弹窗）
  await evaluate(cdp, `[...document.querySelectorAll('.plan-list-row')].find((r) => r.textContent.includes('健康管理'))?.querySelector('.plan-more')?.click()`);
  await waitFor(cdp, `document.querySelector('[data-problem-menu]') !== null`, 5000, '删除菜单');
  await evaluate(cdp, `document.querySelector('[data-problem-menu] [data-action="delete-problem"]')?.click()`);
  await waitFor(cdp, `document.querySelector('#modalBackdrop:not(.hidden)') !== null && document.querySelector('#modalSubmit')?.textContent === '确认删除'`, 5000, '删除确认弹窗');
  check('删除确认弹窗标题含问题名', await evaluate(cdp, `document.querySelector('#modalTitle')?.textContent.includes('健康管理')`));
  await evaluate(cdp, `document.querySelector('#modalSubmit').click()`);
  await waitFor(cdp, `document.querySelectorAll('.plan-list .plan-list-row').length === 1`, 8000, '删除生效');
  check('删除后剩 1 条并选中相邻', await evaluate(cdp, `document.querySelector('.plan-list .plan-list-row .plan-name')?.textContent === '工作与职业' && document.querySelector('#problemName')?.value === '工作与职业'`));

  // 删除最后一条 → 回到空态
  await evaluate(cdp, `document.querySelector('.plan-list-row .plan-more')?.click()`);
  await waitFor(cdp, `document.querySelector('[data-problem-menu]') !== null`, 5000, '菜单3');
  await evaluate(cdp, `document.querySelector('[data-problem-menu] [data-action="delete-problem"]')?.click()`);
  await waitFor(cdp, `document.querySelector('#modalBackdrop:not(.hidden)') !== null`, 5000, '确认3');
  await evaluate(cdp, `document.querySelector('#modalSubmit').click()`);
  await waitFor(cdp, `document.querySelector('.plans-page .empty-state h3') !== null`, 8000, '回归空态');
  check('删除最后一个问题后回到空态「建立第一个问题」', await evaluate(cdp, `document.querySelector('.plans-page .empty-state h3')?.textContent === '建立第一个问题'`));
  await shot(cdp, 'pr-04-empty-again.png');
}

async function stage4Mobile(cdp) {
  console.log('\n===== 阶段 4：移动端（390x844） =====');
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await cdp.send('Page.reload', { ignoreCache: true });
  await waitFor(cdp, `document.querySelector('#app .page') !== null`, 12000, '移动端首页');
  await sleep(500);
  await evaluate(cdp, `document.querySelector('.nav-item[data-view="problems"]').click()`);
  await waitFor(cdp, `document.querySelector('.plans-page .empty-state h3') !== null`, 8000, '移动端空态');
  // 建一条数据，验证单栏列表 + 编辑器
  await evaluate(cdp, `document.querySelector('[data-action="add-problem"]')?.click()`);
  await waitFor(cdp, `document.querySelector('#modalBackdrop:not(.hidden)') !== null`, 5000, '移动端弹窗');
  await setInputValue(cdp, '#modalInput', '移动端自检问题');
  await submitModal(cdp);
  await waitFor(cdp, `document.querySelector('#problemName') !== null`, 8000, '移动端编辑器');
  const mobile = await evaluate(cdp, `
    (() => {
      const page = document.querySelector('.plans-page');
      const list = document.querySelector('.plan-list');
      return {
        columns: getComputedStyle(page).gridTemplateColumns,
        railPosition: getComputedStyle(document.querySelector('.plan-rail')).position,
        listDisplay: list ? getComputedStyle(list).display : 'NO LIST',
        listOverflow: list ? getComputedStyle(list).overflowX : 'NO LIST',
        rowWidth: document.querySelector('.plan-list-row')?.getBoundingClientRect().width,
        noHScroll: document.scrollingElement.scrollWidth <= document.scrollingElement.clientWidth + 1,
        editorWidth: document.querySelector('#problemContent')?.getBoundingClientRect().width,
      };
    })()
  `);
  console.log('  移动端:', JSON.stringify(mobile));
  check('860 以下单栏布局（grid 单列）', mobile.columns.split(' ').length === 1, mobile.columns);
  check('列表横向滚动（flex + overflow auto）', mobile.listDisplay === 'flex' && mobile.listOverflow === 'auto', JSON.stringify({ d: mobile.listDisplay, o: mobile.listOverflow }));
  check('列表卡片宽约 200px+', mobile.rowWidth >= 190, `实际 ${mobile.rowWidth}`);
  check('无横向溢出', mobile.noHScroll);
  check('编辑器在容器内可用', mobile.editorWidth > 250, `宽 ${mobile.editorWidth}`);
  await shot(cdp, 'pr-03-mobile.png');

  // 移动端点击列表行切换
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await cdp.send('Page.reload', { ignoreCache: true });
  await waitFor(cdp, `document.querySelector('#app .page') !== null`, 12000, '桌面回归');
  await evaluate(cdp, `document.querySelector('.nav-item[data-view="problems"]').click()`);
  await waitFor(cdp, `document.querySelector('.plan-list-row') !== null`, 8000, '回归问题页');
  // 清理移动端自建数据，供持久化检查
  const mobileSt = await (await fetch(`${API}/api/state`)).json();
  for (const p of mobileSt.problems || []) await apiCall('DELETE', `/api/problems/${p.id}`);
}

async function stage5Persist() {
  console.log('\n===== 持久化检查 =====');
  const raw = JSON.parse(fs.readFileSync(path.join(dataDir, 'data.json'), 'utf8'));
  check('UI 删除全部后 problems 持久化为空数组', Array.isArray(raw.problems) && raw.problems.length === 0, JSON.stringify(raw.problems));
  check('problemTopics 字段不存在于落盘数据', !('problemTopics' in raw));
  check('旧字段仍保留（原则/记录）', raw.sections?.length === 1 && raw.records?.['2026-08-14'] !== undefined, JSON.stringify({ s: raw.sections?.length }));
}

async function main() {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'problems-qa-'));
  try {
    await stage1Migration();
    await stage2Api();

    const profile = path.join(os.tmpdir(), `problems-qa-chrome-${Date.now()}`);
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

    await stage3UiDesktop(cdp);
    await stage4Mobile(cdp);
    await stage5Persist();

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
  } finally {
    await stopServer();
    try { if (chrome) chrome.kill(); } catch (_) { /* ignore */ }
    try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch (_) { /* ignore */ }
  }

  console.log(`\n===== 结果: ${failures.length ? 'FAIL' : 'PASS'}（失败 ${failures.length} 项） =====`);
  for (const f of failures) console.log('  -', f);
  process.exit(failures.length ? 1 : 0);
}

main().catch((err) => {
  console.error('测试脚本异常:', err);
  if (chrome) { try { chrome.kill(); } catch (_) { /* ignore */ } }
  if (server) { try { server.kill(); } catch (_) { /* ignore */ } }
  process.exit(2);
});
