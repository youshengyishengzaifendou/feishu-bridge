'use strict';

/**
 * 动作执行器 —— 把 AI 给的 actions 真正落地
 *
 * 五种：
 *   remind     建提醒（自动带提前档位、支持循环）
 *   note       记录信息（广告/运营/库存/价格），尽量挂到产品上
 *   campaign   登记广告活动，并归属到具体产品
 *   product    登记新产品
 *   forget     删除提醒 / 取消某条
 */

const store = require('../store');
const db = require('../../src/db');
const memory = require('../../src/memory');
const { config } = require('../../src/config');
const { log } = require('../../src/util');

const nowIso = () => new Date().toISOString();

// ── 去重：同一天同一件事不要建两次 ────────────────────────────

function normalizeTitle(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[\s，。、：；！？（）()【】\[\]"'""''~`]/g, '')
    .replace(/^(请|麻烦|帮我|记得|提醒我|提醒|别忘了|别忘|要)/, '')
    .slice(0, 60);
}

function sameDay(a, b) {
  const da = Date.parse(a), db2 = Date.parse(b);
  if (Number.isNaN(da) || Number.isNaN(db2)) return false;
  const A = new Date(da), B = new Date(db2);
  return A.getFullYear() === B.getFullYear()
    && A.getMonth() === B.getMonth()
    && A.getDate() === B.getDate();
}

function findDuplicate(task, tasks) {
  const nt = normalizeTitle(task.title);
  if (!nt) return null;
  for (const t of tasks) {
    if (t.done) continue;
    if (!sameDay(t.due, task.due)) continue;
    const other = normalizeTitle(t.title);
    if (!other) continue;
    if (other === nt) return t;
    if (other.length >= 8 && nt.includes(other)) return t;
    if (nt.length >= 8 && other.includes(nt)) return t;
  }
  return null;
}

/**
 * 只把「同一天」的任务读出来做判重。
 * 旧实现在每次提醒时都 listTasks({limit:100000}) 把整张表拉进内存，
 * 任务越攒越多，单条消息的延迟就越来越高。
 */
function tasksAround(dueMs) {
  const key = db.localDateKey(new Date(dueMs));
  try {
    return db.tasksOnDate(key);
  } catch (_) {
    return store.loadTasks();
  }
}

// ── 重复规则 ─────────────────────────────────────────────────

const REPEAT_KIND = new Set(['daily', 'weekly', 'monthly']);

function cleanRepeat(rep) {
  if (!rep || !REPEAT_KIND.has(String(rep.kind))) return null;
  const out = { kind: rep.kind };
  if (rep.kind === 'weekly') out.weekday = Number.isFinite(Number(rep.weekday)) ? Number(rep.weekday) : 2;
  if (rep.kind === 'monthly') out.day = Number.isFinite(Number(rep.day)) ? Number(rep.day) : 1;
  out.hour = Number.isFinite(Number(rep.hour)) ? Number(rep.hour) : 10;
  out.minute = Number.isFinite(Number(rep.minute)) ? Number(rep.minute) : 0;
  return out;
}

/**
 * 按重复规则展开出「最近 N 次」的具体日期。
 *
 * ⚠ 仅用于「预览 / 人工核对」，不要再把展开结果写成多条一次性任务：
 *   旧实现把「每月6号」展开成 6 条一次性任务（repeat=null），
 *   发完 6 次就永久失效，而且和 rollForward 的滚动逻辑重复。
 *   现在每个固定日只建一条带 repeat 的循环任务。
 */
function expandRepeat(rep, dueMs, count = 6) {
  const out = [dueMs];
  let cur = dueMs;

  for (let i = 0; i < count - 1; i++) {
    const d = new Date(cur);
    if (rep.kind === 'daily') {
      d.setDate(d.getDate() + 1);
    } else if (rep.kind === 'weekly') {
      d.setDate(d.getDate() + 7);
    } else if (rep.kind === 'monthly') {
      const day = rep.day;
      d.setDate(1);
      d.setMonth(d.getMonth() + 1);
      const lastDay = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
      d.setDate(Math.min(day, lastDay));
    }
    d.setHours(rep.hour, rep.minute, 0, 0);
    out.push(d.getTime());
    cur = d.getTime();
  }
  return out;
}

function fmtDue(ms) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:00+08:00`;
}

function repeatHuman(rep) {
  const hm = `${String(rep.hour).padStart(2, '0')}:${String(rep.minute).padStart(2, '0')}`;
  if (rep.kind === 'daily') return `每天 ${hm}`;
  if (rep.kind === 'weekly') {
    const W = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
    return `每${W[rep.weekday]} ${hm}`;
  }
  if (rep.kind === 'monthly') return `每月 ${rep.day} 号 ${hm}`;
  return '';
}

// ── 执行器 ───────────────────────────────────────────────────

function doRemind(action, messageId) {
  const due = String(action.due || '');
  const dueMs = Date.parse(due);
  if (Number.isNaN(dueMs)) {
    log('WARN', `remind: 时间无效 ${due}`);
    return { type: 'remind', ok: false, error: '时间无效' };
  }
  const title = String(action.title || '').trim().slice(0, 80);
  if (!title) return { type: 'remind', ok: false, error: '标题为空' };

  // 提醒档位：模型给的优先；没给就按配置默认（当前是 [0] = 只准点）。
  // 老板已明确「只在准点发」，所以模型若还按旧习惯给 [1440,120,0]，
  // 这里会把它收敛成准点 —— 避免提示词没生效时又冒出提前提醒。
  let advance = Array.isArray(action.advance) && action.advance.length
    ? action.advance.map(Number).filter((n) => Number.isFinite(n) && n >= 0)
    : config.advanceMinutes.slice();

  if (config.onlyOnTime !== false) {
    // onlyOnTime=true 时忽略模型给的提前档，统一准点
    advance = [0];
  }

  if (!advance.length) advance.push(0);

  // 产品 / 广告活动归属
  let productId = null;
  let campaignId = null;
  if (action.campaign) {
    const cr = memory.recordCampaign({ name: action.campaign, productName: action.product });
    campaignId = cr.campaign.id;
    if (cr.product) productId = cr.product.id;
  } else if (action.product) {
    const hits = memory.findProducts(String(action.product), { limit: 1 });
    if (hits.length) productId = hits[0].id;
  }
  if (!productId) {
    const m = memory.matchProduct(`${title} ${action.note || ''}`);
    if (m) productId = m.product.id;
  }

  // 循环提醒：一条任务 + repeat 规则，由 scheduler 的 rollForward 永久滚动。
  // 旧实现会展开成 6 条一次性任务（repeat=null），发完就永久失效。
  const rep = cleanRepeat(action.repeat);
  if (rep) {
    const first = new Date(dueMs);
    // 若模型给的 due 与 repeat 的时分秒不一致，以 repeat 为准（它才是规则）
    first.setHours(rep.hour, rep.minute, 0, 0);
    const slotDue = fmtDue(first.getTime());

    const task = {
      id: `loop-${rep.kind}-${first.getTime()}-${Math.random().toString(36).slice(2, 6)}`,
      title,
      due: slotDue,
      dueMs: first.getTime(),
      advance,
      note: action.note ? String(action.note).slice(0, 300) : repeatHuman(rep),
      source: messageId ? `msg:${messageId}` : 'ai',
      messageId: messageId || null,
      repeat: rep,
      digest: action.digest || null,
      productId,
      campaignId,
      createdAt: nowIso(),
      done: false,
      fired: [],
      firing: [],
    };

    const dup = findDuplicate(task, tasksAround(dueMs));
    if (dup) {
      log('INFO', `remind: 重复循环任务，跳过 ${title} @ ${slotDue}`);
      return { type: 'remind', ok: true, duplicate: true, ref: dup.id, title: dup.title, due: dup.due };
    }

    db.insertTask(task);
    log('INFO', `remind: ${title} @ ${task.due} repeat=${rep.kind}${rep.day ? `/${rep.day}` : ''}`);
    return {
      type: 'remind',
      ok: true,
      ref: task.id,
      title,
      due: task.due,
      advance,
      repeat: repeatHuman(rep),
      forever: true,
      count: 1,
      productId,
    };
  }

  const task = {
    id: `r-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    title,
    due: fmtDue(dueMs),
    dueMs,
    advance,
    note: action.note ? String(action.note).slice(0, 300) : '',
    source: messageId ? `msg:${messageId}` : 'ai',
    messageId: messageId || null,
    repeat: null,
    digest: action.digest || null,
    productId,
    campaignId,
    createdAt: nowIso(),
    done: false,
    fired: [],
    firing: [],
  };

  const dup = findDuplicate(task, tasksAround(dueMs));
  if (dup) {
    log('INFO', `remind: 重复，跳过 ${title}`);
    return { type: 'remind', ok: true, duplicate: true, ref: dup.id, title: dup.title, due: dup.due };
  }

  db.insertTask(task);
  log('INFO', `remind: ${title} @ ${task.due}`);

  return {
    type: 'remind',
    ok: true,
    ref: task.id,
    title,
    due: task.due,
    advance,
    repeat: null,
    count: 1,
    productId,
  };
}

