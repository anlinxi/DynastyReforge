/**
 * 选取目标时铺在地上的**格子** —— 绿＝可指的范围，蓝＝这一下会打到的格。
 *
 * ## 原作行为（用户 2026-09-16 口述）
 *
 * * **只在要选目标时出现**（攻击 / 绝学 / 法宝都要选）；
 * * 铺在**目标所属那一侧**：打敌人就铺敌方 8 格，作用于我方就铺我方 8 格；
 * * 一出现是**绿色、8 格全有**，**不管格子上有没有人**；
 * * 鼠标悬停到某个角色身上时，**这一次会打到的所有格子变蓝**
 *   （例：横排技能 → 整排都变蓝）；
 * * 蓝绿的动画一样，只是颜色不同。
 *
 * 「打到哪几格」由 `systems/targeting.js` 求解（纯函数，有回归）。
 *
 * ## 素材
 *
 * | 代号 | 是什么 | 尺寸 | 帧 | 混合 |
 * |---|---|---|---|---|
 * | `ITF0013` | **绿格** | 82×41 | 16 | `subtract16` |
 * | `ITF001` | **蓝格** | 82×41 | 16 | `subtract16` |
 *
 * 原始文件：`multimedia/fight/ItfDir.DAT` 里的 `ITF0013.SF2` / `ITF001.SF2`；
 * 产物：`public/assets/ITF0013/` 与 `public/assets/ITF001/`。用户已确认认对了。
 *
 * ⚠️ **`subtract16` 在这个项目里是「加亮」不是减色**（见 `systems/blendModes.js`
 * 的考证）—— 用普通 alpha 画会太实、压在地面上像贴纸。
 *
 * ⚠️ **素材的图层坐标是屏幕绝对坐标**（(278,239)/(279,242)），不是相对那个
 * 82×41 的框。按小框贴会贴到框外，渲出来一片空白 —— 认这两件素材时就栽过一次。
 * 这里不用它的自带坐标，直接**按格心居中**摆。
 *
 * ## 🟡 格子比格小一圈
 *
 * 贴图 82×41，而格心步长是 `(±54,+27)`（菱形 108×54，量自 `FLR000`），
 * 所以铺出来**格与格之间有约 26px 的缝**。用户的原作截图里确实有缝，
 * 但宽度还没对上 —— 登记在 `docs/状态/复现度台账.md`。
 * **人物站位与格子必须共用同一套格心**，否则人不在格子上，所以不单独调格子。
 */
import { packImage } from './packImage.js';
import Phaser from 'phaser';
import DEPTH from '../systems/depths.js';
import { SF2_BLEND, blendAlpha } from '../systems/blendModes.js';
import { tileCenter } from '../systems/battlefield.js';
import { TICK_MS } from '../systems/SF2Animator.js';

/** 绿＝可指的范围；蓝＝这一下会打到的。 */
export const TILE_ART = Object.freeze({ selectable: 'ITF0013', affected: 'ITF001' });

/** 格子贴图尺寸。居中到格心要用。 */
const TILE_W = 82;
const TILE_H = 41;

/** 这一块要预载哪些包 —— 拿上面的表反查，不要另写清单。 */
export function tilePackKeys() {
  return [...new Set(Object.values(TILE_ART))].sort();
}

/**
 * 格子画在**地面之上、所有单位之下**。
 *
 * 单位的深度是 `DEPTH_BASE + 格深`（见 `battlefield.tileDepth`），地面是 0。
 * 取 1~9 之间的一个数，保证「人踩在格子上」而不是「格子盖住人」。
 */
const TILE_DEPTH = 5;

function frameSpec(scene, key, frame) {
  const data = scene.cache.json.get(`${key}-anim`);
  const index = frame % Math.max(1, data?.frames?.length ?? 1);
  const layer = data?.frames?.[index]?.layers?.[0];
  const img = packImage(scene, key, index, { tag: '格子' });
  if (!layer || !img) return null;
  return {
    key: img.key,
    frame: img.frame,
    blend: SF2_BLEND[layer.blend] ?? Phaser.BlendModes.NORMAL,
    alpha: blendAlpha(layer),
  };
}

export default class TileOverlay {
  constructor(scene) {
    this.scene = scene;
    this.root = scene.add.container(0, 0).setDepth(TILE_DEPTH);
    /** 每种颜色一个对象池，避免每帧新建。 */
    this.pools = { selectable: [], affected: [] };
    this.tiles = { selectable: [], affected: [] };
    this.frame = 0;
    this.since = 0;
    this.visible = false;
    this.root.setVisible(false);
  }

  /**
   * 铺格子。**每次选择状态变了就调一次**，不用每帧调。
   *
   * @param {{u:number,v:number}[]} selectable 绿格 —— 可以指的全部格
   * @param {{u:number,v:number}[]} affected 蓝格 —— 这一下会打到的格
   */
  show(selectable = [], affected = []) {
    // 蓝格盖在绿格上：同一格两色都有时只看得见蓝的，正是原作「变蓝」的样子。
    const blue = new Set(affected.map((t) => `${t.u},${t.v}`));
    this.tiles.selectable = selectable.filter((t) => !blue.has(`${t.u},${t.v}`));
    this.tiles.affected = [...affected];
    this.visible = true;
    this.root.setVisible(true);
    this.draw();
  }

  hide() {
    this.visible = false;
    this.root.setVisible(false);
  }

  /** 把两种颜色各自摆好。对象池复用，多出来的藏起来。 */
  draw() {
    for (const kind of ['selectable', 'affected']) {
      const key = TILE_ART[kind];
      const spec = frameSpec(this.scene, key, this.frame);
      const list = this.tiles[kind];
      const pool = this.pools[kind];
      list.forEach((t, i) => {
        if (!spec) return;
        const at = tileCenter(t.u, t.v);
        let img = pool[i];
        if (!img) {
          img = this.scene.add.image(0, 0, spec.key, spec.frame).setOrigin(0, 0);
          this.root.add(img);
          pool[i] = img;
        }
        img.setVisible(true).setTexture(spec.key, spec.frame)
          .setPosition(Math.round(at.x - TILE_W / 2), Math.round(at.y - TILE_H / 2))
          .setBlendMode(spec.blend)
          .setAlpha(spec.alpha);
      });
      for (let i = list.length; i < pool.length; i += 1) pool[i]?.setVisible(false);
    }
  }

  /**
   * 16 帧的循环动画。**每帧调**，`delta` 是本帧毫秒数。
   *
   * 帧时长取素材自带的 `duration × TICK_MS` —— 两件都是每帧 `duration=1`，
   * 也就是一帧 55ms、一轮 880ms。
   */
  update(delta) {
    if (!this.visible) return;
    const data = this.scene.cache.json.get(`${TILE_ART.selectable}-anim`);
    const count = Math.max(1, data?.frames?.length ?? 1);
    const hold = Math.max(1, data?.frames?.[this.frame % count]?.duration ?? 1) * TICK_MS;
    this.since += delta;
    if (this.since < hold) return;
    this.since = 0;
    this.frame = (this.frame + 1) % count;
    this.draw();
  }

  destroy() { this.root.destroy(true); }
}
