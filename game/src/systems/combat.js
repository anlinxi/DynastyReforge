/**
 * 官方普通攻击：RPG.exe 0x42c680..0x42cc8c及各数值子程序。
 * 攻防、命中、闪避、状态修正：官方RPG.exe 0x42b880..0x42bcc0。
 * 普攻整数浮动、兵刃附加法力及必杀加倍按官方分支；场方修正由BattleFields传入。
 *
 * 所有函数均为纯函数，不修改传入对象。
 */

import { hasState, battleResistance } from './battleStates.js';

/** 官方0x42ccb0：两端排序，右端不包含；不是人为百分比伤害浮动。 */
export const nativeRand = (rng = Math.random) => rng.native ? rng.native() : Math.trunc(rng() * 32768);

export function randomBetween(a, b, rng = Math.random) {
  const lo = Math.min(a, b), hi = Math.max(a, b);
  return lo === hi ? lo : lo + nativeRand(rng) % (hi - lo);
}

/** 命中判定（官方RPG.exe 0x42b880/0x42b950复核）:
 *    命中概率% = 攻方命中 − 目标闪避
 *    攻方命中  = 90 + 装备命中补正 + 机运/4
 *    目标闪避  = 装备闪避补正 + 机运/4
 */
const BASE_ACCURACY = 90;
const LUCK_DIVISOR = 4;

/**
 * @typedef {{name: string, 命: number, 膂力: number, 体魄: number, 机运: number, 位阶: number}} Stats
 */

/**
 * 物理攻击力 = 膂力 + 装备攻击补正，再修正疲弱/神力。
 * 原作开局即给夏侯仪「护身匕首」（攻击补正 90），
 * 不计装备会导致伤害远低于原作手感。
 */
export function physicalAttack(stats, bonuses = {}) {
  const base = (stats.膂力 ?? 0) + (bonuses.攻击补正 ?? 0);
  return Math.trunc(base * (hasState(stats, 3) ? .7 : hasState(stats, 22) ? 1.3 : 1));
}

export function physicalGuard(stats, bonuses = {}) {
  const base = Math.trunc((stats.体魄 ?? 0) / 2) + (bonuses.防御补正 ?? 0);
  return Math.trunc(base * (hasState(stats, 15) ? .5 : hasState(stats, 25) ? 1.3 : hasState(stats, 6) ? .7 : 1));
}

/** 攻方命中值。 */
export function accuracyOf(stats, bonuses = {}) {
  const base = BASE_ACCURACY + (bonuses.命中补正 ?? 0) + Math.trunc((stats.机运 ?? 0) / LUCK_DIVISOR);
  return Math.trunc(base * (hasState(stats, 26) ? 1.3 : hasState(stats, 7) ? .7 : 1));
}

/** 守方闪避值。 */
export function evasionOf(stats, bonuses = {}) {
  if (hasState(stats, 14)) return 1000;
  if (hasState(stats, 15)) return 0;
  const base = (bonuses.闪避补正 ?? 0) + Math.trunc((stats.机运 ?? 0) / LUCK_DIVISOR);
  return hasState(stats, 10) ? base + Math.trunc(base / 2) : base;
}

/**
 * 判定是否命中。
 * @returns {{hit: boolean, chance: number}} chance 为百分数
 */
export function resolveHit(attacker, defender, options = {}) {
  const { attackerBonuses = {}, defenderBonuses = {}, rng = Math.random } = options;
  const chance = accuracyOf(attacker, attackerBonuses) - evasionOf(defender, defenderBonuses);
  return { hit: nativeRand(rng) % 100 < chance, chance };
}

/** 必杀补正直接加到暴击率上（原作以百分比计）。 */
function critChance(stats, defender, bonuses) {
  const base = (stats.基础必杀 ?? 0) + (bonuses.必杀补正 ?? 0)
    + Math.trunc(((stats.机运 ?? 0) - (defender.机运 ?? 0)) / 10);
  return Math.max(0, Math.trunc(base * (hasState(stats, 15) ? 1.5 : 1))) / 100;
}

/**
 * 计算一次普攻结果。
 * @param {Stats} attacker
 * @param {Stats} defender
 * @param {{attackerBonuses?: object, defenderBonuses?: object, rng?: () => number}} options
 * @returns {{damage: number, critical: boolean}}
 */
export function resolveAttack(attacker, defender, options = {}) {
  const {
    attackerBonuses = {}, defenderBonuses = {}, rng = Math.random,
  } = options;

  const { hit, chance } = resolveHit(attacker, defender, options);
  if (!hit) return { hit: false, chance, damage: 0, qiDamage: 0, drained: 0, drainedQi: 0, critical: false };

  // 0x42c750先判必杀；0x42bc80和0x42cd50分别给膂力与兵刃的整数浮动。
  const critical = nativeRand(rng) % 100 < critChance(attacker, defender, attackerBonuses) * 100;
  const strength = attacker.膂力 ?? 0;
  const weapon = options.attackerWeapon;
  let physical = Math.max(1, physicalAttack(attacker, attackerBonuses) - physicalGuard(defender, defenderBonuses)
    + randomBetween(Math.trunc(strength / 50), Math.trunc(strength / 10), rng));
  const spread = Math.trunc((weapon?.攻击补正 ?? 0) / 20);
  if (spread > 0) physical += nativeRand(rng) % spread;
  if (options.halfPhysical) physical = Math.trunc(physical / 2);
  if (hasState(attacker, 15)) physical *= 2;
  if (hasState(attacker, 10)) physical = Math.trunc(physical / 2);
  if (critical) physical *= 2;
  // 0x42c4d0：只有兵刃的法力附加量，按对应抗性扣除，负抗性可吸收。
  let magic = 0;
  if (weapon) {
    const resistance = battleResistance(defender, options.defenderEquipment, Number(weapon.附加作用量相性) || 0);
    magic = Math.max(0, (weapon.法力补正 ?? 0) - Math.abs(resistance.value));
    if (resistance.absorbs) magic = -magic;
  }
  const damage = options.blockPhysical ? 0 : Math.min(defender.命 ?? Infinity, physical + magic);

  return { hit: damage !== 0, chance, damage, qiDamage: 0, critical,
    drained: Math.trunc(damage * Math.max(0, weapon?.吸命百分数 ?? 0) / 100),
    drainedQi: Math.trunc(damage * Math.max(0, weapon?.吸气百分数 ?? 0) / 100) };
}

/**
 * 施加伤害，返回新的状态对象（不修改入参）。
 * @param {{hp: number, maxHp: number}} state
 */
export function applyDamage(state, damage) {
  return { ...state, hp: Math.max(0, state.hp - damage) };
}

export function isDefeated(state) {
  return state.hp <= 0;
}
