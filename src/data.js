'use strict';

/**
 * 数据访问层（唯一入口）
 *
 * 全项目只有这一个文件直接调用 lark-cli 读飞书表格。
 * 其它模块一律通过这里取数，避免「同表多种读法」导致的口径分裂。
 *
 * 表 token / sheet id / 列位置 **不再写死在这里**，全部来自 profile.json
 * （src/profile.js）。没配 profile 时本模块的读表函数直接抛「数据源未配置」，
 * 上层据此如实回答「没接表」，绝不返回空数组装成「表里没数据」。
 *
 * 性能事实（实测）：
 *   日运营 3 个 sheet ≈ 1.8s · 周报 3 个 sheet ≈ 1.7s · 库龄 ≈ 0.6s
 *   所以每张表都必须走缓存，且缓存键要能被 invalidate 统一失效。
 */

const { execFileSync } = require('child_process');
const { config } = require('./config');
const cache = require('./cache');
const profile = require('./profile');

// ── 底层调用 ───────────────────────────────────────────────────

/**
 * 取一张表的配置。kind: daily | weekly | aging
 * 缺配置时抛错（消息会一路带到模型眼前，所以写成一句人话）。
 */
function tableDef(kind) {
  const p = profile.get();
  const t = p.tables && p.tables[kind];
  if (!t) throw new Error(`数据源未配置（${kind}）：跑 npm run setup 接入你的飞书表格，或编辑 profile.json`);
  if (!t.token) throw new Error(`${(t.label || kind)} 缺少表格 token`);
  return t;
}

