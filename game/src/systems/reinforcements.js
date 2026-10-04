/** 官方RPG.exe 0x443d90：先抽一种敌人，再抽1～2名；按格号、单位槽顺序补空。 */
import { nativeRand } from './officialDamage.js';

export const REINFORCEMENTS = Object.freeze({
  '161': Object.freeze([125, 126]),
  '169': Object.freeze([145, 146, 147, 148]),
});

/** 本场可能继续召来的敌种闭包，供入场预载使用。 */
export function reinforcementCodes(initial, enemies) {
  const seen = new Set(initial.map(Number));
  for (const code of seen) {
    for (const skill of enemies?.[code]?.绝学 ?? []) {
      for (const summoned of REINFORCEMENTS[skill] ?? []) seen.add(summoned);
    }
  }
  return [...seen];
}

/** slots按原作八个单位槽排列；阵地格号与单位槽不是同一个编号。 */
export function planReinforcements(skill, slots, rng = Math.random) {
  const choices = REINFORCEMENTS[skill];
  if (!choices) return [];
  const code = choices[nativeRand(rng) % choices.length];
  const count = nativeRand(rng) % 2 + 1;
  const occupied = new Set(), freeUnits = [];
  for (let i = 0; i < 8; i++) {
    const unit = slots[i];
    if (!unit || !unit.alive) { freeUnits.push(i); continue; }
    const tile = unit.slot;
    if (tile < 0 || tile >= 8) continue;
    occupied.add(tile);
    if (unit.size === 1 && tile >= 1) occupied.add(tile - 1);
    if (unit.size === 2 && tile >= 4) occupied.add(tile - 4);
    if (unit.size === 3 && tile >= 4) {
      occupied.add(tile - 1); occupied.add(tile - 4); occupied.add(tile - 5);
    }
  }
  const result = [];
  for (let slot = 0; slot < 8 && result.length < count && freeUnits.length; slot++) {
    if (!occupied.has(slot)) result.push({ code, slot, index: freeUnits.shift() });
  }
  return result;
}
