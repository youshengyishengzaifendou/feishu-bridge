'use strict';

/**
 * 路由器 —— 全项目唯一的消息入口
 *
 * 一条飞书消息进来，只走这一条路径：
 *
 *   消息
 *    → 目录（有哪些表、哪些产品线、有哪些工具）        ← 不再预读整表
 *    → ① 规划：模型决定要读什么（tools）
 *    → ② 执行：tools.js 只读需要的那部分
 *    → ③ 作答：模型基于 facts 生成 reply + actions
 *    → 执行 actions（建提醒 / 记笔记 / 登记活动）
 *    → 回飞书 + 记入 turns
 *
 * AI 不可用时 → 降级到规则（fallback/rules.js），并标记为「降级回复」。
 */

const store = require('./store');
const { log } = require('../src/util');
const { sendText } = require('../src/lark');
const llm = require('../src/llm');
const catalog = require('../src/catalog');
const tools = require('../src/tools');
const memory = require('../src/memory');
const db = require('../src/db');

const handlers = require('./handlers');

const nowIso = () => new Date().toISOString();

// ── 上下文：目录 + 少量状态，而不是整表数据 ────────────────────

/**
 * 构建 prompt 里要的那段「已知信息」。
 *
 * 关键变化：不再在这里读日运营/周报/库龄整表。
 * 只放三样东西：
 *   1. 数据目录（缓存，10 分钟）
 *   2. 今天的对话（最近几轮，保持连续性）
 *   3. 昨天的简要总结
 */
function buildContext(catalogText = null) {
  const parts = [];

  if (catalogText !== null) {
    if (catalogText) parts.push(catalogText);
  } else {
    try {
      parts.push(catalog.build());
    } catch (e) {
      log('WARN', `catalog failed: ${e.message}`);
    }
  }

  try {
    const today = store.todayKey();
    const turns = db.listTurns({ date: today, limit: 8 });
    if (turns.length) {
      parts.push('');
      parts.push('■ 今天已经聊过的（最近 8 轮）');
      for (const t of turns.slice(-8)) {
        const hm = String(t.at || '').slice(11, 16);
        parts.push(`· ${hm} 老板：${String(t.user).slice(0, 80)}`);
        if (t.reply) parts.push(`  我：${String(t.reply).replace(/\n/g, ' ').slice(0, 100)}`);
        if (t.actions && t.actions.length) {
          parts.push(`  动作：${t.actions.map((a) => a.type).join('、')}`);
        }
      }
    }
  } catch (e) {
    log('WARN', `today context failed: ${e.message}`);
  }

  try {
    const prev = store.lastSummaryBrief();
    if (prev) {
      parts.push('');
      parts.push(`■ 昨天（${prev.date}）的总结：${prev.brief}`);
    }
  } catch (_) {}

  return parts.join('\n');
}

// ── 提示词 ───────────────────────────────────────────────────
//
// 业务身份 / 范围 / 禁忌全部来自 profile.json（src/profile.js），
// 这里只保留与业务无关的「动作契约」。换个人 clone 下来，
// 模型看到的就是他自己的业务范围，而不是原作者的店铺。

const profile = require('../src/profile');

