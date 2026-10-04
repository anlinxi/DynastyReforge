import { STAGE_WIDTH, STAGE_HEIGHT } from '../config.js';
import { stageView } from './stageView.js';

/**
 * **战斗镜头**（BTL-29），照官方 RPG.exe：
 *
 * - 0x43f520：SF2 对象每换一帧读帧上的震动、推移方向/拍数、跟随、放大、回中；
 * - 0x426a80：以当前镜头为起点、目标为终点开始移动；
 * - 0x426ba0：每拍线性插值（步 0 到 time，共 time+1 拍），跟随时终点每拍取被跟随对象；
 *   结果是全局镜头 0x8e1c84/0x8e1c88，人物、特效、背景都按「坐标 − 镜头」画；
 * - 0x442be6：一次行动结束，取消跟随并在 5 拍内回中、还原放大。
 *
 * 推移量是真实像素：天護靈燁 `EFF1382` 第1帧向上 600，光兽画在 y≈−489 才进得了画面。
 * 放大 z：0x426c81 按左右各 z/2、上下各 3z/8 裁掉再铺满，即以画面中心放大 640/(640−z) 倍。
 *
 * 画面分两台镜头：主镜头画战场（深度 ≤ WORLD_DEPTH_MAX：背景、人物、特效、“避”字），
 * 界面镜头画状态栏、指令、时轮等，不随推移/放大动。原作放大时界面是否一起放大未核（推断不放大）。
 * 镜头不在原位时才启用界面镜头，平时与原先单镜头完全一样。
 */

/** 小键盘方向的推移量（0x43f5e1/0x43f5f0/0x43f608/0x43f612）。 */
export const PAN = Object.freeze({ x: 800, y: 600 });
/** 一次行动结束回中用的拍数（0x442bd0）。 */
export const RESET_TICKS = 5;
/** 放大字段 1/3 与跟随字段 2/4 用的 z（0x43f646/0x43f705）。 */
const ZOOM_IN = 320;
const FOLLOW_ZOOM = 280;
/** 震动模式 2：三拍一轮，逐拍累加到镜头上，一轮净移为零（0x426d7e）。 */
const SHAKE_STEPS = Object.freeze([[-3, -3], [6, -3], [-3, 6]]);
/** 战场层的深度上限：人物/特效 10~490（effects.animationDepth），“避”字 900；选中标记 920 起算界面。 */
export const WORLD_DEPTH_MAX = 900;

/** 方向码 → 镜头目标。0 表示本帧不推；超出 0~9 按 5（0x43f5c2）。 */
export function panTarget(dir) {
  const d = dir < 0 || dir > 9 ? 5 : dir;
  const col = (d - 1) % 3;
  const row = Math.trunc((d - 1) / 3);
  return {
    x: col === 0 ? -PAN.x : col === 2 ? PAN.x : 0,
    y: row === 0 ? PAN.y : row === 2 ? -PAN.y : 0,
  };
}

/** 插值与原作 idiv 一样向零截断。 */
function lerp(from, to, step, time) {
  return from + Math.trunc(((to - from) * step) / time);
}

/** z → 显示倍数。 */
export function zoomOf(z) {
  return STAGE_WIDTH / (STAGE_WIDTH - z);
}

/**
 * 一帧上的镜头指令（0x43f520 的派发顺序），纯函数，供测试。
 * @returns {Array<object>} move / follow / lock / unfollow / reset
 */
export function frameCommands(frame, currentZ) {
  const commands = [];
  const dir = frame.screen_move_dir ?? 0;
  const zoom = frame.screen_zoom ?? 0;
  const follow = frame.screen_follow ?? 0;
  let ticks = Math.max(1, frame.screen_move_time ?? 0);
  if (dir || zoom) {
    const at = dir ? panTarget(dir) : { x: 0, y: 0 };
    let z = currentZ;
    if (zoom === 1 || zoom === 3) z = ZOOM_IN;
    else if (zoom === 2) z = 0;
    if (zoom === 3) ticks = 1;
    commands.push({ type: 'move', to: { ...at, z }, ticks });
  }
  // 推移与跟随同帧时只认解除跟随（0x43f69a）。
  if (follow && (!dir || follow === 5)) {
    if (follow === 1 || follow === 2 || follow === 4) {
      commands.push({ type: 'follow', z: follow === 1 ? 0 : FOLLOW_ZOOM, ticks });
    }
    if (follow === 3 || follow === 4) commands.push({ type: 'lock' });
    if (follow === 5) commands.push({ type: 'unfollow' });
  }
  if (frame.screen_reset === 1) commands.push({ type: 'reset', ticks });
  return commands;
}

