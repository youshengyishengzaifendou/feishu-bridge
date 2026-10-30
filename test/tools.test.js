'use strict';

const test = require('node:test');
const assert = require('node:assert');
const tools = require('../src/tools');
const { parseMessage } = require('../src/parse');
const { plan, buildToolSchemas, getLlmConfig } = require('../src/llm');
const catalog = require('../src/catalog');
const { config } = require('../src/config');

test('normSeries 接受多种说法', () => {
  assert.strictEqual(tools.normSeries('带腿高架'), '带腿高架');
  assert.strictEqual(tools.normSeries('带腿'), '带腿高架');
  assert.strictEqual(tools.normSeries('高架花床'), '带腿高架');
  assert.strictEqual(tools.normSeries('圆'), '圆形花床');
  assert.strictEqual(tools.normSeries('方形'), '方形花床');
  assert.strictEqual(tools.normSeries(''), null);
  assert.strictEqual(tools.normSeries('鸡笼'), null);
});

test('未知工具不会被执行，但也不会炸整轮', () => {
  const r = tools.run([{ name: 'dropTable', args: {} }]);
  assert.strictEqual(r.used.length, 0);
  assert.strictEqual(r.failed.length, 1);
  assert.strictEqual(r.failed[0].error, '未知工具');
});

test('同名工具不同参数都会执行（先方形再带腿）', () => {
  const calls = [];
  const orig = tools.impl.weekly;
  tools.impl.weekly = (args) => { calls.push(args); return 'ok'; };
  try {
    tools.run([
      { name: 'weekly', args: { series: '方形花床' } },
      { name: 'weekly', args: { series: '带腿高架' } },
      { name: 'weekly', args: { series: '方形花床' } },
    ]);
  } finally {
    tools.impl.weekly = orig;
  }
  assert.strictEqual(calls.length, 2, `应执行 2 次不同参数，实际 ${calls.length}`);
  assert.deepStrictEqual(calls.map((c) => c.series), ['方形花床', '带腿高架']);
});

test('series 归一后去重：「带腿」和「带腿高架」只跑一次', () => {
  const calls = [];
  const orig = tools.impl.weekly;
  tools.impl.weekly = (args) => { calls.push(args); return 'ok'; };
  try {
    tools.run([
      { name: 'weekly', args: { series: '带腿' } },
      { name: 'weekly', args: { series: '带腿高架' } },
    ]);
  } finally {
    tools.impl.weekly = orig;
  }
  assert.strictEqual(calls.length, 1, '归一后是同一个参数，只该跑一次');
  assert.strictEqual(calls[0].series, '带腿高架');
});

test('parseMessage 认得常见说法', () => {
  const now = new Date('2026-10-28T15:00:00+08:00');
  const cases = [
    ['提醒我11月3日上午10点查黑五定价', '2026-11-03', '10:00'],
    ['明天下午3点半开会', '2026-10-29', '15:30'],
    ['后天 20:00 看广告', '2026-10-30', '20:00'],
    ['3天后检查库存', '2026-10-31', null],
  ];
  for (const [text, date, time] of cases) {
    const p = parseMessage(text, now);
    assert.ok(p, `${text} 应能解析`);
    assert.strictEqual(p.dateOnly, date, `${text} 日期`);
    if (time) assert.strictEqual(p.due.slice(11, 16), time, `${text} 时间`);
  }
});

test('目录不含实时读表也能构建（消息路径不阻塞）', () => {
  const t0 = Date.now();
  const text = catalog.build();
  const cost = Date.now() - t0;
  assert.ok(text.includes('示例-日运营'));
  assert.ok(text.includes('方形花床'));
  assert.ok(text.length > 300, '目录不能是空的');
  assert.ok(cost < 400, `目录构建不该读表（耗时 ${cost}ms）`);
});

test('tool schema 只暴露已知工具且参数合法', () => {
  const schemas = buildToolSchemas(catalog.TOOLS);
  // 每个真实工具 + 一个 none 哨兵
  assert.strictEqual(schemas.length, catalog.TOOLS.length + 1);
  for (const s of schemas) {
    assert.strictEqual(s.type, 'function');
    assert.ok(s.function.name);
    assert.strictEqual(s.function.parameters.type, 'object');
    assert.ok(typeof s.function.description === 'string' && s.function.description.length > 0);
  }
  const names = schemas.map((s) => s.function.name);
  assert.ok(names.includes('none'), '必须带 none 哨兵，模型才能明确表示「不读数据」');
  const weekly = schemas.find((s) => s.function.name === 'weekly');
  assert.deepStrictEqual(weekly.function.parameters.properties.series.enum,
    ['方形花床', '圆形花床', '带腿高架']);
});

test('extractToolCalls 认得 <tool_call> 文本形式（渠道不支持原生 tools 时）', () => {
  const { extractToolCalls } = require('../src/llm');
  const calls = extractToolCalls('<tool_call>\n{"name":"ops","arguments":{"kind":"广告","days":7}}\n</tool_call>');
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(calls[0].name, 'ops');
  assert.strictEqual(calls[0].args.days, 7);
});

test('extractToolCalls 认得 JSON 形式的 tool_calls', () => {
  const { extractToolCalls } = require('../src/llm');
  const calls = extractToolCalls(JSON.stringify({
    tool_calls: [{ function: { name: 'aging', arguments: '{}' } }],
  }));
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(calls[0].name, 'aging');
});

test('plan(): 渠道不可用时返回 {ok:false}，不抛异常（上层据此走本地兜底）', async () => {
  const savedBase = config.llm.baseUrl;
  const savedKey = config.llm.apiKey;
  config.llm.baseUrl = 'http://127.0.0.1:9/v1'; // 必然连接失败的端口
  config.llm.apiKey = 'sk-test';
  config.llm.retries = 0;
  config.llm.timeoutMs = 300;
  try {
    const r = await plan('库龄压力大不大', '（目录）', '2026-10-28', catalog.TOOLS);
    assert.strictEqual(r.ok, false);
    assert.ok(r.error, '失败必须带 error，供 router 记日志并兜底');
  } finally {
    config.llm.baseUrl = savedBase;
    config.llm.apiKey = savedKey;
    config.llm.retries = 2;
    config.llm.timeoutMs = 120000;
  }
});

test('plan(): 未配置 LLM 时立刻失败，不发请求', async () => {
  const savedBase = config.llm.baseUrl;
  const savedKey = config.llm.apiKey;
  config.llm.baseUrl = '';
  config.llm.apiKey = '';
  try {
    const r = await plan('你好', '（目录）', '2026-10-28', []);
    assert.strictEqual(r.ok, false);
    assert.match(r.error, /未配置/);
  } finally {
    config.llm.baseUrl = savedBase;
    config.llm.apiKey = savedKey;
  }
  assert.ok(getLlmConfig().retries >= 0, 'getLlmConfig 必须给出 retries');
});
