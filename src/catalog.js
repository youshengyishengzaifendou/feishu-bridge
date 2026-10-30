'use strict';

/**
 * 数据目录（catalog）—— 给模型看的「有什么数据」说明书
 *
 * 这是对「每次来消息都实时读飞书表格」的替代：
 *
 *   之前：每条消息都把日运营/周报/库龄整表读一遍，压成几行塞进 prompt。
 *         慢（13 次 lark-cli）、贵（prompt 上万 token）、且大部分数据用不上。
 *
 *   现在：prompt 里只放一份「目录」——有哪些表、哪些业务分组、覆盖到哪天、
 *         有哪些查询工具。模型先判断「这个问题要看哪张表」，再调 tools.js。
 *
 * 目录内容全部来自 profile.json —— 没有写死的店铺名、产品线、表名。
 * profile 没配表时目录只剩实体库和提醒，读表工具不出现在清单里。
 *
 * 关键性能约束：目录本身绝不能阻塞一条消息。
 *   一张日运营表 = 3 个 sheet × 3 次 lark-cli ≈ 1.8 秒（实测）。
 *   目录里那点「最新日期」是锦上添花，用 staleWhileRevalidate 后台刷新：
 *   第一次没读到就先写「（后台刷新中）」，模型照样能规划，数据照样由工具去取。
 */

const { staleWhileRevalidate, cached, cachedOrMiss } = require('./cache');
const data = require('./data');
const db = require('./db');
const profile = require('./profile');
const { log } = require('./util');

const CATALOG_TTL = 10 * 60000;
const COVERAGE_TTL = 10 * 60000;

/**
 * 业务分组（与 profile.series 同步；旧代码里叫 SERIES）。
 * memory.js 用它做产品归属，测试也引用它。
 */
let SERIES = [];
function refreshSeries() {
  SERIES = profile.get().series.map((s) => ({ key: s.key, desc: s.desc || '' }));
  return SERIES;
}
refreshSeries();

/** 表是否可用 + 标签（目录行、覆盖信息都用它）。 */
function tableLabel(kind, fallback) {
  if (!data.hasTable(kind)) return null;
  const t = profile.get().tables[kind];
  return (t && t.label) || fallback;
}

/**
 * 可用的数据工具清单 —— 直接写进 prompt，让模型知道能要什么。
 * name 必须和 tools.js 的 exports 对齐。
 *
 * 表类工具（stock/ops/changes/weekly/aging）只在 profile 配了对应表后才出现。
 */
function toolList() {
  const tools = [];

  if (data.hasTable('daily')) {
    tools.push(
      {
        name: 'stock',
        args: '{series?}',
        desc: '最新一天的库存/售价/排名快照。问「有没有货」「售价多少」「排名如何」「哪个断货了」用这个。',
      },
      {
        name: 'ops',
        args: '{days?, kind?, series?}',
        desc: '日运营表「调整动作」列里的运营操作记录。kind 可选 广告/促销/价格/库存/其他。问「上周做了什么」「调过价吗」「广告动过哪些」用这个。',
      },
      {
        name: 'changes',
        args: '{series?}',
        desc: '最近两个日期快照之间的变化（断货/恢复/价格变动≥0.5%/排名变动≥20%）。问「这两天有什么变化」用这个。',
      },
    );
  }
  if (data.hasTable('weekly')) {
    tools.push({
      name: 'weekly',
      args: '{series?, weeks?}',
      desc: '周报：销量、销售额、成本、毛利、毛利率，可按周期环比。问「毛利率多少」「销量涨了吗」「是不是在赔钱」用这个。',
    });
  }
  if (data.hasTable('aging')) {
    tools.push({
      name: 'aging',
      args: '{}',
      desc: '库龄表：各 SKU 超期库存件数、临近超期。问「库龄压力」「超龄多少」用这个。',
    });
  }

  tools.push(
    {
      name: 'product',
      args: '{query}',
      desc: '按名称/ASIN/SKU/编码找产品档案（含该产品的广告活动、最近笔记）。问某个具体产品时先查这个。',
    },
    {
      name: 'campaign',
      args: '{query?, product?}',
      desc: '广告活动档案，以及它归属哪个产品。问「某个广告活动」用这个。',
    },
    {
      name: 'notes',
      args: '{query?, kind?, limit?}',
      desc: '历史上记下的笔记（广告分析/运营记录/活动登记）。问「之前记过什么」用这个。',
    },
    {
      name: 'task',
      args: '{query?, limit?}',
      desc: '已有提醒的检索（待发/已完成）。问「我有哪些提醒」「记得那个 X 吗」用这个。',
    },
  );

  return tools;
}

