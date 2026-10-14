'use strict';

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

let state = {
  version: 0,
  sections: [], records: {}, checkinReasons: {}, thoughtEntries: [], thoughtCategories: [], reflectFrameworks: [], reflectEntries: {}, plans: [], templates: [], problems: [], learningCategories: [], learningTemplates: [],
  planCategories: [], templateCategories: [], problemCategories: [],
  coreThoughtCategories: [], coreThoughtTemplates: [], reviewTemplateCategories: [], reviewTemplates: [],
  events: [], eventCheckins: {}, eventExceptions: [], backups: [],
};
let currentView = 'events';                   // 业务模块 ID | 'settings' | null（当前界面无模块）
let currentWorkspace = 'main';                 // 'main' 当前界面 | 'zone' 专区界面
let dataEpoch = null;
let dataReloadRequired = false;
let settingsGeneration = 0;
let customCreation = null;
let customCreationPromise = null;
let navigationPreferences = null;              // 服务端规范的模块顺序/归属/最近视图
let trashedModuleIds = [];                    // 已进垃圾站的内置模块，不进入活动导航
let trashEntries = [];
let navigationContextQueue = Promise.resolve(); // 浏览记录请求串行化，旧响应不覆盖新状态
let contextFailureNotified = false;
let currentPrincipleTab = 'checkin';
let selectedDate = localToday();
let selectedReviewDate = addDays(localToday(), -1);
let dailyReviewFilter = 'all';
let reviewCompletedExpanded = false;
let reasonTimelineRange = '30';
let reasonTimelineQuery = '';
let reviewHighlightItemId = null;
let selectedPlanId = null;
let selectedTemplateId = null;
let focusItemId = null;
let toastTimer = null;
let thinkTimer = null;
let reflectTimer = null;
let planTimer = null;
let templateTimer = null;
let thoughtMode = 'free';                 // 'free' | 'review' | 'reflection'
let thoughtSurface = 'history';           // 默认记录列表；'editor' | 'history'
let selectedHistoryKey = null;            // 历史记录中当前打开的文章/反思 key
let historyListScroll = { app: 0, window: 0 }; // 从阅读页返回时恢复列表位置
let thoughtHistoryFilter = 'free';         // 'free' | 'review' | 'reflection' | 'extraction'
let thoughtHistoryCategory = { free: 'all', review: 'all', extraction: 'all' }; // 每种文章独立记忆类别筛选
let thoughtHistoryQuery = '';             // 历史搜索关键词
let selectedThoughtId = null;              // 当前编辑的自由思考 id，'draft' 为临时草稿
let thoughtDraft = null;                   // 尚未产生有效内容的客户端草稿
let thoughtSavePromise = null;             // 当前正在提交的自由思考请求
let reflectSavePromise = null;             // 当前正在提交的每日反思请求
let planSavePromise = null;               // 当前正在提交的计划请求
let templateSavePromise = null;           // 当前正在提交的模板请求
let thinkRetry = null;                     // 自由思考保存失败时的完整文章快照
let reflectRetry = null;                  // 每日反思保存失败时的重试快照
let planMenuOpenId = null;                // 计划列表“更多”菜单当前打开的计划 id
let templateMenuOpenId = null;            // 模板列表“更多”菜单当前打开的模板 id
let planRetry = null;                     // 计划保存失败时的重试快照
let templateRetry = null;                 // 模板保存失败时的重试快照
let selectedProblemId = null;              // 问题拆解当前选中的问题 id
let problemTimer = null;                  // 问题自动保存防抖计时器
let problemSavePromise = null;            // 当前正在提交的问题请求
let problemMenuOpenId = null;             // 问题列表“更多”菜单当前打开的问题 id
let problemRetry = null;                  // 问题保存失败时的重试快照
const flatCollectionRuntime = {
  plans: { categoryFilter: 'all', filterMenuOpen: false, moveMenuOpenId: null },
  templates: { categoryFilter: 'all', filterMenuOpen: false, moveMenuOpenId: null },
  problems: { categoryFilter: 'all', filterMenuOpen: false, moveMenuOpenId: null },
};
let eventDate = localToday();             // 事件安排独立日期（允许过去与未来）
let eventMode = 'schedule';               // 'schedule' | 'calendar' | 'recurring' | 'memos'
let eventCalendarCursor = null;           // 月历当前显示的 'YYYY-MM'
let eventMenuKey = null;                  // 事件“更多”菜单打开的实例键 'eventId@date'（固定安排页为事件 id）
let eventEditing = null;                  // 抽屉编辑上下文：null=新建；{ event, date }=编辑某次发生
let eventCreateDate = null;               // 从备忘事件页新建时，默认使用明天但不改变日程当前日期
let eventRecurringFilter = 'all';         // 固定安排筛选：'all' | 'daily' | 'weekly' | 'monthly'
let eventDoneCollapsed = false;           // 日程页已完成列表是否折叠
let eventNoteExpandedKey = null;          // 当前展开完整备注的事件实例键

// ---------- 模块注册表与界面导航 ----------

// 九个业务模块的稳定身份；设置、品牌与界面切换按钮为固定入口，不参与归属与排序
const BUILTIN_MODULE_REGISTRY = [
  { id: 'events', name: '重要时间点', icon: 'calendar-check', placement: 'main' },
  { id: 'principles', name: '原则打卡', icon: 'circle-play', placement: 'main' },
  { id: 'problems', name: '问题拆解', icon: 'folder-tree', placement: 'zone' },
  { id: 'plans', name: '计划', icon: 'calendar-days', placement: 'main' },
  { id: 'thoughts', name: '所思', icon: 'message-circle', placement: 'main' },
  { id: 'templates', name: '个人模板', icon: 'layout-template', placement: 'main' },
  { id: 'learning', name: '学习专区', icon: 'graduation-cap', placement: 'zone' },
  { id: 'coreThoughts', name: '核心思想', icon: 'lightbulb', placement: 'zone' },
  { id: 'reviewTemplates', name: '复盘', icon: 'history', placement: 'zone' },
];
let MODULE_REGISTRY = [...BUILTIN_MODULE_REGISTRY];
let MODULE_IDS = MODULE_REGISTRY.map((module) => module.id);
const WORKSPACE_LABELS = { main: '当前界面', zone: '专区界面' };

// 设置页草稿：进入设置时从已保存配置复制；拖动/箭头/位置切换只改草稿，保存时一次提交
let settingsDraft = null;                 // { moduleOrder: [], placementByModule: {} }
let settingsBaseRevision = 0;             // 进入设置时记录的配置 revision
let settingsDirty = false;                // 草稿是否与基线不同
let settingsSaving = null;                // 进行中的保存 Promise（防止重复提交）
let settingsStatus = { text: '', error: false };
let settingsReturn = null;                // 进入设置前所在的 { workspace, view }
let pendingNavigation = null;             // 草稿未保存时暂存的离开目标
let dataRestoreLock = false;              // 恢复备份期间禁止新的自动保存

function moduleById(id) { return MODULE_REGISTRY.find((module) => module.id === id) || null; }
function isModuleView(view) { return MODULE_IDS.includes(view); }

function placementOfModule(id) {
  const placement = navigationPreferences?.placementByModule?.[id];
  return placement === 'main' || placement === 'zone' ? placement : moduleById(id)?.placement || 'main';
}

function orderedModuleIds() {
  const order = navigationPreferences?.moduleOrder;
  if (!Array.isArray(order)) return [...MODULE_IDS];
  const known = order.filter((id) => isModuleView(id));
  for (const id of MODULE_IDS) if (!known.includes(id)) known.push(id);
  return known;
}

function workspaceModuleIds(workspace) {
  return orderedModuleIds().filter((id) => placementOfModule(id) === workspace);
}

// 目标界面的有效视图：优先上次访问且仍归属该界面的模块，否则第一项，空界面为 null
function resolveWorkspaceView(workspace, preferred) {
  const ids = workspaceModuleIds(workspace);
  if (preferred && ids.includes(preferred)) return preferred;
  return ids[0] || null;
}

function normalizeNavigationPreferences(raw) {
  const fallback = {
    schemaVersion: 1, revision: 0, moduleOrder: [...MODULE_IDS],
    placementByModule: Object.fromEntries(MODULE_REGISTRY.map((module) => [module.id, module.placement])),
    lastWorkspace: 'main', lastViewByWorkspace: { main: 'events', zone: 'problems' },
  };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return fallback;
  const order = Array.isArray(raw.moduleOrder)
    ? raw.moduleOrder.filter((id, index) => isModuleView(id) && raw.moduleOrder.indexOf(id) === index)
    : [];
  for (const id of MODULE_IDS) if (!order.includes(id)) order.push(id);
  const rawPlacement = raw.placementByModule && typeof raw.placementByModule === 'object' ? raw.placementByModule : {};
  const placement = {};
  for (const id of MODULE_IDS) {
    const value = rawPlacement[id];
    placement[id] = value === 'main' || value === 'zone' ? value : (moduleById(id)?.placement || 'main');
  }
  const lastWorkspace = raw.lastWorkspace === 'zone' ? 'zone' : 'main';
  const lastView = { main: null, zone: null };
  for (const ws of ['main', 'zone']) {
    const ids = order.filter((id) => placement[id] === ws);
    lastView[ws] = ids.includes(raw.lastViewByWorkspace?.[ws]) ? raw.lastViewByWorkspace[ws] : (ids[0] || null);
  }
  return {
    schemaVersion: 1,
    revision: Number.isInteger(raw.revision) && raw.revision >= 0 ? raw.revision : 0,
    moduleOrder: order,
    placementByModule: placement,
    lastWorkspace,
    lastViewByWorkspace: lastView,
  };
}

// 浏览记录：立即更新本地记忆并串行提交服务端；失败提示一次但不打断浏览
function recordNavigationContext(workspace, view) {
  if (!navigationPreferences) return;
  navigationPreferences.lastWorkspace = workspace;
  navigationPreferences.lastViewByWorkspace = { ...navigationPreferences.lastViewByWorkspace, [workspace]: view };
  navigationContextQueue = navigationContextQueue.then(async () => {
    try {
      await api('PATCH', '/api/navigation/context', { workspace, view });
    } catch (error) {
      if (!contextFailureNotified) {
        contextFailureNotified = true;
        toast(`浏览记录保存失败：${error.message}`, true);
      }
    }
  });
}

// ---------- 分类模板库（学习专区 / 核心思想 / 复盘共用） ----------

const LIBRARY_MODULES = {
  learning: {
    id: 'learning',
    eyebrow: '学习专区',
    listHint: '还没有学习模板。',
    filteredListHint: '这个分类还没有模板。',
    emptyTitle: '建立第一个学习模板',
    emptyBody: '把学习方法整理成模板，按分类随时取用。',
    newPlaceholder: '例如：学习模式、读书笔记模板',
    categoryPlaceholder: '例如：通用学习、编程开发、英语学习',
    templatesKey: 'learningTemplates',
    categoriesKey: 'learningCategories',
    apiCategories: '/api/learning-categories',
    apiTemplates: '/api/learning/templates',
    // 学习专区保留旧操作名（兼容既有使用习惯）；新模块统一 library-* 前缀并携带 data-library
    legacyActions: true,
    editor: { name: 'learningName', content: 'learningContent', note: 'learningNote', status: 'learningStatus' },
    editorIcon: 'graduation-cap',
  },
  coreThoughts: {
    id: 'coreThoughts',
    eyebrow: '核心思想',
    listHint: '还没有核心思想模板。',
    filteredListHint: '这个分类还没有模板。',
    emptyTitle: '建立第一个核心思想模板',
    emptyBody: '把反复出现的核心想法整理成模板，按领域随时取用。',
    newPlaceholder: '例如：第一性原理、长期主义',
    categoryPlaceholder: '例如：思维模型、价值观、决策原则',
    templatesKey: 'coreThoughtTemplates',
    categoriesKey: 'coreThoughtCategories',
    apiCategories: '/api/core-thought/categories',
    apiTemplates: '/api/core-thought/templates',
    legacyActions: false,
    editor: { name: 'libraryName', content: 'libraryContent', note: 'libraryNote', status: 'libraryStatus' },
    editorIcon: 'lightbulb',
  },
  reviewTemplates: {
    id: 'reviewTemplates',
    eyebrow: '复盘',
    listHint: '还没有复盘模板。',
    filteredListHint: '这个分类还没有模板。',
    emptyTitle: '建立第一个复盘模板',
    emptyBody: '把复盘框架整理成模板，按领域随时取用。',
    newPlaceholder: '例如：每日复盘、项目复盘',
    categoryPlaceholder: '例如：每日复盘、项目复盘、习惯养成',
    templatesKey: 'reviewTemplates',
    categoriesKey: 'reviewTemplateCategories',
    apiCategories: '/api/review-template/categories',
    apiTemplates: '/api/review-template/templates',
    legacyActions: false,
    editor: { name: 'libraryName', content: 'libraryContent', note: 'libraryNote', status: 'libraryStatus' },
    editorIcon: 'history',
  },
};

// 每个模块独立拥有选中模板、筛选、菜单、防抖计时器、请求与重试快照
const libraryRuntime = {};
function libraryState(moduleId) {
  if (!libraryRuntime[moduleId]) {
    libraryRuntime[moduleId] = {
      selectedId: null, timer: null, savePromise: null, retry: null,
      menuOpenId: null, filterMenuOpen: false, categoryFilter: 'all', moveMenuOpenId: null,
    };
  }
  return libraryRuntime[moduleId];
}

function libraryOwner(moduleId) {
  return LIBRARY_MODULES[moduleId]?.custom ? state.customModules.find((entry) => entry.id === moduleId) : state;
}
function libraryTemplates(moduleId) { return libraryOwner(moduleId)[LIBRARY_MODULES[moduleId].templatesKey]; }
function libraryCategories(moduleId) { return libraryOwner(moduleId)[LIBRARY_MODULES[moduleId].categoriesKey]; }
function setLibraryTemplates(moduleId, entries) { libraryOwner(moduleId)[LIBRARY_MODULES[moduleId].templatesKey] = entries; }
function setLibraryCategories(moduleId, entries) { libraryOwner(moduleId)[LIBRARY_MODULES[moduleId].categoriesKey] = entries; }

// 定义先安装、导航后规范化；已有库内容和保存runtime不被导航快照覆盖。
function installCustomModules(modules, replace = false) {
  CustomModuleModel.validate(modules, 1);
  const old = new Map((state.customModules || []).map((entry) => [entry.id, entry]));
  state.customModules = modules.map((entry) => {
    if (replace || !old.has(entry.id)) return entry;
    const local = old.get(entry.id);
    return { ...entry, categories: local.categories, templates: local.templates };
  });
  for (const id of Object.keys(LIBRARY_MODULES)) if (LIBRARY_MODULES[id].custom) delete LIBRARY_MODULES[id];
  MODULE_REGISTRY = [...BUILTIN_MODULE_REGISTRY.filter((entry) => !trashedModuleIds.includes(entry.id)), ...state.customModules.map((entry) => ({ id: entry.id, name: entry.name, icon: entry.icon, placement: entry.defaultPlacement }))];
  MODULE_IDS = MODULE_REGISTRY.map((entry) => entry.id);
  for (const entry of state.customModules) {
    LIBRARY_MODULES[entry.id] = {
      id: entry.id, custom: true, eyebrow: entry.name, listHint: '还没有模板。', filteredListHint: '这个分类还没有模板。',
      emptyTitle: '建立第一个模板', emptyBody: '按分类整理你的模板、内容和使用备注。',
      newPlaceholder: '例如：常用记录模板', categoryPlaceholder: '例如：通用、工作、生活',
      templatesKey: 'templates', categoriesKey: 'categories', apiCategories: `/api/custom-modules/${entry.id}/categories`,
      apiTemplates: `/api/custom-modules/${entry.id}/templates`, legacyActions: false,
      editor: { name: 'libraryName', content: 'libraryContent', note: 'libraryNote', status: 'libraryStatus' }, editorIcon: entry.icon,
    };
  }
}

function applyNavigationSnapshot(result, replace = false) {
  if (dataEpoch && result.dataEpoch && dataEpoch !== result.dataEpoch) { requireDataReload(); return false; }
  if (!replace && navigationPreferences && result.navigationPreferences.revision < navigationPreferences.revision) return false;
  if (Array.isArray(result.trashedModuleIds)) trashedModuleIds = result.trashedModuleIds;
  installCustomModules(result.customModules || [], replace);
  navigationPreferences = normalizeNavigationPreferences(result.navigationPreferences);
  dataEpoch = result.dataEpoch || dataEpoch;
  return true;
}

function requireDataReload() {
  dataReloadRequired = true;
  for (const rt of Object.values(libraryRuntime)) { clearTimeout(rt.timer); rt.timer = null; }
  const notice = $('#dataReloadNotice');
  notice.hidden = false;
  notice.querySelector('button').onclick = () => {
    if (confirm('数据已恢复或服务已重启。重新载入会放弃本页尚未保存的修改，请先复制需要保留的文字。是否重新载入？')) {
      dataRestoreLock = true; discardPendingLibrarySaves(); location.reload();
    }
  };
  toast('数据已变化，请保留未保存文字并确认重新载入', true);
}
function libraryCurrentTemplate(moduleId) {
  return libraryTemplates(moduleId).find((template) => template.id === libraryState(moduleId).selectedId) || null;
}

// 学习专区沿用旧操作名（保持既有兼容），新模块统一 library-* 前缀并携带 data-library
const LEGACY_LIBRARY_ACTIONS = {
  add: 'add-learning',
  select: 'select-learning',
  menu: 'open-learning-menu',
  move: 'move-learning',
  'delete': 'delete-learning',
  'retry-save': 'retry-learning-save',
  'add-category': 'add-learning-category',
  'rename-category': 'rename-learning-category',
  'delete-category': 'delete-learning-category',
  'set-filter': 'set-learning-filter',
  'toggle-filter': 'toggle-learning-filter',
  'open-category-manager': 'open-learning-category-manager',
};
function libraryActionName(moduleId, key) {
  return LIBRARY_MODULES[moduleId].legacyActions ? LEGACY_LIBRARY_ACTIONS[key] : `library-${key}`;
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[char]));
}

function richPreview(item, textKey, blocksKey, fallback) {
  const text = String(item?.[textKey] || '').trim();
  const drawings = LifeDrawings.searchText(item?.[blocksKey]);
  if (text || drawings) return [text, drawings].filter(Boolean).join(' · ');
  if (Array.isArray(item?.[blocksKey]) && item[blocksKey].some((block) => block?.type === 'image')) return '包含图片';
  return fallback;
}

