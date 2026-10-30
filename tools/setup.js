'use strict';

/**
 * npm run setup —— 交互式安装向导
 *
 * 目标（对齐项目开源诉求）：clone 下来的人，只需要
 *   ① 在浏览器里点「授权 / 创建应用」，② 粘贴大模型 API Key
 * 其余全部自动：lark-cli 安装检查、建应用、登录、找到自己和机器人的
 * 会话 chatId、发现飞书表格结构、访谈生成 profile.json、自检。
 *
 * 每一步失败都给出手工兜底路径，绝不把用户卡死。
 * 密钥只写 config.local.json（gitignore），全程不回显。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const readline = require('readline');
const { spawn, spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const CONFIG_LOCAL = path.join(ROOT, 'config.local.json');
const PROFILE_FILE = path.join(ROOT, 'profile.json');

// ── 小工具 ─────────────────────────────────────────────────────

let rl = readline.createInterface({ input: process.stdin, output: process.stdout });

function ask(q) {
  return new Promise((res) => rl.question(q, (a) => res(String(a || '').trim())));
}

async function askSecret(q) {
  // 非交互（管道）输入：退回普通读取，raw mode 会抛
  if (!process.stdin.isTTY) return ask(q);
  // 不回显读取。readline 也挂着 stdin 的监听器，会和 raw 模式抢数据，
  // 所以先关掉它，读完重建 —— 后面的 ask 还要用。
  rl.close();
  const buf = await new Promise((res) => {
    process.stdout.write(q);
    const stdin = process.stdin;
    stdin.setRawMode(true);
    stdin.resume();
    let acc = '';
    const onData = (ch) => {
      const s = ch.toString();
      for (const c of s) {
        if (c === '\r' || c === '\n') {
          stdin.setRawMode(false);
          stdin.pause();
          stdin.removeListener('data', onData);
          process.stdout.write('\n');
          return res(acc);
        }
        if (c === '\u0003') { // Ctrl+C
          stdin.setRawMode(false);
          process.stdout.write('\n');
          process.exit(130);
        }
        if (c === '\u007f' || c === '\b') acc = acc.slice(0, -1);
        else if (c >= ' ') acc += c;
      }
    };
    stdin.on('data', onData);
  });
  rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return buf;
}

function step(n, total, msg) {
  console.log(`\n\u001b[36m── 步骤 ${n}/${total}：${msg}\u001b[0m`);
}

function ok(msg) { console.log(`  \u001b[32m✓\u001b[0m ${msg}`); }
function warn(msg) { console.log(`  \u001b[33m!\u001b[0m ${msg}`); }
function bad(msg) { console.log(`  \u001b[31m✗\u001b[0m ${msg}`); }

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// ── lark-cli 调用 ──────────────────────────────────────────────

let CLI_BIN = '';

function findCli() {
  // Windows 上只有 .exe 能直接 spawn（.cmd 是 shim）；unix 用裸名字。
  const want = process.platform === 'win32' ? '.exe' : '';
  const dirs = String(process.env.PATH || '').split(path.delimiter).filter(Boolean);
  for (const dir of dirs) {
    const p = path.join(dir, 'lark-cli' + want);
    if (fs.existsSync(p)) return p;
  }
  if (process.env.LARK_CLI_PATH && fs.existsSync(process.env.LARK_CLI_PATH)) return process.env.LARK_CLI_PATH;
  // npm 全局常见位置
  const home = os.homedir();
  const guesses = [
    path.join(home, 'AppData', 'Roaming', 'npm', 'node_modules', '@larksuite', 'cli', 'bin', 'lark-cli.exe'),
    '/usr/local/lib/node_modules/@larksuite/cli/bin/lark-cli',
    '/usr/lib/node_modules/@larksuite/cli/bin/lark-cli',
  ];
  for (const g of guesses) if (fs.existsSync(g)) return g;
  return '';
}

function cliJson(args, { timeoutMs = 60000 } = {}) {
  return new Promise((resolve) => {
    const child = spawn(CLI_BIN, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    const timer = setTimeout(() => { try { child.kill(); } catch (_) {} finish({ ok: false, error: 'timeout' }); }, timeoutMs);
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', (e) => { clearTimeout(timer); finish({ ok: false, error: e.message }); });
    child.on('close', (code) => {
      clearTimeout(timer);
      let parsed = null;
      const t = out.trim();
      if (t) {
        try { parsed = JSON.parse(t); }
        catch (_) {
          const i = t.lastIndexOf('\n{');
          if (i >= 0) { try { parsed = JSON.parse(t.slice(i + 1)); } catch (_) {} }
        }
      }
      finish({ ok: code === 0 && (!parsed || parsed.ok !== false), parsed, code, stderr: err });
    });
  });
}

async function showAuthUrl(url) {
  console.log(`\n  👉 打开这个链接完成操作（手机上用飞书扫码也可以）：\n     ${url}`);
  try {
    const r = spawnSync(CLI_BIN, ['auth', 'qrcode', url, '--ascii'], { encoding: 'utf8', timeout: 15000 });
    const out = `${r.stdout || ''}${r.stderr || ''}`;
    if (/█|▄|▀/.test(out)) {
      console.log('\n' + out.split('\n').map((l) => '     ' + l).join('\n'));
    }
  } catch (_) { /* ASCII 二维码只是锦上添花 */ }
}