function cli(args) {
  const bin = config.cliPathResolved || config.cliPath;
  if (!bin) throw new Error('lark-cli 未找到：运行 npm run setup 安装，或设置环境变量 LARK_CLI_PATH');
  try {
    return execFileSync(bin, args, {
      encoding: 'utf8',
      windowsHide: true,
      maxBuffer: 100 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (e) {
    // lark-cli 把失败详情写在 stdout 的 JSON 里，execFileSync 默认把这些打到 stderr
    //（会污染日志、也会被父进程的 stderr 捕获），这里统一转成 Error 再抛。
    const err = new Error(shortCliError(e));
    err.stdout = e.stdout;
    err.stderr = e.stderr;
    err.status = e.status;
    throw err;
  }
}

/**
 * 读一段表格区域。
 *
 * 读失败**必须抛错**，不能返回空数组：
 * 旧实现把异常吞掉返回 null，上层于是把「没读到」当成「表里没有数据」，
 * 对老板回答「周报里没有带腿高架的数据」—— 这是最危险的一种错误：
 * 数据明明在，只是这次没读到，答案却是「没有」。
 *
 * 返回 [] 只在「读成功但确实是空表」时出现。
 */
function readRange(bookToken, range) {
  let raw;
  try {
    raw = cli([
      'api', 'GET',
      `/open-apis/sheets/v2/spreadsheets/${bookToken}/values/${encodeURIComponent(range)}`,
      '--as', 'user',
    ]);
  } catch (e) {
    throw new Error(`读表失败（${range}）：${e.message}`);
  }

  let j;
  try {
    j = JSON.parse(raw);
  } catch (_) {
    throw new Error(`读表返回的不是 JSON（${range}）：${String(raw).slice(0, 120)}`);
  }

  if (!j.ok) {
    const msg = (j.error && (j.error.message || j.error.type)) || '未知错误';
    throw new Error(`读表失败（${range}）：${msg}`);
  }

  return (j.data && j.data.valueRange && j.data.valueRange.values) || [];
}

/** lark-cli 的错误输出里混着 JSON 和进度噪声，这里只取一句人话。 */
function shortCliError(e) {
  const out = `${(e && e.stdout) || ''}${(e && e.stderr) || ''}${(e && e.message) || ''}`;
  const m = out.match(/"message"\s*:\s*"([^"]{3,160})"/);
  if (m) return m[1];
  if (/no such host|ENOTFOUND|EAI_AGAIN/i.test(out)) return 'DNS 解析失败（网络不可用）';
  if (/token|unauthor|invalid/i.test(out)) return 'user token 可能已过期，需要重新授权';
  return String((e && e.message) || out).slice(0, 160).replace(/\s+/g, ' ');
}

// ── 单元格规整 ─────────────────────────────────────────────────

function cell(v) {
  if (v == null) return '';
  if (typeof v === 'object') return String(v.text ?? v.link ?? '');
  return String(v);
}

function num(v) {
  const n = parseFloat(cell(v).replace(/[^\d.\-]/g, ''));
  return Number.isNaN(n) ? null : n;
}

/**
 * 公式单元格（周报表的佣金列是 `IFERROR(F2/E2*0.15,0)`）：
 * 表格接口对公式返回的是公式文本而不是计算结果，所以能算出静态值就先算，
 * 算不出来（引用了其它列）再交给上层按业务口径估。
 */
function formulaValue(v) {
  const s = cell(v).trim();
  if (!s.startsWith('=') && !/^IFERROR\(/i.test(s)) return null;

  // 只认「纯数字四则运算」的公式，其余一律放弃
  const expr = s.replace(/^=/, '').replace(/IFERROR\(([^,]+),\s*[^)]*\)/i, '($1)');
  if (!/^[\d\s.+\-*/()]+$/.test(expr)) return null;
  try {
    // eslint-disable-next-line no-new-func
    const n = Function(`"use strict";return (${expr});`)();
    return Number.isFinite(n) ? n : null;
  } catch (_) {
    return null;
  }
}

/** Excel 序列号 → YYYY-MM-DD（也兼容 2026.10.26 / 2026/10/26 这类文本） */
function toDate(v) {
  const raw = cell(v).trim();
  if (!raw) return null;

  const serial = Number(raw);
  if (Number.isFinite(serial) && serial > 40000 && serial < 60000) {
    const ms = Math.round((serial - 25569) * 86400 * 1000);
    const d = new Date(ms);
    return `${d.getUTCFullYear()}-${p2(d.getUTCMonth() + 1)}-${p2(d.getUTCDate())}`;
  }

  const m = raw.match(/(20\d{2})[.\-\/](\d{1,2})[.\-\/](\d{1,2})/);
  if (m) return `${m[1]}-${p2(+m[2])}-${p2(+m[3])}`;

  return null;
}

function p2(n) { return String(n).padStart(2, '0'); }

/** 按列名取单元格（1-based，缺配置返回 ''）。 */
function colAt(row, columns, name) {
  const idx = columns && columns[name];
  if (!Number.isFinite(idx) || idx < 1) return '';
  return cell((row || [])[idx - 1]);
}

function colNum(row, columns, name) {
  return num(colAt(row, columns, name));
}

// ── 对外读取接口 ───────────────────────────────────────────────

/**
 * 读日运营表，按日期分组。
 *
 * 这是全项目最贵的一次读（3 个 sheet = 3 次 lark-cli + 网络往返），
 * 而 analyze 里的 freshness/recentOps/stockSnapshot/recentChanges 都要用它。
 * 所以这里统一走缓存，一轮对话内只真正读一次。
 *
 * @returns {Array<{date, series, items:Array}>} 按日期升序
 */
function loadDaily() {
  return cache.cachedOrMiss('daily', loadDailyUncached);
}

function loadDailyUncached() {
  const t = tableDef('daily');
  const COL = t.columns || {};
  const rows = Number(t.rows) > 0 ? Number(t.rows) : 900;
  const sheets = Array.isArray(t.sheets) ? t.sheets : [];
  if (!sheets.length) throw new Error(`${t.label || 'daily'} 没有配置任何工作表`);

  const blocks = [];
  const failures = [];

  for (const sheet of sheets) {
    let grid;
    try {
      grid = readRange(t.token, `${sheet.id}!A1:Z${rows}`);
    } catch (e) {
      failures.push(`${sheet.label}：${e.message}`);
      continue;
    }
    if (!grid.length) { failures.push(`${sheet.label}：读到了空表`); continue; }
    let cur = null;

    for (let i = 0; i < grid.length; i++) {
      const r = grid[i] || [];

      const date = toDate(colAt(r, COL, 'date'));
      if (date) {
        cur = { date, series: sheet.label, row: i + 1, items: [] };
        blocks.push(cur);
      }
      if (!cur) continue;

      const name = colAt(r, COL, 'product').trim();
      if (!name || /^(总计|合计|日期)$/.test(name)) continue;

      const priceRaw = colAt(r, COL, 'price').trim();

      cur.items.push({
        name,
        asin: colAt(r, COL, 'asin').trim(),
        sku: colAt(r, COL, 'sku').trim(),
        priceRaw,
        price: num(priceRaw),
        oos: /无库存|缺货|售罄/.test(priceRaw),
        rankBig: colNum(r, COL, 'rankBig'),
        rankSmall: colNum(r, COL, 'rankSmall'),
        reviews: colNum(r, COL, 'reviews'),
        rating: colNum(r, COL, 'rating'),
        badNew: colAt(r, COL, 'badNew').trim(),
        badReason: colAt(r, COL, 'badReason').trim(),
        goodNew: colAt(r, COL, 'goodNew').trim(),
        goodReason: colAt(r, COL, 'goodReason').trim(),
        action: colAt(r, COL, 'action').trim(),
        remark: colAt(r, COL, 'remark').trim(),
      });
    }
  }

  // 全部 sheet 都读失败 → 抛错。
  // 一个 sheet 失败（例如产品线改名）就只丢那条线，不能把整张表判成空的。
  if (!blocks.length) {
    throw new Error(`${t.label || '日运营'}读取失败：${failures.join('；')}`);
  }

  // 同一天可能被拆成多块（产品多时），合并
  const byDate = new Map();
  for (const b of blocks) {
    const key = `${b.date}|${b.series}`;
    if (!byDate.has(key)) byDate.set(key, { ...b });
    else byDate.get(key).items.push(...b.items);
  }

  return Array.from(byDate.values()).sort((a, b) => a.date.localeCompare(b.date));
}

/**
 * 取最新一个日期块（可选按系列过滤）。
 */
function latestDaily(seriesLabel) {
  let all = loadDaily();
  if (seriesLabel) all = all.filter((b) => b.series === seriesLabel);
  return all.length ? all[all.length - 1] : null;
}

/**
 * 读库龄表。
 * @returns {{date:string|null, rows:Array}} rows 已按「超阈值」降序
 */
function loadAging() {
  return cache.cachedOrMiss('aging', loadAgingUncached);
}

function loadAgingUncached() {
  const t = tableDef('aging');
  const COL = t.columns || {};
  const sheetId = t.sheet || (Array.isArray(t.sheets) && t.sheets[0] && t.sheets[0].id);
  if (!sheetId) throw new Error(`${t.label || '库龄'} 没有配置工作表`);

  const grid = readRange(t.token, `${sheetId}!A1:N40`);
  if (!grid.length) return { date: null, rows: [] };

  // 第 1 行第 6 列附近写统计日期，如「2026.10.22统计」
  let date = null;
  const dcell = cell(grid[0] && grid[0][5]).trim();
  const dm = dcell.match(/(20\d{2})[.\-\/](\d{1,2})[.\-\/](\d{1,2})/);
  if (dm) date = `${dm[1]}-${p2(+dm[2])}-${p2(+dm[3])}`;

  const out = [];
  for (let i = 2; i < grid.length; i++) {
    const r = grid[i] || [];
    const name = colAt(r, COL, 'product').trim();
    if (!name || /^(总计|合计|产品)/.test(name)) continue;

    const get = (k) => colNum(r, COL, k) || 0;
    // 「超龄」= 超过 overThresholdDays 的各档之和（默认 180 天口径）
    const over = get('d181_210') + get('d211_270') + get('d271_365') + get('d365plus');

    out.push({
      name,
      sku: colAt(r, COL, 'sku').trim(),
      near: get('d151_180'),
      d181_210: get('d181_210'),
      d211_270: get('d211_270'),
      d271_365: get('d271_365'),
      d365plus: get('d365plus'),
      over,
      unitPrice: colNum(r, COL, 'unitPrice'),
    });
  }

  out.sort((a, b) => b.over - a.over);
  return { date, rows: out };
}

/**
 * 读周报表，按周期分组。
 *
 * 列语义（电商口径，可在 profile.json 的 columns 里改名/换位）：
 *   周期 / SKU / ASIN / 品名 / 售出数量 / 净销售额 / 平台佣金 / 尾端配送 /
 *   单件成本 / 单件头程 / 退款额 / 秒杀费
 *
 * 注意：成本/头程/尾端配送是**单件**金额，佣金列常是公式文本。
 * @param {string} [seriesLabel] 只要某条产品线
 */
function loadWeekly(seriesLabel) {
  return cache.cachedOrMiss(`weekly:${seriesLabel || 'all'}`, () => loadWeeklyUncached(seriesLabel), 300000);
}

function loadWeeklyUncached(seriesLabel) {
  const t = tableDef('weekly');
  const COL = t.columns || {};
  const rows = Number(t.rows) > 0 ? Number(t.rows) : 300;
  const commissionRate = Number.isFinite(t.commissionFallbackRate) ? t.commissionFallbackRate : 0.15;
  const sheets = Array.isArray(t.sheets) ? t.sheets : [];
  if (!sheets.length) throw new Error(`${t.label || 'weekly'} 没有配置任何工作表`);

  const out = [];
  const failures = [];

  for (const sheet of sheets) {
    if (seriesLabel && sheet.label !== seriesLabel) continue;

    let grid;
    try {
      grid = readRange(t.token, `${sheet.id}!A1:L${rows}`);
    } catch (e) {
      failures.push(`${sheet.label}：${e.message}`);
      continue;
    }
    if (!grid.length) { failures.push(`${sheet.label}：读到了空表`); continue; }
    let cur = null;

    for (let i = 0; i < grid.length; i++) {
      const r = grid[i] || [];

      // 周期文本形如 2026-10-19~2026-10-25
      const periodRaw = colAt(r, COL, 'period').trim();
      const pm = periodRaw.match(/(20\d{2})[.\-\/](\d{1,2})[.\-\/](\d{1,2})\s*[-~到]\s*(20\d{2})[.\-\/](\d{1,2})[.\-\/](\d{1,2})/);
      if (pm) {
        cur = {
          series: sheet.label,
          start: `${pm[1]}-${p2(+pm[2])}-${p2(+pm[3])}`,
          end: `${pm[4]}-${p2(+pm[5])}-${p2(+pm[6])}`,
          label: `${p2(+pm[2])}/${p2(+pm[3])}-${p2(+pm[5])}/${p2(+pm[6])}`,
          items: [],
        };
        out.push(cur);
      }
      if (!cur) continue;

      const name = colAt(r, COL, 'name').trim();
      if (!name || /^(总计|合计|品名)$/.test(name)) continue;

      const qty = colNum(r, COL, 'qty');
      const revenue = colNum(r, COL, 'revenue');
      // 佣金列可能是 =IFERROR(F2/E2*0.15,0)：能算就算了，算不出来按销售额估
      const commission = formulaValue(colAt(r, COL, 'commission'))
        ?? (revenue != null ? Math.round(revenue * commissionRate * 100) / 100 : null);
      const fulfillment = colNum(r, COL, 'fulfillment');
      const cost = colNum(r, COL, 'cost');
      const freight = colNum(r, COL, 'freight');
      const refund = colNum(r, COL, 'refund');
      const dealFee = colNum(r, COL, 'dealFee');

      // 退货按负收入处理：旧实现把它当成本加进去，毛利被低估一倍
      const refundLoss = refund != null ? Math.abs(refund) : 0;

      const totalCost = (cost != null ? cost * (qty || 0) : 0)
        + (freight != null ? freight * (qty || 0) : 0)
        + (commission || 0)
        + (fulfillment != null ? fulfillment * (qty || 0) : 0)
        + (dealFee || 0)
        + refundLoss;

      cur.items.push({
        name,
        sku: colAt(r, COL, 'sku').trim(),
        asin: colAt(r, COL, 'asin').trim(),
        qty,
        revenue,
        unitCost: cost,
        unitFreight: freight,
        unitFulfillment: fulfillment,
        commission,
        refund,
        dealFee,
        totalCost: Math.round(totalCost * 100) / 100,
        profit: revenue != null ? Math.round((revenue - totalCost) * 100) / 100 : null,
        margin: revenue ? Math.round(((revenue - totalCost) / revenue) * 1000) / 10 : null,
      });
    }
  }

  if (!out.length) {
    throw new Error(`${t.label || '周报'}读取失败：${failures.join('；') || '没有匹配的产品线'}`);
  }

  return out.sort((a, b) => a.start.localeCompare(b.start));
}

/** 某张表是否已配置（catalog / tools 用它决定是否启用）。 */
function hasTable(kind) {
  const p = profile.get();
  const t = p.tables && p.tables[kind];
  return Boolean(t && t.token);
}

// ── 工具 ───────────────────────────────────────────────────────

function daysAgoISO(n) {
  const d = new Date(Date.now() - n * 86400 * 1000);
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
}

function todayISO() {
  const d = new Date();
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
}

module.exports = {
  tableDef, hasTable, colAt, colNum,
  loadDaily, latestDaily, loadWeekly, loadAging,
  daysAgoISO, todayISO, toDate, cell, num, formulaValue, p2, readRange,
};
