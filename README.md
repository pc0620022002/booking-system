# booking-system

一對一課程時間預約系統。老師在後台 block 不可預約時段,學生憑邀請碼進站預約半小時時段。

## Stack
- Frontend: vanilla HTML/CSS/JS (GitHub Pages)
- Backend: Google Apps Script Web App
- Storage: Google Sheets

## Usage
- Admin: `https://<your-pages-domain>/?admin=<ADMIN_KEY>`
- Student: `https://<your-pages-domain>/`,enter invite code

## Deploy
1. Create a Google Sheet, copy `gas/Code.gs` into Apps Script bound to that Sheet.
2. In Apps Script → Project Settings → Script Properties, add `ADMIN_KEY = <your-secret>`.
3. Run `initializeSheets()` once from the Apps Script editor.
4. Deploy as Web App (Execute as: Me, Access: Anyone).
5. Copy the Web App URL into `app.js` (`API_BASE`).
6. Push to GitHub, enable Pages.
