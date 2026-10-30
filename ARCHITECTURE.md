#    飞书提醒桥接 · 架构说明

## 一句话

飞书发消息 → 模型先看「数据目录」判断要读什么 → 按需读飞书表格 → 建提醒/答数据/记实体 → 回飞书。
所有状态落在本地 SQLite（`data/bridge.db`）。

## 与上一版的区别

| 维度 | 旧版 | 现在 |
|---|---|---|
| 数据读取 | 每条消息预读日运营+周报+库龄整表（约 13 次 lark-cli） | 先给目录（1361 字），模型决定读哪个工具；只读到需要的那部分 |
| prompt 体积 | 3000+ 字，且大部分用不上 | 约 1400 字，且带工具清单 |
| 任务存储 | `tasks.json` 全表读进内存 → 整表写回 | SQLite + `earliest_ms` 索引，只扫描到期的那几条 |
| 并发安全 | 调度期间新建的任务会被整表写回覆盖 | 每个任务单独 patch，不会互相覆盖 |
| 产品/活动 | 表格里的一行文字，没有实体 | `products` / `campaigns` 表，活动必须归属产品 |
| 读表缓存 | 无 | `src/cache.js`，TTL 120 秒，一轮对话内复用 |
| 循环提醒 | 拆成 N 条一次性任务，发完失效 | `repeat` 字段，到期自动滚到下一个月/周/日 |

## 分层

```
core/
├── main.js              启动器：拉起各组件、心跳、优雅退出
├── router.js            ★ 唯一消息入口：目录 → 规划 → 工具 → 作答 → 执行
├── inbox.js             从飞书拉消息，交给 router
├── store.js             存储适配层（全部转 SQLite）
└── handlers/
    ├── index.js         聚合出口
    └── actions.js       五个执行器：remind / note / campaign / product / forget

fallback/
└── rules.js             降级规则（AI 不可用时，也用工具查表）

src/
├── db.js                ★ 唯一碰数据库的地方（SQLite 3.53 + FTS5）
├── cache.js             读表缓存（TTL）
├── catalog.js           ★ 数据目录：给模型看的「有什么数据」说明书
├── tools.js             ★ 数据工具：模型按需调用的读表入口
├── memory.js            ★ 产品档案 + 广告活动归属
├── data.js              唯一读飞书表格处（列位置/序列号转日期/分产品线）
├── analyze.js           分析：操作 / 变化 / 周报 / 库存 / 库龄
├── answer.js            排版：把分析结果拼成消息
├── scheduler.js         到期投递（增量扫描、补发合并、防重复）
├── repeat.js            循环规则
├── listener.js          实时事件监听
├── llm.js               大模型调用（含两段式 plan + 429 退避重试）
├── summary.js           每日总结
├── lark.js              lark-cli 封装
├── heartbeat.js         心跳与健康检查
├── web.js               控制台 API
├── parse.js             时间解析（网页预览用）
├── config.js / util.js  配置与日志
```

## 消息流转（详细）

```
飞书消息
   ↓
src/listener.js   事件流长连接（120 秒窗口，退出即重开）
   或 core/inbox.js 轮询（120 秒一次，兜底）
   ↓ 去重：seen_messages 表
core/router.js
   ├─ ①+③ 单次调用  llm.act()
   │    一次请求里模型要么直接给最终 JSON，要么调工具
   │    · 直接给 JSON → 执行动作、回消息（**只花 1 次模型请求**）
   │    · 调了工具   → 读表后追加 1 次作答（2 次请求）
   │    · 答不上来   → 返回 null，退回下面的两段式
   │
   ├─ ① 规划（兜底路径）  llm.plan()
   │    输入：用户消息 + catalog.build()（目录）+ 工具 schema
   │    输出：原生 tool_calls / <tool_call> 文本 / JSON
   │    失败（限流/超时）→ localPlan() 本地关键词兜底
   ├─ ② 执行  tools.run(plan.tools)
   │    只读需要的那部分，结果拼成 facts
   └─ ③ 作答  llm.chat()
        输入：消息 + 目录 + 今天对话 + facts
        输出：{intent, reply, actions}
   ↓
core/handlers/actions.js
   ├─ remind   → tasks 表（**只准点** advance=[0]；带 repeat 的建**一条**永久循环任务）
   ├─ note     → notes 表（尽量挂到 product_id）
   ├─ campaign → campaigns 表（自动归属 product_id）
   ├─ product  → products 表
   └─ forget   → 删除任务
   ↓
回复飞书 + 写入 turns 表
```

