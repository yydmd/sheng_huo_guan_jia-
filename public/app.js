'use strict';

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

let state = {
  version: 0,
  sections: [], records: {}, checkinReasons: {}, thoughtEntries: [], thoughtCategories: [], reflectFrameworks: [], reflectEntries: {}, plans: [], problemTopics: [],
  events: [], eventCheckins: {}, eventExceptions: [], backups: [],
};
let currentView = 'events';
let currentPrincipleTab = 'checkin';
let selectedDate = localToday();
let selectedReviewDate = addDays(localToday(), -1);
let dailyReviewFilter = 'all';
let reviewCompletedExpanded = false;
let reasonTimelineRange = '30';
let reasonTimelineQuery = '';
let reviewHighlightItemId = null;
let selectedPlanId = null;
let focusItemId = null;
let toastTimer = null;
let thinkTimer = null;
let reflectTimer = null;
let planTimer = null;
let thoughtMode = 'free';                 // 'free' | 'review' | 'reflection'
let thoughtSurface = 'history';           // 默认记录列表；'editor' | 'history'
let selectedHistoryKey = null;            // 历史记录中当前打开的文章/反思 key
let historyListScroll = { app: 0, window: 0 }; // 从阅读页返回时恢复列表位置
let thoughtHistoryFilter = 'all';         // 'all' | 'free' | 'review' | 'reflection'
let thoughtHistoryCategory = 'all';       // 'all' | 'uncategorized' | categoryId
let thoughtHistoryQuery = '';             // 历史搜索关键词
let selectedThoughtId = null;              // 当前编辑的自由思考 id，'draft' 为临时草稿
let thoughtDraft = null;                   // 尚未产生有效内容的客户端草稿
let thoughtSavePromise = null;             // 当前正在提交的自由思考请求
let reflectSavePromise = null;             // 当前正在提交的每日反思请求
let planSavePromise = null;                // 当前正在提交的计划请求
let thinkRetry = null;                     // 自由思考保存失败时的完整文章快照
let reflectRetry = null;                  // 每日反思保存失败时的重试快照
let planMenuOpenId = null;                // 计划列表“更多”菜单当前打开的计划 id
let planRetry = null;                     // 计划保存失败时的重试快照
let selectedProblemTopicId = null;        // 问题归纳当前选中的主题 id
let problemMenuOpenId = null;             // 问题主题“更多”菜单当前打开的主题 id
let problemMenuAnchor = 'rail';           // 菜单锚点：'rail'（左侧行内）| 'detail'（详情标题区）
let eventDate = localToday();             // 事件安排独立日期（允许过去与未来）
let eventMode = 'schedule';               // 'schedule' | 'calendar' | 'recurring' | 'memos'
let eventCalendarCursor = null;           // 月历当前显示的 'YYYY-MM'
let eventMenuKey = null;                  // 事件“更多”菜单打开的实例键 'eventId@date'（固定安排页为事件 id）
let eventEditing = null;                  // 抽屉编辑上下文：null=新建；{ event, date }=编辑某次发生
let eventCreateDate = null;               // 从备忘事件页新建时，默认使用明天但不改变日程当前日期
let eventRecurringFilter = 'all';         // 固定安排筛选：'all' | 'daily' | 'weekly' | 'monthly'
let eventDoneCollapsed = false;           // 日程页已完成列表是否折叠
let eventNoteExpandedKey = null;          // 当前展开完整备注的事件实例键

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[char]));
}

