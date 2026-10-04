/**
 * **列表行** —— 平时菜单的法寶/絕學/及身页与**战斗里的法寶/絕學页共用这一份**。
 *
 * ## 为什么要抽出来
 *
 * 两边画的是同一个东西：一屏八行，每行「选中条 + 名字 + 数量(或消耗图标+数)」，
 * 用不了的画红字。此前战斗那边**我整个重做了一套**，于是字号、颜色、行距、
 * 红字判据全不一样，还漏了绝学消耗那个蓝圆点 —— 用户原话：
 * 「菜单页里面选物品的时候，这些框框、这些文字，这不都是一样的代码吗？
 * 为什么你重新实现在这个战斗里边，就这么难呢？」
 *
 * ⚠️ 这已经是**第二次**犯同一个错。`ui/slotRows.js` 的模块头里记着第一次：
 * 「这块能不能直接复用天书的代码呀？为什么要整个重新做一套？」
 *
 * ## 两边只差**贴图那一层**
 *
 * | | 平时菜单 | 战斗 |
 * |---|---|---|
 * | 素材加载 | `menus.json` + spritesheet／multiatlas | `anim.json` + `img_NNN.png` |
 * | 选中条 | `MEN4003`（法寶）/ `MEN5002`（絕學） | `ITF3005` |
 * | 数字字形 | `MEN1019`（`glyphLayout` 给映射） | `ITF1019`（帧号＝数字本身） |
 * | 消耗图标 | `MEN5006`（帧 0 红勾玉＝耗体力、1 蓝圆＝耗元气） | 同左 |
 *
 * 所以这里**只管「哪一行画什么」**，真正贴图由调用方给一支 `brush`
 * —— 与 `ui/slotRows.js` 同一个路子。
 */
import { FONT_SIZE } from '../config.js';

/** 行里的字是墨色；**用不了的那一行画红字**。两边共用这一份。 */
export const TEXT_TINT = 0x3a2418;
export const ROW_TINT = Object.freeze({ ok: 0xecceaf, blocked: 0xb91f0f });

/**
 * **已经带颜色的字形不要再上色。**
 *
 * 两类东西的颜色来源不一样：
 *
 * | | 颜色从哪来 | 要不要 tint |
 * |---|---|---|
 * | `yc24` 字库 | 图是**纯白**的 | **要** —— 不 tint 就是一片白字 |
 * | `ITF1019`/`MEN1019` 数字字形 | 图**自带墨色**（66,24,0，抗锯齿边 173,132,99） | **不要** |
 *
 * 拿墨色去 tint 一个已经是墨色的字形＝相乘：笔芯变近黑、**抗锯齿边也被压到
 * 和笔芯一样黑**，笔画看上去就粗一圈。用户原话：「法宝跟绝学列表里边右侧的
 * 数字仍然是比原作中明显更粗」。
 *
 * 红字那一行仍然要 tint —— 那是刻意的信号，不是还原颜色。
 */
export function glyphTint(tint) {
  return tint === TEXT_TINT ? 0xffffff : tint;
}

/** 焦点不在列表上时，选中条压暗到这个透明度。 */
export const DIM_ALPHA = 0.55;

/** 列表里的字号 —— **与平时菜单同一个值**，不许另定。 */
export const ROW_FONT = FONT_SIZE;

/**
 * 选中条那 6 帧是**宽度呼吸动画**（200/200/198/196/196/198）。
 * 借它表达焦点：焦点在列表上用最宽的帧 0，不在时用最窄的帧 3 并压暗。
 */
export const BAR_FRAME = Object.freeze({ focused: 0, blurred: 3 });

/**
 * 一行该画成什么样 —— **判据只有这一处**。
 *
 * @param {{enabled?: boolean}} row `enabled === false` ＝ 用不了（红字）
 * @param {boolean} focused 焦点在不在列表上
 */
export function rowVisual(row, focused = true) {
  return {
    tint: row?.enabled === false ? ROW_TINT.blocked : TEXT_TINT,
    barFrame: focused ? BAR_FRAME.focused : BAR_FRAME.blurred,
    barAlpha: focused ? 1 : DIM_ALPHA,
  };
}

/**
 * 消耗那一格画什么 —— 一个图标 + 一个数。
 *
 * **图标颜色就是消耗什么**：蓝＝元气、红＝体力。原作里两者只会有一个不为 0。
 *
 * ⚠️ 用 `消耗元气值`/`消耗体力值`（`Firttech.enc` 的纯数字），**不要**用配套
 * txt 的「消耗元气」—— 那一列可能是文字（释剑之契写的是「自身气极×100%」），
 * `Number()` 得 NaN，消耗整个不显示。
 *
 * ⚠️ 有的绝学消耗的是**气极的百分比**（`元气消耗按百分比`，`Firttech.enc +485`），
 * 该显示的是这个角色此刻的气极，不是数字 100。
 *
 * @param {object} rec `skills.json` 的一条
 * @param {{气极?: number}} [member] 算百分比消耗要用
 * @returns {{kind: 'qi'|'hp', value: number} | null} 不消耗就是 null
 */
export function costOf(rec, member = null) {
  let qi = Number(rec?.消耗元气值 ?? rec?.消耗元气) || 0;
  if (rec?.元气消耗按百分比 && member) {
    qi = Math.floor((member.气极 ?? 0) * qi / 100);
  }
  const hp = Number(rec?.消耗体力值 ?? rec?.消耗体力) || 0;
  if (qi) return { kind: 'qi', value: qi };
  if (hp) return { kind: 'hp', value: hp };
  return null;
}

/**
 * 画一屏行。**纯组织逻辑**，贴图全交给 `brush`。
 *
 * @param {object} view
 *   `rows` 全部行；`cursor` 选中的全局下标；`top` 这一屏从第几条起；
 *   `perPage` 一屏几行；`focused` 焦点在不在列表上
 * @param {object} style
 *   `y0` 首行 y；`pitch` 行距；`x` 行左缘；`nameDx`/`textDy` 名字偏移；
 *   `qtyDx`/`qtyDy` 数量偏移；`costDx`/`costValueDx` 消耗图标与数的偏移
 * @param {object} brush 调用方提供的四支笔。**每支都带页内行号 `i`**，
 *   让调用方能把对象池按行复用：
 *   `bar(i, frame, x, y, alpha)` 选中条；`text(i, str, x, y, tint)` 名字；
 *   `number(i, value, x, y, tint)` 数值；`icon(i, kind, x, y)` 消耗图标
 */
export function drawRows(view, style, brush) {
  const {
    rows = [], cursor = 0, top = 0, perPage = 8, focused = true,
  } = view ?? {};
  for (let i = 0; i < perPage; i += 1) {
    const row = rows[top + i];
    if (!row) break;
    const y = style.y0 + style.pitch * i;
    const vis = rowVisual(row, focused);

    if (top + i === cursor) brush.bar?.(i, vis.barFrame, style.x, y, vis.barAlpha);
    brush.text?.(i, row.label ?? '', style.x + (style.nameDx ?? 0),
      y + (style.textDy ?? 0), vis.tint);

    const numY = y + (style.qtyDy ?? style.textDy ?? 0);
    if (style.qtyDx != null && Number.isFinite(row.count)) {
      brush.number?.(i, row.count, style.x + style.qtyDx, numY, vis.tint);
    }
    if (style.costDx != null && row.cost) {
      brush.icon?.(i, row.cost.kind, style.x + style.costDx, y + 4);
      brush.number?.(i, row.cost.value,
        style.x + (style.costValueDx ?? style.costDx + 21), numY, vis.tint);
    }
  }
}