**失败处理**：AI 规划失败 → 本地规则兜底（照样读表，不编数据）；
AI 作答失败 → 降级到 `fallback/rules.js`；
规则也拿不准 → 进 `queue` 表重试（最多 3 次，超过 6 小时也丢弃）。
读表失败 → **抛错，不返回空数组**（见下）。

## 为什么这样设计

### 为什么不再预读整表

旧版每条消息都读 3 个 sheet × 日运营 + 3 × 周报 + 1 × 库龄 ≈ 13 次 lark-cli 子进程。
实际一次对话通常只问一件事（毛利率、库龄、广告操作），大部分数据读了就丢。

现在改成「目录 + 按需」：
- 目录是缓存的（10 分钟），只依赖表结构和最新日期，不随提问变化；
- 模型看到目录后自己判断读哪个工具，最多 3 个；
- 工具输出控制在 2400 字以内，只返回回答需要的那部分。

### 为什么任务库用 SQLite，不用向量库

「哪些任务现在该发」是**精确的时间区间查询**（`earliest_ms <= now`），
向量相似度做不了这件事 —— 它没有「顺序」和「区间」的语义。

所以：
- **时间维度**用 B 树索引（`ix_tasks_due`），扫描成本只跟到期条数有关；
- **语义维度**（「我上次说的那个白色款型号的提醒」）用 FTS5 全文检索，
  中文做二元分词，`db.search()` 是唯一入口。

将来如果要换 embedding，只需替换 `db.search()` 这一个函数，
调度和存储完全不受影响。这就是把两种检索分开的原因。

### 为什么广告活动必须归属产品

活动名形如 `ACME-SP-101白色-auto紧密-20261012`，里面藏着：
- 产品线代号
- 编码（`101`）
- 颜色（`白色`）
- 装数（`2P` = 2个装）
- 广告类型（`SP`/`auto`/`广泛`）

`memory.parseCampaignName()` 把这些拆出来，再和 `products` 表比对打分。
分数不够（<40）就**不猜**，显式记成「未归属」，等人工或 AI 补。

## 数据文件

| 文件 | 内容 |
|---|---|
| `data/bridge.db` | ★ 唯一状态源：tasks / products / campaigns / notes / turns / queue / seen / kv / FTS |
| `data/heartbeat.json` | 心跳（每分钟更新） |
| `data/daily/summaries/*.md` | 每日总结正文（人读） |
| `data/spool/` | 待 DSH 处理的 job 文件（dshHook 未配置时仅留档） |
| `data/_archive/` | 旧 JSON 归档（迁移后保留，确认无误可删） |

## 常用命令

```powershell
node tools/entity-cli.js stats            # 库内统计
node tools/entity-cli.js products         # 产品清单
node tools/entity-cli.js product 101      # 查某个产品（含活动、笔记、提醒）
node tools/entity-cli.js campaigns        # 活动及其归属产品
node tools/entity-cli.js assign "活动名" "产品名"   # 手动归属
node tools/entity-cli.js tasks            # 待发提醒
node tools/entity-cli.js due              # 当前该发的
node tools/entity-cli.js search "白色101"  # 全文检索
node tools/entity-cli.js catalog          # 打印给模型看的目录
```

## 大模型

`config.local.json` 的 `llm` 段（任何 OpenAI 兼容接口；密钥只在本机，不进仓库）：

```json
"llm": {
  "baseUrl": "https://api.example-provider.com/v1",
  "apiKey": "sk-...",
  "model": "deepseek-v4-flash-0731",
  "maxTokens": 16000,
  "temperature": 0.3,
  "timeoutMs": 120000,
  "retries": 2
}
```

> 这是**推理模型**：先输出 `reasoning_content` 再输出 `content`。
> `maxTokens` 必须给足（16000），否则推理阶段吃光 token，正文为空。
> 上游渠道有 429 限流，`retries` 做指数退避重试。

## 关机与补发

