'use strict';

/**
 * 消息接入 —— 从飞书拉取新消息，交给 router 处理
 *
 * 这是唯一的「进来」入口。
 *
 * 处理节奏（两段式）：
 *   ① 收到即回执 —— 立刻发一句「收到，我去查…」，不等 LLM、不等锁
 *   ② 后台干活   —— 查数据 / 建提醒 / 记笔记，完成后把结果发出来
 *
 * 为什么拆成两段：
 *   完整处理要调 LLM（2~20 秒），期间老板什么都看不到。
 *   先回执能立刻确认「收到了」，避免以为消息丢了或者卡死。
 *
 * 处理失败才入重试队列。
 */

const { config } = require('../src/config');
const { log } = require('../src/util');
const { listMessages, sendText } = require('../src/lark');
const store = require('./store');
const router = require('./router');
const db = require('../src/db');
const ackText = require('../src/ack');

/**
 * 进程内串行锁 —— 保证同一时刻只有一批消息在处理。
 *
 * 为什么需要：
 *   listener（事件流）和 poller（定时轮询）是两个独立的异步入口，
 *   它们可能在同一瞬间都调用 ingest。bot 的回复本身也会进入聊天记录，
 *   一旦交错处理，容易出现顺序错乱、上下文串味、重复回复等问题。
 *
 *   SQLite 的 claim() 保证「一条消息只被处理一次」；
 *   这把锁进一步保证「同一时刻只处理一批」，两者互补。
 */
let chain = Promise.resolve();
let busy = false;

function withLock(fn) {
  const run = chain.then(async () => {
    busy = true;
    try {
      return await fn();
    } finally {
      busy = false;
    }
  });
  // 即使这一环抛错，也不能把后面的链条卡死
  chain = run.catch(() => {});
  return run;
}

function isBusy() {
  return busy;
}

/**
 * 处理一批原始飞书消息对象。
 *
 * 两段式：
 *   ① 收下 + 回执  —— 在锁外，立刻做，不排队
 *   ② 干活        —— 在锁内，串行执行，保证上下文不错乱
 *
 * 回执必须在锁外：如果上一条消息正在跑 LLM（可能 20 秒），
 * 新消息的回执如果也去抢锁，老板就要干等 20 秒才看到「收到」，那就失去意义了。
 *
 * @param {Array} messages 飞书消息数组（listener 或轮询产出）
 * @param {{ack?:boolean, instantReply?:boolean}} opts
 *   ack=false          → 只认领、不回复（回填用）
 *   instantReply=false → 不发即时回执，只回最终结果
 */
async function ingest(messages, { ack = true, instantReply = true } = {}) {
  const list = Array.isArray(messages) ? messages : [];
  const accepted = [];
  let skipped = 0;

  // ── ① 收下 + 立刻回执（锁外）──
  for (const msg of list) {
    const id = msg.message_id || msg.messageId;
    if (!id) continue;

    // 只处理真人发的；机器人/应用消息直接认领掉，避免被反复拉到
    const senderType = msg.sender && (msg.sender.sender_type || msg.sender.senderType);
    const isUser = senderType ? senderType === 'user' : msg.sender_type === 'user';
    if (!isUser) { db.claim(id); skipped++; continue; }

    const text = typeof msg.content === 'string' ? msg.content : (msg.text || '');
    const chatId = msg.chat_id || config.chatId;

    if (!String(text || '').trim()) { db.claim(id); skipped++; continue; }

    // ★ 原子认领：事件流和轮询可能同时拿到同一条消息。
    //   只有抢到的那一方处理，另一方直接跳过 —— 这是「回复两次」的根因修复。
    if (!db.claim(id)) { skipped++; continue; }

    // 消息在飞书上的发出时刻。用它算「发现延迟」，
    // 这是回执慢的真正来源（不是发送那 1 秒）。
    const arrival = msg.create_time ? Date.parse(msg.create_time) : null;

    log('INFO', `in: ${String(text).slice(0, 60).replace(/\n/g, ' ')}`);
    accepted.push({ id, text, chatId });

    if (!ack) continue;

    // 收到即回执：纯本地判断，不调 LLM
    if (instantReply && config.instantReply !== false) {
      const wake = ackText.build(text);
      const t0 = Date.now();
      try {
        // 立刻发，不等任何东西：先占住「我收到了」这一句
        const sr = await sendText(wake, { chatId });
        const sendMs = Date.now() - t0;
        const total = Number.isFinite(arrival) ? `${Date.now() - arrival}ms` : '—';
        log('INFO', `ack: "${wake}" ${sr.ok ? 'ok' : `FAIL ${sr.error || ''}`} 发送=${sendMs}ms 发现→送达=${total}`);
      } catch (e) {
        log('WARN', `ack failed: ${e.message}`);
      }
    }
  }

  if (!accepted.length) {
    db.setKv('lastPollAt', new Date().toISOString());
    return { handled: 0, skipped, failed: 0, total: list.length };
  }

  // ── ② 干活（锁内串行）──
  return withLock(async () => {
    const stat = { handled: 0, skipped, failed: 0, total: list.length };

    for (const item of accepted) {
      if (!ack) { stat.handled++; continue; }
      try {
        const r = await router.handleAndSend(item.text, { messageId: item.id, chatId: item.chatId });
        if (r.ok && r.sent) stat.handled++;
        else stat.failed++;
        log('INFO', `out: intent=${r.intent} tools=${(r.tools || []).join(',') || '-'} sent=${Boolean(r.sent)}`);
      } catch (e) {
        log('ERROR', `ingest failed: ${e.message}`);
        stat.failed++;
      }
    }

    db.setKv('lastPollAt', new Date().toISOString());
    if (stat.handled || stat.failed) {
      log('INFO', `ingest: handled=${stat.handled} failed=${stat.failed} skipped=${stat.skipped}`);
    }
    return stat;
  });
}

