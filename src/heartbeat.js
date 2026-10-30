'use strict';

/**
 * 心跳：每分钟写一次，外部可据此判断服务是否活着、中断了多久。
 *
 * data/heartbeat.json:
 *   { last: ISO, pid, bootedAt, ticks, since }
 *
 * 查询：node src/agent-cli.js heartbeat
 */

const fs = require('fs');
const path = require('path');
const { DATA } = require('./config');
const { writeJsonAtomic, readJson } = require('./util');

const FILE = path.join(DATA, 'heartbeat.json');

let startedAt = null;
let tickCount = 0;

function beat() {
  if (!startedAt) startedAt = new Date().toISOString();
  tickCount++;
  writeJsonAtomic(FILE, {
    last: new Date().toISOString(),
    pid: process.pid,
    bootedAt: startedAt,
    ticks: tickCount,
  });
}

function read() {
  return readJson(FILE, null);
}

/**
 * 检查心跳健康状况。
 * @returns {{alive:boolean, lastAgoSeconds:number|null, gapSeconds:number|null, note:string}}
 */
function health() {
  const h = read();
  if (!h || !h.last) {
    return { alive: false, lastAgoSeconds: null, gapSeconds: null, note: '从未写过心跳' };
  }

  const lastMs = Date.parse(h.last);
  const ago = (Date.now() - lastMs) / 1000;

  let alive = false;
  try {
    process.kill(h.pid, 0);
    alive = true;
  } catch (_) {
    alive = false;
  }

  let note = '';
  if (alive && ago < 120) note = '运行正常';
  else if (alive && ago >= 120) note = `进程在但心跳停了 ${Math.round(ago / 60)} 分钟，可能卡死`;
  else note = `进程已退出，最后心跳 ${Math.round(ago / 60)} 分钟前`;

  return { alive, lastAgoSeconds: Math.round(ago), gapSeconds: Math.round(ago), note, raw: h };
}

module.exports = { beat, read, health, FILE };
