import Phaser from 'phaser';

/**
 * SF2 图层的混合模式 —— **全前端唯一一份**。
 *
 * 曾经三处各写一份（`SF2Animator.BLEND_MODE_MAP`、`ui/menuSpec.BLEND`、
 * 导出器 `export_sprite.TRANSLUCENT_BLENDS`），而且语义不一致：菜单那边
 * `subtract16` 当加亮、场景那边当半透明黑 —— 同一个字段两种画法，
 * 于是同一批素材在菜单里是金光、在过场动画里是黑块。
 *
 * ## `subtract16` 是**加亮**，不是减色
 *
 * 名字是先前解格式时起的，不是原作的叫法。判据两条：
 *
 * 1. `tools/export_menu_ui.py` 早就写着：「2 号社区文档叫『16级Subtract』，
 *    **实际是加亮**，按字面写成减色会把选中项涂黑」。
 * 2. 用它的素材形态**全部**是「亮色主体 + 纯黑背景」 —— 废屋法术那张
 *    640×480 的中心金黄椭圆光晕、一簇火焰、一团爆炸云。
 *    纯黑加上去等于没加，这是加法混合的标准素材形态；若是真减法，
 *    火焰会把画面挖成黑洞。
 *
 * 它在已导出的动画包里占 1635/2207 = **74%**，是特效的默认模式。
 */
export const SF2_BLEND = Object.freeze({
  normal: Phaser.BlendModes.NORMAL,
  opaque: Phaser.BlendModes.NORMAL,
  alpha16: Phaser.BlendModes.NORMAL,
  subtract16: Phaser.BlendModes.ADD,
  // ⚠️ **7 与 8 不一样，别一起改。**
  // `unknown7` 是正片叠底 —— 菜单标签栏 / 二级菜单 / 商店分类栏的**底板层**
  // 用它压暗背景。菜单里只有 7，没有 8。
  // `unknown8` 是**加亮**（2026-09-05 订正）：`EVENT2-3` 帧 33~35 用它画的
  // img86~88 是「暗红火焰球 + 纯黑圆背景」，按正片叠底画那圈纯黑会把画面
  // 乘成黑 —— **画面正中那个黑圆盘就是这么来的**，也就是玩家说的「黑圈」。
  // 战斗动画里的 87 处同样是暗红 + 30~45% 近黑像素，形态一致。场景与战斗
  // 里只有 8，没有 7。
  unknown7: Phaser.BlendModes.MULTIPLY,
  unknown8: Phaser.BlendModes.ADD,
  // ⚠️ 这两种**未考证**。按 normal 画是占位，不是结论。
  mode3: Phaser.BlendModes.NORMAL,
  invert: Phaser.BlendModes.NORMAL,
});

/**
 * **带 16 级不透明度**的两种模式。其余模式的 `alpha` 字段是废值。
 *
 * ⚠️ 别把它去掉：废屋法术那张全屏光晕的 alpha 是逐帧 10→7→3，
 * 那是**渐隐**。忽略掉就变成"光晕一直最亮，然后突然消失"。
 * ⚠️ 也别把它推广到 `normal`：那些层的 alpha 常常是 0，当成"全透明"
 * 会把人物整个画没。
 */
const GRADED = new Set(['alpha16', 'subtract16']);
const ALPHA_MAX = 0x10;

/** 这一层该用多少不透明度。 */
export function blendAlpha(layer) {
  if (!GRADED.has(layer?.blend) || !layer.alpha) return 1;
  return Phaser.Math.Clamp(layer.alpha / ALPHA_MAX, 0.05, 1);
}

/**
 * **导出器已经译过一遍**的模式名 → Phaser 常量。
 *
 * 菜单素材（`menus.json`）与场景精灵（`sprite.json`）走这一张 ——
 * 它们的 `blend` 字段在导出时就由 `BLEND_MAP` 译成了 add/multiply/normal，
 * `alpha` 也已归一化到 0~1，前端不必再认识 `subtract16` 这种原始名。
 */
export const NAMED_BLEND = Object.freeze({
  normal: Phaser.BlendModes.NORMAL,
  add: Phaser.BlendModes.ADD,
  multiply: Phaser.BlendModes.MULTIPLY,
});