/** 旧代码/测试按常量引用的 TOOLS —— 每次取时按当前 profile 过滤。
 *  用 Proxy 包一层：catalog.TOOLS.length / .map(...) 的用法保持不变，
 *  但内容跟着 profile 配的表实时走。setup 之后调用 refreshSeries() 即可生效。 */
const TOOLS = new Proxy([], {
  get(_, prop) {
    return toolList()[prop];
  },
  has(_, prop) {
    return prop in toolList();
  },
  ownKeys() {
    const list = toolList();
    return list.map((_, i) => String(i)).concat(['length']);
  },
  getOwnPropertyDescriptor(_, prop) {
    const list = toolList();
    return prop in list ? { enumerable: true, configurable: true, value: list[prop] } : undefined;
  },
});

function fmtDate(iso) {
  if (!iso) return '—';
  const d = new Date(`${iso}T00:00:00+08:00`);
  if (Number.isNaN(d.getTime())) return iso;
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

/** 只读缓存里已有的覆盖信息；没有就返回占位，由后台任务补齐。 */
function dailyCoverage() {
  if (!data.hasTable('daily')) return null;
  const blocks = staleWhileRevalidate('daily', () => data.loadDaily(), COVERAGE_TTL);
  if (!blocks || !blocks.length) return '（后台刷新中）';
  const first = blocks[0].date;
  const last = blocks[blocks.length - 1].date;
  const gap = Math.floor((Date.now() - Date.parse(`${last}T00:00:00+08:00`)) / 86400000);
  return `${fmtDate(first)} 至 ${fmtDate(last)}${gap > 1 ? `（最新一条滞后 ${gap} 天）` : ''}`;
}

function weeklyCoverage() {
  if (!data.hasTable('weekly')) return null;
  const periods = staleWhileRevalidate('weekly:all', () => data.loadWeekly(), COVERAGE_TTL);
  if (!periods || !periods.length) return '（后台刷新中）';
  const labels = Array.from(new Set(periods.map((p) => p.label)));
  return `${labels.slice(-3).join('、')}${labels.length > 3 ? ` 等 ${labels.length} 个周期` : ''}`;
}

function agingCoverage() {
  if (!data.hasTable('aging')) return null;
  const a = staleWhileRevalidate('aging', () => data.loadAging(), COVERAGE_TTL);
  if (!a || !a.date) return '（后台刷新中）';
  const total = a.rows.reduce((s, r) => s + r.over, 0);
  return `统计日 ${fmtDate(a.date)}，超期合计 ${total} 件`;
}

/** 预热：让后台把已配置的表读一遍，之后目录里的覆盖信息就是热的。 */
function warmCoverage() {
  setImmediate(() => {
    const jobs = [];
    if (data.hasTable('daily')) jobs.push(['daily', () => data.loadDaily()]);
    if (data.hasTable('weekly')) jobs.push(['weekly:', () => data.loadWeekly()]);
    if (data.hasTable('aging')) jobs.push(['aging', () => data.loadAging()]);
    for (const [key, fn] of jobs) {
      try { cachedOrMiss(key, fn, COVERAGE_TTL); } catch (e) { log('WARN', `catalog warm ${key}: ${e.message}`); }
    }
  });
}

/**
 * 构建目录文本。
 *
 * 缓存策略：**只缓存慢的、稳定的部分**（表结构、产品线、已登记产品/活动），
 * 易变的状态（待发提醒条数）每次现算。
 *
 * 旧实现把整段目录（含「待发 27 条」）缓存 10 分钟：实测新建一条提醒后，
 * 模型看到的仍然是 27 条 —— 它会据此回答「你现在有 27 条提醒」，说错了。
 * COUNT(*) 很便宜，没必要跟着缓存。
 *
 * @param {{force?:boolean}} opts force=true 跳过缓存（人工刷新用）
 */
function build({ force = false } = {}) {
  const p = profile.get();

  const slow = () => {
    const lines = [];

    // ── 数据源 ──
    const cov = [
      ['daily', tableLabel('daily', '日运营表'), dailyCoverage()],
      ['weekly', tableLabel('weekly', '周报表'), weeklyCoverage()],
      ['aging', tableLabel('aging', '库龄表'), agingCoverage()],
    ];
    const configured = cov.filter(([, , c]) => c !== null);
    if (configured.length) {
      lines.push(`■ 可读的飞书表格（${p.scope ? `范围：${p.scope}` : '已接入'}）`);
      for (const [, label, c] of configured) {
        lines.push(`· ${label}  覆盖 ${c}`);
      }
    } else {
      lines.push('■ 数据源：尚未接入任何飞书表格（跑 npm run setup 配置）。');
      lines.push('  被问到需要查表的数据时，如实说「还没接入数据源」，不要编数字。');
    }
    lines.push('');

    // ── 业务分组 ──
    if (p.series.length) {
      lines.push(`■ 业务分组${p.scope ? `（${p.scope}）` : ''}`);
      for (const s of p.series) lines.push(`· ${s.key}${s.desc ? ` — ${s.desc}` : ''}`);
      if (p.taboos.length) {
        lines.push(`· **不处理：${p.taboos.join('、')}**`);
      }
    }

    // ── 已登记的产品 ──
    const products = db.listProducts();
    if (products.length) {
      lines.push('');
      lines.push('■ 已登记产品（含 ASIN/SKU，可直接按编码查）');
      const grouped = new Map();
      for (const prod of products) {
        const k = prod.series || '未分组';
        if (!grouped.has(k)) grouped.set(k, []);
        grouped.get(k).push(prod.name);
      }
      for (const [k, list] of grouped) lines.push(`· ${k}：${list.join('、')}`);
    }

    // ── 广告活动 ──
    const camps = db.listCampaigns({ limit: 40 });
    if (camps.length) {
      lines.push('');
      lines.push('■ 已登记广告活动（归属产品）');
      for (const c of camps.slice(0, 12)) {
        const prod = c.productId ? db.getProduct(c.productId) : null;
        lines.push(`· ${c.name}${prod ? ` → ${prod.name}` : ' → 未归属产品'}`);
      }
      if (camps.length > 12) lines.push(`· …共 ${camps.length} 个，用 campaign 工具查全部`);
    }

    // ── 工具 ──
    lines.push('');
    lines.push('■ 数据工具（需要时调用）');
    for (const t of toolList()) lines.push(`· ${t.name} ${t.args} — ${t.desc}`);

    return lines.join('\n');
  };

  const body = force ? slow() : cached('catalog:slow', slow, CATALOG_TTL);

  // 易变部分：每次现算，且放在最后（模型最先看到的是结构，最后才是计数）
  const counts = db.taskCounts();
  return [
    body,
    '',
    `■ 提醒：待发 ${counts.open} 条，已完成 ${counts.done} 条（用 task 工具按时间/关键词查，不要凭记忆）`,
    `■ 接下来：${statusLine()}`,
  ].join('\n');
}

/** 目录以外还需要的「当前状态」——很短，每次都现算。 */
function statusLine() {
  const counts = db.taskCounts();
  // 最紧迫的待发提醒，让模型知道「接下来有什么事」，不用为此多调一次工具
  let next = '';
  try {
    const list = db.listTasks({ done: false, limit: 3 });
    if (list.length) {
      next = list
        .slice()
        .sort((a, b) => a.earliestMs - b.earliestMs)
        .map((t) => `${String(t.due).slice(5, 10)} ${String(t.due).slice(11, 16)} ${t.title}`)
        .join('；');
    }
  } catch (_) {}
  return next ? `${counts.open} 条待发，最近：${next}` : `${counts.open} 条待发`;
}

module.exports = { build, warmCoverage, toolList, refreshSeries, get SERIES() { return SERIES; }, TOOLS, statusLine, fmtDate };
