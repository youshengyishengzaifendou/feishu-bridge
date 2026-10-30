# feishu-bridge

一个**自托管的飞书私人助理**：你在飞书里用大白话发消息，它先判断要不要读数据，再建提醒、答问题、记信息，最后回你。所有状态存在本地 SQLite，不依赖任何第三方服务器。

```
你：提醒我 11月3日 上午10点 查黑五定价
它：已建提醒（11/3 10:00 准点发一次）

你：产品线C是不是在赔钱
它：（读周报表）毛利率 -4%，主要亏在头程。
```

适合谁：想在自己电脑 / 自己服务器上跑一个飞书机器人当工作助手，又不想写一堆对接代码的人。

> ⚠️ 这是一个**项目 / 模板**，不是开箱即用的商业产品。飞书接入、提醒、笔记、对话是通用能力；「读表格答数据」的列语义是**亚马逊电商口径**，换行业需要改一份配置文件（见下文「业务档案」）。

---

## 3 分钟上手

前提：**Node.js ≥ 22.5**（用了内置 SQLite，见 `node --version`）、一个飞书账号、一个任意 OpenAI 兼容的大模型 API Key。

```bash
git clone <本仓库>
cd feishu-bridge
npm install
npm run setup      # 装完直接跑这个向导
```

`npm run setup` 会带着你走完全部配置，你**只需要做两件事**：

1. 在弹出的浏览器 / 飞书里**点一下授权**（创建应用、扫码登录，全程不用手抄任何 App ID / Secret / chatId）
2. **粘贴一次大模型的 API Key**

向导结束会自检并打印启动方式。之后日常就是：

```bash
npm start          # 前台运行，Ctrl+C 退出
```

打开控制台：<http://127.0.0.1:4599>（看任务、日志、健康状态）。

---

## 它是怎么接进飞书的

