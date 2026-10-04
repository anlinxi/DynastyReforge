/** BattleScene使用的战斗单位；基础属性保留，当前命/气由state持有。 */
import Phaser from 'phaser';
import SF2Animator, { TICK_MS } from './SF2Animator.js';
import { resolveLoadout, sumBonuses, battleLoadout } from './equipment.js';
import { warnOnce } from './warnOnce.js';
import { actorAnchor, anchorDepth, animationDepth } from './effects.js';
import { skillDestination, motionSteps } from './skillMotion.js';
import { RESISTS, innateResist, resistTable } from './formulas.js';
import { battleResistance, applyPreparedStates, stateApplications, modifyVitals, tickStates } from './battleStates.js';
import { restoreVitals } from './recovery.js';
import { penetrationAmount } from './battleAction.js';
import { SUSTAINED, sustainedVitals } from './sustainedAction.js';

/**
 * 战斗中的一个单位：持有数值状态，并负责动作切换与受击表现。
 * 数值状态对象本身不可变，每次变化替换整份引用。
 */


/** 近战突进：冲到目标身前的落脚偏移，以及前冲/撤回耗时。 */
const LUNGE_GAP = { x: 38, y: 20 };
const LUNGE_MS = 260;
const RETREAT_MS = 300;
/** 命中判定落在出招动画的哪个位置。 */
const IMPACT_RATIO = 0.45;

export default class BattleUnit {
  /**
   * @param {Phaser.Scene} scene
   * @param {object} def   config.js 中的单位定义
   * @param {object} stats data/characters.json 中的数值
   */
  constructor(scene, def, stats, catalogue = {}) {
    this.scene = scene;
    this.def = def;
    this.stats = stats;
    this.state = Object.freeze({
      hp: stats.命, maxHp: stats.命极 ?? stats.命,
      qi: stats.气 ?? 0, maxQi: stats.气极 ?? stats.气 ?? 0,
    });

    const { equipped, rejected } = resolveLoadout(catalogue, def.loadout, def.name);
    this.equipment = battleLoadout(stats, scene.cache.json.get('equipment-full')) ?? equipped;
    this.rejectedEquipment = rejected;
    this.bonuses = sumBonuses(this.equipment);
    this.statuses = {};
    this.statusElapsed = 0;
    this.rules = scene.cache.json.get('gamedata')?.战斗规则;

    this.animators = new Map();
    this.actionAnimators = new Set();
    this.borrowers = new Set();
    this.currentKey = null;
    this.onFrameEvent = null;
    this.baseX = def.offsetX ?? 0;
    this.baseY = def.offsetY ?? 0;
    this.visualAlpha = this.alive ? 1 : 0;
    this.bodyFade = null;

    this.showAction('stand');
  }

  holdBorrow(animator) {
    this.borrowers.add(animator);
    this.animators.forEach((a) => a.container.setVisible(false));
  }

  releaseBorrow(animator) {
    this.borrowers.delete(animator);
    if (this.destroyed) return;
    if (!this.borrowers.size) {
      if (this.alive) this.resumeAction();
      else this.animators.get(this.currentKey)?.container.setVisible(this.visualAlpha > 0);
    }
  }

  get name() {
    return this.def.name;
  }

  get alive() {
    return this.state.hp > 0;
  }

  /** 结算时取实时值；不把战斗消耗写进基础属性或存档对象。 */
  get combatStats() {
    return { ...this.stats, 状态: this.statuses, 内禀抗性: this.innateResists,
      及身抗性: this.resists, 法力补正: this.bonuses.法力补正 ?? 0, 命: this.state.hp, 命极: this.state.maxHp,
      气: this.state.qi, 气极: this.state.maxQi };
  }

  get weapon() {
    return this.equipment.find((r) => r.槽位 === '兵刃' || r.物品类别 === '武器') ?? null;
  }

