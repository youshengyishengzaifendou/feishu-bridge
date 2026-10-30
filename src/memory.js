'use strict';

/**
 * 记忆层 —— 产品档案 + 广告活动归属
 *
 * 解决的问题：
 *   1. 产品不再是「表格里的一行文字」，而是有 ASIN/SKU/别名/产品线的实体，
 *      后续所有笔记、任务、广告活动都能挂到它上面。
 *   2. 广告活动必须指向一个具体产品。活动名形如
 *      `ACME-SP-101白色-auto紧密-20261012`，
 *      里面藏着编码（101）、颜色（白色）、产品线代号，
 *      这里用规则把活动名反解到产品；解不出来就显式记成「未归属」，
 *      由 AI 或人工补，不猜。
 *
 * 为什么不用向量库：
 *   这里的匹配是「结构化别名命中」（编码 632 / 颜色 / SKU / ASIN），
 *   精确度要求高、候选集小（十几个产品）。FTS + 编码规则比 embedding 更准也更便宜。
 *   真正需要语义模糊匹配的是「用户这句话提到哪个产品」，
 *   那个入口是 db.search()，将来换 embedding 只改那一处。
 */

const db = require('./db');
const profile = require('./profile');

// ── 产品识别 ───────────────────────────────────────────────────

// 关键词 → 业务分组（来自 profile.json 的 series.key + aliases）。
// 没有配 profile 时为空表：活动归属只做全名/ASIN/SKU 精确命中，不猜线。
function seriesHints() {
  return profile.get().series
    .filter((s) => s.key)
    .map((s) => {
      const words = [s.key, ...(s.aliases || [])].filter(Boolean)
        .map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
      return { re: new RegExp(words.join('|'), 'i'), series: s.key };
    });
}

const COLOR_WORDS = ['白色', '胡桃', '棕色', '绿色', '白', '棕', '绿'];
const SIZE_RE = /([123])\s*个装/;
// 亚马逊广告活动名里常用 1P/2P/3P 表示装数，如 `ACME-SP-2P白-raised bed`
const PACK_SHORT_RE = /\b([123])\s*P(?=[\-\s白胡棕绿]|$)/i;

/** 从广告活动名里抽出产品线索。 */
function parseCampaignName(name) {
  const s = String(name || '');
  const out = { series: null, code: null, color: null, pack: null, type: null };

  // 广告类型：SP / SB / SD
  const t = s.match(/-(SP|SB|SD)-/);
  if (t) out.type = t[1];
  if (/auto/i.test(s)) out.type = (out.type || 'SP') + '-auto';
  else if (/广泛|broad/i.test(s)) out.type = (out.type || 'SP') + '-broad';
  else if (/精确|紧密|exact|phrase/i.test(s)) out.type = (out.type || 'SP') + '-exact';

  for (const h of seriesHints()) if (h.re.test(s)) { out.series = h.series; break; }

  // 编码：3 位数字，如 632 / 842 / 441
  const code = s.match(/\b(\d{3})\b/);
  if (code) out.code = code[1];

  for (const c of COLOR_WORDS) {
    if (s.includes(c)) { out.color = c.length === 1 ? c + '色' : c; break; }
  }

  const pk = s.match(SIZE_RE) || s.match(PACK_SHORT_RE);
  if (pk) out.pack = Number(pk[1]);

  return out;
}

/** 产品名拆成可比较的特征。 */
function productFeatures(p) {
  const name = String(p.name || '');
  const colors = COLOR_WORDS.filter((c) => name.includes(c));
  const pk = name.match(SIZE_RE);
  const codes = name.match(/\d{3}/g) || [];
  return {
    name,
    series: p.series || null,
    colors: colors.map((c) => (c.length === 1 ? c + '色' : c)),
    pack: pk ? Number(pk[1]) : null,
    codes,
    asin: p.asin || '',
    sku: (p.sku || '').toLowerCase(),
  };
}

/**
 * 把一段文本（活动名 / 用户的话 / 产品描述）匹配到已登记产品。
 * @returns {{product:object, score:number, why:string}|null}
 */
