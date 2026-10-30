'use strict';

/* 飞书提醒控制台 · 前端
   数据全部来自 /api，真实读写。 */

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));

const WEEK = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
const pad = (n) => String(n).padStart(2, '0');

const state = { data: null, filter: 'open', timer: null };

function repeatLabel(r) {
  if (!r) return '';
  if (r.kind === 'weekly') {
    const W = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
    return `${W[r.weekday] || ''} ${pad(r.hour)}:${pad(r.minute || 0)} 循环`;
  }
  if (r.kind === 'monthly') return `每月 ${r.day} 号 ${pad(r.hour)}:${pad(r.minute || 0)} 循环`;
  if (r.kind === 'daily') return `每天 ${pad(r.hour)}:${pad(r.minute || 0)} 循环`;
  return '';
}

const fmtDate = (ms) => { const d = new Date(ms); return `${d.getMonth() + 1}月${d.getDate()}日`; };
const fmtTime = (ms) => { const d = new Date(ms); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };

function rel(ms) {
  const abs = Math.abs(ms);
  const mins = Math.round(abs / 60000);
  if (mins < 1) return '现在';
  if (mins < 60) return `${mins} 分钟`;
  const h = Math.floor(mins / 60), rm = mins % 60;
  if (h < 24) return rm ? `${h} 小时 ${rm} 分` : `${h} 小时`;
  const d = Math.floor(h / 24), rh = h % 24;
  return rh ? `${d} 天 ${rh} 小时` : `${d} 天`;
}

function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.add('is-on');
  clearTimeout(el._t);
  el._t = setTimeout(() => el.classList.remove('is-on'), 2400);
}

async function api(path, opts = {}) {
  const res = await fetch(path, { headers: { 'content-type': 'application/json' }, ...opts });
  let data = null;
  try { data = await res.json(); } catch (_) {}
  if (!res.ok) throw new Error((data && data.error) || `HTTP ${res.status}`);
  return data;
}

/* ---------- 渲染 ---------- */

function render() {
  const d = state.data;
  if (!d) return;

  renderService(d.service);
  renderClock(d);
  renderNext(d);
  renderCounts(d);
  renderRailFoot(d);
  renderTimeline(d);
  renderTasks(d);
  renderFeed(d);
  renderInstructions(d);
  renderReview(d);

  // 秒针式的心跳感：让「下一条」的倒计时和时钟有轻微视觉反馈
  const nextEl = $('#next-box');
  if (nextEl && !nextEl.hidden) {
    nextEl.classList.remove('is-tick');
    void nextEl.offsetWidth;
    nextEl.classList.add('is-tick');
  }
}

function renderService(s) {
  const box = $('#service-status');
  box.dataset.state = s.running ? 'up' : 'down';
  $('#service-text').textContent = s.running ? '运行中' : '已停止';
}

function renderClock(d) {
  const now = new Date();
  const t = `${pad(now.getHours())}:${pad(now.getMinutes())}`;
  const el = $('#clock-time');
  const changed = el.textContent !== t;
  el.textContent = t;
  if (changed) {
    el.classList.remove('is-beat');
    void el.offsetWidth;
    el.classList.add('is-beat');
  }
  $('#clock-date').textContent = `${now.getFullYear()}年${now.getMonth() + 1}月${now.getDate()}日 ${WEEK[now.getDay()]}`;
}

function renderNext(d) {
  const open = d.tasks.filter((t) => !t.done && t.dueMs !== null);
  const nxt = open.sort((a, b) => a.dueMs - b.dueMs)[0];

  const box = $('#next-box');
  if (!nxt) {
    box.hidden = true;
    return;
  }
  box.hidden = false;
  $('#next-title').textContent = nxt.title;

  const diff = nxt.dueMs - d.now;
  const when = diff >= 0 ? `还有 ${rel(diff)}` : `已过期 ${rel(diff)}`;
  $('#next-when').textContent = `${fmtDate(nxt.dueMs)} ${fmtTime(nxt.dueMs)} · ${when}`;
}

