'use strict';

/**
 * 主程序
 *
 * 职责：启动各组件、维护心跳、优雅退出。业务逻辑全在 core/ 下。
 *
 * 环境变量：
 *   BRIDGE_DRY=1        只跑调度和 API，不监听飞书、不发消息（调试用）
 *   BRIDGE_NO_WEB=1     不开控制台
 *   BRIDGE_WEB_PORT=    控制台端口
 */

const fs = require('fs');
const path = require('path');
const { config, paths } = require('../src/config');
const { log } = require('../src/util');
const store = require('./store');
const db = require('../src/db');
const inbox = require('./inbox');
const heartbeat = require('../src/heartbeat');

const DRY = process.env.BRIDGE_DRY === '1';
const NO_WEB = process.env.BRIDGE_NO_WEB === '1';

let shuttingDown = false;
const timers = {};

function writePid() {
  try { fs.writeFileSync(paths.pid, String(process.pid), 'utf8'); } catch (_) {}
}
function clearPid() {
  try {
    if (fs.existsSync(paths.pid)) {
      const cur = fs.readFileSync(paths.pid, 'utf8').trim();
      if (cur === String(process.pid)) fs.unlinkSync(paths.pid);
    }
  } catch (_) {}
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (_) {
    return false;
  }
}

/**
 * 单实例保护。
 *
 * 旧实现只在启动时读一次 pid 文件，而 pid 文件是「检查之后」才写的：
 * 启动后到写文件之间有一段窗口，两次几乎同时的启动都会通过检查
 *（实测真的起了两个进程，第二个的 4599 端口 EADDRINUSE、事件流也被抢）。
 *
 * 现在用 O_EXCL 原子创建锁文件：只有一个进程能创建成功；
 * 若锁已存在但 pid 已死（上次崩溃），就接管它。
 */
function acquireLock() {
  const file = paths.pid;

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      fs.writeFileSync(file, String(process.pid), { encoding: 'utf8', flag: 'wx' });
      return true;
    } catch (e) {
      if (e.code !== 'EEXIST') return true; // 无法建锁时不要挡住启动
    }

    const pid = parseInt(String(fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '').trim(), 10);
    if (pid && pid !== process.pid && alive(pid)) return false;

    // 陈旧的锁（进程已死）→ 删掉重试一次
    try { fs.unlinkSync(file); } catch (_) {}
  }

  return false;
}

/** 端口是否已被占用（防止两个实例抢同一个控制台端口）。 */
function portBusy(port) {
  const net = require('net');
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', (e) => resolve(e.code === 'EADDRINUSE'));
    srv.once('listening', () => srv.close(() => resolve(false)));
    srv.listen(port, '127.0.0.1');
  });
}

// ── 定时任务 ─────────────────────────────────────────────────

async function tick() {
  try {
    const { runTick } = require('../src/scheduler');
    const r = await runTick();
    if (r.fired || r.skipped) log('INFO', `tick: fired=${r.fired} skipped=${r.skipped || 0} due=${r.due}`);
  } catch (e) {
    log('ERROR', `tick failed: ${e.message}`);
  }
  if (!shuttingDown) timers.tick = setTimeout(tick, config.tickMs);
}

/**
 * 轮询兜底。
 *
 * 间隔是自适应的：
 *   · 事件流健康（已 ready 且最近 3 分钟收到过事件）→ 慢速 120 秒，只当保险
 *   · 事件流不正常（没 ready / 很久没事件）        → 快速 5 秒，接替实时接收
 *
 * 这样即使 lark-cli 的事件流某天彻底坏掉，消息也不会延迟 2 分钟才被发现。
 * 正常时段仍是 120 秒一次，不会额外消耗 API（一次 listMessages 约 1.5 秒）。
 */
const FAST_POLL_MS = 5000;
const SLOW_POLL_MS = 120000;
const LISTENER_STALE_MS = 3 * 60000;

function pollDelay() {
  const l = timers.listener;
  if (!l || typeof l.status !== 'function') return FAST_POLL_MS;

  const st = l.status();
  if (!st.ready) return FAST_POLL_MS;
  if (!st.lastEventAt) return SLOW_POLL_MS;
  return Date.now() - Date.parse(st.lastEventAt) > LISTENER_STALE_MS ? FAST_POLL_MS : SLOW_POLL_MS;
}

async function poll() {
  try {
    await inbox.pollOnce();
  } catch (e) {
    log('ERROR', `poll failed: ${e.message}`);
  }
  if (shuttingDown) return;
  const delay = pollDelay();
  if (delay === FAST_POLL_MS) {
    // 只在状态切换时说一次，避免刷屏
    if (!timers._fastPoll) {
      timers._fastPoll = true;
      log('WARN', 'poll: 事件流未就绪 → 切换到 5 秒快速轮询兜底');
    }
  } else if (timers._fastPoll) {
    timers._fastPoll = false;
    log('INFO', 'poll: 事件流已恢复 → 回到 120 秒保险轮询');
  }
  timers.poll = setTimeout(poll, delay);
}

