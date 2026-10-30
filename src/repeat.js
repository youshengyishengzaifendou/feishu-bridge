'use strict';

const { config } = require('./config');

// 重复规则：任务上的 repeat 字段，支持每周/每月/每天。
//   { "kind": "weekly", "weekday": 2, "hour": 15, "minute": 0 }
//   { "kind": "monthly", "day": 16, "hour": 15, "minute": 0 }
//   { "kind": "daily", "hour": 10, "minute": 0 }
// 到期全部提醒发完后，把 due 推到下一次并清空 fired，任务不结束。
//
// 关键约束：rollForward 必须同时更新 dueMs。
//   调度器只认 dueMs / earliestMs（B 树索引），如果只改 due 不改 dueMs，
//   任务会在「下一次 tick」再次被判为到期 → 每次 20 秒重复补发一条。

function pad(n) { return String(n).padStart(2, '0'); }

function toIso(d) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:00+08:00`;
}

/** 某年某月共有多少天（1-based month）。 */
function daysInMonth(year, month) {
  return new Date(year, month, 0).getDate();
}

/**
 * 把「每月 N 号」落到真实日期；31 号遇到 2 月时取当月最后一天，
 * 而不是让 Date 溢出到下个月（旧实现会把 1/31 推到 3/3）。
 */
function clampDay(year, month, day) {
  return Math.min(Number(day) || 1, daysInMonth(year, month));
}

/**
 * 根据 repeat 规则，算出严格晚于 afterRef 的下一个触发时间。
 * @returns {Date|null}
 */
function nextOccurrence(repeat, afterRef = new Date()) {
  if (!repeat || !repeat.kind) return null;

  const hour = Number.isFinite(repeat.hour) ? repeat.hour : 10;
  const minute = Number.isFinite(repeat.minute) ? repeat.minute : 0;
  const ref = new Date(afterRef.getTime());

  if (repeat.kind === 'daily') {
    const d = new Date(ref);
    d.setHours(hour, minute, 0, 0);
    if (d <= ref) d.setDate(d.getDate() + 1);
    return d;
  }

  if (repeat.kind === 'weekly') {
    const target = Number.isFinite(repeat.weekday) ? repeat.weekday : 2;
    const d = new Date(ref);
    d.setHours(hour, minute, 0, 0);
    const cur = d.getDay();
    let delta = (target - cur + 7) % 7;
    // 今天就是目标日：若时刻还没到，就用今天；否则顺延一周
    if (delta === 0) {
      if (d > ref) return d;
      delta = 7;
    }
    d.setDate(d.getDate() + delta);
    return d;
  }

  if (repeat.kind === 'monthly') {
    const day = Number.isFinite(repeat.day) ? repeat.day : 1;
    const y = ref.getFullYear();
    const m = ref.getMonth() + 1;

    // 先看本月（日期按当月天数收敛）
    const thisMonth = new Date(y, m - 1, clampDay(y, m, day), hour, minute, 0, 0);
    if (thisMonth > ref) return thisMonth;

    // 再顺延一个月
    const ny = m === 12 ? y + 1 : y;
    const nm = m === 12 ? 1 : m + 1;
    return new Date(ny, nm - 1, clampDay(ny, nm, day), hour, minute, 0, 0);
  }

  return null;
}

/**
 * 任务到期后滚动到下一次。返回是否发生了滚动。
 *
 * 同时写回 due 与 dueMs：调度器/索引都只认 dueMs，
 * 只改 due 会让任务在每个 tick 里反复「到期 → 补发」。
 */
function rollForward(task, nowMs = Date.now()) {
  if (!task.repeat) return false;

  const next = nextOccurrence(task.repeat, new Date(nowMs));
  if (!next) return false;

  task.prevDue = task.due;
  task.due = toIso(next);
  task.dueMs = next.getTime();
  task.fired = [];
  task.firing = [];
  task.done = false;
  task.completedAt = null;
  task.lastFiredAt = new Date(nowMs).toISOString();
  return true;
}

function repeatHuman(repeat) {
  if (!repeat || !repeat.kind) return '';
  const hour = Number.isFinite(repeat.hour) ? repeat.hour : 10;
  const minute = Number.isFinite(repeat.minute) ? repeat.minute : 0;
  const hm = `${pad(hour)}:${pad(minute)}`;
  if (repeat.kind === 'daily') return `每天 ${hm}`;
  if (repeat.kind === 'weekly') {
    const W = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
    return `${W[repeat.weekday] || ''} ${hm}`;
  }
  if (repeat.kind === 'monthly') return `每月 ${repeat.day} 号 ${hm}`;
  return '';
}

module.exports = { nextOccurrence, rollForward, repeatHuman, toIso, daysInMonth, clampDay };
