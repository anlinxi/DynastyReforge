/**
 * 队伍状态：谁在队里、各自什么数值、装备了什么。
 *
 * **数从 `assets/data/gamedata.json` 来，算法从 `systems/formulas.js` 来。**
 * 这个文件只做「把两者接起来 + 管当前选中谁」，自己不含任何数值常量与公式。
 *
 * 派生值（攻击/护禦/命中/闪避、两套抗性）**不存在成员身上**，
 * 而是每次要用时由 `memberView()` 现算 —— 免得装备一换就有两处要同步。
 */
import {
  RESISTS, resistTable, WUNEI, WUWAI,
  derivedStats, equipMaxDelta, gearResist, innateResist, learnableSkills, rankFromExp, experienceRemaining,
} from './formulas.js';

/** 三个装备槽，顺序即及身页从上到下。 */
export const EQUIP_SLOTS = Object.freeze(['兵刃', '护甲', '饰物']);

/** 开局队伍。⚠️ 名字要与 `gamedata.json` 的键一致（已在导出时把「封玲笙」统一成「封铃笙」）。 */
const DEFAULT_MEMBERS = Object.freeze(['夏侯仪', '冰璃', '封铃笙']);

export { RESISTS, WUNEI, WUWAI };

/**
 * 建队。
 * @param {object} gamedata assets/data/gamedata.json
 * @param {string[]} names 入队角色名
 */
export function createParty(gamedata, names = DEFAULT_MEMBERS) {
  if (!gamedata?.角色) throw new Error('createParty: 缺少 gamedata.角色');
  const members = names
    .filter((n) => gamedata.角色[n])
    .map((n) => createMember(n, gamedata.角色[n], gamedata.开局装备?.[n], gamedata));
  if (!members.length) {
    throw new Error(`createParty: gamedata 里找不到任何一个成员（${names.join('/')}）`);
  }
  return Object.freeze({ members: Object.freeze(members), 金钱: 0, 选中: 0 });
}

/**
 * 一个成员。**只存"自己的"状态**，派生值不存。
 *
 * ⚠️ 命极/气极存在成员身上而不是每次算 —— 因为装备的命极/气极补正是
 * **换装时一次性写入**的（见 `formulas.equipMaxDelta` 的说明），不是动态叠加。
 */
export function createMember(name, base, gear, gamedata = null) {
  return Object.freeze({
    name,
    code: base.代码,              // 战斗角色代码；立绘/姓名/队伍条小人都按 序 = 代码−1 取帧
    序: base.序,
    已有历练: base.已有历练,
    // ⚠️ **位阶是成员自己的状态，不是每次从历练现算的。**
    // 判据：原作存档里**同时**存了「位阶」与「已有历练」——
    // 若引擎现算，存位阶就没意义。而 `Save008` 的头部等级字段写着 `21`、
    // 角色区位阶也是 `21`，可它的历练 153570 按门槛算是 **33**。
    // 不据此推断存档如何产生；读档保留其位阶，战后按原作规则最多升一级。
    // 见 `docs/判据/存档格式.md`。
    位阶: rankFromExp(base.已有历练 ?? 0, gamedata?.历练门槛 ?? []),
    命: base.命, 命极: base.命,
    气: base.气, 气极: base.气,
    ...Object.fromEntries(WUWAI.map((k) => [k, base[k] ?? 0])),
    ...Object.fromEntries(WUNEI.map((k) => [k, base[k] ?? 0])),
    剩余五内: base.剩余五内 ?? 0,
    绝学: Object.freeze(base.绝学 ?? []),
    装备: Object.freeze(Object.fromEntries(
      EQUIP_SLOTS.map((s) => [s, gear?.[s] ?? null]))),
  });
}

/** 当前选中的成员。 */
export function selectedMember(party) {
  return party.members[party.选中] ?? party.members[0];
}

/** 切换选中成员，返回**新的**队伍状态（不改原对象）。 */
export function selectStep(party, step) {
  const count = party.members.length;
  const next = ((party.选中 + step) % count + count) % count;
  return Object.freeze({ ...party, 选中: next });
}