function toISODate(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function localToday() { return toISODate(new Date()); }
function parseDate(value) {
  const [year, month, day] = value.split('-').map(Number);
  return new Date(year, month - 1, day);
}
function addDays(value, amount) {
  const date = parseDate(value);
  date.setDate(date.getDate() + amount);
  return toISODate(date);
}
function dateLabel(value) {
  const date = parseDate(value);
  const weekday = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'][date.getDay()];
  return `${date.getMonth() + 1}月${date.getDate()}日 ${weekday}`;
}
function topDateLabel(value) {
  const date = parseDate(value);
  const weekday = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'][date.getDay()];
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}　${weekday}`;
}
function nowTime() {
  const date = new Date();
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

function allItems() {
  return state.sections.flatMap((section) => (section.items || []).map((item) => ({ section, item })));
}
function activeChildren(item, date) {
  return (item.children || []).filter((child) => !child.activeSince || child.activeSince <= date);
}
function activeItemsOn(date) {
  return allItems().flatMap(({ section, item }) => {
    if (item.activeSince && item.activeSince > date) return [];
    const children = activeChildren(item, date);
    return children.length
      ? children.map((child) => ({ section, item: child, parent: item }))
      : [{ section, item, parent: null }];
  });
}
function recordFor(date = selectedDate) { return state.records[date] || {}; }
function reasonFor(itemId, date = selectedDate) { return state.checkinReasons[date]?.[itemId] || ''; }
function checkinStatus(itemId, date) {
  const record = state.records[date] || {};
  if (!Object.prototype.hasOwnProperty.call(record, itemId)) return 'missed';
  return record[itemId] ? 'done' : 'incomplete';
}
function dailyReview(date) {
  const items = activeItemsOn(date).map((entry) => ({
    ...entry,
    status: checkinStatus(entry.item.id, date),
    reason: reasonFor(entry.item.id, date),
  }));
  const done = items.filter((entry) => entry.status === 'done').length;
  return { date, items, done, ratio: items.length ? done / items.length : null };
}
function allNodeContexts() {
  return state.sections.flatMap((section) => (section.items || []).flatMap((parent) => [
    { section, item: parent, parent: null },
    ...(parent.children || []).map((item) => ({ section, item, parent })),
  ]));
}
function currentPlan() { return state.plans.find((plan) => plan.id === selectedPlanId) || null; }

async function api(method, url, body) {
  const options = { method, headers: {} };
  if (body !== undefined) {
    options.headers['Content-Type'] = 'application/json';
    options.body = JSON.stringify(body);
  }
  const response = await fetch(url, options);
  let data = null;
  try { data = await response.json(); } catch (_) { /* empty response */ }
  if (!response.ok) throw new Error(data?.error || `请求失败（${response.status}）`);
  return data;
}

function toast(message, isError = false) {
  const element = $('#toast');
  element.textContent = message;
  element.classList.toggle('error', isError);
  element.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => element.classList.remove('show'), 2400);
}

function renderIcons() {
  if (window.lucide?.createIcons) {
    window.lucide.createIcons({ attrs: { 'aria-hidden': 'true' } });
  }
}

function emptyState(icon, title, body, actionHtml = '') {
  return `<div class="empty-state">
    <div class="empty-icon"><i data-lucide="${icon}"></i></div>
    <h3>${escapeHtml(title)}</h3>
    <p>${escapeHtml(body)}</p>
    ${actionHtml}
  </div>`;
}

function setActiveNavigation() {
  $$('.nav-item[data-view]').forEach((button) => {
    const isSettings = button.dataset.openTab === 'manage';
    const active = button.dataset.view === currentView && (!isSettings || currentPrincipleTab === 'manage');
    button.classList.toggle('active', active);
  });
}

function renderTopbar() {
  const titles = {
    events: ['重要时间点', '把固定节奏与临时安排放进清晰的一天。'],
    principles: ['原则打卡', '用清楚的原则指导每天的行动。'],
    thoughts: ['所思', '记录想法，也给一天留出复盘的空间。'],
    plans: ['计划', '让长期方向始终落到清楚的下一步。'],
    problems: ['问题归纳', '把反复出现的问题按主题整理，慢慢看清真正需要解决的事情。'],
  };
  const [title, subtitle] = titles[currentView];
  let tools = '';
  if ((currentView === 'principles' && currentPrincipleTab !== 'stats') || currentView === 'thoughts') {
    const onHistory = currentView === 'thoughts' && thoughtSurface === 'history';
    tools = `<div class="topbar-tools">
      ${currentView === 'thoughts' && !onHistory ? `<button class="button ghost small" data-action="open-thought-history"><i data-lucide="arrow-left"></i>返回记录列表</button>` : ''}
      ${onHistory ? '' : `<div class="date-control">
        <button class="icon-button" data-action="prev-date" aria-label="前一天"><i data-lucide="chevron-left"></i></button>
        <input id="globalDate" type="date" value="${selectedDate}" max="${localToday()}" aria-label="选择日期" />
        <button class="icon-button" data-action="next-date" aria-label="后一天" ${selectedDate >= localToday() ? 'disabled' : ''}><i data-lucide="chevron-right"></i></button>
        <button class="button ghost small" data-action="today-date">今天</button>
      </div>`}
    </div>`;
  }
  $('#topbar').innerHTML = `
    <div class="topbar-title">
      <h1>${escapeHtml(title)}</h1>
      <p>${escapeHtml(subtitle)}</p>
    </div>
    ${tools}`;
}

function render() {
  setActiveNavigation();
  renderTopbar();
  if (currentView === 'events') renderEvents();
  if (currentView === 'principles') renderPrinciples();
  if (currentView === 'thoughts') renderThoughts();
  if (currentView === 'plans') renderPlans();
  if (currentView === 'problems') renderProblems();
  renderIcons();
}

// ---------- 事件安排 ----------

function eventInstancesOn(date) {
  return EventModel.occurrencesOn(date, state.events, state.eventExceptions)
    .map((instance) => {
      const key = `${instance.eventId}@${date}`;
      const checkin = state.eventCheckins[key];
      return Object.assign({}, instance, { key, done: Boolean(checkin && checkin.done) });
    });
}

function sortEventInstances(list) {
  const withTime = list.filter((item) => item.time).sort((a, b) => (a.time < b.time ? -1 : 1));
  const noTime = list.filter((item) => !item.time);
  return [...withTime, ...noTime];
}

function renderEvents() {
  if (eventMode === 'calendar') { renderEventCalendar(); return; }
  if (eventMode === 'recurring') { renderEventRecurring(); return; }
  if (eventMode === 'memos') { renderEventMemos(); return; }
  renderEventSchedule();
}

function renderEventsHead(extra = '') {
  return `<div class="events-head">
    <div class="events-date-nav" aria-label="切换日期">
      <button class="icon-button" data-action="event-prev-day" aria-label="前一天"><i data-lucide="chevron-left"></i></button>
      <input id="eventDateInput" type="date" value="${eventDate}" aria-label="选择日期" />
      <button class="icon-button" data-action="event-next-day" aria-label="后一天"><i data-lucide="chevron-right"></i></button>
      <button class="button ghost small" data-action="event-today">今天</button>
    </div>
    <button class="button primary small" data-action="open-event-drawer" ${eventMode === 'memos' ? `data-default-date="${EventModel.addDays(localToday(), 1)}"` : ''}><i data-lucide="plus"></i>添加事件</button>
  </div>
  <nav class="segmented events-modes" aria-label="重要时间点视图">
    <button class="segment ${eventMode === 'schedule' ? 'active' : ''}" data-action="event-mode" data-mode="schedule">日程</button>
    <button class="segment ${eventMode === 'calendar' ? 'active' : ''}" data-action="event-mode" data-mode="calendar">日历</button>
    <button class="segment ${eventMode === 'recurring' ? 'active' : ''}" data-action="event-mode" data-mode="recurring">固定安排</button>
    <button class="segment ${eventMode === 'memos' ? 'active' : ''}" data-action="event-mode" data-mode="memos">备忘事件</button>
  </nav>
  ${extra}`;
}

function renderEventSchedule() {
  $('#app').innerHTML = `<section class="page content-page events-page">
    <div class="events-date-title"><h2 id="eventsDateTitle" tabindex="-1">${topDateLabel(eventDate)}</h2></div>
    ${renderEventsHead()}
    <div id="eventScheduleWrap">${eventScheduleBody()}</div>
  </section>`;
  $('#eventDateInput')?.addEventListener('change', (event) => {
    if (event.target.value) {
      eventDate = event.target.value;
      eventMenuKey = null;
      render();
    }
  });
}

function eventScheduleBody() {
  const instances = sortEventInstances(eventInstancesOn(eventDate));
  const done = instances.filter((item) => item.done);
  const pending = instances.filter((item) => !item.done);
  const collapsedDone = done.length > 3;
  const shownDone = collapsedDone ? done.slice(0, 3) : done;
  const isToday = eventDate === localToday();
  const summaryLabel = instances.length
    ? `${isToday ? '今日' : '共'} ${instances.length} 项　已完成 ${done.length} 项　进度 ${Math.round((done.length / instances.length) * 100)}%`
    : '';

  let body = '';
  if (summaryLabel) {
    const width = Math.round((done.length / instances.length) * 100);
    body += `<div class="events-summary">
      <span id="eventsSummaryText">${summaryLabel}</span>
      <div class="events-progress" aria-hidden="true"><span style="width:${width}%"></span></div>
    </div>`;
  }
  body += `<div class="events-list">`;
  body += pending.map((item) => eventRowHtml(item)).join('');
  if (shownDone.length) {
    body += `<div class="events-done-group">
      <button class="events-done-toggle" data-action="toggle-done-collapse" aria-expanded="${collapsedDone ? 'false' : 'true'}">已完成 ${done.length} 项 ${collapsedDone ? '∨' : '∧'}</button>
      <div class="events-done-list">${shownDone.map((item) => eventRowHtml(item)).join('')}</div>
    </div>`;
  }
  body += `</div>`;

  if (!instances.length) {
    const actionHtml = isToday
      ? '<button class="button primary" data-action="open-event-drawer"><i data-lucide="plus"></i>添加今天的事件</button>'
      : '';
    body += emptyState('calendar-x', isToday ? '今天还没有安排' : '这一天还没有安排',
      isToday ? '可以添加一个临时事件，也可以建立每天或每周自动出现的固定安排。' : '给这一天添加一个临时事件，或建立自动出现的固定安排。', actionHtml);
  }
  return body;
}

function eventRowHtml(instance) {
  const open = eventMenuKey === instance.key;
  const note = (instance.note || '').trim();
  const noteExpanded = eventNoteExpandedKey === instance.key;
  const repeatText = instance.repeat && instance.repeat.type !== 'none' ? EventModel.repeatLabel({ repeat: instance.repeat }) : '';
  return `<div class="event-row ${instance.done ? 'done' : ''}" data-key="${instance.key}">
    <label class="event-check">
      <input type="checkbox" data-action="toggle-event-checkin" data-key="${instance.key}" ${instance.done ? 'checked' : ''} aria-label="${escapeHtml(instance.title)}，已完成" />
      <span class="event-checkbox" aria-hidden="true">${instance.done ? '<i data-lucide="check"></i>' : ''}</span>
    </label>
    <div class="event-main">
      <div class="event-title-row">
        <span class="event-time">${instance.time ? escapeHtml(instance.time) : '<span class="event-time-none">未定时间</span>'}</span>
        <span class="event-title">${escapeHtml(instance.title)}</span>
      </div>
      ${repeatText ? `<span class="event-repeat">${escapeHtml(repeatText)}</span>` : ''}
      ${note ? `<div class="event-note ${noteExpanded ? 'expanded' : ''}" data-action="toggle-event-note" data-key="${instance.key}" title="${noteExpanded ? '' : '点击查看完整备注'}">${escapeHtml(note)}</div>` : ''}
    </div>
    <div class="event-more-wrap">
      <button class="event-more" data-action="open-event-menu" data-key="${instance.key}" aria-label="「${escapeHtml(instance.title)}」的更多操作" aria-expanded="${open}"><i data-lucide="more-horizontal"></i></button>
      ${open ? `<div class="event-menu" data-event-menu role="menu" aria-label="事件操作">
        <button class="event-menu-item" role="menuitem" data-action="edit-event-instance" data-key="${instance.key}"><i data-lucide="pencil"></i>编辑</button>
        <button class="event-menu-item danger" role="menuitem" data-action="delete-event-instance" data-key="${instance.key}"><i data-lucide="trash-2"></i>删除</button>
      </div>` : ''}
    </div>
  </div>`;
}

async function toggleEventCheckin(key) {
  const [eventId, date] = key.split('@');
  const instance = eventInstancesOn(date).find((item) => item.key === key);
  if (!instance) return;
  const done = !instance.done;
  try {
    await api('POST', '/api/event-checkin', { eventId, date, done });
    if (done) state.eventCheckins[key] = { done: true, completedAt: new Date().toISOString() };
    else delete state.eventCheckins[key];
    const wrap = $('#eventScheduleWrap');
    if (wrap) wrap.innerHTML = eventScheduleBody();
    renderIcons();
    toast(done ? `${instance.title}已完成` : `${instance.title}已取消完成`);
  } catch (error) { toast(error.message, true); }
}

function renderEventCalendar() {
  if (!eventCalendarCursor) eventCalendarCursor = eventDate.slice(0, 7);
  const [year, month] = eventCalendarCursor.split('-').map(Number);
  const grid = EventModel.calendarGrid(year, month);
  const todayStr = localToday();
  const cells = grid.map((date) => {
    const instances = eventInstancesOn(date);
    return {
      date,
      count: instances.length,
      done: instances.filter((item) => item.done).length,
      inMonth: date.slice(0, 7) === eventCalendarCursor,
      today: date === todayStr,
      selected: date === eventDate,
    };
  });
  $('#app').innerHTML = `<section class="page content-page events-page">
    ${renderEventsHead(`<div class="events-calendar-head">
      <div class="events-month-nav">
        <button class="icon-button" data-action="event-month-prev" aria-label="上个月"><i data-lucide="chevron-left"></i></button>
        <h2 id="eventsCalendarTitle" tabindex="-1">${year}年${month}月</h2>
        <button class="icon-button" data-action="event-month-next" aria-label="下个月"><i data-lucide="chevron-right"></i></button>
        <button class="button ghost small" data-action="event-month-today" ${eventCalendarCursor === todayStr.slice(0, 7) ? 'disabled' : ''}>回到本月</button>
      </div>
    </div>`)}
    <div class="event-calendar">
      <div class="event-calendar-weekdays" aria-hidden="true"><span>一</span><span>二</span><span>三</span><span>四</span><span>五</span><span>六</span><span>日</span></div>
      <div class="event-calendar-grid">
        ${cells.map((cell) => `<button class="event-cal-cell ${cell.inMonth ? '' : 'out'} ${cell.today ? 'today' : ''} ${cell.selected ? 'selected' : ''}" data-action="event-cal-select" data-date="${cell.date}" aria-label="${dateLabel(cell.date)}，${cell.count} 项事件，完成 ${cell.done} 项">
          <span class="event-cal-day">${Number(cell.date.slice(8, 10))}</span>
          ${cell.count ? `<span class="event-cal-dots">${'●'.repeat(Math.min(3, cell.count))}${cell.count > 3 ? `<em>+${cell.count - 3}</em>` : ''}</span>` : ''}
          ${cell.count ? `<span class="event-cal-count">${cell.done}/${cell.count}</span>` : ''}
        </button>`).join('')}
      </div>
    </div>
  </section>`;
}

function renderEventRecurring() {
  const today = localToday();
  const templates = state.events.filter((event) =>
    event.repeat && event.repeat.type !== 'none' && !event.archivedAt && (!event.endDate || event.endDate >= today));
  const filtered = eventRecurringFilter === 'all'
    ? templates
    : templates.filter((event) => event.repeat.type === eventRecurringFilter);
  const listHtml = filtered.length
    ? `<div class="recurring-list">${filtered.map((event) => recurringRowHtml(event, today)).join('')}</div>`
    : emptyState('repeat', templates.length ? '没有匹配的固定安排' : '还没有固定安排', templates.length ? '换个筛选条件试试。' : '建立一个每天、每周或每月自动出现的事件，它会自动进入日程。');
  $('#app').innerHTML = `<section class="page content-page events-page">
    ${renderEventsHead('')}
    <div class="recurring-filter" role="group" aria-label="按重复类型筛选">
      ${['all', 'daily', 'weekly', 'monthly'].map((type) => `<button class="history-filter-chip ${eventRecurringFilter === type ? 'active' : ''}" data-action="event-recurring-filter" data-filter="${type}">${({ all: '全部', daily: '每天', weekly: '每周', monthly: '每月' })[type]}</button>`).join('')}
    </div>
    ${listHtml}
  </section>`;
}

function futureMemoEvents() {
  return EventModel.futureMemoEvents(state.events, localToday());
}

function memoRelativeDate(date) {
  const days = Math.round((parseDate(date) - parseDate(localToday())) / 86400000);
  if (days === 1) return '明天';
  return `${days} 天后`;
}

function renderEventMemos() {
  const events = futureMemoEvents();
  const groups = [];
  for (const event of events) {
    let group = groups[groups.length - 1];
    if (!group || group.date !== event.startDate) {
      group = { date: event.startDate, events: [] };
      groups.push(group);
    }
    group.events.push(event);
  }
  const listHtml = groups.length
    ? `<div class="memo-events-list">${groups.map((group) => `<section class="memo-date-group">
        <button class="memo-date-head" data-action="event-memo-open-date" data-date="${group.date}" aria-label="查看${dateLabel(group.date)}的日程">
          <span><strong>${dateLabel(group.date)}</strong><em>${memoRelativeDate(group.date)}</em></span>
          <span class="memo-date-count">${group.events.length} 项 <i data-lucide="arrow-right"></i></span>
        </button>
        <div class="memo-date-events">${group.events.map(memoEventRowHtml).join('')}</div>
      </section>`).join('')}</div>`
    : emptyState('notebook-tabs', '还没有未来备忘事件', '添加日期晚于今天且“不重复”的事件后，会自动汇总到这里。', `<button class="button primary" data-action="open-event-drawer" data-default-date="${EventModel.addDays(localToday(), 1)}"><i data-lucide="plus"></i>添加未来事件</button>`);
  $('#app').innerHTML = `<section class="page content-page events-page">
    ${renderEventsHead('')}
    <div class="memo-events-intro">
      <div><h2>未来备忘事件</h2><p>集中查看今天之后的单次安排；每天和周期性事件仍在“固定安排”中管理。</p></div>
      ${events.length ? `<span class="memo-total">共 ${events.length} 项</span>` : ''}
    </div>
    ${listHtml}
  </section>`;
}

function memoEventRowHtml(event) {
  const key = `${event.id}@${event.startDate}`;
  const open = eventMenuKey === key;
  return `<div class="memo-event-row" data-key="${key}">
    <span class="memo-event-time">${event.time ? escapeHtml(event.time) : '未定时间'}</span>
    <div class="memo-event-main">
      <span class="memo-event-title">${escapeHtml(event.title)}</span>
      ${(event.note || '').trim() ? `<span class="memo-event-note">${escapeHtml(event.note)}</span>` : ''}
    </div>
    <div class="event-more-wrap">
      <button class="event-more" data-action="open-event-menu" data-key="${key}" aria-label="「${escapeHtml(event.title)}」的更多操作" aria-expanded="${open}"><i data-lucide="more-horizontal"></i></button>
      ${open ? `<div class="event-menu" data-event-menu role="menu" aria-label="备忘事件操作">
        <button class="event-menu-item" role="menuitem" data-action="edit-event-instance" data-key="${key}"><i data-lucide="pencil"></i>编辑</button>
        <button class="event-menu-item danger" role="menuitem" data-action="delete-event-instance" data-key="${key}"><i data-lucide="trash-2"></i>删除</button>
      </div>` : ''}
    </div>
  </div>`;
}

function recurringRowHtml(event, today) {
  const next = EventModel.nextOccurrence(event, today);
  const label = EventModel.repeatLabel(event);
  const time = event.time ? ` · ${event.time}` : '';
  const open = eventMenuKey === event.id;
  return `<div class="recurring-row ${event.enabled ? '' : 'paused'}" data-id="${event.id}">
    <div class="recurring-main">
      <span class="recurring-title">${escapeHtml(event.title)}</span>
      <span class="recurring-meta">${escapeHtml(label)}${escapeHtml(time)}</span>
      ${(event.note || '').trim() ? `<span class="recurring-note">${escapeHtml(event.note)}</span>` : ''}
      <span class="recurring-next">下次：${next ? escapeHtml(dateLabel(next)) : '已结束'}</span>
    </div>
    <button class="recurring-toggle" data-action="toggle-recurring" data-id="${event.id}" aria-pressed="${event.enabled}">${event.enabled ? '暂停' : '启用'}</button>
    <div class="event-more-wrap">
      <button class="event-more" data-action="open-event-menu" data-key="${event.id}" aria-label="「${escapeHtml(event.title)}」的更多操作" aria-expanded="${open}"><i data-lucide="more-horizontal"></i></button>
      ${open ? `<div class="event-menu" data-event-menu role="menu" aria-label="固定安排操作">
        <button class="event-menu-item" role="menuitem" data-action="edit-recurring" data-id="${event.id}"><i data-lucide="pencil"></i>编辑</button>
        <button class="event-menu-item danger" role="menuitem" data-action="delete-recurring" data-id="${event.id}"><i data-lucide="trash-2"></i>删除固定安排</button>
      </div>` : ''}
    </div>
  </div>`;
}

function renderPrinciples() {
  const tabLabels = { checkin: '每日打卡', manage: '原则管理', stats: '统计回顾' };
  let body = '';
  if (currentPrincipleTab === 'checkin') body = renderCheckinTab();
  if (currentPrincipleTab === 'manage') body = renderManageTab();
  if (currentPrincipleTab === 'stats') body = renderStatsTab();
  const pageHeading = currentPrincipleTab === 'stats'
    ? '<h2>近 60 天统计与回顾</h2><p>点击热力图中的日期，查看当天完成情况和原因。</p>'
    : `<h2>${tabLabels[currentPrincipleTab]}</h2><p>${dateLabel(selectedDate)}</p>`;
  $('#app').innerHTML = `<section class="page content-page">
    <div class="page-head"><div>${pageHeading}</div>
      ${currentPrincipleTab === 'manage' ? '<button class="button primary small" data-action="add-section"><i data-lucide="plus"></i>新建原则</button>' : ''}
    </div>
    <nav class="segmented" aria-label="原则页面">
      ${Object.entries(tabLabels).map(([key, label]) => `<button class="segment ${currentPrincipleTab === key ? 'active' : ''}" data-action="principle-tab" data-tab="${key}">${label}</button>`).join('')}
    </nav>
    ${body}
  </section>`;
  bindManageInputs();
}

function renderCheckinTab() {
  if (!state.sections.length) {
    return emptyState('list-checks', '还没有原则', '建立原则和条目后，就可以从这里按组完成每日打卡。', '<button class="button primary" data-action="principle-tab" data-tab="manage">去建立原则</button>');
  }
  return `<div class="group-list">${state.sections.map((section) => {
    const active = activeItemsOn(selectedDate).filter((entry) => entry.section.id === section.id);
    const done = active.filter(({ item }) => recordFor()[item.id]).length;
    return `<section class="group-block">
      <div class="group-head"><h3>${escapeHtml(section.name)}</h3><span class="group-meta">${done} / ${active.length} 已完成</span></div>
      ${(section.items || []).map((item) => renderCheckinItem(item)).join('') || '<div class="group-meta" style="padding:18px 20px">这个原则还没有具体条目。</div>'}
    </section>`;
  }).join('')}</div>`;
}

function renderCheckinLeaf(item, label = item.name, child = false) {
  if (item.activeSince && item.activeSince > selectedDate) return '';
  const done = Boolean(recordFor()[item.id]);
  const reason = reasonFor(item.id);
  return `<div class="checkin-leaf ${child ? 'child' : ''}">
    <button class="check-row ${done ? 'checked' : ''}" data-action="toggle-checkin" data-id="${item.id}" aria-pressed="${done}">
      <span class="check-box">${done ? '<i data-lucide="check"></i>' : ''}</span><span>${escapeHtml(label)}</span>
    </button>
    ${!done || reason ? `<div class="checkin-reason">
      <button class="text-button small-text-button" data-action="edit-checkin-reason" data-id="${item.id}">${reason ? '修改未完成原因' : '填写未完成原因'}</button>
      ${reason ? `<p>${escapeHtml(reason)}</p>` : ''}
    </div>` : ''}
  </div>`;
}

function renderCheckinItem(item) {
  if (item.activeSince && item.activeSince > selectedDate) return '';
  const children = activeChildren(item, selectedDate);
  if (!children.length) return renderCheckinLeaf(item);
  const done = children.filter((child) => recordFor()[child.id]).length;
  return `<div class="checkin-parent">
    <div class="checkin-parent-head"><span>${escapeHtml(item.name)}</span><span class="group-meta">${done} / ${children.length} 已完成</span></div>
    ${children.map((child) => renderCheckinLeaf(child, child.name, true)).join('')}
  </div>`;
}

function renderManageTab() {
  const sections = state.sections.length ? state.sections.map((section, sectionIndex) => `
    <section class="manage-section">
      <div class="manage-section-head">
        <h3>${escapeHtml(section.name)}</h3>
        <div class="row-actions">
          <button class="mini-button" data-action="move-section" data-id="${section.id}" data-dir="up" aria-label="上移" ${sectionIndex === 0 ? 'disabled' : ''}><i data-lucide="arrow-up"></i></button>
          <button class="mini-button" data-action="move-section" data-id="${section.id}" data-dir="down" aria-label="下移" ${sectionIndex === state.sections.length - 1 ? 'disabled' : ''}><i data-lucide="arrow-down"></i></button>
          <button class="mini-button" data-action="rename-section" data-id="${section.id}" aria-label="重命名"><i data-lucide="pencil"></i></button>
          <button class="mini-button danger" data-action="delete-section" data-id="${section.id}" aria-label="删除"><i data-lucide="trash-2"></i></button>
        </div>
      </div>
      ${(section.items || []).map((item, itemIndex) => renderManageItem(section, item, itemIndex)).join('')}
      <div class="inline-add"><input id="addItem-${section.id}" placeholder="添加一个每天要做到的具体条目" data-add-item-input="${section.id}" /><button class="button ghost small" data-action="add-item" data-section="${section.id}"><i data-lucide="plus"></i>添加</button></div>
    </section>`).join('') : emptyState('sprout', '从一条真正相信的原则开始', '原则下面可以添加每天要做到的具体条目。', '<button class="button primary" data-action="add-section"><i data-lucide="plus"></i>新建原则</button>');
  const backupRows = state.backups.length
    ? state.backups.map((backup) => `<li><div><strong>${new Date(backup.createdAt).toLocaleString('zh-CN', { hour12: false })}</strong><small>${backup.imageCount ? `包含 ${backup.imageCount} 张复盘图片` : '不含复盘图片'}${backup.label === 'before-restore' ? ' · 恢复前自动保存' : ''}</small></div><button class="button ghost small" data-action="restore-backup" data-id="${backup.id}"><i data-lucide="history"></i>恢复</button></li>`).join('')
    : '<p class="status-text">还没有备份。</p>';
  return `<div class="manage-grid">${sections}
    <section class="manage-section data-management">
      <div class="manage-section-head"><div><h3>数据备份</h3><p>备份会保存在这台电脑，包含所有记录和复盘图片。</p></div><button class="button ghost small" data-action="create-backup"><i data-lucide="archive"></i>立即备份</button></div>
      <ul class="backup-list">${backupRows}</ul>
    </section>
  </div>`;
}

function renderManageItem(section, item, itemIndex) {
  const children = item.children || [];
  return `<div class="manage-item-wrap">
    <div class="manage-item">
      <span>${escapeHtml(item.name)}</span>
      <div class="row-actions">
        <button class="button ghost small add-child-button" data-action="add-child" data-section="${section.id}" data-id="${item.id}"><i data-lucide="plus"></i>添加子节点</button>
        <button class="mini-button" data-action="move-item" data-section="${section.id}" data-id="${item.id}" data-dir="up" aria-label="上移" ${itemIndex === 0 ? 'disabled' : ''}><i data-lucide="arrow-up"></i></button>
        <button class="mini-button" data-action="move-item" data-section="${section.id}" data-id="${item.id}" data-dir="down" aria-label="下移" ${itemIndex === section.items.length - 1 ? 'disabled' : ''}><i data-lucide="arrow-down"></i></button>
        <button class="mini-button" data-action="rename-item" data-section="${section.id}" data-id="${item.id}" aria-label="重命名"><i data-lucide="pencil"></i></button>
        <button class="mini-button danger" data-action="delete-item" data-section="${section.id}" data-id="${item.id}" aria-label="删除"><i data-lucide="trash-2"></i></button>
      </div>
    </div>
    ${children.map((child, childIndex) => `<div class="manage-item manage-child-item">
      <span>${escapeHtml(child.name)}</span>
      <div class="row-actions">
        <button class="mini-button" data-action="move-child" data-section="${section.id}" data-item="${item.id}" data-id="${child.id}" data-dir="up" aria-label="上移子节点" ${childIndex === 0 ? 'disabled' : ''}><i data-lucide="arrow-up"></i></button>
        <button class="mini-button" data-action="move-child" data-section="${section.id}" data-item="${item.id}" data-id="${child.id}" data-dir="down" aria-label="下移子节点" ${childIndex === children.length - 1 ? 'disabled' : ''}><i data-lucide="arrow-down"></i></button>
        <button class="mini-button" data-action="rename-child" data-section="${section.id}" data-item="${item.id}" data-id="${child.id}" aria-label="重命名子节点"><i data-lucide="pencil"></i></button>
        <button class="mini-button danger" data-action="delete-child" data-section="${section.id}" data-item="${item.id}" data-id="${child.id}" aria-label="删除子节点"><i data-lucide="trash-2"></i></button>
      </div>
    </div>`).join('')}
  </div>`;
}

function computeStats() {
  const days = [];
  for (let offset = 59; offset >= 0; offset -= 1) {
    const date = addDays(localToday(), -offset);
    days.push(dailyReview(date));
  }
  const last30 = days.slice(-30);
  const measurableDays = last30.filter((day) => day.ratio !== null);
  const average = measurableDays.length ? measurableDays.reduce((sum, day) => sum + day.ratio, 0) / measurableDays.length : 0;
  let streak = 0;
  const earliestActive = allNodeContexts().map(({ item }) => item.activeSince).filter(Boolean).sort()[0];
  for (let date = localToday(); earliestActive && date >= earliestActive; date = addDays(date, -1)) {
    const day = dailyReview(date);
    if (day.items.length && day.done === day.items.length) streak += 1;
    else break;
  }
  const rateNodes = new Map();
  for (const day of last30) {
    for (const entry of day.items) rateNodes.set(entry.item.id, entry);
  }
  const rates = [...rateNodes.values()].map(({ section, item, parent }) => {
    const activeDays = last30.filter((day) => day.items.some(({ item: activeItem }) => activeItem.id === item.id));
    const done = activeDays.filter((day) => checkinStatus(item.id, day.date) === 'done').length;
    return { name: item.name, parent: parent?.name || '', section: section.name, rate: activeDays.length ? done / activeDays.length : 0 };
  });
  return { days, average, streak, rates };
}

function renderStatsTab() {
  const stats = computeStats();
  if (!allItems().length) return emptyState('chart-no-axes-column', '还没有可统计的条目', '添加原则条目并开始打卡后，这里会形成真实的趋势。');
  const fullDays = stats.days.slice(-30).filter((day) => day.items.length && day.done === day.items.length).length;
  return `<div class="stats-review-page">
    <div class="stats-grid">
      <div class="stat-tile"><strong>${stats.streak}</strong><span>连续全勤天数</span></div>
      <div class="stat-tile"><strong>${Math.round(stats.average * 100)}%</strong><span>近 30 天平均完成率</span></div>
      <div class="stat-tile"><strong>${fullDays}</strong><span>近 30 天全勤天数</span></div>
    </div>
    ${renderHeatCalendar(stats.days)}
    ${renderDailyReview()}
    ${renderReasonTimeline()}
    <section class="rates-card"><h3>各条目近 30 天完成率</h3>${stats.rates.map((rate) => `<div class="rate-row"><span>${escapeHtml(rate.section)} · ${rate.parent ? `${escapeHtml(rate.parent)} → ` : ''}${escapeHtml(rate.name)}</span><div class="rate-track"><span style="width:${Math.round(rate.rate * 100)}%"></span></div><strong>${Math.round(rate.rate * 100)}%</strong></div>`).join('')}</section>
  </div>`;
}

function renderHeatCalendar(days) {
  const byDate = new Map(days.map((day) => [day.date, day]));
  const first = days[0].date;
  const mondayOffset = (parseDate(first).getDay() + 6) % 7;
  const calendarStart = addDays(first, -mondayOffset);
  const weeks = [];
  for (let weekStart = calendarStart; weekStart <= localToday(); weekStart = addDays(weekStart, 7)) {
    const dates = Array.from({ length: 7 }, (_, index) => addDays(weekStart, index));
    const firstOfMonth = dates.find((date) => byDate.has(date) && date.endsWith('-01'));
    const firstVisible = dates.find((date) => byDate.has(date));
    const monthDate = firstOfMonth || (!weeks.length ? firstVisible : null);
    const monthLabel = monthDate ? `${parseDate(monthDate).getMonth() + 1}月` : '';
    weeks.push(`<div class="heat-week"><span class="heat-month">${monthLabel}</span>${dates.map((date) => {
      const day = byDate.get(date);
      if (!day) return '<span class="heat-day-placeholder" aria-hidden="true"></span>';
      const level = !day.items.length || day.ratio === 0 ? 0 : Math.min(4, Math.ceil(day.ratio * 4));
      const detail = day.items.length ? `完成 ${day.done}/${day.items.length}，${Math.round(day.ratio * 100)}%` : '尚无有效条目';
      return `<button class="heat-day ${date === selectedReviewDate ? 'selected' : ''} ${date === localToday() ? 'today' : ''}" data-level="${level}" data-action="stats-select-date" data-date="${date}" title="${date} · ${detail}" aria-label="${dateLabel(date)}，${detail}" aria-pressed="${date === selectedReviewDate}">${parseDate(date).getDate()}</button>`;
    }).join('')}</div>`);
  }
  return `<section class="heat-card">
    <div class="card-heading"><div><h3>近 60 天完成热力图</h3><p>点击日期查看当天明细</p></div><div class="heat-legend"><span>低</span>${[0, 1, 2, 3, 4].map((level) => `<i data-level="${level}"></i>`).join('')}<span>高</span></div></div>
    <div class="heat-calendar-scroll"><div class="heat-calendar"><div class="heat-weekdays"><span></span>${['一', '二', '三', '四', '五', '六', '日'].map((day) => `<span>${day}</span>`).join('')}</div><div class="heat-weeks">${weeks.join('')}</div></div></div>
  </section>`;
}

function reviewStatusLabel(status) {
  return ({ done: '已完成', incomplete: '未完成', missed: '未打卡' })[status];
}

function renderReviewGroups(entries, date) {
  const groups = new Map();
  for (const entry of entries) {
    if (!groups.has(entry.section.id)) groups.set(entry.section.id, { section: entry.section, entries: [] });
    groups.get(entry.section.id).entries.push(entry);
  }
  return [...groups.values()].map(({ section, entries: sectionEntries }) => `<section class="daily-review-group">
    <h4>${escapeHtml(section.name)}</h4>
    ${sectionEntries.map(({ item, parent, status, reason }) => `<div class="daily-review-row ${status} ${reviewHighlightItemId === item.id ? 'highlighted' : ''}" id="review-node-${item.id}">
      <div class="daily-review-main">
        <div class="daily-review-title">${parent ? `<small>${escapeHtml(parent.name)}</small><span>${escapeHtml(item.name)}</span>` : `<span>${escapeHtml(item.name)}</span>`}</div>
        <span class="review-status ${status}">${reviewStatusLabel(status)}</span>
      </div>
      ${reason ? `<p class="daily-review-reason">${escapeHtml(reason)}</p>` : ''}
      ${status !== 'done' || reason ? `<button class="text-button small-text-button" data-action="stats-edit-reason" data-id="${item.id}" data-date="${date}">${reason ? '修改原因' : '补写原因'}</button>` : ''}
    </div>`).join('')}
  </section>`).join('');
}

function renderDailyReview() {
  const day = dailyReview(selectedReviewDate);
  const percentage = day.ratio === null ? '—' : `${Math.round(day.ratio * 100)}%`;
  const filters = { all: '全部', incomplete: '只看未完成', missed: '只看未打卡', reason: '有原因' };
  let content = '';
  if (!day.items.length) {
    content = '<div class="review-empty"><strong>当天还没有启用的打卡条目</strong><span>这一天不会生成完成率评价。</span></div>';
  } else if (dailyReviewFilter === 'all') {
    const unfinished = day.items.filter((entry) => entry.status !== 'done');
    const completed = day.items.filter((entry) => entry.status === 'done');
    content = `${unfinished.length ? renderReviewGroups(unfinished, selectedReviewDate) : '<div class="review-empty compact"><strong>当天全部完成</strong><span>做得很稳，已完成项目收在下方。</span></div>'}
      ${completed.length ? `<div class="completed-review"><button class="completed-review-toggle" data-action="stats-toggle-completed" aria-expanded="${reviewCompletedExpanded}">已完成 ${completed.length} 项 <span>${reviewCompletedExpanded ? '收起' : '展开'}</span></button>${reviewCompletedExpanded ? renderReviewGroups(completed, selectedReviewDate) : ''}</div>` : ''}`;
  } else {
    const filtered = day.items.filter((entry) => dailyReviewFilter === 'reason' ? Boolean(entry.reason) : entry.status === dailyReviewFilter);
    content = filtered.length ? renderReviewGroups(filtered, selectedReviewDate) : '<div class="review-empty compact"><strong>没有符合条件的条目</strong><span>可以切换筛选条件查看其他记录。</span></div>';
  }
  return `<section class="daily-review-card" id="dailyReviewCard">
    <div class="daily-review-head">
      <div><p class="section-eyebrow">当天回顾</p><h3>${dateLabel(selectedReviewDate)}</h3><span>${day.items.length ? `完成 ${day.done}/${day.items.length} · ${percentage}` : '尚无有效条目'}</span></div>
      <div class="review-date-controls">
        <button class="mini-button" data-action="stats-prev-date" aria-label="回顾前一天"><i data-lucide="chevron-left"></i></button>
        <input id="reviewDate" type="date" value="${selectedReviewDate}" max="${localToday()}" aria-label="选择回顾日期" />
        <button class="mini-button" data-action="stats-next-date" aria-label="回顾后一天" ${selectedReviewDate >= localToday() ? 'disabled' : ''}><i data-lucide="chevron-right"></i></button>
        <button class="button ghost small" data-action="stats-yesterday">昨天</button>
        <button class="button ghost small" data-action="stats-today">今天</button>
      </div>
    </div>
    <div class="review-filters">${Object.entries(filters).map(([key, label]) => `<button class="history-filter-chip ${dailyReviewFilter === key ? 'active' : ''}" data-action="stats-filter" data-filter="${key}">${label}</button>`).join('')}</div>
    <div class="daily-review-content">${content}</div>
  </section>`;
}

function reasonTimelineEntries() {
  const contexts = new Map(allNodeContexts().map((entry) => [entry.item.id, entry]));
  const earliest = reasonTimelineRange === 'all' ? null : addDays(localToday(), -(Number(reasonTimelineRange) - 1));
  const query = reasonTimelineQuery.trim().toLocaleLowerCase('zh-CN');
  const entries = [];
  for (const [date, reasons] of Object.entries(state.checkinReasons)) {
    if (date > localToday() || (earliest && date < earliest)) continue;
    for (const [itemId, reason] of Object.entries(reasons || {})) {
      const context = contexts.get(itemId);
      if (!context || !String(reason).trim()) continue;
      const haystack = [context.section.name, context.parent?.name, context.item.name, reason].filter(Boolean).join(' ').toLocaleLowerCase('zh-CN');
      if (query && !haystack.includes(query)) continue;
      entries.push({ ...context, date, reason: String(reason), status: checkinStatus(itemId, date) });
    }
  }
  return entries.sort((a, b) => b.date.localeCompare(a.date) || a.section.name.localeCompare(b.section.name, 'zh-CN'));
}

function renderReasonTimelineList() {
  const entries = reasonTimelineEntries();
  if (!entries.length) return '<div class="review-empty"><strong>这个范围内还没有未完成原因</strong><span>可以从热力图选择日期，查看未完成和未打卡条目。</span></div>';
  return entries.map(({ date, section, parent, item, reason, status }) => `<article class="reason-timeline-item">
    <button class="reason-timeline-jump" data-action="stats-select-date" data-date="${date}" data-highlight="${item.id}">
      <time>${dateLabel(date)}</time><span>${escapeHtml(section.name)} · ${parent ? `${escapeHtml(parent.name)} → ` : ''}${escapeHtml(item.name)}</span><em class="review-status ${status}">${reviewStatusLabel(status)}</em>
    </button>
    <p>${escapeHtml(reason)}</p>
    <button class="text-button small-text-button" data-action="stats-edit-reason" data-id="${item.id}" data-date="${date}">修改或清空</button>
  </article>`).join('');
}

function renderReasonTimeline() {
  const ranges = { 7: '近 7 天', 30: '近 30 天', 60: '近 60 天', all: '全部' };
  return `<section class="reason-timeline-card">
    <div class="card-heading"><div><p class="section-eyebrow">原因时间线</p><h3>回看没有完成的原因</h3></div></div>
    <div class="reason-timeline-tools"><div class="review-filters">${Object.entries(ranges).map(([key, label]) => `<button class="history-filter-chip ${reasonTimelineRange === key ? 'active' : ''}" data-action="stats-reason-range" data-range="${key}">${label}</button>`).join('')}</div><label class="reason-search"><i data-lucide="search"></i><input id="reasonTimelineSearch" value="${escapeHtml(reasonTimelineQuery)}" placeholder="搜索原则、条目或原因" /></label></div>
    <div class="reason-timeline-list" id="reasonTimelineList">${renderReasonTimelineList()}</div>
  </section>`;
}

function renderThoughts() {
  if (thoughtSurface === 'history') {
    $('#app').innerHTML = renderThoughtHistory();
    bindHistoryControls();
    return;
  }
  const workspace = isArticleMode() ? renderFreeThoughtEditor() : renderReflectionEditor();
  $('#app').innerHTML = `<section class="page content-page thoughts-page">
    <div class="page-head"><div><h2>${dateLabel(selectedDate)}</h2></div></div>
    ${renderThoughtToolbar()}
    <div class="thought-workspace" id="thoughtPanel" role="tabpanel" aria-labelledby="${thoughtMode === 'free' ? 'thoughtTabFree' : thoughtMode === 'review' ? 'thoughtTabReview' : 'thoughtTabReflection'}">
      ${workspace}
    </div>
  </section>`;
  if (isArticleMode()) {
    bindFreeThoughtEditor();
  } else {
    $$('.reflect-editor').forEach((editor) => editor.addEventListener('input', (event) => {
      scheduleReflectSave();
      syncClearAnswerButtons();
    }));
  }
}

function syncClearAnswerButtons() {
  $$('.reflection-card').forEach((card) => {
    const editor = card.querySelector('.reflect-editor');
    if (!editor) return;
    const frameworkId = editor.dataset.framework;
    const existing = card.querySelector('[data-action="clear-reflect-answer"]');
    if (editor.value.trim()) {
      if (!existing) {
        const wrap = document.createElement('div');
        wrap.innerHTML = `<div class="reflect-answer-actions"><button class="text-button danger" data-action="clear-reflect-answer" data-framework="${frameworkId}" aria-label="清空今天的回答"><i data-lucide="trash-2"></i>清空回答</button></div>`;
        card.appendChild(wrap.firstElementChild);
        renderIcons();
      }
    } else if (existing) {
      existing.closest('.reflect-answer-actions').remove();
    }
  });
}

function isArticleMode(kind = thoughtMode) {
  return kind === 'free' || kind === 'review';
}

function thoughtKind(thought) {
  return thought?.kind === 'review' ? 'review' : 'free';
}

function thoughtKindLabel(kind) {
  return kind === 'review' ? '每日复盘' : kind === 'reflection' ? '每日反思' : '自由思考';
}

function thoughtNoun(thought) {
  return thoughtKind(thought) === 'review' ? '复盘' : '思考';
}

function effectiveThoughtTitle(thought) {
  const explicit = String(thought?.title || '').trim();
  if (explicit) return explicit;
  const first = String(thought?.text || '').split(/\r?\n/).map((line) => line.trim()).find(Boolean) || '';
  if (!first) return `未命名${thoughtNoun(thought)}`;
  return first.length > 60 ? `${first.slice(0, 59)}…` : first;
}

function thoughtCategoryName(categoryId) {
  if (!categoryId) return '未分类';
  return state.thoughtCategories.find((category) => category.id === categoryId)?.name || '未分类';
}

function thoughtEntriesForDate(date = selectedDate, kind = thoughtMode) {
  return state.thoughtEntries
    .filter((entry) => entry.date === date && thoughtKind(entry) === kind)
    .sort((a, b) => String(b.updatedAt || b.createdAt || '').localeCompare(String(a.updatedAt || a.createdAt || '')));
}

function normalizeLoadedThoughts(result) {
  if (Array.isArray(result.thoughtEntries)) return result.thoughtEntries.map((entry) => ({ ...entry, kind: thoughtKind(entry) }));
  const legacy = result.thinkEntries && typeof result.thinkEntries === 'object' ? result.thinkEntries : {};
  return Object.entries(legacy)
    .filter(([, text]) => String(text || '').trim())
    .map(([date, text]) => ({
      id: `legacy-${date}`,
      kind: 'free',
      date,
      title: effectiveThoughtTitle({ text }),
      text: String(text),
      categoryId: null,
      createdAt: `${date}T00:00:00.000Z`,
      updatedAt: `${date}T00:00:00.000Z`,
      legacyDate: date,
      legacyCompat: true,
    }));
}

function currentThought() {
  if (selectedThoughtId === 'draft') return thoughtDraft;
  return state.thoughtEntries.find((entry) => entry.id === selectedThoughtId) || null;
}

function renderThoughtToolbar() {
  return `<div class="thought-toolbar" role="tablist" aria-label="选择写作模式">
    <button class="thought-tab ${thoughtMode === 'free' ? 'active' : ''}" role="tab" id="thoughtTabFree" aria-selected="${thoughtMode === 'free'}" aria-controls="thoughtPanel" data-action="switch-thought-mode" data-mode="free">自由思考</button>
    <button class="thought-tab ${thoughtMode === 'review' ? 'active' : ''}" role="tab" id="thoughtTabReview" aria-selected="${thoughtMode === 'review'}" aria-controls="thoughtPanel" data-action="switch-thought-mode" data-mode="review">每日复盘</button>
    <button class="thought-tab ${thoughtMode === 'reflection' ? 'active' : ''}" role="tab" id="thoughtTabReflection" aria-selected="${thoughtMode === 'reflection'}" aria-controls="thoughtPanel" data-action="switch-thought-mode" data-mode="reflection">每日反思</button>
  </div>`;
}

function renderFreeThoughtEditor() {
  const items = thoughtEntriesForDate();
  if (selectedThoughtId === 'draft' && (thoughtDraft?.date !== selectedDate || thoughtKind(thoughtDraft) !== thoughtMode)) selectedThoughtId = null;
  if (selectedThoughtId !== 'draft' && !items.some((entry) => entry.id === selectedThoughtId)) selectedThoughtId = null;
  if (!selectedThoughtId && items.length) selectedThoughtId = items[0].id;
  const thought = currentThought();
  const label = thoughtKindLabel(thoughtMode);
  return `<section class="free-thought-workspace" aria-label="${label}编辑区">
    ${thought ? renderThoughtEditorCard(thought) : emptyState('notebook-pen', `这一天还没有${label}`, '可以新建一篇，或返回记录列表查看其他文章。', `<button class="button primary small" data-action="${thoughtMode === 'review' ? 'new-review' : 'new-thought'}"><i data-lucide="plus"></i>新建${thoughtMode === 'review' ? '复盘' : '思考'}</button>`)}
  </section>`;
}

function renderThoughtEditorCard(thought) {
  const label = thoughtKindLabel(thoughtKind(thought));
  const options = state.thoughtCategories.map((category) => `<option value="${category.id}" ${thought.categoryId === category.id ? 'selected' : ''}>${escapeHtml(category.name)}</option>`).join('');
  return `<div class="free-editor-card" data-thought-id="${escapeHtml(thought.id)}">
    <div class="thought-editor-head">
      <input class="thought-title-input" id="thoughtTitle" value="${escapeHtml(thought.title || '')}" placeholder="输入标题；留空时自动使用正文首行" aria-label="${label}标题" maxlength="160" />
      ${thought.id !== 'draft' ? `<button class="text-button danger" data-action="delete-thought"><i data-lucide="trash-2"></i>删除这篇${thoughtNoun(thought)}</button>` : ''}
    </div>
    <div class="thought-meta-row">
      <label for="thoughtCategory">类别</label>
      <select class="input thought-category-select" id="thoughtCategory" aria-label="${label}类别">
        <option value="" ${!thought.categoryId ? 'selected' : ''}>未分类</option>
        ${options}
        <option value="__new__">＋ 新建类别…</option>
      </select>
      <button class="button ghost small" data-action="manage-thought-categories"><i data-lucide="settings-2"></i>管理类别</button>
    </div>
    ${thoughtKind(thought) === 'review' && state.version >= 8 ? renderReviewEditor(thought) : `<textarea class="textarea free-thought" id="thoughtEditor" placeholder="${thoughtKind(thought) === 'review' ? '回顾今天：发生了什么、有哪些收获、明天想怎样改进……' : '此刻在想什么？写下今天的想法、灵感或目标……'}" aria-label="${label}内容">${escapeHtml(thought.text || '')}</textarea>`}
    <div class="save-line">
      <span id="thoughtStatus" role="status" aria-live="polite" data-action="retry-think-save">${thought.id === 'draft' ? '开始输入后自动保存' : '仅保存在本地'}</span>
      <span id="thoughtCount">${String(thought.text || '').replace(/\s/g, '').length} 字${thoughtKind(thought) === 'review' ? ` · ${reviewImages(thought).length} 张图片` : ''}</span>
    </div>
  </div>`;
}

function bindFreeThoughtEditor() {
  const title = $('#thoughtTitle');
  const editor = $('#thoughtEditor');
  const category = $('#thoughtCategory');
  const update = () => {
    const thought = currentThought();
    if (!thought) return;
    thought.title = title?.value || '';
    if (!$('#reviewBody')) thought.text = editor?.value || '';
    if ($('#reviewBody')) syncReviewText(thought);
    else if ($('#thoughtCount')) $('#thoughtCount').textContent = `${thought.text.replace(/\s/g, '').length} 字`;
    scheduleThinkSave();
  };
  title?.addEventListener('input', update);
  if ($('#reviewBody')) bindReviewEditor();
  else editor?.addEventListener('input', update);
  category?.addEventListener('change', () => {
    if (category.value === '__new__') {
      category.value = currentThought()?.categoryId || '';
      openAddThoughtCategoryModal();
      return;
    }
    const thought = currentThought();
    if (!thought) return;
    thought.categoryId = category.value || null;
    scheduleThinkSave();
  });
}

function renderReflectionEditor() {
  const entries = state.reflectEntries[selectedDate] || {};
  const cards = state.reflectFrameworks.length
    ? `<div class="reflection-list">${state.reflectFrameworks.map((framework, index) => {
      const answer = entries[framework.id] || '';
      return `<article class="reflection-card">
        <div class="reflection-card-head">
          <label for="reflect-${framework.id}">${index + 1}. ${escapeHtml(framework.name)}</label>
          <div class="row-actions">
            <button class="mini-button" data-action="rename-framework" data-id="${framework.id}" aria-label="重命名问题「${escapeHtml(framework.name)}」"><i data-lucide="pencil"></i></button>
            <button class="mini-button danger" data-action="delete-framework" data-id="${framework.id}" aria-label="删除问题「${escapeHtml(framework.name)}」"><i data-lucide="trash-2"></i></button>
          </div>
        </div>
        <textarea class="textarea reflect-editor" id="reflect-${framework.id}" data-framework="${framework.id}" placeholder="写下你的回答……" aria-label="回答：${escapeHtml(framework.name)}">${escapeHtml(answer)}</textarea>
        ${answer.trim() ? `<div class="reflect-answer-actions"><button class="text-button danger" data-action="clear-reflect-answer" data-framework="${framework.id}" aria-label="清空「${escapeHtml(framework.name)}」今天的回答"><i data-lucide="trash-2"></i>清空回答</button></div>` : ''}
      </article>`;
    }).join('')}</div>`
    : emptyState('message-circle', '还没有反思问题', '添加几个固定问题，帮助自己每天稳定复盘。', '<button class="button primary" data-action="add-framework"><i data-lucide="plus"></i>添加第一个问题</button>');
  return `<section class="reflection-workspace">
    <div class="mode-head">
      <div><h3>每日反思</h3><p>按问题复盘今天，答案会自动保存。</p></div>
      <div class="mode-head-actions">
        <span id="reflectStatus" class="status-text" role="status" aria-live="polite" data-action="retry-reflect-save">自动保存</span>
        <button class="button ghost small" data-action="add-framework"><i data-lucide="plus"></i>添加反思问题</button>
      </div>
    </div>
    ${cards}
  </section>`;
}

// ---------- 所思：历史记录 ----------

function buildThoughtHistory() {
  const thoughts = state.thoughtEntries
    .filter(hasThoughtContent)
    .map((entry) => ({
      key: `thought:${entry.id}`, kind: thoughtKind(entry), date: entry.date, thought: entry,
      title: effectiveThoughtTitle(entry), categoryId: entry.categoryId || null,
      preview: getThoughtPreview(entry.text) || (reviewImages(entry).length ? `${reviewImages(entry).length} 张图片` : ''), sortStamp: entry.updatedAt || entry.createdAt || entry.date,
    }));
  const reflections = Object.entries(state.reflectEntries || {})
    .filter(([, entries]) => Object.values(entries || {}).some((text) => String(text || '').trim()))
    .map(([date, reflect]) => ({
      key: `reflection:${date}`, kind: 'reflection', date, reflect,
      title: '每日反思', categoryId: null, preview: getReflectionPreview(reflect), sortStamp: date,
    }));
  return [...thoughts, ...reflections].sort((a, b) => {
    if (a.date !== b.date) return a.date < b.date ? 1 : -1;
    if (isArticleMode(a.kind) !== isArticleMode(b.kind)) return isArticleMode(a.kind) ? -1 : 1;
    return String(b.sortStamp).localeCompare(String(a.sortStamp));
  });
}

function getThoughtPreview(text) {
  const clean = String(text || '').replace(/\s+/g, ' ').trim();
  return clean.length > 84 ? `${clean.slice(0, 83)}…` : clean;
}

function getReflectionPreview(entries) {
  const joined = Object.values(entries || {})
    .map((text) => String(text || '').trim())
    .filter(Boolean)
    .join(' ');
  const clean = joined.replace(/\s+/g, ' ').trim();
  return clean.length > 84 ? `${clean.slice(0, 83)}…` : clean;
}

function applyHistoryFilter(records) {
  const query = thoughtHistoryQuery.trim().toLowerCase();
  return records.filter((record) => {
    if (thoughtHistoryFilter !== 'all' && record.kind !== thoughtHistoryFilter) return false;
    if (thoughtHistoryCategory !== 'all') {
      if (!isArticleMode(record.kind)) return false;
      if (thoughtHistoryCategory === 'uncategorized' && record.categoryId) return false;
      if (thoughtHistoryCategory !== 'uncategorized' && record.categoryId !== thoughtHistoryCategory) return false;
    }
    if (query) {
      const haystack = [
        dateLabel(record.date),
        record.date,
        record.title,
        isArticleMode(record.kind) ? record.thought.text : '',
        isArticleMode(record.kind) ? thoughtCategoryName(record.categoryId) : '',
        ...reviewImages(record.thought).map((block) => block.caption),
        ...Object.values(record.reflect || {}),
        ...(record.kind === 'reflection' ? state.reflectFrameworks.map((framework) => framework.name) : []),
      ].join(' ').toLowerCase();
      if (!haystack.includes(query)) return false;
    }
    return true;
  });
}

function historyRecordItem(record, selected) {
  const kindLabel = thoughtKindLabel(record.kind);
  const images = reviewImages(record.thought);
  return `<div class="history-record ${selected ? 'active' : ''}" role="listitem" data-key="${escapeHtml(record.key)}" data-date="${record.date}">
    <button class="history-record-main ${images.length ? 'has-review-image' : ''}" data-action="select-history-record" data-key="${escapeHtml(record.key)}" aria-label="查看${dateLabel(record.date)}的${kindLabel}">
      ${images.length ? `<img class="history-review-cover" src="${reviewImageUrl(images[0].imageId)}" alt="" loading="lazy" />` : ''}
      <div class="history-record-copy">
      <div class="history-record-head">
        <strong>${escapeHtml(record.title)}</strong>
        <span class="history-tags">
          <span class="history-tag ${record.kind === 'reflection' ? 'reflect' : record.kind}">${kindLabel}</span>
          ${isArticleMode(record.kind) ? `<span class="history-tag category">${escapeHtml(thoughtCategoryName(record.categoryId))}</span>` : ''}
          ${images.length ? `<span class="history-tag image-count">${images.length} 图</span>` : ''}
        </span>
      </div>
      <span class="history-record-date">${dateLabel(record.date)}</span>
      <p class="history-preview">${escapeHtml(record.preview || '')}</p>
      </div>
    </button>
  </div>`;
}

function renderThoughtHistoryHeader() {
  return `<div class="page-head thought-history-head">
    <div><h2 id="historyPageTitle" tabindex="-1">所思记录</h2></div>
    <div class="thought-history-actions">
      <button class="button ghost small" data-action="write-daily-reflection"><i data-lucide="pen-line"></i>写每日反思</button>
      <button class="button ghost small" data-action="new-review"><i data-lucide="notebook-pen"></i>新建复盘</button>
      <button class="button primary small" data-action="new-thought"><i data-lucide="plus"></i>新建思考</button>
    </div>
  </div>`;
}

function renderThoughtHistory() {
  const records = buildThoughtHistory();
  const filtered = applyHistoryFilter(records);

  const selected = filtered.find((record) => record.key === selectedHistoryKey);
  if (selected) return renderHistoryDetail(selected);
  selectedHistoryKey = null;

  const categoryOptions = state.thoughtCategories.map((category) => `<option value="${category.id}" ${thoughtHistoryCategory === category.id ? 'selected' : ''}>${escapeHtml(category.name)}</option>`).join('');
  return `<section class="page content-page thoughts-page">
    ${renderThoughtHistoryHeader()}
    <div class="history-filter">
      <div class="history-type-filter" role="group" aria-label="按类型筛选记录">
        <button class="history-filter-chip ${thoughtHistoryFilter === 'all' ? 'active' : ''}" data-action="filter-thought-history" data-filter="all" aria-pressed="${thoughtHistoryFilter === 'all'}">全部</button>
        <button class="history-filter-chip ${thoughtHistoryFilter === 'free' ? 'active' : ''}" data-action="filter-thought-history" data-filter="free" aria-pressed="${thoughtHistoryFilter === 'free'}">自由思考</button>
        <button class="history-filter-chip ${thoughtHistoryFilter === 'review' ? 'active' : ''}" data-action="filter-thought-history" data-filter="review" aria-pressed="${thoughtHistoryFilter === 'review'}">每日复盘</button>
        <button class="history-filter-chip ${thoughtHistoryFilter === 'reflection' ? 'active' : ''}" data-action="filter-thought-history" data-filter="reflection" aria-pressed="${thoughtHistoryFilter === 'reflection'}">每日反思</button>
      </div>
      <select class="input history-category-filter" id="historyCategoryFilter" aria-label="按文章类别筛选">
        <option value="all" ${thoughtHistoryCategory === 'all' ? 'selected' : ''}>全部类别</option>
        <option value="uncategorized" ${thoughtHistoryCategory === 'uncategorized' ? 'selected' : ''}>未分类</option>
        ${categoryOptions}
      </select>
      <input class="input history-search" id="historySearch" type="search" placeholder="搜索记录……" aria-label="搜索历史记录" value="${escapeHtml(thoughtHistoryQuery)}" />
    </div>
    <div class="thought-history-layout">
      ${filtered.length ? `<div class="history-list" role="list" aria-label="所思记录列表">
        ${filtered.map((record) => historyRecordItem(record, record.key === selectedHistoryKey)).join('')}
      </div>` : records.length
        ? emptyState('search-x', '没有找到匹配的记录', '换个关键词或筛选条件试试。', '<button class="button ghost small" data-action="reset-history-filter"><i data-lucide="rotate-ccw"></i>清除筛选</button>')
        : emptyState('notebook-pen', '还没有所思记录', '从上方新建思考、每日复盘，或写下每日反思。')}
    </div>
  </section>`;
}

function renderHistoryDetail(record) {
  const label = thoughtKindLabel(record.kind);
  const reflectItems = record.kind === 'reflection' ? state.reflectFrameworks
    .map((framework, index) => ({ framework, index, text: (record.reflect && record.reflect[framework.id]) || '' }))
    .filter((entry) => entry.text.trim()) : [];
  const body = `<article class="history-detail" aria-labelledby="historyDetailTitle">
    <h3 class="history-detail-title" id="historyDetailTitle" tabindex="-1">${escapeHtml(record.title)}</h3>
    <div class="history-detail-meta"><span>${dateLabel(record.date)}</span>${isArticleMode(record.kind) ? `<span class="history-tag category">${escapeHtml(thoughtCategoryName(record.categoryId))}</span>` : ''}</div>
    ${isArticleMode(record.kind) ? `<section class="history-section">
      <div class="history-section-head">
        <h4>${label}</h4>
        <button class="button ghost small" data-action="edit-history-record" data-id="${record.thought.id}" data-date="${record.date}" data-mode="${record.kind}"><i data-lucide="pencil"></i>编辑${label}</button>
      </div>
      ${reviewImages(record.thought).length ? renderReviewDocument(record.thought) : `<div class="history-text">${record.thought.text ? escapeHtml(record.thought.text) : `<span class="history-qa-empty">这篇${thoughtNoun(record.thought)}还没有正文。</span>`}</div>`}
    </section>` : ''}
    ${record.kind === 'reflection' ? `<section class="history-section">
      <div class="history-section-head">
        <h4>每日反思</h4>
        <button class="button ghost small" data-action="edit-history-record" data-date="${record.date}" data-mode="reflection"><i data-lucide="arrow-right"></i>继续每日反思</button>
      </div>
      ${reflectItems.length ? reflectItems.map(({ framework, index, text }) => `<div class="history-qa">
        <h5>${index + 1}. ${escapeHtml(framework.name)}</h5>
        <p>${escapeHtml(text)}</p>
      </div>`).join('') : '<p class="history-qa-empty">当天没有可显示的回答内容。</p>'}
    </section>` : ''}
    <div class="history-detail-actions">
      ${isArticleMode(record.kind)
        ? `<button class="text-button danger" data-action="delete-history-thought" data-id="${record.thought.id}"><i data-lucide="trash-2"></i>删除这篇${thoughtNoun(record.thought)}</button>`
        : `<button class="text-button danger" data-action="delete-history-reflection" data-date="${record.date}"><i data-lucide="trash-2"></i>删除当天反思</button>`}
    </div>
  </article>`;
  return `<section class="page content-page thoughts-page history-reading-page">
    <nav class="history-reading-nav" aria-label="阅读导航">
      <button class="button ghost small" data-action="back-history-list"><i data-lucide="arrow-left"></i>返回记录列表</button>
    </nav>
    ${body}
  </section>`;
}

function bindHistoryControls() {
  bindReviewImageErrors();
  const search = $('#historySearch');
  if (!search) return;
  search.addEventListener('input', (event) => {
    thoughtHistoryQuery = event.target.value;
    render();
    const next = $('#historySearch');
    if (next) {
      next.focus();
      next.setSelectionRange(next.value.length, next.value.length);
    }
  });
  $('#historyCategoryFilter')?.addEventListener('change', (event) => {
    thoughtHistoryCategory = event.target.value;
    selectedHistoryKey = null;
    render();
  });
}

function openHistoryRecord(key) {
  historyListScroll = { app: $('#app').scrollTop, window: window.scrollY };
  thoughtSurface = 'history';
  selectedHistoryKey = key;
  render();
  $('#app').scrollTop = 0;
  window.scrollTo(0, 0);
  const title = $('#historyDetailTitle');
  if (title) title.focus({ preventScroll: true });
}

function editHistoryRecord(date, mode, id = null) {
  selectedDate = date;
  thoughtMode = mode;
  thoughtSurface = 'editor';
  selectedHistoryKey = null;
  selectedThoughtId = isArticleMode(mode) ? id : null;
  render();
  if (isArticleMode(mode)) {
    const editor = $('#thoughtEditor');
    if (editor) editor.focus();
  } else {
    const editor = $('.reflect-editor');
    if (editor) editor.focus();
  }
}

function renderPlans() {
  if (!selectedPlanId && state.plans.length) selectedPlanId = state.plans[0].id;
  const plan = currentPlan();
  $('#app').innerHTML = `<section class="page content-page plans-page">
    <aside class="plan-rail" aria-label="全部计划">
      <div class="plan-rail-head">
        <div class="plan-rail-title"><h2>全部计划</h2><span class="plan-count">${state.plans.length} 个</span></div>
        <button class="button primary small plan-new" data-action="add-plan"><i data-lucide="plus"></i>新建计划</button>
      </div>
      <div class="plan-list">
        ${state.plans.length ? state.plans.map((item, index) => planListItem(item, index)).join('') : '<p class="status-text plan-empty-hint">还没有计划。</p>'}
      </div>
    </aside>
    <div class="plan-workspace">
      ${plan ? renderPlanEditor(plan) : emptyState('calendar-days', '建立第一个计划', '为一个真正想推进的方向写下名称和清楚的下一步。', '<button class="button primary" data-action="add-plan"><i data-lucide="plus"></i>新建计划</button>')}
    </div>
  </section>`;
  $$('.plan-editor').forEach((editor) => editor.addEventListener('input', (event) => {
    schedulePlanSave();
    syncPlanListRow(selectedPlanId);
  }));
}

function planListItem(item, index) {
  const open = planMenuOpenId === item.id;
  const preview = (item.description || '').trim() || '尚未设置下一步';
  const active = item.id === selectedPlanId;
  return `<div class="plan-list-row ${active ? 'active' : ''}" data-id="${item.id}">
    <button class="plan-select" data-action="select-plan" data-id="${item.id}" aria-label="选择计划「${escapeHtml(item.name)}」">
      <span class="plan-name">${escapeHtml(item.name || '未命名计划')}</span>
      <span class="plan-preview">${escapeHtml(preview)}</span>
    </button>
    <div class="plan-more-wrap">
      <button class="plan-more" data-action="open-plan-menu" data-id="${item.id}" aria-label="「${escapeHtml(item.name || '未命名计划')}」的更多操作" aria-expanded="${open}" aria-haspopup="menu"><i data-lucide="more-horizontal"></i></button>
      ${open ? `<div class="plan-menu" data-plan-menu role="menu" aria-label="计划操作">
        <button class="plan-menu-item" role="menuitem" data-action="move-plan" data-id="${item.id}" data-dir="up" ${index === 0 ? 'disabled' : ''}><i data-lucide="arrow-up"></i>上移</button>
        <button class="plan-menu-item" role="menuitem" data-action="move-plan" data-id="${item.id}" data-dir="down" ${index === state.plans.length - 1 ? 'disabled' : ''}><i data-lucide="arrow-down"></i>下移</button>
        <button class="plan-menu-item danger" role="menuitem" data-action="delete-plan" data-id="${item.id}"><i data-lucide="trash-2"></i>删除计划</button>
      </div>` : ''}
    </div>
  </div>`;
}

function renderPlanEditor(plan) {
  return `<section class="plan-workspace-panel" aria-label="当前计划编辑器">
    <div class="plan-title-row">
      <input class="plan-name-input plan-editor" id="planName" value="${escapeHtml(plan.name)}" aria-label="计划名称" placeholder="计划名称" />
      <span class="plan-save" id="planStatus" role="status" aria-live="polite" data-action="retry-plan-save">已保存</span>
    </div>
    <section class="plan-field next-step-field">
      <div class="plan-field-head">
        <label for="planDescription">具体计划</label>
      </div>
      <textarea class="plan-next-step plan-editor" id="planDescription" placeholder="例如：周五前整理第一版方案，并发给对方确认。" aria-label="具体计划">${escapeHtml(plan.description)}</textarea>
    </section>
    <section class="plan-field note-field">
      <div class="plan-field-head">
        <label for="planNote">计划笔记</label>
      </div>
      <textarea class="plan-note plan-editor" id="planNote" placeholder="记录想法、进展、材料和复盘……" aria-label="计划笔记">${escapeHtml(plan.note)}</textarea>
    </section>
  </section>`;
}

function setPlanStatus(text, isError = false) {
  const el = $('#planStatus');
  if (!el) return;
  el.textContent = text;
  el.classList.toggle('save-error', isError);
}

function syncPlanListRow(planId) {
  const plan = state.plans.find((entry) => entry.id === planId);
  const row = $(`.plan-list-row[data-id="${planId}"]`);
  if (!plan || !row) return;
  const nameEl = row.querySelector('.plan-name');
  const previewEl = row.querySelector('.plan-preview');
  if (nameEl) nameEl.textContent = plan.name || '未命名计划';
  if (previewEl) previewEl.textContent = (plan.description || '').trim() || '尚未设置下一步';
}

// ---------- 问题归纳 ----------

function currentProblemTopic() {
  return state.problemTopics.find((topic) => topic.id === selectedProblemTopicId) || null;
}

function renderProblems() {
  if (!state.problemTopics.length) {
    selectedProblemTopicId = null;
    $('#app').innerHTML = `<section class="page content-page problems-page problems-empty">
      ${emptyState('folder-tree', '还没有问题主题', '先建立一个主题，把反复出现的问题放到一起。', '<button class="button primary" data-action="add-problem-topic"><i data-lucide="plus"></i>建立第一个主题</button>')}
    </section>`;
    return;
  }
  if (!state.problemTopics.some((topic) => topic.id === selectedProblemTopicId)) {
    selectedProblemTopicId = state.problemTopics[0].id;
  }
  const topic = currentProblemTopic();
  $('#app').innerHTML = `<section class="page content-page problems-page">
    <aside class="problem-rail" aria-label="问题主题列表">${renderProblemTopicRail()}</aside>
    <div class="problem-detail" id="problemDetailWrap">${renderProblemTopicDetail(topic)}</div>
  </section>`;
  bindProblemComposer();
}

function renderProblemTopicRail() {
  return `<div class="problem-rail-head">
    <div class="problem-rail-title"><h2>问题主题</h2><span class="problem-count">${state.problemTopics.length} 个</span></div>
    <button class="button primary small problem-new" data-action="add-problem-topic"><i data-lucide="plus"></i>新建主题</button>
  </div>
  <div class="problem-topic-list" role="list" aria-label="问题主题">
    ${state.problemTopics.map((topic) => problemTopicRow(topic)).join('')}
  </div>`;
}

function problemTopicRow(topic) {
  const open = problemMenuOpenId === topic.id && problemMenuAnchor === 'rail';
  const active = topic.id === selectedProblemTopicId;
  return `<div class="problem-topic-row ${active ? 'active' : ''}" data-id="${topic.id}" role="listitem">
    <button class="problem-topic-select" data-action="select-problem-topic" data-id="${topic.id}" aria-current="${active ? 'true' : 'false'}" aria-label="选择主题「${escapeHtml(topic.name)}」">
      <span class="problem-topic-name">${escapeHtml(topic.name)}</span>
      <span class="problem-topic-meta">${topic.items.length} 个问题</span>
    </button>
    <div class="problem-more-wrap">
      <button class="problem-more" data-action="open-problem-menu" data-anchor="rail" data-id="${topic.id}" aria-label="「${escapeHtml(topic.name)}」的更多操作" aria-expanded="${open}"><i data-lucide="more-horizontal"></i></button>
      ${open ? problemMenuHtml(topic) : ''}
    </div>
  </div>`;
}

function problemMenuHtml(topic) {
  return `<div class="problem-menu" data-problem-menu role="menu" aria-label="主题操作">
    <button class="problem-menu-item" role="menuitem" data-action="rename-problem-topic" data-id="${topic.id}"><i data-lucide="pencil"></i>重命名主题</button>
    <button class="problem-menu-item danger" role="menuitem" data-action="delete-problem-topic" data-id="${topic.id}"><i data-lucide="trash-2"></i>删除主题</button>
  </div>`;
}

function renderProblemTopicDetail(topic) {
  const open = problemMenuOpenId === topic.id && problemMenuAnchor === 'detail';
  return `<div class="problem-detail-head">
    <div class="problem-detail-title">
      <h2>${escapeHtml(topic.name)}</h2>
      <span class="problem-count">${topic.items.length} 个问题</span>
    </div>
    <div class="problem-more-wrap">
      <button class="problem-more" data-action="open-problem-menu" data-anchor="detail" data-id="${topic.id}" aria-label="「${escapeHtml(topic.name)}」的更多操作" aria-expanded="${open}"><i data-lucide="more-horizontal"></i></button>
      ${open ? problemMenuHtml(topic) : ''}
    </div>
  </div>
  ${renderProblemComposer()}
  ${renderProblemItems(topic)}`;
}

function renderProblemComposer() {
  return `<section class="problem-composer" aria-label="新增问题">
    <div class="plan-field-head"><label for="problemComposer">新增问题</label></div>
    <textarea class="problem-composer-input" id="problemComposer" placeholder="写下一个反复出现、值得继续追问的问题……" aria-label="新增问题"></textarea>
    <div class="problem-composer-actions">
      <button class="button primary" data-action="add-problem-item"><i data-lucide="plus"></i>添加问题</button>
    </div>
  </section>`;
}

function renderProblemItems(topic) {
  if (!topic.items.length) {
    return `<div class="problem-items-empty">${emptyState('folder-tree', '这个主题还没有问题', '把第一个值得继续思考的问题写下来。')}</div>`;
  }
  return `<div class="problem-item-list" role="list" aria-label="问题列表">
    ${topic.items.map((item, index) => {
      const snippet = item.text.length > 18 ? `${item.text.slice(0, 18)}…` : item.text;
      return `<div class="problem-item" role="listitem">
        <span class="problem-item-index">${String(index + 1).padStart(2, '0')}</span>
        <p class="problem-item-text">${escapeHtml(item.text)}</p>
        <div class="problem-item-actions">
          <button class="mini-button" data-action="edit-problem-item" data-topic="${topic.id}" data-id="${item.id}" aria-label="编辑问题「${escapeHtml(snippet)}」"><i data-lucide="pencil"></i></button>
          <button class="mini-button danger" data-action="delete-problem-item" data-topic="${topic.id}" data-id="${item.id}" aria-label="删除问题「${escapeHtml(snippet)}」"><i data-lucide="trash-2"></i></button>
        </div>
      </div>`;
    }).join('')}
  </div>`;
}

function bindProblemComposer() {
  const composer = $('#problemComposer');
  if (!composer) return;
  composer.addEventListener('keydown', (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
      event.preventDefault();
      addProblemItem(selectedProblemTopicId, composer.value);
    }
  });
}

// 增加/删除问题后局部刷新当前主题详情，不重新请求全部状态
function renderProblemDetail() {
  const topic = currentProblemTopic();
  const wrap = $('#problemDetailWrap');
  if (!topic || !wrap) return;
  wrap.innerHTML = renderProblemTopicDetail(topic);
  const row = $(`.problem-topic-row[data-id="${topic.id}"] .problem-topic-meta`);
  if (row) row.textContent = `${topic.items.length} 个问题`;
  bindProblemComposer();
}

async function addProblemItem(topicId, rawText) {
  const text = String(rawText || '').trim();
  if (!text) return;
  const topic = state.problemTopics.find((entry) => entry.id === topicId);
  if (!topic) return;
  try {
    const result = await api('POST', `/api/problem-topics/${topicId}/items`, { text });
    topic.items.push(result.item);
    renderProblemDetail();
    const composer = $('#problemComposer');
    if (composer) { composer.value = ''; composer.focus(); }
  } catch (error) { toast(error.message, true); }
}

function collectThoughtSnapshot() {
  const thought = currentThought();
  if (!thought) return null;
  return {
    id: thought.id,
    kind: thoughtKind(thought),
    date: thought.date,
    title: String(thought.title || ''),
    text: String(thought.text || ''),
    categoryId: thought.categoryId || null,
    ...(thoughtKind(thought) === 'review' && state.version >= 8 ? { blocks: reviewBlocks(thought).map((block) => ({ ...block })) } : {}),
  };
}

function setThoughtStatus(text, isError = false) {
  const status = $('#thoughtStatus');
  if (!status) return;
  status.textContent = text;
  status.classList.toggle('save-error', isError);
}

function scheduleThinkSave() {
  const snapshot = collectThoughtSnapshot();
  if (!snapshot) return;
  if (snapshot.id === 'draft' && !hasThoughtContent(snapshot)) {
    thinkRetry = null;
    clearTimeout(thinkTimer);
    thinkTimer = null;
    setThoughtStatus('开始输入后自动保存');
    return;
  }
  thinkRetry = snapshot;
  setThoughtStatus('正在保存…');
  clearTimeout(thinkTimer);
  thinkTimer = setTimeout(() => {
    thinkTimer = null;
    persistThoughtSnapshot(snapshot);
  }, 650);
}

async function persistThoughtSnapshot(rawSnapshot) {
  if (!rawSnapshot) return true;
  if (thoughtSavePromise) {
    try { await thoughtSavePromise; } catch (_) { /* 使用当前快照继续重试 */ }
  }
  const snapshot = { ...rawSnapshot };
  if (snapshot.id === 'draft' && !thoughtDraft) {
    const resolved = state.thoughtEntries.find((entry) => entry.id === selectedThoughtId && entry.date === snapshot.date && thoughtKind(entry) === snapshot.kind);
    if (resolved) snapshot.id = resolved.id;
  }
  thoughtSavePromise = (async () => {
    try {
      let saved;
      if (snapshot.id === 'draft') {
        if (!hasThoughtContent(snapshot)) return;
        const result = await api('POST', '/api/thoughts', {
          date: snapshot.date, kind: snapshot.kind, title: snapshot.title, text: snapshot.text, categoryId: snapshot.categoryId,
          ...(snapshot.blocks ? { blocks: snapshot.blocks } : {}),
        });
        saved = result.thought;
        // 请求期间可能继续输入，不能用较早的服务端快照覆盖最新本地正文。
        const latest = thoughtDraft;
        state.thoughtEntries.push(latest ? { ...saved, title: latest.title, text: latest.text, categoryId: latest.categoryId, ...(latest.blocks ? { blocks: latest.blocks } : {}) } : saved);
        if (selectedThoughtId === 'draft') selectedThoughtId = saved.id;
        thoughtDraft = null;
        const card = $('.free-editor-card');
        if (card) card.dataset.thoughtId = saved.id;
      } else {
        const localThought = state.thoughtEntries.find((entry) => entry.id === snapshot.id);
        if (localThought?.legacyCompat) {
          await api('POST', '/api/think', { date: snapshot.date, text: snapshot.text });
          saved = { ...localThought, title: snapshot.title, text: snapshot.text, categoryId: null, updatedAt: new Date().toISOString() };
        } else {
          const result = await api('PATCH', `/api/thoughts/${snapshot.id}`, {
            kind: snapshot.kind, title: snapshot.title, text: snapshot.text, categoryId: snapshot.categoryId,
            ...(snapshot.blocks ? { blocks: snapshot.blocks } : {}),
          });
          saved = result.thought;
        }
        const index = state.thoughtEntries.findIndex((entry) => entry.id === saved.id);
        if (index >= 0) {
          const latest = state.thoughtEntries[index];
          state.thoughtEntries[index] = { ...saved, title: latest.title, text: latest.text, categoryId: latest.categoryId, ...(latest.blocks ? { blocks: latest.blocks } : {}) };
        }
      }
      if (thinkRetry && thinkRetry.kind === rawSnapshot.kind && thinkRetry.date === rawSnapshot.date && thinkRetry.title === rawSnapshot.title && thinkRetry.text === rawSnapshot.text && thinkRetry.categoryId === rawSnapshot.categoryId && JSON.stringify(thinkRetry.blocks) === JSON.stringify(rawSnapshot.blocks)) {
        thinkRetry = null;
      }
      if (selectedDate === snapshot.date && (selectedThoughtId === saved?.id || selectedThoughtId === snapshot.id)) {
        setThoughtStatus(thinkRetry ? '正在保存…' : `已保存 ${nowTime()}`);
      }
    } catch (error) {
      setThoughtStatus('保存失败，点击重试', true);
      toast(error.message, true);
      throw error;
    } finally {
      thoughtSavePromise = null;
    }
  })();
  try { await thoughtSavePromise; return true; } catch (_) { return false; }
}

async function flushThoughtSave() {
  if (reviewUploadPromise && !(await reviewUploadPromise)) return false;
  if (reviewUploadFailure) { toast('有图片尚未插入，请先重试或取消待插入图片。', true); return false; }
  clearTimeout(thinkTimer);
  thinkTimer = null;
  if (thoughtSavePromise) {
    try { await thoughtSavePromise; } catch (_) { /* retry snapshot remains */ }
  }
  // 等待请求时输入可能又启动了计时器，切换前一并提交最新快照。
  clearTimeout(thinkTimer);
  thinkTimer = null;
  const snapshot = collectThoughtSnapshot();
  if (!snapshot || (snapshot.id === 'draft' && !hasThoughtContent(snapshot))) return true;
  return persistThoughtSnapshot(snapshot);
}

function setReflectStatus(text, isError = false) {
  const el = $('#reflectStatus');
  if (!el) return;
  el.textContent = text;
  el.classList.toggle('save-error', isError);
}

function sameReflectSnapshot(left, right) {
  return left && right && left.date === right.date && JSON.stringify(left.entries) === JSON.stringify(right.entries);
}

async function persistReflectSnapshot(rawSnapshot) {
  if (!rawSnapshot) return true;
  if (reflectSavePromise) await reflectSavePromise;
  const snapshot = { date: rawSnapshot.date, entries: { ...rawSnapshot.entries } };
  reflectSavePromise = (async () => {
    try {
      await api('POST', '/api/reflect', snapshot);
      if (selectedDate === snapshot.date) setReflectStatus(sameReflectSnapshot(reflectRetry, snapshot) ? `已保存 ${nowTime()}` : '正在保存…');
      if (sameReflectSnapshot(reflectRetry, snapshot)) reflectRetry = null;
      return true;
    } catch (error) {
      if (selectedDate === snapshot.date) setReflectStatus('保存失败，点击重试', true);
      toast(error.message, true);
      return false;
    } finally {
      reflectSavePromise = null;
    }
  })();
  return reflectSavePromise;
}

function scheduleReflectSave() {
  const entries = { ...(state.reflectEntries[selectedDate] || {}) };
  $$('.reflect-editor').forEach((editor) => { entries[editor.dataset.framework] = editor.value; });
  state.reflectEntries[selectedDate] = entries;
  const date = selectedDate;
  reflectRetry = { date, entries: { ...entries } };
  setReflectStatus('正在保存…');
  clearTimeout(reflectTimer);
  reflectTimer = setTimeout(() => {
    reflectTimer = null;
    persistReflectSnapshot({ date, entries });
  }, 650);
}

function samePlanSnapshot(left, right) {
  return left && right && left.id === right.id && left.name === right.name && left.description === right.description && left.note === right.note;
}

async function persistPlanSnapshot(rawSnapshot) {
  if (!rawSnapshot) return true;
  if (planSavePromise) await planSavePromise;
  const snapshot = { ...rawSnapshot };
  planSavePromise = (async () => {
    try {
      await Promise.all([
        api('PATCH', `/api/plans/${snapshot.id}`, { name: snapshot.name, description: snapshot.description }),
        api('POST', `/api/plans/${snapshot.id}/note`, { note: snapshot.note }),
      ]);
      if (selectedPlanId === snapshot.id) setPlanStatus(samePlanSnapshot(planRetry, snapshot) ? `已保存 ${nowTime()}` : '正在保存…');
      if (samePlanSnapshot(planRetry, snapshot)) planRetry = null;
      return true;
    } catch (error) {
      if (selectedPlanId === snapshot.id) setPlanStatus('保存失败，点击重试', true);
      toast(error.message, true);
      return false;
    } finally {
      planSavePromise = null;
    }
  })();
  return planSavePromise;
}

function schedulePlanSave() {
  const plan = currentPlan();
  if (!plan) return;
  plan.name = $('#planName').value.trim() || plan.name;
  plan.description = $('#planDescription').value;
  plan.note = $('#planNote').value;
  const snapshot = { id: plan.id, name: plan.name, description: plan.description, note: plan.note };
  planRetry = snapshot;
  setPlanStatus('输入中…');
  clearTimeout(planTimer);
  planTimer = setTimeout(() => {
    planTimer = null;
    if (selectedPlanId === snapshot.id) setPlanStatus('正在保存…');
    persistPlanSnapshot(snapshot);
  }, 650);
}

async function flushPendingSaves() {
  const thoughtSaved = await flushThoughtSave();
  const reflectSnapshot = reflectRetry;
  clearTimeout(reflectTimer);
  reflectTimer = null;
  const reflectSaved = reflectSnapshot ? await persistReflectSnapshot(reflectSnapshot) : !reflectSavePromise || await reflectSavePromise;
  const planSnapshot = planRetry;
  clearTimeout(planTimer);
  planTimer = null;
  const planSaved = planSnapshot ? await persistPlanSnapshot(planSnapshot) : !planSavePromise || await planSavePromise;
  return thoughtSaved && reflectSaved && planSaved;
}

function bindManageInputs() {
  $$('[data-add-item-input]').forEach((input) => input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      addItem(input.dataset.addItemInput, input.value);
    }
  }));
}

function openFormModal({ eyebrow = '编辑', title, label, value = '', placeholder = '', submitText = '保存', multiline = false, onSubmit }) {
  $('#modalEyebrow').textContent = eyebrow;
  $('#modalTitle').textContent = title;
  $('#modalBody').innerHTML = multiline
    ? `<div class="field"><label for="modalInput">${escapeHtml(label)}</label><textarea class="textarea modal-input" id="modalInput" rows="5" placeholder="${escapeHtml(placeholder)}">${escapeHtml(value)}</textarea></div>`
    : `<div class="field"><label for="modalInput">${escapeHtml(label)}</label><input class="input" id="modalInput" value="${escapeHtml(value)}" placeholder="${escapeHtml(placeholder)}" /></div>`;
  $('#modalActions').innerHTML = '<button class="button ghost" data-modal-cancel>取消</button><button class="button primary" id="modalSubmit">' + escapeHtml(submitText) + '</button>';
  $('#modalBackdrop').classList.remove('hidden');
  renderIcons();
  setTimeout(() => { $('#modalInput').focus(); $('#modalInput').select(); }, 0);
  const submit = async () => {
    const clean = $('#modalInput').value.trim();
    if (!clean) { toast(`${label}不能为空`, true); return; }
    $('#modalSubmit').disabled = true;
    try { await onSubmit(clean); closeModal(); } catch (error) { toast(error.message, true); $('#modalSubmit').disabled = false; }
  };
  $('#modalSubmit').onclick = submit;
  $('#modalInput').onkeydown = (event) => { if (event.key === 'Enter') submit(); };
  $('[data-modal-cancel]').onclick = closeModal;
}

function openCheckinReasonModal(itemId, date = selectedDate) {
  const existing = reasonFor(itemId, date);
  $('#modalEyebrow').textContent = dateLabel(date);
  $('#modalTitle').textContent = '未完成原因';
  $('#modalBody').innerHTML = `<div class="field"><label for="modalInput">原因说明</label><textarea class="textarea modal-input" id="modalInput" rows="5" placeholder="例如：临时安排打断了计划，明天调整时间完成。">${escapeHtml(existing)}</textarea><p class="field-hint">留空保存即可清空已填写的原因。</p></div>`;
  $('#modalActions').innerHTML = '<button class="button ghost" data-modal-cancel>取消</button><button class="button primary" id="modalSubmit">保存原因</button>';
  $('#modalBackdrop').classList.remove('hidden');
  renderIcons();
  setTimeout(() => { $('#modalInput').focus(); $('#modalInput').select(); }, 0);
  $('#modalSubmit').onclick = async () => {
    const reason = $('#modalInput').value;
    $('#modalSubmit').disabled = true;
    try {
      const result = await api('POST', '/api/checkin-reasons', { date, itemId, reason });
      if (!state.checkinReasons[date]) state.checkinReasons[date] = {};
      if (result.reason) state.checkinReasons[date][itemId] = result.reason;
      else {
        delete state.checkinReasons[date][itemId];
        if (!Object.keys(state.checkinReasons[date]).length) delete state.checkinReasons[date];
      }
      closeModal();
      render();
    } catch (error) { toast(error.message, true); $('#modalSubmit').disabled = false; }
  };
  $('[data-modal-cancel]').onclick = closeModal;
}

function openConfirmModal({ title, message, confirmText = '确认删除', onConfirm }) {
  $('#modalEyebrow').textContent = '请确认';
  $('#modalTitle').textContent = title;
  $('#modalBody').innerHTML = `<p class="modal-message">${escapeHtml(message)}</p>`;
  $('#modalActions').innerHTML = '<button class="button ghost" data-modal-cancel>取消</button><button class="button danger" id="modalSubmit">' + escapeHtml(confirmText) + '</button>';
  $('#modalBackdrop').classList.remove('hidden');
  renderIcons();
  $('#modalSubmit').onclick = async () => {
    $('#modalSubmit').disabled = true;
    try { await onConfirm(); closeModal(); } catch (error) { toast(error.message, true); $('#modalSubmit').disabled = false; }
  };
  $('[data-modal-cancel]').onclick = closeModal;
}

function closeModal() { $('#modalBackdrop').classList.add('hidden'); }

function openAddThoughtCategoryModal() {
  openFormModal({
    eyebrow: '所思 · 文章类别', title: '新建类别', label: '类别名称', placeholder: '例如：学习、关系、灵感', submitText: '新建类别',
    onSubmit: async (name) => {
      const result = await api('POST', '/api/thought-categories', { name });
      state.thoughtCategories.push(result.category);
      const thought = currentThought();
      if (thought) {
        thought.categoryId = result.category.id;
        scheduleThinkSave();
      }
      render();
    },
  });
}

function openThoughtCategoryManager() {
  $('#modalEyebrow').textContent = '自由思考与每日复盘共用类别';
  $('#modalTitle').textContent = '管理类别';
  $('#modalBody').innerHTML = `<div class="thought-category-manager">
    <div class="thought-category-row system"><span>未分类</span><small>系统类别</small></div>
    ${state.thoughtCategories.length ? state.thoughtCategories.map((category) => `<div class="thought-category-row">
      <span>${escapeHtml(category.name)}</span>
      <div class="row-actions">
        <button class="mini-button" data-action="rename-thought-category" data-id="${category.id}" aria-label="重命名类别${escapeHtml(category.name)}"><i data-lucide="pencil"></i></button>
        <button class="mini-button danger" data-action="delete-thought-category" data-id="${category.id}" aria-label="删除类别${escapeHtml(category.name)}"><i data-lucide="trash-2"></i></button>
      </div>
    </div>`).join('') : '<p class="status-text">还没有自定义类别。</p>'}
  </div>`;
  $('#modalActions').innerHTML = '<button class="button ghost" data-modal-cancel>关闭</button><button class="button primary" data-action="add-thought-category"><i data-lucide="plus"></i>新建类别</button>';
  $('#modalBackdrop').classList.remove('hidden');
  $('[data-modal-cancel]').onclick = closeModal;
  renderIcons();
}

async function moveEntity(list, id, direction, endpoint, responseKey, assign) {
  const index = list.findIndex((item) => item.id === id);
  const target = direction === 'up' ? index - 1 : index + 1;
  if (index < 0 || target < 0 || target >= list.length) return;
  const ordered = list.slice();
  [ordered[index], ordered[target]] = [ordered[target], ordered[index]];
  const result = await api('POST', endpoint, { orderedIds: ordered.map((item) => item.id) });
  assign(result[responseKey]);
  render();
}

async function addItem(sectionId, rawValue) {
  const name = String(rawValue || '').trim();
  if (!name) { toast('请输入条目名称', true); return; }
  try {
    const result = await api('POST', `/api/sections/${sectionId}/items`, { name });
    state.sections.find((section) => section.id === sectionId).items.push(result.item);
    render();
    requestAnimationFrame(() => $(`[data-add-item-input="${sectionId}"]`)?.focus());
  } catch (error) { toast(error.message, true); }
}

async function handleAction(button) {
  const action = button.dataset.action;
  if (action.startsWith('review-')) { await handleReviewImageAction(button); return; }
  if (action === 'prev-date' || action === 'next-date' || action === 'today-date') {
    if (currentView === 'thoughts' && isArticleMode() && !(await flushThoughtSave())) return;
    selectedDate = action === 'today-date' ? localToday() : addDays(selectedDate, action === 'prev-date' ? -1 : 1);
    focusItemId = null;
    thoughtSurface = 'editor';
    thoughtDraft = null;
    selectedThoughtId = null;
    render();
    return;
  }
  if (action === 'principle-tab') { currentPrincipleTab = button.dataset.tab; render(); return; }
  if (action === 'create-backup') {
    button.disabled = true;
    try {
      const result = await api('POST', '/api/backups');
      state.backups.unshift(result.backup);
      render();
      toast('已创建本机备份');
    } finally { button.disabled = false; }
    return;
  }
  if (action === 'restore-backup') {
    const backup = state.backups.find((entry) => entry.id === button.dataset.id);
    if (!backup) return;
    openConfirmModal({
      title: '恢复这份备份？',
      message: '当前数据会先自动备份，然后恢复所选备份中的记录和复盘图片。恢复后页面将刷新。',
      confirmText: '恢复备份',
      onConfirm: async () => {
        await api('POST', `/api/backups/${backup.id}/restore`);
        location.reload();
      },
    });
    return;
  }
  if (action === 'toggle-checkin') {
    const itemId = button.dataset.id;
    const done = !recordFor()[itemId];
    try {
      await api('POST', '/api/checkin', { date: selectedDate, itemId, done });
      if (!state.records[selectedDate]) state.records[selectedDate] = {};
      state.records[selectedDate][itemId] = done;
      render();
    } catch (error) { toast(error.message, true); }
    return;
  }
  if (action === 'edit-checkin-reason') { openCheckinReasonModal(button.dataset.id); return; }
  if (action === 'stats-edit-reason') { openCheckinReasonModal(button.dataset.id, button.dataset.date); return; }
  if (action === 'stats-select-date') {
    selectedReviewDate = button.dataset.date;
    reviewHighlightItemId = button.dataset.highlight || null;
    reviewCompletedExpanded = false;
    dailyReviewFilter = 'all';
    render();
    requestAnimationFrame(() => {
      const target = reviewHighlightItemId ? $(`#review-node-${reviewHighlightItemId}`) : $('#dailyReviewCard');
      target?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
    return;
  }
  if (action === 'stats-prev-date' || action === 'stats-next-date' || action === 'stats-yesterday' || action === 'stats-today') {
    if (action === 'stats-yesterday') selectedReviewDate = addDays(localToday(), -1);
    else if (action === 'stats-today') selectedReviewDate = localToday();
    else selectedReviewDate = addDays(selectedReviewDate, action === 'stats-prev-date' ? -1 : 1);
    if (selectedReviewDate > localToday()) selectedReviewDate = localToday();
    reviewHighlightItemId = null;
    reviewCompletedExpanded = false;
    render();
    return;
  }
  if (action === 'stats-filter') {
    dailyReviewFilter = button.dataset.filter;
    reviewCompletedExpanded = false;
    render();
    return;
  }
  if (action === 'stats-toggle-completed') { reviewCompletedExpanded = !reviewCompletedExpanded; render(); return; }
  if (action === 'stats-reason-range') { reasonTimelineRange = button.dataset.range; render(); return; }
  if (action === 'select-plan') { selectedPlanId = button.dataset.id; planMenuOpenId = null; render(); return; }

  if (action === 'switch-thought-mode') {
    if (button.dataset.mode === thoughtMode) return;
    if (isArticleMode() && !(await flushThoughtSave())) return;
    if (thoughtDraft && !hasThoughtContent(thoughtDraft)) thoughtDraft = null;
    selectedThoughtId = null;
    thoughtMode = button.dataset.mode;
    render();
    $(`.thought-tab[data-mode="${thoughtMode}"]`)?.focus();
    return;
  }
  if (action === 'open-thought-history') {
    if (thoughtSurface === 'editor' && isArticleMode() && !(await flushThoughtSave())) return;
    if (thoughtDraft && !hasThoughtContent(thoughtDraft)) thoughtDraft = null;
    thoughtSurface = 'history';
    selectedHistoryKey = null;
    historyListScroll = { app: 0, window: 0 };
    thoughtHistoryFilter = 'all';
    thoughtHistoryCategory = 'all';
    thoughtHistoryQuery = '';
    render();
    $('#app').scrollTop = 0;
    window.scrollTo(0, 0);
    const heading = $('#historyPageTitle');
    if (heading) heading.focus({ preventScroll: true });
    return;
  }
  if (action === 'write-daily-reflection') {
    selectedDate = localToday();
    thoughtMode = 'reflection';
    thoughtSurface = 'editor';
    selectedHistoryKey = null;
    render();
    $('#app').scrollTop = 0;
    window.scrollTo(0, 0);
    ($('.reflect-editor') || $('.thought-tab.active'))?.focus({ preventScroll: true });
    return;
  }
  if (action === 'back-history-list') {
    const previousKey = selectedHistoryKey;
    selectedHistoryKey = null;
    render();
    const previous = $$('.history-record-main').find((entry) => entry.dataset.key === previousKey);
    (previous || $('.history-record-main'))?.focus({ preventScroll: true });
    $('#app').scrollTop = historyListScroll.app;
    window.scrollTo(0, historyListScroll.window);
    return;
  }
  if (action === 'filter-thought-history') {
    thoughtHistoryFilter = button.dataset.filter;
    selectedHistoryKey = null;
    render();
    const chip = $(`.history-filter-chip[data-filter="${thoughtHistoryFilter}"]`);
    if (chip) chip.focus();
    return;
  }
  if (action === 'select-history-record') {
    openHistoryRecord(button.dataset.key);
    return;
  }
  if (action === 'edit-history-record') {
    editHistoryRecord(button.dataset.date, button.dataset.mode, button.dataset.id || null);
    return;
  }
  if (action === 'reset-history-filter') {
    thoughtHistoryFilter = 'all';
    thoughtHistoryCategory = 'all';
    thoughtHistoryQuery = '';
    render();
    return;
  }
  if (action === 'retry-think-save') {
    if (!thinkRetry) return;
    setThoughtStatus('正在保存…');
    await persistThoughtSnapshot({ ...thinkRetry });
    return;
  }
  if (action === 'retry-reflect-save') {
    const snapshot = reflectRetry;
    if (!snapshot) return;
    setReflectStatus('正在保存…');
    clearTimeout(reflectTimer);
    reflectTimer = null;
    await persistReflectSnapshot(snapshot);
    return;
  }
  if (action === 'new-thought' || action === 'new-review') {
    if (action === 'new-review' && state.version < 7) {
      toast('请先重启生活管家服务并刷新页面，以启用每日复盘。现有文章不受影响。', true);
      return;
    }
    if (thoughtSurface === 'editor' && isArticleMode() && !(await flushThoughtSave())) return;
    if (thoughtSurface === 'history') selectedDate = localToday();
    thoughtSurface = 'editor';
    thoughtMode = action === 'new-review' ? 'review' : 'free';
    selectedHistoryKey = null;
    thoughtDraft = { id: 'draft', kind: thoughtMode, date: selectedDate, title: '', text: '', categoryId: null, createdAt: null, updatedAt: null };
    selectedThoughtId = 'draft';
    render();
    requestAnimationFrame(() => $('#thoughtTitle')?.focus());
    return;
  }
  if (action === 'manage-thought-categories') {
    if (!(await flushThoughtSave())) return;
    openThoughtCategoryManager();
    return;
  }
  if (action === 'add-thought-category') {
    openAddThoughtCategoryModal();
    return;
  }
  if (action === 'rename-thought-category') {
    const category = state.thoughtCategories.find((entry) => entry.id === button.dataset.id);
    if (!category) return;
    openFormModal({ eyebrow: '所思 · 文章类别', title: '重命名类别', label: '类别名称', value: category.name, onSubmit: async (name) => {
      const result = await api('PATCH', `/api/thought-categories/${category.id}`, { name });
      category.name = result.category.name;
      render();
    } });
    return;
  }
  if (action === 'delete-thought-category') {
    const category = state.thoughtCategories.find((entry) => entry.id === button.dataset.id);
    if (!category) return;
    const count = state.thoughtEntries.filter((entry) => entry.categoryId === category.id).length;
    openConfirmModal({ title: `删除类别「${category.name}」？`, message: `${count} 篇相关文章会转入“未分类”，文章本身不会删除。`, confirmText: '删除类别', onConfirm: async () => {
      await api('DELETE', `/api/thought-categories/${category.id}`);
      state.thoughtCategories = state.thoughtCategories.filter((entry) => entry.id !== category.id);
      state.thoughtEntries.forEach((entry) => { if (entry.categoryId === category.id) entry.categoryId = null; });
      if (thoughtDraft?.categoryId === category.id) thoughtDraft.categoryId = null;
      if (thoughtHistoryCategory === category.id) thoughtHistoryCategory = 'uncategorized';
      render();
    } });
    return;
  }
  if (action === 'delete-thought') {
    if (!(await flushThoughtSave())) return;
    const thought = currentThought();
    if (!thought || thought.id === 'draft') return;
    openConfirmModal({ title: `删除「${effectiveThoughtTitle(thought)}」？`, message: `这篇${thoughtKindLabel(thoughtKind(thought))}会被永久删除，此操作无法撤销。`, confirmText: `删除${thoughtNoun(thought)}`, onConfirm: async () => {
      clearTimeout(thinkTimer); thinkTimer = null; thinkRetry = null;
      await api('DELETE', `/api/thoughts/${thought.id}`);
      state.thoughtEntries = state.thoughtEntries.filter((entry) => entry.id !== thought.id);
      selectedThoughtId = thoughtEntriesForDate()[0]?.id || null;
      render();
      toast(`已删除这篇${thoughtNoun(thought)}`);
    } });
    return;
  }
  if (action === 'clear-reflect-answer') {
    const frameworkId = button.dataset.framework;
    const framework = state.reflectFrameworks.find((entry) => entry.id === frameworkId);
    const entries = { ...(state.reflectEntries[selectedDate] || {}) };
    if (!(entries[frameworkId] || '').trim()) return;
    delete entries[frameworkId];
    openConfirmModal({ title: '清空这个回答？', message: `「${framework.name}」今天的回答会被清空，此操作无法撤销。`, confirmText: '清空', onConfirm: async () => {
      clearTimeout(reflectTimer); reflectTimer = null; reflectRetry = null;
      await api('POST', '/api/reflect', { date: selectedDate, entries });
      state.reflectEntries[selectedDate] = entries;
      render();
      toast('已清空回答');
    } });
    return;
  }
  if (action === 'delete-history-thought') {
    const thought = state.thoughtEntries.find((entry) => entry.id === button.dataset.id);
    if (!thought) return;
    openConfirmModal({ title: `删除「${effectiveThoughtTitle(thought)}」？`, message: `${dateLabel(thought.date)}的这篇${thoughtKindLabel(thoughtKind(thought))}会被永久删除。`, confirmText: `删除${thoughtNoun(thought)}`, onConfirm: async () => {
      await api('DELETE', `/api/thoughts/${thought.id}`);
      state.thoughtEntries = state.thoughtEntries.filter((entry) => entry.id !== thought.id);
      selectedHistoryKey = null;
      render();
      toast(`已删除这篇${thoughtNoun(thought)}`);
    } });
    return;
  }
  if (action === 'delete-history-reflection') {
    const date = button.dataset.date;
    openConfirmModal({ title: `删除 ${dateLabel(date)} 的每日反思？`, message: '当天的反思回答会被清空，自由思考和每日复盘不会受到影响。', confirmText: '删除反思', onConfirm: async () => {
      clearTimeout(reflectTimer); reflectTimer = null; reflectRetry = null;
      await api('POST', '/api/reflect', { date, entries: {} });
      delete state.reflectEntries[date];
      selectedHistoryKey = null;
      render();
      toast('已删除当天反思');
    } });
    return;
  }

  // ---------- 事件安排 ----------
  if (action === 'event-mode') {
    eventMode = button.dataset.mode;
    eventMenuKey = null;
    if (eventMode === 'calendar' && !eventCalendarCursor) eventCalendarCursor = eventDate.slice(0, 7);
    render();
    return;
  }
  if (action === 'event-prev-day' || action === 'event-next-day' || action === 'event-today') {
    eventDate = action === 'event-today' ? localToday() : EventModel.addDays(eventDate, action === 'event-prev-day' ? -1 : 1);
    eventMenuKey = null;
    render();
    return;
  }
  if (action === 'open-event-drawer') {
    openEventDrawer(null, button.dataset.defaultDate || null);
    return;
  }
  if (action === 'toggle-event-checkin') {
    toggleEventCheckin(button.dataset.key);
    return;
  }
  if (action === 'toggle-event-note') {
    const key = button.dataset.key;
    eventNoteExpandedKey = eventNoteExpandedKey === key ? null : key;
    const wrap = $('#eventScheduleWrap');
    if (wrap) wrap.innerHTML = eventScheduleBody();
    renderIcons();
    return;
  }
  if (action === 'toggle-done-collapse') {
    eventDoneCollapsed = !eventDoneCollapsed;
    const wrap = $('#eventScheduleWrap');
    if (wrap) wrap.innerHTML = eventScheduleBody();
    renderIcons();
    return;
  }
  if (action === 'open-event-menu') {
    const key = button.dataset.key;
    eventMenuKey = eventMenuKey === key ? null : key;
    render();
    const toggle = $(`[data-action="open-event-menu"][data-key="${key}"]`);
    if (toggle) toggle.focus();
    return;
  }
  if (action === 'edit-event-instance') { editEventInstance(button.dataset.key); return; }
  if (action === 'delete-event-instance') { deleteEventInstance(button.dataset.key); return; }
  if (action === 'edit-recurring') {
    const event = state.events.find((entry) => entry.id === button.dataset.id);
    openEventDrawer({ event, date: event.startDate, mode: 'single' });
    return;
  }
  if (action === 'delete-recurring') { deleteRecurring(button.dataset.id); return; }
  if (action === 'toggle-recurring') { toggleRecurring(button.dataset.id); return; }
  if (action === 'event-recurring-filter') { eventRecurringFilter = button.dataset.filter; render(); return; }
  if (action === 'event-month-prev' || action === 'event-month-next') {
    const [year, month] = eventCalendarCursor.split('-').map(Number);
    const cursor = new Date(year, month - 1 + (action === 'event-month-prev' ? -1 : 1), 1);
    eventCalendarCursor = `${cursor.getFullYear()}-${String(cursor.getMonth() + 1).padStart(2, '0')}`;
    render();
    const title = $('#eventsCalendarTitle');
    if (title) title.focus({ preventScroll: true });
    return;
  }
  if (action === 'event-month-today') {
    eventCalendarCursor = localToday().slice(0, 7);
    render();
    return;
  }
  if (action === 'event-cal-select') {
    eventDate = button.dataset.date;
    eventMode = 'schedule';
    eventMenuKey = null;
    render();
    const title = $('#eventsDateTitle');
    if (title) title.focus({ preventScroll: true });
    return;
  }
  if (action === 'event-memo-open-date') {
    eventDate = button.dataset.date;
    eventMode = 'schedule';
    eventMenuKey = null;
    render();
    const title = $('#eventsDateTitle');
    if (title) title.focus({ preventScroll: true });
    return;
  }

  if (action === 'open-plan-menu') {
    const id = button.dataset.id;
    planMenuOpenId = planMenuOpenId === id ? null : id;
    render();
    const toggle = $(`[data-action="open-plan-menu"][data-id="${id}"]`);
    if (toggle) toggle.focus();
    return;
  }
  if (action === 'retry-plan-save') {
    const snapshot = planRetry;
    if (!snapshot) return;
    setPlanStatus('正在保存…');
    clearTimeout(planTimer);
    planTimer = null;
    await persistPlanSnapshot(snapshot);
    return;
  }

  // ---------- 问题归纳 ----------
  if (action === 'add-problem-topic') {
    openFormModal({ eyebrow: '问题归纳', title: '新建主题', label: '主题名称', placeholder: '例如：工作与职业、健康管理、人际关系', submitText: '建立主题', onSubmit: async (name) => {
      const result = await api('POST', '/api/problem-topics', { name });
      state.problemTopics.push(result.topic);
      selectedProblemTopicId = result.topic.id;
      problemMenuOpenId = null;
      render();
      requestAnimationFrame(() => { const composer = $('#problemComposer'); if (composer) composer.focus(); });
    } });
    return;
  }
  if (action === 'select-problem-topic') {
    selectedProblemTopicId = button.dataset.id;
    problemMenuOpenId = null;
    render();
    return;
  }
  if (action === 'open-problem-menu') {
    const id = button.dataset.id;
    const anchor = button.dataset.anchor || 'rail';
    if (problemMenuOpenId === id && problemMenuAnchor === anchor) {
      problemMenuOpenId = null;
    } else {
      problemMenuOpenId = id;
      problemMenuAnchor = anchor;
    }
    render();
    const toggle = $(`[data-action="open-problem-menu"][data-anchor="${anchor}"][data-id="${id}"]`);
    if (toggle) toggle.focus();
    return;
  }
  if (action === 'rename-problem-topic') {
    const topic = state.problemTopics.find((entry) => entry.id === button.dataset.id);
    openFormModal({ eyebrow: '问题归纳', title: '重命名主题', label: '主题名称', value: topic.name, submitText: '保存', onSubmit: async (name) => {
      const result = await api('PATCH', `/api/problem-topics/${topic.id}`, { name });
      topic.name = result.topic.name;
      problemMenuOpenId = null;
      render();
    } });
    return;
  }
  if (action === 'delete-problem-topic') {
    const topic = state.problemTopics.find((entry) => entry.id === button.dataset.id);
    openConfirmModal({
      title: `删除「${topic.name}」？`,
      message: `该主题下的 ${topic.items.length} 个问题也会一起删除，此操作无法撤销。`,
      confirmText: '删除主题',
      onConfirm: async () => {
        const index = state.problemTopics.findIndex((entry) => entry.id === topic.id);
        await api('DELETE', `/api/problem-topics/${topic.id}`);
        state.problemTopics = state.problemTopics.filter((entry) => entry.id !== topic.id);
        if (state.problemTopics.length) {
          selectedProblemTopicId = state.problemTopics[Math.min(Math.max(index, 0), state.problemTopics.length - 1)].id;
        } else {
          selectedProblemTopicId = null;
        }
        problemMenuOpenId = null;
        render();
      },
    });
    return;
  }
  if (action === 'add-problem-item') {
    addProblemItem(selectedProblemTopicId, $('#problemComposer')?.value || '');
    return;
  }
  if (action === 'edit-problem-item') {
    const topic = state.problemTopics.find((entry) => entry.id === button.dataset.topic);
    const item = topic.items.find((entry) => entry.id === button.dataset.id);
    openFormModal({ eyebrow: topic.name, title: '编辑问题', label: '问题内容', value: item.text, placeholder: '写下一个反复出现、值得继续追问的问题……', submitText: '保存', multiline: true, onSubmit: async (text) => {
      const result = await api('PATCH', `/api/problem-topics/${topic.id}/items/${item.id}`, { text });
      item.text = result.item.text;
      renderProblemDetail();
    } });
    return;
  }
  if (action === 'delete-problem-item') {
    const topic = state.problemTopics.find((entry) => entry.id === button.dataset.topic);
    const item = topic.items.find((entry) => entry.id === button.dataset.id);
    const preview = item.text.length > 16 ? `${item.text.slice(0, 16)}…` : item.text;
    openConfirmModal({
      title: '删除这个问题？',
      message: `「${preview}」将被永久删除。`,
      confirmText: '删除问题',
      onConfirm: async () => {
        await api('DELETE', `/api/problem-topics/${topic.id}/items/${item.id}`);
        topic.items = topic.items.filter((entry) => entry.id !== item.id);
        renderProblemDetail();
      },
    });
    return;
  }

  if (action === 'add-section') {
    openFormModal({ eyebrow: '原则管理', title: '新建原则', label: '原则名称', placeholder: '例如：专注重要，少即是多', submitText: '建立原则', onSubmit: async (name) => {
      const result = await api('POST', '/api/sections', { name }); state.sections.push(result.section); render();
    } });
    return;
  }
  if (action === 'rename-section') {
    const section = state.sections.find((item) => item.id === button.dataset.id);
    openFormModal({ eyebrow: '原则管理', title: '重命名原则', label: '原则名称', value: section.name, onSubmit: async (name) => {
      const result = await api('PATCH', `/api/sections/${section.id}`, { name }); section.name = result.section.name; render();
    } });
    return;
  }
  if (action === 'delete-section') {
    const section = state.sections.find((item) => item.id === button.dataset.id);
    openConfirmModal({ title: `删除「${section.name}」？`, message: '该原则下的条目和历史打卡记录也会一并删除，这个操作无法撤销。', onConfirm: async () => {
      await api('DELETE', `/api/sections/${section.id}`); state.sections = state.sections.filter((item) => item.id !== section.id); render();
    } });
    return;
  }
  if (action === 'move-section') {
    await moveEntity(state.sections, button.dataset.id, button.dataset.dir, '/api/sections/reorder', 'sections', (items) => { state.sections = items; }); return;
  }
  if (action === 'add-item') { await addItem(button.dataset.section, $(`#addItem-${button.dataset.section}`).value); return; }
  if (action === 'add-child') {
    const section = state.sections.find((entry) => entry.id === button.dataset.section);
    const item = section?.items.find((entry) => entry.id === button.dataset.id);
    if (!item) return;
    openFormModal({ eyebrow: `${section.name} · ${item.name}`, title: '添加子节点', label: '子节点名称', placeholder: '例如：完成今天的练习', submitText: '添加子节点', onSubmit: async (name) => {
      const result = await api('POST', `/api/sections/${section.id}/items/${item.id}/children`, { name });
      if (!Array.isArray(item.children)) item.children = [];
      item.children.push(result.child);
      render();
    } });
    return;
  }
  if (action === 'rename-item') {
    const section = state.sections.find((item) => item.id === button.dataset.section);
    const item = section.items.find((entry) => entry.id === button.dataset.id);
    openFormModal({ eyebrow: section.name, title: '重命名条目', label: '条目名称', value: item.name, onSubmit: async (name) => {
      const result = await api('PATCH', `/api/sections/${section.id}/items/${item.id}`, { name }); item.name = result.item.name; render();
    } });
    return;
  }
  if (action === 'delete-item') {
    const section = state.sections.find((item) => item.id === button.dataset.section);
    const item = section.items.find((entry) => entry.id === button.dataset.id);
    openConfirmModal({ title: `删除「${item.name}」？`, message: '这个条目、其子节点及所有相关的历史打卡和未完成原因都会被删除。', onConfirm: async () => {
      await api('DELETE', `/api/sections/${section.id}/items/${item.id}`); section.items = section.items.filter((entry) => entry.id !== item.id); render();
    } });
    return;
  }
  if (action === 'move-item') {
    const section = state.sections.find((item) => item.id === button.dataset.section);
    await moveEntity(section.items, button.dataset.id, button.dataset.dir, `/api/sections/${section.id}/items/reorder`, 'items', (items) => { section.items = items; }); return;
  }
  if (action === 'rename-child') {
    const section = state.sections.find((entry) => entry.id === button.dataset.section);
    const item = section?.items.find((entry) => entry.id === button.dataset.item);
    const child = item?.children?.find((entry) => entry.id === button.dataset.id);
    if (!child) return;
    openFormModal({ eyebrow: `${section.name} · ${item.name}`, title: '重命名子节点', label: '子节点名称', value: child.name, onSubmit: async (name) => {
      const result = await api('PATCH', `/api/sections/${section.id}/items/${item.id}/children/${child.id}`, { name });
      child.name = result.child.name;
      render();
    } });
    return;
  }
  if (action === 'delete-child') {
    const section = state.sections.find((entry) => entry.id === button.dataset.section);
    const item = section?.items.find((entry) => entry.id === button.dataset.item);
    const child = item?.children?.find((entry) => entry.id === button.dataset.id);
    if (!child) return;
    openConfirmModal({ title: `删除「${child.name}」？`, message: '这个子节点的历史打卡和未完成原因也会被删除。', onConfirm: async () => {
      await api('DELETE', `/api/sections/${section.id}/items/${item.id}/children/${child.id}`);
      item.children = item.children.filter((entry) => entry.id !== child.id);
      render();
    } });
    return;
  }
  if (action === 'move-child') {
    const section = state.sections.find((entry) => entry.id === button.dataset.section);
    const item = section?.items.find((entry) => entry.id === button.dataset.item);
    if (!item?.children) return;
    await moveEntity(item.children, button.dataset.id, button.dataset.dir, `/api/sections/${section.id}/items/${item.id}/children/reorder`, 'children', (children) => { item.children = children; });
    return;
  }

  if (action === 'add-framework') {
    openFormModal({ eyebrow: '每日反思', title: '添加反思问题', label: '问题或框架名称', placeholder: '例如：今天做得好的是什么？', submitText: '添加问题', onSubmit: async (name) => {
      const result = await api('POST', '/api/reflect/frameworks', { name }); state.reflectFrameworks.push(result.framework); render();
    } });
    return;
  }
  if (action === 'rename-framework') {
    const framework = state.reflectFrameworks.find((item) => item.id === button.dataset.id);
    openFormModal({ eyebrow: '每日反思', title: '修改反思问题', label: '问题或框架名称', value: framework.name, onSubmit: async (name) => {
      const result = await api('PATCH', `/api/reflect/frameworks/${framework.id}`, { name }); framework.name = result.framework.name; render();
    } });
    return;
  }
  if (action === 'delete-framework') {
    const framework = state.reflectFrameworks.find((item) => item.id === button.dataset.id);
    openConfirmModal({ title: `删除「${framework.name}」？`, message: '历史反思中这个问题对应的内容也会被删除。', onConfirm: async () => {
      await api('DELETE', `/api/reflect/frameworks/${framework.id}`); state.reflectFrameworks = state.reflectFrameworks.filter((item) => item.id !== framework.id); render();
    } });
    return;
  }

  if (action === 'add-plan') {
    openFormModal({ eyebrow: '计划', title: '新建计划', label: '计划名称', placeholder: '例如：完成个人作品集', submitText: '建立计划', onSubmit: async (name) => {
      const result = await api('POST', '/api/plans', { name });
      state.plans.push(result.plan);
      selectedPlanId = result.plan.id;
      planMenuOpenId = null;
      render();
      requestAnimationFrame(() => { const input = $('#planName'); if (input) input.focus(); });
    } });
    return;
  }
  if (action === 'move-plan') {
    planMenuOpenId = null;
    await moveEntity(state.plans, button.dataset.id, button.dataset.dir, '/api/plans/reorder', 'plans', (items) => { state.plans = items; }); return;
  }
  if (action === 'delete-plan') {
    const plan = state.plans.find((item) => item.id === button.dataset.id);
    openConfirmModal({ title: `删除「${plan.name}」？`, message: '计划描述和笔记也会一并删除，这个操作无法撤销。', onConfirm: async () => {
      if (selectedPlanId === plan.id && !(await flushPendingSaves())) throw new Error('计划尚未保存成功，请重试后再删除');
      const index = state.plans.findIndex((item) => item.id === plan.id);
      await api('DELETE', `/api/plans/${plan.id}`);
      if (planRetry?.id === plan.id) planRetry = null;
      state.plans = state.plans.filter((item) => item.id !== plan.id);
      const nextIndex = Math.min(Math.max(index, 0), state.plans.length - 1);
      selectedPlanId = state.plans[nextIndex]?.id || null;
      planMenuOpenId = null;
      render();
    } });
  }
}

