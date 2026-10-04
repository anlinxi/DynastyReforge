import { MENU_SPEC_KEY, layersOf, textureKey } from './menuSpec.js';
import { TICK_MS } from '../systems/SF2Animator.js';
import DEPTH from '../systems/depths.js';
import { FEEDBACK_ADVANCE, FEEDBACK_TICKS, vitalFrame, vitalLabels } from './battleFeedback.js';

/** 用已有菜单原作字形画战斗命气变化；不创建系统字体数字或用正负号替代图标。 */
export default class VitalFeedback {
  constructor(scene) { this.scene = scene; this.entries = []; }

  show(unit, change) {
    const scene = this.scene, spec = scene.cache.json.get(MENU_SPEC_KEY);
    const { x, y } = scene.unitAnchor(unit);
    vitalLabels(change).forEach((label, row) => {
      const root = scene.add.container(x, y - 70 - row * 20).setDepth(DEPTH.HUD + 1);
      const left = -label.frames.length * FEEDBACK_ADVANCE / 2;
      label.frames.forEach((frame, i) => {
        for (const layer of layersOf(spec, label.asset, frame, left + i * FEEDBACK_ADVANCE, 0)) {
          root.add(scene.add.image(layer.x, layer.y, textureKey(label.asset), layer.img)
            .setOrigin(0, 0).setBlendMode(layer.blend).setAlpha(layer.alpha));
        }
      });
      const entry = { ...label, root, baseY: root.y, elapsed: 0 };
      root.setY(entry.baseY + vitalFrame(label.delta, 0).y);
      this.entries.push(entry);
    });
  }

  update(delta) {
    this.entries = this.entries.filter((entry) => {
      entry.elapsed += delta;
      if (entry.elapsed >= FEEDBACK_TICKS * TICK_MS) { entry.root.destroy(); return false; }
      const pose = vitalFrame(entry.delta, entry.elapsed / TICK_MS);
      entry.root.setY(entry.baseY + pose.y).setAlpha(pose.alpha);
      return true;
    });
  }

  destroy() { this.entries.forEach((entry) => entry.root.destroy()); this.entries = []; }
}