function renderCounts(d) {
  const open = d.tasks.filter((t) => !t.done);
  $('#c-open').textContent = open.length;
  $('#c-soon').textContent = open.filter((t) => t.status === 'soon').length;
  $('#c-overdue').textContent = open.filter((t) => t.status === 'overdue').length;
  $('#c-done').textContent = d.tasks.filter((t) => t.done).length;
}

function renderRailFoot(d) {
  $('#h-seen').textContent = String(d.stats.seenMessages);
  $('#h-lastpoll').textContent = d.stats.lastPoll ? fmtTime(Date.parse(d.stats.lastPoll)) : '—';
  $('#h-tick').textContent = `${Math.round(d.service.tickMs / 1000)} 秒`;
}

/* 时间轴：从今天 0 点到后天 0 点，共 48 小时 */

function renderTimeline(d) {
  const start = new Date(d.now);
  start.setHours(0, 0, 0, 0);
  const t0 = start.getTime();
  const SPAN = 48 * 3600 * 1000;

  // 小时刻度：每 4 小时一个
  const hours = $('#tl-hours');
  hours.innerHTML = '';
  for (let i = 0; i < 12; i++) {
    const s = document.createElement('span');
    const h = (i * 4) % 24;
    // 用「点」后缀，避免被误判为装饰性序号
    s.textContent = (i === 0 || h === 0) ? `${h}点起` : `${h}点`;
    hours.appendChild(s);
  }

  const grid = $('#tl-grid');
  // 清掉旧钉子，保留 nowbar
  $$('.tl-pin, .tl-pin-label, .tl-empty', grid).forEach((n) => n.remove());

  const open = d.tasks.filter((t) => !t.done && t.dueMs !== null);
  const visible = open.filter((t) => t.dueMs >= t0 && t.dueMs <= t0 + SPAN);

  // 现在的位置
  const nowPct = ((d.now - t0) / SPAN) * 100;
  const bar = $('#tl-nowbar');
  if (nowPct >= 0 && nowPct <= 100) {
    bar.style.left = nowPct + '%';
    bar.hidden = false;
  } else {
    bar.hidden = true;
  }

  if (!visible.length) {
    const e = document.createElement('div');
    e.className = 'tl-empty';
    e.textContent = '今明两天没有到期的提醒';
    grid.appendChild(e);
    return;
  }

  // 竖向排列避免重叠
  visible.sort((a, b) => a.dueMs - b.dueMs);
  visible.forEach((t, i) => {
    const pct = ((t.dueMs - t0) / SPAN) * 100;
    const top = 22 + (i % 4) * 22;

    const pin = document.createElement('div');
    pin.className = 'tl-pin' + (t.status === 'soon' ? ' is-soon' : '') + (t.status === 'overdue' ? ' is-overdue' : '');
    pin.style.left = pct + '%';
    pin.style.top = top + 'px';
    pin.title = `${fmtDate(t.dueMs)} ${fmtTime(t.dueMs)} · ${t.title}`;
    grid.appendChild(pin);

    const lb = document.createElement('div');
    lb.className = 'tl-pin-label';
    lb.style.left = pct + '%';
    lb.style.top = (top + 10) + 'px';
    lb.textContent = fmtTime(t.dueMs);
    grid.appendChild(lb);
  });
}

/* 列表 */

function statusPill(t) {
  if (t.done) return '<span class="pill is-done">已完成</span>';
  if (t.status === 'overdue') return '<span class="pill is-overdue">已过期</span>';
  if (t.status === 'soon') return '<span class="pill is-soon">24 小时内</span>';
  return '<span class="pill">待提醒</span>';
}

