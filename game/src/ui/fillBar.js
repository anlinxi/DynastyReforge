/**
 * 填充条 / 柱子的档位换算。
 *
 * ⚠️ **帧号是倒着数的：帧 1 ＝ 满，末帧 ＝ 空。**
 * 逐帧铺开看过 `MEN2001`（五外柱）、`MEN2002`（命条）、`MEN2003`（气条）
 * 三张，方向一致。按「帧 = 比例 × 帧数」写会得到完全相反的显示
 * —— 满血画成空管，而且因为两端都是"看着像没画对"，很难一眼看出方向反了。
 *
 * 帧 0 是**空的没有图层**（不是空管，是什么都不画），所以可用区间是 `1 .. 帧数−1`。
 */

/**
 * @param {object} spec menus.json
 * @param {string} asset 填充素材名（不带 .SF2）
 * @param {number} ratio 0~1，1 = 满
 * @returns {number} 帧号
 */
export function fillFrame(spec, asset, ratio) {
  const frames = spec.assets?.[asset]?.frames?.length ?? 2;
  const last = frames - 1;                       // 可用帧 1..last，1 满、last 空
  const clamped = Math.min(1, Math.max(0, ratio));
  return Math.min(last, Math.max(1, 1 + Math.round((1 - clamped) * (last - 1))));
}
