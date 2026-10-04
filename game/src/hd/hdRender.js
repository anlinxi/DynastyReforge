import Phaser from 'phaser';
import { XbrPipeline, XBR_PIPELINE } from './xbrPipeline.js';
import { alignedCanvasSize } from './canvasAlign.js';

/**
 * 高清渲染（UI-10 H2）：2026-09-30 起默认开；网址带 `?hd=0` 时关闭，行为与原版完全一样。
 *
 * 做法：**游戏逻辑仍是 640×480**（坐标、镜头、鼠标、碰撞/遮挡掩码、菜单坐标都不动），
 * 只把 WebGL 画布的实际像素提到 640×480 × 倍数 k（= 整数放大倍数 × 屏幕倍率），
 * 投影矩阵照旧按 640×480，视口和裁剪区在底层乘 k。于是：
 * - 高清贴图（地图底图、立绘、战斗背景）按原尺寸显示时，能用满屏幕像素；
 * - 原作像素素材走 xBR 着色器（xbrPipeline.js），按屏幕像素算平滑边缘；
 * - 系统字体的 Text 按 k 倍分辨率栅格。
 *
 * 限制：只处理默认帧缓冲；本项目没有用离屏渲染/遮罩/后处理（2026-09-29核对），
 * 以后引入这些要重新核对。
 */

/** 标题页“画面”选择记在这里（见 hdChoice.js）：'0' 原版、'1' 高清。 */
export const HD_STORAGE_KEY = 'youcheng-hd';

/**
 * 高清默认开（用户 2026-09-30 决定，D-21）。优先级：网址 `hd=0/1` > 标题页的选择 > 默认开。
 * 没有浏览器环境（Node 测试）时按原版。
 */
function hdRequested() {
  try {
    const param = new URLSearchParams(window.location.search).get('hd');
    if (param !== null) return param !== '0';
    // 手机 App 一律原版（用户 2026-10-03）：高清 AI 图让真机内存触上限、进战斗被系统关掉；
    // 安装包也不带 assets-hd（mobile/package.json 的 capacitor:copy:after）。
    if (inNativeApp()) return false;
    return window.localStorage?.getItem(HD_STORAGE_KEY) !== '0';
  } catch {
    return typeof window !== 'undefined';
  }
}

/** 装在手机 App（Capacitor 原生壳）里运行？壳在页面脚本之前注入 `window.Capacitor`。 */
export function inNativeApp() {
  try {
    return Boolean(window.Capacitor?.isNativePlatform?.());
  } catch {
    return false;
  }
}

export const HD_ENABLED = hdRequested();

/** 诊断开关：`hdxbr=0` 关 xBR、`hdassets=0` 不用 AI 高清图（拆分卡顿来源用）。 */
function hdParam(name) {
  try {
    return new URLSearchParams(window.location.search).get(name);
  } catch {
    return null;
  }
}
// xBR 默认开（2026-09-30 单一管线重写后：沙州城、战斗、迦夏之窟实测均 60 帧）；`hdxbr=0` 关。
const XBR_ENABLED = HD_ENABLED && hdParam('hdxbr') !== '0';
export const HD_ASSETS_ENABLED = HD_ENABLED && hdParam('hdassets') !== '0';

let factor = 1;

/** 当前实际像素 / 逻辑像素的倍数；未开高清时恒为 1。 */
export function hdFactor() {
  return factor;
}

/**
 * 画布绘制倍数上限（实际像素 / 逻辑像素）。显示照旧铺满窗口，只是超过上限的部分交给显卡放大。
 * 2026-10-03 用户全屏实测（MacBook 1792×1120 视网膜屏）：满分辨率 4.67 倍时画布 3584×2240，
 * 显卡画不过来，地图 37–39 帧、天书 27–29 帧；封顶 3 倍后地图 52–59 帧、天书 46–58 帧。
 * 诊断参数 `hdk=` 可改上限（如 `hdk=4` 试更清晰，`hdk=99` 等于不封顶）。
 */
const HD_FACTOR_CAP = 3;

/** 实际像素 / 逻辑像素。高清下画面可按小数倍放满窗口，所以不取整。 */
function computeFactor(zoom) {
  const forced = Number(hdParam('hdk'));
  const cap = forced > 0 ? forced : HD_FACTOR_CAP;
  const dpr = window.devicePixelRatio || 1;
  return Math.max(1, Math.min(zoom * dpr, cap));
}

/** 横竖各自的换算系数（画布尺寸取整后按实际比例算，避免边缘差一像素）。 */
let fx = 1;
let fy = 1;

