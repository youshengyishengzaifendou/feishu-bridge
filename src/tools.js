'use strict';

/**
 * 数据工具 —— 模型按需调用的读表入口
 *
 * 这是「先看目录、再决定读什么」的落地方式：
 *   router 把 catalog.build() 的目录塞进 prompt
 *   → 模型（原生 tool_calls 或 JSON）返回 plan: { tools: [{name:'weekly', args:{series:'带腿高架'}}] }
 *   → 这里按名字执行对应工具，结果拼成 facts 再喂回模型
 *
 * 原则：
 *   · 每个工具只返回「回答这个问题需要的那部分」，不返回整表。
 *   · 每个工具的输出是给人看的短文本（同时给模型），所以直接复用 answer.js 的排版。
 *   · 任何一个工具失败都不能让整轮失败 —— 返回一句「读不到」让模型如实说明。
 *   · **参数必须真的生效**：旧实现里 changes/weekly 收下 series 却在返回时又调了
 *     不带参数的 answerChanges()/answerWeekly()，模型问「带腿高架这周怎么样」时
 *     实际拿到的是三条产品线混在一起的数据 —— 这是「数字对不上」的根源之一。
 */

const { log } = require('./util');
const analyze = require('./analyze');
const answer = require('./answer');
const memory = require('./memory');
const db = require('./db');
const profile = require('./profile');

const MAX_CHARS_PER_TOOL = 2400;

function clip(s) {
  const t = String(s || '').trim();
  return t.length > MAX_CHARS_PER_TOOL ? `${t.slice(0, MAX_CHARS_PER_TOOL)}…（已截断）` : t;
}

/** 归一业务分组名（来自 profile.json，不再写死产品线）。 */
function normSeries(v) {
  return profile.normSeries(v);
}

function fmtDate(iso) {
  if (!iso) return '—';
  const d = new Date(`${iso}T00:00:00+08:00`);
  if (Number.isNaN(d.getTime())) return iso;
  return `${d.getMonth() + 1}月${d.getDate()}日`;
}

// ── 各工具实现 ─────────────────────────────────────────────────

const impl = {
  /** 库存 / 售价 / 排名快照 */
  stock(args = {}) {
    const series = normSeries(args.series);
    const snap = analyze.stockSnapshot(series);
    if (!snap.length) return `库存：${series ? `「${series}」` : ''}没有读到快照数据。`;

    const date = snap[0].date;
    const lines = [`库存快照（数据日 ${fmtDate(date)}）${series ? `· ${series}` : ''}`];
    const oos = snap.filter((x) => x.oos);
    const ok = snap.filter((x) => !x.oos);

    if (oos.length) {
      lines.push(`无库存 ${oos.length} 个：` + oos.map((x) => `${x.series}/${x.name}`).join('、'));
    }
    lines.push(`有货 ${ok.length} 个：`);
    for (const x of ok) {
      const rank = x.rankBig ? ` 大类${x.rankBig}` : '';
      const price = x.priceRaw || '—';
      lines.push(`· ${x.series} / ${x.name}：${price}${rank}（ASIN ${x.asin || '—'}）`);
    }
    return lines.join('\n');
  },

  /** 运营操作（N 列） */
  ops(args = {}) {
    const days = Number(args.days) > 0 ? Math.min(Number(args.days), 60) : 7;
    const kind = args.kind || null;
    const series = normSeries(args.series);

    const list = analyze.recentOps({ days, kind, series });
    if (!list.length) {
      const last = analyze.lastOpDate(series);
      return `近 ${days} 天「调整动作」列没有${kind ? kind : ''}操作记录${series ? `（${series}）` : ''}。`
        + (last ? `最近一次有记录是 ${fmtDate(last.date)}。` : '');
    }

    return answer.answerOps({ days, kind, series });
  },

  /** 两个快照之间的变化 */
  changes(args = {}) {
    const series = normSeries(args.series);
    const list = analyze.recentChanges(series);
    if (!list.length) return `最近两个快照之间没有明显变化${series ? `（${series}）` : ''}。`;
    return answer.answerChanges({ series });
  },

  /** 周报环比 */
  weekly(args = {}) {
    const series = normSeries(args.series);
    const weeks = Number(args.weeks) > 0 ? Math.min(Number(args.weeks), 12) : null;
    const r = analyze.weeklyTrend(series, weeks);
    if (!r.periods.length) return `周报里没有${series ? `「${series}」` : ''}的数据。`;
    return answer.answerWeekly({ series, weeks });
  },

  /** 库龄 */
  aging() {
    return answer.answerAging();
  },

  /** 产品档案 */
  product(args = {}) {
    const q = String(args.query || args.name || '').trim();
    if (!q) return '需要提供产品名/ASIN/SKU/编码。';

    const hits = memory.findProducts(q, { limit: 3 });
    if (!hits.length) return `没找到匹配「${q}」的产品。已登记的产品都来自日运营表，可按编码（632/842）或颜色查。`;

    const lines = [];
    for (const p of hits) {
      const card = memory.productCard(p.id);
      lines.push(`产品：${p.name}（${p.series || '未分类'}）ASIN ${p.asin || '—'} · SKU ${p.sku || '—'}`);
      if (card.campaigns.length) {
        lines.push('  广告活动：' + card.campaigns.map((c) => c.name).join('；'));
      } else {
        lines.push('  广告活动：未登记');
      }
      if (card.notes.length) {
        lines.push('  最近笔记：' + card.notes.slice(0, 3).map((n) => `[${n.kind}] ${String(n.text).slice(0, 40)}`).join(' / '));
      }
      if (card.tasks.length) {
        lines.push('  相关提醒：' + card.tasks.slice(0, 3).map((t) => `${fmtDate(t.due.slice(0, 10))} ${t.title}`).join(' / '));
      }
    }
    return lines.join('\n');
  },

  /** 广告活动 */
  campaign(args = {}) {
    const q = String(args.query || args.name || '').trim();
    const productQ = String(args.product || '').trim();

    let list = [];
    if (q) list = memory.findCampaigns(q, { limit: 8 });
    if (productQ) {
      for (const p of memory.findProducts(productQ, { limit: 2 })) {
        list = list.concat(db.listCampaigns({ productId: p.id }));
      }
    }
    if (!list.length && !q && !productQ) list = db.listCampaigns({ limit: 15 });

    if (!list.length) {
      return `没找到广告活动${q ? `「${q}」` : ''}。可先问「${productQ || '某个产品'} 有哪些广告活动」。`;
    }

    const seen = new Set();
    const lines = ['广告活动：'];
    for (const c of list) {
      if (seen.has(c.id)) continue;
      seen.add(c.id);
      const p = c.productId ? db.getProduct(c.productId) : null;
      lines.push(`· ${c.name}`);
      lines.push(`  类型 ${c.type || '—'} · 状态 ${c.status || '—'} · 产品 ${p ? p.name : '未归属'}`);
      if (c.note) lines.push(`  ${String(c.note).slice(0, 120)}`);
    }
    return lines.join('\n');
  },

  /** 笔记 */
  notes(args = {}) {
    const limit = Number(args.limit) > 0 ? Math.min(Number(args.limit), 20) : 8;
    const list = args.query
      ? db.search(args.query, { kinds: ['note'], limit }).map((x) => x.item)
      : db.listNotes({ kind: args.kind || null, limit });

    if (!list.length) return '没有相关笔记。';
    return ['笔记：']
      .concat(list.map((n) => `· [${n.kind}] ${fmtDate((n.createdAt || '').slice(0, 10))} ${String(n.text).slice(0, 160)}${n.analysis ? `\n  ${String(n.analysis).slice(0, 120)}` : ''}`))
      .join('\n');
  },

  /** 任务查询（大任务量下按需取） */
  task(args = {}) {
    const limit = Number(args.limit) > 0 ? Math.min(Number(args.limit), 30) : 10;

    let list;
    if (args.query) {
      list = db.search(args.query, { kinds: ['task'], limit }).map((x) => x.item)
        .filter((t) => (args.done === true ? t.done : !t.done));
    } else {
      list = db.listTasks({ done: args.done === true ? true : false, limit });
    }

    if (!list.length) return args.query ? '没有匹配的提醒。' : '没有待发提醒。';
    const counts = db.taskCounts();
    return [`待发提醒 ${counts.open} 条，相关的 ${list.length} 条：`]
      .concat(list.map((t) => `· ${fmtDate(t.due.slice(0, 10))} ${t.due.slice(11, 16)} ${t.title}`))
      .join('\n');
  },
};

