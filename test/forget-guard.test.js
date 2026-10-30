'use strict';

process.env.BRIDGE_TEST_DB = require('path').join(require('os').tmpdir(), `bridge-test-guard-${process.pid}.db`);

const test = require('node:test');
const assert = require('node:assert');
const db = require('../src/db');
const actions = require('../core/handlers/actions');

const mk = (id, title, due) => db.insertTask({
  id, title, due, dueMs: Date.parse(due), advance: [0],
  createdAt: new Date().toISOString(), done: false, fired: [], firing: [],
});

test('关键词命中过多时拒绝执行，不误删（旧实现会一口气删 6 条无关的）', () => {
  for (let i = 0; i < 8; i++) {
    mk(`guard-${i}`, `重复的 BD 提醒 ${i}`, `2026-11-2${i}T10:00:00+08:00`);
  }
  mk('unrelated-1', '复查广告数据', '2026-11-30T10:00:00+08:00');

  const r = actions.doForget({ query: '重复的 BD 提醒' });
  assert.strictEqual(r.ok, false, '超过上限必须拒绝，而不是删一部分');
  assert.match(String(r.error), /上限/);
  assert.ok(Array.isArray(r.matched) && r.matched.length === 8);

  // 一条都不能少
  const left = db.listTasks({ done: false, limit: 100 }).filter((t) => t.title.startsWith('重复的 BD 提醒'));
  assert.strictEqual(left.length, 8, `拒绝执行时不该删任何东西，实际剩 ${left.length}`);

  for (let i = 0; i < 8; i++) db.deleteTask(`guard-${i}`);
  db.deleteTask('unrelated-1');
});

test('关键词只按「标题包含」匹配，不会碰到无关提醒', () => {
  mk('k1', 'BD/LD 活动结束 A', '2026-11-25T10:00:00+08:00');
  mk('k2', 'BD/LD 活动结束 B', '2026-11-25T16:00:00+08:00');
  mk('other-1', '查看 GJ 广告数据（首次）', '2026-11-26T10:00:00+08:00');
  mk('other-2', '复查 GJ 广告（BD后价格回升）', '2026-11-27T10:00:00+08:00');

  const r = actions.doForget({ query: 'BD/LD 活动结束' });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.count, 2, `只该删 2 条，实际 ${r.count}`);

  assert.ok(db.getTask('other-1'), '无关提醒不能被动到');
  assert.ok(db.getTask('other-2'), '含「BD」字样的无关提醒也不能被动到');

  db.deleteTask('other-1');
  db.deleteTask('other-2');
});

test('withActionFacts 用真实结果覆盖模型的描述（模型说「没动别的」时纠正它）', () => {
  const { withActionFacts } = require('../core/router');
  const reply = '已把重复的合并成 1 条，其余提醒都没动。';

  const applied = [{
    type: 'forget',
    ok: true,
    count: 3,
    deleted: [
      { title: 'BD 提醒 A', due: '2026-10-29T16:00:00+08:00' },
      { title: 'BD 提醒 B', due: '2026-10-29T16:00:00+08:00' },
      { title: '无关的广告提醒', due: '2026-11-06T10:00:00+08:00' },
    ],
  }];

  const out = withActionFacts(reply, applied);
  assert.match(out, /实际删除 3 条/);
  assert.match(out, /无关的广告提醒/, '真实删除的每条都要列出来，让老板能核对');
  assert.ok(out.startsWith(reply), '模型原文保留在前面');
});

test('withActionFacts 对「没删成」也要明说（不能静默）', () => {
  const { withActionFacts } = require('../core/router');
  const out = withActionFacts('已合并。', [{
    type: 'forget', ok: false, error: '命中 8 条，超过单次删除上限 5 条',
    matched: [{ title: 'A' }, { title: 'B' }],
  }]);
  assert.match(out, /没有删掉/);
  assert.match(out, /上限/);
  assert.match(out, /未做改动/, '要明确告诉老板一条都没动');
});

test('withActionFacts 对建提醒失败也要提示', () => {
  const { withActionFacts } = require('../core/router');
  const out = withActionFacts('已建好提醒。', [{ type: 'remind', ok: false, error: '时间无效' }]);
  assert.match(out, /提醒没有建成功/);
  assert.match(out, /时间无效/);
});
