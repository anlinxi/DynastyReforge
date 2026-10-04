import { soulProgress } from './soulStones.js';
import { learnStorySkill } from './storyActions.js';
/**
 * 读档 —— 把 `tools/tsf_parse.py --export` 导出的存档变成队伍与背包。
 *
 * ## 这东西是干什么用的
 *
 * **测试入口。** 想试某个数值（某人五内点满、背包里塞一件特定装备、
 * 金钱给够去买东西），不要再去改 `inventory.js` 的 `START_PACK` 或
 * `partyState.js` 的 `TEST_WUNEI_POINTS` —— 那些是代码，改了要记得改回来。
 * 改**存档 JSON** 就行，它本来就是数据。
 *
 * ```bash
 * # 从原作存档导一份
 * python3 tools/tsf_parse.py ~/Game/.../save/Save013.TSF --export test
 * # 然后直接编辑 game/public/assets/data/saves/test.json
 * ```
 *
 * ## 只读原始状态
 *
 * 存档里那份抗性快照**不采信**：一来它有 8% 与我们的公式对不上
 * （原因未查清，见 `tools/tsf_parse.py` 的 §待查），二来就算采信，
 * 它与 `formulas.js` 现算的值会变成两个来源，迟早不同步。
 * 派生值一律现算，存档只提供「角色自己的状态」。
 *
 * ## ⚠️ 两套角色代码
 *
 * 存档里的是**战斗角色代码**（夏侯仪 1、冰璃 2、封铃笙 3…），
 * 而 `characters.json` 的「代码」是**对话人物代码**（冰璃是 8）。
 * 两者不通用 —— 这条坑 `CLAUDE.md` 专门警告过。
 * 这里靠 `gamedata.队伍顺序` 换算：**战斗代码 = 队伍顺序里的下标 + 1**。
 */

/**
 * 存档里的剧情旗标 → `FlagStore` 的初值。
 *
 * ⚠️ **主线进度就是旗标 1。** 兰州城这一段的链路是：
 * `flag1==6` → 城里某事件写 7 → 进药铺写 8 → **进废屋才演封铃笙初遇** → 写 9。
 * 开局 flag1 是 0，所以直接跑去废屋只会切个图 —— **那是原作逻辑，不是 bug**。
 * 要验收初遇，在测试存档里写 `"剧情旗标": { "1": 8 }`。
 *
 * 旗标在原作存档里位于 `0xE179 + 编号×2`，`tsf_parse.py` 还没解那一片，
 * 所以这里的值目前是**手写进 JSON 的**，不是从 TSF 来的。
 */
export function flagsFromSave(save) {
  const raw = save?.剧情旗标 ?? {};
  return Object.fromEntries(
    Object.entries(raw).map(([k, v]) => [Number(k), Number(v)]).filter(([k]) => Number.isFinite(k)),
  );
}

/** 战斗角色代码 → 角色名。 */
function nameByBattleCode(gamedata) {
  const order = gamedata?.队伍顺序 ?? [];
  return new Map(order.map((name, index) => [index + 1, name]));
}

/** 存档角色的原始数值；在队和暂未入队使用同一转换。 */
function memberFromRecord(rec, name, code, gamedata) {
  const base = gamedata.角色?.[name];
  return Object.freeze({
      name,
      code,
      序: base?.序 ?? code - 1,
      曾入队: rec.曾入队 ?? 0,
      已有历练: rec.已有历练 ?? 0,
      // ⚠️ **用存档里的位阶，不要拿历练重算。**
      // `Save008` 位阶 21 / 历练 153570（按门槛算是 33）—— 那档被修改器改过。
      // 原作存档的**头部等级字段也写着 21**，证明原作读档时不重算。
      // 重算的后果：读档一进去等级从 21 跳到 33，再存回去就把错的写死了。
      位阶: rec.位阶 ?? 0,
      命: rec.命 ?? 0, 命极: rec.命极 ?? 0,
      气: rec.气 ?? 0, 气极: rec.气极 ?? 0,
      膂力: rec.膂力 ?? 0, 体魄: rec.体魄 ?? 0, 灵力: rec.灵力 ?? 0,
      迅捷: rec.迅捷 ?? 0, 机运: rec.机运 ?? 0,
      迅: rec.迅 ?? 0, 烈: rec.烈 ?? 0, 神: rec.神 ?? 0,
      魔: rec.魔 ?? 0, 魂: rec.魂 ?? 0,
      剩余五内: rec.剩余五内 ?? 0,
      绝学: Object.freeze([...(rec.绝学 ?? [])]),
      ...soulProgress(rec),
      装备: Object.freeze({ ...rec.装备 }),
    });
}