/** 供 Phaser.Game 配置合并：注册 xBR 管线并设为默认。未开高清返回空对象。 */
export function hdGameConfig() {
  if (!XBR_ENABLED) return {};
  // 单一管线：所有东西都走它（底子是原生多贴图管线），人物与点阵字靠 ycXbr 标记才做 xBR。
  // 不能“只给人物换管线”：与原生管线交错切换时沙州城实测 6.6 帧。
  return { pipeline: { [XBR_PIPELINE]: XbrPipeline }, defaultPipeline: XBR_PIPELINE };
}

/** 包装 gl 的视口/裁剪：只在画默认帧缓冲时把逻辑像素换成实际像素。 */
function wrapGl(gl) {
  let boundFramebuffer = null;
  const bindFramebuffer = gl.bindFramebuffer.bind(gl);
  const viewport = gl.viewport.bind(gl);
  const scissor = gl.scissor.bind(gl);
  gl.bindFramebuffer = (target, fb) => { boundFramebuffer = fb; bindFramebuffer(target, fb); };
  const scaled = (fn) => (x, y, w, h) => {
    if (boundFramebuffer) return fn(x, y, w, h);
    const x0 = Math.round(x * fx), y0 = Math.round(y * fy);
    return fn(x0, y0, Math.round((x + w) * fx) - x0, Math.round((y + h) * fy) - y0);
  };
  gl.viewport = scaled(viewport);
  gl.scissor = scaled(scissor);
}

function patchRenderer(game) {
  const renderer = game.renderer;
  const canvas = game.canvas;
  wrapGl(renderer.gl);
  const resize = renderer.resize.bind(renderer);
  let lastSize = null;
  renderer.resize = (width, height) => {
    factor = computeFactor(game.scale.zoom);
    const { w: cw, h: ch } = alignedCanvasSize(width * factor, height * factor);
    if (canvas.width !== cw || canvas.height !== ch) {
      canvas.width = cw;
      canvas.height = ch;
    }
    // 显示尺寸：没封顶时按画布实际像素换算（取整数设备像素，免得浏览器重采样）；
    // 封顶时画布比屏幕像素少，显示照旧按“逻辑尺寸 × 缩放”铺满窗口，由显卡放大
    // （2026-10-03：封顶首试把显示也跟着缩小了，画面小一圈、四周黑边，用户指出）。
    const dpr = window.devicePixelRatio || 1;
    const capped = factor < game.scale.zoom * dpr - 1e-6;
    canvas.style.width = capped ? `${width * game.scale.zoom}px` : `${cw / dpr}px`;
    canvas.style.height = capped ? `${height * game.scale.zoom}px` : `${ch / dpr}px`;
    // ⚠️ 上面改了画布显示尺寸，居中后画布位置会挪一点；同步给 Phaser，否则它每 0.5 秒检查时
    // 以为画布变了又重排一次，形成循环（2026-10-03 用户全屏实玩：每秒重设两次）。
    const syncBounds = () => game.scale.updateBounds?.();
    // ⚠️ 尺寸其实没变就**不重建显卡缓冲区**：原 resize 会让每条管线重建帧缓冲并 checkFramebufferStatus
    // 同步等显卡，实测每次 50~100 毫秒以上，是“走路卡、鼠标卡”的元凶（诊断日志 diag-20261003-204557）。
    const size = `${width}x${height}@${cw}x${ch}`;
    if (size === lastSize) { syncBounds(); return renderer; }
    lastSize = size;
    fx = cw / width;
    fy = ch / height;
    resize(width, height);
    // Phaser 用 drawingBufferHeight 翻转裁剪区的 y；保持逻辑单位，由 gl.scissor 包装统一乘倍数
    renderer.drawingBufferHeight = height;
    renderer.gl.scissor(0, 0, width, height);
    renderer.pipelines.get(XBR_PIPELINE)?.setScale(factor);
    syncBounds();
    return renderer;
  };
  const resetViewport = renderer.resetViewport.bind(renderer);
  renderer.resetViewport = () => {
    resetViewport();
    renderer.drawingBufferHeight = renderer.height;
  };
  renderer.resize(game.scale.width, game.scale.height);
}

/** 系统字体 Text 按实际像素栅格，且不走 xBR（它已是屏幕分辨率）。 */
function patchText() {
  const proto = Phaser.GameObjects.Text.prototype;
  const updateText = proto.updateText;
  proto.updateText = function updateHdText() {
    if (this.style.resolution !== factor) this.style.resolution = factor;
    return updateText.call(this);
  };
}

