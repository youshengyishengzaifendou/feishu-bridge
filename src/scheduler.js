'use strict';

/**
 * 到期投递
 *
 * 与旧版的关键差异：
 *   旧：每次 tick 把整张任务表读进内存 → 循环 dispatch（几秒的 IO）→ 整表写回。
 *        任务一多就是 O(全部) 读 + 全量写，而且写回会覆盖 tick 期间新建的任务。
 *
 *   新：每个任务在库里存 earliest_ms（下一次该被唤醒的时刻），
 *        tick 只取 earliest_ms <= now 的那几条（走索引），
 *        每条只 patch 自己那几个字段。
 *        → 扫描成本只跟「到期条数」有关，跟任务总量无关。
 *
 * 投递优先级不变：DSH（若配置）→ 直发 lark-cli。
 *
 * 时间一致性约定（血泪教训）：
 *   due / dueMs / earliestMs 三者必须同源。滚动到下一个月时只改 due 不改 dueMs，
 *   会让任务在每个 tick（20 秒）都重新被判为到期 —— 循环提醒变成刷屏。
 *   rollForward() 现在同时写 due 与 dueMs，patchTask 也强制二者一致。
 */

const fs = require('fs');
const path = require('path');
const { config, paths } = require('./config');
const { log } = require('./util');
const store = require('../core/store');
const db = require('./db');
const { sendText } = require('./lark');
const { rollForward } = require('./repeat');

// 提前档位存于 task.advance（分钟），每档最多发一次，状态在 task.fired。
// 额外维护 task.firing（正在发送中），防止崩溃后重复发送。

// 发送失败后，同一档位至少等这么久再重试，避免每 20 秒锤一次 lark-cli。
const RETRY_BACKOFF_MS = 3 * 60000;
// firing 占位超过这个时间视为「上次发送中途崩了」，清掉重试。
const STALE_FIRING_MS = 5 * 60000;

function parseDue(task) {
  const t = Date.parse(task.due);
  if (!Number.isNaN(t)) return t;
  return Number.isFinite(task.dueMs) ? task.dueMs : null;
}

/**
 * 判断某档位该不该真正投递（关机后开机时避免一次刷出多条）。
 * @returns {{deliver:boolean, late:number}} late 为迟到分钟数
 */
function shouldDeliver(triggerAt, now, graceMinutes) {
  const late = (now - triggerAt) / 60000;
  if (late < 0) return { deliver: true, late: 0 };
  if (late <= graceMinutes) return { deliver: true, late };
  return { deliver: false, late };
}

/**
 * 组装提醒正文。
 *
 * 两个时间概念必须分开，否则会说出「还没到期就说已过期」这种话：
 *
 *   lateMinutes  —— 某个**提前档位的触发点**已经过去多久。
 *                  比如「提前 2 小时」的档位应该在 08:00 发，09:00 才发就是迟了 60 分钟，
 *                  但任务本身 10:00 才到期，此时**远没到过期**。
 *
 *   overdueMin   —— **任务到期时间**已经过去多久。只有这个才叫「过期」。
 *
 * 旧实现把 lateMinutes 直接写成「已过期」，于是提前档位一迟到就谎报过期。
 *
 * @param {object} task
 * @param {number} advMin 当前档位的提前分钟数（0 = 准点）
 * @param {number} lateMinutes 档位触发点的迟到分钟数
 * @param {number} [nowMs] 用于计算距到期时间
 */