  get innateResists() {
    const data = this.scene.cache.json.get('gamedata');
    if (this.def.side === 'ally' && data?.五内抗性系数) {
      const values = innateResist(this.stats, resistTable(data), data.常数);
      return [...RESISTS.map((key) => Math.trunc(values[key])), 100, 100];
    }
    return this.stats.内禀抗性 ?? Array(10).fill(100);
  }

  get resists() {
    return Object.fromEntries(RESISTS.map((key, i) => [key,
      battleResistance({ ...this.stats, 内禀抗性: this.innateResists }, this.equipment, i + 1).value]));
  }

  get states() {
    return Object.entries(this.statuses).filter(([, value]) => value > 0)
      .map(([id, duration]) => ({ id: Number(id), icon: this.rules?.状态?.[id]?.图标 ?? -1,
        name: this.rules?.状态?.[id]?.名称 ?? id, duration }));
  }

  applyStates(record, actor, effects = record.附加特效 ?? record.使用特效 ?? []) {
    const applications = stateApplications(effects, record, actor.combatStats, this.combatStats, this.rules);
    this.statuses = applyPreparedStates(this.statuses, applications, record, this.rules);
    return applications;
  }

  /** 返回真实命气变化；伤害与回复使用同一个特殊状态入口。 */
  applyVitals(hpLoss = 0, qiLoss = 0, record = {}, { penetration = false, reaction = true } = {}) {
    // 动画中途也可能倒地；只有显式revive先恢复资格，普通治疗不能偷偷复活。
    if (!this.alive) return { hp: 0, qi: 0 };
    const changed = modifyVitals(this.combatStats, hpLoss, qiLoss, record);
    this.statuses = changed.states;
    Object.assign(changed, sustainedVitals(this.sustained, changed.hp, changed.qi));
    if (penetration) {
      changed.hp = penetrationAmount(changed.hp);
      changed.qi = penetrationAmount(changed.qi);
    }
    const old = this.state;
    const hp = Math.max(0, Math.min(old.maxHp, old.hp - changed.hp));
    const qi = Math.max(0, Math.min(old.maxQi, old.qi - changed.qi));
    this.state = Object.freeze({ ...old, hp, qi });
    if (hp < old.hp) { if (!this.alive) this.fall(); else if (reaction) this.hurt(); }
    return { hp: hp - old.hp, qi: qi - old.qi };
  }

  revive() {
    if (this.alive) return false;
    this.reactionTimer?.remove();
    this.statuses = {};
    this.state = Object.freeze({ ...this.state, hp: 1 });
    this.guarding = false;
    this.reactionRestoreKey = null;
    this.setActionPosition(this.baseX, this.baseY);
    this.idle();
    this.fadeBody(1);
    return true;
  }

  tickStatuses(delta) {
    if (!this.alive) return { hp: 0, qi: 0 };
    this.statusElapsed += delta;
    const ticks = Math.floor(this.statusElapsed / TICK_MS);
    if (!ticks) return { hp: 0, qi: 0 };
    this.statusElapsed -= ticks * TICK_MS;
    const got = tickStates(this.statuses, ticks, this.combatStats);
    this.statuses = got.states;
    const old = this.state.hp;
    this.state = Object.freeze({ ...this.state, hp: Math.max(0, Math.min(this.state.maxHp, old + got.hp)) });
    if (!this.alive) this.fall();
    return { hp: this.state.hp - old, qi: 0 };
  }

  /**
   * 该动作是否有可用素材。
   * 部分动作（如小兵的 HIT）只有帧时序而无图片，复用的是标准精灵，
   * 切过去会导致角色消失，因此必须连图片一起检查。
   */
  hasAction(action) {
    const key = this.def[action];
    if (!key) return false;
    const data = this.scene.cache.json.get(`${key}-anim`);
    return Boolean(data?.images?.length);
  }

  /** 当前所处位置。动作容器之间保持同步，取任意一个即可。 */
  currentPosition() {
    const any = this.animators.values().next().value;
    return any ? { x: any.container.x, y: any.container.y } : { x: this.baseX, y: this.baseY };
  }

