/** 官方RPG.exe 0x42b5a0..0x42cd50。整数步骤保留原顺序；原生函数差分见测试样本。 */
import { physicalAttack, physicalGuard, randomBetween, nativeRand } from './combat.js';
import { effectiveSpirit, hasState, battleResistance } from './battleStates.js';
import { RESISTS } from './formulas.js';
const t = n => Math.trunc(n) || 0;
/** 原作MSVC rand为15位整数；支持原生差分注入原始序列。 */
export { nativeRand };
const roll = (rng, modulus) => nativeRand(rng) % modulus;
export function magicHit(record, actor, target, options = {}) {
  if (options.forceMagicHit) return true;
  if (hasState(target, 14)) return false;
  if (hasState(target, 15)) return true;
  const rate = record.附加作用命中率 ?? record.命中率 ?? record.accuracy ?? 100;
  return roll(options.rng, 100) < rate + (record.物品编号 ? 0 : t(((actor.机运 ?? 0) - (target.机运 ?? 0)) / 8));
}
/** 不预先把抗性乘积舍成百分数，否则低抗性和多件装备会丢失有效小数。 */
function resistance(target, gear, element, options) {
  const field = RESISTS[element - 1];
  const innate = element === 0 ? target.魂 ?? 0 : target.内禀抗性?.[element - 1] ?? target[field] ?? 100;
  const values = [innate, ...[0, 1, 2].map(i => gear?.[i]?.抗性原值?.[element] ?? gear?.[i]?.[field] ?? 100)];
  if (!gear && options.defenderResist?.[field] != null) values[0] = options.defenderResist[field];
  return { values: values.map(Math.abs), absorbs: element > 0 && values.some(n => n < 0) };
}
function resistScale(target, element, options, percent = false) {
  const { values: [base, ...gear], absorbs } = resistance(target, options.defenderEquipment, element, options);
  const g = gear.reduce((n, v) => Math.imul(n, v), 1);
  const factor = percent ? Math.imul(t(g / 100), base) : t(Math.imul(g, base) / 100);
  return { factor, sign: absorbs ? -1 : 1 };
}
export function skillPhysical(record, actor, target, options = {}) {
  const atk = physicalAttack(actor, options.attackerBonuses), guard = physicalGuard(target, options.defenderBonuses);
  const idx = record.绝学指数 ?? 0, type = record.绝技类型 ?? 0, str = actor.膂力 ?? 0;
  const random = (div) => {
    const a = t(str / div), b = t(str / 10);
    return options.rng?.native ? Math.min(a, b) + (a === b ? 0 : roll(options.rng, Math.abs(b - a))) : randomBetween(a, b, options.rng);
  };
  let n;
  switch (type) {
    case 2: n = Math.max(0, atk + t(((actor.命极 ?? actor.命) - actor.命) * idx / 10) + random(50) - guard); break;
    case 3: n = Math.max(0, atk + t((actor.命极 ?? actor.命) * idx / 100) + random(50) - guard); break;
    case 4: n = Math.max(0, t(atk * idx / 10) + random(50) - guard); break;
    case 5: { const a = atk + random(50); n = Math.max(0, a - t(guard / a) * idx); break; }
    case 6: n = Math.max(0, t(Math.max(1, atk - guard + random(25)) * idx / 10)); break;
    default: n = Math.max(1, atk - guard + random(25));
  }
  const spread = t((options.attackerWeapon?.攻击补正 ?? 0) / 20);
  if (spread > 0) n += roll(options.rng, spread);
  if (!idx) return 0;
  return n;
}
export function skillMagic(record, actor, target, options = {}) {
  const amount = record.附加作用量 ?? 0, level = target.位阶 ?? 1, element = record.咒术相性码 ?? 0;
  const percent = record.附加作用量类型 === 1;
  const spirit = effectiveSpirit(actor), targetSpirit = effectiveSpirit(target);
  const magic = options.attackerBonuses?.法力补正 ?? actor.法力补正 ?? 0;
  let n = (percent ? t((target.命极 ?? target.命 ?? 0) * amount / 100) : amount + t(level * 17 / 10))
    + magic + t(spirit * spirit / (2 * ((record.伤害缩减指数 ?? 0) + level)));
  if (percent) {
    n -= t(((target.体魄 ?? 0) + targetSpirit) / 2);
    // 官方百分数分支这里是商，普通分支才取余数；不按资料文字统一改写。
    n += t(amount / (t(nativeRand(options.rng) / 99) + 1));
    n -= t((target.机运 ?? 0) / (t(nativeRand(options.rng) / 19) + 1));
  } else {
    if (hasState(actor, 24)) n = t(n * 13 / 10);
    if (hasState(actor, 5)) n = t(n * 7 / 10);
    if ((element === 1 && hasState(target, 2)) || (element === 2 && hasState(target, 1))) n = t(n * 8 / 10);
    if (options.blockLight && element === 4) n = 0;
    n -= targetSpirit;
    n += t((target.机运 ?? 0) / (roll(options.rng, 19) + 1));
    n += t(amount / (roll(options.rng, 9) + 1));
  }
  const { factor, sign } = resistScale(target, element, options, percent);
  return sign * Math.max(0, t(n * factor * 0.000001));
}
export function weaponMagic(actor, target, options = {}) {
  const w = options.attackerWeapon;
  if (!w) return 0;
  const r = battleResistance(target, options.defenderEquipment, Number(w.附加作用量相性) || 0);
  return Math.max(0, (w.法力补正 ?? 0) - Math.abs(r.value)) * (r.absorbs ? -1 : 1);
}
export function splitDamage(total, record, target, options = {}) {
  const damage = Math.min(options.capVitals === false ? Infinity : target.命 ?? Infinity, t(total * Math.max(0, record.命作用百分数 ?? 0) / 100));
  const qiDamage = Math.min(options.capVitals === false ? Infinity : target.气 ?? Infinity, t(total * Math.max(0, record.气作用百分数 ?? 0) / 100));
  return { damage, qiDamage, ...drainDamage(damage, qiDamage, record, options) };
}
export function drainDamage(damage, qiDamage, record, options = {}) {
  const amount = damage + qiDamage;
  const drain = key => t(amount * Math.max(0, record[key] ?? 0) / 100)
    + t(amount * Math.max(0, options.attackerWeapon?.[key] ?? 0) / 100);
  return { drained: drain('吸命百分数'), drainedQi: drain('吸气百分数') };
}
export function itemDamage(record, actor, target, options = {}) {
  let physical = Math.max(0, t(((record.主作用量 ?? 0) - (t((target.体魄 ?? 0) / 2) + (options.defenderBonuses?.防御补正 ?? 0))) * (options.halfPhysical ? .5 : 1)));
  let magic = 0;
  if (magicHit(record, actor, target, options)) {
    const percent = record.附加作用量类型 === 1, amount = record.附加作用量 ?? 0, element = record.附加作用量相性 ?? 0;
    magic = percent ? t((target.命极 ?? target.命 ?? 0) * amount / 100) - t(((target.体魄 ?? 0) + effectiveSpirit(target)) / 2)
      : Math.max(0, amount - effectiveSpirit(target));
    if (!percent && ((element === 1 && hasState(target, 2)) || (element === 2 && hasState(target, 1)))) magic = t(magic * 8 / 10);
    if (!percent && options.blockLight && element === 4) magic = 0;
    physical += t(physical / (roll(options.rng, 9) + 1)) - t((target.体魄 ?? 0) / (roll(options.rng, 19) + 1));
    if (!percent) physical = Math.max(0, physical);
    magic += t(magic / (roll(options.rng, percent ? 99 : 9) + 1)) - t((target.机运 ?? 0) / (roll(options.rng, 19) + 1));
    const { factor, sign } = resistScale(target, element, options, percent);
    magic = sign * Math.max(0, t(Math.imul(magic, factor) / 1000000));
  }
  return splitDamage(physical + magic, { ...record, 吸命百分数: 0, 吸气百分数: 0 }, target, { ...options, capVitals: false });
}
