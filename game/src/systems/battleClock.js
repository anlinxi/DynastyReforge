/** 原作0x41f3c4/0x423e90：绿条180000，步长1100+迅捷*8；蓝紫步长1100+迅捷*4。
 * 一逻辑拍55ms，原数值20000=标称一秒。0x4434b3防御、0x423c56道具回气100000。
 * 初始绿条80000+rand()%40000，普攻没有蓝紫；主指令闲置走表，进入子页面、选目标及演出暂停。
 */
import { stateClockMods } from './battleStates.js';

/** 三个阶段。值同时是 `hudLayout.GAUGE_PHASES` 里的键，别改字面量。 */
export const PHASE = Object.freeze({
  WAIT: 'wait',
  CHARGE: 'charge',
  RECOVER: 'recover',
});

/** 没有迅捷修正时，绿条涨满的标称毫秒数。 */
export const BASE_WAIT_MS = 9000;

/** 绿条迅捷系数8/1100；蓝紫系数4/1100。 */
export const SPEED_DIVISOR = 137.5;

/**
 * 防御原值100000，除以20000得到标称5秒。
 * 「防御持续一回合」＝ 持续到这一段紫条走完。
 */
export const GUARD_RECOVER_MS = 5000;

/** 状态倍率的上下限 —— **这两个数是原作明文**（配套资料〈名词解释〉）。 */
export const RATE_MAX = 2;
export const RATE_MIN = 0;

const clamp01 = (v) => (Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0);
const toMs = (seconds) => {
  const v = Number(seconds);
  return Number.isFinite(v) && v > 0 ? v * 1000 : 0;
};

/**
 * 迅捷带来的速度倍率。**下限 1 倍**（迅捷 0 的人按基准速度走，不是不动）。
 *
 * @param {{迅捷?: number}} stats
 */
export function speedRate(stats, phase = PHASE.WAIT) {
  const speed = Number(stats?.迅捷);
  if (!Number.isFinite(speed) || speed <= 0) return 1;
  return 1 + speed / (phase === PHASE.WAIT ? SPEED_DIVISOR : 275);
}

/**
 * 状态（麻痹/迟缓/冰结/奋驰…）带来的倍率，**乘起来后按 0%~200% 截断**。
 *
 * @param {{factor:number, phases?:string[]}[]} mods 每条状态一项；
 *   `phases` 不给＝三个阶段都影响（迟缓要写 `['wait','charge']`，紫不受影响）
 * @param {string} phase 当前阶段
 */
export function statusRate(mods = [], phase = PHASE.WAIT) {
  let rate = 100;
  for (const m of mods ?? []) {
    if (Array.isArray(m?.phases) && !m.phases.includes(phase)) continue;
    const f = Number(m?.factor);
    if (Number.isFinite(f)) rate = Math.trunc(rate * f);
  }
  if (!Number.isFinite(rate)) return 1;
  return Math.min(RATE_MAX, Math.max(RATE_MIN, rate / 100));
}

/**
 * 一次动作占的**整条**：总时长与释放点。
 *
 * ⚠️ **蓄劲与回气共用一整条**，不是各走一条。释放点是两者的比值 ——
 * 把它算成 1（蓝走满才放）就变成上一版那个错的样子。
 *
 * @param {{charge?:number, recover?:number}} [action] 绝学（**秒**）；普攻传 null
 * @returns {{total:number, release:number, charge:number, recover:number}}
 *   `total` 毫秒；`release` 0..1；普攻是 `{total:0, release:0}`
 */
export function actionSpan(action = null) {
  const charge = toMs(action?.charge);
  const recover = toMs(action?.recover);
  const total = charge + recover;
  return { total, release: total > 0 ? charge / total : 0, charge, recover };
}

/** 一条记录当前每毫秒走多少 —— 迅捷倍率 × 状态倍率。 */
export function rateOf(entry) {
  return speedRate(entry?.unit?.stats, entry?.phase) * statusRate([...(entry?.mods ?? []), ...(entry?.unit?.fieldClockMods ?? []), ...stateClockMods(entry?.unit?.statuses)], entry?.phase);
}

/**
 * 这一条**走到哪算到点**：蓄劲到释放点，等待与回气到满。
 *
 * @returns {number} 0..1
 */
export function triggerAt(entry) {
  return entry?.phase === PHASE.CHARGE ? clamp01(entry.release) : 1;
}

/** 到点了没有（等着上层处理）。 */
export function isDue(entry) {
  return Boolean(entry) && entry.progress >= triggerAt(entry);
}

/** 这次动作打完之后还有没有紫段要走。 */
export function hasRecover(entry) {
  return (entry?.release ?? 1) < 1 && (entry?.duration ?? 0) > 0;
}

/**
 * 开局：全员绿条带原作随机初始进度。
 *
 * **原作带随机初始进度** —— 迅捷不同，涨满的先后自然就分开了；
 * 初始值只用于入场，此后每次等待从0开始。
 */
export function createClock(units = [], rng = Math.random) {
  return units.map((unit) => ({
    unit,
    phase: PHASE.WAIT,
    progress: (80000 + Math.trunc(rng() * 32768) % 40000) / 180000,
    elapsed: 0,
    duration: BASE_WAIT_MS,
    release: 1,
    action: null,
    mods: [],
  }));
}

