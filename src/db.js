'use strict';

/**
 * 唯一的存储层（SQLite）
 *
 * 设计原则：
 *   1. 全项目只有这一个文件碰数据库；其它模块一律通过这里读写。
 *   2. 任务按 earliest_ms 建索引 —— 到点扫描是 O(到期条数)，不随任务总数增长。
 *   3. 每个实体单独事务，不做「整表读出来 → 改 → 整表写回去」，避免并发丢更新。
 *   4. 全文检索走 FTS5（中文用二元分词），给「找那个东西」用；
 *      时间条件走 B 树索引 —— 两件事不能混成一种结构。
 *
 * 为什么不是向量库：
 *   「哪些任务现在该发」是精确的时间区间查询，向量相似度做不了。
 *   这一层用索引解决；「用户说的这句话指哪个产品/活动/笔记」才是语义检索，
 *   已经隔离在 search() 后面，将来换成 embedding 只需替换这一个函数。
 */

const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const { DATA } = require('./config');

// 测试时把库指到临时文件（BRIDGE_TEST_DB），绝不污染真实的 data/bridge.db
const DB_FILE = process.env.BRIDGE_TEST_DB || path.join(DATA, 'bridge.db');

let db = null;

// ── 连接与建表 ─────────────────────────────────────────────────

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA busy_timeout = 5000;

