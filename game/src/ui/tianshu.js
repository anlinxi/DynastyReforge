/**
 * 天书（存读档）页的**状态机**。纯函数，不碰 Phaser —— 画在 `MenuScreen`。
 *
 * ## 交互是**从素材解出来的**，不是设计的
 *
 * 归档里躺着三个此前没导出的对话框，把流程写得清清楚楚：
 *
 * | 素材 | 内容 |
 * |---|---|
 * | `MEN8002` 三帧 | **「今況記錄」（存档）/「前歷再續」（读档）/「取消」** |
 * | `MEN8003` 两帧 | 「確定／取消」—— 存档前的覆盖确认 |
 * | `MEN8006` 两帧 | 「確定／取消」—— 读档前的确认（与 8003 同尺寸） |
 * | `MEN8008` | 「讀取中 ...」进度条 |
 *
 * 于是流程是：**选一条记录 → 回车弹三选项 → 选存/读 → 再确认一次**。
 *
 * ## ⚠️ 帧号与屏幕顺序是**反的**
 *
 * 逐帧渲染确认过：
 *
 * ```
 * MEN8002  帧0=「取消」高亮   帧1=「前歷再續」  帧2=「今況記錄」
 * MEN8003  帧0=「取消」高亮   帧1=「確定」
 * ```
 *
 * 而屏幕上是**自上而下** 今況記錄 / 前歷再續 / 取消。也就是说
 * **帧号是自下而上数的**。
 *
 * 所以这里的 `pick` 一律是**屏幕下标**（0 = 最上面那项），画的时候经
 * `frameOf()` 换成帧号。把 `pick` 直接当帧号用会同时得到两个 bug：
 * **↑↓ 反向**，以及**选中「取消」按回车却在存档** —— 两个都出现过。
 */

/** 对话框的四个阶段。`null` 表示没开框，方向键归记录列表。 */
export const STAGE = Object.freeze({
  MENU: 'menu',
  CONFIRM_SAVE: 'confirmSave',
  CONFIRM_LOAD: 'confirmLoad',
  BUSY: 'busy',
});

/** `MEN8002` 的三项，**按屏幕自上而下**。 */
export const MENU_ITEMS = Object.freeze(['save', 'load', 'cancel']);

/** 确认框的两项，**按屏幕自上而下**：確定在上、取消在下。 */
export const CONFIRM_ITEMS = Object.freeze(['ok', 'cancel']);
const CONFIRM_OK = 0;
const CONFIRM_CANCEL = 1;

/**
 * 屏幕下标 → 素材帧号。**帧号自下而上数**，见文件头。
 * @param {number} count 这个框有几项
 * @param {number} pick 屏幕下标（0 = 最上面）
 */
export function frameOf(count, pick) {
  return count - 1 - pick;
}

/** 某个阶段的框有几项。 */
export function itemCount(stage) {
  return stage === STAGE.MENU ? MENU_ITEMS.length : CONFIRM_ITEMS.length;
}

export function createState() {
  return Object.freeze({ cursor: 0, scroll: 0, dialog: null });
}

/** 光标移动。`total` 是槽位总数，`rows` 是一屏几条。**两端不循环** —— 99 条循环会转晕。 */
export function navigate(state, step, total, rows) {
  if (state.dialog) return navigateDialog(state, step);
  const cursor = Math.max(0, Math.min(total - 1, state.cursor + step));
  // 滚动跟着光标走：光标顶到窗口上/下沿才推动窗口。
  const scroll = Math.max(cursor - rows + 1, Math.min(state.scroll, cursor));
  return Object.freeze({ ...state, cursor, scroll: Math.max(0, scroll) });
}

/**
 * **翻一屏**（上下箭头点击走这里）。与 `navigate` 的区别：
 *
 * | | `navigate(±1)` | `pageBy(±rows)` |
 * |---|---|---|
 * | 光标 | 挪一条 | 挪一屏，**落在新一屏的第一条** |
 * | 窗口 | 光标顶到沿才推 | **整屏跟着走** |
 *
 * 用 `navigate(±rows)` 代替是不行的：它的滚动是「光标顶到窗口上/下沿才推动」，
 * 于是从第 0 条翻一屏会得到 `cursor=4, scroll=1` —— 光标跑到了下一屏，
 * 窗口却只挪了一行。**那不叫翻页。**
 *
 * @param {number} step 正数向下、负数向上，通常是 ±rows
 */
