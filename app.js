// booking-system — 前端入口
// 流程:
//   1. 判斷 ?admin=xxx → 老師模式 / 否則 → 學生模式
//   2. 學生先試用 localStorage 的邀請碼登入,失敗再顯示登入框
//   3. 載入月曆資料 → 渲染 3 個月並排月曆
//   4. 點某天 → 抽屜展開該日 26 個半小時格

// =========================================================================
// 設定
// =========================================================================
const API_BASE = ''; // TODO: Step 6 部署後填入 GAS Web App URL

// =========================================================================
// State
// =========================================================================
const state = {
  isAdmin: false,
  adminKey: '',
  inviteCode: '',
  studentName: '',
  calendar: null,         // { "2026-06-01": [{time, status, ...}, ...], ... }
  selectedDate: null,
};

// =========================================================================
// localStorage
// =========================================================================
const storage = {
  getInviteCode() { return localStorage.getItem('booking_invite_code') || ''; },
  setInviteCode(code) { localStorage.setItem('booking_invite_code', code); },
  clearInviteCode() { localStorage.removeItem('booking_invite_code'); },
};

// =========================================================================
// API client
//   POST 不能設 Content-Type: application/json (會觸發 CORS preflight,GAS 不支援)
//   用預設 text/plain,GAS 端從 e.postData.contents 解 JSON
// =========================================================================
const api = {
  async get(action, params = {}) {
    if (!API_BASE) throw new Error('API_BASE 尚未設定 (見 Step 6)');
    const url = new URL(API_BASE);
    url.searchParams.set('action', action);
    Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
    const res = await fetch(url.toString());
    return await res.json();
  },
  async post(action, body = {}) {
    if (!API_BASE) throw new Error('API_BASE 尚未設定 (見 Step 6)');
    const res = await fetch(API_BASE, {
      method: 'POST',
      body: JSON.stringify({ action, ...body }),
    });
    return await res.json();
  },
};

// =========================================================================
// DOM helpers
// =========================================================================
const $ = sel => document.querySelector(sel);

function el(tag, attrs = {}, ...children) {
  const e = document.createElement(tag);
  Object.entries(attrs).forEach(([k, v]) => {
    if (v == null) return;
    if (k === 'class') e.className = v;
    else if (k === 'dataset') Object.entries(v).forEach(([dk, dv]) => e.dataset[dk] = dv);
    else if (k.startsWith('on') && typeof v === 'function') e.addEventListener(k.slice(2).toLowerCase(), v);
    else e.setAttribute(k, v);
  });
  children.flat().forEach(c => {
    if (c == null || c === false) return;
    e.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
  });
  return e;
}

// =========================================================================
// Init
// =========================================================================
async function init() {
  const params = new URLSearchParams(location.search);
  const adminKey = params.get('admin');

  if (adminKey) {
    state.isAdmin = true;
    state.adminKey = adminKey;
    document.body.classList.add('admin-mode');
    const ok = await loadAdminCalendar();
    if (ok) renderMain();
    return;
  }

  const saved = storage.getInviteCode();
  if (saved) {
    const ok = await tryLoginStudent(saved);
    if (ok) { renderMain(); return; }
    storage.clearInviteCode();
  }
  renderLogin();
}

async function tryLoginStudent(code) {
  try {
    const res = await api.get('get_calendar', { code });
    if (!res.ok) return false;
    state.inviteCode = code;
    state.studentName = res.data.student.name;
    state.calendar = res.data.days;
    return true;
  } catch (err) {
    console.error('login error', err);
    return false;
  }
}

async function loadAdminCalendar() {
  try {
    const res = await api.get('admin_calendar', { admin_key: state.adminKey });
    if (!res.ok) {
      alert('無法載入老師後台:' + (res.error || '') + ' / ' + (res.msg || ''));
      return false;
    }
    state.calendar = res.data.days;
    return true;
  } catch (err) {
    alert('API 連線失敗:' + err.message);
    return false;
  }
}

async function refreshCalendar() {
  if (state.isAdmin) await loadAdminCalendar();
  else await tryLoginStudent(state.inviteCode);
  renderMain();
}

