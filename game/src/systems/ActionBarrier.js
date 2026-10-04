/**
 * ⚠️ **当前没有任何消费者。**
 *
 * 它属于**战斗执行层**。2026-09-05 删掉战斗演示页（`BattleScene`）与特效
 * 浏览页之后，这条线暂时断了 —— 但代码是有效资产，战斗真正接进主线时
 * （由剧情的 `battle` 指令拉起）会重新用上，所以留着而不是删掉。
 *
 * 同样处境的还有：`ui/StatusPanel.js`、`systems/BattleUnit.js`、
 * `systems/effects.js`、`systems/ActionBarrier.js`。
 * 见 `docs/归档/全流程可行性.md` 的战斗线。
 */
/**
 * 行动屏障：等一次行动牵涉的所有动画（出招动作、特效、受击）
 * 全部播完，再放行下一步。
 *
 * 不论回合制还是将来的半即时制，交手都必须等上一方的表演收尾，
 * 否则会出现「特效还在放，对面已经打过来」的错乱。
 *
 * 用法:
 *   const barrier = new ActionBarrier(() => nextTurn());
 *   const done = barrier.track();   // 每开一个动画就领一个凭证
 *   ...动画结束时 done()
 *   barrier.seal();                 // 声明不再新增，可以开始判定
 */
export default class ActionBarrier {
  /** @param {() => void} onSettled 全部完成后的回调，只会触发一次 */
  constructor(onSettled) {
    this.onSettled = onSettled;
    this.pending = 0;
    this.sealed = false;
    this.fired = false;
  }

  /**
   * 登记一项待完成的动画，返回其完成凭证。
   * 凭证重复调用只计一次，避免动画回调被触发多次时提前放行。
   */
  track() {
    this.pending += 1;
    let used = false;
    return () => {
      if (used) return;
      used = true;
      this.pending -= 1;
      this.check();
    };
  }

  /** 声明不会再有新的动画加入。 */
  seal() {
    this.sealed = true;
    this.check();
  }

  check() {
    if (this.fired || !this.sealed || this.pending > 0) return;
    this.fired = true;
    this.onSettled?.();
  }
}
