'use strict';

/**
 * 旧 JSON → SQLite 迁移
 *
 * 一次性脚本，幂等（重复跑不会重复插入）。
 *
 *   data/tasks.json            → tasks
 *   data/notes.json            → campaigns / notes（kind=campaign 的进 campaigns）
 *   data/state.json            → seen_messages
 *   data/daily/YYYY-MM-DD.json → turns
 *   data/daily/summaries/*.md  → 文件保留（单独读）
 *   日运营表里的产品名          → products
 *
 * 用法：
 *   node tools/migrate-to-sqlite.js --dry   只看统计，不写库
 *   node tools/migrate-to-sqlite.js          写入
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const DATA = path.join(ROOT, 'data');
const DRY = process.argv.includes('--dry');

/** 稳定的笔记 id：同一 kind + 同一内容永远得到同一个 id，保证重复跑不重复插入。 */
function noteKey(kind, text) {
  const crypto = require('crypto');
  const h = crypto.createHash('sha1').update(`${kind}|${text}`).digest('hex').slice(0, 10);
  return `mig-${kind}-${h}`;
}

function readJson(name, fallback) {  const f = path.join(DATA, name);
  if (!fs.existsSync(f)) return fallback;
  try {
    let raw = fs.readFileSync(f, 'utf8');
    if (raw.charCodeAt(0) === 0xFEFF) raw = raw.slice(1);
    if (!raw.trim()) return fallback;
    return JSON.parse(raw);
  } catch (e) {
    console.warn(`  ! ${name} 读取失败: ${e.message}`);
    return fallback;
  }
}

