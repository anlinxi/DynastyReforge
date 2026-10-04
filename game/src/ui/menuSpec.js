/**
 * 菜单页配置的读取层。
 *
 * **配置本身不在这里，在 `public/assets/menus/menus.json`**，由
 * `tools/export_menu_ui.py` 从原作 exe 的布局表导出。改摆位改那边重跑，
 * 不要在 JS 里写死坐标——那是这个界面反复做不对的老毛病。
 *
 * 这里只做三件事：把 JSON 取出来、把 SF2 的绘制模式翻成 Phaser 的混合模式、
 * 把「元素 + 帧号 → 一串要贴的图层」这条摆位公式实现一次。
 */
import Phaser from 'phaser';
import { NAMED_BLEND } from '../systems/blendModes.js';

/** JSON 在 Phaser 缓存里的键。 */
export const MENU_SPEC_KEY = 'menus';

/** 精灵表纹理键的前缀，避免和别处的 MEN* 撞名。 */
export const textureKey = (asset) => `menu-${asset}`;

/**
 * SF2 绘制模式 → Phaser 混合模式。
 *
 * ⚠️ 导出时已经把语义翻译好了（社区文档把 2 号叫「Subtract」但**实际是加亮**，
 * 7/8 号文档没有、实测是正片叠底），这里只做名字到常量的映射。
 * 见 `docs/判据/数据链路.md` §8.2。
 */
// 混合模式收口在 `systems/blendModes.js`，见那里的说明。
const BLEND = NAMED_BLEND;

/**
 * 只有位置、没有内容或画不出来的元素，前端一律跳过。
 *
 * ⚠️ `select_bar` 也在里面：exe 给的是**第 0 行**那根条的位置，而条要跟着
 * 光标走，所以由 `MenuScreen.drawList()` 按光标行画。放着不跳过就会多出
 * 一根钉在第 0 行的条。
 */
const SKIP_ROLES = new Set(['glyphs', 'unparsed', 'popup', 'select_bar']);

export const isDrawable = (role) => !SKIP_ROLES.has(role);

/**
 * 半身立绘 `MEN0002`、竖排姓名 `MEN0004`、队伍条小人 `MEN7003` 的**帧序**。
 *
 * 三者**是同一套编号**：anim 帧序 + 1 = 战斗角色代码（1=夏侯仪 2=冰璃 3=封铃笙）。
 *
 * > ❌ 曾经写成「立绘走对话人物代码、姓名走战斗角色代码，2/3 互换」，
 * > **那条已被推翻**（见 `docs/判据/数据链路.md` §3）。真相是 anim 帧序 ≠ 图片序号
 * > （`MEN0002`/`MEN0004` 的帧→图映射都是 `[3,1,2,5,0,4,6,1]`，完全相同），
 * > 先前的「两套编号」是一边按 anim 帧读、一边按 image 序号读错开造成的错觉。
 * > **按 anim 帧读就只有一套编号。**
 *
 * ⚠️ 这四条素材都只有 7 张图，第 8 个 anim 帧回指 image 1 —— **代码 8 不是真实角色**。
 */
export const BATTLE_ORDER = Object.freeze([
  '夏侯仪', '冰璃', '封铃笙', '慕容璇玑', '古伦德', '葛云衣', '霍雍',
]);

export const battleIndex = (name) => Math.max(0, BATTLE_ORDER.indexOf(name));

/**
 * 一个元素在某一帧要贴哪些图层。
 *
 * 摆位公式（四项缺一不可，见 `docs/判据/数据链路.md` §2.9）：
 * 元素的 `x`/`y` 已经把「容器原点 + exe 构造坐标 + setOffset」叠好了，
 * 这里补上最后一项 **SF2 帧层偏移** —— 它随帧号变，所以不能预先叠进去。
 *
 * ⚠️ 层的先后**就是图层表顺序，不要按 depth 排**：`depth === 0xFFFFFFFF`
 * 是「没设」的哨兵不是最大值，按它排会把高亮块压到文字底下（§8.19）。
 *
 * @returns {{img:number,x:number,y:number,blend:number,alpha:number}[]}
 */
export function layersOf(spec, asset, frame, originX, originY) {
  const meta = spec.assets?.[asset];
  if (!meta) return [];
  const layers = meta.frames?.[frame];
  if (!layers) return [];
  return layers.map((l) => ({
    img: l.img,
    x: originX + l.x,
    y: originY + l.y,
    blend: BLEND[l.blend ?? 'normal'] ?? Phaser.BlendModes.NORMAL,
    alpha: l.alpha ?? 1,
  }));
}

/** 某个素材的图数量。帧号越界时用来兜底。 */
export const frameCount = (spec, asset) => spec.assets?.[asset]?.frames?.length ?? 0;

/**
 * 标签栏每一格的可点区域，直接从帧表里的高亮块算，不另外硬编码。
 *
 * 每一帧的结构都是 底板 → 文字条 → **高亮块**，高亮块就是那一格的位置，
 * 所以「哪里能点」和「点了哪里会亮」天然一致。
 *
 * @param {object} spec menus.json
 * @param {string} asset 标签栏素材名
 * @param {number} count 标签数（帧数可能多于标签数，末尾那格是「离开」）
 */
export function tabHitAreas(spec, asset, originX, originY, count) {
  const meta = spec.assets?.[asset];
  if (!meta) return [];
  const areas = [];
  for (let i = 0; i < count; i += 1) {
    const layers = meta.frames?.[i];
    const hl = layers?.[layers.length - 1];
    // 帧 0~5 的底板/文字条固定两层，第三层才是高亮；没有第三层就是那一格无高亮
    if (!layers || layers.length < 3 || !hl) continue;
    const [w, h] = meta.sizes[hl.img] ?? [0, 0];
    areas.push({ tab: i, x: originX + hl.x, y: originY + hl.y, w, h });
  }
  return areas;
}
