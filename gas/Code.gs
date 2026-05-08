// booking-system — GAS Web App 後端
//
// 部署方式:
// 1. 在 Google Drive 建一個試算表(任意名稱),從該試算表的「擴充功能 → Apps Script」開啟編輯器,把本檔貼進去
// 2. 「專案設定 → 指令碼屬性」新增 ADMIN_KEY = <你自選的老師碼,例如 8 字英數>
// 3. 在編輯器手動執行一次 initializeSheets()(會建表 + 填 2392 row。第一次跑會跳授權對話框,允許即可)
// 4. 「部署 → 新增部署作業 → 類型=網頁應用程式」執行身分=我、可存取的人=任何人
// 5. 把產生的 Web App URL 貼到 app.js 的 API_BASE
// 6. 老師後台網址 = <pages-domain>/?admin=<ADMIN_KEY>

// === 常數 ===
const SLOTS_SHEET = 'slots';
const STUDENTS_SHEET = 'students';
const TZ = 'Asia/Taipei';

// 時段範圍(明年要重用要改這幾行)
const RANGE_START = '2026-06-01';
const RANGE_END = '2026-08-31';
const HOURS_START = 9;     // 09:00 第一格
const HOURS_END = 22;      // 最後一格 21:30(end exclusive)
const SLOT_MINUTES = 30;

const SLOT_HEADERS = ['datetime', 'status', 'invite_code', 'student_name', 'booked_at', 'notes'];
const STUDENT_HEADERS = ['invite_code', 'name', 'email', 'created_at', 'notes'];

// ===========================================================================
// HTTP 入口
// ===========================================================================
function doGet(e) {
  return route('GET', e || {}, null);
}

function doPost(e) {
  let body = {};
  if (e && e.postData && e.postData.contents) {
    try { body = JSON.parse(e.postData.contents); } catch (err) {
      return errResp('bad_json', err.message);
    }
  }
  return route('POST', e || {}, body);
}

function route(method, e, body) {
  const params = e.parameter || {};
  const action = (params.action || (body && body.action) || '').trim();
  try {
    switch (action) {
      case 'ping':           return okResp({ pong: true, method, time: new Date().toISOString() });
      case 'get_calendar':   return getCalendar(params.code);
      case 'admin_calendar': return adminCalendar(params.admin_key);
      case 'list_students':  return listStudents(params.admin_key);
      case 'book':           return book(body.code, body.datetime);
      case 'block':          return setBlocked(body.admin_key, body.datetime, true);
      case 'unblock':        return setBlocked(body.admin_key, body.datetime, false);
      case 'unbook':         return unbook(body.admin_key, body.datetime);
      case 'reschedule':     return reschedule(body.admin_key, body.from_dt, body.to_dt);
      case 'create_student': return createStudent(body.admin_key, body.name, body.email, body.invite_code);
      default:               return errResp('unknown_action', action);
    }
  } catch (err) {
    return errResp('exception', err.message || String(err));
  }
}

function okResp(data) {
  return ContentService
    .createTextOutput(JSON.stringify({ ok: true, data: data || {} }))
    .setMimeType(ContentService.MimeType.JSON);
}

function errResp(code, msg) {
  return ContentService
    .createTextOutput(JSON.stringify({ ok: false, error: code, msg: msg || '' }))
    .setMimeType(ContentService.MimeType.JSON);
}

// ===========================================================================
// Helpers
// ===========================================================================
function getSS() {
  return SpreadsheetApp.getActiveSpreadsheet();
}

function getAdminKey() {
  return PropertiesService.getScriptProperties().getProperty('ADMIN_KEY') || '';
}

function requireAdmin(key) {
  const expected = getAdminKey();
  if (!expected) throw new Error('ADMIN_KEY not configured in Script Properties');
  if (key !== expected) throw new Error('admin_key invalid');
}

// 把 Date 轉成 "yyyy-MM-ddTHH:mm" 字串(以 Asia/Taipei 解讀)
function isoFromDate(d) {
  return Utilities.formatDate(d, TZ, "yyyy-MM-dd'T'HH:mm");
}

