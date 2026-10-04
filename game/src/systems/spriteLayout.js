/**
 * 场景精灵的分段规则。
 *
 * 一条 SF2 里装的是多个动作段，段内再按朝向分组。SF2 头部没有分段表，
 * 得从帧数反推——好在规律非常整齐，对所有场景精灵都成立：
 *
 *     帧 0              只有影子（原作用它做投影）
 *     帧 1 .. D         站立，每个朝向 1 帧
 *     帧 1+D .. 1+D+4D  行走，每个朝向 4 帧
 *     之后              待机动作（伸懒腰一类），帧时长更慢
 *
 * 于是总帧数 = 1 + D + 4D = 1 + 5D：
 *
 *     D=8  ->  41 帧   冰璃 BINGLI、士兵 NP104
 *     D=4  ->  21 帧   配角 NP103
 *     夏侯仪 XIAHOUYI 124 帧 = 41（站立+行走）+ 32（另一套动作）+ 待机段
 *
 * **朝向按顺时针排列，方向与屏幕方向序号相反**：
 *
 *     8 向：下 右下 右 右上 上 左上 左 左下
 *     4 向：下 右 上 左
 *
 * 把帧 1..8 并排渲染，正好是一圈干净的旋转（正面 → 侧脸 → 背面 →
 * 另一侧脸 → 回到正面），行走段各朝向的首帧同样如此。旋转的**方向**
 * 则是实机确认的：先前按逆时针取帧，上下正好落在对称轴上没露馅，
 * 左右整个反了——向右走时人物朝左看。
 *
 * > ⚠️ 曾经误以为「每朝向 5 帧」，于是取帧时跨过了朝向边界，
 * > 走路时人物自己转圈、向右走却朝左看。当时还编了一张置换表去凑，
 * > 越凑越错。**分组大小不对时，任何置换表都救不回来。**
 */

/** 帧 0 是影子，站立段从这里开始。 */
const STAND_START = 1;
/** 行走每个朝向占的帧数。 */
const WALK_FRAMES = 4;
/**
 * 跑步每个朝向占的帧数，与行走相同。
 *
 * 夏侯仪 124 帧里，紧跟行走段之后的帧 41–72 又是一组 8 朝向 × 4 帧、
 * 帧时长同为 2 的快动作。逐帧看过：身体前倾、步幅加大、手臂甩开，是跑步。
 * 只有主角这类精灵有这一段，NPC 的 41/21 帧精灵到行走就结束了。
 */
const RUN_FRAMES = 4;
/** 站立 + 行走一共占 1 + 5D 帧。 */
const FRAMES_PER_DIRECTION = 1 + WALK_FRAMES;
/** 待机动作的帧时长门槛：慢于此值的不属于站立/行走段。 */
const MOVE_FRAME_DURATION = 2;

/**
 * 这条精灵的「移动帧」时长阈值。**默认 2；只有在 2 完全扫不出帧时才放宽。**
 *
 * ## 为什么要放宽
 *
 * `HUOYONG`（霍雍，88 帧）的站立/行走/跑步帧 **`dur` 全是 4**，不是 2。
 * 按固定阈值 2 扫，第一帧就停了 → `usable = 0` → `directions = 0` →
 * `standFrame` 退回帧 0，而**帧 0 是影子** —— 画面上霍雍只剩地上一摊黑圈。
 * 阈值 2 是当初照夏侯仪（`dur=2`）定的，没有普适性。
 *
 * ## 为什么不能直接改成「帧 1 自己的 dur」
 *
 * **会把 234 条原地动作 NPC 一起"修"坏。** 他们整条精灵就是一个动作的循环
 * （喝酒、扇扇子），现在靠 `ambientLoop` 整条播；一旦解出了 `directions`
 * 与跑步段，`ambientLoop` 就返回 null，他们会**当场僵住**。
 *
 * ## 判据：块长必须正好是 `D×(1+4+4)` 或 `D×(1+4)`
 *
 * 真正的行走图，站立+行走(+跑步)是一整块等时长的帧，块外紧跟一个明显更长的
 * 停顿帧。拿这条门槛扫全库 1882 条精灵，**只有 2 条被放进来**：
 *
 * | 精灵 | 帧数 | 帧 dur | 块长 | 判为 |
 * |---|---|---|---|---|
 * | `HUOYONG` | 88 | 4 | **72 = 8×9** | 八向 + 跑步段（块后那帧 dur=80） |
 * | `NE0609A-08` | 65 | 3 | **36 = 4×9** | 四向 + 跑步段（块后那帧 dur=6） |
 *
 * 其余 232 条的块长都不是这两个形状，原样走老路。
 */
