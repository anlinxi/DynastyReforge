import { targetable } from './sustainedAction.js';
/**
 * 一次战斗动作的**描述**：打谁、打几格、够不够得着、蓄劲回气多久。
 *
 * **纯函数，不碰 Phaser。** 攻擊 / 絕學 / 法寶 三条路最后都收敛成这里的
 * 一个 `action`，选目标（`systems/targeting.js`）与时钟（`systems/battleClock.js`）
 * 都只认这一个形状 —— 否则每加一个指令就要在铺格子、算蓄劲两处各改一遍。
 *
 * ## 三条路的判据各自在哪
 *
 * | 指令 | 阵营 | 范围 | 前后排 | 蓄劲/回气 |
 * |---|---|---|---|---|
 * | **攻擊** | 固定敌方 | 武器的 `武器攻击范围`（`Ail2.ENC +52`） | 同左 | **都是 0**（普攻不蓄劲也不回气） |
 * | **絕學** | `skills.json` 的 `作用对象` | `作用范围` | `前后排判定` | `蓄劲秒`/`回气秒`（`Firttech.enc +140/+144`） |
 * | **法寶** | `items.json` 的 `作用对象` | `作用范围` | `前后排判定` | 不蓄劲，回气标称5秒 |
 *
 * ⚠️ **`作用对象` 的偏移 2026-09-18 订正过**：`Ail2.ENC` 里是 `+184` 不是
 * `+176`。旧的那个毫无区分度，于是雷火弹（攻击道具）解出来是「己方阵营」，
 * 选目标时会把绿格铺到自己人脚下。判据写在 `tools/export_gamedata.py`。
 *
 * 法宝回气原值100000来自原程序0x423c56，不从Ail2不存在的时间字段推断。
 */
import {
  CAMP, RANGE, REACH, weaponReach, selectableTiles, affectedTiles, canTarget,
} from './targeting.js';

/** 动作的三种来源。 */
export const ACTION_KIND = Object.freeze({
  ATTACK: 'attack',
  SKILL: 'skill',
  ITEM: 'item',
});

const known = (value, table, fallback) =>
  (Object.values(table).includes(value) ? value : fallback);

/**
 * **出手站位**（绝学的 `攻击位置`，`Firttech.enc`）。
 *
 * `原地` = 站在自己格子上放；`目标阵前` = 冲到目标身前再打。
 * 普攻没有这个字段，由**武器的 `武器攻击范围`** 决定（见 {@link lungesForWeapon}）。
 */
export const SPOT = Object.freeze({ PLACE: '原地', FRONT: '目标阵前' });

/**
 * **这把武器要不要冲上去打。**
 *
 * 判据是 `equipment.json` 的 `武器攻击范围`，全库五种取值：
 *
 * | 取值 | 件数 | 走不走过去 | 为什么 |
 * |---|---|---|---|
 * | `前排单体` | 121 | **走** | 刀剑，够不着后排 |
 * | `前排一横排` | 17 | **走** | 索带横扫前排 |
 * | `一直列` | 35 | **走** | **长枪穿刺** —— 从前排扎到后排，人还是要顶上去 |
 * | `任意单体` | 43 | 原地 | 宿玉这类法器，隔空打 |
 * | `全体` | 8 | 原地 | 法器群攻 |
 *
 * ⚠️ **「够得着后排」不等于「远程」。** 上一版我把 `一直列` 归成原地，
 * 理由是「它够得着任意一格」—— 用户 2026-09-19：「一直列（长枪穿刺）
 * 当然要走过去，近战跟远程你分不清楚是吗？」。**分界是兵器还是法器**，
 * 不是够不够得着。
 *
 * ⭐ 慕容璇玑装的九陽煌珠（宿玉）是 `任意单体` —— 原地出手。
 */
const RANGED_WEAPON = new Set(['任意单体', '全体']);

export function lungesForWeapon(weaponRange) {
  const r = String(weaponRange ?? '');
  return Boolean(r) && !RANGED_WEAPON.has(r);
}

/**
 * 普攻 —— 范围来自**武器**，蓄劲回气都是 0。
 *
 * @param {string} weaponRange `equipment.json` 的 `武器攻击范围`；空手传 null
 */
export function attackAction(weaponRange = null) {
  const { range, reach } = weaponReach(weaponRange);
  const spot = lungesForWeapon(weaponRange) ? SPOT.FRONT : SPOT.PLACE;
  return Object.freeze({
    kind: ACTION_KIND.ATTACK,
    label: '攻擊',
    camp: CAMP.FOE,                       // 普攻永远打敌人
    range,
    spot,
    reach,
    charge: 0,
    recover: 0,
    skill: null,
    item: null,
  });
}

/**
 * 绝学 —— 三个字段全来自 `skills.json`。
 *
 * @param {object} skill `systems/skills.js` 的 `buildSkill()` 结果
 * @param {object} [record] 原始记录（`作用对象`/`作用范围`/`前后排判定` 在这儿）
 */
