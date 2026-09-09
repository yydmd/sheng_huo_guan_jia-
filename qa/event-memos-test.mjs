/** 备忘事件筛选与排序回归：纯模型测试，不读写真实数据。 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const M = require('../public/event-model.js');
const today = '2026-09-09';
const oneTime = (id, title, startDate, time, extra = {}) => ({
  id, title, note: '', time, startDate, endDate: null,
  repeat: { type: 'none', weekdays: [], monthDay: null, monthlyMode: null },
  enabled: extra.enabled ?? true,
  archivedAt: extra.archivedAt || null,
  createdAt: extra.createdAt || '2026-09-01T00:00:00.000Z',
});

const events = [
  oneTime('later-no-time', '后天未定时间', '2026-09-11', null),
  oneTime('tomorrow-late', '明天晚上', '2026-09-10', '18:00'),
  oneTime('tomorrow-early', '明天上午', '2026-09-10', '09:00'),
  oneTime('today', '今天事件', today, '08:00'),
  oneTime('past', '过去事件', '2026-09-08', '08:00'),
  oneTime('archived', '已归档事件', '2026-09-12', '08:00', { archivedAt: '2026-09-01T00:00:00.000Z' }),
  oneTime('disabled', '已停用事件', '2026-09-12', '09:00', { enabled: false }),
  {
    id: 'daily', title: '固定安排', note: '', time: '07:00', startDate: '2026-09-10', endDate: null,
    repeat: { type: 'daily', weekdays: [], monthDay: null, monthlyMode: null },
    enabled: true, archivedAt: null, createdAt: '2026-09-01T00:00:00.000Z',
  },
];

const result = M.futureMemoEvents(events, today);
assert.deepEqual(result.map((event) => event.id), [
  'tomorrow-early', 'tomorrow-late', 'later-no-time',
]);
assert.deepEqual(events.map((event) => event.id), [
  'later-no-time', 'tomorrow-late', 'tomorrow-early', 'today', 'past', 'archived', 'disabled', 'daily',
], '筛选排序不应修改原数组');
assert.deepEqual(M.futureMemoEvents([], today), []);
assert.deepEqual(M.futureMemoEvents(null, today), []);

console.log('备忘事件筛选与排序测试通过');