**当前策略：只准点发一次**（`advanceMinutes: [0]`、`onlyOnTime: true`）。

| 情况 | 行为 |
|---|---|
| 准点前后正常触发 | 发一条 |
| 任务到期 ≤ 180 分钟（睡过/关机） | 补发，标注「补发 · 已过期约 X 分钟」 |
| 任务到期 > 180 分钟 | 只标记 skipped，不补发 |
| 多档位同时到期 | 合并成一条（历史上用过提前档时的逻辑，现在只有一档） |

发送前在 `task.firing` 占位，成功后移到 `task.fired`。
`firing` 卡住超过 5 分钟自动清理重试。

### 为什么改成只准点（2026-10-30）

原来默认 `[1440, 120, 0]`（提前1天/2小时/准点）。问题：

1. 提前档迟到会被误报成「已过期」（见下）
2. 一条提醒连发 3 次，噪音大
3. 电脑睡眠时提前档容易堆积，醒来连发

老板要求「以后都准点发」，因此：

| 位置 | 改动 |
|---|---|
| `config.js` / `config.json` | `advanceMinutes: [0]`、新增 `onlyOnTime: true` |
| `router.js` 提示词 | 明确「advance 一律 [0]，不要提前」 |
| `actions.js` `doRemind` | `onlyOnTime` 为真时**忽略模型给的提前档**，强制 `[0]` |
| 已有任务 | `node tools/only-on-time.js` 把 13 条收敛成 `[0]` |

最后一行是双保险：即使模型按旧习惯给了 `[1440,120,0]`，落库时仍会被收敛成准点。

> 想恢复提前提醒：把 `config.json` 的 `advanceMinutes` 改回 `[1440,120,0]`
> 并设 `onlyOnTime: false`。

### ⚠ 「档位迟到」不等于「任务过期」

这是最容易搞错的一处。两个时间概念必须分开：

| 概念 | 含义 | 措辞 |
|---|---|---|
| **档位迟到** `lateMinutes` | 「提前 2 小时」这档该 08:00 发，09:00 才发 | 【提醒 · 还剩 X】 |
| **任务过期** `overdueMin` | 任务到期时间（10:00）已过去 | 【补发 · 已过期约 X】 |

**真实事故（2026-10-30）**：任务 10:00 到期，08:54 收到「【补发 · 已过期约 46 分钟】」。

- 提前 2 小时档应在 08:00 触发
- 电脑睡眠导致 tick 停摆，08:16 醒来才发
- 这一档迟到 → 被旧代码误报成「任务已过期」

实际情况是任务**还剩 1 小时**才到期。

修复后 `buildMessage(task, advMin, lateMinutes, nowMs)` 的判断顺序：

```
overdueMin >= 1           → 【补发 · 已过期约 X】   （真过期）
lateMin >= 1 && 未到期     → 【提醒 · 还剩 X】        （只是这档晚了）
advMin > 0                → 【提醒 · 还有 X 分钟】    （正常提前档）
否则                       → 【提醒 · 现在】
```

取整也修正：提前 1 分钟用 `floor`（不能算成已过期），剩余时间用 `ceil`（不能说「还剩 0 分钟」）。

验证：`node tools/test-message-header.js`（12 个边界用例）。
诊断当前状态：`node tools/diag-advance.js`。

### 电脑休眠

进程被系统冻结时不报错，醒来继续跑。表现：日志里 tick 有长时间空档，
醒来后一次性发出多条补发。

现在 `runTick` 记录 `lastTickMs`，间隔 ≥10 分钟打警告：

```
[WARN] tick 间隔 720 分钟 —— 电脑可能休眠过（上次 tick 2026/10/29 20:59:17）
```

这不是 bug，是环境行为。想唤醒后立刻补发就调大 `catchUpGraceMinutes`。

## 循环提醒

任务带 `repeat` 字段，**一条任务**发完后自动滚到下一次并清空 `fired`：

```json
"repeat": { "kind": "monthly", "day": 6, "hour": 16, "minute": 0 }
```

| kind | 字段 |
|---|---|
| `daily` | `hour`、`minute` |
| `weekly` | `weekday`(0-6)、`hour`、`minute` |
| `monthly` | `day`(1-31)、`hour`、`minute` |

