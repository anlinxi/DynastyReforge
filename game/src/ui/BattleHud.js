/**
 * 战斗顶部的「队员状态条」—— 用**原作素材**画，一格一个队员。
 *
 * 布局与帧换算全在 {@link ./hudLayout.js}（纯函数，有回归）；
 * 这里只管把图贴上去。**不要在这个文件里写坐标**。
 *
 * ## 一个必须知道的坑：帧号 ≠ 图号
 *
 * `anim.json` 里 `frames[i].layers[].image_index` 才是真正要画哪张图。
 * 多数界面素材是 1:1（第 i 帧用第 i 张图），但 **`ITF0011` 是 13 帧 11 图**
 * —— 帧 10/11 是空的、帧 12 才是 `?`。直接拿帧号当图号会画出别的字形，
 * 而且不报错。所以一律走 {@link imageOf}。
 *
 * ## 深度
 *
 * 走 `systems/depths.js` 的 `HUD`。⚠️ 判据表 F 组：场上精灵的深度＝地图 y，
 * 最高 2640 —— 界面层写死一个小数字会被站得靠下的单位盖住，而且不报错。
 */
import { packImage } from './packImage.js';
import { hdScaleOf } from '../hd/hdRender.js';
import DEPTH from '../systems/depths.js';
import {
  BOX_SIZE, SLOTS, GAUGE_PHASES,
  boxOrigin, barFrame, gaugeFrame, recoverKeepWidth, digitFrames, hpBarKey,
} from './hudLayout.js';

/**
 * 第 `frame` 帧实际要画哪张图、偏移多少。
 *
 * @returns {{key: string, dx: number, dy: number} | null} 这一帧什么都不画时返回 null
 */
function imageOf(scene, key, frame) {
  return packImage(scene, key, frame, { tag: '状态条' });
}

/** 一个队员的一格。持有自己的 Image 对象，刷新时只改纹理/帧，不重建。 */
class HudBox {
  constructor(scene, container, index) {
    this.scene = scene;
    this.index = index;
    // 位置在 `place()` 里定 —— **整组居中，所以要等知道一共几个人**。
    this.root = scene.add.container(0, 0);
    container.add(this.root);
    /** 名字 → Phaser.Image，惰性建。 */
    this.parts = new Map();
    this.digits = new Map();
  }

  /** 整组居中，所以每次渲染都要按当前人数重新摆位。 */
  place(count, active = -1) {
    const at = boxOrigin(this.index, count, active);
    this.root.setPosition(at.x, at.y);
  }

  /** 贴一张图；`spec` 为 null 时把这一块藏起来（不销毁，下一帧还要用）。 */
  /**
   * @param {number|null} [keepW] 只画左边这么宽（回气条要把右边裁掉，
   *   见 `hudLayout.recoverKeepWidth`）。给 `null` 就整张画。
   *   ⚠️ **不需要裁的时候一定要 `setCrop()` 清掉** —— 裁剪是对象上的状态，
   *   上一帧裁过、这一帧不清，条会一直缺一块。
   */
  put(name, spec, x, y, keepW = null) {
    let img = this.parts.get(name);
    if (!spec) { if (img) img.setVisible(false); return; }
    if (!img) {
      img = this.scene.add.image(0, 0, spec.key, spec.frame).setOrigin(0, 0);
      this.root.add(img);
      this.parts.set(name, img);
    }
    img.setVisible(true).setTexture(spec.key, spec.frame).setPosition(x + spec.dx, y + spec.dy);
    if (keepW == null) img.setCrop();
    else if (keepW <= 0) img.setVisible(false);
    else img.setCrop(0, 0, keepW * hdScaleOf(img.texture.key), img.height); // 裁剪按贴图像素，高清图要乘倍数
  }

  /** 画一个数（左对齐，逐位贴字形）。 */
  putNumber(name, glyphKey, value, at, advance) {
    const frames = digitFrames(value);
    const pool = this.digits.get(name) ?? [];
    this.digits.set(name, pool);
    frames.forEach((frame, i) => {
      const spec = imageOf(this.scene, glyphKey, frame);
      let img = pool[i];
      if (!spec) { if (img) img.setVisible(false); return; }
      if (!img) {
        img = this.scene.add.image(0, 0, spec.key, spec.frame).setOrigin(0, 0);
        this.root.add(img);
        pool[i] = img;
      }
      img.setVisible(true).setTexture(spec.key, spec.frame)
        .setPosition(at.x + advance * i + spec.dx, at.y + spec.dy);
    });
    for (let i = frames.length; i < pool.length; i += 1) pool[i]?.setVisible(false);
  }