  /**
   * 动作容器按需创建。必须以「当前位置」而非初始位置建立，
   * 否则突进途中切换动作会把单位瞬间拉回起点。
   */
  getAnimator(key) {
    if (!this.animators.has(key)) {
      const { x, y } = this.currentPosition();
      const animator = new SF2Animator(this.scene, key, {
        x, y,
        depth: animationDepth(anchorDepth(actorAnchor(this))),
        onFrameEvent: (event) => this.onFrameEvent?.({ ...event, unit: this }),
      });
      this.animators.set(key, animator);
      animator.container.setAlpha(this.visualAlpha);
    }
    return this.animators.get(key);
  }

  /**
   * 切换到某个动作。缺素材时回退到站立。
   * @returns {SF2Animator}
   */
  showAction(action, { loop = true, onComplete = null, startFrame = 0, steps = null, onStep = null } = {}) {
    const key = this.hasAction(action) ? this.def[action] : this.def.stand;
    if (!key) return null;

    this.animators.forEach((a, k) => {
      if (k !== key) a.container.setVisible(false);
    });

    const animator = this.getAnimator(key);
    animator.container.setVisible(this.alive || this.visualAlpha > 0).setAlpha(this.visualAlpha);
    animator.play({ loop, onComplete, startFrame, steps, onStep });
    this.currentKey = key;
    return animator;
  }

  /** 回到站立循环。 */
  idle() {
    this.showAction('stand', { loop: true });
  }

  /** 同步移动全部动作容器，保证切换动作时位置连续。 */
  moveTo(x, y, duration, onDone) {
    const targets = [...this.animators.values()].map((a) => a.container);
    if (targets.length === 0) {
      onDone?.();
      return;
    }
    this.scene.tweens.add({
      targets, x, y, duration, ease: 'Quad.easeInOut', onComplete: () => onDone?.(),
      onUpdate: () => {
        const depth = animationDepth(anchorDepth(actorAnchor(this)));
        targets.forEach((container) => container.setDepth(depth));
      },
    });
  }

  /** 出招动画的总时长（毫秒）。 */
  actionDuration(action) {
    const key = this.def[action];
    const data = key && this.scene.cache.json.get(`${key}-anim`);
    if (!data?.frames?.length) return 300;
    return data.frames.reduce((sum, f) => sum + Math.max(1, f.duration), 0) * TICK_MS;
  }

  /**
   * 发起攻击。近战会突进到目标身前再出招，随后撤回；
   * 远程与术法原地施放。
   * @param {BattleUnit} target
   * @param {() => void} onImpact 命中时机回调
   */
  /**
   * @param {boolean|null} [lunge] 要不要冲到目标身前。
   *   普攻看武器的 `武器攻击范围`，由battleAction决定。
   *   绝学不走此方法，使用useSkill/returnSkill与原作移动分段。
   *   给 `null` 就退回 `def.attackType`（敌人现在还是一律 melee）。
   */
  attack(target, onImpact, onFinished, lunge = null) {
    this.onActionFinished = onFinished;
    const strikeInPlace = () => {
      const total = this.actionDuration('attack');
      this.showAction('attack', { loop: false, onComplete: () => this.finishAttack() });
      this.scene.time.delayedCall(total * IMPACT_RATIO, () => onImpact?.());
      return total;
    };

    const melee = lunge == null ? this.def.attackType === 'melee' : Boolean(lunge);
    // ⚠️ **撤回也要按这一次的判断来** —— 记在实例上，否则原地出手的人
    // 打完还会「走回原位」，而他根本没动过。
    this.lunged = melee && Boolean(target);
    if (!this.lunged) {
      strikeInPlace();
      return;
    }

    // 冲到目标身前：站在目标靠己方的一侧
    const dir = this.def.side === 'ally' ? 1 : -1;
    const destX = target.baseX + LUNGE_GAP.x * dir;
    const destY = target.baseY + LUNGE_GAP.y * dir;

    this.showAction('move', { loop: true });
    this.moveTo(destX, destY, LUNGE_MS, () => strikeInPlace());
  }

