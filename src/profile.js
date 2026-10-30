'use strict';

/**
 * 业务档案（profile）—— 这个助理「为谁服务、管什么事、读哪些表」
 *
 * 之前这些东西散在源码里写死（产品线名、表 token、列位置、提示词里的店铺名），
 * 换一个人 clone 下来，模型就会一本正经地回答一个根本不存在于他世界里的
 * 「方形花床」。现在全部收进 profile.json：
 *
 *   · 仓库里只有 profile.example.json（占位示例，无真实业务数据）
 *   · 真实档案在 profile.json（gitignore），由 `npm run setup` 访谈生成，
 *     或人工照示例改。
 *   · 缺省（没有 profile.json）时助理照常跑「提醒 / 笔记 / 对话」，
 *     读表类工具明确回答「数据源未配置」，绝不编数字。
 *
 * schema：
 * {
 *   "version": 1,
 *   "name":  "运营助理",                  // 助理自称
 *   "role":  "亚马逊店铺「XX」的运营助理",  // 一句话身份（进 system prompt）
 *   "userLabel": "老板",                  // 对用户的称呼
 *   "scope": "只处理花床房三条产品线",      // 工作范围（进 prompt）
 *   "taboos": ["鸡笼"],                   // 禁碰的领域（进 prompt）
 *   "series": [                            // 业务分组（产品线/项目线，可空）
 *     { "key": "方形花床", "aliases": ["方形","fx","sq"], "desc": "…441/442/632…" }
 *   ],
 *   "tables": {                            // 飞书电子表格数据源（可整个缺省）
 *     "daily": {
 *       "token": "知识库/表格 token",       // 电子表格本体（spreadsheet token）
 *       "label": "日运营表",
 *       "rows": 900,                       // 一次最多读多少行
 *       "sheets": [ { "id": "sheet_id", "label": "分组一" } ],
 *       "columns": {                       // 列位置 1-based，缺省的键按不存在处理
 *         "date": 1, "product": 2, "asin": 3, "sku": 4, "price": 5,
 *         "rankBig": 6, "rankSmall": 7, "reviews": 8, "rating": 9,
 *         "badNew": 10, "badReason": 11, "goodNew": 12, "goodReason": 13,
 *         "action": 14, "remark": 23
 *       },
 *       "actionKinds": ["广告","促销","价格","库存","其他"]   // ops 工具的分类词
 *     },
 *     "weekly": {
 *       "token": "...", "label": "周报表", "rows": 300,
 *       "sheets": [...],
 *       "columns": { "period":1,"sku":2,"asin":3,"name":4,"qty":5,"revenue":6,
 *                    "commission":7,"fulfillment":8,"cost":9,"freight":10,
 *                    "refund":11,"dealFee":12 },
 *       "commissionFallbackRate": 0.15     // 佣金列是公式且解析不出时，按净销售额估
 *     },
 *     "aging": {
 *       "token": "...", "label": "库龄表",
 *       "sheet": "sheet_id",
 *       "columns": { "product":1,"sku":2,"warehouse":3,"d151_180":8,"d181_210":9,
 *                    "d211_270":10,"d271_365":11,"d365plus":12,"unitPrice":13 },
 *       "overThresholdDays": 180
 *     }
 *   },
 *   "extra": "任何想让模型知道的业务背景（自由文本，追加进 system prompt）"
 * }
 *
 * 说明：weekly/aging 的列语义是「亚马逊电商」口径。别的行业想用自己的表，
 * 要么改 columns 对上自己的表，要么整个缺省 tables —— 助理退化为
 * 「提醒 + 笔记 + 对话」助手，功能仍然完整。
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
// 测试用 BRIDGE_PROFILE_FILE 指向 test/fixtures/…，保证 clone 后没生成
// profile.json 也能跑通全部回归测试（而不是依赖某个人的真实业务档案）。
const FILE = process.env.BRIDGE_PROFILE_FILE
  ? (path.isAbsolute(process.env.BRIDGE_PROFILE_FILE)
      ? process.env.BRIDGE_PROFILE_FILE
      : path.join(ROOT, process.env.BRIDGE_PROFILE_FILE))
  : path.join(ROOT, 'profile.json');
const EXAMPLE = path.join(ROOT, 'profile.example.json');

// 内置最小缺省：不含任何真实业务信息，保证代码任何分支都有值可取。
const EMPTY = {
  version: 1,
  name: '助理',
  role: '通过飞书与用户沟通的个人助理',
  userLabel: '老板',
  scope: '',
  taboos: [],
  series: [],
  tables: {},
  extra: '',
};

function load() {
  // 只加载 profile.json（setup 生成 / 人工照示例写）。
  // profile.example.json 里的 token 是占位文字，绝不能被当成真实数据源，
  // 否则新 clone 的用户会看到「工具已就绪但一读就失败」——不如直接如实显示「未接入」。
  try {
    if (!fs.existsSync(FILE)) return { ...EMPTY, _from: null };
    const raw = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    const p = { ...EMPTY, ...raw };
    p.taboos = Array.isArray(p.taboos) ? p.taboos : [];
    p.series = Array.isArray(p.series) ? p.series : [];
    p.tables = p.tables && typeof p.tables === 'object' ? p.tables : {};
    p._from = path.basename(FILE);
    return p;
  } catch (e) {
    console.error(`profile.json 解析失败，按「未配置业务档案」运行: ${e.message}`);
    return { ...EMPTY, _from: null };
  }
}

let current = load();

/** 热重载（setup 访谈写完 profile.json 后调用）。 */
function reload() {
  current = load();
  return current;
}

function get() {
  return current;
}

/** 有没有配置任何表（决定 catalog / 读表工具是否启用）。 */
function hasTables() {
  return Boolean(Object.keys(current.tables).length);
}

/** 业务分组名列表（旧代码里的「产品线」）。 */
function seriesKeys() {
  return current.series.map((s) => s.key).filter(Boolean);
}

/**
 * 把任意说法归一到 series.key。
 * 匹配顺序：精确 key > aliases > key 的子串。匹配不上返回 null。
 */
function normSeries(v) {
  const s = String(v || '').trim();
  if (!s) return null;
  for (const x of current.series) {
    if (x.key && (s === x.key || s.includes(x.key))) return x.key;
  }
  for (const x of current.series) {
    for (const a of x.aliases || []) {
      if (a && s.includes(a)) return x.key;
    }
  }
  return null;
}

/** 提示词片段：工作范围 + 禁忌。没配业务档案时返回空串。 */
function scopePrompt() {
  const parts = [];
  if (current.scope) parts.push(current.scope);
  if (current.series.length) {
    parts.push(`业务分组（series 只能填这些）：${seriesKeys().join(' / ')}`);
  }
  if (current.taboos.length) {
    parts.push(`**绝对不要涉及：${current.taboos.join('、')}**`);
  }
  if (current.extra) parts.push(current.extra);
  return parts.join('\n');
}

module.exports = { get, reload, hasTables, seriesKeys, normSeries, scopePrompt, FILE, EMPTY };