// ---------- 事件安排：抽屉与范围操作 ----------

function openEventDrawer(editing, defaultDate = null) {
  eventEditing = editing; // null=新建；{event,date,mode}=编辑
  eventCreateDate = editing ? null : defaultDate;
  const root = $('#eventDrawerRoot');
  if (!root) return;
  root.innerHTML = eventDrawerHtml();
  root.classList.remove('hidden');
  bindEventDrawer();
  renderIcons();
  updateEventDrawerPreview();
  setTimeout(() => { const input = $('#eventTitleInput'); if (input) input.focus(); }, 0);
}

function closeEventDrawer() {
  const root = $('#eventDrawerRoot');
  if (root) root.classList.add('hidden');
  eventEditing = null;
  eventCreateDate = null;
  const addBtn = $('[data-action="open-event-drawer"]');
  if (addBtn) addBtn.focus();
}

function eventDrawerHtml() {
  const editing = eventEditing;
  const isEdit = Boolean(editing);
  const event = editing ? editing.event : null;
  const date = editing && editing.date ? editing.date : (eventCreateDate || eventDate);
  const repeat = (event && event.repeat) || { type: 'none', weekdays: [], monthDay: null, monthlyMode: null };
  const weekdayNames = ['一', '二', '三', '四', '五', '六', '日'];
  return `<section class="event-drawer" role="dialog" aria-modal="true" aria-labelledby="eventDrawerTitle">
    <div class="event-drawer-head">
      <h2 id="eventDrawerTitle">${isEdit ? '编辑事件' : '添加事件'}</h2>
      <button class="icon-button" id="eventDrawerClose" aria-label="关闭"><i data-lucide="x"></i></button>
    </div>
    <div class="event-drawer-body">
      <div class="field"><label for="eventTitleInput">事件名称 *</label><input class="input" id="eventTitleInput" value="${escapeHtml(event ? event.title : '')}" placeholder="例如：晨间阅读" /></div>
      <div class="field"><label for="eventDateField">日期</label><input class="input" type="date" id="eventDateField" value="${isEdit && editing.date ? editing.date : date}" /></div>
      <div class="field"><label for="eventTimeField">时间（可不填）</label><input class="input" type="time" id="eventTimeField" value="${escapeHtml(event ? (event.time || '') : '')}" /></div>
      <div class="field"><label for="eventRepeatSelect">重复方式</label>
        <select class="input" id="eventRepeatSelect">
          <option value="none" ${repeat.type === 'none' ? 'selected' : ''}>不重复</option>
          <option value="daily" ${repeat.type === 'daily' ? 'selected' : ''}>每天</option>
          <option value="weekly" ${repeat.type === 'weekly' ? 'selected' : ''}>每周</option>
          <option value="monthly" ${repeat.type === 'monthly' ? 'selected' : ''}>每月</option>
        </select>
      </div>
      <div class="field ${repeat.type === 'weekly' ? '' : 'hidden'}" id="eventWeekdaysField">
        <label>重复星期</label>
        <div class="weekday-picker" role="group" aria-label="重复星期">
          ${weekdayNames.map((name, index) => `<button type="button" class="weekday-btn ${(repeat.weekdays || []).includes(index + 1) ? 'active' : ''}" data-weekday="${index + 1}" aria-pressed="${(repeat.weekdays || []).includes(index + 1)}">${name}</button>`).join('')}
        </div>
      </div>
      <div class="field ${repeat.type === 'monthly' ? '' : 'hidden'}" id="eventMonthlyField">
        <label>每月规则</label>
        <div class="monthly-options">
          <label class="monthly-option"><input type="radio" name="monthlyMode" value="day" ${repeat.monthlyMode !== 'lastDay' ? 'checked' : ''} />每月第 <input class="input monthday-input" id="eventMonthDay" type="number" min="1" max="31" value="${escapeHtml(repeat.monthDay || parseInt(date.slice(8, 10), 10) || 1)}" aria-label="每月第几日" /> 日</label>
          <label class="monthly-option"><input type="radio" name="monthlyMode" value="lastDay" ${repeat.monthlyMode === 'lastDay' ? 'checked' : ''} />每月最后一天</label>
        </div>
      </div>
      <div class="field"><label for="eventNoteInput">备注（可不填）</label><textarea class="textarea" id="eventNoteInput" rows="3" placeholder="记录任何相关细节……">${escapeHtml(event ? (event.note || '') : '')}</textarea></div>
      <div class="event-preview" id="eventDrawerPreview" aria-live="polite"></div>
    </div>
    <div class="event-drawer-actions">
      <button class="button ghost" id="eventDrawerCancel">取消</button>
      <button class="button primary" id="eventDrawerSave"><i data-lucide="check"></i>保存事件</button>
    </div>
  </section>`;
}

