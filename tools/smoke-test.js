'use strict';

/**
 * 端到端冒烟测试（不发送飞书消息）
 *
 *   node tools/smoke-test.js                跑默认用例
 *   node tools/smoke-test.js "库龄压力大不大"   跑指定一句
 *
 * 会真实调用 LLM 和飞书表格，但不发消息、不写任务。
 */

const db = require('../src/db');
const catalog = require('../src/catalog');
const llm = require('../src/llm');
const tools = require('../src/tools');

const CASES = [
  '库龄压力大不大',
  '产品线C毛利率多少',
  '提醒我11月5日上午10点查黑五定价',
  '上周我做了哪些广告操作',
  'ACME-SP-2P白-raised bed广泛-top-20260224 这个广告活动是哪个产品的',
  '你好',
];

async function main() {
  const argv = process.argv.slice(2);
  const cases = argv.length ? [argv.join(' ')] : CASES;

  console.log(`LLM 配置: ${llm.isConfigured() ? '已配置' : '未配置（会走降级）'}\n`);

  // 目录里的覆盖信息来自后台预热；这里先同步预热一次，免得打印「（后台刷新中）」
  try {
    const data = require('../src/data');
    catalog.warmCoverage();
    await new Promise((r) => setTimeout(r, 1500));
    void data;
  } catch (_) {}

  const cat = catalog.build({ force: true });
  console.log('=== 目录（模型视角）===');
  console.log(cat);
  console.log(`\n目录长度 ${cat.length} 字（旧实现每次塞整表摘要，通常 3000+ 字）\n`);

  for (const text of cases) {
    console.log('─'.repeat(70));
    console.log(`消息: ${text}`);

    // ① 规划
    const t0 = Date.now();
    const p = await llm.plan(text, cat, db.localDateKey(new Date()), catalog.TOOLS);
    const planMs = Date.now() - t0;

    if (!p.ok) {
      console.log(`  规划失败（会走本地兜底）: ${p.error}`);
      continue;
    }
    const names = p.plan.tools.map((x) => `${x.name}${Object.keys(x.args || {}).length ? JSON.stringify(x.args) : ''}`).join(' ');
    console.log(`  ① 规划（${planMs}ms）needsData=${p.plan.needsData} → ${names || '(不读表)'}`);
    if (p.plan.why) console.log(`     理由: ${p.plan.why}`);

    // ② 执行工具
    let facts = '';
    if (p.plan.tools.length) {
      const t1 = Date.now();
      const r = tools.run(p.plan.tools);
      facts = r.facts;
      console.log(`  ② 工具（${Date.now() - t1}ms）${r.used.join(',') || '(无)'} → ${facts.length} 字`);
      if (r.failed.length) console.log(`     失败: ${r.failed.map((f) => `${f.name}:${f.error}`).join(', ')}`);
      console.log('     ' + (facts.split('\n').slice(0, 6).join('\n     ')));
    } else {
      console.log('  ② 不需要读表');
    }
  }

  console.log('─'.repeat(70));
}

main()
  .catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(() => db.close());
