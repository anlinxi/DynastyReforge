/**
 * 阵形页的几何与站位 —— **格心是量出来的，不是调出来的**。
 *
 * ## 八格在哪
 *
 * 阵形页的格盘是 `MEN7001` 的**帧 1**（342×182）；帧 0 是 153×181 的
 * 「諸能/攻擊/護禦/命中/閃避」说明框。`menus.json` 里两条并排写着：
 *
 * ```
 * MEN7001 frame 0 → (160,145)   ← 说明框
 * MEN7001 frame 1 → (290,280)   ← 格盘
 * ```
 *
 * ⚠️ 我一度把这两条读反了（按「帧 0 是格盘」取了 (160,145)），
 * 结果队员小人画到了说明框上、格盘上空空如也。**帧号与尺寸要一起核**：
 * `sprite.json` 的帧表写着 `[(153,181), (342,182)]`。
 *
 * 板面为 2 行 × 4 列。按 MEN7001 顶面网格取角，不含底座厚度：
 * 左 (0,113)、上 (228,0)、右 (341,55)、下 (113,168)。
 * 列步长 (57,-28.25)，行步长 (56.5,27.5)。旧算法误用底座左角 y=123，
 * 导致格心越靠左下越偏。人物、光标和鼠标命中共用这里的顶面坐标。
 * MEN7002/7004 的原图为 82×41，显示时铺满一格的 114×56 顶面。
 *
 * ## 位置 0~7 怎么对到格 —— **判据是原作截图，不是推理**
 *
 * ```
 * row = ⌊位置/4⌋          col = 3 − 位置%4
 * ```
 *
 * `row` 0 是板的**右上**那一行（我方前排，靠敌人），`col` 0 在板的最左。
 *
 * **判据**：用户给的原作阵形页截图 —— `Save009` 里霍雍的阵型格号是 **0**，
 * 原作把他画在板的**右上端**，也就是 `(row 0, col 3)`。
 *
 * ### ⚠️ 这里翻过两次，第二次是我把对的改坏了
 *
 * 最早写的就是上面这个式子，**它是对的**。后来发现「菜单里站左下、
 * 打起来站右上」两边不一致，我**把菜单转了 180° 去迁就战斗** ——
 * 而错的是战斗那边（`battlefield.slotToTile` 只镜像了「排」、没镜像「列」，
 * 因为列方向的判据全部取自敌方的遇敌组数据）。
 *
 * **教训：两处不一致时，先找哪一处有原作判据，不要挑好改的那处动。**
 * 现在两边都按原作截图定，`formation.test.js` 那条「比八个点的相对方位」
 * 的回归继续钉着它们一致。
 */

/**
 * 格盘图在屏幕上的落位 —— `menus.json` 阵形页的 `MEN7001` **帧 1**
 * 落在 (290,280)，帧自身的偏移是 (−1,2)。
 */
export const BOARD_AT = Object.freeze({ x: 290 - 1, y: 280 + 2 });

/** 板的左角与两个方向的步长（板内坐标）。 */
const CORNER = Object.freeze({ x: 0, y: 113 });
const COL_STEP = Object.freeze({ x: 57.0, y: -28.25 });
const ROW_STEP = Object.freeze({ x: 56.5, y: 27.5 });

export const TILE_SIZE = Object.freeze({ width: 114, height: 56 });

export const ROWS = 2;
export const COLS = 4;

/**
 * 一格的屏幕格心。
 * `row` 0 = **我方前排**（板的右上那一行，靠敌人）、1 = 后排；`col` 0 在板的最左。
 */
export function tileCenter(row, col) {
  return {
    x: Math.round(BOARD_AT.x + CORNER.x + (col + 0.5) * COL_STEP.x + (row + 0.5) * ROW_STEP.x),
    y: Math.round(BOARD_AT.y + CORNER.y + (col + 0.5) * COL_STEP.y + (row + 0.5) * ROW_STEP.y),
  };
}