/**
 * 按贴图键登记的高清倍数（立绘、菜单形象、界面包头像等"沿用原键名"的高清图）。
 * 图片对象一换到这些贴图，就自动缩到 1/倍数 显示并用线性采样——各处绘制代码不用改。
 * 地图底图、战斗背景另用独立键名（addHdImage 自行缩放），不在这里登记。
 */
const hdKeyScale = new Map();

/** 贴图键登记的高清倍数；未登记为 1。 */
export function hdScaleOf(key) {
  return hdKeyScale.get(key) ?? 1;
}

/** 按贴图键打 xBR 标记（菜单里的像素小人等），图片对象换到这些贴图时自动带上 ycXbr。 */
const xbrKeys = new Set();

export function registerXbrKey(key) {
  if (XBR_ENABLED) xbrKeys.add(key);
}

/**
 * @param {boolean} [linear] 线性采样。4 倍的人物图（单张）用线性；2 倍的界面图用最近邻——
 *   界面图多是一张表里的格子拼贴，线性采样会混进相邻格的透明像素，拼接处出细缝（2026-09-30 截图）。
 */
export function registerHdKey(key, scale, linear = true) {
  if (HD_ASSETS_ENABLED && scale > 1) {
    hdKeyScale.set(key, scale);
    if (!linear) nearestKeys.add(key);
  }
}

const nearestKeys = new Set();

function patchImage() {
  const proto = Phaser.GameObjects.Image.prototype;
  const setFrame = proto.setFrame;
  proto.setFrame = function setHdFrame(frame, updateSize, updateOrigin) {
    const result = setFrame.call(this, frame, updateSize, updateOrigin);
    const texture = this.texture;
    if (xbrKeys.has(texture?.key)) this.ycXbr = true;
    const s = hdKeyScale.get(texture?.key) ?? 1;
    const prev = this.hdScale ?? 1;
    if (s !== prev) {
      this.setScale(this.scaleX * prev / s, this.scaleY * prev / s);
      this.hdScale = s;
    }
    if (s > 1 && !texture.hdFilterSet) {
      texture.setFilter(nearestKeys.has(texture.key)
        ? Phaser.Textures.FilterMode.NEAREST : Phaser.Textures.FilterMode.LINEAR);
      texture.hdFilterSet = true;
    }
    return result;
  };
}

/** 窗口变化后重新对齐画布（缩放倍数没变时 Phaser 不会触发 RESIZE）。 */
export function refreshHdCanvas(game) {
  if (HD_ENABLED && game.renderer?.type === Phaser.WEBGL) game.renderer.resize(game.scale.width, game.scale.height);
}

/** 在 new Phaser.Game 之后调用；未开高清或非 WebGL 时什么也不做。 */
export function installHdRender(game) {
  if (!HD_ENABLED) return;
  const install = () => {
    if (game.renderer?.type !== Phaser.WEBGL) return;
    patchText();
    patchImage();
    if (XBR_ENABLED && hdParam('hdfont') !== '0') patchBitmapText(); // hdfont=0：点阵字不平滑
    patchRenderer(game);
    game.scale.on(Phaser.Scale.Events.RESIZE, () => game.renderer.resize(game.scale.width, game.scale.height));
  };
  if (game.isBooted) install();
  else game.events.once(Phaser.Core.Events.BOOT, install);
}

/** 人物精灵（地图人物、战斗单位与特效）打 xBR 标记；未开 xBR 时标记无人理会。 */
export function useXbr(gameObject) {
  if (XBR_ENABLED && gameObject) gameObject.ycXbr = true;
  return gameObject;
}

/**
 * 菜单里的点阵字（物品名、说明、数值）的 xBR 开关：网址 `menufont=crisp` 时不走 xBR，保持原作点阵的锐利笔画；
 * 默认仍走 xBR（与对白字一致）。用户 2026-10-02 嫌菜单字偏糊偏粗，试过 crisp 后又说更糊，
 * 本机无头 Chrome 里 crisp 是清晰的、复现不出，所以先保持默认不变，留开关让用户在自己机器上 A/B。
 */
export function noXbr(gameObject) {
  if (gameObject && hdParam('menufont') === 'crisp') gameObject.ycXbr = false;
  return gameObject;
}

/** 点阵字（BitmapText 及其动态版）一律打 xBR 标记。 */
function patchBitmapText() {
  Phaser.GameObjects.BitmapText.prototype.ycXbr = true;
}

/** 高清贴图（按原尺寸显示、本身已是屏幕分辨率）不走 xBR，并用线性采样。 */
export function useHdTexture(gameObject) {
  if (!HD_ENABLED) return gameObject;
  gameObject.texture?.setFilter(Phaser.Textures.FilterMode.LINEAR);
  return gameObject;
}