function doNote(action, messageId) {
  const text = String(action.text || '').trim();
  if (!text) return { type: 'note', ok: false, error: '内容为空' };

  let productId = null;
  if (action.product) {
    const hits = memory.findProducts(String(action.product), { limit: 1 });
    if (hits.length) productId = hits[0].id;
  }
  if (!productId) {
    const m = memory.matchProduct(text);
    if (m) productId = m.product.id;
  }

  let campaignId = null;
  if (action.campaign) {
    const c = db.getCampaign(String(action.campaign)) || memory.findCampaigns(String(action.campaign), { limit: 1 })[0];
    if (c) {
      campaignId = c.id;
      if (!productId && c.productId) productId = c.productId;
    }
  }

  const note = db.addNote({
    kind: action.kind || 'ops',
    text: text.slice(0, 800),
    analysis: action.analysis ? String(action.analysis).slice(0, 800) : '',
    productId,
    campaignId,
    source: messageId ? `msg:${messageId}` : 'ai',
    createdAt: nowIso(),
  });

  log('INFO', `note: [${note.kind}] ${text.slice(0, 40)}${productId ? ` → ${productId}` : ''}`);
  return { type: 'note', ok: true, ref: note.id, productId };
}

function doCampaign(action, messageId) {
  const name = String(action.name || '').trim();
  if (!name) return { type: 'campaign', ok: false, error: '活动名为空' };

  const r = memory.recordCampaign({
    name,
    productName: action.product,
    type: action.campaignType,
    note: action.analysis || '',
  });

  // 同时留一条笔记，保留分析结论
  if (action.analysis) {
    db.addNote({
      kind: 'campaign',
      text: name,
      analysis: String(action.analysis).slice(0, 800),
      campaignId: r.campaign.id,
      productId: r.product ? r.product.id : null,
      source: messageId ? `msg:${messageId}` : 'ai',
      createdAt: nowIso(),
    });
  }

  log('INFO', `campaign: ${name} → ${r.product ? r.product.name : '【未归属】'} (${r.resolvedBy})`);
  return {
    type: 'campaign',
    ok: true,
    ref: r.campaign.id,
    name,
    product: r.product ? r.product.name : null,
    resolvedBy: r.resolvedBy,
  };
}