function bindEventDrawer() {
  $('#eventDrawerClose')?.addEventListener('click', closeEventDrawer);
  $('#eventDrawerCancel')?.addEventListener('click', closeEventDrawer);
  $('#eventDrawerSave')?.addEventListener('click', saveEventDrawer);
  $('#eventRepeatSelect')?.addEventListener('change', () => {
    const type = $('#eventRepeatSelect').value;
    $('#eventWeekdaysField')?.classList.toggle('hidden', type !== 'weekly');
    $('#eventMonthlyField')?.classList.toggle('hidden', type !== 'monthly');
    updateEventDrawerPreview();
  });
  $('#eventWeekdaysField')?.addEventListener('click', (event) => {
    const btn = event.target.closest('.weekday-btn');
    if (!btn) return;
    btn.classList.toggle('active');
    btn.setAttribute('aria-pressed', String(btn.classList.contains('active')));
    updateEventDrawerPreview();
  });
  $('#eventMonthlyField')?.addEventListener('change', updateEventDrawerPreview);
  $('#eventTitleInput')?.addEventListener('input', updateEventDrawerPreview);
  $('#eventTimeField')?.addEventListener('change', updateEventDrawerPreview);
  $('#eventDateField')?.addEventListener('change', updateEventDrawerPreview);
}

