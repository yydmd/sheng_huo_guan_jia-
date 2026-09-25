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
const BACKUP_DIR = path.join(DATA_DIR, 'backups');
const REVIEW_IMAGE_ID = /^[a-f0-9-]{36}\.(png|jpg|webp|gif)$/;
const BACKUP_ID = /^backup-[0-9]{8}-[0-9]{6}-[a-f0-9-]{36}$/;
const REVIEW_IMAGE_LIMIT = 10 * 1024 * 1024;
const THOUGHT_KINDS = ['free', 'review', 'extraction'];

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
    sections: [],           // 原则（行）
    records: {},            // 打卡记录（按日期）
    checkinReasons: {},     // 未完成原因：{ 'YYYY-MM-DD': { nodeId: '原因' } }
    thoughtEntries: [],     // 所思文章：[{ id, kind: 'free'|'review'|'extraction', date, title, text, categoryId, createdAt, updatedAt }]
    thoughtCategories: [],  // 文章类别：[{ id, kind: 'free'|'review'|'extraction', name, createdAt }]
    reflectFrameworks: [],  // 所思-反思框架（省）：[{ id, name }]
    reflectEntries: {},     // 所思-反思内容：{ 'YYYY-MM-DD': { frameworkId: 'text' } }
    plans: [],              // 计划：[{ id, name, description, note }]
    templates: [],          // 个人模板：[{ id, name, content, note }]
    problems: [],           // 问题拆解：[{ id, name, content, note }]
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
  return { id, createdAt: manifest.createdAt || fs.statSync(directory).birthtime.toISOString(), label: manifest.label || 'manual', imageCount };
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
  const safetyBackup = createBackup('before-restore');
  const imageTemporary = `${REVIEW_IMAGE_DIR}.restore-tmp`;
  const imagePrevious = `${REVIEW_IMAGE_DIR}.restore-previous`;
  try {
    fs.rmSync(imageTemporary, { recursive: true, force: true });
    copyDirectory(path.join(source, 'review-images'), imageTemporary);
    fs.rmSync(imagePrevious, { recursive: true, force: true });
    if (fs.existsSync(REVIEW_IMAGE_DIR)) fs.renameSync(REVIEW_IMAGE_DIR, imagePrevious);
    if (fs.existsSync(imageTemporary)) fs.renameSync(imageTemporary, REVIEW_IMAGE_DIR);
    writeJSON(DATA_FILE, restored);
    fs.rmSync(imagePrevious, { recursive: true, force: true });
  } catch (error) {
    try {
      fs.rmSync(imageTemporary, { recursive: true, force: true });
      if (!fs.existsSync(REVIEW_IMAGE_DIR) && fs.existsSync(imagePrevious)) fs.renameSync(imagePrevious, REVIEW_IMAGE_DIR);
    } catch (_) { /* preserve original error */ }
    throw error;
  }
  return { restored: summary, safetyBackup };
}

function readData() {
  ensureDataFile();
  const raw = fs.readFileSync(DATA_FILE, 'utf8');
  try {
    const data = JSON.parse(raw);
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
  } catch (e) {
    // 文件损坏时备份后重建，避免启动失败
    const bak = `${DATA_FILE}.bak-${Date.now()}`;
    try { fs.copyFileSync(DATA_FILE, bak); } catch (_) { /* ignore */ }
    const fresh = freshData();
    writeJSON(DATA_FILE, fresh);
    return fresh;
  }
}

