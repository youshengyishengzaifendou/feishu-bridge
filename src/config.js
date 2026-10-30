'use strict';

/**
 * 配置装配 —— 全项目唯一读配置的地方
 *
 * 分层（后者优先）：
 *   1. src/config.js 内置默认值           —— 通用、可公开
 *   2. config.example.json 不存在则忽略   —— 仅作模板，不参与运行
 *   3. config.json（旧位置，兼容保留）    —— gitignore 掉，历史用户无缝升级
 *   4. config.local.json                  —— setup 生成的本机配置（含密钥），gitignore
 *   5. 环境变量 BRIDGE_*                  —— 临时覆盖 / 部署时用
 *
 * 仓库里永远只有第 2 项。密钥、chatId、openId 都落在第 4 项。
 */

const path = require('path');
const fs = require('fs');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const DATA = path.join(ROOT, 'data');
const LOGS = path.join(ROOT, 'logs');

for (const d of [DATA, LOGS]) {
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
}

// ── lark-cli 自动发现 ──────────────────────────────────────────
//
// 写死某台机器的绝对路径（旧实现）换个人就起不来。这里按顺序找：
//   1. LARK_CLI_PATH 环境变量 / config 里手写的 cliPath
//   2. PATH 上的 lark-cli(.exe / .cmd / 无扩展名)
//   3. npm 全局目录下的已知安装位置
//   4. 找不到 → 留空，main.js 启动时报错并提示安装命令
//
// Windows 上 npm 的 lark-cli 是 .cmd shim，spawn .cmd 在新版 Node
// 需要 shell:true（安全策略禁止），所以这里尽量解析到真实的 .exe。
function findCli() {
  const env = process.env.LARK_CLI_PATH;
  if (env && fs.existsSync(env)) return env;

  const exts = process.platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : [''];
  const names = ['lark-cli'];

  // PATH 逐个试（比 which 稳：PATH 里可能含带空格目录）
  const dirs = String(process.env.PATH || '').split(path.delimiter).filter(Boolean);
  for (const dir of dirs) {
    for (const n of names) {
      for (const e of exts) {
        const p = path.join(dir, n + e);
        // .cmd/.bat 不是真实二进制，能优先找到 .exe 就不要用它
        if (e !== '.exe' && e !== '' ) continue;
        if (fs.existsSync(p)) return p;
      }
    }
  }

  // 常见 npm 全局位置
  const guess = [];
  // install.ps1 / install.sh 下载的便携 Node：lark-cli 会装在这里
  guess.push(path.join(ROOT, '.tools', 'node', 'node_modules', '@larksuite', 'cli', 'bin', 'lark-cli.exe'));
  guess.push(path.join(ROOT, '.tools', 'node', 'node_modules', '@larksuite', 'cli', 'bin', 'lark-cli'));
  const home = process.env.USERPROFILE || process.env.HOME || '';
  if (home) {
    guess.push(path.join(home, 'AppData', 'Roaming', 'npm', 'node_modules', '@larksuite', 'cli', 'bin', 'lark-cli.exe'));
    guess.push(path.join(home, '.nvm', 'current', 'node_modules', '@larksuite', 'cli', 'bin', 'lark-cli.exe'));
  }
  if (process.env.LOCALAPPDATA) {
    guess.push(path.join(process.env.LOCALAPPDATA, 'npm', 'node_modules', '@larksuite', 'cli', 'bin', 'lark-cli.exe'));
  }
  guess.push('/usr/local/lib/node_modules/@larksuite/cli/bin/lark-cli');
  guess.push('/usr/lib/node_modules/@larksuite/cli/bin/lark-cli');
  for (const g of guess) {
    if (g && fs.existsSync(g)) return g;
  }

  return '';
}