function systemPrompt() {
  const p = profile.get();
  const U = p.userLabel || '老板';
  const scope = profile.scopePrompt();
  return `你是${p.role}。

${scope ? `工作范围：\n${scope}\n` : ''}
你能做五件事：
1. 建提醒 —— ${U}说「提醒我」「几号」「到时候」等
2. 回答数据问题 —— 只能用【已读取的数据】里给出的真实数字，不要编造
3. 记录信息 —— ${U}描述了对广告/价格/库存做了什么、或让你记下活动信息
4. 登记实体 —— ${U}提到一个新产品、或说明某广告活动属于哪个产品
5. **改删已有提醒** —— ${U}说「合并」「删掉」「不要了」「改成X点」时，用 forget 真的去删，再按需要重建

严格返回 JSON（不要 markdown 代码块、不要多余文字）：

{
  "intent": "remind | answer | note | campaign | forget | chat",
  "reply": "给${U}看的回复，中文，简洁，可用 · 分段",
  "actions": []
}

actions 格式：
- 建提醒：{"type":"remind","title":"标题(30字内)","due":"2026-11-03T10:00:00+08:00","note":"备注","advance":[0]}
- 循环提醒：在上面基础上加 "repeat":{"kind":"weekly|monthly|daily","weekday":2,"day":16,"hour":10,"minute":0}
- 记录：{"type":"note","kind":"ad|ops|stock|price","text":"记录内容","product":"产品名(可选)"}
- 登记广告活动：{"type":"campaign","name":"活动全名","product":"归属产品名","analysis":"分析结论"}
- 归属已有活动：{"type":"campaign","name":"活动全名","product":"产品名"}
- **删除提醒**：{"type":"forget","id":"r-xxxx"} 或 {"type":"forget","query":"标题关键词"}

规则：
- due 必须带 +08:00，格式 YYYY-MM-DDTHH:mm:ss+08:00
- 「这周五」「下周」按今天推算
- **提醒只在准点发一次：advance 一律给 [0]，不要提前提醒**
  （${U}明确要求"提前一天/提前两小时"时，才按他说的分钟数给，例如 [120,0]）
- **${U}说「每月X号」「每周X」这种重复的，用 repeat，不要拆成三条一次性任务**
- 登记广告活动时，「product」写你在目录里看到的那个产品全名
- 没有动作时 actions 为 []
- reply 要直接回答，不要只说「已记录」
- 数据里没有的，明确说「表里没有」，不要编
- 如果${U}说的事你刚才已经做过（看「今天已经聊过的」），要指出来，不要重复做
- 数据源未接入时，被问到需要查表的问题就如实说「还没接入数据源，跑 npm run setup 配置」，绝不编数字

**关于删除和合并（很重要）：**
- 你**有**删除提醒的能力（forget 动作），不要说「我没有删除权限」。
  说这句话会误导${U}，而且重复提醒会一直留着继续打扰他。
- ${U}说「合并」时：**先把重复的删掉（forget），再建一条新的**，一次做完。
  不要只建新的、把旧的留着让${U}自己删。
- 删除前先从【已读取的数据】里的 task 工具结果拿到准确 id 或标题关键词，
  删完在 reply 里报「已删除 X 条、新建 1 条」的实际结果。
- 只删${U}明确要删的那些，其余提醒一律不动。`;
}


function userPrompt(text, context, facts, today) {
  const W = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
  const wd = W[new Date(`${today}T00:00:00+08:00`).getDay()] || '';
  const U = profile.get().userLabel || '老板';

  return `今天是 ${today}（${wd}）

=== 已知信息 ===
${context || '（暂无）'}
${facts ? `\n=== 已读取的数据 ===\n${facts}` : `\n（本轮没有读表；如果问题确实需要数据，明确告诉${U}你需要先查，不要猜）`}

=== ${U}的消息 ===
${text}`;
}

// ── 主流程 ───────────────────────────────────────────────────

/**
 * 处理一条飞书消息。
 *
 * @param {string} text
 * @param {{messageId?:string, chatId?:string, skipPlan?:boolean}} meta
 * @returns {Promise<{ok:boolean, reply:string, intent:string, actions:Array,
 *                    degraded?:boolean, plan?:object, tools?:Array, error?:string}>}
 */
