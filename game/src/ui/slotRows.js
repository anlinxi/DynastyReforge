import { menuFont } from './nativeText.js';
/**
 * 存档记录条 —— **天书页与标题读档页共用这一份**。
 *
 * ## 为什么要抽出来
 *
 * 两个页面画的是同一个东西：一屏几条记录，每条是「条底图 + 行首头像 +
 * 地名 + 等级 + 年月日时分」，光标那条不透明、其余半透明。
 * 此前各写了一套，于是修一边另一边不动 —— 用户原话：
 * 「这块能不能直接复用天书的代码呀？为什么要整个重新做一套？」
 *
 * 两边**只有布局参数不同**，结构完全一样：
 *
 * | | 天书页 | 标题读档页 |
 * |---|---|---|
 * | 条底图 | `MEN8001` | `MEN9304`（同构：帧 0 有记录 / 帧 1 未記錄） |
 * | 槽位编号 | 有（`MEN1019`） | 无 |
 * | 等级 x | 508 | 538（条上标签位置不同，见 `config.TITLE`） |
 *
 * 所以这里只收一份 `style`（形状就是 `menus.json` 的 `tianshu`），
 * 调用方各自传自己的。**导航不在这里** —— 那是 `ui/tianshu.js` 的纯状态机，
 * 两边也共用同一份。
 */
import { FONT_KEY, FONT_SIZE } from '../config.js';
import { textureKey } from './menuSpec.js';
import { paintNumber } from './glyphNumber.js';

/** 记录条上的字是墨色，不是纯黑。与八页菜单同一个值。 */
export const TEXT_TINT = 0x3a2418;

/** 行首最多画几个头像 —— 再多就压到条上「地點/」的标签美术上了。 */
export const FACE_MAX = 5;

/**
 * 往容器里贴一张图。
 *
 * @param {{scene: object, container: object, parts: Array}} brush
 *   两个页面各有自己的容器与回收表，所以画笔由调用方给。
 */
function tile(brush, asset, index, x, y, alpha = 1) {
  // `index` 可以是数字（spritesheet，如 `MEN8001`）也可以是帧名字符串
  // （独立图集，如 `MEN9304` 的 `img_000`）—— 原样交给 Phaser。
  const img = brush.scene.add.image(x, y, textureKey(asset), index)
    .setOrigin(0, 0).setScrollFactor(0).setAlpha(alpha);
  brush.container.add(img);
  brush.parts.push(img);
  return img;
}

/**
 * 一条记录上的地名、等级、日期、时间。
 *
 * ⚠️ **值要填进条上模板的空格里，不能另起一行自己排。**
 * 条的美术里已经印着「地點/ 　等級/ ／ 日期/ 年 月 日 時間/ ：」这些
 * **15px 的标签**，所以数字用 `MEN1018`（15×14 的字形表）与它们同高，
 * 只有地名用 24px 字库。从前在条上另画两行 24px 简体字，两套字叠在一起 ——
 * 用户说的「字体明显有问题」就是那个。
 */
function drawFields(brush, spec, style, summary, y) {
  const s = style.slots;
  if (!s) return;
  const label = brush.scene.add
    .bitmapText(style.row.x + s.地名.x, y + s.地名.y, menuFont(),
                summary.存档名 ?? '', FONT_SIZE)
    .setScrollFactor(0);
  brush.container.add(label);
  brush.parts.push(label);

  for (const key of ['等级', '年', '月', '日', '时', '分']) {
    const at = s[key];
    const value = summary[key];
    if (!at || !Number.isFinite(value)) continue;
    paintNumber(brush.scene, brush.container, spec, s.asset, value,
                { x: style.row.x + at.x, y: y + at.y }, brush.parts);
  }
}

/**
 * 行首的小头像 = **那次存档时队伍里有谁**。
 *
 * ⚠️ 曾经画的是角色记录 `+156`「曾入队」那一列 —— 那一列**只增不减**，
 * 于是每条存档都是五个人，而原作 `Save009` 只有霍雍一个。
 * 现在读的是存档的队伍区（`systems/tsf.js` 的 `readParty`）。
 */
function drawFaces(brush, style, summary, y) {
  const face = style.face;
  if (!face) return;
  (summary.队伍 ?? []).slice(0, face.max ?? FACE_MAX).forEach((code, j) => {
    tile(brush, face.asset, code - 1,
         style.row.x + face.x0 + face.step * j, y + face.dy);
  });
}

/**
 * 画一屏记录条。
 *
 * @param {{scene, container, parts}} brush 画到哪儿、回收表放哪儿
 * @param {object} spec `menus.json`
 * @param {object} style 布局，形状同 `menus.json` 的 `tianshu`
 *   （要 `row`，可选 `face` / `index` / `slots`）
 * @param {Array<{slot: number, summary: object|null, selected: boolean}>} rows
 *   由 `ui/tianshu.js` 的 `visibleRows` 算出来 —— **两个页面同一个状态机**
 */
export function drawSlotRows(brush, spec, style, rows) {
  const { row } = style;
  if (!row) return;
  rows.forEach(({ slot, summary, selected }, k) => {
    const y = row.y0 + row.step * k;
    // ⚠️ 记录条的半透明是**元素级**的（SF2 里写着 alpha=0）。选中那条画成
    // 不透明 —— 原作没有第三张「选中」图，高亮只能靠它。
    tile(brush, row.asset, summary ? (row.img ?? 0) : (row.emptyImg ?? 1),
         row.x, y, selected ? 1 : row.alpha);
    // 空槽原作也印编号，所以画在 summary 判断之前。
    if (style.index) {
      paintNumber(brush.scene, brush.container, spec, style.index.asset, slot + 1,
                  { x: row.x + style.index.x, y: y + style.index.y }, brush.parts);
    }
    if (!summary) return;
    drawFields(brush, spec, style, summary, y);
    drawFaces(brush, style, summary, y);
  });
}