// ── 默认值 ─────────────────────────────────────────────────────
const defaults = {
  // lark-cli 二进制路径（空 = 运行时自动发现）
  cliPath: '',
  // lark-cli 的 profile 名（空 = 用 lark-cli 当前默认 profile）
  profile: '',
  // 机器人对话的会话 id（空 = 尚未绑定，setup 会引导绑定）
  chatId: '',
  // 你的 open_id（仅诊断用，setup 自动填）
  userOpenId: '',
  // 发消息用的身份：bot = 以应用名义
  sendAs: 'bot',
  // 调度 tick 间隔（毫秒）
  tickMs: 20000,
  // 事件监听断开后的重启退避基数
  listenerRestartMs: 5000,
  // 轮询兜底间隔（毫秒）——事件流掉线时接替实时接收
  pollMs: 120000,
  // 消息里没说时间时，提醒默认落在几点
  defaultHour: 10,
  // 提醒档位（距到期的分钟数）。[0] = 只准点提醒。
  // 想提前提醒：改成 [1440, 120, 0]（提前 1 天 / 2 小时 / 准点），并把 onlyOnTime 设为 false。
  advanceMinutes: [0],
  // true = 强制只准点，忽略模型给的提前档
  onlyOnTime: true,
  // 本地控制台端口
  webPort: 4599,
  // 队列里消息超过多少秒交给规则兜底
  agentStaleSeconds: 240,
  // 关机再开机，超过多少分钟的过期提醒不再补发（防止刷屏）
  catchUpGraceMinutes: 180,
  // 读表缓存开关
  dataCache: true,
  // 收到消息先本地秒回一句「收到…」再去干活
  instantReply: true,
  // 大模型：任何 OpenAI 兼容接口。apiKey 只应出现在 config.local.json。
  llm: {
    baseUrl: '',
    apiKey: '',
    model: '',
    maxTokens: 4000,
    temperature: 0.3,
    timeoutMs: 60000,
    retries: 2,
    // 「读完表再作答」这一次调用的独立预算（比规划更紧，防止最坏路径卡几分钟）
    answerTimeoutMs: 45000,
    answerRetries: 1,
    // 推理模型思考档位：low / medium / high；'' = 不下发（非推理模型用这个）
    reasoningEffort: '',
    // 渠道是否支持原生 function calling；false 时自动回落文本工具调用
    supportsTools: true,
  },
};

// ── 合并 ───────────────────────────────────────────────────────
function readJson(file) {
  try {
    if (!fs.existsSync(file)) return {};
    const obj = JSON.parse(fs.readFileSync(file, 'utf8'));
    // 剥掉注释键（模板文件里以 _ 开头的键都是给人看的说明）
    for (const k of Object.keys(obj)) if (k.startsWith('_')) delete obj[k];
    if (obj.llm) for (const k of Object.keys(obj.llm)) if (k.startsWith('_')) delete obj.llm[k];
    return obj;
  } catch (e) {
    console.error(`${path.basename(file)} 解析失败，忽略该文件: ${e.message}`);
    return {};
  }
}

// 浅合并会把 llm 整段覆盖：config 里只写 baseUrl/apiKey/model 时，
// maxTokens/retries/timeoutMs 全丢。对嵌套对象做深合并。
function mergeDeep(base, over) {
  if (!over || typeof over !== 'object' || Array.isArray(over)) return base;
  const out = { ...base };
  for (const [k, v] of Object.entries(over)) {
    const cur = out[k];
    if (v && typeof v === 'object' && !Array.isArray(v) && cur && typeof cur === 'object' && !Array.isArray(cur)) {
      out[k] = mergeDeep(cur, v);
    } else if (v !== undefined) {
      out[k] = v;
    }
  }
  return out;
}

const legacy = readJson(path.join(ROOT, 'config.json'));      // 旧位置（兼容）
const local = readJson(path.join(ROOT, 'config.local.json'));  // 本机位置（优先）

let config = mergeDeep(mergeDeep(defaults, legacy), local);

// 环境变量覆盖：BRIDGE_CHAT_ID / BRIDGE_PROFILE / BRIDGE_LLM_API_KEY / BRIDGE_LLM_BASE_URL / BRIDGE_LLM_MODEL ...
const envMap = {
  BRIDGE_CHAT_ID: 'chatId',
  BRIDGE_PROFILE: 'profile',
  BRIDGE_CLI_PATH: 'cliPath',
  BRIDGE_WEB_PORT: 'webPort',
};
for (const [env, key] of Object.entries(envMap)) {
  if (process.env[env]) config[key] = process.env[env];
}
if (process.env.BRIDGE_LLM_BASE_URL) config.llm.baseUrl = process.env.BRIDGE_LLM_BASE_URL;
if (process.env.BRIDGE_LLM_API_KEY) config.llm.apiKey = process.env.BRIDGE_LLM_API_KEY;
if (process.env.BRIDGE_LLM_MODEL) config.llm.model = process.env.BRIDGE_LLM_MODEL;

// 解析后的 cli 路径：手写的 > 自动发现
config.cliPathResolved = config.cliPath && fs.existsSync(config.cliPath) ? config.cliPath : findCli();

module.exports = {
  ROOT,
  DATA,
  LOGS,
  config,
  LOCAL_CONFIG: path.join(ROOT, 'config.local.json'),
  findCli,
  paths: {
    db: path.join(DATA, 'bridge.db'),
    spool: path.join(DATA, 'spool'),
    inbox: path.join(DATA, 'inbox'),
    log: path.join(LOGS, 'bridge.log'),
    pid: path.join(DATA, 'bridge.pid'),
  },
};
