/**
 * 安卓系统返回键 / 返回手势 = 点一下游戏里的「返回」（ESC），同触屏「返回」键走共用核心（virtualKeys.js）。
 *
 * 安卓默认按返回会直接关掉 App，玩着误触就丢进度（用户 2026-10-04 定：改成游戏内返回）。
 * Capacitor 的 App 插件（@capacitor/app，装在 mobile/）一旦有人监听 backButton，就不再执行默认的退出。
 * 网页、桌面、iPhone 没有这个事件，什么都不做。
 */

const SOURCE = 'android-back';
/** 按下到松开的间隔：要跨过至少一帧，按住检测（Key.isDown）也能看到这一下。 */
const TAP_MS = 120;

/**
 * @param {object} opts
 * @param {{press: Function, release: Function}} opts.keys virtualKeys 核心
 */
export function installAndroidBack({ keys }) {
  const cap = typeof window === 'undefined' ? null : window.Capacitor;
  const app = cap?.Plugins?.App;
  if (cap?.getPlatform?.() !== 'android' || !app?.addListener) return;
  app.addListener('backButton', () => {
    keys.press('ESC', SOURCE);
    setTimeout(() => keys.release('ESC', SOURCE), TAP_MS);
  });
}
