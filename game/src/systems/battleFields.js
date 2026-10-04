/** 官方0x43db20/0x43dab0：场方效果独立于人物异常状态，重复施放不续期。 */
export default class BattleFields {
  constructor(rules = {}) { this.rules = rules; this.entries = []; this.elapsed = 0; }
  has(side, id) { return this.entries.some(e => e.side === side && e.id === id && e.remaining >= 0 && e.owner.alive); }
  owner(side, id) { return this.entries.find(e => e.side === side && e.id === id && e.owner.alive)?.owner; }
  removeOwner(owner) { this.entries = this.entries.filter(e => e.owner !== owner); }
  cast(record, owner) {
    const rule = this.rules.场方效果?.[record.code ?? record.绝学代码];
    if (!rule || ![2, 3, 4, 6, 7, 8].includes(rule.编号)) return;
    const own = owner.def.side, other = own === 'ally' ? 'foe' : 'ally';
    const sides = record.作用对象码 === 2 ? [own, other] : [record.作用对象码 === 0 ? other : own];
    for (const side of sides) {
      if (this.entries.some(e => e.side === side && e.id === rule.编号)) continue;
      this.entries.push({ id: rule.编号, side, owner, pack: rule.动画,
        remaining: Math.round((record.回气秒 ?? 0) * 20000) });
    }
  }
  tick(delta) {
    this.elapsed += delta;
    const ticks = Math.floor(this.elapsed / 55);
    this.elapsed -= ticks * 55;
    for (const e of this.entries) e.remaining -= ticks * 1100;
    this.entries = this.entries.filter(e => e.remaining >= 0 && e.owner.alive);
  }
  spellRestriction(record) {
    return record?.绝学类型码 === 2 && (this.has('ally', 2) || this.has('foe', 2)) ? '反咒禁制中，無法使用咒法' : '';
  }
  options(target) {
    const side = target.def.side;
    return { blockSpell: this.has(side, 2), blockPhysical: this.has(side, 6),
      blockLight: this.has(side, 4), forceMagicHit: this.has(side, 3) };
  }
  clockMods(unit) {
    return [{ factor: (this.has(unit.def.side, 7) ? 2 : 1) * (this.has(unit.def.side, 8) ? .5 : 1), phases: ['wait', 'charge'] }];
  }
  /** 阈迦结算消耗按一次行动的全部目标合计，不能每个目标分别舍入。 */
  intercept(target, hp, qi, costs) {
    const owner = this.owner(target.def.side, 3);
    if (!owner) return { hp, qi };
    costs.set(owner, (costs.get(owner) ?? 0) + hp + qi);
    return { hp: 0, qi: 0 };
  }
  pay(costs) {
    for (const [owner, amount] of costs) {
      if (amount <= 0) continue;
      owner.state = Object.freeze({ ...owner.state, qi: Math.max(0, owner.state.qi - Math.trunc(amount / 15)) });
      if (!owner.state.qi) this.removeOwner(owner);
    }
  }
}

export function persistentPackKeys(rules = {}) {
  return [...new Set([...Object.values(rules.场方效果 ?? {}).filter(v => [2, 3, 4, 6, 7, 8].includes(v.编号)).map(v => v.动画),
    ...Object.values(rules.状态演出 ?? {}).flatMap(v => [v.前层, v.后层])].filter(Boolean))];
}

/** 原作状态图层选择0x4207b0；冻/幻影独占，命蕴遮毒、狂暴遮慎惧。 */
export function visibleStates(states = {}) {
  const has = id => states[id] > 0;
  if (has(9)) return [9];
  if (has(14)) return [14];
  return [0, 21, 15, 10, 1, 2, 11, 13, 19].filter(id => has(id)
    && !(id === 0 && has(21)) && !(id === 10 && has(15)));
}
/** 官方0x43ebcc，60拍周期内的轻微抖动，不挪实际站位。 */
export function paralysisOffset(tick) {
  const n = tick % 60;
  return n < 2 || (n >= 4 && n < 6) ? { x: -2, y: 1 } : n < 20 ? { x: 2, y: -1 } : { x: 0, y: 0 };
}
