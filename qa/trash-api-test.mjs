/** 删除进入垃圾站：活动数据不再保留正文和图片，恢复后回来，彻底删除后文件消失。 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { ROOT, waitForHttp, sleep, makeChecker, makeServer } from './cdp-kit.mjs';

const PORT = 4179;
const API = `http://127.0.0.1:${PORT}`;
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const SECRET = 'SECRET-BODY-SHOULD-LEAVE-LIVE-DATA';
const { check, failures } = makeChecker();

async function call(method, url, body, epoch) {
  const res = await fetch(API + url, {
    method,
    headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(epoch ? { 'X-Life-Data-Epoch': epoch } : {}) },
    body: body === undefined ? undefined : (Buffer.isBuffer(body) ? body : JSON.stringify(body)),
  });
  const text = await res.text();
  let data = null;
  try { data = JSON.parse(text); } catch (_) { data = text; }
  return { status: res.status, data, text };
}

function disk(dataDir) {
  return JSON.parse(fs.readFileSync(path.join(dataDir, 'data.json'), 'utf8'));
}

async function main() {
  let restarted = null;
  const made = makeServer(PORT, null);
  try {
    await waitForHttp(`${API}/api/state`);
    let state = (await call('GET', '/api/state')).data;
    const epoch = state.dataEpoch;
    check('T01 新数据没有已删除模块', Array.isArray(state.trashedModuleIds) && state.trashedModuleIds.length === 0 && state.navigationPreferences.moduleOrder.includes('plans'));

    const uploaded = await fetch(`${API}/api/review-images`, { method: 'POST', headers: { 'Content-Type': 'image/png' }, body: PNG });
    const uploadedData = await uploaded.json();
    check('T02 上传图片', uploaded.status === 201 && uploadedData.image?.id, JSON.stringify(uploadedData));
    const imageId = uploadedData.image.id;
    const thought = (await call('POST', '/api/thoughts', {
      date: '2026-10-14', kind: 'free', title: '短标题',
      blocks: [{ id: 'text-1', type: 'text', text: SECRET }, { id: 'image-1', type: 'image', imageId, caption: '', widthPercent: 100 }],
    })).data.thought;
    check('T03 文章已保存', Boolean(thought?.id));

    const removed = await call('DELETE', `/api/thoughts/${thought.id}`);
    check('T04 删除文章成功', removed.status === 200);
    state = (await call('GET', '/api/state')).data;
    const raw = JSON.stringify(disk(made.dataDir));
    const trash = await call('GET', '/api/trash');
    const entry = trash.data.entries.find((item) => item.sourceId === thought.id);
    check('T05 活动数据不再包含正文和文章', state.thoughtEntries.every((item) => item.id !== thought.id) && !raw.includes(SECRET) && !JSON.stringify(state).includes(SECRET));
    check('T06 垃圾索引只有标题，图片已离开活动目录', entry && entry.kind === 'record' && entry.title === '短标题' && !JSON.stringify(trash.data).includes(SECRET)
      && !fs.existsSync(path.join(made.dataDir, 'review-images', imageId))
      && fs.existsSync(path.join(made.dataDir, 'trash', 'files', 'images', imageId))
      && fs.existsSync(path.join(made.dataDir, 'trash', 'items', `${entry.id}.json`)));

    const blocked = await call('POST', `/api/trash/${entry.id}/restore`);
    check('T07 恢复需要数据代次', blocked.status === 400);
    const restored = await call('POST', `/api/trash/${entry.id}/restore`, {}, epoch);
    check('T08 恢复文章', restored.status === 200);
    state = (await call('GET', '/api/state')).data;
    const back = state.thoughtEntries.find((item) => item.id === thought.id);
    check('T09 正文和图片回到活动数据', back?.blocks?.some((block) => block.text === SECRET) && fs.existsSync(path.join(made.dataDir, 'review-images', imageId))
      && !(await call('GET', '/api/trash')).data.entries.some((item) => item.id === entry.id));

    await call('DELETE', `/api/thoughts/${thought.id}`);
    const again = (await call('GET', '/api/trash')).data.entries.find((item) => item.sourceId === thought.id);
    const purged = await call('DELETE', `/api/trash/${again.id}`, undefined, epoch);
    check('T10 彻底删除后文件消失', purged.status === 200 && !fs.existsSync(path.join(made.dataDir, 'trash', 'items', `${again.id}.json`))
      && !fs.existsSync(path.join(made.dataDir, 'trash', 'files', 'images', imageId))
      && !fs.existsSync(path.join(made.dataDir, 'review-images', imageId)));

    const plan = (await call('POST', '/api/plans', { name: '要归档的计划' })).data.plan;
    const moduleDelete = await call('DELETE', '/api/modules/plans', undefined, epoch);
    state = (await call('GET', '/api/state')).data;
    check('T11 内置模块离开导航且数据清空', moduleDelete.status === 200 && state.plans.length === 0
      && state.trashedModuleIds.includes('plans') && !state.navigationPreferences.moduleOrder.includes('plans')
      && !JSON.stringify(state).includes('要归档的计划'));
    const moduleEntry = (await call('GET', '/api/trash')).data.entries.find((item) => item.kind === 'module' && item.moduleId === 'plans');
    check('T12 模块在垃圾站', moduleEntry?.title === '计划');

    const backup = await call('POST', '/api/backups');
    check('T13 备份包含垃圾站', backup.status === 201 && fs.existsSync(path.join(made.dataDir, 'backups', backup.data.backup.id, 'trash', 'index.json')));

    const stopped = new Promise((resolve) => made.server.once('exit', resolve));
    made.server.kill();
    await stopped;
    const restartedProcess = spawn(process.execPath, ['server.js', '--port', String(PORT), '--no-open'], {
      cwd: ROOT, env: { ...process.env, LIFE_STEWARD_DATA_DIR: made.dataDir }, stdio: 'ignore',
    });
    restarted = restartedProcess;
    made.server = restartedProcess;
    await waitForHttp(`${API}/api/state`);
    state = (await call('GET', '/api/state')).data;
    const epoch2 = state.dataEpoch;
    check('T14 重启后不会把已删除模块自动加回', !state.navigationPreferences.moduleOrder.includes('plans') && state.trashedModuleIds.includes('plans') && state.plans.length === 0);

    const moduleRestored = await call('POST', `/api/trash/${moduleEntry.id}/restore`, {}, epoch2);
    state = (await call('GET', '/api/state')).data;
    check('T15 恢复模块后计划和入口回来', moduleRestored.status === 200 && state.plans.some((item) => item.id === plan.id && item.name === '要归档的计划')
      && state.navigationPreferences.moduleOrder.includes('plans') && !state.trashedModuleIds.includes('plans'));

    const category = (await call('POST', '/api/plans/categories', { name: '推进' })).data.category;
    const linked = (await call('POST', '/api/plans', { name: '分类下的计划', categoryId: category.id })).data.plan;
    await call('DELETE', `/api/plans/categories/${category.id}`);
    state = (await call('GET', '/api/state')).data;
    check('T16 删除分类后计划转为未分类', state.plans.find((item) => item.id === linked.id)?.categoryId === null && state.planCategories.every((item) => item.id !== category.id));
    const categoryEntry = (await call('GET', '/api/trash')).data.entries.find((item) => item.sourceId === category.id);
    await call('POST', `/api/trash/${categoryEntry.id}/restore`, {}, (await call('GET', '/api/state')).data.dataEpoch);
    state = (await call('GET', '/api/state')).data;
    check('T17 恢复分类后仍未分类的计划挂回', state.planCategories.some((item) => item.id === category.id) && state.plans.find((item) => item.id === linked.id)?.categoryId === category.id);
  } finally {
    if (restarted && !restarted.killed) restarted.kill();
    await made.stop();
  }
  if (failures.length) {
    console.error(`FAIL trash-api: ${failures.join('、')}`);
    process.exit(1);
  }
  console.log('PASS trash-api');
}

main().catch((error) => { console.error(error); process.exit(1); });