// 讀整張 slots sheet,回傳 sheet 物件 + 原始 row 陣列 + iso → row 索引
function readSlots() {
  const sheet = getSS().getSheetByName(SLOTS_SHEET);
  if (!sheet) throw new Error(`${SLOTS_SHEET} sheet 不存在,請先執行 initializeSheets()`);
  const last = sheet.getLastRow();
  if (last < 2) return { sheet, rows: [], byIso: {} };
  const values = sheet.getRange(2, 1, last - 1, SLOT_HEADERS.length).getValues();
  const byIso = {};
  values.forEach((r, i) => {
    if (!(r[0] instanceof Date)) return;
    const iso = isoFromDate(r[0]);
    byIso[iso] = { rowIndex: i + 2, values: r, iso };
  });
  return { sheet, rows: values, byIso };
}

function findStudent(code) {
  if (!code) return null;
  const sheet = getSS().getSheetByName(STUDENTS_SHEET);
  if (!sheet) return null;
  const last = sheet.getLastRow();
  if (last < 2) return null;
  const target = String(code).trim().toLowerCase();
  const rows = sheet.getRange(2, 1, last - 1, STUDENT_HEADERS.length).getValues();
  for (const r of rows) {
    if (String(r[0]).trim().toLowerCase() === target) {
      return { invite_code: r[0], name: r[1], email: r[2] };
    }
  }
  return null;
}

function generateInviteCode() {
  // 排除易混字元 0/O/1/l/I
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 8; i++) {
    code += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return code;
}

// ===========================================================================
// Endpoints — 學生
// ===========================================================================
function getCalendar(code) {
  if (!code) return errResp('missing_code');
  const student = findStudent(code);
  if (!student) return errResp('invalid_code');

  const { rows } = readSlots();
  const days = {};
  rows.forEach(r => {
    if (!(r[0] instanceof Date)) return;
    const iso = isoFromDate(r[0]);
    const dateKey = iso.slice(0, 10);
    const time = iso.slice(11, 16);
    const status = r[1];
    const inviteCode = r[2];

    let view;
    if (status === 'available') view = 'available';
    else if (status === 'booked' && String(inviteCode).trim().toLowerCase() === String(code).trim().toLowerCase()) view = 'mine';
    else view = 'unavailable'; // blocked OR booked_by_others(學生眼中合併)

    if (!days[dateKey]) days[dateKey] = [];
    days[dateKey].push({ time, status: view });
  });
  return okResp({ days, student: { name: student.name, code } });
}

function book(code, datetime) {
  if (!code) return errResp('missing_code');
  if (!datetime) return errResp('missing_datetime');

  const lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) return errResp('busy_try_again');
  try {
    const student = findStudent(code);
    if (!student) return errResp('invalid_code');

    const { sheet, byIso } = readSlots();
    const slot = byIso[datetime];
    if (!slot) return errResp('slot_not_found', datetime);
    if (slot.values[1] !== 'available') {
      return errResp('slot_taken', `current status: ${slot.values[1]}`);
    }

    sheet.getRange(slot.rowIndex, 2, 1, 4).setValues([[
      'booked',
      student.invite_code, // 用 sheet 裡的原始大小寫,不用 user 輸入
      student.name,
      new Date(),
    ]]);
    return okResp({ datetime, status: 'mine', student_name: student.name });
  } finally {
    lock.releaseLock();
  }
}

// ===========================================================================
// Endpoints — 老師
// ===========================================================================
function adminCalendar(key) {
  requireAdmin(key);
  const { rows } = readSlots();
  const days = {};
  rows.forEach(r => {
    if (!(r[0] instanceof Date)) return;
    const iso = isoFromDate(r[0]);
    const dateKey = iso.slice(0, 10);
    const time = iso.slice(11, 16);
    if (!days[dateKey]) days[dateKey] = [];
    days[dateKey].push({
      time,
      status: r[1],
      invite_code: r[2] || '',
      student_name: r[3] || '',
    });
  });
  return okResp({ days });
}

function setBlocked(key, datetime, blocked) {
  requireAdmin(key);
  if (!datetime) return errResp('missing_datetime');

  const lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) return errResp('busy_try_again');
  try {
    const { sheet, byIso } = readSlots();
    const slot = byIso[datetime];
    if (!slot) return errResp('slot_not_found');

    const cur = slot.values[1];
    if (blocked) {
      if (cur === 'booked') return errResp('slot_booked_cannot_block', '請先 unbook 再 block');
      if (cur === 'blocked') return okResp({ datetime, status: 'blocked', noop: true });
      sheet.getRange(slot.rowIndex, 2).setValue('blocked');
      return okResp({ datetime, status: 'blocked' });
    } else {
      if (cur !== 'blocked') return errResp('slot_not_blocked', `current: ${cur}`);
      sheet.getRange(slot.rowIndex, 2, 1, 4).setValues([['available', '', '', '']]);
      return okResp({ datetime, status: 'available' });
    }
  } finally {
    lock.releaseLock();
  }
}

