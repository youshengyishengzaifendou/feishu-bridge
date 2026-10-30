'use strict';

/**
 * LLM 客户端 —— 方案 A 的引擎
 *
 * 兼容任何 OpenAI 风格的 /chat/completions 接口：
 *   DeepSeek   https://api.deepseek.com
 *   SiliconFlow https://api.siliconflow.cn/v1
 *   智谱        https://open.bigmodel.cn/api/paas/v4
 *   通义        https://dashscope.aliyuncs.com/compatible-mode/v1
 *   OpenAI      https://api.openai.com/v1
 *
 * 配置在 config.json：
 *   "llm": {
 *     "baseUrl": "https://api.deepseek.com",
 *     "apiKey": "sk-...",
 *     "model": "deepseek-chat",
 *     "maxTokens": 1200,
 *     "temperature": 0.3,
 *     "timeoutMs": 45000
 *   }
 */

const https = require('https');
const http = require('http');
const { URL } = require('url');
const { config } = require('./config');
const profile = require('./profile');
const { log } = require('./util');

// ── 熔断 ──────────────────────────────────────────────────────
//
// 上游限流/宕机时，每次消息都要先等满 timeoutMs（120 秒）+ 重试退避，
// 老板等 5 分钟才收到一句「降级回复」。实测 429 期间单条消息要 90 秒以上。
//
// 连续失败达到阈值后打开熔断，冷却期内直接走本地兜底（照样读表、不编数字），
// 冷却结束自动半开重试一次。这样坏境况下响应时间从「分钟级」回到「秒级」。
const BREAKER_THRESHOLD = 3;
const BREAKER_COOLDOWN_MS = 60000;

const breaker = { fails: 0, openUntil: 0 };

function breakerState() {
  return {
    open: Date.now() < breaker.openUntil,
    fails: breaker.fails,
    openUntil: breaker.openUntil,
    cooldownMs: BREAKER_COOLDOWN_MS,
    threshold: BREAKER_THRESHOLD,
  };
}

function noteSuccess() {
  if (breaker.fails) log('INFO', 'LLM 熔断复位');
  breaker.fails = 0;
  breaker.openUntil = 0;
}

function noteFailure() {
  breaker.fails++;
  if (breaker.fails >= BREAKER_THRESHOLD) {
    breaker.openUntil = Date.now() + BREAKER_COOLDOWN_MS;
    log('WARN', `LLM 熔断打开 ${Math.round(BREAKER_COOLDOWN_MS / 1000)}s（连续失败 ${breaker.fails} 次）— 期间走本地兜底`);
  }
}

/** 熔断打开时返回 true；调用方应直接走兜底，不要发请求。 */
function isCoolingDown() {
  if (Date.now() >= breaker.openUntil) {
    if (breaker.openUntil) {
      // 冷却结束 → 半开：清零计数，下一次真实请求决定要不要再打开
      breaker.openUntil = 0;
      breaker.fails = 0;
      log('INFO', 'LLM 熔断冷却结束，下次请求将真正尝试');
    }
    return false;
  }
  return true;
}

function getLlmConfig() {
  const c = config.llm || {};
  return {
    baseUrl: c.baseUrl || '',
    apiKey: c.apiKey || '',
    model: c.model || 'deepseek-chat',
    maxTokens: c.maxTokens || 1200,
    temperature: typeof c.temperature === 'number' ? c.temperature : 0.3,
    timeoutMs: c.timeoutMs || 45000,
    retries: Number.isFinite(c.retries) ? c.retries : 2,
    answerTimeoutMs: c.answerTimeoutMs || 45000,
    answerRetries: Number.isFinite(c.answerRetries) ? c.answerRetries : 1,
    reasoningEffort: c.reasoningEffort || '',
    supportsTools: c.supportsTools !== false,
  };
}

function isConfigured() {
  const c = getLlmConfig();
  return Boolean(c.baseUrl && c.apiKey);
}

/**
 * 调一次 chat completions。
 *
 * 对 429 / 5xx 做退避重试：上游渠道限流是常态，
 * 不重试的话规划阶段一失败，模型就会「没读数据就作答」——那是最坏的结果。
 *
 * @param {Array<{role:string,content:string}>} messages
 * @returns {Promise<{ok:boolean, text?:string, error?:string, usage?:object}>}
 */
