/**
 * 画面提示里的按键名，按当前输入方式给（2026-10-03 用户：手机上「空格 交谈」应写「確認 交谈」）。
 * 触屏（touchControls 挂上时 body 带 `touch-ui`）用屏幕按键上的字；否则仍是键盘键名。
 */
import { LANGUAGE } from './language.js';

const touchUi = () => typeof document !== 'undefined' && document.body?.classList.contains('touch-ui');

/** 确认键的名字。纯函数（参数可注入，便于测试）。 */
export function confirmHint(touch = touchUi(), language = LANGUAGE) {
  if (!touch) return '空格';
  return language === '简' ? '确认' : '確認';
}

/** 返回键的名字。 */
export function backHint(touch = touchUi()) {
  return touch ? '返回' : 'ESC';
}
