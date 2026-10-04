/**
 * 抗性计量管（`MEN6005`）。
 *
 * 管身是固定的蓝→红渐变，**动的只有那颗菱形游标**。129 帧就是游标的 129 个
 * 落点，**倒着数**：f0 在最右、f128 在最左，与命气条、五外柱同规。
 *
 * 坐标与映射都在 `menus.json` 的 `interactions.resistRows` 里，这里只放算法。
 */

/** 一行抗性管该用第几帧。越界的值夹回两端，返回 null 表示配置缺失。 */
export function resistFrame(rows, value) {
  const bar = rows?.bar;
  if (!bar || !Number.isFinite(value)) return null;
  const [lo, hi] = bar.domain;
  const v = Math.min(hi, Math.max(lo, value));
  // 【实测】五内页 8 行 8/8 全中。⚠️ 及身页交叉验证没通过（见配置里的注释），
  // 所以这条公式只当"目前最好的解释"，不是已经坐实的规则。
  const f = Math.floor(bar.frames - (v - lo) * (bar.frames - 1) / (hi - lo));
  return Math.min(bar.frames - 1, Math.max(0, f));
}

/** 第 i 行的 y。⚠️ 行距 34.571 不是整数，必须每行现算再取整，不能累加。 */
export function rowY(rows, i) {
  return Math.round(rows.y0 + rows.dy * i);
}