function matchProduct(text, { series = null } = {}) {
  const s = String(text || '');
  if (!s.trim()) return null;

  const clue = parseCampaignName(s);
  const all = db.listProducts({ series: series || clue.series || null });
  if (!all.length) return null;

  let best = null;
  for (const p of all) {
    const f = productFeatures(p);
    let score = 0;
    const why = [];

    if (f.name && s.includes(f.name)) { score += 100; why.push('全名命中'); }
    if (f.asin && s.toUpperCase().includes(f.asin.toUpperCase())) { score += 90; why.push('ASIN'); }
    if (f.sku && s.toLowerCase().includes(f.sku)) { score += 80; why.push('SKU'); }
    if (clue.series && f.series === clue.series) { score += 30; why.push(`产品线${clue.series}`); }
    if (clue.code && f.codes.includes(clue.code)) { score += 40; why.push(`编码${clue.code}`); }
    if (clue.color && f.colors.includes(clue.color)) { score += 15; why.push(clue.color); }
    if (clue.pack && f.pack === clue.pack) { score += 10; why.push(`${clue.pack}个装`); }

    // 编码 + 颜色同时命中才算稳妥，单独编码容易误配（631/632 只差一位）
    if (clue.code && !f.codes.includes(clue.code)) score -= 30;
    if (clue.color && f.colors.length && !f.colors.includes(clue.color)) score -= 10;

    if (score > 0 && (!best || score > best.score)) best = { product: p, score, why: why.join('+') };
  }

  // 低于阈值视为「不确定」，宁可返回 null 让上层标注未归属
  if (!best || best.score < 40) return null;
  return best;
}

/** 按任意说法找产品（名称/别名/ASIN/SKU/编码），返回候选列表。 */
function findProducts(query, { limit = 5 } = {}) {
  const q = String(query || '').trim();
  if (!q) return [];
  const all = db.listProducts();
  const scored = [];

  for (const p of all) {
    const f = productFeatures(p);
    let score = 0;
    if (f.name === q) score += 100;
    else if (f.name.includes(q) || q.includes(f.name)) score += 60;
    if (p.aliases && p.aliases.some((a) => a && (a === q || String(a).includes(q)))) score += 50;
    if (f.asin && q.toUpperCase().includes(f.asin.toUpperCase())) score += 90;
    if (f.sku && q.toLowerCase().includes(f.sku)) score += 80;
    const codes = q.match(/\d{3}/g) || [];
    for (const c of codes) if (f.codes.includes(c)) score += 40;
    for (const c of COLOR_WORDS) if (q.includes(c) && f.colors.includes(c.length === 1 ? c + '色' : c)) score += 10;
    const pk = q.match(SIZE_RE);
    if (pk && f.pack === Number(pk[1])) score += 8;
    if (score > 0) scored.push({ product: p, score });
  }

  if (!scored.length) {
    // 兜底走一次全文检索（别名、备注里的内容）
    for (const hit of db.search(q, { kinds: ['product'], limit })) {
      scored.push({ product: hit.item, score: 20 });
    }
  }

  return scored.sort((a, b) => b.score - a.score).slice(0, limit).map((x) => x.product);
}

// ── 广告活动登记 ───────────────────────────────────────────────

/**
 * 登记（或更新）一个广告活动，并把它挂到产品上。
 *
 * @param {{name:string, productId?:string, productName?:string, type?:string, note?:string}} c
 * @returns {{campaign:object, product:object|null, resolvedBy:string}}
 */
function recordCampaign(c) {
  const name = String(c.name || '').trim();
  if (!name) throw new Error('广告活动名不能为空');

  let product = null;
  let resolvedBy = 'none';

  if (c.productId) {
    product = db.getProduct(c.productId);
    if (product) resolvedBy = 'explicit-id';
  }
  if (!product && c.productName) {
    const hits = findProducts(c.productName, { limit: 1 });
    if (hits.length) {
      product = hits[0];
      resolvedBy = 'explicit-name';
    }
  }
  if (!product) {
    // 从活动名反解
    const m = matchProduct(name);
    if (m) {
      product = m.product;
      resolvedBy = `campaign-name(${m.why})`;
    }
  }

  const existing = db.getCampaign(name);
  const clue = parseCampaignName(name);

  const saved = db.putCampaign({
    id: existing ? existing.id : name,
    name,
    type: c.type || clue.type || (existing ? existing.type : null),
    status: c.status || (existing ? existing.status : 'active'),
    productId: product ? product.id : (existing ? existing.productId : null),
    note: c.note || (existing ? existing.note : ''),
  });

  return {
    campaign: saved,
    product: product || (saved.productId ? db.getProduct(saved.productId) : null),
    resolvedBy,
  };
}

