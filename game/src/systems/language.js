import paths from './uiLocales.json' with { type: 'json' };
import { titleOptionColumn } from '../ui/titleColumn.js';
const STORAGE_KEY = 'youcheng-language';
export function savedLanguage(storage) {
  try { return storage?.getItem(STORAGE_KEY) === '简' ? '简' : '繁'; }
  catch { return '繁'; }
}
export const LANGUAGE = savedLanguage(typeof localStorage === 'undefined' ? null : localStorage);
/** 只改已核对的UI美术路径；所有官方剧情、装备、伤害数据路径原样保留。 */
export function uiAsset(path, language = LANGUAGE) {
  for (const [source, target] of Object.entries(paths[language] ?? {})) {
    if (path === source || path.startsWith(source + '/')) return target + path.slice(source.length);
  }
  return path;
}
/** 标题界面选择语言；此时没有进行中的剧情/战斗，重新加载不丢当前游戏状态。 */
export function mountLanguageChoice(scene) {
  const label = document.createElement('label');
  label.className = 'language-choice';
  label.append(document.createTextNode(LANGUAGE === '简' ? '语言 ' : '語言 '));
  const select = document.createElement('select');
  select.setAttribute('aria-label', '語言 / 语言');
  for (const [value, title] of [['繁', '繁體中文'], ['简', '简体中文']]) {
    const option = document.createElement('option');
    option.value = value; option.textContent = title; option.selected = value === LANGUAGE;
    select.append(option);
  }
  select.addEventListener('keydown', (e) => e.stopPropagation());
  select.addEventListener('change', () => {
    if (select.value === LANGUAGE) return;
    localStorage.setItem(STORAGE_KEY, select.value);
    location.reload();
  });
  label.append(select); titleOptionColumn(scene).append(label);
}