function updateEventDrawerPreview() {
  const el = $('#eventDrawerPreview');
  if (!el) return;
  const title = ($('#eventTitleInput')?.value || '').trim();
  const date = $('#eventDateField')?.value || eventDate;
  const time = $('#eventTimeField')?.value || '';
  const type = $('#eventRepeatSelect')?.value || 'none';
  let text = '';
  if (!title) {
    text = '先填写事件名称，规则预览会显示在这里。';
  } else if (type === 'none') {
    text = `「${title}」将在 ${dateLabel(date)} ${time ? time + ' ' : ''}发生一次。`;
  } else if (type === 'daily') {
    text = `将从 ${dateLabel(date)} 起${time ? `，每天 ${time}` : ''}自动出现在日程中。`;
  } else if (type === 'weekly') {
    const names = ['', '周一', '周二', '周三', '周四', '周五', '周六', '周日'];
    const days = $$('#eventWeekdaysField .weekday-btn.active').map((btn) => names[Number(btn.dataset.weekday)]);
    text = days.length
      ? `将从 ${dateLabel(date)} 起，每周${days.join('、')}${time ? ` ${time}` : ''}自动出现在日程中。`
      : '请至少选择一个重复星期。';
  } else {
    const lastDay = document.querySelector('input[name="monthlyMode"]:checked')?.value === 'lastDay';
    text = lastDay
      ? `从 ${dateLabel(date)} 起，每月最后一天${time ? ` ${time}` : ''}自动出现。`
      : `从 ${dateLabel(date)} 起，每月${$('#eventMonthDay')?.value || 1}日${time ? ` ${time}` : ''}自动出现。`;
  }
  el.textContent = text;
}