function doProduct(action, messageId) {
  const name = String(action.name || '').trim();
  if (!name) return { type: 'product', ok: false, error: '产品名为空' };

  const p = db.putProduct({
    id: db.slug(`${action.series || '未分类'}-${name}`),
    name,
    series: action.series || null,
    asin: action.asin || null,
    sku: action.sku || null,
    aliases: [name, action.asin, action.sku].filter(Boolean),
    note: action.note || '',
  });
  log('INFO', `product: ${name} (${action.series || '未分类'}) asin=${action.asin || '—'}`);
  return { type: 'product', ok: true, ref: p.id, name: p.name };
}

/**
 * 删除提醒。
 *
 * 支持三种入参（模型给的形状各不相同，都要认）：
 *   · id        单条：{"type":"forget","id":"r-xxx"}
 *   · ids       多条：{"type":"forget","ids":["r-1","r-2"]}
 *   · query     关键词：{"type":"forget","query":"BD/LD"}
 *
 * ⚠ 这是唯一会**不可逆销毁数据**的动作（提醒删了就没了），所以有三道保护：
 *
 *   1. 单次最多删 MAX_FORGET 条。实测模型说「合并」时曾一次性删掉 6 条，
 *      其中 3 条是无关的广告提醒，而它回复说「其余提醒都没动」——
 *      说一套做一套，老板根本不知道被删了什么。
 *   2. 关键词匹配要求「包含」，不用全文检索的模糊命中：
 *      FTS 的分词会把「BD」这种短词匹配到不相关任务上。
 *   3. 返回 deleted 名单（标题+时间），让上层把真实结果写进回复，
 *      不依赖模型自己复述。
 */