「每月6/16/26号」这种多日循环，是**每个固定日一条 monthly 任务**，
各自独立滚动，永久有效。

> ⚠ 两个已经踩过的坑，改这块前务必读：
>
> **① `due` 和 `dueMs` 必须一起改。**
> 调度器只认 `dueMs`（B 树索引 `ix_tasks_due`）。旧版 `rollForward()` 只改 `due`
> 不改 `dueMs`，任务于是「明明已经推到下个月，每个 tick 仍被判为到期」——
> 循环提醒变成每 20 秒刷一条。现在 `rollForward()` 同时写两个字段，
> `db.patchTask()` 也会强制二者一致，`rowToTask()` 以 `due` 字符串为准纠偏。
>
> **② 循环任务不再展开成 N 条一次性任务。**
> 旧版 `doRemind()` 会把「每月6号」展开成 6 条 `repeat=null` 的任务，
> 发完 6 次就永久失效，而且和滚动逻辑重复。现在只建 1 条带 `repeat` 的任务。
>
> **③ 月末不溢出。** `monthly` 的 31 号遇到 2 月会收敛到当月最后一天；
> 旧实现用 `Date` 直接 setDate(31) 会溢出到 3/3，整月漏发。

## 数据读取的三个硬约束

| 约束 | 原因 |
|---|---|
| **读表失败必须抛错** | 旧 `readRange()` 吞掉异常返回空数组，上层把「没读到」当成「表里没有」，会回答「周报里没有带腿高架的数据」——数据明明在，只是这次没读到。现在抛错，工具输出「读取失败：…」，模型如实说明 |
| **目录构建不读表** | 目录里的「数据覆盖到哪天」用 `cache.staleWhileRevalidate()`：先返旧值，后台刷新。日运营 3 个 sheet ≈ 1.8 秒，不能挡在每条消息前面 |
| **缓存 TTL 必须生效** | 旧 `cached()` 命中时写死比 `DEFAULT_TTL`，给目录传的 10 分钟实际 2 分钟就过期，每条消息都重读整表 |

## 大模型调用的两个调整

**① 单次调用（agent 模式）**：`llm.act()` 一次请求里要么直接给最终 JSON，
要么调工具。对「你好」「提醒我…」这类不用读表的消息，模型请求数从 2 降到 1。
上游按请求数限流，这一项直接把 429 概率砍半。
任何一步不符合预期就返回 `null`，router 自动退回两段式，不影响原有流程。

**② `reasoning_effort: "low"`**：同一条规划问题实测
默认档位 68 秒 → low 档 10 秒；作答 139 秒 → 29 秒，而工具调用与结论完全一致。
`minimal` 在这个渠道会让模型输出空内容，所以最低只到 `low`。
设为 `""` 则不下发该参数。

## 单实例

`core/main.js` 用 `O_EXCL` 原子创建 `data/bridge.pid`：

- 创建成功 → 本进程是唯一实例
- 已存在且 pid 还活着 → 直接退出
- 已存在但 pid 已死（上次崩溃）→ 接管

启动前还会探一次 `webPort`，端口被占只跳过控制台，其余功能照常。
（旧实现是「先检查、后写 pid」，两次几乎同时的启动都能通过检查，
实测真的起过两个进程：第二个控制台 EADDRINUSE、事件流被抢。）

## 启动 / 停止

**推荐：Windows 计划任务**

```powershell
Start-ScheduledTask -TaskName "feishu-bridge"      # 启动
(Get-ScheduledTask -TaskName "feishu-bridge").State # 查状态
Stop-ScheduledTask  -TaskName "feishu-bridge"      # 停止
```

计划任务配置：`AtLogOn` 触发、执行 `wscript start-hidden.vbs`、
`ExecutionTimeLimit=0`（不超时）、失败后 1 分钟重启（最多 3 次）。

> ⚠ **为什么不用「在终端里 `wscript start-hidden.vbs`」**
>
> `wscript` 就算不阻塞，拉起的进程仍然是**当前终端的子进程**。
> 终端一退出（或自动化工具的一次命令调用结束），整棵进程树被回收，
> 桥接进程跟着死 —— 而且没有任何日志，因为它是被强杀的。
> 表现就是「刚启动好好的，过一会儿心跳就停了」。
>
> 计划任务拉起的进程父级是 `svchost`，与终端彻底解耦。
> 实测：计划任务启动后连续 4 分钟、跨多次外部命令，进程仍在、心跳正常推进。

