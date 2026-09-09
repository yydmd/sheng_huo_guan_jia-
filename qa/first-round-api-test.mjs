/**
 * 第一轮优化：数据版本迁移、完整备份与恢复。
 * 测试在临时副本中运行，不读写真实 data/data.json。
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'life-steward-first-round-'));
const port = 45000 + Math.floor(Math.random() * 1000);
const base = `http://127.0.0.1:${port}`;
let server;

const itemId = 'item-existing';
const seed = {
  version: 8,
  sections: [{ id: 'section-existing', name: '已有原则', items: [{ id: itemId, name: '已有条目' }] }],
  records: { '2026-08-14': { [itemId]: true } },
  thoughtEntries: [], thoughtCategories: [], reflectFrameworks: [], reflectEntries: [], plans: [], problemTopics: [],
  events: [], eventCheckins: {}, eventExceptions: [],
};

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

async function waitForServer() {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    try { if ((await fetch(`${base}/api/state`)).ok) return; } catch (_) { /* retry */ }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('等待测试服务启动超时');
}

try {
  fs.copyFileSync(path.join(root, 'server.js'), path.join(temp, 'server.js'));
  fs.mkdirSync(path.join(temp, 'data', 'review-images'), { recursive: true });
  fs.writeFileSync(path.join(temp, 'data', 'data.json'), JSON.stringify(seed, null, 2));
  fs.writeFileSync(path.join(temp, 'data', 'review-images', 'existing.png'), 'image-before-backup');
  server = spawn(process.execPath, ['server.js', '--port', String(port), '--no-open'], { cwd: temp, stdio: 'ignore' });
  await waitForServer();

  const migrated = await request('GET', '/api/state');
  assert.equal(migrated.version, 10, '旧数据应升级为 v10');
  assert.equal(migrated.sections[0].items[0].activeSince, '2026-08-14', '已有条目应从最早打卡日开始参与统计');
  assert.deepEqual(migrated.sections[0].items[0].children, [], '已有条目应补充空子节点列表');

  const { backup } = await request('POST', '/api/backups');
  assert.equal(backup.imageCount, 1, '备份应包含复盘图片');
  await request('POST', '/api/sections', { name: '恢复后不应存在' });
  fs.writeFileSync(path.join(temp, 'data', 'review-images', 'new.png'), 'image-after-backup');

  const restored = await request('POST', `/api/backups/${backup.id}/restore`);
  assert.equal(restored.restored.id, backup.id, '应恢复指定备份');
  assert.ok(restored.safetyBackup?.id, '恢复前应自动创建安全备份');
  const afterRestore = await request('GET', '/api/state');
  assert.equal(afterRestore.sections.length, 1, '恢复后不应保留之后新增的数据');
  assert.ok(fs.existsSync(path.join(temp, 'data', 'review-images', 'existing.png')), '恢复后应保留备份中的图片');
  assert.ok(!fs.existsSync(path.join(temp, 'data', 'review-images', 'new.png')), '恢复后应移除备份之后新增的图片');

  const listed = await request('GET', '/api/backups');
  assert.ok(listed.backups.some((entry) => entry.id === backup.id), '列表应包含手动备份');
  assert.ok(listed.backups.some((entry) => entry.id === restored.safetyBackup.id), '列表应包含恢复前安全备份');
  console.log('第一轮 API 测试通过');
} finally {
  if (server && !server.killed) {
    server.kill();
    await once(server, 'exit');
  }
  fs.rmSync(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
