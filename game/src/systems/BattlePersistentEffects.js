import { soulPack, endSoulOpportunity } from './soulStones.js';
import SF2Animator from './SF2Animator.js';
import { actorAnchor, anchorDepth, animationDepth, EFFECT_ORIGIN } from './effects.js';
import { tileCenter } from './battlefield.js';
import { visibleStates, paralysisOffset } from './battleFields.js';

/** 持续效果复用SF2；跟随当前人物位置，结束或死亡即销毁，不占行动结束屏障。 */
export default class BattlePersistentEffects {
  constructor(scene) { this.scene = scene; this.animations = new Map(); }
  update(time, delta) {
    const wanted = new Map();
    for (const unit of this.scene.units) {
      const ids = unit.alive ? visibleStates(unit.statuses) : [];
      const offset = ids.includes(1) ? paralysisOffset(Math.floor(time / 55)) : { x: 0, y: 0 };
      for (const animator of unit.animators.values()) animator.setDisplayOffset(offset.x, offset.y);
      const point = actorAnchor(unit);
      if (!unit.alive && unit.soulChecked) endSoulOpportunity(unit);
      if (unit.alive && unit.soulStone) wanted.set(`${unit.def.id}:soul`, {
        pack: soulPack(unit.soulStone), point: { x: point.x - 23, y: point.y - 70 },
        depth: animationDepth(anchorDepth(point) + 320), origin: EFFECT_ORIGIN,
      });
      for (const id of ids) {
        const spec = unit.rules?.状态演出?.[id];
        for (const [layer, diff] of [['后层', -640], ['前层', 640]]) {
          if (spec?.[layer]) wanted.set(`${unit.def.id ?? this.scene.units.indexOf(unit)}:${id}:${layer}`, {
            pack: spec[layer], point, depth: animationDepth(anchorDepth(point) + diff), origin: { x: 320, y: 260 },
          });
        }
      }
    }
    for (const entry of this.scene.fields.entries) {
      if (!entry.owner.alive || !entry.pack) continue;
      const point = tileCenter(entry.side === 'ally' ? 6 : 1, 3);
      wanted.set(entry, { pack: entry.pack, point, depth: animationDepth(6000), origin: { x: 293, y: 246 } });
    }
    for (const [key, animation] of this.animations) {
      if (!wanted.has(key)) { animation.destroy(); this.animations.delete(key); }
    }
    for (const [key, { pack, point, depth, origin }] of wanted) {
      let animation = this.animations.get(key);
      if (!animation) {
        animation = new SF2Animator(this.scene, pack, { x: point.x, y: point.y, depth, originX: origin.x, originY: origin.y });
        animation.play({ loop: true }); this.animations.set(key, animation);
      }
      animation.container.setPosition(point.x, point.y).setDepth(depth);
      animation.update(time, delta);
    }
  }
  destroy() { this.animations.forEach(a => a.destroy()); this.animations.clear(); }
}
