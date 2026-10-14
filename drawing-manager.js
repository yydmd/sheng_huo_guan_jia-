'use strict';

const fs = require('fs');
const path = require('path');

// Visit only the rich fields understood by the application, including custom libraries.
function drawingOwners(data) {
  const definitions = [
    ['thoughtEntries', 'thoughts', '所思', ['blocks']],
    ['plans', 'plans', '计划', ['descriptionBlocks', 'noteBlocks']],
    ['templates', 'templates', '个人模板', ['contentBlocks', 'noteBlocks']],
    ['problems', 'problems', '问题拆解', ['contentBlocks', 'noteBlocks']],
    ['learningTemplates', 'learning', '学习专区', ['contentBlocks', 'noteBlocks']],
    ['coreThoughtTemplates', 'coreThoughts', '核心思想', ['contentBlocks', 'noteBlocks']],
    ['reviewTemplates', 'reviewTemplates', '复盘', ['contentBlocks', 'noteBlocks']],
  ];
  const owners = definitions.flatMap(([key, moduleId, moduleName, fields]) =>
    (data[key] || []).map(item => ({ item, moduleId, moduleName, fields })));
  for (const mod of data.customModules || []) for (const item of mod.templates || []) {
    owners.push({ item, moduleId: mod.id, moduleName: mod.name, fields: ['contentBlocks', 'noteBlocks'] });
  }
  return owners;
}

function stripDrawingReferences(data, deleted) {
  for (const { item, fields } of drawingOwners(data)) for (const field of fields) {
    if (Array.isArray(item[field])) item[field] = item[field].filter(b => b.type !== 'drawing' || !deleted.has(b.drawingId));
  }
}

