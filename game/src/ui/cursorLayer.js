/**
 * 鼠标指针图层：原作指针画在游戏画布**上方**一个独立的小画布里，不画进游戏画面。
 *
 * 原先指针跟着整张游戏画面一起出图，要等整帧画完送屏才动；高清把画布提到屏幕像素后，
 * 每帧更重，指针明显变“黏”（用户 2026-09-30 反馈）。独立图层在鼠标事件里直接挪位置、
 * 换形状，不等游戏帧；指针图、动画、方向箭头与手势照旧来自原作素材（CursorScene 决定）。
 *
 * 位置公式与 FieldSprite 相同：指针点 + 绘制偏移 + 图层坐标（逻辑像素），
 * 再乘画面缩放（CSS 像素）与屏幕倍率（实际像素）。最近邻放大，保持原作像素样子。
 */

import { stageView } from '../systems/stageView.js';

const STYLE_ID = 'yc-cursor-layer-style';
const BODY_CLASS = 'yc-cursor-layer';

const BLEND = { add: 'lighter', subtract16: 'lighter', screen: 'screen', multiply: 'multiply' };

export default class CursorLayer {
  /** @param {HTMLCanvasElement} gameCanvas 游戏画布，用来换算缩放 */
  constructor(gameCanvas) {
    this.gameCanvas = gameCanvas;
    this.canvas = document.createElement('canvas');
    Object.assign(this.canvas.style, {
      position: 'fixed', left: '0', top: '0', pointerEvents: 'none', zIndex: '10000',
      display: 'none', willChange: 'transform',
    });
    document.body.appendChild(this.canvas);
    // 画布上一律不显示系统光标：Phaser 的“悬停变手形”（useHandCursor）会改画布的 style.cursor，
    // 离开时又重置回 index.html 里的小指针图，于是大手指上叠小手指、或冒出系统白手（2026-09-30 用户报）。
    // 样式表的 !important 压过行内样式，谁改都不生效。
    if (!document.getElementById(STYLE_ID)) {
      const style = document.createElement('style');
      style.id = STYLE_ID;
      style.textContent = `body.${BODY_CLASS} #game canvas { cursor: none !important; }`;
      document.head.appendChild(style);
    }
    document.body.classList.add(BODY_CLASS);
    this.ctx = this.canvas.getContext('2d');
    this.box = { x: 0, y: 0 };
    this.scale = 1;
    this.clientX = 0;
    this.clientY = 0;
    this.drawnKey = null;
  }

  /** 画面缩放：CSS 像素 / 逻辑像素。 */
  cssScale() {
    const rect = this.gameCanvas.getBoundingClientRect();
    return rect.width / stageView().width || 1;
  }

  setVisible(visible) {
    this.canvas.style.display = visible ? 'block' : 'none';
  }

  /** 鼠标屏幕位置（clientX/Y）。只挪图层，不重画。 */
  moveTo(clientX, clientY) {
    this.clientX = clientX;
    this.clientY = clientY;
    this.place();
  }

  place() {
    const s = this.scale;
    const x = this.clientX + this.box.x * s;
    const y = this.clientY + this.box.y * s;
    this.canvas.style.transform = `translate(${x}px, ${y}px)`;
  }

  /**
   * 画一帧指针。
   * @param {Phaser.Textures.TextureManager} textures
   * @param {Array<{key: string, frame?: string, dx: number, dy: number, alpha?: number, blend?: string}>} layers
   *   dx/dy 为相对指针点的逻辑坐标（已含绘制偏移与图层坐标）
   * @param {string} signature 这一帧的标识，相同则不重画
   */
  draw(textures, layers, signature) {
    const scale = this.cssScale();
    const sig = `${signature}@${scale}`;
    if (sig === this.drawnKey) return;
    const frames = layers.map((l) => ({ ...l, tex: textures.get(l.key).get(l.frame) }))
      .filter((l) => l.tex && l.tex.cutWidth > 0);
    if (!frames.length) { this.setVisible(false); return; }
    const minX = Math.min(...frames.map((l) => l.dx));
    const minY = Math.min(...frames.map((l) => l.dy));
    const maxX = Math.max(...frames.map((l) => l.dx + l.tex.cutWidth));
    const maxY = Math.max(...frames.map((l) => l.dy + l.tex.cutHeight));
    const dpr = window.devicePixelRatio || 1;
    const px = scale * dpr;
    const w = Math.ceil((maxX - minX) * px);
    const h = Math.ceil((maxY - minY) * px);
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
    this.canvas.style.width = `${w / dpr}px`;
    this.canvas.style.height = `${h / dpr}px`;
    const ctx = this.ctx;
    ctx.clearRect(0, 0, w, h);
    ctx.imageSmoothingEnabled = false;
    for (const l of frames) {
      const t = l.tex;
      ctx.globalAlpha = l.alpha ?? 1;
      ctx.globalCompositeOperation = BLEND[l.blend] ?? 'source-over';
      ctx.drawImage(t.source.image, t.cutX, t.cutY, t.cutWidth, t.cutHeight,
        Math.round((l.dx - minX) * px), Math.round((l.dy - minY) * px),
        Math.round(t.cutWidth * px), Math.round(t.cutHeight * px));
    }
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
    this.box = { x: minX, y: minY };
    this.scale = scale;
    this.drawnKey = sig;
    this.place();
  }

  destroy() {
    document.body.classList.remove(BODY_CLASS);
    this.canvas.remove();
  }
}
