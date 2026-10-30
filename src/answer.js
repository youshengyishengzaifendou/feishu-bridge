'use strict';

/**
 * 作答层：把 analyze.js 的结果拼成飞书消息。
 * 只负责排版，不做判断、不读表格。
 */

const {
  recentOps, lastOpDate, recentChanges,
  weeklyTrend, stockSnapshot, agingSummary, freshness, condense, campaignsIn,
} = require('./analyze');

const KIND_ORDER = ['广告', '促销', '价格', '库存', '其他'];

function fmtDate(iso) {
  if (!iso) return '—';
  const d = new Date(`${iso}T00:00:00+08:00`);
  if (Number.isNaN(d.getTime())) return iso;
  return `${d.getMonth() + 1}月${d.getDate()}日`;
}

// ── 运营操作 ───────────────────────────────────────────────────

/**
 * 「上周做了什么操作」
 * @param {{days?:number, kind?:string, series?:string}} opts
 */
function answerOps({ days = 7, kind = null, series = null } = {}) {
  const ops = recentOps({ days, kind, series });
  const lines = [];

  const title = kind ? `【近 ${days} 天·${kind}操作】` : `【近 ${days} 天运营操作】`;
  lines.push(title);

  if (!ops.length) {
    const last = lastOpDate(series);
    lines.push('');
    lines.push(`这段时间「调整动作」列没有记录${series ? `（${series}）` : ''}。`);
    if (last) {
      lines.push('');
      lines.push(`最近一次有记录是 ${fmtDate(last.date)}：`);
      for (const it of last.items) {
        const k = it.action ? require('./analyze').classify(it.action) : null;
        if (k) lines.push(`· ${it.name}：${condense(it.action, 70)}`);
      }
    }
    return lines.join('\n');
  }

  lines.push(`区间 ${fmtDate(ops[0].date)} 起，共 ${ops.length} 条`);
  lines.push('');

  const grouped = new Map();
  for (const op of ops) {
    if (!grouped.has(op.kind)) grouped.set(op.kind, []);
    grouped.get(op.kind).push(op);
  }

  for (const k of KIND_ORDER) {
    const list = grouped.get(k);
    if (!list) continue;

    lines.push(`■ ${k}（${list.length}）`);
    const seen = new Set();
    for (const op of list) {
      const key = `${op.date}|${op.product}|${op.text}`;
      if (seen.has(key)) continue;
      seen.add(key);

      lines.push(`· ${fmtDate(op.date)} ${op.product}`);
      lines.push(`  ${condense(op.text, k === '广告' ? 120 : 80)}`);

      const camps = op.campaigns.length ? op.campaigns : campaignsIn(op.text);
      if (camps.length) lines.push(`  活动：${camps.join('、')}`);
    }
    lines.push('');
  }

  return lines.join('\n').trimEnd();
}

// ── 库存 ───────────────────────────────────────────────────────

function answerStock(keywords = []) {
  const snap = stockSnapshot();
  if (!snap.length) return null;

  let hits = snap;
  if (keywords.length) {
    hits = snap.filter((x) => keywords.every((k) => x.name.includes(k)));
  }
  if (!hits.length) return null;

  const date = hits[0].date;
  const lines = ['【库存】', `数据日期 ${fmtDate(date)}`, ''];

  const oos = hits.filter((x) => x.oos);
  const ok = hits.filter((x) => !x.oos);

  if (oos.length) {
    lines.push(`无库存 ${oos.length} 个：`);
    for (const x of oos) lines.push(`· ${x.series} / ${x.name}（${x.priceRaw}）`);
    lines.push('');
  }
  if (ok.length) {
    lines.push(`有货 ${ok.length} 个：`);
    for (const x of ok) {
      const rank = x.rankBig ? ` · 大类 ${x.rankBig}` : '';
      lines.push(`· ${x.series} / ${x.name}：${x.priceRaw}${rank}`);
    }
  }
  return lines.join('\n');
}

// ── 库龄 ───────────────────────────────────────────────────────

function answerAging() {
  const { date, rows, total, nearTotal } = agingSummary();

  const lines = ['【库龄超龄】'];
  if (date) lines.push(`统计日期 ${fmtDate(date)}`);
  lines.push('');

  if (!rows.length || total === 0) {
    lines.push('没有超 180 天的库存。');
    return lines.join('\n');
  }

  lines.push(`已超 180 天合计 ${total} 件：`);
  lines.push('');
  for (const r of rows) {
    if (!r.over) continue;
    lines.push(`· ${r.name}：${r.over} 件`);
    const parts = [];
    if (r.d181_210) parts.push(`181-210天 ${r.d181_210}`);
    if (r.d211_270) parts.push(`211-270天 ${r.d211_270}`);
    if (r.d271_365) parts.push(`271-365天 ${r.d271_365}`);
    if (r.d365plus) parts.push(`365天+ ${r.d365plus}`);
    if (parts.length) lines.push(`  ${parts.join(' · ')}`);
    if (r.near) lines.push(`  另有 151-180天 ${r.near} 件即将超期`);
  }

  if (nearTotal) {
    lines.push('');
    lines.push(`合计临近超期（151-180天）${nearTotal} 件。`);
  }
  return lines.join('\n');
}

// ── 概览 ───────────────────────────────────────────────────────

