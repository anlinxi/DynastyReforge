import { HD_ENABLED, HD_STORAGE_KEY, inNativeApp } from './hdRender.js';
import { titleOptionColumn } from '../ui/titleColumn.js';

/**
 * 标题页“画面：高清/原版”（桌面版没有网址栏，用户 2026-09-30 要求打包后可切换）。
 * 与语言选择同样在标题页、切换后重新载入；网址带 `hd=` 参数时以网址为准，这里只显示不改。
 */
export function mountHdChoice(scene) {
  // 手机 App 固定原版、不带高清图，选项去掉（用户 2026-10-03）
  if (inNativeApp()) return;
  const label = document.createElement('label');
  label.className = 'language-choice hd-choice';
  label.append(document.createTextNode('畫面 '));
  const select = document.createElement('select');
  select.setAttribute('aria-label', '畫面');
  for (const [value, title] of [['1', '高清'], ['0', '原版']]) {
    const option = document.createElement('option');
    option.value = value; option.textContent = title; option.selected = (value === '1') === HD_ENABLED;
    select.append(option);
  }
  const fromUrl = new URLSearchParams(window.location.search).has('hd');
  select.disabled = fromUrl;
  if (fromUrl) select.title = '已由網址參數 hd= 指定';
  select.addEventListener('keydown', (e) => e.stopPropagation());
  select.addEventListener('change', () => {
    try { window.localStorage.setItem(HD_STORAGE_KEY, select.value); } catch { /* 存不了就只影响本次 */ }
    window.location.reload();
  });
  label.append(select);
  titleOptionColumn(scene).append(label);
}
