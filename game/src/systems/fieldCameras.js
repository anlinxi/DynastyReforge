import { STAGE_WIDTH, STAGE_HEIGHT } from '../config.js';
import DEPTH, { SPRITE_MAX } from './depths.js';
import { stageView, onStageViewChange, WIDE_ENABLED } from './stageView.js';

/**
 * 地图场景的三台相机（宽屏视野，见 docs/专题/宽屏视野.md）：
 *
 * | 相机（由下到上） | 视口 | 画什么 |
 * |---|---|---|
 * | 世界（scene.cameras.main） | 整个舞台宽 | 地面、人物、遮挡、网点虚影、过场精灵等跟着地图走的东西 |
 * | 自由界面 | 整个舞台宽 | 打了 `ycFree` 标记的东西（对话立绘）：原作里立绘贴着画面边缘、在边缘处截断，宽屏下截断边落在画面中间很怪，所以不裁剪、贴舞台左/右边缘（见 `uiShift`） |
 * | 界面 | 居中的 640×480 | 对白框、菜单、HUD、商店等 scrollFactor 为 0 且高于精灵层的东西；菜单滑入的画外起点被裁掉，与原作一致 |
 * | 全幅 | 整个舞台宽 | 打了 `ycFullStage` 标记的东西（黑幕、整屏界面时两侧的黑幕），盖住界面 |
 *
 * 分法沿用战斗镜头（battleCamera.js）：用 `cameraFilter`（位掩码，表示"不被该相机画"）把顶层对象分给相机，
 * 点击命中也按它判断。深度层次集中在 depths.js，界面层都在精灵层 SPRITE_MAX 之上。
 * 每帧渲染前重新归类：对象的深度、可见性、scrollFactor 可能创建之后才设；只改自己那三位，不碰别处用过的位（如读条镜头的 ignore）。
 *
 * `?view=43`（原版 4:3）时不创建，行为与原来完全一致。
 */

/** 这个对象该由哪台相机画：'world' | 'free' | 'ui' | 'top'。 */
export function viewOf(child) {
  if (child.ycFullStage) return 'top';
  if (child.ycFree) return 'free';
  if (child.scrollFactorX === 0 && child.depth > SPRITE_MAX) return 'ui';
  return 'world';
}

/**
 * 对话立绘的横向位移。立绘是贴着原作画面左/右边缘的半身像，本身在边缘处被截断；
 * 宽屏下对白框仍居中，立绘改贴舞台的左/右边缘（中心在左半的贴左、右半的贴右），截断边仍在画面边缘。
 * 没装宽屏相机的场景恒为 0。
 */
export function uiShift(scene, centerX) {
  if (!scene.fieldCameras) return 0;
  return centerX < STAGE_WIDTH / 2 ? 0 : 2 * stageView().offsetX;
}

/** 整屏界面（菜单、商店、客栈）开着时，两侧盖黑，不露出背后的地图。 */
function addWingCurtains(scene) {
  const make = () => {
    const r = scene.add.rectangle(0, 0, 1, STAGE_HEIGHT, 0x000000).setOrigin(0, 0)
      .setScrollFactor(0).setDepth(DEPTH.MENU - 1).setVisible(false);
    r.ycFullStage = true;
    return r;
  };
  const left = make();
  const right = make();
  // 各向界面区里伸进 1 像素：界面底图最外一列带一道浅色边（原作贴着画面边缘看不出），宽屏下紧挨黑边就成了细线
  const layout = ({ width, offsetX }) => {
    left.setSize(offsetX + 1, STAGE_HEIGHT).setPosition(0, 0);
    right.setSize(offsetX + 1, STAGE_HEIGHT).setPosition(width - offsetX - 1, 0);
  };
  layout(stageView());
  return { left, right, layout };
}

/** @returns {{ destroy: () => void } | null} */
export function installFieldCameras(scene) {
  if (!WIDE_ENABLED) return null;
  const { cameras } = scene;
  const world = cameras.main;
  const { width, offsetX } = stageView();
  const free = cameras.add(0, 0, width, STAGE_HEIGHT);
  const ui = cameras.add(offsetX, 0, STAGE_WIDTH, STAGE_HEIGHT);
  const top = cameras.add(0, 0, width, STAGE_HEIGHT);
  const mine = world.id | free.id | ui.id | top.id;
  const others = (...keep) => mine & ~keep.reduce((a, c) => a | c.id, 0);
  const hiddenFrom = {
    world: others(world), free: others(free), ui: others(ui), top: others(top),
  };
  const wings = addWingCurtains(scene);

  const assign = () => {
    const covered = Boolean(scene.fullScreenUiOpen?.());
    wings.left.setVisible(covered);
    wings.right.setVisible(covered);
    for (const child of scene.children.list) {
      child.cameraFilter = (child.cameraFilter & ~mine) | hiddenFrom[viewOf(child)];
    }
  };
  const relayout = (view) => {
    ui.setViewport(view.offsetX, 0, STAGE_WIDTH, STAGE_HEIGHT);
    free.setViewport(0, 0, view.width, STAGE_HEIGHT);
    top.setViewport(0, 0, view.width, STAGE_HEIGHT);
    wings.layout(view);
  };

  scene.sys.events.on('prerender', assign);
  const offResize = onStageViewChange(relayout);
  const destroy = () => {
    scene.sys.events.off('prerender', assign);
    offResize();
  };
  scene.sys.events.once('shutdown', destroy);
  return { destroy };
}
