import artSubstitute from './battleArt.json' with { type: 'json' };
/**
 * 出场名单 —— 把「遇敌组」与队伍变成战场上的一批单位定义。
 *
 * 从 `BattleScene` 分出来的原因：那个文件已经 377 行，而这里要接的是
 * `gamedata` 的三张表（遇敌组 / 敌人 / 角色），塞进去会顶到八百行上限。
 *
 * ## 单位定义长什么样
 *
 * 与 `config.js` 的 `UNITS` 同构（`BattleUnit` 直接吃它），只是
 * **`offsetX/offsetY` 不再手调**，改由 `battlefield.slotOffset()` 按格心算。
 *
 * ## 战斗素材的键
 *
 * `STN/ATT/HIT + 代码×10`（补足四位）：夏侯仪 1→`STN0010`、
 * 西夏兵 103→`STN1030`。这条规律在遇敌组用到的 139 个代码上命中 135 个。
 * 导出器已把算好的四位数字放进 `gamedata.敌人[代码].素材`，这里直接用。
 */
import { slotOffset, slotToTile, tileDepth } from './battlefield.js';
import { DEFAULT_SLOTS } from './formation.js';

/**
 * 我方默认站位。**只有一份正本** —— 就是阵形页那张
 * `formation.DEFAULT_SLOTS`（前排从右往左，排满退后排）。
 *
 * ⚠️ 别在这里再抄一份。上一版这里是独立的 `[7,6,5,4]`，**只有四格**，
 * 五人队伍时最后一个人拿不到位置。原作的站位是玩家摆的、存在存档的
 * 队伍区 `@56648`，读档时由 `partyFromSave` 带进 `party.站位`，
 * 这张表只在存档没给时兜底。
 */
export const DEFAULT_ALLY_SLOTS = DEFAULT_SLOTS;

/** 把一个单位定义摆到某一格上：站位偏移与绘制深度都由格盘算。 */
export function placeDef(def, slot, side) {
  const { u, v } = slotToTile(slot, side);
  const { x, y } = slotOffset(slot, side);
  return Object.freeze({ ...def, side, slot, tile: { u, v }, offsetX: x, offsetY: y, depth: tileDepth(u, v) });
}

/** 已登记的旧素材替身。只有207空名记录仍沿用206，真实对应关系未确定。
 * 245/246/248的STN/ATT/HIT/DEF实际存在官方fight散装补丁，已恢复自身素材。
 * 旧“DAT没有→官方没有→使用替身”的推断撤回；导出和预载共用此表。
 */
export const ART_SUBSTITUTE = Object.freeze(artSubstitute);

/** 2026-09-19用户批准：这两种敌人暂留旧普攻流程，等待原作定点验证。
 * 不改原始Firttech记录，也不按近似文件名猜替代的MIS/RED。
 */
const LEGACY_NORMAL_ATTACKS = new Set([243, 245]);
export function normalAttackRecord(gamedata, code) {
  return LEGACY_NORMAL_ATTACKS.has(Number(code)) ? null : gamedata?.普通攻击?.[String(code)];
}

/** 敌人代码 → 实际要用的素材号（缺包的换成替身）。 */
export function foeArt(gamedata, code) {
  const art = gamedata?.敌人?.[String(code)]?.素材;
  if (!art) return null;
  return ART_SUBSTITUTE[String(art)] ?? ART_SUBSTITUTE[Number(art)] ?? String(art);
}

/** 敌人代码 → 单位定义（不含站位）。 */
export function enemyDef(gamedata, code, index) {
  const rec = gamedata?.敌人?.[String(code)];
  if (!rec) return null;
  const art = foeArt(gamedata, code);
  return {
    id: `foe${index}`,
    code,
    // ⚠️ 名称是 **Big5 繁体**，那是渲染正本 —— 字库按 Big5 码位索引。
    name: rec.名称繁 || `敌${code}`,
    stand: `STN${art}`,
    attack: normalAttackRecord(gamedata, code)?.攻击动作 || `ATT${art}`,
    hurt: `HIT${art}`,
    guard: `DEF${art}`,
    move: rec.移动动作, back: rec.归位动作, charge: rec.默认蓄劲动作, cast: rec.默认施法动作,
    attackType: 'melee',
    loadout: [],
    skills: [],
    stats: rec,
  };
}

/**
 * 一场仗的敌方阵容。
 *
 * @param {object} gamedata
 * @param {number} groupId 遇敌组编号（事件脚本 op55 的 `swarm` 字段给的就是它）
 * @returns {object[]} 已摆好位置的单位定义；查不到就是空数组
 */
export function foeRoster(gamedata, groupId) {
  const group = (gamedata?.遇敌组 ?? [])[Number(groupId)];
  if (!group) {
    console.warn(`遇敌组 ${groupId} 不在数据里，敌方阵容为空`);
    return [];
  }
  const out = [];
  for (const [i, e] of (group.敌人 ?? []).entries()) {
    const def = enemyDef(gamedata, e.代码, i);
    if (!def) {
      console.warn(`遇敌组 ${groupId} 的敌人代码 ${e.代码} 不在敌人表里，跳过`);
      continue;
    }
    out.push(placeDef(def, e.位置, 'foe'));
  }
  return out;
}

/** 我方阵容：按 `DEFAULT_ALLY_SLOTS` 依次落座。 */
export function allyRoster(defs, slots = DEFAULT_ALLY_SLOTS) {
  // ⚠️ **空站位表要退回默认**：`formation.slotsOf` 的长度跟着队伍走，
  // registry 里还没有队伍时它是空数组 —— 直接用会 `slice(0,0)`，
  // 我方一个人都不上场，战斗一开始就判敌方胜。
  const use = slots?.length ? slots : DEFAULT_ALLY_SLOTS;
  return defs.slice(0, use.length).map((def, i) => placeDef(def, use[i], 'ally'));
}

/** 这场仗要预载哪些动画素材。 */
export function rosterAnimKeys(roster) {
  return [...new Set(roster.flatMap(
    (d) => [d.stand, d.attack, d.hurt, d.guard, d.move, d.back, d.charge, d.cast, d.victory, d.levelUp].filter(Boolean),
  ))];
}
