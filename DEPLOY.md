# 部署指引

依序跑完 A → B → C,大約 15 分鐘可以全部完成。

---

## A. 後端 (Google Apps Script + Google Sheets)

1. 開 https://drive.google.com,新建一個 Google 試算表(名稱隨意,例如「課程預約後端」)
2. 在試算表內,點 **擴充功能 → Apps Script** 開啟編輯器
3. 把 `gas/Code.gs` 整個內容貼到編輯器(取代預設的 `function myFunction()`)
4. 按 ⌘+S 儲存(專案名稱建議 `booking-system-backend`)
5. 設定老師碼:點左側 **專案設定**(齒輪圖示)→ 滑到下方 **指令碼屬性** → **新增指令碼屬性**
   - 屬性名:`ADMIN_KEY`
   - 值:你自選的 8 字以上英數字串(這就是你的老師後台密碼)
   - 按 **儲存指令碼屬性**
6. 回到 **編輯器**,從上方下拉選單選 `initializeSheets`,按 **執行**
   - 第一次執行會跳授權對話框 → 選你的 Google 帳號 → 點「進階」→「前往(不安全)」→ 允許
   - 等約 30 秒,執行記錄會顯示 `init done: 2392 slot rows generated`
   - 切回試算表分頁,會看到 `slots` 跟 `students` 兩張新 sheet,slots 已填 2392 row
7. 部署 Web App:點右上 **部署 → 新增部署作業**
   - 點齒輪圖示選 **網頁應用程式**
   - 說明:隨意(例如 `v1`)
   - 執行身分:**我**(你的 Google 帳號)
   - 可存取的人:**任何人**(不是「擁有 Google 帳戶的任何人」,要選沒有條件那個)
   - 按 **部署** → 跳出 URL,**複製這個 URL**(最後是 `/exec`)

---

## B. 前端 (GitHub Pages)

1. 開啟 `app.js`,把第 11 行的 `API_BASE` 填上剛剛複製的 URL:
   ```js
   const API_BASE = 'https://script.google.com/macros/s/.../exec';
   ```
2. 在 Terminal:
   ```sh
   cd ~/Documents/Projects/booking-system
   git add app.js
   git commit -m "config: set API_BASE for production"
   ```
3. 在 GitHub 建一個新 repo(public 即可,Pages 才能直接用)
4. 推上去:
   ```sh
   git remote add origin https://github.com/<你的帳號>/booking-system.git
   git push -u origin main
   ```
5. 在 GitHub repo → **Settings** → **Pages** → Source 選 **Deploy from a branch**,Branch 選 **main / (root)** → Save
6. 等 1–2 分鐘,Pages 會給你 URL:`https://<你的帳號>.github.io/booking-system/`

---

## C. 測試

### 老師端
1. 訪問 `https://<你的 Pages>/?admin=<你的 ADMIN_KEY>`
2. 應該看到三個月的月曆(目前每天都是「26 可選」綠標)
3. 點任一天 → 抽屜彈出 26 個白色時段
4. 點任一個白色時段 → 變成黃色 (已封鎖)
5. 再點一次 → 變回白色
6. 右上點 **管理邀請碼** → 輸入測試學生姓名(例如「測試 A」)→ 建立 → 看到列表多一行 → 點 **複製** 把碼複製起來

### 學生端(用無痕視窗或另一個瀏覽器)
1. 訪問 `https://<你的 Pages>/`(不帶 `?admin`)
2. 看到登入框 → 貼上剛剛複製的邀請碼 → 登入
3. 應該看到三個月月曆,顏色與老師端不同(綠/灰/藍)
4. 點任一天 → 點任一綠色時段 → 確認 → 預約成功
5. 該時段變成藍色「已預約」,無法再點

### 老師端驗證
1. 重新整理老師後台分頁
2. 剛剛學生預約的時段應變成紅色,顯示學生姓名
3. 點該紅色時段 → 跳出選單(改期 / 取消預約 / 關閉)
4. 點 **改期** → 上方藍色 banner 出現 → 點任一白色時段 → 確認 → 改期成功

---

## D. 之後要新增邀請碼怎麼做?

老師後台 → **管理邀請碼** → 填姓名 → 建立 → **複製** → 給學生(LINE / Email)

也可以直接在 `students` sheet 手動編輯,但邀請碼要符合 8 字英數規則,而且得自己確保不重複。建議走介面。

---

## E. 之後要重新跑下一年(例如 2027 暑假)?

1. 在 `gas/Code.gs` 改 `RANGE_START` 跟 `RANGE_END` 兩個常數
2. 在 Apps Script 編輯器選 `_devResetSlots` → 執行
3. **警告**:`_devResetSlots` 會清空所有 slots(含學生現有預約)再重新填空白。如果還有未上的課就先記下來,跑完再手動 block / 通知學生重訂

學生資料(`students` sheet)不會被清,他們的舊邀請碼仍然可用。

---

## F. 卡住怎麼辦

**「admin_key invalid」** → 檢查指令碼屬性是否有 `ADMIN_KEY`,以及 URL 的 `?admin=` 後面值是否一樣

**`slots sheet 不存在`** → 回 GAS 編輯器再跑一次 `initializeSheets`

**瀏覽器 console 看到 CORS 錯誤** → 確認 Web App 部署時「可存取的人」選的是 **任何人**,不是「擁有 Google 帳戶的任何人」

**改了 `Code.gs` 但網站行為沒變** → GAS 改完要 **部署 → 管理部署 → 編輯(鉛筆)→ 版本選新版本 → 部署**(URL 不變,但版本要更新)

**換 ADMIN_KEY 之後舊網址還能用** → 老師關掉所有開著的老師後台分頁,改新的 URL 再開
