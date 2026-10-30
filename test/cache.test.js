'use strict';

process.env.BRIDGE_TEST_DB = require('path').join(require('os').tmpdir(), `bridge-test-cache-${process.pid}.db`);

const test = require('node:test');
const assert = require('node:assert');
const cache = require('../src/cache');
const { config } = require('../src/config');

test('cached() 遵守传入的 ttl（旧实现写死 2 分钟，10 分钟的目录也会提前失效）', async () => {
  let calls = 0;
  const fn = () => { calls++; return { n: calls }; };

  cache.cached('probe', fn, 50);
  assert.strictEqual(calls, 1, '第一次应真正执行');
  cache.cached('probe', fn, 50);
  assert.strictEqual(calls, 1, 'TTL 内应命中缓存');

  await new Promise((r) => setTimeout(r, 70));
  cache.cached('probe', fn, 50);
  assert.strictEqual(calls, 2, '过期后应重新执行');
});

test('cachedOrMiss 空结果只缓存很短时间', async () => {
  let calls = 0;
  const fn = () => { calls++; return []; };
  cache.cachedOrMiss('miss', fn, 60000);
  cache.cachedOrMiss('miss', fn, 60000);
  assert.strictEqual(calls, 1);
  await new Promise((r) => setTimeout(r, 30));
  // 空结果 ttl = min(15s, 60s)，30ms 内仍应命中
  cache.cachedOrMiss('miss', fn, 60000);
  assert.strictEqual(calls, 1);
});

test('staleWhileRevalidate 第一次返回 null，不阻塞调用方', () => {
  const t0 = Date.now();
  const v = cache.staleWhileRevalidate('swr', () => {
    // 模拟 200ms 的读表
    const end = Date.now() + 200;
    while (Date.now() < end) { /* spin */ }
    return ['x'];
  }, 60000);
  const cost = Date.now() - t0;
  assert.strictEqual(v, null, '第一次没有缓存应立刻返回 null');
  assert.ok(cost < 50, `不该在消息路径里同步读表（耗时 ${cost}ms）`);
});

test('config 深合并：只写 baseUrl/apiKey/model 时，rest 的默认值仍然在', () => {
  // 这是真实事故：浅合并把 retries/timeoutMs/maxTokens 冲掉
  assert.ok(Number.isFinite(config.llm.retries), 'llm.retries 必须有值');
  assert.ok(config.llm.maxTokens > 0);
  assert.ok(config.llm.timeoutMs > 0);
  assert.strictEqual(config.dataCache, true);
});

test('invalidate 能清掉指定前缀', () => {
  let calls = 0;
  const fn = () => { calls++; return 1; };
  cache.cached('weekly:方形花床', fn, 60000);
  cache.cached('weekly:圆形花床', fn, 60000);
  cache.invalidate('weekly:');
  cache.cached('weekly:方形花床', fn, 60000);
  assert.strictEqual(calls, 3);
});
