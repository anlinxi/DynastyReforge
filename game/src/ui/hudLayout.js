/**
 * 战斗顶部「队员状态条」的布局与帧换算 —— **坐标全是原作真值**。
 *
 * ## 这些数从哪来
 *
 * 原作 exe 里界面元素是明文构造的，x/y 就是压栈的立即数：
 *
 * ```
 * push $0x42       ; y = 66
 * push $0x3        ; x = 3
 * push $0x46cb8c   ; "Fight\ITF\ITF0008.SF2" 的地址
 * call 0x4310e0    ; 建元素
 * ```
 *
 * 用 `tools/extract_layout.py` 取出来（**注意默认正则只认单层目录**，
 * 战斗界面是 `Fight\ITF\…` 两层，要换 `--pattern`；而且要用 300块版的
 * `exe/大众难度.exe`，游戏本体 `RPG.exe` 扫不出来）。命令写在
 * `docs/专题/战斗.md` §4.1。
 *
 * ## 素材各是什么（都在 `fight/ItfDir.DAT`，产物在 `public/assets/<代号>/`）
 *
 * | 代号 | 是什么 | 尺寸 | 帧 |
 * |---|---|---|---|
 * | `ITF0003` | **底板** —— 板上印着「位階＼」与三条空槽，条之间的「＼」也在板上 | 116×73 | 2 |
 * | `ITF0002` | 头像，八个队友各一帧 | 49×56 | 8 |
 * | `ITF0011` | 大号阿拉伯数字，**帧号＝数字**（帧 12 是 `?`） | 11×14 | 13 |
 * | `ITF0012` | 小号阿拉伯数字，同上 | 6×10 | 13 |
 * | `ITF0004`/`ITF0006` | 命条的**黄**与**红**，画在同一位置 | 68×3 | 69 |
 * | `ITF0005`/`ITF0007` | 气条（蓝） | 69×3 | 69 |
 * | `ITF0008`/`ITF0009`/`ITF0010` | **行动条的绿/蓝/紫**，三件画在同一位置 | 110×3 | 110 |
 *
 * ## ⭐ 「一条三色」不是三条
 *
 * 用户 2026-09-13 指出：绿、蓝、粉**共用头像下面那一条**。数据两头都印证：
 *
 * * `ITF0008`/`ITF0009`/`ITF0010` **构造在同一个 (3,66)**、宽度都是 110；
 * * 三件的主色分别是 **绿(148,255,123)** / **蓝(198,206,255)** / **粉紫(255,231,255)**，
 *   正对「等待 → 蓄劲 → 回气」三个阶段；
 * * 几何自洽：`3 + 110 = 113` 横跨 116 宽的板，而命/气条只有 68/69 宽、
 *   起点 x=41，是为了让开左边 49 宽的头像。
 *
 * ⚠️ **两类条的帧序是反的**（见 {@link barFrame} / {@link gaugeFrame}）。
 */

/** 底板尺寸。框内所有坐标都相对它的左上角。 */
export const BOX_SIZE = Object.freeze({ width: 116, height: 73 });

/**
 * 框内各元素的位置 —— **exe 簇 9 的原文**，不要手调。
 *
 * `bar`/`low` 两个键指向**同一位置的两张图**：命条满时是黄的（`ITF0004`），
 * 低到某个阈值换成红的（`ITF0006`）。⚠️ **阈值原作没给**，见 `LOW_HP_RATIO`。
 */
export const SLOTS = Object.freeze({
  board: { key: 'ITF0003', x: 0, y: 0 },
  portrait: { key: 'ITF0002', x: 0, y: 0 },
  rank: { key: 'ITF0011', x: 87, y: 2, advance: 11 },
  hp: {
    bar: 'ITF0004', low: 'ITF0006', x: 41, y: 18, width: 68,
    glyph: 'ITF0012', advance: 6,
    cur: { x: 55, y: 26 }, max: { x: 87, y: 26 },
  },
  mp: {
    bar: 'ITF0005', low: 'ITF0007', x: 41, y: 43, width: 69,
    glyph: 'ITF0012', advance: 6,
    cur: { x: 55, y: 52 }, max: { x: 87, y: 52 },
  },
  gauge: {
    x: 3, y: 66, width: 110,
    wait: 'ITF0008', charge: 'ITF0009', recover: 'ITF0010',
  },
});

/** 行动条三个阶段的键名。顺序＝原作的推进顺序。 */
export const GAUGE_PHASES = Object.freeze(['wait', 'charge', 'recover']);

/**
 * 🟡 **命条转红的阈值** —— 原作没给数，`docs/状态/复现度台账.md` 有登记。
 * 素材摆在那儿（`ITF0006` 与 `ITF0004` 同坐标），但「几成血变红」查不到。
 */
export const LOW_HP_RATIO = 0.25;

/**
 * 🟡 **五个框在屏幕上的位置** —— 这是本模块**唯一不是 exe 真值**的一组数。
 *
 * exe 取不到：五个框是**循环画**的，容器坐标在寄存器里而不是立即数
 * （判据表 E 组专门记过这个坑）。所以只能从用户提供的原作截图量：
 * 截图 1600 宽对 640 的游戏画面，比例 0.4。
 *
 * * 第一个框左上 ≈ (11, 5)
 * * 横向**等距 124~125**
 * * 有**一个框**的 y 比其余低约 9px
 *
 * ⭐ **下沉的那个是「正在选指令的人」**（用户 2026-09-19 口述）。
 * 上一版把它写成 `BOX_Y_OFFSET = [0,0,0,9,0]` —— 因为三张原作截图里下沉的
 * 都是第 4 格，就当成了固定偏移。**三张截图里那一格恰好都是当时在行动的人**。
 * 后果：给冰璃选指令时，下沉的却是慕容璇玑。
 *
 * ⚠️ 这是「拿中位/少数样本论证一个判据」那条的又一次翻车 ——
 * 三张截图的共同点不一定是「位置」，也可能是「状态」。
 */
