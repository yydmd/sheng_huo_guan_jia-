'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const FILE_ID = /^[a-zA-Z0-9_-]{1,128}$/;
const fail = (message, status = 400, code = 'DRAWING_INVALID') => Object.assign(new Error(message), { status, code });

function createDrawingStore({ dataDir, writeJSON, getEpoch, detectImageType, isDeleted = () => false }) {
  const directory = path.join(dataDir, 'drawings');
  const drawingPath = (id) => {
    if (!UUID.test(id || '')) throw fail('图稿地址无效');
    return path.join(directory, id);
  };
  const load = (id) => {
    if (isDeleted(id)) throw fail('画布已删除', 410, 'DRAWING_DELETED');
    const file = path.join(drawingPath(id), 'scene.json');
    if (!fs.existsSync(file)) throw fail('图稿无法读取，请检查本机图稿文件', 404, 'DRAWING_MISSING');
    try {
      const value = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (value.schemaVersion !== 1 || value.id !== id || !Array.isArray(value.elements)) throw Error();
      return value;
    } catch { throw fail('图稿文件损坏，原文件已保留', 422, 'DRAWING_CORRUPT'); }
  };
  const summary = (d) => ({ id: d.id, title: d.title, revision: d.revision, createdAt: d.createdAt, updatedAt: d.updatedAt });
  const list = () => fs.existsSync(directory) ? fs.readdirSync(directory).filter((id) => UUID.test(id)).flatMap((id) => {
    try { return [summary(load(id))]; } catch { return []; }
  }) : [];
  function checkEpoch(req) {
    const epoch = req.headers['x-life-data-epoch'];
    if (!epoch) throw fail('缺少数据代次，请重新载入', 400, 'DATA_EPOCH_REQUIRED');
    if (epoch !== getEpoch()) throw fail('数据已恢复或服务已重启，请重新载入', 409, 'DATA_EPOCH_CHANGED');
  }
  function checkRevision(body, current) {
    if (!Number.isInteger(body.baseRevision) || body.baseRevision !== current.revision) {
      throw fail('图稿已在其他窗口修改，请导出当前内容或重新加载', 409, 'DRAWING_REVISION_CONFLICT');
    }
  }
  const readBytes = (req, limit) => new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    req.on('data', (chunk) => { size += chunk.length; if (size <= limit) chunks.push(chunk); });
    req.on('end', () => size > limit ? reject(fail('文件过大，请导出后缩小内容再重试', 413)) : resolve(Buffer.concat(chunks)));
    req.on('error', reject); req.on('aborted', () => reject(fail('上传已中断')));
  });
  const readJSON = async (req) => {
    const bytes = await readBytes(req, 32 * 1024 * 1024);
    try {
      const body = JSON.parse(bytes.toString('utf8') || '{}');
      if (!body || typeof body !== 'object' || Array.isArray(body)) throw Error();
      return body;
    } catch { throw fail('图稿数据格式错误'); }
  };
  function title(raw) {
    if (typeof raw !== 'string' || !raw.trim() || [...raw.trim()].length > 100 || /[\u0000-\u001f]/.test(raw)) throw fail('图稿名称需为 1–100 个字符');
    return raw.trim();
  }
  function validateScene(body, current) {
    if (body.elements !== undefined) {
      if (!Array.isArray(body.elements) || body.elements.some((el) => !el || typeof el.id !== 'string' || typeof el.type !== 'string' || !Number.isFinite(el.x) || !Number.isFinite(el.y))) throw fail('图稿元素格式错误');
      const available = fileManifest(current.id);
      if (body.elements.some((el) => !el.isDeleted && el.type === 'image' && el.fileId && !available[el.fileId])) throw fail('请先保存图稿中的图片再重试');
    }
    if (body.appState !== undefined && (!body.appState || typeof body.appState !== 'object' || Array.isArray(body.appState))) throw fail('画布状态格式错误');
  }
  function fileManifest(id) {
    const filesDir = path.join(drawingPath(id), 'files');
    const out = {};
    if (fs.existsSync(filesDir)) for (const name of fs.readdirSync(filesDir).filter((n) => n.endsWith('.json'))) {
      const meta = JSON.parse(fs.readFileSync(path.join(filesDir, name), 'utf8'));
      out[meta.id] = { ...meta, url: `/api/drawings/${id}/files/${meta.id}` };
    }
    return out;
  }
  async function handle(req, res, seg, sendJSON) {
    if (seg[0] !== 'api' || seg[1] !== 'drawings') return false;
    const done = (status, body) => { sendJSON(res, status, body); return true; };
    try {
      const method = req.method;
      if (method !== 'GET' && method !== 'HEAD') checkEpoch(req);
      if (seg.length === 2 && method === 'GET') return done(200, { drawings: list(), dataEpoch: getEpoch() });
      if (seg.length === 2 && method === 'POST') {
        const body = await readJSON(req); checkEpoch(req);
        const id = body.requestId;
        drawingPath(id);
        if (isDeleted(id)) throw fail('画布已删除，不能重新创建', 410, 'DRAWING_DELETED');
        if (fs.existsSync(path.join(drawingPath(id), 'scene.json'))) return done(200, { drawing: summary(load(id)), replayed: true });
        const now = new Date().toISOString();
        const drawing = { schemaVersion: 1, id, title: title(body.title || '未命名图稿'), revision: 0, createdAt: now, updatedAt: now, elements: [], appState: {} };
        fs.mkdirSync(drawingPath(id), { recursive: true });
        writeJSON(path.join(drawingPath(id), 'scene.json'), drawing);
        return done(201, { drawing: summary(drawing) });
      }
      if (seg.length === 3 && seg[2] === 'library') {
        const file = path.join(directory, '_library.json');
        let library = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : { schemaVersion: 1, revision: 0, items: [] };
        if (method === 'GET') return done(200, { library });
        if (method === 'PATCH') {
          const body = await readJSON(req); checkEpoch(req);
          if (fs.existsSync(file)) library = JSON.parse(fs.readFileSync(file, 'utf8'));
          checkRevision(body, library);
          if (!Array.isArray(body.items)) throw fail('素材库格式错误');
          library.items = body.items; library.revision += 1;
          fs.mkdirSync(directory, { recursive: true }); writeJSON(file, library);
          return done(200, { library });
        }
      }
      const id = seg[2]; const drawing = load(id);
      if (seg.length === 3 && method === 'GET') return done(200, { drawing: { ...drawing, files: fileManifest(id) }, dataEpoch: getEpoch() });
      if (seg.length === 3 && method === 'PATCH') {
        const body = await readJSON(req); checkEpoch(req);
        // Re-read after awaiting the request body: concurrent saves must compare the latest revision.
        const current = load(id); checkRevision(body, current); validateScene(body, current);
        if (body.title !== undefined) current.title = title(body.title);
        if (body.elements !== undefined) current.elements = body.elements;
        if (body.appState !== undefined) current.appState = body.appState;
        current.revision += 1; current.updatedAt = new Date().toISOString();
        writeJSON(path.join(drawingPath(id), 'scene.json'), current);
        return done(200, { drawing: summary(current) });
      }
      if (seg[3] === 'files') {
        const fileId = method === 'POST' ? req.headers['x-drawing-file-id'] : seg[4];
        if (!FILE_ID.test(fileId || '')) throw fail('图片标识无效');
        const filesDir = path.join(drawingPath(id), 'files');
        const rawPath = path.join(filesDir, `${fileId}.bin`); const metaPath = path.join(filesDir, `${fileId}.json`);
        if (method === 'POST' && seg.length === 4) {
          const bytes = await readBytes(req, 10 * 1024 * 1024); checkEpoch(req); load(id);
          const detected = detectImageType(bytes);
          const mime = detected?.mime || (/^\s*(?:<\?xml[^>]*>\s*)?<svg[\s>]/i.test(bytes.toString('utf8')) ? 'image/svg+xml' : null);
          if (!mime || mime !== req.headers['content-type']?.split(';')[0]) throw fail('图片格式无法读取');
          const hash = crypto.createHash('sha256').update(bytes).digest('hex');
          if (fs.existsSync(metaPath)) {
            const current = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
            if (current.hash !== hash) throw fail('图片标识已用于另一张图片', 409);
            return done(200, { file: current });
          }
          fs.mkdirSync(filesDir, { recursive: true });
          const temporary = `${rawPath}.tmp`; fs.writeFileSync(temporary, bytes); fs.renameSync(temporary, rawPath);
          const meta = { id: fileId, mimeType: mime, created: Date.now(), hash, size: bytes.length };
          writeJSON(metaPath, meta); return done(201, { file: meta });
        }
        if ((method === 'GET' || method === 'HEAD') && seg.length === 5) {
          if (!fs.existsSync(rawPath) || !fs.existsSync(metaPath)) throw fail('图稿图片文件缺失', 404);
          const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8')); const bytes = fs.readFileSync(rawPath);
          res.writeHead(200, { 'Content-Type': meta.mimeType, 'Content-Length': bytes.length, 'Cache-Control': 'private, max-age=86400', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'; sandbox" });
          res.end(method === 'HEAD' ? undefined : bytes); return true;
        }
      }
      return done(404, { error: '图稿操作不存在' });
    } catch (error) { return done(error.status || 500, { error: error.message, code: error.code, commitState: 'not_committed' }); }
  }
  return { directory, handle, list, load, checkEpoch, readJSON, readBytes, UUID };
}

module.exports = { createDrawingStore, UUID };
