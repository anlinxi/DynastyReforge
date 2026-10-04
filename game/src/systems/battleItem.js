/** 战斗道具：普通回复按官方固定作用类型2/3分流，状态交BattleUnit统一执行。
 * 回复依据0x42adb5..0x42af6e；伤害依据0x42a7d0，命中仅控制附加咒术部分。
 * 此模块描述结果；死亡目标、时钟及动作恢复由BattleScene/BattleUnit接通。
 */
import { itemDamage } from './officialDamage.js';
import { isFixedRecovery, recoveryAmount } from './recovery.js';

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

/** 战斗里这件东西是哪一类效果。 */
export const ITEM_EFFECT = Object.freeze({
  DAMAGE: 'damage',
  HEAL: 'heal',
  REVIVE: 'revive',
  NONE: 'none',
  STATE: 'state',
});

/**
 * 固定回复类型2/3优先；作用对象只决定复活与旧伤害分支。
 *
 * @param {object} record `items.json` 的一条
 */
export function effectKindOf(record) {
  if (record?.作用对象 === '死者') return ITEM_EFFECT.REVIVE;
  if (isFixedRecovery(record)) {
    return (record.命作用百分数 || record.气作用百分数)
      && (record.主作用量 || record.附加作用量) ? ITEM_EFFECT.HEAL : ITEM_EFFECT.STATE;
  }
  switch (record?.作用对象) {
    case '敌方阵营': return ITEM_EFFECT.DAMAGE;
    case '己方阵营':
    case '双方阵营':
    case '自体': return ITEM_EFFECT.HEAL;
    default: return ITEM_EFFECT.NONE;
  }
}

/**
 * 回复：`命极 × 主作用量% + 附加作用量`，再乘 `命作用百分数` / `气作用百分数`。
 *
 * @param {{命极?:number, 气极?:number}} stats 目标的数值
 * @returns {{hp:number, qi:number}}
 */
export function recoveryOf(record, stats) {
  return recoveryAmount(stats, record);
}

/**
 * 算一次使用落到某个目标身上的结果。**不改任何东西**，由调用方去落。
 *
 * @param {object} record `items.json` 的一条
 * @param {{命极?:number, 气极?:number}} stats 目标数值
 * @param {{alive?:boolean}} [target] 目标当前状态（复活要看死没死）
 * @returns {{kind:string, hit:boolean, damage:number, hp:number, qi:number}}
 */
export function applyItem(record, stats, target = null, rng = Math.random, options = {}) {
  const kind = effectKindOf(record);
  const miss = {
    kind, hit: false, damage: 0, hp: 0, qi: 0,
  };
  if (kind === ITEM_EFFECT.NONE) return miss;
  if (kind === ITEM_EFFECT.STATE) return { ...miss, hit: true, effects: record.使用特效 ?? [] };
  if (kind === ITEM_EFFECT.HEAL && target?.alive === false) return miss;

  if (kind === ITEM_EFFECT.DAMAGE) {
    const out = itemDamage(record, options.actor ?? {}, stats, { ...options, rng });
    return { kind, ...out, hit: !!(out.damage || out.qiDamage), hp: 0, qi: 0 };
  }
  // 复活结果仅用于死亡目标；实际复活由场景在落数值前执行。
  if (kind === ITEM_EFFECT.REVIVE && target?.alive) return miss;
  const gain = options.blockLight ? { hp: 0, qi: 0 } : recoveryOf(record, stats);
  return {
    kind, hit: true, damage: 0, hp: gain.hp, qi: gain.qi, effects: record.使用特效 ?? [],
  };
}

/** 背包里扣掉一件。**返回新数组，不改原来的**；扣到 0 就把那条去掉。 */
export function consume(inventory, code) {
  const out = [];
  let done = false;
  for (const row of inventory ?? []) {
    if (!done && row.代码 === code) {
      done = true;
      const left = num(row.数量) - 1;
      if (left > 0) out.push(Object.freeze({ ...row, 数量: left }));
      continue;
    }
    out.push(row);
  }
  return Object.freeze(out);
}

export { clamp };