用官方的 [`lark-cli`](https://www.npmjs.com/package/@larksuite/cli)（飞书开放平台命令行）。`npm run setup` 会自动装它、引导你创建应用、扫码授权。

**为什么还需要你点那两下**：自建应用的凭证是**按租户**签发的——你的飞书企业的应用，别人用不了；而读你个人的飞书表格必须用你本人的授权（应用身份看不到个人资源）。所以「授权」这一步无法替你省，省掉的那是过去要手抄 App ID、Secret、chatId、sheet token 的麻烦。

想彻底免掉这一步，只有把项目做成飞书**商店应用**上架（企业应用 + 多租户改造），本项目没走那条路。

---

## 能力清单

| 你对它说 | 它做什么 |
|---|---|
| 提醒我 X 月 X 日上午 10 点 干某事 | 建提醒（默认只在准点发一次） |
| 每月 6/16/26 号下午 4 点提醒我更新表 | 建一条**永久循环**提醒，发完自动滚到下月 |
| 合并 / 删掉那几条重复提醒 | 真的去删，并把「实际删了哪几条」逐条回报 |
| 这个广告活动是哪个产品的 | 从活动名解析归属（需接入表格） |
| 毛利率多少 / 库龄压力大不大 | 读表、算数、作答（需接入表格） |
| 聊聊今天的安排 | 不读表，直接对话 |

处理节奏：**收到先秒回一句「我去查…」**（本地关键词，不耗模型），真正干活在后台完成后发结果。即时回执可在配置里关。

---

## 业务档案：把它变成「你自己的」

助理「为谁服务、管哪些表、有哪些业务分组」全部写在 `profile.json`，由 `npm run setup` 访谈生成。这份文件**不进 git**，你的业务数据不会泄露。

```jsonc
{
  "name": "小助手",
  "role": "电商店铺「示例店」的运营助理",     // 进 system prompt
  "userLabel": "老板",                          // 它怎么称呼你
  "scope": "只处理三条产品线",                  // 工作范围
  "taboos": ["其他品类"],                       // 它绝不碰的东西
  "series": [                                   // 业务分组（产品线/门店/班级）
    { "key": "产品线A", "aliases": ["A线", "甲"], "desc": "型号 101/102" }
  ],
  "tables": { /* 可选：接入的飞书电子表格 */ }
}
```

**不想接表格也完全能跑**：删掉 `tables`，助理退化成一个纯粹的「提醒 + 笔记 + 对话」助手，功能仍然完整；被问到需要查表的问题时，它会如实说「还没接入数据源」，**绝不编数字**。

配置结构细节见 [`profile.example.json`](profile.example.json) 和 `src/profile.js` 顶部注释。

---

## 常用命令

```bash
npm start                              # 运行
npm run setup                          # 重新配置（改模型 Key / 重新授权 / 改业务档案）
npm test                               # 回归测试（不联网，46 个用例）
npm run dry                            # 只跑调度和控制台，不收发飞书消息（调试用）

node tools/setup-llm.js test           # 单独测大模型连通性
node tools/smoke-test.js "库龄压力大不大" # 单条消息跑一遍完整链路
node tools/entity-cli.js tasks         # 看待发提醒（还有 products/campaigns/catalog/stats）
```

---

## 后台常驻（开机自启 + 崩溃自动重启）

`npm start` 会跟着终端一起退出。要让它一直在后台跑：

**Windows — 计划任务（推荐）**
```powershell
# 注册（管理员一次即可）：登录时自启
schtasks /create /tn feishu-bridge /tr `
  "wscript.exe \"<仓库绝对路径>\start-hidden.vbs\"" `
  /sc onlogon /f

schtasks /run /tn feishu-bridge      # 启动
schtasks /end /tn feishu-bridge      # 停止
```
> 计划任务拉起的进程挂在 `svchost` 下，与终端无关；**别在终端里直接 `wscript start-hidden.vbs`**，那样终端一关进程就被回收。

**Linux / macOS — systemd**
```ini
# ~/.config/systemd/user/feishu-bridge.service
[Service]
WorkingDirectory=/path/to/feishu-bridge
ExecStart=/usr/bin/node core/main.js
Restart=always
[Install]
WantedBy=default.target
```
```bash
systemctl --user enable --now feishu-bridge
```

---

## 配置项

真实配置在 `config.local.json`（`npm run setup` 生成，不进 git）。可缺省，缺省用 `src/config.js` 里的默认值。完整带注释的模板见 [`config.example.json`](config.example.json)。

| 键 | 默认 | 说明 |
|---|---|---|
| `cliPath` | 自动发现 | lark-cli 路径；装了多个 Node 环境、自动发现失败时才手写 |
| `profile` | 空 | lark-cli 的 profile 名；空 = 用其当前默认 |
| `chatId` | 自动绑定 | 机器人对话会话；`setup` 自动抓 |
| `webPort` | 4599 | 控制台端口 |
| `tickMs` / `pollMs` | 20000 / 120000 | 到期检查 / 消息轮询兜底间隔 |
| `advanceMinutes` | `[0]` | 提醒档位；`[0]` = 只准点。想提前提醒改这里 |
| `onlyOnTime` | true | 强制准点，忽略模型给的提前档 |
| `catchUpGraceMinutes` | 180 | 关机再开机，过期多久内还补发 |
| `instantReply` | true | 收到先秒回一句 |
| `llm.reasoningEffort` | `""` | 推理模型思考档（`low`/`medium`/`high`）；普通模型留空 |
| `llm.supportsTools` | true | 渠道是否支持原生 function calling；false 自动回落文本工具调用 |

大模型也可只用 `setup-llm.js` 单独设置：
```bash
node tools/setup-llm.js set https://api.deepseek.com deepseek-chat
# 然后粘贴 sk-xxx 回车
```

---

## 架构

想了解「为什么这么设计」，读 [`ARCHITECTURE.md`](ARCHITECTURE.md)——那里有消息如何流转、为什么用 SQLite 而不是向量库、限流下怎么降级、以及踩过的坑。

```
core/      main.js 启动 · router.js 唯一消息入口 · inbox.js 接入去重 · store.js 存储适配
src/       db.js(SQLite+FTS5) · catalog.js(数据目录) · tools.js(读表工具) · llm.js(模型/熔断) · profile.js(业务档案)
fallback/  rules.js（AI 不可用时的关键词降级）
web/       控制台前端
```

---

## 已知限制

- **应用身份读不到个人文档**：读你的表格用的是你本人的 user token。refresh token 约 7 天有效，过期后读表会明确报「读取失败」，不会假装表里没数据。重新授权：`npm run setup` 或直接 `lark-cli auth login`。
- **机器人权限**：新创建的应用可能缺发消息的 scope。`setup` 会尽量自动开通，缺的话会打印开发者后台链接让你点一下。
- **列语义是电商口径**：`weekly` / `aging` 的列（毛利、佣金、库龄分档）是为亚马逊运营定的。别的行业要么改 `columns` 对上自己的表，要么不接表只用提醒功能。
- **上游模型可能限流**：部分渠道有 429。规划失败走本地关键词兜底（照样读表、不编数字），但措辞质量下降；连续失败会熔断，冷却期内秒回兜底。

## 安全提醒

- **这是私人助手**。把机器人拉进群或允许他人对话，等于把你的飞书权限和你的表格暴露给他们。请只与它单聊。
- 密钥、业务数据只落在 `config.local.json` / `profile.json` / `data/`，这些都被 gitignore。提交前可自查：`git status` 不应列出这三个文件。
- 若你曾把带密钥的 `config.json` 提交过，即使删了也在 git 历史里——请去服务商后台**轮换**那把 Key。

## 许可

MIT
