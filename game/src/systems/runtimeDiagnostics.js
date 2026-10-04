/** 保留最近一次页面刷新/异常的原因，供排查偶发重载；不保存玩家存档内容。 */
const KEY = 'youcheng-runtime-events';
export function recordRuntimeEvent(type, detail = '') {
  try {
    const events = JSON.parse(sessionStorage.getItem(KEY) || '[]');
    events.push({ time: new Date().toISOString(), type, detail: String(detail).slice(0, 600) });
    sessionStorage.setItem(KEY, JSON.stringify(events.slice(-20)));
  } catch { /* 浏览器禁止会话存储时不能影响游戏。 */ }
}
export function installRuntimeDiagnostics(game) {
  recordRuntimeEvent('page-start', performance.getEntriesByType('navigation')[0]?.type);
  window.addEventListener('error', e => { if (e.message) recordRuntimeEvent('error', e.message); });
  window.addEventListener('unhandledrejection', e => recordRuntimeEvent('rejection', e.reason?.stack ?? e.reason));
  window.addEventListener('pagehide', () => recordRuntimeEvent('page-hide'));
  const watchCanvas = () => game.canvas.addEventListener('webglcontextlost', () => recordRuntimeEvent('webgl-context-lost'));
  if (game.canvas) watchCanvas(); else game.events.once('ready', watchCanvas);
  if (import.meta.hot) import.meta.hot.on('vite:beforeFullReload', payload => {
    recordRuntimeEvent('development-reload', payload.path);
    // Vite 7会等待此事件的Promise。游戏运行中保留当前版本，用户保存后手动刷新。
    // 标题页没有游戏进度，允许正常更新；不修改浏览器崩溃处理或吞游戏异常。
    if (!['Field', 'Battle', 'Loading'].some(key => game.scene.isActive(key))) return;
    if (!document.querySelector('.game-update-notice')) {
      const notice = document.createElement('div');
      notice.className = 'game-update-notice';
      notice.textContent = '版本已更新，請保存進度後刷新頁面。';
      Object.assign(notice.style, { position: 'fixed', top: '8px', left: '50%', transform: 'translateX(-50%)',
        padding: '7px 12px', background: '#24170e', color: '#dbc59e', zIndex: 10000, font: '14px serif' });
      document.body.append(notice);
    }
    return new Promise(() => {});
  });
}