export const BOX_ORIGIN = Object.freeze({ y: 5 });
export const BOX_STEP_X = 124;
/** 正在选指令的那一格往下沉多少（量自原作截图）。 */
export const BOX_ACTIVE_DROP = 9;

/** 画面宽。框整组居中要用到。 */
const SCREEN_WIDTH = 640;

/**
 * 第 `i` 个队员的框画在哪（屏幕绝对坐标）。
 *
 * ⚠️ **整组居中**，不是从左边固定位置排开（2026-09-16 订正）。
 * 判据是用户提供的**两人队伍**的原作截图：两个框挤在画面中间
 * （左框左缘约在画面 31% 处），而不是贴着左边。五人时整组几乎铺满，
 * 所以此前按左对齐写也看不出错 —— **人少的时候才露馅**。
 *
 * @param {number} i 第几个
 * @param {number} count 一共几个。不给就按满编 5 个算
 */
export function boxOrigin(i, count = 5, active = -1) {
  const n = Math.max(1, count);
  const span = (n - 1) * BOX_STEP_X + BOX_SIZE.width;
  const left = Math.round((SCREEN_WIDTH - span) / 2);
  return {
    x: left + BOX_STEP_X * i,
    y: BOX_ORIGIN.y + (i === active ? BOX_ACTIVE_DROP : 0),
  };
}

const clamp01 = (v) => Math.min(1, Math.max(0, Number.isFinite(v) ? v : 0));

/**
 * **命/气条**的帧号。⚠️ **第 0 帧最满，末帧最空。**
 *
 * 判据：把 69 帧逐帧数不透明像素，`ITF0004` 的**第 0 帧**有 204 个像素、
 * 主色是黄 (255,239,0)，越往后越少。
 * 写反的后果是「满血画成空管」—— 而两端都像「没画对」，很难一眼看出方向反了
 * （菜单那边的 `fillBar.js` 已经在同一个坑上栽过一次）。
 *
 * @param {number} ratio 0~1，1 = 满
 * @param {number} frames 该素材的总帧数
 */
export function barFrame(ratio, frames) {
  const last = Math.max(0, frames - 1);
  return Math.round((1 - clamp01(ratio)) * last);
}

/**
 * **行动条**的帧号。⚠️ **与命/气条相反：第 0 帧最空，末帧最满。**
 *
 * 判据：`ITF0008` 的**第 109 帧**（共 110 帧）不透明像素最多。
 * 方向相反是合理的 —— 命/气是「还剩多少」，行动条是「充了多少」。
 */
export function gaugeFrame(ratio, frames) {
  const last = Math.max(0, frames - 1);
  return Math.round(clamp01(ratio) * last);
}

/**
 * **回气那一段要从释放点往左画，右边留空。**
 *
 * 三色条是**一根**：绿（等待，左锚，左→右）→ 蓝（蓄劲，右锚，右→左）→
 * 紫（回气，右锚，右→左）。蓝紫共用一根，释放点 = 蓄劲÷(蓄劲+回气)。
 *
 * 蓝条从最右扫到释放点，绝学出手；接着紫条**从释放点继续往左**。
 * 可素材是右锚的 —— 第 N 帧画的是**最右边 N 个像素**，直接按 `progress`
 * 画紫条，就会把蓝条刚扫过的那一段也涂成紫的。用户 2026-09-19：
 * 「右侧蓝色条走过的部分会变成紫色，这是不对的，右边走过的部分就留空。」
 *
 * 所以画紫条时要把**最右边 `release × 宽` 个像素裁掉**。
 * 返回要保留的宽度（相对这一帧的墨迹宽 = 帧号+1）；≤0 表示什么都不画。
 *
 * @param {number} frame 这一帧的帧号
 * @param {number} release 释放点（0~1）
 * @param {number} width 条的总宽（`SLOTS.gauge.width`，110）
 */
export function recoverKeepWidth(frame, release, width) {
  const ink = Math.max(0, frame) + 1;
  const blank = Math.round(clamp01(release) * width);
  return ink - blank;
}

/**
 * 一个数拆成字形帧号。**这两张表的帧号就是数字本身**（`ITF0011`/`ITF0012`
 * 的帧 0~9 就是阿拉伯数字 0~9），比菜单那套要查 `glyphLayout` 简单得多。
 *
 * @param {number} value 非负整数
 * @returns {number[]} 每一位的帧号，高位在前；非法输入返回空数组
 */
export function digitFrames(value) {
  if (!Number.isFinite(value)) return [];
  return [...String(Math.abs(Math.trunc(value)))].map(Number);
}

/** 命条这一刻该用黄的还是红的。 */
export function hpBarKey(ratio) {
  return clamp01(ratio) <= LOW_HP_RATIO ? SLOTS.hp.low : SLOTS.hp.bar;
}

/** 这一块要预载哪些素材包 —— 拿上面的表反查，**不要另写清单**。 */
export function hudPackKeys() {
  const keys = new Set([
    SLOTS.board.key, SLOTS.portrait.key, SLOTS.rank.key,
    SLOTS.hp.bar, SLOTS.hp.low, SLOTS.hp.glyph,
    SLOTS.mp.bar, SLOTS.mp.low, SLOTS.mp.glyph,
    ...GAUGE_PHASES.map((p) => SLOTS.gauge[p]),
  ]);
  return [...keys].sort();
}
