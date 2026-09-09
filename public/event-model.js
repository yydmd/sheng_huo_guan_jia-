/**
 * 事件安排 · 统一事件模型与重复日期计算器
 * 浏览器全局暴露 EventModel，Node 下通过 module.exports 导出以便边界测试。
 * 日期统一使用本地时间的 YYYY-MM-DD 字符串，避免 UTC 偏移。
 */
(function (global, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else global.EventModel = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  function toISODate(date) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  }

  function parseDate(value) {
    const [year, month, day] = value.split('-').map(Number);
    return new Date(year, month - 1, day);
  }

  function addDays(value, amount) {
    const date = parseDate(value);
    date.setDate(date.getDate() + amount);
    return toISODate(date);
  }

  function daysInMonth(value) {
    const date = parseDate(value);
    return new Date(date.getFullYear(), date.getMonth() + 1, 0).getDate();
  }

  function lastDayOfMonth(value) {
    const date = parseDate(value);
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(daysInMonth(value)).padStart(2, '0')}`;
  }

  // 1=周一 … 7=周日
  function isoWeekday(value) {
    const day = parseDate(value).getDay();
    return day === 0 ? 7 : day;
  }

  /** 事件在指定日期是否发生（重复规则 + 启用状态 + 起止范围） */
  function eventOccursOn(event, date) {
    if (!event || !event.enabled || event.archivedAt) return false;
    if (!event.startDate || event.startDate > date) return false;
    if (event.endDate && event.endDate < date) return false;
    const r = event.repeat || { type: 'none', weekdays: [], monthDay: null, monthlyMode: null };
    if (r.type === 'none') return event.startDate === date;
    if (r.type === 'daily') return true;
    if (r.type === 'weekly') {
      return Array.isArray(r.weekdays) && r.weekdays.includes(isoWeekday(date));
    }
    if (r.type === 'monthly') {
      if (r.monthlyMode === 'lastDay') return lastDayOfMonth(date) === date;
      const day = r.monthDay || parseInt(date.slice(8, 10), 10);
      // 每月第 N 日：不存在的月份直接跳过（不落到最后一天）
      return parseInt(date.slice(8, 10), 10) === day;
    }
    return false;
  }

  /** 计算某天应显示的事件实例（模板 + 取消/修改例外） */
  function occurrencesOn(date, events, exceptions) {
    const list = [];
    for (const event of events || []) {
      if (!eventOccursOn(event, date)) continue;
      const ex = (exceptions || []).find((e) => e.eventId === event.id && e.date === date);
      if (ex && ex.type === 'cancel') continue;
      const changes = (ex && ex.changes) || {};
      list.push({
        eventId: event.id,
        date,
        title: changes.title != null ? changes.title : event.title,
        time: changes.time != null ? changes.time : event.time,
        note: changes.note != null ? changes.note : event.note,
        repeat: event.repeat,
        exception: ex || null,
      });
    }
    return list;
  }

  /** 从 fromDate（含）起下一次发生日期；找不到返回 null */
  function nextOccurrence(event, fromDate, maxDays = 400) {
    if (!event || !event.enabled || event.archivedAt) return null;
    let date = event.startDate > fromDate ? event.startDate : fromDate;
    for (let i = 0; i < maxDays; i += 1) {
      if (eventOccursOn(event, date)) return date;
      date = addDays(date, 1);
    }
    return null;
  }

  /** 今天之后、启用且未归档的单次事件，供“备忘事件”按日期和时间展示。 */
  function futureMemoEvents(events, today) {
    return (events || [])
      .filter((event) => (event.repeat?.type || 'none') === 'none'
        && event.startDate > today
        && event.enabled !== false
        && !event.archivedAt)
      .sort((a, b) => a.startDate.localeCompare(b.startDate)
        || (a.time || '99:99').localeCompare(b.time || '99:99')
        || String(a.createdAt || '').localeCompare(String(b.createdAt || '')));
  }

  /** 月历 42 格：从当月 1 号所在周的周一开始 */
  function calendarGrid(year, month) {
    const first = new Date(year, month - 1, 1);
    const firstIso = isoWeekday(toISODate(first));
    const gridStart = new Date(year, month - 1, 1 - (firstIso - 1));
    const cells = [];
    for (let i = 0; i < 42; i += 1) {
      const d = new Date(gridStart);
      d.setDate(gridStart.getDate() + i);
      cells.push(toISODate(d));
    }
    return cells;
  }

  /** 简短的重复说明，如“每天”“每周一、周三”“每月最后一天” */
  function repeatLabel(event) {
    const r = (event && event.repeat) || { type: 'none' };
    if (r.type === 'none') return '仅此一次';
    if (r.type === 'daily') return '每天';
    if (r.type === 'weekly') {
      const names = ['', '周一', '周二', '周三', '周四', '周五', '周六', '周日'];
      const days = (r.weekdays || []).map((d) => names[d]).filter(Boolean);
      return days.length ? `每${days.join('、')}` : '每周';
    }
    if (r.type === 'monthly') return r.monthlyMode === 'lastDay' ? '每月最后一天' : `每月${r.monthDay}日`;
    return '';
  }

  return {
    toISODate, parseDate, addDays, daysInMonth, lastDayOfMonth, isoWeekday,
    eventOccursOn, occurrencesOn, nextOccurrence, futureMemoEvents, calendarGrid, repeatLabel,
  };
});