function readEventDrawerPayload() {
  const title = ($('#eventTitleInput')?.value || '').trim();
  const date = $('#eventDateField')?.value || eventDate;
  const time = $('#eventTimeField')?.value || null;
  const note = $('#eventNoteInput')?.value || '';
  const type = $('#eventRepeatSelect')?.value || 'none';
  const repeat = { type, weekdays: [], monthDay: null, monthlyMode: null };
  if (type === 'weekly') {
    repeat.weekdays = $$('#eventWeekdaysField .weekday-btn.active').map((btn) => Number(btn.dataset.weekday));
    if (!repeat.weekdays.length) { toast('请至少选择一个重复星期', true); return null; }
  }
  if (type === 'monthly') {
    if (document.querySelector('input[name="monthlyMode"]:checked')?.value === 'lastDay') {
      repeat.monthlyMode = 'lastDay';
    } else {
      repeat.monthDay = Number($('#eventMonthDay')?.value);
      if (!Number.isInteger(repeat.monthDay) || repeat.monthDay < 1 || repeat.monthDay > 31) {
        toast('请填写 1–31 之间的日期', true); return null;
      }
    }
  }
  if (!title) { toast('事件名称不能为空', true); return null; }
  return { title, date, time, note, repeat };
}

function setEventException(exception) {
  state.eventExceptions = state.eventExceptions.filter((entry) => !(entry.eventId === exception.eventId && entry.date === exception.date));
  state.eventExceptions.push(exception);
}

