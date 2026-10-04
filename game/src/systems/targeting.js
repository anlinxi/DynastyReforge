/**
 * 「这一下会打到哪几格」—— 作用对象 / 作用范围 / 前后排判定的求解。
 *
 * **纯函数，不碰任何 Phaser 对象。** 画格子的是 `ui/TileOverlay.js`。
 *
 * ## 格盘长什么样（详见 `battlefield.js`）
 *
 * 7 列（`u`）× 4 排（`v`）。两端各 2 列是阵地，中间 3 列是空地：
 *
 * ```
 *        u=0    u=1   │ u=2 u=3 u=4 │  u=5    u=6
 *      敌后排 敌前排  │    空地     │ 我前排 我后排
 * v=0…3  ↑ 每列 4 排
 * ```
 *
 * **前排 ＝ 靠近对手那一列**：敌方 `u=1`、我方 `u=5`。
 *
 * ## 「直列」与「横排」是什么
 *
 * 一方是 **2 列（前/后）× 4 排**，所以：
 *
 * | 范围 | 打到哪 | 几格 |
 * |---|---|---|
 * | **单体** | 目标那一格 | 1 |
 * | **直列** | 目标那一**排**的前后两格（纵深穿透） | 2 |
 * | **横排** | 目标那一**列**的四格（横扫） | 4 |
 * | **全体** | 该方阵地全部 | 8 |
 *
 * **判据是武器**（`Ail2.ENC +52 武器攻击范围`，语义与持有者完全自洽）：
 *
 * * 长枪（古倫德/蕭熇）＝「一直列」→ 枪**刺穿**前后排；
 * * 索带（封鈴笙/高皇君）＝「前排一横排」→ **横扫**一整行；
 * * 匕首/长剑＝「前排单体」；宿玉（慕容璇璣/葛雲衣）＝「任意单体」（远程，
 *   所以那两人**没有走动画** —— 见 `docs/专题/战斗.md` §3.1bis）。
 *
 * ## 前后排判定
 *
 * `前后排判定` 只有两个值：**仅前排 / 无限制**。近战不能越过同一直列的活人；
 * 正前方空缺时可直接攻击后排，其他直列是否有人不影响它。
 *
 * ⚠️ 🟡 **一条没有判据的取舍**：目标不可选时（例如只能打前排却指着后排），
 * 我们**不让它变蓝、也不让确认**。原作是「指不上去」还是「指得上去但灰着」
 * 没验过，登记在 `docs/状态/复现度台账.md`。
 */
import { BOARD_WIDTH, ALLY_DEPTHS, FOE_DEPTHS } from './battlefield.js';

/** 作用对象（`skills.json` / `items.json` 的 `作用对象`）。 */
export const CAMP = Object.freeze({
  FOE: '敌方阵营',
  ALLY: '己方阵营',
  BOTH: '双方阵营',
  DEAD: '死者',
  SELF: '自体',
});

/** 作用范围（同上表的 `作用范围`）。 */
export const RANGE = Object.freeze({
  SINGLE: '单体',
  COLUMN: '直列',
  ROW: '横排',
  ALL: '全体',
});

/** 前后排判定。 */
export const REACH = Object.freeze({ FRONT: '仅前排', ANY: '无限制' });

/** 某一方的两列：`[后排 u, 前排 u]`。 */
const depthsOf = (side) => (side === 'foe' ? FOE_DEPTHS : ALLY_DEPTHS);

/** 某一方的前排那一列。**前排＝靠近对手**：敌 `u=1`、我 `u=5`。 */
export function frontDepth(side) {
  return side === 'foe' ? FOE_DEPTHS[1] : ALLY_DEPTHS[1];
}

/**
 * ⭐ **前排是相对的：该方还站得住人的、最靠前的那一列。**
 *
 * 写死 `u=1` 的后果：**前排四个全死之后，近战就够不着后排了，仗打不完**。
 * 用户 2026-09-18 报的「对面人都死了还能选中，反而是活着的这个选中不了」
 * 就是这个 —— 四个西夏兵（前排 `u=1`）倒了，赫蘭鐵罕在后排 `u=0`，
 * 而武器是「仅前排」。
 *
 * @param {'ally'|'foe'} side
 * @param {{u:number,v:number}[]} [alive] 该方**还活着的人**占的格；
 *   不给（或一个人都没有）就退回固定的前排列
 */
export function activeFront(side, alive = null) {
  const [back, front] = depthsOf(side);
  if (!Array.isArray(alive) || !alive.length) return front;
  if (alive.some((t) => t.u === front)) return front;
  return alive.some((t) => t.u === back) ? back : front;
}

/** 这一格是不是该方的前排。 */
export function isFront(u, side) {
  return u === frontDepth(side);
}

/** 某一格属于哪一方；中间三列返回 `null`。 */
export function sideOfTile(u) {
  if (FOE_DEPTHS.includes(u)) return 'foe';
  if (ALLY_DEPTHS.includes(u)) return 'ally';
  return null;
}

