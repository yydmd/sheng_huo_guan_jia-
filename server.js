'use strict';

/**
 * 生活管家 · 本地服务
 *
 * - 零第三方依赖，仅使用 Node.js 内置模块。
 * - 提供静态页面托管 + JSON 文件存储 + REST API。
 * - 数据保存在 ./data/data.json，写入采用「临时文件 + 重命名」保证原子性。
 *
 * 用法：
 *   node server.js [--port 4000] [--no-open]
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const CustomModuleModel = require('./public/custom-module-model');
const { createDrawingStore } = require('./drawing-store');
const { createDrawingManager } = require('./drawing-manager');
const { createTrashStore } = require('./trash-store');
let dataEpoch = crypto.randomUUID();
const { spawn, exec } = require('child_process');

// 打包版（asar 内）与源码目录中 package.json 均与 server.js 同级
let APP_VERSION = null;
try { APP_VERSION = require('./package.json').version || null; } catch (_) { /* 缺失时前端不显示版本 */ }

const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
const DATA_DIR = process.env.LIFE_STEWARD_DATA_DIR
  ? path.resolve(process.env.LIFE_STEWARD_DATA_DIR)
  : path.join(ROOT, 'data');
const DATA_FILE = path.join(DATA_DIR, 'data.json');
const REVIEW_IMAGE_DIR = path.join(DATA_DIR, 'review-images');
const TRASH_DIR = path.join(DATA_DIR, 'trash');
const BACKUP_DIR = path.join(DATA_DIR, 'backups');
const REVIEW_IMAGE_ID = /^[a-f0-9-]{36}\.(png|jpg|webp|gif)$/;
const BACKUP_ID = /^backup-[0-9]{8}-[0-9]{6}-[a-f0-9-]{36}$/;
const REVIEW_IMAGE_LIMIT = 10 * 1024 * 1024;
const RICH_BLOCK_ID = /^[a-zA-Z0-9-]{1,80}$/;
const RICH_BLOCK_LIMIT = 120;
const RICH_IMAGE_LIMIT = 20;
const RICH_IMAGE_MIN_WIDTH = 20;
const RICH_IMAGE_MAX_WIDTH = 100;
const THOUGHT_KINDS = ['free', 'review', 'extraction'];
let drawingManager;
const drawingStore = createDrawingStore({ dataDir: DATA_DIR, writeJSON, getEpoch: () => dataEpoch, detectImageType, isDeleted: id => drawingManager?.isDeleted(id) || false });
const trashStore = createTrashStore({
  dataDir: DATA_DIR,
  writeJSON,
  imageDir: REVIEW_IMAGE_DIR,
  drawingDir: drawingStore.directory,
  imageIdTest: (id) => REVIEW_IMAGE_ID.test(id || ''),
  drawingIdTest: (id) => drawingStore.UUID.test(id || ''),
});
drawingManager = createDrawingManager({ dataDir: DATA_DIR, store: drawingStore, writeJSON, readData, saveData, getEpoch: () => dataEpoch, trash: trashStore });

// ---------------------------------------------------------------- 模块注册与导航配置

// 九个业务模块的稳定 ID（顺序即默认全局顺序；设置、品牌、切换按钮为固定入口不参与分配）
const MODULE_IDS = [
  'events', 'principles', 'problems', 'plans', 'thoughts',
  'templates', 'learning', 'coreThoughts', 'reviewTemplates',
];
const MODULE_NAMES = {
  events: '重要时间点', principles: '原则打卡', problems: '问题拆解', plans: '计划',
  thoughts: '所思', templates: '个人模板', learning: '学习专区', coreThoughts: '核心思想', reviewTemplates: '复盘',
};
const MODULE_COLLECTIONS = {
  events: ['events', 'eventCheckins', 'eventExceptions'],
  principles: ['sections', 'records', 'checkinReasons'],
  problems: ['problems', 'problemCategories'],
  plans: ['plans', 'planCategories'],
  thoughts: ['thoughtEntries', 'thoughtCategories', 'reflectFrameworks', 'reflectEntries'],
  templates: ['templates', 'templateCategories'],
  learning: ['learningTemplates', 'learningCategories'],
  coreThoughts: ['coreThoughtTemplates', 'coreThoughtCategories'],
  reviewTemplates: ['reviewTemplates', 'reviewTemplateCategories'],
};
const DEFAULT_MODULE_PLACEMENT = {
  events: 'main', principles: 'main', problems: 'zone',
  plans: 'main', thoughts: 'main', templates: 'main',
  learning: 'zone', coreThoughts: 'zone', reviewTemplates: 'zone',
};
const WORKSPACE_IDS = ['main', 'zone'];

function effectiveModuleIds(data) {
  const hidden = new Set(Array.isArray(data?.trashedModuleIds) ? data.trashedModuleIds : []);
  return [...MODULE_IDS.filter((id) => !hidden.has(id)), ...(data?.customModules || []).map((entry) => entry.id)];
}

function moduleDefaults(data) {
  return { ...DEFAULT_MODULE_PLACEMENT, ...Object.fromEntries((data?.customModules || []).map((entry) => [entry.id, entry.defaultPlacement])) };
}

function navigationSnapshot(data) {
  return { navigationPreferences: data.navigationPreferences, customModules: data.customModules, trashedModuleIds: data.trashedModuleIds || [], dataEpoch };
}

function requireDataEpoch(req, res) {
  const epoch = req.headers['x-life-data-epoch'];
  if (!epoch) { sendJSON(res, 400, { error: '缺少数据代次，请重新载入', code: 'DATA_EPOCH_REQUIRED', commitState: 'not_committed' }); return false; }
  if (epoch !== dataEpoch) { sendJSON(res, 409, { error: '数据已恢复或服务已重启，请确认重新载入', code: 'DATA_EPOCH_CHANGED', commitState: 'not_committed' }); return false; }
  return true;
}

function defaultNavigationPreferences(data) {
  return {
    schemaVersion: 1,
    revision: 0,
    moduleOrder: effectiveModuleIds(data),
    placementByModule: moduleDefaults(data),
    lastWorkspace: 'main',
    lastViewByWorkspace: { main: 'events', zone: 'problems' },
  };
}

function validWorkspace(value) {
  return WORKSPACE_IDS.includes(value);
}

// 规范化导航配置：保留有效偏好的相对顺序与归属，补缺失模块，剔除未知/重复项。
// 永不抛错；repaired 表示与输入相比发生了变化（需要落盘一次）。
function normalizeNavigationPreferences(raw, data) {
  const ids = effectiveModuleIds(data);
  const defaults = defaultNavigationPreferences(data);
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { prefs: defaults, repaired: false, absent: true };
  }
  let repaired = false;
  const rawOrder = Array.isArray(raw.moduleOrder) ? raw.moduleOrder : [];
  const seen = new Set();
  const order = [];
  for (const id of rawOrder) {
    if (ids.includes(id) && !seen.has(id)) { seen.add(id); order.push(id); }
    else repaired = true;
  }
  for (const id of ids) {
    if (!seen.has(id)) { order.push(id); repaired = true; }
  }
  const rawPlacement = raw.placementByModule && typeof raw.placementByModule === 'object' && !Array.isArray(raw.placementByModule)
    ? raw.placementByModule
    : {};
  const placement = {};
  const placementKeys = new Set(Object.keys(rawPlacement));
  for (const id of ids) {
    const value = rawPlacement[id];
    if (validWorkspace(value)) placement[id] = value;
    else { placement[id] = defaults.placementByModule[id]; repaired = true; }
  }
  for (const key of placementKeys) {
    if (!ids.includes(key)) repaired = true;
  }
  const workspaceModules = (ws) => order.filter((id) => placement[id] === ws);
  const lastWorkspace = validWorkspace(raw.lastWorkspace) ? raw.lastWorkspace : 'main';
  if (!validWorkspace(raw.lastWorkspace)) repaired = true;
  const rawLastView = raw.lastViewByWorkspace && typeof raw.lastViewByWorkspace === 'object' && !Array.isArray(raw.lastViewByWorkspace)
    ? raw.lastViewByWorkspace
    : {};
  const lastView = {};
  for (const ws of WORKSPACE_IDS) {
    const ids = workspaceModules(ws);
    const value = rawLastView[ws];
    if (ids.includes(value) || (value === null && ids.length === 0)) lastView[ws] = value;
    else { lastView[ws] = ids[0] || null; repaired = true; }
  }
  const revision = Number.isInteger(raw.revision) && raw.revision >= 0 ? raw.revision : 0;
  if (!Number.isInteger(raw.revision) || raw.revision < 0) repaired = true;
  const schemaVersion = 1;
  if (raw.schemaVersion !== 1) repaired = true;
  return {
    prefs: { schemaVersion, revision, moduleOrder: order, placementByModule: placement, lastWorkspace, lastViewByWorkspace: lastView },
    repaired,
    absent: false,
  };
}

// 分类模板库配置：学习专区保留旧路由，核心思想/复盘使用新前缀，同一处理器按配置映射集合
const LIBRARY_MODULES = {
  'core-thought': {
    categoryField: 'coreThoughtCategories',
    templateField: 'coreThoughtTemplates',
    categoryPath: '/api/core-thought/categories',
    templatePath: '/api/core-thought/templates',
  },
  'review-template': {
    categoryField: 'reviewTemplateCategories',
    templateField: 'reviewTemplates',
    categoryPath: '/api/review-template/categories',
    templatePath: '/api/review-template/templates',
  },
};

// 三个原有扁平模块的分类集合。条目仍保留在原数组中，分类只通过 categoryId 建立归属，
// 这样旧路由和原有全局排序可以继续工作。
const FLAT_CATEGORY_MODULES = {
  templates: { categoryField: 'templateCategories', itemField: 'templates', label: '模板' },
  plans: { categoryField: 'planCategories', itemField: 'plans', label: '计划' },
  problems: { categoryField: 'problemCategories', itemField: 'problems', label: '问题' },
};

const HOST = process.env.HOST || '127.0.0.1';
const PORT = parseInt(process.env.PORT || argValue('--port') || '4000', 10);
const NO_OPEN = process.argv.includes('--no-open') || process.env.NO_OPEN === '1';

function argValue(flag) {
  const i = process.argv.indexOf(flag);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : null;
}

// ---------------------------------------------------------------- 存储层

function freshData() {
  return {
    version: 11,
    customModulesSchemaVersion: 1,
    categorizedCollectionsSchemaVersion: 1,
    customModules: [],
    trashedModuleIds: [],
    sections: [],           // 原则（行）
    records: {},            // 打卡记录（按日期）
    checkinReasons: {},     // 未完成原因：{ 'YYYY-MM-DD': { nodeId: '原因' } }
    thoughtEntries: [],     // 所思文章：[{ id, kind: 'free'|'review'|'extraction', date, title, text, categoryId, createdAt, updatedAt }]
    thoughtCategories: [],  // 文章类别：[{ id, kind: 'free'|'review'|'extraction', name, createdAt }]
    reflectFrameworks: [],  // 所思-反思框架（省）：[{ id, name }]
    reflectEntries: {},     // 所思-反思内容：{ 'YYYY-MM-DD': { frameworkId: 'text' } }
    plans: [],              // 计划：[{ id, categoryId, name, description, note }]
    templates: [],          // 个人模板：[{ id, categoryId, name, content, note }]
    problems: [],           // 问题拆解：[{ id, categoryId, name, content, note }]
    planCategories: [],
    templateCategories: [],
    problemCategories: [],
    learningCategories: [], // 学习专区分类：[{ id, name, createdAt }]
    learningTemplates: [],  // 学习专区模板：[{ id, categoryId(null=未分类), name, content, note, createdAt, updatedAt }]
    coreThoughtCategories: [], // 核心思想分类：[{ id, name, createdAt }]
    coreThoughtTemplates: [], // 核心思想模板：[{ id, categoryId, name, content, note, createdAt, updatedAt }]
    reviewTemplateCategories: [], // 复盘分类：[{ id, name, createdAt }]
    reviewTemplates: [],     // 复盘模板：[{ id, categoryId, name, content, note, createdAt, updatedAt }]
    navigationPreferences: defaultNavigationPreferences(), // 界面导航：模块顺序、归属与最近视图
    events: [],             // 事件安排模板：[{ id, title, note, time, startDate, endDate, repeat, enabled, createdAt, archivedAt }]
    eventCheckins: {},      // 事件完成记录：{ 'eventId@YYYY-MM-DD': { done, completedAt } }
    eventExceptions: [],    // 重复事件例外：[{ eventId, date, type: 'override'|'cancel', changes }]
  };
}

function ensureDataFile() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(DATA_FILE)) {
    writeJSON(DATA_FILE, freshData());
  }
}

