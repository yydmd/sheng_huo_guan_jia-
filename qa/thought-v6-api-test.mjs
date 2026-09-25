/**
 * 自由思考 v6：迁移、文章 CRUD、类别 CRUD、旧接口隔离测试。
 * 测试在临时项目副本中运行，不读写真实 data/data.json。
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'life-steward-thought-v6-'));
const port = 44000 + Math.floor(Math.random() * 1000);
const base = `http://127.0.0.1:${port}`;
let server;

const legacyText = '旧数据标题来自这里\n正文必须原样保留。';
const seed = {
  version: 5,
  sections: [], records: {},
  thinkEntries: { '2026-08-08': legacyText, '2026-08-09': '   ' },
  reflectFrameworks: [], reflectEntries: {}, plans: [], problems: [],
  events: [], eventCheckins: {}, eventExceptions: [],
};

function copyFixture() {
  fs.copyFileSync(path.join(root, 'server.js'), path.join(temp, 'server.js'));
  fs.mkdirSync(path.join(temp, 'public'));
  fs.copyFileSync(path.join(root, 'public', 'index.html'), path.join(temp, 'public', 'index.html'));
  fs.mkdirSync(path.join(temp, 'data'));
  fs.writeFileSync(path.join(temp, 'data', 'data.json'), JSON.stringify(seed, null, 2));
}

async function waitForServer() {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${base}/api/state`);
      if (response.ok) return;
    } catch (_) { /* retry */ }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('等待测试服务启动超时');
}

