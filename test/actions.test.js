'use strict';

process.env.BRIDGE_TEST_DB = require('path').join(require('os').tmpdir(), `bridge-test-act-${process.pid}.db`);

const test = require('node:test');
const assert = require('node:assert');
const db = require('../src/db');
const actions = require('../core/handlers/actions');

test('循环提醒只建一条任务，并带 repeat 规则（旧实现展开成 6 条一次性任务）', () => {
  const r = actions.doRemind({
    title: '更新库龄表',
    due: '2026-11-06T16:00:00+08:00',
    repeat: { kind: 'monthly', day: 6, hour: 16, minute: 0 },
    advance: [0],
  }, null);

  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.count, 1, '只应该建 1 条任务');
  assert.match(String(r.repeat), /每月 6 号/);
  assert.strictEqual(r.forever, true);

  const all = db.listTasks({ done: null, limit: 1000 })
    .filter((t) => t.title === '更新库龄表' && t.repeat);
  assert.strictEqual(all.length, 1, `库里应只有 1 条循环任务，实际 ${all.length}`);

  const t = all[0];
  assert.deepStrictEqual(t.repeat, { kind: 'monthly', day: 6, hour: 16, minute: 0 });
  assert.strictEqual(Date.parse(t.due), t.dueMs, 'due 与 dueMs 必须一致');

  db.deleteTask(t.id);

  // 清理：把历史数据里可能残留的同名任务也删掉（只删本测试产生的）
  for (const x of db.listTasks({ done: null, limit: 1000 })) {
    if (x.title === '更新库龄表' && String(x.id).startsWith('loop-monthly-')) db.deleteTask(x.id);
  }
});

test('一次性提醒：带提前档位、due 与 dueMs 一致', () => {
  const due = '2026-11-05T10:00:00+08:00';
  // config 默认 onlyOnTime=true 会把提前档收敛成 [0]（准点提醒的产品决定），
  // 这里测的是「关掉强制准点后，模型给的档位被原样保存」。
  const { config } = require('../src/config');
  const saved = config.onlyOnTime;
  config.onlyOnTime = false;
  const r = actions.doRemind({ title: '查黑五定价', due, advance: [1440, 120, 0] }, 'msg-x');
  config.onlyOnTime = saved;
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.count, 1);
  assert.strictEqual(r.repeat, null);

  const t = db.getTask(r.ref);
  assert.strictEqual(t.due, due);
  assert.strictEqual(t.dueMs, Date.parse(due));
  assert.deepStrictEqual(t.advance, [1440, 120, 0]);
  assert.strictEqual(t.messageId, 'msg-x');
  db.deleteTask(t.id);
});

test('同一件事同一天建两次 → 第二次判重，不重复建', () => {
  const due = '2026-11-07T09:00:00+08:00';
  const a = actions.doRemind({ title: '整理黑五广告预算', due }, null);
  const b = actions.doRemind({ title: '整理黑五广告预算！', due }, null);
  assert.strictEqual(a.ok, true);
  assert.strictEqual(b.duplicate, true, '第二条应被判重');
  assert.strictEqual(b.ref, a.ref);
  db.deleteTask(a.ref);
});

test('时间无效 / 标题为空 → 明确失败，不写库', () => {
  const before = db.taskCounts().open;
  assert.strictEqual(actions.doRemind({ title: 'x', due: '不是时间' }, null).ok, false);
  assert.strictEqual(actions.doRemind({ title: '', due: '2026-11-08T10:00:00+08:00' }, null).ok, false);
  assert.strictEqual(db.taskCounts().open, before, '失败的动作不该写库');
});

test('forget 按关键词删除任务', () => {
  const r = actions.doRemind({ title: '临时要删掉的提醒', due: '2026-12-01T10:00:00+08:00' }, null);
  const del = actions.doForget({ query: '临时要删掉' }, null);
  assert.strictEqual(del.ok, true);
  assert.ok(del.removed.length >= 1);
  assert.strictEqual(db.getTask(r.ref), null);
});
