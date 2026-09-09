/**
 * 事件模型 · 重复日期计算器边界测试
 * 用法: node qa/event-model-test.mjs
 */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const M = require('../public/event-model.js');

let pass = 0;
let fail = 0;
function check(name, cond, detail = '') {
  if (cond) { pass += 1; console.log(`  [通过] ${name}`); }
  else { fail += 1; console.log(`  [失败] ${name} ${detail}`); }
}

function ev(id, overrides = {}) {
  return Object.assign({
    id, title: '事件', note: '', time: '08:30',
    startDate: '2026-01-01', endDate: null,
    repeat: { type: 'none', weekdays: [], monthDay: null, monthlyMode: null },
    enabled: true, archivedAt: null,
  }, overrides);
}

console.log('===== 重复规则 =====');
check('单次事件只在 startDate 出现', M.eventOccursOn(ev('a'), '2026-01-01') && !M.eventOccursOn(ev('a'), '2026-01-02'));
check('每日事件每天出现', M.eventOccursOn(ev('b', { repeat: { type: 'daily' } }), '2026-03-15') && M.eventOccursOn(ev('b', { repeat: { type: 'daily' } }), '2026-06-30'));
check('每日事件在 startDate 之前不出现', !M.eventOccursOn(ev('b', { startDate: '2026-03-01', repeat: { type: 'daily' } }), '2026-02-28'));

// 2026-08-14 是周五(5)，2026-08-17 是周一(1)，2026-08-19 是周三(3)
check('每周事件只在选中星期出现', M.eventOccursOn(ev('c', { repeat: { type: 'weekly', weekdays: [1, 3, 5] } }), '2026-08-17') && M.eventOccursOn(ev('c', { repeat: { type: 'weekly', weekdays: [1, 3, 5] } }), '2026-08-19') && M.eventOccursOn(ev('c', { repeat: { type: 'weekly', weekdays: [1, 3, 5] } }), '2026-08-14') && !M.eventOccursOn(ev('c', { repeat: { type: 'weekly', weekdays: [1, 3, 5] } }), '2026-08-18'));
check('星期日用 7 表示', M.eventOccursOn(ev('d', { repeat: { type: 'weekly', weekdays: [7] } }), '2026-08-16'));

check('每月 14 日只在 14 日出现', M.eventOccursOn(ev('e', { repeat: { type: 'monthly', monthDay: 14 } }), '2026-08-14') && !M.eventOccursOn(ev('e', { repeat: { type: 'monthly', monthDay: 14 } }), '2026-08-15') && M.eventOccursOn(ev('e', { repeat: { type: 'monthly', monthDay: 14 } }), '2026-02-14'));
check('每月 31 日不在 2/4/6/9/11 月出现', !M.eventOccursOn(ev('f', { repeat: { type: 'monthly', monthDay: 31 } }), '2026-02-28') && !M.eventOccursOn(ev('f', { repeat: { type: 'monthly', monthDay: 31 } }), '2026-04-30') && !M.eventOccursOn(ev('f', { repeat: { type: 'monthly', monthDay: 31 } }), '2026-11-30'));
check('每月 31 日在 1/3/5/7/8 月出现', M.eventOccursOn(ev('f', { repeat: { type: 'monthly', monthDay: 31 } }), '2026-01-31') && M.eventOccursOn(ev('f', { repeat: { type: 'monthly', monthDay: 31 } }), '2026-08-31'));
check('每月最后一天：1 月为 31 日', M.eventOccursOn(ev('g', { repeat: { type: 'monthly', monthlyMode: 'lastDay' } }), '2026-01-31') && !M.eventOccursOn(ev('g', { repeat: { type: 'monthly', monthlyMode: 'lastDay' } }), '2026-01-30'));
check('每月最后一天：2 月为 28 日（2026 非闰年）', M.eventOccursOn(ev('g', { repeat: { type: 'monthly', monthlyMode: 'lastDay' } }), '2026-02-28'));
check('每月最后一天：闰年 2 月为 29 日', M.eventOccursOn(ev('g', { repeat: { type: 'monthly', monthlyMode: 'lastDay' } }), '2028-02-29'));
check('每月最后一天：4 月为 30 日', M.eventOccursOn(ev('g', { repeat: { type: 'monthly', monthlyMode: 'lastDay' } }), '2026-04-30'));