export function skillAction(skill, record = null) {
  const src = record ?? skill?.record ?? skill ?? {};
  return Object.freeze({
    kind: ACTION_KIND.SKILL,
    label: skill?.name ?? src.名称繁 ?? src.名称 ?? '絕學',
    camp: known(src.作用对象, CAMP, CAMP.FOE),
    // ⚠️ **绝学那张表的字段叫 `作用范围格`，不是 `作用范围`**（法寶/装备两张
    // 表才叫 `作用范围`）。读错了 `known()` 会静默兜底成**单体** ——
    // 于是**每一门绝学都变成单体**：焚炎之陣（全体）只打一个、雷引之術
    // （横排）只打一个。用户 2026-09-19 报。
    range: known(src.作用范围格 ?? src.作用范围, RANGE, RANGE.SINGLE),
    reach: known(src.前后排判定, REACH, REACH.ANY),
    // ⭐ **出手时走不走过去** —— `Firttech.enc` 的 `攻击位置`：
    // 「原地」站着放、「目标阵前」冲到目标身前。
    spot: src.攻击位置 ?? SPOT.PLACE,
    charge: Number(skill?.charge) || 0,
    recover: Number(skill?.recover) || 0,
    skill,
    item: null,
  });
}

/**
 * 法宝（道具）—— 阵营/范围来自items；原作0x423c56不蓄劲、回气100000。
 *
 * @param {object} record `items.json` 的一条
 */
export function itemAction(record) {
  return Object.freeze({
    kind: ACTION_KIND.ITEM,
    label: record?.名称繁 ?? record?.名称 ?? '法寶',
    camp: known(record?.作用对象, CAMP, CAMP.FOE),
    range: known(record?.作用范围, RANGE, RANGE.SINGLE),
    reach: known(record?.前后排判定, REACH, REACH.ANY),
    spot: SPOT.PLACE,                       // 用东西不走位
    charge: 0,
    recover: 5,
    skill: null,
    item: record,
  });
}

/**
 * 这次动作能指哪些格（绿格）。
 *
 * ⚠️ 用户 2026-09-16 明确说过：**一出现就是 8 格全有，不管格子上有没有人**。
 *
 * @param {object} action
 * @param {{u:number,v:number}} [actorTile] 施法者所在格（`自体` 要用）
 */
export function greenTiles(action, actorTile = null) {
  return selectableTiles(action?.camp, actorTile ? { ...actorTile } : null);
}

/**
 * 指着 `tile` 时这一下会打到哪些格（蓝格）。指不上就是空的。
 *
 * @param {{u:number,v:number}[]} [alive] 目标那一方**还活着的人**占的格 ——
 *   前排是相对的，不传的话前排死光之后近战就够不着后排（见 `targeting.activeFront`）
 */
export function blueTiles(action, tile, actorTile = null, alive = null) {
  if (!tile) return [];
  const me = actorTile ? { ...actorTile } : null;
  if (!canTarget(tile, action?.camp, action?.reach, me, alive, action?.range)) return [];
  return affectedTiles(tile, action?.range);
}

/**
 * 绿格里**哪些是真能确认的**（前后排够得着的那些）。
 *
 * 光标要落在能确认的格上，否则玩家按下去没反应 —— 近战的后排就是这样。
 */
export function confirmableTiles(action, actorTile = null, alive = null) {
  const me = actorTile ? { ...actorTile } : null;
  return greenTiles(action, actorTile)
    .filter((t) => canTarget(t, action?.camp, action?.reach, me, alive, action?.range));
}

/** 这次动作会打到的**单位**（场上有人的那几格）。 */
export function targetsOf(action, tile, units, actorTile = null, alive = null) {
  const hit = blueTiles(action, tile, actorTile, alive);
  const key = (t) => `${t.u},${t.v}`;
  const want = new Set(hit.map(key));
  return (units ?? []).filter((u) => (action?.camp === CAMP.DEAD ? !u.alive : targetable(u))
    && u.def?.tile && want.has(key(u.def.tile)))
    .sort((a, b) => Number(key(b.def.tile) === key(tile)) - Number(key(a.def.tile) === key(tile)));
}

/** 长枪选择前排，穿透到同列后排时伤害减半；前排全灭后后排成为主目标。 */
export function weaponDamageScale(action, target, primary) {
  return action?.kind === ACTION_KIND.ATTACK && action.range === RANGE.COLUMN
    && target.def.tile.u !== primary.def.tile.u ? 0.5 : 1;
}

/** 0x42152a..0x42155e：后排非零命/气量先向远离零方向加2，再整除2。
 * 不是直接乘0.5；吸取量在此前计算，原作不在这个分支减半。
 */
export function penetrationAmount(amount) {
  return amount ? Math.trunc((amount + Math.sign(amount) * 2) / 2) : 0;
}