function cloneRichBlocks(blocks) {
  return Array.isArray(blocks) ? blocks.map((block) => ({ ...block })) : undefined;
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
function forgetCheckinIds(ids) {
  const drop = new Set(ids);
  for (const bucket of [state.records, state.checkinReasons]) {
    for (const date of Object.keys(bucket || {})) {
      for (const id of drop) delete bucket[date][id];
      if (bucket[date] && !Object.keys(bucket[date]).length) delete bucket[date];
    }
  }
}
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
function currentTemplate() { return state.templates.find((template) => template.id === selectedTemplateId) || null; }
function currentProblem() { return state.problems.find((problem) => problem.id === selectedProblemId) || null; }

const FLAT_COLLECTIONS = {
  plans: {
    itemsKey: 'plans', categoriesKey: 'planCategories', itemLabel: '计划',
    listTitle: '全部计划', railLabel: '全部计划', emptyTitle: '建立第一个计划',
    emptyBody: '为一个真正想推进的方向写下名称和清楚的下一步。',
    addAction: 'add-plan', selectAction: 'select-plan', menuAction: 'open-plan-menu',
    reorderAction: 'move-plan', deleteAction: 'delete-plan',
    addEndpoint: '/api/plans', reorderEndpoint: '/api/plans/reorder', responseKey: 'plans',
  },
  templates: {
    itemsKey: 'templates', categoriesKey: 'templateCategories', itemLabel: '个人模板',
    listTitle: '全部模板', railLabel: '全部模板', emptyTitle: '建立第一个模板',
    emptyBody: '把常用的内容整理成模板，需要时直接取用。',
    addAction: 'add-template', selectAction: 'select-template', menuAction: 'open-template-menu',
    reorderAction: 'move-template', deleteAction: 'delete-template',
    addEndpoint: '/api/templates', reorderEndpoint: '/api/templates/reorder', responseKey: 'templates',
  },
  problems: {
    itemsKey: 'problems', categoriesKey: 'problemCategories', itemLabel: '问题拆解',
    listTitle: '全部问题', railLabel: '全部问题', emptyTitle: '建立第一个问题',
    emptyBody: '把一个反复出现的大问题写下来，拆成看得清的小步骤。',
    addAction: 'add-problem', selectAction: 'select-problem', menuAction: 'open-problem-menu',
    reorderAction: 'move-problem', deleteAction: 'delete-problem',
    addEndpoint: '/api/problems', reorderEndpoint: '/api/problems/reorder', responseKey: 'problems',
  },
};

function flatConfig(collection) { return FLAT_COLLECTIONS[collection]; }
function flatState(collection) { return flatCollectionRuntime[collection]; }
function flatCategories(collection) { return state[flatConfig(collection).categoriesKey] || []; }
function flatItems(collection) { return state[flatConfig(collection).itemsKey] || []; }
function flatSelectedId(collection) {
  return collection === 'plans' ? selectedPlanId : collection === 'templates' ? selectedTemplateId : selectedProblemId;
}
function setFlatSelectedId(collection, id) {
  if (collection === 'plans') selectedPlanId = id;
  else if (collection === 'templates') selectedTemplateId = id;
  else selectedProblemId = id;
}
function flatItemsForFilter(collection) {
  const rt = flatState(collection);
  const items = flatItems(collection), categories = flatCategories(collection);
  if (rt.categoryFilter === 'all') return items;
  if (rt.categoryFilter === 'none') return items.filter((item) => !item.categoryId || !categories.some((category) => category.id === item.categoryId));
  return items.filter((item) => item.categoryId === rt.categoryFilter);
}
function flatCategoryCount(collection, categoryId) {
  const items = flatItems(collection), categories = flatCategories(collection);
  if (categoryId === 'all') return items.length;
  if (categoryId === 'none') return items.filter((item) => !item.categoryId || !categories.some((category) => category.id === item.categoryId)).length;
  return items.filter((item) => item.categoryId === categoryId).length;
}
function flatFilterLabel(collection) {
  const rt = flatState(collection);
  if (rt.categoryFilter === 'all') return '全部分类';
  if (rt.categoryFilter === 'none') return '未分类';
  return flatCategories(collection).find((category) => category.id === rt.categoryFilter)?.name || '全部分类';
}
function flatAction(collection, action) { return `flat-${action}`; }

function renderFlatToolbar(collection) {
  const config = flatConfig(collection), rt = flatState(collection);
  const rows = [
    { id: 'all', name: '全部分类' },
    ...flatCategories(collection).map((category) => ({ id: category.id, name: category.name })),
    { id: 'none', name: '未分类' },
  ];
  return `<div class="learning-toolbar flat-toolbar" data-flat-collection="${collection}">
    <button class="button primary small" data-action="${config.addAction}"><i data-lucide="plus"></i>新建${config.itemLabel === '问题拆解' ? '问题' : config.itemLabel === '个人模板' ? '模板' : '计划'}</button>
    <div class="learning-filter-wrap">
      <button class="learning-filter-btn ${rt.filterMenuOpen ? 'open' : ''}" data-action="${flatAction(collection, 'toggle-filter')}" data-collection="${collection}" aria-haspopup="menu" aria-expanded="${rt.filterMenuOpen}">
        <i data-lucide="folder"></i><span>${escapeHtml(flatFilterLabel(collection))}</span><i data-lucide="chevron-down"></i>
      </button>
      ${rt.filterMenuOpen ? `<div class="plan-menu learning-filter-menu" data-flat-filter-menu="${collection}" role="menu" aria-label="按分类筛选">
        ${rows.map((row) => `<button class="plan-menu-item ${rt.categoryFilter === row.id ? 'active' : ''}" role="menuitem" data-action="${flatAction(collection, 'set-filter')}" data-collection="${collection}" data-filter="${escapeHtml(row.id)}"><span class="learning-filter-name">${escapeHtml(row.name)}</span><span class="learning-filter-count">${flatCategoryCount(collection, row.id)}</span></button>`).join('')}
        <div class="learning-filter-sep" role="separator"></div>
        <button class="plan-menu-item" role="menuitem" data-action="${flatAction(collection, 'open-category-manager')}" data-collection="${collection}"><i data-lucide="settings-2"></i>管理分类</button>
      </div>` : ''}
    </div>
    <button class="button teal small" data-action="${flatAction(collection, 'add-category')}" data-collection="${collection}"><i data-lucide="plus"></i>新建分类</button>
  </div>`;
}

function renderFlatMoveSubmenu(collection, item) {
  const rt = flatState(collection);
  if (rt.moveMenuOpenId !== item.id) return '';
  const current = item.categoryId || 'none';
  const rows = [{ id: 'none', name: '未分类' }, ...flatCategories(collection).map((category) => ({ id: category.id, name: category.name }))];
  return `<div class="flat-category-submenu" data-flat-move-menu="${collection}" role="menu" aria-label="移动到分类">
    <div class="flat-category-submenu-title">移动到分类</div>
    ${rows.map((row) => `<button class="plan-menu-item ${current === row.id ? 'active' : ''}" role="menuitem" data-action="${flatAction(collection, 'move-category')}" data-collection="${collection}" data-id="${item.id}" data-category-id="${escapeHtml(row.id)}"><span class="learning-filter-name">${escapeHtml(row.name)}</span>${current === row.id ? '<span aria-hidden="true">✓</span>' : ''}</button>`).join('')}
  </div>`;
}

function renderFlatCategoryManager(collection) {
  const config = flatConfig(collection), categories = flatCategories(collection);
  $('#modalEyebrow').textContent = `${config.itemLabel} · 分类`;
  $('#modalTitle').textContent = '管理分类';
  $('#modalBody').innerHTML = `<div class="thought-category-manager">
    <div class="thought-category-row system"><span>未分类</span><small>系统分类</small></div>
    ${categories.length ? categories.map((category) => `<div class="thought-category-row"><span>${escapeHtml(category.name)}</span><div class="row-actions"><button class="mini-button" data-action="${flatAction(collection, 'rename-category')}" data-collection="${collection}" data-id="${category.id}" aria-label="重命名分类${escapeHtml(category.name)}"><i data-lucide="pencil"></i></button><button class="mini-button danger" data-action="${flatAction(collection, 'delete-category')}" data-collection="${collection}" data-id="${category.id}" aria-label="删除分类${escapeHtml(category.name)}"><i data-lucide="trash-2"></i></button></div></div>`).join('') : '<p class="status-text">还没有自定义分类。</p>'}
  </div>`;
  $('#modalActions').innerHTML = `<button class="button ghost" data-modal-cancel>关闭</button><button class="button primary" data-action="${flatAction(collection, 'add-category')}" data-collection="${collection}"><i data-lucide="plus"></i>新建分类</button>`;
  $('#modalBackdrop').classList.remove('hidden');
  $('[data-modal-cancel]').onclick = closeModal;
  renderIcons();
}

async function api(method, url, body) {
  const options = { method, headers: {} };
  const guarded = method !== 'GET';
  if (guarded) {
    if (dataReloadRequired) throw Object.assign(new Error('数据已变化，请确认重新载入'), { code: 'DATA_EPOCH_CHANGED' });
    options.headers['X-Life-Data-Epoch'] = dataEpoch;
  }
  if (body !== undefined) {
    options.headers['Content-Type'] = 'application/json';
    options.body = JSON.stringify(body);
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20000);
  let response, data = null;
  try {
    response = await fetch(url, { ...options, signal: controller.signal });
    try { data = await response.json(); } catch (error) {
      if (controller.signal.aborted) throw error;
      if (response.ok) throw new Error('响应内容不完整，请确认操作结果');
    }
  } finally { clearTimeout(timeout); }
  if (!response.ok) {
    const error = new Error(data?.error || `请求失败（${response.status}）`);
    error.status = response.status;
    error.code = data?.code;
    error.commitState = data?.commitState;
    error.snapshot = data;
    if (error.code === 'DATA_EPOCH_CHANGED') requireDataReload();
    if (data && typeof data === 'object' && data.navigationPreferences) error.navigationPreferences = data.navigationPreferences;
    throw error;
  }
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
    button.classList.toggle('active', button.dataset.view === currentView);
  });
}

// 侧栏由模块注册表 + 用户配置生成：只显示分配给当前界面的模块，顺序取全局排序
function renderSidebarNav() {
  const items = workspaceModuleIds(currentWorkspace)
    .map((id) => moduleById(id))
    .filter(Boolean);
  $('#primaryNav').innerHTML = items
    .map((module) => `<button class="nav-item ${module.id === currentView ? 'active' : ''}" data-view="${module.id}" title="${escapeHtml(module.name)}"><i data-lucide="${module.icon}"></i><span>${escapeHtml(module.name)}</span></button>`)
    .join('');
  const switchButton = $('#workspaceSwitch');
  if (switchButton) {
    const toZone = currentWorkspace === 'main';
    switchButton.dataset.workspace = toZone ? 'zone' : 'main';
    switchButton.setAttribute('aria-label', toZone ? '进入专区' : '返回当前界面');
    switchButton.innerHTML = toZone
      ? '<i data-lucide="layout-grid"></i><span>进入专区</span><i data-lucide="arrow-right"></i>'
      : '<i data-lucide="arrow-left"></i><span>返回当前界面</span>';
  }
}

function renderTopbar() {
  const titles = {
    events: ['重要时间点', '把固定节奏与临时安排放进清晰的一天。'],
    principles: ['原则打卡', '用清楚的原则指导每天的行动。'],
    thoughts: ['所思', '记录想法，也给一天留出复盘的空间。'],
    plans: ['计划', '让长期方向始终落到清楚的下一步。'],
    templates: ['个人模板', '把常用的内容整理成模板，需要时直接取用。'],
    problems: ['问题拆解', '把大问题拆成小步骤，看清下一步能做什么。'],
    learning: ['学习专区', '按学习领域和主题分类管理你的学习模板。'],
    coreThoughts: ['核心思想', '按思想领域和主题分类管理你的核心思想模板。'],
    reviewTemplates: ['复盘', '按复盘领域和主题分类管理你的复盘模板。'],
    settings: ['设置', '管理模块的显示位置和排列顺序。'],
    drawingManager: ['画布管理', '所有画布，集中整理与快速打开。'],
  };
  const [title, subtitle] = currentView === null
    ? [WORKSPACE_LABELS[currentWorkspace], '此界面还没有分配模块，可以在设置中调整。']
    : titles[currentView] || [moduleById(currentView)?.name || '模块', '按分类管理你的模板、内容和使用备注。'];
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
  renderSidebarNav();
  setActiveNavigation();
  renderTopbar();
  if (currentView === 'drawingManager') DrawingManagerUI.render();
  else if (currentView === 'settings') renderSettingsPage();
  else if (currentView === null) renderEmptyWorkspace();
  else if (LIBRARY_MODULES[currentView]) renderLibraryPage(currentView);
  else if (currentView === 'events') renderEvents();
  else if (currentView === 'principles') renderPrinciples();
  else if (currentView === 'thoughts') renderThoughts();
  else if (currentView === 'plans') renderPlans();
  else if (currentView === 'templates') renderTemplates();
  else if (currentView === 'problems') renderProblems();
  renderIcons();
  bindRichEditors();
  bindRichViewer();
  LifeDrawings.renderTabs();
}

// 当前界面没有任何模块时的空状态：切换入口与设置仍可用
function renderEmptyWorkspace() {
  $('#app').innerHTML = `<section class="page content-page">
    ${emptyState('layout-grid', `${WORKSPACE_LABELS[currentWorkspace]}还没有模块`, '所有模块都放在另一个界面。可以在设置中调整模块归属，或用左侧按钮切换界面。', `<button class="button primary" data-action="open-settings"><i data-lucide="settings"></i>前往设置</button>`)}
  </section>`;
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
    ? state.backups.map((backup) => `<li><div><strong>${new Date(backup.createdAt).toLocaleString('zh-CN', { hour12: false })}</strong><small>${backup.imageCount ? `包含 ${backup.imageCount} 张复盘图片` : '不含复盘图片'} · ${backup.drawingCount || 0} 张图稿${backup.label === 'before-restore' ? ' · 恢复前自动保存' : ''}</small></div><button class="button ghost small" data-action="restore-backup" data-id="${backup.id}"><i data-lucide="history"></i>恢复</button></li>`).join('')
    : '<p class="status-text">还没有备份。</p>';
  return `<div class="manage-grid">${sections}
    <section class="manage-section data-management">
      <div class="manage-section-head"><div><h3>数据备份</h3><p>备份会保存在这台电脑，包含所有记录、复盘图片、图稿、垃圾站及绘图素材库。</p></div><button class="button ghost small" data-action="create-backup"><i data-lucide="archive"></i>立即备份</button></div>
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
  return kind === 'free' || kind === 'review' || kind === 'extraction';
}

function thoughtKind(thought) {
  return ['review', 'extraction'].includes(thought?.kind) ? thought.kind : 'free';
}

function thoughtKindLabel(kind) {
  return kind === 'review' ? '每日复盘' : kind === 'reflection' ? '每日反思' : kind === 'extraction' ? '思想提取' : '自由思考';
}

function thoughtNoun(thought) {
  const kind = thoughtKind(thought);
  return kind === 'review' ? '复盘' : kind === 'extraction' ? '提取' : '思考';
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

function thoughtCategoriesForKind(kind) {
  return state.thoughtCategories.filter((category) => category.kind === kind);
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
    <button class="thought-tab ${thoughtMode === 'extraction' ? 'active' : ''}" role="tab" id="thoughtTabExtraction" aria-selected="${thoughtMode === 'extraction'}" aria-controls="thoughtPanel" data-action="switch-thought-mode" data-mode="extraction">思想提取</button>
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
    ${thought ? renderThoughtEditorCard(thought) : emptyState('notebook-pen', `这一天还没有${label}`, '可以新建一篇，或返回记录列表查看其他文章。', `<button class="button primary small" data-action="${thoughtMode === 'review' ? 'new-review' : thoughtMode === 'extraction' ? 'new-extraction' : 'new-thought'}"><i data-lucide="plus"></i>新建${thoughtMode === 'review' ? '复盘' : thoughtMode === 'extraction' ? '提取' : '思考'}</button>`)}
  </section>`;
}

