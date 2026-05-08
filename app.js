// booking-system — 前端
// 流程:
//   1. 判斷 ?admin=xxx → 老師模式 / 否則 → 學生模式
//   2. 學生先試用 localStorage 邀請碼,失敗才顯示登入框
//   3. 載入月曆 → 渲染 3 個月並排月曆 + 抽屜
//   4. 點時段 → 學生:預約 / 老師:block toggle 或開選單(取消、改期)

// =========================================================================
// 設定 — 部署後請把 GAS Web App URL 填進來
// =========================================================================
const API_BASE = '';

// =========================================================================
// State
// =========================================================================
const state = {
  isAdmin: false,
  adminKey: '',
  inviteCode: '',
  studentName: '',
  calendar: null,
  selectedDate: null,
};

// 改期模式:點老師後台中已預約時段 → 改期 → 設這個值 → 下一次點 available 時段就觸發改期 API
let rescheduleFromDt = null;

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
    'unknown_action': '不支援的動作',
    'admin_key invalid': '老師碼錯誤',
    'admin_key invalid (admin_key invalid)': '老師碼錯誤',
  };
  if (map[code]) return map[code];
  if (msg && msg.includes('admin_key invalid')) return '老師碼錯誤';
  if (msg && msg.includes('ADMIN_KEY not configured')) return 'GAS 端尚未設定 ADMIN_KEY';
  return msg ? `${code}: ${msg}` : code;
}

// =========================================================================
// Init
// =========================================================================
async function init() {
  if (!API_BASE) {
    renderSetupPage();
    return;
  }

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
      alert('無法載入老師後台:' + humanError(res.error, res.msg));
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
  // 如果 reschedule banner 在,重新加上
  if (rescheduleFromDt) showRescheduleBanner();
}

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
      '請依 DEPLOY.md 部署 GAS Web App,把 URL 填進 ',
      el('code', {}, 'app.js'),
      ' 的 ',
      el('code', {}, 'API_BASE'),
      ' 後再訪問。'),
  ));
}

// =========================================================================
// Render — Login (學生)
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
    if (blocked) stats.appendChild(el('span', { class: 'stat blocked', title: '我封鎖' }, String(blocked)));
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
  const titleEl = $('#drawer-title');
  if (titleEl) titleEl.textContent = formatDateLabel(dateKey);
  renderSlotGrid();
  const drawer = $('#drawer');
  if (drawer) drawer.classList.remove('hidden');
}

function closeDrawer() {
  state.selectedDate = null;
  const drawer = $('#drawer');
  if (drawer) drawer.classList.add('hidden');
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
  const btn = el('button', { class: `slot slot-${slot.status}`, dataset: { datetime } });
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
  const btn = el('button', { class: `slot slot-${slot.status}`, dataset: { datetime } });
  btn.appendChild(el('span', { class: 'slot-time' }, slot.time));
  if (slot.status === 'blocked') btn.appendChild(el('span', { class: 'slot-meta' }, '⛔ 已封鎖'));
  else if (slot.status === 'booked') btn.appendChild(el('span', { class: 'slot-meta' }, slot.student_name || '學生'));
  btn.addEventListener('click', () => onAdminSlotClick(slot, datetime));
  return btn;
}

// =========================================================================
// 學生功能 — 預約
// =========================================================================
async function onStudentBook(datetime, time) {
  const dateLabel = formatDateLabel(state.selectedDate);
  if (!confirm(`確定預約 ${dateLabel} ${time} 嗎?\n\n預約後無法自行取消,需聯絡老師。`)) return;
  try {
    const res = await api.post('book', { code: state.inviteCode, datetime });
    if (res.ok) {
      toast('預約成功');
    } else {
      toast('預約失敗:' + humanError(res.error, res.msg), 'error');
    }
  } catch (err) {
    toast('連線失敗:' + err.message, 'error');
  }
  // 不論結果都刷新(失敗可能因為時段已被搶走,要更新顯示)
  await refreshCalendar();
  if (state.selectedDate) openDrawer(state.selectedDate);
}

