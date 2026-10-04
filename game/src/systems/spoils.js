import { soulProgress } from './soulStones.js';
/** 战后结算依据0x443660：存活参战者各得全额历练；升级一次并回满命气。
 * 原概率与最大成长/必掉补丁分开；用户默认开启两项，设置页后续接共用配置。
 */
import { growWuwai, learnableSkills } from './formulas.js';
import { nativeRand } from './officialDamage.js';
import { BATTLE_PATCHES } from './gameplayOptions.js';

/** 遇敌组按编号取。找不到返回 null。 */
export function encounterGroup(gamedata, number) {
  const num = Number(number);
  return (gamedata?.遇敌组 ?? []).find((g) => Number(g?.编号) === num) ?? null;
}

/**
 * 掷一次战利。
 *
 * @param {object} gamedata
 * @param {number} encounter 遇敌组编号
 * @param {() => number} rng 随机源，测试里注入定值
 * @returns {{金钱:number, 历练:number, 物品:Array<string>}}
 *   `物品` 是**物品代码的十六进制串**（与背包、`catalog` 一致 —— 脚本里给的是
 *   十进制，表里是 `'1A7'` 这种，判据表有这一条）。
 */
export function rollSpoils(gamedata, encounter, rng = Math.random, patches = BATTLE_PATCHES) {
  const group = encounterGroup(gamedata, encounter);
  if (!group) return { 金钱: 0, 历练: 0, 物品: [] };

  const low = Number(group.掉落金钱下限) || 0;
  const span = Number(group.掉落金钱浮动) || 0;
  const 金钱 = low + (span > 0 ? nativeRand(rng) % span : 0);

  const foes = gamedata?.敌人 ?? {};
  const 历练 = (group.敌人 ?? []).reduce(
    (sum, f) => sum + (Number(foes[String(f.代码)]?.已有历练) || 0), 0);

  const 物品 = [];
  for (const loot of group.战利品 ?? []) {
    const chance = Number(loot.概率) || 0;
    if (chance <= 0) continue;
    const rolled = nativeRand(rng) % 100;
    if (patches.guaranteedDrops || rolled <= chance) 物品.push(Number(loot.代码).toString(16).toUpperCase());
  }
  return { 金钱, 历练, 物品 };
}

/**
 * 把战利并进队伍与背包。**返回新对象**，原来那份不动。
 *
 * @returns {{party:object, inventory:Array}}
 */
export function applySpoils(party, inventory, spoils, gamedata = null, patches = BATTLE_PATCHES, rng = Math.random) {
  const gained = Number(spoils?.历练) || 0;
  const upgrades = [];
  const members = (party?.members ?? []).map((m) => {
    if (!gained || m.命 <= 0) return m;
    const next = { ...m, 已有历练: (Number(m.已有历练) || 0) + gained };
    const threshold = gamedata?.历练门槛?.[m.位阶];
    if (threshold > 0 && next.已有历练 >= threshold) {
      next.位阶 = m.位阶 + 1;
      // 原程序仍调用随机数再由补丁覆盖结果；命气使用升级前体魄/灵力。
      const hpRoll = nativeRand(rng) % 3, qiRoll = nativeRand(rng) % 3;
      next.命极 = m.命极 + Math.trunc((m.体魄 - next.位阶) / 10) + 4 + (patches.maximumGrowth ? 2 : hpRoll);
      next.气极 = m.气极 + Math.trunc((Math.trunc(m.灵力 * 2 / 3) - next.位阶) / 25) + 3 + (patches.maximumGrowth ? 2 : qiRoll);
      next.命 = next.命极; next.气 = next.气极;
      for (const key of ['膂力', '体魄', '灵力', '迅捷', '机运']) {
        const range = gamedata.成长?.[m.name]?.range?.[key] ?? [0, 0];
        const rolled = nativeRand(rng) % (range[1] - range[0] + 1);
        next[key] = (m[key] ?? 0) + (patches.maximumGrowth ? growWuwai(range) : range[0] + rolled);
      }
      next.剩余五内 = (m.剩余五内 ?? 0) + 3;
      const learned = learnableSkills(m.code, next.位阶, next, gamedata.绝学习得 ?? [])
        .map(row => Number(row.绝学代码).toString(16).toUpperCase()).filter(code => !(m.绝学 ?? []).includes(code));
      next.绝学 = Object.freeze([...new Set([...(m.绝学 ?? []), ...learned])]);
      upgrades.push({ before: m, after: next, learned });
    }
    return Object.freeze(next);
  });

  const money = (Number(party?.金钱) || 0) + (Number(spoils?.金钱) || 0);
  const next = Object.freeze({ ...party, members: Object.freeze(members), 金钱: money });

  // 背包是 `{代码, 数量}` 的扁平表；同一件东西累加而不是并排两行。
  let rows = [...(inventory ?? [])];
  for (const code of spoils?.物品 ?? []) {
    const at = rows.findIndex((r) => r.代码 === code);
    rows = at >= 0
      ? rows.map((r, i) => (i === at ? { ...r, 数量: (r.数量 ?? 1) + 1 } : r))
      : [...rows, { 代码: code, 数量: 1 }];
  }
  return { party: next, inventory: rows, upgrades };
}

/** 结算摘要，给画面上那一行用。名字查 `catalog`，查不到就用代码。 */
export function spoilsText(spoils, catalog = null) {
  const parts = [];
  if (spoils?.历练) parts.push(`歷練 +${spoils.历练}`);
  if (spoils?.金钱) parts.push(`銀兩 +${spoils.金钱}`);
  for (const code of spoils?.物品 ?? []) {
    parts.push(`得「${catalog?.物品?.(code)?.名称繁 ?? catalog?.物品?.(code)?.名称 ?? code}」`);
  }
  return parts.join('　');
}

/** 只回写本场参战角色，保留装备、阵形、未参战者及同一场已消费的背包。 */
export function writeBattleVitals(party, units) {
  const byCode = new Map(units.filter(u => u.def.side === 'ally').map(u => [u.stats.code ?? u.def.code, u]));
  const members = party.members.map(m => {
    const u = byCode.get(m.code);
    return u ? Object.freeze({ ...m, ...soulProgress(u.stats), 命: u.state.hp, 气: u.state.qi }) : m;
  });
  return Object.freeze({ ...party, members: Object.freeze(members) });
}