function writeJSON(file, obj) {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

function backupId() {
  const now = new Date();
  const stamp = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}-${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}${String(now.getSeconds()).padStart(2, '0')}`;
  return `backup-${stamp}-${newId()}`;
}

function copyDirectory(source, destination) {
  if (!fs.existsSync(source)) return;
  fs.mkdirSync(destination, { recursive: true });
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    const from = path.join(source, entry.name);
    const to = path.join(destination, entry.name);
    if (entry.isDirectory()) copyDirectory(from, to);
    else if (entry.isFile()) fs.copyFileSync(from, to);
  }
}

function createBackup(label = 'manual') {
  ensureDataFile();
  const id = backupId();
  const temporary = path.join(BACKUP_DIR, `.${id}.tmp`);
  const target = path.join(BACKUP_DIR, id);
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  fs.mkdirSync(temporary, { recursive: true });
  try {
    fs.copyFileSync(DATA_FILE, path.join(temporary, 'data.json'));
    copyDirectory(REVIEW_IMAGE_DIR, path.join(temporary, 'review-images'));
    copyDirectory(drawingStore.directory, path.join(temporary, 'drawings'));
    copyDirectory(TRASH_DIR, path.join(temporary, 'trash'));
    fs.writeFileSync(path.join(temporary, 'manifest.json'), JSON.stringify({ id, label, createdAt: new Date().toISOString() }, null, 2), 'utf8');
    fs.renameSync(temporary, target);
    return backupSummary(id);
  } catch (error) {
    try { fs.rmSync(temporary, { recursive: true, force: true }); } catch (_) { /* ignore cleanup failure */ }
    throw error;
  }
}

function backupSummary(id) {
  if (!BACKUP_ID.test(id)) return null;
  const directory = path.join(BACKUP_DIR, id);
  const manifestFile = path.join(directory, 'manifest.json');
  const dataFile = path.join(directory, 'data.json');
  if (!fs.existsSync(dataFile)) return null;
  let manifest = {};
  try { manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8')); } catch (_) { /* legacy/incomplete backup */ }
  const imageDirectory = path.join(directory, 'review-images');
  const imageCount = fs.existsSync(imageDirectory)
    ? fs.readdirSync(imageDirectory, { withFileTypes: true }).filter((entry) => entry.isFile()).length
    : 0;
  const drawingDirectory = path.join(directory, 'drawings');
  const drawingCount = fs.existsSync(drawingDirectory) ? fs.readdirSync(drawingDirectory).filter((id) => drawingStore.UUID.test(id)).length : 0;
  return { id, createdAt: manifest.createdAt || fs.statSync(directory).birthtime.toISOString(), label: manifest.label || 'manual', imageCount, drawingCount };
}

function listBackups() {
  if (!fs.existsSync(BACKUP_DIR)) return [];
  return fs.readdirSync(BACKUP_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && BACKUP_ID.test(entry.name))
    .map((entry) => backupSummary(entry.name))
    .filter(Boolean)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

function restoreBackup(id) {
  const summary = backupSummary(id);
  if (!summary) throw new Error('备份不存在或格式不完整');
  const source = path.join(BACKUP_DIR, id);
  let restored;
  try { restored = JSON.parse(fs.readFileSync(path.join(source, 'data.json'), 'utf8')); } catch (_) { throw new Error('备份数据无法读取'); }
  if (!restored || typeof restored !== 'object' || Array.isArray(restored)) throw new Error('备份数据格式错误');
  if (Object.prototype.hasOwnProperty.call(restored, 'customModules')) CustomModuleModel.validate(restored.customModules, restored.customModulesSchemaVersion);
  const safetyBackup = createBackup('before-restore');
  const originalJSON = fs.readFileSync(DATA_FILE);
  const areas = [REVIEW_IMAGE_DIR, drawingStore.directory, TRASH_DIR].map((target) => ({ target, temporary: `${target}.restore-tmp`, previous: `${target}.restore-previous`, moved: false, installed: false }));
  try {
    dataEpoch = crypto.randomUUID();
    for (const area of areas) {
      fs.rmSync(area.temporary, { recursive: true, force: true });
      copyDirectory(path.join(source, path.basename(area.target)), area.temporary);
      fs.rmSync(area.previous, { recursive: true, force: true });
    }
    for (const area of areas) {
      if (fs.existsSync(area.target)) { fs.renameSync(area.target, area.previous); area.moved = true; }
      if (fs.existsSync(area.temporary)) { fs.renameSync(area.temporary, area.target); area.installed = true; }
    }
    writeJSON(DATA_FILE, restored);
    richBlockMemory.clear();
    rememberRichData(restored);
  } catch (error) {
    try {
      for (const area of areas.reverse()) {
        if (area.installed) fs.rmSync(area.target, { recursive: true, force: true });
        if (area.moved) fs.renameSync(area.previous, area.target);
      }
      fs.writeFileSync(DATA_FILE, originalJSON);
      richBlockMemory.clear(); rememberRichData(JSON.parse(originalJSON));
    } catch (_) { /* preserve original error */ }
    throw error;
  }
  for (const area of areas) {
    try { fs.rmSync(area.previous, { recursive: true, force: true }); fs.rmSync(area.temporary, { recursive: true, force: true }); } catch (_) { /* recoverable staging files */ }
  }
  return { restored: summary, safetyBackup };
}

function parseDataFile(raw) {
  const data = typeof raw === 'string' ? JSON.parse(raw) : raw;
  if (!data || typeof data !== 'object') throw new Error('数据格式不正确');
  data.sections = Array.isArray(data.sections) ? data.sections : [];
  data.records = data.records && typeof data.records === 'object' ? data.records : {};
  data.checkinReasons = data.checkinReasons && typeof data.checkinReasons === 'object' ? data.checkinReasons : {};
  const legacyThinkEntries = data.thinkEntries && !Array.isArray(data.thinkEntries) && typeof data.thinkEntries === 'object'
    ? data.thinkEntries
    : null;
  data.thoughtEntries = Array.isArray(data.thoughtEntries) ? data.thoughtEntries : [];
  data.thoughtCategories = Array.isArray(data.thoughtCategories) ? data.thoughtCategories : [];
  data.reflectFrameworks = Array.isArray(data.reflectFrameworks) ? data.reflectFrameworks : [];
  data.reflectEntries = data.reflectEntries && typeof data.reflectEntries === 'object' ? data.reflectEntries : {};
  data.plans = Array.isArray(data.plans) ? data.plans : [];
  // 个人模板兼容：旧数据自动补空，不触碰其他字段
  if (!Array.isArray(data.templates)) data.templates = [];
  // v12 兼容：旧「问题归纳」待迁移（仅当存在旧字段且尚无新字段时转换）
  const legacyProblemTopics = Array.isArray(data.problemTopics) && !Array.isArray(data.problems)
    ? data.problemTopics
    : null;
  data.problems = Array.isArray(data.problems) ? data.problems : [];
  // 学习专区兼容：旧数据自动补空，不触碰其他字段
  if (!Array.isArray(data.learningCategories)) data.learningCategories = [];
  if (!Array.isArray(data.learningTemplates)) data.learningTemplates = [];
  // v5 兼容：事件安排字段
  if (!Array.isArray(data.events)) data.events = [];
  if (!data.eventCheckins || typeof data.eventCheckins !== 'object') data.eventCheckins = {};
  if (!Array.isArray(data.eventExceptions)) data.eventExceptions = [];
  if (legacyThinkEntries) {
    const migrationBackup = `${DATA_FILE}.bak-v5-${Date.now()}`;
    fs.copyFileSync(DATA_FILE, migrationBackup);
    for (const [date, rawText] of Object.entries(legacyThinkEntries)) {
      const text = String(rawText ?? '');
      if (!text.trim()) continue;
      const stamp = `${date}T00:00:00.000Z`;
      data.thoughtEntries.push({
        id: newId(),
        date,
        title: deriveThoughtTitle(text),
        text,
        categoryId: null,
        createdAt: stamp,
        updatedAt: stamp,
        legacyDate: date,
      });
    }
    delete data.thinkEntries;
  }
  if (legacyProblemTopics) {
    const migrationBackup = `${DATA_FILE}.bak-v12-${Date.now()}`;
    fs.copyFileSync(DATA_FILE, migrationBackup);
    // 旧「问题归纳」→ 问题拆解：每个主题转为一条拆解，条目文本逐行合并为内容
    for (const topic of legacyProblemTopics) {
      if (!topic || typeof topic !== 'object') continue;
      const content = (Array.isArray(topic.items) ? topic.items : [])
        .map((item) => String((item && item.text) ?? ''))
        .join('\n');
      data.problems.push({
        id: typeof topic.id === 'string' && topic.id ? topic.id : newId(),
        name: String(topic.name || '').trim(),
        content,
        note: '',
      });
    }
    delete data.problemTopics;
    saveData(data); // 迁移立即落盘，后续读取不再重复
  }
  if (typeof data.version !== 'number' || data.version < 8 || legacyThinkEntries) {
    if (!legacyThinkEntries) fs.copyFileSync(DATA_FILE, `${DATA_FILE}.bak-v${data.version || 'old'}-${Date.now()}`);
    // 原文章的 ID、日期、标题与正文不变；旧文章全部保持为自由思考。
    for (const entry of data.thoughtEntries) entry.kind = entry.kind === 'review' ? 'review' : 'free';
    data.version = 8;
    saveData(data); // 迁移立即落盘，后续读取不再重复
  }
  if (data.version < 9) {
    fs.copyFileSync(DATA_FILE, `${DATA_FILE}.bak-v${data.version || 8}-${Date.now()}`);
    const knownDates = Object.keys(data.records).filter(isISODate).sort();
    const fallbackDate = knownDates[0] || toISODateLocal(new Date());
    for (const section of data.sections) {
      for (const item of section.items || []) {
        if (!isISODate(item.activeSince)) item.activeSince = fallbackDate;
      }
    }
    data.version = 9;
    saveData(data);
  }
  if (data.version < 10) {
    fs.copyFileSync(DATA_FILE, `${DATA_FILE}.bak-v${data.version || 9}-${Date.now()}`);
    for (const section of data.sections) {
      for (const item of section.items || []) {
        if (!Array.isArray(item.children)) item.children = [];
      }
    }
    data.version = 10;
    saveData(data);
  }
  if (data.version < 11) {
    fs.copyFileSync(DATA_FILE, `${DATA_FILE}.bak-v${data.version || 10}-${Date.now()}`);
    const originalCategories = data.thoughtCategories.slice();
    const entriesByCategory = new Map();
    for (const entry of data.thoughtEntries) {
      if (!entry.categoryId) continue;
      const kind = THOUGHT_KINDS.includes(entry.kind) ? entry.kind : 'free';
      if (!entriesByCategory.has(entry.categoryId)) entriesByCategory.set(entry.categoryId, new Set());
      entriesByCategory.get(entry.categoryId).add(kind);
    }
    const kindOrder = ['free', 'review', 'extraction'];
    const migratedCategories = [];
    for (const category of originalCategories) {
      const usedKinds = [...(entriesByCategory.get(category.id) || [])].sort((a, b) => kindOrder.indexOf(a) - kindOrder.indexOf(b));
      const kinds = usedKinds.length ? usedKinds : ['free'];
      const idsByKind = new Map();
      kinds.forEach((kind, index) => {
        const migrated = { ...category, kind, id: index === 0 ? category.id : newId() };
        idsByKind.set(kind, migrated.id);
        migratedCategories.push(migrated);
      });
      for (const entry of data.thoughtEntries) {
        if (entry.categoryId !== category.id) continue;
        const kind = THOUGHT_KINDS.includes(entry.kind) ? entry.kind : 'free';
        const migratedId = idsByKind.get(kind);
        entry.categoryId = migratedId || null;
      }
    }
    data.thoughtCategories = migratedCategories;
    for (const entry of data.thoughtEntries) {
      if (entry.categoryId && !data.thoughtCategories.some((category) => category.id === entry.categoryId)) entry.categoryId = null;
    }
    data.version = 11;
    saveData(data);
  }
  return data;
}

// 新增字段（核心思想/复盘集合 + 导航配置）首次写入前的幂等升级：
// - 缺少导航配置的有效用户文件：先做一次完整升级备份（JSON + 复盘图片），再原子落盘；
// - 已有导航配置：只修复坏配置/补缺失集合，不重复备份；
// - 升级或备份失败：直接抛错由调用方报告，绝不触发「文件损坏重建」路径。
function upgradeNavigationLibraries(data) {
  let changed = false;
  const customAbsent = !Object.prototype.hasOwnProperty.call(data, 'customModules');
  const categorizedAbsent = !Object.prototype.hasOwnProperty.call(data, 'categorizedCollectionsSchemaVersion');
  if (customAbsent) { data.customModules = []; changed = true; }
  if (!Array.isArray(data.trashedModuleIds)) { data.trashedModuleIds = []; changed = true; }
  else {
    const visible = data.trashedModuleIds.filter((id) => MODULE_IDS.includes(id));
    if (visible.length !== data.trashedModuleIds.length) { data.trashedModuleIds = visible; changed = true; }
  }
  CustomModuleModel.validate(data.customModules, data.customModulesSchemaVersion);
  if (data.customModulesSchemaVersion === undefined) { data.customModulesSchemaVersion = 1; changed = true; }
  for (const key of ['coreThoughtCategories', 'coreThoughtTemplates', 'reviewTemplateCategories', 'reviewTemplates']) {
    if (!Array.isArray(data[key])) { data[key] = []; changed = true; }
  }
  // 三个旧扁平模块的分类能力采用增量字段升级，首次写入前沿用完整备份保护。
  if (categorizedAbsent) { data.categorizedCollectionsSchemaVersion = 1; changed = true; }
  for (const { categoryField, itemField } of Object.values(FLAT_CATEGORY_MODULES)) {
    if (!Object.prototype.hasOwnProperty.call(data, categoryField)) { data[categoryField] = []; changed = true; }
    else if (!Array.isArray(data[categoryField])) throw new Error(`${categoryField} 必须是数组`);
    if (!Array.isArray(data[itemField])) throw new Error(`${itemField} 必须是数组`);
    const categoryIds = new Set();
    for (const category of data[categoryField]) {
      if (!category || typeof category.id !== 'string' || !category.id || categoryIds.has(category.id)) {
        throw new Error(`${categoryField} 含无效或重复 ID`);
      }
      categoryIds.add(category.id);
    }
    const itemIds = new Set();
    for (const item of data[itemField]) {
      if (!item || typeof item.id !== 'string' || !item.id || itemIds.has(item.id)) {
        throw new Error(`${itemField} 含无效或重复 ID`);
      }
      itemIds.add(item.id);
      if (!Object.prototype.hasOwnProperty.call(item, 'categoryId')) { item.categoryId = null; changed = true; }
      else if (item.categoryId !== null && typeof item.categoryId !== 'string') throw new Error(`${itemField}.categoryId 格式错误`);
      else if (item.categoryId && !categoryIds.has(item.categoryId)) { item.categoryId = null; changed = true; }
    }
  }
  const rawPrefs = data.navigationPreferences;
  const hasPrefs = rawPrefs && typeof rawPrefs === 'object' && !Array.isArray(rawPrefs);
  const { prefs, repaired } = normalizeNavigationPreferences(hasPrefs ? rawPrefs : null, data);
  if (!hasPrefs) {
    createBackup('before-navigation-libraries-upgrade');
    data.navigationPreferences = prefs;
    saveData(data);
    return;
  }
  if (customAbsent) createBackup('before-custom-modules-upgrade');
  else if (categorizedAbsent) createBackup('before-categorized-collections-upgrade');
  data.navigationPreferences = prefs;
  if (repaired || changed) saveData(data);
}

function readData() {
  ensureDataFile();
  const raw = fs.readFileSync(DATA_FILE, 'utf8');
  let data;
  try {
    data = JSON.parse(raw);
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('数据格式错误');
  } catch (e) {
    // 文件损坏时备份后重建，避免启动失败（新增字段升级不在此路径内）
    const bak = `${DATA_FILE}.bak-${Date.now()}`;
    try { fs.copyFileSync(DATA_FILE, bak); } catch (_) { /* ignore */ }
    const fresh = freshData();
    writeJSON(DATA_FILE, fresh);
    return fresh;
  }
  // 用户库校验与旧版本迁移的I/O错误不能触发损坏重建。
  if (Object.prototype.hasOwnProperty.call(data, 'customModules')) CustomModuleModel.validate(data.customModules, data.customModulesSchemaVersion);
  data = parseDataFile(data);
  upgradeNavigationLibraries(data);
  return data;
}

function saveData(data) {
  ensureDataFile();
  preserveRichDataBeforeWrite(data);
  drawingManager?.sanitize(data);
  archiveOrphanImages(data);
  rememberRichData(data);
  writeJSON(DATA_FILE, data);
}

function archiveOrphanImages(next) {
  let previous = null;
  try {
    if (fs.existsSync(DATA_FILE)) previous = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch (_) { return; }
  if (!previous || typeof previous !== 'object') return;
  const removed = [...trashStore.collectRefs(previous).images].filter((id) => !trashStore.collectRefs(next).images.has(id));
  for (const imageId of removed) {
    if (!fs.existsSync(path.join(REVIEW_IMAGE_DIR, imageId))) continue;
    const moved = trashStore.claimImages([imageId]);
    if (!moved.length) continue;
    trashStore.add({ kind: 'image', title: '图片', moduleId: '', sourceId: imageId, body: { imageId }, files: { images: moved, drawings: [] } });
  }
}

// 多个本地请求可能同时完成读改写（例如导航记录与图文自动保存）。
// 旧请求若没有携带图文字段，不应把较新的图片引用和显示宽度覆盖掉。
const richBlockMemory = new Map();
function preserveRichDataBeforeWrite(data) {
  let latest;
  try {
    if (!fs.existsSync(DATA_FILE)) return;
    latest = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch (_) { return; }
  const preserve = (incoming, current, mappings, memoryKey = '') => {
    if (!incoming || !current || incoming.id !== current.id) return;
    for (const { blocksKey, textKey } of mappings) {
      const remembered = memoryKey ? richBlockMemory.get(`${memoryKey}:${incoming.id}:${blocksKey}`) : null;
      const source = Array.isArray(current[blocksKey]) ? current[blocksKey] : remembered;
      if (!Array.isArray(incoming[blocksKey]) && Array.isArray(source)) {
        incoming[blocksKey] = source;
        if (textKey) incoming[textKey] = richBlocksText(source);
      }
    }
  };
  const collections = [
    ['plans', data.plans, latest.plans, [{ blocksKey: 'descriptionBlocks', textKey: 'description' }, { blocksKey: 'noteBlocks', textKey: 'note' }]],
    ['templates', data.templates, latest.templates, [{ blocksKey: 'contentBlocks', textKey: 'content' }, { blocksKey: 'noteBlocks', textKey: 'note' }]],
    ['problems', data.problems, latest.problems, [{ blocksKey: 'contentBlocks', textKey: 'content' }, { blocksKey: 'noteBlocks', textKey: 'note' }]],
    ['learningTemplates', data.learningTemplates, latest.learningTemplates, [{ blocksKey: 'contentBlocks', textKey: 'content' }, { blocksKey: 'noteBlocks', textKey: 'note' }]],
    ['coreThoughtTemplates', data.coreThoughtTemplates, latest.coreThoughtTemplates, [{ blocksKey: 'contentBlocks', textKey: 'content' }, { blocksKey: 'noteBlocks', textKey: 'note' }]],
    ['reviewTemplates', data.reviewTemplates, latest.reviewTemplates, [{ blocksKey: 'contentBlocks', textKey: 'content' }, { blocksKey: 'noteBlocks', textKey: 'note' }]],
  ];
  for (const [memoryKey, incomingList, currentList, mappings] of collections) {
    if (!Array.isArray(incomingList) || !Array.isArray(currentList)) continue;
    const currentById = new Map(currentList.map((item) => [item.id, item]));
    for (const item of incomingList) preserve(item, currentById.get(item.id), mappings, memoryKey);
  }
  if (Array.isArray(data.customModules) && Array.isArray(latest.customModules)) {
    const currentById = new Map(latest.customModules.map((module) => [module.id, module]));
    for (const module of data.customModules) {
      const current = currentById.get(module.id);
      preserve(module, current, []);
      if (current && Array.isArray(module.templates) && Array.isArray(current.templates)) {
        const currentTemplates = new Map(current.templates.map((item) => [item.id, item]));
        for (const item of module.templates) preserve(item, currentTemplates.get(item.id), [{ blocksKey: 'contentBlocks', textKey: 'content' }, { blocksKey: 'noteBlocks', textKey: 'note' }], `custom:${module.id}`);
      }
    }
  }
  if (Array.isArray(data.thoughtEntries) && Array.isArray(latest.thoughtEntries)) {
    const currentById = new Map(latest.thoughtEntries.map((item) => [item.id, item]));
    for (const item of data.thoughtEntries) preserve(item, currentById.get(item.id), [{ blocksKey: 'blocks', textKey: 'text' }], 'thoughtEntries');
  }
}

function rememberRichData(data) {
  richBlockMemory.clear();
  const remember = (memoryKey, list, mappings) => {
    if (!Array.isArray(list)) return;
    for (const item of list) for (const { blocksKey } of mappings) {
      if (Array.isArray(item[blocksKey])) richBlockMemory.set(`${memoryKey}:${item.id}:${blocksKey}`, item[blocksKey]);
    }
  };
  remember('plans', data.plans, [{ blocksKey: 'descriptionBlocks' }, { blocksKey: 'noteBlocks' }]);
  remember('templates', data.templates, [{ blocksKey: 'contentBlocks' }, { blocksKey: 'noteBlocks' }]);
  remember('problems', data.problems, [{ blocksKey: 'contentBlocks' }, { blocksKey: 'noteBlocks' }]);
  remember('learningTemplates', data.learningTemplates, [{ blocksKey: 'contentBlocks' }, { blocksKey: 'noteBlocks' }]);
  remember('coreThoughtTemplates', data.coreThoughtTemplates, [{ blocksKey: 'contentBlocks' }, { blocksKey: 'noteBlocks' }]);
  remember('reviewTemplates', data.reviewTemplates, [{ blocksKey: 'contentBlocks' }, { blocksKey: 'noteBlocks' }]);
  remember('thoughtEntries', data.thoughtEntries, [{ blocksKey: 'blocks' }]);
  for (const module of data.customModules || []) remember(`custom:${module.id}`, module.templates, [{ blocksKey: 'contentBlocks' }, { blocksKey: 'noteBlocks' }]);
}

function newId() {
  if (crypto.randomUUID) return crypto.randomUUID();
  return crypto.randomBytes(16).toString('hex');
}

function deriveThoughtTitle(text) {
  const first = String(text || '').split(/\r?\n/).map((line) => line.trim()).find(Boolean) || '';
  return first.length > 60 ? `${first.slice(0, 59)}…` : first;
}

function isISODate(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(value || ''));
}

function findThought(data, id) {
  return data.thoughtEntries.find((entry) => entry.id === id) || null;
}

function findThoughtCategory(data, id) {
  return data.thoughtCategories.find((category) => category.id === id) || null;
}

function findThoughtCategoryForKind(data, id, kind) {
  const category = findThoughtCategory(data, id);
  return category && category.kind === kind ? category : null;
}

function normalizeRichBlocks(blocks, label = '图文内容') {
  if (!Array.isArray(blocks) || blocks.length > RICH_BLOCK_LIMIT) throw new Error(`${label}格式错误或内容块过多`);
  let images = 0;
  const ids = new Set();
  return blocks.map((block) => {
    if (!block || !RICH_BLOCK_ID.test(block.id || '') || ids.has(block.id)) throw new Error(`${label}内容块标识格式错误`);
    ids.add(block.id);
    if (block.type === 'text' && typeof block.text === 'string') return { id: block.id, type: 'text', text: block.text };
    if (block.type === 'drawing' && drawingStore.UUID.test(block.drawingId || '')) return { id: block.id, type: 'drawing', drawingId: block.drawingId };
    if (block.type !== 'image' || typeof block.imageId !== 'string' || !REVIEW_IMAGE_ID.test(block.imageId)) throw new Error(`${label}图片格式错误`);
    if (++images > RICH_IMAGE_LIMIT) throw new Error(`图片数量过大，每条内容最多插入 ${RICH_IMAGE_LIMIT} 张图片`);
    // 文件名严格限制在本地图片目录内；不接受外链、HTML、SVG 或任意本地路径。
    if (!fs.existsSync(path.join(REVIEW_IMAGE_DIR, block.imageId))) throw new Error('图片文件不存在，请重新插入');
    if (typeof block.caption !== 'string' || block.caption.length > 500) throw new Error('图片说明格式错误或超过 500 字');
    const widthPercent = block.widthPercent === undefined ? 100 : Number(block.widthPercent);
    if (!Number.isInteger(widthPercent) || widthPercent < RICH_IMAGE_MIN_WIDTH || widthPercent > RICH_IMAGE_MAX_WIDTH) {
      throw new Error(`图片显示宽度必须是 ${RICH_IMAGE_MIN_WIDTH}–${RICH_IMAGE_MAX_WIDTH} 的整数`);
    }
    return { id: block.id, type: 'image', imageId: block.imageId, caption: block.caption, widthPercent };
  });
}

function richBlocksText(blocks) {
  return blocks.filter((block) => block.type === 'text').map((block) => block.text).join('');
}

function richBlockImageCount(blocks) {
  return Array.isArray(blocks) ? blocks.filter((block) => block.type === 'image').length : 0;
}

function normalizeReviewBlocks(blocks) {
  return normalizeRichBlocks(blocks, '复盘图文').map((block, index) => {
    if (block.type === 'image' && blocks[index].widthPercent === undefined) {
      const { widthPercent, ...legacyBlock } = block;
      return legacyBlock;
    }
    return block;
  });
}

function reviewText(blocks) {
  return richBlocksText(blocks);
}

// 将一条记录的正文/备注图文字段以一次 PATCH 原子应用，同时保留旧的纯文本字段。
// blocksKey 只在请求明确传入时更新；旧客户端仅传 text 时，若原文已有图片则拒绝覆盖。
function applyRichFields(item, body, fields, label = '图文内容') {
  const proposed = [];
  for (const field of fields) {
    const hasBlocks = Object.prototype.hasOwnProperty.call(body, field.blocksKey);
    const hasText = Object.prototype.hasOwnProperty.call(body, field.textKey);
    if (hasBlocks) {
      const blocks = normalizeRichBlocks(body[field.blocksKey], `${label}${field.label}`);
      proposed.push({ field, blocks, text: richBlocksText(blocks) });
    } else if (hasText) {
      if (item[field.blocksKey]?.some((block) => block.type !== 'text')) {
        const error = new Error(`${label}${field.label}已有图片，请提交完整图文内容`);
        error.code = 'RICH_CONTENT_REQUIRES_BLOCKS';
        throw error;
      }
      const text = String(body[field.textKey] ?? '');
      const blocks = Array.isArray(item[field.blocksKey])
        ? [{ id: item[field.blocksKey].find((block) => block.type === 'text')?.id || newId(), type: 'text', text }]
        : undefined;
      proposed.push({ field, blocks, text });
    }
  }
  const totalImages = fields.reduce((sum, field) => {
    const update = proposed.find((entry) => entry.field === field);
    return sum + (update ? richBlockImageCount(update.blocks) : richBlockImageCount(item[field.blocksKey]));
  }, 0);
  if (totalImages > RICH_IMAGE_LIMIT) throw new Error(`图片数量过大，每条内容最多插入 ${RICH_IMAGE_LIMIT} 张图片`);
  for (const update of proposed) {
    item[update.field.textKey] = update.text;
    if (update.blocks) item[update.field.blocksKey] = update.blocks;
    else if (update.removeBlocks) delete item[update.field.blocksKey];
  }
  return proposed.length > 0;
}

function readImageBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > REVIEW_IMAGE_LIMIT) { chunks.length = 0; return; }
      chunks.push(chunk);
    });
    req.on('end', () => size > REVIEW_IMAGE_LIMIT ? reject(new Error('图片过大，单张最多 10 MB')) : resolve(Buffer.concat(chunks)));
    req.on('error', reject);
    req.on('aborted', () => reject(new Error('图片上传已中断')));
  });
}

function detectImageType(bytes) {
  if (bytes.length < 12) return null;
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return { ext: 'png', mime: 'image/png' };
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return { ext: 'jpg', mime: 'image/jpeg' };
  if (['GIF87a', 'GIF89a'].includes(bytes.toString('ascii', 0, 6))) return { ext: 'gif', mime: 'image/gif' };
  if (bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') return { ext: 'webp', mime: 'image/webp' };
  return null;
}

function findSection(data, id) {
  return data.sections.find((s) => s.id === id) || null;
}

function findItem(section, id) {
  if (!section || !Array.isArray(section.items)) return null;
  return section.items.find((it) => it.id === id) || null;
}

function findChild(item, id) {
  if (!item || !Array.isArray(item.children)) return null;
  return item.children.find((child) => child.id === id) || null;
}

function findCheckinNode(data, id) {
  for (const section of data.sections) {
    const item = findItem(section, id);
    if (item) return item;
    for (const candidate of section.items || []) {
      const child = findChild(candidate, id);
      if (child) return child;
    }
  }
  return null;
}

function toISODateLocal(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function normalizeEventRepeat(repeat) {
  if (!repeat || typeof repeat !== 'object') return { type: 'none', weekdays: [], monthDay: null, monthlyMode: null };
  const type = ['none', 'daily', 'weekly', 'monthly'].includes(repeat.type) ? repeat.type : 'none';
  const normalized = { type, weekdays: [], monthDay: null, monthlyMode: null };
  if (type === 'weekly' && Array.isArray(repeat.weekdays)) {
    normalized.weekdays = repeat.weekdays.filter((d) => Number.isInteger(d) && d >= 1 && d <= 7);
  }
  if (type === 'monthly') {
    if (repeat.monthlyMode === 'lastDay') {
      normalized.monthlyMode = 'lastDay';
    } else {
      const day = Number(repeat.monthDay);
      if (Number.isInteger(day) && day >= 1 && day <= 31) normalized.monthDay = day;
    }
  }
  return normalized;
}

function removeItemFromRecords(data, itemId) {
  for (const date of Object.keys(data.records)) {
    const rec = data.records[date];
    if (rec && Object.prototype.hasOwnProperty.call(rec, itemId)) delete rec[itemId];
  }
  for (const date of Object.keys(data.checkinReasons || {})) {
    const reasons = data.checkinReasons[date];
    if (reasons && Object.prototype.hasOwnProperty.call(reasons, itemId)) delete reasons[itemId];
  }
}

function removeItemAndChildrenFromRecords(data, item) {
  removeItemFromRecords(data, item.id);
  for (const child of item.children || []) removeItemFromRecords(data, child.id);
}

function extractCheckins(data, itemIds) {
  const records = {};
  const reasons = {};
  for (const itemId of itemIds) {
    for (const date of Object.keys(data.records || {})) {
      const record = data.records[date];
      if (!record || !Object.prototype.hasOwnProperty.call(record, itemId)) continue;
      records[date] = records[date] || {};
      records[date][itemId] = record[itemId];
      delete record[itemId];
      if (!Object.keys(record).length) delete data.records[date];
    }
    for (const date of Object.keys(data.checkinReasons || {})) {
      const reason = data.checkinReasons[date];
      if (!reason || !Object.prototype.hasOwnProperty.call(reason, itemId)) continue;
      reasons[date] = reasons[date] || {};
      reasons[date][itemId] = reason[itemId];
      delete reason[itemId];
      if (!Object.keys(reason).length) delete data.checkinReasons[date];
    }
  }
  return { records, reasons };
}

function nodeIds(item) {
  return [item.id, ...(item.children || []).map((child) => child.id)];
}

function archiveTrash(data, spec) {
  const body = JSON.parse(JSON.stringify(spec.body));
  const files = trashStore.claimUnreferenced(data, body, { images: true, drawings: Boolean(spec.drawings) });
  return trashStore.add({
    kind: spec.kind,
    title: spec.title,
    moduleId: spec.moduleId || '',
    sourceId: spec.sourceId || '',
    body,
    files,
  });
}

function emptyCollection(value) {
  return Array.isArray(value) ? [] : {};
}

function blankModuleCollection(key) {
  return ['records', 'checkinReasons', 'reflectEntries', 'eventCheckins'].includes(key) ? {} : [];
}

function httpError(message, status) {
  return Object.assign(new Error(message), { status });
}

function moduleIsLive(data, moduleId) {
  if (!moduleId || moduleId === 'drawings') return true;
  if (Object.prototype.hasOwnProperty.call(MODULE_COLLECTIONS, moduleId)) return !(data.trashedModuleIds || []).includes(moduleId);
  if (String(moduleId).startsWith('custom-')) return (data.customModules || []).some((entry) => entry.id === moduleId);
  return true;
}

function assertModuleLive(data, moduleId) {
  if (!moduleIsLive(data, moduleId)) throw httpError('请先恢复所属模块', 409);
}

function assertIdFree(list, id) {
  if (id && Array.isArray(list) && list.some((item) => item && item.id === id)) throw httpError('活动数据里已有相同内容，无法覆盖', 409);
}

function assertCollectionsFree(data, collections) {
  for (const [key, value] of Object.entries(collections || {})) {
    if (Array.isArray(value)) {
      const ids = new Set((data[key] || []).map((item) => item && item.id));
      if (value.some((item) => item && ids.has(item.id))) throw httpError('活动数据里已有相同内容，无法覆盖', 409);
    } else if (value && typeof value === 'object') {
      for (const childKey of Object.keys(value)) {
        const current = data[key]?.[childKey];
        const incoming = value[childKey];
        if (current === undefined) continue;
        if (incoming && current && typeof incoming === 'object' && typeof current === 'object' && !Array.isArray(incoming)) {
          if (Object.keys(incoming).some((leaf) => Object.prototype.hasOwnProperty.call(current, leaf))) throw httpError('活动数据里已有相同内容，无法覆盖', 409);
        } else throw httpError('活动数据里已有相同内容，无法覆盖', 409);
      }
    }
  }
}

function mergeCollections(data, collections) {
  for (const [key, value] of Object.entries(collections || {})) {
    if (Array.isArray(value)) data[key] = [...(data[key] || []), ...value];
    else if (value && typeof value === 'object') {
      data[key] = data[key] && typeof data[key] === 'object' ? data[key] : {};
      for (const childKey of Object.keys(value)) {
        const incoming = value[childKey];
        if (!data[key][childKey] || typeof incoming !== 'object' || Array.isArray(incoming)) data[key][childKey] = incoming;
        else Object.assign(data[key][childKey], incoming);
      }
    }
  }
}

function mergeExtracted(data, extracted = {}) {
  assertCollectionsFree(data, { records: extracted.records || {}, checkinReasons: extracted.reasons || {} });
  mergeCollections(data, { records: extracted.records || {}, checkinReasons: extracted.reasons || {} });
}

function restoreTrashPayload(data, payload) {
  const body = payload.body || {};
  if (payload.kind === 'module') {
    const moduleId = body.moduleId;
    const placement = body.placement === 'zone' ? 'zone' : 'main';
    if (body.builtin) {
      if (!MODULE_COLLECTIONS[moduleId]) throw httpError('模块无法恢复', 404);
      if (!(data.trashedModuleIds || []).includes(moduleId)) throw httpError('模块已在使用中', 409);
      assertCollectionsFree(data, body.collections);
      data.trashedModuleIds = data.trashedModuleIds.filter((id) => id !== moduleId);
      mergeCollections(data, body.collections);
    } else {
      const customModule = body.customModule;
      if (!customModule || !String(customModule.id || '').startsWith('custom-')) throw httpError('模块无法恢复', 404);
      if (data.customModules.some((entry) => entry.id === customModule.id)) throw httpError('活动数据里已有相同内容，无法覆盖', 409);
      const nameConflict = CustomModuleModel.nameError(customModule.name, data.customModules);
      if (nameConflict) throw httpError(nameConflict, 409);
      data.customModules.push(customModule);
    }
    data.navigationPreferences.placementByModule[moduleId] = placement;
    data.navigationPreferences.moduleOrder = data.navigationPreferences.moduleOrder.filter((id) => id !== moduleId);
    data.navigationPreferences = normalizeNavigationPreferences(data.navigationPreferences, data).prefs;
    data.navigationPreferences.revision += 1;
    return;
  }
  assertModuleLive(data, payload.moduleId);
  if (payload.kind === 'record') {
    const owner = body.scope === 'custom'
      ? data.customModules.find((entry) => entry.id === payload.moduleId)
      : data;
    if (!owner || !Array.isArray(owner[body.collection])) throw httpError('请先恢复所属模块', 409);
    assertIdFree(owner[body.collection], body.record?.id);
    owner[body.collection].push(body.record);
    return;
  }
  if (payload.kind === 'category') {
    const owner = body.scope === 'custom'
      ? data.customModules.find((entry) => entry.id === payload.moduleId)
      : data;
    if (!owner || !Array.isArray(owner[body.collection]) || !Array.isArray(owner[body.itemsKey])) throw httpError('请先恢复所属模块', 409);
    assertIdFree(owner[body.collection], body.category?.id);
    owner[body.collection].push(body.category);
    for (const itemId of body.reattachItemIds || []) {
      const item = owner[body.itemsKey].find((entry) => entry.id === itemId);
      if (item && (item.categoryId === null || item.categoryId === undefined || item.categoryId === '')) item.categoryId = body.category.id;
    }
    return;
  }
  if (payload.kind === 'principle-section') {
    assertIdFree(data.sections, body.section?.id);
    mergeExtracted(data, body.extracted);
    data.sections.push(body.section);
    return;
  }
  if (payload.kind === 'principle-item') {
    const section = data.sections.find((entry) => entry.id === body.sectionId);
    if (!section) throw httpError('请先恢复所属原则', 409);
    if (!Array.isArray(section.items)) section.items = [];
    assertIdFree(section.items, body.item?.id);
    mergeExtracted(data, body.extracted);
    section.items.push(body.item);
    return;
  }
  if (payload.kind === 'principle-child') {
    const section = data.sections.find((entry) => entry.id === body.sectionId);
    const item = section?.items?.find((entry) => entry.id === body.itemId);
    if (!item) throw httpError('请先恢复所属条目', 409);
    if (!Array.isArray(item.children)) item.children = [];
    assertIdFree(item.children, body.child?.id);
    mergeExtracted(data, body.extracted);
    item.children.push(body.child);
    return;
  }
  if (payload.kind === 'framework') {
    assertIdFree(data.reflectFrameworks, body.framework?.id);
    for (const [date, text] of Object.entries(body.answers || {})) {
      if (data.reflectEntries?.[date] && Object.prototype.hasOwnProperty.call(data.reflectEntries[date], body.framework.id)) {
        throw httpError('活动数据里已有相同内容，无法覆盖', 409);
      }
    }
    data.reflectFrameworks.push(body.framework);
    for (const [date, text] of Object.entries(body.answers || {})) {
      if (!data.reflectEntries[date]) data.reflectEntries[date] = {};
      data.reflectEntries[date][body.framework.id] = text;
    }
    return;
  }
  if (payload.kind === 'reflection') {
    const current = data.reflectEntries?.[body.date];
    if (current && Object.keys(current).some((key) => Object.prototype.hasOwnProperty.call(body.entries || {}, key))) {
      throw httpError('活动数据里已有相同内容，无法覆盖', 409);
    }
    data.reflectEntries[body.date] = { ...(current || {}), ...(body.entries || {}) };
    return;
  }
  if (payload.kind === 'drawing') {
    drawingManager.unmarkDeleted(body.drawingId);
    return;
  }
  if (payload.kind === 'image') return;
  throw httpError('垃圾站记录无法恢复', 400);
}

function trashModule(data, moduleId) {
  const prefs = data.navigationPreferences;
  const placement = prefs.placementByModule?.[moduleId] === 'zone' ? 'zone' : 'main';
  if (MODULE_COLLECTIONS[moduleId]) {
    if ((data.trashedModuleIds || []).includes(moduleId)) throw httpError('模块已在垃圾站', 409);
    const collections = {};
    for (const key of MODULE_COLLECTIONS[moduleId]) {
      const current = data[key] === undefined ? blankModuleCollection(key) : data[key];
      collections[key] = JSON.parse(JSON.stringify(current));
      data[key] = blankModuleCollection(key);
    }
    data.trashedModuleIds = [...(data.trashedModuleIds || []), moduleId];
    prefs.moduleOrder = prefs.moduleOrder.filter((id) => id !== moduleId);
    delete prefs.placementByModule[moduleId];
    prefs.revision += 1;
    data.navigationPreferences = normalizeNavigationPreferences(prefs, data).prefs;
    data.navigationPreferences.revision = prefs.revision;
    archiveTrash(data, {
      kind: 'module', title: MODULE_NAMES[moduleId], moduleId, sourceId: moduleId, drawings: true,
      body: { builtin: true, moduleId, placement, collections },
    });
    return;
  }
  const customModule = (data.customModules || []).find((entry) => entry.id === moduleId);
  if (!customModule) throw httpError('模块不存在', 404);
  data.customModules = data.customModules.filter((entry) => entry.id !== moduleId);
  prefs.moduleOrder = prefs.moduleOrder.filter((id) => id !== moduleId);
  delete prefs.placementByModule[moduleId];
  prefs.revision += 1;
  data.navigationPreferences = normalizeNavigationPreferences(prefs, data).prefs;
  data.navigationPreferences.revision = prefs.revision;
  archiveTrash(data, {
    kind: 'module', title: customModule.name, moduleId, sourceId: moduleId, drawings: true,
    body: { builtin: false, moduleId, placement, customModule },
  });
}

// ---------------------------------------------------------------- 工具

function sendJSON(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > 1_000_000) {
        reject(new Error('请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        const hasDrawing = ['blocks', 'contentBlocks', 'descriptionBlocks', 'noteBlocks'].some((key) => body[key]?.some?.((block) => block.type === 'drawing'));
        const epoch = req.headers['x-life-data-epoch'];
        if ((hasDrawing && !epoch) || (epoch && epoch !== dataEpoch)) {
          reject(Object.assign(new Error('数据已恢复或服务已重启，请重新载入'), { status: epoch ? 409 : 400, code: epoch ? 'DATA_EPOCH_CHANGED' : 'DATA_EPOCH_REQUIRED' })); return;
        }
        resolve(body);
      } catch (_) {
        reject(new Error('JSON 解析失败'));
      }
    });
    req.on('error', reject);
  });
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

function serveStatic(res, pathname) {
  const rel = pathname === '/' ? '/index.html' : pathname;
  const filePath = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('Forbidden');
  }
  fs.readFile(filePath, (err, buf) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('404 Not Found');
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(buf);
  });
}

function openBrowser(url) {
  if (process.platform === 'win32') {
    // 1) 打开默认浏览器（分离进程 + 忽略输出，避免 EPERM/引号转义问题）
    const opener = spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore' });
    opener.unref();

    // 2) 稍后把浏览器窗口置前，确保用户能看到（页面标题含「生活管家」，尽力而为）
    const activate = [
      'Start-Sleep -Milliseconds 1200',
      '$sh = New-Object -ComObject WScript.Shell',
      "for ($i = 0; $i -lt 8; $i++) { $w = Get-Process | Where-Object { $_.MainWindowTitle -like '*生活管家*' } | Select-Object -First 1; if ($w -and $sh.AppActivate($w.Id)) { break }; Start-Sleep -Milliseconds 400 }",
    ].join('; ');
    try {
      const focus = spawn('powershell', ['-NoProfile', '-WindowStyle', 'Hidden', '-Command', activate], {
        detached: true,
        stdio: 'ignore',
      });
      focus.unref();
    } catch (_) { /* 置前失败不影响使用 */ }
    return;
  }
  const cmd = process.platform === 'darwin' ? `open "${url}"` : `xdg-open "${url}"`;
  exec(cmd, () => { /* 忽略打开结果 */ });
}

// ---------------------------------------------------------------- API 路由

// 核心思想/复盘分类模板库：按 LIBRARY_MODULES 配置映射集合，语义与学习专区完全一致。
// 返回 true 表示已处理该请求；所有路由先读请求体，再同步读取/修改/保存。
async function serveCategorizedLibrary(req, res, method, seg) {
  if (seg.length < 3 || seg[0] !== 'api') return false;
  const custom = seg[1] === 'custom-modules';
  const customId = custom ? seg[2] : null;
  let config = custom ? { categoryField: 'categories', templateField: 'templates' } : LIBRARY_MODULES[seg[1]];
  if (!config) return false;
  if (custom) seg = ['api', 'custom-modules', ...seg.slice(3)];
  if (seg[2] !== 'categories' && seg[2] !== 'templates') return false;
  const done = (status, obj) => { sendJSON(res, status, obj); return true; };
  // 先读完请求体，再取得最新数据；之后的读取/修改/保存不再插入 await
  const body = method === 'DELETE' ? {} : await readBody(req);
  if (custom && !requireDataEpoch(req, res)) return true;
  const data = readData();
  const owner = custom ? data.customModules.find((entry) => entry.id === customId) : data;
  if (!owner) return done(404, { error: '模块不存在', commitState: 'not_committed' });

  // ---- 分类 ----
  if (method === 'POST' && seg.length === 3 && seg[2] === 'categories') {
    const clean = String(body.name || '').trim();
    if (!clean) return done(400, { error: '分类名称不能为空' });
    if (owner[config.categoryField].some((entry) => entry.name.toLocaleLowerCase() === clean.toLocaleLowerCase())) {
      return done(409, { error: '分类名称已存在' });
    }
    const category = { id: newId(), name: clean, createdAt: new Date().toISOString() };
    owner[config.categoryField].push(category);
    saveData(data);
    return done(201, { category });
  }
  if (method === 'PATCH' && seg.length === 4 && seg[2] === 'categories') {
    const category = owner[config.categoryField].find((entry) => entry.id === seg[3]);
    if (!category) return done(404, { error: '分类不存在' });
    const clean = String(body.name || '').trim();
    if (!clean) return done(400, { error: '分类名称不能为空' });
    if (owner[config.categoryField].some((entry) => entry.id !== category.id && entry.name.toLocaleLowerCase() === clean.toLocaleLowerCase())) {
      return done(409, { error: '分类名称已存在' });
    }
    category.name = clean;
    saveData(data);
    return done(200, { category });
  }
  if (method === 'DELETE' && seg.length === 4 && seg[2] === 'categories') {
    const category = owner[config.categoryField].find((entry) => entry.id === seg[3]);
    if (!category) return done(404, { error: '分类不存在' });
    const reattachItemIds = owner[config.templateField].filter((template) => template.categoryId === category.id).map((template) => template.id);
    owner[config.categoryField] = owner[config.categoryField].filter((entry) => entry.id !== category.id);
    for (const template of owner[config.templateField]) {
      if (template.categoryId === category.id) template.categoryId = null; // 模板原文保留，仅转未分类
    }
    const moduleId = custom ? customId : (seg[1] === 'core-thought' ? 'coreThoughts' : 'reviewTemplates');
    archiveTrash(data, {
      kind: 'category', title: category.name, moduleId, sourceId: category.id,
      body: { scope: custom ? 'custom' : 'root', moduleId, collection: config.categoryField, itemsKey: config.templateField, category, reattachItemIds },
    });
    saveData(data);
    return done(200, { ok: true });
  }

  // ---- 模板 ----
  if (method === 'POST' && seg.length === 3 && seg[2] === 'templates') {
    const clean = String(body.name || '').trim();
    if (!clean) return done(400, { error: '模板名称不能为空' });
    let categoryId = null;
    if (body.categoryId) {
      const category = owner[config.categoryField].find((entry) => entry.id === body.categoryId);
      if (!category) return done(400, { error: '分类不存在' });
      categoryId = category.id;
    }
    const now = new Date().toISOString();
    const template = { id: newId(), categoryId, name: clean, content: '', note: '', createdAt: now, updatedAt: now };
    applyRichFields(template, body, [
      { blocksKey: 'contentBlocks', textKey: 'content', label: '模板内容' },
      { blocksKey: 'noteBlocks', textKey: 'note', label: '使用备注' },
    ], '模板');
    owner[config.templateField].push(template);
    saveData(data);
    return done(201, { template });
  }
  if (method === 'POST' && seg.length === 4 && seg[2] === 'templates' && seg[3] === 'reorder') {
    const { orderedIds } = body;
    if (!Array.isArray(orderedIds) || new Set(orderedIds).size !== orderedIds.length) {
      return done(400, { error: '参数错误' });
    }
    const map = new Map(owner[config.templateField].map((t) => [t.id, t]));
    if (!orderedIds.every((id) => map.has(id))) {
      return done(400, { error: '排序列表与模板不一致' });
    }
    if (orderedIds.length !== owner[config.templateField].length) {
      // 部分重排（筛选视图）：把所列模板按新顺序放回它们原本占据的槽位
      const queue = orderedIds.map((id) => map.get(id));
      owner[config.templateField] = owner[config.templateField].map((entry) => (orderedIds.includes(entry.id) ? queue.shift() : entry));
    } else {
      owner[config.templateField] = orderedIds.map((id) => map.get(id));
    }
    saveData(data);
    return done(200, { templates: owner[config.templateField] });
  }
  if (method === 'PATCH' && seg.length === 4 && seg[2] === 'templates') {
    const template = owner[config.templateField].find((t) => t.id === seg[3]);
    if (!template) return done(404, { error: '模板不存在' });
    if (body.name !== undefined) {
      const clean = String(body.name).trim();
      if (!clean) return done(400, { error: '模板名称不能为空' });
      template.name = clean;
    }
    applyRichFields(template, body, [
      { blocksKey: 'contentBlocks', textKey: 'content', label: '模板内容' },
      { blocksKey: 'noteBlocks', textKey: 'note', label: '使用备注' },
    ], '模板');
    if (Object.prototype.hasOwnProperty.call(body, 'categoryId')) {
      const categoryId = body.categoryId == null || body.categoryId === '' ? null : String(body.categoryId);
      if (categoryId && !owner[config.categoryField].some((entry) => entry.id === categoryId)) {
        return done(400, { error: '分类不存在' });
      }
      template.categoryId = categoryId;
    }
    template.updatedAt = new Date().toISOString();
    saveData(data);
    return done(200, { template });
  }
  if (method === 'DELETE' && seg.length === 4 && seg[2] === 'templates') {
    const template = owner[config.templateField].find((entry) => entry.id === seg[3]);
    owner[config.templateField] = owner[config.templateField].filter((entry) => entry.id !== seg[3]);
    if (template) {
      const moduleId = custom ? customId : (seg[1] === 'core-thought' ? 'coreThoughts' : 'reviewTemplates');
      archiveTrash(data, {
        kind: 'record', title: template.name, moduleId, sourceId: template.id,
        body: { scope: custom ? 'custom' : 'root', moduleId, collection: config.templateField, record: template },
      });
    }
    saveData(data);
    return done(200, { ok: true });
  }
  return false;
}

// 个人模板、计划、问题拆解的分类管理路由。条目本身仍走各自旧 PATCH/POST 路由，
// 这里仅负责分类集合的增删改，避免改变既有排序和字段语义。
async function serveFlatCategoryRoutes(req, res, method, seg) {
  if (seg[0] !== 'api' || !FLAT_CATEGORY_MODULES[seg[1]]) return false;
  const config = FLAT_CATEGORY_MODULES[seg[1]];
  if (seg[2] !== 'categories' || (seg.length !== 3 && seg.length !== 4)) return false;
  const body = method === 'DELETE' ? {} : await readBody(req);
  const data = readData();
  const categories = data[config.categoryField];
  const items = data[config.itemField];
  const done = (status, obj) => { sendJSON(res, status, obj); return true; };
  if (method === 'POST' && seg.length === 3) {
    const clean = String(body.name || '').trim();
    if (!clean) return done(400, { error: '分类名称不能为空' });
    if (categories.some((entry) => entry.name.toLocaleLowerCase() === clean.toLocaleLowerCase())) {
      return done(409, { error: '分类名称已存在' });
    }
    const category = { id: newId(), name: clean, createdAt: new Date().toISOString() };
    categories.push(category);
    saveData(data);
    return done(201, { category });
  }
  if (seg.length !== 4) return false;
  const category = categories.find((entry) => entry.id === seg[3]);
  if (!category) return done(404, { error: '分类不存在' });
  if (method === 'PATCH') {
    const clean = String(body.name || '').trim();
    if (!clean) return done(400, { error: '分类名称不能为空' });
    if (categories.some((entry) => entry.id !== category.id && entry.name.toLocaleLowerCase() === clean.toLocaleLowerCase())) {
      return done(409, { error: '分类名称已存在' });
    }
    category.name = clean;
    saveData(data);
    return done(200, { category });
  }
  if (method === 'DELETE') {
    const reattachItemIds = items.filter((item) => item.categoryId === category.id).map((item) => item.id);
    data[config.categoryField] = categories.filter((entry) => entry.id !== category.id);
    for (const item of items) if (item.categoryId === category.id) item.categoryId = null;
    archiveTrash(data, {
      kind: 'category', title: category.name, moduleId: seg[1], sourceId: category.id,
      body: { scope: 'root', moduleId: seg[1], collection: config.categoryField, itemsKey: config.itemField, category, reattachItemIds },
    });
    saveData(data);
    return done(200, { ok: true });
  }
  return false;
}

function categoryIdFor(data, config, rawCategoryId) {
  if (rawCategoryId === undefined || rawCategoryId === null || rawCategoryId === '') return null;
  const categoryId = String(rawCategoryId);
  if (!data[config.categoryField].some((entry) => entry.id === categoryId)) return undefined;
  return categoryId;
}

function existingDrawingReference(seg) {
  const collections = { thoughts: 'thoughtEntries', plans: 'plans', templates: 'templates', problems: 'problems', learning: 'learningTemplates', 'core-thought': 'coreThoughtTemplates', 'review-template': 'reviewTemplates' };
  if (!collections[seg[1]] && seg[1] !== 'custom-modules') return false;
  const data = readData();
  const list = seg[1] === 'custom-modules' ? data.customModules.find((m) => m.id === seg[2])?.templates : data[collections[seg[1]]];
  const id = seg[1] === 'custom-modules' ? seg[4] : seg[2] === 'templates' ? seg[3] : seg[2];
  const record = list?.find((item) => item.id === id);
  return record && ['blocks', 'contentBlocks', 'descriptionBlocks', 'noteBlocks'].some((key) => record[key]?.some((b) => b.type === 'drawing'));
}

async function handleApi(req, res, pathname) {
  const method = req.method;
  const seg = pathname.split('/').filter(Boolean); // 例：['api','sections','abc','items','xyz']

  try {
    drawingManager.recover();
    if (await drawingManager.handle(req, res, seg, sendJSON)) return;
    if (await drawingStore.handle(req, res, seg, sendJSON)) return;
    if (!['GET', 'HEAD'].includes(method) && (req.headers['x-life-data-epoch'] || existingDrawingReference(seg)) && !requireDataEpoch(req, res)) return;
    if (method === 'POST' && seg.length === 2 && seg[1] === 'custom-modules') {
      const body = await readBody(req);
      const fail = (status, error, code) => sendJSON(res, status, { error, code, commitState: 'not_committed' });
      if (!body || typeof body !== 'object' || Array.isArray(body)) return fail(400, '参数格式错误');
      if (Object.keys(body).some((key) => !['name', 'icon', 'placement', 'baseRevision', 'requestId'].includes(key))) return fail(400, '参数不支持，模块类型固定为复盘模板库');
      const nameError = CustomModuleModel.nameError(body.name);
      // 重名在幂等和revision检查之后处理；基本格式先检查。
      if (nameError && nameError !== '模块名称已存在或为保留名称') return fail(400, nameError);
      if (!CustomModuleModel.icons.includes(body.icon) || !validWorkspace(body.placement)
        || !CustomModuleModel.uuid.test(body.requestId) || !Number.isInteger(body.baseRevision) || body.baseRevision < 0) return fail(400, '参数格式错误');
      if (!requireDataEpoch(req, res)) return;
      const data = readData();
      const existing = data.customModules.find((entry) => entry.creationRequestId === body.requestId);
      if (existing) {
        if (CustomModuleModel.key(existing.name) !== CustomModuleModel.key(body.name) || existing.icon !== body.icon || existing.defaultPlacement !== body.placement) {
          return fail(409, '该创建请求已用于其他内容', 'REQUEST_ID_REUSED');
        }
        return sendJSON(res, 200, { module: existing, ...navigationSnapshot(data), appliedRevision: existing.createdNavigationRevision, replayed: true });
      }
      if (body.baseRevision !== data.navigationPreferences.revision) return sendJSON(res, 409, {
        error: '模块设置已在其他页面更新，请重新载入最新设置', code: 'NAVIGATION_REVISION_CONFLICT', commitState: 'not_committed', ...navigationSnapshot(data),
      });
      const conflict = CustomModuleModel.nameError(body.name, data.customModules);
      if (conflict) return fail(409, conflict, 'MODULE_NAME_EXISTS');
      const prefs = data.navigationPreferences;
      const module = {
        id: `custom-${crypto.randomUUID()}`, kind: 'categorized-library', name: body.name.trim(), icon: body.icon,
        defaultPlacement: body.placement, createdAt: new Date().toISOString(), creationRequestId: body.requestId,
        createdNavigationRevision: prefs.revision + 1, categories: [], templates: [],
      };
      data.customModules.push(module);
      prefs.moduleOrder.push(module.id);
      prefs.placementByModule[module.id] = body.placement;
      prefs.revision += 1;
      data.navigationPreferences = normalizeNavigationPreferences(prefs, data).prefs;
      // 一次原子写入同时包含定义、空库和导航；写盘失败不得宣告成功。
      saveData(data);
      return sendJSON(res, 201, { module, ...navigationSnapshot(data), appliedRevision: module.createdNavigationRevision, replayed: false });
    }
    // GET /api/state —— 返回全部数据
    if (method === 'GET' && seg.length === 2 && seg[1] === 'state') {
      const data = readData();
      return sendJSON(res, 200, {
        version: data.version,
        appVersion: APP_VERSION,
        dataEpoch,
        customModulesSchemaVersion: data.customModulesSchemaVersion,
        categorizedCollectionsSchemaVersion: data.categorizedCollectionsSchemaVersion,
        customModules: data.customModules,
        trashedModuleIds: data.trashedModuleIds || [],
        sections: data.sections,
        records: data.records,
        checkinReasons: data.checkinReasons,
        thoughtEntries: data.thoughtEntries,
        thoughtCategories: data.thoughtCategories,
        reflectFrameworks: data.reflectFrameworks,
        reflectEntries: data.reflectEntries,
        plans: data.plans,
        templates: data.templates,
        problems: data.problems,
        planCategories: data.planCategories,
        templateCategories: data.templateCategories,
        problemCategories: data.problemCategories,
        learningCategories: data.learningCategories,
        learningTemplates: data.learningTemplates,
        coreThoughtCategories: data.coreThoughtCategories,
        coreThoughtTemplates: data.coreThoughtTemplates,
        reviewTemplateCategories: data.reviewTemplateCategories,
        reviewTemplates: data.reviewTemplates,
        navigationPreferences: data.navigationPreferences,
        events: data.events,
        eventCheckins: data.eventCheckins,
        eventExceptions: data.eventExceptions,
      });
    }

    if (await serveFlatCategoryRoutes(req, res, method, seg)) return;

    // ---------- 数据备份 ----------
    if (method === 'GET' && seg.length === 2 && seg[1] === 'backups') {
      return sendJSON(res, 200, { backups: listBackups() });
    }

    if (method === 'POST' && seg.length === 2 && seg[1] === 'backups') {
      return sendJSON(res, 201, { backup: createBackup('manual') });
    }

    if (method === 'POST' && seg.length === 4 && seg[1] === 'backups' && seg[3] === 'restore') {
      const result = restoreBackup(seg[2]);
      return sendJSON(res, 200, result);
    }

    if (seg[1] === 'trash') {
      if (method === 'GET' && seg.length === 2) return sendJSON(res, 200, { entries: trashStore.list() });
      if (method === 'POST' && seg.length === 3 && seg[2] === 'empty') {
        if (!requireDataEpoch(req, res)) return;
        const data = readData();
        trashStore.empty();
        saveData(data);
        return sendJSON(res, 200, { ok: true, entries: [] });
      }
      if (seg.length === 4 && seg[3] === 'restore' && method === 'POST') {
        if (!requireDataEpoch(req, res)) return;
        const payload = trashStore.readPayload(seg[2]);
        const data = readData();
        restoreTrashPayload(data, payload);
        trashStore.restoreFiles(payload.files);
        saveData(data);
        trashStore.discard(seg[2]);
        return sendJSON(res, 200, { ok: true, ...navigationSnapshot(data) });
      }
      if (method === 'DELETE' && seg.length === 3) {
        if (!requireDataEpoch(req, res)) return;
        trashStore.remove(seg[2]);
        return sendJSON(res, 200, { ok: true });
      }
    }

    if (method === 'DELETE' && seg.length === 3 && seg[1] === 'modules') {
      if (!requireDataEpoch(req, res)) return;
      const data = readData();
      trashModule(data, seg[2]);
      saveData(data);
      return sendJSON(res, 200, { ok: true, moduleId: seg[2], ...navigationSnapshot(data) });
    }

    // ---------- 板块 ----------
    // POST /api/sections —— 新建板块 { name }
    if (method === 'POST' && seg.length === 2 && seg[1] === 'sections') {
      const { name } = await readBody(req);
      const clean = String(name || '').trim();
      if (!clean) return sendJSON(res, 400, { error: '板块名称不能为空' });
      const data = readData();
      const section = { id: newId(), name: clean, items: [] };
      data.sections.push(section);
      saveData(data);
      return sendJSON(res, 201, { section });
    }

    // POST /api/sections/reorder —— 板块排序 { orderedIds }
    if (method === 'POST' && seg.length === 3 && seg[1] === 'sections' && seg[2] === 'reorder') {
      const { orderedIds } = await readBody(req);
      if (!Array.isArray(orderedIds)) return sendJSON(res, 400, { error: '参数错误' });
      const data = readData();
      const map = new Map(data.sections.map((s) => [s.id, s]));
      const reordered = orderedIds.map((id) => map.get(id)).filter(Boolean);
      if (reordered.length !== data.sections.length) {
        return sendJSON(res, 400, { error: '排序列表与板块不一致' });
      }
      data.sections = reordered;
      saveData(data);
      return sendJSON(res, 200, { sections: data.sections });
    }

    // PATCH /api/sections/:id —— 重命名板块 { name }
    if (method === 'PATCH' && seg.length === 3 && seg[1] === 'sections') {
      const { name } = await readBody(req);
      const data = readData();
      const section = findSection(data, seg[2]);
      if (!section) return sendJSON(res, 404, { error: '板块不存在' });
      const clean = String(name || '').trim();
      if (!clean) return sendJSON(res, 400, { error: '板块名称不能为空' });
      section.name = clean;
      saveData(data);
      return sendJSON(res, 200, { section });
    }

    // DELETE /api/sections/:id —— 删除板块及其条目、打卡记录
    if (method === 'DELETE' && seg.length === 3 && seg[1] === 'sections') {
      const data = readData();
      const section = findSection(data, seg[2]);
      if (!section) return sendJSON(res, 404, { error: '板块不存在' });
      const extracted = extractCheckins(data, (section.items || []).flatMap(nodeIds));
      data.sections = data.sections.filter((entry) => entry.id !== section.id);
      archiveTrash(data, {
        kind: 'principle-section', title: section.name, moduleId: 'principles', sourceId: section.id,
        body: { section, extracted },
      });
      saveData(data);
      return sendJSON(res, 200, { ok: true });
    }

    // ---------- 条目 ----------
    // POST /api/sections/:id/items —— 新建条目 { name }
    if (method === 'POST' && seg.length === 4 && seg[1] === 'sections' && seg[3] === 'items') {
      const { name } = await readBody(req);
      const data = readData();
      const section = findSection(data, seg[2]);
      if (!section) return sendJSON(res, 404, { error: '板块不存在' });
      const clean = String(name || '').trim();
      if (!clean) return sendJSON(res, 400, { error: '条目名称不能为空' });
      if (!Array.isArray(section.items)) section.items = [];
      const item = { id: newId(), name: clean, activeSince: toISODateLocal(new Date()), children: [] };
      section.items.push(item);
      saveData(data);
      return sendJSON(res, 201, { item });
    }

    // POST /api/sections/:id/items/reorder —— 条目排序 { orderedIds }
    if (
      method === 'POST' &&
      seg.length === 5 &&
      seg[1] === 'sections' &&
      seg[3] === 'items' &&
      seg[4] === 'reorder'
    ) {
      const { orderedIds } = await readBody(req);
      if (!Array.isArray(orderedIds)) return sendJSON(res, 400, { error: '参数错误' });
      const data = readData();
      const section = findSection(data, seg[2]);
      if (!section) return sendJSON(res, 404, { error: '板块不存在' });
      const map = new Map(section.items.map((it) => [it.id, it]));
      const reordered = orderedIds.map((id) => map.get(id)).filter(Boolean);
      if (reordered.length !== section.items.length) {
        return sendJSON(res, 400, { error: '排序列表与条目不一致' });
      }
      section.items = reordered;
      saveData(data);
      return sendJSON(res, 200, { items: section.items });
    }

    // PATCH /api/sections/:id/items/:itemId —— 重命名条目 { name }
    if (method === 'PATCH' && seg.length === 5 && seg[1] === 'sections' && seg[3] === 'items') {
      const { name } = await readBody(req);
      const data = readData();
      const section = findSection(data, seg[2]);
      const item = findItem(section, seg[4]);
      if (!item) return sendJSON(res, 404, { error: '条目不存在' });
      const clean = String(name || '').trim();
      if (!clean) return sendJSON(res, 400, { error: '条目名称不能为空' });
      item.name = clean;
      saveData(data);
      return sendJSON(res, 200, { item });
    }

    // DELETE /api/sections/:id/items/:itemId —— 删除条目及其打卡记录
    if (method === 'DELETE' && seg.length === 5 && seg[1] === 'sections' && seg[3] === 'items') {
      const data = readData();
      const section = findSection(data, seg[2]);
      if (!section) return sendJSON(res, 404, { error: '板块不存在' });
      const item = findItem(section, seg[4]);
      if (!item) return sendJSON(res, 404, { error: '条目不存在' });
      const extracted = extractCheckins(data, nodeIds(item));
      section.items = (section.items || []).filter((entry) => entry.id !== item.id);
      archiveTrash(data, {
        kind: 'principle-item', title: item.name, moduleId: 'principles', sourceId: item.id,
        body: { sectionId: section.id, item, extracted },
      });
      saveData(data);
      return sendJSON(res, 200, { ok: true });
    }

    // ---------- 子节点 ----------
    // POST /api/sections/:sectionId/items/:itemId/children —— 新建子节点 { name }
    if (method === 'POST' && seg.length === 6 && seg[1] === 'sections' && seg[3] === 'items' && seg[5] === 'children') {
      const data = readData();
      const item = findItem(findSection(data, seg[2]), seg[4]);
      if (!item) return sendJSON(res, 404, { error: '条目不存在' });
      const { name } = await readBody(req);
      const clean = String(name || '').trim();
      if (!clean) return sendJSON(res, 400, { error: '子节点名称不能为空' });
      if (!Array.isArray(item.children)) item.children = [];
      const child = { id: newId(), name: clean, activeSince: toISODateLocal(new Date()) };
      item.children.push(child);
      saveData(data);
      return sendJSON(res, 201, { child });
    }

    // POST /api/sections/:sectionId/items/:itemId/children/reorder —— 子节点排序 { orderedIds }
    if (method === 'POST' && seg.length === 7 && seg[1] === 'sections' && seg[3] === 'items' && seg[5] === 'children' && seg[6] === 'reorder') {
      const data = readData();
      const item = findItem(findSection(data, seg[2]), seg[4]);
      if (!item) return sendJSON(res, 404, { error: '条目不存在' });
      const { orderedIds } = await readBody(req);
      if (!Array.isArray(orderedIds)) return sendJSON(res, 400, { error: '参数错误' });
      const children = Array.isArray(item.children) ? item.children : [];
      const map = new Map(children.map((child) => [child.id, child]));
      const reordered = orderedIds.map((id) => map.get(id)).filter(Boolean);
      if (reordered.length !== children.length) return sendJSON(res, 400, { error: '排序列表与子节点不一致' });
      item.children = reordered;
      saveData(data);
      return sendJSON(res, 200, { children: item.children });
    }

    // PATCH /api/sections/:sectionId/items/:itemId/children/:childId —— 重命名子节点 { name }
    if (method === 'PATCH' && seg.length === 7 && seg[1] === 'sections' && seg[3] === 'items' && seg[5] === 'children') {
      const data = readData();
      const child = findChild(findItem(findSection(data, seg[2]), seg[4]), seg[6]);
      if (!child) return sendJSON(res, 404, { error: '子节点不存在' });
      const { name } = await readBody(req);
      const clean = String(name || '').trim();
      if (!clean) return sendJSON(res, 400, { error: '子节点名称不能为空' });
      child.name = clean;
      saveData(data);
      return sendJSON(res, 200, { child });
    }

    // DELETE /api/sections/:sectionId/items/:itemId/children/:childId —— 删除子节点及其记录
    if (method === 'DELETE' && seg.length === 7 && seg[1] === 'sections' && seg[3] === 'items' && seg[5] === 'children') {
      const data = readData();
      const section = findSection(data, seg[2]);
      const item = findItem(section, seg[4]);
      const child = findChild(item, seg[6]);
      if (!child) return sendJSON(res, 404, { error: '子节点不存在' });
      const extracted = extractCheckins(data, [child.id]);
      item.children = item.children.filter((entry) => entry.id !== child.id);
      archiveTrash(data, {
        kind: 'principle-child', title: child.name, moduleId: 'principles', sourceId: child.id,
        body: { sectionId: section.id, itemId: item.id, child, extracted },
      });
      saveData(data);
      return sendJSON(res, 200, { ok: true });
    }

    // ---------- 打卡 ----------
    // POST /api/checkin —— { date: 'YYYY-MM-DD', itemId, done: true/false }
    if (method === 'POST' && seg.length === 2 && seg[1] === 'checkin') {
      const { date, itemId, done } = await readBody(req);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date || ''))) {
        return sendJSON(res, 400, { error: '日期格式错误' });
      }
      if (typeof itemId !== 'string' || !itemId) {
        return sendJSON(res, 400, { error: '缺少条目 ID' });
      }
      // 校验条目或子节点存在
      const data = readData();
      if (!findCheckinNode(data, itemId)) return sendJSON(res, 404, { error: '条目不存在' });

      if (!data.records[date]) data.records[date] = {};
      data.records[date][itemId] = Boolean(done);
      saveData(data);
      return sendJSON(res, 200, { date, itemId, done: Boolean(done) });
    }

    // POST /api/checkin-reasons —— { date: 'YYYY-MM-DD', itemId, reason: string }
    if (method === 'POST' && seg.length === 2 && seg[1] === 'checkin-reasons') {
      const { date, itemId, reason } = await readBody(req);
      if (!isISODate(date)) return sendJSON(res, 400, { error: '日期格式错误' });
      if (typeof itemId !== 'string' || !itemId) return sendJSON(res, 400, { error: '缺少条目 ID' });
      if (typeof reason !== 'string') return sendJSON(res, 400, { error: '原因格式错误' });
      if (reason.length > 2000) return sendJSON(res, 400, { error: '未完成原因不能超过 2000 字' });
      const data = readData();
      if (!findCheckinNode(data, itemId)) return sendJSON(res, 404, { error: '条目不存在' });
      const clean = reason.trim();
      if (!data.checkinReasons[date]) data.checkinReasons[date] = {};
      if (clean) data.checkinReasons[date][itemId] = clean;
      else delete data.checkinReasons[date][itemId];
      if (!Object.keys(data.checkinReasons[date]).length) delete data.checkinReasons[date];
      saveData(data);
      return sendJSON(res, 200, { date, itemId, reason: clean });
    }

    // 图片以原始文件保存在本地；上传与图文记录保存分开，避免将二进制塞进 JSON。
    // review-images 保留给旧复盘接口，content-images 是所有双层模块使用的通用别名；两者共用同一目录和备份。
    if (method === 'POST' && seg.length === 2 && ['review-images', 'content-images'].includes(seg[1])) {
      const bytes = await readImageBody(req);
      const type = detectImageType(bytes);
      if (!type || req.headers['content-type']?.split(';')[0] !== type.mime) {
        return sendJSON(res, 400, { error: '图片格式不支持，请选择 PNG、JPG、WebP 或 GIF 图片' });
      }
      const imageId = `${newId()}.${type.ext}`;
      fs.mkdirSync(REVIEW_IMAGE_DIR, { recursive: true });
      fs.writeFileSync(path.join(REVIEW_IMAGE_DIR, imageId), bytes, { flag: 'wx' });
      return sendJSON(res, 201, { image: { id: imageId, url: `/api/${seg[1]}/${imageId}`, size: bytes.length } });
    }
    if ((method === 'GET' || method === 'HEAD') && seg.length === 3 && ['review-images', 'content-images'].includes(seg[1])) {
      if (!REVIEW_IMAGE_ID.test(seg[2])) return sendJSON(res, 404, { error: '图片不存在' });
      const imagePath = path.join(REVIEW_IMAGE_DIR, seg[2]);
      if (!fs.existsSync(imagePath)) return sendJSON(res, 404, { error: '图片不存在' });
      const mime = { png: 'image/png', jpg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif' }[path.extname(imagePath).slice(1)];
      res.writeHead(200, { 'Content-Type': mime, 'Content-Length': fs.statSync(imagePath).size,
        'Cache-Control': 'private, max-age=86400', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'; sandbox" });
      if (method === 'HEAD') return res.end();
      const stream = fs.createReadStream(imagePath);
      stream.on('error', () => res.destroy());
      stream.pipe(res);
      return;
    }

    // ---------- 自由思考 / 每日复盘 / 思想提取：文章 ----------
    // POST /api/thoughts —— 新建文章 { date, kind?: 'free'|'review'|'extraction', title?, text?, categoryId? }
    if (method === 'POST' && seg.length === 2 && seg[1] === 'thoughts') {
      const body = await readBody(req);
      if (!isISODate(body.date)) return sendJSON(res, 400, { error: '日期格式错误' });
      const kind = body.kind === undefined ? 'free' : body.kind;
      if (!THOUGHT_KINDS.includes(kind)) return sendJSON(res, 400, { error: '文章类型无效' });
      const title = String(body.title ?? '');
      const blocks = body.blocks === undefined ? undefined : normalizeReviewBlocks(body.blocks);
      const text = blocks ? reviewText(blocks) : String(body.text ?? '');
      if (!title.trim() && !text.trim() && !blocks?.some((block) => block.type !== 'text')) return sendJSON(res, 400, { error: '标题、正文和图片不能同时为空' });
      const data = readData();
      const categoryId = body.categoryId == null || body.categoryId === '' ? null : String(body.categoryId);
      if (categoryId && !findThoughtCategory(data, categoryId)) {
        return sendJSON(res, 400, { error: '所选类别不存在' });
      }
      if (categoryId && !findThoughtCategoryForKind(data, categoryId, kind)) {
        return sendJSON(res, 400, { error: '所选类别不属于当前文章类型' });
      }
      const now = new Date().toISOString();
      const thought = { id: newId(), kind, date: body.date, title, text, categoryId, createdAt: now, updatedAt: now };
      if (blocks) thought.blocks = blocks;
      data.thoughtEntries.push(thought);
      saveData(data);
      return sendJSON(res, 201, { thought });
    }

    // PATCH /api/thoughts/:id —— 更新文章 { title?, text?, categoryId? }
    if (method === 'PATCH' && seg.length === 3 && seg[1] === 'thoughts') {
      const body = await readBody(req);
      const data = readData();
      const thought = findThought(data, seg[2]);
      if (!thought) return sendJSON(res, 404, { error: '文章不存在' });
      if (Object.prototype.hasOwnProperty.call(body, 'kind') && body.kind !== thought.kind) {
        return sendJSON(res, 400, { error: '不能更改已有文章的类型' });
      }
      if (body.blocks !== undefined) {
        thought.blocks = normalizeReviewBlocks(body.blocks);
        thought.text = reviewText(thought.blocks);
      } else if (Object.prototype.hasOwnProperty.call(body, 'text') && thought.blocks) {
        if (thought.blocks.some((block) => block.type !== 'text')) return sendJSON(res, 409, { error: '请刷新页面后使用图文编辑器，避免覆盖已有图片或图稿' });
        thought.blocks = [{ id: thought.blocks.find((block) => block.type === 'text')?.id || newId(), type: 'text', text: String(body.text ?? '') }];
      }
      if (Object.prototype.hasOwnProperty.call(body, 'title')) thought.title = String(body.title ?? '');
      if (body.blocks === undefined && Object.prototype.hasOwnProperty.call(body, 'text')) thought.text = String(body.text ?? '');
      if (Object.prototype.hasOwnProperty.call(body, 'categoryId')) {
        const categoryId = body.categoryId == null || body.categoryId === '' ? null : String(body.categoryId);
        if (categoryId && !findThoughtCategory(data, categoryId)) {
          return sendJSON(res, 400, { error: '所选类别不存在' });
        }
        if (categoryId && !findThoughtCategoryForKind(data, categoryId, thought.kind)) {
          return sendJSON(res, 400, { error: '所选类别不属于当前文章类型' });
        }
        thought.categoryId = categoryId;
      }
      thought.updatedAt = new Date().toISOString();
      saveData(data);
      return sendJSON(res, 200, { thought });
    }

    // DELETE /api/thoughts/:id —— 删除单篇文章
    if (method === 'DELETE' && seg.length === 3 && seg[1] === 'thoughts') {
      const data = readData();
      const thought = findThought(data, seg[2]);
      if (!thought) return sendJSON(res, 404, { error: '文章不存在' });
      data.thoughtEntries = data.thoughtEntries.filter((entry) => entry.id !== thought.id);
      archiveTrash(data, {
        kind: 'record', title: thought.title || '未命名', moduleId: 'thoughts', sourceId: thought.id,
        body: { scope: 'root', moduleId: 'thoughts', collection: 'thoughtEntries', record: thought },
      });
      saveData(data);
      return sendJSON(res, 200, { ok: true });
    }

    // ---------- 所思文章类别（按文章类型独立） ----------
    // POST /api/thought-categories —— 新建类别 { name, kind?: 'free'|'review'|'extraction' }
    if (method === 'POST' && seg.length === 2 && seg[1] === 'thought-categories') {
      const body = await readBody(req);
      const { name } = body;
      const kind = body.kind === undefined ? 'free' : body.kind;
      if (!THOUGHT_KINDS.includes(kind)) return sendJSON(res, 400, { error: '文章类型无效' });
      const clean = String(name || '').trim();
      if (!clean) return sendJSON(res, 400, { error: '类别名称不能为空' });
      const data = readData();
      if (data.thoughtCategories.some((entry) => entry.kind === kind && entry.name.toLocaleLowerCase() === clean.toLocaleLowerCase())) {
        return sendJSON(res, 409, { error: '类别名称已存在' });
      }
      const category = { id: newId(), kind, name: clean, createdAt: new Date().toISOString() };
      data.thoughtCategories.push(category);
      saveData(data);
      return sendJSON(res, 201, { category });
    }

    // PATCH /api/thought-categories/:id —— 重命名类别 { name }
    if (method === 'PATCH' && seg.length === 3 && seg[1] === 'thought-categories') {
      const { name } = await readBody(req);
      const data = readData();
      const category = findThoughtCategory(data, seg[2]);
      if (!category) return sendJSON(res, 404, { error: '类别不存在' });
      const clean = String(name || '').trim();
      if (!clean) return sendJSON(res, 400, { error: '类别名称不能为空' });
      if (data.thoughtCategories.some((entry) => entry.id !== category.id && entry.kind === category.kind && entry.name.toLocaleLowerCase() === clean.toLocaleLowerCase())) {
        return sendJSON(res, 409, { error: '类别名称已存在' });
      }
      category.name = clean;
      saveData(data);
      return sendJSON(res, 200, { category });
    }

    // DELETE /api/thought-categories/:id —— 删除类别，文章转为未分类
    if (method === 'DELETE' && seg.length === 3 && seg[1] === 'thought-categories') {
      const data = readData();
      const category = findThoughtCategory(data, seg[2]);
      if (!category) return sendJSON(res, 404, { error: '类别不存在' });
      const reattachItemIds = data.thoughtEntries.filter((entry) => entry.categoryId === category.id).map((entry) => entry.id);
      data.thoughtCategories = data.thoughtCategories.filter((entry) => entry.id !== category.id);
      for (const thought of data.thoughtEntries) {
        if (thought.categoryId === category.id) thought.categoryId = null;
      }
      archiveTrash(data, {
        kind: 'category', title: category.name, moduleId: 'thoughts', sourceId: category.id,
        body: { scope: 'root', moduleId: 'thoughts', collection: 'thoughtCategories', itemsKey: 'thoughtEntries', category, reattachItemIds },
      });
      saveData(data);
      return sendJSON(res, 200, { ok: true });
    }

    // POST /api/think —— 旧版兼容入口；只维护该日期的兼容文章
    if (method === 'POST' && seg.length === 2 && seg[1] === 'think') {
      const { date, text } = await readBody(req);
      if (!isISODate(date)) {
        return sendJSON(res, 400, { error: '日期格式错误' });
      }
      const data = readData();
      const value = String(text ?? '');
      const existing = data.thoughtEntries.find((entry) => entry.legacyDate === date && entry.kind !== 'review') || null;
      if (existing?.blocks?.some((block) => block.type !== 'text')) return sendJSON(res, 409, { error: '请使用图文编辑器，旧版文字接口不能覆盖图片或图稿' });
      if (!value.trim()) {
        if (existing) data.thoughtEntries = data.thoughtEntries.filter((entry) => entry.id !== existing.id);
      } else if (existing) {
        existing.text = value;
        existing.title = deriveThoughtTitle(value);
        existing.updatedAt = new Date().toISOString();
      } else {
        const now = new Date().toISOString();
        data.thoughtEntries.push({
          id: newId(), kind: 'free', date, title: deriveThoughtTitle(value), text: value, categoryId: null,
          createdAt: now, updatedAt: now, legacyDate: date,
        });
      }
      saveData(data);
      return sendJSON(res, 200, { date, saved: true });
    }

    // ---------- 每日反思：框架管理 ----------
    // POST /api/reflect/frameworks —— 新建框架 { name }
    if (method === 'POST' && seg.length === 3 && seg[1] === 'reflect' && seg[2] === 'frameworks') {
      const { name } = await readBody(req);
      const clean = String(name || '').trim();
      if (!clean) return sendJSON(res, 400, { error: '框架名称不能为空' });
      const data = readData();
      const framework = { id: newId(), name: clean };
      data.reflectFrameworks.push(framework);
      saveData(data);
      return sendJSON(res, 201, { framework });
    }

    // POST /api/reflect/frameworks/reorder —— 框架排序 { orderedIds }
    if (method === 'POST' && seg.length === 4 && seg[1] === 'reflect' && seg[2] === 'frameworks' && seg[3] === 'reorder') {
      const { orderedIds } = await readBody(req);
      if (!Array.isArray(orderedIds)) return sendJSON(res, 400, { error: '参数错误' });
      const data = readData();
      const map = new Map(data.reflectFrameworks.map((f) => [f.id, f]));
      const reordered = orderedIds.map((id) => map.get(id)).filter(Boolean);
      if (reordered.length !== data.reflectFrameworks.length) {
        return sendJSON(res, 400, { error: '排序列表与框架不一致' });
      }
      data.reflectFrameworks = reordered;
      saveData(data);
      return sendJSON(res, 200, { frameworks: data.reflectFrameworks });
    }

    // PATCH /api/reflect/frameworks/:id —— 重命名框架 { name }
    if (method === 'PATCH' && seg.length === 4 && seg[1] === 'reflect' && seg[2] === 'frameworks') {
      const { name } = await readBody(req);
      const data = readData();
      const framework = data.reflectFrameworks.find((f) => f.id === seg[3]);
      if (!framework) return sendJSON(res, 404, { error: '框架不存在' });
      const clean = String(name || '').trim();
      if (!clean) return sendJSON(res, 400, { error: '框架名称不能为空' });
      framework.name = clean;
      saveData(data);
      return sendJSON(res, 200, { framework });
    }

    // DELETE /api/reflect/frameworks/:id —— 删除框架（同步清理各日期内容）
    if (method === 'DELETE' && seg.length === 4 && seg[1] === 'reflect' && seg[2] === 'frameworks') {
      const data = readData();
      const framework = data.reflectFrameworks.find((entry) => entry.id === seg[3]);
      if (!framework) return sendJSON(res, 404, { error: '框架不存在' });
      const answers = {};
      data.reflectFrameworks = data.reflectFrameworks.filter((entry) => entry.id !== framework.id);
      for (const date of Object.keys(data.reflectEntries)) {
        const entry = data.reflectEntries[date];
        if (entry && typeof entry === 'object' && Object.prototype.hasOwnProperty.call(entry, framework.id)) {
          answers[date] = entry[framework.id];
          delete entry[framework.id];
          if (!Object.keys(entry).length) delete data.reflectEntries[date];
        }
      }
      archiveTrash(data, {
        kind: 'framework', title: framework.name, moduleId: 'thoughts', sourceId: framework.id,
        body: { framework, answers },
      });
      saveData(data);
      return sendJSON(res, 200, { ok: true });
    }

    // ---------- 每日反思：内容 ----------
    // POST /api/reflect —— { date, entries: { frameworkId: text } } 保存当天反思
    if (method === 'POST' && seg.length === 2 && seg[1] === 'reflect') {
      const { date, entries } = await readBody(req);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date || ''))) {
        return sendJSON(res, 400, { error: '日期格式错误' });
      }
      if (!entries || typeof entries !== 'object' || Array.isArray(entries)) {
        return sendJSON(res, 400, { error: '参数错误' });
      }
      const data = readData();
      data.reflectEntries[date] = entries;
      saveData(data);
      return sendJSON(res, 200, { date, saved: true });
    }

    if (method === 'DELETE' && seg.length === 3 && seg[1] === 'reflect' && isISODate(seg[2])) {
      const data = readData();
      const entries = data.reflectEntries[seg[2]];
      delete data.reflectEntries[seg[2]];
      if (entries && Object.values(entries).some((text) => String(text || '').trim())) {
        archiveTrash(data, {
          kind: 'reflection', title: seg[2], moduleId: 'thoughts', sourceId: seg[2],
          body: { date: seg[2], entries },
        });
      }
      saveData(data);
      return sendJSON(res, 200, { ok: true });
    }

    // ---------- 计划 ----------
    // POST /api/plans —— 新建计划 { name, categoryId? }
    if (method === 'POST' && seg.length === 2 && seg[1] === 'plans') {
      const body = await readBody(req);
      const { name } = body;
      const clean = String(name || '').trim();
      if (!clean) return sendJSON(res, 400, { error: '计划名称不能为空' });
      const data = readData();
      const categoryId = categoryIdFor(data, FLAT_CATEGORY_MODULES.plans, body.categoryId);
      if (categoryId === undefined) return sendJSON(res, 400, { error: '分类不存在' });
      const plan = { id: newId(), categoryId, name: clean, description: '', note: '' };
      applyRichFields(plan, body, [
        { blocksKey: 'descriptionBlocks', textKey: 'description', label: '具体计划' },
        { blocksKey: 'noteBlocks', textKey: 'note', label: '计划笔记' },
      ], '计划');
      data.plans.push(plan);
      saveData(data);
      return sendJSON(res, 201, { plan });
    }

    // POST /api/plans/reorder —— 计划排序 { orderedIds }
    if (method === 'POST' && seg.length === 3 && seg[1] === 'plans' && seg[2] === 'reorder') {
      const { orderedIds } = await readBody(req);
      if (!Array.isArray(orderedIds)) return sendJSON(res, 400, { error: '参数错误' });
      const data = readData();
      const map = new Map(data.plans.map((p) => [p.id, p]));
      const reordered = orderedIds.map((id) => map.get(id)).filter(Boolean);
      if (reordered.length !== data.plans.length) {
        return sendJSON(res, 400, { error: '排序列表与计划不一致' });
      }
      data.plans = reordered;
      saveData(data);
      return sendJSON(res, 200, { plans: data.plans });
    }

    // PATCH /api/plans/:id —— 更新名称/描述/分类 { name?, description?, categoryId? }
    if (method === 'PATCH' && seg.length === 3 && seg[1] === 'plans') {
      const body = await readBody(req);
      const data = readData();
      const plan = data.plans.find((p) => p.id === seg[2]);
      if (!plan) return sendJSON(res, 404, { error: '计划不存在' });
      if (body.name !== undefined) {
        const clean = String(body.name).trim();
        if (!clean) return sendJSON(res, 400, { error: '计划名称不能为空' });
        plan.name = clean;
      }
      applyRichFields(plan, body, [
        { blocksKey: 'descriptionBlocks', textKey: 'description', label: '具体计划' },
        { blocksKey: 'noteBlocks', textKey: 'note', label: '计划笔记' },
      ], '计划');
      if (Object.prototype.hasOwnProperty.call(body, 'categoryId')) {
        const categoryId = categoryIdFor(data, FLAT_CATEGORY_MODULES.plans, body.categoryId);
        if (categoryId === undefined) return sendJSON(res, 400, { error: '分类不存在' });
        plan.categoryId = categoryId;
      }
      saveData(data);
      return sendJSON(res, 200, { plan });
    }

    // POST /api/plans/:id/note —— 保存笔记 { note }
    if (method === 'POST' && seg.length === 4 && seg[1] === 'plans' && seg[3] === 'note') {
      const body = await readBody(req);
      const data = readData();
      const plan = data.plans.find((p) => p.id === seg[2]);
      if (!plan) return sendJSON(res, 404, { error: '计划不存在' });
      applyRichFields(plan, body, [{ blocksKey: 'noteBlocks', textKey: 'note', label: '计划笔记' }], '计划');
      saveData(data);
      return sendJSON(res, 200, { saved: true });
    }

    // DELETE /api/plans/:id —— 删除计划
    if (method === 'DELETE' && seg.length === 3 && seg[1] === 'plans') {
      const data = readData();
      const plan = data.plans.find((entry) => entry.id === seg[2]);
      data.plans = data.plans.filter((entry) => entry.id !== seg[2]);
      if (plan) archiveTrash(data, { kind: 'record', title: plan.name, moduleId: 'plans', sourceId: plan.id, body: { scope: 'root', moduleId: 'plans', collection: 'plans', record: plan } });
      saveData(data);
      return sendJSON(res, 200, { ok: true });
    }

    // ---------- 个人模板 ----------
    // POST /api/templates —— 新建模板 { name, categoryId? }
    if (method === 'POST' && seg.length === 2 && seg[1] === 'templates') {
      const body = await readBody(req);
      const { name } = body;
      const clean = String(name || '').trim();
      if (!clean) return sendJSON(res, 400, { error: '模板名称不能为空' });
      const data = readData();
      const categoryId = categoryIdFor(data, FLAT_CATEGORY_MODULES.templates, body.categoryId);
      if (categoryId === undefined) return sendJSON(res, 400, { error: '分类不存在' });
      const template = { id: newId(), categoryId, name: clean, content: '', note: '' };
      applyRichFields(template, body, [
        { blocksKey: 'contentBlocks', textKey: 'content', label: '模板内容' },
        { blocksKey: 'noteBlocks', textKey: 'note', label: '使用备注' },
      ], '个人模板');
      data.templates.push(template);
      saveData(data);
      return sendJSON(res, 201, { template });
    }

    // POST /api/templates/reorder —— 模板排序 { orderedIds }
    if (method === 'POST' && seg.length === 3 && seg[1] === 'templates' && seg[2] === 'reorder') {
      const { orderedIds } = await readBody(req);
      if (!Array.isArray(orderedIds)) return sendJSON(res, 400, { error: '参数错误' });
      const data = readData();
      const map = new Map(data.templates.map((t) => [t.id, t]));
      const reordered = orderedIds.map((id) => map.get(id)).filter(Boolean);
      if (reordered.length !== data.templates.length) {
        return sendJSON(res, 400, { error: '排序列表与模板不一致' });
      }
      data.templates = reordered;
      saveData(data);
      return sendJSON(res, 200, { templates: data.templates });
    }

    // PATCH /api/templates/:id —— 更新名称/内容/分类 { name?, content?, categoryId? }
    if (method === 'PATCH' && seg.length === 3 && seg[1] === 'templates') {
      const body = await readBody(req);
      const data = readData();
      const template = data.templates.find((t) => t.id === seg[2]);
      if (!template) return sendJSON(res, 404, { error: '模板不存在' });
      if (body.name !== undefined) {
        const clean = String(body.name).trim();
        if (!clean) return sendJSON(res, 400, { error: '模板名称不能为空' });
        template.name = clean;
      }
      applyRichFields(template, body, [
        { blocksKey: 'contentBlocks', textKey: 'content', label: '模板内容' },
        { blocksKey: 'noteBlocks', textKey: 'note', label: '使用备注' },
      ], '个人模板');
      if (Object.prototype.hasOwnProperty.call(body, 'categoryId')) {
        const categoryId = categoryIdFor(data, FLAT_CATEGORY_MODULES.templates, body.categoryId);
        if (categoryId === undefined) return sendJSON(res, 400, { error: '分类不存在' });
        template.categoryId = categoryId;
      }
      saveData(data);
      return sendJSON(res, 200, { template });
    }

    // POST /api/templates/:id/note —— 保存备注 { note }
    if (method === 'POST' && seg.length === 4 && seg[1] === 'templates' && seg[3] === 'note') {
      const body = await readBody(req);
      const data = readData();
      const template = data.templates.find((t) => t.id === seg[2]);
      if (!template) return sendJSON(res, 404, { error: '模板不存在' });
      applyRichFields(template, body, [{ blocksKey: 'noteBlocks', textKey: 'note', label: '使用备注' }], '个人模板');
      saveData(data);
      return sendJSON(res, 200, { saved: true });
    }

    // DELETE /api/templates/:id —— 删除模板
    if (method === 'DELETE' && seg.length === 3 && seg[1] === 'templates') {
      const data = readData();
      const template = data.templates.find((entry) => entry.id === seg[2]);
      data.templates = data.templates.filter((entry) => entry.id !== seg[2]);
      if (template) archiveTrash(data, { kind: 'record', title: template.name, moduleId: 'templates', sourceId: template.id, body: { scope: 'root', moduleId: 'templates', collection: 'templates', record: template } });
      saveData(data);
      return sendJSON(res, 200, { ok: true });
    }

    // ---------- 问题拆解 ----------
    // POST /api/problems —— 新建问题 { name, categoryId? }
    if (method === 'POST' && seg.length === 2 && seg[1] === 'problems') {
      const body = await readBody(req);
      const { name } = body;
      const clean = String(name || '').trim();
      if (!clean) return sendJSON(res, 400, { error: '问题标题不能为空' });
      const data = readData();
      const categoryId = categoryIdFor(data, FLAT_CATEGORY_MODULES.problems, body.categoryId);
      if (categoryId === undefined) return sendJSON(res, 400, { error: '分类不存在' });
      const problem = { id: newId(), categoryId, name: clean, content: '', note: '' };
      applyRichFields(problem, body, [
        { blocksKey: 'contentBlocks', textKey: 'content', label: '拆解内容' },
        { blocksKey: 'noteBlocks', textKey: 'note', label: '备注' },
      ], '问题拆解');
      data.problems.push(problem);
      saveData(data);
      return sendJSON(res, 201, { problem });
    }

    // POST /api/problems/reorder —— 问题排序 { orderedIds }
    if (method === 'POST' && seg.length === 3 && seg[1] === 'problems' && seg[2] === 'reorder') {
      const { orderedIds } = await readBody(req);
      if (!Array.isArray(orderedIds)) return sendJSON(res, 400, { error: '参数错误' });
      const data = readData();
      const map = new Map(data.problems.map((p) => [p.id, p]));
      const reordered = orderedIds.map((id) => map.get(id)).filter(Boolean);
      if (reordered.length !== data.problems.length) {
        return sendJSON(res, 400, { error: '排序列表与问题不一致' });
      }
      data.problems = reordered;
      saveData(data);
      return sendJSON(res, 200, { problems: data.problems });
    }

    // PATCH /api/problems/:id —— 单请求保存全部字段 { name?, content?, note?, categoryId? }
    if (method === 'PATCH' && seg.length === 3 && seg[1] === 'problems') {
      const body = await readBody(req);
      const data = readData();
      const problem = data.problems.find((p) => p.id === seg[2]);
      if (!problem) return sendJSON(res, 404, { error: '问题不存在' });
      if (body.name !== undefined) {
        const clean = String(body.name).trim();
        if (!clean) return sendJSON(res, 400, { error: '问题标题不能为空' });
        problem.name = clean;
      }
      applyRichFields(problem, body, [
        { blocksKey: 'contentBlocks', textKey: 'content', label: '拆解内容' },
        { blocksKey: 'noteBlocks', textKey: 'note', label: '备注' },
      ], '问题拆解');
      if (Object.prototype.hasOwnProperty.call(body, 'categoryId')) {
        const categoryId = categoryIdFor(data, FLAT_CATEGORY_MODULES.problems, body.categoryId);
        if (categoryId === undefined) return sendJSON(res, 400, { error: '分类不存在' });
        problem.categoryId = categoryId;
      }
      saveData(data);
      return sendJSON(res, 200, { problem });
    }

    // DELETE /api/problems/:id —— 删除问题
    if (method === 'DELETE' && seg.length === 3 && seg[1] === 'problems') {
      const data = readData();
      const problem = data.problems.find((entry) => entry.id === seg[2]);
      data.problems = data.problems.filter((entry) => entry.id !== seg[2]);
      if (problem) archiveTrash(data, { kind: 'record', title: problem.name, moduleId: 'problems', sourceId: problem.id, body: { scope: 'root', moduleId: 'problems', collection: 'problems', record: problem } });
      saveData(data);
      return sendJSON(res, 200, { ok: true });
    }

    // ---------- 学习专区 ----------
    // POST /api/learning-categories —— 新建分类 { name }
    if (method === 'POST' && seg.length === 2 && seg[1] === 'learning-categories') {
      const { name } = await readBody(req);
      const clean = String(name || '').trim();
      if (!clean) return sendJSON(res, 400, { error: '分类名称不能为空' });
      const data = readData();
      if (data.learningCategories.some((entry) => entry.name.toLocaleLowerCase() === clean.toLocaleLowerCase())) {
        return sendJSON(res, 409, { error: '分类名称已存在' });
      }
      const category = { id: newId(), name: clean, createdAt: new Date().toISOString() };
      data.learningCategories.push(category);
      saveData(data);
      return sendJSON(res, 201, { category });
    }

    // PATCH /api/learning-categories/:id —— 重命名分类 { name }
    if (method === 'PATCH' && seg.length === 3 && seg[1] === 'learning-categories') {
      const data = readData();
      const category = data.learningCategories.find((entry) => entry.id === seg[2]);
      if (!category) return sendJSON(res, 404, { error: '分类不存在' });
      const { name } = await readBody(req);
      const clean = String(name || '').trim();
      if (!clean) return sendJSON(res, 400, { error: '分类名称不能为空' });
      if (data.learningCategories.some((entry) => entry.id !== category.id && entry.name.toLocaleLowerCase() === clean.toLocaleLowerCase())) {
        return sendJSON(res, 409, { error: '分类名称已存在' });
      }
      category.name = clean;
      saveData(data);
      return sendJSON(res, 200, { category });
    }

    // DELETE /api/learning-categories/:id —— 删除分类，旗下模板转为未分类
    if (method === 'DELETE' && seg.length === 3 && seg[1] === 'learning-categories') {
      const data = readData();
      const category = data.learningCategories.find((entry) => entry.id === seg[2]);
      if (!category) return sendJSON(res, 404, { error: '分类不存在' });
      const reattachItemIds = data.learningTemplates.filter((entry) => entry.categoryId === category.id).map((entry) => entry.id);
      data.learningCategories = data.learningCategories.filter((entry) => entry.id !== category.id);
      for (const template of data.learningTemplates) {
        if (template.categoryId === category.id) template.categoryId = null;
      }
      archiveTrash(data, {
        kind: 'category', title: category.name, moduleId: 'learning', sourceId: category.id,
        body: { scope: 'root', moduleId: 'learning', collection: 'learningCategories', itemsKey: 'learningTemplates', category, reattachItemIds },
      });
      saveData(data);
      return sendJSON(res, 200, { ok: true });
    }

    // POST /api/learning/templates —— 新建学习模板 { name, categoryId? }
    if (method === 'POST' && seg.length === 3 && seg[1] === 'learning' && seg[2] === 'templates') {
      const body = await readBody(req);
      const clean = String(body.name || '').trim();
      if (!clean) return sendJSON(res, 400, { error: '模板名称不能为空' });
      const data = readData();
      let categoryId = null;
      if (body.categoryId) {
        const category = data.learningCategories.find((entry) => entry.id === body.categoryId);
        if (!category) return sendJSON(res, 400, { error: '分类不存在' });
        categoryId = category.id;
      }
      const now = new Date().toISOString();
      const template = { id: newId(), categoryId, name: clean, content: '', note: '', createdAt: now, updatedAt: now };
      applyRichFields(template, body, [
        { blocksKey: 'contentBlocks', textKey: 'content', label: '模板内容' },
        { blocksKey: 'noteBlocks', textKey: 'note', label: '使用备注' },
      ], '学习模板');
      data.learningTemplates.push(template);
      saveData(data);
      return sendJSON(res, 201, { template });
    }

    // POST /api/learning/templates/reorder —— 稳定重排 { orderedIds }：仅调整所列模板的相对顺序，其余不动
    if (method === 'POST' && seg.length === 4 && seg[1] === 'learning' && seg[2] === 'templates' && seg[3] === 'reorder') {
      const { orderedIds } = await readBody(req);
      if (!Array.isArray(orderedIds) || new Set(orderedIds).size !== orderedIds.length) {
        return sendJSON(res, 400, { error: '参数错误' });
      }
      const data = readData();
      const map = new Map(data.learningTemplates.map((t) => [t.id, t]));
      if (!orderedIds.every((id) => map.has(id))) {
        return sendJSON(res, 400, { error: '排序列表与模板不一致' });
      }
      if (orderedIds.length !== data.learningTemplates.length) {
        // 部分重排（筛选视图）：把所列模板按新顺序放回它们原本占据的槽位
        const queue = orderedIds.map((id) => map.get(id));
        data.learningTemplates = data.learningTemplates.map((entry) => (orderedIds.includes(entry.id) ? queue.shift() : entry));
      } else {
        data.learningTemplates = orderedIds.map((id) => map.get(id));
      }
      saveData(data);
      return sendJSON(res, 200, { templates: data.learningTemplates });
    }

    // PATCH /api/learning/templates/:id —— 单请求保存全部字段 { name?, content?, note?, categoryId? }
    if (method === 'PATCH' && seg.length === 4 && seg[1] === 'learning' && seg[2] === 'templates') {
      const body = await readBody(req);
      const data = readData();
      const template = data.learningTemplates.find((t) => t.id === seg[3]);
      if (!template) return sendJSON(res, 404, { error: '模板不存在' });
      if (body.name !== undefined) {
        const clean = String(body.name).trim();
        if (!clean) return sendJSON(res, 400, { error: '模板名称不能为空' });
        template.name = clean;
      }
      applyRichFields(template, body, [
        { blocksKey: 'contentBlocks', textKey: 'content', label: '模板内容' },
        { blocksKey: 'noteBlocks', textKey: 'note', label: '使用备注' },
      ], '学习模板');
      if (Object.prototype.hasOwnProperty.call(body, 'categoryId')) {
        const categoryId = body.categoryId == null || body.categoryId === '' ? null : String(body.categoryId);
        if (categoryId && !data.learningCategories.some((entry) => entry.id === categoryId)) return sendJSON(res, 400, { error: '分类不存在' });
        template.categoryId = categoryId;
      }
      template.updatedAt = new Date().toISOString();
      saveData(data);
      return sendJSON(res, 200, { template });
    }

    // DELETE /api/learning/templates/:id —— 删除学习模板
    if (method === 'DELETE' && seg.length === 4 && seg[1] === 'learning' && seg[2] === 'templates') {
      const data = readData();
      const template = data.learningTemplates.find((entry) => entry.id === seg[3]);
      data.learningTemplates = data.learningTemplates.filter((entry) => entry.id !== seg[3]);
      if (template) archiveTrash(data, { kind: 'record', title: template.name, moduleId: 'learning', sourceId: template.id, body: { scope: 'root', moduleId: 'learning', collection: 'learningTemplates', record: template } });
      saveData(data);
      return sendJSON(res, 200, { ok: true });
    }

    // ---------- 核心思想 / 复盘：与学习专区同语义的分类模板库 ----------
    if (await serveCategorizedLibrary(req, res, method, seg)) return;

    // ---------- 界面导航 ----------
    if (method === 'GET' && seg.length === 3 && seg[1] === 'navigation' && seg[2] === 'preferences') {
      return sendJSON(res, 200, navigationSnapshot(readData()));
    }

    if (method === 'PATCH' && seg.length === 3 && seg[1] === 'navigation' && seg[2] === 'preferences') {
      const body = await readBody(req);
      if (!requireDataEpoch(req, res)) return;
      const data = readData();
      const current = data.navigationPreferences;
      const registeredIds = effectiveModuleIds(data);
      if (!Number.isInteger(body.baseRevision) || body.baseRevision < 0) {
        return sendJSON(res, 400, { error: 'baseRevision 必须是非负整数', commitState: 'not_committed' });
      }
      if (body.baseRevision !== current.revision) {
        return sendJSON(res, 409, { error: '模块设置已在其他页面更新，请重新载入最新设置后再修改', code: 'NAVIGATION_REVISION_CONFLICT', commitState: 'not_committed', ...navigationSnapshot(data) });
      }
      if (!Array.isArray(body.moduleOrder)
        || body.moduleOrder.length !== registeredIds.length
        || new Set(body.moduleOrder).size !== registeredIds.length
        || !body.moduleOrder.every((id) => registeredIds.includes(id))) {
        return sendJSON(res, 400, { error: '模块顺序必须恰好包含全部注册模块且不重复' });
      }
      const placement = body.placementByModule;
      if (!placement || typeof placement !== 'object' || Array.isArray(placement)) {
        return sendJSON(res, 400, { error: '模块归属格式错误' });
      }
      const placementKeys = Object.keys(placement);
      if (placementKeys.length !== registeredIds.length
        || !registeredIds.every((id) => Object.prototype.hasOwnProperty.call(placement, id))
        || !registeredIds.every((id) => validWorkspace(placement[id]))) {
        return sendJSON(res, 400, { error: '模块归属必须恰好覆盖全部模块，且只能是当前界面或专区界面' });
      }
      current.moduleOrder = [...body.moduleOrder];
      current.placementByModule = {};
      for (const id of registeredIds) current.placementByModule[id] = placement[id];
      // 最近视图按新归属校验：失效模块回退到所属界面第一项，空界面记录为 null
      for (const ws of WORKSPACE_IDS) {
        const ids = current.moduleOrder.filter((id) => current.placementByModule[id] === ws);
        current.lastViewByWorkspace[ws] = ids.includes(current.lastViewByWorkspace[ws]) ? current.lastViewByWorkspace[ws] : (ids[0] || null);
      }
      current.revision += 1; // 仅设置配置保存增加 revision
      saveData(data);
      return sendJSON(res, 200, navigationSnapshot(data));
    }

    if (method === 'PATCH' && seg.length === 3 && seg[1] === 'navigation' && seg[2] === 'context') {
      const body = await readBody(req);
      if (!requireDataEpoch(req, res)) return;
      const data = readData();
      const registeredIds = effectiveModuleIds(data);
      const current = data.navigationPreferences;
      if (!validWorkspace(body.workspace)) {
        return sendJSON(res, 400, { error: 'workspace 只能是 main 或 zone' });
      }
      const ids = current.moduleOrder.filter((id) => current.placementByModule[id] === body.workspace);
      if (body.view !== null && body.view !== undefined) {
        if (typeof body.view !== 'string' || !registeredIds.includes(body.view) || !ids.includes(body.view)) {
          return sendJSON(res, 400, { error: 'view 必须是属于该界面的业务模块，或空界面的 null' });
        }
      }
      if (body.view === null && ids.length) return sendJSON(res, 400, { error: '只有空界面允许null', commitState: 'not_committed' });
      const view = body.view === undefined ? current.lastViewByWorkspace[body.workspace] : (body.view || null);
      current.lastWorkspace = body.workspace;
      current.lastViewByWorkspace[body.workspace] = view;
      saveData(data); // 浏览记录写入不增加配置 revision
      return sendJSON(res, 200, navigationSnapshot(data));
    }


    // ---------- 事件安排 ----------
    const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

    // POST /api/events —— 新建事件 { title, note, time, startDate, endDate, repeat }
    if (method === 'POST' && seg.length === 2 && seg[1] === 'events') {
      const body = await readBody(req);
      const title = String(body.title || '').trim();
      if (!title) return sendJSON(res, 400, { error: '事件名称不能为空' });
      const startDate = String(body.startDate || '');
      if (!DATE_RE.test(startDate)) return sendJSON(res, 400, { error: '日期格式错误' });
      const data = readData();
      const event = {
        id: newId(),
        title,
        note: body.note !== undefined ? String(body.note) : '',
        time: body.time || null,
        startDate,
        endDate: body.endDate || null,
        repeat: normalizeEventRepeat(body.repeat),
        enabled: body.enabled !== false,
        createdAt: new Date().toISOString(),
        archivedAt: null,
      };
      data.events.push(event);
      saveData(data);
      return sendJSON(res, 201, { event });
    }

    // PUT /api/events/:id —— 更新事件（标题/备注/时间/日期/重复规则/启用状态）
    if (method === 'PUT' && seg.length === 3 && seg[1] === 'events') {
      const data = readData();
      const event = data.events.find((e) => e.id === seg[2]);
      if (!event) return sendJSON(res, 404, { error: '事件不存在' });
      const body = await readBody(req);
      if (body.title !== undefined) {
        const clean = String(body.title).trim();
        if (!clean) return sendJSON(res, 400, { error: '事件名称不能为空' });
        event.title = clean;
      }
      if (body.note !== undefined) event.note = String(body.note);
      if (body.time !== undefined) event.time = body.time || null;
      if (body.startDate !== undefined) {
        if (!DATE_RE.test(String(body.startDate))) return sendJSON(res, 400, { error: '日期格式错误' });
        event.startDate = body.startDate;
      }
      if (body.endDate !== undefined) event.endDate = body.endDate || null;
      if (body.repeat !== undefined) event.repeat = normalizeEventRepeat(body.repeat);
      if (body.enabled !== undefined) event.enabled = Boolean(body.enabled);
      saveData(data);
      return sendJSON(res, 200, { event });
    }

    // POST /api/events/:id/archive —— 归档/结束事件 { effectiveDate }
    // 从 effectiveDate 起不再发生；过去完成记录保留。
    if (method === 'POST' && seg.length === 4 && seg[1] === 'events' && seg[3] === 'archive') {
      const data = readData();
      const event = data.events.find((e) => e.id === seg[2]);
      if (!event) return sendJSON(res, 404, { error: '事件不存在' });
      const { effectiveDate } = await readBody(req);
      if (!DATE_RE.test(String(effectiveDate || ''))) return sendJSON(res, 400, { error: '日期格式错误' });
      const prev = new Date(`${effectiveDate}T00:00:00`);
      prev.setDate(prev.getDate() - 1);
      const prevISO = toISODateLocal(prev);
      event.endDate = event.endDate && event.endDate < prevISO ? event.endDate : prevISO;
      event.archivedAt = new Date().toISOString();
      saveData(data);
      return sendJSON(res, 200, { event });
    }

    // POST /api/event-exceptions —— 建立/覆盖重复事件例外 { eventId, date, type, changes }
    if (method === 'POST' && seg.length === 2 && seg[1] === 'event-exceptions') {
      const { eventId, date, type, changes } = await readBody(req);
      if (!eventId || !DATE_RE.test(String(date || ''))) return sendJSON(res, 400, { error: '参数错误' });
      if (type !== 'override' && type !== 'cancel') return sendJSON(res, 400, { error: '例外类型错误' });
      const data = readData();
      if (!data.events.some((e) => e.id === eventId)) return sendJSON(res, 404, { error: '事件不存在' });
      const existing = data.eventExceptions.find((ex) => ex.eventId === eventId && ex.date === date);
      if (existing) {
        existing.type = type;
        existing.changes = changes || {};
      } else {
        data.eventExceptions.push({ eventId, date, type, changes: changes || {} });
      }
      saveData(data);
      return sendJSON(res, 201, { exception: { eventId, date, type, changes: changes || {} } });
    }

    // POST /api/event-checkin —— 事件打卡 { eventId, date, done }
    if (method === 'POST' && seg.length === 2 && seg[1] === 'event-checkin') {
      const { eventId, date, done } = await readBody(req);
      if (!eventId || !DATE_RE.test(String(date || ''))) return sendJSON(res, 400, { error: '参数错误' });
      const data = readData();
      if (!data.events.some((e) => e.id === eventId)) return sendJSON(res, 404, { error: '事件不存在' });
      const key = `${eventId}@${date}`;
      if (done) {
        data.eventCheckins[key] = { done: true, completedAt: new Date().toISOString() };
      } else {
        delete data.eventCheckins[key];
      }
      saveData(data);
      return sendJSON(res, 200, { key, done: Boolean(done) });
    }

    return sendJSON(res, 404, { error: '接口不存在' });
  } catch (e) {
    const msg = e && e.message ? e.message : '服务器内部错误';
    const status = e.status || (e.code === 'CUSTOM_MODULE_DATA_INVALID' ? 500 : e.code === 'RICH_CONTENT_REQUIRES_BLOCKS' ? 409 : /JSON|参数|为空|格式|不存在|不一致|过大|宽度/.test(msg) ? 400 : 500);
    return sendJSON(res, status, { error: msg, ...(e.code ? { code: e.code, commitState: 'not_committed' } : {}) });
  }
}

// ---------------------------------------------------------------- 服务器

const server = http.createServer((req, res) => {
  const { pathname } = new URL(req.url, `http://${req.headers.host || HOST}`);
  if (pathname.startsWith('/api/')) {
    handleApi(req, res, pathname).catch((e) => {
      sendJSON(res, 500, { error: (e && e.message) || '服务器内部错误', commitState: 'unknown' });
    });
    return;
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('Method Not Allowed');
  }
  serveStatic(res, pathname);
});

function startServer(options = {}) {
  drawingManager.recover();
  const host = options.host || HOST;
  const port = options.port === undefined ? PORT : options.port;
  const shouldOpen = options.openBrowser === undefined ? !NO_OPEN : options.openBrowser;

  return new Promise((resolve, reject) => {
    const onError = (error) => {
      server.off('listening', onListening);
      reject(error);
    };
    const onListening = () => {
      server.off('error', onError);
      const address = server.address();
      const actualPort = address && typeof address === 'object' ? address.port : port;
      const url = `http://${host}:${actualPort}`;
      console.log('');
      console.log('  ┌──────────────────────────────────────────────┐');
      console.log('  │   生活管家 · 本地助手                          │');
      console.log(`  │   已启动：${url}`);
      console.log(`  │   数据文件：${DATA_FILE}`);
      console.log('  │   按 Ctrl+C 停止服务                          │');
      console.log('  └──────────────────────────────────────────────┘');
      console.log('');
      if (shouldOpen) openBrowser(url);
      resolve({ server, url });
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, host);
  });
}

if (require.main === module) {
  startServer().catch((error) => {
    console.error('生活管家启动失败：', error);
    process.exitCode = 1;
  });
}

module.exports = { server, startServer };