// ── 执行 ───────────────────────────────────────────────────────

const ALLOWED = new Set(Object.keys(impl));

/**
 * 执行一组工具调用。
 *
 * 两个省钱点：
 *   1. 去重：同一工具 + 同一参数本轮只跑一次。
 *      （不同参数仍会跑，例如先查方形再查带腿）
 *   2. 先把旧实现里「读一次表再读一次表」的浪费消掉：weekly/changes/ops
 *      各自都会拉整张日运营/周报表，同一轮里连着调用就是重复 IO。
 *      数据层已有 TTL 缓存，这里再加一层「同名字段去重」就够了。
 *
 * @param {Array<{name:string,args:object}>} calls
 * @returns {{facts:string, used:Array, failed:Array}}
 */
function run(calls) {
  const used = [];
  const failed = [];
  const parts = [];
  const seen = new Set();

  for (const c of Array.isArray(calls) ? calls.slice(0, 6) : []) {
    const name = String(c && c.name || '').trim();
    if (!name) continue;
    if (!ALLOWED.has(name)) {
      failed.push({ name, error: '未知工具' });
      continue;
    }

    // 去重键：工具名 + 归一化后的参数（series 先归一，避免「带腿」和「带腿高架」跑两遍）
    const args = { ...(c.args || {}) };
    if (args.series) args.series = normSeries(args.series) || args.series;
    const sig = `${name}:${JSON.stringify(args, Object.keys(args).sort())}`;

    if (seen.has(sig)) continue;
    seen.add(sig);

    try {
      const out = impl[name](args);
      used.push(name);
      if (out) parts.push(`【${name}${args.series ? `·${args.series}` : ''}】${clip(out)}`);
    } catch (e) {
      log('WARN', `tool ${name} failed: ${e.message}`);
      failed.push({ name, error: e.message });
      // 读失败要如实说「读取失败」，不能装成「没有数据」
      parts.push(`【${name}】读取失败：${e.message}`);
    }
  }

  return { facts: parts.join('\n\n'), used, failed };
}

/** 工具名 → 说明（给 prompt 用）。 */
function describe() {
  return Object.keys(impl);
}

module.exports = { run, impl, describe, ALLOWED, normSeries };