export function pageBy(state, step, total, rows) {
  if (state.dialog) return state;                 // 开着确认框时不翻页
  const maxScroll = Math.max(0, total - rows);
  const scroll = Math.max(0, Math.min(maxScroll, state.scroll + step));
  // 光标落在新一屏的第一条 —— 翻完就能直接回车选它。
  const cursor = Math.max(0, Math.min(total - 1, scroll));
  return Object.freeze({ ...state, cursor, scroll });
}

function navigateDialog(state, step) {
  const { stage, pick } = state.dialog;
  if (stage === STAGE.BUSY) return state;                 // 读档中，不接受输入
  const count = itemCount(stage);
  // 框里的项数少，**循环**反而顺手（法宝页那个两项框也是循环的）。
  const next = ((pick + step) % count + count) % count;
  return Object.freeze({ ...state, dialog: { stage, pick: next } });
}

/** 回车。返回 `{state, action}`，`action` 是 `'save'` / `'load'` / null。 */
export function confirm(state, { occupied }) {
  if (!state.dialog) {
    return { state: withDialog(state, STAGE.MENU, 0), action: null };
  }
  const { stage, pick } = state.dialog;
  if (stage === STAGE.BUSY) return { state, action: null };

  if (stage === STAGE.MENU) {
    const item = MENU_ITEMS[pick];
    if (item === 'cancel') return { state: withDialog(state, null), action: null };
    // ⚠️ **空槽不能读。**「前歷再續」在没有记录的槽上按下去应当没反应 ——
    // 放行的话会拿一堆零去建队伍，表现是「读完档全队空白」而不是报错。
    if (item === 'load' && !occupied) return { state, action: null };
    const next = item === 'save' ? STAGE.CONFIRM_SAVE : STAGE.CONFIRM_LOAD;
    return { state: withDialog(state, next, CONFIRM_OK), action: null };
  }

  if (pick === CONFIRM_CANCEL) {
    // 退回三选项那一层，停在刚才选的那一项上。
    const back = stage === STAGE.CONFIRM_SAVE ? 0 : 1;
    return { state: withDialog(state, STAGE.MENU, back), action: null };
  }
  // ⚠️ **只有读档才进 BUSY（「讀取中…」那个横幅）。**
  //
  // 判据是素材本身：`MEN8008` **只有 1 帧**，画出来是「讀取中 . . .」——
  // 原作没有「存檔中」的变体。用户的原话：「原作存档的时候应该是不会显示
  // 任何额外信息的，就直接到他存完」。
  //
  // 存档直接收框、当场完成；读档要等切图，所以留在 BUSY 里挡住输入。
  if (stage === STAGE.CONFIRM_SAVE) {
    return { state: Object.freeze({ ...state, dialog: null }), action: 'save' };
  }
  return { state: withDialog(state, STAGE.BUSY, 0), action: 'load' };
}

/** ESC / ← ：退一层。已经在最外层则返回 null，由调用方决定怎么退出页面。 */
export function back(state) {
  if (!state.dialog) return null;
  const { stage } = state.dialog;
  if (stage === STAGE.BUSY) return state;                 // 忙的时候退不了
  if (stage === STAGE.MENU) return withDialog(state, null);
  const at = stage === STAGE.CONFIRM_SAVE ? 0 : 1;
  return withDialog(state, STAGE.MENU, at);
}

/** 一次存/读做完之后回到列表。 */
export function done(state) {
  return withDialog(state, null);
}

function withDialog(state, stage, pick = 0) {
  return Object.freeze({ ...state, dialog: stage ? { stage, pick } : null });
}

/**
 * 当前窗口里要画的那几条。
 *
 * @param {object} state
 * @param {Map<number, object>} summaries 槽号 → 摘要（`saveslot.slotSummary` 的产物）
 * @param {number} rows 一屏几条
 * @returns {{slot:number, summary:object|null, selected:boolean}[]}
 */
export function visibleRows(state, summaries, rows) {
  const out = [];
  for (let i = 0; i < rows; i += 1) {
    const slot = state.scroll + i;
    out.push({
      slot,
      summary: summaries.get(slot) ?? null,
      selected: slot === state.cursor,
    });
  }
  return out;
}
