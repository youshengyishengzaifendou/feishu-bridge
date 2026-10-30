'use strict';

const fs = require('fs');
const path = require('path');
const { LOGS, DATA } = require('./config');

function ts() {
  const d = new Date();
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

// 日志轮转：单文件超过 MAX_LOG_BYTES 就改名成 bridge.log.1（只留一份旧的）。
// 不做的话，listener 每 2 分钟一行、tick 每 20 秒一行，日志会无限长大。
const MAX_LOG_BYTES = 5 * 1024 * 1024;

// 测试进程不许写进生产日志：否则跑一次测试，日志里就混进一堆假任务的记录，
// 排查线上问题时会被误导（实测踩过：把测试的 remind 当成真实提醒）。
const IS_TEST = Boolean(process.env.BRIDGE_TEST_DB) || process.env.NODE_ENV === 'test';
const LOG_FILE = path.join(IS_TEST ? require('os').tmpdir() : LOGS, IS_TEST ? 'bridge-test.log' : 'bridge.log');

let bytesWritten = null;

function rotateIfNeeded() {
  try {
    if (bytesWritten === null) {
      bytesWritten = fs.existsSync(LOG_FILE) ? fs.statSync(LOG_FILE).size : 0;
    }
    if (bytesWritten < MAX_LOG_BYTES) return;
    fs.renameSync(LOG_FILE, `${LOG_FILE}.1`);
    bytesWritten = 0;
  } catch (_) {
    bytesWritten = 0;
  }
}

function log(level, msg) {
  const line = `[${ts()}] [${level}] ${msg}`;
  try {
    rotateIfNeeded();
    fs.appendFileSync(LOG_FILE, line + '\n', 'utf8');
    if (bytesWritten !== null) bytesWritten += Buffer.byteLength(line) + 1;
  } catch (_) { /* logging must never throw */ }

  if (IS_TEST) return; // 测试里不打屏，保持输出干净

  if (level === 'ERROR') console.error(line);
  else if (level === 'WARN' || process.env.BRIDGE_VERBOSE === '1') console.log(line);
}

// Atomic JSON write: write temp then rename, so a crash never leaves a half file.
function writeJsonAtomic(file, obj) {
  const dir = path.dirname(file);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

function readJson(file, fallback) {
  try {
    if (!fs.existsSync(file)) return fallback;
    let raw = fs.readFileSync(file, 'utf8');
    // tolerate a UTF-8 BOM left by PowerShell / Notepad
    if (raw.charCodeAt(0) === 0xFEFF) raw = raw.slice(1);
    if (!raw.trim()) return fallback;
    return JSON.parse(raw);
  } catch (e) {
    log('ERROR', `readJson ${path.basename(file)}: ${e.message}`);
    return fallback;
  }
}

module.exports = { log, writeJsonAtomic, readJson, ts, DATA, LOG_FILE, MAX_LOG_BYTES };

