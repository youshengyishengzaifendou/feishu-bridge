'use strict';

/**
 * 存储层适配 —— 全部转到 SQLite
 *
 * 这个文件只做「旧接口 → db.js」的映射，让 core/ 下的调用点不用大改。
 * 真正的读写逻辑和表结构都在 src/db.js。
 *
 * 旧的 data/tasks.json / notes.json / state.json / review.json / daily 已经迁移进
 * data/bridge.db（见 tools/migrate-to-sqlite.js），JSON 文件保留为只读快照。
 */

const fs = require('fs');
const path = require('path');
const db = require('../src/db');
const { log } = require('../src/util');

const DATA = path.join(__dirname, '..', 'data');

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

// ── 提醒 ───────────────────────────────────────────────────────

function loadTasks() {
  return db.listTasks({ done: null, limit: 100000 });
}

function openTasks() {
  return db.listTasks({ done: false, limit: 100000 });
}

function getTask(id) {
  return db.getTask(id);
}

function saveTask(task) {
  return db.putTask(task);
}

function patchTask(id, patch) {
  return db.patchTask(id, patch);
}

function removeTask(id) {
  return db.deleteTask(id);
}

function addTask(task) {
  const exists = db.getTask(task.id);
  if (exists) return { added: false, task: exists };
  const saved = db.insertTask(task);
  log('INFO', `task added id=${task.id} due=${task.due} title="${task.title}"`);
  return { added: true, task: saved };
}

function dueTasks(nowMs) {
  return db.dueTasks(nowMs);
}

// ── 产品 / 活动 / 笔记 ─────────────────────────────────────────

function loadProducts() { return db.listProducts(); }
function getProduct(id) { return db.getProduct(id); }
function saveProduct(p) { return db.putProduct(p); }

function loadCampaigns(opts) { return db.listCampaigns(opts || {}); }
function getCampaign(id) { return db.getCampaign(id); }
function saveCampaign(c) { return db.putCampaign(c); }

function loadNotes(limit = 20) {
  return db.listNotes({ limit });
}

function addNote(note) {
  return db.addNote(note);
}

// ── 对话上下文 ─────────────────────────────────────────────────

function todayKey(d = new Date()) {
  return db.localDateKey(d);
}

function loadToday() {
  const key = todayKey();
  return { date: key, turns: db.listTurns({ date: key, limit: 300 }) };
}

function saveToday(record) {
  // 兼容旧调用：只把新增的最后一轮写进库
  const turns = Array.isArray(record && record.turns) ? record.turns : [];
  const last = turns[turns.length - 1];
  if (last && last._saved !== true) {
    db.addTurn({
      date: record.date || todayKey(),
      at: last.at,
      user: last.user,
      reply: last.reply,
      intent: last.intent,
      actions: last.actions,
      degraded: last.degraded,
    });
    last._saved = true;
  }
}

function appendTurn(t) {
  db.addTurn(t);
}

function recentTurns(n = 5) {
  return db.listTurns({ limit: n });
}

function writeSummaryUndated(content, dateKey) {
  const dir = path.join(DATA, 'daily', 'summaries');
  ensureDir(dir);
  fs.writeFileSync(path.join(dir, `${dateKey}.md`), content, 'utf8');
}

function lastSummaryBrief() {
  const dir = path.join(DATA, 'daily', 'summaries');
  try {
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.md')).sort();
    if (!files.length) return null;
    const last = files[files.length - 1];
    const key = last.replace('.md', '');
    if (key === todayKey()) return null;
    const text = fs.readFileSync(path.join(dir, last), 'utf8');
    const brief = text.split('\n').filter((x) => x.trim()).slice(1, 4).join(' / ');
    return { date: key, brief: brief.slice(0, 260) };
  } catch (_) {
    return null;
  }
}

// ── 已见消息 ───────────────────────────────────────────────────

function isSeen(ids) {
  return db.isSeen(ids);
}

function markSeen(ids) {
  db.markSeen(ids);
}

function loadState() {
  return {
    seenCount: db.countSeen(),
    lastPollAt: db.getKv('lastPollAt', null),
    lastTickAt: db.getKv('lastTickAt', null),
  };
}

function saveState() {
  // SQLite 里已见 id 是逐条写入的，这里只是为了兼容旧调用点
}

// ── 重试队列 ───────────────────────────────────────────────────

function enqueueFailed(item) {
  return db.enqueueFailed(item);
}

function listFailed() {
  return db.listFailed();
}

function updateFailed(id, patch) {
  return db.updateFailed(id, patch);
}

function removeFailed(id) {
  return db.removeFailed(id);
}

// ── 杂项 ───────────────────────────────────────────────────────

function stats() {
  return db.stats();
}

function search(q, opts) {
  return db.search(q, opts);
}

module.exports = {
  DATA, ensureDir,
  // tasks
  loadTasks, openTasks, getTask, saveTask, patchTask, removeTask, addTask, dueTasks,
  // entities
  loadProducts, getProduct, saveProduct,
  loadCampaigns, getCampaign, saveCampaign,
  loadNotes, addNote,
  // turns
  todayKey, loadToday, saveToday, appendTurn, recentTurns,
  writeSummaryUndated, lastSummaryBrief,
  // seen / state
  isSeen, markSeen, loadState, saveState,
  // queue
  enqueueFailed, listFailed, updateFailed, removeFailed,
  // search / stats
  search, stats,
};
