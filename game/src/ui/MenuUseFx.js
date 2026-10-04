import { hdScaleOf } from '../hd/hdRender.js';
import { layersOf, textureKey } from './menuSpec.js';
import DEPTHS from '../systems/depths.js';

const DEPTH = DEPTHS.MENU;

/**
 * 菜单里用物品/放绝学时，成员头上的金光（`MEN0016`，21 帧：光环张开 → 粒子上升 → 散尽）。
 *
 * ⚠️ **这是菜单自己的素材，不是战斗那套。** 一度拿 `Ail2 +716` 的
 * 「使用动画文件一」（金创药＝`EFF3001`）来画 —— 那是**战斗里**用物品的动画，
 * 蓝色、按整幅战斗画面构图；菜单里本来就有金色的 `MEN0016`。
 *
 * 特效挂在菜单的 container 之外（贴图自带深度），关菜单时要 `clear()`，否则会留在画面上。
 * （2026-10-04 从 MenuScreen 拆出，QA-04；行为不变。）
 */
export class MenuUseFx {
  /** @param {import('./MenuScreen.js').default} menu 取 `spec` 与 `scene` */
  constructor(menu) {
    this.menu = menu;
    /** 正在播的每一份：`{x, y, frame, elapsed, parts}`。 */
    this.list = [];
  }

  /**
   * 在这些成员头上各放一份（全体回复就是每个目标各一份，与原作截图一致）。
   *
   * 摆位：`屏幕位置 = 落点 − 锚点 + 该帧的 layer.x/y` —— 用相对量平移，
   * 原作那 21 帧之间的运动（粒子上升、图往上长）原样保留。
   */
  play(targets) {
    const { spec } = this.menu;
    const bar = spec.partyBar;
    const cfg = spec.useFx;
    if (!bar || !cfg || !targets?.length) {
      if (!cfg) console.warn('menus.json 缺 useFx，这次不放特效');
      return;
    }
    if (!spec.assets?.[cfg.asset]) {
      console.warn(`使用特效素材 ${cfg.asset} 没导出，这次不放特效`);
      return;
    }
    const s = cfg.scale ?? 1;
    const added = targets
      .filter((k) => k >= 0 && k < bar.slotX.length)
      .map((k) => ({
        x: bar.slotX[k] + cfg.at.x - cfg.anchor.x * s,
        y: bar.slotY + cfg.at.y - cfg.anchor.y * s,
        frame: 0,
        elapsed: 0,
        parts: [],
      }));
    this.list = [...this.list, ...added];
    this.list.forEach((f) => this.drawFrame(f));
  }

  /**
   * 画一份特效的当前帧。旧的贴图先销毁 —— 21 帧逐帧重建，开销可忽略。
   *
   * ⚠️ **缩放要连位移一起缩。** 素材是按原作战斗画面那么大画的（帧 1 光环就
   * 占满 105 宽），而队伍条一格才 104×97。只给贴图 `setScale` 而不缩位移的话，
   * 环是小了，但它在 21 帧里上升的那 100 多像素照旧 —— 第三帧就飞出格子了。
   */
  drawFrame(fx) {
    const { spec, scene } = this.menu;
    const cfg = spec.useFx;
    const s = cfg.scale ?? 1;
    const hd = hdScaleOf(textureKey(cfg.asset)); // 同 drawCellCursor：显式缩放要除掉高清倍数
    fx.parts.forEach((p) => p.destroy());
    fx.parts = layersOf(spec, cfg.asset, fx.frame, 0, 0).map((l) => scene.add
      .image(fx.x + l.x * s, fx.y + l.y * s, textureKey(cfg.asset), l.img)
      .setOrigin(0, 0)
      .setScale(s / hd)
      .setScrollFactor(0)
      .setBlendMode(l.blend)
      .setAlpha(l.alpha)
      .setDepth(DEPTH + 2));
  }

  drop(fx) {
    fx.parts.forEach((p) => p.destroy());
    this.list = this.list.filter((f) => f !== fx);
  }

  /**
   * 每帧推一下。**由菜单的 update 调**。
   *
   * ⚠️ 菜单素材**没有帧时长字段**（菜单 SF2 里根本没有帧表），
   * 节拍取战斗动画的 `TICK_MS`，见 `docs/状态/复现度台账.md` §七。
   */
  tick(delta) {
    const { spec } = this.menu;
    const cfg = spec?.useFx;
    if (!cfg || !this.list.length) return;
    const count = spec.assets?.[cfg.asset]?.count ?? 0;
    for (const fx of [...this.list]) {
      fx.elapsed += delta;
      if (fx.elapsed < cfg.tickMs) continue;
      fx.elapsed -= cfg.tickMs;
      fx.frame += 1;
      if (fx.frame >= count) { this.drop(fx); continue; }
      this.drawFrame(fx);
    }
  }

  /** 关菜单时把还在播的全收掉。 */
  clear() {
    this.list.forEach((f) => f.parts.forEach((q) => q.destroy()));
    this.list = [];
  }
}