/** 某个单位的那一条。 */
export function entryOf(clock, unit) {
  return (clock ?? []).find((e) => e.unit === unit) ?? null;
}

/**
 * 条画到第几帧（0..1 的比例，直接喂 `hudLayout.gaugeFrame`）。
 *
 * ⚠️ **三个阶段都是 `progress` 本身，不取反。** 绿往右长、蓝紫往左长
 * 是**素材自带的锚点**决定的 —— 见模块头那张表。
 */
export function gaugeOf(entry) {
  return clamp01(entry?.progress);
}

/** 同时到点时谁先动：迅捷高的优先，再同按入场顺序 —— 免得每帧抖。 */
function bySpeed(a, b) {
  return (Number(b.unit?.stats?.迅捷) || 0) - (Number(a.unit?.stats?.迅捷) || 0);
}

const replace = (clock, unit, make) =>
  (clock ?? []).map((e) => (e.unit === unit ? make(e) : e));

/**
 * 绿条涨满、选完动作 —— **进这一整条**（蓝 + 紫）。
 *
 * 普攻（`action` 为 null 或蓄劲回气都是 0）得到 `total = 0`：
 * 下一次 `advance` 就到点，**打完没有紫段**。
 *
 * @returns {Array} 新数组
 */
export function beginAction(clock, unit, action = null) {
  const span = actionSpan(action);
  return replace(clock, unit, (e) => ({
    ...e,
    phase: PHASE.CHARGE,
    progress: 0,
    duration: span.total,
    release: span.release,
    action,
  }));
}

/**
 * 打出去了 —— 换成紫，**进度原样保留**（接着蓝停下的那一点往左走）。
 *
 * ⚠️ **不许把 `progress` 归零。** 归零之后紫条会从最右端重新来一趟，
 * 那就是上一版「蓝走满一条、紫再走满一条」的错法。
 */
export function enterRecover(clock, unit) {
  return replace(clock, unit, (e) => ({ ...e, phase: PHASE.RECOVER }));
}

/**
 * 防禦 —— **不经过蓄劲，从最右端（帧 0）直接开始回气**（用户原话）。
 * 时长见 {@link GUARD_RECOVER_MS}。
 */
export function beginGuard(clock, unit) {
  return replace(clock, unit, (e) => ({
    ...e,
    phase: PHASE.RECOVER,
    progress: 0,
    duration: GUARD_RECOVER_MS,
    release: 0,
    action: null,
  }));
}

/** 这一轮走完，回到绿条从头涨。 */
export function resetWait(clock, unit) {
  return replace(clock, unit, (e) => ({
    ...e,
    phase: PHASE.WAIT,
    progress: 0,
    duration: BASE_WAIT_MS,
    release: 1,
    action: null,
  }));
}

/**
 * 推进一帧。**返回新数组，不改原来的。**
 *
 * @param {Array} clock
 * @param {number} delta 本帧毫秒
 * @returns {{clock: Array, ready: Array}} `ready` = **当前到点的全部活人**
 *   （不只是这一帧刚跨过去的），已按迅捷排好序。上层一次只处理一个，
 *   没被处理的下一帧还会再出现在这里 —— 见下面那段注释。
 */
export function advance(clock, delta) {
  const step = Number(delta);
  if (!Number.isFinite(step) || step <= 0) return { clock, ready: [] };

  const next = (clock ?? []).map((e) => {
    // 死人不走条。复活时从头涨，不保留生前进度。
    if (!e.unit?.alive) {
      return e.phase === PHASE.WAIT && e.progress === 0
        ? e
        : {
          ...e,
          phase: PHASE.WAIT,
          progress: 0,
          duration: BASE_WAIT_MS,
          release: 1,
          action: null,
        };
    }
    if (isDue(e)) return e;                     // 已到点，等上层处理
    const rate = rateOf(e);
    if (rate <= 0) return e;                    // 冰结：停住
    // ⚠️ 时长 0（普攻）要当场到点，不能除出 Infinity 再靠截断。
    const elapsed = (e.elapsed ?? 0) + step;
    const ticks = Math.floor(elapsed / 55);
    const rawStep = Math.trunc(1100 * rate + 1e-8);
    const p = e.duration > 0 ? e.progress + ticks * rawStep / (e.duration * 20) : 1;
    return { ...e, elapsed: elapsed - ticks * 55, progress: p >= 1 ? 1 : p };
  });

  // ⚠️ **到点了还没被处理的，每帧都要再报一次**，不能只报「这一帧刚跨过去的」。
  // 上层一帧只处理一个（弹菜单、演出招都要独占），同时到点的另一个人就会
  // 永远停着 —— 实机采样里**冰璃从头到尾没轮到过一次**，就是这么来的，
  // 而且画面上只是「她的条一直是满的」，不报任何错。
  const ready = next.filter((e) => e.unit?.alive && isDue(e) && !(e.phase === PHASE.RECOVER && (e.unit.fieldHolding || e.unit.sustained)));
  return { clock: next, ready: ready.slice().sort(bySpeed) };
}

/** 挂/摘状态倍率。状态系统（模块 I）接进来之后由它调。 */
export function setMods(clock, unit, mods = []) {
  return replace(clock, unit, (e) => ({ ...e, mods: [...mods] }));
}
