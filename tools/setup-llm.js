'use strict';

/**
 * LLM 配置与自测工具。
 *
 * 用法：
 *   node tools/setup-llm.js status
 *   node tools/setup-llm.js set <baseUrl> <model>        （然后从 stdin 读 apiKey）
 *   node tools/setup-llm.js test                         发一句测试
 *   node tools/setup-llm.js ask "你的问题"               试处理一条消息
 */

const fs = require('fs');
const path = require('path');

const CONFIG = path.join(__dirname, '..', 'config.local.json');

function loadConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG, 'utf8')); } catch (_) { return {}; }
}
function saveConfig(c) {
  fs.writeFileSync(CONFIG, JSON.stringify(c, null, 2) + '\n', 'utf8');
}

function readStdin() {
  return new Promise((resolve) => {
    let d = '';
    if (process.stdin.isTTY) return resolve('');
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (x) => { d += x; });
    process.stdin.on('end', () => resolve(d.trim()));
    setTimeout(() => resolve(d.trim()), 2000);
  });
}

async function main() {
  const [, , cmd, ...rest] = process.argv;

  if (cmd === 'status') {
    const c = loadConfig();
    const l = c.llm || {};
    console.log('\nLLM 配置');
    console.log(`  baseUrl: ${l.baseUrl || '(未设置)'}`);
    console.log(`  model:   ${l.model || '(未设置)'}`);
    console.log(`  apiKey:  ${l.apiKey ? l.apiKey.slice(0, 6) + '...' + l.apiKey.slice(-4) : '(未设置)'}`);
    console.log(`  状态:    ${l.baseUrl && l.apiKey ? '已配置' : '未配置'}\n`);
    return;
  }

  if (cmd === 'set') {
    const [baseUrl, model] = rest;
    if (!baseUrl || !model) {
      console.error('用法: node tools/setup-llm.js set <baseUrl> <model>');
      console.error('然后从 stdin 输入 apiKey（或直接回车跳过）');
      process.exit(1);
    }
    const key = await readStdin();
    const c = loadConfig();
    c.llm = c.llm || {};
    c.llm.baseUrl = baseUrl;
    c.llm.model = model;
    if (key) c.llm.apiKey = key;
    saveConfig(c);
    console.log('已保存');
    console.log(`  baseUrl: ${baseUrl}`);
    console.log(`  model:   ${model}`);
    console.log(`  apiKey:  ${key ? '已更新' : '保持不变'}`);
    return;
  }

  if (cmd === 'test') {
    const llm = require('../src/llm');
    console.log('测试中...');
    const r = await llm.selftest();
    console.log(JSON.stringify({ ok: r.ok, text: r.text, error: r.error, model: r.model }, null, 2));
    return;
  }

  if (cmd === 'ask') {
    const text = rest.join(' ') || '你好';
    // 走真实消息入口（规划→工具→作答→动作），但不发消息
    const { handle } = require('../core/router');
    console.log(`\n输入: ${text}\n`);
    const r = await handle(text, { messageId: 'cli-test' });
    console.log('ok:', r.ok);
    if (r.error) console.log('error:', r.error);
    console.log('\n--- 回复 ---');
    console.log(r.reply);
    console.log('\n--- 动作 ---');
    console.log(JSON.stringify(r.actions, null, 2));
    return;
  }

  console.log(`llm 工具：
  status              查看配置
  set <baseUrl> <model>  设置（apiKey 从 stdin）
  test                连通性测试
  ask "问题"           试跑一条消息

常见配置示例：
  DeepSeek    https://api.deepseek.com              deepseek-chat
  SiliconFlow https://api.siliconflow.cn/v1         deepseek-ai/DeepSeek-V3
  智谱        https://open.bigmodel.cn/api/paas/v4  glm-4-flash
  通义        https://dashscope.aliyuncs.com/compatible-mode/v1  qwen-plus

设置示例：
  node tools/setup-llm.js set https://api.deepseek.com deepseek-chat
  （然后粘贴 sk-xxx 回车）`);
}

main().catch((e) => { console.error(e); process.exit(1); });