// =========================================================================
// Render — Login screen (學生)
// =========================================================================
function renderLogin() {
  const app = $('#app');
  app.innerHTML = '';
  const input = el('input', {
    type: 'text',
    placeholder: '邀請碼',
    maxlength: 8,
    id: 'login-code',
    autocomplete: 'off',
  });
  input.addEventListener('keydown', e => { if (e.key === 'Enter') doLogin(); });
  app.appendChild(el('div', { class: 'login' },
    el('h1', {}, '課程預約'),
    el('p', { class: 'login-hint' }, '請輸入老師提供的 8 字邀請碼'),
    input,
    el('button', { class: 'btn-primary', onclick: doLogin }, '登入'),
    el('div', { class: 'login-error', id: 'login-error' }),
  ));
  setTimeout(() => input.focus(), 50);
}

async function doLogin() {
  const input = $('#login-code');
  const code = input.value.trim().toUpperCase();
  const errBox = $('#login-error');
  errBox.textContent = '';
  if (!code) { errBox.textContent = '請輸入邀請碼'; return; }
  const ok = await tryLoginStudent(code);
  if (ok) {
    storage.setInviteCode(code);
    renderMain();
  } else {
    errBox.textContent = '邀請碼無效,請檢查或聯絡老師';
  }
}

function doLogout() {
  if (state.isAdmin) {
    location.href = location.pathname; // 拿掉 ?admin=
  } else {
    storage.clearInviteCode();
    state.inviteCode = '';
    state.studentName = '';
    state.calendar = null;
    renderLogin();
  }
}

// =========================================================================
// Render — Main (header + months + drawer)
// =========================================================================
function renderMain() {
  const app = $('#app');
  app.innerHTML = '';
  app.appendChild(renderHeader());
  app.appendChild(renderMonths());
  app.appendChild(renderDrawer());
}

function renderHeader() {
  return el('header', { class: 'header' },
    el('div', { class: 'brand' }, '課程預約'),
    el('div', { class: 'user' },
      state.isAdmin
        ? el('span', { class: 'admin-tag' }, '老師後台')
        : el('span', { class: 'user-name' }, state.studentName),
      state.isAdmin
        ? el('button', { class: 'btn-link', onclick: openStudentManager }, '管理邀請碼')
        : null,
      el('button', { class: 'btn-link', onclick: doLogout }, '登出'),
    ),
  );
}

const MONTHS = ['2026-06', '2026-07', '2026-08'];
const MONTH_LABELS = { '2026-06': '2026 年 6 月', '2026-07': '2026 年 7 月', '2026-08': '2026 年 8 月' };
const WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六'];

function renderMonths() {
  const wrap = el('main', { class: 'months' });
  MONTHS.forEach(m => wrap.appendChild(renderMonth(m)));
  return wrap;
}