// ── 配置读写（config.local.json）───────────────────────────────

function loadLocal() {
  try { return JSON.parse(fs.readFileSync(CONFIG_LOCAL, 'utf8')); } catch (_) { return {}; }
}
function saveLocal(c) {
  fs.writeFileSync(CONFIG_LOCAL, JSON.stringify(c, null, 2) + '\n', 'utf8');
}

// ── 步骤实现 ───────────────────────────────────────────────────

async function checkPrereqs() {
  step(1, 7, '环境检查');
  const v = process.versions.node.split('.').map(Number);
  if (v[0] < 22 || (v[0] === 22 && v[1] < 5)) {
    bad(`Node.js ≥ 22.5 才能跑（SQLite 内置驱动需要），当前 ${process.version}`);
    return false;
  }
  ok(`Node.js ${process.version}`);

  CLI_BIN = findCli();
  if (!CLI_BIN) {
    warn('没找到 lark-cli（飞书官方命令行）。')
    const a = await ask('  现在自动安装吗？（npm i -g @larksuite/cli）[Y/n] ');
    if (!a || /^y/i.test(a)) {
      console.log('  安装中…');
      const npmBin = process.platform === 'win32' ? 'npm.cmd' : 'npm';
      const r = spawnSync(npmBin, ['i', '-g', '@larksuite/cli'], { stdio: 'inherit' });
      if (r.status !== 0) {
        bad('自动安装失败。请手工执行: npm i -g @larksuite/cli，装完重新跑 npm run setup');
        return false;
      }
      CLI_BIN = findCli();
    }
    if (!CLI_BIN) {
      bad('装完了但 PATH 里找不到 lark-cli。设置环境变量 LARK_CLI_PATH 指向它，再重跑 setup。');
      return false;
    }
  }
  ok(`lark-cli: ${CLI_BIN}`);
  return true;
}