function moveDurOf(frames) {
  const blockLen = (limit) => {
    let i = STAND_START;
    while (i < frames.length && (frames[i]?.dur ?? 99) <= limit) i += 1;
    return i - STAND_START;
  };
  if (blockLen(MOVE_FRAME_DURATION) > 0) return MOVE_FRAME_DURATION;
  const cadence = frames[STAND_START]?.dur;
  if (!Number.isFinite(cadence)) return MOVE_FRAME_DURATION;
  const n = blockLen(cadence);
  const fits = [SCREEN_DIRECTIONS, 4].some(
    (d) => n === d * (1 + WALK_FRAMES + RUN_FRAMES) || n === d * FRAMES_PER_DIRECTION,
  );
  return fits ? cadence : MOVE_FRAME_DURATION;
}

/**
 * 帧 0 比其余帧矮到这个比例以下，就认定它是投影帧。
 * 行走图的第一帧是贴在地上的影子（64x48，其余 64x96）；而店里那些原地
 * 做动作的 NPC（0202N002 等）整条等高，压根没有影子帧。
 */
const SHADOW_HEIGHT_RATIO = 0.75;

/** 屏幕八方向：0=下 1=左下 2=左 3=左上 4=上 5=右上 6=右 7=右下 */
const SCREEN_DIRECTIONS = 8;
/** 只有四个朝向的配角：下 / 右 / 上 / 左。 */
const FOUR_WAY = Object.freeze([0, 3, 3, 3, 2, 1, 1, 1]);

/**
 * 开头有没有投影帧，有则返回 1。
 *
 * **帧 0 是一张单独的影子**（`XIAHOUYI` 是 37×15、`oy=253`，而人物层 `oy≈175`）——
 * 它不属于任何动作段，原作是把它**常驻画在脚下**，再在上面画当前帧的人。
 * 见 `FieldSprite` 的 `shadow`。
 */
export function shadowFrames(frames) {
  if (frames.length < 2) return 0;
  const tallest = Math.max(...frames.map((f) => f.h ?? 0));
  return (frames[0]?.h ?? 0) < tallest * SHADOW_HEIGHT_RATIO ? 1 : 0;
}

/**
 * 是不是**帧数正好等于 影子 + 5D** 的纯行走图。
 *
 * 主角那种「行走图 + 跑步段 + 待机段」的精灵帧数不合这个公式，
 * 这里会返回 false——判「有没有原地动作循环」时要连 `walkLayout` 的
 * 跑步段一起看，见 `ambientLoop`。
 */
export function isWalkSheet(sprite) {
  const frames = sprite?.frames ?? [];
  const head = shadowFrames(frames);
  return [SCREEN_DIRECTIONS, 4]
    .some((d) => frames.length === head + FRAMES_PER_DIRECTION * d);
}

/**
 * 原地动作循环的帧区间；这条精灵是行走图时返回 null。
 *
 * 客栈药铺里的 NPC 不是行走图：他们的帧数（62/50/32/27…）根本不合
 * 「影子 + 5D」的公式，`dur` 也全是 2 没有分段。这些人本来就只在原地
 * 做一件事——喝酒、扇扇子、擦桌子——**整条精灵就是那一个动作的循环**。
 *
 * 兰州城街上的 NP103/NP104 则是正经的四向 / 八向行走图，帧数正好合公式，
 * 站着不动才对；整条循环播会让他们原地转圈（这个坑 FieldSprite 的注释
 * 里记过）。所以判据是帧数合不合公式，不是帧时长。
 */
/**
 * SCI 的 `frames` 到底指哪几帧。
 *
 * ## 判据：第二个数在「起 > 止」时是**帧数**，不是「止」
 *
 * 3945 个有精灵的对象里，绝大多数 `frames[0]` 是 1 —— 那时「起,止」与
 * 「起,帧数」**完全等价**，区分不了。能区分的是 `frames[0] > 1` 的那 102 个：
 *
 * | 对象 | `frames` | 精灵帧数 | 按「止」 | 按「帧数」 |
 * |---|---|---|---|---|
 * | `MP1607 insects` | `[2,128]` | 129 | 末帧 128 ✓ | 末帧 **129 越界** |
 *
 * 所以 **`起 ≤ 止` 时是区间**。而 72 个 `起 > 止` 按「起,帧数」解释
 * **一个都不越界**，并且一举解释了原先所有的特例：
 *
 * | 对象 | `frames` | 按「起,帧数」 | 画面上 |
 * |---|---|---|---|
 * | `MP0303 gate` | `[2,1]` | 帧 2，**一帧** | 门定格在「关着」✓ |
 * | `MP0904 doorx` | `[3,1]` | 帧 3，**一帧** | 开锁后的门定格 ✓（不会闪） |
 * | `MP0303 gearanm` | `[3,2]` | 帧 **3~4** | 静止的齿轮 → 转一格，循环＝**微弱地来回转**，而帧 3 带一段 1.235 秒的「嘎吱」 |
 *
 * 用户原话：「它嘎吱嘎吱嘎吱来回转但是转不动」。
 *
 * ⚠️ 这条**取代**了上一版的「两端同图才循环」——那是在错的解释上打补丁：
 * 先把 `[3,2]` 读成「区间 2~3」（两帧同一张图 → 画面纹丝不动），
 * 再用「同图」去解释它为什么不动。**两帧同图本身就是读错区间的结果。**
 *
 * ⚠️ **起>止里帧数为 1 的有 55 个（门、开关、等 `play_anim` 推的演出对象），
 * 帧数>1 的只有 17 个**，而那 17 个里 16 个 `showWithMap=0` ——
 * 全是剧情 `actor_show` 才叫出来的演出精灵，平时不在场上。
 *
 * @returns {{start:number,count:number}|null} 该播的帧区间；给不出就 null
 */
