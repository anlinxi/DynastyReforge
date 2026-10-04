import Phaser from 'phaser';
import { hdScaleOf, registerHdKey } from '../hd/hdRender.js';

/**
 * 多层元素预合成：同一素材的多个图层（普通混合）先在画布上叠成一张，缓存为贴图，
 * 之后只画这一张。看起来与逐层画完全相同。
 *
 * 用途：菜单底图 `MEN0001` 第 1 帧是原作把旋涡图错位叠 7 次（透明度 0.25→1）的拖影，
 * 7 层都是整屏大图。高清画布（约 2600×1960）上逐层画，菜单页实测 29 帧（2026-09-30）；
 * 原版 640×480 画布感觉不到。
 */

/** 至少几层才合成；层数少时直接画更省事。 */
const MIN_LAYERS = 3;

/**
 * @param {Phaser.Scene} scene
 * @param {string} textureKey 素材贴图键
 * @param {string} cacheKey 这一帧的缓存键（同一素材同一帧共用）
 * @param {Array<{img: number, x: number, y: number, blend: number, alpha: number}>} layers 相对元素原点的图层
 * @returns {{key: string, x: number, y: number}|null} 合成贴图键与其左上角相对元素原点的偏移；不适合合成时 null
 */
export function flattenLayers(scene, textureKey, cacheKey, layers) {
  if (layers.length < MIN_LAYERS) return null;
  if (layers.some((l) => l.blend !== Phaser.BlendModes.NORMAL)) return null;
  const texture = scene.textures.get(textureKey);
  const frames = layers.map((l) => texture.get(l.img));
  if (frames.some((f) => !f || f === texture.get('__BASE'))) return null;
  // 贴图若是登记过的高清图，帧尺寸是逻辑尺寸的 s 倍；合成按贴图像素做，显示时同样缩回
  const hdScale = hdScaleOf(textureKey);
  const minX = Math.min(...layers.map((l) => l.x));
  const minY = Math.min(...layers.map((l) => l.y));
  const key = `${cacheKey}-flat`;
  if (!scene.textures.exists(key)) {
    const maxX = Math.max(...layers.map((l, i) => l.x + frames[i].cutWidth / hdScale));
    const maxY = Math.max(...layers.map((l, i) => l.y + frames[i].cutHeight / hdScale));
    const w = Math.ceil((maxX - minX) * hdScale);
    const h = Math.ceil((maxY - minY) * hdScale);
    const canvas = scene.textures.createCanvas(key, w, h);
    const ctx = canvas.context;
    layers.forEach((l, i) => {
      const f = frames[i];
      ctx.globalAlpha = l.alpha;
      ctx.drawImage(f.source.image, f.cutX, f.cutY, f.cutWidth, f.cutHeight,
        Math.round((l.x - minX) * hdScale), Math.round((l.y - minY) * hdScale), f.cutWidth, f.cutHeight);
    });
    ctx.globalAlpha = 1;
    canvas.refresh();
    if (hdScale > 1) registerHdKey(key, hdScale);
  }
  return { key, x: minX, y: minY };
}