async function ensureApp() {
  step(2, 7, '连接飞书应用（不用手填 App ID / Secret）');

  const st = await cliJson(['auth', 'status', '--json']);
  if (st.ok && st.parsed && st.parsed.appId) {
    ok(`已绑定应用：${(st.parsed.identities && st.parsed.identities.bot && st.parsed.identities.bot.appName) || st.parsed.appId}`);
    return st.parsed;
  }

  console.log('  还没有绑定飞书应用。lark-cli 会在浏览器里带你创建并授权一个，全程不用抄任何 ID。');
  const child = spawn(CLI_BIN, ['config', 'init', '--new'], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  let shown = false;
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', async (d) => {
    out += d;
    if (!shown) {
      const m = out.match(/https:\/\/[^\s"']+\/[^\s"']*(?:verification|config|auth|app)[^\s"']*/i)
        || out.match(/https:\/\/[^\s"']{20,}/);
      if (m) {
        shown = true;
        await showAuthUrl(m[0]);
        console.log('\n  完成后这个步骤会自动继续（等最多 5 分钟）…');
      }
    }
  });

  const t0 = Date.now();
  while (Date.now() - t0 < 300000) {
    if (child.exitCode !== null) break;
    await sleep(2000);
  }

  const st2 = await cliJson(['auth', 'status', '--json']);
  if (st2.ok && st2.parsed && st2.parsed.appId) {
    ok(`应用已创建：${st2.parsed.appId}`);
    return st2.parsed;
  }
  bad('没检测到应用配置。你可以稍后手工执行 lark-cli config init --new，然后重跑本向导。');
  return null;
}

async function ensureUserAuth() {
  step(3, 7, '飞书授权（扫码，一次搞定读消息/读表格）');

  const st = await cliJson(['auth', 'status', '--json', '--verify']);
  const user = st.parsed && st.parsed.identities && st.parsed.identities.user;
  if (user && (user.status === 'ready' || user.status === 'active') && /sheets:spreadsheet:read/.test(user.scope || '')) {
    ok(`用户已授权：${user.userName || user.openId}`);
    return st.parsed;
  }

  console.log('  需要以你本人的身份授权（读表格用的是用户权限，应用身份看不到你个人的表）。');
  const r = await cliJson(['auth', 'login', '--domain', 'im', '--domain', 'sheets', '--domain', 'wiki', '--domain', 'drive', '--no-wait', '--json']);
  if (!r.ok || !r.parsed) {
    bad('发起授权失败：' + (r.stderr || r.error || '未知错误'));
    warn('兜底：手工执行 lark-cli auth login --domain all，完成后再回来按回车。');
    await ask('按回车继续…');
  } else {
    const url = r.parsed.verification_url || r.parsed.verification_uri_complete || (r.parsed.data && r.parsed.data.verification_url);
    const code = r.parsed.device_code || (r.parsed.data && r.parsed.data.device_code);
    if (!url) { bad('返回里没有授权链接：' + JSON.stringify(r.parsed).slice(0, 200)); }
    else {
      await showAuthUrl(url);
      console.log('\n  请在手机/浏览器里完成授权，然后回来按回车…');
      await ask('（确认你已完成授权）按回车继续…');
      if (code) {
        const done = await cliJson(['auth', 'login', '--device-code', code], { timeoutMs: 90000 });
        if (done.ok) ok('授权完成');
        else warn('完成授权失败：' + (done.stderr || done.error || '') + '（不影响后面的步骤，读表失败时重跑 lark-cli auth login 即可）');
      }
    }
  }
  return (await cliJson(['auth', 'status', '--json', '--verify'])).parsed;
}

async function bindChat(status) {
  step(4, 7, '找到你和机器人的对话（chatId 自动获取，不用抄）');

  const local = loadLocal();
  if (local.chatId) {
    ok(`沿用已有 chatId：${local.chatId.slice(0, 12)}…`);
    return local.chatId;
  }

  const userOpenId = status && status.identities && status.identities.user && status.identities.user.openId;
  if (!userOpenId) {
    warn('拿不到你的 open_id。兜底：在飞书里和机器人对话的窗口地址栏/信息里复制 chatId（oc_ 开头）。');
    const manual = await ask('  粘贴 oc_ 开头的 chatId（拿不到就回车跳过，之后可手填 config.local.json）：');
    if (/^oc_/.test(manual)) {
      const c = loadLocal(); c.chatId = manual; saveLocal(c);
      ok(`已保存 chatId`);
      return manual;
    }
    return null;
  }

  // 路径 A：直接给本人发一条测试消息 —— 返回里带 chat_id，顺便验证机器人能说话
  console.log('  正在用机器人给你发一条测试消息…');
  const send = await cliJson([
    'im', '+messages-send', '--as', 'bot', '--user-id', userOpenId,
    '--text', 'feishu-bridge 安装成功 ✅ 以后有事直接在这里说。', '--json',
  ]);
  let chatId = null;
  if (send.ok && send.parsed && send.parsed.data) {
    chatId = send.parsed.data.chat_id
      || (send.parsed.data.message && send.parsed.data.message.chat_id);
  }

  // 路径 B：列 p2p 会话
  if (!chatId) {
    warn('发消息没拿到 chat_id（可能机器人还没开通 im:message 发送权限，稍后处理）。改用会话列表探测…');
    const list = await cliJson(['im', '+chat-list', '--as', 'user', '--types', 'p2p', '--json']);
    if (list.ok && list.parsed && list.parsed.data) {
      const chats = list.parsed.data.chats || list.parsed.data.items || [];
      const botName = status.identities.bot && status.identities.bot.appName;
      const hit = chats.find((c) => botName && String(c.name || '').includes(botName)) || chats[0];
      if (hit) chatId = hit.chat_id || hit.id;
    }
  }

  if (chatId) {
    const c = loadLocal(); c.chatId = chatId; c.userOpenId = userOpenId; saveLocal(c);
    ok(`chatId 已写入 config.local.json：${chatId.slice(0, 14)}…`);
    if (send.ok) ok('测试消息已送达飞书，请查收');
    else warn('发送测试消息失败。若机器人缺权限：到飞书开发者后台开通 im:message（发送消息）后重试 npm run setup');
    return chatId;
  }

  bad('自动获取失败。手工兜底：跑一次 lark-cli im +chat-list --types p2p --json，把 p2p 会话的 chat_id 填进 config.local.json 的 chatId。');
  return null;
}

function askLlmConfig() {
  step(5, 7, '大模型 API（这是唯一要你填的密钥）');
  return (async () => {
    const local = loadLocal();
    const saved = local.llm || {};
    if (saved.baseUrl && saved.apiKey && saved.model) {
      ok(`沿用已配置：${saved.model} @ ${saved.baseUrl}`);
      const redo = await ask('  要重新配置吗？[y/N] ');
      if (!/^y/i.test(redo)) return saved;
    }
    console.log('  任意 OpenAI 兼容接口都可以：DeepSeek / 硅基流动 / 智谱 / 通义 / OpenAI…');
    console.log('  示例：https://api.deepseek.com  model=deepseek-chat');
    const baseUrl = (await ask('  baseUrl（留空保留现值）：')) || saved.baseUrl || '';
    const model = (await ask('  model：')) || saved.model || '';
    const keyHint = saved.apiKey ? `（已存 ${saved.apiKey.slice(0, 6)}…，直接回车保留）` : '';
    const apiKey = (await askSecret(`  apiKey${keyHint}：`)) || saved.apiKey || '';

    const c = loadLocal();
    c.llm = { ...(c.llm || {}), baseUrl, model, apiKey };
    saveLocal(c);
    ok('已保存（写入 config.local.json，不会提交进 git）');

    // 连通性自检
    console.log('  测试连通性…');
    const { config } = require('../src/config');
    config.llm.baseUrl = baseUrl;
    config.llm.model = model;
    config.llm.apiKey = apiKey;
    const llm = require('../src/llm');
    const r = await llm.selftest();
    if (r.ok) ok(`模型可用：${String(r.text || '').slice(0, 30)}`);
    else warn(`模型自检失败：${r.error}（先继续，稍后可用 node tools/setup-llm.js test 复查）`);
    return c.llm;
  })();
}

/** 从一个飞书链接解析出电子表格 token（wiki 自动解包）。 */
async function resolveSheetToken(urlOrToken) {
  const s = String(urlOrToken || '').trim();
  if (!s) return null;
  if (/^https?:\/\//.test(s)) {
    const r = await cliJson(['drive', '+inspect', '--url', s, '--as', 'user', '--json']);
    if (r.ok && r.parsed && r.parsed.data) {
      const d = r.parsed.data;
      const tok = d.obj_token || d.token;
      const type = d.obj_type || d.type;
      if (type && type !== 'sheet' && type !== 'spreadsheet') {
        warn(`这是「${type}」不是电子表格。目前自动接入只支持电子表格（sheet），其他类型先跳过。`);
        return null;
      }
      return tok || null;
    }
    // 兜底：直接正则取 URL 里最后一段
    const m = s.match(/\/(?:wiki|sheets)\/([A-Za-z0-9_-]+)/);
    return m ? m[1] : null;
  }
  return s; // 裸 token
}

async function probeSheets(token) {
  const r = await cliJson(['api', 'GET', `/open-apis/sheets/v3/spreadsheets/${token}/sheets/query`, '--as', 'user']);
  if (!r.ok || !r.parsed || !r.parsed.data) return null;
  return (r.parsed.data.sheets || []).map((s) => ({ id: s.sheet_id, title: s.title || s.sheet_name || s.sheet_id }));
}

/**
 * 用大模型把「访谈 + 表格结构」变成 profile.json。
 * 没有 LLM 时退回规则拼装（访谈文本进 extra，表结构原样列出，列映射留空让人补）。
 */
async function buildProfile(answers, sheetInfos, llmCfg) {
  const base = {
    version: 1,
    name: answers.name || '助理',
    role: answers.role || '通过飞书与用户沟通的个人助理',
    userLabel: answers.userLabel || '老板',
    scope: answers.scope || '',
    taboos: answers.taboos || [],
    series: answers.series || [],
    tables: {},
    extra: answers.notes || '',
  };

  if (!sheetInfos.length) return base;

  if (llmCfg && llmCfg.baseUrl && llmCfg.apiKey) {
    try {
      const { config } = require('../src/config');
      config.llm.baseUrl = llmCfg.baseUrl; config.llm.apiKey = llmCfg.apiKey; config.llm.model = llmCfg.model;
      const llm = require('../src/llm');
      const sys = `你要为「飞书运营助理」生成业务档案。给你：用户的访谈回答 + 每张电子表格的工作表清单和表头行。
输出严格 JSON（不要代码块、不要解释），字段：
{
 "series":[{"key":"分组名","aliases":["别名"],"desc":"说明"}],
 "tables":{
   "daily":{"token":"","label":"","sheets":[{"id":"","label":""}],"columns":{"date":1,"product":2,"asin":3,"sku":4,"price":5,"rankBig":6,"rankSmall":7,"reviews":8,"rating":9,"badNew":10,"badReason":11,"goodNew":12,"goodReason":13,"action":14,"remark":23},"actionKinds":["广告","促销","价格","库存","其他"]},
   "weekly":{"token":"","label":"","sheets":[{"id":"","label":""}],"columns":{"period":1,"sku":2,"asin":3,"name":4,"qty":5,"revenue":6,"commission":7,"fulfillment":8,"cost":9,"freight":10,"refund":11,"dealFee":12},"commissionFallbackRate":0.15},
   "aging":{"token":"","label":"","sheet":"","columns":{"product":1,"sku":2,"warehouse":3,"d151_180":8,"d181_210":9,"d211_270":10,"d271_365":11,"d365plus":12,"unitPrice":13}}
 },
 "scope":"一句话工作范围",
 "taboos":["禁碰的东西"]
}
规则：
- 只输出你有把握的部分；对应不上的表/列就整体省略（不要编）。
- columns 是 1-based 列号，必须根据表头文字判断（表头第几个词是「日期」→ date=那个位置）。
- 用户说的分组进 series，aliases 放口语别名。
- 如果表明显不是日运营/周报/库龄的语义，就跳过该表。`;
      const user = `=== 访谈 ===\n${JSON.stringify(answers, null, 2)}\n\n=== 表格结构 ===\n${JSON.stringify(sheetInfos, null, 2)}`;
      const r = await llm.chat([
        { role: 'system', content: sys },
        { role: 'user', content: user },
      ], { maxTokens: 4000, temperature: 0.2 });
      const j = r.ok && llm.extractJson(r.text);
      if (j && (j.tables || j.series)) {
        // 白名单合并：只接受结构里认识的键，token 用我们探测到的真值
        if (Array.isArray(j.series) && j.series.length) base.series = j.series.filter((x) => x && x.key);
        if (typeof j.scope === 'string' && j.scope) base.scope = j.scope;
        if (Array.isArray(j.taboos)) base.taboos = j.taboos;
        for (const kind of ['daily', 'weekly', 'aging']) {
          const t = j.tables && j.tables[kind];
          const src = sheetInfos.find((s) => s.kinds && s.kinds.includes(kind));
          if (!t || !src) continue;
          const merged = { ...t, token: src.token, label: t.label || src.label };
          const validIds = new Set(src.sheets.map((x) => x.id));
          if (Array.isArray(merged.sheets)) merged.sheets = merged.sheets.filter((x) => x && validIds.has(x.id));
          if (merged.sheets && !merged.sheets.length) continue;
          if (kind === 'aging' && merged.sheet && !validIds.has(merged.sheet)) merged.sheet = src.sheets[0].id;
          base.tables[kind] = merged;
        }
        return base;
      }
      warn('模型没能生成可用的档案结构，改用基础模式（表结构已登记，列映射留空，可在 profile.json 手工补）。');
    } catch (e) {
      warn('生成档案失败：' + e.message);
    }
  }

  // 规则兜底：至少把表登记上（列不映射，读表会明确报「缺列配置」而不是瞎读）
  for (const s of sheetInfos) {
    if (!s.kinds) continue;
    for (const kind of s.kinds) {
      base.tables[kind] = {
        token: s.token, label: s.label,
        ...(kind === 'aging' ? { sheet: s.sheets[0] && s.sheets[0].id } : { sheets: s.sheets.map((x) => ({ id: x.id, label: x.title })) }),
        columns: {},
      };
    }
  }
  return base;
}

async function interviewAndDetect(status, llmCfg) {
  step(6, 7, '告诉助理你的业务（3 个问题 + 可选的表格接入）');

  const answers = {};
  answers.role = (await ask('  1) 这个助理主要帮你干什么？（例：盯亚马逊店铺的运营数据 / 管理班级作业提醒）\n     > ') || '通过飞书与用户沟通的个人助理');
  answers.userLabel = (await ask('  2) 你怎么称呼自己？（默认「老板」）\n     > ')) || '老板';
  answers.scopeRaw = (await ask('  3) 有哪些业务分组（产品线/门店/班级，逗号分隔；没有就回车）？\n     > ')) || '';
  answers.taboosRaw = (await ask('  4) 有什么是它绝对不能碰的？（逗号分隔；回车跳过）\n     > ')) || '';

  answers.series = (answers.scopeRaw || '').split(/[,，]/).map((s) => s.trim()).filter(Boolean)
    .map((k) => ({ key: k, aliases: [], desc: '' }));
  answers.taboos = (answers.taboosRaw || '').split(/[,，]/).map((s) => s.trim()).filter(Boolean);

  // 表格接入
  const sheetInfos = [];
  let url = await ask('  要接入飞书电子表格吗？粘贴表格/知识库链接（回车跳过；之后可编辑 profile.json 补）\n     > ');
  while (url) {
    const token = await resolveSheetToken(url);
    if (token) {
      const sheets = await probeSheets(token);
      if (sheets) {
        console.log(`  已发现 ${sheets.length} 个工作表：${sheets.map((s) => s.title).join('、')}`);
        const kind = (await ask('  这张表是什么？ daily=每日运营记录 / weekly=周报 / aging=库龄 / skip。默认按名字猜：\n     > ') || '').toLowerCase();
        const guess = /库龄/.test(sheets.map((s) => s.title).join()) ? ['aging']
          : /周报|周度/.test(sheets.map((s) => s.title).join()) ? ['weekly']
          : /日运营|日报|运营/.test(sheets.map((s) => s.title).join()) ? ['daily'] : [];
        const kinds = kind === 'skip' ? [] : (kind ? [kind] : guess);
        // 读表头给模型/人参考
        let headers = [];
        for (const s of sheets.slice(0, 3)) {
          try {
            const r = await cliJson(['api', 'GET',
              `/open-apis/sheets/v2/spreadsheets/${token}/values/${encodeURIComponent(`${s.id}!A1:Z3`)}`,
              '--as', 'user'], { timeoutMs: 30000 });
            const vals = r.parsed && r.parsed.data && r.parsed.data.valueRange && r.parsed.data.valueRange.values || [];
            headers.push({ sheet: s.title, rows: vals.slice(0, 3) });
          } catch (_) {}
        }
        sheetInfos.push({ token, label: sheets[0] ? `(${sheets.length}个表)` : token, sheets, kinds, headers });
      } else warn('读不到这张表的工作表清单（可能无权限或不是电子表格）。');
    } else warn('解析不了这个链接。');
    url = await ask('  还要接入下一张表吗？（回车结束）\n     > ');
  }

  const profileObj = await buildProfile(answers, sheetInfos, llmCfg);
  fs.writeFileSync(PROFILE_FILE, JSON.stringify(profileObj, null, 2) + '\n', 'utf8');
  ok(`业务档案已生成：profile.json（分组 ${profileObj.series.length} 个 / 接入表 ${Object.keys(profileObj.tables).length} 张）`);
  return profileObj;
}

async function verify(profileObj) {
  step(7, 7, '自检');
  const local = loadLocal();

  // 清缓存重新加载模块视角的 profile/config
  delete require.cache[require.resolve('../src/profile')];
  const profile = require('../src/profile');
  profile.reload();

  const checks = [];
  checks.push([Boolean(local.chatId), 'chatId 已绑定（没有就再跑 npm run setup 走完第 4 步）']);
  checks.push([Boolean(local.llm && local.llm.apiKey), '大模型 Key 已配置']);
  checks.push([profile.hasTables(), profile.hasTables() ? '数据表已接入（没配也没关系，助理仍可建提醒/记笔记/对话）' : '未接入数据表 —— 正常，可跳过']);

  // 起一次目录构建，确认不炸
  try {
    const catalog = require('../src/catalog');
    const cat = catalog.build({ force: true });
    checks.push([cat.length > 50, `目录构建 OK（${cat.length} 字）`]);
  } catch (e) {
    checks.push([false, '目录构建失败：' + e.message]);
  }

  for (const [pass, msg] of checks) (pass ? ok : warn)(msg);

  console.log('\n\u001b[36m════ 完成 ════\u001b[0m');
  console.log('  启动：npm start        （前台调试，Ctrl+C 退出）');
  console.log('  后台常驻（Windows）：schtasks 注册计划任务，见 README「开机自启」一节');
  console.log('  控制台：http://127.0.0.1:' + (local.webPort || 4599));
  console.log('  测试一句：node tools/smoke-test.js "你好"');
  console.log('\n  ⚠ 提醒：机器人请只作为私人助手使用，不要拉进群或让他人对话（权限即你的身份）。');
}

// ── 主流程 ─────────────────────────────────────────────────────

async function main() {
  console.log('\n\u001b[1m feishu-bridge 安装向导\u001b[0m —— 全程只需要：浏览器点授权 + 粘贴一个大模型 Key。\n');

  if (process.env.OPENCLAW_HOME || process.env.HERMES_HOME) {
    warn('检测到 Agent 工作区环境变量（OPENCLAW_HOME/HERMES_HOME），lark-cli 会拒绝在这里建应用。');
    warn('请在你自己的普通终端（cmd / PowerShell）里运行 npm run setup。');
  }

  if (!(await checkPrereqs())) return;
  const status0 = await ensureApp();
  const status = await ensureUserAuth() || status0;
  await bindChat(status);
  const llmCfg = await askLlmConfig();
  const profileObj = await interviewAndDetect(status, llmCfg);
  await verify(profileObj);

  rl.close();
}

main().catch((e) => { console.error(e); try { rl.close(); } catch (_) {} process.exitCode = 1; });
