'use strict';

const { config } = require('./config');

// Deterministic Chinese/English time parsing. No model calls: fast, free, predictable.
// Returns { date: 'YYYY-MM-DD', hour, minute, matched: '...' } or null.

const MONTH_DAY = /(\d{1,2})\s*[月\/\-]\s*(\d{1,2})\s*[日号]?/;
const FULL_DATE = /(\d{4})\s*[年\-\/]\s*(\d{1,2})\s*[月\-\/]\s*(\d{1,2})\s*[日号]?/;
const PERIOD_MID = /(\d{1,2}|[一二三四五六七八九十]{1,3})\s*月\s*中旬/;
const PERIOD_EARLY = /(\d{1,2}|[一二三四五六七八九十]{1,3})\s*月\s*上旬/;
const PERIOD_LATE = /(\d{1,2}|[一二三四五六七八九十]{1,3})\s*月\s*下旬/;
const REL_DAY = /(\d{1,3}|[一二三四五六七八九十]{1,3})\s*(?:天|days?)\s*(?:后|之后|later)/i;
const REL_WEEK = /(\d{1,2}|[一二三四五六七八九十]{1,3}|两)\s*(?:周|星期|week)\s*(?:后|之后|later)/i;
const CN_NUM = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };

// Parse a small number that may be written in Chinese numerals (三, 十五, 二十).
function toInt(s) {
  if (/^\d+$/.test(s)) return parseInt(s, 10);
  if (s === '十') return 10;
  if (/^十[一二三四五六七八九]$/.test(s)) return 10 + CN_NUM[s[1]];
  if (/^[一二三四五六七八九]十$/.test(s)) return CN_NUM[s[0]] * 10;
  if (/^[一二三四五六七八九]十[一二三四五六七八九]$/.test(s)) return CN_NUM[s[0]] * 10 + CN_NUM[s[2]];
  if (s.length === 1 && CN_NUM[s]) return CN_NUM[s];
  // 两 == 2 in casual Chinese
  if (s === '两') return 2;
  return NaN;
}
const WEEKDAY = /(下{0,1})(?:周|星期)([一二三四五六日天])/;
const TODAY = /(今天|今日|today)/i;
const TOMORROW = /(明天|明日|tomorrow)/i;
const DAY_AFTER = /(后天)/;

const TIME_HM = /(\d{1,2})\s*[:：]\s*(\d{2})/;
const TIME_H_CN = /(上午|下午|中午|晚上|早上|凌晨)?\s*(\d{1,2})\s*(?:点|时)\s*(半|(\d{1,2})\s*分)?/;

function pad(n) { return String(n).padStart(2, '0'); }

function fmtDate(d) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function parseTime(text) {
  let hour = null;
  let minute = 0;

  const hm = text.match(TIME_HM);
  if (hm) {
    hour = parseInt(hm[1], 10);
    minute = parseInt(hm[2], 10);
    return hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59 ? { hour, minute } : null;
  }

  const hcn = text.match(TIME_H_CN);
  if (hcn) {
    const marker = hcn[1] || '';
    hour = parseInt(hcn[2], 10);
    if (hcn[3] === '半') minute = 30;
    else if (hcn[4]) minute = parseInt(hcn[4], 10);

    if (/下午|晚上/.test(marker) && hour < 12) hour += 12;
    if (/中午/.test(marker) && hour < 11) hour += 12;
    if (/凌晨/.test(marker) && hour === 12) hour = 0;

    if (hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59) return { hour, minute };
  }

  return null;
}

function parseDate(text, now = new Date()) {
  const y = now.getFullYear();
  let m;

  if ((m = text.match(FULL_DATE))) {
    const date = `${m[1]}-${pad(parseInt(m[2], 10))}-${pad(parseInt(m[3], 10))}`;
    return { date, matched: m[0] };
  }

  if ((m = text.match(PERIOD_EARLY))) {
    const mo = toInt(m[1]);
    if (!Number.isNaN(mo)) return { date: `${y}-${pad(mo)}-05`, matched: m[0] };
  }
  if ((m = text.match(PERIOD_MID))) {
    const mo = toInt(m[1]);
    if (!Number.isNaN(mo)) return { date: `${y}-${pad(mo)}-15`, matched: m[0] };
  }
  if ((m = text.match(PERIOD_LATE))) {
    const mo = toInt(m[1]);
    if (!Number.isNaN(mo)) return { date: `${y}-${pad(mo)}-25`, matched: m[0] };
  }

  if ((m = text.match(MONTH_DAY))) {
    const mo = parseInt(m[1], 10);
    const da = parseInt(m[2], 10);
    if (mo >= 1 && mo <= 12 && da >= 1 && da <= 31) {
      // keep current year; roll to next year if the date already passed by > 30 days
      let dd = new Date(y, mo - 1, da);
      if (isNaN(dd.getTime())) return null;
      const diffDays = (dd - now) / 86400000;
      if (diffDays < -30) dd = new Date(y + 1, mo - 1, da);
      return { date: fmtDate(dd), matched: m[0] };
    }
  }

  if ((m = text.match(DAY_AFTER))) {
    const d = new Date(now); d.setDate(d.getDate() + 2);
    return { date: fmtDate(d), matched: m[0] };
  }
  if ((m = text.match(TOMORROW))) {
    const d = new Date(now); d.setDate(d.getDate() + 1);
    return { date: fmtDate(d), matched: m[0] };
  }
  if ((m = text.match(TODAY))) {
    return { date: fmtDate(now), matched: m[0] };
  }
  if ((m = text.match(REL_DAY))) {
    const n = toInt(m[1]);
    if (!Number.isNaN(n)) {
      const d = new Date(now); d.setDate(d.getDate() + n);
      return { date: fmtDate(d), matched: m[0] };
    }
  }
  if ((m = text.match(REL_WEEK))) {
    const n = toInt(m[1]);
    if (!Number.isNaN(n)) {
      const d = new Date(now); d.setDate(d.getDate() + n * 7);
      return { date: fmtDate(d), matched: m[0] };
    }
  }

  const wd = text.match(WEEKDAY);
  if (wd) {
    const map = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 日: 0, 天: 0 };
    const target = map[wd[2]];
    const d = new Date(now);
    const delta = (target - d.getDay() + 7) % 7;
    d.setDate(d.getDate() + (wd[1] === '下' ? delta + 7 : (delta === 0 ? 7 : delta)));
    return { date: fmtDate(d), matched: wd[0] };
  }

  return null;
}

/**
 * Parse a Feishu message into a reminder candidate.
 * @returns {{title:string,due:string,matchedDate:string,matchedTime:string|null}|null}
 */
function parseMessage(text, now = new Date()) {
  if (!text || typeof text !== 'string') return null;
  const t = text.trim();
  if (!t) return null;

  const d = parseDate(t, now);
  if (!d) return null;

  const tm = parseTime(t);
  const hour = tm ? tm.hour : config.defaultHour;
  const minute = tm ? tm.minute : 0;

  const due = `${d.date}T${pad(hour)}:${pad(minute)}:00+08:00`;

  return {
    title: t.replace(/\s+/g, ' ').slice(0, 120),
    due,
    matchedDate: d.matched,
    matchedTime: tm ? `${pad(hour)}:${pad(minute)}` : null,
    dateOnly: d.date,
  };
}

module.exports = { parseMessage, parseDate, parseTime, fmtDate };
