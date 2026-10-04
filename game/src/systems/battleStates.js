/** 官方RPG.exe：0x42b0d0状态结算、0x420440时钟/周期、0x421690清除。
 * 时长保留原始单位，每个逻辑节拍扣10；毫秒换算由场景统一节拍决定。
 */
import { RESISTS } from './formulas.js';
import { nativeRand } from './combat.js';

const trunc = Math.trunc;
const ATTRS = [null, '膂力', '体魄', '灵力', '迅捷', '机运'];
/** 官方抗性乘绝对值，有任一负项则吸收；不是偶数个负号相消。 */
export function battleResistance(stats, gear, index) {
  const field = RESISTS[index - 1];
  const base = index === 0 ? stats.魂 ?? 0 : stats.内禀抗性?.[index - 1] ?? stats[field] ?? 100;
  const values = [base, ...(gear ?? []).map((r) => r.抗性原值?.[index] ?? r[field] ?? 100)];
  const absorbs = index > 0 && values.some((v) => v < 0);
  const value = Math.trunc(values.reduce((n, v) => n * Math.abs(v), 1) / 100 ** (values.length - 1));
  return { value: absorbs ? -value : value, absorbs };
}

export const hasState = (stats, id) => Number(stats?.状态?.[id] ?? 0) > 0;

/** 诸态固定格与同格优先级来自官方显示分支；没有状态画空格，不将图标左移。 */
export function stateIconFrames(states, rules) {
  return (rules?.诸态状态格 ?? []).map(ids => {
    const id = ids.find(code => states?.[code] > 0);
    return id === undefined ? 0 : rules.状态[id].图标;
  });
}
export function effectiveSpirit(stats) {
  let n = stats.灵力 ?? 0;
  if (hasState(stats, 24)) n = trunc(n * 1.3);
  if (hasState(stats, 5)) n = trunc(n * 0.7);
  return n;
}
export function stateClockMods(states = {}) {
  const on = (id) => states[id] > 0;
  return [on(1) && { factor: .1 }, on(16) && { factor: .75 },
    on(4) && { factor: .5, phases: ['wait', 'charge'] },
    on(23) && { factor: 1.5, phases: ['wait', 'charge'] },
    on(9) && { factor: 0, phases: ['wait', 'charge'] }].filter(Boolean);
}

/** 状态命中及持续量；正面21~27必中，异常遵循机运差与及身抗性。 */
export function stateApplications(effects, record, actor, target, rules, rng = Math.random) {
  if (hasState(target, 16)) return [];
  return (effects ?? []).flatMap((effect) => {
    const id = effect.码 ?? effect.特效码;
    const rule = rules?.状态?.[id];
    if (!rule || id === 27 || !(effect.概率 > 0)) return [];
    const field = RESISTS[rule.抗性 - 1];
    const resist = field ? (target.及身抗性?.[field] ?? target[field] ?? 100) : 100;
    const chance = id > 20 ? 100 : trunc(((effect.概率 ?? 0)
      + trunc(((actor.机运 ?? 0) - (target.机运 ?? 0)) / 10)) * resist / 100);
    const forced = [2, 3].includes(record.附加作用量类型) || [10, 11].includes(record.咒术相性码 ?? record.附加作用量相性);
    if (nativeRand(rng) % 100 >= chance && !forced) return [];
    const code = parseInt(record.绝学代码 ?? record.code, 16);
    let base = code >= 0x1b7 && code <= 0x1be ? record.附加作用量 : rule.基础时长;
    base += (actor.法力补正 ?? 0) + trunc(effectiveSpirit(actor) ** 2 / 95);
    let deduct = ATTRS[rule.目标五外] ? target[ATTRS[rule.目标五外]] ?? 0 : 100;
    if (ATTRS[rule.施者五外]) deduct = trunc(deduct / Math.max(1, actor[ATTRS[rule.施者五外]] ?? 0));
    const luck = target.机运 ?? 0, lo = trunc(luck / 10), span = trunc(luck / 5) - lo;
    const random = span >= 1 ? lo + nativeRand(rng) % span : 0;
    const innate = target.内禀抗性?.[rule.抗性 - 1] ?? 100;
    return [{ id, duration: Math.max(0, trunc(base * innate / 100) - deduct - random) }];
  });
}

