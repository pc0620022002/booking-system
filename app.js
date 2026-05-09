// booking-system — 前端
// 流程:
//   1. 判斷 ?admin=xxx → 老師模式 / 否則 → 學生模式
//   2. 學生先試用 localStorage 邀請碼,失敗才顯示登入框
//   3. 載入月曆 → 一次顯示一週(直欄=時間、橫欄=日期),按鈕或左右滑動切週
//   4. 點時段 → 學生:預約 / 老師:block toggle 或開選單(取消、改期)
//   5. 「預約總覽」:老師看全體學生 / 學生看自己

// =========================================================================
// 設定
// =========================================================================
const API_BASE = 'https://script.google.com/macros/s/AKfycbzxKaZayb72wwmNp6GnmybqOMGdvXF8lsSTx2SPsFBTjrtgVtMFvX7ae4ZlMwcN9oFLWw/exec';

const RANGE_START = '2026-06-01';
const RANGE_END = '2026-08-31';
const HOURS_START = 9;
const HOURS_END = 22; // 不含,最後一格 21:30
const SLOT_MINUTES = 30;
const WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六'];

// =========================================================================
// State
// =========================================================================
const state = {
  isAdmin: false,
  adminKey: '',
  inviteCode: '',
  studentName: '',
  calendar: null,
  weeks: null,        // [{ days: [{dateKey, inRange, weekday, dayNum, month}, ...] }, ...]
  selectedWeek: null,
  lastVersion: null,  // 後端 data version,polling 比對是否變動
};

let rescheduleFromDt = null;

// =========================================================================
// localStorage
// =========================================================================
const storage = {
  getInviteCode() { return localStorage.getItem('booking_invite_code') || ''; },
  setInviteCode(code) { localStorage.setItem('booking_invite_code', code); },
  clearInviteCode() { localStorage.removeItem('booking_invite_code'); },
  getLastSeenBookedAt() { return localStorage.getItem('booking_last_seen_at') || ''; },
  setLastSeenBookedAt(iso) { localStorage.setItem('booking_last_seen_at', iso); },
};

