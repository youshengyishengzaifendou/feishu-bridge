'use strict';

/**
 * 实时事件监听（流式）
 *
 * ── 为什么重写 ────────────────────────────────────────────────
 *
 * 旧实现用 `--output-dir` 把事件写成文件，**只在窗口关闭时才读文件**
 * （`_drain` 在 `close` 事件里调用）。窗口是 120 秒，于是：
 *
 *   你 08:44 发消息 → 事件 08:44 就到了 → 但要等窗口结束（08:45:44）才被处理
 *   → 实测「发现延迟」中位数 60 秒、最坏接近 120 秒。
 *
 * 真正的瓶颈不是发消息那 1 秒，而是**几十秒才发现消息**。
 *
 * 现在改成读 `lark-cli event consume` 的 **stdout（NDJSON 流）**：
 * 事件一到就立刻解析、立刻交给 ingest，发现延迟从「几十秒」降到「<1 秒」。
 * 窗口仍然保留（用于定期自我重启，避免长连接老化），但不再影响投递速度。
 *
 * lark-cli 的 `event _bus` 守护进程会持续保持订阅，窗口之间的
 * ~1 秒空档里事件在服务端排队，重连后补发，不会丢。
 */

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { config, paths } = require('./config');
const { log } = require('./util');
const lark = require('./lark');

const WINDOW_SECONDS = 120;

/** 从 lark-cli 的一行 NDJSON 里取出可用的消息对象。 */
function parseEventLine(line) {
  const s = String(line || '').trim();
  if (!s || s[0] !== '{') return null;

  let ev;
  try { ev = JSON.parse(s); } catch (_) { return null; }

  // 事件里 message_id 是推荐的幂等键；id 是旧字段
  const messageId = ev.message_id || ev.id;
  if (!messageId) return null;

  // 只处理真人消息。机器人自己的回复 sender_type 是 bot/app，交给 inbox 丢弃
  const senderType = ev.sender_type || (ev.sender && ev.sender.sender_type);
  if (senderType && senderType !== 'user') return null;

  const text = typeof ev.content === 'string' ? ev.content : '';
  if (!text.trim()) return null;

  return {
    message_id: messageId,
    content: text,
    chat_id: ev.chat_id || config.chatId,
    chat_type: ev.chat_type || 'p2p',
    create_time: ev.create_time
      ? new Date(Number(ev.create_time)).toISOString()
      : new Date().toISOString(),
    sender: { sender_type: 'user', sender_id: ev.sender_id || null },
  };
}

class EventListener {
  constructor(onEvents) {
    this.onEvents = onEvents;
    this.child = null;
    this.stopped = false;
    this.retry = 0;
    this.ready = false;
    this.timer = null;
    this.buf = '';
    this.lastEventAt = null;
  }

  start() {
    this.stopped = false;
    this._loop();
  }

  stop() {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    if (this.child) {
      try { this.child.kill(); } catch (_) {}
    }
  }

  /** 给健康检查用：最近一次收到事件距今多久。 */
  status() {
    return {
      ready: this.ready,
      running: Boolean(this.child),
      lastEventAt: this.lastEventAt,
      retry: this.retry,
    };
  }

  _loop() {
    if (this.stopped) return;

    const outDir = path.join(paths.spool, 'events');
    for (const d of [paths.spool, outDir]) {
      if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
    }

    // 不再用 --output-dir：那是「窗口结束才读」的根源。
    // 保留 --quiet 关闭（需要 ready 标记判断健康）。
    const args = [
      'event', 'consume', 'im.message.receive_v1',
      '--as', 'bot',
      '--timeout', `${WINDOW_SECONDS}s`,
    ];
    if (config.profile) args.push('--profile', config.profile);

    let child;
    try {
      child = lark.spawnCli(args, { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      log('ERROR', `listener spawn failed: ${e.message}`);
      return this._scheduleRestart();
    }

    this.child = child;
    this.ready = false;
    this.buf = '';

    // ── 流式：每收到一行就立刻处理 ──
    child.stdout.on('data', (chunk) => {
      this.buf += chunk.toString();
      const lines = this.buf.split('\n');
      this.buf = lines.pop(); // 最后一段可能不完整，留到下一块

      const msgs = [];
      for (const line of lines) {
        const m = parseEventLine(line);
        if (m) msgs.push(m);
      }
      if (msgs.length) this._dispatch(msgs);
    });

    let stderr = '';
    child.stderr.on('data', (d) => {
      stderr += d.toString();
      if (!this.ready && stderr.includes('ready event_key')) {
        this.ready = true;
        log('INFO', 'listener: ready（流式接收中）');
      }
    });

    child.on('error', (e) => {
      log('ERROR', `listener error: ${e.message}`);
      this.child = null;
      this._scheduleRestart();
    });

    child.on('close', (code) => {
      this.child = null;
      this.ready = false;
      if (this.stopped) return;

      // 处理缓冲区里可能剩下的最后一行
      if (this.buf) {
        const m = parseEventLine(this.buf);
        this.buf = '';
        if (m) this._dispatch([m]);
      }

      // 正常窗口结束（timeout）不算故障
      if (code === 0) {
        this.retry = 0;
        this.timer = setTimeout(() => this._loop(), 500);
        return;
      }

      log('WARN', `listener exited code=${code} :: ${stderr.slice(-160).replace(/\s+/g, ' ')}`);
      this._scheduleRestart();
    });
  }

  /** 事件立刻入队，不阻塞本次读取。 */
  _dispatch(msgs) {
    if (!msgs.length) return;
    this.lastEventAt = new Date().toISOString();
    log('INFO', `listener: ${msgs.length} new message(s)`);
    msgs.sort((a, b) => String(a.create_time).localeCompare(String(b.create_time)));
    Promise.resolve()
      .then(() => this.onEvents(msgs))
      .catch((e) => log('ERROR', `listener ingest failed: ${e.message}`));
  }

  _scheduleRestart() {
    if (this.stopped) return;
    this.retry = Math.min(this.retry + 1, 6);
    const delay = config.listenerRestartMs * this.retry;
    log('WARN', `listener restart in ${delay}ms (attempt ${this.retry})`);
    this.timer = setTimeout(() => this._loop(), delay);
  }
}

module.exports = { EventListener, parseEventLine, WINDOW_SECONDS };