async function retry() {
  try {
    await inbox.retryFailed();
  } catch (e) {
    log('ERROR', `retry failed: ${e.message}`);
  }
  if (!shuttingDown) timers.retry = setTimeout(retry, 120000);
}

function beat() {
  try { heartbeat.beat(); } catch (e) { log('ERROR', `heartbeat: ${e.message}`); }
  if (!shuttingDown) timers.beat = setTimeout(beat, 60000);
}

/** 每小时清理一次：已见消息表只留最近 3000 条，spool 里 3 天前的 job 文件删掉。 */
function housekeeping() {
  try { inbox.pruneSeenSafe(); } catch (e) { log('WARN', `housekeeping seen: ${e.message}`); }
  try { require('../src/scheduler').pruneSpool(); } catch (e) { log('WARN', `housekeeping spool: ${e.message}`); }
  if (!shuttingDown) timers.house = setTimeout(housekeeping, 3600000);
}

// 实时监听（事件流），收到即处理
function startListener() {
  const { EventListener } = require('../src/listener');
  const listener = new EventListener(async (msgs) => {
    await inbox.ingest(msgs, { ack: true });
  });
  listener.start();
  timers.listener = listener;
}

// ── 生命周期 ─────────────────────────────────────────────────

function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  log('INFO', `shutdown (${signal})`);
  if (timers.listener && timers.listener.stop) {
    try { timers.listener.stop(); } catch (_) {}
  }
  for (const k of ['tick', 'poll', 'retry', 'beat', 'house']) {
    if (timers[k]) clearTimeout(timers[k]);
  }
  // 杀掉所有 lark-cli 子进程，避免重启后累积孤儿进程占端口/卡 token
  try { require('../src/lark').killAll(); } catch (_) {}
  try { db.close(); } catch (_) {}
  clearPid();
  setTimeout(() => process.exit(0), 400);
}

function main() {
  // ── 首次运行体检：缺什么直接说人话，别让新人对着堆栈猜 ──
  if (!DRY) {
    if (!config.cliPathResolved) {
      log('ERROR', '没找到 lark-cli。跑 npm run setup 一键安装配置，或设置环境变量 LARK_CLI_PATH');
      process.exit(1);
    }
    if (!config.chatId) {
      log('WARN', 'chatId 未绑定 —— 跑 npm run setup 完成飞书授权与对话绑定（或手填 config.local.json）');
    }
    if (!config.llm.apiKey || !config.llm.baseUrl) {
      log('WARN', '大模型未配置 —— 期间所有消息走本地规则兜底。跑 npm run setup 或 node tools/setup-llm.js set <baseUrl> <model>');
    }
  }

  if (!DRY) {
    if (!acquireLock()) {
      log('WARN', '另一个实例在运行 — 退出');
      process.exit(0);
    }
  }

  log('INFO', `bridge start pid=${process.pid} dry=${DRY}`);

  // 迁移检查：如果数据库还不存在，提示先跑迁移
  try {
    const s = db.stats();
    log('INFO', `db: ${s.tasks.open} 待发 / ${s.tasks.done} 已完成 · 产品 ${s.products} · 活动 ${s.campaigns} · 笔记 ${s.notes} · 已见 ${s.seen}`);
    if (!s.products && !s.tasks.open) {
      log('WARN', '数据库是空的 —— 如果这是首次启动，先跑：node tools/migrate-to-sqlite.js');
    }
  } catch (e) {
    log('ERROR', `db open failed: ${e.message}`);
  }

  if (!NO_WEB) {
    const port = Number(process.env.BRIDGE_WEB_PORT || config.webPort || 4599);
    portBusy(port).then((busy) => {
      if (busy) {
        log('WARN', `端口 ${port} 已被占用（另一个实例？）— 本次不启动控制台，其余功能照常`);
        return;
      }
      try {
        require('../src/web').startWeb();
      } catch (e) {
        log('ERROR', `web start failed: ${e.message}`);
      }
    }).catch((e) => log('ERROR', `web port check failed: ${e.message}`));
  }

  if (!DRY) {
    startListener();
    poll();
  }
  retry();
  beat();
  housekeeping();
  tick();

  // 目录里的「数据覆盖到哪天」需要读表；放到启动后异步预热，
  // 这样第一条消息的规划路径不必等 2 秒的 lark-cli。
  setImmediate(() => {
    try { require('../src/catalog').warmCoverage(); } catch (e) { log('WARN', `warm catalog: ${e.message}`); }
  });

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('uncaughtException', (e) => log('ERROR', `uncaught: ${e.stack || e.message}`));
  process.on('unhandledRejection', (e) => log('ERROR', `unhandled: ${e && (e.stack || e.message)}`));
}

main();