/** 给一组键加后缀，用来放同一批值的不同变体（如「卸下兵刃后」）。 */
const withSuffix = (obj, suffix) =>
  Object.fromEntries(Object.entries(obj).map(([k, v]) => [k + suffix, v]));

/** 按代码取装备记录。空槽返回 null。 */
function gearOf(member, catalog) {
  return EQUIP_SLOTS.map((slot) => catalog.物品(member.装备?.[slot]));
}

/**
 * 界面要显示的全部字段，**键名与 `menus.json` 的 `statSlots.field` 一一对应**。
 *
 * 加一个新的数值坑时：在 `export_menu_ui.py` 的 `STAT_SLOTS` 里写上 field，
 * 然后确保这里能产出同名的键 —— 两边靠字段名对齐，不靠顺序。
 *
 * @param {object} party 队伍状态（金钱是队伍级的）
 * @param {object} gamedata gamedata.json
 * @param {object[]} equipment equipment.json
 */
export function memberView(party, gamedata, catalog, swap = null, alloc = null) {
  const m = selectedMember(party);
  if (!m) return {};
  const k = gamedata.常数;
  const gear = gearOf(m, catalog);
  // 预览用的那一套装备：把「假设换装」应用到副本上。
  // swap = { 槽: '兵刃', 代码: '2' | null }，null 表示卸下。
  const preview = swap ? gearOf(swapped(m, swap), catalog) : gear;
  const wunei = Object.fromEntries(WUNEI.map((w) => [w, m[w]]));
  // 五内加点的**暂存**：还没按确认，不写角色，只喂给预览那一路。
  // ⚠️ 五块牌上显示的点数是「存量 + 暂存」，而右列抗性仍按存量算 ——
  // 两者故意不同源，见 `菜单交互与数值联动.md` §3.3 A。
  const pending = allocSum(alloc);
  const wuneiNext = Object.fromEntries(WUNEI.map((w) => [w, m[w] + (alloc?.[w] ?? 0)]));

  return {
    ...Object.fromEntries(WUWAI.map((w) => [w, m[w]])),
    ...wuneiNext,
    // ⚠️ **先用成员自己的位阶**，没有才现算。读档时位阶来自存档 ——
    // 历练与位阶不一致时照搬存档，不自作主张重算或猜测存档来源。
    位阶: m.位阶 ?? rankFromExp(m.已有历练, gamedata.历练门槛),
    已有历练: experienceRemaining(m, gamedata.历练门槛),
    命: m.命, 命极: m.命极, 气: m.气, 气极: m.气极,
    剩余五内: m.剩余五内 - pending,
    金钱: party.金钱,
    ...derivedStats(m, gear, k),
    // 及身页「诸能」右列＝**预览**：把光标停着的那件装备换进已选槽之后的值。
    // 没有 swap 时预览等于当前，两列一样 —— 这是正确的「无变化」状态，
    // 不是占位。键名后缀与 menus.json 的 `statSlots[].variant` 对应。
    ...withSuffix(derivedStats(m, preview, k), '@预览'),
    抗性: {
      ...resistView(m, wunei, gear, gamedata, k),
      及身预览: gearResist(innateResist(wunei, resistTable(gamedata), k), preview),
      // 五内页左列：按「存量 + 暂存」现算。没有暂存时与 `内禀` 相等，
      // 这是正确的「无变化」，不是占位。
      内禀预览: innateResist(wuneiNext, resistTable(gamedata), k),
    },
  };
}

/** 暂存加点的总数。空／缺省都当 0。 */
export function allocSum(alloc) {
  return WUNEI.reduce((n, w) => n + (alloc?.[w] ?? 0), 0);
}

/**
 * 五内加点**确认写入**：把暂存加进角色五内，同额扣掉剩余五内。
 *
 * ⚠️ 只有这一步会改角色 —— 箭头只改暂存（见 `菜单交互与数值联动.md` §3.3 A）。
 * 超出剩余五内的暂存**整批拒绝**（返回原队伍），不做部分写入：
 * 部分写入会让界面上的数与实际写进去的数对不上，比不写更难查。
 *
 * @param {object} party 队伍状态
 * @param {Record<string, number>} alloc 暂存 `{迅:1, 烈:2, …}`
 * @returns {object} 新的队伍状态（不改原对象）
 */