function advanceText(t) {
  const pending = t.advance.filter((a) => !t.fired.includes(String(a)));
  if (!pending.length) return '全部档位已发出';
  const next = pending.sort((a, b) => b - a)[0];
  if (next === 0) return '下次准点';
  if (next >= 1440) return `下次提前 ${next / 1440} 天`;
  if (next >= 60) return `下次提前 ${next / 60} 小时`;
  return `下次提前 ${next} 分钟`;
}

function renderTasks(d) {
  const list = $('#tasks');
  list.innerHTML = '';

  let items = d.tasks.slice();
  if (state.filter === 'open') items = items.filter((t) => !t.done);
  else if (state.filter === 'done') items = items.filter((t) => t.done);
  else if (state.filter === 'soon') items = items.filter((t) => !t.done && t.status === 'soon');

  items.sort((a, b) => {
    if (a.done !== b.done) return a.done ? 1 : -1;
    return (a.dueMs || 0) - (b.dueMs || 0);
  });

  const empty = $('#empty');
  empty.hidden = items.length > 0;
  if (!items.length) {
    empty.textContent = state.filter === 'done'
      ? '还没有已完成的提醒。'
      : state.filter === 'soon'
        ? '未来 24 小时内没有提醒。'
        : '这里还没有提醒。加一条，或者在飞书里直接说。';
    return;
  }

  const now = d.now;

  for (const t of items) {
    const li = document.createElement('li');
    li.className = 'task rise' + (t.done ? ' is-done' : '');
    li.dataset.id = t.id;

    const diff = t.dueMs !== null ? t.dueMs - now : null;
    const relTxt = diff === null ? '' : (diff >= 0 ? `还有 ${rel(diff)}` : `过期 ${rel(diff)}`);
    const dayTxt = t.dueMs ? WEEK[new Date(t.dueMs).getDay()] : '';

    li.innerHTML = `
      <div class="task-when">
        <b>${t.dueMs ? fmtTime(t.dueMs) : '—'}</b>
        <span>${t.dueMs ? fmtDate(t.dueMs) : ''} ${dayTxt}</span>
        <span>${relTxt}</span>
      </div>
      <div class="task-body">
        <div class="task-title">${esc(t.title)}</div>
        <div class="task-sub">
          ${statusPill(t)}
          ${t.repeat ? `<span class="pill is-repeat">${esc(repeatLabel(t.repeat))}</span>` : ''}
          <span>${esc(advanceText(t))}</span>
          ${t.note ? `<span>${esc(t.note)}</span>` : ''}
        </div>
      </div>
      <div class="task-actions">
        <button class="iconbtn" data-act="detail" aria-label="详情">详情</button>
        <button class="iconbtn" data-act="${t.done ? 'reopen' : 'done'}">${t.done ? '重开' : '完成'}</button>
        <button class="iconbtn" data-act="del">删除</button>
      </div>
    `;
    list.appendChild(li);
  }

  observeRise();
}

/* 最近消息 */

function renderFeed(d) {
  const list = $('#feed');
  list.innerHTML = '';

  const msgs = (d.feed || []).slice(0, 8);
  if (!msgs.length) {
    const li = document.createElement('li');
    li.innerHTML = '<p style="color:var(--muted);font-size:13px">还没有收到消息。在飞书里给机器人说一句带时间的话。</p>';
    list.appendChild(li);
    return;
  }

  for (const m of msgs) {
    const li = document.createElement('li');
    li.innerHTML = `
      <p>${esc(m.text)}</p>
      <time>${esc(m.receivedAt || '')}${m.parsed ? ' · 已建提醒' : ' · 未识别时间'}</time>
    `;
    list.appendChild(li);
  }
}

function renderReview(d) {
  const box = $('#review-box');
  const items = d.review || [];
  box.hidden = items.length === 0;
  if (!items.length) return;

  const list = $('#review-list');
  list.innerHTML = '';
  for (const it of items.slice().reverse()) {
    const li = document.createElement('li');
    li.innerHTML = `<p>${esc(it.text)}</p><time>${esc(it.receivedAt || '')}</time>`;
    list.appendChild(li);
  }
}