  /** 出招结束：近战撤回原位，其余直接回到站立。撤回到位才算行动完毕。 */
  finishAttack() {
    const settle = () => {
      this.idle();
      const done = this.onActionFinished;
      this.onActionFinished = null;
      done?.();
    };

    if (!this.lunged) {
      settle();
      return;
    }
    this.lunged = false;
    this.showAction('move', { loop: true });
    this.moveTo(this.baseX, this.baseY, RETREAT_MS, settle);
  }

  /** 官方0x423738：受击事件1按命中结果选HIT或DEF；0x43d300只循环帧1、2。
   * 五张HIT图片不是每次受击都顺播的动画，后面三张供特定演出引用。
   */
  react(action) {
    if (!this.alive) return;
    this.reactionTimer?.remove();
    if (this.currentKey !== this.def.hurt && this.currentKey !== this.def.guard) this.reactionRestoreKey = this.currentKey;
    // 原作422342的动作0x72沿用正在施放的ATT，仍走受击帧1/2。
    if (this.sustained?.kind === SUSTAINED.VINES) action = 'sustainedAnim';
    const key = this.def[action];
    const frames = this.scene.cache.json.get(`${key}-anim`)?.frames ?? [];
    const steps = [1, 2].filter((index) => index < frames.length).map((index) => ({ index }));
    if (!steps.length || !this.hasAction(action)) return;
    this.showAction(action, { steps, loop: true });
    const animator = this.getAnimator(key);
    const { x, y } = this.currentPosition();
    const sign = this.def.side === 'ally' ? 1 : -1;
    // 原作0x43d270，两阵营相反方向的四个偏移，不移动真实站位。
    const offsets = [[16, 10], [12, 8], [8, 6], [4, 4]];
    let step = 0;
    const update = () => {
      if (step >= offsets.length) {
        animator.container.setPosition(x, y);
        this.resumeAction();
        return;
      }
      const [dx, dy] = offsets[step++];
      animator.container.setPosition(x + dx * sign, y + dy * sign);
      this.reactionTimer = this.scene.time.delayedCall(TICK_MS, update);
    };
    update();
  }

  hurt() { this.react('hurt'); }
  evade() { this.react('guard'); }

  /**
   * 施放绝学。动画键来自绝学定义而非单位定义，故临时挂到 def 上复用动作机制。
   * @param {object} skill
   * @param {BattleUnit} target
   * @param {() => void} onImpact
   */
  /**
   * **摆一个姿势并保持**（蓄劲 / 防禦）。
   *
   * 与 `showAction` 的区别是**不回 idle** —— 蓄劲要一直摆到打出去，
   * 防禦要一直摆到回气走完。用户 2026-09-18：
   * 「防御是有防御姿势的好吗？蓄力也有对应的姿势」。
   *
   * @param {string} pack 素材包名（`RED0011` 那种）；给 null 就回站立
   * @param {string} slot 挂在 `def` 的哪个键上
   */
  holdPose(pack, slot = 'poseAnim') {
    if (!pack) { this.idle(); return false; }
    this.def = { ...this.def, [slot]: pack };
    if (!this.hasAction(slot)) {
      // 判据表：兜底跳过要留日志，否则「没有姿势」和「原作就没画」分不开
      warnOnce(`pose:${pack}`, `姿势素材 ${pack} 没预载，${this.name} 保持站立`);
      this.idle();
      return false;
    }
    this.showAction(slot, { loop: true });
    return true;
  }