function renderMonth(monthKey) {
  const [year, month] = monthKey.split('-').map(Number);
  const firstDay = new Date(year, month - 1, 1);
  const startWeekday = firstDay.getDay();
  const daysInMonth = new Date(year, month, 0).getDate();

  const monthEl = el('section', { class: 'month' },
    el('h2', { class: 'month-title' }, MONTH_LABELS[monthKey]),
    el('div', { class: 'weekdays' }, ...WEEKDAYS.map(w => el('div', { class: 'weekday' }, w))),
  );

  const grid = el('div', { class: 'days-grid' });
  for (let i = 0; i < startWeekday; i++) grid.appendChild(el('div', { class: 'day-empty' }));
  for (let d = 1; d <= daysInMonth; d++) {
    const dateKey = `${year}-${String(month).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    grid.appendChild(renderDayCell(dateKey, d));
  }
  monthEl.appendChild(grid);
  return monthEl;
}

function renderDayCell(dateKey, dayNum) {
  const slots = (state.calendar && state.calendar[dateKey]) || [];
  let avail = 0, blocked = 0, booked = 0, mine = 0;
  slots.forEach(s => {
    if (state.isAdmin) {
      if (s.status === 'available') avail++;
      else if (s.status === 'blocked') blocked++;
      else if (s.status === 'booked') booked++;
    } else {
      if (s.status === 'available') avail++;
      else if (s.status === 'mine') mine++;
    }
  });

  const cell = el('button', {
    class: 'day-cell',
    onclick: () => openDrawer(dateKey),
    dataset: { date: dateKey },
  });
  cell.appendChild(el('div', { class: 'day-num' }, String(dayNum)));

  const stats = el('div', { class: 'day-stats' });
  if (state.isAdmin) {
    if (avail) stats.appendChild(el('span', { class: 'stat avail', title: '可選' }, String(avail)));
    if (blocked) stats.appendChild(el('span', { class: 'stat blocked', title: '我 block' }, String(blocked)));
    if (booked) stats.appendChild(el('span', { class: 'stat booked', title: '已預約' }, String(booked)));
  } else {
    if (mine) stats.appendChild(el('span', { class: 'stat mine' }, `${mine} 已約`));
    if (avail) stats.appendChild(el('span', { class: 'stat avail' }, `${avail} 可選`));
    if (!mine && !avail) {
      stats.appendChild(el('span', { class: 'stat full' }, '已滿'));
      cell.classList.add('day-full');
    }
  }
  cell.appendChild(stats);
  return cell;
}

// =========================================================================
// Render — Drawer (該日時段)
// =========================================================================
function renderDrawer() {
  return el('div', { class: 'drawer hidden', id: 'drawer', onclick: drawerOverlayClick },
    el('div', { class: 'drawer-content', onclick: e => e.stopPropagation() },
      el('header', { class: 'drawer-header' },
        el('h2', { id: 'drawer-title' }, ''),
        el('button', { class: 'btn-close', onclick: closeDrawer, 'aria-label': '關閉' }, '✕'),
      ),
      el('div', { id: 'drawer-body', class: 'drawer-body' }),
    ),
  );
}

function drawerOverlayClick(e) {
  if (e.target.id === 'drawer') closeDrawer();
}

function openDrawer(dateKey) {
  state.selectedDate = dateKey;
  $('#drawer-title').textContent = formatDateLabel(dateKey);
  renderSlotGrid();
  $('#drawer').classList.remove('hidden');
}

function closeDrawer() {
  state.selectedDate = null;
  $('#drawer').classList.add('hidden');
}

function formatDateLabel(dateKey) {
  const [y, m, d] = dateKey.split('-').map(Number);
  const wk = WEEKDAYS[new Date(y, m - 1, d).getDay()];
  return `${y} 年 ${m} 月 ${d} 日(週${wk})`;
}

function renderSlotGrid() {
  const body = $('#drawer-body');
  body.innerHTML = '';
  const slots = (state.calendar && state.calendar[state.selectedDate]) || [];
  if (!slots.length) {
    body.appendChild(el('div', { class: 'empty-msg' }, '此日無時段資料'));
    return;
  }
  const grid = el('div', { class: 'slot-grid' });
  slots.forEach(s => grid.appendChild(renderSlotButton(s)));
  body.appendChild(grid);
}

function renderSlotButton(slot) {
  const datetime = `${state.selectedDate}T${slot.time}`;
  if (state.isAdmin) return renderAdminSlot(slot, datetime);
  return renderStudentSlot(slot, datetime);
}

function renderStudentSlot(slot, datetime) {
  // status: available / mine / unavailable
  const btn = el('button', {
    class: `slot slot-${slot.status}`,
    dataset: { datetime },
  });
  btn.appendChild(el('span', { class: 'slot-time' }, slot.time));
  if (slot.status === 'mine') btn.appendChild(el('span', { class: 'slot-meta' }, '已預約'));
  if (slot.status === 'available') {
    btn.addEventListener('click', () => onStudentBook(datetime, slot.time));
  } else {
    btn.disabled = true;
  }
  return btn;
}

function renderAdminSlot(slot, datetime) {
  // status: available / blocked / booked
  const btn = el('button', {
    class: `slot slot-${slot.status}`,
    dataset: { datetime },
  });
  btn.appendChild(el('span', { class: 'slot-time' }, slot.time));
  if (slot.status === 'blocked') btn.appendChild(el('span', { class: 'slot-meta' }, '⛔ 已封鎖'));
  else if (slot.status === 'booked') btn.appendChild(el('span', { class: 'slot-meta' }, slot.student_name || '學生'));
  btn.addEventListener('click', () => onAdminSlotClick(slot, datetime));
  return btn;
}

// =========================================================================
// Slot 互動 (Step 4 / 5 完整實作)
// =========================================================================
function onStudentBook(datetime, time) {
  alert(`(Step 4 待實作) 學生預約 ${datetime}`);
}

function onAdminSlotClick(slot, datetime) {
  alert(`(Step 5 待實作) 老師動作 ${datetime},狀態=${slot.status}`);
}

function openStudentManager() {
  alert('(Step 5 待實作) 邀請碼管理');
}

// =========================================================================
// 啟動
// =========================================================================
init();
