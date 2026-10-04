/**
 * 触屏来源：左下虚拟摇杆 + 右下「確認」「返回」两键（PLAT-01 手机版）。
 *
 * 外观照用户 2026-10-01 选定的样式 C「本作风格」（设计稿见 docs/专题/平台形态.md 第四节链接）：
 * 深褐底、金色描边，整体 60% 不透明；样式写在 index.html 的 `.touch-*`。
 * 和手柄一样只调共用核心（virtualKeys.js）：摇杆 = 方向键、確認 = 空格（推着摇杆时＝Shift 走/跑切换）、返回 = ESC，
 * 游戏里的按键逻辑一行不改。画面其余地方的点击照旧当鼠标用（点地面走、点人物交谈）。
 *
 * 只在触屏设备上出现；网址 `?touch=1` 强制显示（电脑上调试）、`?touch=0` 强制关闭。
 */

import { axisKeys, reconcile } from './virtualKeys.js';
import { LANGUAGE } from './language.js';

/** 摇杆推过可移动距离的 35% 才算按方向：比手柄的一半灵敏些，手指没有回中弹簧。 */
export const TOUCH_DEADZONE = 0.35;

const STICK = 'touch-stick';
const LABELS = Object.freeze({
  confirm: LANGUAGE === '简' ? '确认' : '確認',
  back: '返回',
});

/** 要不要显示触屏按键。纯函数（便于测试）。 */
export function touchEnabled(search, { maxTouchPoints = 0, coarse = false } = {}) {
  const forced = new URLSearchParams(search).get('touch');
  if (forced === '1') return true;
  if (forced === '0') return false;
  return maxTouchPoints > 0 && coarse;
}

/**
 * 手指相对摇杆中心的偏移 → 圆钮位置（夹在可移动半径内）与归一化的 -1~1 摇杆量。纯函数。
 * @returns {{kx:number, ky:number, x:number, y:number}}
 */
export function stickOffset(dx, dy, travel) {
  const len = Math.hypot(dx, dy);
  const scale = len > travel ? travel / len : 1;
  const kx = dx * scale;
  const ky = dy * scale;
  return { kx, ky, x: travel ? kx / travel : 0, y: travel ? ky / travel : 0 };
}

function el(doc, tag, className, text) {
  const node = doc.createElement(tag);
  node.className = className;
  if (text) node.textContent = text;
  return node;
}

function bindStick(stick, knob, keys) {
  let active = null;
  let center = null;
  const move = (e) => {
    const o = stickOffset(e.clientX - center.x, e.clientY - center.y, center.travel);
    knob.style.transform = `translate(${o.kx}px, ${o.ky}px)`;
    reconcile(keys, STICK, new Set(axisKeys(o.x, o.y, TOUCH_DEADZONE)));
  };
  const end = (e) => {
    if (e.pointerId !== active) return;
    active = null;
    knob.style.transform = '';
    keys.releaseSource(STICK);
  };
  stick.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    if (active !== null) return;
    active = e.pointerId;
    stick.setPointerCapture?.(e.pointerId);
    const r = stick.getBoundingClientRect();
    // 圆钮能走的距离 = 底盘半径 − 圆钮半径
    center = { x: r.left + r.width / 2, y: r.top + r.height / 2, travel: (r.width - knob.offsetWidth) / 2 };
    move(e);
  });
  stick.addEventListener('pointermove', (e) => { if (e.pointerId === active) move(e); });
  for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) stick.addEventListener(type, end);
}

/**
 * 按下这个键时实际发哪个虚拟键。纯函数。
 * 確認键：地图上自由行走、且摇杆正推着时，改发 Shift＝走/跑切换（用户 2026-10-03 要求，手机没有 Shift 键）；
 * 其余时候（没推摇杆、对白、菜单、战斗）照旧是空格。
 */
export function confirmKey({ stickHeld, canToggleRun }) {
  return stickHeld && canToggleRun ? 'SHIFT' : 'SPACE';
}

function bindButton(button, keys, pick) {
  let pressed = null; // 按下时发的那个键，松开时松同一个
  button.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    button.setPointerCapture?.(e.pointerId);
    button.classList.add('pressed');
    pressed = pick();
    keys.press(pressed, `touch-${pressed}`);
  });
  const up = () => {
    button.classList.remove('pressed');
    if (pressed) keys.release(pressed, `touch-${pressed}`); // 重复松开无副作用
    pressed = null;
  };
  for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) button.addEventListener(type, up);
}

/**
 * 把触屏按键挂到页面上。
 * @param {object} opts
 * @param {ReturnType<import('./virtualKeys.js').createVirtualKeys>} opts.keys 共用核心
 * @param {Document} [opts.doc]
 * @param {() => boolean} [opts.canToggleRun] 现在是不是地图上自由行走（能切走/跑）
 */
export function mountTouchControls({ keys, doc = document, canToggleRun = () => false }) {
  const root = el(doc, 'div', 'touch-controls');
  const stick = el(doc, 'div', 'touch-stick');
  stick.setAttribute('role', 'application');
  stick.setAttribute('aria-label', '虚拟摇杆');
  for (const dir of ['up', 'down', 'left', 'right']) stick.append(el(doc, 'span', `touch-arrow ${dir}`));
  const knob = el(doc, 'span', 'touch-knob');
  stick.append(knob);
  const confirm = el(doc, 'button', 'touch-btn touch-confirm', LABELS.confirm);
  const back = el(doc, 'button', 'touch-btn touch-back', LABELS.back);
  root.append(stick, confirm, back);
  root.addEventListener('contextmenu', (e) => e.preventDefault());

  bindStick(stick, knob, keys);
  bindButton(confirm, keys, () => confirmKey({ stickHeld: keys.heldBy(STICK).size > 0, canToggleRun: canToggleRun() }));
  bindButton(back, keys, () => 'ESC');
  // 切到后台、来电时手指的抬起事件可能收不到：全部松开，免得人一直往一个方向走
  const releaseAll = () => {
    for (const source of [STICK, 'touch-SPACE', 'touch-SHIFT', 'touch-ESC']) keys.releaseSource(source);
    knob.style.transform = '';
  };
  doc.defaultView?.addEventListener('blur', releaseAll);
  doc.addEventListener('visibilitychange', () => { if (doc.hidden) releaseAll(); });

  doc.body.classList.add('touch-ui');
  doc.body.append(root);
  return root;
}