  /** 受击可暂时遮住动作，但不能丢掉正在等待的行动结束回调。 */
  resumeAction() {
    if (this.destroyed || !this.alive) return;
    const active = [...this.actionAnimators].find((a) => a.playing);
    if (!active) {
      const held = this.animators.get(this.reactionRestoreKey);
      this.reactionRestoreKey = null;
      if (this.sustained?.stage === 'hold') this.showAction('sustainedAnim');
      else if (this.guarding) this.showAction('guard');
      else if (held?.playing && held.key !== this.def.hurt) {
        this.animators.forEach((a) => a.container.setVisible(a === held));
        this.currentKey = held.key;
      } else this.idle();
      return;
    }
    this.animators.forEach((a) => a.container.setVisible(a === active));
    this.currentKey = active.key;
  }

  playActionPack(key, options, onFinished) {
    if (!key) { onFinished?.(); return; }
    const animator = this.getAnimator(key);
    // 动作的帧表必须执行；不能因无独立图片便换成站立帧表，丢掉事件/收尾。
    this.animators.forEach((a) => a.container.setVisible(a === animator));
    this.currentKey = key;
    animator.borrowUnit = this.borrowTarget ?? null;
    this.actionAnimators.add(animator);
    animator.play({ ...options, loop: false, onComplete: () => {
      this.actionAnimators.delete(animator);
      onFinished?.();
    } });
  }

  setActionPosition(x, y, moving = null, lift = 0) {
    this.animators.forEach((a) => a.container.setPosition(x, y));
    const depth = animationDepth(anchorDepth(actorAnchor(this)));
    this.animators.forEach((a) => a.container.setDepth(depth));
    if (moving) moving.container.y -= lift;
  }

  playSkillMotion(key, destination, done) {
    // NULL表示没有这一段，不用普通移动替代；归位最终仍恢复战场站位。
    if (!key) { done?.(); return; }
    const animator = this.getAnimator(key), start = this.currentPosition();
    const steps = motionSteps(animator.data);
    if (!steps.length) { this.setActionPosition(destination.x, destination.y); done?.(); return; }
    this.playActionPack(key, { steps, onStep: ({ progress, lift }) => {
      this.setActionPosition(start.x + (destination.x - start.x) * progress,
        start.y + (destination.y - start.y) * progress, animator, lift);
    } }, () => { this.setActionPosition(destination.x, destination.y); done?.(); });
  }

  /** 原作持续类型：MOV进入、ATT循环、BAK退出；循环不占全局行动锁。 */
  beginSustained(skill, target, ready) {
    const destination = skillDestination(skill, this, target) ?? { x: this.baseX, y: this.baseY };
    this.sustainedCast = skill;
    this.def = { ...this.def, sustainedAnim: skill.anim };
    this.playSkillMotion(skill.moveAnim, destination, () => {
      if (!this.sustained || !this.alive) { ready?.(); return; }
      this.sustained.stage = 'hold';
      this.showAction('sustainedAnim');
      ready?.();
    });
  }

  endSustained(done) {
    this.reactionTimer?.remove();
    this.reactionRestoreKey = null;
    const cast = this.sustainedCast;
    const state = this.sustained;
    if (this.sustained) this.sustained.stage = 'exit';
    const finish = () => {
      if (this.sustained !== state) return;
      this.sustained = null;
      this.sustainedCast = null;
      this.setActionPosition(this.baseX, this.baseY);
      if (this.alive) this.idle();
      done?.();
    };
    if (this.alive) this.playSkillMotion(cast?.backAnim, { x: this.baseX, y: this.baseY }, finish);
    else finish();
  }

  useSkill(skill, target, onImpact, onFinished) {
    const destination = skillDestination(skill, this, target);
    const strike = () => {
      if (!skill.anim) { onImpact?.(); onFinished?.(); return; }
      this.def = { ...this.def, skillAnim: skill.anim };
      const total = this.actionDuration('skillAnim');
      this.playActionPack(skill.anim, {}, onFinished);
      this.scene.time.delayedCall(total * IMPACT_RATIO, () => onImpact?.());
    };
    this.skillMoved = Boolean(destination && skill.moveAnim);
    if (destination) this.playSkillMotion(skill.moveAnim, destination, strike);
    else strike();
  }

