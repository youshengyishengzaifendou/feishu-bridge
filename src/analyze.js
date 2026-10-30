'use strict';

/**
 * 分析层：把 data.js 的原始行，提炼成「操作」「变化」「概览」。
 * 这一层只做判断，不碰 lark-cli 调用，也不拼消息。
 */

const { loadDaily, loadWeekly, loadAging, daysAgoISO } = require('./data');

/** 某条产品线的最新数据日（各线更新节奏不同，不能取全表最大值）。 */
function seriesLatestDate(seriesLabel) {
  let latest = null;
  for (const b of loadDaily()) {
    if (seriesLabel && b.series !== seriesLabel) continue;
    if (!latest || b.date > latest) latest = b.date;
  }
  return latest;
}

/** 数据新鲜度（可用 series 限定）。 */
function freshness(seriesLabel = null) {
  const latest = seriesLatestDate(seriesLabel);
  if (!latest) return { latest: null, gapDays: null };
  const t = Date.parse(`${latest}T00:00:00+08:00`);
  const gap = Math.floor((Date.now() - t) / 86400000);
  return { latest, gapDays: gap };
}

// ── 操作归类 ───────────────────────────────────────────────────
// 一条记录只归一个主类，避免同一内容在多处重复出现。

const RULES = [
  { kind: '广告', re: /广告|竞价|出价|CPC|PPC|ACOS|预算|投放|关键词|否定|曝光|点击|展示量|转化/i },
  { kind: '促销', re: /促销|折扣|优惠|秒杀|BD|LD|黑五|网一|deal|coupon|满减|参加/ },
  { kind: '价格', re: /价格|售价|降|涨|调价|改价|\$\d|美金/ },
  { kind: '库存', re: /库存|补货|断货|发货|入库|到货|库龄/ },
];

function classify(text) {
  const t = String(text || '').trim();
  if (!t || t === '-' || t === '—') return null;
  for (const r of RULES) {
    if (r.re.test(t)) return r.kind;
  }
  return '其他';
}

/** 提取文本里的广告活动名（形如 ACME-SP-101白色-auto紧密-20261012） */
function campaignsIn(text) {
  const out = new Set();
  const s = String(text || '');
  // 带 -SP- / -SB- / -SD- 的完整活动名
  let m;
  const re = /[A-Za-z][\w\- ]{1,40}?-(SP|SB|SD)-[\w\-\u4e00-\u9fa5]{1,40}/g;
  while ((m = re.exec(s))) out.add(m[0].trim());
  return Array.from(out);
}

/** 把长文本压成要点，保留含关键信息的句子 */
function condense(text, maxLen = 110) {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  if (t.length <= maxLen) return t;

  const parts = t.split(/[。；;!！?？]/).map((x) => x.trim()).filter(Boolean);
  const key = parts.filter((p) => /20\d{2}|月\d{1,2}|号|\d+\s*(美金|天|单|个|件)|[A-Za-z]{2,}.*-SP-|BD|LD|广告|折扣|库存/.test(p));

  const picked = [];
  let len = 0;
  for (const p of (key.length ? key : parts)) {
    if (len + p.length > maxLen) break;
    picked.push(p);
    len += p.length + 1;
  }
  if (!picked.length) return t.slice(0, maxLen) + '…';
  const out = picked.join('；');
  return out.length < t.length ? out + '…' : out;
}

// ── 操作提取 ───────────────────────────────────────────────────

/**
 * 提取近 N 天「调整动作（N 列）」里的操作。
 * @param {{days?:number, kind?:string, series?:string}} opts  kind 指定只看某一类
 * @returns {Array<{date,series,product,kind,text,campaigns}>}
 */
function recentOps({ days = 7, kind = null, series = null } = {}) {
  const since = daysAgoISO(days);
  const out = [];

  for (const block of loadDaily()) {
    if (block.date < since) continue;
    if (series && block.series !== series) continue;
    for (const it of block.items) {
      if (!it.action) continue;
      const k = classify(it.action);
      if (!k) continue;
      if (kind && k !== kind) continue;

      out.push({
        date: block.date,
        series: block.series,
        product: it.name,
        kind: k,
        text: it.action,
        campaigns: campaignsIn(it.action),
      });
    }
  }
  return out;
}

/** 最近一次有操作记录是哪天（用于「这段时间没记录」时给个参照） */
function lastOpDate(series = null) {
  const all = loadDaily();
  for (let i = all.length - 1; i >= 0; i--) {
    if (series && all[i].series !== series) continue;
    if (all[i].items.some((it) => classify(it.action))) return all[i];
  }
  return null;
}

// ── 变化检测 ───────────────────────────────────────────────────

/**
 * 对比最近两个日期块，找出价格/排名/库存变化。
 * 用同一产品线（series）内部对比，避免跨线错配。
 * @param {string} [onlySeries] 只比某条产品线
 */