const DOMAIN_LABEL = { ad: '广告', price: '价格', promo: '促销', stock: '库存', general: '一般' };

function renderInstructions(d) {
  const box = $('#instr-box');
  const items = d.instructions || [];
  box.hidden = items.length === 0;
  if (!items.length) return;

  const list = $('#instr-list');
  list.innerHTML = '';
  for (const it of items) {
    const li = document.createElement('li');
    const mutate = it.mutate ? '会改动' : '只读';
    li.innerHTML = `
      <p>${esc(it.text)}</p>
      <time>${DOMAIN_LABEL[it.domain] || it.domain} · ${mutate} · ${esc((it.receivedAt || '').slice(0, 16).replace('T', ' '))}${it.campaign ? ` · ${esc(it.campaign)}` : ''}</time>
    `;
    list.appendChild(li);
  }
}

/* ---------- 进场 ---------- */

let io = null;
function observeRise() {
  if (!('IntersectionObserver' in window)) {
    $$('.rise').forEach((el) => el.classList.add('is-in'));
    return;
  }
  if (!io) {
    io = new IntersectionObserver((entries) => {
      entries.forEach((e, i) => {
        if (e.isIntersecting) {
          const el = e.target;
          setTimeout(() => el.classList.add('is-in'), Math.min(i * 40, 200));
          io.unobserve(el);
        }
      });
    }, { rootMargin: '0px 0px -6% 0px' });
  }
  $$('.rise:not(.is-in)').forEach((el) => io.observe(el));
  $$('.sec-block:not(.is-in)').forEach((el) => io.observe(el));
}

/* ---------- 动作 ---------- */

async function refresh() {
  try {
    state.data = await api('/api/state');
    render();
  } catch (e) {
    $('#service-status').dataset.state = 'down';
    $('#service-text').textContent = '连接失败';
  }
}