async function handle(text, meta = {}) {
  const trimmed = String(text || '').trim();
  if (!trimmed) return { ok: false, reply: '', intent: 'chat', actions: [], error: '空消息' };

  if (!llm.isConfigured()) {
    log('WARN', 'route: llm not configured → fallback');
    return runFallback(trimmed, meta, null);
  }

  const today = store.todayKey();
  let planResult = null;
  let facts = '';
  let usedTools = [];

  // 目录只构建一次：它既是规划输入，也是作答输入。
  // catalog.build() 内部只走缓存 + 后台刷新，不会读飞书表格（1.8s 的那种读被挪到预热里）。
  let catalogText = '';
  try {
    catalogText = catalog.build();
  } catch (e) {
    log('WARN', `catalog failed: ${e.message}`);
  }

  // ── ①+③ 单次调用：不读表的消息只花一次模型请求 ──
  //   （上游按请求数限流，两次调用会明显放大 429 概率）
  if (!meta.skipPlan) {
    // 熔断中就别试了：直接走本地规则，避免每条消息都等满 120 秒超时
    if (llm.isCoolingDown()) {
      log('WARN', 'route: LLM 熔断中 → 直接本地兜底');
      return runFallback(trimmed, meta, localPlan(trimmed));
    }
    const one = await tryAgentStep(trimmed, catalogText, meta);
    if (one) return one;
  }

  // ── ① 规划：要不要读数据、读什么 ──
  if (!meta.skipPlan) {
    try {
      const p = await llm.plan(trimmed, catalogText, today, catalog.TOOLS);
      if (p.ok) {
        planResult = p.plan;
        log('INFO', `plan: needsData=${p.plan.needsData} tools=${p.plan.tools.map((t) => t.name + JSON.stringify(t.args || {})).join(',') || '-'} (${p.plan.why || ''})`);
      } else {
        // 规划失败（限流/超时）→ 用本地规则兜底，绝不带着空数据去作答
        const local = localPlan(trimmed);
        planResult = local;
        log('WARN', `plan failed (${p.error}) → 本地兜底: ${local.tools.map((t) => t.name).join(',') || '(不读表)'}`);
      }
    } catch (e) {
      planResult = localPlan(trimmed);
      log('WARN', `plan threw: ${e.message} → 本地兜底: ${planResult.tools.map((t) => t.name).join(',') || '(不读表)'}`);
    }
  } else {
    planResult = { needsData: false, tools: [], why: 'skipped' };
  }

  // ── ② 执行工具：只读需要的那部分 ──
  if (planResult && planResult.tools.length) {
    try {
      const r = tools.run(planResult.tools);
      facts = r.facts;
      usedTools = r.used;
      if (r.failed.length) {
        log('WARN', `tools failed: ${r.failed.map((f) => `${f.name}(${f.error})`).join(', ')}`);
      }
      log('INFO', `tools: ${usedTools.join(',') || '(none)'} facts=${facts.length}字`);
    } catch (e) {
      log('ERROR', `tools threw: ${e.message}`);
    }
  }

  // ── ③ 作答（仅在两段式子流程走到这里时） ──
  const context = buildContext(catalogText);
  const r = await llm.chat([
    { role: 'system', content: systemPrompt() },
    { role: 'user', content: userPrompt(trimmed, context, facts, today) },
  ], { maxTokens: 6000 });

  if (!r.ok) {
    log('WARN', `route: ai failed (${r.error}) → fallback`);
    return runFallback(trimmed, meta, planResult);
  }

  return finish(parseReply(r.text), trimmed, usedTools, meta, planResult);
}

// ── 单次调用（agent 优先路径）─────────────────────────────────

/**
 * 一次模型调用同时完成「规划」和「作答」。
 *
 * 旧的两段式对每条消息都要两次请求：先规划（约 10s）再作答（约 29s）。
 * 上游按请求数限流（实测连发 3 条就 429），而「提醒我…」「你好」这类消息
 * 其实一次就能答完。这里先试一次：
 *
 *   · 模型直接给出最终 JSON → 执行 actions 返回，省掉第二次请求
 *   · 模型要读数据          → 读表后再追加一次调用（与老路径等价）
 *   · 模型输出不可用        → 返回 null，router 退回两段式老路径
 *
 * 任何异常都返回 null，不影响原有流程。
 */
