import { STAGE_WIDTH, STAGE_HEIGHT } from '../config.js';
import { WORLD_DEPTH_MAX } from './battleCamera.js';
import { paintBackdrop } from './battleBackdrop.js';
import { WIDE_ENABLED, battleView, centerLegacyScene, onStageViewChange, stageView } from './stageView.js';

/**
 * 战斗场景的五台相机（宽屏视野，见 docs/专题/宽屏视野.md）：
 *
 * | 相机（由下到上） | 视口 | 画什么 |
 * |---|---|---|
 * | 战场（scene.cameras.main） | 居中的 min(舞台宽, 800) | 背景、人物、特效；随战斗镜头推移/放大/震动，基准滚动 `battleBaseScrollX` 让 640 世界居中 |
 * | 补边 | 整个舞台 | 打了 `ycBack` 标记的补边图（battleBackdrop.js）：两侧模糊压暗的背景，战场边缘渐隐 |
 * | 界面 | 居中的 640×480 | 状态栏、结算等 scrollFactor 为 0 且深度高于战场层的东西，坐标一个字不改 |
 * | 右侧界面 | 居中 640 整个右移到右缘贴战场右边缘 | 打了 `ycRight` 标记的：时轮、指令框与法寶/絕學页、复活目标（用户 2026-10-02：时轮与指令框同一列，贴战场右边缘）；裁剪框与原作 640 一样，只是右移，画外停放/滑入的板照样看不见 |
 * | 顶层 | 整个舞台 | 打了 `ycTop` 标记的：进场截图、破碎转场（铺满舞台，宽 `coverWidth`）、读条字；这些都 scrollFactor 0，按舞台坐标摆 |
 *
 * 分法沿用战斗镜头原有规则（深度 > WORLD_DEPTH_MAX 或 scrollFactor 为 0 归界面），每帧渲染前归类，
 * 只改自己那几位 cameraFilter。舞台宽不超过 640（没开宽屏）时退回居中 640 的旧做法。
 */

const BACKDROP_KEY = 'battle-wide-backdrop';

/** 界面坐标 → 右侧界面的右移量（相对居中 640）。 */
const rightShiftOf = (bv) => (bv.width - STAGE_WIDTH) / 2;

/** 把场景上的几项布局数写到 scene（战斗代码读这些，不用关心有没有开宽屏）。 */
function publish(scene, bv, stageWidth) {
  scene.battleWidth = bv.width;
  scene.battleBaseScrollX = bv.scrollX;
  scene.battleRightShift = rightShiftOf(bv);
  scene.coverWidth = stageWidth; // 顶层相机（整个舞台）的宽
}

/**
 * `make()` 里新建的顶层对象都标成“右侧界面”。滑板后来补建的行、数字、图标都加进各自的容器，不会漏。
 * 没开宽屏时标了也没有相机读它，不影响。
 */
export function rightAnchored(scene, make) {
  const before = new Set(scene.children.list);
  const out = make();
  for (const child of scene.children.list) if (!before.has(child)) child.ycRight = true;
  return out;
}

/** @returns {{ backdrop: (floor: Phaser.GameObjects.Image) => void, destroy: () => void } | null} */
export function installBattleCameras(scene) {
  if (!WIDE_ENABLED || stageView().width <= STAGE_WIDTH) {
    centerLegacyScene(scene);
    publish(scene, { width: STAGE_WIDTH, offsetX: 0, scrollX: 0 }, STAGE_WIDTH);
    return null;
  }
  const { cameras } = scene;
  const world = cameras.main;
  const back = cameras.add(0, 0, STAGE_WIDTH, STAGE_HEIGHT);
  const ui = cameras.add(0, 0, STAGE_WIDTH, STAGE_HEIGHT);
  const right = cameras.add(0, 0, STAGE_WIDTH, STAGE_HEIGHT);
  const top = cameras.add(0, 0, STAGE_WIDTH, STAGE_HEIGHT);
  const all = [world, back, ui, right, top];
  const mine = all.reduce((a, c) => a | c.id, 0);
  const hidden = Object.fromEntries(Object.entries({ world, back, ui, right, top })
    .map(([name, cam]) => [name, mine & ~cam.id]));

  let floor = null;
  let backImage = null;
  const drawBackdrop = () => {
    if (!floor?.active) return;
    const { width } = stageView();
    const bv = battleView();
    if (width <= bv.width) { backImage?.setVisible(false); return; } // 战场已铺满舞台，没有两侧
    const canvas = document.createElement('canvas');
    paintBackdrop(canvas, floor.texture.getSourceImage(), {
      stageWidth: width, height: STAGE_HEIGHT, floorWidth: floor.displayWidth, floorHeight: floor.displayHeight,
      fieldX: bv.offsetX, fieldWidth: bv.width,
    });
    if (scene.textures.exists(BACKDROP_KEY)) scene.textures.remove(BACKDROP_KEY);
    scene.textures.addCanvas(BACKDROP_KEY, canvas);
    if (!backImage) {
      backImage = scene.add.image(0, 0, BACKDROP_KEY).setOrigin(0, 0).setScrollFactor(0);
      backImage.ycBack = true;
    }
    backImage.setTexture(BACKDROP_KEY).setVisible(true);
  };

  const layout = () => {
    const { width, offsetX } = stageView();
    const bv = battleView();
    world.setViewport(bv.offsetX, 0, bv.width, STAGE_HEIGHT);
    back.setViewport(0, 0, width, STAGE_HEIGHT);
    ui.setViewport(offsetX, 0, STAGE_WIDTH, STAGE_HEIGHT);
    right.setViewport(offsetX + rightShiftOf(bv), 0, STAGE_WIDTH, STAGE_HEIGHT);
    top.setViewport(0, 0, width, STAGE_HEIGHT);
    publish(scene, bv, width);
  };
  layout();
  world.setScroll(scene.battleBaseScrollX, 0);

  const assign = () => {
    for (const child of scene.children.list) {
      const view = child.ycBack ? 'back' : child.ycTop ? 'top' : child.ycRight ? 'right'
        : (child.depth > WORLD_DEPTH_MAX || child.scrollFactorX === 0) ? 'ui' : 'world';
      child.cameraFilter = (child.cameraFilter & ~mine) | hidden[view];
    }
  };
  scene.sys.events.on('prerender', assign);
  const offResize = onStageViewChange(() => { layout(); drawBackdrop(); });
  const destroy = () => {
    scene.sys.events.off('prerender', assign);
    offResize();
  };
  scene.sys.events.once('shutdown', destroy);
  return {
    /** 本场背景画好后调用，按它做两侧补边。 */
    backdrop: (image) => { floor = image; drawBackdrop(); },
    destroy,
  };
}
