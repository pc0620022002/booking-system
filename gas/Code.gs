// booking-system — GAS Web App 後端
//
// 部署方式:
// 1. 在 Google Drive 建一個試算表,從該試算表的「擴充功能 → Apps Script」開啟編輯器,把本檔貼進去
// 2. 「專案設定 → 指令碼屬性」新增 ADMIN_KEY = <你的老師碼>
// 3. 在編輯器手動執行一次 initializeSheets()(會建表 + 填 2392 row)
// 4. 「部署 → 新增部署作業 → 網頁應用程式」執行身分=我、可存取的人=任何人
// 5. 把產生的 Web App URL 貼到 app.js 的 API_BASE

const SLOTS_SHEET = 'slots';
const STUDENTS_SHEET = 'students';
const TZ = 'Asia/Taipei';

// === HTTP 入口 ===
function doGet(e) {
  return route(e, 'GET');
}

function doPost(e) {
  return route(e, 'POST');
}

function route(e, method) {
  // TODO: Step 2 實作所有 endpoint:
  //   GET  ?action=get_calendar&code=...        → 學生看到的月曆 (mask 別人資料)
  //   GET  ?action=admin_calendar&admin_key=... → 老師看到的月曆 (含 student_name)
  //   POST { action: 'book', code, datetime }   → 學生預約
  //   POST { action: 'block' / 'unblock', admin_key, datetime }
  //   POST { action: 'unbook' / 'reschedule', admin_key, ... }
  //   POST { action: 'create_student', admin_key, name, email }
  //   GET  ?action=list_students&admin_key=...
  return jsonResponse({ ok: true, method, msg: 'router 待 Step 2 實作' });
}

function jsonResponse(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

// === 初始化(首次部署在編輯器手動執行一次)===
function initializeSheets() {
  // TODO: Step 2 實作
  //   - 建 slots / students 兩張 sheet (header)
  //   - 預先填 2026/6/1 ~ 2026/8/31 每天 09:00–22:00 半小時一格 (共 2392 row),status 預設 available
}
