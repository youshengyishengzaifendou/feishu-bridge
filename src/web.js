'use strict';

/**
 * 控制台 API
 *
 * 只读 SQLite + 少量写（增删改提醒）。不再拼凑多个 JSON 文件。
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const { config, paths } = require('./config');
const { log } = require('./util');
const db = require('./db');
const catalog = require('./catalog');
const memory = require('./memory');
const tools = require('./tools');
const { parseMessage } = require('./parse');
const { sendText } = require('./lark');
const heartbeat = require('./heartbeat');
const llm = require('./llm');

const WEB = path.join(path.resolve(__dirname, '..'), 'web');
const PORT = Number(process.env.BRIDGE_WEB_PORT || config.webPort || 4599);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.woff2': 'font/woff2',
};

function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
}

function readBody(req, limit = 1e6) {
  return new Promise((resolve, reject) => {
    let data = '';
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new Error('body too large')); req.destroy(); return; }
      data += c;
    });
    req.on('end', () => {
      if (!data) return resolve({});
      try { resolve(JSON.parse(data)); } catch (e) { reject(new Error('invalid JSON')); }
    });
    req.on('error', reject);
  });
}

// ---------- derived state for the UI ----------

function taskView(t, now = Date.now()) {
  const dueMs = Number.isFinite(t.dueMs) ? t.dueMs : Date.parse(t.due);
  const valid = Number.isFinite(dueMs);
  const advance = Array.isArray(t.advance) ? t.advance : [0];
  const fired = Array.isArray(t.fired) ? t.fired : [];

  const pending = advance.filter((a) => !fired.includes(String(a))).sort((a, b) => b - a);
  const nextAdvance = pending.length ? pending[0] : null;

  let status = 'scheduled';
  if (t.done) status = 'done';
  else if (valid && dueMs - now < 0) status = 'overdue';
  else if (valid && dueMs - now < 24 * 3600 * 1000) status = 'soon';

  const product = t.productId ? db.getProduct(t.productId) : null;
  const campaign = t.campaignId ? db.getCampaign(t.campaignId) : null;

  return {
    id: t.id,
    title: t.title,
    due: t.due,
    dueMs: valid ? dueMs : null,
    note: t.note || '',
    source: t.source || '',
    done: Boolean(t.done),
    status,
    advance,
    fired,
    nextAdvance,
    remainingMs: valid ? dueMs - now : null,
    createdAt: t.createdAt || null,
    completedAt: t.completedAt || null,
    repeat: t.repeat || null,
    product: product ? { id: product.id, name: product.name } : null,
    campaign: campaign ? { id: campaign.id, name: campaign.name } : null,
  };
}

function snapshot() {
  const now = Date.now();
  const raw = db.listTasks({ done: null, limit: 500 });
  const tasks = raw.map((t) => taskView(t, now));

  const open = tasks.filter((t) => !t.done);
  const done = tasks.filter((t) => t.done);

  const hb = (() => {
    try {
      return JSON.parse(fs.readFileSync(path.join(paths.db, '..', 'heartbeat.json'), 'utf8'));
    } catch (_) { return null; }
  })();

  // 健康面板：这三项决定了「它现在到底有没有在干活」，
  // 之前控制台只有「进程在不在」，listener 死了、模型被限流了都看不出来。
  let health = null;
  try {
    const h = heartbeat.health();
    health = {
      alive: h.alive,
      lastHeartbeat: h.lastAgoSeconds,
      note: h.note,
      llmConfigured: llm.isConfigured(),
      llmBreaker: llm.breakerState(),
      queue: db.countTable('queue'),
      lastPoll: db.getKv('lastPollAt', null),
    };
  } catch (e) {
    health = { error: e.message };
  }

  let pid = null;
  try { pid = parseInt(fs.readFileSync(paths.pid, 'utf8').trim(), 10); } catch (_) {}
  let alive = false;
  if (pid) { try { process.kill(pid, 0); alive = true; } catch (_) {} }

  const turns = db.listTurns({ date: db.localDateKey(new Date()), limit: 30 });

  // 前端要的三块流式数据，之前 snapshot 根本没返回（feed / review / instructions
  // 恒为 undefined），所以「最近收到的消息」「没识别出时间」「待处理的指令」三节永远是空的。
  const feed = turns.slice().reverse().slice(0, 8).map((t) => ({
    text: String(t.user || '').slice(0, 200),
    receivedAt: String(t.at || '').slice(11, 16),
    parsed: Array.isArray(t.actions) && t.actions.length > 0,
    intent: t.intent || '',
  }));

  return {
    now,
    serverTime: new Date().toISOString(),
    tasks,
    stats: {
      open: open.length,
      done: done.length,
      overdue: open.filter((t) => t.status === 'overdue').length,
      soon: open.filter((t) => t.status === 'soon').length,
      seenMessages: db.countSeen(),
      products: db.countTable('products'),
      campaigns: db.countTable('campaigns'),
      notes: db.countTable('notes'),
      lastPoll: db.getKv('lastPollAt', null),
    },
    service: {
      running: alive,
      pid,
      chatId: config.chatId,
      profile: config.profile,
      tickMs: config.tickMs,
      pollMs: config.pollMs,
      advance: config.advanceMinutes,
      heartbeat: hb ? hb.last : null,
      dbFile: db.DB_FILE,
    },
    products: db.listProducts(),
    campaigns: db.listCampaigns({ limit: 200 }).map((c) => {
      const p = c.productId ? db.getProduct(c.productId) : null;
      return { id: c.id, name: c.name, type: c.type, status: c.status, product: p ? p.name : null };
    }),
    notes: db.listNotes({ limit: 20 }),
    turns,
    feed,
    review: [],
    instructions: [],
    health,
  };
}

// ---------- routes ----------

async function handleApi(req, res, url) {
  const p = url.pathname;

  if (req.method === 'GET' && p === '/api/state') {
    return json(res, 200, snapshot());
  }

  // 数据目录（给前端展示「它知道什么」）
  if (req.method === 'GET' && p === '/api/catalog') {
    return json(res, 200, { ok: true, catalog: catalog.build({ force: url.searchParams.get('force') === '1' }) });
  }

  // 手动跑一次工具（调试用）
  if (req.method === 'POST' && p === '/api/tool') {
    const body = await readBody(req);
    const r = tools.run([{ name: body.name, args: body.args || {} }]);
    return json(res, 200, { ok: true, ...r });
  }

  // 检索
  if (req.method === 'GET' && p === '/api/search') {
    const q = url.searchParams.get('q') || '';
    return json(res, 200, { ok: true, hits: db.search(q, { limit: 15 }).map((h) => ({
      kind: h.kind,
      score: Math.round(h.score * 100) / 100,
      label: h.kind === 'task' ? h.item.title
        : h.kind === 'product' ? h.item.name
        : h.kind === 'campaign' ? h.item.name
        : String(h.item.text || '').slice(0, 80),
    })) });
  }

  // 产品档案
  const mProd = p.match(/^\/api\/products\/([^/]+)$/);
  if (mProd && req.method === 'GET') {
    const card = memory.productCard(decodeURIComponent(mProd[1]));
    return card ? json(res, 200, { ok: true, ...card }) : json(res, 404, { ok: false, error: '未找到产品' });
  }

  // 广告活动归属
  if (req.method === 'POST' && p === '/api/assign') {
    const body = await readBody(req);
    if (!body.name || !body.product) return json(res, 400, { ok: false, error: '需要 name 和 product' });
    const r = memory.recordCampaign({ name: body.name, productName: body.product });
    return json(res, 200, {
      ok: true,
      campaign: r.campaign.name,
      product: r.product ? r.product.name : null,
      resolvedBy: r.resolvedBy,
    });
  }

  if (req.method === 'POST' && p === '/api/tasks') {
    const body = await readBody(req);
    const text = String(body.text || '').trim();
    if (!text) return json(res, 400, { ok: false, error: '内容不能为空' });

    let due = body.due ? String(body.due) : null;
    let title = String(body.title || text).trim();

    if (!due) {
      const parsed = parseMessage(text);
      if (!parsed) return json(res, 400, { ok: false, error: '没能识别出日期，请写明时间，例如「11月3日 上午10点」' });
      due = parsed.due;
      title = parsed.title;
    }

    const dueMs = Date.parse(due);
    if (Number.isNaN(dueMs)) {
      return json(res, 400, { ok: false, error: '时间格式无法识别' });
    }

    const task = {
      id: `ui-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      title,
      due,
      dueMs,
      advance: Array.isArray(body.advance) && body.advance.length ? body.advance : config.advanceMinutes.slice(),
      note: body.note ? String(body.note) : '网页添加',
      source: 'web',
      createdAt: new Date().toISOString(),
      done: false,
      fired: [],
      firing: [],
    };
    const saved = db.insertTask(task);
    return json(res, 201, { ok: true, task: taskView(saved) });
  }

  const mTask = p.match(/^\/api\/tasks\/([^/]+)$/);
  if (mTask) {
    const id = decodeURIComponent(mTask[1]);

    if (req.method === 'PATCH') {
      const body = await readBody(req);
      const patch = {};
      if (body.title !== undefined) patch.title = String(body.title);
      if (body.due !== undefined) { patch.due = String(body.due); patch.dueMs = Date.parse(patch.due); }
      if (body.note !== undefined) patch.note = String(body.note);
      if (body.done !== undefined) {
        patch.done = Boolean(body.done);
        patch.completedAt = body.done ? new Date().toISOString() : null;
      }
      const t = db.patchTask(id, patch);
      if (!t) return json(res, 404, { ok: false, error: '未找到该提醒' });
      return json(res, 200, { ok: true, task: taskView(t) });
    }

    if (req.method === 'DELETE') {
      const ok = db.deleteTask(id);
      if (!ok) return json(res, 404, { ok: false, error: '未找到该提醒' });
      return json(res, 200, { ok: true });
    }
  }

  if (req.method === 'POST' && p === '/api/parse') {
    const body = await readBody(req);
    const parsed = parseMessage(String(body.text || ''));
    return json(res, 200, { ok: true, parsed });
  }

  if (req.method === 'POST' && p === '/api/test') {
    const body = await readBody(req);
    const text = String(body.text || '来自控制台的测试消息');
    const r = await sendText(text);
    return json(res, r.ok ? 200 : 502, { ok: r.ok, error: r.ok ? undefined : (r.error || '发送失败') });
  }

  return json(res, 404, { ok: false, error: 'not found' });
}

function serveStatic(req, res, url) {
  let rel = decodeURIComponent(url.pathname);
  if (rel === '/' || rel === '') rel = '/index.html';

  const target = path.normalize(path.join(WEB, rel));
  if (!target.startsWith(WEB)) {
    res.writeHead(403); return res.end('forbidden');
  }

  fs.stat(target, (err, st) => {
    if (err || !st.isFile()) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      return res.end('not found');
    }
    const ext = path.extname(target).toLowerCase();
    res.writeHead(200, {
      'content-type': MIME[ext] || 'application/octet-stream',
      'cache-control': ext === '.html' ? 'no-store' : 'public, max-age=3600',
    });
    fs.createReadStream(target).pipe(res);
  });
}

function startWeb() {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://localhost:${PORT}`);
    try {
      if (url.pathname.startsWith('/api/')) {
        await handleApi(req, res, url);
      } else {
        serveStatic(req, res, url);
      }
    } catch (e) {
      log('ERROR', `web: ${e.message}`);
      if (!res.headersSent) json(res, 500, { ok: false, error: e.message });
    }
  });

  server.listen(PORT, '127.0.0.1', () => {
    log('INFO', `web console: http://127.0.0.1:${PORT}`);
  });

  server.on('error', (e) => {
    log('ERROR', `web server failed: ${e.message}`);
  });

  return server;
}

module.exports = { startWeb, snapshot };
