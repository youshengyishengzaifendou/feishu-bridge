'use strict';

process.env.BRIDGE_TEST_DB = process.env.BRIDGE_TEST_DB || require('path').join(require('os').tmpdir(), `bridge-test-breaker-${process.pid}.db`);

const test = require('node:test');
const assert = require('node:assert');
const { config } = require('../src/config');
const llm = require('../src/llm');

// 让 chat 一定失败，且不要真等网络
function unsafeConfig() {
  config.llm.baseUrl = 'http://127.0.0.1:9/v1'; // 必然连接失败
  config.llm.apiKey = 'sk-test';
  config.llm.retries = 0;
  config.llm.timeoutMs = 400;
}

function restore() {
  config.llm.baseUrl = 'https://api.example.com/v1';
  config.llm.apiKey = 'sk-test-restore';
  config.llm.retries = 2;
  config.llm.timeoutMs = 120000;
}

test('连续失败后熔断打开：后续调用立刻返回，不再等网络', async () => {
  unsafeConfig();
  try {
    // 阈值 3 次
    for (let i = 0; i < 3; i++) {
      await llm.chat([{ role: 'user', content: 'hi' }]);
    }
    const st = llm.breakerState();
    assert.strictEqual(st.open, true, `熔断应当打开（fails=${st.fails}）`);

    const t0 = Date.now();
    const r = await llm.chat([{ role: 'user', content: 'hi' }]);
    const cost = Date.now() - t0;

    assert.strictEqual(r.ok, false);
    assert.match(r.error, /熔断/);
    assert.ok(cost < 100, `熔断期间必须立刻返回（实际 ${cost}ms）`);
    assert.strictEqual(llm.isCoolingDown(), true);
  } finally {
    restore();
  }
});