async function request(method, url, body) {
  const response = await fetch(`${base}${url}`, {
    method,
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(`${response.status}: ${data.error}`);
  return data;
}

try {
  copyFixture();
  server = spawn(process.execPath, ['server.js', '--port', String(port), '--no-open'], { cwd: temp, stdio: 'ignore' });
  await waitForServer();

  let state = await request('GET', '/api/state');
  assert.equal(state.thoughtEntries.length, 1, '空白旧记录不应迁移');
  assert.equal(state.thoughtEntries[0].text, legacyText, '旧正文应原样保留');
  assert.equal(state.thoughtEntries[0].title, '旧数据标题来自这里');
  assert.equal(state.thoughtEntries[0].categoryId, null);
  const migratedId = state.thoughtEntries[0].id;

  const diskAfterMigration = JSON.parse(fs.readFileSync(path.join(temp, 'data', 'data.json'), 'utf8'));
  assert.equal(diskAfterMigration.version, 11);
  assert.equal(state.thoughtEntries[0].kind, 'free');
  assert.equal('thinkEntries' in diskAfterMigration, false);
  assert.equal(fs.readdirSync(path.join(temp, 'data')).some((name) => name.startsWith('data.json.bak-v5-')), true, '迁移前应生成 v5 备份');
  await request('GET', '/api/state');
  state = await request('GET', '/api/state');
  assert.equal(state.thoughtEntries.length, 1, '重复读取不得重复迁移');

  const learning = (await request('POST', '/api/thought-categories', { name: '学习' })).category;
  await assert.rejects(() => request('POST', '/api/thought-categories', { name: ' 学习 ' }), /409/);
  const renamed = (await request('PATCH', `/api/thought-categories/${learning.id}`, { name: '成长' })).category;
  assert.equal(renamed.name, '成长');

  const first = (await request('POST', '/api/thoughts', {
    date: '2026-08-08', title: '', text: '第一篇的首行\n内容', categoryId: learning.id,
  })).thought;
  const second = (await request('POST', '/api/thoughts', {
    date: '2026-08-08', title: '第二篇', text: '另一篇内容', categoryId: null,
  })).thought;
  assert.notEqual(first.id, second.id, '同一天文章必须有独立 ID');
  const updated = (await request('PATCH', `/api/thoughts/${first.id}`, { title: '手填标题', text: '已修改' })).thought;
  assert.equal(updated.title, '手填标题');
  assert.equal(updated.text, '已修改');

  await request('DELETE', `/api/thought-categories/${learning.id}`);
  state = await request('GET', '/api/state');
  assert.equal(state.thoughtEntries.find((entry) => entry.id === first.id).categoryId, null, '删除类别后文章应转为未分类');

  await request('POST', '/api/think', { date: '2026-08-08', text: '兼容接口更新旧文章' });
  state = await request('GET', '/api/state');
  assert.equal(state.thoughtEntries.length, 3, '兼容接口不得覆盖或新增到已有迁移文章之外');
  assert.equal(state.thoughtEntries.find((entry) => entry.id === migratedId).text, '兼容接口更新旧文章');
  assert.equal(state.thoughtEntries.find((entry) => entry.id === second.id).text, '另一篇内容');

  await request('DELETE', `/api/thoughts/${second.id}`);
  state = await request('GET', '/api/state');
  assert.equal(state.thoughtEntries.some((entry) => entry.id === second.id), false);

  // 三类文章 CRUD 独立管理类别；每日反思仍使用独立框架。
  assert.equal(first.kind, 'free', '旧调用不传类型仍创建自由思考');
  await assert.rejects(() => request('POST', '/api/thoughts', { date: '2026-08-08', kind: 'reflection', text: '类型无效' }), /400/);
  await assert.rejects(() => request('POST', '/api/thoughts', { date: '2026-08-08', kind: 'review', title: ' ', text: ' ' }), /400/);
  const freeCategory = (await request('POST', '/api/thought-categories', { name: '复盘与成长', kind: 'free' })).category;
  const reviewCategory = (await request('POST', '/api/thought-categories', { name: '复盘与成长', kind: 'review' })).category;
  assert.notEqual(freeCategory.id, reviewCategory.id, '不同文章类型允许同名类别');
  await assert.rejects(() => request('POST', '/api/thought-categories', { name: '复盘与成长', kind: 'review' }), /409/);
  const review = (await request('POST', '/api/thoughts', { date: '2026-08-08', kind: 'review', title: '今日复盘', text: '收获\n\n下一步', categoryId: reviewCategory.id })).thought;
  const anotherReview = (await request('POST', '/api/thoughts', { date: '2026-08-08', kind: 'review', text: '第二篇复盘' })).thought;
  assert.notEqual(review.id, anotherReview.id);
  await request('PATCH', `/api/thoughts/${first.id}`, { categoryId: freeCategory.id });
  await assert.rejects(() => request('PATCH', `/api/thoughts/${first.id}`, { categoryId: reviewCategory.id }), /400/);
  const savedReview = (await request('PATCH', `/api/thoughts/${review.id}`, { kind: 'review', title: '复盘改名', text: '改进计划' })).thought;
  assert.equal(savedReview.kind, 'review');
  await assert.rejects(() => request('PATCH', `/api/thoughts/${review.id}`, { kind: 'free', text: '不应写入' }), /400/);
  await request('POST', '/api/think', { date: '2026-08-08', text: '兼容更新' });
  await request('POST', '/api/reflect', { date: '2026-08-08', entries: { question: '独立反思' } });
  await request('DELETE', `/api/thought-categories/${reviewCategory.id}`);
  state = await request('GET', '/api/state');
  assert.equal(state.thoughtEntries.find((entry) => entry.id === review.id).text, '改进计划');
  assert.equal(state.thoughtEntries.find((entry) => entry.id === review.id).categoryId, null);
  assert.equal(state.thoughtEntries.find((entry) => entry.id === first.id).categoryId, freeCategory.id);
  await request('DELETE', `/api/thought-categories/${freeCategory.id}`);
  state = await request('GET', '/api/state');
  assert.equal(state.thoughtEntries.find((entry) => entry.id === first.id).categoryId, null);
  await request('DELETE', `/api/thoughts/${review.id}`);
  state = await request('GET', '/api/state');
  assert.equal(state.thoughtEntries.some((entry) => entry.id === review.id), false);
  assert.equal(state.thoughtEntries.find((entry) => entry.id === anotherReview.id).text, '第二篇复盘');
  assert.equal(state.thoughtEntries.find((entry) => entry.id === first.id).text, '已修改');
  assert.deepEqual(state.reflectEntries['2026-08-08'], { question: '独立反思' });

  // 复盘图文与本地图片文件：拒绝外链、伪装文件和无效引用。
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jxJkAAAAASUVORK5CYII=', 'base64');
  const upload = await fetch(`${base}/api/review-images`, { method: 'POST', headers: { 'Content-Type': 'image/png' }, body: png });
  assert.equal(upload.status, 201);
  const uploaded = (await upload.json()).image;
  const imageResponse = await fetch(`${base}${uploaded.url}`);
  assert.equal(imageResponse.headers.get('content-type'), 'image/png');
  assert.equal(imageResponse.headers.get('x-content-type-options'), 'nosniff');
  assert.deepEqual(Buffer.from(await imageResponse.arrayBuffer()), png);
  assert.equal((await fetch(`${base}${uploaded.url}`, { method: 'HEAD' })).status, 200);
  for (const [type, body] of [['image/svg+xml', '<svg onload="alert(1)"></svg>'], ['image/png', '<html>not an image</html>'], ['image/jpeg', png]]) {
    assert.equal((await fetch(`${base}/api/review-images`, { method: 'POST', headers: { 'Content-Type': type }, body })).status, 400);
  }
  assert.equal((await fetch(`${base}/api/review-images`, { method: 'POST', headers: { 'Content-Type': 'image/png' }, body: Buffer.alloc(10 * 1024 * 1024 + 1) })).status, 400);
  const blocks = [{ id: 'text-a', type: 'text', text: '前半段\n' }, { id: 'photo-a', type: 'image', imageId: uploaded.id, caption: '<script>不执行</script>' }, { id: 'text-b', type: 'text', text: '\n后半段' }];
  const illustrated = (await request('POST', '/api/thoughts', { kind: 'review', date: '2026-08-08', blocks })).thought;
  assert.equal(illustrated.text, '前半段\n\n后半段');
  assert.deepEqual(illustrated.blocks, blocks);
  await assert.rejects(() => request('PATCH', `/api/thoughts/${illustrated.id}`, { text: '旧编辑器不能抹掉图片' }), /409/);
  await request('PATCH', `/api/thoughts/${illustrated.id}`, { title: '仅修改标题也保留图片' });
  await assert.rejects(() => request('POST', '/api/thoughts', { kind: 'free', date: '2026-08-08', blocks }), /400/);
  for (const imageId of ['https://example.com/photo.png', '../../data.json', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa.png']) {
    await assert.rejects(() => request('POST', '/api/thoughts', { kind: 'review', date: '2026-08-08', blocks: [{ ...blocks[1], imageId }] }), /400/);
  }
  await assert.rejects(() => request('POST', '/api/thoughts', { kind: 'review', date: '2026-08-08', blocks: Array.from({ length: 21 }, (_, i) => ({ ...blocks[1], id: `picture-${i}` })) }), /400/);
  await assert.rejects(() => request('POST', '/api/thoughts', { kind: 'review', date: '2026-08-08', blocks: [blocks[0], blocks[0]] }), /400/);
  const imageOnly = (await request('POST', '/api/thoughts', { kind: 'review', date: '2026-08-08', blocks: [blocks[1]] })).thought;
  assert.equal(imageOnly.text, '');
  const removed = (await request('PATCH', `/api/thoughts/${illustrated.id}`, { blocks: [blocks[0], blocks[2]] })).thought;
  assert.equal(removed.text, illustrated.text);
  await request('DELETE', `/api/thoughts/${imageOnly.id}`);
  assert.equal((await fetch(`${base}${uploaded.url}`)).status, 200, '移除引用不销毁本地原图');
  state = await request('GET', '/api/state');

  // 在隔离副本中模拟 v6 升级和重复启动；逐字段验证旧数据与备份。
  await new Promise((resolve) => { server.once('exit', resolve); server.kill(); });
  const v6 = { ...state, version: 6, thoughtEntries: state.thoughtEntries.map((entry) => {
    if (entry.kind === 'review') return entry;
    const { kind, ...oldEntry } = entry;
    return oldEntry;
  }) };
  const fixturePath = path.join(temp, 'data', 'data.json');
  fs.writeFileSync(fixturePath, JSON.stringify(v6, null, 2));
  server = spawn(process.execPath, ['server.js', '--port', String(port), '--no-open'], { cwd: temp, stdio: 'ignore' });
  await waitForServer();
  const upgraded = await request('GET', '/api/state');
  assert.equal(upgraded.version, 11);
  assert.deepEqual(upgraded.thoughtEntries, state.thoughtEntries);
  assert.deepEqual(upgraded.reflectEntries, state.reflectEntries);
  const backupName = fs.readdirSync(path.join(temp, 'data')).find((name) => name.startsWith('data.json.bak-v6-'));
  assert.ok(backupName);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(temp, 'data', backupName), 'utf8')), v6);
  const backupsBeforeRestart = fs.readdirSync(path.join(temp, 'data'));
  await new Promise((resolve) => { server.once('exit', resolve); server.kill(); });
  server = spawn(process.execPath, ['server.js', '--port', String(port), '--no-open'], { cwd: temp, stdio: 'ignore' });
  await waitForServer();
  assert.deepEqual((await request('GET', '/api/state')).thoughtEntries, upgraded.thoughtEntries);
  assert.deepEqual(fs.readdirSync(path.join(temp, 'data')), backupsBeforeRestart);

  await new Promise((resolve) => { server.once('exit', resolve); server.kill(); });
  const v7 = { ...upgraded, version: 7 };
  fs.writeFileSync(fixturePath, JSON.stringify(v7, null, 2));
  server = spawn(process.execPath, ['server.js', '--port', String(port), '--no-open'], { cwd: temp, stdio: 'ignore' });
  await waitForServer();
  assert.deepEqual((await request('GET', '/api/state')).thoughtEntries, upgraded.thoughtEntries, 'v7 升级不得改动原复盘');
  const v7Backup = fs.readdirSync(path.join(temp, 'data')).find((name) => name.startsWith('data.json.bak-v7-'));
  assert.ok(v7Backup);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(temp, 'data', v7Backup), 'utf8')), v7);

  // v10 -> v11：跨类型类别拆分、未使用类别归入自由思考、无效引用清理。
  await new Promise((resolve) => { server.once('exit', resolve); server.kill(); });
  const migrationFixture = {
    ...upgraded,
    version: 10,
    thoughtCategories: [
      { id: 'shared-category', name: '共享类别', createdAt: '2026-08-01T00:00:00.000Z' },
      { id: 'unused-category', name: '未使用类别', createdAt: '2026-08-01T00:00:00.000Z' },
    ],
    thoughtEntries: [
      { id: 'migrate-free', kind: 'free', date: '2026-08-01', title: '自由', text: '自由', categoryId: 'shared-category' },
      { id: 'migrate-review', kind: 'review', date: '2026-08-01', title: '复盘', text: '复盘', categoryId: 'shared-category' },
      { id: 'migrate-extraction', kind: 'extraction', date: '2026-08-01', title: '提取', text: '提取', categoryId: 'missing-category' },
    ],
  };
  fs.writeFileSync(fixturePath, JSON.stringify(migrationFixture, null, 2));
  server = spawn(process.execPath, ['server.js', '--port', String(port), '--no-open'], { cwd: temp, stdio: 'ignore' });
  await waitForServer();
  const migrated = await request('GET', '/api/state');
  assert.equal(migrated.version, 11);
  const sharedCategories = migrated.thoughtCategories.filter((category) => category.name === '共享类别');
  assert.deepEqual(sharedCategories.map((category) => category.kind).sort(), ['free', 'review']);
  assert.equal(migrated.thoughtCategories.find((category) => category.name === '未使用类别').kind, 'free');
  assert.equal(migrated.thoughtEntries.find((entry) => entry.id === 'migrate-free').categoryId, sharedCategories.find((category) => category.kind === 'free').id);
  assert.equal(migrated.thoughtEntries.find((entry) => entry.id === 'migrate-review').categoryId, sharedCategories.find((category) => category.kind === 'review').id);
  assert.equal(migrated.thoughtEntries.find((entry) => entry.id === 'migrate-extraction').categoryId, null);
  assert.ok(fs.readdirSync(path.join(temp, 'data')).some((name) => name.startsWith('data.json.bak-v10-')));
  const migrationFiles = fs.readdirSync(path.join(temp, 'data'));
  await new Promise((resolve) => { server.once('exit', resolve); server.kill(); });
  server = spawn(process.execPath, ['server.js', '--port', String(port), '--no-open'], { cwd: temp, stdio: 'ignore' });
  await waitForServer();
  assert.deepEqual(fs.readdirSync(path.join(temp, 'data')), migrationFiles, 'v11 迁移不得在重复启动时重复生成备份');

  console.log('PASS thought-v6-api-test');
} finally {
  if (server) server.kill();
  await new Promise((resolve) => setTimeout(resolve, 150));
  fs.rmSync(temp, { recursive: true, force: true });
}