export function frameSpan(frames) {
  const [from, to] = (frames ?? []).map(Number);
  if (!Number.isFinite(from) || !Number.isFinite(to) || from < 0) return null;
  // 起 ≤ 止：老老实实是区间
  if (to >= from) return { start: from, count: to - from + 1 };
  // 起 > 止：第二个数是**帧数**
  return to > 0 ? { start: from, count: to } : null;
}

export function ambientLoop(sprite) {
  const frames = sprite?.frames ?? [];
  if (frames.length < 2 || isWalkSheet(sprite)) return null;
  // 主角这类精灵帧数不合公式，但它有正经的跑步段，是行走图的扩展版，
  // 整条循环播会把站立、行走、跑步、伸懒腰连成一串乱演
  if (walkLayout(sprite).runStart !== null) return null;
  const head = shadowFrames(frames);
  return { start: head, count: frames.length - head };
}

/**
 * 一条精灵的行走布局。
 * @param {{frames: Array<{dur: number}>}} sprite export_sprite.py 的产物
 */
export function walkLayout(sprite) {
  const frames = sprite?.frames ?? [];

  // 帧数正好是 1+5D 时直接认朝向数。**不能只靠帧时长去找段边界**——
  // NP103 整条精灵的 dur 全是 4，按时长扫会算出 0 个朝向，于是退回帧 0，
  // 那是影子帧：地图上三个士兵都成了孤零零的一摊黑影。
  const exact = [SCREEN_DIRECTIONS, 4]
    .find((d) => frames.length === STAND_START + FRAMES_PER_DIRECTION * d);
  if (exact) {
    // 帧数正好等于 1+5D 的精灵（NPC）没有多余的段，也就没有跑步
    return {
      directions: exact, standStart: STAND_START,
      walkStart: STAND_START + exact, runStart: null,
    };
  }

  // ⚠️ **还有一种更短的：影子 + D 个站立帧，压根没有行走段。**
  // `KAGI`（河州镇「不哭了」）、`CUDY`、`11` 三条都是 5 帧 = 影子 + 4 朝向，
  // SCI 也确实记 `dirs=4`。落到下面的「按帧时长找段尾」上会算出
  // `usable=4 < 5`，于是 `directions=0`、`standFrame` 退回帧 0 ——
  // **帧 0 是影子**，画面上就只剩地上一摊黑圈，人却还能对话。
  //
  // 判据只用精灵自己的数据：帧 0 是影子帧，且余下帧数正好等于某个朝向数。
  // 不会误伤「4 帧原地动作 + 影子」那类：`ambientLoop` 判的是
  // `isWalkSheet`（仍为假）与 `runStart`（这里给 null），行为不变。
  const head = shadowFrames(frames);
  const standOnly = head === STAND_START
    && [SCREEN_DIRECTIONS, 4].find((d) => frames.length === STAND_START + d);
  if (standOnly) {
    return {
      directions: standOnly, standStart: STAND_START,
      walkStart: null, runStart: null,
    };
  }

  // 帧数不合公式（夏侯仪 124 帧还带另一套动作），才按帧时长找站立/行走段的末尾
  const limit = moveDurOf(frames);
  let last = STAND_START;
  while (last < frames.length && (frames[last]?.dur ?? 99) <= limit) {
    last += 1;
  }
  const usable = Math.max(0, last - STAND_START);
  const directions = usable >= FRAMES_PER_DIRECTION * SCREEN_DIRECTIONS
    ? SCREEN_DIRECTIONS
    : Math.min(4, Math.floor(usable / FRAMES_PER_DIRECTION));
  const walkStart = STAND_START + directions;
  // 站立 + 行走 + 跑步一共要 D×(1+4+4) 帧，凑不齐就是没有跑步段
  const hasRun = directions > 0
    && usable >= directions * (1 + WALK_FRAMES + RUN_FRAMES);
  return {
    directions,
    standStart: STAND_START,
    walkStart,
    runStart: hasRun ? walkStart + WALK_FRAMES * directions : null,
  };
}