function recentChanges(onlySeries = null) {
  const blocks = loadDaily();
  const bySeries = new Map();
  for (const b of blocks) {
    if (onlySeries && b.series !== onlySeries) continue;
    if (!bySeries.has(b.series)) bySeries.set(b.series, []);
    bySeries.get(b.series).push(b);
  }

  const changes = [];

  for (const [series, list] of bySeries) {
    if (list.length < 2) continue;
    const prev = list[list.length - 2];
    const cur = list[list.length - 1];
    const pmap = new Map(prev.items.map((x) => [x.asin || x.name, x]));

    for (const c of cur.items) {
      const p = pmap.get(c.asin || c.name);
      if (!p) continue;

      if (!p.oos && c.oos) changes.push({ series, kind: 'oos', name: c.name, detail: '变为无库存' });
      if (p.oos && !c.oos) changes.push({ series, kind: 'restock', name: c.name, detail: `恢复有货 ${c.priceRaw}` });

      if (p.price != null && c.price != null && p.price > 0) {
        const pct = ((c.price - p.price) / p.price) * 100;
        if (Math.abs(pct) >= 0.5) {
          changes.push({
            series, kind: 'price', name: c.name,
            detail: `${p.price} → ${c.price}（${pct > 0 ? '+' : ''}${pct.toFixed(1)}%）`,
          });
        }
      }

      if (p.rankBig && c.rankBig) {
        const pct = ((c.rankBig - p.rankBig) / p.rankBig) * 100;
        if (Math.abs(pct) >= 20) {
          changes.push({
            series, kind: 'rank', name: c.name,
            detail: `大类 ${p.rankBig} → ${c.rankBig}（${pct > 0 ? '下滑' : '上升'} ${Math.abs(pct).toFixed(0)}%）`,
          });
        }
      }
    }
  }
  return changes;
}

// ── 周报分析 ───────────────────────────────────────────────────

/**
 * 周报环比分析：拿最近两个周期比销量/销售额/毛利率。
 * @param {string} [seriesLabel] 指定产品线
 * @param {number} [weeks] 只看最近 N 个周期
 */
function weeklyTrend(seriesLabel, weeks = null) {
  let periods = loadWeekly(seriesLabel);

  if (!seriesLabel) {
    // 未指定产品线时，按最新周期聚合各产品线（否则跨线混比会错）
    const byPeriod = new Map();
    for (const p of periods) {
      // 周期文本（label）在同一周各线相同，用它做聚合键
      const key = p.label;
      if (!byPeriod.has(key)) byPeriod.set(key, { label: key, start: p.start, end: p.end, series: 'all', items: [] });
      const agg = byPeriod.get(key);
      for (const it of p.items) agg.items.push(it);
    }
    periods = Array.from(byPeriod.values()).sort((a, b) => a.start.localeCompare(b.start));
    if (weeks && weeks > 0) periods = periods.slice(-weeks);
    return buildTrend(periods, '全部');
  }

  if (weeks && weeks > 0) periods = periods.slice(-weeks);
  return buildTrend(periods, seriesLabel);
}

/** 从周期列表构建环比 */
function buildTrend(periods, label) {
  if (periods.length < 2) return { periods, trend: [], series: label };
  const prev = periods[periods.length - 2];
  const cur = periods[periods.length - 1];
  const sum = (p, key) => p.items.reduce((s, x) => s + (x[key] || 0), 0);
  const prevMap = new Map(prev.items.map((x) => [x.name, x]));
  const trend = [];

  for (const it of cur.items) {
    const p = prevMap.get(it.name);
    if (!p) continue;
    const dQty = (it.qty || 0) - (p.qty || 0);
    const qtyPct = p.qty ? (dQty / p.qty) * 100 : null;
    const dRev = (it.revenue || 0) - (p.revenue || 0);
    const revPct = p.revenue ? (dRev / p.revenue) * 100 : null;
    const dMargin = (it.margin || 0) - (p.margin || 0);
    trend.push({
      name: it.name, qty: it.qty, dQty, qtyPct,
      revenue: it.revenue, dRev, revPct,
      margin: it.margin, dMargin, profit: it.profit,
    });
  }

  trend.sort((a, b) => (b.revenue || 0) - (a.revenue || 0));

  return {
    series: label,
    periods,
    cur: { ...cur, totalQty: sum(cur, 'qty'), totalRevenue: sum(cur, 'revenue'), totalProfit: sum(cur, 'profit') },
    prev: { ...prev, totalQty: sum(prev, 'qty'), totalRevenue: sum(prev, 'revenue'), totalProfit: sum(prev, 'profit') },
    trend,
  };
}

// ── 库存快照 ───────────────────────────────────────────────────

/** 最新一天的库存状况（每个系列只取最后一天，产品去重） */
function stockSnapshot(onlySeries = null) {
  const blocks = loadDaily();
  const latestBySeries = new Map();
  for (const b of blocks) {
    if (onlySeries && b.series !== onlySeries) continue;
    const cur = latestBySeries.get(b.series);
    if (!cur || b.date > cur.date) latestBySeries.set(b.series, b);
  }

  const out = [];
  const seen = new Set();
  for (const [series, b] of latestBySeries) {
    for (const it of b.items) {
      const key = `${series}|${it.name}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ series, date: b.date, ...it });
    }
  }
  return out;
}

/** 库龄汇总 */
function agingSummary() {
  const { date, rows } = loadAging();
  const total = rows.reduce((s, r) => s + r.over, 0);
  const nearTotal = rows.reduce((s, r) => s + r.near, 0);
  return { date, rows, total, nearTotal };
}

module.exports = {
  classify, campaignsIn, condense, RULES,
  recentOps, lastOpDate, recentChanges,
  weeklyTrend, stockSnapshot, agingSummary, freshness, seriesLatestDate,
};