function unbook(key, datetime) {
  requireAdmin(key);
  if (!datetime) return errResp('missing_datetime');

  const lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) return errResp('busy_try_again');
  try {
    const { sheet, byIso } = readSlots();
    const slot = byIso[datetime];
    if (!slot) return errResp('slot_not_found');
    if (slot.values[1] !== 'booked') return errResp('slot_not_booked', `current: ${slot.values[1]}`);

    sheet.getRange(slot.rowIndex, 2, 1, 4).setValues([['available', '', '', '']]);
    return okResp({ datetime, status: 'available' });
  } finally {
    lock.releaseLock();
  }
}

function reschedule(key, fromDt, toDt) {
  requireAdmin(key);
  if (!fromDt || !toDt) return errResp('missing_datetime');
  if (fromDt === toDt) return errResp('same_slot');

  const lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) return errResp('busy_try_again');
  try {
    const { sheet, byIso } = readSlots();
    const fromSlot = byIso[fromDt];
    const toSlot = byIso[toDt];
    if (!fromSlot || !toSlot) return errResp('slot_not_found');
    if (fromSlot.values[1] !== 'booked') return errResp('from_not_booked');
    if (toSlot.values[1] !== 'available') return errResp('to_not_available', `target status: ${toSlot.values[1]}`);

    const code = fromSlot.values[2];
    const name = fromSlot.values[3];
    sheet.getRange(toSlot.rowIndex, 2, 1, 4).setValues([['booked', code, name, new Date()]]);
    sheet.getRange(fromSlot.rowIndex, 2, 1, 4).setValues([['available', '', '', '']]);
    return okResp({ from: fromDt, to: toDt, code, student_name: name });
  } finally {
    lock.releaseLock();
  }
}

function createStudent(key, name, email, customCode) {
  requireAdmin(key);
  if (!name || !String(name).trim()) return errResp('missing_name');

  const sheet = getSS().getSheetByName(STUDENTS_SHEET);
  if (!sheet) throw new Error(`${STUDENTS_SHEET} sheet 不存在,請先執行 initializeSheets()`);

  let code;
  if (customCode && String(customCode).trim()) {
    code = String(customCode).trim();
    // 限英文 / 數字 / _- 符號,1-30 字
    if (!/^[A-Za-z0-9_-]{1,30}$/.test(code)) {
      return errResp('invalid_code_format', '邀請碼僅限英數和 _- 符號,1-30 字');
    }
    if (findStudent(code)) {
      return errResp('code_taken', '此邀請碼已被使用');
    }
  } else {
    code = generateInviteCode();
    for (let i = 0; i < 5 && findStudent(code); i++) code = generateInviteCode();
  }

  sheet.appendRow([code, String(name).trim(), email ? String(email).trim() : '', new Date(), '']);
  return okResp({ invite_code: code, name: String(name).trim(), email: email || '' });
}

// 批次匯入學生(在 GAS 編輯器手動執行)
// 用法:_devBulkAddStudents([{invite_code:'Andrew', name:'陳小明'}, {invite_code:'Bob', name:'王大華'}])
// 或 _devBulkAddStudents([{invite_code:'Andrew'}, {invite_code:'Bob'}])(name 留空時取 invite_code)
function _devBulkAddStudents(arr) {
  const sheet = getSS().getSheetByName(STUDENTS_SHEET);
  if (!sheet) throw new Error(`${STUDENTS_SHEET} sheet 不存在`);
  const added = [];
  const skipped = [];
  arr.forEach(s => {
    const code = String(s.invite_code || '').trim();
    if (!code) { skipped.push({ s, reason: 'empty' }); return; }
    if (!/^[A-Za-z0-9_-]{1,30}$/.test(code)) { skipped.push({ s, reason: 'invalid_format' }); return; }
    if (findStudent(code)) { skipped.push({ s, reason: 'duplicate' }); return; }
    sheet.appendRow([code, String(s.name || code).trim(), String(s.email || '').trim(), new Date(), '']);
    added.push(code);
  });
  Logger.log(`added: ${added.length} (${added.join(', ')}) | skipped: ${skipped.length}`);
  if (skipped.length) Logger.log('skipped detail: ' + JSON.stringify(skipped));
  return { added, skipped };
}