async function tryAgentStep(trimmed, catalogText, meta) {
  const context = buildContext(catalogText);
  const today = store.todayKey();

  let r;
  try {
    r = await llm.act([
      { role: 'system', content: systemPrompt() },
      { role: 'user', content: userPrompt(trimmed, context, '', today) },
    ], catalog.TOOLS, { maxTokens: 4000 });
  } catch (e) {
    log('WARN', `agent step threw: ${e.message}`);
    return null;
  }

  if (!r || !r.ok) {
    log('WARN', `agent step failed: ${r && r.error}`);
    return null;
  }

  // ── 分支 1：模型要读数据 → 读表，再答一次 ──
  if (Array.isArray(r.toolCalls) && r.toolCalls.length) {
    let facts = '';
    let usedTools = [];
    try {
      const tr = tools.run(r.toolCalls.map((t) => ({ name: t.name, args: t.args || {} })));
      facts = tr.facts;
      usedTools = tr.used;
      if (tr.failed.length) {
        log('WARN', `tools failed: ${tr.failed.map((f) => `${f.name}(${f.error})`).join(', ')}`);
      }
      log('INFO', `agent: tools=${usedTools.join(',') || '-'} facts=${facts.length}字`);
    } catch (e) {
      log('ERROR', `agent tools threw: ${e.message}`);
      return null;
    }

    // 读表之后这次作答有独立的、更紧的预算：老板已经在等结果了，
    // 不能再用「120 秒 × 3 次重试」的最坏路径（实测卡过 6 分钟）。
    const cfg = llm.getLlmConfig();
    const r2 = await llm.chat([
      { role: 'system', content: systemPrompt() },
      { role: 'user', content: userPrompt(trimmed, context, facts, today) },
    ], { maxTokens: 6000, timeoutMs: cfg.answerTimeoutMs, retries: cfg.answerRetries });

    if (!r2.ok) {
      log('WARN', `agent answer failed: ${r2.error}`);
      // 超时/限流 → 用「已经读到的真实数据」直接拼一条，别让老板干等
      if (facts) {
        return finish({
          intent: 'answer',
          reply: `（模型暂时没响应，以下是刚读到的真实数据）\n\n${facts}`,
          actions: [],
        }, trimmed, [], meta, { needsData: true, tools: r.toolCalls });
      }
      return null;
    }
    return finish(parseReply(r2.text), trimmed, usedTools, meta, { needsData: true, tools: r.toolCalls });
  }

  // ── 分支 2：模型直接给了最终 JSON → 一条请求结束这轮 ──
  const parsed = llm.extractJson(r.text);
  if (parsed && (parsed.intent || parsed.reply)) {
    log('INFO', 'agent: single-call reply');
    return finish(parseReply(r.text), trimmed, [], meta, null);
  }

  // ── 分支 3：模型什么都没给明白 → 交给下面的两段式 ──
  return null;
}

/** 把模型输出规整成 {intent, reply, actions}。 */
function parseReply(text) {
  const parsed = llm.extractJson(text);
  if (parsed && (parsed.intent || parsed.reply)) {
    return {
      intent: parsed.intent || 'answer',
      reply: String(parsed.reply || '').trim(),
      actions: Array.isArray(parsed.actions) ? parsed.actions : [],
    };
  }
  return {
    intent: 'answer',
    reply: String(text || '').trim().slice(0, 1500),
    actions: [],
  };
}

/**
 * 把「动作的真实结果」补进回复。
 *
 * 为什么必须做：模型经常把自己的动作说错。实测它一口气删了 6 条
 *（其中 3 条无关），回复里却写「其余提醒都没动」——
 * 老板以为只动了重复项，实际少了别的提醒，且毫无察觉。
 *
 * 所以凡是删除/失败的动作，一律用**执行结果**覆盖模型的描述：
 *   · 删了哪几条 → 逐条列出来
 *   · 删失败 / 命中太多 → 明确说没删、原因是什么
 * 模型原文保留在前面（它负责解释和措辞），事实部分由这里保证。
 */
