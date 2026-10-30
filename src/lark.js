'use strict';

const { spawn } = require('child_process');
const path = require('path');
const { config } = require('./config');

// 本进程起过的所有 lark-cli 子进程。退出时必须一并杀掉，
// 否则每次重启都会在后台留下孤儿进程（实测会累积成一片 node.exe）。
const live = new Set();

function track(child) {
  live.add(child);
  const drop = () => live.delete(child);
  child.on('close', drop);
  child.on('error', drop);
  return child;
}

/** 杀掉所有还在跑的 lark-cli 子进程（进程退出时调用）。 */
function killAll() {
  for (const c of Array.from(live)) {
    try { c.kill(); } catch (_) {}
    live.delete(c);
  }
}

function cliBin() {
  return config.cliPathResolved || config.cliPath;
}

function spawnCli(args, opts = {}) {
  const bin = cliBin();
  if (!bin) throw new Error('lark-cli 未找到：运行 npm run setup 安装，或设置环境变量 LARK_CLI_PATH');
  return track(spawn(bin, args, { windowsHide: true, ...opts }));
}

// Small promise wrapper around lark-cli with a hard timeout.
// lark-cli prints JSON on stdout; stderr carries progress noise.
function runCli(args, { timeoutMs = 60000 } = {}) {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let done = false;

    let child;
    try {
      child = spawnCli(args, { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      return resolve({ ok: false, error: `spawn failed: ${e.message}` });
    }

    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      try { child.kill(); } catch (_) {}
      resolve({ ok: false, error: 'timeout', stdout, stderr });
    }, timeoutMs);

    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });

    child.on('error', (e) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ ok: false, error: e.message, stdout, stderr });
    });

    child.on('close', (code) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      let parsed = null;
      const trimmed = stdout.trim();
      // lark-cli may emit pretty JSON or NDJSON; take the last JSON object
      if (trimmed) {
        try {
          parsed = JSON.parse(trimmed);
        } catch (_) {
          const idx = trimmed.lastIndexOf('\n{');
          if (idx >= 0) {
            try { parsed = JSON.parse(trimmed.slice(idx + 1)); } catch (_) {}
          }
        }
      }
      const ok = code === 0 && (!parsed || parsed.ok !== false);
      resolve({ ok, code, parsed, stdout, stderr });
    });
  });
}

/**
 * 发一条文本消息。
 *
 * idempotencyKey：飞书服务端按它去重（最长 50 字符）。
 * 用途：send-failed 之后的重试补发，如果第一次其实已经送达、
 * 只是我们这边读超时判成失败，没有幂等键就会再发一遍，老板收到两条一样的。
 *
 * @param {string} text
 * @param {{chatId?:string, idempotencyKey?:string}} opts
 */
async function sendText(text, { chatId = config.chatId, idempotencyKey = null } = {}) {
  if (!chatId) {
    return { ok: false, error: 'chatId 未绑定：跑 npm run setup 完成绑定' };
  }
  const args = [
    'im', '+messages-send',
    '--as', config.sendAs,
    '--chat-id', chatId,
    '--text', text,
    '--json',
  ];
  if (idempotencyKey) args.push('--idempotency-key', String(idempotencyKey).slice(0, 50));
  if (config.profile) args.push('--profile', config.profile);
  const r = await runCli(args, { timeoutMs: 45000 });
  return r;
}

async function listMessages(chatId = config.chatId, limit = 20) {
  if (!chatId) return { ok: false, messages: [] };
  const args = [
    'im', '+chat-messages-list',
    '--as', config.sendAs,
    '--chat-id', chatId,
    '--json',
    '--order', 'desc',
  ];
  if (config.profile) args.push('--profile', config.profile);
  const r = await runCli(args, { timeoutMs: 45000 });
  if (!r.ok || !r.parsed || !r.parsed.data) return { ok: false };
  const msgs = (r.parsed.data.messages || []).slice(0, limit);
  return { ok: true, messages: msgs };
}

module.exports = { runCli, sendText, listMessages, spawnCli, killAll };