/**
 * 存档 → 队伍状态。形状与 `partyState.createParty()` 的产物一致。
 *
 * @param {object} save `saves/*.json`
 * @param {object} gamedata
 * @param {string[]} [only] 只要这几个人（缺省：存档里所有认得出名字的）
 */
export function partyFromSave(save, gamedata, only = null) {
  if (!save?.角色) throw new Error('partyFromSave: 存档里没有「角色」');
  const names = nameByBattleCode(gamedata);
  const members = [];
  // 按战斗代码升序 —— 队伍顺序是固定的，不跟存档里的键序走。
  for (const code of [...Object.keys(save.角色)].map(Number).sort((a, b) => a - b)) {
    const name = names.get(code);
    const rec = save.角色[String(code)];
    if (!name || !rec) continue;
    if (only && !only.includes(name)) continue;
    members.push(memberFromRecord(rec, name, code, gamedata));
  }
  if (!members.length) {
    throw new Error('partyFromSave: 存档里没有一个角色能对上「队伍顺序」');
  }
  const reserve = {};
  const active = new Set(members.map((m) => m.code));
  for (const [rawCode, rec] of Object.entries(save.角色全表 ?? save.角色)) {
    const code = Number(rawCode), name = names.get(code);
    if (name && rec && !active.has(code)) reserve[code] = memberFromRecord(rec, name, code, gamedata);
  }
  const party = Object.freeze({
    members: Object.freeze(members),
    reserve: Object.freeze(reserve),
    金钱: save.金钱 ?? 0,
    选中: 0,
    // 阵型格号。**按代码对，不按下标对** —— 存档里的成员数组有自己的顺序
    // （`Save011` 是 `[1,2,4]`），而这里的 `members` 是按战斗代码升序重排过的。
    // 照下标抄会把「谁站哪」错位，表现是读档后阵形页人站错格。
    站位: Object.freeze(slotsByCode(save, members)),
  });
  // 旧复刻跳过MP0212槽9的习得指令。旗标1>=9证明废屋剧情已完成，
  // 补回必得的离火神诀；新游戏/事前存档不赠送，也不改读入的原始字节。
  return Number(save.剧情旗标?.[1]) >= 9 ? learnStorySkill(party, 1) : party;
}

/**
 * 存档里每个成员的阵型格号，重排成 `members` 的顺序。
 *
 * 存档缺这一段（老档、或人数与数组对不上）时返回空数组，
 * 由 `formation.slotsOf` 去补默认站位。
 */
function slotsByCode(save, members) {
  const byCode = new Map();
  (save?.队伍 ?? []).forEach((code, i) => {
    const slot = Number(save?.阵型?.[i]);
    if (Number.isInteger(slot)) byCode.set(Number(code), slot);
  });
  if (!byCode.size) return [];
  return members.map((m) => byCode.get(m.code));
}

/**
 * 存档 → 背包。条目形状与 `inventory.createInventory()` 一致。
 *
 * 存档里认不出来的代码会被**丢掉并在控制台留一行**——静默吞掉的话，
 * 背包里少了东西却看不出原因。
 */
export function inventoryFromSave(save, catalog) {
  const rows = [];
  const unknown = [];
  for (const row of save?.背包 ?? []) {
    if (!catalog.物品(row.代码)) {
      unknown.push(row.代码);
      continue;
    }
    rows.push(Object.freeze({
      代码: row.代码,
      数量: row.数量 ?? 1,
      ...(row.暂置 ? { 暂置: true } : {}),
    }));
  }
  if (unknown.length) {
    console.warn(`读档：${unknown.length} 件物品的代码不在目录里，已跳过：`
      + unknown.slice(0, 10).join('、'));
  }
  return Object.freeze(rows);
}