前台调试：`npm start`（Ctrl+C 退出）。
dry-run（不监听飞书、不发消息）：`$env:BRIDGE_DRY='1'; node core/main.js`

停止（不论怎么启动的）：

```powershell
Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
  Where-Object { $_.CommandLine -like "*core/main.js*" } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
```

## 控制台

**http://127.0.0.1:4599**

额外接口：
- `GET /api/catalog` — 模型看到的数据目录
- `GET /api/search?q=` — 全文检索
- `POST /api/tool` — 手动跑一个工具
- `POST /api/assign` — 手动归属广告活动

## 两段式回复（先回执，再干活）

收到消息后**立刻**回一句，再去查数据/建提醒，完成后再发结果。

```
飞书消息
   ↓
① 回执（锁外，纯本地）
   「收到，我去查库龄表…」        ← 实测 1.2 秒内送达
   ↓
② 干活（锁内，串行）
   规划 → 读表 → 作答 → 执行动作
    ↓
③ 结果
   「已超 180 天合计 1350 件：…」  ← 5~20 秒后
```

### 为什么回执不用 LLM

「立刻」是唯一要求。`src/ack.js` 用本地关键词表判断该说什么：

| 你说 | 回执 |
|---|---|
| 提醒我… | 收到，正在建提醒… |
| 库龄压力大不大 | 收到，我去查库龄表… |
| 带腿高架毛利率多少 | 收到，我去查周报… |
| 现在记录了哪些广告活动 | 收到，我去看广告记录… |
| 你好 | 收到… |

零网络、零模型调用。回执总耗时 = 发现延迟 + 发送耗时，其中发送约 1.1 秒
（进程启动 70ms + 飞书 API 往返），**发现延迟才是决定性的**（见下）。

### 关键：回执必须在锁外

`inbox.ingest()` 分两段：

1. **收下 + 回执** —— 在 `withLock()` 之外。如果上一条消息正在跑 LLM（可能 20 秒），
   新消息的回执若也去抢锁，老板就要干等 20 秒才看到「收到」，那就失去意义了。
2. **干活** —— 在锁内串行，保证上下文不错乱、动作不重复。

实测：第一条消息处理到第 1 秒时第二条到达，第二条回执在 **+1012ms** 就发出，没有排队。

### 秒级回执的真正瓶颈：不是发送，是发现

实测（2026-10-29）：

| 环节 | 耗时 | 说明 |
|---|---|---|
| lark-cli 进程启动 | 66–84ms | 可忽略 |
| 发送一条消息（API 往返） | 1065–1153ms | 飞书服务端投递，基本是下限 |
| **旧版「发现消息」延迟** | **60–200 秒** | ← 真正的瓶颈 |
| 新版「发现消息」延迟 | **约 178ms** | |

**原因**：旧 `listener.js` 用 `--output-dir` 把事件写成文件，
`_drain()` 只在子进程 `close` 时才执行 —— 而窗口是 120 秒。
消息其实**早已到达**，却要等窗口结束才被读走。

**修法**：改成读 `lark-cli event consume` 的 **stdout（NDJSON 流）**，
一行一个事件，到一行就立刻 ingest。窗口仍保留（定期自我重启），但不再影响投递。

实测同一条消息：

```
旧：in 09:03:18  ack 发现→送达 = 200937ms
新：in 09:08:24  ack 发现→送达 =   1331ms   （发现 178ms + 发送 1153ms）
```

**轮询兜底也改成自适应**（`main.pollDelay()`）：

| listener 状态 | 轮询间隔 |
|---|---|
| 未 ready / 超过 3 分钟没收到事件 | **5 秒**（接替实时接收） |
| ready 且近期有事件 | 120 秒（纯保险，省 API 调用） |

这样即使 `lark-cli` 事件流哪天彻底坏掉，消息也不会延迟 2 分钟才被发现。

### 回执不会被当成新消息

