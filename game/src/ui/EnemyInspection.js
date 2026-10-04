import { menuFont } from './nativeText.js';
import { FONT_KEY, FONT_SIZE } from '../config.js';
import DEPTH from '../systems/depths.js';
import { imageOf } from './ListPanel.js';
import { MENU_SPEC_KEY, layersOf, textureKey } from './menuSpec.js';
import { RESIST_FIELDS, digitFrames } from './listLayout.js';
import { barFrame } from './hudLayout.js';
import { TEXT_TINT } from './slotRows.js';
import { INSPECTION } from './battleFeedback.js';

/** 神视是常驻目标资料，不取得输入焦点，不参与战斗行动的结束屏障。
 * 原作0x430a20实时更新命气，目标死亡收起；0x421cb1再次施放会替换目标。
 */
export default class EnemyInspection {
  constructor(scene) {
    this.scene = scene;
    this.root = scene.add.container(INSPECTION.x, INSPECTION.y).setDepth(DEPTH.HUD).setVisible(false);
    this.parts = new Map();
    this.target = null;
    this.put('board', INSPECTION.board, 0, 0, 0);
    this.name = scene.add.bitmapText(INSPECTION.name.x, INSPECTION.name.y, menuFont(), '', FONT_SIZE)
      .setOrigin(.5, 0);
    this.root.add(this.name);
  }

  put(name, key, frame, x, y, menu = false) {
    const scene = this.scene;
    const layer = menu ? layersOf(scene.cache.json.get(MENU_SPEC_KEY), key, frame, x, y)[0] : null;
    const art = menu ? layer && { key: textureKey(key), frame: layer.img, dx: layer.x - x, dy: layer.y - y }
      : imageOf(scene, key, frame);
    let image = this.parts.get(name);
    if (!art) { image?.setVisible(false); return; }
    if (!image) { image = scene.add.image(0, 0, art.key, art.frame).setOrigin(0, 0); this.root.add(image); this.parts.set(name, image); }
    image.setVisible(true).setTexture(art.key, art.frame).setPosition(x + art.dx, y + art.dy);
  }

  number(name, value, x, y, key = 'ITF0012', step = 6, menu = false, width = 0) {
    const digits = digitFrames(Math.abs(value));
    const pad = Math.max(0, width - digits.length) * step;
    digits.forEach((frame, i) => this.put(`${name}-${i}`, key, frame, x + pad + i * step, y, menu));
    for (let i = digits.length; this.parts.has(`${name}-${i}`); i++) this.parts.get(`${name}-${i}`).setVisible(false);
  }

  show(unit) { this.target = unit; this.refresh(); }
  clear() { this.target = null; this.root.setVisible(false); }

  refresh() {
    const unit = this.target;
    if (!unit?.alive) { this.clear(); return; }
    this.root.setVisible(true);
    this.name.setText(unit.name);
    for (const channel of ['hp', 'qi']) {
      const slot = INSPECTION[channel], current = unit.state[channel];
      const max = unit.state[channel === 'hp' ? 'maxHp' : 'maxQi'];
      const count = this.scene.cache.json.get(`${slot.key}-anim`).frames.length;
      this.put(channel, slot.key, barFrame(max ? current / max : 0, count), slot.x, slot.y);
      this.number(`${channel}-cur`, current, INSPECTION.currentX, slot.valueY);
      this.number(`${channel}-max`, max, INSPECTION.maxX, slot.valueY);
    }
    RESIST_FIELDS.forEach((col, ci) => col.forEach((field, ri) => {
      const value = unit.resists[field];
      this.number(`resist${ci}${ri}`, value, INSPECTION.resistX[ci], INSPECTION.resistY + ri * INSPECTION.resistStep,
        value > 0 ? 'MEN0028' : 'MEN0029', 10, true, 3);
    }));
  }

  destroy() { this.target = null; this.root.destroy(); this.parts.clear(); }
}