function buildMessage(task, advMin, lateMinutes = 0, nowMs = Date.now()) {
  const dueMs = parseDue(task);
  const when = dueMs ? new Date(dueMs) : new Date();
  const p = (n) => String(n).padStart(2, '0');
  const stamp = `${when.getMonth() + 1}月${when.getDate()}日 ${p(when.getHours())}:${p(when.getMinutes())}`;

  const lateMin = Math.round(lateMinutes);
  // 到期差用 floor 而非 round：提前 1 分钟不能因为四舍五入变成「已过期」，
  // 迟到 30 秒也不该说「还剩 1 分钟」。
  const msToDue = dueMs ? dueMs - nowMs : 0;
  const overdueMin = msToDue < 0 ? Math.floor(-msToDue / 60000) : 0;
  const toDueMin = msToDue > 0 ? Math.ceil(msToDue / 60000) + 1 : 0; // +1 避免「还剩 0 分钟」

  let head;

  if (overdueMin >= 1) {
    // ── 任务本身已经过期（真的补发）──
    if (overdueMin > 60) {
      const h = Math.round(overdueMin / 60);
      head = `【补发 · 已过期约 ${h} 小时】`;
    } else {
      head = `【补发 · 已过期约 ${overdueMin} 分钟】`;
    }
  } else if (dueMs && lateMin >= 1) {
    // ── 任务还没到期，只是这一档晚了 ──
    const tense = toDueMin > 60 ? `${Math.round(toDueMin / 60)} 小时` : `${toDueMin} 分钟`;
    head = `【提醒 · 还剩 ${tense}】`;
  } else if (advMin > 0) {
    head = `【提醒 · 还有 ${advMin} 分钟】`;
  } else {
    head = '【提醒 · 现在】';
  }

  let text = `${head}\n${task.title}\n⏰ ${stamp}`;
  if (task.note) text += `\n📝 ${task.note}`;

  // 关联了产品的任务，附一行产品档案，省得老板再去查
  if (task.productId) {
    try {
      const p2 = db.getProduct(task.productId);
      if (p2) text += `\n🪴 ${p2.name}${p2.asin ? ` · ${p2.asin}` : ''}`;
    } catch (_) {}
  }

  // 带 digest 的任务：把生成的摘要附在提醒后面
  if (task.digest === 'weekly-ops') {
    try {
      const { answerOps } = require('./answer');
      text += '\n\n' + answerOps({ days: 7 });
    } catch (e) {
      log('ERROR', `weekly digest failed for ${task.id}: ${e.message}`);
      text += '\n\n（摘要生成失败，见日志）';
    }
  }

  return text;
}

// Hand a due job to DSH: write a job file and, if configured, invoke the hook.
// DSH may pick it up via the hook; otherwise the caller falls back to direct send.
async function handOffToDsh(job) {
  if (!config.dshHook) return { delivered: false, reason: 'no dsh hook configured' };

  return new Promise((resolve) => {
    const { spawn } = require('child_process');
    let settled = false;
    let child;

    try {
      child = spawn(config.dshHook, [job.file], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], shell: true });
    } catch (e) {
      return resolve({ delivered: false, reason: `hook spawn failed: ${e.message}` });
    }

    let out = '';
    child.stdout.on('data', (d) => { out += d.toString(); });
    child.stderr.on('data', (d) => { out += d.toString(); });

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { child.kill(); } catch (_) {}
      resolve({ delivered: out.includes('DELIVERED'), reason: 'hook timeout', output: out });
    }, config.dshWaitSeconds * 1000);

    child.on('error', (e) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ delivered: false, reason: `hook error: ${e.message}` });
    });

    child.on('close', () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ delivered: out.includes('DELIVERED'), reason: 'hook finished', output: out });
    });
  });
}

async function dispatch(task, advMin, lateMinutes = 0) {
  // 每日总结是特殊任务：不按普通提醒发，而是生成总结正文再发
  if (task.digest === 'daily-summary') {
    try {
      const { runDailySummary } = require('./summary');
      const r = await runDailySummary();
      const body = r.ok ? r.text : `今日总结生成失败：${r.error || '未知'}`;
      const sr = await sendText(body);
      if (sr.ok) {
        log('INFO', `daily summary sent task=${task.id}`);
        return { delivered: true, via: 'summary' };
      }
      log('ERROR', `daily summary send failed task=${task.id}`);
      return { delivered: false, via: 'summary' };
    } catch (e) {
      log('ERROR', `daily summary threw: ${e.message}`);
      return { delivered: false, via: 'summary' };
    }
  }

  const text = buildMessage(task, advMin, lateMinutes);

  // Preferred path: let DSH handle delivery (it can enrich, rephrase, or use other tools).
  const jobFile = path.join(paths.spool, `job-${task.id}-${advMin}-${Date.now()}.json`);
  const { writeJsonAtomic } = require('./util');
  writeJsonAtomic(jobFile, {
    taskId: task.id,
    title: task.title,
    due: task.due,
    advanceMinutes: advMin,
    note: task.note || '',
    productId: task.productId || null,
    message: text,
    createdAt: new Date().toISOString(),
  });

  let dsh = { delivered: false, reason: 'skipped' };
  if (config.dshHook) {
    dsh = await handOffToDsh({ file: jobFile });
    if (dsh.delivered) {
      log('INFO', `DSH delivered job task=${task.id} adv=${advMin}`);
      pruneSpool();
      return { delivered: true, via: 'dsh' };
    }
    log('WARN', `DSH unavailable (${dsh.reason}) — falling back to direct CLI`);
  }

  // Fallback path: send straight through lark-cli so the reminder is never lost.
  const r = await sendText(text);
  pruneSpool();
  if (r.ok) {
    log('INFO', `direct sent task=${task.id} adv=${advMin}`);
    return { delivered: true, via: 'cli' };
  }

  log('ERROR', `send failed task=${task.id} adv=${advMin}: ${r.error || (r.stderr || '').slice(0, 200)}`);
  return { delivered: false, via: 'cli' };
}

