import { HD_ENABLED } from './hdRender.js';
import { LANGUAGE } from '../systems/language.js';

/**
 * 高清下的对白字样式（用户 2026-09-30 从五种对比里选 3a）：
 * 原作对白字是「深棕笔画 + 右下一圈浅棕阴影」，高清放大后阴影与底色对比弱，看着发虚。
 * 改法：紧贴在同一字格内笔画右侧的阴影像素改成笔画色（笔画横向略加粗），其余阴影去掉。
 * 只在高清下改（默认开，`?hd=0` 为原版），原版保持原作样子。字体图是 26×24 的均匀网格（见 yc24-dialogue.xml）。
 */

const CELL_W = 26;

const isColor = (d, i, c) => d[i] === c[0] && d[i + 1] === c[1] && d[i + 2] === c[2] && d[i + 3] > 0;

/**
 * 重绘规则（字体图是「深棕笔画 + 右下浅棕阴影」两色）：
 * - `orig`：不动，原作双色；
 * - `core`：只留笔画，去掉全部阴影（对比图里的选项 3）；
 * - `3a`：紧贴笔画右侧的阴影改成笔画色，其余阴影去掉（繁体用，用户 2026-09-30 选定）；
 * - `gap`：同 3a，但那个像素的右邻还是笔画时不加——不把 1 像素宽的间隙堵死（简体字密，3a 加粗后笔画糊成一团，
 *   用户 2026-10-02 反馈：不要双色字，要加粗但比 3a 轻）；
 * - `vert`：只加粗竖笔——紧贴笔画右侧、且左邻笔画上下也是笔画的阴影才改（横笔、撇捺保持原粗），比 3a/gap 轻。
 * 网址 `font3a=orig|core|3a|gap`（`0` 同 orig）强制某种规则，供对比用。
 */
const DEFAULT_RULE = LANGUAGE === '简' ? 'core' : '3a';
const RULES = ['orig', 'core', '3a', 'gap', 'vert'];

function chosenRule() {
  try {
    const q = new URLSearchParams(window.location.search).get('font3a');
    if (q === '0') return 'orig';
    return RULES.includes(q) ? q : DEFAULT_RULE;
  } catch {
    return DEFAULT_RULE;
  }
}

/** 该阴影像素在规则下的去留：true 改成笔画色，false 去掉。 */
export function keepShadowAsCore(rule, leftIsCore, rightIsCore, leftIsVertical = false) {
  if (rule === 'core') return false;
  if (rule === 'vert') return leftIsCore && leftIsVertical;
  if (rule === 'gap') return leftIsCore && !rightIsCore;
  return leftIsCore;
}

/** 字体图的两色（笔画色、阴影色）：对白字与红/蓝/强调红三种带色字各一套。 */
const PALETTES = Object.freeze({
  dialogue: { core: [66, 24, 0], shadow: [173, 140, 99] },
  red: { core: [255, 0, 0], shadow: [247, 140, 115] },
  blue: { core: [24, 74, 140], shadow: [132, 140, 148] },
  'emphasis-red': { core: [255, 0, 0], shadow: [255, 99, 33] },
});

/** 把一张两色字体贴图按规则重绘并重新上传。未开高清、规则为 orig 或贴图不在时什么也不做。 */
export function applyFontStyle(scene, key, palette = PALETTES.dialogue) {
  const rule = chosenRule();
  if (!HD_ENABLED || rule === 'orig' || !scene.textures.exists(key)) return;
  const { core, shadow } = palette;
  const texture = scene.textures.get(key);
  const source = texture.source[0];
  const image = source.image;
  const canvas = document.createElement('canvas');
  canvas.width = image.width;
  canvas.height = image.height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(image, 0, 0);
  const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const d = pixels.data;
  const src = new Uint8ClampedArray(d);
  const w = canvas.width;
  const rowBytes = w * 4;
  for (let i = 0; i < d.length; i += 4) {
    if (!isColor(src, i, shadow)) continue;
    const x = (i / 4) % w;
    const leftIsCore = x % CELL_W !== 0 && isColor(src, i - 4, core);
    const rightIsCore = x % CELL_W !== CELL_W - 1 && isColor(src, i + 4, core);
    const leftIsVertical = leftIsCore && i - rowBytes >= 0 && i + rowBytes < d.length
      && isColor(src, i - 4 - rowBytes, core) && isColor(src, i - 4 + rowBytes, core);
    if (keepShadowAsCore(rule, leftIsCore, rightIsCore, leftIsVertical)) {
      d[i] = core[0]; d[i + 1] = core[1]; d[i + 2] = core[2];
    } else {
      d[i + 3] = 0;
    }
  }
  ctx.putImageData(pixels, 0, 0);
  source.image = canvas;
  source.isCanvas = true;
  source.update();
}

/**
 * 启动时按规则处理当前语言的字体图：对白字（菜单、对白共用）总是处理；
 * 红（不可用的物品/绝学）、蓝、强调红三种带色字只在简体处理——繁体的 3a 是用户 2026-09-30 看对比图选定、仅针对对白字，
 * 带色字保持原样；简体不要双色字，带色字也要同步（用户 2026-10-02 反馈红字还是粗且有黄边）。
 */
export function applyHdFontStyles(scene, font) {
  applyFontStyle(scene, font.dialogueKey, PALETTES.dialogue);
  if (LANGUAGE !== '简') return;
  for (const style of ['red', 'blue', 'emphasis-red']) applyFontStyle(scene, `${font.key}-${style}`, PALETTES[style]);
}