/** 找广告活动：先按名字精确/模糊，再落到产品维度的全部活动。 */
function findCampaigns(query, { limit = 8 } = {}) {
  const q = String(query || '').trim();
  if (!q) return [];

  const all = db.listCampaigns({ limit: 500 });
  const scored = [];
  for (const c of all) {
    let score = 0;
    if (c.name === q) score += 100;
    else if (c.name.includes(q)) score += 70;
    else if (q.includes(c.name)) score += 60;

    const clue = parseCampaignName(q);
    const fc = parseCampaignName(c.name);
    if (clue.code && fc.code === clue.code) score += 25;
    if (clue.type && fc.type === fc.type) { /* noop */ }
    if (score > 0) scored.push({ c, score });
  }

  if (!scored.length) {
    for (const hit of db.search(q, { kinds: ['campaign'], limit })) {
      scored.push({ c: hit.item, score: 20 });
    }
  }

  // 还能通过产品间接找到：问「632 的广告」时，活动名里可能没有 632
  if (!scored.length) {
    const prods = findProducts(q, { limit: 2 });
    for (const p of prods) {
      for (const c of db.listCampaigns({ productId: p.id, limit })) {
        scored.push({ c, score: 15 });
      }
    }
  }

  return scored.sort((a, b) => b.score - a.score).slice(0, limit).map((x) => x.c);
}

// ── 产品首入册 ─────────────────────────────────────────────────

/**
 * 从飞书表格里的产品名批量登记产品（幂等）。
 * 表格是产品档案的第一来源：名字、ASIN、SKU 都从那里来。
 */
function syncFromSheets() {
  const data = require('./data');
  const blocks = data.loadDaily();
  const seen = new Map();

  for (const b of blocks) {
    for (const it of b.items) {
      const key = `${b.series}|${it.name}`;
      if (!seen.has(key)) {
        seen.set(key, { name: it.name, series: b.series, asin: it.asin, sku: it.sku });
      } else {
        const v = seen.get(key);
        if (!v.asin && it.asin) v.asin = it.asin;
        if (!v.sku && it.sku) v.sku = it.sku;
      }
    }
  }

  const added = [];
  for (const v of seen.values()) {
    if (!v.name) continue;
    const exists = db.listProducts().find((p) => p.name === v.name && p.series === v.series);
    if (exists) {
      // 补齐缺失的 ASIN/SKU
      if ((!exists.asin && v.asin) || (!exists.sku && v.sku)) {
        db.putProduct({ ...exists, asin: exists.asin || v.asin, sku: exists.sku || v.sku });
      }
      continue;
    }
    db.putProduct({
      id: db.slug(`${v.series}-${v.name}`),
      name: v.name,
      series: v.series,
      asin: v.asin,
      sku: v.sku,
      aliases: [v.name, v.asin, v.sku].filter(Boolean),
      note: '',
    });
    added.push(v.name);
  }

  return { total: db.listProducts().length, added };
}

/** 某个产品的完整视图：档案 + 活动 + 最近笔记 + 相关任务。 */
function productCard(id) {
  const p = db.getProduct(id);
  if (!p) return null;
  return {
    product: p,
    campaigns: db.listCampaigns({ productId: id, limit: 50 }),
    notes: db.listNotes({ productId: id, limit: 10 }),
    tasks: db.listTasks({ productId: id, limit: 10 }),
  };
}

module.exports = {
  parseCampaignName, productFeatures, matchProduct, findProducts,
  recordCampaign, findCampaigns, syncFromSheets, productCard,
};
