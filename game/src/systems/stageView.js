import { STAGE_WIDTH, STAGE_HEIGHT } from '../config.js';

/**
 * 宽屏视野（PLAT-01，见 docs/专题/宽屏视野.md）：舞台宽度可变，高度固定 480。
 *
 * - 界面（菜单、对白、战斗界面等）永远是居中的 640×480，坐标一个字不改；
 * - 地图世界相机铺满整个舞台宽度，看到更多地图。
 *
 * 默认开（2026-10-02 用户定电脑默认宽屏）：宽度随窗口宽高比，640 ≤ 宽 ≤ WIDE_MAX；网址 `?view=43` 退回原版 4:3（宽度恒 640）。
 */

/** 宽屏舞台宽度上限：19.5:9 的手机横屏（480×19.5/9 = 1040）刚好占满；更宽的屏幕两侧留黑。 */
export const WIDE_MAX = 1040;

/** 窗口 → 舞台宽度。纯函数；宽度取偶数，保证两侧留边相等。 */
export function viewWidthFor(innerWidth, innerHeight, wide, max = WIDE_MAX) {
  if (!wide || !(innerWidth > 0) || !(innerHeight > 0)) return STAGE_WIDTH;
  const raw = Math.round((STAGE_HEIGHT * innerWidth) / innerHeight);
  const even = raw - (raw % 2);
  return Math.min(max, Math.max(STAGE_WIDTH, even));
}

/** 是否宽屏：默认开，网址 `?view=43` 关。没有浏览器环境（Node 测试）按关。 */
export function wideRequested() {
  try {
    return new URLSearchParams(window.location.search).get('view') !== '43';
  } catch {
    return false;
  }
}

export const WIDE_ENABLED = wideRequested();

let current = Object.freeze({ width: STAGE_WIDTH, offsetX: 0 });
const listeners = new Set();

/** 当前舞台：`width` 总宽，`offsetX` 居中 640 界面区的左边距。 */
export function stageView() {
  return current;
}

/** 按窗口重算并通知订阅者；返回是否变化。 */
export function updateStageView(innerWidth, innerHeight) {
  const width = viewWidthFor(innerWidth, innerHeight, WIDE_ENABLED);
  if (width === current.width) return false;
  current = Object.freeze({ width, offsetX: (width - STAGE_WIDTH) / 2 });
  for (const listener of listeners) listener(current);
  return true;
}

/** 订阅舞台宽度变化；返回取消订阅函数。 */
export function onStageViewChange(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * 指针在 640 界面坐标里的位置（界面代码按 640 坐标写，宽屏时要扣掉左边距）。
 * `board` 是贴战场右边缘的战斗界面（`ycRight`，见 battleCameras.js）时，再扣掉它的右移量。
 */
export function uiPointer(pointer, board = null) {
  const shift = board?.ycRight ? board.scene?.battleRightShift ?? 0 : 0;
  return { x: pointer.x - current.offsetX - shift, y: pointer.y };
}

/**
 * 没有改造成宽屏的场景（标题、读条、战斗……）：主相机视口只取居中的 640×480，两侧留黑，
 * 与现在的 4:3 观感一致。窗口变化时跟着重新居中；场景关闭时自动取消订阅。
 */
export function centerLegacyScene(scene) {
  const apply = ({ offsetX }) => scene.cameras.main.setViewport(offsetX, 0, STAGE_WIDTH, STAGE_HEIGHT);
  apply(current);
  const off = onStageViewChange(apply);
  scene.sys.events.once('shutdown', off);
}

/**
 * 地图相机的横向边界。
 * - 地图比舞台宽出 2 个收边：四周各收 `inset` 像素（藏原作底图最外一行的白线）；
 * - 地图比舞台窄：边界撑到舞台宽并让地图居中，两侧留黑（相机夹到边界时不会自己居中）；
 * - 其余：原样。
 */
export function cameraBoundsX(mapWidth, viewWidth, inset) {
  if (mapWidth >= viewWidth + 2 * inset) return { x: inset, width: mapWidth - 2 * inset };
  if (mapWidth < viewWidth) return { x: -(viewWidth - mapWidth) / 2, width: viewWidth };
  return { x: 0, width: mapWidth };
}

/** 战场画面宽度上限：战斗背景原图宽 800（现在居中裁成 640，两侧各 80 本是镜头余量），再宽没有美术。 */
export const BATTLE_WIDE_MAX = 800;

/** 舞台宽 → 战场画面：`width` 宽度，`offsetX` 它在舞台里的左边距，`scrollX` 世界相机的基准横向滚动（让 640 世界居中）。纯函数。 */
export function battleViewFor(stageWidth) {
  const width = Math.min(Math.max(stageWidth, STAGE_WIDTH), BATTLE_WIDE_MAX);
  return { width, offsetX: (stageWidth - width) / 2, scrollX: -(width - STAGE_WIDTH) / 2 };
}

export const battleView = () => battleViewFor(current.width);
