/**
 * 虚拟按键核心：**手柄与手机触屏共用**（PLAT-03，方案见 docs/专题/手柄.md）。
 *
 * ## 为什么模拟键盘，而不是另做一套“动作”输入
 *
 * 游戏里约 80 处按键逻辑全是 `keyboard.on('keydown-XXX')` 与按住检测，而 Phaser 3.90 的
 * 键盘监听挂在 `window` 上、按事件的 `keyCode` 分派（KeyboardManager / KeyboardPlugin）。
 * 所以从页面上派发带 `keyCode` 的模拟键盘事件（冒泡到 window），现有逻辑**一行不改**全部照常响应，
 * `Key.isDown`（地图走路、Ctrl 快进、菜单连滚）也跟着更新。
 *
 * ## 职责
 *
 * 只管三件事：某键按下、松开、按住时按系统键盘的节奏补发重复按键。
 * 输入来源（手柄、触屏）只告诉它“哪个来源按住了哪个键”——
 * **同一个键可以被多个来源同时按住**（手柄按着确认、手指也按着屏幕上的确认），
 * 第一个来源按下才发 keydown、最后一个松开才发 keyup，两边不会打架。
 */

/** 能模拟的键。`repeat` = 按住时补发重复按键（只给方向键，和系统键盘一致）。 */
export const VKEYS = Object.freeze({
  UP: Object.freeze({ key: 'ArrowUp', code: 'ArrowUp', keyCode: 38, repeat: true }),
  DOWN: Object.freeze({ key: 'ArrowDown', code: 'ArrowDown', keyCode: 40, repeat: true }),
  LEFT: Object.freeze({ key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37, repeat: true }),
  RIGHT: Object.freeze({ key: 'ArrowRight', code: 'ArrowRight', keyCode: 39, repeat: true }),
  SPACE: Object.freeze({ key: ' ', code: 'Space', keyCode: 32 }),
  ENTER: Object.freeze({ key: 'Enter', code: 'Enter', keyCode: 13 }),
  ESC: Object.freeze({ key: 'Escape', code: 'Escape', keyCode: 27 }),
  SHIFT: Object.freeze({ key: 'Shift', code: 'ShiftLeft', keyCode: 16 }),
  TAB: Object.freeze({ key: 'Tab', code: 'Tab', keyCode: 9 }),
  CTRL: Object.freeze({ key: 'Control', code: 'ControlLeft', keyCode: 17 }),
  BRACKET_LEFT: Object.freeze({ key: '[', code: 'BracketLeft', keyCode: 219 }),
  BRACKET_RIGHT: Object.freeze({ key: ']', code: 'BracketRight', keyCode: 221 }),
});

/** 按住补发的节奏，取系统键盘的常见值。菜单连滚另有自己的计时（ui/holdScroll.js），不靠这个。 */
export const REPEAT = Object.freeze({ DELAY_MS: 400, INTERVAL_MS: 80 });

/**
 * 按住 `since` 起到 `now`，一共该补发几次（不含按下那一次）。纯函数。
 * @returns {number}
 */
export function repeatCount(since, now, timing = REPEAT) {
  const elapsed = now - since;
  if (elapsed < timing.DELAY_MS) return 0;
  return Math.floor((elapsed - timing.DELAY_MS) / timing.INTERVAL_MS) + 1;
}

/**
 * 摇杆位置（-1~1，向下为正）→ 方向键。**手柄左摇杆与触屏虚拟摇杆共用**。纯函数。
 * 斜推 = 两个方向键同按（地图上斜走）。
 */
export function axisKeys(x, y, deadzone) {
  const keys = [];
  if (x <= -deadzone) keys.push('LEFT');
  if (x >= deadzone) keys.push('RIGHT');
  if (y <= -deadzone) keys.push('UP');
  if (y >= deadzone) keys.push('DOWN');
  return keys;
}