function listStudents(key) {
  requireAdmin(key);
  const sheet = getSS().getSheetByName(STUDENTS_SHEET);
  if (!sheet) return okResp({ students: [] });
  const last = sheet.getLastRow();
  if (last < 2) return okResp({ students: [] });
  const rows = sheet.getRange(2, 1, last - 1, STUDENT_HEADERS.length).getValues();
  const students = rows.map(r => ({
    invite_code: r[0],
    name: r[1],
    email: r[2],
    created_at: r[3] instanceof Date ? isoFromDate(r[3]) : '',
    notes: r[4] || '',
  }));
  return okResp({ students });
}

// ===========================================================================
// 初始化(部署後在編輯器手動執行一次)
// ===========================================================================
function initializeSheets() {
  const ss = getSS();

  // ---- slots sheet ----
  let slotSh = ss.getSheetByName(SLOTS_SHEET);
  if (slotSh && slotSh.getLastRow() > 1) {
    throw new Error(`${SLOTS_SHEET} sheet 已有資料,請先手動清空 (避免覆蓋)。或刪掉整張 sheet 再跑。`);
  }
  if (!slotSh) slotSh = ss.insertSheet(SLOTS_SHEET);

  slotSh.clear();
  slotSh.getRange(1, 1, 1, SLOT_HEADERS.length).setValues([SLOT_HEADERS]);
  slotSh.setFrozenRows(1);

  const slotRows = generateSlotRows();
  slotSh.getRange(2, 1, slotRows.length, SLOT_HEADERS.length).setValues(slotRows);
  slotSh.getRange(2, 1, slotRows.length, 1).setNumberFormat('yyyy-MM-dd HH:mm');
  slotSh.getRange(2, 5, slotRows.length, 1).setNumberFormat('yyyy-MM-dd HH:mm');
  slotSh.setColumnWidth(1, 130);
  slotSh.setColumnWidth(2, 90);

  // ---- students sheet ----
  let stuSh = ss.getSheetByName(STUDENTS_SHEET);
  if (!stuSh) stuSh = ss.insertSheet(STUDENTS_SHEET);
  if (stuSh.getLastRow() < 1) {
    stuSh.getRange(1, 1, 1, STUDENT_HEADERS.length).setValues([STUDENT_HEADERS]);
    stuSh.setFrozenRows(1);
    stuSh.getRange(1, 4, 1, 1).setNumberFormat('yyyy-MM-dd HH:mm');
  }

  Logger.log(`init done: ${slotRows.length} slot rows generated`);
  return slotRows.length;
}

function generateSlotRows() {
  const rows = [];
  const startMs = new Date(`${RANGE_START}T12:00:00+08:00`).getTime();
  const endMs = new Date(`${RANGE_END}T12:00:00+08:00`).getTime();
  const dayCount = Math.round((endMs - startMs) / 86400000) + 1;

  for (let i = 0; i < dayCount; i++) {
    const dayDate = new Date(startMs + i * 86400000);
    const ymd = Utilities.formatDate(dayDate, TZ, 'yyyy-MM-dd');
    for (let h = HOURS_START; h < HOURS_END; h++) {
      for (let m = 0; m < 60; m += SLOT_MINUTES) {
        const hh = String(h).padStart(2, '0');
        const mm = String(m).padStart(2, '0');
        const dt = new Date(`${ymd}T${hh}:${mm}:00+08:00`);
        rows.push([dt, 'available', '', '', '', '']);
      }
    }
  }
  return rows;
}

// ===========================================================================
// 開發者工具(編輯器手動執行,協助除錯/重置)
// ===========================================================================
function _devSetAdminKey(key) {
  // 在編輯器執行 _devSetAdminKey('YOUR_KEY') 可快速設老師碼
  PropertiesService.getScriptProperties().setProperty('ADMIN_KEY', key);
  Logger.log('ADMIN_KEY set');
}

function _devResetSlots() {
  // 危險:清空所有 slots(含學生預約)並重新填 2392 row
  const ss = getSS();
  const sh = ss.getSheetByName(SLOTS_SHEET);
  if (sh) ss.deleteSheet(sh);
  initializeSheets();
}