async function toggleDone(id, done) {
  try {
    await api(`/api/tasks/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify({ done }) });
    toast(done ? '已完成' : '已重开');
    await refresh();
  } catch (e) { toast(e.message); }
}

async function del(id) {
  try {
    await api(`/api/tasks/${encodeURIComponent(id)}`, { method: 'DELETE' });
    toast('已删除');
    await refresh();
  } catch (e) { toast(e.message); }
}

function openDetail(id) {
  const t = state.data.tasks.find((x) => x.id === id);
  if (!t) return;

  const rows = [
    ['时间', t.dueMs ? `${fmtDate(t.dueMs)} ${WEEK[new Date(t.dueMs).getDay()]} ${fmtTime(t.dueMs)}` : '—'],
    ['状态', t.done ? '已完成' : t.status === 'overdue' ? '已过期' : t.status === 'soon' ? '24 小时内' : '待提醒'],
    ['剩余', t.remainingMs === null ? '—' : t.remainingMs >= 0 ? rel(t.remainingMs) : `已过 ${rel(t.remainingMs)}`],
    ['来源', t.source || '—'],
    ['创建', t.createdAt ? t.createdAt.slice(0, 16).replace('T', ' ') : '—'],
    ['标识', t.id],
  ];

  $('#task-detail').innerHTML = `
    <h2 class="detail-head">${esc(t.title)}</h2>
    ${t.note ? `<p class="hint">${esc(t.note)}</p>` : ''}
    <dl class="detail-rows">
      ${rows.map(([k, v]) => `<div><dt>${k}</dt><dd>${esc(v)}</dd></div>`).join('')}
    </dl>
    <p class="hint" style="margin-top:18px">提醒档位 · 已发出的标绿</p>
    <div class="offsets">
      ${t.advance.map((a) => {
        const on = t.fired.includes(String(a));
        const label = a === 0 ? '准点' : a >= 1440 ? `提前 ${a / 1440} 天` : a >= 60 ? `提前 ${a / 60} 小时` : `提前 ${a} 分钟`;
        return `<span class="offset${on ? ' is-fired' : ''}">${label}</span>`;
      }).join('')}
    </div>
    <div class="sheet-actions">
      <button type="button" class="btn-ghost" data-close="1">关闭</button>
    </div>
  `;
  $('#dlg-task').showModal();
}

/* ---------- 表单 ---------- */

let parseTimer = null;

function bindAddDialog() {
  const dlg = $('#dlg-add');
  const text = $('#f-text');
  const hint = $('#parse-hint');

  $('#btn-add').addEventListener('click', () => { dlg.showModal(); text.focus(); });
  $('#btn-cancel').addEventListener('click', () => dlg.close());

  text.addEventListener('input', () => {
    clearTimeout(parseTimer);
    const v = text.value.trim();
    if (!v) {
      hint.textContent = '会自动识别日期和时间';
      hint.className = 'hint';
      return;
    }
    parseTimer = setTimeout(async () => {
      try {
        const r = await api('/api/parse', { method: 'POST', body: JSON.stringify({ text: v }) });
        if (r.parsed) {
          const ms = Date.parse(r.parsed.due);
          hint.textContent = `识别为 ${fmtDate(ms)} ${fmtTime(ms)}`;
          hint.className = 'hint is-ok';
        } else {
          hint.textContent = '没识别出日期，请写明，例如「11月3日 上午10点」';
          hint.className = 'hint is-bad';
        }
      } catch (_) {}
    }, 180);
  });

  $('#form-add').addEventListener('submit', async (e) => {
    e.preventDefault();
    const errEl = $('#add-err');
    errEl.hidden = true;

    const v = text.value.trim();
    if (!v) { errEl.textContent = '请先说点什么'; errEl.hidden = false; return; }

    const payload = { text: v, note: $('#f-note').value.trim() || undefined };
    const dateV = $('#f-date').value;
    if (dateV) payload.due = `${dateV}T${$('#f-time').value || '10:00'}:00+08:00`;

    try {
      await api('/api/tasks', { method: 'POST', body: JSON.stringify(payload) });
      dlg.close();
      $('#form-add').reset();
      $('#f-time').value = '10:00';
      hint.textContent = '会自动识别日期和时间';
      hint.className = 'hint';
      toast('已添加');
      await refresh();
    } catch (err) {
      errEl.textContent = err.message;
      errEl.hidden = false;
    }
  });
}

/* ---------- 全局事件 ---------- */

document.addEventListener('click', (e) => {
  const chip = e.target.closest('.chip');
  if (chip) {
    state.filter = chip.dataset.filter;
    $$('.chip').forEach((c) => c.classList.toggle('is-on', c === chip));
    renderTasks(state.data);
    return;
  }

  const btn = e.target.closest('[data-act]');
  if (btn) {
    const id = btn.closest('.task').dataset.id;
    const act = btn.dataset.act;
    if (act === 'done') toggleDone(id, true);
    else if (act === 'reopen') toggleDone(id, false);
    else if (act === 'del') del(id);
    else if (act === 'detail') openDetail(id);
    return;
  }

  if (e.target.closest('[data-close]')) {
    const d = e.target.closest('dialog');
    if (d) d.close();
    return;
  }

  const dlg = e.target.closest('dialog');
  if (dlg && e.target === dlg) dlg.close();
});

/* ---------- 启动 ---------- */

bindAddDialog();
refresh();

// 区块进场：区块在视口内时立刻显示，避免内容长期不可见
setTimeout(() => {
  $$('.sec-block').forEach((el, i) => {
    setTimeout(() => el.classList.add('is-in'), i * 90);
  });
}, 60);

setInterval(refresh, 15000);
setInterval(() => {
  if (state.data) {
    state.data.now = Date.now();
    renderClock(state.data);
    renderNext(state.data);
    renderTasks(state.data);
  }
}, 20000);
