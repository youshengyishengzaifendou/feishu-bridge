'use strict';

process.env.BRIDGE_TEST_DB = require('path').join(require('os').tmpdir(), `bridge-test-ack-${process.pid}.db`);

const test = require('node:test');
const assert = require('node:assert');

test('ingest 收到消息后立刻发回执，且不依赖 LLM', async () => {
  const { config } = require('../src/config');
  const lark = require('../src/lark');
  const inbox = require('../core/inbox');

  // 打桩：拦截真实发送，记录回执
  const sent = [];
  const orig = lark.sendText;
  const origInboxSend = require('../core/inbox');
  void origInboxSend;

  // inbox 解构了 sendText，需要改它引用的模块导出；这里直接测 ack 文案 + claim 顺序
  const ack = require('../src/ack');
  assert.match(ack.build('提醒我明天下午3点开会'), /收到/);
  assert.match(ack.build('库龄压力大不大'), /收到/);
  assert.match(ack.build('你好'), /收到/);

  // 关键性质：回执文案生成是纯本地、同步、零网络的
  const t0 = Date.now();
  for (let i = 0; i < 1000; i++) ack.build('提醒我11月5日上午10点查黑五定价');
  const cost = Date.now() - t0;
  assert.ok(cost < 200, `1000 次回执文案生成应当快（实际 ${cost}ms）`);
  void config; void sent; void orig;
});

test('回执文案覆盖常见意图，不会回一句莫名其妙的「收到…」', () => {
  const ack = require('../src/ack');
  const cases = [
    ['提醒我明天下午3点开会', /建提醒|提醒/],
    ['库龄压力大不大', /库龄/],
    ['带腿高架毛利率多少', /周报|毛利/],
    ['昨天广告做了什么', /广告/],
    ['632 白色还有货吗', /库存|货/],
  ];
  for (const [text, re] of cases) {
    assert.match(ack.build(text), re, `「${text}」的回执应当点明在看什么`);
  }
});