/** 按官方0x42b536与0x421612：先削时长，同名已存在不续时。
 * 原作并不在这里清零旧对抗项，二者可短暂共存；不能自行改成互斥布尔开关。
 */
export function addStates(current, applications, rules) {
  const next = { ...current };
  for (const { id, duration } of applications) {
    const opposite = rules?.状态?.[id]?.对抗;
    let left = duration;
    if (opposite >= 0 && next[opposite] > 0) {
      const old = next[opposite];
      if (old > left) next[opposite] = old - left;
      else left -= old;
    }
    if (left > 0 && !(next[id] > 0) && !(next[14] > 0)) next[id] = left;
  }
  return next;
}

export function clearedStates(current, ids) {
  const next = { ...current };
  for (const id of ids ?? []) delete next[id];
  return next;
}
export function clearFor(record, rules) {
  const item = record.物品编号;
  const code = String(item ?? record.绝学代码 ?? record.code ?? '').toUpperCase();
  return item ? rules?.药物清除?.[code] ?? []
    : [...(rules?.绝学清除?.[code] ?? []), ...(rules?.驱散?.[code] ?? [])];
}

/** 官方先清旧状态，再落本次附加状态；蚀血神丹的清除不能吞掉自身反噬。 */
export function applyPreparedStates(current, applications, record, rules) {
  return addStates(clearedStates(current, clearFor(record, rules)), applications, rules);
}

/** 步数由场景累积，不卡帧丢周期；中毒/命蕴每跨过600单位作用一次。 */
export function tickStates(current, ticks, stats) {
  const next = {}, amount = ticks * 10;
  let hp = 0;
  for (const [key, duration] of Object.entries(current)) {
    const left = Math.max(0, duration - amount);
    if (left > 0) next[key] = left;
    const times = Math.floor(duration / 600) - Math.floor(left / 600);
    if (times > 0 && key === '0') hp += times * (trunc((stats.体魄 ?? 0) / 20) - trunc(stats.命极 / 20));
    if (times > 0 && key === '21') hp += times * (trunc((stats.体魄 ?? 0) / 20) + trunc(stats.命极 / 20));
  }
  return { states: next, hp };
}

/** 伤害/回复共同经过目标的特殊状态，正值为损失，负值为回复。 */
export function modifyVitals(stats, hp, qi, record = {}) {
  let states = { ...stats.状态 };
  // 逆阙在作用量计算阶段反转；神临金丹随后覆盖为满命气（0x42b055）。
  if (hasState(stats, 11) && record.物品编号 !== '108') {
    if (hp < 0) hp = -hp;
    if (qi < 0) qi = -qi;
  }
  // 光系作用对操偶先写-1，再经下方操偶分支变为1点伤害并解除。
  if (hasState(stats, 16) && hp > 0 && (record.咒术相性码 === 4 || record.附加作用量相性 === 4)) hp = -1;
  if (hasState(stats, 14)) return { hp: 0, qi: 0, states };
  if (hasState(stats, 19) && (hp > 0 || qi > 0)) {
    delete states[19];
    return { hp: 0, qi: 0, states };
  }
  // 原作0x4213a6是>=0，单独补命（气变化0）也会解冻；不能改成仅受伤解除。
  if (hasState(stats, 9) && (hp >= 0 || qi >= 0)) delete states[9];
  if (hasState(stats, 16)) {
    if (hp > 0) hp = 0;
    else if (hp < 0) { hp = -hp; delete states[16]; }
  }
  return { hp, qi, states };
}