export function allocWunei(party, alloc) {
  const m = selectedMember(party);
  const total = allocSum(alloc);
  if (!m || total <= 0 || total > m.剩余五内) return party;
  const next = Object.freeze({
    ...m,
    ...Object.fromEntries(WUNEI.map((w) => [w, m[w] + (alloc[w] ?? 0)])),
    剩余五内: m.剩余五内 - total,
  });
  const members = party.members.map((x, i) => (i === party.选中 ? next : x));
  return Object.freeze({ ...party, members: Object.freeze(members) });
}

/** 把一次「假设换装」应用到成员副本上。**不改原对象。** */
function swapped(member, swap) {
  return Object.freeze({
    ...member,
    装备: Object.freeze({ ...member.装备, [swap.槽]: swap.代码 ?? null }),
  });
}

/**
 * 真的换装：返回新的队伍状态与新的背包。
 *
 * ⚠️ **命极/气极是换装时一次性增减的**（配套 xlsx「概念释例」原文：
 * 「当且仅当在游戏及身界面更换装备时…进行增减计算」），所以在这里调
 * `equipMaxDelta` 写进角色，**不能**放进每帧都跑的 `derivedStats`。
 * 换完把命/气夹到新上限内。
 *
 * @returns {{party: object, inventory: object[]}}
 */
export function equipTo(party, inventory, catalog, slot, code) {
  const m = selectedMember(party);
  if (!m) return { party, inventory };
  const oldItem = catalog.物品(m.装备?.[slot]);
  const newItem = catalog.物品(code);
  const delta = equipMaxDelta(oldItem, newItem);
  const 命极 = Math.max(1, m.命极 + delta.命极);
  const 气极 = Math.max(0, m.气极 + delta.气极);
  const next = Object.freeze({
    ...m,
    命极, 气极,
    命: Math.min(m.命, 命极), 气: Math.min(m.气, 气极),
    装备: Object.freeze({ ...m.装备, [slot]: code ?? null }),
  });
  // 背包：拿走换上去的那件，放回换下来的那件。
  let pack = inventory.filter((r) => r.代码 !== code || (r.数量 ?? 1) > 1)
    .map((r) => (r.代码 === code ? { ...r, 数量: r.数量 - 1 } : r));
  if (oldItem) {
    const back = String(oldItem.物品编号).toUpperCase();
    const at = pack.findIndex((r) => r.代码 === back);
    pack = at >= 0
      ? pack.map((r, i) => (i === at ? { ...r, 数量: (r.数量 ?? 1) + 1 } : r))
      : [...pack, { 代码: back, 数量: 1 }];
  }
  const members = party.members.map((x, i) => (i === party.选中 ? next : x));
  return { party: Object.freeze({ ...party, members: Object.freeze(members) }),
           inventory: Object.freeze(pack) };
}

/**
 * 两套抗性。**它们不是一回事**：
 * * `内禀`（五内页显示）—— 只由五内决定，管**状态持续时间**
 * * `及身`（及身页显示）—— 内禀再乘上装备的抗性系数，管**伤害与特效命中**
 */
function resistView(member, wunei, gear, gamedata, k) {
  const table = resistTable(gamedata);
  const 内禀 = innateResist(wunei, table, k);
  return { 内禀, 及身: gearResist(内禀, gear) };
}

/** 当前位阶与五内下可习得的绝学（返回绝学代码列表）。 */
export function learnable(party, gamedata) {
  const m = selectedMember(party);
  if (!m) return [];
  const rank = m.位阶 ?? rankFromExp(m.已有历练, gamedata.历练门槛);
  const wunei = Object.fromEntries(WUNEI.map((w) => [w, m[w]]));
  return learnableSkills(m.code, rank, wunei, gamedata.绝学习得);
}
