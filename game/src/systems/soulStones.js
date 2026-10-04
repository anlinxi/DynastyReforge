/** 官方4232d0/423470/421a00；机会只存在于一次行动周期，不写入永久绝学。 */
import { nativeRand } from './combat.js';
export const SOUL_FIELDS = Object.freeze(['魂石熟练', '魂石积累'].flatMap(prefix => [1,2,3,4,5].map(i => `${prefix}${i}`)));
export const soulProgress = member => Object.fromEntries(SOUL_FIELDS.map(key => [key, Number(member?.[key]) || 0]));
export const soulCodes = stone => (stone?.skills ?? []).filter(code => code > 0).map(code => code.toString(16).toUpperCase());
export const soulPack = stone => stone.art.replaceAll('\\', '/').split('/').at(-1).replace(/\.sf2$/i, '').toLowerCase();
export function equippedSoul(member, stones) {
  const code = Number.parseInt(String(member?.装备?.饰物), 16);
  return stones?.find(stone => stone.items.includes(code)) ?? null;
}
/** 原作423550进入战斗时清掉兽魂绝学，再按本次机会临时加入。 */
export function battleSoulSkills(member, active, stones = []) {
  const temporary = new Set(stones.flatMap(soulCodes));
  return [...new Set([...(member?.绝学 ?? []).filter(code => !temporary.has(code)), ...soulCodes(active)])];
}
/** 测试开关：网址加 `soul=always` 时装了魂石的人每次出手都有召唤机会（用户2026-09-30要求）；不加完全按原作概率。 */
export const SOUL_ALWAYS = (() => {
  try { return new URLSearchParams(window.location.search).get('soul') === 'always'; } catch { return false; }
})();
export function canSummon(member, stone, rng = Math.random, always = SOUL_ALWAYS) {
  if (!stone || [2,5,8].includes(Number(member.code))) return false;
  if (always) return true;
  const chance = member.气极 > 0 ? Math.trunc((member[`魂石熟练${stone.type}`] || 0) / 4) : 0;
  return nativeRand(rng) % 100 <= chance;
}
export function trainSoul(member, stone, skillCode, rng = Math.random) {
  if (!stone) return member;
  const rank = stone.trainingSpells.indexOf(parseInt(skillCode, 16)) + 1;
  if (rank <= 0) return member;
  const mastery = `魂石熟练${stone.type}`, training = `魂石积累${stone.type}`;
  const low = Math.trunc((rank - 1) / 2), high = Math.trunc(rank / 2);
  const progress = Math.min(100, (member[training] || 0) + low + nativeRand(rng) % (high - low + 1));
  const chance = Math.trunc(((member[mastery] || 0) + progress - 25) / 5);
  const grown = chance > 0 && nativeRand(rng) % 100 < chance;
  return { ...member, [training]: grown ? 0 : progress, [mastery]: Math.min(100, (member[mastery] || 0) + Number(grown)) };
}
export function endSoulOpportunity(unit) {
  const stone = unit.soulStone;
  if (stone && soulCodes(stone).includes(unit.soulActionCode)) {
    const key = `魂石熟练${stone.type}`;
    unit.stats = { ...unit.stats, [key]: Math.min(100, (unit.stats[key] || 0) + 1) };
  }
  unit.soulStone = null;
  unit.soulActionCode = null;
  unit.soulChecked = false;
}
