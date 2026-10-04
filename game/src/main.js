import Phaser from 'phaser';
import CursorScene from './scenes/CursorScene.js';
import BootScene from './scenes/BootScene.js';
import FieldScene from './scenes/FieldScene.js';
import BattleScene from './scenes/BattleScene.js';
import TitleScene from './scenes/TitleScene.js';
import LoadingScene from './scenes/LoadingScene.js';
import { STAGE_HEIGHT } from './config.js';
import { installRuntimeDiagnostics } from './systems/runtimeDiagnostics.js';
import { HD_ENABLED, hdGameConfig, installHdRender, refreshHdCanvas } from './hd/hdRender.js';
import { WIDE_ENABLED, stageView, updateStageView } from './systems/stageView.js';
import { createVirtualKeys } from './systems/virtualKeys.js';
import { installGamepad } from './systems/gamepadSource.js';
import { mountTouchControls, touchEnabled } from './systems/touchControls.js';
import { onSafeAreaChange, safeViewport } from './systems/safeArea.js';
import { installBackgroundAudio } from './systems/backgroundAudio.js';
import { bgmStreamElements } from './systems/bgm.js';
import { installDiagnostics } from './systems/diagnostics.js';

/**
 * 画面只按**整数倍**放大。
 *
 * 原作是 640×480 上 1:1 显示的点阵素材——字体是 24×24 的死像素图，
 * 没有矢量轮廓。用 `Scale.FIT` 撑满窗口会得到 1.875 这类倍数，
 * 1 个原始像素要摊到 1.875 个屏幕像素上、除不尽，于是同一个字里
 * 横画有的 1 像素、有的 2 像素，笔画粗细不匀，整个画面发虚。
 * 整数缩放只能避免重采样；字模索引、字形语言和原作绘字字重另查FONT-01，
 * 不能据此认定所有字体差异都来自缩放。
 *
 * 取能放进窗口的最大整数倍。
 * ⚠️ **窗口连 1 倍都放不下时（手机横屏只有约 750×382）按实际比例缩小**，不能锁在 1 倍：
 * 从前“至少 1 倍、宁可露出画面外”是按电脑大窗口写的，到了手机上画布四边溢出，
 * 对白框、菜单被切掉（2026-10-03 iPhone 模拟器）。缩小必然重采样，但看不全更糟。
 */
function integerZoom() {
  // 手机：按扣掉灵动岛/圆角后的安全区算（systems/safeArea.js；电脑上就是窗口尺寸）
  const { width, height } = safeViewport();
  const fit = Math.min(width / stageView().width, height / STAGE_HEIGHT);
  // 高清（默认开，?hd=0 关）：画布按屏幕实际像素画、点阵字走 xBR，小数倍不再有笔画粗细不匀，
  // 所以按窗口放满（4:3 在宽屏上只留左右黑边）。原版仍只取整数倍。
  if (fit < 1) return fit;
  if (HD_ENABLED) return fit;
  return Math.floor(fit);
}

// 宽屏视野（默认开，?view=43 退回 4:3，见 systems/stageView.js）：舞台宽度随窗口（安全区）宽高比。
const initialView = safeViewport();
updateStageView(initialView.width, initialView.height);

// 宽屏：两侧留边与房间等地图自带的纯黑底一致
if (WIDE_ENABLED) document.documentElement.style.background = document.body.style.background = '#000000';

const game = new Phaser.Game({
  type: Phaser.AUTO,
  parent: 'game',
  width: stageView().width,
  height: STAGE_HEIGHT,
  backgroundColor: WIDE_ENABLED ? '#000000' : '#0d0b0a',
  pixelArt: true,
  physics: { default: 'arcade' },
  // NONE + zoom：自己控制倍数，不让 FIT 算出小数
  scale: {
    mode: Phaser.Scale.NONE,
    autoCenter: Phaser.Scale.CENTER_BOTH,
    zoom: integerZoom(),
  },
  // ⚠️ **`Battle` 不是入口，是被拉起来的。** 打开游戏进的永远是 `Boot`；
  // 战斗由剧情的 `battle` 指令（op55）从 `FieldScene` 拉起，打完自己回去。
  // 特效浏览页那个开发期入口 2026-09-05 删了，没有恢复。
  // ⚠️ **`Boot` 仍是入口**，它载完资源去 `Title`（标题画面），
  // 选了「新章初始」才回 `Boot` 进 `Field`。`Battle` 由 op55 拉起。
  scene: [BootScene, TitleScene, LoadingScene, FieldScene, BattleScene, CursorScene],
  // 高清（默认开，?hd=0 关）：xBR 管线设为默认；未开时为空，不影响原行为
  ...hdGameConfig(),
});
installHdRender(game);
// 诊断模式入口（平时不采样；桌面版 YC_DIAG=1 启动时由主进程开启，见 systems/diagnostics.js）
installDiagnostics(game);

// 切到后台（手机回主屏幕、电脑最小化）时停背景音乐、影片与音效，回来再接着放。见 systems/backgroundAudio.js
installBackgroundAudio({ game, media: () => [...bgmStreamElements(), ...document.querySelectorAll('video')] });

// 手柄（以后的手机触屏同用这个核心）：模拟成键盘事件，现有按键逻辑不用改。见 systems/virtualKeys.js。
// 先对账各来源，再由核心补发按住的重复按键——每帧一次，不随来源数量重复。
const virtualKeys = createVirtualKeys();
const onFrame = (cb) => game.events.on(Phaser.Core.Events.PRE_STEP, cb);
installGamepad({ keys: virtualKeys, onFrame });
onFrame(() => virtualKeys.tick());
// 手机触屏：左下摇杆、右下確認/返回，同用上面的核心（?touch=1 强制显示，?touch=0 关）
if (touchEnabled(window.location.search, {
  maxTouchPoints: navigator.maxTouchPoints ?? 0,
  coarse: window.matchMedia?.('(pointer: coarse)').matches === true,
})) {
  mountTouchControls({
    keys: virtualKeys,
    // 地图上自由行走时，推着摇杆按確認＝走/跑切换
    canToggleRun: () => {
      const field = game.scene.getScene('Field');
      return Boolean(field?.scene.isActive() && field.fieldInputAvailable?.());
    },
  });
}

// 窗口或手机安全区变化时重算舞台宽与倍数
function relayout() {
  // 宽度变了先改舞台（各场景相机跟着订阅更新），再算倍数
  const view = safeViewport();
  if (updateStageView(view.width, view.height)) {
    game.scale.resize(stageView().width, STAGE_HEIGHT);
  }
  const zoom = integerZoom();
  if (zoom !== game.scale.zoom) game.scale.setZoom(zoom);
  refreshHdCanvas(game);
}
window.addEventListener('resize', relayout);
// ⚠️ iPhone 的安全区数值在 App 刚启动时可能还是 0，稍后才补上，而窗口尺寸不变、不发 resize：
// 画布按整屏算、页面留白却生效，画布左边钻进灵动岛、战斗顶部血条超出屏幕（2026-10-03 真机）。
onSafeAreaChange(relayout);

// 开发用遥控通道：网址带 ?remote 才连（iPhone 模拟器/真机测试用）；构建时整段被裁掉。见 verify/remoteControl.mjs
if (import.meta.env.DEV && new URLSearchParams(window.location.search).has('remote')) {
  import('./dev/remoteControl.js').then((m) => m.startRemoteControl());
}

// 便于开发期从控制台/自动化脚本检查运行时状态
window.__GAME__ = game;
installRuntimeDiagnostics(game);