/**
 * **原作朝向编号 → 本项目的「屏幕方向序号」。**
 *
 * 两套编号都从「下」起步，但**转的方向相反**：
 *
 * | | 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 |
 * |---|---|---|---|---|---|---|---|---|
 * | 原作（SCI 的 `facing`、事件指令的朝向） | 南 | 东南 | 东 | 东北 | 北 | 西北 | 西 | 西南 |
 * | 本项目（`directionFromVector` 的输出） | 下 | 左下 | 左 | 左上 | 上 | 右上 | 右 | 右下 |
 *
 * ⚠️ **不转换就是左右镜像**，而且上下方向恰好落在对称轴上看不出来 ——
 * 表现是「两个士兵拦路，一个面朝里一个面朝外」。
 * 原作的编号其实**直接等于精灵帧的槽位**（帧也是顺时针排的），
 * 而 `slotOf` 会再取反一次，于是错了。
 */
export function screenFacing(original) {
  const d = ((Number(original) || 0) % SCREEN_DIRECTIONS + SCREEN_DIRECTIONS) % SCREEN_DIRECTIONS;
  return (SCREEN_DIRECTIONS - d) % SCREEN_DIRECTIONS;
}

/**
 * 屏幕方向 -> 该精灵的朝向槽位。
 * 精灵按顺时针排、屏幕方向按逆时针数，所以要取反。
 */
function slotOf(direction, directions) {
  const d = ((direction % SCREEN_DIRECTIONS) + SCREEN_DIRECTIONS) % SCREEN_DIRECTIONS;
  if (directions >= SCREEN_DIRECTIONS) return (SCREEN_DIRECTIONS - d) % SCREEN_DIRECTIONS;
  return FOUR_WAY[d] % Math.max(directions, 1);
}

/** 站定时用的单帧。 */
export function standFrame(sprite, direction) {
  const { directions, standStart } = walkLayout(sprite);
  if (!directions) return 0;
  return standStart + slotOf(direction, directions);
}

/** 走动时用的帧区间。 */
export function walkSegment(sprite, direction) {
  const { directions, walkStart } = walkLayout(sprite);
  if (!directions) return { start: 0, count: Math.max(sprite?.frames?.length ?? 1, 1) };
  // 只有站立帧的精灵（影子 + D 帧）没有行走段，走动时就停在站立帧上。
  if (walkStart === null) return { start: standFrame(sprite, direction), count: 1 };
  return {
    start: walkStart + slotOf(direction, directions) * WALK_FRAMES,
    count: WALK_FRAMES,
  };
}

/** 跑动时用的帧区间；这条精灵没有跑步段时返回 null。 */
export function runSegment(sprite, direction) {
  const { directions, runStart } = walkLayout(sprite);
  if (!directions || runStart === null) return null;
  return {
    start: runStart + slotOf(direction, directions) * RUN_FRAMES,
    count: RUN_FRAMES,
  };
}

/**
 * 待机动作段：站立与行走之后、帧时长更慢的那几段。
 * 段与段之间由 dur 很大的单帧（原作的停顿）隔开。
 */
export function idleSegments(sprite) {
  const frames = sprite?.frames ?? [];
  // ⚠️ **阈值要与 `walkLayout` 用同一个**（见 `moveDurOf`）。两边不一致的话，
  // 霍雍那种 dur=4 的精灵会把「行走+跑步」整块当成待机动作，站着不动就开始跑。
  const limit = moveDurOf(frames);
  let i = STAND_START;
  while (i < frames.length && (frames[i]?.dur ?? 99) <= limit) i += 1;
  const out = [];
  while (i < frames.length) {
    if ((frames[i]?.dur ?? 0) <= limit) { i += 1; continue; }
    const begin = i;
    while (i < frames.length && (frames[i]?.dur ?? 0) > MOVE_FRAME_DURATION) i += 1;
    if (i - begin > 1) out.push({ start: begin, count: i - begin });
  }
  return out;
}

/** 由移动向量取屏幕八方向序号。 */
export function directionFromVector(dx, dy) {
  if (!dx && !dy) return null;
  const angle = Math.atan2(dy, dx);           // 右为 0，顺时针为正（屏幕 y 向下）
  const step = ((Math.round(angle / (Math.PI / 4)) % 8) + 8) % 8;
  // atan2 顺序：0=右 1=右下 2=下 3=左下 4=左 5=左上 6=上 7=右上
  return [6, 7, 0, 1, 2, 3, 4, 5][step];
}