console.log('===== 起止 / 启用 / 归档 =====');
const ended = ev('h', { startDate: '2026-01-01', endDate: '2026-01-10', repeat: { type: 'daily' } });
check('超过 endDate 不出现', M.eventOccursOn(ended, '2026-01-10') && !M.eventOccursOn(ended, '2026-01-11'));
const paused = ev('i', { repeat: { type: 'daily' }, enabled: false });
check('暂停（enabled=false）不出现', !M.eventOccursOn(paused, '2026-08-14'));
const archived = ev('j', { repeat: { type: 'daily' }, archivedAt: '2026-08-01T00:00:00Z' });
check('归档事件不出现', !M.eventOccursOn(archived, '2026-08-14'));

console.log('===== 例外 =====');
const weekly = ev('w', { repeat: { type: 'weekly', weekdays: [5] } }); // 每周五
const exceptions = [
  { eventId: 'w', date: '2026-08-21', type: 'cancel', changes: {} },
  { eventId: 'w', date: '2026-08-28', type: 'override', changes: { time: '10:00', title: '上午阅读' } },
];
const normal = M.occurrencesOn('2026-08-14', [weekly], exceptions);
const cancelled = M.occurrencesOn('2026-08-21', [weekly], exceptions);
const overridden = M.occurrencesOn('2026-08-28', [weekly], exceptions);
check('正常日期出现', normal.length === 1 && normal[0].time === '08:30');
check('取消例外（cancel）当天不出现', cancelled.length === 0);
check('修改例外（override）应用标题与时间', overridden.length === 1 && overridden[0].title === '上午阅读' && overridden[0].time === '10:00');
check('例外不影响其他日期', M.occurrencesOn('2026-09-04', [weekly], exceptions).length === 1);

console.log('===== 下次发生 / 月历 =====');
check('下次发生（每周五）', M.nextOccurrence(weekly, '2026-08-14') === '2026-08-14');
check('下次发生从未来日期起', M.nextOccurrence(weekly, '2026-08-15') === '2026-08-21');
check('暂停事件无下次', M.nextOccurrence(paused, '2026-08-14') === null);
check('每月最后一天的下次', M.nextOccurrence(ev('g', { repeat: { type: 'monthly', monthlyMode: 'lastDay' } }), '2026-01-31') === '2026-01-31');
const grid = M.calendarGrid(2026, 8);
check('月历为 42 格', grid.length === 42);
check('2026 年 8 月 1 日是周六，网格从周一 7-27 开始', grid[0] === '2026-07-27');
check('网格含当月所有日期', grid.includes('2026-08-01') && grid.includes('2026-08-31'));

console.log('===== 重复说明 =====');
check('repeatLabel 每天', M.repeatLabel(ev('x', { repeat: { type: 'daily' } })) === '每天');
check('repeatLabel 每周一三五', M.repeatLabel(ev('x', { repeat: { type: 'weekly', weekdays: [1, 3, 5] } })) === '每周一、周三、周五');
check('repeatLabel 每月最后一天', M.repeatLabel(ev('x', { repeat: { type: 'monthly', monthlyMode: 'lastDay' } })) === '每月最后一天');
check('repeatLabel 每月 14 日', M.repeatLabel(ev('x', { repeat: { type: 'monthly', monthDay: 14 } })) === '每月14日');

console.log(`\n===== 结果: ${fail ? 'FAIL' : 'PASS'}（${pass} 通过 / ${fail} 失败） =====`);
process.exit(fail ? 1 : 0);