// =========================================================================
// 老師功能 — slot 點擊路由
// =========================================================================
async function onAdminSlotClick(slot, datetime) {
  // 改期模式:第二次點 → 選擇目標
  if (rescheduleFromDt) {
    if (rescheduleFromDt === datetime) {
      cancelReschedule();
      return;
    }
    if (slot.status !== 'available') {
      toast('改期目標必須是可選(白色)時段', 'error');
      return;
    }
    await doReschedule(rescheduleFromDt, datetime);
    return;
  }

  if (slot.status === 'available') {
    await adminToggleBlock(datetime, true);
  } else if (slot.status === 'blocked') {
    await adminToggleBlock(datetime, false);
  } else if (slot.status === 'booked') {
    openBookedMenu(slot, datetime);
  }
}

async function adminToggleBlock(datetime, makeBlocked) {
  try {
    const action = makeBlocked ? 'block' : 'unblock';
    const res = await api.post(action, { admin_key: state.adminKey, datetime });
    if (res.ok) {
      toast(makeBlocked ? '已封鎖時段' : '已解除封鎖');
    } else {
      toast('失敗:' + humanError(res.error, res.msg), 'error');
    }
  } catch (err) {
    toast('連線失敗:' + err.message, 'error');
  }
  await refreshCalendar();
  if (state.selectedDate) openDrawer(state.selectedDate);
}

// =========================================================================
// 老師功能 — 已預約 slot 選單
// =========================================================================
function openBookedMenu(slot, datetime) {
  const dateLabel = formatDateLabel(state.selectedDate);
  const overlay = el('div', { class: 'modal-overlay' });
  overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });

  const modal = el('div', { class: 'modal' },
    el('h3', {}, `${dateLabel} ${slot.time}`),
    el('div', { class: 'modal-info' },
      el('div', {}, `學生:${slot.student_name || '(未填名)'}`),
      el('div', {}, `邀請碼:`, el('code', {}, slot.invite_code || '-')),
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
  try {
    const res = await api.post('unbook', { admin_key: state.adminKey, datetime });
    if (res.ok) toast('已取消預約');
    else toast('失敗:' + humanError(res.error, res.msg), 'error');
  } catch (err) {
    toast('連線失敗:' + err.message, 'error');
  }
  await refreshCalendar();
  if (state.selectedDate) openDrawer(state.selectedDate);
}

// =========================================================================
// 老師功能 — 改期(兩階段:選目標 → 確認)
// =========================================================================
function startReschedule(fromDt, slot) {
  rescheduleFromDt = fromDt;
  document.body.classList.add('reschedule-mode');
  closeDrawer();
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
  try {
    const res = await api.post('reschedule', { admin_key: state.adminKey, from_dt: fromDt, to_dt: toDt });
    if (res.ok) {
      toast('已改期');
      cancelReschedule();
    } else {
      toast('改期失敗:' + humanError(res.error, res.msg), 'error');
    }
  } catch (err) {
    toast('連線失敗:' + err.message, 'error');
  }
  await refreshCalendar();
  if (state.selectedDate) openDrawer(state.selectedDate);
}

// =========================================================================
// 老師功能 — 邀請碼管理
// =========================================================================
async function openStudentManager() {
  const overlay = el('div', { class: 'modal-overlay' });
  overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });

  const nameInput = el('input', { type: 'text', placeholder: '學生姓名', id: 'new-student-name', autocomplete: 'off' });
  const emailInput = el('input', { type: 'email', placeholder: 'Email (選填)', id: 'new-student-email', autocomplete: 'off' });
  const createBtn = el('button', { class: 'btn-primary inline', onclick: async () => {
    const name = nameInput.value.trim();
    if (!name) { toast('請輸入姓名', 'error'); return; }
    createBtn.disabled = true;
    try {
      const res = await api.post('create_student', {
        admin_key: state.adminKey,
        name,
        email: emailInput.value.trim(),
      });
      if (res.ok) {
        toast(`已建立邀請碼:${res.data.invite_code}`);
        nameInput.value = '';
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
    el('p', { class: 'modal-hint' }, '建立新邀請碼,點「複製」把碼傳給學生。'),
    el('div', { class: 'create-form' }, nameInput, emailInput, createBtn),
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
        ),
      ));
    });
  } catch (err) {
    list.innerHTML = '';
    list.appendChild(el('div', { class: 'error-msg' }, '連線失敗:' + err.message));
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
// Boot
// =========================================================================
init();