function withActionFacts(reply, applied) {
  const lines = [];

  // 删除类：合并成一段，不要每条 forget 各打一个标题
  const deleted = [];
  const notDeleted = [];
  for (const a of applied) {
    if (a.type !== 'forget') continue;
    if (a.ok && Array.isArray(a.deleted)) deleted.push(...a.deleted);
    else if (!a.ok) notDeleted.push(a);
  }

  if (deleted.length) {
    lines.push(`✅ 实际删除 ${deleted.length} 条提醒：`);
    for (const d of deleted) {
      const when = d.due ? `（${String(d.due).slice(5, 16).replace('T', ' ')}）` : '';
      lines.push(`· ${String(d.title).slice(0, 60)}${when}`);
    }
  }

  for (const a of notDeleted) {
    lines.push(`⚠️ 有提醒没有删掉：${a.error || '未知原因'}`);
    if (Array.isArray(a.matched) && a.matched.length) {
      lines.push(`命中了 ${a.matched.length} 条，未做改动：`);
      for (const m of a.matched.slice(0, 6)) lines.push(`· ${String(m.title).slice(0, 60)}`);
      if (a.matched.length > 6) lines.push(`· …共 ${a.matched.length} 条`);
    }
  }

  // 建提醒失败也要说，别让老板以为建好了
  for (const a of applied) {
    if (a.type === 'remind' && !a.ok) {
      lines.push(`⚠️ 提醒没有建成功：${a.error || '未知原因'}`);
    }
  }

  if (!lines.length) return reply;
  const head = String(reply || '').trim();
  return head ? `${head}\n\n${lines.join('\n')}` : lines.join('\n');
}

/** 执行动作、记 turns、组装返回值。 */
function finish({ intent, reply, actions }, trimmed, usedTools, meta, planResult) {
  const applied = handlers.apply(actions, meta.messageId);
  const finalReply = withActionFacts(reply, applied);

  try {
    db.addTurn({
      at: nowIso(),
      user: trimmed,
      reply: finalReply.slice(0, 800),
      intent,
      actions: applied.map((a) => ({ type: a.type, ref: a.ref || '' })),
    });
  } catch (e) {
    log('WARN', `turn record failed: ${e.message}`);
  }

  log('INFO', `route: ai intent=${intent} actions=${applied.length} tools=${usedTools.join(',') || '-'}`);
  return { ok: true, reply: finalReply, intent, actions: applied, plan: planResult, tools: usedTools };
}

// ── 本地兜底规划（AI 规划不可用时）────────────────────────────

const QUERY_HINT = /多少|几|怎么样|如何|什么时[候间]|还剩|剩余|有没有|是否|概览|概况|情况|现状|告诉我|查一下|看看|列出|有哪些|变化|变动|分析|读取|汇总|统计|评估|压力|毛利|利润|销量|销售额|库存|库龄|广告|排名|售价|review|星级/;

/**
 * 用关键词把消息映射成工具调用。
 *
 * 这不算「聪明」，但在限流/断网时能保证：该读的数据照样读到，
 * 而不是让模型凭空编一个数字出来。
 *
 * 分组词来自 profile.json；表类工具只在 profile 配了对应表时才可能被选中。
 */
function localPlan(text) {
  const data = require('../src/data');
  const t = String(text || '').trim();
  const series = profile.normSeries(t) || undefined;

  const tools = [];

  // 广告活动 / 产品归属类问题优先走实体工具（精确、便宜）
  const camp = t.match(/[A-Za-z][\w\- ]{2,40}-(SP|SB|SD)-[\w\-\u4e00-\u9fa5]{2,40}/);
  if (camp) tools.push({ name: 'campaign', args: { query: camp[0].trim() } });

  if (!tools.length && /广告活动|哪个产品|属于|归属/.test(t) && /广告|活动/.test(t)) {
    tools.push({ name: 'campaign', args: { query: t.slice(0, 60) } });
  }

  const has = {
    aging: data.hasTable('aging'),
    weekly: data.hasTable('weekly'),
    changes: data.hasTable('daily'),
    stock: data.hasTable('daily'),
    ops: data.hasTable('daily'),
  };

  if (/库龄|超龄|180/.test(t) && has.aging) tools.push({ name: 'aging', args: {} });
  else if (/周报|周度|weekly|毛利|利润|赔钱|销售额|销量|成本/i.test(t) && has.weekly) tools.push({ name: 'weekly', args: series ? { series } : {} });
  else if (/变化|变动|对比/.test(t) && !/毛利|利润/.test(t) && has.changes) tools.push({ name: 'changes', args: series ? { series } : {} });
  else if (/库存|无库存|断货|还剩|剩多少/.test(t) && has.stock) tools.push({ name: 'stock', args: series ? { series } : {} });
  else if (/上周|前几天|最近.*(操作|动作)|做了什么|调过/.test(t) && has.ops) tools.push({ name: 'ops', args: { days: 10, ...(series ? { series } : {}) } });
  else if (/提醒|待发|任务/.test(t) && /哪些|什么|列出/.test(t)) tools.push({ name: 'task', args: { limit: 15 } });

  const needsData = tools.length > 0 || QUERY_HINT.test(t);
  if (needsData && !tools.length && has.ops) tools.push({ name: 'ops', args: { days: 7 } });

  return { needsData, tools, why: '本地兜底规则' };
}