function renderThoughtEditorCard(thought) {
  const label = thoughtKindLabel(thoughtKind(thought));
  const options = thoughtCategoriesForKind(thoughtKind(thought)).map((category) => `<option value="${category.id}" ${thought.categoryId === category.id ? 'selected' : ''}>${escapeHtml(category.name)}</option>`).join('');
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
    ${state.version >= 8 ? renderReviewEditor(thought) : `<textarea class="textarea free-thought" id="thoughtEditor" placeholder="${thoughtKind(thought) === 'review' ? '回顾今天：发生了什么、有哪些收获、明天想怎样改进……' : thoughtKind(thought) === 'extraction' ? '从文章、对话或笔记里摘出关键思想，写下出处和自己的理解……' : '此刻在想什么？写下今天的想法、灵感或目标……'}" aria-label="${label}内容">${escapeHtml(thought.text || '')}</textarea>`}
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
      preview: getThoughtPreview([entry.text, LifeDrawings.searchText(entry.blocks)].filter(Boolean).join(' · ')) || (reviewImages(entry).length ? `${reviewImages(entry).length} 张图片` : ''), sortStamp: entry.updatedAt || entry.createdAt || entry.date,
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
  const categoryFilter = isArticleMode(thoughtHistoryFilter) ? thoughtHistoryCategory[thoughtHistoryFilter] : 'all';
  return records.filter((record) => {
    if (thoughtHistoryFilter !== 'all' && record.kind !== thoughtHistoryFilter) return false;
    if (categoryFilter !== 'all') {
      if (!isArticleMode(record.kind)) return false;
      if (categoryFilter === 'uncategorized' && record.categoryId) return false;
      if (categoryFilter !== 'uncategorized' && record.categoryId !== categoryFilter) return false;
    }
    if (query) {
      const haystack = [
        dateLabel(record.date),
        record.date,
        record.title,
        isArticleMode(record.kind) ? record.thought.text : '',
        isArticleMode(record.kind) ? thoughtCategoryName(record.categoryId) : '',
        ...reviewImages(record.thought).map((block) => block.caption),
        LifeDrawings.searchText(record.thought?.blocks),
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
      <button class="button ghost small" data-action="new-extraction"><i data-lucide="highlighter"></i>新建提取</button>
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

  const showCategoryFilter = isArticleMode(thoughtHistoryFilter);
  const activeCategory = showCategoryFilter ? thoughtHistoryCategory[thoughtHistoryFilter] : 'all';
  const categoryOptions = showCategoryFilter
    ? thoughtCategoriesForKind(thoughtHistoryFilter).map((category) => `<option value="${category.id}" ${activeCategory === category.id ? 'selected' : ''}>${escapeHtml(category.name)}</option>`).join('')
    : '';
  return `<section class="page content-page thoughts-page">
    ${renderThoughtHistoryHeader()}
    <div class="history-filter">
      <div class="history-type-filter" role="group" aria-label="按类型筛选记录">
        <button class="history-filter-chip ${thoughtHistoryFilter === 'free' ? 'active' : ''}" data-action="filter-thought-history" data-filter="free" aria-pressed="${thoughtHistoryFilter === 'free'}">自由思考</button>
        <button class="history-filter-chip ${thoughtHistoryFilter === 'review' ? 'active' : ''}" data-action="filter-thought-history" data-filter="review" aria-pressed="${thoughtHistoryFilter === 'review'}">每日复盘</button>
        <button class="history-filter-chip ${thoughtHistoryFilter === 'reflection' ? 'active' : ''}" data-action="filter-thought-history" data-filter="reflection" aria-pressed="${thoughtHistoryFilter === 'reflection'}">每日反思</button>
        <button class="history-filter-chip ${thoughtHistoryFilter === 'extraction' ? 'active' : ''}" data-action="filter-thought-history" data-filter="extraction" aria-pressed="${thoughtHistoryFilter === 'extraction'}">思想提取</button>
      </div>
      ${showCategoryFilter ? `<select class="input history-category-filter" id="historyCategoryFilter" aria-label="按${thoughtKindLabel(thoughtHistoryFilter)}类别筛选">
        <option value="all" ${activeCategory === 'all' ? 'selected' : ''}>全部类别</option>
        <option value="uncategorized" ${activeCategory === 'uncategorized' ? 'selected' : ''}>未分类</option>
        ${categoryOptions}
      </select>` : ''}
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
      ${record.thought.blocks?.some((b) => b.type !== 'text') ? renderReviewDocument(record.thought) : `<div class="history-text">${record.thought.text ? escapeHtml(record.thought.text) : `<span class="history-qa-empty">这篇${thoughtNoun(record.thought)}还没有正文。</span>`}</div>`}
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
    if (isArticleMode(thoughtHistoryFilter)) thoughtHistoryCategory[thoughtHistoryFilter] = event.target.value;
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
  const visible = flatItemsForFilter('plans');
  if (!visible.some((item) => item.id === selectedPlanId)) selectedPlanId = visible[0]?.id || null;
  const plan = currentPlan();
  $('#app').innerHTML = `<section class="page content-page plans-page">
    ${renderFlatToolbar('plans')}
    <aside class="plan-rail" aria-label="全部计划">
      <div class="plan-rail-head">
        <div class="plan-rail-title"><h2>全部计划</h2><span class="plan-count">${state.plans.length} 个</span></div>
        <button class="button primary small plan-new" data-action="add-plan"><i data-lucide="plus"></i>新建计划</button>
      </div>
      <div class="plan-list">
        ${visible.length ? visible.map((item, index) => planListItem(item, index, visible)).join('') : '<p class="status-text plan-empty-hint">当前分类还没有计划。</p>'}
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

function planListItem(item, index, visible = state.plans) {
  const open = planMenuOpenId === item.id;
  const preview = richPreview(item, 'description', 'descriptionBlocks', '尚未设置下一步');
  const active = item.id === selectedPlanId;
  const category = flatCategories('plans').find((entry) => entry.id === item.categoryId);
  return `<div class="plan-list-row ${active ? 'active' : ''}" data-id="${item.id}">
    <button class="plan-select" data-action="select-plan" data-id="${item.id}" aria-label="选择计划「${escapeHtml(item.name)}」">
      <span class="plan-name">${escapeHtml(item.name || '未命名计划')}</span>
      <span class="plan-preview">${escapeHtml(preview)}</span>
      <span class="flat-category-label">${escapeHtml(category?.name || '未分类')}</span>
    </button>
    <div class="plan-more-wrap">
      <button class="plan-more" data-action="open-plan-menu" data-id="${item.id}" aria-label="「${escapeHtml(item.name || '未命名计划')}」的更多操作" aria-expanded="${open}" aria-haspopup="menu"><i data-lucide="more-horizontal"></i></button>
      ${open ? `<div class="plan-menu" data-plan-menu role="menu" aria-label="计划操作">
        <button class="plan-menu-item" role="menuitem" data-action="move-plan" data-id="${item.id}" data-dir="up" ${index === 0 ? 'disabled' : ''}><i data-lucide="arrow-up"></i>上移</button>
        <button class="plan-menu-item" role="menuitem" data-action="move-plan" data-id="${item.id}" data-dir="down" ${index === visible.length - 1 ? 'disabled' : ''}><i data-lucide="arrow-down"></i>下移</button>
        <button class="plan-menu-item" role="menuitem" data-action="flat-open-move-menu" data-collection="plans" data-id="${item.id}" aria-haspopup="menu" aria-expanded="${flatState('plans').moveMenuOpenId === item.id}"><i data-lucide="folder-output"></i>移动到分类</button>
        ${renderFlatMoveSubmenu('plans', item)}
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
      ${richEditorMarkup({ key: `plan:${plan.id}:description`, legacyId: 'planDescription', legacyClass: 'plan-next-step', getItem: () => plan, blocksKey: 'descriptionBlocks', textKey: 'description', label: '具体计划', placeholder: '例如：周五前整理第一版方案，并发给对方确认。', onChange: () => { schedulePlanSave(); syncPlanListRow(plan.id); } })}
    </section>
    <section class="plan-field note-field">
      <div class="plan-field-head">
        <label for="planNote">计划笔记</label>
      </div>
      ${richEditorMarkup({ key: `plan:${plan.id}:note`, legacyId: 'planNote', legacyClass: 'plan-note', getItem: () => plan, blocksKey: 'noteBlocks', textKey: 'note', label: '计划笔记', placeholder: '记录想法、进展、材料和复盘……', onChange: () => { schedulePlanSave(); syncPlanListRow(plan.id); } })}
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
  if (previewEl) previewEl.textContent = richPreview(plan, 'description', 'descriptionBlocks', '尚未设置下一步');
}

// ---------- 个人模板 ----------

function renderTemplates() {
  const visible = flatItemsForFilter('templates');
  if (!visible.some((item) => item.id === selectedTemplateId)) selectedTemplateId = visible[0]?.id || null;
  const template = currentTemplate();
  $('#app').innerHTML = `<section class="page content-page plans-page">
    ${renderFlatToolbar('templates')}
    <aside class="plan-rail" aria-label="全部模板">
      <div class="plan-rail-head">
        <div class="plan-rail-title"><h2>全部模板</h2><span class="plan-count">${state.templates.length} 个</span></div>
        <button class="button primary small plan-new" data-action="add-template"><i data-lucide="plus"></i>新建模板</button>
      </div>
      <div class="plan-list">
        ${visible.length ? visible.map((item, index) => templateListItem(item, index, visible)).join('') : '<p class="status-text plan-empty-hint">当前分类还没有模板。</p>'}
      </div>
    </aside>
    <div class="plan-workspace">
      ${template ? renderTemplateEditor(template) : emptyState('layout-template', '建立第一个模板', '把常用的内容整理成模板，需要时直接取用。', '<button class="button primary" data-action="add-template"><i data-lucide="plus"></i>新建模板</button>')}
    </div>
  </section>`;
  $$('.template-editor').forEach((editor) => editor.addEventListener('input', () => {
    scheduleTemplateSave();
    syncTemplateListRow(selectedTemplateId);
  }));
}

function templateListItem(item, index, visible = state.templates) {
  const open = templateMenuOpenId === item.id;
  const preview = richPreview(item, 'content', 'contentBlocks', '还没有内容');
  const active = item.id === selectedTemplateId;
  const category = flatCategories('templates').find((entry) => entry.id === item.categoryId);
  return `<div class="plan-list-row ${active ? 'active' : ''}" data-id="${item.id}">
    <button class="plan-select" data-action="select-template" data-id="${item.id}" aria-label="选择模板「${escapeHtml(item.name)}」">
      <span class="plan-name">${escapeHtml(item.name || '未命名模板')}</span>
      <span class="plan-preview">${escapeHtml(preview)}</span>
      <span class="flat-category-label">${escapeHtml(category?.name || '未分类')}</span>
    </button>
    <div class="plan-more-wrap">
      <button class="plan-more" data-action="open-template-menu" data-id="${item.id}" aria-label="「${escapeHtml(item.name || '未命名模板')}」的更多操作" aria-expanded="${open}" aria-haspopup="menu"><i data-lucide="more-horizontal"></i></button>
      ${open ? `<div class="plan-menu" data-template-menu role="menu" aria-label="模板操作">
        <button class="plan-menu-item" role="menuitem" data-action="move-template" data-id="${item.id}" data-dir="up" ${index === 0 ? 'disabled' : ''}><i data-lucide="arrow-up"></i>上移</button>
        <button class="plan-menu-item" role="menuitem" data-action="move-template" data-id="${item.id}" data-dir="down" ${index === visible.length - 1 ? 'disabled' : ''}><i data-lucide="arrow-down"></i>下移</button>
        <button class="plan-menu-item" role="menuitem" data-action="flat-open-move-menu" data-collection="templates" data-id="${item.id}" aria-haspopup="menu" aria-expanded="${flatState('templates').moveMenuOpenId === item.id}"><i data-lucide="folder-output"></i>移动到分类</button>
        ${renderFlatMoveSubmenu('templates', item)}
        <button class="plan-menu-item danger" role="menuitem" data-action="delete-template" data-id="${item.id}"><i data-lucide="trash-2"></i>删除模板</button>
      </div>` : ''}
    </div>
  </div>`;
}

function renderTemplateEditor(template) {
  return `<section class="plan-workspace-panel" aria-label="当前模板编辑器">
    <div class="plan-title-row">
      <input class="plan-name-input template-editor" id="templateName" value="${escapeHtml(template.name)}" aria-label="模板名称" placeholder="模板名称" />
      <span class="plan-save" id="templateStatus" role="status" aria-live="polite" data-action="retry-template-save">已保存</span>
    </div>
    <section class="plan-field next-step-field">
      <div class="plan-field-head">
        <label for="templateContent">模板内容</label>
      </div>
      ${richEditorMarkup({ key: `template:${template.id}:content`, legacyId: 'templateContent', legacyClass: 'plan-next-step', getItem: () => template, blocksKey: 'contentBlocks', textKey: 'content', label: '模板内容', placeholder: '写下这份模板的固定内容，例如周报结构、复盘框架、常用话术……', onChange: () => { scheduleTemplateSave(); syncTemplateListRow(template.id); } })}
    </section>
    <section class="plan-field note-field">
      <div class="plan-field-head">
        <label for="templateNote">使用备注</label>
      </div>
      ${richEditorMarkup({ key: `template:${template.id}:note`, legacyId: 'templateNote', legacyClass: 'plan-note', getItem: () => template, blocksKey: 'noteBlocks', textKey: 'note', label: '使用备注', placeholder: '记录适用场景、使用方法或维护心得……', onChange: () => { scheduleTemplateSave(); syncTemplateListRow(template.id); } })}
    </section>
  </section>`;
}

function setTemplateStatus(text, isError = false) {
  const el = $('#templateStatus');
  if (!el) return;
  el.textContent = text;
  el.classList.toggle('save-error', isError);
}

function syncTemplateListRow(templateId) {
  const template = state.templates.find((entry) => entry.id === templateId);
  const row = $(`.plan-list-row[data-id="${templateId}"]`);
  if (!template || !row) return;
  const nameEl = row.querySelector('.plan-name');
  const previewEl = row.querySelector('.plan-preview');
  if (nameEl) nameEl.textContent = template.name || '未命名模板';
  if (previewEl) previewEl.textContent = richPreview(template, 'content', 'contentBlocks', '还没有内容');
}

// ---------- 问题拆解 ----------

function renderProblems() {
  const visible = flatItemsForFilter('problems');
  if (!visible.some((item) => item.id === selectedProblemId)) selectedProblemId = visible[0]?.id || null;
  const problem = currentProblem();
  $('#app').innerHTML = `<section class="page content-page plans-page">
    ${renderFlatToolbar('problems')}
    <aside class="plan-rail" aria-label="全部问题">
      <div class="plan-rail-head">
        <div class="plan-rail-title"><h2>全部问题</h2><span class="plan-count">${state.problems.length} 个</span></div>
        <button class="button primary small plan-new" data-action="add-problem"><i data-lucide="plus"></i>新建问题</button>
      </div>
      <div class="plan-list">
        ${visible.length ? visible.map((item, index) => problemListItem(item, index, visible)).join('') : '<p class="status-text plan-empty-hint">当前分类还没有问题。</p>'}
      </div>
    </aside>
    <div class="plan-workspace">
      ${problem ? renderProblemEditor(problem) : emptyState('folder-tree', '建立第一个问题', '把一个反复出现的大问题写下来，拆成看得清的小步骤。', '<button class="button primary" data-action="add-problem"><i data-lucide="plus"></i>新建问题</button>')}
    </div>
  </section>`;
  $$('.problem-editor').forEach((editor) => editor.addEventListener('input', () => {
    scheduleProblemSave();
    syncProblemListRow(selectedProblemId);
  }));
}

function problemListItem(item, index, visible = state.problems) {
  const open = problemMenuOpenId === item.id;
  const preview = richPreview(item, 'content', 'contentBlocks', '还没有内容');
  const active = item.id === selectedProblemId;
  const category = flatCategories('problems').find((entry) => entry.id === item.categoryId);
  return `<div class="plan-list-row ${active ? 'active' : ''}" data-id="${item.id}">
    <button class="plan-select" data-action="select-problem" data-id="${item.id}" aria-label="选择问题「${escapeHtml(item.name)}」">
      <span class="plan-name">${escapeHtml(item.name || '未命名问题')}</span>
      <span class="plan-preview">${escapeHtml(preview)}</span>
      <span class="flat-category-label">${escapeHtml(category?.name || '未分类')}</span>
    </button>
    <div class="plan-more-wrap">
      <button class="plan-more" data-action="open-problem-menu" data-id="${item.id}" aria-label="「${escapeHtml(item.name || '未命名问题')}」的更多操作" aria-expanded="${open}" aria-haspopup="menu"><i data-lucide="more-horizontal"></i></button>
      ${open ? `<div class="plan-menu" data-problem-menu role="menu" aria-label="问题操作">
        <button class="plan-menu-item" role="menuitem" data-action="move-problem" data-id="${item.id}" data-dir="up" ${index === 0 ? 'disabled' : ''}><i data-lucide="arrow-up"></i>上移</button>
        <button class="plan-menu-item" role="menuitem" data-action="move-problem" data-id="${item.id}" data-dir="down" ${index === visible.length - 1 ? 'disabled' : ''}><i data-lucide="arrow-down"></i>下移</button>
        <button class="plan-menu-item" role="menuitem" data-action="flat-open-move-menu" data-collection="problems" data-id="${item.id}" aria-haspopup="menu" aria-expanded="${flatState('problems').moveMenuOpenId === item.id}"><i data-lucide="folder-output"></i>移动到分类</button>
        ${renderFlatMoveSubmenu('problems', item)}
        <button class="plan-menu-item danger" role="menuitem" data-action="delete-problem" data-id="${item.id}"><i data-lucide="trash-2"></i>删除问题</button>
      </div>` : ''}
    </div>
  </div>`;
}

function renderProblemEditor(problem) {
  return `<section class="plan-workspace-panel" aria-label="当前问题编辑器">
    <div class="plan-title-row">
      <input class="plan-name-input problem-editor" id="problemName" value="${escapeHtml(problem.name)}" aria-label="问题标题" placeholder="问题标题" />
      <span class="plan-save" id="problemStatus" role="status" aria-live="polite" data-action="retry-problem-save">已保存</span>
    </div>
    <section class="plan-field note-field">
      <div class="plan-field-head">
        <label for="problemContent">拆解内容</label>
      </div>
      ${richEditorMarkup({ key: `problem:${problem.id}:content`, legacyId: 'problemContent', legacyClass: 'plan-next-step', getItem: () => problem, blocksKey: 'contentBlocks', textKey: 'content', label: '拆解内容', placeholder: '把大问题拆成一个个小步骤，写下下一步能做什么……', onChange: () => { scheduleProblemSave(); syncProblemListRow(problem.id); } })}
    </section>
    <section class="plan-field next-step-field">
      <div class="plan-field-head">
        <label for="problemNote">备注</label>
      </div>
      ${richEditorMarkup({ key: `problem:${problem.id}:note`, legacyId: 'problemNote', legacyClass: 'plan-note', getItem: () => problem, blocksKey: 'noteBlocks', textKey: 'note', label: '备注', placeholder: '记录背景、限制或线索……', onChange: () => { scheduleProblemSave(); syncProblemListRow(problem.id); } })}
    </section>
  </section>`;
}

function setProblemStatus(text, isError = false) {
  const el = $('#problemStatus');
  if (!el) return;
  el.textContent = text;
  el.classList.toggle('save-error', isError);
}

function syncProblemListRow(problemId) {
  const problem = state.problems.find((entry) => entry.id === problemId);
  const row = $(`.plan-list-row[data-id="${problemId}"]`);
  if (!problem || !row) return;
  const nameEl = row.querySelector('.plan-name');
  const previewEl = row.querySelector('.plan-preview');
  if (nameEl) nameEl.textContent = problem.name || '未命名问题';
  if (previewEl) previewEl.textContent = richPreview(problem, 'content', 'contentBlocks', '还没有内容');
}

// ---------- 分类模板库：渲染与列表 ----------

function libraryTemplatesForFilter(moduleId) {
  const rt = libraryState(moduleId);
  const templates = libraryTemplates(moduleId);
  const categories = libraryCategories(moduleId);
  if (rt.categoryFilter === 'all') return templates;
  if (rt.categoryFilter === 'none') return templates.filter((entry) => !entry.categoryId || !categories.some((category) => category.id === entry.categoryId));
  return templates.filter((entry) => entry.categoryId === rt.categoryFilter);
}

function libraryCategoryCount(moduleId, categoryId) {
  const templates = libraryTemplates(moduleId);
  const categories = libraryCategories(moduleId);
  if (categoryId === 'all') return templates.length;
  if (categoryId === 'none') return templates.filter((entry) => !entry.categoryId || !categories.some((category) => category.id === entry.categoryId)).length;
  return templates.filter((entry) => entry.categoryId === categoryId).length;
}

function libraryFilterLabel(moduleId) {
  const rt = libraryState(moduleId);
  if (rt.categoryFilter === 'all') return '全部分类';
  if (rt.categoryFilter === 'none') return '未分类';
  return libraryCategories(moduleId).find((entry) => entry.id === rt.categoryFilter)?.name || '全部分类';
}

function learningUpdatedLabel(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return `更新于 ${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')} ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

function renderLibraryFilterMenu(moduleId) {
  const mod = LIBRARY_MODULES[moduleId];
  const rt = libraryState(moduleId);
  if (!rt.filterMenuOpen) return '';
  const rows = [
    { id: 'all', name: '全部分类' },
    ...libraryCategories(moduleId).map((entry) => ({ id: entry.id, name: entry.name })),
    { id: 'none', name: '未分类' },
  ];
  const menuAttr = mod.legacyActions
    ? 'data-learning-filter-menu data-library-filter-menu data-library="learning"'
    : `data-library-filter-menu data-library="${moduleId}"`;
  const setFilter = libraryActionName(moduleId, 'set-filter');
  return `<div class="plan-menu learning-filter-menu" ${menuAttr} role="menu" aria-label="按分类筛选">
    ${rows.map((row) => `<button class="plan-menu-item ${rt.categoryFilter === row.id ? 'active' : ''}" role="menuitem" data-action="${setFilter}" ${mod.legacyActions ? '' : `data-library="${moduleId}"`} data-filter="${row.id}">
      <span class="learning-filter-name">${escapeHtml(row.name)}</span>
      <span class="learning-filter-count">${libraryCategoryCount(moduleId, row.id)}</span>
    </button>`).join('')}
    <div class="learning-filter-sep" role="separator"></div>
    <button class="plan-menu-item" role="menuitem" data-action="${libraryActionName(moduleId, 'open-category-manager')}" ${mod.legacyActions ? '' : `data-library="${moduleId}"`}><i data-lucide="settings-2"></i>管理分类</button>
  </div>`;
}

function renderLibraryPage(moduleId) {
  const mod = LIBRARY_MODULES[moduleId];
  const rt = libraryState(moduleId);
  const visible = libraryTemplatesForFilter(moduleId);
  if (!visible.some((entry) => entry.id === rt.selectedId)) rt.selectedId = visible[0]?.id || null;
  const template = libraryCurrentTemplate(moduleId);
  const filtering = rt.categoryFilter !== 'all';
  const action = (name) => libraryActionName(moduleId, name);
  const attrs = mod.legacyActions ? '' : `data-library="${moduleId}"`;
  $('#app').innerHTML = `<section class="page content-page learning-page" data-library="${moduleId}">
    <div class="learning-toolbar">
      <button class="button primary small" data-action="${action('add')}" ${attrs}><i data-lucide="plus"></i>新建模板</button>
      <div class="learning-filter-wrap">
        <button class="learning-filter-btn ${rt.filterMenuOpen ? 'open' : ''}" data-action="${action('toggle-filter')}" ${attrs} aria-haspopup="menu" aria-expanded="${rt.filterMenuOpen}">
          <i data-lucide="folder"></i><span>${escapeHtml(libraryFilterLabel(moduleId))}</span><i data-lucide="chevron-down"></i>
        </button>
        ${renderLibraryFilterMenu(moduleId)}
      </div>
      <button class="button teal small" data-action="${action('add-category')}" ${attrs}><i data-lucide="plus"></i>新建分类</button>
    </div>
    <div class="learning-body">
      <aside class="plan-rail" aria-label="${escapeHtml(mod.eyebrow)}模板列表">
        <div class="plan-rail-head">
          <div class="plan-rail-title"><h2>列表</h2><span class="plan-count">${visible.length} 个</span></div>
        </div>
        <div class="learning-cards">
          ${visible.length ? visible.map((item, index) => libraryListItem(moduleId, item, index, visible)).join('') : `<p class="status-text plan-empty-hint">${filtering ? mod.filteredListHint : mod.listHint}</p>`}
          <button class="learning-card-add" data-action="${action('add')}" ${attrs}><i data-lucide="plus"></i>新建模板</button>
        </div>
      </aside>
      <div class="plan-workspace">
        ${template ? renderLibraryEditor(moduleId, template) : emptyState(mod.editorIcon, filtering ? '当前分类还没有模板' : mod.emptyTitle, mod.emptyBody, `<button class="button primary" data-action="${action('add')}" ${attrs}><i data-lucide="plus"></i>新建模板</button>`)}
      </div>
    </div>
  </section>`;
  $$('.learning-editor').forEach((editor) => {
    editor.addEventListener('input', () => {
      scheduleLibrarySave(moduleId);
      syncLibraryListRow(moduleId, libraryState(moduleId).selectedId);
    });
  });
}

function libraryListItem(moduleId, item, index, visible) {
  const mod = LIBRARY_MODULES[moduleId];
  const rt = libraryState(moduleId);
  const open = rt.menuOpenId === item.id;
  const preview = richPreview(item, 'content', 'contentBlocks', '还没有内容');
  const active = item.id === rt.selectedId;
  const updated = learningUpdatedLabel(item.updatedAt);
  const action = libraryActionName(moduleId, 'menu');
  const attrs = mod.legacyActions ? '' : `data-library="${moduleId}"`;
  const menuAttr = mod.legacyActions
    ? 'data-learning-menu data-library-menu data-library="learning"'
    : `data-library-menu data-library="${moduleId}"`;
  const moveAction = libraryActionName(moduleId, 'move');
  const deleteAction = libraryActionName(moduleId, 'delete');
  return `<div class="plan-list-row learning-card ${active ? 'active' : ''}" data-id="${item.id}">
    <button class="plan-select" data-action="${libraryActionName(moduleId, 'select')}" ${attrs} data-id="${item.id}" aria-label="选择模板「${escapeHtml(item.name)}」">
      <span class="plan-name">${escapeHtml(item.name || '未命名模板')}</span>
      <span class="plan-preview">${escapeHtml(preview)}</span>
      ${updated ? `<span class="learning-updated">${escapeHtml(updated)}</span>` : ''}
    </button>
    <div class="plan-more-wrap">
      <button class="plan-more" data-action="${action}" ${attrs} data-id="${item.id}" aria-label="「${escapeHtml(item.name || '未命名模板')}」的更多操作" aria-expanded="${open}" aria-haspopup="menu"><i data-lucide="more-horizontal"></i></button>
      ${open ? `<div class="plan-menu" ${menuAttr} role="menu" aria-label="${escapeHtml(mod.eyebrow)}模板操作">
        <button class="plan-menu-item" role="menuitem" data-action="${moveAction}" ${attrs} data-id="${item.id}" data-dir="up" ${index === 0 ? 'disabled' : ''}><i data-lucide="arrow-up"></i>上移</button>
        <button class="plan-menu-item" role="menuitem" data-action="${moveAction}" ${attrs} data-id="${item.id}" data-dir="down" ${index === visible.length - 1 ? 'disabled' : ''}><i data-lucide="arrow-down"></i>下移</button>
        <button class="plan-menu-item" role="menuitem" data-action="library-open-move-menu" data-library="${moduleId}" data-id="${item.id}" aria-haspopup="menu" aria-expanded="${rt.moveMenuOpenId === item.id}"><i data-lucide="folder-output"></i>移动到分类</button>
        ${renderLibraryMoveSubmenu(moduleId, item)}
        <button class="plan-menu-item danger" role="menuitem" data-action="${deleteAction}" ${attrs} data-id="${item.id}"><i data-lucide="trash-2"></i>删除模板</button>
      </div>` : ''}
    </div>
  </div>`;
}

function renderLibraryEditor(moduleId, template) {
  const mod = LIBRARY_MODULES[moduleId];
  return `<section class="plan-workspace-panel" aria-label="当前${escapeHtml(mod.eyebrow)}模板编辑器">
    <div class="plan-title-row">
      <input class="plan-name-input learning-editor" id="${mod.editor.name}" value="${escapeHtml(template.name)}" aria-label="模板标题" placeholder="模板标题" />
      <span class="plan-save" id="${mod.editor.status}" role="status" aria-live="polite" data-action="${libraryActionName(moduleId, 'retry-save')}" ${mod.legacyActions ? '' : `data-library="${moduleId}"`}>已保存</span>
    </div>
    <section class="plan-field next-step-field">
      <div class="plan-field-head">
        <label for="${mod.editor.content}">模板内容</label>
      </div>
      ${richEditorMarkup({ key: `library:${moduleId}:${template.id}:content`, legacyId: mod.editor.content, legacyClass: 'plan-next-step', getItem: () => template, blocksKey: 'contentBlocks', textKey: 'content', label: '模板内容', placeholder: '写下这份模板的固定内容，例如周报结构、复盘框架、常用话术……', onChange: () => { scheduleLibrarySave(moduleId); syncLibraryListRow(moduleId, template.id); } })}
    </section>
    <section class="plan-field note-field">
      <div class="plan-field-head">
        <label for="${mod.editor.note}">使用备注</label>
      </div>
      ${richEditorMarkup({ key: `library:${moduleId}:${template.id}:note`, legacyId: mod.editor.note, legacyClass: 'plan-note', getItem: () => template, blocksKey: 'noteBlocks', textKey: 'note', label: '使用备注', placeholder: '记录适用场景、使用方法或维护心得……', onChange: () => { scheduleLibrarySave(moduleId); syncLibraryListRow(moduleId, template.id); } })}
    </section>
  </section>`;
}

function setLibraryStatus(moduleId, text, isError = false) {
  const el = $(`#${LIBRARY_MODULES[moduleId].editor.status}`);
  if (!el) return;
  el.textContent = text;
  el.classList.toggle('save-error', isError);
}

function syncLibraryListRow(moduleId, templateId) {
  const template = libraryTemplates(moduleId).find((entry) => entry.id === templateId);
  const row = $(`.plan-list-row[data-id="${templateId}"]`);
  if (!template || !row) return;
  const nameEl = row.querySelector('.plan-name');
  const previewEl = row.querySelector('.plan-preview');
  if (nameEl) nameEl.textContent = template.name || '未命名模板';
  if (previewEl) previewEl.textContent = richPreview(template, 'content', 'contentBlocks', '还没有内容');
}

function openLibraryCategoryManager(moduleId) {
  const mod = LIBRARY_MODULES[moduleId];
  const rt = libraryState(moduleId);
  rt.filterMenuOpen = false;
  const renameAction = libraryActionName(moduleId, 'rename-category');
  const deleteAction = libraryActionName(moduleId, 'delete-category');
  const addAction = libraryActionName(moduleId, 'add-category');
  const attrs = mod.legacyActions ? '' : `data-library="${moduleId}"`;
  const categories = libraryCategories(moduleId);
  $('#modalEyebrow').textContent = `${mod.eyebrow} · 分类`;
  $('#modalTitle').textContent = '管理分类';
  $('#modalBody').innerHTML = `<div class="thought-category-manager">
    <div class="thought-category-row system"><span>未分类</span><small>系统分类</small></div>
    ${categories.length ? categories.map((category) => `<div class="thought-category-row">
      <span>${escapeHtml(category.name)}</span>
      <div class="row-actions">
        <button class="mini-button" data-action="${renameAction}" ${attrs} data-id="${category.id}" aria-label="重命名分类${escapeHtml(category.name)}"><i data-lucide="pencil"></i></button>
        <button class="mini-button danger" data-action="${deleteAction}" ${attrs} data-id="${category.id}" aria-label="删除分类${escapeHtml(category.name)}"><i data-lucide="trash-2"></i></button>
      </div>
    </div>`).join('') : '<p class="status-text">还没有自定义分类。</p>'}
  </div>`;
  $('#modalActions').innerHTML = `<button class="button ghost" data-modal-cancel>关闭</button><button class="button primary" data-action="${addAction}" ${attrs}><i data-lucide="plus"></i>新建分类</button>`;
  $('#modalBackdrop').classList.remove('hidden');
  $('[data-modal-cancel]').onclick = closeModal;
  renderIcons();
}

// ---------- 设置：模块归属与排序 ----------

async function openCustomModuleModal() {
  if (settingsSaving || customCreationPromise || dataRestoreLock || dataReloadRequired) return;
  if (!(await flushPendingSaves())) return;
  if (!customCreation || customCreation.phase !== 'unknown') {
    customCreation = { phase: 'editing', name: '', icon: 'book-open', placement: currentWorkspace, error: '' };
  }
  renderCustomModuleModal();
}

function renderCustomModuleModal() {
  const entry = customCreation;
  const submitting = Boolean(customCreationPromise), unknown = entry.phase === 'unknown';
  const locked = submitting || unknown;
  $('#modalBackdrop').dataset.customModule = 'true';
  $('.modal').classList.add('custom-module-modal');
  $('#modalEyebrow').textContent = '模块管理';
  $('#modalTitle').textContent = '新增模块';
  $('#modalClose').disabled = submitting;
  const iconNames = ['书本', '文件夹', '灯泡', '目标', '星星'];
  $('#modalBody').innerHTML = `<p class="custom-module-intro">采用与复盘相同的分类和模板布局。</p>
    <form id="customModuleForm">
      <div class="field"><label for="customModuleName">模块名称</label><input class="input" id="customModuleName" value="${escapeHtml(entry.name)}" placeholder="例如：读书笔记" aria-describedby="customModuleError" ${locked ? 'disabled' : ''}></div>
      <fieldset class="custom-module-field"><legend>模块图标</legend><div class="custom-icon-options">
        ${CustomModuleModel.icons.map((icon, index) => `<label class="custom-icon-option" title="${iconNames[index]}"><input type="radio" name="moduleIcon" value="${icon}" ${entry.icon === icon ? 'checked' : ''} ${locked ? 'disabled' : ''} aria-label="${iconNames[index]}"><span><i data-lucide="${icon}"></i></span></label>`).join('')}
      </div></fieldset>
      <fieldset class="custom-module-field"><legend>显示位置</legend><div class="custom-placement-options">
        ${['main', 'zone'].map((placement) => `<label class="custom-position-option"><input type="radio" name="modulePlacement" value="${placement}" ${entry.placement === placement ? 'checked' : ''} ${locked ? 'disabled' : ''}><span>${WORKSPACE_LABELS[placement]}</span></label>`).join('')}
      </div></fieldset>
      <div class="custom-module-info"><strong>模块包含</strong><p>分类管理 · 模板列表 · 模板内容 · 使用备注</p></div>
      <p id="customModuleError" class="custom-module-error" role="alert">${escapeHtml(entry.error || '')}</p>
    </form>`;
  $('#modalActions').innerHTML = `<div class="custom-module-footer"><small>创建后立即保存，可在设置中调整位置和顺序。</small><div>
    ${entry.conflict ? '<button class="button ghost" id="moduleReload">重新载入最新设置</button>' : ''}
    <button class="button ghost" id="moduleCancel" ${submitting ? 'disabled' : ''}>${unknown ? '关闭并稍后确认' : '取消'}</button>
    <button class="button primary" id="moduleCreate" ${submitting || entry.conflict || dataReloadRequired ? 'disabled' : ''}>${submitting ? '创建中…' : unknown ? '确认创建结果' : '创建模块'}</button>
    </div></div>`;
  $('#modalBackdrop').classList.remove('hidden');
  renderIcons();
  $('#customModuleName').addEventListener('input', (event) => { entry.name = event.target.value; });
  $$('#customModuleForm input[type="radio"]').forEach((input) => input.addEventListener('change', () => {
    if (input.name === 'moduleIcon') entry.icon = input.value; else entry.placement = input.value;
  }));
  $('#customModuleForm').onsubmit = (event) => { event.preventDefault(); if (!event.isComposing) void submitCustomModule(); };
  $('#customModuleName').onkeydown = (event) => {
    if (event.key === 'Enter' && !event.isComposing && event.keyCode !== 229) { event.preventDefault(); void submitCustomModule(); }
    else if (event.key === 'Enter') event.preventDefault();
  };
  $('#moduleCreate').onclick = () => void submitCustomModule();
  $('#moduleCancel').onclick = () => { closeModal(true); $('#modalClose').disabled = false; };
  $('#moduleReload')?.addEventListener('click', async () => {
    if (!confirm('重新载入将放弃尚未保存的排序和归属修改，保留新增模块表单。是否继续？')) return;
    try {
      const result = await api('GET', '/api/navigation/preferences');
      if (!applyNavigationSnapshot(result)) return;
      initSettingsDraft(); entry.conflict = false; entry.error = ''; render(); renderCustomModuleModal();
    } catch (error) { entry.error = error.message; renderCustomModuleModal(); }
  });
  $('.custom-module-modal').onkeydown = trapCustomModuleFocus;
  if (!locked) $('#customModuleName').focus(); else $('#moduleCreate').focus();
}

function trapCustomModuleFocus(event) {
  if (event.key !== 'Tab') return;
  const fields = $$('button:not(:disabled), input:not(:disabled)', $('.custom-module-modal')).filter((entry) => entry.getClientRects().length);
  const first = fields[0], last = fields[fields.length - 1];
  if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
  else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
}

async function submitCustomModule() {
  if (customCreationPromise || settingsSaving || dataRestoreLock || dataReloadRequired || !customCreation || customCreation.conflict) return;
  const entry = customCreation;
  if (entry.phase !== 'unknown') {
    const error = CustomModuleModel.nameError(entry.name, state.customModules || []);
    if (error) { entry.error = error; renderCustomModuleModal(); return; }
    entry.payload = { name: entry.name.trim(), icon: entry.icon, placement: entry.placement, baseRevision: settingsBaseRevision, requestId: crypto.randomUUID() };
    entry.generation = settingsGeneration;
    entry.epoch = dataEpoch;
  }
  entry.phase = 'submitting'; entry.error = '';
  // Promise赋值后才开始UI/请求，保证同步双击只进入一次。
  customCreationPromise = Promise.resolve().then(async () => {
    render(); renderCustomModuleModal();
    try {
      const result = await api('POST', '/api/custom-modules', entry.payload);
      if (entry.epoch !== dataEpoch || !applyNavigationSnapshot(result)) throw Object.assign(new Error('数据已变化，请重新载入'), { code: 'DATA_EPOCH_CHANGED' });
      const ownRevision = result.navigationPreferences.revision === result.appliedRevision && result.appliedRevision === entry.payload.baseRevision + 1;
      if (ownRevision) {
        // 确认旧请求时只更新当前草稿，绝不恢复已被放弃的旧排序/归属。
        if (currentView === 'settings' && settingsDraft) {
          if (!settingsDraft.moduleOrder.includes(result.module.id)) settingsDraft.moduleOrder.push(result.module.id);
          settingsDraft.placementByModule[result.module.id] = entry.payload.placement;
          settingsBaseRevision = result.navigationPreferences.revision;
          settingsDirty = settingsDraftChanged();
        }
        settingsStatus = { text: '模块已创建', error: false };
      } else {
        settingsStatus = { text: '模块已创建，但设置已在其他页面更新，请重新载入最新设置。', error: true };
      }
      entry.phase = 'success';
      closeModal(true); $('#modalClose').disabled = false;
      customCreation = null;
      render(); toast(settingsStatus.text, !ownRevision);
      if (!ownRevision && currentView === 'settings') openSettingsConflictModal({});
    } catch (error) {
      entry.error = error.message;
      if (error.code === 'DATA_EPOCH_CHANGED') {
        entry.phase = 'unknown'; entry.error = '数据已变化。请保留输入并确认重新载入，不能自动重复创建。';
      } else if (error.commitState === 'not_committed' || (error.status >= 400 && error.status < 500)) {
        entry.phase = 'editing'; entry.conflict = error.code === 'NAVIGATION_REVISION_CONFLICT';
      } else {
        entry.phase = 'unknown'; entry.error = '创建结果尚未确认，模块可能已经保存。请确认创建结果。';
      }
    }
  }).finally(() => {
    customCreationPromise = null;
    render();
    if (customCreation === entry && !$('#modalBackdrop').classList.contains('hidden')) renderCustomModuleModal();
  });
  return customCreationPromise;
}

function initSettingsDraft() {
  settingsGeneration += 1;
  const prefs = navigationPreferences;
  settingsDraft = { moduleOrder: [...prefs.moduleOrder], placementByModule: { ...prefs.placementByModule } };
  settingsBaseRevision = prefs.revision;
  settingsDirty = false;
  settingsStatus = { text: '', error: false };
}

function settingsDraftChanged() {
  return JSON.stringify(settingsDraft.moduleOrder) !== JSON.stringify(navigationPreferences.moduleOrder)
    || JSON.stringify(settingsDraft.placementByModule) !== JSON.stringify(navigationPreferences.placementByModule);
}

// 拖动与箭头共用的唯一移动函数：直接作用于草稿的全局有序数组
function moveModuleInDraft(moduleId, targetIndex) {
  const order = settingsDraft.moduleOrder;
  const from = order.indexOf(moduleId);
  if (from < 0) return;
  const to = Math.max(0, Math.min(order.length - 1, targetIndex));
  if (from === to) return;
  order.splice(to, 0, ...order.splice(from, 1));
  markSettingsDirty();
}

function markSettingsDirty() {
  settingsDirty = settingsDraftChanged();
  render();
}

const TRASH_HINT = '移入垃圾站后可以恢复，彻底清空才会从这台电脑删除。';

function trashKindLabel(kind) {
  return {
    module: '模块', record: '内容', category: '分类', drawing: '画布', image: '图片',
    reflection: '每日反思', framework: '反思问题', 'principle-section': '原则',
    'principle-item': '原则条目', 'principle-child': '原则子节点',
  }[kind] || '内容';
}

function renderTrashCard(saving) {
  const rows = trashEntries.length
    ? trashEntries.map((entry) => `<div class="trash-row">
        <div><strong>${escapeHtml(entry.title || '未命名')}</strong><small>${trashKindLabel(entry.kind)} · ${escapeHtml(new Date(entry.deletedAt).toLocaleString('zh-CN', { hour12: false }))}</small></div>
        <div class="row-actions">
          <button class="button ghost small" data-action="trash-restore" data-id="${entry.id}" ${saving ? 'disabled' : ''}>恢复</button>
          <button class="mini-button danger" data-action="trash-purge" data-id="${entry.id}" ${saving ? 'disabled' : ''} aria-label="彻底删除${escapeHtml(entry.title || '这条内容')}"><i data-lucide="trash-2"></i></button>
        </div>
      </div>`).join('')
    : '<p class="status-text">垃圾站是空的。删除的模块和内容会放在这里，不再占用正在使用的数据。</p>';
  return `<section class="settings-card trash-card">
    <div class="settings-head">
      <div class="settings-heading-row"><h2>垃圾站</h2>${trashEntries.length ? `<button class="button ghost" data-action="trash-empty" ${saving ? 'disabled' : ''}>清空垃圾站</button>` : ''}</div>
      <p>这里的内容不在日常页面和活动数据里。恢复后回到原处；彻底删除或清空后，才会从这台电脑消失。</p>
    </div>
    <div class="trash-list">${rows}</div>
  </section>`;
}

function renderBackupCard() {
  const backupRows = state.backups.length
    ? state.backups.map((backup) => `<li><div><strong>${new Date(backup.createdAt).toLocaleString('zh-CN', { hour12: false })}</strong><small>${backup.imageCount ? `包含 ${backup.imageCount} 张图片` : '不含图片'} · ${backup.drawingCount || 0} 张图稿${backup.label === 'before-restore' ? ' · 恢复前自动保存' : ''}</small></div><button class="button ghost small" data-action="restore-backup" data-id="${backup.id}"><i data-lucide="history"></i>恢复</button></li>`).join('')
    : '<p class="status-text">还没有备份。</p>';
  return `<section class="settings-card trash-card">
    <div class="settings-head">
      <div class="settings-heading-row"><h2>数据备份</h2><button class="button ghost" data-action="create-backup"><i data-lucide="archive"></i>立即备份</button></div>
      <p>备份保存在这台电脑，包含记录、图片、图稿和垃圾站。不依赖某个模块是否还在导航里。</p>
    </div>
    <ul class="backup-list">${backupRows}</ul>
  </section>`;
}

function renderSettingsPage() {
  const order = settingsDraft.moduleOrder;
  const placement = settingsDraft.placementByModule;
  const saving = Boolean(settingsSaving || customCreationPromise || dataRestoreLock);
  const rows = order.map((id, index) => {
    const module = moduleById(id);
    if (!module) return '';
    const current = placement[id] === 'main';
    return `<div class="settings-row" data-module-id="${id}" data-row-index="${index}">
      <button class="drag-handle" data-drag-handle aria-label="拖动调整「${escapeHtml(module.name)}」的顺序" ${saving ? 'disabled' : ''}><i data-lucide="grip-vertical"></i></button>
      <span class="settings-module-icon"><i data-lucide="${module.icon}"></i></span>
      <span class="settings-module-name" title="${escapeHtml(module.name)}">${escapeHtml(module.name)}</span>
      <div class="placement-segment" role="group" aria-label="「${escapeHtml(module.name)}」的显示位置">
        <button class="placement-btn ${current ? 'active' : ''}" data-action="settings-placement" data-module-id="${id}" data-placement="main" ${saving ? 'disabled' : ''}>当前</button>
        <button class="placement-btn ${!current ? 'active' : ''}" data-action="settings-placement" data-module-id="${id}" data-placement="zone" ${saving ? 'disabled' : ''}>专区</button>
      </div>
      <div class="row-actions">
        <button class="mini-button" data-action="settings-move" data-module-id="${id}" data-dir="up" ${index === 0 || saving ? 'disabled' : ''} aria-label="上移「${escapeHtml(module.name)}」"><i data-lucide="arrow-up"></i></button>
        <button class="mini-button" data-action="settings-move" data-module-id="${id}" data-dir="down" ${index === order.length - 1 || saving ? 'disabled' : ''} aria-label="下移「${escapeHtml(module.name)}」"><i data-lucide="arrow-down"></i></button>
        <button class="mini-button danger" data-action="settings-delete-module" data-module-id="${id}" ${saving ? 'disabled' : ''} aria-label="删除模块「${escapeHtml(module.name)}」"><i data-lucide="trash-2"></i></button>
      </div>
    </div>`;
  }).join('');
  $('#app').innerHTML = `<section class="page content-page settings-page ${saving ? 'settings-saving' : ''}">
    <div class="settings-card">
      <div class="settings-head">
        <div class="settings-heading-row"><h2>模块管理</h2><button class="button primary" data-action="custom-module-open" id="addCustomModule" ${saving || dataReloadRequired ? 'disabled' : ''}><i data-lucide="plus"></i>${customCreation?.phase === 'unknown' ? '确认创建结果' : '新增模块'}</button></div>
        <p>拖动手柄或使用箭头调整顺序；选择每个模块的显示位置。顺序与归属保存后立即生效。</p>
        <p>新增模块将采用与复盘相同的分类和模板布局。</p>
      </div>
      <div class="settings-rows" id="settingsRows">${rows}</div>
      <div class="settings-foot">
        <span class="settings-status ${settingsStatus.error ? 'error' : ''}" id="settingsStatus" role="status" aria-live="polite">${escapeHtml(saving ? '正在保存设置…' : settingsStatus.text)}</span>
        <div class="settings-actions">
          <button class="button ghost" data-action="settings-cancel" id="settingsCancel" ${saving ? 'disabled' : ''}>取消</button>
          <button class="button primary" data-action="settings-save" id="settingsSave" ${saving || !settingsDirty || customCreation?.phase === 'unknown' || dataReloadRequired ? 'disabled' : ''}>${saving ? '处理中…' : '保存设置'}</button>
        </div>
      </div>
    </div>
    ${renderTrashCard(saving)}
    ${renderBackupCard()}
    ${MODULE_IDS.includes('principles') ? '<p class="settings-links">原则条目和打卡记录仍在「原则打卡 → 原则管理」，<button class="text-button" data-action="open-principle-manage">前往原则管理</button>。</p>' : ''}
  </section>`;
  if (!saving) bindSettingsDrag();
}

// 拖动只从手柄开始；释放在有效行后提交草稿变更，释放到表格外或 Esc 取消本次拖动
function bindSettingsDrag() {
  const container = $('#settingsRows');
  if (!container) return;
  let draggingId = null;
  let dropTargetIndex = null;
  container.querySelectorAll('.settings-row').forEach((row) => {
    const handle = row.querySelector('[data-drag-handle]');
    if (!handle) return;
    handle.addEventListener('pointerdown', () => { row.draggable = true; });
    row.addEventListener('mouseup', () => { row.draggable = false; });
    row.addEventListener('dragstart', (event) => {
      draggingId = row.dataset.moduleId;
      event.dataTransfer.effectAllowed = 'move';
      event.dataTransfer.setData('text/plain', draggingId);
      row.classList.add('dragging');
    });
    row.addEventListener('dragend', () => {
      row.draggable = false;
      row.classList.remove('dragging');
      container.querySelectorAll('.settings-row').forEach((target) => target.classList.remove('drop-above', 'drop-below'));
      draggingId = null;
      dropTargetIndex = null;
    });
    row.addEventListener('dragover', (event) => {
      if (!draggingId || draggingId === row.dataset.moduleId) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = 'move';
      const rect = row.getBoundingClientRect();
      const before = event.clientY < rect.top + rect.height / 2;
      dropTargetIndex = before ? Number(row.dataset.rowIndex) : Number(row.dataset.rowIndex) + 1;
      container.querySelectorAll('.settings-row').forEach((target) => target.classList.remove('drop-above', 'drop-below'));
      row.classList.add(before ? 'drop-above' : 'drop-below');
    });
    row.addEventListener('drop', (event) => {
      if (!draggingId || dropTargetIndex === null) return;
      event.preventDefault();
      const from = settingsDraft.moduleOrder.indexOf(draggingId);
      // 插入目标按移除拖拽行后的位置计算
      const target = from < dropTargetIndex ? dropTargetIndex - 1 : dropTargetIndex;
      moveModuleInDraft(draggingId, target);
    });
  });
}

async function saveSettings() {
  if (customCreationPromise) await customCreationPromise;
  if (dataReloadRequired || customCreation?.phase === 'unknown') { toast('请先确认创建结果或重新载入数据', true); return false; }
  if (settingsSaving) return settingsSaving;
  if (!settingsDraftChanged()) { settingsDirty = false; render(); return true; }
  settingsStatus = { text: '', error: false };
  settingsSaving = (async () => {
    render(); // 锁定编辑与按钮，显示保存中
    try {
      const result = await api('PATCH', '/api/navigation/preferences', {
        baseRevision: settingsBaseRevision,
        moduleOrder: settingsDraft.moduleOrder,
        placementByModule: settingsDraft.placementByModule,
      });
      if (!applyNavigationSnapshot(result)) return false;
      initSettingsDraft();
      settingsStatus = { text: '设置已保存', error: false };
      toast('设置已保存');
      render();
      return true;
    } catch (error) {
      if (error.status === 409 && error.code !== 'DATA_EPOCH_CHANGED') {
        openSettingsConflictModal(error);
      } else {
        settingsStatus = { text: `保存失败：${error.message}`, error: true };
        toast(error.message, true);
      }
      render();
      return false;
    } finally {
      settingsSaving = null;
      render();
    }
  })();
  return settingsSaving;
}

// 409 冲突：先确认放弃当前草稿，再读取最新配置；不能仅改 baseRevision 重发旧草稿
function openSettingsConflictModal(error) {
  $('#modalEyebrow').textContent = '设置冲突';
  $('#modalTitle').textContent = '模块设置已在其他页面更新';
  $('#modalBody').innerHTML = `<p class="modal-message">另一处保存的模块设置比当前草稿更新。重新载入会放弃本页未保存的修改；也可以继续留在本页查看原草稿。</p>`;
  $('#modalActions').innerHTML = '<button class="button ghost" data-modal-cancel>继续编辑</button><button class="button primary" id="modalSubmit">重新载入最新设置</button>';
  $('#modalBackdrop').classList.remove('hidden');
  renderIcons();
  $('#modalSubmit').onclick = async () => {
    $('#modalSubmit').disabled = true;
    try {
      const result = await api('GET', '/api/navigation/preferences');
      if (!applyNavigationSnapshot(result)) return;
      initSettingsDraft();
      closeModal();
      render();
      toast('已重新载入最新设置');
    } catch (loadError) {
      toast(loadError.message, true);
      $('#modalSubmit').disabled = false;
    }
  };
  $('[data-modal-cancel]').onclick = closeModal;
}

// 草稿未保存时尝试离开：保存并继续 / 放弃更改 / 继续编辑
function openLeaveSettingsModal(leave) {
  $('#modalEyebrow').textContent = '设置未保存';
  $('#modalTitle').textContent = '模块设置还未保存';
  $('#modalBody').innerHTML = `<p class="modal-message">当前调整的模块顺序与归属尚未保存。可以保存后继续，或放弃这些更改。</p>`;
  $('#modalActions').innerHTML = '<button class="button ghost" id="settingsKeepEditing">继续编辑</button><button class="button ghost" id="settingsDiscard">放弃更改</button><button class="button primary" id="settingsSaveAndGo">保存并继续</button>';
  $('#modalBackdrop').classList.remove('hidden');
  renderIcons();
  $('#settingsKeepEditing').onclick = () => { closeModal(); };
  $('#settingsDiscard').onclick = async () => {
    initSettingsDraft();
    closeModal();
    await leave();
  };
  $('#settingsSaveAndGo').onclick = async () => {
    const saved = await saveSettings();
    if (saved) { closeModal(); await leave(); }
    else { closeModal(); } // 保存失败留在设置页，保留草稿
  };
  $('[data-modal-cancel]')?.addEventListener('click', closeModal, { once: true });
}

// ---------- 分类模板库：操作（新建/选择/排序/删除/筛选/分类管理） ----------

async function handleLibraryAction(button) {
  const moduleId = button.dataset.library;
  if (!LIBRARY_MODULES[moduleId]) return;
  const action = button.dataset.action;
  if (action === 'library-add') return libraryAddTemplate(moduleId);
  if (action === 'library-select') return librarySelectTemplate(moduleId, button.dataset.id);
  if (action === 'library-menu') return libraryToggleMenu(moduleId, button.dataset.id);
  if (action === 'library-open-move-menu') {
    const rt = libraryState(moduleId);
    rt.moveMenuOpenId = rt.moveMenuOpenId === button.dataset.id ? null : button.dataset.id;
    render();
    return;
  }
  if (action === 'library-move-category') return libraryMoveCategory(moduleId, button.dataset.id, button.dataset.categoryId);
  if (action === 'library-retry-save') return libraryRetrySave(moduleId);
  if (action === 'library-move') return libraryMoveTemplate(moduleId, button.dataset.id, button.dataset.dir);
  if (action === 'library-delete') return libraryDeleteTemplate(moduleId, button.dataset.id);
  if (action === 'library-toggle-filter') return libraryToggleFilterMenu(moduleId);
  if (action === 'library-set-filter') return librarySetFilter(moduleId, button.dataset.filter);
  if (action === 'library-add-category') return libraryAddCategory(moduleId);
  if (action === 'library-open-category-manager') {
    render();
    openLibraryCategoryManager(moduleId);
    return;
  }
  if (action === 'library-rename-category') return libraryRenameCategory(moduleId, button.dataset.id);
  if (action === 'library-delete-category') return libraryDeleteCategory(moduleId, button.dataset.id);
}

async function handleFlatAction(button) {
  const collection = button.dataset.collection;
  const config = flatConfig(collection);
  if (!config) return;
  const action = button.dataset.action;
  const rt = flatState(collection);
  if (action === 'flat-toggle-filter') { rt.filterMenuOpen = !rt.filterMenuOpen; render(); return; }
  if (action === 'flat-set-filter') {
    if (rt.categoryFilter === button.dataset.filter) { rt.filterMenuOpen = false; render(); return; }
    if (!(await flushPendingSaves())) return;
    rt.categoryFilter = button.dataset.filter || 'all'; rt.filterMenuOpen = false; rt.moveMenuOpenId = null; render(); return;
  }
  if (action === 'flat-open-move-menu') { rt.moveMenuOpenId = rt.moveMenuOpenId === button.dataset.id ? null : button.dataset.id; render(); return; }
  if (action === 'flat-move-category') return flatMoveItem(collection, button.dataset.id, button.dataset.categoryId);
  if (action === 'flat-add-category') return flatAddCategory(collection);
  if (action === 'flat-open-category-manager') { rt.filterMenuOpen = false; renderFlatCategoryManager(collection); return; }
  if (action === 'flat-rename-category') return flatRenameCategory(collection, button.dataset.id);
  if (action === 'flat-delete-category') return flatDeleteCategory(collection, button.dataset.id);
}

async function libraryMoveCategory(moduleId, templateId, rawCategoryId) {
  const mod = LIBRARY_MODULES[moduleId], rt = libraryState(moduleId);
  const template = libraryTemplates(moduleId).find((entry) => entry.id === templateId);
  if (!template) return;
  const categoryId = rawCategoryId === 'none' || !rawCategoryId ? null : rawCategoryId;
  if ((template.categoryId || null) === categoryId) { rt.moveMenuOpenId = null; render(); return; }
  if (!(await flushLibrarySave(moduleId))) return;
  const result = await api('PATCH', `${mod.apiTemplates}/${templateId}`, { categoryId });
  const index = libraryTemplates(moduleId).findIndex((entry) => entry.id === templateId);
  if (index >= 0 && result.template) libraryTemplates(moduleId)[index] = result.template;
  rt.moveMenuOpenId = null; rt.menuOpenId = null;
  const visible = libraryTemplatesForFilter(moduleId);
  if (!visible.some((entry) => entry.id === rt.selectedId)) rt.selectedId = visible[0]?.id || null;
  render();
  toast(categoryId ? '已移动到新分类' : '已移到未分类');
}

function renderLibraryMoveSubmenu(moduleId, item) {
  const rt = libraryState(moduleId);
  if (rt.moveMenuOpenId !== item.id) return '';
  const current = item.categoryId || 'none';
  const rows = [{ id: 'none', name: '未分类' }, ...libraryCategories(moduleId).map((category) => ({ id: category.id, name: category.name }))];
  return `<div class="flat-category-submenu" data-library-move-menu="${moduleId}" role="menu" aria-label="移动到分类">
    <div class="flat-category-submenu-title">移动到分类</div>
    ${rows.map((row) => `<button class="plan-menu-item ${current === row.id ? 'active' : ''}" role="menuitem" data-action="library-move-category" data-library="${moduleId}" data-id="${item.id}" data-category-id="${escapeHtml(row.id)}"><span class="learning-filter-name">${escapeHtml(row.name)}</span>${current === row.id ? '<span aria-hidden="true">✓</span>' : ''}</button>`).join('')}
  </div>`;
}

async function flatMoveItem(collection, itemId, rawCategoryId) {
  const config = flatConfig(collection), rt = flatState(collection);
  const item = flatItems(collection).find((entry) => entry.id === itemId);
  if (!item) return;
  const categoryId = rawCategoryId === 'none' || !rawCategoryId ? null : rawCategoryId;
  if ((item.categoryId || null) === categoryId) { rt.moveMenuOpenId = null; render(); return; }
  if (!(await flushPendingSaves())) return;
  const result = await api('PATCH', `${config.addEndpoint}/${itemId}`, { categoryId });
  const key = collection === 'plans' ? 'plan' : collection === 'templates' ? 'template' : 'problem';
  const updated = result[key];
  const list = flatItems(collection), index = list.findIndex((entry) => entry.id === itemId);
  if (index >= 0 && updated) list[index] = updated;
  rt.moveMenuOpenId = null;
  planMenuOpenId = null; templateMenuOpenId = null; problemMenuOpenId = null;
  const visible = flatItemsForFilter(collection);
  if (!visible.some((entry) => entry.id === flatSelectedId(collection))) setFlatSelectedId(collection, visible[0]?.id || null);
  render();
  toast(categoryId ? '已移动到新分类' : '已移到未分类');
}

async function flatMoveOrder(collection, itemId, direction) {
  const config = flatConfig(collection), visible = flatItemsForFilter(collection), index = visible.findIndex((item) => item.id === itemId);
  const target = direction === 'up' ? index - 1 : index + 1;
  if (index < 0 || target < 0 || target >= visible.length) return;
  if (!(await flushPendingSaves())) return;
  const ordered = visible.slice();
  [ordered[index], ordered[target]] = [ordered[target], ordered[index]];
  const result = await api('POST', config.reorderEndpoint, { orderedIds: ordered.map((item) => item.id) });
  state[config.itemsKey] = result[config.responseKey];
  planMenuOpenId = null; templateMenuOpenId = null; problemMenuOpenId = null;
  flatState(collection).moveMenuOpenId = null;
  render();
}

function flatAddCategory(collection) {
  const config = flatConfig(collection);
  openFormModal({ eyebrow: `${config.itemLabel} · 分类`, title: '新建分类', label: '分类名称', placeholder: '例如：工作、生活、长期方向', submitText: '新建分类', onSubmit: async (name) => {
    const result = await api('POST', `${config.addEndpoint}/categories`, { name });
    flatCategories(collection).push(result.category);
    render();
  } });
}

function flatRenameCategory(collection, categoryId) {
  const config = flatConfig(collection), category = flatCategories(collection).find((entry) => entry.id === categoryId);
  if (!category) return;
  openFormModal({ eyebrow: `${config.itemLabel} · 分类`, title: '重命名分类', label: '分类名称', value: category.name, onSubmit: async (name) => {
    const result = await api('PATCH', `${config.addEndpoint}/categories/${category.id}`, { name });
    category.name = result.category.name;
    render();
  } });
}

function flatDeleteCategory(collection, categoryId) {
  const config = flatConfig(collection), rt = flatState(collection), category = flatCategories(collection).find((entry) => entry.id === categoryId);
  if (!category) return;
  const count = flatItems(collection).filter((item) => item.categoryId === category.id).length;
  openConfirmModal({ title: `删除分类「${category.name}」？`, message: `${count} 个相关${config.itemLabel}会转入“未分类”，内容本身不会删除。`, confirmText: '删除分类', onConfirm: async () => {
    await api('DELETE', `${config.addEndpoint}/categories/${category.id}`);
    state[config.categoriesKey] = flatCategories(collection).filter((entry) => entry.id !== category.id);
    flatItems(collection).forEach((item) => { if (item.categoryId === category.id) item.categoryId = null; });
    if (rt.categoryFilter === category.id) rt.categoryFilter = 'all';
    render();
  } });
}

async function libraryAddTemplate(moduleId) {
  const mod = LIBRARY_MODULES[moduleId];
  const rt = libraryState(moduleId);
  // 新建会替换编辑器，先提交当前输入
  if (!(await flushLibrarySave(moduleId))) return;
  const categoryId = rt.categoryFilter !== 'all' && rt.categoryFilter !== 'none' ? rt.categoryFilter : null;
  const categoryName = categoryId ? libraryCategories(moduleId).find((entry) => entry.id === categoryId)?.name : null;
  openFormModal({
    eyebrow: categoryName ? `${mod.eyebrow} · ${categoryName}` : mod.eyebrow,
    title: mod.legacyActions ? '新建学习模板' : '新建模板',
    label: '模板名称',
    placeholder: mod.newPlaceholder,
    submitText: '建立模板',
    onSubmit: async (name) => {
      const result = await api('POST', mod.apiTemplates, { name, categoryId });
      libraryTemplates(moduleId).push(result.template);
      rt.selectedId = result.template.id;
      rt.menuOpenId = null;
      render();
      requestAnimationFrame(() => { const input = $(`#${mod.editor.name}`); if (input) input.focus(); });
    },
  });
}

async function librarySelectTemplate(moduleId, templateId) {
  const rt = libraryState(moduleId);
  if (rt.selectedId === templateId) {
    if (rt.menuOpenId) { rt.menuOpenId = null; render(); }
    return;
  }
  // 修复快速切换：先提交当前模板输入，失败则不切换
  if (!(await flushLibrarySave(moduleId))) return;
  rt.selectedId = templateId;
  rt.menuOpenId = null;
  render();
}

function libraryToggleMenu(moduleId, templateId) {
  const mod = LIBRARY_MODULES[moduleId];
  const rt = libraryState(moduleId);
  rt.menuOpenId = rt.menuOpenId === templateId ? null : templateId;
  rt.moveMenuOpenId = null;
  render();
  const action = libraryActionName(moduleId, 'menu');
  const toggle = $(`[data-action="${action}"][data-id="${templateId}"]`);
  if (toggle) toggle.focus();
}

async function libraryRetrySave(moduleId) {
  const rt = libraryState(moduleId);
  const snapshot = rt.retry;
  if (!snapshot) return;
  setLibraryStatus(moduleId, '正在保存…');
  clearTimeout(rt.timer);
  rt.timer = null;
  await persistLibrarySnapshot(snapshot);
}

async function libraryMoveTemplate(moduleId, templateId, direction) {
  const mod = LIBRARY_MODULES[moduleId];
  const rt = libraryState(moduleId);
  rt.menuOpenId = null;
  const visible = libraryTemplatesForFilter(moduleId);
  const index = visible.findIndex((item) => item.id === templateId);
  const target = direction === 'up' ? index - 1 : index + 1;
  if (index < 0 || target < 0 || target >= visible.length) return;
  const ordered = visible.slice();
  [ordered[index], ordered[target]] = [ordered[target], ordered[index]];
  const result = await api('POST', `${mod.apiTemplates}/reorder`, { orderedIds: ordered.map((item) => item.id) });
  setLibraryTemplates(moduleId, result.templates);
  render();
}

function libraryDeleteTemplate(moduleId, templateId) {
  const mod = LIBRARY_MODULES[moduleId];
  const rt = libraryState(moduleId);
  const template = libraryTemplates(moduleId).find((item) => item.id === templateId);
  if (!template) return;
  openConfirmModal({ title: `删除「${template.name}」？`, message: `模板内容和备注会移入垃圾站。${TRASH_HINT}`, onConfirm: async () => {
    if (rt.selectedId === template.id && !(await flushPendingSaves())) throw new Error('模板尚未保存成功，请重试后再删除');
    const visibleIndex = libraryTemplatesForFilter(moduleId).findIndex((item) => item.id === template.id);
    const index = libraryTemplates(moduleId).findIndex((item) => item.id === template.id);
    await api('DELETE', `${mod.apiTemplates}/${template.id}`);
    if (rt.retry?.templateId === template.id) rt.retry = null;
    setLibraryTemplates(moduleId, libraryTemplates(moduleId).filter((item) => item.id !== template.id));
    // 选中同筛选下相邻可用项；筛选为空时由渲染函数回到空状态
    const nextVisible = libraryTemplatesForFilter(moduleId);
    const next = nextVisible[Math.min(Math.max(visibleIndex, 0), nextVisible.length - 1)] || libraryTemplates(moduleId)[Math.min(Math.max(index, 0), libraryTemplates(moduleId).length - 1)];
    rt.selectedId = next?.id || null;
    rt.menuOpenId = null;
    rt.moveMenuOpenId = null;
    render();
  } });
}

function libraryToggleFilterMenu(moduleId) {
  const rt = libraryState(moduleId);
  rt.filterMenuOpen = !rt.filterMenuOpen;
  render();
}

async function librarySetFilter(moduleId, filter) {
  const rt = libraryState(moduleId);
  if (rt.categoryFilter === filter) {
    if (rt.filterMenuOpen) { rt.filterMenuOpen = false; render(); }
    return;
  }
  // 换分类前先提交当前输入
  if (!(await flushLibrarySave(moduleId))) return;
  rt.categoryFilter = filter || 'all';
  rt.filterMenuOpen = false;
  render();
}

function libraryAddCategory(moduleId) {
  const mod = LIBRARY_MODULES[moduleId];
  openFormModal({ eyebrow: `${mod.eyebrow} · 分类`, title: '新建分类', label: '分类名称', placeholder: mod.categoryPlaceholder, submitText: '新建分类', onSubmit: async (name) => {
    const result = await api('POST', mod.apiCategories, { name });
    libraryCategories(moduleId).push(result.category);
    render();
  } });
}

function libraryRenameCategory(moduleId, categoryId) {
  const mod = LIBRARY_MODULES[moduleId];
  const category = libraryCategories(moduleId).find((entry) => entry.id === categoryId);
  if (!category) return;
  openFormModal({ eyebrow: `${mod.eyebrow} · 分类`, title: '重命名分类', label: '分类名称', value: category.name, onSubmit: async (name) => {
    const result = await api('PATCH', `${mod.apiCategories}/${category.id}`, { name });
    category.name = result.category.name;
    render();
  } });
}

function libraryDeleteCategory(moduleId, categoryId) {
  const mod = LIBRARY_MODULES[moduleId];
  const rt = libraryState(moduleId);
  const category = libraryCategories(moduleId).find((entry) => entry.id === categoryId);
  if (!category) return;
  const count = libraryTemplates(moduleId).filter((entry) => entry.categoryId === category.id).length;
  openConfirmModal({ title: `删除分类「${category.name}」？`, message: `${count} 个相关模板会转入“未分类”，模板本身不会删除。`, confirmText: '删除分类', onConfirm: async () => {
    await api('DELETE', `${mod.apiCategories}/${category.id}`);
    setLibraryCategories(moduleId, libraryCategories(moduleId).filter((entry) => entry.id !== category.id));
    libraryTemplates(moduleId).forEach((entry) => { if (entry.categoryId === category.id) entry.categoryId = null; });
    if (rt.categoryFilter === category.id) rt.categoryFilter = 'all';
    render();
  } });
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
    ...(Array.isArray(thought.blocks) ? { blocks: thought.blocks.map((block) => ({ ...block })) } : {}),
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
        // 保留编辑对象身份，首次保存后正在上传的图片仍写入这一篇文章。
        if (latest) {
          const local = { title: latest.title, text: latest.text, categoryId: latest.categoryId, ...(latest.blocks ? { blocks: latest.blocks } : {}) };
          Object.assign(latest, saved, local);
        }
        state.thoughtEntries.push(latest || saved);
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
          Object.assign(latest, { ...saved, title: latest.title, text: latest.text, categoryId: latest.categoryId, ...(latest.blocks ? { blocks: latest.blocks } : {}) });
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
  if (!await flushRichEditorUploads()) return false;
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
  return left && right && left.id === right.id && left.name === right.name && left.description === right.description && left.note === right.note
    && JSON.stringify(left.descriptionBlocks || []) === JSON.stringify(right.descriptionBlocks || [])
    && JSON.stringify(left.noteBlocks || []) === JSON.stringify(right.noteBlocks || []);
}

async function persistPlanSnapshot(rawSnapshot) {
  if (!rawSnapshot) return true;
  if (planSavePromise) await planSavePromise;
  const snapshot = { ...rawSnapshot, descriptionBlocks: cloneRichBlocks(rawSnapshot.descriptionBlocks), noteBlocks: cloneRichBlocks(rawSnapshot.noteBlocks) };
  planSavePromise = (async () => {
    try {
      await api('PATCH', `/api/plans/${snapshot.id}`, {
        name: snapshot.name, description: snapshot.description, note: snapshot.note,
        descriptionBlocks: snapshot.descriptionBlocks, noteBlocks: snapshot.noteBlocks,
      });
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
  const snapshot = { id: plan.id, name: plan.name, description: plan.description, note: plan.note,
    descriptionBlocks: cloneRichBlocks(plan.descriptionBlocks), noteBlocks: cloneRichBlocks(plan.noteBlocks) };
  planRetry = snapshot;
  setPlanStatus('输入中…');
  clearTimeout(planTimer);
  planTimer = setTimeout(() => {
    planTimer = null;
    if (selectedPlanId === snapshot.id) setPlanStatus('正在保存…');
    persistPlanSnapshot(snapshot);
  }, 650);
}

function sameTemplateSnapshot(left, right) {
  return left && right && left.id === right.id && left.name === right.name && left.content === right.content && left.note === right.note
    && JSON.stringify(left.contentBlocks || []) === JSON.stringify(right.contentBlocks || [])
    && JSON.stringify(left.noteBlocks || []) === JSON.stringify(right.noteBlocks || []);
}

async function persistTemplateSnapshot(rawSnapshot) {
  if (!rawSnapshot) return true;
  if (templateSavePromise) await templateSavePromise;
  const snapshot = { ...rawSnapshot, contentBlocks: cloneRichBlocks(rawSnapshot.contentBlocks), noteBlocks: cloneRichBlocks(rawSnapshot.noteBlocks) };
  templateSavePromise = (async () => {
    try {
      await api('PATCH', `/api/templates/${snapshot.id}`, {
        name: snapshot.name, content: snapshot.content, note: snapshot.note,
        contentBlocks: snapshot.contentBlocks, noteBlocks: snapshot.noteBlocks,
      });
      if (selectedTemplateId === snapshot.id) setTemplateStatus(sameTemplateSnapshot(templateRetry, snapshot) ? `已保存 ${nowTime()}` : '正在保存…');
      if (sameTemplateSnapshot(templateRetry, snapshot)) templateRetry = null;
      return true;
    } catch (error) {
      if (selectedTemplateId === snapshot.id) setTemplateStatus('保存失败，点击重试', true);
      toast(error.message, true);
      return false;
    } finally {
      templateSavePromise = null;
    }
  })();
  return templateSavePromise;
}

function scheduleTemplateSave() {
  const template = currentTemplate();
  if (!template) return;
  template.name = $('#templateName').value.trim() || template.name;
  const snapshot = { id: template.id, name: template.name, content: template.content, note: template.note,
    contentBlocks: cloneRichBlocks(template.contentBlocks), noteBlocks: cloneRichBlocks(template.noteBlocks) };
  templateRetry = snapshot;
  setTemplateStatus('输入中…');
  clearTimeout(templateTimer);
  templateTimer = setTimeout(() => {
    templateTimer = null;
    if (selectedTemplateId === snapshot.id) setTemplateStatus('正在保存…');
    persistTemplateSnapshot(snapshot);
  }, 650);
}

function sameProblemSnapshot(left, right) {
  return left && right && left.id === right.id && left.name === right.name && left.content === right.content && left.note === right.note
    && JSON.stringify(left.contentBlocks || []) === JSON.stringify(right.contentBlocks || [])
    && JSON.stringify(left.noteBlocks || []) === JSON.stringify(right.noteBlocks || []);
}

async function persistProblemSnapshot(rawSnapshot) {
  if (!rawSnapshot) return true;
  if (problemSavePromise) await problemSavePromise;
  const snapshot = { ...rawSnapshot, contentBlocks: cloneRichBlocks(rawSnapshot.contentBlocks), noteBlocks: cloneRichBlocks(rawSnapshot.noteBlocks) };
  problemSavePromise = (async () => {
    try {
      await api('PATCH', `/api/problems/${snapshot.id}`, {
        name: snapshot.name, content: snapshot.content, note: snapshot.note,
        contentBlocks: snapshot.contentBlocks, noteBlocks: snapshot.noteBlocks,
      });
      if (selectedProblemId === snapshot.id) setProblemStatus(sameProblemSnapshot(problemRetry, snapshot) ? `已保存 ${nowTime()}` : '正在保存…');
      if (sameProblemSnapshot(problemRetry, snapshot)) problemRetry = null;
      return true;
    } catch (error) {
      if (selectedProblemId === snapshot.id) setProblemStatus('保存失败，点击重试', true);
      toast(error.message, true);
      return false;
    } finally {
      problemSavePromise = null;
    }
  })();
  return problemSavePromise;
}

function scheduleProblemSave() {
  const problem = currentProblem();
  if (!problem) return;
  problem.name = $('#problemName').value.trim() || problem.name;
  const snapshot = { id: problem.id, name: problem.name, content: problem.content, note: problem.note,
    contentBlocks: cloneRichBlocks(problem.contentBlocks), noteBlocks: cloneRichBlocks(problem.noteBlocks) };
  problemRetry = snapshot;
  setProblemStatus('输入中…');
  clearTimeout(problemTimer);
  problemTimer = setTimeout(() => {
    problemTimer = null;
    if (selectedProblemId === snapshot.id) setProblemStatus('正在保存…');
    persistProblemSnapshot(snapshot);
  }, 650);
}

// 快照携带 moduleId + templateId：异步回调只更新请求发起时捕获的模块与模板，
// 后台保存其他模块时不改当前编辑器的状态文字
function sameLibrarySnapshot(left, right) {
  return left && right && left.moduleId === right.moduleId && left.templateId === right.templateId
    && left.name === right.name && left.content === right.content && left.note === right.note
    && JSON.stringify(left.contentBlocks || []) === JSON.stringify(right.contentBlocks || [])
    && JSON.stringify(left.noteBlocks || []) === JSON.stringify(right.noteBlocks || []);
}

async function persistLibrarySnapshot(rawSnapshot) {
  if (dataReloadRequired) return false;
  const mod = LIBRARY_MODULES[rawSnapshot.moduleId];
  const rt = libraryState(rawSnapshot.moduleId);
  if (!mod) return true;
  if (rt.savePromise) {
    try { await rt.savePromise; } catch (_) { /* 使用当前快照继续重试 */ }
  }
  const snapshot = { ...rawSnapshot, contentBlocks: cloneRichBlocks(rawSnapshot.contentBlocks), noteBlocks: cloneRichBlocks(rawSnapshot.noteBlocks) };
  rt.savePromise = (async () => {
    try {
      const result = await api('PATCH', `${mod.apiTemplates}/${snapshot.templateId}`, {
        name: snapshot.name, content: snapshot.content, note: snapshot.note,
        contentBlocks: snapshot.contentBlocks, noteBlocks: snapshot.noteBlocks,
      });
      const local = libraryTemplates(snapshot.moduleId).find((entry) => entry.id === snapshot.templateId);
      if (local && result.template?.updatedAt) {
        local.updatedAt = result.template.updatedAt;
        const label = $(`.plan-list-row[data-id="${snapshot.templateId}"] .learning-updated`);
        if (label) label.textContent = learningUpdatedLabel(local.updatedAt);
      }
      if (currentView === snapshot.moduleId && rt.selectedId === snapshot.templateId) {
        setLibraryStatus(snapshot.moduleId, sameLibrarySnapshot(rt.retry, snapshot) ? `已保存 ${nowTime()}` : '正在保存…');
      }
      if (sameLibrarySnapshot(rt.retry, snapshot)) rt.retry = null;
      return true;
    } catch (error) {
      if (currentView === snapshot.moduleId && rt.selectedId === snapshot.templateId) {
        setLibraryStatus(snapshot.moduleId, '保存失败，点击重试', true);
      }
      toast(error.message, true);
      return false;
    } finally {
      rt.savePromise = null;
    }
  })();
  return rt.savePromise;
}

function scheduleLibrarySave(moduleId) {
  const mod = LIBRARY_MODULES[moduleId];
  const rt = libraryState(moduleId);
  if (dataRestoreLock || dataReloadRequired) return;
  const template = libraryTemplates(moduleId).find((entry) => entry.id === rt.selectedId);
  if (!template) return;
  template.name = $(`#${mod.editor.name}`).value.trim() || template.name;
  const snapshot = { moduleId, templateId: template.id, name: template.name, content: template.content, note: template.note,
    contentBlocks: cloneRichBlocks(template.contentBlocks), noteBlocks: cloneRichBlocks(template.noteBlocks) };
  rt.retry = snapshot;
  setLibraryStatus(moduleId, '输入中…');
  clearTimeout(rt.timer);
  rt.timer = setTimeout(() => {
    rt.timer = null;
    if (rt.selectedId === snapshot.templateId) setLibraryStatus(moduleId, '正在保存…');
    persistLibrarySnapshot(snapshot);
  }, 650);
}

// 切换模板/分类/模块/界面前先提交当前输入；保存失败则保持原状态不切换
async function flushLibrarySave(moduleId) {
  const rt = libraryState(moduleId);
  clearTimeout(rt.timer);
  rt.timer = null;
  if (rt.savePromise) {
    try { await rt.savePromise; } catch (_) { /* retry snapshot remains */ }
  }
  clearTimeout(rt.timer);
  rt.timer = null;
  const snapshot = rt.retry;
  if (!snapshot) return true;
  return persistLibrarySnapshot(snapshot);
}

async function flushPendingSaves() {
  if (!await LifeDrawings.flush()) return false;
  if (dataReloadRequired) return false;
  const richUploadsSaved = await flushRichEditorUploads();
  if (!richUploadsSaved) return false;
  const thoughtSaved = await flushThoughtSave();
  const reflectSnapshot = reflectRetry;
  clearTimeout(reflectTimer);
  reflectTimer = null;
  const reflectSaved = reflectSnapshot ? await persistReflectSnapshot(reflectSnapshot) : !reflectSavePromise || await reflectSavePromise;
  const planSnapshot = planRetry;
  clearTimeout(planTimer);
  planTimer = null;
  const planSaved = planSnapshot ? await persistPlanSnapshot(planSnapshot) : !planSavePromise || await planSavePromise;
  const templateSnapshot = templateRetry;
  clearTimeout(templateTimer);
  templateTimer = null;
  const templateSaved = templateSnapshot ? await persistTemplateSnapshot(templateSnapshot) : !templateSavePromise || await templateSavePromise;
  const problemSnapshot = problemRetry;
  clearTimeout(problemTimer);
  problemTimer = null;
  const problemSaved = problemSnapshot ? await persistProblemSnapshot(problemSnapshot) : !problemSavePromise || await problemSavePromise;
  let librariesSaved = true;
  for (const moduleId of Object.keys(LIBRARY_MODULES)) {
    if (!await flushLibrarySave(moduleId)) librariesSaved = false;
  }
  return thoughtSaved && reflectSaved && planSaved && templateSaved && problemSaved && librariesSaved && richUploadsSaved;
}

function hasPendingLibrarySaves() {
  return Object.values(libraryRuntime).some((rt) => rt.timer || rt.savePromise || rt.retry);
}

// 恢复备份/重载前丢弃所有待保存内容，避免旧保存请求在恢复完成后覆盖恢复结果
function discardPendingLibrarySaves() {
  for (const rt of Object.values(libraryRuntime)) {
    clearTimeout(rt.timer);
    rt.timer = null;
    rt.retry = null;
  }
}

function bindManageInputs() {
  $$('[data-add-item-input]').forEach((input) => input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      addItem(input.dataset.addItemInput, input.value);
    }
  }));
}

function openFormModal({ eyebrow = '编辑', title, label, value = '', placeholder = '', submitText = '保存', multiline = false, allowEmpty = false, onSubmit }) {
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
    if (!clean && !allowEmpty) { toast(`${label}不能为空`, true); return; }
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

function closeModal(force = false) {
  const customOpen = $('#modalBackdrop').dataset.customModule === 'true';
  if (customOpen && force !== true && customCreationPromise) return;
  $('#modalBackdrop').classList.add('hidden');
  delete $('#modalBackdrop').dataset.customModule;
  $('.modal').classList.remove('custom-module-modal');
  $('.modal').onkeydown = null;
  $('#modalClose').disabled = false;
  if (customOpen) $('#addCustomModule')?.focus();
}

function openAddThoughtCategoryModal() {
  const kind = thoughtKind(currentThought() || { kind: thoughtMode });
  const label = thoughtKindLabel(kind);
  openFormModal({
    eyebrow: `所思 · ${label}类别`, title: '新建类别', label: '类别名称', placeholder: '例如：学习、关系、灵感', submitText: '新建类别',
    onSubmit: async (name) => {
      const result = await api('POST', '/api/thought-categories', { name, kind });
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
  const kind = thoughtKind(currentThought() || { kind: thoughtMode });
  const label = thoughtKindLabel(kind);
  const categories = thoughtCategoriesForKind(kind);
  $('#modalEyebrow').textContent = `所思 · ${label}类别`;
  $('#modalTitle').textContent = '管理类别';
  $('#modalBody').innerHTML = `<div class="thought-category-manager">
    <div class="thought-category-row system"><span>未分类</span><small>系统类别</small></div>
    ${categories.length ? categories.map((category) => `<div class="thought-category-row">
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
  if (action.startsWith('rich-')) { await handleRichAction(button); return; }
  if (action.startsWith('review-')) { await handleReviewImageAction(button); return; }
  if (action.startsWith('library-')) { await handleLibraryAction(button); return; }
  if (action.startsWith('flat-')) { await handleFlatAction(button); return; }

  // ---------- 界面导航与设置 ----------
  if (action === 'switch-workspace') {
    await handleSwitchWorkspace();
    return;
  }
  if (action === 'open-settings') {
    await changeView('settings');
    return;
  }
  if (action === 'open-principle-manage') {
    currentPrincipleTab = 'manage';
    await changeView('principles', 'manage');
    return;
  }
  if (action === 'custom-module-open') { await openCustomModuleModal(); return; }
  if (action.startsWith('settings-') && (customCreationPromise || settingsSaving || dataRestoreLock)) return;
  if (action === 'settings-placement') {
    settingsDraft.placementByModule[button.dataset.moduleId] = button.dataset.placement === 'zone' ? 'zone' : 'main';
    markSettingsDirty();
    return;
  }
  if (action === 'settings-move') {
    const index = settingsDraft.moduleOrder.indexOf(button.dataset.moduleId);
    moveModuleInDraft(button.dataset.moduleId, button.dataset.dir === 'up' ? index - 1 : index + 1);
    return;
  }
  if (action === 'settings-save') {
    await saveSettings();
    return;
  }
  if (action === 'settings-cancel') {
    await cancelSettings();
    return;
  }
  if (action === 'settings-delete-module') {
    const module = moduleById(button.dataset.moduleId);
    if (!module) return;
    openConfirmModal({
      title: `删除模块「${module.name}」？`,
      message: `这个模块和里面的内容会离开正在使用的数据。${TRASH_HINT}`,
      confirmText: '移入垃圾站',
      onConfirm: async () => {
        if (!(await flushPendingSaves())) throw new Error('有内容尚未保存成功，请先重试保存');
        await api('DELETE', `/api/modules/${module.id}`);
        await reloadLiveState();
        render();
        toast(`已将「${module.name}」移入垃圾站`);
      },
    });
    return;
  }
  if (action === 'trash-restore') {
    const entry = trashEntries.find((item) => item.id === button.dataset.id);
    if (!entry) return;
    openConfirmModal({
      title: `恢复「${entry.title || '这条内容'}」？`,
      message: '恢复后会回到原来的位置，并重新进入正在使用的数据。',
      confirmText: '恢复',
      onConfirm: async () => {
        await api('POST', `/api/trash/${entry.id}/restore`);
        await reloadLiveState();
        render();
        toast('已从垃圾站恢复');
      },
    });
    return;
  }
  if (action === 'trash-purge') {
    const entry = trashEntries.find((item) => item.id === button.dataset.id);
    if (!entry) return;
    openConfirmModal({
      title: `彻底删除「${entry.title || '这条内容'}」？`,
      message: '彻底删除后无法恢复，占用的文件也会从这台电脑消失。',
      confirmText: '彻底删除',
      onConfirm: async () => {
        await api('DELETE', `/api/trash/${entry.id}`);
        trashEntries = trashEntries.filter((item) => item.id !== entry.id);
        render();
        toast('已彻底删除');
      },
    });
    return;
  }
  if (action === 'trash-empty') {
    if (!trashEntries.length) return;
    openConfirmModal({
      title: '清空垃圾站？',
      message: '垃圾站里的模块、内容和文件都会彻底删除，无法恢复。',
      confirmText: '清空',
      onConfirm: async () => {
        await api('POST', '/api/trash/empty');
        trashEntries = [];
        render();
        toast('垃圾站已清空');
      },
    });
    return;
  }
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
    if (customCreationPromise) await customCreationPromise;
    if (customCreation?.phase === 'unknown') { toast('请先确认创建结果', true); return; }
    button.disabled = true;
    try {
      // 备份必须包含用户最后一次输入
      if (!(await flushPendingSaves())) { toast('有内容尚未保存成功，请先重试保存', true); return; }
      const result = await api('POST', '/api/backups');
      state.backups.unshift(result.backup);
      render();
      toast('已创建本机备份');
    } finally { button.disabled = false; }
    return;
  }
  if (action === 'restore-backup') {
    if (customCreationPromise) await customCreationPromise;
    if (customCreation?.phase === 'unknown') { toast('请先确认创建结果', true); return; }
    const backup = state.backups.find((entry) => entry.id === button.dataset.id);
    if (!backup) return;
    openConfirmModal({
      title: '恢复这份备份？',
      message: '当前数据会先自动备份，然后恢复所选备份中的记录、图片、图稿及素材库。恢复后页面将刷新。',
      confirmText: '恢复备份',
      onConfirm: async () => {
        // 恢复前等待全部保存成功，恢复期间锁定编辑，避免旧保存请求覆盖恢复结果
        if (!(await flushPendingSaves())) throw new Error('有内容尚未保存成功，请先重试保存后再恢复');
        dataRestoreLock = true;
        discardPendingLibrarySaves();
        try {
          await api('POST', `/api/backups/${backup.id}/restore`);
          location.reload();
        } catch (error) {
          dataRestoreLock = false;
          throw error;
        }
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
    thoughtHistoryFilter = 'free';
    thoughtHistoryCategory = { free: 'all', review: 'all', extraction: 'all' };
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
    thoughtHistoryFilter = 'free';
    thoughtHistoryCategory = { free: 'all', review: 'all', extraction: 'all' };
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
  if (action === 'new-thought' || action === 'new-review' || action === 'new-extraction') {
    if (action === 'new-review' && state.version < 7) {
      toast('请先重启生活管家服务并刷新页面，以启用每日复盘。现有文章不受影响。', true);
      return;
    }
    if (thoughtSurface === 'editor' && isArticleMode() && !(await flushThoughtSave())) return;
    if (thoughtSurface === 'history') selectedDate = localToday();
    thoughtSurface = 'editor';
    thoughtMode = action === 'new-review' ? 'review' : action === 'new-extraction' ? 'extraction' : 'free';
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
    openFormModal({ eyebrow: `所思 · ${thoughtKindLabel(category.kind)}类别`, title: '重命名类别', label: '类别名称', value: category.name, onSubmit: async (name) => {
      const result = await api('PATCH', `/api/thought-categories/${category.id}`, { name });
      category.name = result.category.name;
      render();
    } });
    return;
  }
  if (action === 'delete-thought-category') {
    const category = state.thoughtCategories.find((entry) => entry.id === button.dataset.id);
    if (!category) return;
    const count = state.thoughtEntries.filter((entry) => entry.categoryId === category.id && thoughtKind(entry) === category.kind).length;
    openConfirmModal({ title: `删除类别「${category.name}」？`, message: `${count} 篇相关文章会转入“未分类”，文章本身不会删除。`, confirmText: '删除类别', onConfirm: async () => {
      await api('DELETE', `/api/thought-categories/${category.id}`);
      state.thoughtCategories = state.thoughtCategories.filter((entry) => entry.id !== category.id);
      state.thoughtEntries.forEach((entry) => { if (entry.categoryId === category.id) entry.categoryId = null; });
      if (thoughtDraft?.categoryId === category.id) thoughtDraft.categoryId = null;
      if (thoughtHistoryCategory[category.kind] === category.id) thoughtHistoryCategory[category.kind] = 'uncategorized';
      render();
    } });
    return;
  }
  if (action === 'delete-thought') {
    if (!(await flushThoughtSave())) return;
    const thought = currentThought();
    if (!thought || thought.id === 'draft') return;
    openConfirmModal({ title: `删除「${effectiveThoughtTitle(thought)}」？`, message: `这篇${thoughtKindLabel(thoughtKind(thought))}会移入垃圾站。${TRASH_HINT}`, confirmText: `删除${thoughtNoun(thought)}`, onConfirm: async () => {
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
    openConfirmModal({ title: `删除「${effectiveThoughtTitle(thought)}」？`, message: `${dateLabel(thought.date)}的这篇${thoughtKindLabel(thoughtKind(thought))}会移入垃圾站。${TRASH_HINT}`, confirmText: `删除${thoughtNoun(thought)}`, onConfirm: async () => {
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
    openConfirmModal({ title: `删除 ${dateLabel(date)} 的每日反思？`, message: `当天的反思回答会移入垃圾站。${TRASH_HINT}`, confirmText: '删除反思', onConfirm: async () => {
      clearTimeout(reflectTimer); reflectTimer = null; reflectRetry = null;
      await api('DELETE', `/api/reflect/${date}`);
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
  if (action === 'open-template-menu') {
    const id = button.dataset.id;
    templateMenuOpenId = templateMenuOpenId === id ? null : id;
    render();
    const toggle = $(`[data-action="open-template-menu"][data-id="${id}"]`);
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
  if (action === 'retry-template-save') {
    const snapshot = templateRetry;
    if (!snapshot) return;
    setTemplateStatus('正在保存…');
    clearTimeout(templateTimer);
    templateTimer = null;
    await persistTemplateSnapshot(snapshot);
    return;
  }

  // ---------- 问题拆解 ----------
  if (action === 'add-problem') {
    openFormModal({ eyebrow: '问题拆解', title: '新建问题', label: '问题标题', placeholder: '例如：学习效率低、总是拖延', submitText: '建立问题', onSubmit: async (name) => {
      if (!(await flushPendingSaves())) throw new Error('当前内容尚未保存成功，请重试');
      const filter = flatState('problems').categoryFilter;
      const categoryId = filter !== 'all' && filter !== 'none' ? filter : null;
      const result = await api('POST', '/api/problems', { name, categoryId });
      state.problems.push(result.problem);
      selectedProblemId = result.problem.id;
      problemMenuOpenId = null;
      render();
      requestAnimationFrame(() => { const input = $('#problemName'); if (input) input.focus(); });
    } });
    return;
  }
  if (action === 'select-problem') { selectedProblemId = button.dataset.id; problemMenuOpenId = null; render(); return; }
  if (action === 'open-problem-menu') {
    const id = button.dataset.id;
    problemMenuOpenId = problemMenuOpenId === id ? null : id;
    render();
    const toggle = $(`[data-action="open-problem-menu"][data-id="${id}"]`);
    if (toggle) toggle.focus();
    return;
  }
  if (action === 'retry-problem-save') {
    const snapshot = problemRetry;
    if (!snapshot) return;
    setProblemStatus('正在保存…');
    clearTimeout(problemTimer);
    problemTimer = null;
    await persistProblemSnapshot(snapshot);
    return;
  }
  if (action === 'move-problem') {
    problemMenuOpenId = null;
    await flatMoveOrder('problems', button.dataset.id, button.dataset.dir); return;
  }
  if (action === 'delete-problem') {
    const problem = state.problems.find((item) => item.id === button.dataset.id);
    openConfirmModal({ title: `删除「${problem.name}」？`, message: `问题拆解内容和备注会移入垃圾站。${TRASH_HINT}`, onConfirm: async () => {
      if (selectedProblemId === problem.id && !(await flushPendingSaves())) throw new Error('问题尚未保存成功，请重试后再删除');
      const index = state.problems.findIndex((item) => item.id === problem.id);
      await api('DELETE', `/api/problems/${problem.id}`);
      if (problemRetry?.id === problem.id) problemRetry = null;
      state.problems = state.problems.filter((item) => item.id !== problem.id);
      const nextIndex = Math.min(Math.max(index, 0), state.problems.length - 1);
      selectedProblemId = state.problems[nextIndex]?.id || null;
      problemMenuOpenId = null;
      render();
    } });
    return;
  }

  // ---------- 分类模板库（学习专区沿用旧操作名，逻辑走通用实现） ----------
  if (action === 'add-learning') return libraryAddTemplate('learning');
  if (action === 'select-learning') return librarySelectTemplate('learning', button.dataset.id);
  if (action === 'open-learning-menu') return libraryToggleMenu('learning', button.dataset.id);
  if (action === 'retry-learning-save') return libraryRetrySave('learning');
  if (action === 'move-learning') return libraryMoveTemplate('learning', button.dataset.id, button.dataset.dir);
  if (action === 'delete-learning') return libraryDeleteTemplate('learning', button.dataset.id);
  if (action === 'toggle-learning-filter') return libraryToggleFilterMenu('learning');
  if (action === 'set-learning-filter') return librarySetFilter('learning', button.dataset.filter);
  if (action === 'add-learning-category') return libraryAddCategory('learning');
  if (action === 'open-learning-category-manager') {
    render();
    openLibraryCategoryManager('learning');
    return;
  }
  if (action === 'rename-learning-category') return libraryRenameCategory('learning', button.dataset.id);
  if (action === 'delete-learning-category') return libraryDeleteCategory('learning', button.dataset.id);

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
    openConfirmModal({ title: `删除「${section.name}」？`, message: `该原则下的条目和历史打卡记录也会移入垃圾站。${TRASH_HINT}`, onConfirm: async () => {
      const ids = (section.items || []).flatMap((item) => [item.id, ...(item.children || []).map((child) => child.id)]);
      await api('DELETE', `/api/sections/${section.id}`); state.sections = state.sections.filter((item) => item.id !== section.id); forgetCheckinIds(ids); render();
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
    openConfirmModal({ title: `删除「${item.name}」？`, message: `这个条目、其子节点及相关打卡记录会移入垃圾站。${TRASH_HINT}`, onConfirm: async () => {
      const ids = [item.id, ...(item.children || []).map((child) => child.id)];
      await api('DELETE', `/api/sections/${section.id}/items/${item.id}`); section.items = section.items.filter((entry) => entry.id !== item.id); forgetCheckinIds(ids); render();
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
    openConfirmModal({ title: `删除「${child.name}」？`, message: `这个子节点和它的打卡记录会移入垃圾站。${TRASH_HINT}`, onConfirm: async () => {
      await api('DELETE', `/api/sections/${section.id}/items/${item.id}/children/${child.id}`);
      item.children = item.children.filter((entry) => entry.id !== child.id);
      forgetCheckinIds([child.id]);
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
    openConfirmModal({ title: `删除「${framework.name}」？`, message: `这个问题和历史回答会移入垃圾站。${TRASH_HINT}`, onConfirm: async () => {
      await api('DELETE', `/api/reflect/frameworks/${framework.id}`);
      state.reflectFrameworks = state.reflectFrameworks.filter((item) => item.id !== framework.id);
      for (const date of Object.keys(state.reflectEntries)) {
        if (!state.reflectEntries[date]) continue;
        delete state.reflectEntries[date][framework.id];
        if (!Object.keys(state.reflectEntries[date]).length) delete state.reflectEntries[date];
      }
      render();
    } });
    return;
  }

  if (action === 'add-plan') {
    openFormModal({ eyebrow: '计划', title: '新建计划', label: '计划名称', placeholder: '例如：完成个人作品集', submitText: '建立计划', onSubmit: async (name) => {
      if (!(await flushPendingSaves())) throw new Error('当前内容尚未保存成功，请重试');
      const filter = flatState('plans').categoryFilter;
      const categoryId = filter !== 'all' && filter !== 'none' ? filter : null;
      const result = await api('POST', '/api/plans', { name, categoryId });
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
    await flatMoveOrder('plans', button.dataset.id, button.dataset.dir); return;
  }
  if (action === 'delete-plan') {
    const plan = state.plans.find((item) => item.id === button.dataset.id);
    openConfirmModal({ title: `删除「${plan.name}」？`, message: `计划描述和笔记会移入垃圾站。${TRASH_HINT}`, onConfirm: async () => {
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
    return;
  }

  // ---------- 个人模板 ----------
  if (action === 'add-template') {
    openFormModal({ eyebrow: '个人模板', title: '新建模板', label: '模板名称', placeholder: '例如：周报框架、复盘提纲、活动清单', submitText: '建立模板', onSubmit: async (name) => {
      if (!(await flushPendingSaves())) throw new Error('当前内容尚未保存成功，请重试');
      const filter = flatState('templates').categoryFilter;
      const categoryId = filter !== 'all' && filter !== 'none' ? filter : null;
      const result = await api('POST', '/api/templates', { name, categoryId });
      state.templates.push(result.template);
      selectedTemplateId = result.template.id;
      templateMenuOpenId = null;
      render();
      requestAnimationFrame(() => { const input = $('#templateName'); if (input) input.focus(); });
    } });
    return;
  }
  if (action === 'select-template') { selectedTemplateId = button.dataset.id; templateMenuOpenId = null; render(); return; }
  if (action === 'move-template') {
    templateMenuOpenId = null;
    await flatMoveOrder('templates', button.dataset.id, button.dataset.dir); return;
  }
  if (action === 'delete-template') {
    const template = state.templates.find((item) => item.id === button.dataset.id);
    openConfirmModal({ title: `删除「${template.name}」？`, message: `模板内容和备注会移入垃圾站。${TRASH_HINT}`, onConfirm: async () => {
      if (selectedTemplateId === template.id && !(await flushPendingSaves())) throw new Error('模板尚未保存成功，请重试后再删除');
      const index = state.templates.findIndex((item) => item.id === template.id);
      await api('DELETE', `/api/templates/${template.id}`);
      if (templateRetry?.id === template.id) templateRetry = null;
      state.templates = state.templates.filter((item) => item.id !== template.id);
      const nextIndex = Math.min(Math.max(index, 0), state.templates.length - 1);
      selectedTemplateId = state.templates[nextIndex]?.id || null;
      templateMenuOpenId = null;
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

function resetThoughtsSurface() {
  thoughtSurface = 'history';
  selectedHistoryKey = null;
  thoughtHistoryFilter = 'free';
  thoughtHistoryCategory = { free: 'all', review: 'all', extraction: 'all' };
  thoughtHistoryQuery = '';
  historyListScroll = { app: 0, window: 0 };
}

function resetViewMenus() {
  planMenuOpenId = null;
  templateMenuOpenId = null;
  problemMenuOpenId = null;
  for (const rt of Object.values(libraryRuntime)) {
    rt.menuOpenId = null;
    rt.filterMenuOpen = false;
  }
  eventMenuKey = null;
}

// 进入指定界面的指定视图（preferredView 为空时取该界面上次访问或第一项，空界面为 null）
async function enterWorkspaceView(workspace, preferredView) {
  LifeDrawings.leaveForNavigation();
  if (customCreationPromise) await customCreationPromise;
  if (settingsSaving) await settingsSaving;
  if (thoughtDraft && !hasThoughtContent(thoughtDraft)) thoughtDraft = null;
  currentWorkspace = workspace;
  currentView = resolveWorkspaceView(workspace, preferredView ?? null);
  if (currentView === 'thoughts') resetThoughtsSurface();
  resetViewMenus();
  recordNavigationContext(workspace, currentView);
  render();
  if (currentView === 'thoughts') {
    $('#app').scrollTop = 0;
    window.scrollTo(0, 0);
  }
  $('#app').focus({ preventScroll: true });
}

async function changeView(view, openTab) {
  if (customCreationPromise) await customCreationPromise;
  if (settingsSaving) await settingsSaving;
  if (view === 'drawingManager') {
    if (currentView === 'settings' && settingsDirty) { openLeaveSettingsModal(() => changeView(view)); return; }
    if (!(await flushPendingSaves())) return;
    LifeDrawings.leaveForNavigation();
    currentView = 'drawingManager'; resetViewMenus();
    await DrawingManagerUI.load(); render(); $('#app').focus({ preventScroll: true }); return;
  }
  // 设置页本身：进入时从已保存配置复制草稿；已在设置页时再次点击不重置草稿
  if (view === 'settings') {
    if (currentView === 'settings') {
      if (LifeDrawings.active && await flushPendingSaves()) LifeDrawings.leaveForNavigation();
      return;
    }
    if (!(await flushPendingSaves())) return;
    LifeDrawings.leaveForNavigation();
    settingsReturn = { workspace: currentWorkspace, view: isModuleView(currentView) || currentView === null ? currentView : null };
    currentView = 'settings';
    initSettingsDraft();
    resetViewMenus();
    try { trashEntries = (await api('GET', '/api/trash')).entries || []; } catch (error) { toast(error.message, true); }
    render();
    $('#app').focus({ preventScroll: true });
    return;
  }
  if (!isModuleView(view)) return;
  // 通用模块跳转：设置/其他入口跳某模块时，先找到该模块当前归属再进入
  const workspace = placementOfModule(view);
  if (currentView === 'settings' && settingsDirty) {
    openLeaveSettingsModal(() => changeView(view, openTab));
    return;
  }
  if (currentView === 'thoughts' && thoughtSurface === 'editor' && isArticleMode() && !(await flushThoughtSave())) return;
  if (!(await flushPendingSaves())) return;
  if (openTab) currentPrincipleTab = openTab;
  // 再次点击当前模块导航保持旧行为：重置该模块的界面状态并重绘
  await enterWorkspaceView(workspace, view);
}

async function handleSwitchWorkspace() {
  if (customCreationPromise) await customCreationPromise;
  if (settingsSaving) await settingsSaving;
  if (currentView === 'settings' && settingsDirty) {
    openLeaveSettingsModal(() => handleSwitchWorkspace());
    return;
  }
  if (currentView === 'thoughts' && thoughtSurface === 'editor' && isArticleMode() && !(await flushThoughtSave())) return;
  if (!(await flushPendingSaves())) return;
  // 切换后优先打开目标界面上次访问且仍归属它的模块，否则第一项
  const target = currentWorkspace === 'main' ? 'zone' : 'main';
  const last = navigationPreferences?.lastViewByWorkspace?.[target];
  await enterWorkspaceView(target, last ?? null);
}

// 取消：恢复已保存草稿并返回进入设置前的有效模块；没有模块则回到该界面空状态
async function cancelSettings() {
  if (customCreationPromise) await customCreationPromise;
  if (settingsSaving) await settingsSaving;
  initSettingsDraft();
  const target = settingsReturn || { workspace: currentWorkspace, view: null };
  if (!(await flushPendingSaves())) return;
  await enterWorkspaceView(target.workspace, target.view ?? null);
}

function bindGlobalEvents() {
  document.addEventListener('click', async (event) => {
    const drawerRoot = $('#eventDrawerRoot');
    if (drawerRoot && !drawerRoot.classList.contains('hidden') && event.target.id === 'eventDrawerRoot') {
      closeEventDrawer();
      return;
    }
    const openLibraryMenus = Object.values(libraryRuntime).some((rt) => rt.menuOpenId || rt.filterMenuOpen || rt.moveMenuOpenId);
    const openFlatMenus = Object.values(flatCollectionRuntime).some((rt) => rt.moveMenuOpenId || rt.filterMenuOpen);
    if (planMenuOpenId || templateMenuOpenId || problemMenuOpenId || openLibraryMenus || openFlatMenus || eventMenuKey) {
      const onPlanMenu = event.target.closest('[data-plan-menu]') || event.target.closest('[data-action="open-plan-menu"]');
      const onTemplateMenu = event.target.closest('[data-template-menu]') || event.target.closest('[data-action="open-template-menu"]');
      const onProblemMenu = event.target.closest('[data-problem-menu]') || event.target.closest('[data-action="open-problem-menu"]');
      const onEventMenu = event.target.closest('[data-event-menu]') || event.target.closest('[data-action="open-event-menu"]');
      let dirty = false;
      if (planMenuOpenId && !onPlanMenu) { planMenuOpenId = null; dirty = true; }
      if (templateMenuOpenId && !onTemplateMenu) { templateMenuOpenId = null; dirty = true; }
      if (problemMenuOpenId && !onProblemMenu) { problemMenuOpenId = null; dirty = true; }
      for (const collection of Object.keys(flatCollectionRuntime)) {
        const rt = flatState(collection);
        if (!rt.moveMenuOpenId && !rt.filterMenuOpen) continue;
        const inFlat = event.target.closest(`[data-flat-filter-menu="${collection}"]`)
          || event.target.closest(`[data-flat-move-menu="${collection}"]`)
          || event.target.closest(`[data-action="${flatAction(collection, 'toggle-filter')}"]`)
          || event.target.closest(`[data-action="${flatAction(collection, 'open-move-menu')}"]`)
          || event.target.closest(`[data-action="${flatAction(collection, 'add-category')}"]`)
          || event.target.closest(`[data-action="${flatAction(collection, 'open-category-manager')}"]`);
        if (rt.moveMenuOpenId && !inFlat) { rt.moveMenuOpenId = null; dirty = true; }
        if (rt.filterMenuOpen && !inFlat) { rt.filterMenuOpen = false; dirty = true; }
      }
      for (const [moduleId, rt] of Object.entries(libraryRuntime)) {
        if (!rt.menuOpenId && !rt.filterMenuOpen) continue;
        const menuAction = libraryActionName(moduleId, 'menu');
        const filterAction = libraryActionName(moduleId, 'toggle-filter');
        const inMenu = event.target.closest('[data-library-menu]') || event.target.closest('[data-library-move-menu]') || event.target.closest('[data-action="library-open-move-menu"]') || event.target.closest(`[data-action="${menuAction}"]`);
        const inFilter = event.target.closest('[data-library-filter-menu]') || event.target.closest(`[data-action="${filterAction}"]`);
        if (rt.menuOpenId && !inMenu) { rt.menuOpenId = null; dirty = true; }
        if (rt.moveMenuOpenId && !inMenu) { rt.moveMenuOpenId = null; dirty = true; }
        if (rt.filterMenuOpen && !inFilter) { rt.filterMenuOpen = false; dirty = true; }
      }
      if (eventMenuKey && !onEventMenu) { eventMenuKey = null; dirty = true; }
      if (dirty && (currentView === 'plans' || currentView === 'templates' || currentView === 'problems' || LIBRARY_MODULES[currentView] || currentView === 'events')) render();
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
      if ($('#richImageViewer')?.open) { $('#richImageViewer').close(); return; }
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
    if (customCreationPromise || thinkTimer || thoughtSavePromise || thinkRetry || reflectTimer || reflectSavePromise || reflectRetry || planTimer || planSavePromise || planRetry || templateTimer || templateSavePromise || templateRetry || problemTimer || problemSavePromise || problemRetry || hasPendingLibrarySaves() || hasPendingRichEditorUploads() || LifeDrawings.dirty) {
      if (!dataRestoreLock) void flushPendingSaves();
      event.preventDefault();
      event.returnValue = '';
    }
  });
}

async function reloadLiveState() {
  const [result, backupResult, trashResult] = await Promise.all([
    api('GET', '/api/state'),
    api('GET', '/api/backups'),
    api('GET', '/api/trash'),
  ]);
  const draft = settingsDraft ? { moduleOrder: [...settingsDraft.moduleOrder], placementByModule: { ...settingsDraft.placementByModule } } : null;
  const dirty = settingsDirty;
  trashedModuleIds = result.trashedModuleIds || [];
  trashEntries = trashResult.entries || [];
  state = {
    version: result.version || 0,
    customModules: result.customModules || [],
    sections: result.sections || [],
    records: result.records || {},
    checkinReasons: result.checkinReasons || {},
    thoughtEntries: normalizeLoadedThoughts(result),
    thoughtCategories: result.thoughtCategories || [],
    reflectFrameworks: result.reflectFrameworks || [],
    reflectEntries: result.reflectEntries || {},
    plans: result.plans || [],
    templates: result.templates || [],
    problems: result.problems || [],
    planCategories: result.planCategories || [],
    templateCategories: result.templateCategories || [],
    problemCategories: result.problemCategories || [],
    learningCategories: result.learningCategories || [],
    learningTemplates: result.learningTemplates || [],
    coreThoughtCategories: result.coreThoughtCategories || [],
    coreThoughtTemplates: result.coreThoughtTemplates || [],
    reviewTemplateCategories: result.reviewTemplateCategories || [],
    reviewTemplates: result.reviewTemplates || [],
    events: result.events || [],
    eventCheckins: result.eventCheckins || {},
    eventExceptions: result.eventExceptions || [],
    backups: backupResult.backups || [],
  };
  dataEpoch = result.dataEpoch;
  installCustomModules(state.customModules || [], true);
  navigationPreferences = normalizeNavigationPreferences(result.navigationPreferences);
  if (currentView === 'settings' && draft && dirty) {
    settingsDraft = {
      moduleOrder: draft.moduleOrder.filter((id) => MODULE_IDS.includes(id)),
      placementByModule: Object.fromEntries(Object.entries(draft.placementByModule).filter(([id]) => MODULE_IDS.includes(id))),
    };
    for (const id of navigationPreferences.moduleOrder) {
      if (!settingsDraft.moduleOrder.includes(id)) settingsDraft.moduleOrder.push(id);
      if (!settingsDraft.placementByModule[id]) settingsDraft.placementByModule[id] = navigationPreferences.placementByModule[id];
    }
    settingsBaseRevision = navigationPreferences.revision;
    settingsDirty = settingsDraftChanged();
  } else if (currentView === 'settings') initSettingsDraft();
  if (currentView && currentView !== 'settings' && currentView !== 'drawingManager' && !isModuleView(currentView)) {
    currentView = resolveWorkspaceView(currentWorkspace, navigationPreferences.lastViewByWorkspace[currentWorkspace]);
  }
  if (settingsReturn?.view && !isModuleView(settingsReturn.view)) settingsReturn.view = null;
  if (!state.plans.some((item) => item.id === selectedPlanId)) selectedPlanId = state.plans[0]?.id || null;
  if (!state.templates.some((item) => item.id === selectedTemplateId)) selectedTemplateId = state.templates[0]?.id || null;
  if (!state.problems.some((item) => item.id === selectedProblemId)) selectedProblemId = state.problems[0]?.id || null;
  if (!state.thoughtEntries.some((item) => item.id === selectedThoughtId)) selectedThoughtId = null;
  for (const moduleId of Object.keys(LIBRARY_MODULES)) {
    const runtime = libraryState(moduleId);
    if (!libraryTemplates(moduleId).some((item) => item.id === runtime.selectedId)) runtime.selectedId = libraryTemplates(moduleId)[0]?.id || null;
  }
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
      customModules: result.customModules || [],
      sections: result.sections || [],
      records: result.records || {},
      checkinReasons: result.checkinReasons || {},
      thoughtEntries: normalizeLoadedThoughts(result),
      thoughtCategories: result.thoughtCategories || [],
      reflectFrameworks: result.reflectFrameworks || [],
      reflectEntries: result.reflectEntries || {},
      plans: result.plans || [],
      templates: result.templates || [],
      problems: result.problems || [],
      planCategories: result.planCategories || [],
      templateCategories: result.templateCategories || [],
      problemCategories: result.problemCategories || [],
      learningCategories: result.learningCategories || [],
      learningTemplates: result.learningTemplates || [],
      coreThoughtCategories: result.coreThoughtCategories || [],
      coreThoughtTemplates: result.coreThoughtTemplates || [],
      reviewTemplateCategories: result.reviewTemplateCategories || [],
      reviewTemplates: result.reviewTemplates || [],
      events: result.events || [],
      eventCheckins: result.eventCheckins || {},
      eventExceptions: result.eventExceptions || {},
      backups: backupResult.backups || [],
    };
    // 启动恢复最近打开的界面与有效模块；无配置时进入 main/events
    dataEpoch = result.dataEpoch;
    trashedModuleIds = result.trashedModuleIds || [];
    await LifeDrawings.load();
    installCustomModules(result.customModules || [], true);
    navigationPreferences = normalizeNavigationPreferences(result.navigationPreferences);
    currentWorkspace = navigationPreferences.lastWorkspace === 'zone' ? 'zone' : 'main';
    currentView = resolveWorkspaceView(currentWorkspace, navigationPreferences.lastViewByWorkspace[currentWorkspace]);
    if (currentView === 'thoughts') resetThoughtsSurface();
    selectedPlanId = state.plans[0]?.id || null;
    selectedTemplateId = state.templates[0]?.id || null;
    selectedProblemId = state.problems[0]?.id || null;
    for (const moduleId of Object.keys(LIBRARY_MODULES)) {
      libraryState(moduleId).selectedId = libraryTemplates(moduleId)[0]?.id || null;
    }
    const localNote = $('#localNoteText');
    if (localNote && result.appVersion) localNote.textContent = `数据仅保存在本地 · v${result.appVersion}`;
    render();
    const startupDrawing = new URLSearchParams(location.search).get('drawing');
    if (startupDrawing) {
      const library = new URLSearchParams(location.hash.slice(1)).get('addLibrary');
      await LifeDrawings.open(startupDrawing, '', library ? 'edit' : 'view', library || '');
    }
  } catch (error) {
    $('#app').innerHTML = emptyState('triangle-alert', '数据加载失败', error.message, '<button class="button ghost" onclick="location.reload()">重新加载</button>');
    renderIcons();
  }
}

init();
