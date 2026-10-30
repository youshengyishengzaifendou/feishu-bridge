'use strict';

process.env.BRIDGE_TEST_DB = require('path').join(require('os').tmpdir(), `bridge-test-forget-${process.pid}.db`);

const test = require('node:test');
const assert = require('node:assert');
const db = require('../src/db');
const actions = require('../core/handlers/actions');

const mk = (id, title, due) => {
  db.insertTask({
    id,
    title,
    due,
    dueMs: Date.parse(due),
    advance: [0],
    createdAt: new Date().toISOString(),
    done: false,
    fired: [],
    firing: [],
  });
};

test('forget 支持一次删多条（老板说「合并这几条」时必须全删）', () => {
  mk('dup-a', 'BD/LD 活动结束 A', '2026-10-30T10:00:00+08:00');
  mk('dup-b', 'BD/LD 活动结束 B', '2026-10-30T12:00:00+08:00');
  mk('dup-c', 'BD/LD 活动结束 C', '2026-10-30T16:00:00+08:00');
  mk('keep-me', '无关的提醒', '2026-11-01T10:00:00+08:00');

  const r = actions.doForget({ ids: ['dup-a', 'dup-b', 'dup-c'] });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.count, 3, `应当删除 3 条，实际 ${r.count}`);
  assert.strictEqual(db.getTask('dup-a'), null);
  assert.strictEqual(db.getTask('dup-b'), null);
  assert.strictEqual(db.getTask('dup-c'), null);

  // 没点名的提醒不能被动到
  assert.ok(db.getTask('keep-me'), '只该删老板明确要删的');
  db.deleteTask('keep-me');
});

test('forget 按关键词可删多条，但受单次上限保护（超过就整体拒绝，不删一半）', () => {
  // 上限内：正常全删
  for (let i = 0; i < 4; i++) {
    mk(`kw-${i}`, `重复提醒 ${i}`, `2026-10-31T${String(10 + i).padStart(2, '0')}:00:00+08:00`);
  }
  const ok = actions.doForget({ query: '重复提醒' });
  assert.strictEqual(ok.ok, true);
  assert.strictEqual(ok.count, 4, `上限内应删掉 4 条，实际 ${ok.count}`);
  assert.deepStrictEqual(
    db.listTasks({ done: false, limit: 100 }).filter((t) => t.title.startsWith('重复提醒')),
    [],
  );

  // 超上限：整体拒绝，一条不删（避免误删无关任务）
  for (let i = 0; i < 8; i++) {
    mk(`kw2-${i}`, `超额提醒 ${i}`, `2026-11-01T${String(10 + i).padStart(2, '0')}:00:00+08:00`);
  }
  const over = actions.doForget({ query: '超额提醒' });
  assert.strictEqual(over.ok, false, '超过上限必须拒绝');
  assert.match(String(over.error), /上限/);
  const left = db.listTasks({ done: false, limit: 100 }).filter((t) => t.title.startsWith('超额提醒'));
  assert.strictEqual(left.length, 8, '拒绝执行时一条都不该少');
  for (let i = 0; i < 8; i++) db.deleteTask(`kw2-${i}`);
});

test('forget 找不到就如实失败，不要假装成功', () => {
  const r = actions.doForget({ query: '根本不存在的东西' });
  assert.strictEqual(r.ok, false);
  assert.match(String(r.error), /没找到/);
});

test('合并 = 先删后建，一次做完（这正是 08:44 那条消息该走的路径）', () => {
  mk('m1', 'BD/LD活动结束（10/28）评估与续期', '2026-10-29T16:00:00+08:00');
  mk('m2', 'BD/LD活动结束：评估效果+开价格折扣', '2026-10-29T16:00:00+08:00');

  const r = actions.apply([
    { type: 'forget', ids: ['m1', 'm2'] },
    {
      type: 'remind',
      title: 'BD/LD 活动结束：评估效果 + 续期 + 价格折扣',
      due: '2026-10-29T16:00:00+08:00',
      advance: [120, 0],
    },
  ], 'merge-test');

  assert.strictEqual(r.length, 2);
  assert.strictEqual(r[0].count, 2, '旧的两条要真的被删掉');
  assert.strictEqual(r[1].ok, true, '新的合并版要建起来');

  const left = db.listTasks({ done: false, limit: 100 }).filter((t) => /BD\/LD/.test(t.title));
  assert.strictEqual(left.length, 1, `合并后只该剩 1 条，实际 ${left.length}`);
  db.deleteTask(left[0].id);
});