// =========================================================================
// API client
// =========================================================================
const api = {
  async get(action, params = {}) {
    if (!API_BASE) throw new Error('API_BASE 尚未設定');
    const url = new URL(API_BASE);
    url.searchParams.set('action', action);
    Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
    const res = await fetch(url.toString());
    return await res.json();
  },
  async post(action, body = {}) {
    if (!API_BASE) throw new Error('API_BASE 尚未設定');
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
// Toast / 訊息
// =========================================================================
function toast(msg, type = 'info') {
  const t = el('div', { class: `toast toast-${type}` }, msg);
  document.body.appendChild(t);
  setTimeout(() => {
    t.classList.add('toast-leaving');
    setTimeout(() => t.remove(), 200);
  }, 2200);
}

function humanError(code, msg) {
  const map = {
    'slot_taken': '此時段已被其他學生預約或老師封鎖',
    'invalid_code': '邀請碼無效',
    'busy_try_again': '系統忙碌,請稍後再試',
    'slot_not_found': '時段不存在',
    'slot_booked_cannot_block': '此時段已有學生預約,請先取消預約再封鎖',
    'slot_not_blocked': '此時段並非封鎖狀態',
    'slot_not_booked': '此時段並非已預約狀態',
    'from_not_booked': '原始時段不是已預約狀態',
    'to_not_available': '目標時段並非可選狀態',
    'missing_code': '缺少邀請碼',
    'missing_datetime': '缺少時段參數',
    'missing_name': '缺少學生姓名',
    'invalid_code_format': '邀請碼格式不合(僅限英數和 _- 符號,1–30 字)',
    'code_taken': '此邀請碼已被使用,請換一個',
    'student_not_found': '找不到此邀請碼對應的學生',
    'unknown_action': '不支援的動作',
    'admin_key invalid': '老師碼錯誤',
  };
  if (map[code]) return map[code];
  if (msg && msg.includes('admin_key invalid')) return '老師碼錯誤';
  if (msg && msg.includes('ADMIN_KEY not configured')) return 'GAS 端尚未設定 ADMIN_KEY';
  return msg ? `${code}: ${msg}` : code;
}

// =========================================================================
// Init
// =========================================================================
function showInitLoading(label) {
  const app = $('#app');
  app.innerHTML = '';
  const wrap = el('div', {});
  wrap.style.cssText = 'text-align:center; padding:60px 20px; color:#666;';
  wrap.innerHTML =
    `<div style="font-size:18px; margin-bottom:8px;">⏳ ${label || '載入中...'}</div>` +
    `<div style="font-size:13px; color:#999;">首次開啟可能需要 1–5 秒(後端剛喚醒),之後操作都會立即反應</div>`;
  app.appendChild(wrap);
}

async function init() {
  const params = new URLSearchParams(location.search);
  const isMock = params.get('mock') === '1';

  if (isMock) {
    installMockApi();
  } else if (!API_BASE) {
    renderSetupPage();
    return;
  }

  const adminKey = params.get('admin');
  if (adminKey) {
    state.isAdmin = true;
    state.adminKey = adminKey;
    document.body.classList.add('admin-mode');
    showInitLoading('載入老師後台');
    const ok = await loadAdminCalendar();
    if (ok) renderMain();
    return;
  }

  const saved = storage.getInviteCode();
  if (saved) {
    showInitLoading('載入課表');
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
    if (res.data.version) state.lastVersion = res.data.version;
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
      alert('無法載入老師後台:' + humanError(res.error, res.msg));
      return false;
    }
    state.calendar = res.data.days;
    if (res.data.version) state.lastVersion = res.data.version;
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
  if (rescheduleFromDt) showRescheduleBanner();
}

// 樂觀更新:就地改 state.calendar 內對應 slot 的欄位,免去重抓整張 calendar
function mutateSlot(datetime, fields) {
  if (!state.calendar) return;
  const [dateKey, time] = datetime.split('T');
  const slots = state.calendar[dateKey];
  if (!slots) return;
  const slot = slots.find(s => s.time === time);
  if (slot) Object.assign(slot, fields);
}

// 拍下 slot 當前完整狀態,用於樂觀更新失敗後回滾
function snapshotSlot(datetime) {
  if (!state.calendar) return null;
  const [dateKey, time] = datetime.split('T');
  const slots = state.calendar[dateKey];
  if (!slots) return null;
  const slot = slots.find(s => s.time === time);
  return slot ? { ...slot } : null;
}

function restoreSlot(datetime, snap) {
  if (!snap) return;
  if (!state.calendar) return;
  const [dateKey, time] = datetime.split('T');
  const slots = state.calendar[dateKey];
  if (!slots) return;
  const idx = slots.findIndex(s => s.time === time);
  if (idx >= 0) slots[idx] = snap;
}

// 切回分頁時主動同步 (cooldown 5s 避免抖動 / 改期模式中跳過)
let lastVisCheck = 0;
document.addEventListener('visibilitychange', async () => {
  if (document.hidden) return;
  if (!state.calendar) return;
  if (rescheduleFromDt) return;
  if (document.querySelector('.modal-overlay')) return;
  const now = Date.now();
  if (now - lastVisCheck < 5000) return;
  lastVisCheck = now;
  // 若 server 支援 version,走輕量 check;否則 fallback 到完整 refresh(舊版 GAS)
  if (state.lastVersion) {
    await checkVersionAndMaybeRefresh();
  } else {
    await refreshCalendar();
  }
});

// 即時同步:每 3s 輕量 ping version,變動才拉整個 calendar
const POLL_INTERVAL_MS = 3000;
async function checkVersionAndMaybeRefresh() {
  if (!state.calendar) return;
  if (!state.lastVersion) return;     // server 不支援 version,polling 略過(避免每 5s 全量 refresh)
  if (rescheduleFromDt) return;
  if (document.querySelector('.modal-overlay')) return;
  if (document.hidden) return;
  try {
    const res = await api.get('version', {});
    if (!res.ok) return;
    const newVer = res.data.version;
    if (newVer && newVer !== state.lastVersion) {
      state.lastVersion = newVer;
      await refreshCalendar();
    }
  } catch (err) {
    // polling 失敗靜默,下一輪再試
  }
}

setInterval(checkVersionAndMaybeRefresh, POLL_INTERVAL_MS);

// =========================================================================
// Render — 部署前提示頁
// =========================================================================
function renderSetupPage() {
  const app = $('#app');
  app.innerHTML = '';
  app.appendChild(el('div', { class: 'login' },
    el('h1', {}, '尚未部署'),
    el('p', { class: 'login-hint' },
      '本前端尚未連接後端 API。'),
    el('p', { class: 'login-hint' },
      '想先看 UI?在網址末加 ',
      el('code', {}, '?mock=1'),
      ' 進入示範模式。'),
    el('p', { class: 'login-hint' },
      '正式部署請依 DEPLOY.md,把 GAS Web App URL 填進 ',
      el('code', {}, 'app.js'),
      ' 的 ',
      el('code', {}, 'API_BASE'),
      '。'),
  ));
}

// =========================================================================
// Render — Login (學生)
// =========================================================================
function renderLogin() {
  showMockBanner();
  const app = $('#app');
  app.innerHTML = '';
  const input = el('input', {
    type: 'text',
    placeholder: '邀請碼',
    maxlength: 30,
    id: 'login-code',
    autocomplete: 'off',
    autocapitalize: 'off',
    spellcheck: 'false',
  });
  input.addEventListener('keydown', e => { if (e.key === 'Enter') doLogin(); });
  app.appendChild(el('div', { class: 'login' },
    el('h1', {}, 'Andy致安老師課程預約'),
    el('p', { class: 'login-hint' }, '請輸入老師提供的邀請碼'),
    input,
    el('button', { class: 'btn-primary', onclick: doLogin }, '登入'),
    el('div', { class: 'login-error', id: 'login-error' }),
  ));
  setTimeout(() => input.focus(), 50);
}

async function doLogin() {
  const input = $('#login-code');
  const code = input.value.trim(); // 不強制大寫,backend case-insensitive 比對
  const errBox = $('#login-error');
  errBox.textContent = '';
  if (!code) { errBox.textContent = '請輸入邀請碼'; return; }
  // 防呆:disable input + 顯示登入中,避免 user 連按或以為卡住
  input.disabled = true;
  errBox.textContent = '⏳ 登入中...(首次稍久)';
  const ok = await tryLoginStudent(code);
  if (ok) {
    storage.setInviteCode(code);
    renderMain();
  } else {
    input.disabled = false;
    errBox.textContent = '邀請碼無效,請檢查或聯絡老師';
  }
}

function doLogout() {
  if (state.isAdmin) {
    location.href = location.pathname;
  } else {
    storage.clearInviteCode();
    state.inviteCode = '';
    state.studentName = '';
    state.calendar = null;
    renderLogin();
  }
}

// =========================================================================
// Render — Main
// =========================================================================
function renderMain() {
  showMockBanner();
  const app = $('#app');
  app.innerHTML = '';
  if (!state.weeks) state.weeks = computeWeeks(RANGE_START, RANGE_END);
  if (state.selectedWeek == null) state.selectedWeek = defaultWeekIndex();

  app.appendChild(renderHeader());
  app.appendChild(renderWeekNav());

  const wrap = el('div', { class: 'week-wrap', id: 'week-wrap' });
  wrap.appendChild(renderWeekTable(state.selectedWeek));
  app.appendChild(wrap);
  attachSwipe(wrap);
}

function renderHeader() {
  const recentBtn = state.isAdmin ? buildRecentBookingsBtn() : null;
  return el('header', { class: 'header' },
    el('div', { class: 'brand' }, state.isAdmin ? '課程預約' : 'Andy致安老師課程預約'),
    el('div', { class: 'user' },
      state.isAdmin
        ? el('span', { class: 'admin-tag' }, '老師後台')
        : el('span', { class: 'user-name' }, state.studentName),
      el('button', { class: 'btn-link', onclick: openSummary }, state.isAdmin ? '預約總覽' : '我的預約'),
      recentBtn,
      state.isAdmin
        ? el('button', { class: 'btn-link', onclick: openStudentManager }, '管理邀請碼')
        : null,
      el('button', { class: 'btn-link', onclick: doLogout }, '登出'),
    ),
  );
}

function buildRecentBookingsBtn() {
  const list = collectRecentBookings();
  const lastSeen = storage.getLastSeenBookedAt();
  const unread = list.filter(b => !lastSeen || b.booked_at > lastSeen).length;
  const btn = el('button', { class: 'btn-link recent-btn', onclick: openRecentBookings }, '📋 預約紀錄');
  if (unread > 0) {
    btn.appendChild(el('span', { class: 'unread-badge' }, String(unread)));
  }
  return btn;
}

// 收集所有 booked slots 並按 booked_at desc 排序(只回有 booked_at 的)
function collectRecentBookings() {
  if (!state.calendar) return [];
  const list = [];
  Object.entries(state.calendar).forEach(([dateKey, slots]) => {
    slots.forEach(s => {
      if (s.status === 'booked' && s.booked_at) {
        list.push({
          datetime: `${dateKey}T${s.time}`,
          dateKey,
          time: s.time,
          student_name: s.student_name || '(未填名)',
          invite_code: s.invite_code || '',
          booked_at: s.booked_at,
        });
      }
    });
  });
  list.sort((a, b) => b.booked_at.localeCompare(a.booked_at));
  return list;
}

function relativeTime(isoStr) {
  if (!isoStr) return '';
  const t = new Date(isoStr);
  const diff = Date.now() - t.getTime();
  if (diff < 60000) return '剛剛';
  if (diff < 3600000) return `${Math.floor(diff / 60000)} 分鐘前`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)} 小時前`;
  if (diff < 7 * 86400000) return `${Math.floor(diff / 86400000)} 天前`;
  return Utilities_formatDateLocal(t);
}

function Utilities_formatDateLocal(d) {
  const m = d.getMonth() + 1;
  const day = d.getDate();
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${m}/${day} ${hh}:${mm}`;
}

