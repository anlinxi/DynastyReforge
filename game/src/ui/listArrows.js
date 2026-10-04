/**
 * **列表的上下翻页箭头**：跳动帧 + 静止帧。
 *
 * ## 判据全在素材里
 *
 * 全部八套箭头都是 **6 帧、同一张图、逐帧上下偏移**：
 *
 * | 素材 | 用在 | 各帧的图层 y |
 * |---|---|---|
 * | `MEN4004` / `MEN4005` | 法宝页 + 购物界面两侧 | `2,1,0,0,1,2` / `0,1,2,2,1,0` |
 * | `MEN5003` / `MEN5004` | 绝学页 | `3,2,0,0,2,3` / `0,1,2,2,1,0` |
 * | `MEN3006` / `MEN3007` | 及身页 | `2,1,0,0,1,2` / `0,1,2,2,1,0` |
 * | `MEN8004` / `MEN8005` | 天书页 | `3,1,0,0,1,2` / `0,1,2,2,1,0` |
 *
 * 也就是说**「箭头跳动」是原作自带的循环动画**，不是我们加的效果 ——
 * 用户报「如果可以往后翻页，向下的箭头应该是跳动状态…如果箭头不跳动，
 * 则表示没有那一页了」，对应的就是**这段动画播 / 不播**。
 *
 * 此前所有地方都只画帧 0，所以箭头全是死的。
 *
 * ⚠️ **「静止」不是帧 0**：上箭头帧 0 是**偏移最大**的那一帧
 * （`MEN4004` 的 y=2）。静止该停在偏移为 0 的那一帧，所以按
 * **图层 y 最小**去找，不要写死帧号 —— 八套素材的那一帧分别是 2/2/2/2。
 */

/** 一段跳动播完要多久。🅓 原作的帧时长没导出（`menus.json` 不带 dur），取 120ms/帧。 */
export const ARROW_STEP_MS = 120;

/** 这套箭头有几帧。 */
function frameCount(spec, asset) {
  return spec?.assets?.[asset]?.frames?.length ?? 1;
}

/**
 * 静止该停在哪一帧 —— **图层 y 最小的那一帧**（理由见文件头）。
 * 取不到帧表就退回 0。
 */
export function restFrame(spec, asset) {
  const frames = spec?.assets?.[asset]?.frames ?? [];
  let best = 0;
  let bestY = Infinity;
  frames.forEach((layers, i) => {
    const y = layers?.[0]?.y ?? 0;
    if (y < bestY) { bestY = y; best = i; }
  });
  return best;
}

/**
 * 现在该画哪一帧。
 *
 * @param {object} spec `menus.json`
 * @param {string} asset 箭头素材名
 * @param {boolean} live 这个方向还翻得动吗 —— 翻不动就定格
 * @param {number} time `scene.time.now`
 */
export function arrowFrame(spec, asset, live, time) {
  if (!live) return restFrame(spec, asset);
  const n = frameCount(spec, asset);
  return n > 1 ? Math.floor(time / ARROW_STEP_MS) % n : 0;
}