const MAX_FORGET = 5;

function doForget(action, _messageId) {
  // ── 按 id（一条或多条）──
  const ids = [];
  if (action.id) ids.push(String(action.id).trim());
  if (Array.isArray(action.ids)) {
    for (const x of action.ids) if (x) ids.push(String(x).trim());
  }
  const uniqueIds = Array.from(new Set(ids.filter(Boolean)));

  if (uniqueIds.length) {
    const removed = [];
    const missing = [];
    for (const id of uniqueIds.slice(0, MAX_FORGET)) {
      const t = db.getTask(id);
      if (!t) { missing.push(id); continue; }
      if (db.deleteTask(id)) removed.push({ id, title: t.title, due: t.due });
    }
    if (removed.length) log('INFO', `forget: 删除 ${removed.length} 条（按 id）`);
    return {
      type: 'forget',
      ok: removed.length > 0,
      deleted: removed,
      count: removed.length,
      removed: removed.map((x) => x.title),
      missing,
      ref: uniqueIds[0],
    };
  }

  // ── 按标题关键词 ──
  const q = String(action.query || action.title || '').trim();
  if (!q) return { type: 'forget', ok: false, error: '需要 id / ids / query' };

  const norm = (s) => String(s || '').replace(/[\s，。、：；！？（）()【】\[\]"'`~-]/g, '').toLowerCase();
  const nq = norm(q);
  if (!nq) return { type: 'forget', ok: false, error: '关键词太短' };

  // 只用「标题包含关键词」判定，不用 FTS 模糊命中（会把无关任务删掉）
  const all = db.listTasks({ done: false, limit: 2000 });
  const hits = all.filter((t) => !t.done && norm(t.title).includes(nq));

  if (!hits.length) return { type: 'forget', ok: false, error: `没找到标题含「${q}」的提醒` };
  if (hits.length > MAX_FORGET) {
    log('WARN', `forget: 「${q}」命中 ${hits.length} 条，超过单次上限 ${MAX_FORGET}，拒绝执行`);
    return {
      type: 'forget',
      ok: false,
      error: `「${q}」命中 ${hits.length} 条，超过单次删除上限 ${MAX_FORGET} 条；请指定更精确的关键词或逐条给 id`,
      matched: hits.map((t) => ({ id: t.id, title: t.title, due: t.due })),
    };
  }

  const removed = [];
  for (const t of hits) {
    if (db.deleteTask(t.id)) removed.push({ id: t.id, title: t.title, due: t.due });
  }
  log('INFO', `forget: 删除 ${removed.length} 条（关键词「${q}」）`);
  return {
    type: 'forget',
    ok: removed.length > 0,
    deleted: removed,
    count: removed.length,
    removed: removed.map((x) => x.title),
  };
}

/**
 * 执行一组 actions。
 */
function apply(actions, messageId) {
  const out = [];
  for (const a of actions || []) {
    if (!a || !a.type) continue;
    try {
      if (a.type === 'remind') out.push(doRemind(a, messageId));
      else if (a.type === 'note') out.push(doNote(a, messageId));
      else if (a.type === 'campaign') out.push(doCampaign(a, messageId));
      else if (a.type === 'product') out.push(doProduct(a, messageId));
      else if (a.type === 'forget') out.push(doForget(a, messageId));
    } catch (e) {
      log('ERROR', `action ${a.type} failed: ${e.message}`);
      out.push({ type: a.type, ok: false, error: e.message });
    }
  }
  return out;
}

module.exports = {
  apply, doRemind, doNote, doCampaign, doProduct, doForget,
  findDuplicate, normalizeTitle, cleanRepeat, expandRepeat, repeatHuman,
};