function main() {
  console.log(`=== 迁移开始 ${DRY ? '(dry-run)' : ''} ===\n`);

  if (!DRY) {
    // 确保 schema 建好
    require('../src/db').open();
  }

  const db = require('../src/db');
  const memory = require('../src/memory');

  const report = { tasks: 0, campaigns: 0, notes: 0, seen: 0, turns: 0, products: 0, unassigned: [] };

  // ── 1. 产品：从日运营表读真实产品名 ──
  console.log('1) 产品登记（来自日运营表）');
  try {
    const r = memory.syncFromSheets();
    report.products = r.total;
    console.log(`   ${DRY ? '将登记' : '已登记'} ${r.total} 个产品${r.added.length ? `（新增 ${r.added.length}：${r.added.join('、')}）` : ''}`);
  } catch (e) {
    console.log(`   跳过：读表失败（${e.message}）`);
    console.log('   提示：可以在有 user token 的环境下重跑本脚本补齐产品档案。');
  }

  // ── 2. 任务 ──
  console.log('\n2) 提醒 → tasks');
  const tasksJson = readJson('tasks.json', { tasks: [] });
  const tasks = Array.isArray(tasksJson.tasks) ? tasksJson.tasks : [];
  for (const t of tasks) {
    if (!t || !t.id || !t.due) continue;
    const dueMs = Date.parse(t.due);
    if (Number.isNaN(dueMs)) {
      console.log(`   ! 跳过时间无效 ${t.id} due=${t.due}`);
      continue;
    }
    // 任务上的产品/活动关联（旧数据没有，靠标题反解）
    let productId = t.productId || null;
    let campaignId = t.campaignId || null;

    if (t.campaign) {
      const cr = memory.recordCampaign({ name: t.campaign });
      campaignId = cr.campaign.id;
      if (cr.product) productId = cr.product.id;
    }
    if (!productId) {
      const m = memory.matchProduct(`${t.title} ${t.note || ''}`);
      if (m) productId = m.product.id;
    }

    const row = {
      id: t.id,
      title: t.title,
      note: t.note || '',
      due: t.due,
      dueMs,
      advance: Array.isArray(t.advance) && t.advance.length ? t.advance : [0],
      repeat: t.repeat || null,
      digest: t.digest || null,
      productId,
      campaignId,
      source: t.source || 'migrated',
      messageId: t.messageId || null,
      createdAt: t.createdAt || new Date().toISOString(),
      done: Boolean(t.done),
      completedAt: t.completedAt || null,
      lastFiredAt: t.lastFiredAt || null,
      prevDue: t.prevDue || null,
      fired: Array.isArray(t.fired) ? t.fired : [],
      firing: Array.isArray(t.firing) ? t.firing : [],
    };
    if (!DRY) db.putTask(row);
    report.tasks++;
  }
  console.log(`   ${DRY ? '将导入' : '已导入'} ${report.tasks} 条提醒`);

  // ── 3. 笔记 / 广告活动 ──
  console.log('\n3) 笔记 → campaigns / notes');
  const notesJson = readJson('notes.json', { notes: [] });
  const notes = Array.isArray(notesJson.notes) ? notesJson.notes : [];

  for (const n of notes) {
    if (!n || !n.text) continue;

    if (n.kind === 'campaign') {
      const r = memory.recordCampaign({
        name: n.text,
        type: n.type || null,
        note: n.analysis || n.display || '',
      });
      report.campaigns++;
      if (!r.product) report.unassigned.push(n.text);
      // 活动笔记按「活动名 + kind」判重，保证重复跑不会重复插入
      const noteId = noteKey('campaign', n.text);
      if (!DRY && !db.getNote(noteId)) {
        db.addNote({
          id: noteId,
          kind: 'campaign',
          text: n.text,
          analysis: n.analysis || '',
          campaignId: r.campaign.id,
          productId: r.product ? r.product.id : null,
          source: n.source || 'migrated',
          createdAt: n.createdAt || new Date().toISOString(),
        });
      }
      continue;
    }

    // 普通笔记：尽量挂到产品上
    let productId = null;
    const m = memory.matchProduct(n.text);
    if (m) productId = m.product.id;

    const noteId = noteKey(n.kind || 'ops', n.text);
    if (!DRY && !db.getNote(noteId)) {
      db.addNote({
        id: noteId,
        kind: n.kind || 'ops',
        text: n.text,
        analysis: n.analysis || '',
        productId,
        source: n.source || 'migrated',
        createdAt: n.createdAt || new Date().toISOString(),
      });
    }
    report.notes++;
  }
  console.log(`   ${DRY ? '将导入' : '已导入'} ${report.campaigns} 个广告活动、${report.notes} 条普通笔记`);

  // ── 4. 已见消息 ──
  console.log('\n4) 已见消息 → seen_messages');
  const stateJson = readJson('state.json', { seenMessageIds: [] });
  const seen = Array.isArray(stateJson.seenMessageIds) ? stateJson.seenMessageIds : [];
  if (!DRY && seen.length) db.markSeen(seen);
  report.seen = seen.length;
  console.log(`   ${DRY ? '将导入' : '已导入'} ${report.seen} 个消息 id`);

  // ── 5. 当天对话 → turns ──
  console.log('\n5) 历史对话 → turns');
  const dailyDir = path.join(DATA, 'daily');
  if (fs.existsSync(dailyDir)) {
    for (const f of fs.readdirSync(dailyDir).filter((x) => /^\d{4}-\d{2}-\d{2}\.json$/.test(x))) {
      const date = f.replace('.json', '');
      const rec = readJson(path.join('daily', f), null);
      const turns = rec && Array.isArray(rec.turns) ? rec.turns : [];
      for (const t of turns) {
        if (!DRY) {
          db.addTurn({
            date,
            at: t.at || `${date}T00:00:00+08:00`,
            user: t.user,
            reply: t.reply,
            intent: t.intent,
            actions: t.actions,
            degraded: t.intent === 'degraded',
          });
        }
        report.turns++;
      }
      console.log(`   ${f}: ${turns.length} 轮`);
    }
  }
  if (!report.turns) console.log('   （没有历史对话）');

  // ── 6. 重建索引 ──
  if (!DRY) {
    console.log('\n6) 重建全文索引');
    db.reindexAll();
    console.log('   完成');
  }

  // ── 报告 ──
  console.log('\n=== 汇总 ===');
  console.log(`  提醒 ${report.tasks} 条 · 广告活动 ${report.campaigns} 个 · 笔记 ${report.notes} 条`);
  console.log(`  已见消息 ${report.seen} 个 · 对话 ${report.turns} 轮 · 产品 ${report.products} 个`);

  if (report.unassigned.length) {
    console.log(`\n  ⚠ 有 ${report.unassigned.length} 个广告活动无法自动归属产品，需要人工确认：`);
    for (const n of report.unassigned) console.log(`    · ${n}`);
    console.log('    可在飞书里说「XX广告活动是YY产品的」，或用 node tools/entity-cli.js 补。');
  }

  if (!DRY) {
    const s = db.stats();
    console.log('\n=== 库内现状 ===');
    console.log(`  数据库 ${s.file}`);
    console.log(`  tasks ${s.tasks.open} 待发 / ${s.tasks.done} 已完成 · products ${s.products} · campaigns ${s.campaigns} · notes ${s.notes} · seen ${s.seen}`);
  }
}

main();