async function saveEventDrawer() {
  const payload = readEventDrawerPayload();
  if (!payload) return;
  const editing = eventEditing;
  const saveBtn = $('#eventDrawerSave');
  if (saveBtn) saveBtn.disabled = true;
  try {
    let createdId = null;
    if (!editing) {
      // 新建（含从日历/固定安排进入的新建）
      const result = await api('POST', '/api/events', {
        title: payload.title, note: payload.note, time: payload.time,
        startDate: payload.date, repeat: payload.repeat,
      });
      state.events.push(result.event);
      createdId = result.event.id;
    } else if (editing.mode === 'single') {
      const result = await api('PUT', `/api/events/${editing.event.id}`, {
        title: payload.title, note: payload.note, time: payload.time,
        startDate: payload.date, repeat: payload.repeat,
      });
      Object.assign(editing.event, result.event);
    } else if (editing.mode === 'override') {
      // 仅修改本次：例外记录
      const result = await api('POST', '/api/event-exceptions', {
        eventId: editing.event.id, date: editing.date, type: 'override',
        changes: { title: payload.title, time: payload.time, note: payload.note },
      });
      setEventException(result.exception);
    } else if (editing.mode === 'split') {
      // 本次及以后：原规则在 date-1 结束，从 date 起新规则
      const ended = await api('PUT', `/api/events/${editing.event.id}`, { endDate: EventModel.addDays(editing.date, -1) });
      Object.assign(editing.event, ended.event);
      const result = await api('POST', '/api/events', {
        title: payload.title, note: payload.note, time: payload.time,
        startDate: editing.date, repeat: editing.event.repeat,
      });
      state.events.push(result.event);
      createdId = result.event.id;
    }
    closeEventDrawer();
    render();
    if (createdId) {
      requestAnimationFrame(() => {
        const row = $(`.event-row[data-key^="${createdId}@"], .memo-event-row[data-key^="${createdId}@"]`);
        if (row) {
          row.scrollIntoView({ block: 'center' });
          const focusTarget = row.querySelector('input[type="checkbox"], [data-action="open-event-menu"]');
          if (focusTarget) focusTarget.focus();
        }
      });
    }
  } catch (error) {
    toast(error.message, true);
    if (saveBtn) saveBtn.disabled = false;
  }
}

