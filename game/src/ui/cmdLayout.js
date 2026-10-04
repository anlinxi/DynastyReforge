/**
 * 战斗主菜单（攻擊 / 法寶 / 絕學 / 諸態 / 防禦 / 退卻）的布局与选择逻辑。
 *
 * ## 素材（都在 `fight/ItfDir.DAT`，产物在 `public/assets/<代号>/`）
 *
 * | 代号 | 是什么 | 尺寸 | 帧 |
 * |---|---|---|---|
 * | `ITF0025` | **整块竹简** —— ⚠️ **六个指令的字已经印在板上了**，不用另画 | 107×226 | 1 |
 * | `ITF0026` | **选中光标** —— 停在当前那一行左右两侧的一对花纹爪 | 81×28 | 6（自己的闪动动画） |
 *
 * ⚠️ 上一版把 `ITF0026` 当成「六个指令的字」（因为它正好 6 帧），**是错的**。
 * 渲染出来一看就知道：板上有字，`ITF0026` 是一对爪子。
 * 判据表 E 组：认素材要渲染出来看，别按「尺寸×帧数」推。
 *
 * ## 六行字的 y —— **从素材像素量的**
 *
 * 把 `ITF0025` 的底图按行扫「明显比底色暗的像素」，得到六段连续的暗行：
 *
 * ```
 * y= 29..46  59..75  90..107  121..138  151..168  181..197
 * 中心  37     67      98       129       159       189      步进 30.4
 * ```
 *
 * 六段、等距、高度都是 17~18 —— 正是六行字。**不是调出来的。**
 *
 * ⭐ **exe 独立佐证**：主菜单的构造函数里 `movl $0x7d, %esi`（125）之后
 * 循环六次、每次 `addl $0x1f`（31），建六个 90×30 的格 —— 即屏幕 y=125 起、
 * 步进 31。板 y=100，换成板内就是 25 起、格心 40/71/102/…，与上面量自像素的
 * 37/67/98/… 只差 3px（一个是格、一个是墨迹带）。两条独立来源互证。
 */

/** 六个指令，顺序＝板上从上到下印的顺序。 */
export const COMMANDS = Object.freeze([
  Object.freeze({ id: 'attack', label: '攻擊' }),
  Object.freeze({ id: 'item', label: '法寶' }),
  Object.freeze({ id: 'skill', label: '絕學' }),
  Object.freeze({ id: 'status', label: '諸態' }),
  Object.freeze({ id: 'guard', label: '防禦' }),
  Object.freeze({ id: 'flee', label: '退卻' }),
]);

/** 每一行字的中心 y（相对竹简左上角）。量自 `ITF0025` 的像素，见模块头。 */
export const ROW_CENTER_Y = Object.freeze([37, 67, 98, 129, 159, 189]);

/**
 * 竹简板。
 *
 * * `offscreenX` **是 exe 给的真值 (700, 100)** —— 700 在 640 宽的画面外，
 *   说明它是**从右侧滑进来**的，这个数是滑入前的起点。
 * * 🟡 `x`（停住的位置）**是量的**：用户的原作截图里板子右缘贴着画面右边，
 *   `640 − 107 = 533`。exe 里取不到（多半是算出来的，不是立即数）。
 * * `y = 100` 用 exe 的原值，滑入只动 x。
 */
export const BOARD = Object.freeze({
  key: 'ITF0025',
  width: 107,
  height: 226,
  x: 533,
  y: 100,
  offscreenX: 700,
});

/** 光标。x 由板宽与光标宽居中算出，不写死。 */
export const CURSOR = Object.freeze({
  key: 'ITF0026',
  width: 81,
  height: 28,
  frames: 6,
  /** 一帧停多久（毫秒）。🟡 原作的帧时长没解，先用场景动画那套的 110ms。 */
  frameMs: 110,
});

/** 光标画在第 `i` 项时的位置（相对竹简左上角）。 */
export function cursorAt(i) {
  const row = ROW_CENTER_Y[Math.max(0, Math.min(ROW_CENTER_Y.length - 1, i))];
  return {
    x: Math.round((BOARD.width - CURSOR.width) / 2),
    y: row - Math.round(CURSOR.height / 2),
  };
}

/**
 * 上下移动选择。
 *
 * 🟡 **循环（到底再往下回到第一项）是我们定的** —— 原作是不是循环没验。
 * 菜单那边的八页是循环的，这里先照同一套。
 */
export function moveSelection(index, step, count = COMMANDS.length) {
  if (count <= 0) return 0;
  return ((index + step) % count + count) % count;
}

/** 这一块要预载哪些素材包。 */
export function cmdPackKeys() {
  return [BOARD.key, CURSOR.key];
}