function openRecentBookings() {
  const list = collectRecentBookings();
  const lastSeen = storage.getLastSeenBookedAt();

  const overlay = el('div', { class: 'modal-overlay' });
  overlay.addEventListener('click', e => { if (e.target === overlay) closeAndMarkSeen(); });

  function closeAndMarkSeen() {
    if (list.length > 0) storage.setLastSeenBookedAt(list[0].booked_at);
    overlay.remove();
    renderMain(); // 重畫 header 清掉 badge
  }

  const rows = el('div', { class: 'recent-list' });
  if (list.length === 0) {
    rows.appendChild(el('div', { class: 'empty-msg' }, '目前沒有任何預約'));
  } else {
    list.slice(0, 50).forEach(b => {
      const isUnread = !lastSeen || b.booked_at > lastSeen;
      const dateLabel = formatDateLabel(b.dateKey);
      const [h, m] = b.time.split(':').map(Number);
      const endTotal = h * 60 + m + 30;
      const endTime = `${String(Math.floor(endTotal / 60)).padStart(2, '0')}:${String(endTotal % 60).padStart(2, '0')}`;
      const slotLabel = `${dateLabel} ${b.time}-${endTime}`;
      const row = el('div', { class: 'recent-row' + (isUnread ? ' is-unread' : '') });
      row.appendChild(el('div', { class: 'recent-row-main' },
        el('span', { class: 'recent-student' }, b.student_name),
        el('span', { class: 'recent-arrow' }, ' → '),
        el('span', { class: 'recent-slot' }, slotLabel),
      ));
      row.appendChild(el('span', { class: 'recent-when', title: b.booked_at }, relativeTime(b.booked_at)));
      row.addEventListener('click', () => {
        jumpToWeekContaining(b.dateKey);
        closeAndMarkSeen();
      });
      rows.appendChild(row);
    });
  }

  const modal = el('div', { class: 'modal modal-wide' },
    el('h3', {}, '📋 預約紀錄'),
    el('p', { class: 'modal-hint' }, '依預約時間由近到遠排序。點任一筆可跳到該週。關閉後新筆數歸零。'),
    rows,
    el('div', { class: 'modal-actions' },
      el('button', { class: 'btn-secondary', onclick: closeAndMarkSeen }, '關閉'),
    ),
  );
  overlay.appendChild(modal);
  document.body.appendChild(overlay);
}

function jumpToWeekContaining(dateKey) {
  if (!state.weeks) return;
  for (let i = 0; i < state.weeks.length; i++) {
    if (state.weeks[i].days.some(d => d.dateKey === dateKey)) {
      state.selectedWeek = i;
      renderMain();
      return;
    }
  }
}

// =========================================================================
// 週計算
// =========================================================================
function computeWeeks(rangeStart, rangeEnd) {
  const start = new Date(rangeStart + 'T12:00:00+08:00');
  const startWeekday = start.getDay();
  const firstSundayMs = start.getTime() - startWeekday * 86400000;
  const end = new Date(rangeEnd + 'T12:00:00+08:00');
  const endWeekday = end.getDay();
  const lastSaturdayMs = end.getTime() + (6 - endWeekday) * 86400000;

  const weeks = [];
  for (let cursor = firstSundayMs; cursor <= lastSaturdayMs; cursor += 7 * 86400000) {
    const days = [];
    for (let i = 0; i < 7; i++) {
      const d = new Date(cursor + i * 86400000);
      const dateKey = formatDateKey(d);
      const inRange = dateKey >= rangeStart && dateKey <= rangeEnd;
      days.push({ dateKey, inRange, weekday: d.getDay(), dayNum: d.getDate(), month: d.getMonth() + 1 });
    }
    weeks.push({ days });
  }
  return weeks;
}

