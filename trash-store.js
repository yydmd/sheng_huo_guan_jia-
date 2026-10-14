'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function createTrashStore({ dataDir, writeJSON, imageDir, drawingDir, imageIdTest, drawingIdTest }) {
  const root = path.join(dataDir, 'trash');
  const indexPath = path.join(root, 'index.json');
  const itemsDir = path.join(root, 'items');
  const imageTrashDir = path.join(root, 'files', 'images');
  const drawingTrashDir = path.join(root, 'files', 'drawings');
  const fail = (message, status = 400) => Object.assign(new Error(message), { status });

  function ensure() {
    fs.mkdirSync(itemsDir, { recursive: true });
    fs.mkdirSync(imageTrashDir, { recursive: true });
    fs.mkdirSync(drawingTrashDir, { recursive: true });
  }

  function newId() {
    return crypto.randomUUID ? crypto.randomUUID() : crypto.randomBytes(16).toString('hex');
  }

  function assertSafeId(id, test, label) {
    if (typeof id !== 'string' || !test(id) || path.basename(id) !== id) throw fail(`${label}无效`);
    return id;
  }

  function readIndex() {
    ensure();
    if (!fs.existsSync(indexPath)) return [];
    const data = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
    if (!Array.isArray(data)) throw fail('垃圾站索引无法读取', 500);
    return data;
  }

  function writeIndex(entries) {
    ensure();
    writeJSON(indexPath, entries);
  }

  function collectRefs(value, acc = { images: new Set(), drawings: new Set() }, seen = new Set()) {
    if (!value || typeof value !== 'object' || seen.has(value)) return acc;
    seen.add(value);
    if (Array.isArray(value)) {
      for (const entry of value) collectRefs(entry, acc, seen);
      return acc;
    }
    if (value.type === 'image' && typeof value.imageId === 'string' && imageIdTest(value.imageId)) acc.images.add(value.imageId);
    if (value.type === 'drawing' && typeof value.drawingId === 'string' && drawingIdTest(value.drawingId)) acc.drawings.add(value.drawingId);
    for (const nested of Object.values(value)) {
      if (nested && typeof nested === 'object') collectRefs(nested, acc, seen);
    }
    return acc;
  }

  function moveInto(from, to) {
    if (!fs.existsSync(from)) return false;
    fs.mkdirSync(path.dirname(to), { recursive: true });
    if (fs.existsSync(to)) fs.rmSync(to, { recursive: true, force: true });
    fs.renameSync(from, to);
    return true;
  }

  function claimImages(imageIds) {
    const moved = [];
    for (const id of imageIds) {
      if (!imageIdTest(id) || path.basename(id) !== id) continue;
      const from = path.join(imageDir, id);
      const to = path.join(imageTrashDir, id);
      if (moveInto(from, to)) moved.push(id);
    }
    return moved;
  }

  function claimDrawings(drawingIds) {
    const moved = [];
    for (const id of drawingIds) {
      if (!drawingIdTest(id)) continue;
      const from = path.resolve(drawingDir, id);
      const to = path.resolve(drawingTrashDir, id);
      if (path.dirname(from) !== path.resolve(drawingDir) || path.dirname(to) !== path.resolve(drawingTrashDir)) continue;
      if (moveInto(from, to)) moved.push(id);
    }
    return moved;
  }

  function claimUnreferenced(liveData, payload, options = {}) {
    const refs = collectRefs(payload);
    const live = collectRefs(liveData);
    const images = options.images === false ? [] : [...refs.images].filter((id) => !live.images.has(id));
    const drawings = options.drawings ? [...refs.drawings].filter((id) => !live.drawings.has(id)) : [];
    return { images: claimImages(images), drawings: claimDrawings(drawings) };
  }

  // 画布删除沿用「复制后再删除原目录」：原目录删除失败时事务可以重做，且不会把半份内容留在活动目录。
  function relocateDrawing(id) {
    assertSafeId(id, drawingIdTest, '画布');
    const from = path.resolve(drawingDir, id);
    const to = path.resolve(drawingTrashDir, id);
    if (path.dirname(from) !== path.resolve(drawingDir) || path.dirname(to) !== path.resolve(drawingTrashDir)) throw fail('画布目录无效');
    if (!fs.existsSync(from)) return fs.existsSync(to);
    fs.mkdirSync(drawingTrashDir, { recursive: true });
    if (fs.existsSync(to)) fs.rmSync(to, { recursive: true, force: true });
    fs.cpSync(from, to, { recursive: true });
    fs.rmSync(from, { recursive: true, force: true });
    return true;
  }

  function drawingTitle(id) {
    try {
      const scene = JSON.parse(fs.readFileSync(path.join(drawingTrashDir, id, 'scene.json'), 'utf8'));
      return scene.title || '画布';
    } catch (_) {
      return '画布';
    }
  }

  function add({ kind, title, moduleId = '', sourceId = '', body, files }) {
    const id = newId();
    const deletedAt = new Date().toISOString();
    const entry = {
      id,
      kind,
      title: String(title || '未命名').slice(0, 80),
      moduleId: moduleId || '',
      sourceId: sourceId || '',
      deletedAt,
    };
    const payload = {
      schemaVersion: 1,
      ...entry,
      files: {
        images: files?.images || [],
        drawings: files?.drawings || [],
      },
      body,
    };
    ensure();
    writeJSON(path.join(itemsDir, `${id}.json`), payload);
    const index = readIndex();
    index.unshift(entry);
    writeIndex(index);
    return entry;
  }

  function noteDrawing(id) {
    assertSafeId(id, drawingIdTest, '画布');
    const index = readIndex();
    if (index.some((entry) => entry.kind === 'drawing' && entry.sourceId === id)) return index.find((entry) => entry.kind === 'drawing' && entry.sourceId === id);
    return add({
      kind: 'drawing',
      title: drawingTitle(id),
      moduleId: 'drawings',
      sourceId: id,
      body: { drawingId: id },
      files: { images: [], drawings: [id] },
    });
  }

  function assertEntryId(id) {
    if (typeof id !== 'string' || !/^[0-9a-f-]{36}$/i.test(id)) throw fail('垃圾站记录无效');
    return id;
  }

  function readPayload(id) {
    assertEntryId(id);
    const file = path.join(itemsDir, `${id}.json`);
    if (!fs.existsSync(file)) throw fail('垃圾站记录不存在', 404);
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  }

  function restoreFiles(files = {}) {
    fs.mkdirSync(imageDir, { recursive: true });
    fs.mkdirSync(drawingDir, { recursive: true });
    for (const id of files.images || []) {
      if (!imageIdTest(id) || path.basename(id) !== id) continue;
      const from = path.join(imageTrashDir, id);
      const to = path.join(imageDir, id);
      if (!fs.existsSync(from) || fs.existsSync(to)) continue;
      fs.renameSync(from, to);
    }
    for (const id of files.drawings || []) {
      if (!drawingIdTest(id)) continue;
      const from = path.resolve(drawingTrashDir, id);
      const to = path.resolve(drawingDir, id);
      if (path.dirname(from) !== path.resolve(drawingTrashDir) || path.dirname(to) !== path.resolve(drawingDir)) continue;
      if (!fs.existsSync(from) || fs.existsSync(to)) continue;
      fs.renameSync(from, to);
    }
  }

  function ownedFiles(exceptId) {
    const images = new Set();
    const drawings = new Set();
    for (const entry of readIndex()) {
      if (entry.id === exceptId) continue;
      try {
        const payload = readPayload(entry.id);
        for (const id of payload.files?.images || []) images.add(id);
        for (const id of payload.files?.drawings || []) drawings.add(id);
      } catch (_) { /* 单条损坏不阻止清理其他记录 */ }
    }
    return { images, drawings };
  }

  function deleteOwnedFiles(files, keep) {
    for (const id of files?.images || []) {
      if (keep?.images.has(id) || !imageIdTest(id)) continue;
      fs.rmSync(path.join(imageTrashDir, path.basename(id)), { force: true });
    }
    for (const id of files?.drawings || []) {
      if (keep?.drawings.has(id) || !drawingIdTest(id)) continue;
      const target = path.resolve(drawingTrashDir, id);
      if (path.dirname(target) !== path.resolve(drawingTrashDir)) continue;
      fs.rmSync(target, { recursive: true, force: true });
    }
  }

  function discard(id) {
    assertEntryId(id);
    const index = readIndex();
    if (!index.some((entry) => entry.id === id)) throw fail('垃圾站记录不存在', 404);
    fs.rmSync(path.join(itemsDir, `${id}.json`), { force: true });
    writeIndex(index.filter((entry) => entry.id !== id));
  }

  function remove(id) {
    const payload = readPayload(id);
    const keep = ownedFiles(id);
    deleteOwnedFiles(payload.files, keep);
    discard(id);
    return { id, kind: payload.kind, title: payload.title, moduleId: payload.moduleId, deletedAt: payload.deletedAt };
  }

  function empty() {
    const index = readIndex();
    for (const entry of index) {
      try { deleteOwnedFiles(readPayload(entry.id).files, { images: new Set(), drawings: new Set() }); } catch (_) { /* 继续清空其余记录 */ }
      fs.rmSync(path.join(itemsDir, `${entry.id}.json`), { force: true });
    }
    writeIndex([]);
  }

  return {
    root,
    list: readIndex,
    add,
    readPayload,
    claimUnreferenced,
    claimImages,
    relocateDrawing,
    noteDrawing,
    restoreFiles,
    discard,
    remove,
    empty,
    collectRefs,
  };
}

module.exports = { createTrashStore };