function saveData(data) {
  ensureDataFile();
  writeJSON(DATA_FILE, data);
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

function normalizeReviewBlocks(blocks) {
  if (!Array.isArray(blocks) || blocks.length > 120) throw new Error('复盘图文格式错误或内容块过多');
  let images = 0;
  const ids = new Set();
  return blocks.map((block) => {
    if (!block || !/^[a-zA-Z0-9-]{1,80}$/.test(block.id || '') || ids.has(block.id)) throw new Error('复盘内容块标识格式错误');
    ids.add(block.id);
    if (block.type === 'text' && typeof block.text === 'string') return { id: block.id, type: 'text', text: block.text };
    if (block.type !== 'image' || typeof block.imageId !== 'string' || !REVIEW_IMAGE_ID.test(block.imageId)) throw new Error('复盘图片格式错误');
    if (++images > 20) throw new Error('图片数量过大，每篇复盘最多插入 20 张图片');
    // 文件名严格限制在上传目录内；不接受外链、HTML、SVG 或任意本地路径。
    if (!fs.existsSync(path.join(REVIEW_IMAGE_DIR, block.imageId))) throw new Error('复盘图片文件不存在，请重新插入');
    if (typeof block.caption !== 'string' || block.caption.length > 500) throw new Error('图片说明格式错误或超过 500 字');
    return { id: block.id, type: 'image', imageId: block.imageId, caption: block.caption };
  });
}

function reviewText(blocks) {
  return blocks.filter((block) => block.type === 'text').map((block) => block.text).join('');
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
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
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

async function handleApi(req, res, pathname) {
  const method = req.method;
  const seg = pathname.split('/').filter(Boolean); // 例：['api','sections','abc','items','xyz']

  try {
    // GET /api/state —— 返回全部数据
    if (method === 'GET' && seg.length === 2 && seg[1] === 'state') {
      const data = readData();
      return sendJSON(res, 200, {
        version: data.version,
        appVersion: APP_VERSION,
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
        events: data.events,
        eventCheckins: data.eventCheckins,
        eventExceptions: data.eventExceptions,
      });
    }

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
      const data = readData();
      const section = findSection(data, seg[2]);
      if (!section) return sendJSON(res, 404, { error: '板块不存在' });
      const { name } = await readBody(req);
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
      for (const it of section.items || []) removeItemAndChildrenFromRecords(data, it);
      data.sections = data.sections.filter((s) => s.id !== seg[2]);
      saveData(data);
      return sendJSON(res, 200, { ok: true });
    }

    // ---------- 条目 ----------
    // POST /api/sections/:id/items —— 新建条目 { name }
    if (method === 'POST' && seg.length === 4 && seg[1] === 'sections' && seg[3] === 'items') {
      const data = readData();
      const section = findSection(data, seg[2]);
      if (!section) return sendJSON(res, 404, { error: '板块不存在' });
      const { name } = await readBody(req);
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
      const data = readData();
      const section = findSection(data, seg[2]);
      if (!section) return sendJSON(res, 404, { error: '板块不存在' });
      const { orderedIds } = await readBody(req);
      if (!Array.isArray(orderedIds)) return sendJSON(res, 400, { error: '参数错误' });
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
      const data = readData();
      const section = findSection(data, seg[2]);
      const item = findItem(section, seg[4]);
      if (!item) return sendJSON(res, 404, { error: '条目不存在' });
      const { name } = await readBody(req);
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
      section.items = (section.items || []).filter((it) => it.id !== seg[4]);
      removeItemAndChildrenFromRecords(data, item);
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
      const item = findItem(findSection(data, seg[2]), seg[4]);
      const child = findChild(item, seg[6]);
      if (!child) return sendJSON(res, 404, { error: '子节点不存在' });
      item.children = item.children.filter((entry) => entry.id !== child.id);
      removeItemFromRecords(data, child.id);
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

    // 图片以原始文件保存在本地；上传与文章保存分开，避免将二进制塞进 JSON。
    if (method === 'POST' && seg.length === 2 && seg[1] === 'review-images') {
      const bytes = await readImageBody(req);
      const type = detectImageType(bytes);
      if (!type || req.headers['content-type']?.split(';')[0] !== type.mime) {
        return sendJSON(res, 400, { error: '图片格式不支持，请选择 PNG、JPG、WebP 或 GIF 图片' });
      }
      const imageId = `${newId()}.${type.ext}`;
      fs.mkdirSync(REVIEW_IMAGE_DIR, { recursive: true });
      fs.writeFileSync(path.join(REVIEW_IMAGE_DIR, imageId), bytes, { flag: 'wx' });
      return sendJSON(res, 201, { image: { id: imageId, url: `/api/review-images/${imageId}`, size: bytes.length } });
    }
    if ((method === 'GET' || method === 'HEAD') && seg.length === 3 && seg[1] === 'review-images') {
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
      if (body.blocks !== undefined && kind !== 'review') return sendJSON(res, 400, { error: '仅每日复盘支持图文内容' });
      const blocks = body.blocks === undefined ? undefined : normalizeReviewBlocks(body.blocks);
      const text = blocks ? reviewText(blocks) : String(body.text ?? '');
      if (!title.trim() && !text.trim() && !blocks?.some((block) => block.type === 'image')) return sendJSON(res, 400, { error: '标题、正文和图片不能同时为空' });
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
      const data = readData();
      const thought = findThought(data, seg[2]);
      if (!thought) return sendJSON(res, 404, { error: '文章不存在' });
      const body = await readBody(req);
      if (Object.prototype.hasOwnProperty.call(body, 'kind') && body.kind !== thought.kind) {
        return sendJSON(res, 400, { error: '不能更改已有文章的类型' });
      }
      if (body.blocks !== undefined) {
        if (thought.kind !== 'review') return sendJSON(res, 400, { error: '仅每日复盘支持图文内容' });
        thought.blocks = normalizeReviewBlocks(body.blocks);
        thought.text = reviewText(thought.blocks);
      } else if (Object.prototype.hasOwnProperty.call(body, 'text') && thought.blocks) {
        if (thought.blocks.some((block) => block.type === 'image')) return sendJSON(res, 409, { error: '请刷新页面后使用图文编辑器，避免覆盖已有图片' });
        delete thought.blocks; // 兼容旧版的纯文字复盘编辑。
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
      if (!findThought(data, seg[2])) return sendJSON(res, 404, { error: '文章不存在' });
      data.thoughtEntries = data.thoughtEntries.filter((entry) => entry.id !== seg[2]);
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
      const data = readData();
      const category = findThoughtCategory(data, seg[2]);
      if (!category) return sendJSON(res, 404, { error: '类别不存在' });
      const { name } = await readBody(req);
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
      if (!findThoughtCategory(data, seg[2])) return sendJSON(res, 404, { error: '类别不存在' });
      data.thoughtCategories = data.thoughtCategories.filter((entry) => entry.id !== seg[2]);
      for (const thought of data.thoughtEntries) {
        if (thought.categoryId === seg[2]) thought.categoryId = null;
      }
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
      const data = readData();
      const framework = data.reflectFrameworks.find((f) => f.id === seg[3]);
      if (!framework) return sendJSON(res, 404, { error: '框架不存在' });
      const { name } = await readBody(req);
      const clean = String(name || '').trim();
      if (!clean) return sendJSON(res, 400, { error: '框架名称不能为空' });
      framework.name = clean;
      saveData(data);
      return sendJSON(res, 200, { framework });
    }

    // DELETE /api/reflect/frameworks/:id —— 删除框架（同步清理各日期内容）
    if (method === 'DELETE' && seg.length === 4 && seg[1] === 'reflect' && seg[2] === 'frameworks') {
      const data = readData();
      data.reflectFrameworks = data.reflectFrameworks.filter((f) => f.id !== seg[3]);
      for (const date of Object.keys(data.reflectEntries)) {
        const entry = data.reflectEntries[date];
        if (entry && typeof entry === 'object') delete entry[seg[3]];
      }
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

    // ---------- 计划 ----------
    // POST /api/plans —— 新建计划 { name }
    if (method === 'POST' && seg.length === 2 && seg[1] === 'plans') {
      const { name } = await readBody(req);
      const clean = String(name || '').trim();
      if (!clean) return sendJSON(res, 400, { error: '计划名称不能为空' });
      const data = readData();
      const plan = { id: newId(), name: clean, description: '', note: '' };
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

    // PATCH /api/plans/:id —— 更新名称/描述 { name?, description? }
    if (method === 'PATCH' && seg.length === 3 && seg[1] === 'plans') {
      const data = readData();
      const plan = data.plans.find((p) => p.id === seg[2]);
      if (!plan) return sendJSON(res, 404, { error: '计划不存在' });
      const body = await readBody(req);
      if (body.name !== undefined) {
        const clean = String(body.name).trim();
        if (!clean) return sendJSON(res, 400, { error: '计划名称不能为空' });
        plan.name = clean;
      }
      if (body.description !== undefined) plan.description = String(body.description);
      saveData(data);
      return sendJSON(res, 200, { plan });
    }

    // POST /api/plans/:id/note —— 保存笔记 { note }
    if (method === 'POST' && seg.length === 4 && seg[1] === 'plans' && seg[3] === 'note') {
      const data = readData();
      const plan = data.plans.find((p) => p.id === seg[2]);
      if (!plan) return sendJSON(res, 404, { error: '计划不存在' });
      const { note } = await readBody(req);
      plan.note = String(note ?? '');
      saveData(data);
      return sendJSON(res, 200, { saved: true });
    }

    // DELETE /api/plans/:id —— 删除计划
    if (method === 'DELETE' && seg.length === 3 && seg[1] === 'plans') {
      const data = readData();
      data.plans = data.plans.filter((p) => p.id !== seg[2]);
      saveData(data);
      return sendJSON(res, 200, { ok: true });
    }

    // ---------- 个人模板 ----------
    // POST /api/templates —— 新建模板 { name }
    if (method === 'POST' && seg.length === 2 && seg[1] === 'templates') {
      const { name } = await readBody(req);
      const clean = String(name || '').trim();
      if (!clean) return sendJSON(res, 400, { error: '模板名称不能为空' });
      const data = readData();
      const template = { id: newId(), name: clean, content: '', note: '' };
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

    // PATCH /api/templates/:id —— 更新名称/内容 { name?, content? }
    if (method === 'PATCH' && seg.length === 3 && seg[1] === 'templates') {
      const data = readData();
      const template = data.templates.find((t) => t.id === seg[2]);
      if (!template) return sendJSON(res, 404, { error: '模板不存在' });
      const body = await readBody(req);
      if (body.name !== undefined) {
        const clean = String(body.name).trim();
        if (!clean) return sendJSON(res, 400, { error: '模板名称不能为空' });
        template.name = clean;
      }
      if (body.content !== undefined) template.content = String(body.content);
      saveData(data);
      return sendJSON(res, 200, { template });
    }

    // POST /api/templates/:id/note —— 保存备注 { note }
    if (method === 'POST' && seg.length === 4 && seg[1] === 'templates' && seg[3] === 'note') {
      const data = readData();
      const template = data.templates.find((t) => t.id === seg[2]);
      if (!template) return sendJSON(res, 404, { error: '模板不存在' });
      const { note } = await readBody(req);
      template.note = String(note ?? '');
      saveData(data);
      return sendJSON(res, 200, { saved: true });
    }

    // DELETE /api/templates/:id —— 删除模板
    if (method === 'DELETE' && seg.length === 3 && seg[1] === 'templates') {
      const data = readData();
      data.templates = data.templates.filter((t) => t.id !== seg[2]);
      saveData(data);
      return sendJSON(res, 200, { ok: true });
    }

    // ---------- 问题拆解 ----------
    // POST /api/problems —— 新建问题 { name }
    if (method === 'POST' && seg.length === 2 && seg[1] === 'problems') {
      const { name } = await readBody(req);
      const clean = String(name || '').trim();
      if (!clean) return sendJSON(res, 400, { error: '问题标题不能为空' });
      const data = readData();
      const problem = { id: newId(), name: clean, content: '', note: '' };
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

    // PATCH /api/problems/:id —— 单请求保存全部字段 { name?, content?, note? }
    if (method === 'PATCH' && seg.length === 3 && seg[1] === 'problems') {
      const data = readData();
      const problem = data.problems.find((p) => p.id === seg[2]);
      if (!problem) return sendJSON(res, 404, { error: '问题不存在' });
      const body = await readBody(req);
      if (body.name !== undefined) {
        const clean = String(body.name).trim();
        if (!clean) return sendJSON(res, 400, { error: '问题标题不能为空' });
        problem.name = clean;
      }
      if (body.content !== undefined) problem.content = String(body.content);
      if (body.note !== undefined) problem.note = String(body.note);
      saveData(data);
      return sendJSON(res, 200, { problem });
    }

    // DELETE /api/problems/:id —— 删除问题
    if (method === 'DELETE' && seg.length === 3 && seg[1] === 'problems') {
      const data = readData();
      data.problems = data.problems.filter((p) => p.id !== seg[2]);
      saveData(data);
      return sendJSON(res, 200, { ok: true });
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
    const status = /JSON|参数|为空|格式|不存在|不一致|过大/.test(msg) ? 400 : 500;
    return sendJSON(res, status, { error: msg });
  }
}

// ---------------------------------------------------------------- 服务器

const server = http.createServer((req, res) => {
  const { pathname } = new URL(req.url, `http://${req.headers.host || HOST}`);
  if (pathname.startsWith('/api/')) {
    handleApi(req, res, pathname).catch((e) => {
      sendJSON(res, 500, { error: (e && e.message) || '服务器内部错误' });
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
