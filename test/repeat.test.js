'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { nextOccurrence, rollForward, repeatHuman } = require('../src/repeat');

const at = (s) => new Date(s);

test('daily：今天没过点用今天，过了点用明天', () => {
  const rep = { kind: 'daily', hour: 10, minute: 0 };
  assert.strictEqual(nextOccurrence(rep, at('2026-10-28T08:00:00+08:00')).getDate(), 28);
  assert.strictEqual(nextOccurrence(rep, at('2026-10-28T11:00:00+08:00')).getDate(), 29);
});

test('weekly：命中当天未到点用今天，已到点顺延一周', () => {
  // 2026-10-28 是周三(3)
  const rep = { kind: 'weekly', weekday: 3, hour: 16, minute: 0 };
  assert.strictEqual(nextOccurrence(rep, at('2026-10-28T09:00:00+08:00')).getDate(), 28);
  assert.strictEqual(nextOccurrence(rep, at('2026-10-28T18:00:00+08:00')).getDate(), 4);
});

test('monthly：本月未到点用本月', () => {
  const rep = { kind: 'monthly', day: 16, hour: 16, minute: 0 };
  const n = nextOccurrence(rep, at('2026-10-05T09:00:00+08:00'));
  assert.strictEqual(n.getMonth(), 9); // 10 月
  assert.strictEqual(n.getDate(), 16);
});

test('monthly 31 号不溢出到下下月（旧实现 1/31 会推到 3/3）', () => {
  const rep = { kind: 'monthly', day: 31, hour: 10, minute: 0 };
  const n = nextOccurrence(rep, at('2026-01-31T12:00:00+08:00'));
  assert.strictEqual(n.getMonth(), 1, '应当是 2 月');
  assert.strictEqual(n.getDate(), 28, '2 月没有 31 号 → 收敛到 28');
});

test('monthly 31 号遇到小月收敛到最后一天，不错过整月', () => {
  const rep = { kind: 'monthly', day: 31, hour: 10, minute: 0 };
  const n = nextOccurrence(rep, at('2026-03-31T12:00:00+08:00'));
  assert.strictEqual(n.getMonth(), 3, '应当是 4 月');
  assert.strictEqual(n.getDate(), 30);
});

test('rollForward 同时更新 due 与 dueMs（防重复补发的根本修复）', () => {
  const task = {
    id: 'x',
    due: '2026-10-28T10:00:00+08:00',
    dueMs: Date.parse('2026-10-28T10:00:00+08:00'),
    repeat: { kind: 'daily', hour: 10, minute: 0 },
    fired: ['0'],
    firing: [],
    done: false,
  };
  const ok = rollForward(task, Date.parse('2026-10-28T10:00:30+08:00'));
  assert.strictEqual(ok, true);
  assert.strictEqual(task.due, '2026-10-29T10:00:00+08:00');
  assert.strictEqual(task.dueMs, Date.parse('2026-10-29T10:00:00+08:00'));

  // 关键断言：due 字符串和 dueMs 必须指向同一时刻
  assert.strictEqual(Date.parse(task.due), task.dueMs, 'due 与 dueMs 不一致会导致每 tick 重复投递');
  assert.deepStrictEqual(task.fired, []);
});

test('repeatHuman 输出人话', () => {
  assert.strictEqual(repeatHuman({ kind: 'monthly', day: 6, hour: 16, minute: 0 }), '每月 6 号 16:00');
  assert.strictEqual(repeatHuman({ kind: 'daily', hour: 10, minute: 0 }), '每天 10:00');
  assert.match(repeatHuman({ kind: 'weekly', weekday: 2, hour: 14, minute: 30 }), /周二 14:30/);
});