飞书返回的消息里，机器人自己的 `sender.sender_type` 是 `app`，真人是 `user`。
`inbox` 只认 `user`，`app` 的直接 `claim` 掉。实测确认过两类能正确区分。

### 关掉

`config.json` 里 `"instantReply": false` 就只回最终结果。

## 去重（为什么一条消息只会回一次）

消息有两个来源，必须保证它们不会各自处理一遍：

1. **事件流**（`src/listener.js`）——120 秒窗口长连接，退出即重开
2. **定时轮询**（`core/inbox.js` `pollOnce`）——120 秒一次，兜底

修复前的问题（实测日志）：

```
15:20:43 in: 现在记录了哪些广告活动了呀     ← listener
15:20:46 in: 现在记录了哪些广告活动了呀     ← poller（同一条）
15:21:07 out: sent=true
15:21:11 out: sent=true                    ← 回了两遍
```

原因是 `markSeen` 写在**处理之后**：listener 正在跑 LLM（4~20 秒），
poller 此时查库发现"没见过"，于是也处理了一遍。

现在有三道闸：

| 闸 | 位置 | 作用 |
|---|---|---|
| 原子认领 | `db.claim()` | `INSERT OR IGNORE` 的 changes 决定谁处理；**在处理之前**调用，跨进程也只有一个赢家 |
| 进程内串行锁 | `inbox.withLock()` | 同一时刻只处理一批，防止两路交错 |
| 轮询避让 | `pollOnce()` 检查 `busy` | 事件流正在处理时跳过这轮轮询 |

`claim()` 同时用于丢弃机器人自己发的消息和空消息，避免它们被反复拉到。

### 第二种重复：重试会把动作再跑一遍

`send-failed` 入队时，**回复已生成、任务已建好**。
修复前重试走 `handleAndSend` 整条重跑 → 任务被建第二遍 → 可能再发一条。

现在按 `reason` 分流：

| reason | 重试行为 |
|---|---|
| `send-failed` | 只调 `router.resend()` 补发那条 reply，**不重跑动作** |
| `handle-failed` / `deferred` | 还没有副作用，整条重跑 |

### 验证

```powershell
node tools/test-dedupe.js     # 并发认领、重复轮询、批量顺序
```

## 子进程清理

`src/lark.js` 会跟踪所有起过的 lark-cli 子进程，`shutdown` 时统一 `killAll()`。
不清理的话，每次重启都会留下孤儿进程（实测累积成一片 node.exe，还会占住 4599 端口）。

启动前建议确认没有残留：

```powershell
Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
  Select-Object ProcessId, CommandLine
```

## 已知限制

- **应用身份读不到文档**：`sheets:spreadsheet:read`、`wiki:node:read` 只在你个人的 user token 上。
- **user token 会过期**：refresh token 7 天有效，过期需重新扫码授权。
  过期后读表会**明确报错**（不再假装「表里没有数据」）。
- **上游模型不稳定**：部分渠道有 429 限流；规划失败会自动走本地兜底，但生成质量会下降。
  已经用「单次调用」和 `reasoning_effort: low` 把请求数和单次耗时都压下来了。
- **月度成本表未接入**：问成本结构时会明确回答「表里没有」。

## 已经修掉的坑（别再改回去）