const tilesOfSide = (side) => {
  const out = [];
  for (const u of depthsOf(side)) {
    for (let v = 0; v < BOARD_WIDTH; v += 1) out.push({ u, v });
  }
  return out;
};

/**
 * **绿格铺哪些** —— 一次动作可以「指向」的全部格子。
 *
 * ⚠️ 用户 2026-09-16 明确说过：**一出现就是 8 格全有，不管格子上有没有人**。
 * 所以这里**不看占用、也不看前后排** —— 那两件事只影响「指上去能不能确认」。
 *
 * @param {string} camp `作用对象`
 * @param {{side:string,u:number,v:number}} [actor] 施法者所在格（`自体` 要用）
 * @returns {{u:number,v:number}[]}
 */
export function selectableTiles(camp, actor = null) {
  const ownSide = actor?.side ?? sideOfTile(actor?.u) ?? 'ally';
  const otherSide = ownSide === 'ally' ? 'foe' : 'ally';
  switch (camp) {
    case CAMP.ALLY:
    case CAMP.DEAD:
      return tilesOfSide(ownSide);
    case CAMP.BOTH:
      return [...tilesOfSide('foe'), ...tilesOfSide('ally')];
    case CAMP.SELF:
      return actor ? [{ u: actor.u, v: actor.v }] : [];
    case CAMP.FOE:
    default:
      return tilesOfSide(otherSide);
  }
}

/**
 * **蓝格铺哪些** —— 指着 `(u,v)` 时，这一下实际会打到的格子。
 *
 * @param {{u:number,v:number}} tile 鼠标指着的格
 * @param {string} range `作用范围`
 * @returns {{u:number,v:number}[]} 目标不在任何一方阵地上时返回空数组
 */
export function affectedTiles(tile, range) {
  const side = sideOfTile(tile?.u);
  if (!side) return [];
  const v = Number(tile.v);
  if (!Number.isInteger(v) || v < 0 || v >= BOARD_WIDTH) return [];

  switch (range) {
    case RANGE.ALL:
      return tilesOfSide(side);
    // 「横排」＝同一列的四排：屏幕上横着并排的一行，一扫四个
    case RANGE.ROW:
      return Array.from({ length: BOARD_WIDTH }, (_, k) => ({ u: tile.u, v: k }));
    // 「直列」＝同一排的前后两格：枪从前排刺穿到后排
    case RANGE.COLUMN:
      return depthsOf(side).map((u) => ({ u, v }));
    case RANGE.SINGLE:
    default:
      return [{ u: tile.u, v }];
  }
}

/**
 * 指着这一格能不能确认。
 *
 * @param {{u:number,v:number}} tile
 * @param {string} camp `作用对象`
 * @param {string} reach `前后排判定`
 * @param {{side:string,u:number,v:number}} [actor]
 * @param {{u:number,v:number}[]} [alive] 目标那一方还活着的人占的格 ——
 *   **不给就按固定前排算**，前排死光之后会够不着后排
 * @param {string} [range] `作用范围`。横排（风铃声等「前排一横排」）扫的是整行，
 *   前排任何一格有人就只能打前排 —— 用户2026-09-27指出不能按正前方空缺放行后排
 */
export function canTarget(tile, camp, reach, actor = null, alive = null, range = null) {
  const ok = selectableTiles(camp, actor)
    .some((t) => t.u === tile?.u && t.v === tile?.v);
  if (!ok) return false;
  if (reach !== REACH.FRONT) return true;
  const side = sideOfTile(tile.u);
  if (!side) return false;
  const front = frontDepth(side);
  if (tile.u === front) return true;
  if (!Array.isArray(alive)) return false;
  if (range === RANGE.ROW) return !alive.some(t => t.u === front);
  // 单体/直列只由目标正前方的活人遮挡；别的直列仍有人，不能挡住这个空位。
  return !alive.some(t => t.u === front && t.v === tile.v);
}

/**
 * 武器的 `武器攻击范围` → `{range, reach}`。
 *
 * 枚举来自 `Ail2.ENC +52`（`tools/export_gamedata.py` 的 `AIL2_RULES`）：
 * `前排单体 / 任意单体 / 一直列 / 前排一横排 / 全体`。
 * ⚠️ **只有物品类别是「武器」时才有意义**（exe 规格原话）。
 */
export function weaponReach(text) {
  switch (text) {
    case '任意单体': return { range: RANGE.SINGLE, reach: REACH.ANY };
    case '一直列': return { range: RANGE.COLUMN, reach: REACH.FRONT };
    case '前排一横排': return { range: RANGE.ROW, reach: REACH.FRONT };
    case '全体': return { range: RANGE.ALL, reach: REACH.ANY };
    case '前排单体':
    default: return { range: RANGE.SINGLE, reach: REACH.FRONT };
  }
}

/** 两格是不是同一格。列表比对用。 */
export const sameTile = (a, b) => a?.u === b?.u && a?.v === b?.v;
