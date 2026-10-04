import { LANGUAGE } from '../systems/language.js';
import { battlePatches, setBattlePatch } from '../systems/gameplayOptions.js';
import { titleOptionColumn } from './titleColumn.js';

/** 一个下拉选项。`choices` 为 [值, 显示文字]；键盘事件不外传，免得方向键/空格触发标题菜单。 */
export function titleSelect(scene, { caption, choices, value, onChange, className = '' }) {
  const label = document.createElement('label');
  label.className = `language-choice ${className}`.trim();
  label.append(document.createTextNode(`${caption} `));
  const select = document.createElement('select');
  select.setAttribute('aria-label', caption);
  for (const [v, title] of choices) {
    const option = document.createElement('option');
    option.value = v; option.textContent = title; option.selected = v === value;
    select.append(option);
  }
  select.addEventListener('keydown', (e) => e.stopPropagation());
  select.addEventListener('change', () => onChange(select.value, select));
  label.append(select);
  titleOptionColumn(scene).append(label);
  return select;
}

/** 两个补丁开关的文字，跟随标题页语言。 */
const PATCH_TEXT = {
  繁: { maximumGrowth: ['成長', '最大', '隨機（原作）'], guaranteedDrops: ['掉寶', '必定', '機率（原作）'] },
  简: { maximumGrowth: ['成长', '最大', '随机（原作）'], guaranteedDrops: ['掉宝', '必定', '概率（原作）'] },
};

/**
 * 「成長：最大/隨機」「掉寶：必定/機率」（BTL-16，用户2026-10-04定放标题页）。
 * 改了即存，不重新载入：结算时才读，从下一场战斗起生效。
 */
export function mountPatchChoices(scene) {
  const current = battlePatches();
  const text = PATCH_TEXT[LANGUAGE] ?? PATCH_TEXT.繁;
  for (const key of ['maximumGrowth', 'guaranteedDrops']) {
    const [caption, on, off] = text[key];
    titleSelect(scene, {
      caption,
      choices: [['1', on], ['0', off]],
      value: current[key] ? '1' : '0',
      className: 'patch-choice',
      onChange: (v, select) => {
        if (!setBattlePatch(key, v === '1')) select.title = '無法保存，只對本次有效';
      },
    });
  }
}