async function runFallback(trimmed, meta, planResult) {
  try {
    const rules = require('../fallback/rules');
    const r = rules.handle(trimmed);
    if (r && r.reply) {
      try {
        db.addTurn({
          at: nowIso(),
          user: trimmed,
          reply: r.reply.slice(0, 800),
          intent: 'degraded',
          degraded: true,
        });
      } catch (_) {}
      log('INFO', 'route: fallback replied');
      return {
        ok: true, reply: r.reply, intent: 'degraded', actions: [],
        degraded: true, plan: planResult, tools: [],
      };
    }
    if (r && r.defer) {
      return {
        ok: false, reply: '', intent: 'deferred', actions: [],
        error: '规则拿不准，已留待重试', plan: planResult, tools: [],
      };
    }
  } catch (e) {
    log('ERROR', `route: fallback threw ${e.message}`);
  }
  return {
    ok: false, reply: '', intent: 'error', actions: [],
    error: 'AI 与规则均失败', plan: planResult, tools: [],
  };
}

/**
 * 处理并发送（含失败入队重试）。
 *
 * 关键约定：**动作只执行一次，重试只补发消息，不重跑动作**。
 *
 *   · 发送失败（send-failed）：动作已经落地（任务已建），重试时只重发这条 reply。
 *     把 reply 存进队列，重试走 resend，绝不重新调 LLM、绝不再建一次任务。
 *   · 处理失败（handle-failed / deferred）：还没产生任何副作用，重试可以整条重跑。
 *
 * 幂等键：每条消息的最终回复用 `reply:<messageId>` 作为 idempotency-key。
 * 这样「其实已经送达、但我们读超时判成失败」时，补发不会让老板收到两条一样的；
 * 没有 messageId 的调用（网页/工具）不加键，保持原样。
 */
function replyKey(meta) {
  return meta && meta.messageId ? `reply:${meta.messageId}` : null;
}

async function handleAndSend(text, meta = {}) {
  const r = await handle(text, meta);

  if (r.ok && r.reply) {
    const sr = await sendText(r.reply, {
      chatId: meta.chatId || undefined,
      idempotencyKey: replyKey(meta),
    });
    if (!sr.ok) {
      log('ERROR', `send failed: ${sr.error || ''}`);
      // 只存 reply，不带 text —— 重试时只补发，不再触发动作
      store.enqueueFailed({ text, meta, reason: 'send-failed', reply: r.reply });
      return { ...r, sent: false };
    }
    return { ...r, sent: true };
  }

  if (!r.ok) {
    store.enqueueFailed({ text, meta, reason: r.error || 'handle-failed' });
  }
  return { ...r, sent: false };
}

/**
 * 只补发一条已经生成好的回复（用于 send-failed 的重试）。
 * 不调 LLM、不执行动作。
 */
async function resend(reply, meta = {}) {
  const sr = await sendText(reply, {
    chatId: meta.chatId || undefined,
    idempotencyKey: replyKey(meta),
  });
  return { ok: sr.ok, sent: sr.ok, error: sr.ok ? undefined : sr.error };
}

module.exports = {
  handle, handleAndSend, resend, buildContext, tryAgentStep, localPlan, withActionFacts,
  systemPrompt, userPrompt, memory,
  // 兼容旧引用名：取当前 profile 渲染的 system prompt
  get SYSTEM_PROMPT() { return systemPrompt(); },
};