function openEventRangeModal({ eyebrow, title, options, confirmText = '确认', onConfirm }) {
  $('#modalEyebrow').textContent = eyebrow;
  $('#modalTitle').textContent = title;
  $('#modalBody').innerHTML = `<div class="range-options">
    ${options.map((option) => `<label class="range-option"><input type="radio" name="eventRange" value="${option.id}" ${option.checked ? 'checked' : ''} /><span>${escapeHtml(option.label)}</span></label>`).join('')}
  </div>`;
  $('#modalActions').innerHTML = '<button class="button ghost" data-modal-cancel>取消</button><button class="button primary" id="modalSubmit">' + escapeHtml(confirmText) + '</button>';
  $('#modalBackdrop').classList.remove('hidden');
  renderIcons();
  const submit = async () => {
    const value = $('input[name="eventRange"]:checked')?.value;
    if (!value) return;
    const btn = $('#modalSubmit');
    btn.disabled = true;
    try { await onConfirm(value); closeModal(); } catch (error) { toast(error.message, true); btn.disabled = false; }
  };
  $('#modalSubmit').onclick = submit;
  $('[data-modal-cancel]').onclick = closeModal;
}

function editEventInstance(key) {
  const [eventId, date] = key.split('@');
  const event = state.events.find((entry) => entry.id === eventId);
  if (!event) return;
  const repeatType = (event.repeat || {}).type;
  if (repeatType === 'none') {
    openEventDrawer({ event, date, mode: 'single' });
    return;
  }
  const dateText = dateLabel(date);
  openEventRangeModal({
    eyebrow: '修改范围',
    title: '修改「' + event.title + '」？',
    options: [
      { id: 'split', label: `修改${dateText}及以后的安排`, checked: true },
      { id: 'override', label: `仅修改${dateText}这一次` },
    ],
    confirmText: '继续编辑',
    onConfirm: async (mode) => {
      openEventDrawer({ event, date, mode });
    },
  });
}

function deleteEventInstance(key) {
  const [eventId, date] = key.split('@');
  const event = state.events.find((entry) => entry.id === eventId);
  if (!event) return;
  const repeatType = (event.repeat || {}).type;
  const dateText = dateLabel(date);
  const removeThis = async () => {
    try {
      if (repeatType === 'none') {
        const result = await api('POST', `/api/events/${event.id}/archive`, { effectiveDate: date });
        Object.assign(event, result.event);
      } else {
        const result = await api('POST', '/api/event-exceptions', { eventId: event.id, date, type: 'cancel', changes: {} });
        setEventException(result.exception);
      }
      render();
      toast('已删除这一次');
    } catch (error) { toast(error.message, true); }
  };
  if (repeatType === 'none') {
    openConfirmModal({ title: '删除这个事件？', message: `「${event.title}」将不再出现在日程中，此操作无法撤销。`, confirmText: '删除', onConfirm: removeThis });
    return;
  }
  openEventRangeModal({
    eyebrow: '删除范围',
    title: `删除「${event.title}」？`,
    options: [
      { id: 'this', label: `仅删除${dateText}这一次`, checked: true },
      { id: 'after', label: `删除${dateText}及以后的安排` },
    ],
    confirmText: '删除',
    onConfirm: async (scope) => {
      if (scope === 'this') {
        const result = await api('POST', '/api/event-exceptions', { eventId: event.id, date, type: 'cancel', changes: {} });
        setEventException(result.exception);
        render();
        toast('已删除这一次');
      } else {
        const result = await api('POST', `/api/events/${event.id}/archive`, { effectiveDate: date });
        Object.assign(event, result.event);
        render();
        toast('已删除这一天及以后的安排');
      }
    },
  });
}

async function deleteRecurring(eventId) {
  const event = state.events.find((entry) => entry.id === eventId);
  if (!event) return;
  openConfirmModal({ title: `删除「${event.title}」？`, message: '该固定安排将从今天起不再出现在日程中，过去的完成记录会保留。', confirmText: '删除固定安排', onConfirm: async () => {
    const result = await api('POST', `/api/events/${event.id}/archive`, { effectiveDate: localToday() });
    Object.assign(event, result.event);
    eventMenuKey = null;
    render();
  } });
}

async function toggleRecurring(eventId) {
  const event = state.events.find((entry) => entry.id === eventId);
  if (!event) return;
  try {
    const result = await api('PUT', `/api/events/${event.id}`, { enabled: !event.enabled });
    Object.assign(event, result.event);
    eventMenuKey = null;
    render();
    toast(result.event.enabled ? '已启用' : '已暂停');
  } catch (error) { toast(error.message, true); }
}

async function changeView(view, openTab) {
  if (currentView === 'thoughts' && thoughtSurface === 'editor' && isArticleMode() && !(await flushThoughtSave())) return;
  if (thoughtDraft && !hasThoughtContent(thoughtDraft)) thoughtDraft = null;
  currentView = view;
  if (view === 'thoughts') {
    thoughtSurface = 'history';
    selectedHistoryKey = null;
    thoughtHistoryFilter = 'all';
    thoughtHistoryCategory = 'all';
    thoughtHistoryQuery = '';
    historyListScroll = { app: 0, window: 0 };
  }
  if (openTab) currentPrincipleTab = openTab;
  planMenuOpenId = null;
  problemMenuOpenId = null;
  eventMenuKey = null;
  render();
  if (view === 'thoughts') {
    $('#app').scrollTop = 0;
    window.scrollTo(0, 0);
  }
  $('#app').focus({ preventScroll: true });
}

function bindGlobalEvents() {
  document.addEventListener('click', async (event) => {
    const drawerRoot = $('#eventDrawerRoot');
    if (drawerRoot && !drawerRoot.classList.contains('hidden') && event.target.id === 'eventDrawerRoot') {
      closeEventDrawer();
      return;
    }
    if (planMenuOpenId || problemMenuOpenId || eventMenuKey) {
      const onPlanMenu = event.target.closest('[data-plan-menu]') || event.target.closest('[data-action="open-plan-menu"]');
      const onProblemMenu = event.target.closest('[data-problem-menu]') || event.target.closest('[data-action="open-problem-menu"]');
      const onEventMenu = event.target.closest('[data-event-menu]') || event.target.closest('[data-action="open-event-menu"]');
      let dirty = false;
      if (planMenuOpenId && !onPlanMenu) { planMenuOpenId = null; dirty = true; }
      if (problemMenuOpenId && !onProblemMenu) { problemMenuOpenId = null; dirty = true; }
      if (eventMenuKey && !onEventMenu) { eventMenuKey = null; dirty = true; }
      if (dirty && (currentView === 'plans' || currentView === 'problems' || currentView === 'events')) render();
    }
    const nav = event.target.closest('[data-view]');
    if (nav) { await changeView(nav.dataset.view, nav.dataset.openTab); return; }
    const action = event.target.closest('[data-action]');
    if (action && !action.disabled) {
      try { await handleAction(action); } catch (error) { toast(error.message, true); }
    }
  });
  document.addEventListener('change', async (event) => {
    if (event.target.id === 'reviewDate' && event.target.value) {
      selectedReviewDate = event.target.value > localToday() ? localToday() : event.target.value;
      reviewHighlightItemId = null;
      reviewCompletedExpanded = false;
      render();
      return;
    }
    if (event.target.id === 'globalDate' && event.target.value) {
      if (currentView === 'thoughts' && isArticleMode() && !(await flushThoughtSave())) { render(); return; }
      selectedDate = event.target.value;
      focusItemId = null;
      thoughtSurface = 'editor';
      thoughtDraft = null;
      selectedThoughtId = null;
      render();
    }
  });
  document.addEventListener('input', (event) => {
    if (event.target.id !== 'reasonTimelineSearch') return;
    reasonTimelineQuery = event.target.value;
    const list = $('#reasonTimelineList');
    if (list) list.innerHTML = renderReasonTimelineList();
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      if ($('#reviewImageViewer').open) { $('#reviewImageViewer').close(); return; }
      const drawer = $('#eventDrawerRoot');
      if (drawer && !drawer.classList.contains('hidden')) { closeEventDrawer(); return; }
      if (!$('#modalBackdrop').classList.contains('hidden')) { closeModal(); return; }
    }
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    const tab = event.target.closest('.thought-tab');
    if (!tab) return;
    event.preventDefault();
    const tabs = $$('.thought-tab');
    const index = tabs.indexOf(tab);
    if (index < 0) return;
    const next = event.key === 'ArrowRight' ? (index + 1) % tabs.length : (index - 1 + tabs.length) % tabs.length;
    const mode = tabs[next].dataset.mode;
    tabs[next].click();
    $(`.thought-tab[data-mode="${mode}"]`)?.focus();
  });
  $('#modalClose').addEventListener('click', closeModal);
  $('#modalBackdrop').addEventListener('click', (event) => { if (event.target.id === 'modalBackdrop') closeModal(); });
  document.addEventListener('keydown', (event) => { if (event.key === 'Escape' && !$('#modalBackdrop').classList.contains('hidden')) closeModal(); });
  const saveWhenHidden = () => { if (document.hidden) void flushPendingSaves(); };
  document.addEventListener('visibilitychange', saveWhenHidden);
  window.addEventListener('pagehide', () => { void flushPendingSaves(); });
  window.addEventListener('beforeunload', (event) => {
    if (thinkTimer || thoughtSavePromise || thinkRetry || reviewUploadPromise || reviewUploadFailure || reflectTimer || reflectSavePromise || reflectRetry || planTimer || planSavePromise || planRetry) {
      void flushPendingSaves();
      event.preventDefault();
      event.returnValue = '';
    }
  });
}

async function init() {
  bindGlobalEvents();
  bindReviewViewer();
  renderTopbar();
  $('#app').innerHTML = emptyState('loader-circle', '正在准备你的生活管家', '数据只会从这台电脑读取。');
  renderIcons();
  try {
    const [result, backupResult] = await Promise.all([api('GET', '/api/state'), api('GET', '/api/backups')]);
    state = {
      version: result.version || 0,
      sections: result.sections || [],
      records: result.records || {},
      checkinReasons: result.checkinReasons || {},
      thoughtEntries: normalizeLoadedThoughts(result),
      thoughtCategories: result.thoughtCategories || [],
      reflectFrameworks: result.reflectFrameworks || [],
      reflectEntries: result.reflectEntries || {},
      plans: result.plans || [],
      problemTopics: result.problemTopics || [],
      events: result.events || [],
      eventCheckins: result.eventCheckins || {},
      eventExceptions: result.eventExceptions || [],
      backups: backupResult.backups || [],
    };
    selectedPlanId = state.plans[0]?.id || null;
    render();
  } catch (error) {
    $('#app').innerHTML = emptyState('triangle-alert', '数据加载失败', error.message, '<button class="button ghost" onclick="location.reload()">重新加载</button>');
    renderIcons();
  }
}

init();