/**
 * job 文件只用于交接给 DSH，留档 3 天即可。
 * 不清理的话每发一条提醒就多一个文件，长期跑下来 spool 里堆成几万个（旧版从没清过）。
 */
function pruneSpool(maxAgeMs = 3 * 86400000) {
  try {
    const dir = paths.spool;
    if (!fs.existsSync(dir)) return;
    const cutoff = Date.now() - maxAgeMs;
    for (const f of fs.readdirSync(dir)) {
      if (!f.startsWith('job-') || !f.endsWith('.json')) continue;
      const full = path.join(dir, f);
      try {
        const st = fs.statSync(full);
        if (st.mtimeMs < cutoff) fs.unlinkSync(full);
      } catch (_) {}
    }
  } catch (_) {}
}

/**
 * 一次 tick：只处理到期的任务。
 * @param {{dry?:boolean, now?:number, deliver?:Function}} opts
 *   dry=true     不发消息、不写库，只打印预览
 *   deliver      测试用注入点：替掉真实发送（默认 dispatch）
 */
async function runTick({ dry = false, now = Date.now(), deliver = null } = {}) {
  const send = deliver || dispatch;
  const grace = Number(config.catchUpGraceMinutes) || 180;

  // ⓪ 睡眠/挂起检测
  // 电脑休眠时进程被冻住，tick 停摆。醒来后第一个 tick 会看到「上一次 tick 是很久以前」。
  // 这时候任务是被睡过去的，不是投递卡住 —— 记一条日志便于排查，
  // 但补发逻辑不变（超过 catchUpGraceMinutes 的照样只标记不发，避免醒来刷屏）。
  const lastTick = Number(db.getKv('lastTickMs', 0)) || 0;
  const gapMin = lastTick ? Math.round((now - lastTick) / 60000) : 0;
  if (lastTick && gapMin >= 10) {
    log('WARN', `tick 间隔 ${gapMin} 分钟 —— 电脑可能休眠过（上次 tick ${new Date(lastTick).toLocaleString('zh-CN')}）`);
  }
  if (!dry) db.setKv('lastTickMs', now);

  // ① 增量取任务：走 ix_tasks_due 索引，只回到期的那几条
  const due = dry
    ? db.listTasks({ done: false, limit: 500 }).filter((t) => t.earliestMs <= now)
    : store.dueTasks(now);

  if (!due.length) return { fired: 0, skipped: 0, checked: 0, due: 0, wakeGapMin: gapMin };

  let fired = 0;
  let skipped = 0;

  for (const task of due) {
    const dueMs = parseDue(task);
    if (dueMs === null) {
      log('WARN', `task ${task.id} has unparsable due=${task.due} — skipped`);
      continue;
    }

    // ── 崩溃恢复：firing 里的档位卡了很久就清掉重试 ──
    let firing = Array.isArray(task.firing) ? task.firing.slice() : [];
    if (firing.length) {
      const lastTry = Date.parse(task.lastAttemptAt || task.createdAt || 0);
      if (Number.isNaN(lastTry) || now - lastTry > STALE_FIRING_MS) {
        log('WARN', `clear stale firing task=${task.id} offsets=${firing.join(',')}`);
        firing = [];
        if (!dry) db.patchTask(task.id, { firing: [], lastAttemptAt: new Date(now).toISOString() });
      }
    }

    // 上一次投递失败要退避，别每个 tick 都重锤
    const lastAttempt = Date.parse(task.lastAttemptAt || 0);
    const backoff = !Number.isNaN(lastAttempt) && now - lastAttempt < RETRY_BACKOFF_MS && firing.length === 0;

    const firedTags = Array.isArray(task.fired) ? task.fired.map(String) : [];
    const advances = Array.isArray(task.advance) && task.advance.length ? task.advance : [0];

    const dueOffsets = [];
    const staleTags = [];

    for (const adv of advances) {
      const tag = String(adv);
      if (firedTags.includes(tag) || firing.includes(tag)) continue;

      const triggerAt = dueMs - adv * 60000;
      if (now < triggerAt) continue;
      if (backoff) continue;

      const verdict = shouldDeliver(triggerAt, now, grace);
      if (!verdict.deliver) {
        // 过期太久：只标记，不发
        staleTags.push(tag);
        skipped++;
        log('INFO', `skip stale offset task=${task.id} adv=${adv} late=${Math.round(verdict.late)}min`);
        continue;
      }
      dueOffsets.push({ adv, tag, late: verdict.late });
    }

    if (staleTags.length && !dry) {
      db.patchTask(task.id, { fired: Array.from(new Set([...firedTags, ...staleTags])) });
    }

    // ── 关机后多个档位同时到期：只发一条 ──
    if (dueOffsets.length > 1) {
      const first = dueOffsets[0];
      const extra = dueOffsets.slice(1).map((o) => o.tag);
      dueOffsets.length = 0;
      dueOffsets.push(first);
      if (!dry && extra.length) {
        db.patchTask(task.id, { fired: Array.from(new Set([...firedTags, ...extra])) });
      }
      log('INFO', `collapse offsets task=${task.id} — sending one (${first.adv})`);
    }

    for (const item of dueOffsets) {
      const { adv, tag, late } = item;

      // 占位：先记 firing 再发，崩溃后不会重复
      if (!dry) db.patchTask(task.id, { firing: [...firing, tag], lastAttemptAt: new Date(now).toISOString() });

      const res = dry
        ? { delivered: true, via: 'dry', preview: buildMessage(task, adv, late, now) }
        : await send(task, adv, late);

      if (res.delivered) {
        fired++;
        if (!dry) {
          const t2 = db.getTask(task.id);
          const f2 = t2 ? t2.fired : firedTags;
          db.patchTask(task.id, {
            fired: Array.from(new Set([...f2, tag])),
            firing: (t2 ? t2.firing : []).filter((x) => x !== tag),
            lastFiredAt: new Date(now).toISOString(),
          });
        }
        if (dry) console.log(`  [dry] ${task.title} @ ${task.due} adv=${adv}\n${String(res.preview).split('\n').map((l) => '        ' + l).join('\n')}`);
      } else {
        // 失败不标记 fired，等退避后重试
        if (!dry) {
          const t2 = db.getTask(task.id);
          db.patchTask(task.id, {
            firing: (t2 ? t2.firing : []).filter((x) => x !== tag),
            lastAttemptAt: new Date(now).toISOString(),
          });
        }
        log('WARN', `deliver failed task=${task.id} adv=${adv} — retry in ${Math.round(RETRY_BACKOFF_MS / 60000)}min`);
      }
    }

    // ── 所有档位已处理且到期时间已过 → 结束或滚动 ──
    const t3 = dry ? task : db.getTask(task.id);
    if (!t3) continue;
    const allHandled = advances.every((a) => t3.fired.map(String).includes(String(a)));
    if (allHandled && now >= dueMs && !t3.done) {
      const rolled = t3.repeat ? rollForward(t3, now) : false;
      if (rolled) {
        log('INFO', `repeat rolled forward id=${t3.id} next=${t3.due}`);
        if (!dry) db.patchTask(t3.id, {
          due: t3.due, dueMs: t3.dueMs, fired: [], firing: [],
          prevDue: t3.prevDue, lastFiredAt: t3.lastFiredAt, done: false, completedAt: null,
        });
      } else if (!dry) {
        db.patchTask(t3.id, { done: true, completedAt: new Date(now).toISOString() });
      }
    }
  }

  return { fired, skipped, checked: due.length, due: due.length, wakeGapMin: gapMin };
}

module.exports = { runTick, buildMessage, dispatch, parseDue, shouldDeliver, pruneSpool, RETRY_BACKOFF_MS };