/**
 * `位置 0~7` → 格。**与 `battlefield.slotToTile` 摆出来的方位一致**，
 * 换算见模块头的对照表。
 */
export function slotToCell(slot) {
  const s = Number(slot);
  if (!Number.isInteger(s) || s < 0 || s > 7) {
    throw new RangeError(`阵形位置只能是 0~7，收到 ${slot}`);
  }
  return { row: Math.floor(s / COLS), col: COLS - 1 - (s % COLS) };
}

/** 格 → `位置 0~7`。`slotToCell` 的逆。 */
export function cellToSlot(row, col) {
  return row * COLS + (COLS - 1 - col);
}

/** 某个位置的屏幕格心。 */
export function slotCenter(slot) {
  const { row, col } = slotToCell(slot);
  return tileCenter(row, col);
}

/**
 * 没有存档站位时的**补位顺序**：前排从右往左，排满了再退到后排。
 *
 * ⚠️ 这是我们定的缺省值，不是原作数据 —— 原作里站位是玩家自己摆的，
 * 存在存档的**队伍区**（`@56648`，2026-09-11 解出，见 `tools/tsf_parse.py`）。
 * 正常读档一律用存档里的那份，这张表只在「存档没给」时兜底。
 *
 * ⚠️ **必须够 5 个人用。** 上一版只有 4 项 `[7,6,5,4]`，第 5 个人落到
 * `DEFAULT_SLOTS[4] ?? i` 的 `i`＝4，**正好与第 4 个人撞在同一格** ——
 * 表现就是阵形页上两个人叠在一起。
 */
export const DEFAULT_SLOTS = Object.freeze([7, 6, 5, 4, 3]);

/** 八格全集，用来找空位。 */
const ALL_SLOTS = Object.freeze([7, 6, 5, 4, 3, 2, 1, 0]);

const validSlot = (v) => Number.isInteger(v) && v >= 0 && v <= 7;

/**
 * 队伍当前的站位表：`成员下标 → 位置 0~7`。
 *
 * **保证互不相同** —— 一格只站一个人，这是原作数据里 22/22 无例外的
 * 硬约束（见 `tools/tsf_parse.py` 的 `PARTY_SLOTS_OFF`）。存档给的值先用，
 * 越界、重复、缺失的那几个按 {@link DEFAULT_SLOTS} 补第一个空格。
 */
export function slotsOf(party) {
  const n = party?.members?.length ?? 0;
  const saved = party?.站位;
  const out = new Array(n).fill(null);
  const taken = new Set();
  for (let i = 0; i < n; i += 1) {
    const v = Number(saved?.[i]);
    if (!validSlot(v) || taken.has(v)) continue;
    out[i] = v;
    taken.add(v);
  }
  for (let i = 0; i < n; i += 1) {
    if (out[i] !== null) continue;
    // 先按下标要自己那一格；被占了才去找第一个空格。
    const want = DEFAULT_SLOTS[i];
    const free = validSlot(want) && !taken.has(want)
      ? want
      : ALL_SLOTS.find((v) => !taken.has(v));
    // 队伍不可能超过 8 人（八格），所以一定找得到；找不到就是数据坏了。
    out[i] = free ?? i;
    taken.add(out[i]);
  }
  return out;
}

/**
 * 把某个成员挪到某一格。**格上已经有人就两人对调** —— 原作阵形页就是
 * 点两下换位置，不会把人叠在一格上。
 *
 * @returns 新的站位数组（不改原来那份）
 */
export function moveTo(slots, index, slot) {
  if (index < 0 || index >= slots.length) return slots;
  const taken = slots.indexOf(slot);
  const next = [...slots];
  if (taken >= 0) next[taken] = next[index];
  next[index] = slot;
  return next;
}

/** 这一格上站着谁（成员下标）；没人返回 −1。 */
export function whoAt(slots, slot) {
  return slots.indexOf(slot);
}
