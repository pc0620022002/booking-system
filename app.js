// booking-system — 前端入口
// 流程:邀請碼登入 → 月曆渲染 → 點某天 → 時段抽屜 → 預約 / 老師管理

// === 設定 ===
const API_BASE = ''; // TODO: Step 6 部署後填入 GAS Web App URL

// === 入口 ===
function main() {
  const params = new URLSearchParams(location.search);
  const adminKey = params.get('admin');
  const isAdmin = !!adminKey;

  const app = document.getElementById('app');
  // TODO: Step 3 之後實作 router(login screen / calendar)
  app.textContent = isAdmin ? '老師模式(待實作)' : '學生模式(待實作)';
}

main();
