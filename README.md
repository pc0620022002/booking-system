# booking-system

一對一課程時間預約系統。老師(我)在後台 block 不能上課的時段、管理邀請碼;學生憑邀請碼進站預約半小時時段。

## 架構
- 前端:vanilla HTML/CSS/JS(GitHub Pages)
- 後端:Google Apps Script Web App
- 資料層:Google Sheets(`slots` + `students` 兩張)

## 使用方式
- 老師:`https://<your-pages>/?admin=<ADMIN_KEY>`
- 學生:`https://<your-pages>/`,用邀請碼登入

## 部署
詳見 [DEPLOY.md](DEPLOY.md)。