  /**
   * @param {object|null} unit 这一格的队员；`null` = 空位，整格藏起来
   */
  render(unit, count, active = -1) {
    this.root.setVisible(Boolean(unit));
    if (!unit) return;
    this.place(count, active);

    this.put('board', imageOf(this.scene, SLOTS.board.key, 0), SLOTS.board.x, SLOTS.board.y);
    this.put('portrait', imageOf(this.scene, SLOTS.portrait.key, unit.portraitFrame ?? 0),
      SLOTS.portrait.x, SLOTS.portrait.y);

    this.putNumber('rank', SLOTS.rank.key, unit.rank ?? 0,
      { x: SLOTS.rank.x, y: SLOTS.rank.y }, SLOTS.rank.advance);

    for (const which of ['hp', 'mp']) {
      const slot = SLOTS[which];
      const cur = Math.max(0, unit[which]?.cur ?? 0);
      const max = Math.max(1, unit[which]?.max ?? 1);
      const ratio = cur / max;
      // 命条低血换红；气条没有第二种颜色，`low` 与 `bar` 指向同一效果的另一张
      const barKey = which === 'hp' ? hpBarKey(ratio) : slot.bar;
      const frames = this.scene.cache.json.get(`${barKey}-anim`)?.counts?.frames ?? 1;
      this.put(`${which}-bar`, imageOf(this.scene, barKey, barFrame(ratio, frames)),
        slot.x, slot.y);
      this.putNumber(`${which}-cur`, slot.glyph, cur, slot.cur, slot.advance);
      this.putNumber(`${which}-max`, slot.glyph, max, slot.max, slot.advance);
    }

    // 行动条：三种颜色同一位置，按阶段挑一种画，另外两种藏起来。
    const phase = GAUGE_PHASES.includes(unit.phase) ? unit.phase : 'wait';
    for (const p of GAUGE_PHASES) {
      const key = SLOTS.gauge[p];
      if (p !== phase) { this.put(`gauge-${p}`, null); continue; }
      const frames = this.scene.cache.json.get(`${key}-anim`)?.counts?.frames ?? 1;
      const frame = gaugeFrame(unit.gauge ?? 0, frames);
      // ⭐ 回气那一段从**释放点**往左画，右边（蓝条刚扫过的）留空。
      const keep = p === 'recover'
        ? recoverKeepWidth(frame, unit.release ?? 0, SLOTS.gauge.width) : null;
      this.put(`gauge-${p}`, imageOf(this.scene, key, frame),
        SLOTS.gauge.x, SLOTS.gauge.y, keep);
    }
  }
}

/**
 * 顶部状态条整体。
 *
 * ⚠️ **每帧都要 `render()`** —— 判据表 E 组那条「改了状态却界面不更新」
 * 在这里同样适用：剧情或战斗扣了血，不重画就是旧数。
 */
export default class BattleHud {
  /**
   * @param {Phaser.Scene} scene
   * @param {number} [slots] 画几格。原作顶部最多五格
   */
  constructor(scene, slots = 5) {
    this.scene = scene;
    this.container = scene.add.container(0, 0).setDepth(DEPTH.HUD);
    this.boxes = Array.from({ length: slots }, (_, i) => new HudBox(scene, this.container, i));
  }

  /**
   * @param {Array<object|null>} units 每格一个队员，顺序＝队伍顺序；
   *   少于格数时后面的格子藏起来。每项要有：
   *   `{ portraitFrame, rank, hp:{cur,max}, mp:{cur,max}, gauge, phase }`
   */
  render(units, active = -1) {
    const count = Math.max(1, units?.length ?? 0);
    // ⭐ `active` = 正在选指令的那一格，它比其余低 9px（见 `hudLayout.boxOrigin`）。
    this.boxes.forEach((box, i) => box.render(units?.[i] ?? null, count, active));
  }

  setVisible(v) { this.container.setVisible(v); return this; }

  destroy() { this.container.destroy(true); }
}

export { BOX_SIZE };
