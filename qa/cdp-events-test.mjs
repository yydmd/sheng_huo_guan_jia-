/**
 * 事件安排模块 · 综合验证脚本（日程/日历/固定安排/抽屉/范围操作/移动端）
 * 用法: node qa/cdp-events-test.mjs
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(__dirname, '..', 'qa');
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const DEBUG_PORT = 9340;
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

async function setInputValue(cdp, selector, value) {
  await evaluate(cdp, `
    (() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return;
      const proto = el instanceof HTMLTextAreaElement ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
      setter.call(el, ${JSON.stringify(value)});
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    })()
  `);
}

async function setSelect(cdp, selector, value) {
  await evaluate(cdp, `
    (() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return;
      el.value = ${JSON.stringify(value)};
      el.dispatchEvent(new Event('change', { bubbles: true }));
    })()
  `);
}

async function click(cdp, expr) {
  await evaluate(cdp, expr);
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const profile = path.join(os.tmpdir(), `dsh-events-test-${Date.now()}`);
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

  console.log('===== 1. 导航与初始 =====');
  await cdp.send('Page.navigate', { url: `${API}/` });
  await waitFor(cdp, `document.querySelector('#app .page') !== null`, 12000, '首页');
  await sleep(500);
  const nav = await evaluate(cdp, `
    (() => {
      const views = [...document.querySelectorAll('.primary-nav .nav-item')].map((b) => ({ v: b.dataset.view, text: b.querySelector('span')?.textContent, icon: b.querySelector('[data-lucide]')?.getAttribute('data-lucide') }));
      return views;
    })()
  `);
  check('导航第一位是重要时间点（无“今天”）', nav[0].v === 'events' && nav[0].text === '重要时间点' && !nav.some((n) => n.text === '今天'), JSON.stringify(nav));
  check('重要时间点使用 calendar-check 图标', nav[0].icon === 'calendar-check', JSON.stringify(nav[0]));
  check('默认进入重要时间点日程页', await evaluate(cdp, `document.querySelector('.events-page') !== null && document.querySelector('[data-action="event-mode"][data-mode="schedule"]')?.classList.contains('active')`));
  check('顶部标题为「重要时间点」', await evaluate(cdp, `document.querySelector('#topbar h1')?.textContent === '重要时间点'`));
  check('初始空状态「今天还没有安排」', await evaluate(cdp, `document.querySelector('.empty-state h3')?.textContent === '今天还没有安排'`));
  await shot(cdp, 'ev-01-empty.png');

  console.log('===== 2. 添加单次与每日事件 =====');
  await click(cdp, `document.querySelector('[data-action="open-event-drawer"]').click()`);
  await waitFor(cdp, `document.querySelector('#eventDrawerRoot') && !document.querySelector('#eventDrawerRoot').classList.contains('hidden')`, 5000, '抽屉');
  check('抽屉打开后焦点在标题输入框', await evaluate(cdp, `document.activeElement?.id === 'eventTitleInput'`));
  await setInputValue(cdp, '#eventTitleInput', '晨间阅读');
  await setInputValue(cdp, '#eventTimeField', '08:30');
  await setSelect(cdp, '#eventRepeatSelect', 'daily');
  const preview = await evaluate(cdp, `document.querySelector('#eventDrawerPreview')?.textContent`);
  check('规则预览显示每天', preview.includes('每天'), preview);
  await click(cdp, `document.querySelector('#eventDrawerSave').click()`);
  await waitFor(cdp, `document.querySelectorAll('.event-row').length === 1`, 8000, '事件保存');
  check('每日事件出现在日程', await evaluate(cdp, `document.querySelector('.event-title')?.textContent === '晨间阅读' && document.querySelector('.event-repeat')?.textContent === '每天'`));
  check('摘要显示今日 1 项', await evaluate(cdp, `document.querySelector('#eventsSummaryText')?.textContent.includes('今日 1 项')`));

  await click(cdp, `document.querySelector('[data-action="open-event-drawer"]').click()`);
  await waitFor(cdp, `document.querySelector('#eventTitleInput') !== null`, 5000, '抽屉2');
  await setInputValue(cdp, '#eventTitleInput', '和父母通话');
  await setInputValue(cdp, '#eventTimeField', '19:00');
  await click(cdp, `document.querySelector('#eventDrawerSave').click()`);
  await waitFor(cdp, `document.querySelectorAll('.event-row').length === 2`, 8000, '事件2');
  const order = await evaluate(cdp, `[...document.querySelectorAll('.event-title')].map((e) => e.textContent)`);
  check('按时间排序（08:30 在前）', order[0] === '晨间阅读' && order[1] === '和父母通话', JSON.stringify(order));

  console.log('===== 3. 打卡 =====');
  const dailyKey = await evaluate(cdp, `[...document.querySelectorAll('.event-row')].find((r) => r.querySelector('.event-title')?.textContent === '晨间阅读').dataset.key`);
  await click(cdp, `document.querySelector('.event-row[data-key="${dailyKey}"] input[type="checkbox"]').click()`);
  await waitFor(cdp, `document.querySelector('.event-row[data-key="${dailyKey}"]').classList.contains('done')`, 8000, '打卡完成');
  check('完成后移入已完成区且摘要更新', await evaluate(cdp, `document.querySelector('#eventsSummaryText')?.textContent.includes('已完成 1 项')`));
  check('已完成事件显示删除线样式', await evaluate(cdp, `document.querySelector('.event-row.done .event-title')?.classList.length >= 0 && getComputedStyle(document.querySelector('.event-row.done .event-title')).textDecorationLine.includes('line-through')`));
  await click(cdp, `document.querySelector('.event-row[data-key="${dailyKey}"] input[type="checkbox"]').click()`);
  await waitFor(cdp, `!document.querySelector('.event-row[data-key="${dailyKey}"]').classList.contains('done')`, 8000, '取消完成');
  check('再次点击取消完成', true);

  console.log('===== 4. 日期导航与完成独立 =====');
  await click(cdp, `document.querySelector('[data-action="event-next-day"]').click()`);
  await waitFor(cdp, `document.querySelectorAll('.event-row').length === 1`, 8000, '明天');
  check('明天只有每日事件（单次不出现）', await evaluate(cdp, `document.querySelector('.event-title')?.textContent === '晨间阅读' && document.querySelectorAll('.event-row').length === 1`));
  check('非今日摘要显示「共 1 项」', await evaluate(cdp, `document.querySelector('#eventsSummaryText')?.textContent.includes('共 1 项')`));
  const tomorrowKey = await evaluate(cdp, `document.querySelector('.event-row').dataset.key`);
  await click(cdp, `document.querySelector('.event-row input[type="checkbox"]').click()`);
  await waitFor(cdp, `document.querySelector('.event-row.done') !== null`, 8000, '明天完成');
  await click(cdp, `document.querySelector('[data-action="event-today"]').click()`);
  await waitFor(cdp, `document.querySelectorAll('.event-row').length === 2`, 8000, '回到今天');
  check('完成状态按日独立（今天未完成）', await evaluate(cdp, `document.querySelectorAll('.event-row.done').length === 0`));

  console.log('===== 5. 每周与每月重复 =====');
  // 每周五事件（今天 8/14 周五）
  await click(cdp, `document.querySelector('[data-action="open-event-drawer"]').click()`);
  await waitFor(cdp, `document.querySelector('#eventTitleInput') !== null`, 5000, '抽屉3');
  await setInputValue(cdp, '#eventTitleInput', '每周复盘');
  await setInputValue(cdp, '#eventTimeField', '20:00');
  await setSelect(cdp, '#eventRepeatSelect', 'weekly');
  await waitFor(cdp, `document.querySelector('#eventWeekdaysField') && !document.querySelector('#eventWeekdaysField').classList.contains('hidden')`, 5000, '星期选择');
  await click(cdp, `document.querySelector('.weekday-btn[data-weekday="5"]').click()`);
  await click(cdp, `document.querySelector('#eventDrawerSave').click()`);
  await waitFor(cdp, `document.querySelectorAll('.event-row').length === 3`, 8000, '每周事件');
  // 每月 14 日事件
  await click(cdp, `document.querySelector('[data-action="open-event-drawer"]').click()`);
  await waitFor(cdp, `document.querySelector('#eventTitleInput') !== null`, 5000, '抽屉4');
  await setInputValue(cdp, '#eventTitleInput', '整理账单');
  await setSelect(cdp, '#eventRepeatSelect', 'monthly');
  await waitFor(cdp, `document.querySelector('#eventMonthlyField') && !document.querySelector('#eventMonthlyField').classList.contains('hidden')`, 5000, '每月规则');
  await click(cdp, `document.querySelector('#eventDrawerSave').click()`);
  await waitFor(cdp, `document.querySelectorAll('.event-row').length === 4`, 8000, '每月事件');
  check('今天（14日）有 4 个事件', await evaluate(cdp, `document.querySelectorAll('.event-row').length === 4`));
  // 每月最后一天事件
  await click(cdp, `document.querySelector('[data-action="open-event-drawer"]').click()`);
  await waitFor(cdp, `document.querySelector('#eventTitleInput') !== null`, 5000, '抽屉5');
  await setInputValue(cdp, '#eventTitleInput', '月末结账');
  await setSelect(cdp, '#eventRepeatSelect', 'monthly');
  await waitFor(cdp, `document.querySelector('#eventMonthlyField') !== null`, 5000, '每月规则2');
  await click(cdp, `document.querySelector('input[name="monthlyMode"][value="lastDay"]').click()`);
  const lastDayPreview = await evaluate(cdp, `document.querySelector('#eventDrawerPreview')?.textContent`);
  check('每月最后一天预览', lastDayPreview.includes('每月最后一天'), lastDayPreview);
  await click(cdp, `document.querySelector('#eventDrawerSave').click()`);
  await sleep(600);
  check('今天（非月末）不出现月末事件', await evaluate(cdp, `document.querySelectorAll('.event-row').length === 4`));
  // 跳到 8/31：应出现 5 个（每天+每周五? 8/31 是周一，每周五不出现 → 每天+每月14日不出现+月末=2？8/31: 晨间阅读(每天)+月末结账(月末) = 2）
  await evaluate(cdp, `document.querySelector('#eventDateInput').value = '2026-08-31'; document.querySelector('#eventDateInput').dispatchEvent(new Event('change', { bubbles: true }))`);
  await waitFor(cdp, `document.querySelectorAll('.event-row').length === 2`, 8000, '8月31日');
  const aug31 = await evaluate(cdp, `[...document.querySelectorAll('.event-title')].map((e) => e.textContent)`);
  check('8/31 出现每天+月末事件', aug31.includes('晨间阅读') && aug31.includes('月末结账') && !aug31.includes('整理账单') && !aug31.includes('每周复盘'), JSON.stringify(aug31));
  // 8/21（周五）每周复盘出现
  await evaluate(cdp, `document.querySelector('#eventDateInput').value = '2026-08-21'; document.querySelector('#eventDateInput').dispatchEvent(new Event('change', { bubbles: true }))`);
  await waitFor(cdp, `document.querySelectorAll('.event-row').length >= 1`, 8000, '8月21日');
  const aug21 = await evaluate(cdp, `[...document.querySelectorAll('.event-title')].map((e) => e.textContent)`);
  check('8/21（周五）出现每周复盘', aug21.includes('每周复盘'), JSON.stringify(aug21));
  // 8/22（周六）每周复盘不出现
  await evaluate(cdp, `document.querySelector('#eventDateInput').value = '2026-08-22'; document.querySelector('#eventDateInput').dispatchEvent(new Event('change', { bubbles: true }))`);
  await sleep(600);
  const aug22 = await evaluate(cdp, `[...document.querySelectorAll('.event-title')].map((e) => e.textContent)`);
  check('8/22（周六）无每周复盘', !aug22.includes('每周复盘'), JSON.stringify(aug22));
  await shot(cdp, 'ev-02-schedule.png');

  console.log('===== 6. 日历视图 =====');
  await click(cdp, `document.querySelector('[data-action="event-mode"][data-mode="calendar"]').click()`);
  await waitFor(cdp, `document.querySelector('.event-calendar-grid') !== null`, 8000, '月历');
  const cal = await evaluate(cdp, `
    (() => {
      const cells = [...document.querySelectorAll('.event-cal-cell')];
      const aug14 = cells.find((c) => c.dataset.date === '2026-08-14');
      const aug31 = cells.find((c) => c.dataset.date === '2026-08-31');
      return {
        total: cells.length,
        title: document.querySelector('#eventsCalendarTitle')?.textContent,
        aug14Count: aug14?.querySelector('.event-cal-count')?.textContent,
        aug14Dots: aug14?.querySelector('.event-cal-dots')?.textContent || '',
        aug31Count: aug31?.querySelector('.event-cal-count')?.textContent,
        todayMarked: cells.find((c) => c.classList.contains('today'))?.dataset.date,
      };
    })()
  `);
  console.log('  月历:', JSON.stringify(cal));
  check('月历 42 格且标题为 2026年8月', cal.total === 42 && cal.title === '2026年8月', JSON.stringify(cal));
  check('8/14 显示 4 项事件计数', cal.aug14Count === '0/4', JSON.stringify(cal.aug14Count));
  check('8/14 显示圆点', cal.aug14Dots.includes('●'));
  check('8/31 显示 2 项', cal.aug31Count === '0/2', JSON.stringify(cal.aug31Count));
  check('今天有标记', cal.todayMarked !== undefined);
  await shot(cdp, 'ev-03-calendar.png');
  // 点击 8/31 → 切回日程
  await click(cdp, `document.querySelector('.event-cal-cell[data-date="2026-08-31"]').click()`);
  await waitFor(cdp, `document.querySelector('.events-list') !== null`, 8000, '回到日程');
  check('点击月历日期切回日程并更新日期', await evaluate(cdp, `document.querySelector('#eventsDateTitle')?.textContent.includes('2026-08-31') && document.querySelector('[data-action="event-mode"][data-mode="schedule"]')?.classList.contains('active')`));

  console.log('===== 7. 固定安排管理 =====');
  await click(cdp, `document.querySelector('[data-action="event-mode"][data-mode="recurring"]').click()`);
  await waitFor(cdp, `document.querySelectorAll('.recurring-row').length >= 4`, 8000, '固定安排');
  const rec = await evaluate(cdp, `
    (() => {
      const rows = [...document.querySelectorAll('.recurring-row')];
      return rows.map((r) => ({ title: r.querySelector('.recurring-title')?.textContent, meta: r.querySelector('.recurring-meta')?.textContent, next: r.querySelector('.recurring-next')?.textContent, toggle: r.querySelector('.recurring-toggle')?.textContent }));
    })()
  `);
  console.log('  固定安排:', JSON.stringify(rec));
  check('固定安排含每天/每周/每月模板', rec.some((r) => r.meta.includes('每天')) && rec.some((r) => r.meta.includes('每周五')) && rec.some((r) => r.meta.includes('每月14日')) && rec.some((r) => r.meta.includes('每月最后一天')), JSON.stringify(rec));
  // 筛选：每天
  await click(cdp, `document.querySelector('[data-action="event-recurring-filter"][data-filter="daily"]').click()`);
  await waitFor(cdp, `document.querySelectorAll('.recurring-row').length === 1`, 8000, '筛选每天');
  check('筛选每天后只剩 1 条', await evaluate(cdp, `document.querySelector('.recurring-title')?.textContent === '晨间阅读'`));
  await click(cdp, `document.querySelector('[data-action="event-recurring-filter"][data-filter="all"]').click()`);
  await waitFor(cdp, `document.querySelectorAll('.recurring-row').length === 4`, 8000, '恢复全部');
  // 暂停晨间阅读
  await click(cdp, `[...document.querySelectorAll('.recurring-row')].find((r) => r.querySelector('.recurring-title')?.textContent === '晨间阅读').querySelector('.recurring-toggle').click()`);
  await waitFor(cdp, `[...document.querySelectorAll('.recurring-row')].find((r) => r.querySelector('.recurring-title')?.textContent === '晨间阅读')?.classList.contains('paused')`, 8000, '暂停');
  check('暂停后标记为 paused', true);
  await click(cdp, `document.querySelector('[data-action="event-mode"][data-mode="schedule"]').click()`);
  await waitFor(cdp, `document.querySelector('.events-list') !== null`, 8000, '日程');
  check('暂停后日程不再出现该事件', await evaluate(cdp, `![...document.querySelectorAll('.event-title')].some((e) => e.textContent === '晨间阅读')`));
  await click(cdp, `document.querySelector('[data-action="event-mode"][data-mode="recurring"]').click()`);
  await waitFor(cdp, `document.querySelectorAll('.recurring-row').length === 4`, 8000, '固定安排2');
  await click(cdp, `[...document.querySelectorAll('.recurring-row')].find((r) => r.querySelector('.recurring-title')?.textContent === '晨间阅读').querySelector('.recurring-toggle').click()`);
  await waitFor(cdp, `[...document.querySelectorAll('.recurring-row')].find((r) => r.querySelector('.recurring-title')?.textContent === '晨间阅读') && ![...document.querySelectorAll('.recurring-row')].find((r) => r.querySelector('.recurring-title')?.textContent === '晨间阅读').classList.contains('paused')`, 8000, '重新启用');
  check('重新启用成功', true);
  await shot(cdp, 'ev-04-recurring.png');

  console.log('===== 8. 编辑范围（仅本次） =====');
  await click(cdp, `document.querySelector('[data-action="event-mode"][data-mode="schedule"]').click()`);
  await waitFor(cdp, `document.querySelector('.events-list') !== null`, 8000, '日程3');
  // 切到 8/21（每周复盘出现）
  await evaluate(cdp, `document.querySelector('#eventDateInput').value = '2026-08-21'; document.querySelector('#eventDateInput').dispatchEvent(new Event('change', { bubbles: true }))`);
  await waitFor(cdp, `[...document.querySelectorAll('.event-title')].some((e) => e.textContent === '每周复盘')`, 8000, '8月21日');
  const wkKey = await evaluate(cdp, `[...document.querySelectorAll('.event-row')].find((r) => r.querySelector('.event-title')?.textContent === '每周复盘').dataset.key`);
  await click(cdp, `document.querySelector('.event-row[data-key="${wkKey}"] [data-action="open-event-menu"]').click()`);
  await waitFor(cdp, `document.querySelector('.event-menu') !== null`, 5000, '事件菜单');
  await click(cdp, `document.querySelector('.event-menu [data-action="edit-event-instance"]').click()`);
  await waitFor(cdp, `document.querySelector('#modalBackdrop:not(.hidden)') !== null`, 5000, '范围弹窗');
  check('重复事件编辑出现范围选择', await evaluate(cdp, `document.querySelectorAll('.range-option input').length === 2 && document.querySelector('input[name="eventRange"]:checked')?.value === 'split'`));
  await click(cdp, `document.querySelector('input[name="eventRange"][value="override"]').click()`);
  await click(cdp, `document.querySelector('#modalSubmit').click()`);
  await waitFor(cdp, `document.querySelector('#eventTitleInput') !== null`, 8000, '抽屉编辑');
  await setInputValue(cdp, '#eventTitleInput', '提前复盘');
  await click(cdp, `document.querySelector('#eventDrawerSave').click()`);
  await sleep(1500);
  await waitFor(cdp, `document.body.innerText.includes('提前复盘')`, 8000, '例外生效');
  check('仅本次修改生效（当日标题变为提前复盘）', await evaluate(cdp, `[...document.querySelectorAll('.event-title')].some((e) => e.textContent === '提前复盘')`));
  // 8/28（下周五）仍是每周复盘
  await evaluate(cdp, `document.querySelector('#eventDateInput').value = '2026-08-28'; document.querySelector('#eventDateInput').dispatchEvent(new Event('change', { bubbles: true }))`);
  await sleep(700);
  check('其他日期不受影响（仍为每周复盘）', await evaluate(cdp, `[...document.querySelectorAll('.event-title')].some((e) => e.textContent === '每周复盘') && ![...document.querySelectorAll('.event-title')].some((e) => e.textContent === '提前复盘')`));

  console.log('===== 9. 删除范围（仅删除这一次） =====');
  await evaluate(cdp, `document.querySelector('#eventDateInput').value = '2026-08-28'; document.querySelector('#eventDateInput').dispatchEvent(new Event('change', { bubbles: true }))`);
  await waitFor(cdp, `[...document.querySelectorAll('.event-title')].some((e) => e.textContent === '每周复盘')`, 8000, '8月28日');
  const wkKey28 = await evaluate(cdp, `[...document.querySelectorAll('.event-row')].find((r) => r.querySelector('.event-title')?.textContent === '每周复盘').dataset.key`);
  await click(cdp, `document.querySelector('.event-row[data-key="${wkKey28}"] [data-action="open-event-menu"]').click()`);
  await waitFor(cdp, `document.querySelector('.event-menu') !== null`, 5000, '菜单2');
  await click(cdp, `document.querySelector('.event-menu [data-action="delete-event-instance"]').click()`);
  await waitFor(cdp, `document.querySelector('#modalBackdrop:not(.hidden)') !== null`, 5000, '删除范围');
  check('删除出现范围选择', await evaluate(cdp, `document.querySelectorAll('.range-option input').length === 2`));
  await click(cdp, `document.querySelector('input[name="eventRange"][value="this"]').click()`);
  await click(cdp, `document.querySelector('#modalSubmit').click()`);
  await waitFor(cdp, `![...document.querySelectorAll('.event-title')].some((e) => e.textContent === '每周复盘')`, 8000, '删除本次');
  check('仅删除这一次成功', true);
  // 9/4（周五）仍出现每周复盘
  await evaluate(cdp, `document.querySelector('#eventDateInput').value = '2026-09-04'; document.querySelector('#eventDateInput').dispatchEvent(new Event('change', { bubbles: true }))`);
  await sleep(700);
  check('未来日期每周复盘仍在', await evaluate(cdp, `[...document.querySelectorAll('.event-title')].some((e) => e.textContent === '每周复盘')`));

  console.log('===== 10. 移动端 390x844 =====');
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await cdp.send('Page.reload', { ignoreCache: true });
  await waitFor(cdp, `document.querySelector('#app .page') !== null`, 12000, '移动端首页');
  await sleep(500);
  check('移动端无横向溢出', await evaluate(cdp, `document.scrollingElement.scrollWidth <= document.scrollingElement.clientWidth + 1`));
  await click(cdp, `document.querySelector('[data-action="open-event-drawer"]').click()`);
  await waitFor(cdp, `document.querySelector('#eventTitleInput') !== null`, 5000, '移动抽屉');
  const mobileDrawer = await evaluate(cdp, `({ w: document.querySelector('.event-drawer').getBoundingClientRect().width, vw: window.innerWidth })`);
  check('移动端抽屉全宽', mobileDrawer.w >= mobileDrawer.vw - 2, JSON.stringify(mobileDrawer));
  check('移动端抽屉无横向滚动', await evaluate(cdp, `document.querySelector('.event-drawer').scrollWidth <= document.querySelector('.event-drawer').clientWidth + 2`));
  await click(cdp, `document.querySelector('#eventDrawerCancel').click()`);
  await sleep(300);
  await shot(cdp, 'ev-05-mobile.png');

  console.log('\n===== 11. 持久化与数据完整性 =====');
  const raw = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'data.json'), 'utf8'));
  check('events 已持久化（≥4 条）', Array.isArray(raw.events) && raw.events.length >= 4, `count=${raw.events.length}`);
  check('eventCheckins 已持久化', Object.keys(raw.eventCheckins || {}).length >= 1, JSON.stringify(Object.keys(raw.eventCheckins || {})));
  check('eventExceptions 已持久化（override + cancel）', (raw.eventExceptions || []).filter((e) => e.type === 'override').length >= 1 && (raw.eventExceptions || []).filter((e) => e.type === 'cancel').length >= 1, JSON.stringify(raw.eventExceptions));
  check('原则/计划/问题数据未被污染', raw.sections?.length >= 1 && raw.plans?.length >= 1 && Array.isArray(raw.problemTopics), JSON.stringify({ s: raw.sections?.length, p: raw.plans?.length }));
  const st = await (await fetch(`${API}/api/state`)).json();
  check('原则打卡 records 未受影响', st.records && typeof st.records === 'object', JSON.stringify(Object.keys(st.records || {})));
  check('api/state 返回三个事件字段', Array.isArray(st.events) && typeof st.eventCheckins === 'object' && Array.isArray(st.eventExceptions));

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