  returnSkill(skill, done) {
    const finish = () => {
      this.setActionPosition(this.baseX, this.baseY);
      this.skillMoved = false;
      if (this.alive) this.idle();
      done?.();
    };
    if (this.skillMoved && this.alive) this.playSkillMotion(skill.backAnim, { x: this.baseX, y: this.baseY }, finish);
    else finish();
  }

  /** 扣减施法代价，返回新状态。 */
  payCost(skill) {
    this.state = Object.freeze({
      ...this.state,
      hp: Math.max(1, this.state.hp - (skill.costHp ?? 0)),
      qi: Math.max(0, (this.state.qi ?? 0) - (skill.costQi ?? 0)),
    });
  }

  /** 调整元气（可正可负），上限为气极，不是入场时的剩余气。 */
  changeQi(delta) {
    const cap = this.state.maxQi;
    this.state = Object.freeze({
      ...this.state,
      qi: Math.max(0, Math.min(cap, (this.state.qi ?? 0) + delta)),
    });
  }

  /** 普通回复不播放受击、不复活；返回截断上限后的真实增量。 */
  restore(requested) {
    const result = restoreVitals(this.state, requested);
    this.state = result.state;
    return { hp: result.hp, qi: result.qi };
  }

  /** 应用一次伤害，返回是否被击倒。 */
  takeDamage(damage, pose = 0) {
    this.state = Object.freeze({
      ...this.state,
      hp: Math.max(0, this.state.hp - damage),
    });
    if (this.alive) {
      this.hurt(pose);
    } else {
      this.fall();
    }
    return !this.alive;
  }

  /** END是胜利动作，不能用于死亡。0x4231f0隐藏本体并交给0x42d9c0渐隐副本。 */
  fall() {
    this.reactionTimer?.remove();
    this.reactionRestoreKey = null;
    this.guarding = false;
    this.statuses = {};
    // 保留当前姿势与站位；正在执行的动画回调仍要完成，不能以隐藏取消动作。
    this.fadeBody(0);
  }

  fadeBody(to) {
    this.bodyFade = { from: this.visualAlpha, to, elapsed: 0 };
  }

  updateBodyFade(delta) {
    if (this.bodyFade) {
      const f = this.bodyFade;
      f.elapsed += delta;
      // 视觉渐变沿用55ms逻辑拍的16级透明度；原作逐帧颜色变化另保留对照边界。
      const amount = Math.min(1, Math.floor(f.elapsed / TICK_MS) / 16);
      this.visualAlpha = f.from + (f.to - f.from) * amount;
      if (amount === 1) this.bodyFade = null;
    }
    this.animators.forEach(a => {
      a.container.setAlpha(this.visualAlpha);
      if (!this.alive && this.visualAlpha === 0) a.container.setVisible(false);
    });
  }

  celebrate(upgraded = false) {
    if (!this.alive) return;
    this.reactionTimer?.remove();
    this.guarding = false;
    this.setActionPosition(this.baseX, this.baseY);
    // 原作LUP使用0x43e670（模式7，播完停末帧），END使用模式5循环。
    this.showAction(upgraded ? 'levelUp' : 'victory', { loop: !upgraded });
  }

  update(time, delta) {
    this.updateBodyFade(delta);
    if (this.borrowers.size) this.animators.forEach((a) => a.container.setVisible(false));
    [...this.animators.values()].forEach((a) => {
      if ((this.alive && a.container.visible) || this.actionAnimators.has(a)) a.update(time, delta);
    });
  }

  destroy() {
    this.destroyed = true;
    this.reactionTimer?.remove();
    this.animators.forEach((a) => a.destroy());
    this.animators.clear();
    this.actionAnimators.clear();
    this.borrowers.clear();
  }
}
