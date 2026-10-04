/**
 * 手柄来源：每帧读浏览器 Gamepad API，按映射告诉虚拟按键核心按住了哪些键（PLAT-03）。
 *
 * 映射**按位置**，不按键帽字母：下方键 = 确认、右方键 = 返回。
 * Xbox/PS/Switch Pro 在浏览器的“标准布局”（`mapping === 'standard'`）里同一位置编号相同，
 * 所以一张表通吃；键帽上印的字母（Xbox 的 A 在任天堂是 B）只影响画面提示，不影响这里。
 * 映射见 docs/专题/手柄.md 第二节（2026-10-03 方案，用户同意开工）。
 */

import { axisKeys, reconcile } from './virtualKeys.js';

/** 标准布局按钮编号 → 虚拟键。 */
export const PAD_BUTTONS = Object.freeze([
  [0, 'SPACE'], //         下方键（Xbox A / PS × / 任天堂 B）：确认、交谈
  [1, 'ESC'], //           右方键（Xbox B / PS ○ / 任天堂 A）：返回；地图上开菜单
  [9, 'ESC'], //           Start / Menu / +：开菜单
  [2, 'SHIFT'], //         左方键（Xbox X / PS □ / 任天堂 Y）：走/跑切换
  [3, 'TAB'], //           上方键（Xbox Y / PS △ / 任天堂 X）：换角色 / 菜单换人
  [4, 'BRACKET_LEFT'], //  LB / L1 / L：菜单上一页
  [5, 'BRACKET_RIGHT'], // RB / R1 / R：菜单下一页
  [7, 'CTRL'], //          RT / R2 / ZR 按住：快进对话
  [12, 'UP'], [13, 'DOWN'], [14, 'LEFT'], [15, 'RIGHT'], // 十字键
]);

/** 摇杆推过一半才算按方向——太灵会在菜单里误触。 */
export const STICK_DEADZONE = 0.5;
/** 扳机是模拟量（0~1），按过一半算按下。 */
export const TRIGGER_THRESHOLD = 0.5;

const SOURCE = 'gamepad';

function buttonDown(button) {
  if (!button) return false;
  return Boolean(button.pressed) || Number(button.value) > TRIGGER_THRESHOLD;
}

/** 一个手柄当前按住的虚拟键。纯函数。 */
export function padKeys(pad) {
  const keys = new Set();
  if (!pad?.connected) return keys;
  for (const [index, name] of PAD_BUTTONS) {
    if (buttonDown(pad.buttons?.[index])) keys.add(name);
  }
  const [x = 0, y = 0] = pad.axes ?? [];
  for (const name of axisKeys(x, y, STICK_DEADZONE)) keys.add(name);
  return keys;
}

/** 所有已连接手柄按住的键的并集（Joy-Con 左右各算一个手柄时也能一起用）。 */
export function heldFromPads(pads) {
  const keys = new Set();
  for (const pad of pads ?? []) for (const name of padKeys(pad)) keys.add(name);
  return keys;
}

/**
 * 接上手柄：每帧对账一次，按下的发 press、松开的发 release。
 * 补发重复按键是核心的事（`keys.tick()`，main.js 每帧调一次），这里不管——触屏来源同理。
 *
 * @param {object} opts
 * @param {ReturnType<import('./virtualKeys.js').createVirtualKeys>} opts.keys 虚拟按键核心
 * @param {(cb:()=>void)=>void} opts.onFrame 订阅每帧回调（main.js 传 Phaser 的 prestep）
 * @param {()=>Iterable} [opts.getPads] 读手柄；缺省 `navigator.getGamepads()`
 */
export function installGamepad({ keys, onFrame, getPads = () => navigator.getGamepads?.() ?? [] }) {
  const warned = new Set();
  onFrame(() => {
    let pads;
    try {
      pads = [...getPads()].filter(Boolean);
    } catch (err) {
      // 某些浏览器在权限策略禁用手柄时会抛错：记一次，之后安静地当作没有手柄
      if (!warned.has('error')) { warned.add('error'); console.warn('读取手柄失败：', err); }
      pads = [];
    }
    for (const pad of pads) {
      if (pad.mapping !== 'standard' && !warned.has(pad.id)) {
        warned.add(pad.id);
        console.warn(`手柄「${pad.id}」不是浏览器标准布局，按键位置可能对不上`);
      }
    }
    reconcile(keys, SOURCE, heldFromPads(pads));
  });
}
