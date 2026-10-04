/**
 * 用原作的美术数字字形拼数值。
 *
 * 原作的数值**不用字体**，是一张张字形图贴出来的；而且是**中文数字按十进制位**排，
 * 不是「十百千」的传统写法 —— 截图上 1475 写作「一四七五」。所以只需要 0~9 十个字形。
 *
 * ⚠️ **各张字形表的排布不一样**（`MEN1017` 的〇在第 9 帧、`MEN0028` 在第 10、
 * `MEN1019` 在第 0），映射写在 `menus.json` 的 `glyphLayout` 里，不要在这里写死。
 *
 * ⚠️ 旧实现 `deprecated/game/src/ui/glyphText.js` 依赖 `statusLayout.js` 的硬编码坐标，
 * **不要复活它**；这一份只认 `menus.json`。
 */
import { textureKey } from './menuSpec.js';

/**
 * 一个数字拆成的帧号序列。
 * @param {object} layout menus.json 的 glyphLayout[素材名]
 * @param {number} value 非负整数；负数取绝对值（界面上没见过负的数值坑）
 * @returns {number[]} 每一位对应的帧号，高位在前
 */
export function framesForNumber(layout, value) {
  const digits = String(Math.abs(Math.trunc(value)));
  return [...digits].map((ch) => {
    const d = Number(ch);
    return d === 0 ? layout.zero : layout.one + (d - 1);
  });
}

/**
 * 画一个数值。
 *
 * 摆位规则来自原作截图实测（见 `docs/判据/数据链路.md` §2.9「数值坑位盘点」）：
 * 命/气/五外是**左对齐**（值的左缘就是坑的 x）；金钱与诸骸组是**右对齐**，
 * 右缘 = 坑的 x + 字段宽 × 步进。
 *
 * @param {object} spec menus.json
 * @param {string} asset 字形表素材名（不带 .SF2）
 * @param {number} value 要显示的数
 * @param {{x:number,y:number,align?:string,width?:number}} slot 坑位（statSlots 的一条 + 坐标）
 * @param {number} advance 步进（字宽 + 字距），来自元素的 exe 参数
 * @param {(asset:string, frame:number, x:number, y:number) => void} draw 逐字回调
 */
export function drawNumber(spec, asset, value, slot, advance, draw) {
  const layout = spec.glyphLayout?.[asset];
  if (!layout || !Number.isFinite(value)) return;
  const frames = framesForNumber(layout, value);
  // 右对齐时整体后移，让**末位**贴住字段边界；字段宽没给就按实际位数（等同左对齐）
  const pad = slot.align === 'right' ? Math.max(0, (slot.width ?? frames.length) - frames.length) : 0;
  // 居中：`slot.x` 当**中心**用，整体左移半个串宽。五内页五块牌上的点数用这个 ——
  // 牌是固定宽的雕花框，点数从 1 位变 2 位时原作是往两边长，不是往右长。
  // 串宽 = (位数−1)×步进 + 字宽，而字宽 = 步进 − 字距(2)。
  const centerShift = slot.align === 'center'
    ? Math.round((frames.length * advance - 2) / 2) : 0;
  // ⚠️ 五外那五个数是**竖着写**的（原作里「膂力＼六四」整列往下排），
  // 按横排画会横穿柱子。竖排的步进实测也是 15，与横排相同。
  const vertical = slot.dir === 'vertical';
  frames.forEach((frame, i) => {
    const step = (pad + i) * advance - centerShift;
    draw(asset, frame, vertical ? slot.x : slot.x + step, vertical ? slot.y + step : slot.y);
  });
}

/**
 * 变化标记 ▲ / ▼。原作在**变化的那个值**旁边贴一个，标预览相对当前的升降。
 * 字形表里就有（`glyphLayout` 的 `up` / `down`），没有那两帧的表返回 null。
 *
 * @param {number} delta 预览 − 当前
 * @returns {number|null} 帧号
 */
export function markerFrame(spec, asset, delta) {
  const layout = spec.glyphLayout?.[asset];
  if (!layout || !delta) return null;
  return (delta > 0 ? layout.up : layout.down) ?? null;
}

/**
 * 字形的步进（字宽 + 字距）。`0x431600` 建文字元素的第 3/4 个参数就是这两项，
 * 但 `extract_layout.py` 收集立即数时没保留它们的先后，所以这里按**字形自身的宽度**
 * 推：实测各表的步进就等于 `cell 宽 + 2`（`MEN1017` 13→15，与 statusLayout 旧实测的
 * `GLYPH.advance = 15` 一致）。
 */
export function advanceOf(spec, asset) {
  const cell = spec.assets?.[asset]?.cell;
  return cell ? cell[0] + 2 : 15;
}

/** 给 Phaser 用的便捷封装：把一个数值画进容器。 */
export function paintNumber(scene, container, spec, asset, value, slot, sink) {
  drawNumber(spec, asset, value, slot, advanceOf(spec, asset), (a, frame, x, y) => {
    const img = scene.add.image(x, y, textureKey(a), frame)
      .setOrigin(0, 0).setScrollFactor(0);
    container.add(img);
    sink.push(img);
  });
}
