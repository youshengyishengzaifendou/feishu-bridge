'use strict';

/**
 * 降级规则 —— 只在 AI 不可用时使用
 *
 * 用最简单的关键词判断，只做有把握的事：
 *   · 简单查询 → 调工具查表回答（走 tools.js，不自己读表）
 *   · 简短提醒 → 建提醒
 *   · 复杂消息 → defer，交给重试队列
 */

const { log } = require('../src/util');
const { parseMessage } = require('../src/parse');
const tools = require('../src/tools');
const actions = require('../core/handlers/actions');
const profile = require('../src/profile');

const LONG_MESSAGE = 60;
const MULTI_INTENT = /另外|还有|以及|同时|顺便|再提醒|也再|并且|然后|记录一下/;

function dueText(dueStr) {
  const t = Date.parse(dueStr);
  if (Number.isNaN(t)) return dueStr;
  const d = new Date(t);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getMonth() + 1}月${d.getDate()}日 ${p(d.getHours())}:${p(d.getMinutes())}`;
}

const QUERY_WORDS = /多少|几|怎么样|如何|什么时[候间]|还剩|剩余|有没有|是否|概览|概况|情况|现状|告诉我|查一下|看看|列出|有哪些|变化|变动/;
const REMIND_WORDS = /提醒我|记得提醒|别忘了|到点提醒|帮我提醒|定时提醒/;
const ANA_WORDS = /分析|读取|汇总|统计|整理|评估/;

/** 数据词 = 通用词 + 业务档案里的分组名（不再写死店铺词）。 */
function dataWords() {
  const generic = /周报|月报|日运营|库龄|广告|数据|报表/;
  const names = profile.seriesKeys().map((k) => k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  return names.length ? new RegExp(`${generic.source}|${names.join('|')}`) : generic;
}

function guessSeries(t) {
  return profile.normSeries(t) || undefined;
}

/** 用规则把一句话映射成工具调用（表类工具只在 profile 配了表时才选）。 */
function guessTools(t) {
  const data = require('../src/data');
  const has = {
    aging: data.hasTable('aging'),
    weekly: data.hasTable('weekly'),
    daily: data.hasTable('daily'),
  };
  const series = guessSeries(t);
  const calls = [];

  if (/库龄|超龄|180/.test(t) && has.aging) calls.push({ name: 'aging', args: {} });
  else if (/周报|周度|weekly|毛利|利润|销售额|销量/i.test(t) && has.weekly) calls.push({ name: 'weekly', args: { series } });
  else if (/概览|概况|总览/.test(t)) {
    if (has.aging) calls.push({ name: 'aging', args: {} });
    if (has.weekly) calls.push({ name: 'weekly', args: {} });
  }
  else if (/变化|变动|对比/.test(t) && has.daily) calls.push({ name: 'changes', args: { series } });
  else if (/广告|竞价|投放|ACOS|CPC/i.test(t) && has.daily) calls.push({ name: 'ops', args: { days: 7, kind: '广告' } });
  else if (/库存|无库存|断货|还剩|剩多少/.test(t) && has.daily) calls.push({ name: 'stock', args: { series } });
  else if (has.daily) calls.push({ name: 'ops', args: { days: 7 } });

  return calls;
}

/**
 * 用规则处理一条消息。
 * @returns {{reply?:string, defer?:boolean, reason?:string}}
 */
function handle(text) {
  const t = String(text || '').trim();
  if (!t) return { defer: true, reason: '空消息' };

  // 询问已有提醒：直接查库，不需要模型
  if (/哪些提醒|有什么提醒|待发提醒|提醒列表/.test(t)) {
    const r = tools.run([{ name: 'task', args: { limit: 20 } }]);
    return { reply: r.facts || '没有待发提醒。' };
  }

  // 复杂消息一律不猜
  if (t.length > LONG_MESSAGE || MULTI_INTENT.test(t)) {
    log('INFO', `rules: defer complex (len=${t.length})`);
    return { defer: true, reason: '消息较复杂，等 AI 处理' };
  }

  // 查询
  const isQuery = QUERY_WORDS.test(t) || (ANA_WORDS.test(t) && dataWords().test(t));
  if (isQuery) {
    try {
      const r = tools.run(guessTools(t));
      if (r.facts) return { reply: `（AI 未就绪，以下是直接读表结果）\n\n${r.facts}` };
      return { defer: true, reason: '没有读到数据' };
    } catch (e) {
      return { defer: true, reason: `查询失败: ${e.message}` };
    }
  }

  // 提醒
  if (REMIND_WORDS.test(t) || /\d{1,2}\s*[月日点时]/.test(t)) {
    const p = parseMessage(t);
    if (!p) return { reply: `想建提醒但没认出时间：\n${t}\n\n补上日期即可。` };
    if (p.title.length > 40) return { defer: true, reason: '标题过长，等 AI' };

    const r = actions.doRemind({ title: p.title, due: p.due, note: '规则降级创建' }, null);
    if (!r.ok) return { defer: true, reason: r.error };
    if (r.duplicate) return { reply: `已有类似提醒：\n${r.title}\n${dueText(r.due)}` };
    return { reply: `已建提醒\n${r.title}\n${dueText(r.due)}` };
  }

  return { defer: true, reason: '规则无法判断' };
}

module.exports = { handle, LONG_MESSAGE, MULTI_INTENT };
