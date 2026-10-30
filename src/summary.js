'use strict';

/**
 * 每日总结 —— 每晚跑一次，把当天做的事浓缩成几行。
 * 数据来自 SQLite 的 turns 表（不再读 JSON 文件）。
 */

const { log } = require('./util');
const llm = require('./llm');
const db = require('./db');
const profile = require('./profile');

/**
 * 生成并保存当天总结。
 */
async function runDailySummary(dateKey) {
  const key = dateKey || db.localDateKey(new Date());
  const turns = db.listTurns({ date: key, limit: 200 });

  if (!turns.length) {
    const text = `# ${key} 今日总结\n\n今天没有对话记录。\n`;
    writeSummary(text, key);
    return { ok: true, text, empty: true };
  }

  const U = profile.get().userLabel || '老板';
  const lines = [];
  for (const t of turns.slice(-60)) {
    const time = String(t.at || '').slice(11, 16);
    lines.push(`${time} ${U}：${String(t.user || '').slice(0, 120)}`);
    if (t.reply) lines.push(`     我：${String(t.reply).replace(/\n/g, ' ').slice(0, 120)}`);
    if (t.actions && t.actions.length) {
      lines.push(`     动作：${t.actions.map((a) => a.type).join('、')}`);
    }
  }

  if (!llm.isConfigured()) {
    const text = `# ${key} 今日总结\n\n（AI 未配置，原始记录）\n\n${lines.join('\n').slice(0, 1200)}\n`;
    writeSummary(text, key);
    return { ok: false, error: 'AI 未配置', text };
  }

  const prompt = `下面是今天（${key}）我和主人的全部对话，共 ${turns.length} 轮。

请写一份极简的今日总结，要求：
- 最多 8 行，每行一个要点
- 只写「做了什么、决定了什么、发现了什么」
- 不要客套话、不要建议
- 纯闲聊就一句话说明

对话：
${lines.join('\n')}`;

  const r = await llm.chat([
    { role: 'system', content: '你是极简日志记录员。只输出总结正文，不要标题、不要前言。' },
    { role: 'user', content: prompt },
  ], { maxTokens: 4000 });

  if (!r.ok) {
    log('ERROR', `daily summary failed: ${r.error}`);
    const fallback = `# ${key} 今日总结\n\n（生成失败：${r.error}）\n\n${lines.join('\n').slice(0, 800)}\n`;
    writeSummary(fallback, key);
    return { ok: false, error: r.error, text: fallback };
  }

  const content = `# ${key} 今日总结\n\n${r.text.trim()}\n`;
  writeSummary(content, key);
  log('INFO', `daily summary done ${key} (${turns.length} turns)`);
  return { ok: true, text: content };
}

function writeSummary(content, dateKey) {
  const fs = require('fs');
  const path = require('path');
  const { DATA } = require('./config');
  const dir = path.join(DATA, 'daily', 'summaries');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${dateKey}.md`), content, 'utf8');
}

module.exports = { runDailySummary };

if (require.main === module) {
  runDailySummary().then((r) => {
    console.log(r.ok ? r.text : `失败: ${r.error}`);
    db.close();
  });
}
