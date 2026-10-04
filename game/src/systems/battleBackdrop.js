/**
 * 战斗宽屏两侧的补边（用户 2026-10-02 选 E：模糊补边 + 渐隐）。
 *
 * 战场画面最宽 800（背景原图宽，见 stageView.battleViewFor），舞台更宽时两侧没有美术：
 * 用本场背景放大到盖满舞台、模糊、压暗铺在两侧；战场边缘往里 FADE 像素内由清晰背景渐隐进补边，看不出界线。
 * 样张与另外四种候选见 out/战斗宽屏/。
 *
 * 模糊用“缩小再放大”，不靠 canvas 的 filter（老 iOS Safari 不支持）。
 */

/** 战场边缘往里渐隐的宽度（逻辑像素）。 */
export const FADE = 40;
/** 缩小倍数：越大越糊。 */
const BLUR_DOWN = 12;
/** 压暗：盖一层这么不透明的黑。 */
const DARKEN = 0.55;
/** 背景放大到盖满舞台宽后再多放大一点，免得模糊后边缘发虚露底。 */
const OVERSCAN = 1.05;

/**
 * 画补边。`canvas` 被改成 stageWidth×height：两侧是模糊压暗的背景，战场范围挖空，边缘渐隐。
 * @param {HTMLCanvasElement} canvas
 * @param {CanvasImageSource} src 本场背景图（可能是高清大图）
 * @param {{ stageWidth:number, height:number, floorWidth:number, floorHeight:number, fieldX:number, fieldWidth:number }} geo 逻辑像素
 */
export function paintBackdrop(canvas, src, geo) {
  const { stageWidth: W, height: H, floorWidth, floorHeight, fieldX, fieldWidth } = geo;
  canvas.width = W;
  canvas.height = H;
  const g = canvas.getContext('2d');

  const scale = (W / floorWidth) * OVERSCAN;
  const dw = floorWidth * scale, dh = floorHeight * scale;
  const small = document.createElement('canvas');
  small.width = Math.ceil(W / BLUR_DOWN);
  small.height = Math.ceil(H / BLUR_DOWN);
  const sg = small.getContext('2d');
  sg.imageSmoothingEnabled = true;
  sg.imageSmoothingQuality = 'high';
  sg.drawImage(src, (W - dw) / 2 / BLUR_DOWN, (H - dh) / 2 / BLUR_DOWN, dw / BLUR_DOWN, dh / BLUR_DOWN);
  g.imageSmoothingEnabled = true;
  g.imageSmoothingQuality = 'high';
  g.drawImage(small, 0, 0, W, H);
  g.fillStyle = `rgba(0,0,0,${DARKEN})`;
  g.fillRect(0, 0, W, H);

  // 战场范围挖空；两边各 FADE 像素由“全留”渐变到“全挖”，清晰背景就渐隐进补边
  const fade = Math.min(FADE, fieldWidth / 2);
  const right = fieldX + fieldWidth;
  g.globalCompositeOperation = 'destination-out';
  const left = g.createLinearGradient(fieldX, 0, fieldX + fade, 0);
  left.addColorStop(0, 'rgba(0,0,0,0)');
  left.addColorStop(1, '#000');
  g.fillStyle = left;
  g.fillRect(fieldX, 0, fade, H);
  const rightGrad = g.createLinearGradient(right, 0, right - fade, 0);
  rightGrad.addColorStop(0, 'rgba(0,0,0,0)');
  rightGrad.addColorStop(1, '#000');
  g.fillStyle = rightGrad;
  g.fillRect(right - fade, 0, fade, H);
  g.fillStyle = '#000';
  g.fillRect(fieldX + fade, 0, fieldWidth - 2 * fade, H);
  g.globalCompositeOperation = 'source-over';
}
