/** 原则子节点与未完成原因：迁移及 API 回归测试，始终使用临时数据副本。 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'life-steward-principles-v10-'));
const port = 46500 + Math.floor(Math.random() * 1000);
const base = `http://127.0.0.1:${port}`;
let server;

const seed = {
  version: 9,
  sections: [{ id: 'section-1', name: '原则', items: [{ id: 'item-1', name: '条目', activeSince: '2026-08-01' }] }],
  records: { '2026-08-14': { 'item-1': true } },
  thoughtEntries: [], thoughtCategories: [], reflectFrameworks: [], reflectEntries: {}, plans: [], problemTopics: [],
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
  fs.mkdirSync(path.join(temp, 'data'), { recursive: true });
  fs.writeFileSync(path.join(temp, 'data', 'data.json'), JSON.stringify(seed, null, 2));
  server = spawn(process.execPath, ['server.js', '--port', String(port), '--no-open'], { cwd: temp, stdio: 'ignore' });
  await waitForServer();

  let state = await request('GET', '/api/state');
  assert.equal(state.version, 10, 'v9 数据应升级为 v10');
  assert.deepEqual(state.sections[0].items[0].children, [], '旧条目应补充空子节点列表');
  assert.deepEqual(state.records['2026-08-14'], { 'item-1': true }, '历史父条目打卡应保留');

  const { child: first } = await request('POST', '/api/sections/section-1/items/item-1/children', { name: '子节点一' });
  const { child: second } = await request('POST', '/api/sections/section-1/items/item-1/children', { name: '子节点二' });
  await request('POST', '/api/checkin', { date: '2026-09-06', itemId: first.id, done: true });
  await request('POST', '/api/checkin-reasons', { date: '2026-09-06', itemId: second.id, reason: '临时安排冲突' });
  await request('POST', '/api/checkin-reasons', { date: '2026-09-07', itemId: second.id, reason: '另一日原因' });
  await request('POST', '/api/sections/section-1/items/item-1/children/reorder', { orderedIds: [second.id, first.id] });
  await request('PATCH', `/api/sections/section-1/items/item-1/children/${second.id}`, { name: '子节点二（改）' });

  state = await request('GET', '/api/state');
  const children = state.sections[0].items[0].children;
  assert.deepEqual(children.map((child) => child.id), [second.id, first.id], '子节点应支持同级排序');
  assert.equal(children[0].name, '子节点二（改）', '子节点应支持重命名');
  assert.equal(state.records['2026-09-06'][first.id], true, '子节点打卡应保存');
  assert.equal(state.checkinReasons['2026-09-06'][second.id], '临时安排冲突', '原因应按日期与子节点保存');
  assert.equal(state.checkinReasons['2026-09-07'][second.id], '另一日原因', '不同日期原因应隔离');

  await request('POST', '/api/checkin-reasons', { date: '2026-09-06', itemId: second.id, reason: '' });
  await request('DELETE', `/api/sections/section-1/items/item-1/children/${first.id}`);
  state = await request('GET', '/api/state');
  assert.equal(state.records['2026-09-06']?.[first.id], undefined, '删除子节点应清理打卡');
  assert.equal(state.checkinReasons['2026-09-06']?.[second.id], undefined, '空原因应被清除');
  assert.equal(state.checkinReasons['2026-09-07'][second.id], '另一日原因', '清空当天原因不应影响其他日期');

  await request('DELETE', '/api/sections/section-1/items/item-1');
  state = await request('GET', '/api/state');
  assert.equal(state.checkinReasons['2026-09-07']?.[second.id], undefined, '删除父条目应清理子节点原因');
  console.log('原则 v10 API 测试通过');
} finally {
  if (server && !server.killed) {
    server.kill();
    await once(server, 'exit');
  }
  fs.rmSync(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