CREATE TABLE IF NOT EXISTS tasks (
  id              TEXT PRIMARY KEY,
  title           TEXT NOT NULL,
  note            TEXT NOT NULL DEFAULT '',
  due             TEXT NOT NULL,
  due_ms          INTEGER NOT NULL,
  advance         TEXT NOT NULL DEFAULT '[0]',
  repeat_rule     TEXT,
  digest          TEXT,
  product_id      TEXT,
  campaign_id     TEXT,
  source          TEXT,
  message_id      TEXT,
  created_at      TEXT NOT NULL,
  done            INTEGER NOT NULL DEFAULT 0,
  completed_at    TEXT,
  last_fired_at   TEXT,
  last_attempt_at TEXT,
  prev_due        TEXT,
  fired           TEXT NOT NULL DEFAULT '[]',
  firing          TEXT NOT NULL DEFAULT '[]',
  earliest_ms     INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_tasks_due   ON tasks(done, earliest_ms);
CREATE INDEX IF NOT EXISTS ix_tasks_time  ON tasks(due_ms);
CREATE INDEX IF NOT EXISTS ix_tasks_prod  ON tasks(product_id);
CREATE INDEX IF NOT EXISTS ix_tasks_camp  ON tasks(campaign_id);

CREATE TABLE IF NOT EXISTS products (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  aliases    TEXT NOT NULL DEFAULT '[]',
  series     TEXT,
  asin       TEXT,
  sku        TEXT,
  note       TEXT NOT NULL DEFAULT '',
  created_at TEXT,
  updated_at TEXT
);
CREATE INDEX IF NOT EXISTS ix_products_series ON products(series);

CREATE TABLE IF NOT EXISTS campaigns (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  type       TEXT,
  status     TEXT NOT NULL DEFAULT 'active',
  product_id TEXT REFERENCES products(id) ON DELETE SET NULL,
  note       TEXT NOT NULL DEFAULT '',
  created_at TEXT,
  updated_at TEXT
);
CREATE INDEX IF NOT EXISTS ix_campaigns_product ON campaigns(product_id);

CREATE TABLE IF NOT EXISTS notes (
  id          TEXT PRIMARY KEY,
  kind        TEXT NOT NULL DEFAULT 'ops',
  text        TEXT NOT NULL,
  analysis    TEXT NOT NULL DEFAULT '',
  product_id  TEXT,
  campaign_id TEXT,
  source      TEXT,
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_notes_kind ON notes(kind, created_at);

CREATE TABLE IF NOT EXISTS turns (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  date     TEXT NOT NULL,
  at       TEXT NOT NULL,
  user     TEXT,
  reply    TEXT,
  intent   TEXT,
  actions  TEXT NOT NULL DEFAULT '[]',
  degraded INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS ix_turns_date ON turns(date, id);

CREATE TABLE IF NOT EXISTS queue (
  id          TEXT PRIMARY KEY,
  text        TEXT NOT NULL,
  meta        TEXT NOT NULL DEFAULT '{}',
  reason      TEXT,
  reply       TEXT,
  attempts    INTEGER NOT NULL DEFAULT 0,
  enqueued_at TEXT NOT NULL,
  updated_at  TEXT
);

CREATE TABLE IF NOT EXISTS seen_messages (
  message_id TEXT PRIMARY KEY,
  seen_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS kv (
  k TEXT PRIMARY KEY,
  v TEXT
);

CREATE VIRTUAL TABLE IF NOT EXISTS search USING fts5(
  kind,
  ref UNINDEXED,
  body,
  tokenize = 'unicode61'
);
`;

function open() {
  if (db) return db;
  if (!fs.existsSync(DATA)) fs.mkdirSync(DATA, { recursive: true });
  db = new DatabaseSync(DB_FILE);
  db.exec(SCHEMA);
  return db;
}

/** 关闭连接（测试/退出用）。 */
function close() {
  if (db) {
    try { db.close(); } catch (_) {}
    db = null;
  }
}

const nowIso = () => new Date().toISOString();
const uniq = (a) => Array.from(new Set(a.filter(Boolean)));
const clampInt = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d);

// ── 行 ↔ 对象 ─────────────────────────────────────────────────

function rowToTask(r) {
  if (!r) return null;
  const j = (s, d) => {
    try { return JSON.parse(s); } catch (_) { return d; }
  };
  // due_ms 是索引列，也是唯一可信的时间源；历史行若与 due 不一致，以 due 字符串为准。
  const parsedDue = Date.parse(r.due);
  const dueMs = Number.isFinite(parsedDue) ? parsedDue : r.due_ms;
  return {
    id: r.id,
    title: r.title,
    note: r.note || '',
    due: r.due,
    dueMs,
    advance: j(r.advance, [0]),
    repeat: j(r.repeat_rule, null),
    digest: r.digest || null,
    productId: r.product_id || null,
    campaignId: r.campaign_id || null,
    source: r.source || '',
    messageId: r.message_id || null,
    createdAt: r.created_at,
    done: Boolean(r.done),
    completedAt: r.completed_at || null,
    lastFiredAt: r.last_fired_at || null,
    lastAttemptAt: r.last_attempt_at || null,
    prevDue: r.prev_due || null,
    fired: j(r.fired, []).map(String),
    firing: j(r.firing, []).map(String),
    earliestMs: r.earliest_ms,
  };
}

/**
 * 计算「下一次需要被唤醒」的毫秒数。
 * 取所有还没发出的提前档位里最早的触发时刻；全部发完则用到期时刻。
 * 这个值就是调度器唯一的扫描依据。
 */
function computeEarliest(task) {
  const dueMs = Number.isFinite(task.dueMs) ? task.dueMs : Date.parse(task.due);
  if (!Number.isFinite(dueMs)) return Number.MAX_SAFE_INTEGER;
  const fired = Array.isArray(task.fired) ? task.fired.map(String) : [];
  const advances = Array.isArray(task.advance) && task.advance.length ? task.advance : [0];
  let min = Infinity;
  for (const a of advances) {
    if (fired.includes(String(a))) continue;
    const t = dueMs - Number(a) * 60000;
    if (t < min) min = t;
  }
  return min === Infinity ? dueMs : min;
}

function toParams(task) {
  const dueMs = Number.isFinite(task.dueMs) ? task.dueMs : Date.parse(task.due);
  const merged = {
    ...task,
    dueMs,
    advance: Array.isArray(task.advance) && task.advance.length ? task.advance : [0],
    fired: Array.isArray(task.fired) ? task.fired.map(String) : [],
    firing: Array.isArray(task.firing) ? task.firing.map(String) : [],
  };
  return {
    id: merged.id,
    title: merged.title,
    note: merged.note || '',
    due: merged.due,
    due_ms: dueMs,
    advance: JSON.stringify(merged.advance),
    repeat_rule: merged.repeat ? JSON.stringify(merged.repeat) : null,
    digest: merged.digest || null,
    product_id: merged.productId || null,
    campaign_id: merged.campaignId || null,
    source: merged.source || '',
    message_id: merged.messageId || null,
    created_at: merged.createdAt || nowIso(),
    done: merged.done ? 1 : 0,
    completed_at: merged.completedAt || null,
    last_fired_at: merged.lastFiredAt || null,
    last_attempt_at: merged.lastAttemptAt || null,
    prev_due: merged.prevDue || null,
    fired: JSON.stringify(merged.fired),
    firing: JSON.stringify(merged.firing),
    earliest_ms: computeEarliest(merged),
  };
}

// ── 任务 ───────────────────────────────────────────────────────

function insertTask(task) {
  const p = toParams(task);
  open().prepare(`
    INSERT INTO tasks (id,title,note,due,due_ms,advance,repeat_rule,digest,product_id,campaign_id,
                       source,message_id,created_at,done,completed_at,last_fired_at,last_attempt_at,
                       prev_due,fired,firing,earliest_ms)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `).run(p.id, p.title, p.note, p.due, p.due_ms, p.advance, p.repeat_rule, p.digest,
    p.product_id, p.campaign_id, p.source, p.message_id, p.created_at, p.done,
    p.completed_at, p.last_fired_at, p.last_attempt_at, p.prev_due, p.fired, p.firing,
    p.earliest_ms);
  reindexTask(p.id);
  return getTask(p.id);
}

/** 按 id 覆盖写（保留 createdAt）。 */
function putTask(task) {
  const p = toParams(task);
  open().prepare(`
    INSERT INTO tasks (id,title,note,due,due_ms,advance,repeat_rule,digest,product_id,campaign_id,
                       source,message_id,created_at,done,completed_at,last_fired_at,last_attempt_at,
                       prev_due,fired,firing,earliest_ms)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET
      title=excluded.title, note=excluded.note, due=excluded.due, due_ms=excluded.due_ms,
      advance=excluded.advance, repeat_rule=excluded.repeat_rule, digest=excluded.digest,
      product_id=excluded.product_id, campaign_id=excluded.campaign_id,
      done=excluded.done, completed_at=excluded.completed_at,
      last_fired_at=excluded.last_fired_at, last_attempt_at=excluded.last_attempt_at,
      prev_due=excluded.prev_due, fired=excluded.fired, firing=excluded.firing,
      earliest_ms=excluded.earliest_ms
  `).run(p.id, p.title, p.note, p.due, p.due_ms, p.advance, p.repeat_rule, p.digest,
    p.product_id, p.campaign_id, p.source, p.message_id, p.created_at, p.done,
    p.completed_at, p.last_fired_at, p.last_attempt_at, p.prev_due, p.fired, p.firing,
    p.earliest_ms);
  reindexTask(p.id);
  return getTask(p.id);
}

/**
 * 只改指定字段，其余不动 —— 这是防止并发丢更新的关键：
 * 调度器不再把整张任务表读进内存再写回。
 */
function patchTask(id, patch) {
  const cur = getTask(id);
  if (!cur) return null;
  const next = { ...cur, ...patch };

  // due 与 dueMs 必须始终一致：调度器只认 dueMs（索引列）。
  // 一旦两个字段说的时间不同，任务就会「已经推到下周，却仍然每个 tick 被判到期」。
  if (patch.due !== undefined) {
    const parsed = Date.parse(next.due);
    next.dueMs = Number.isFinite(patch.dueMs) && patch.dueMs === parsed ? patch.dueMs : parsed;
  } else if (patch.dueMs !== undefined) {
    next.dueMs = patch.dueMs;
  }

  return putTask(next);
}

function getTask(id) {
  const r = open().prepare('SELECT * FROM tasks WHERE id = ?').get(id);
  return rowToTask(r);
}

function deleteTask(id) {
  const info = open().prepare('DELETE FROM tasks WHERE id = ?').run(id);
  unindex('task', id);
  return info.changes > 0;
}

/**
 * 到期扫描：只回到期的那几条（走 ix_tasks_due 索引）。
 * @returns {Array} 未完成且 earliest_ms <= now
 */
function dueTasks(nowMs = Date.now(), limit = 200) {
  const rows = open().prepare(
    'SELECT * FROM tasks WHERE done = 0 AND earliest_ms <= ? ORDER BY earliest_ms ASC LIMIT ?'
  ).all(nowMs, limit);
  return rows.map(rowToTask);
}

function listTasks({ done = null, productId = null, campaignId = null, limit = 100, offset = 0 } = {}) {
  const where = [];
  const args = [];
  if (done !== null) { where.push('done = ?'); args.push(done ? 1 : 0); }
  if (productId) { where.push('product_id = ?'); args.push(productId); }
  if (campaignId) { where.push('campaign_id = ?'); args.push(campaignId); }
  const sql = `SELECT * FROM tasks ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
               ORDER BY done ASC, earliest_ms ASC LIMIT ? OFFSET ?`;
  return open().prepare(sql).all(...args, limit, offset).map(rowToTask);
}

function taskCounts() {
  const r = open().prepare(`
    SELECT
      SUM(CASE WHEN done = 0 THEN 1 ELSE 0 END) AS open,
      SUM(CASE WHEN done = 1 THEN 1 ELSE 0 END) AS done
    FROM tasks
  `).get();
  return { open: Number(r.open || 0), done: Number(r.done || 0) };
}

/** 同一到期日（本地日期）里找相似标题，用于去重。 */
function tasksOnDate(dateKey) {
  // dateKey: YYYY-MM-DD（本地日）
  const start = Date.parse(`${dateKey}T00:00:00+08:00`);
  const end = start + 86400000;
  return open().prepare(
    'SELECT * FROM tasks WHERE done = 0 AND due_ms >= ? AND due_ms < ? ORDER BY due_ms'
  ).all(start, end).map(rowToTask);
}

// ── 产品 ───────────────────────────────────────────────────────

function rowToProduct(r) {
  if (!r) return null;
  let aliases = [];
  try { aliases = JSON.parse(r.aliases || '[]'); } catch (_) {}
  return {
    id: r.id, name: r.name, aliases, series: r.series || null,
    asin: r.asin || null, sku: r.sku || null, note: r.note || '',
    createdAt: r.created_at, updatedAt: r.updated_at,
  };
}

function putProduct(p) {
  const now = nowIso();
  const id = p.id || slug(p.name);
  const cur = getProduct(id);
  const aliases = uniq([...(p.aliases || []), p.name, p.asin, p.sku, ...(cur ? cur.aliases : [])]);
  open().prepare(`
    INSERT INTO products (id,name,aliases,series,asin,sku,note,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET
      name=excluded.name, aliases=excluded.aliases, series=COALESCE(excluded.series, products.series),
      asin=COALESCE(excluded.asin, products.asin), sku=COALESCE(excluded.sku, products.sku),
      note=excluded.note, updated_at=excluded.updated_at
  `).run(id, p.name, JSON.stringify(aliases), p.series || null, p.asin || null, p.sku || null,
    p.note || '', cur ? cur.createdAt : now, now);
  reindexProduct(id);
  return getProduct(id);
}

function getProduct(id) {
  return rowToProduct(open().prepare('SELECT * FROM products WHERE id = ?').get(id));
}

function listProducts({ series = null } = {}) {
  const sql = series
    ? 'SELECT * FROM products WHERE series = ? ORDER BY name'
    : 'SELECT * FROM products ORDER BY series, name';
  const args = series ? [series] : [];
  return open().prepare(sql).all(...args).map(rowToProduct);
}

function deleteProduct(id) {
  open().prepare('DELETE FROM products WHERE id = ?').run(id);
  unindex('product', id);
}

function slug(s) {
  return String(s || '').trim().toLowerCase()
    .replace(/[^\w\u4e00-\u9fff]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || `p-${Date.now()}`;
}

// ── 广告活动 ───────────────────────────────────────────────────

function rowToCampaign(r) {
  if (!r) return null;
  return {
    id: r.id, name: r.name, type: r.type || null, status: r.status || 'active',
    productId: r.product_id || null, note: r.note || '',
    createdAt: r.created_at, updatedAt: r.updated_at,
  };
}

function putCampaign(c) {
  const now = nowIso();
  const id = c.id || c.name;
  const cur = getCampaign(id);
  open().prepare(`
    INSERT INTO campaigns (id,name,type,status,product_id,note,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET
      name=excluded.name,
      type=COALESCE(excluded.type, campaigns.type),
      status=COALESCE(excluded.status, campaigns.status),
      product_id=COALESCE(excluded.product_id, campaigns.product_id),
      note=excluded.note, updated_at=excluded.updated_at
  `).run(id, c.name, c.type || null, c.status || 'active', c.productId || null,
    c.note || '', cur ? cur.createdAt : now, now);
  reindexCampaign(id);
  return getCampaign(id);
}

function getCampaign(id) {
  return rowToCampaign(open().prepare('SELECT * FROM campaigns WHERE id = ?').get(id));
}

function listCampaigns({ productId = null, limit = 100 } = {}) {
  const sql = productId
    ? 'SELECT * FROM campaigns WHERE product_id = ? ORDER BY updated_at DESC LIMIT ?'
    : 'SELECT * FROM campaigns ORDER BY updated_at DESC LIMIT ?';
  const args = productId ? [productId, limit] : [limit];
  return open().prepare(sql).all(...args).map(rowToCampaign);
}

function deleteCampaign(id) {
  open().prepare('DELETE FROM campaigns WHERE id = ?').run(id);
  unindex('campaign', id);
}

// ── 笔记 ───────────────────────────────────────────────────────

function rowToNote(r) {
  if (!r) return null;
  return {
    id: r.id, kind: r.kind, text: r.text, analysis: r.analysis || '',
    productId: r.product_id || null, campaignId: r.campaign_id || null,
    source: r.source || '', createdAt: r.created_at,
  };
}

function addNote(n) {
  const id = n.id || `n-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  open().prepare(`
    INSERT INTO notes (id,kind,text,analysis,product_id,campaign_id,source,created_at)
    VALUES (?,?,?,?,?,?,?,?)
  `).run(id, n.kind || 'ops', n.text, n.analysis || '', n.productId || null,
    n.campaignId || null, n.source || '', n.createdAt || nowIso());
  reindexNote(id);
  return getNote(id);
}

function getNote(id) {
  return rowToNote(open().prepare('SELECT * FROM notes WHERE id = ?').get(id));
}

function listNotes({ kind = null, productId = null, limit = 20 } = {}) {
  const where = [];
  const args = [];
  if (kind) { where.push('kind = ?'); args.push(kind); }
  if (productId) { where.push('product_id = ?'); args.push(productId); }
  const sql = `SELECT * FROM notes ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
               ORDER BY created_at DESC LIMIT ?`;
  return open().prepare(sql).all(...args, limit).map(rowToNote);
}

function deleteNote(id) {
  open().prepare('DELETE FROM notes WHERE id = ?').run(id);
  unindex('note', id);
}

// ── 对话（每日上下文）────────────────────────────────────────

function addTurn(t) {
  const date = t.date || localDateKey(new Date(t.at || Date.now()));
  open().prepare(`
    INSERT INTO turns (date,at,user,reply,intent,actions,degraded)
    VALUES (?,?,?,?,?,?,?)
  `).run(date, t.at || nowIso(), String(t.user || '').slice(0, 2000),
    String(t.reply || '').slice(0, 4000), t.intent || '',
    JSON.stringify(t.actions || []), t.degraded ? 1 : 0);
}

function rowToTurn(r) {
  let actions = [];
  try { actions = JSON.parse(r.actions || '[]'); } catch (_) {}
  return {
    id: r.id, date: r.date, at: r.at, user: r.user || '', reply: r.reply || '',
    intent: r.intent || '', actions, degraded: Boolean(r.degraded),
  };
}

function listTurns({ date = null, limit = 100 } = {}) {
  const sql = date
    ? 'SELECT * FROM turns WHERE date = ? ORDER BY id ASC LIMIT ?'
    : 'SELECT * FROM turns ORDER BY id DESC LIMIT ?';
  const args = date ? [date, limit] : [limit];
  const rows = open().prepare(sql).all(...args).map(rowToTurn);
  return date ? rows : rows.reverse();
}

function localDateKey(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

// ── 失败重试队列 ──────────────────────────────────────────────

function enqueueFailed(item) {
  const id = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  open().prepare(`
    INSERT INTO queue (id,text,meta,reason,reply,attempts,enqueued_at)
    VALUES (?,?,?,?,?,0,?)
  `).run(id, String(item.text || ''), JSON.stringify(item.meta || {}),
    item.reason || '', item.reply ? String(item.reply) : null, nowIso());
  return id;
}

function listFailed() {
  return open().prepare('SELECT * FROM queue ORDER BY enqueued_at').all().map((r) => ({
    id: r.id, text: r.text, meta: JSON.parse(r.meta || '{}'), reason: r.reason,
    reply: r.reply, attempts: r.attempts, enqueuedAt: r.enqueued_at,
  }));
}

function updateFailed(id, patch) {
  const cur = open().prepare('SELECT * FROM queue WHERE id = ?').get(id);
  if (!cur) return null;
  open().prepare('UPDATE queue SET attempts = ?, updated_at = ? WHERE id = ?')
    .run(clampInt(patch.attempts, cur.attempts), nowIso(), id);
  return id;
}

function removeFailed(id) {
  return open().prepare('DELETE FROM queue WHERE id = ?').run(id).changes > 0;
}

// ── 已见消息 ───────────────────────────────────────────────────

function isSeen(ids) {
  const list = Array.isArray(ids) ? ids : [ids];
  if (!list.length) return new Set();
  const hit = new Set();
  const stmt = open().prepare('SELECT 1 AS x FROM seen_messages WHERE message_id = ?');
  for (const id of list) if (stmt.get(id)) hit.add(id);
  return hit;
}

/**
 * 原子认领一条消息 —— 决定「谁来处理它」。
 *
 * 为什么需要这个：
 *   消息有两个来源（事件流 listener + 定时轮询 poller），
 *   它们可能几乎同时拿到同一条消息。如果先「查询是否见过」再「处理」再「登记」，
 *   两个来源都会看到「没见过」，于是各自处理一遍 → 用户收到两次回复。
 *
 *   INSERT OR IGNORE 的返回值（changes）是原子的：
 *   只有真正插入成功的那一方拿到 true，另一方拿到 false 立刻放弃。
 *   这一步必须在**处理之前**做，而不是处理之后。
 *
 * @returns {boolean} true = 认领成功，应当由本调用方处理
 */
function claim(id) {
  if (!id) return false;
  const info = open()
    .prepare('INSERT OR IGNORE INTO seen_messages (message_id, seen_at) VALUES (?,?)')
    .run(id, nowIso());
  return info.changes === 1;
}

/** 认领失败回滚（处理失败时允许重试队列接手）。 */
function unclaim(id) {
  if (!id) return;
  open().prepare('DELETE FROM seen_messages WHERE message_id = ?').run(id);
}

function markSeen(ids) {
  const list = Array.isArray(ids) ? ids : [ids];
  const stmt = open().prepare('INSERT OR IGNORE INTO seen_messages (message_id, seen_at) VALUES (?,?)');
  const at = nowIso();
  for (const id of list) if (id) stmt.run(id, at);
}

/** 只留最近 n 条，防止无限增长。 */
function pruneSeen(keep = 2000) {
  open().prepare(`
    DELETE FROM seen_messages WHERE message_id NOT IN (
      SELECT message_id FROM seen_messages ORDER BY seen_at DESC LIMIT ?
    )
  `).run(keep);
}

function countSeen() {
  return Number(open().prepare('SELECT COUNT(*) AS c FROM seen_messages').get().c || 0);
}

// ── key/value ──────────────────────────────────────────────────

function getKv(k, fallback = null) {
  const r = open().prepare('SELECT v FROM kv WHERE k = ?').get(k);
  if (!r) return fallback;
  try { return JSON.parse(r.v); } catch (_) { return r.v; }
}

function setKv(k, v) {
  open().prepare(`
    INSERT INTO kv (k,v) VALUES (?,?)
    ON CONFLICT(k) DO UPDATE SET v = excluded.v
  `).run(k, JSON.stringify(v));
}

// ── 全文检索 ───────────────────────────────────────────────────

/**
 * 中文二元分词：unicode61 会把一整串汉字当成一个词，
 * 所以入库和查询两侧都额外补上二元组（bigram），这样「白色」「632」「胡桃842」
 * 这类短片段都能命中。纯英文/数字串按原样保留。
 */
function tokenize(text) {
  const s = String(text || '');
  const out = [];
  const re = /[A-Za-z0-9][\w\-.]+|\d+[\w\-.]*|[\u4e00-\u9fff]+/g;
  let m;
  while ((m = re.exec(s))) {
    const w = m[0];
    if (/^[\u4e00-\u9fff]+$/.test(w)) {
      if (w.length <= 6) out.push(w);
      for (let i = 0; i < w.length - 1; i++) out.push(w.slice(i, i + 2));
    } else {
      out.push(w);
    }
  }
  return uniq(out);
}

function ftsEscape(t) {
  return `"${String(t).replace(/"/g, '""')}"`;
}

function indexBody(kind, ref, text) {
  const d = open();
  d.prepare('DELETE FROM search WHERE kind = ? AND ref = ?').run(kind, ref);
  d.prepare('INSERT INTO search (kind,ref,body) VALUES (?,?,?)')
    .run(kind, ref, tokenize(text).join(' '));
}

function unindex(kind, ref) {
  open().prepare('DELETE FROM search WHERE kind = ? AND ref = ?').run(kind, ref);
}

function reindexTask(id) {
  const t = getTask(id);
  if (t) indexBody('task', id, [t.title, t.note, t.productId, t.campaignId].join(' '));
}

function reindexProduct(id) {
  const p = getProduct(id);
  if (p) indexBody('product', id, [p.name, p.series, p.asin, p.sku, ...p.aliases].join(' '));
}

function reindexCampaign(id) {
  const c = getCampaign(id);
  if (c) indexBody('campaign', id, [c.name, c.type, c.productId, c.note].join(' '));
}

function reindexNote(id) {
  const n = getNote(id);
  if (n) indexBody('note', id, [n.text, n.analysis, n.kind].join(' '));
}

/**
 * 语义检索（当前用 FTS5 关键词近似）。
 * @param {string} query 用户的话或片段
 * @param {{kinds?:string[], limit?:number}} opts
 * @returns {Array<{kind:string, score:number, item:object}>}
 */
function search(query, { kinds = null, limit = 8 } = {}) {
  const tokens = tokenize(query);
  if (!tokens.length) return [];
  const expr = tokens.map(ftsEscape).join(' OR ');
  const rows = open().prepare(`
    SELECT kind, ref, bm25(search) AS score
    FROM search
    WHERE search MATCH ?
    ORDER BY score
    LIMIT ?
  `).all(expr, limit * 4);

  const out = [];
  for (const r of rows) {
    if (kinds && !kinds.includes(r.kind)) continue;
    let item = null;
    if (r.kind === 'task') item = getTask(r.ref);
    else if (r.kind === 'product') item = getProduct(r.ref);
    else if (r.kind === 'campaign') item = getCampaign(r.ref);
    else if (r.kind === 'note') item = getNote(r.ref);
    if (item) out.push({ kind: r.kind, score: r.score, item });
    if (out.length >= limit) break;
  }
  return out;
}

// ── 维护 ───────────────────────────────────────────────────────

/** 重建全文索引（迁移或数据被外部改动后调用）。 */
function reindexAll() {
  open().exec('DELETE FROM search');
  for (const t of listTasks({ done: null, limit: 100000 })) reindexTask(t.id);
  for (const p of listProducts()) reindexProduct(p.id);
  for (const c of listCampaigns({ limit: 100000 })) reindexCampaign(c.id);
  for (const n of listNotes({ limit: 100000 })) reindexNote(n.id);
}

/** 只做 COUNT(*)，不把整表读进内存（启动、控制台每 15 秒都会调用）。 */
function countTable(table) {
  return Number(open().prepare(`SELECT COUNT(*) AS c FROM ${table}`).get().c || 0);
}

function stats() {
  return {
    tasks: taskCounts(),
    products: countTable('products'),
    campaigns: countTable('campaigns'),
    notes: countTable('notes'),
    seen: countSeen(),
    queue: countTable('queue'),
    file: DB_FILE,
  };
}

module.exports = {
  DB_FILE,
  open, close,
  computeEarliest, localDateKey,
  // tasks
  insertTask, putTask, patchTask, getTask, deleteTask, dueTasks, listTasks,
  taskCounts, tasksOnDate,
  // products
  putProduct, getProduct, listProducts, deleteProduct, slug,
  // campaigns
  putCampaign, getCampaign, listCampaigns, deleteCampaign,
  // notes
  addNote, getNote, listNotes, deleteNote,
  // turns
  addTurn, listTurns,
  // queue
  enqueueFailed, listFailed, updateFailed, removeFailed,
  // seen
  isSeen, markSeen, claim, unclaim, pruneSeen, countSeen,
  // kv
  getKv, setKv,
  // search
  tokenize, search, indexBody, reindexAll,
  countTable,
  stats,
};