function answerOverview() {
  const ops = recentOps({ days: 7 });
  const { latest, gapDays } = freshness();
  const { date: ageDate, total: over180 } = agingSummary();
  const snap = stockSnapshot();
  const oosCount = snap.filter((x) => x.oos).length;

  const lines = ['【运营概览】', ''];

  lines.push('■ 数据');
  lines.push(`· 日运营最新 ${fmtDate(latest)}${gapDays > 1 ? `（${gapDays} 天未更新）` : ''}`);
  if (ageDate) lines.push(`· 库龄统计 ${fmtDate(ageDate)}`);
  lines.push('');

  lines.push('■ 本周操作');
  if (ops.length) {
    const byKind = {};
    for (const o of ops) byKind[o.kind] = (byKind[o.kind] || 0) + 1;
    lines.push(`· 共 ${ops.length} 条：` + Object.entries(byKind).map(([k, v]) => `${k} ${v}`).join('、'));
  } else {
    lines.push('· 无记录');
  }
  lines.push('');

  lines.push('■ 库存');
  lines.push(`· 无库存 ${oosCount} 个`);
  lines.push(`· 超 180 天 ${over180} 件`);

  return lines.join('\n');
}

// ── 周报分析 ───────────────────────────────────────────────────

const pct = (x) => (x == null ? '—' : `${x > 0 ? '+' : ''}${x.toFixed(1)}%`);

/**
 * 周报环比分析。
 * @param {{series?:string, weeks?:number}} opts  series 指定产品线
 */
function answerWeekly({ series = null, weeks = null } = {}) {
  const r = weeklyTrend(series, weeks);

  if (!r.periods.length) {
    return `周报表里没有${series ? `「${series}」` : ''}的数据。`;
  }

  const head = series ? `【周报分析·${series}】` : '【周报分析】';
  const lines = [head, ''];

  if (!r.cur || !r.prev) {
    lines.push(`只有 ${r.periods.length} 个周期，无法环比。`);
    lines.push('');
    for (const p of r.periods) {
      const rev = p.items.reduce((s, x) => s + (x.revenue || 0), 0);
      const qty = p.items.reduce((s, x) => s + (x.qty || 0), 0);
      lines.push(`· ${p.label}：销量 ${qty} · 销售额 $${rev.toFixed(2)}`);
    }
    return lines.join('\n');
  }

  const c = r.cur;
  const p = r.prev;

  lines.push(`对比 ${p.label} → ${c.label}`);
  lines.push('');
  lines.push('■ 整体');
  lines.push(`· 销量 ${p.totalQty} → ${c.totalQty}（${pct(p.totalQty ? ((c.totalQty - p.totalQty) / p.totalQty) * 100 : null)}）`);
  lines.push(`· 销售额 $${p.totalRevenue.toFixed(0)} → $${c.totalRevenue.toFixed(0)}（${pct(p.totalRevenue ? ((c.totalRevenue - p.totalRevenue) / p.totalRevenue) * 100 : null)}）`);
  lines.push(`· 利润 $${p.totalProfit.toFixed(0)} → $${c.totalProfit.toFixed(0)}`);
  lines.push('');

  lines.push('■ 分产品（按销售额排序）');
  for (const t of r.trend) {
    lines.push(`· ${t.name}`);
    lines.push(`  ${t.qty} 件（${t.dQty > 0 ? '+' : ''}${t.dQty}）· $${(t.revenue || 0).toFixed(0)} · 毛利率 ${t.margin}%`);
    if (t.dMargin != null && Math.abs(t.dMargin) >= 1) {
      lines.push(`  毛利率${t.dMargin > 0 ? '↑' : '↓'} ${Math.abs(t.dMargin).toFixed(1)} 个百分点`);
    }
  }
  lines.push('');

  // 异常提示
  const drops = r.trend.filter((t) => t.qtyPct != null && t.qtyPct <= -40);
  const rises = r.trend.filter((t) => t.qtyPct != null && t.qtyPct >= 60);
  const lowMargin = r.trend.filter((t) => t.margin != null && t.margin < 8);

  if (drops.length || rises.length || lowMargin.length) {
    lines.push('■ 值得注意');
    for (const t of drops) lines.push(`· ${t.name} 销量下滑 ${Math.abs(t.qtyPct).toFixed(0)}%（${t.dQty} 件）`);
    for (const t of rises) lines.push(`· ${t.name} 销量增长 ${t.qtyPct.toFixed(0)}%`);
    for (const t of lowMargin) lines.push(`· ${t.name} 毛利率仅 ${t.margin}%，偏低`);
  }

  return lines.join('\n').trimEnd();
}

function answerChanges({ series = null } = {}) {
  const changes = recentChanges(series);
  if (!changes.length) return `最近两个快照之间没有明显变化${series ? `（${series}）` : ''}（价格 ≥0.5%、排名 ≥20% 才计入）。`;

  const lines = [series ? `【近期变化·${series}】` : '【近期变化】', ''];
  const KIND = { oos: '断货', restock: '恢复有货', price: '价格', rank: '排名' };
  const grouped = new Map();
  for (const c of changes) {
    const k = KIND[c.kind] || c.kind;
    if (!grouped.has(k)) grouped.set(k, []);
    grouped.get(k).push(c);
  }
  for (const [k, list] of grouped) {
    lines.push(`■ ${k}（${list.length}）`);
    for (const c of list) lines.push(`· ${c.series} / ${c.name}：${c.detail}`);
    lines.push('');
  }
  return lines.join('\n').trimEnd();
}

module.exports = {
  answerOps, answerStock, answerAging, answerOverview, answerChanges, answerWeekly,
};