/**
 * 拉一次飞书消息并处理。
 */
async function pollOnce() {
  // 事件流正在处理消息时不轮询，避免两路同时灌进来
  if (busy) {
    log('INFO', 'poll: 跳过（事件流正在处理）');
    return { handled: 0, skipped: 0, failed: 0 };
  }

  const r = await listMessages(config.chatId, 30);
  if (!r.ok) {
    log('WARN', 'poll: 拉取消息失败');
    return { handled: 0, skipped: 0, failed: 0 };
  }
  // 飞书返回是倒序，反转成时间正序
  return ingest((r.messages || []).slice().reverse(), { ack: true });
}

/**
 * 消息保活：已见 id 不能无限长，也不能把「最近仍在轮询窗口内」的删掉。
 * 旧实现有 pruneSeen() 但从来没人调用，库里会按「每条消息一行」永久增长。
 */
function pruneSeenSafe() {
  try {
    db.pruneSeen(3000);
  } catch (e) {
    log('WARN', `pruneSeen failed: ${e.message}`);
  }
}

/**
 * 重试队列。
 *
 * 两种失败要分开对待：
 *   · send-failed  —— 回复已生成、动作已执行，只补发这条消息（不重跑动作）
 *   · handle-failed / deferred —— 还没产生副作用，整条重跑
 *
 * 之前两者都走 handleAndSend，导致「发送失败 → 重试 → 任务被建第二遍」。
 *
 * 重试上限按「创建时间」算：旧实现只在 attempts 上累加，
 * 一条永远发不出去的消息（例如 chat_id 失效）会永久占着队列，
 * attempts 每次 +1 却永远到不了 3 就会被下一次写入覆盖 —— 队列只增不减。
 */
const MAX_ATTEMPTS = 3;
const MAX_QUEUE_AGE_MS = 6 * 3600 * 1000;

async function retryFailed() {
  const items = store.listFailed();
  if (!items.length) return 0;

  // 重试会整条重跑 router.handleAndSend（可能读表 + 调模型）。
  // 必须在锁内串行，否则会和 listener/轮询的处理交错，上下文串味、动作重复。
  return withLock(async () => {
    let ok = 0;
    for (const it of items) {
      const attempts = (it.attempts || 0) + 1;
      const age = Date.now() - Date.parse(it.enqueuedAt || 0);

      if (attempts > MAX_ATTEMPTS || age > MAX_QUEUE_AGE_MS) {
        store.removeFailed(it.id);
        const why = attempts > MAX_ATTEMPTS ? `已试 ${MAX_ATTEMPTS} 次` : `积压超过 ${Math.round(MAX_QUEUE_AGE_MS / 3600000)} 小时`;
        log('WARN', `retry: 放弃 ${it.id}（${why}）reason=${it.reason || '-'}`);
        continue;
      }

      try {
        let sent = false;

        if (it.reason === 'send-failed' && it.reply) {
          // 只补发，不重跑动作
          const r = await router.resend(it.reply, it.meta || {});
          sent = r.sent;
          if (sent) log('INFO', `retry: 补发成功 ${it.id}`);
        } else {
          const r = await router.handleAndSend(it.text, it.meta || {});
          sent = r.ok && r.sent;
        }

        if (sent) {
          store.removeFailed(it.id);
          ok++;
        } else {
          store.updateFailed(it.id, { attempts });
        }
      } catch (e) {
        log('WARN', `retry: ${it.id} 异常 ${e.message}`);
        store.updateFailed(it.id, { attempts });
      }
    }
    if (ok) log('INFO', `retry: 成功 ${ok} 条`);
    return ok;
  });
}

module.exports = { ingest, pollOnce, retryFailed, isBusy, pruneSeenSafe, MAX_ATTEMPTS };