export default class BattleCamera {
  /** @param {number} tickMs 原作一拍的毫秒数，同 SF2Animator.TICK_MS（此处不引入以免测试加载 Phaser） */
  constructor(scene, tickMs) {
    this.scene = scene;
    this.tickMs = tickMs;
    this.main = scene.cameras.main;
    this.main.setScroll(scene.battleBaseScrollX ?? 0, 0).setZoom(1);
    this.ui = null;
    this.current = { x: 0, y: 0, z: 0 };
    this.view = { x: 0, y: 0 };
    this.move = null;
    this.subject = null;
    this.track = false;
    this.lock = false;
    this.shakeStep = -1;
    this.elapsed = 0;
  }

  /** SF2Animator 换帧时调用；animator 是带镜头字段那一帧所属的对象。 */
  onFrame(frame, animator) {
    if (frame.shake) this.shakeStep = Math.max(this.shakeStep, 0);
    for (const command of frameCommands(frame, this.current.z)) {
      if (command.type === 'move') this.moveTo(command.to, command.ticks);
      else if (command.type === 'follow') {
        this.subject = animator;
        this.track = true;
        this.moveTo({ ...subjectPoint(animator), z: command.z }, command.ticks);
      } else if (command.type === 'lock') {
        this.subject = animator;
        this.lock = true;
      } else if (command.type === 'unfollow') this.track = this.lock = false;
      else if (command.type === 'reset') this.reset(command.ticks);
    }
  }

  /** 行动结束（0x442be6）或帧上回中：取消跟随，回原位并还原放大。 */
  reset(ticks = RESET_TICKS) {
    this.track = this.lock = false;
    if (this.move || this.current.x || this.current.y || this.current.z || this.view.x || this.view.y) {
      this.moveTo({ x: 0, y: 0, z: 0 }, ticks);
    }
  }

  moveTo(to, ticks) {
    this.move = { from: { ...this.current }, to: { ...to }, time: Math.max(1, ticks), step: 0 };
  }

  update(delta) {
    this.elapsed += delta;
    while (this.elapsed >= this.tickMs) {
      this.elapsed -= this.tickMs;
      this.tick();
    }
    this.apply();
  }

  /** 0x426ba0 的一拍。 */
  tick() {
    const move = this.move;
    const subject = this.subject?.container?.active ? this.subject : null;
    if (move) {
      if ((this.track || this.lock) && subject) Object.assign(move.to, subjectPoint(subject));
      const { from, to, step, time } = move;
      this.current = { x: lerp(from.x, to.x, step, time), y: lerp(from.y, to.y, step, time), z: lerp(from.z, to.z, step, time) };
      this.view = { x: this.current.x, y: this.current.y };
      this.move = step + 1 > time ? null : { ...move, step: step + 1 };
    }
    if (!this.move && this.lock && subject) this.view = subjectPoint(subject);
    if (this.shakeStep >= 0) {
      const [dx, dy] = SHAKE_STEPS[this.shakeStep];
      this.view = { x: this.view.x + dx, y: this.view.y + dy };
      this.shakeStep = this.shakeStep + 1 >= SHAKE_STEPS.length ? -1 : this.shakeStep + 1;
    }
  }

  get idle() {
    return !this.move && !this.lock && this.shakeStep < 0
      && !this.view.x && !this.view.y && !this.current.z;
  }

  apply() {
    const baseX = this.scene.battleBaseScrollX ?? 0; // 宽屏：战场相机视口变宽后世界原点要偏回居中（battleCameras.js）
    this.main.setScroll(this.view.x + baseX, this.view.y).setZoom(zoomOf(this.current.z));
    if (this.scene.battleCameras) return; // 宽屏：界面相机常驻，由 battleCameras.js 每帧归类
    if (this.idle) {
      if (this.ui) this.detachUi();
      return;
    }
    if (!this.ui) this.ui = this.scene.cameras.add(stageView().offsetX, 0, STAGE_WIDTH, STAGE_HEIGHT);
    // 顶层对象按深度分给两台镜头：cameraFilter 的位表示「不被该镜头画」。
    const { main, ui } = this;
    for (const child of this.scene.children.list) {
      child.cameraFilter = child.depth > WORLD_DEPTH_MAX || child.scrollFactorX === 0 ? main.id : ui.id;
    }
  }

  detachUi() {
    for (const child of this.scene.children.list) child.cameraFilter = 0;
    this.scene.cameras.remove(this.ui);
    this.ui = null;
  }

  destroy() {
    if (this.ui) this.detachUi();
    this.main.setScroll(this.scene.battleBaseScrollX ?? 0, 0).setZoom(1);
  }
}

/**
 * 被跟随对象的镜头目标：原作取对象坐标（+0x24/+0x28），即“对象图层原点”落到画面左上角所需的镜头位置。
 * 我们的层坐标 = 容器位置 + 缩放 ×（层坐标 − origin + displayOffset）。
 */
function subjectPoint(animator) {
  const { container } = animator;
  const sx = container.scaleX < 0 ? -1 : 1;
  return {
    x: Math.round(container.x + sx * (animator.displayOffset.x - animator.originX)),
    y: Math.round(container.y + animator.displayOffset.y - animator.originY),
  };
}