/** 让某个来源按住的键变成 `want`：多出来的松开、缺的按下。手柄与触屏共用。 */
export function reconcile(keys, source, want) {
  const before = keys.heldBy(source);
  for (const name of before) if (!want.has(name)) keys.release(name, source);
  for (const name of want) if (!before.has(name)) keys.press(name, source);
}

/**
 * 造一个浏览器键盘事件。⚠️ `KeyboardEvent` 构造参数里**设不了 `keyCode`**（浏览器忽略），
 * 而 Phaser 正是按 `keyCode` 分派，所以要在事件对象上补定义。
 */
export function makeKeyboardEvent(type, def, { repeat = false, shiftKey = false, ctrlKey = false } = {}) {
  const event = new KeyboardEvent(type, {
    key: def.key, code: def.code, repeat, shiftKey, ctrlKey, bubbles: true, cancelable: true,
  });
  Object.defineProperty(event, 'keyCode', { get: () => def.keyCode });
  Object.defineProperty(event, 'which', { get: () => def.keyCode });
  return event;
}

/**
 * @param {object} [opts]
 * @param {(type:string, name:string, flags:object)=>void} [opts.emit] 发事件；缺省派发到 window
 * @param {()=>number} [opts.now] 毫秒时钟
 * @param {{DELAY_MS:number, INTERVAL_MS:number}} [opts.timing]
 */
export function createVirtualKeys({ emit, now = () => performance.now(), timing = REPEAT } = {}) {
  // ⚠️ **发在 document.body 上，不是 window。** 真键盘事件从页面元素冒泡到 window，
  // 片头跳过等在 window 捕获阶段 stopPropagation 就能拦住；直接派发给 window 时目标就是 window，
  // 拦不住同一目标上 Phaser 的监听，按一次确认会“跳过片头 + 选中标题第一项”（2026-10-03 iPhone 模拟器）。
  const send = emit ?? ((type, name, flags) => document.body.dispatchEvent(makeKeyboardEvent(type, VKEYS[name], flags)));
  /** 键名 → { sources: Set<来源>, since: 按下时刻, fired: 已补发次数 }。整体替换，不原地改。 */
  let held = new Map();

  const modifiers = () => ({ shiftKey: held.has('SHIFT'), ctrlKey: held.has('CTRL') });

  function press(name, source) {
    if (!VKEYS[name]) throw new Error(`虚拟按键没有「${name}」`);
    const entry = held.get(name);
    if (entry?.sources.has(source)) return;
    const next = new Map(held);
    next.set(name, entry
      ? { ...entry, sources: new Set([...entry.sources, source]) }
      : { sources: new Set([source]), since: now(), fired: 0 });
    held = next;
    if (!entry) send('keydown', name, { ...modifiers(), repeat: false });
  }

  function release(name, source) {
    const entry = held.get(name);
    if (!entry?.sources.has(source)) return;
    const sources = new Set([...entry.sources].filter((s) => s !== source));
    const next = new Map(held);
    if (sources.size) next.set(name, { ...entry, sources });
    else next.delete(name);
    held = next;
    if (!sources.size) send('keyup', name, { ...modifiers(), repeat: false });
  }

  /** 松开某个来源按着的全部键（来源断开、触屏层隐藏时用）。 */
  function releaseSource(source) {
    for (const name of [...held.keys()]) release(name, source);
  }

  /** 每帧调一次：给按住的方向键补发重复按键。 */
  function tick() {
    const t = now();
    for (const [name, entry] of held) {
      if (!VKEYS[name].repeat) continue;
      const want = repeatCount(entry.since, t, timing);
      for (let i = entry.fired; i < want; i += 1) send('keydown', name, { ...modifiers(), repeat: true });
      if (want > entry.fired) held = new Map(held).set(name, { ...entry, fired: want });
    }
  }

  /** 某个来源当前按着哪些键（调试与来源自己对账用）。 */
  function heldBy(source) {
    return new Set([...held].filter(([, e]) => e.sources.has(source)).map(([name]) => name));
  }

  return Object.freeze({ press, release, releaseSource, tick, heldBy });
}