function formatDateKey(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function defaultWeekIndex() {
  const today = formatDateKey(new Date());
  for (let i = 0; i < state.weeks.length; i++) {
    if (state.weeks[i].days.some(d => d.dateKey === today)) return i;
  }
  return 0;
}

function formatDateLabel(dateKey) {
  const [y, m, d] = dateKey.split('-').map(Number);
  const wk = WEEKDAYS[new Date(y, m - 1, d).getDay()];
  return `${y} 年 ${m} 月 ${d} 日(週${wk})`;
}

// =========================================================================
// 週導覽
// =========================================================================
function renderWeekNav() {
  const week = state.weeks[state.selectedWeek];
  const first = week.days[0];
  const last = week.days[6];
  const label = `${first.month}/${first.dayNum} – ${last.month}/${last.dayNum} (第 ${state.selectedWeek + 1} / ${state.weeks.length} 週)`;

  const prev = el('button', { class: 'btn-secondary nav-btn', onclick: gotoPrevWeek }, '← 上週');
  if (state.selectedWeek === 0) prev.disabled = true;
  const next = el('button', { class: 'btn-secondary nav-btn', onclick: gotoNextWeek }, '下週 →');
  if (state.selectedWeek === state.weeks.length - 1) next.disabled = true;

  return el('div', { class: 'week-nav' },
    prev,
    el('span', { class: 'week-label' }, label),
    next,
  );
}

function gotoPrevWeek() {
  if (state.selectedWeek > 0) {
    state.selectedWeek--;
    renderMain();
  }
}
function gotoNextWeek() {
  if (state.selectedWeek < state.weeks.length - 1) {
    state.selectedWeek++;
    renderMain();
  }
}

// =========================================================================
// Swipe (touch)
// =========================================================================
let swipeStart = null;
let swipeMoved = false;

function attachSwipe(elem) {
  elem.addEventListener('touchstart', e => {
    swipeStart = { x: e.touches[0].clientX, y: e.touches[0].clientY };
    swipeMoved = false;
  }, { passive: true });
  elem.addEventListener('touchmove', e => {
    if (!swipeStart) return;
    const dx = e.touches[0].clientX - swipeStart.x;
    const dy = e.touches[0].clientY - swipeStart.y;
    if (Math.abs(dx) > 24 && Math.abs(dx) > Math.abs(dy) * 1.3) {
      swipeMoved = true;
    }
  }, { passive: true });
  elem.addEventListener('touchend', e => {
    if (!swipeStart) { swipeMoved = false; return; }
    const dx = e.changedTouches[0].clientX - swipeStart.x;
    swipeStart = null;
    if (swipeMoved && Math.abs(dx) > 60) {
      if (dx < 0) gotoNextWeek();
      else gotoPrevWeek();
    }
    setTimeout(() => { swipeMoved = false; }, 50);
  });
}

// =========================================================================
// 週表格
// =========================================================================
function renderWeekTable(weekIndex) {
  const week = state.weeks[weekIndex];
  const table = el('table', { class: 'week-table' });

  const thead = el('thead');
  const headerRow = el('tr');
  headerRow.appendChild(el('th', { class: 'time-col' }, ''));
  week.days.forEach(d => {
    const isWeekend = d.weekday === 0 || d.weekday === 6;
    const cls = (d.inRange ? 'date-col' : 'date-col date-col-out') + (isWeekend ? ' is-weekend' : '');
    headerRow.appendChild(el('th', { class: cls },
      el('div', { class: 'wk' }, '週' + WEEKDAYS[d.weekday]),
      el('div', { class: 'date' }, `${d.month}/${d.dayNum}`),
    ));
  });
  thead.appendChild(headerRow);
  table.appendChild(thead);

  const tbody = el('tbody');
  for (let h = HOURS_START; h < HOURS_END; h++) {
    for (let m = 0; m < 60; m += SLOT_MINUTES) {
      const time = `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
      // 顯示用範圍格式 "09:00-09:30"(end = start + SLOT_MINUTES)
      const endTotal = h * 60 + m + SLOT_MINUTES;
      const endTime = `${String(Math.floor(endTotal / 60)).padStart(2, '0')}:${String(endTotal % 60).padStart(2, '0')}`;
      const timeLabel = `${time}-${endTime}`;
      const row = el('tr');
      row.appendChild(el('th', { class: 'time-col' }, timeLabel));
      week.days.forEach(d => {
        const isWeekend = d.weekday === 0 || d.weekday === 6;
        if (!d.inRange) {
          row.appendChild(el('td', { class: 'slot slot-out-of-range' + (isWeekend ? ' is-weekend' : '') }));
          return;
        }
        const slotsForDay = (state.calendar && state.calendar[d.dateKey]) || [];
        const slot = slotsForDay.find(s => s.time === time);
        if (!slot) {
          row.appendChild(el('td', { class: 'slot slot-out-of-range' + (isWeekend ? ' is-weekend' : '') }));
          return;
        }
        const td = renderTableCell(slot, d.dateKey, time);
        if (isWeekend) td.classList.add('is-weekend');
        row.appendChild(td);
      });
      tbody.appendChild(row);
    }
  }
  table.appendChild(tbody);
  return table;
}

function renderTableCell(slot, dateKey, time) {
  const datetime = `${dateKey}T${time}`;
  const td = el('td', { class: `slot slot-${slot.status}`, dataset: { datetime } });

  if (state.isAdmin) {
    if (slot.status === 'booked') {
      td.appendChild(el('span', { class: 'cell-name', title: slot.student_name || '' }, slot.student_name || '學生'));
    } else if (slot.status === 'blocked') {
      td.appendChild(el('span', { class: 'cell-icon' }, '⛔'));
    }
    td.addEventListener('click', () => onAdminSlotClick(slot, datetime));
  } else {
    if (slot.status === 'mine') {
      td.appendChild(el('span', { class: 'cell-mine' }, '已約'));
    }
    if (slot.status === 'available') {
      td.addEventListener('click', () => onStudentBook(datetime, time));
    }
  }
  return td;
}

// =========================================================================
// 學生 — 預約
// =========================================================================
async function onStudentBook(datetime, time) {
  if (swipeMoved) return;
  const dateKey = datetime.split('T')[0];
  const dateLabel = formatDateLabel(dateKey);
  if (!confirm(`確定預約 ${dateLabel} ${time} 嗎?\n\n預約後無法自行取消,需聯絡老師。`)) return;
  // 樂觀更新:先改 UI,再背景發 API
  const snap = snapshotSlot(datetime);
  mutateSlot(datetime, { status: 'mine' });
  renderMain();
  try {
    const res = await api.post('book', { code: state.inviteCode, datetime });
    if (res.ok) {
      toast('預約成功');
    } else {
      toast('預約失敗:' + humanError(res.error, res.msg), 'error');
      restoreSlot(datetime, snap);
      renderMain();
    }
  } catch (err) {
    toast('連線失敗:' + err.message, 'error');
    restoreSlot(datetime, snap);
    renderMain();
  }
}

// =========================================================================
// 老師 — slot 點擊路由
// =========================================================================
async function onAdminSlotClick(slot, datetime) {
  if (swipeMoved) return;

  if (rescheduleFromDt) {
    if (rescheduleFromDt === datetime) { cancelReschedule(); return; }
    if (slot.status !== 'available') { toast('改期目標必須是可選(白色)時段', 'error'); return; }
    await doReschedule(rescheduleFromDt, datetime);
    return;
  }

  if (slot.status === 'available') await adminToggleBlock(datetime, true);
  else if (slot.status === 'blocked') await adminToggleBlock(datetime, false);
  else if (slot.status === 'booked') openBookedMenu(slot, datetime);
}

async function adminToggleBlock(datetime, makeBlocked) {
  // 樂觀更新:先改 UI,再背景發 API
  const snap = snapshotSlot(datetime);
  mutateSlot(datetime, { status: makeBlocked ? 'blocked' : 'available' });
  renderMain();
  try {
    const action = makeBlocked ? 'block' : 'unblock';
    const res = await api.post(action, { admin_key: state.adminKey, datetime });
    if (res.ok) {
      toast(makeBlocked ? '已封鎖' : '已解除封鎖');
    } else {
      toast('失敗:' + humanError(res.error, res.msg), 'error');
      restoreSlot(datetime, snap);
      renderMain();
    }
  } catch (err) {
    toast('連線失敗:' + err.message, 'error');
    restoreSlot(datetime, snap);
    renderMain();
  }
}

function openBookedMenu(slot, datetime) {
  const dateKey = datetime.split('T')[0];
  const dateLabel = formatDateLabel(dateKey);
  const overlay = el('div', { class: 'modal-overlay' });
  overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });

  const modal = el('div', { class: 'modal' },
    el('h3', {}, `${dateLabel} ${slot.time}`),
    el('div', { class: 'modal-info' },
      el('div', {}, `學生:${slot.student_name || '(未填名)'}`),
      el('div', {}, '邀請碼:', el('code', {}, slot.invite_code || '-')),
    ),
    el('div', { class: 'modal-actions' },
      el('button', { class: 'btn-secondary', onclick: () => overlay.remove() }, '關閉'),
      el('button', { class: 'btn-secondary', onclick: () => { overlay.remove(); startReschedule(datetime, slot); } }, '改期'),
      el('button', { class: 'btn-danger', onclick: async () => { overlay.remove(); await adminUnbook(datetime); } }, '取消預約'),
    ),
  );
  overlay.appendChild(modal);
  document.body.appendChild(overlay);
}

async function adminUnbook(datetime) {
  if (!confirm('確定取消這位學生的預約嗎?\n(該時段會釋放為可選)')) return;
  // 樂觀更新:先改 UI,再背景發 API
  const snap = snapshotSlot(datetime);
  mutateSlot(datetime, { status: 'available', invite_code: '', student_name: '' });
  renderMain();
  try {
    const res = await api.post('unbook', { admin_key: state.adminKey, datetime });
    if (res.ok) {
      toast('已取消預約');
    } else {
      toast('失敗:' + humanError(res.error, res.msg), 'error');
      restoreSlot(datetime, snap);
      renderMain();
    }
  } catch (err) {
    toast('連線失敗:' + err.message, 'error');
    restoreSlot(datetime, snap);
    renderMain();
  }
}

function startReschedule(fromDt, slot) {
  rescheduleFromDt = fromDt;
  document.body.classList.add('reschedule-mode');
  showRescheduleBanner(slot);
  toast('請點選任一可選(白色)時段作為新時段');
}

function showRescheduleBanner(slot) {
  const existing = document.getElementById('reschedule-banner');
  if (existing) existing.remove();
  const fromLabel = rescheduleFromDt.replace('T', ' ');
  const banner = el('div', { class: 'banner banner-reschedule', id: 'reschedule-banner' },
    el('span', {}, `改期模式:從 ${fromLabel}${slot ? ` (${slot.student_name || '學生'})` : ''} 改到 → 請點目標時段`),
    el('button', { class: 'btn-link banner-cancel', onclick: cancelReschedule }, '取消'),
  );
  document.body.appendChild(banner);
}

function cancelReschedule() {
  rescheduleFromDt = null;
  document.body.classList.remove('reschedule-mode');
  const b = document.getElementById('reschedule-banner');
  if (b) b.remove();
}

async function doReschedule(fromDt, toDt) {
  const fromLabel = fromDt.replace('T', ' ');
  const toLabel = toDt.replace('T', ' ');
  if (!confirm(`確認改期?\n從:${fromLabel}\n到:${toLabel}`)) return;
  // 樂觀更新:from / to 都先改 UI 再背景發 API
  const fromSnap = snapshotSlot(fromDt);
  const toSnap = snapshotSlot(toDt);
  const studentInfo = fromSnap
    ? { invite_code: fromSnap.invite_code || '', student_name: fromSnap.student_name || '' }
    : { invite_code: '', student_name: '' };
  mutateSlot(fromDt, { status: 'available', invite_code: '', student_name: '' });
  mutateSlot(toDt, { status: 'booked', ...studentInfo });
  cancelReschedule();
  renderMain();
  try {
    const res = await api.post('reschedule', { admin_key: state.adminKey, from_dt: fromDt, to_dt: toDt });
    if (res.ok) {
      toast('已改期');
    } else {
      toast('改期失敗:' + humanError(res.error, res.msg), 'error');
      restoreSlot(fromDt, fromSnap);
      restoreSlot(toDt, toSnap);
      renderMain();
    }
  } catch (err) {
    toast('連線失敗:' + err.message, 'error');
    restoreSlot(fromDt, fromSnap);
    restoreSlot(toDt, toSnap);
    renderMain();
  }
}

// =========================================================================
// 老師 — 邀請碼管理
// =========================================================================
async function openStudentManager() {
  const overlay = el('div', { class: 'modal-overlay' });
  overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });

  const nameInput = el('input', { type: 'text', placeholder: '學生姓名(預設也當邀請碼)', autocomplete: 'off' });
  const codeInput = el('input', { type: 'text', placeholder: '自訂邀請碼(留空 = 用姓名)', autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false' });
  const emailInput = el('input', { type: 'email', placeholder: 'Email (選填)', autocomplete: 'off' });
  const createBtn = el('button', { class: 'btn-primary inline', onclick: async () => {
    const name = nameInput.value.trim();
    if (!name) { toast('請輸入姓名', 'error'); return; }
    createBtn.disabled = true;
    try {
      const res = await api.post('create_student', {
        admin_key: state.adminKey,
        name,
        email: emailInput.value.trim(),
        invite_code: codeInput.value.trim(),
      });
      if (res.ok) {
        toast(`已建立邀請碼:${res.data.invite_code}`);
        nameInput.value = '';
        codeInput.value = '';
        emailInput.value = '';
        reloadStudentList();
      } else {
        toast('失敗:' + humanError(res.error, res.msg), 'error');
      }
    } catch (err) {
      toast('連線失敗:' + err.message, 'error');
    } finally {
      createBtn.disabled = false;
    }
  } }, '建立邀請碼');

  const list = el('div', { class: 'student-list', id: 'student-list' }, '載入中...');

  const modal = el('div', { class: 'modal modal-wide' },
    el('h3', {}, '邀請碼管理'),
    el('p', { class: 'modal-hint' }, '邀請碼預設 = 姓名(若姓名是中文或特殊字,會自動產生 8 字隨機碼)。建立後點「複製」把碼傳給學生。'),
    el('div', { class: 'create-form' }, nameInput, codeInput, emailInput, createBtn),
    el('h4', {}, '學生列表'),
    list,
    el('div', { class: 'modal-actions' },
      el('button', { class: 'btn-secondary', onclick: () => overlay.remove() }, '關閉'),
    ),
  );
  overlay.appendChild(modal);
  document.body.appendChild(overlay);
  reloadStudentList();
}

async function reloadStudentList() {
  const list = $('#student-list');
  if (!list) return;
  list.innerHTML = '';
  list.appendChild(el('div', { class: 'empty-msg' }, '載入中...'));
  try {
    const res = await api.get('list_students', { admin_key: state.adminKey });
    list.innerHTML = '';
    if (!res.ok) {
      list.appendChild(el('div', { class: 'error-msg' }, '載入失敗:' + humanError(res.error, res.msg)));
      return;
    }
    const students = res.data.students || [];
    if (!students.length) {
      list.appendChild(el('div', { class: 'empty-msg' }, '尚無學生'));
      return;
    }
    students.forEach(s => {
      list.appendChild(el('div', { class: 'student-row' },
        el('div', { class: 'student-info' },
          el('div', { class: 'student-name' }, s.name),
          el('div', { class: 'student-email' }, s.email || ''),
        ),
        el('div', { class: 'student-code' },
          el('code', {}, s.invite_code),
          el('button', { class: 'btn-link', onclick: () => copyCode(s.invite_code) }, '複製'),
          el('button', { class: 'btn-link student-del', onclick: () => deleteStudentClick(s.invite_code, s.name) }, '刪除'),
        ),
      ));
    });
  } catch (err) {
    list.innerHTML = '';
    list.appendChild(el('div', { class: 'error-msg' }, '連線失敗:' + err.message));
  }
}

async function deleteStudentClick(code, name) {
  if (!confirm(`確定刪除「${name}」(${code}) 的邀請碼嗎?\n\n注意:已有的預約會留在月曆上(顯示原名)。如要清掉請手動取消那些預約。`)) return;
  try {
    const res = await api.post('delete_student', { admin_key: state.adminKey, invite_code: code });
    if (res.ok) {
      toast(`已刪除:${res.data.name || code}`);
      reloadStudentList();
    } else {
      toast('失敗:' + humanError(res.error, res.msg), 'error');
    }
  } catch (err) {
    toast('連線失敗:' + err.message, 'error');
  }
}

function copyCode(code) {
  if (navigator.clipboard) {
    navigator.clipboard.writeText(code).then(
      () => toast('已複製:' + code),
      () => toast('複製失敗,請手動選取', 'error'),
    );
  } else {
    toast('瀏覽器不支援自動複製,請手動選取', 'error');
  }
}

// =========================================================================
// 預約總覽
// =========================================================================
function openSummary() {
  const overlay = el('div', { class: 'modal-overlay' });
  overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });
  const modal = el('div', { class: 'modal modal-wide' });

  if (state.isAdmin) {
    modal.appendChild(el('h3', {}, '預約總覽 — 全體學生'));
    modal.appendChild(el('p', { class: 'modal-hint' }, '依預約次數從多到少排序。點某時段可跳到該週查看。'));
    modal.appendChild(renderAdminSummary(overlay));
  } else {
    modal.appendChild(el('h3', {}, '我的預約'));
    modal.appendChild(el('p', { class: 'modal-hint' }, '依時間排序。點某時段可跳到該週查看。'));
    modal.appendChild(renderStudentSummary(overlay));
  }

  modal.appendChild(el('div', { class: 'modal-actions' },
    el('button', { class: 'btn-secondary', onclick: () => overlay.remove() }, '關閉'),
  ));
  overlay.appendChild(modal);
  document.body.appendChild(overlay);
}

function collectBookings() {
  const out = [];
  if (!state.calendar) return out;
  Object.entries(state.calendar).forEach(([dateKey, slots]) => {
    slots.forEach(s => {
      if (state.isAdmin) {
        if (s.status === 'booked') out.push({ ...s, dateKey, datetime: `${dateKey}T${s.time}` });
      } else {
        if (s.status === 'mine') out.push({ ...s, dateKey, datetime: `${dateKey}T${s.time}` });
      }
    });
  });
  return out;
}

function renderAdminSummary(overlay) {
  const wrap = el('div', { class: 'summary-list' });
  const all = collectBookings();
  if (!all.length) {
    wrap.appendChild(el('div', { class: 'empty-msg' }, '目前無學生預約'));
    return wrap;
  }
  const groups = {};
  all.forEach(b => {
    const key = b.invite_code || '(unknown)';
    if (!groups[key]) groups[key] = { name: b.student_name || '(未填名)', code: key, bookings: [] };
    groups[key].bookings.push(b);
  });
  const sorted = Object.values(groups).sort((a, b) => b.bookings.length - a.bookings.length);
  sorted.forEach(g => {
    const merged = mergeConsecutive(g.bookings);
    const totalHours = (g.bookings.length * 0.5).toFixed(1).replace(/\.0$/, '');
    wrap.appendChild(el('div', { class: 'summary-student' },
      el('div', { class: 'summary-student-head' },
        el('span', { class: 'summary-student-name' }, g.name),
        el('code', {}, g.code),
        el('span', { class: 'summary-count' }, `${merged.length} 段 · 共 ${totalHours} 小時`),
      ),
      el('ul', { class: 'summary-bookings' },
        ...merged.map(grp => el('li', {
          onclick: () => { jumpToWeek(grp.dateKey); overlay.remove(); },
        }, formatGroupLabel(grp))),
      ),
    ));
  });
  return wrap;
}

function renderStudentSummary(overlay) {
  const wrap = el('div', { class: 'summary-list' });
  const all = collectBookings();
  if (!all.length) {
    wrap.appendChild(el('div', { class: 'empty-msg' }, '你目前沒有預約'));
    return wrap;
  }
  const merged = mergeConsecutive(all);
  const totalHours = (all.length * 0.5).toFixed(1).replace(/\.0$/, '');
  wrap.appendChild(el('div', { class: 'summary-student' },
    el('div', { class: 'summary-student-head' },
      el('span', { class: 'summary-student-name' }, state.studentName),
      el('span', { class: 'summary-count' }, `${merged.length} 段 · 共 ${totalHours} 小時`),
    ),
    el('ul', { class: 'summary-bookings' },
      ...merged.map(grp => el('li', {
        onclick: () => { jumpToWeek(grp.dateKey); overlay.remove(); },
      }, formatGroupLabel(grp))),
    ),
  ));
  return wrap;
}

function timeToMinutes(t) {
  const [h, m] = t.split(':').map(Number);
  return h * 60 + m;
}

function minutesToTime(mins) {
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

// 把同學生連續半小時的預約合併成一段
//   input:  [{ dateKey, time, datetime, invite_code, student_name }, ...]
//   output: [{ dateKey, startTime, endTime, datetime(=第一格的), ... }, ...]
function mergeConsecutive(bookings) {
  if (!bookings.length) return [];
  const sorted = [...bookings].sort((a, b) => a.datetime.localeCompare(b.datetime));
  const groups = [];
  let cur = null;
  for (const b of sorted) {
    const startMin = timeToMinutes(b.time);
    const endMin = startMin + 30;
    if (cur && cur.dateKey === b.dateKey && cur.endMin === startMin) {
      cur.endMin = endMin;
    } else {
      if (cur) groups.push(cur);
      cur = {
        dateKey: b.dateKey,
        startMin,
        endMin,
        invite_code: b.invite_code,
        student_name: b.student_name,
        datetime: b.datetime,
      };
    }
  }
  if (cur) groups.push(cur);
  return groups.map(g => ({
    ...g,
    startTime: minutesToTime(g.startMin),
    endTime: minutesToTime(g.endMin),
  }));
}

function formatGroupLabel(g) {
  const [y, m, d] = g.dateKey.split('-').map(Number);
  const wk = WEEKDAYS[new Date(y, m - 1, d).getDay()];
  return `${m}/${d} (週${wk}) ${g.startTime}–${g.endTime}`;
}

function jumpToWeek(dateKey) {
  if (!state.weeks) return;
  const idx = state.weeks.findIndex(w => w.days.some(d => d.dateKey === dateKey));
  if (idx >= 0 && idx !== state.selectedWeek) {
    state.selectedWeek = idx;
    renderMain();
  }
}

// =========================================================================
// Mock 模式 — `?mock=1` 啟用,資料只存記憶體,重整還原
// =========================================================================
const mockData = {
  adminKey: 'admin',
  students: [
    { invite_code: 'Andrew', name: 'Andrew', email: 'andrew@example.com', created_at: new Date().toISOString() },
    { invite_code: 'Bob', name: 'Bob', email: '', created_at: new Date().toISOString() },
  ],
  slots: {
    '2026-06-01T10:00': { status: 'blocked' },
    '2026-06-01T10:30': { status: 'blocked' },
    '2026-06-01T11:00': { status: 'blocked' },
    '2026-06-02T14:00': { status: 'booked', invite_code: 'Andrew', student_name: 'Andrew' },
    '2026-06-02T14:30': { status: 'booked', invite_code: 'Andrew', student_name: 'Andrew' },
    '2026-06-08T19:00': { status: 'booked', invite_code: 'Bob', student_name: 'Bob' },
    '2026-06-15T09:00': { status: 'blocked' },
    '2026-06-15T09:30': { status: 'blocked' },
    '2026-06-22T20:00': { status: 'booked', invite_code: 'Andrew', student_name: 'Andrew' },
    '2026-07-04T15:00': { status: 'booked', invite_code: 'Bob', student_name: 'Bob' },
    '2026-07-15T10:00': { status: 'blocked' },
    '2026-08-01T09:00': { status: 'blocked' },
    '2026-08-01T09:30': { status: 'blocked' },
    '2026-08-01T10:00': { status: 'blocked' },
  },
};

function isMockMode() {
  return new URLSearchParams(location.search).get('mock') === '1';
}

function showMockBanner() {
  if (!isMockMode()) return;
  const existing = document.querySelector('.mock-banner');
  if (existing) existing.remove();

  const roleLabel = state.isAdmin ? '老師' : (state.studentName ? `學生 (${state.studentName})` : '學生(未登入)');
  const switchLabel = state.isAdmin ? '切換為學生' : '切換為老師';

  const banner = el('div', { class: 'mock-banner' },
    el('div', { class: 'mock-line' },
      '⚠️ 示範模式 · 身份:',
      el('strong', {}, roleLabel),
      el('button', { class: 'mock-switch-btn', onclick: switchMockRole }, switchLabel),
      el('button', { class: 'mock-reset-btn', onclick: resetMockState }, '重置示範資料'),
    ),
    el('div', { class: 'mock-line mock-hint-line' },
      '預設學生碼:',
      el('code', {}, 'Andrew'),
      ' / ',
      el('code', {}, 'Bob'),
      ' · 也可以用老師後台「管理邀請碼」自己建',
    ),
  );
  document.body.insertBefore(banner, document.body.firstChild);
}

function switchMockRole() {
  if (state.isAdmin) {
    state.isAdmin = false;
    state.adminKey = '';
    document.body.classList.remove('admin-mode');
    history.replaceState(null, '', location.pathname + '?mock=1');
    state.inviteCode = '';
    state.studentName = '';
    state.calendar = null;
    storage.clearInviteCode();
    renderLogin();
  } else {
    state.isAdmin = true;
    state.adminKey = 'admin';
    document.body.classList.add('admin-mode');
    history.replaceState(null, '', location.pathname + '?mock=1&admin=admin');
    storage.clearInviteCode();
    state.inviteCode = '';
    state.studentName = '';
    state.calendar = null;
    state.weeks = null;
    state.selectedWeek = null;
    loadAdminCalendar().then(ok => { if (ok) renderMain(); });
  }
}

function resetMockState() {
  if (!confirm('確定重置示範資料?\n\n所有在 mock 模式建立的學生 / 預約 / 封鎖都會清除,還原到初始示範狀態。')) return;
  localStorage.removeItem(MOCK_STORAGE_KEY);
  storage.clearInviteCode();
  location.reload();
}

const MOCK_STORAGE_KEY = 'booking_mock_state_v1';

function loadMockState() {
  try {
    const raw = localStorage.getItem(MOCK_STORAGE_KEY);
    if (!raw) return false;
    const saved = JSON.parse(raw);
    if (saved.students) mockData.students = saved.students;
    if (saved.slots) mockData.slots = saved.slots;
    return true;
  } catch (e) {
    return false;
  }
}

function saveMockState() {
  try {
    localStorage.setItem(MOCK_STORAGE_KEY, JSON.stringify({
      students: mockData.students,
      slots: mockData.slots,
    }));
  } catch (e) {
    console.warn('saveMockState failed:', e);
  }
}

const MOCK_MUTATING_ACTIONS = new Set([
  'book', 'block', 'unblock', 'unbook', 'reschedule', 'create_student', 'delete_student',
]);

function installMockApi() {
  loadMockState(); // 載入既有狀態(若無則保留 mockData 預設)
  api.get = async (action, params = {}) => { await mockSleep(); return mockHandleWithSave(action, params, null); };
  api.post = async (action, body = {}) => { await mockSleep(); return mockHandleWithSave(action, null, body); };
}

function mockHandleWithSave(action, params, body) {
  const result = mockHandle(action, params, body);
  if (result && result.ok && MOCK_MUTATING_ACTIONS.has(action)) saveMockState();
  return result;
}

const mockSleep = () => new Promise(r => setTimeout(r, 120));

function mockHandle(action, params, body) {
  switch (action) {
    case 'ping':           return { ok: true, data: { pong: true, mock: true } };
    case 'get_calendar':   return mockGetCalendar(params.code);
    case 'admin_calendar': return mockAdminCalendar(params.admin_key);
    case 'list_students':  return mockListStudents(params.admin_key);
    case 'book':           return mockBook(body.code, body.datetime);
    case 'block':          return mockSetBlocked(body.admin_key, body.datetime, true);
    case 'unblock':        return mockSetBlocked(body.admin_key, body.datetime, false);
    case 'unbook':         return mockUnbook(body.admin_key, body.datetime);
    case 'reschedule':     return mockReschedule(body.admin_key, body.from_dt, body.to_dt);
    case 'create_student': return mockCreateStudent(body.admin_key, body.name, body.email, body.invite_code);
    case 'delete_student': return mockDeleteStudent(body.admin_key, body.invite_code);
    default:               return { ok: false, error: 'unknown_action' };
  }
}

function mockEnumerateAllSlots() {
  const out = [];
  const months = [
    { year: 2026, month: 6, days: 30 },
    { year: 2026, month: 7, days: 31 },
    { year: 2026, month: 8, days: 31 },
  ];
  months.forEach(({ year, month, days }) => {
    for (let d = 1; d <= days; d++) {
      const dateKey = `${year}-${String(month).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
      for (let h = HOURS_START; h < HOURS_END; h++) {
        for (let m = 0; m < 60; m += SLOT_MINUTES) {
          const time = `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
          out.push({ dateKey, time, datetime: `${dateKey}T${time}` });
        }
      }
    }
  });
  return out;
}

function findMockStudent(code) {
  if (!code) return null;
  const target = String(code).trim().toLowerCase();
  return mockData.students.find(s => String(s.invite_code).toLowerCase() === target);
}

function mockGetCalendar(code) {
  const student = findMockStudent(code);
  if (!student) return { ok: false, error: 'invalid_code' };
  const myCodeLower = String(student.invite_code).toLowerCase();
  const days = {};
  mockEnumerateAllSlots().forEach(({ dateKey, time, datetime }) => {
    const slot = mockData.slots[datetime] || { status: 'available' };
    let view;
    if (slot.status === 'available') view = 'available';
    else if (slot.status === 'booked' && String(slot.invite_code).toLowerCase() === myCodeLower) view = 'mine';
    else view = 'unavailable';
    if (!days[dateKey]) days[dateKey] = [];
    days[dateKey].push({ time, status: view });
  });
  return { ok: true, data: { days, student: { name: student.name, code: student.invite_code } } };
}

function mockAdminCalendar(adminKey) {
  if (adminKey !== mockData.adminKey) return { ok: false, error: 'admin_key invalid' };
  const days = {};
  mockEnumerateAllSlots().forEach(({ dateKey, time, datetime }) => {
    const slot = mockData.slots[datetime] || { status: 'available' };
    if (!days[dateKey]) days[dateKey] = [];
    days[dateKey].push({
      time,
      status: slot.status,
      invite_code: slot.invite_code || '',
      student_name: slot.student_name || '',
    });
  });
  return { ok: true, data: { days } };
}

function mockBook(code, datetime) {
  const student = findMockStudent(code);
  if (!student) return { ok: false, error: 'invalid_code' };
  const slot = mockData.slots[datetime];
  if (slot && slot.status !== 'available') return { ok: false, error: 'slot_taken' };
  // 寫入用 sheet 裡的原始大小寫
  mockData.slots[datetime] = { status: 'booked', invite_code: student.invite_code, student_name: student.name };
  return { ok: true, data: { datetime, status: 'mine', student_name: student.name } };
}

function mockSetBlocked(adminKey, datetime, makeBlocked) {
  if (adminKey !== mockData.adminKey) return { ok: false, error: 'admin_key invalid' };
  if (makeBlocked) {
    const slot = mockData.slots[datetime];
    if (slot && slot.status === 'booked') return { ok: false, error: 'slot_booked_cannot_block' };
    mockData.slots[datetime] = { status: 'blocked' };
    return { ok: true, data: { datetime, status: 'blocked' } };
  }
  const slot = mockData.slots[datetime];
  if (!slot || slot.status !== 'blocked') return { ok: false, error: 'slot_not_blocked' };
  delete mockData.slots[datetime];
  return { ok: true, data: { datetime, status: 'available' } };
}

function mockUnbook(adminKey, datetime) {
  if (adminKey !== mockData.adminKey) return { ok: false, error: 'admin_key invalid' };
  const slot = mockData.slots[datetime];
  if (!slot || slot.status !== 'booked') return { ok: false, error: 'slot_not_booked' };
  delete mockData.slots[datetime];
  return { ok: true, data: { datetime, status: 'available' } };
}

function mockReschedule(adminKey, fromDt, toDt) {
  if (adminKey !== mockData.adminKey) return { ok: false, error: 'admin_key invalid' };
  const fromSlot = mockData.slots[fromDt];
  if (!fromSlot || fromSlot.status !== 'booked') return { ok: false, error: 'from_not_booked' };
  const toSlot = mockData.slots[toDt];
  if (toSlot && toSlot.status !== 'available') return { ok: false, error: 'to_not_available' };
  mockData.slots[toDt] = { status: 'booked', invite_code: fromSlot.invite_code, student_name: fromSlot.student_name };
  delete mockData.slots[fromDt];
  return { ok: true, data: { from: fromDt, to: toDt } };
}

function mockCreateStudent(adminKey, name, email, customCode) {
  if (adminKey !== mockData.adminKey) return { ok: false, error: 'admin_key invalid' };
  if (!name || !name.trim()) return { ok: false, error: 'missing_name' };
  const trimmedName = name.trim();
  const codeFormat = /^[A-Za-z0-9_-]{1,30}$/;
  const codeExists = c => mockData.students.some(s => s.invite_code.toLowerCase() === c.toLowerCase());

  let code;
  if (customCode && customCode.trim()) {
    code = customCode.trim();
    if (!codeFormat.test(code)) return { ok: false, error: 'invalid_code_format' };
    if (codeExists(code)) return { ok: false, error: 'code_taken' };
  } else if (codeFormat.test(trimmedName) && !codeExists(trimmedName)) {
    code = trimmedName;
  } else {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    do {
      code = '';
      for (let i = 0; i < 8; i++) code += chars.charAt(Math.floor(Math.random() * chars.length));
    } while (codeExists(code));
  }

  mockData.students.push({
    invite_code: code,
    name: trimmedName,
    email: (email || '').trim(),
    created_at: new Date().toISOString(),
  });
  return { ok: true, data: { invite_code: code, name: trimmedName, email: email || '' } };
}

function mockDeleteStudent(adminKey, code) {
  if (adminKey !== mockData.adminKey) return { ok: false, error: 'admin_key invalid' };
  if (!code) return { ok: false, error: 'missing_code' };
  const target = String(code).trim().toLowerCase();
  const idx = mockData.students.findIndex(s => s.invite_code.toLowerCase() === target);
  if (idx < 0) return { ok: false, error: 'student_not_found' };
  const removed = mockData.students.splice(idx, 1)[0];
  return { ok: true, data: { deleted: removed.invite_code, name: removed.name } };
}

function mockListStudents(adminKey) {
  if (adminKey !== mockData.adminKey) return { ok: false, error: 'admin_key invalid' };
  return { ok: true, data: { students: mockData.students.slice() } };
}

// =========================================================================
// Boot
// =========================================================================
init();
