'use strict';

process.env.BRIDGE_TEST_DB = process.env.BRIDGE_TEST_DB || require('path').join(require('os').tmpdir(), `bridge-test-fresh-${process.pid}.db`);

const test = require('node:test');
const assert = require('node:assert');
const db = require('../src/db');
const catalog = require('../src/catalog');

test('目录里的「待发条数」必须实时，不能跟着 10 分钟缓存走', () => {
  const readCount = () => Number(/待发 (\d+) 条/.exec(catalog.build())[1]);
  const before = readCount();
  assert.strictEqual(before, db.taskCounts().open);

  const id = `fresh-${Date.now()}`;
  db.insertTask({
    id,
    title: '新鲜度测试',
    due: '2026-12-09T10:00:00+08:00',
    dueMs: Date.parse('2026-12-09T10:00:00+08:00'),
    advance: [0],
    createdAt: new Date().toISOString(),
    done: false,
    fired: [],
    firing: [],
  });

  // 目录有 10 分钟缓存，但计数必须立刻反映新增
  assert.strictEqual(readCount(), before + 1, '新建提醒后目录里的条数必须立刻更新');
  assert.strictEqual(readCount(), db.taskCounts().open);

  db.deleteTask(id);
  assert.strictEqual(readCount(), before, '删除后也要立刻回落');
});

test('目录给出「接下来最近的几条」，模型不用为此多调一次工具', () => {
  const id = `next-${Date.now()}`;
  db.insertTask({
    id,
    title: '目录里要能看到的提醒',
    due: '2026-11-01T09:30:00+08:00',
    dueMs: Date.parse('2026-11-01T09:30:00+08:00'),
    advance: [0],
    createdAt: new Date().toISOString(),
    done: false,
    fired: [],
    firing: [],
  });

  const text = catalog.build();
  assert.match(text, /■ 接下来/);
  assert.match(text, /目录里要能看到的提醒/, '最近的提醒标题要出现在目录里');

  db.deleteTask(id);
});
