/**
 * 按住 ↑/↓ 连续滚 —— **天书页与标题读档页共用**。
 *
 * ## 为什么不靠浏览器的按键重复
 *
 * `keydown-UP` 在按住时确实会被 OS 重复触发，但**首次重复要等 ~500ms、
 * 之后的速率也由系统设置决定**，99 个存档槽一条条挪太慢，而且每台机器手感不同。
 * 所以自己按帧计时：按住超过 `DELAY_MS` 之后，每 `INTERVAL_MS` 走一步。
 *
 * 纯函数 + 不可变：状态进、状态出，不碰 Phaser，便于回归。
 * 调用方在 `update()` 里每帧喂一次「现在按的是哪个方向」。
 */

/** 手感值。**原作没有这一项**（它是我们加的翻页便利），见复现度台账。 */
export const HOLD = Object.freeze({
  /** 按住多久才开始连发。太短会让「点一下」变成「滚两格」。 */
  DELAY_MS: 320,
  /** 连发间隔。70ms ≈ 每秒 14 行，99 个槽扫一遍约 7 秒。 */
  INTERVAL_MS: 70,
});

/** 初始状态：没按住任何方向。 */
export function createHold() {
  return Object.freeze({ dir: 0, since: 0, fired: 0 });
}

/**
 * 推进一帧，返回这一帧还要走几步。
 *
 * ⚠️ **第一步不由这里出** —— 那是 `keydown` 事件的事。这里只负责
 * 「按住不放之后的连发」，所以 `fired` 从 0 起算、`DELAY_MS` 内一步不出。
 *
 * @param {{dir:number,since:number,fired:number}} state
 * @param {number} dir 这一帧按着的方向：-1 上 / 1 下 / 0 没按
 * @param {number} now 毫秒时钟（`update` 的 `time`）
 * @returns {{state: object, steps: number}}
 */
export function holdSteps(state, dir, now) {
  if (!dir) return { state: createHold(), steps: 0 };
  // 换方向 = 重新开始计时，不继承上一个方向的连发进度
  if (dir !== state.dir) {
    return { state: Object.freeze({ dir, since: now, fired: 0 }), steps: 0 };
  }
  const elapsed = now - state.since;
  if (elapsed < HOLD.DELAY_MS) return { state, steps: 0 };
  const want = Math.floor((elapsed - HOLD.DELAY_MS) / HOLD.INTERVAL_MS) + 1;
  const steps = Math.max(0, want - state.fired);
  return { state: steps ? Object.freeze({ ...state, fired: want }) : state, steps };
}

/**
 * 从两个 Phaser Key 读出方向。**上优先** —— 两个一起按时不该左右横跳。
 */
export function heldDirection(up, down) {
  if (up?.isDown) return -1;
  if (down?.isDown) return 1;
  return 0;
}
