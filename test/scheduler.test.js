'use strict';

process.env.BRIDGE_TEST_DB = require('path').join(require('os').tmpdir(), `bridge-test-sched-${process.pid}.db`);

const test = require('node:test');
const assert = require('node:assert');
const db = require('../src/db');
const { runTick } = require('../src/scheduler');

const fakeDeliver = (log) => async (task, adv) => {
  log.push(`${task.id}@${adv}`);
  return { delivered: true, via: 'test' };
};

test('循环任务：投递一次后滚到下一次，不会每 tick 重复补发', async () => {
  const sent = [];
  const now = Date.parse('2026-10-28T10:00:10+08:00');
  const id = `sched-loop-${Date.now()}`;

  db.putTask({
    id,
    title: '测试循环',
    due: '2026-10-28T10:00:00+08:00',
    dueMs: Date.parse('2026-10-28T10:00:00+08:00'),
    advance: [0],
    repeat: { kind: 'daily', hour: 10, minute: 0 },
    createdAt: new Date(now).toISOString(),
    done: false,
    fired: [],
    firing: [],
  });

  // 第 1 次 tick：应当投递一次并滚到明天
  const r1 = await runTick({ now, deliver: fakeDeliver(sent) });
  assert.strictEqual(r1.fired, 1, '第一次 tick 应当发一条');
  assert.strictEqual(sent.length, 1);

  const t1 = db.getTask(id);
  assert.strictEqual(t1.done, false, '循环任务不该被标记完成');
  assert.strictEqual(t1.due, '2026-10-29T10:00:00+08:00');
  assert.strictEqual(t1.dueMs, Date.parse('2026-10-29T10:00:00+08:00'));
  assert.strictEqual(Date.parse(t1.due), t1.dueMs, 'due 与 dueMs 必须一致');
  assert.deepStrictEqual(t1.fired, [], '滚动后档位状态要清空');

  // 第 2 次 tick（同一时刻）：不该再发
  const r2 = await runTick({ now: now + 20000, deliver: fakeDeliver(sent) });
  assert.strictEqual(r2.fired, 0, '第二个 tick 不该重复补发');
  assert.strictEqual(sent.length, 1, `累计只该发 1 条，实际 ${sent.length}`);

  // 第 3 次 tick：仍然不该发
  const r3 = await runTick({ now: now + 40000, deliver: fakeDeliver(sent) });
  assert.strictEqual(r3.fired, 0);
  assert.strictEqual(sent.length, 1);

  db.deleteTask(id);
});

test('一次性任务：发完标记 done，不再出现在到期列表', async () => {
  const sent = [];
  const now = Date.parse('2026-10-28T12:00:00+08:00');
  const id = `sched-once-${Date.now()}`;

  db.putTask({
    id,
    title: '一次性提醒',
    due: '2026-10-28T11:58:00+08:00',
    dueMs: Date.parse('2026-10-28T11:58:00+08:00'),
    advance: [0],
    repeat: null,
    createdAt: new Date(now).toISOString(),
    done: false,
    fired: [],
    firing: [],
  });

  const r = await runTick({ now, deliver: fakeDeliver(sent) });
  assert.strictEqual(r.fired, 1);
  assert.strictEqual(db.getTask(id).done, true);
  assert.deepStrictEqual(db.dueTasks(now + 60000).filter((t) => t.id === id), []);

  db.deleteTask(id);
});

test('补发窗口：超过 grace 的旧提醒只标记、不发送', async () => {
  const sent = [];
  const now = Date.parse('2026-10-28T12:00:00+08:00');
  const id = `sched-stale-${Date.now()}`;

  db.putTask({
    id,
    title: '很久以前的提醒',
    due: '2026-10-28T06:00:00+08:00', // 迟到 6 小时 > 默认 180 分钟
    dueMs: Date.parse('2026-10-28T06:00:00+08:00'),
    advance: [0],
    repeat: null,
    createdAt: new Date(now).toISOString(),
    done: false,
    fired: [],
    firing: [],
  });

  const r = await runTick({ now, deliver: fakeDeliver(sent) });
  assert.strictEqual(r.fired, 0, '超窗口不该补发');
  assert.strictEqual(r.skipped, 1);
  assert.strictEqual(sent.length, 0);
  assert.deepStrictEqual(db.getTask(id).fired, ['0'], '应标记为已处理，避免下次再扫');

  db.deleteTask(id);
});

test('投递失败不标记 fired，但会退避而不是每 tick 重锤', async () => {
  const sent = [];
  const now = Date.parse('2026-10-28T13:00:00+08:00');
  const id = `sched-fail-${Date.now()}`;

  db.putTask({
    id,
    title: '发送会失败的提醒',
    due: '2026-10-28T12:59:00+08:00',
    dueMs: Date.parse('2026-10-28T12:59:00+08:00'),
    advance: [0],
    repeat: null,
    createdAt: new Date(now).toISOString(),
    done: false,
    fired: [],
    firing: [],
  });

  const fail = async () => ({ delivered: false, via: 'test' });

  await runTick({ now, deliver: fail });
  assert.strictEqual(db.getTask(id).done, false);
  assert.deepStrictEqual(db.getTask(id).fired, []);

  // 20 秒后再 tick：处于退避期，不该再尝试
  const r2 = await runTick({ now: now + 20000, deliver: async (t, a) => { sent.push(a); return { delivered: false }; } });
  assert.strictEqual(sent.length, 0, `退避期内不该重试，实际尝试 ${sent.length} 次`);
  void r2;

  db.deleteTask(id);
});
