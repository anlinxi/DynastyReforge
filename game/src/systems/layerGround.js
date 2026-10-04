/**
 * 分层背景的地面画法（待办 MAP-17）。字段由 `tools/export_map_layers.py` 从地图 SCI 导出，
 * 原作依据见那里的 `PARALLAX` 注释：官方 RPG.exe 0x4067a0（视差/漂移）、0x44e677 与 0x44e723（颜色键）。
 */
/**
 * 漂移背景每拍移动一次。按原作逻辑拍 55 毫秒换算（与 `SF2Animator.TICK_MS` 同值；
 * 原作图层更新是否每拍一次属推断）。不从那里引用：那个模块带 Phaser，纯函数测试加载不了。
 */
export const DRIFT_TICK_MS = 55;

/**
 * 原作 16 位（RGB565）贴图时哪些像素不画。
 * - `black`（0x44e677，SCI +0x6E > 0）：整个像素值为 0；
 * - `greenBlue`（0x44e723，视差档 2 或 10）：低 11 位即绿、蓝为 0，红色不看 —— 容得下 JPEG 黑底里的杂色。
 */
export function isColorKeyed(r, g, b, mode) {
  if ((g >> 2) !== 0 || (b >> 3) !== 0) return false;
  return mode === 'greenBlue' || (r >> 3) === 0;
}

/**
 * 按颜色键把一张地面图的透明部分抠掉，存成画布贴图（键名加 `-keyed`）。已有就直接用。
 * @returns {string} 抠好的贴图键
 */
export function colorKeyedTexture(scene, key, mode) {
  const keyed = `${key}-keyed`;
  if (scene.textures.exists(keyed)) return keyed;
  const source = scene.textures.get(key).getSourceImage();
  const canvas = document.createElement('canvas');
  canvas.width = source.width;
  canvas.height = source.height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(source, 0, 0);
  const image = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const px = image.data;
  for (let i = 0; i < px.length; i += 4) {
    if (isColorKeyed(px[i], px[i + 1], px[i + 2], mode)) px[i + 3] = 0;
  }
  ctx.putImageData(image, 0, 0);
  scene.textures.addCanvas(keyed, canvas);
  return keyed;
}
