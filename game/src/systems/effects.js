import { ART_ANCHOR, tileCenter } from './battlefield.js';

/** 官方动画坐标基准：RPG.exe 0x42d390、0x41f368。 */
export const EFFECT_ORIGIN = Object.freeze({ x: 293, y: 246 });
const ACTOR_ORIGIN = Object.freeze({ foe: EFFECT_ORIGIN, ally: { x: 346, y: 273 } });

/** 把原作的深度顺序保序压进战场层；地面/选格在下，界面在上。 */
export function animationDepth(value) {
  return 250 + 240 * value / (Math.abs(value) + 1000000);
}

/** 图层原点与影子中心不同；沿用现有单位位置，不重排队形。 */
export function actorAnchor(unit) {
  const side = unit?.def?.side ?? 'foe';
  const origin = ACTOR_ORIGIN[side];
  let offset = unit?.currentPosition?.();
  if (!offset) {
    const tile = unit?.def?.tile;
    const point = tile ? tileCenter(tile.u, tile.v) : ART_ANCHOR[side];
    offset = { x: point.x - ART_ANCHOR[side].x, y: point.y - ART_ANCHOR[side].y };
  }
  return { x: offset.x + origin.x, y: offset.y + origin.y };
}

export const anchorDepth = ({ x, y }) => y * 1000 + x;

/** 槽上限与触发号都来自原记录；例如黑血阵的事件2同时引发第二、三槽。 */
export function animationSlots(record) {
  const slots = record?.动画槽 ?? record?.使用动画槽 ?? [];
  const count = record?.动画槽上限 ?? record?.使用动画槽上限 ?? slots.length;
  return slots.slice(0, count).filter((s) => s.文件 && s.触发号 > 0);
}

export function slotsForEvent(record, eventNo) {
  if (!(eventNo > 0)) return [];
  const count = record?.动画槽上限 ?? record?.使用动画槽上限 ?? 5;
  if (eventNo > count) return [];
  return animationSlots(record).filter((s) => s.触发号 === eventNo);
}

/** JSON到达不等于可播放，逐张图片和图集都要检查实际纹理帧及声音。 */
export function animationPackReady(scene, key) {
  const data = scene.cache.json.get(`${key}-anim`);
  if (!data || !Array.isArray(data.frames)) return false;
  if (/^(MOV|BAK)/.test(key) && !data.motion) return false;
  const images = (data.images ?? []).every((image) => data.atlas
    ? scene.textures.exists(key) && scene.textures.get(key).has(`img_${String(image.index).padStart(3, '0')}`)
    : scene.textures.exists(`${key}-img${image.index}`));
  return images && (data.sounds ?? []).every((sound) => scene.cache.audio.exists(`${key}-snd${sound.index}`));
}

/**
 * 官方0x444b57：多目标只展开本次作用范围，不能波及未选中的敌人。
 * 0x445030：单实例按全屏/施术者/目标/横排/阵营取锚点；多实例各落在目标上。
 */
export function effectPlacements(slot, actor, targets) {
  if (!targets.length) return [];
  const spread = slot.目标码 === 1 && slot.位置码 !== 0;
  const bound = spread ? targets : targets.slice(0, 1);
  return bound.map((target) => {
    let point = actorAnchor(target);
    if (bound.length === 1) {
      switch (slot.位置码) {
        case 0: point = { x: 320, y: 260 }; break;
        case 1: point = actorAnchor(actor); break;
        case 2: break;
        // 原作取该排最后一格、该阵营前排最后一格；不是存活目标的平均位置。
        case 3: point = tileCenter(target.def.tile.u, 3); break;
        case 4: point = tileCenter(target.def.side === 'ally' ? 6 : 1, 3); break;
        default: throw new Error(`尚未支持动画位置码 ${slot.位置码}`);
      }
    }
    // 0x444fc0：0固定5000；1施术者深度；2当前目标深度，然后加槽高度。
    const base = slot.控制码 === 0 ? 5000
      : anchorDepth(actorAnchor(slot.控制码 === 1 ? actor : target));
    if (![0, 1, 2].includes(slot.控制码)) throw new Error(`尚未支持动画高度基准 ${slot.控制码}`);
    return { target, x: point.x - EFFECT_ORIGIN.x, y: point.y - EFFECT_ORIGIN.y,
      depth: animationDepth(base + slot.图层高度) };
  });
}

/**
 * 一次行动的公共动画上下文。只管理视觉，不计算伤害或扣成本。
 * 同批多目标实例的同一帧事件只展开一次，避免N个目标变成N²份后续动画；
 * 同一动作不同帧可以再次触发同槽。关闭后拒绝旧回调。
 */
export class ActionEffects {
  constructor({ record, actor, targets, play, warn = console.warn }) {
    Object.assign(this, { record, actor, targets: [...targets], play, warn });
    this.active = true;
    this.seen = new Set();
    this.nextGroup = 0;
    this.started = 0;
  }

  trigger(frame, group = 'actor', ancestry = []) {
    if (!this.active || !frame.effect_file) return;
    const event = `${group}:${frame.index}:${frame.effect_file}`;
    if (this.seen.has(event)) return;
    this.seen.add(event);
    for (const slot of slotsForEvent(this.record, frame.effect_file)) {
      if (ancestry.includes(slot.槽号)) {
        this.warn(`动画循环引用：${this.record.name ?? this.record.名称} 槽${slot.槽号}`);
        continue;
      }
      const childGroup = ++this.nextGroup;
      const path = [...ancestry, slot.槽号];
      for (const placement of effectPlacements(slot, this.actor, this.targets)) {
        this.started += 1;
        this.play(slot, placement, (event) => this.trigger(event.frame, childGroup, path));
      }
    }
  }

  cancel() { this.active = false; }
}

/**
 * 原作帧数据中的 effect_file 字段标记「本帧引发哪个特效文件」。
 *
 * 特效文件命名规律（由 EffDir.DAT 的 590 个条目归纳）:
 *   EFFA<动画编号>  攻击动画（ATT）引发的特效
 *   EFFM<动画编号>  咒术动画（MAG）引发的特效
 *   EFF<动画编号><序号>  同一动画的多个分部特效，需叠加播放
 *
 * 并非每个动画都有外部特效——例如夏侯仪的摄魂鬼爪(ATT0011)，
 * 其表现已完全内嵌在 54 帧的动画本体中，不存在 EFFA0011。
 */

const ANIM_PATTERN = /^(ATT|MAG)(\d+)$/i;

const PREFIX_BY_TYPE = Object.freeze({
  ATT: 'EFFA',
  MAG: 'EFFM',
});

/**
 * 推导某个动画对应的特效键候选。
 * @param {string} animKey 如 'ATT0010'
 * @param {number} effectNo 帧数据中的 effect_file 编号
 * @returns {string[]} 候选键，按优先级排列
 */
export function effectCandidates(animKey, effectNo) {
  const match = ANIM_PATTERN.exec(animKey ?? '');
  if (!match) return [];

  const [, type, number] = match;
  const prefix = PREFIX_BY_TYPE[type.toUpperCase()];
  const candidates = [`${prefix}${number}`];

  // 分部特效：同一动画可拆成多个文件，末位即 effect_file 编号
  if (effectNo > 0) candidates.push(`EFF${number}${effectNo}`);
  return candidates;
}

/** 从候选中选出已载入的那一个。 */
export function resolveEffectKey(cache, animKey, effectNo) {
  return effectCandidates(animKey, effectNo)
    .find((key) => cache.json.get(`${key}-anim`)) ?? null;
}
