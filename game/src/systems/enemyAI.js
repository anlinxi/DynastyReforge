/** Enemy_AI/MagicCon，官方0x444240..0x44482b。与原生函数差分，不按说明猜加权抽签。 */
import { nativeRand } from './combat.js';
import { DEFERRED_SKILLS } from './skills.js';

/** 特殊条件只决定技能是否进入候选；不替代实际动作的范围选择。 */
export function conditionTarget(condition, friends, foes) {
  const groups = [foes, friends];
  const search = (camp, state, present) => {
    const group = groups[camp];
    if (!group || state <= 0) return null;
    return group.find(u => {
      if (state === 28) return u.state.hp < Math.trunc(u.state.maxHp * .6);
      if (state === 29) return friends.filter(v => v.alive).length < 6;
      return present ? (u.statuses?.[state] ?? 0) > 0 : u.alive && !(u.statuses?.[state] > 0);
    }) ?? null;
  };
  return search(condition.已有状态阵营, condition.已有状态, true)
    ?? search(condition.缺少状态阵营, condition.缺少状态, false);
}

/** 返回0普攻、-1防御、正整数绝学代码。canUse只用于登记的未实现/缺源分支。 */
export function chooseEnemyAction(actor, friends, foes, strategy, skillByCode, { rng = Math.random, spellBlocked = false, canUse = () => true } = {}) {
  const roll = nativeRand(rng) % 100;
  const code = actor.def.code;
  const rates = strategy?.行动概率?.[code];
  if (!rates) return 0;
  if (roll < rates.防御) return -1;
  const codes = actor.stats.绝学 ?? [];
  if (!codes.length || roll >= rates.防御 + rates.绝学) return 0;
  const magicAllowed = !spellBlocked && !(actor.statuses?.[2] > 0) && !(actor.statuses?.[15] > 0);
  let chosen = 0, best = 0;
  for (const hex of codes) {
    const record = skillByCode(hex), rule = strategy.绝学条件[hex];
    let valid = !!record && !!rule;
    if (valid && record.绝学类型码 === 2 && !magicAllowed) valid = false;
    if (valid && (actor.state.hp < record.消耗体力值 || actor.state.qi < record.消耗元气值)) valid = false;
    if (valid && (actor.state.hp > Math.trunc(actor.state.maxHp * rule.命上限百分数 / 100)
      || actor.state.qi > Math.trunc(actor.state.maxQi * rule.气上限百分数 / 100))) valid = false;
    // 原函数队伍命条件分支没有排除候选，不把表头推断为另一个门槛。
    if (valid && rule.特殊选取 === 1) valid = !!conditionTarget(rule, friends, foes);
    const roll = nativeRand(rng); // 原作无论候选是否有效都取一次随机数。
    const score = valid && rule.掷值上限 > 0 && canUse(hex, record) ? roll % rule.掷值上限 : 0;
    if (score > best) { best = score; chosen = parseInt(hex, 16); }
  }
  return chosen;
}

/** 敌我共享未开放能力表；AI可用性不能与玩家菜单各维护一份。 */
export { DEFERRED_SKILLS as DEFERRED_ENEMY_SKILLS } from './skills.js';
export const enemySkillSupported = code => !DEFERRED_SKILLS[code];