function createDrawingManager({ dataDir, store, writeJSON, readData, saveData, getEpoch, trash }) {
  const metaPath = path.join(store.directory, '_manager.json');
  const journalPath = path.join(dataDir, '.drawing-delete.json');
  const invalid = (message, status = 400) => Object.assign(new Error(message), { status });
  function metadata() {
    if (!fs.existsSync(metaPath)) return { schemaVersion: 1, revision: 0, favorites: [], visits: {}, pinnedIds: [], deletedIds: [] };
    const data = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
    if (data.schemaVersion !== 1 || !Array.isArray(data.deletedIds) || !Array.isArray(data.pinnedIds) || !Array.isArray(data.favorites) || !data.visits || !Number.isInteger(data.revision)) throw invalid('画布管理数据无法读取，原文件已保留', 422);
    return data;
  }
  function persist(meta) { fs.mkdirSync(store.directory, { recursive: true }); writeJSON(metaPath, meta); }
  function isDeleted(id) { return metadata().deletedIds.includes(id); }
  function sanitize(data) { stripDrawingReferences(data, new Set(metadata().deletedIds)); }
  function validId(id) { if (!store.UUID.test(id || '')) throw invalid('画布标识无效'); return id; }
  function recover() {
    if (!fs.existsSync(journalPath)) return;
    const { ids } = JSON.parse(fs.readFileSync(journalPath, 'utf8'));
    if (!Array.isArray(ids) || !ids.length) throw invalid('画布删除事务无法读取', 500);
    ids.forEach(validId);
    const meta = metadata(); const deleted = new Set([...meta.deletedIds, ...ids]);
    meta.deletedIds = [...deleted]; meta.pinnedIds = meta.pinnedIds.filter(id => !deleted.has(id));
    meta.favorites = meta.favorites.filter(id => !deleted.has(id));
    for (const id of ids) delete meta.visits[id];
    meta.revision++;
    persist(meta);
    const data = readData(); stripDrawingReferences(data, deleted); saveData(data);
    for (const id of ids) {
      trash.relocateDrawing(id);
      trash.noteDrawing(id);
    }
    fs.unlinkSync(journalPath);
  }
  function unmarkDeleted(id) {
    const safe = validId(id);
    const meta = metadata();
    if (!meta.deletedIds.includes(safe)) return;
    meta.deletedIds = meta.deletedIds.filter((entry) => entry !== safe);
    meta.revision++;
    persist(meta);
  }
  function snapshot() {
    const meta = metadata(); const sources = new Map();
    for (const { item, moduleId, moduleName, fields } of drawingOwners(readData())) for (const field of fields) {
      for (const block of item[field] || []) if (block.type === 'drawing') {
        if (!sources.has(block.drawingId)) sources.set(block.drawingId, []);
        const entries = sources.get(block.drawingId);
        if (!entries.some(s => s.moduleId === moduleId && s.itemId === item.id && s.field === field)) entries.push({ moduleId, moduleName, itemId: item.id, title: item.name || item.title || '未命名文章', field });
      }
    }
    const ids = new Set(fs.existsSync(store.directory) ? fs.readdirSync(store.directory).filter(id => store.UUID.test(id)) : []);
    for (const id of sources.keys()) ids.add(id);
    const drawings = [...ids].filter(id => !meta.deletedIds.includes(id)).map(id => {
      let d; let error = null;
      try { d = store.load(id); } catch (e) { error = e.message; }
      return { id, title: d?.title || '无法读取的画布', revision: d?.revision ?? null, createdAt: d?.createdAt || null, updatedAt: d?.updatedAt || null,
        searchText: (d?.elements || []).filter(e => !e.isDeleted && e.type === 'text').map(e => e.text || e.originalText || '').join(' '),
        sources: sources.get(id) || [], favorite: meta.favorites.includes(id), lastOpenedAt: meta.visits[id] || null, error };
    });
    return { drawings, manager: { revision: meta.revision, pinnedIds: meta.pinnedIds.filter(id => ids.has(id) && !meta.deletedIds.includes(id)), favorites: meta.favorites, visits: meta.visits }, dataEpoch: getEpoch() };
  }
  async function handle(req, res, seg, sendJSON) {
    if (seg[0] !== 'api' || seg[1] !== 'drawings') return false;
    const managerRoute = seg.length === 3 && seg[2] === 'manager';
    const deleteRoute = seg.length === 3 && seg[2] === 'delete' && req.method === 'POST';
    const thumbRoute = seg.length === 4 && seg[3] === 'thumbnail';
    if (!managerRoute && !deleteRoute && !thumbRoute) return false;
    const done = (status, body) => { sendJSON(res, status, body); return true; };
    try {
      if (!['GET', 'HEAD'].includes(req.method)) store.checkEpoch(req);
      if (managerRoute && req.method === 'GET') return done(200, snapshot());
      if (managerRoute && req.method === 'PATCH') {
        const body = await store.readJSON(req); store.checkEpoch(req);
        const meta = metadata();
        if (body.baseRevision !== meta.revision) throw invalid('画布管理记录已更新，请重试', 409);
        if (body.favorite) {
          const id = validId(body.favorite.id); store.load(id);
          if (typeof body.favorite.value !== 'boolean') throw invalid('收藏状态无效');
          meta.favorites = meta.favorites.filter(x => x !== id); if (body.favorite.value) meta.favorites.push(id);
        }
        if (body.visit) { const id = validId(body.visit); store.load(id); meta.visits[id] = new Date().toISOString(); }
        if (body.pinnedIds !== undefined) {
          if (!Array.isArray(body.pinnedIds) || body.pinnedIds.length > 200) throw invalid('悬挂标签列表无效');
          const next = [...new Set(body.pinnedIds.map(validId))];
          for (const id of next) {
            if (meta.deletedIds.includes(id)) throw invalid('画布已删除', 410);
            if (!meta.pinnedIds.includes(id)) store.load(id);
          }
          meta.pinnedIds = next;
        }
        meta.revision++; persist(meta); return done(200, snapshot());
      }
      if (deleteRoute) {
        const body = await store.readJSON(req); store.checkEpoch(req);
        if (!Array.isArray(body.ids) || !body.ids.length || body.ids.length > 1000) throw invalid('请选择要删除的画布');
        const ids = [...new Set(body.ids.map(validId))];
        writeJSON(journalPath, { ids }); recover();
        return done(200, { deletedIds: ids, ...snapshot() });
      }
      if (thumbRoute) {
        const id = validId(seg[2]); const drawing = store.load(id);
        const file = path.join(store.directory, id, `thumbnail-${drawing.revision}.png`);
        if (req.method === 'GET' || req.method === 'HEAD') {
          if (!fs.existsSync(file)) return done(404, { error: '暂无预览' });
          const bytes = fs.readFileSync(file); res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': bytes.length, 'Cache-Control': 'no-cache' }); res.end(req.method === 'HEAD' ? undefined : bytes); return true;
        }
        if (req.method === 'PUT') {
          const bytes = await store.readBytes(req, 2 * 1024 * 1024); store.checkEpoch(req);
          const current = store.load(id);
          if (Number(req.headers['x-drawing-revision']) !== current.revision) throw invalid('预览已过期', 409);
          if (bytes.length < 8 || bytes.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') throw invalid('预览格式无效');
          const target = path.join(store.directory, id, `thumbnail-${current.revision}.png`);
          fs.writeFileSync(`${target}.tmp`, bytes); fs.renameSync(`${target}.tmp`, target);
          for (const name of fs.readdirSync(path.dirname(target))) if (/^thumbnail-\d+\.png$/.test(name) && name !== path.basename(target)) fs.unlinkSync(path.join(path.dirname(target), name));
          return done(200, { revision: current.revision });
        }
      }
      return done(405, { error: '不支持此操作' });
    } catch (e) { return done(e.status || 500, { error: e.message, code: e.code, commitState: fs.existsSync(journalPath) ? 'unknown' : 'not_committed' }); }
  }
  return { handle, recover, sanitize, isDeleted, unmarkDeleted };
}

module.exports = { createDrawingManager, drawingOwners, stripDrawingReferences };