function chat(messages, overrides = {}) {
  const c = { ...getLlmConfig(), ...overrides };
  const retries = Number.isFinite(c.retries) ? c.retries : 2;

  // 熔断打开：不发请求，直接失败 —— 上层会立刻走本地兜底
  if (isCoolingDown()) {
    return Promise.resolve({
      ok: false,
      error: '熔断中（上游连续失败，稍后自动重试）',
      breaker: breakerState(),
    });
  }

  return chatOnce(messages, c).then(async (r) => {
    let last = r;
    for (let i = 0; i < retries && !last.ok && isRetryable(last); i++) {
      const wait = 1500 * Math.pow(2, i) + Math.random() * 500;
      log('WARN', `LLM 重试 ${i + 1}/${retries}（${last.error}），等待 ${Math.round(wait)}ms`);
      await sleep(wait);
      last = await chatOnce(messages, c);
    }

    if (last.ok) noteSuccess();
    else noteFailure();

    return last;
  });
}

function isRetryable(r) {
  const e = String(r.error || '');
  return /HTTP 429|HTTP 5\d\d|超时|timeout|ECONNRESET|ETIMEDOUT|对端|socket hang up/i.test(e);
}

function sleep(ms) {
  return new Promise((res) => setTimeout(res, ms));
}

function chatOnce(messages, c) {
  if (!c.baseUrl || !c.apiKey) {
    return Promise.resolve({ ok: false, error: 'LLM 未配置（config.json 的 llm 段）' });
  }

  const payloadObj = {
    model: c.model,
    messages,
    max_tokens: c.maxTokens,
    temperature: c.temperature,
    stream: false,
  };
  // 推理模型的思考档位。不传时上游默认档位实测要 68 秒（规划）/ 139 秒（回答），
  // 传 low 后是 10 秒 / 29 秒，结论（调哪个工具、怎么答）不变。
  // 注意：minimal 在这个渠道会让模型输出空内容，所以最低只到 low。
  if (c.reasoningEffort) payloadObj.reasoning_effort = c.reasoningEffort;
  if (Array.isArray(c.tools) && c.tools.length) {
    payloadObj.tools = c.tools;
    payloadObj.tool_choice = c.toolChoice || 'auto';
  }
  const payload = JSON.stringify(payloadObj);

  let endpoint;
  try {
    const base = c.baseUrl.replace(/\/+$/, '');
    endpoint = new URL(base + '/chat/completions');
  } catch (e) {
    return Promise.resolve({ ok: false, error: `baseUrl 无效: ${e.message}` });
  }

  const isHttps = endpoint.protocol === 'https:';
  const mod = isHttps ? https : http;

  return new Promise((resolve) => {
    let settled = false;
    const done = (v) => { if (!settled) { settled = true; resolve(v); } };

    const req = mod.request({
      hostname: endpoint.hostname,
      port: endpoint.port || (isHttps ? 443 : 80),
      path: endpoint.pathname + endpoint.search,
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${c.apiKey}`,
        'content-length': Buffer.byteLength(payload),
      },
      timeout: c.timeoutMs,
    }, (res) => {
      let body = '';
      res.on('data', (d) => { body += d; });
      res.on('end', () => {
        if (res.statusCode !== 200) {
          let msg = body.slice(0, 200);
          try {
            const j = JSON.parse(body);
            msg = (j.error && (j.error.message || j.error.code)) || msg;
          } catch (_) {}
          return done({ ok: false, error: `HTTP ${res.statusCode}: ${msg}` });
        }
        try {
          const j = JSON.parse(body);
          const choice = j.choices && j.choices[0];
          const m = (choice && choice.message) || {};

          // 推理模型（deepseek-v4-flash 等）会先输出 reasoning_content，
          // content 可能为空或被截断。两者都取，便于判断真实原因。
          let text = m.content;
          const reasoning = m.reasoning_content || m.reasoning || '';

          const toolCalls = Array.isArray(m.tool_calls) ? m.tool_calls : [];

          if (toolCalls.length) {
            return done({
              ok: true,
              text: m.content || '',
              toolCalls: toolCalls.map((tc) => ({
                name: tc.function && tc.function.name,
                args: (() => {
                  try { return JSON.parse(tc.function && tc.function.arguments || '{}'); } catch (_) { return {}; }
                })(),
              })),
              reasoning,
              usage: j.usage,
            });
          }

          if (text == null || text === '') {
            // content 为空但推理有内容：模型「想完了却没输出」。
            // 旧实现直接判失败，但模型可能已经在推理里给出了答案
            //（实测 finish=stop 时 reasoning 里就有完整回答）。
            if (reasoning) {
              return done({ ok: true, text: String(reasoning).trim(), reasoning, reasoningOnly: true, usage: j.usage });
            }
            return done({ ok: false, error: `响应里没有 content（finish=${choice && choice.finish_reason}）` });
          }

          return done({ ok: true, text, reasoning, usage: j.usage });
        } catch (e) {
          return done({ ok: false, error: `解析失败: ${e.message}` });
        }
      });
    });

    req.on('error', (e) => done({ ok: false, error: `网络错误: ${e.code || e.message}` }));
    req.on('timeout', () => { req.destroy(); done({ ok: false, error: '超时' }); });
    req.write(payload);
    req.end();
  });
}

/**
 * 连通性自测：发一句最短的话。
 */
async function selftest() {
  const c = getLlmConfig();
  if (!isConfigured()) return { ok: false, error: '未配置' };
  const r = await chat([{ role: 'user', content: '回复"ok"两个字即可' }], { maxTokens: 10 });
  return { ...r, model: c.model, baseUrl: c.baseUrl };
}

// ── 两段式：先规划读什么，再回答 ────────────────────────────────

/**
 * 从模型输出里抠出 JSON（容忍 ```json 围栏和前后废话）。
 */
function extractJson(text) {
  let s = String(text || '').trim();
  s = s.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
  try { return JSON.parse(s); } catch (_) {}

  // 退一步：取第一个 { 到最后一个 }
  const a = s.indexOf('{');
  const b = s.lastIndexOf('}');
  if (a >= 0 && b > a) {
    try { return JSON.parse(s.slice(a, b + 1)); } catch (_) {}
  }
  return null;
}

/**
 * 有的渠道不支持原生 tools，模型于是把工具调用「写」成文本：
 *   <tool_call>{"name":"ops","arguments":{"kind":"广告","days":7}}</tool_call>
 * 或 {"tool_calls":[{"function":{...}}]}。
 * 这些都要认，否则规划阶段直接判成「不是 JSON」，白白退到关键词兜底。
 */
function extractToolCalls(text) {
  const s = String(text || '');
  const out = [];

  const re = /<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/gi;
  let m;
  while ((m = re.exec(s))) {
    const j = extractJson(m[1]);
    if (j && j.name) out.push({ name: j.name, args: j.arguments || j.args || {} });
  }
  if (out.length) return out;

  const j = extractJson(s);
  if (j && Array.isArray(j.tool_calls)) {
    for (const tc of j.tool_calls) {
      const fn = tc.function || tc;
      if (fn && fn.name) {
        let args = fn.arguments || fn.args || {};
        if (typeof args === 'string') { try { args = JSON.parse(args); } catch (_) { args = {}; } }
        out.push({ name: fn.name, args });
      }
    }
  }
  return out;
}

// 「不需要读数据」的显式信号。
// 不加这个哨兵，模型在「建提醒 / 闲聊」时要么回一段文字、要么回一段自创 JSON，
// plan() 只能判成失败 → 每次都在白白调一次模型之后退回关键词兜底。
// 有了它，模型可以明确表态，规划结果就只有一个含义。
const NONE_TOOL = {
  type: 'function',
  function: {
    name: 'none',
    description: '不需要读取任何数据时调用：闲聊、打招呼、建提醒、记录信息、登记实体的消息都用它。',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
  },
};

/**
 * 第一段：规划。
 *
 * 模型看不到表内容，只看到「目录」（有哪些表、哪些产品线、有哪些工具）。
 * 它要做的是判断：这句话要不要读数据，读哪个工具，参数是什么。
 *
 * 走原生 function calling（实测该上游支持 tool_calls，参数是合法 JSON）。
 * 模型/渠道不支持 tools 时自动回落到「文本工具调用 / JSON」。
 *
 * @param {string} text 用户消息
 * @param {string} catalog 目录文本
 * @param {string} today 今天日期（YYYY-MM-DD）
 * @param {Array<{name:string,args:string,desc:string}>} [toolSpec] 工具清单（来自 catalog.TOOLS）
 * @returns {Promise<{ok:boolean, plan?:object, error?:string}>}
 */
async function plan(text, catalog, today, toolSpec = []) {
  const W = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
  const wd = W[new Date(`${today}T00:00:00+08:00`).getDay()] || '';

  const p = profile.get();
  const U = p.userLabel || '老板';
  const keys = profile.seriesKeys();
  const scopeLines = [];
  if (keys.length) scopeLines.push(`series 只能填：${keys.join(' / ')}`);
  if (p.taboos.length) scopeLines.push(`绝对不要涉及：${p.taboos.join('、')}`);

  const system = `你是一个规划器，服务于「${p.role}」。你看不到表格内容，只能看到数据目录。

你的任务只有一个：判断这句话需要读哪些数据，然后调用工具。**必须调用工具**，
不需要读数据时调用 none。

规则：
1. 纯闲聊、打招呼、确认收到 → 调 none
2. 建提醒、记录信息 → 一般调 none；如果要核对已有提醒/产品归属，调 task 或 product
3. 问数据 → 只调**真正需要**的工具，宁少不多（最多 3 个）
4. 问「某个产品/某条广告活动」→ 先 product / campaign，不要直接读整表
${scopeLines.map((s, i) => `${5 + i}. ${s}`).join('\n')}${scopeLines.length ? '\n' : ''}${5 + scopeLines.length}. 不要输出任何解释文字，只调工具`;

  const user = `今天 ${today}（${wd}）

=== 数据目录 ===
${catalog}

=== ${U}的消息 ===
${text}`;

  const messages = [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];

  const useTools = getLlmConfig().supportsTools && toolSpec.length > 0;
  const overrides = { maxTokens: 900, temperature: 0.1 };
  if (useTools) overrides.tools = buildToolSchemas(toolSpec);

  const r = await chat(messages, overrides);

  if (!r.ok) return { ok: false, error: r.error };

  // ── 情况 A：原生 tool_calls ──
  if (Array.isArray(r.toolCalls) && r.toolCalls.length) {
    const raw = r.toolCalls
      .filter((t) => t && t.name)
      .map((t) => ({ name: t.name, args: t.args || {} }));

    // none 哨兵：模型明确说「不用读数据」
    const tools = raw.filter((t) => t.name !== 'none');
    if (!tools.length) {
      return { ok: true, plan: { needsData: false, tools: [], why: 'none' } };
    }
    return { ok: true, plan: { needsData: true, tools, why: 'tool_calls' } };
  }

  // ── 情况 B：模型把工具调用写成了文本（渠道不支持原生 tools 时） ──
  const written = extractToolCalls(r.text);
  if (written.length) {
    const known = new Set([...toolSpec.map((t) => t.name), 'none']);
    const tools = written
      .filter((t) => t.name && (!known.size || known.has(t.name)))
      .filter((t) => t.name !== 'none')
      .map((t) => ({ name: t.name, args: t.args || {} }));
    if (tools.length) {
      return { ok: true, plan: { needsData: true, tools, why: 'text tool_call' } };
    }
    if (written.some((t) => t.name === 'none')) {
      return { ok: true, plan: { needsData: false, tools: [], why: 'none(text)' } };
    }
  }

  // ── 情况 C：老路，模型直接给 JSON ──
  const parsed = extractJson(r.text);
  if (parsed && Array.isArray(parsed.tools)) {
    const tools = parsed.tools.filter((t) => t && t.name && t.name !== 'none');
    return {
      ok: true,
      plan: {
        needsData: parsed.needsData !== false && tools.length > 0,
        tools,
        why: parsed.why || '',
      },
    };
  }

  // ── 情况 D：模型给了纯文本（闲聊型回答）→ 当作「不用读数据」，避免白跑兜底 ──
  //   注意：只有当模型输出里完全没有数字时才这么做；
  //   否则宁可失败走兜底，也不能让模型「没读数据却答了数字」。
  const plain = String(r.text || '').trim();
  if (plain && !/\d/.test(plain)) {
    return { ok: true, plan: { needsData: false, tools: [], why: 'plain-text' } };
  }

  return { ok: false, error: `规划结果里没有工具调用：${String(plain || r.reasoning || '').slice(0, 120)}` };
}

/** 把 catalog.TOOLS 的「参数说明」转成 OpenAI function schema。
 *  series / kind 的枚举来自 profile.json —— 没有业务档案时不伪造枚举。 */
function buildToolSchemas(toolSpec) {
  const SERIES_ENUM = profile.seriesKeys();
  const KIND_ENUM = (profile.get().tables?.daily?.actionKinds) || ['广告', '促销', '价格', '库存', '其他'];

  const s = (name) => (SERIES_ENUM.length
    ? { type: 'string', enum: SERIES_ENUM }
    : { type: 'string' });

  const PARAMS = {
    stock: { series: s() },
    ops: {
      days: { type: 'integer' },
      kind: KIND_ENUM.length ? { type: 'string', enum: KIND_ENUM } : { type: 'string' },
      series: s(),
    },
    changes: { series: s() },
    weekly: { series: s(), weeks: { type: 'integer' } },
    aging: {},
    product: { query: { type: 'string' } },
    campaign: { query: { type: 'string' }, product: { type: 'string' } },
    notes: { query: { type: 'string' }, kind: { type: 'string' }, limit: { type: 'integer' } },
    task: { query: { type: 'string' }, limit: { type: 'integer' } },
  };

  const schemas = toolSpec.map((t) => ({
    type: 'function',
    function: {
      name: t.name,
      description: t.desc,
      parameters: {
        type: 'object',
        properties: PARAMS[t.name] || {},
        required: t.name === 'product' ? ['query'] : [],
        additionalProperties: false,
      },
    },
  }));

  schemas.push(NONE_TOOL);
  return schemas;
}

// ── 单次调用（agent 模式）─────────────────────────────────────
//
// 旧的「规划 → 读表 → 作答」固定要两次模型调用，即使这条消息根本不用读表
// （「提醒我…」「你好」）。上游渠道按请求数限流，实测连发几条就会 429。
//
// 这里合成一步：一次调用里模型要么直接给出最终 JSON，要么调工具；
// 调了工具才追加第二次调用。对「不读表」的消息，调用数从 2 降到 1。
//
// 任何一步不符合预期 → 返回 ok:false，router 会退回两段式老路径，
// 所以这是一个纯增量优化，不会让原来能跑的流程变差。

/**
 * 单次调用：带工具，但要求模型**要么直接输出最终 JSON，要么调工具**。
 *
 * @param {Array} messages
 * @param {Array} toolSpec
 * @param {{maxTokens?:number}} opts
 * @returns {Promise<{ok:boolean, text?:string, toolCalls?:Array, error?:string}>}
 */
async function act(messages, toolSpec = [], { maxTokens = 4000 } = {}) {
  const c = getLlmConfig();
  const useTools = c.supportsTools && toolSpec.length > 0;

  const r = await chat(messages, {
    maxTokens,
    temperature: c.temperature,
    ...(useTools ? { tools: buildToolSchemas(toolSpec) } : {}),
  });

  if (!r.ok) return { ok: false, error: r.error };

  const calls = (r.toolCalls || []).filter((t) => t && t.name && t.name !== 'none');
  if (calls.length) return { ok: true, toolCalls: calls, text: r.text || '' };

  // 文本形式的工具调用（渠道不支持原生 tools 时）
  const written = extractToolCalls(r.text).filter((t) => t.name !== 'none');
  const known = new Set(toolSpec.map((t) => t.name));
  const valid = written.filter((t) => known.has(t.name));
  if (valid.length) return { ok: true, toolCalls: valid, text: r.text || '' };

  return { ok: true, text: String(r.text || '').trim() };
}

module.exports = {
  chat, isConfigured, selftest, getLlmConfig, extractJson, extractToolCalls,
  plan, act, buildToolSchemas, NONE_TOOL,
  isCoolingDown, breakerState,
};
