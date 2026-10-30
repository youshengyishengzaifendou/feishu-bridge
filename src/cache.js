'use strict';

/**
 * 读表缓存（TTL）
 *
 * 一次消息处理里可能连着问好几件事（库存、周报、库龄），
 * 每次都去 lark-cli 拉一遍整表既慢又浪费 —— 每张表一次子进程 + 一次网络往返。
 * 这里按「表 + 参数」做短时缓存：
 *   · 同一轮对话内多次读同一张表 → 只读一次
 *   · 相邻两条消息（几秒内）→ 复用
 *   · 超过 TTL 自动失效，保证数据新鲜度
 *
 * 注意：缓存的是「解析后的结果」而不是原始行，所以下游 analyze 可以放心改。
 */

const { config } = require('./config');

const store = new Map();

const DEFAULT_TTL = 120000; // 2 分钟：足够覆盖一轮对话，又不至于读到旧数据

function isEnabled() {
  return config.dataCache !== false;
}

/**
 * @template T
 * @param {string} key 缓存键（必须能唯一标识这次读取，例如 `daily` / `weekly:方形花床`）
 * @param {() => T} fn 实际读取函数
 * @param {number} [ttlMs]
 * @returns {T}
 */
function cached(key, fn, ttlMs = DEFAULT_TTL) {
  if (!isEnabled()) return fn();

  const hit = store.get(key);
  // 统一用 hit.ttl：旧实现这里写死 DEFAULT_TTL，导致给 10 分钟的目录
  // 实际 2 分钟就过期，每条消息都要重读整张日运营表（≈2 秒）。
  if (hit && Date.now() - hit.at < hit.ttl) return hit.value;

  const value = fn();
  store.set(key, { at: Date.now(), value, ttl: ttlMs });
  return value;
}

/** 读不到数据（null/空数组）时不要把空结果缓存太久。 */
function cachedOrMiss(key, fn, ttlMs = DEFAULT_TTL) {
  if (!isEnabled()) return fn();

  const hit = store.get(key);
  if (hit && Date.now() - hit.at < hit.ttl) return hit.value;

  const value = fn();
  const empty = value == null || (Array.isArray(value) && value.length === 0);
  const ttl = empty ? Math.min(15000, ttlMs) : ttlMs;
  store.set(key, { at: Date.now(), value, ttl });
  return value;
}

/**
 * 后台刷新：先返回旧值（可能为空），同时异步触发一次读取。
 *
 * 用于「消息路径不能等 2 秒读表」的场景：目录里那点新鲜度信息
 * （最新日期、覆盖范围）绝不能阻塞一条消息的规划。
 */
function staleWhileRevalidate(key, fn, ttlMs = DEFAULT_TTL) {
  if (!isEnabled()) {
    try { return fn(); } catch (_) { return null; }
  }

  const hit = store.get(key);
  if (hit && Date.now() - hit.at < hit.ttl) return hit.value;

  // 旧值直接用，刷新丢到下一轮事件循环
  if (hit) {
    setImmediate(() => {
      try {
        const value = fn();
        store.set(key, { at: Date.now(), value, ttl: ttlMs });
      } catch (_) {}
    });
    return hit.value;
  }

  return null;
}

function invalidate(prefix) {
  for (const k of store.keys()) {
    if (!prefix || k.startsWith(prefix)) store.delete(k);
  }
}

function clear() {
  store.clear();
}

function info() {
  return {
    entries: store.size,
    keys: Array.from(store.keys()),
    ttlMs: DEFAULT_TTL,
    enabled: isEnabled(),
  };
}

module.exports = { cached, cachedOrMiss, staleWhileRevalidate, invalidate, clear, info, DEFAULT_TTL };
