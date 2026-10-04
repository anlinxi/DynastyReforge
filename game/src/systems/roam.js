/**
 * NPC 在自己那一小块地盘里溜达。
 *
 * ## 范围是原作数据，走法是我们编的
 *
 * SCI 有两个字段 `RangeX`(+0xEF) / `RangeY`(+0xF3)，释义原文：
 * 「**角色自由走动时，离默认出现地点的可允许最远横向 / 纵向距离**」。
 *
 * 全游戏 3955 个场景对象里**只有 79 个非零**，分布在 11 张图；取值清一色
 * `(100,50)` / `(200,100)` / `(300,200)` / `(800,400)` —— X:Y 恒为 2:1，
 * 正是等距投影的比例。河州镇 `MP0101` 里只有 **阿平老媽** 与 **沈大伯**
 * 是 `(200,100)`，其余 53 个对象全是 0 —— 与玩家的记忆完全一致。
 *
 * ⚠️ **原作只给了范围，没给走法**：多久动一次、走多远、停多久、走多快，
 * 一个数都没有。下面这些常量全是手感值，**登记在 `docs/状态/复现度台账.md`**。
 * 在表里就别拿它们当原作行为去推理别的东西。
 *
 * ## 为什么不是「随机方向走一段」
 *
 * 那样会一路蹭着墙走。这里改成「在矩形里挑一个**站得住**的点，走过去，
 * 停一会儿，再挑」—— 挑点时就用调用方给的 `canStand`，天然不会走进墙里；
 * 真走的时候还要再过一次逐像素扫掠（`FieldScene.slideAxis`），
 * 中途被挡住就当作到了，下一轮重挑。
 */

/** 手感值，全部是推断。见文件头。 */
export const ROAM = Object.freeze({
  /** 到点之后停多久（毫秒），在这个区间里随机。 */
  PAUSE_MIN_MS: 1500,
  PAUSE_MAX_MS: 4000,
  /** 相对主角走速的倍率 —— NPC 溜达比赶路慢。 */
  SPEED_RATIO: 0.6,
  /** 离目标多近算到了。小于一帧的位移就会一直「差一点」。 */
  ARRIVE_PX: 4,
  /** 挑不到站得住的点时最多重试几次，之后这一轮就原地待着。 */
  MAX_TRIES: 8,
  /** 目标点离出发点太近就不值得走一趟。 */
  MIN_TRIP_PX: 24,
});

const between = (rnd, lo, hi) => lo + rnd() * (hi - lo);

/**
 * 在 `home ± range` 的矩形里挑一个点。**纯函数**，随机源由调用方给。
 * @param {{x:number,y:number}} home 默认出现地点
 * @param {[number,number]} range `[RangeX, RangeY]`
 */
export function pickPoint(home, range, rnd) {
  return {
    x: home.x + (rnd() * 2 - 1) * range[0],
    y: home.y + (rnd() * 2 - 1) * range[1],
  };
}

/**
 * 挑一个**站得住**、且离当前位置够远的目标点；挑不到返回 null。
 * @param {(x:number,y:number)=>boolean} canStand
 */
export function chooseTarget(home, range, from, canStand, rnd) {
  for (let i = 0; i < ROAM.MAX_TRIES; i += 1) {
    const at = pickPoint(home, range, rnd);
    if (!canStand(at.x, at.y)) continue;
    if (Math.hypot(at.x - from.x, at.y - from.y) < ROAM.MIN_TRIP_PX) continue;
    return at;
  }
  return null;
}

/**
 * 给一个场景对象建溜达状态；`range` 为空（绝大多数对象）返回 null。
 *
 * ⚠️ 只给**行走图**（`dirs` ≠ 0）建。原地做动作的那些（扫地、晾衣服、
 * 斗虫的小孩）`dirs=0`，整条精灵就是那一个动作，没有行走段可播。
 */
export function createRoamer(o) {
  const range = o?.range;
  if (!Array.isArray(range) || !(range[0] || range[1])) return null;
  if (!o.dirs) return null;
  return Object.freeze({
    home: Object.freeze({ x: o.x, y: o.y }),
    range: Object.freeze([Math.abs(range[0]), Math.abs(range[1])]),
    target: null,
    waitMs: 0,
  });
}

/**
 * 推进一帧。**返回新的 roamer 与这一帧想走的位移**，不碰精灵、不碰场景 ——
 * 真正的移动与碰撞交给调用方（要过 `slideAxis` 的逐像素扫掠）。
 *
 * @param {object} roamer `createRoamer` 的产物
 * @param {{x:number,y:number}} at 当前位置
 * @param {number} deltaMs
 * @param {{speed:number, canStand:Function, rnd?:Function}} ctx
 * @returns {{roamer:object, dx:number, dy:number}}
 */
export function advanceRoamer(roamer, at, deltaMs, ctx) {
  const rnd = ctx.rnd ?? Math.random;

  if (!roamer.target) {
    const waitMs = roamer.waitMs - deltaMs;
    if (waitMs > 0) return { roamer: { ...roamer, waitMs }, dx: 0, dy: 0 };
    const target = chooseTarget(roamer.home, roamer.range, at, ctx.canStand, rnd);
    // 一个站得住的点都挑不到（缩在角落里的 NPC）：再等一轮，别每帧重试。
    return {
      roamer: {
        ...roamer,
        target,
        waitMs: target ? 0 : between(rnd, ROAM.PAUSE_MIN_MS, ROAM.PAUSE_MAX_MS),
      },
      dx: 0,
      dy: 0,
    };
  }

  const toX = roamer.target.x - at.x;
  const toY = roamer.target.y - at.y;
  const dist = Math.hypot(toX, toY);
  if (dist <= ROAM.ARRIVE_PX) {
    return {
      roamer: {
        ...roamer,
        target: null,
        waitMs: between(rnd, ROAM.PAUSE_MIN_MS, ROAM.PAUSE_MAX_MS),
      },
      dx: 0,
      dy: 0,
    };
  }
  const step = Math.min(dist, (ctx.speed * deltaMs) / 1000);
  return { roamer, dx: (toX / dist) * step, dy: (toY / dist) * step };
}

/** 一帧几乎没挪动就当作被挡住了，放弃这个目标重挑。 */
export function giveUp(roamer, rnd = Math.random) {
  return {
    ...roamer,
    target: null,
    waitMs: between(rnd, ROAM.PAUSE_MIN_MS, ROAM.PAUSE_MAX_MS),
  };
}