| 位置 | 坑 | 后果 |
|---|---|---|
| `repeat.js` `rollForward` | 只改 `due` 不改 `dueMs` | 循环提醒每 20 秒重复补发，直到刷屏 |
| `handlers/actions.js` `doRemind` | 循环规则展开成 6 条一次性任务 | 发完 6 次永久失效 |
| `repeat.js` `monthly` | 31 号用 `setDate(31)` 溢出 | 2 月漏发，推到 3/3 |
| `cache.js` `cached` | 命中时用写死的 TTL | 10 分钟的目录 2 分钟就失效，每条消息重读整表 |
| `config.js` | 浅合并覆盖整个 `llm` 段 | `retries`/`timeoutMs` 丢失 |
| `tools.js` | 收下 `series` 却在返回时丢掉 | 问「带腿高架毛利」拿到三条线混算的数 |
| `data.js` `readRange` | 吞异常返回空 | 读表失败被当成「表里没有数据」 |
| `listener.js` | 只取 `sender_type` 不取 `chat_id` | 群里说话也回私聊 |
| `web.js` `snapshot` | 没返回 `feed`/`review`/`instructions` | 控制台三个区块永远是空的 |
| `db.stats` | `listNotes(100000)` 全表读 | 控制台每 15 秒全表扫描一次 |
| `main.js` | 先检查 pid 再写 pid | 并发启动会起两个实例 |
| `util.js` `log` | 无轮转 | 日志无限增长（listener 每 2 分钟一行） |
| `inbox.js` | 重试队列只看 attempts | 发不出去的消息永久占队列 |
| `scheduler.js` | 发送失败每个 tick 都重试 | 每 20 秒锤一次 lark-cli |
| `catalog.js` | 整段目录（含「待发 27 条」）缓存 10 分钟 | 新建提醒后模型仍看到旧条数，据此答错 |
| `data.js` | 日运营只读 `A1:Z240` | 方形花床已用 145 行，几个月后历史被静默截断 |
| `llm.js` | 无熔断 | 上游限流时每条消息都等满 120 秒超时 |
| `lark.js` | 补发没有幂等键 | 「其实已送达但读超时」会导致老板收到两条一样 |
| `inbox.js` `retryFailed` | 不在串行锁内 | 重试与 listener 处理交错，上下文串味 |
| `catalog.js` `warmCoverage` | 缓存的 key 与数据层不一致 | 预热形同虚设，每题仍重读整表 |
| `router.js` 提示词 | 从没告诉模型它能删提醒 | 模型回「我没有删除权限，你自己去删」，一条没删，重复提醒继续发 |
| `router.js` `finish` | 回复直接用模型的话 | 模型删了 6 条（含 3 条无关），回复却说「其余提醒都没动」 |
| `actions.js` `doForget` | 关键词走 FTS 模糊、且无上限 | 「BD」命中无关的广告复查任务，一次删掉 6 条 |
| `scheduler.js` `buildMessage` | 把「提前档位迟到」写成「已过期」 | 任务 10:00 到期，08:54 却收到「已过期约 46 分钟」 |
| `scheduler.js` `buildMessage` | 到期差用 `Math.round` | 还差 1 分钟被算成已过期；刚过 30 秒说「还剩 1 分钟」 |

## 删除类动作的三道保护

`forget` 是全项目**唯一不可逆销毁数据**的动作（提醒删了就没了），因此：

| 保护 | 位置 | 作用 |
|---|---|---|
| 单次上限 5 条 | `doForget` | 超过上限**整体拒绝**（不删一半），把命中列表回给老板 |
| 只按「标题包含」匹配 | `doForget` | 不用 FTS 模糊命中，避免「BD」这类短词匹配到无关任务 |
| 用真实结果覆盖模型的话 | `router.withActionFacts` | 成功则逐条列出「实际删了哪几条」；失败明确说「一条都没动」 |

> 这一条是**真实事故**驱动加的：一条「合并这几条」的消息里，模型先说
> 「我没有删除权限」，后来又删了 6 条（其中 3 条无关）并谎称「其余没动」。
> 教训：**凡是模型对「自己做了什么」的陈述，都要用执行结果校验并覆盖。**

## 熔断与可观测性

**熔断**（`src/llm.js`）：连续 3 次调用失败 → 打开 60 秒熔断。
熔断期间 `chat()` 立刻返回失败，router 直接走本地规则（照样读表、不编数字），
不再让老板等满 120 秒超时。冷却结束自动半开重试。

**健康面板**：`GET /api/state` 的 `health` 字段给出
`alive` / `lastHeartbeat` / `llmBreaker` / `queue` / `lastPoll`。
之前控制台只能看「进程在不在」，listener 死了、模型被限流了都看不出来。

## 测试

```powershell
node --test "test/*.test.js"
```

46 个用例，不联网、不写真实库（`BRIDGE_TEST_DB` 指向临时文件）、不写生产日志，约 0.3 秒跑完。
覆盖：循环规则（含月末收敛）、调度滚动/补发窗口/失败退避、删除保护与动作事实校验、回执文案与延迟、
动作创建与判重、缓存 TTL、配置深合并、工具参数过滤与去重、
时间解析、工具 schema、目录实时计数、熔断。
