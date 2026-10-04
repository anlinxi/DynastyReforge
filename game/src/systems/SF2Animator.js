import { playSfx } from './audioSettings.js';
import { useXbr } from '../hd/hdRender.js';
import Phaser from 'phaser';

/**
 * 播放由 tools/export_pack.py 导出的 SF2 动画。
 *
 * anim.json 结构:
 *   { anim_size, tile, counts, images: [{index, file, width, height}],
 *     frames: [{index, duration, shake, sound_index, hit_pose, effect_file,
 *               layers: [{image_index, x, y, depth, blend, alpha}]}] }
 *
 * 原作以「帧时长」为节拍单位而非毫秒，这里按固定节拍换算。
 */

/** 原作一个时长单位对应的毫秒数（可整体调速）。 */
export const TICK_MS = 55;

import { SF2_BLEND, blendAlpha } from './blendModes.js';
import { warnOnce } from './warnOnce.js';

/**
 * SF2 绘制模式 → Phaser 混合模式，以及分级 alpha。
 *
 * ⚠️ **收口到 `blendModes.js`（2026-09-05）。** 原先这里自己写一份，
 * 而且 `TRANSLUCENT_BLENDS` **只含 `alpha16`** —— 于是 `subtract16` 的
 * alpha 字段被忽略，废屋法术那张全屏光晕的 10→7→3 渐隐失效，
 * 变成"一直最亮然后突然消失"。
 */
function resolveBlend(blend) {
  return SF2_BLEND[blend] ?? SF2_BLEND.normal;
}

function resolveAlpha(layer) {
  return blendAlpha(layer);
}

export default class SF2Animator {
  /**
   * @param {Phaser.Scene} scene
   * @param {string} key      资源键，同时是 assets 下的目录名
   * @param {object} options  { x, y, originX, originY, depth }
   */
  constructor(scene, key, options = {}) {
    this.scene = scene;
    this.key = key;
    this.data = scene.cache.json.get(`${key}-anim`);
    if (!this.data) throw new Error(`缺少动画数据: ${key}-anim`);
    /**
     * 走图集还是逐张 PNG。
     *
     * 图集（`load.multiatlas`）下整个动画包**只有一个纹理 key**，层与层之间
     * 靠**帧名** `img_003` 区分。实测把 33 个动画包打成图集后，
     * 请求数从 1000 多降到 100 出头。旧产物没有 `atlas` 字段，走后者。
     */
    this.atlas = Boolean(this.data.atlas);

    this.container = scene.add.container(options.x ?? 0, options.y ?? 0);
    this.container.setDepth(options.depth ?? 0);
    // 原作坐标以整幅战斗画面为基准，这里减去锚点得到局部坐标
    this.originX = options.originX ?? 0;
    this.originY = options.originY ?? 0;
    this.displayOffset = { x: 0, y: 0 };

    this.sfxVolume = options.sfxVolume ?? 0.8;
    // 帧上携带的原作事件（引发特效、屏幕震动）交由外部处理
    this.onFrameEvent = options.onFrameEvent ?? null;
    this.borrowUnit = options.borrowUnit ?? null;
    this.borrowedUnit = null;
    this.frameIndex = 0;
    this.elapsed = 0;
    this.playing = false;
    this.loop = true;
    this.onComplete = null;
    this.sprites = [];

    this.renderFrame(0);
  }

  get frames() {
    return this.data.frames ?? [];
  }

  get frameCount() {
    return this.frames.length;
  }

  play({ loop = true, onComplete = null, startFrame = 0, steps = null, onStep = null } = {}) {
    this.steps = steps;
    this.stepIndex = 0;
    this.onStep = onStep;
    this.frameIndex = steps?.[0]?.index ?? startFrame;
    this.elapsed = 0;
    this.loop = loop;
    this.onComplete = onComplete;
    this.playing = true;
    if (steps?.length) onStep?.(steps[0]);
    this.renderFrame(this.frameIndex);
    return this;
  }

  stop() {
    this.playing = false;
    return this;
  }

  setPosition(x, y) {
    this.container.setPosition(x, y);
    return this;
  }

  setFlipX(flip) {
    this.container.setScale(flip ? -1 : 1, 1);
    return this;
  }

  /** 当前帧的原作参数，供外部驱动震屏/音效/受击。 */
  get currentFrameInfo() {
    return this.frames[this.frameIndex] ?? null;
  }

  /** 帧上标记了音效就触发；-1 表示该帧无声。 */
  playFrameSound(frame) {
    const index = frame?.sound_index ?? -1;
    if (index < 0) return;
    const key = `${this.key}-snd${index}`;
    if (!this.scene.cache.audio.exists(key)) {
      // 兜底跳过要留日志（判据表）：**少一声在画面上完全看不出来**。
      // 场景动画的内嵌音效整条链曾经都是空的，谁也没发现。
      warnOnce(`sf2-snd:${key}`, `动画 ${this.key} 第 ${index} 号帧音效没载入，这一声不响`);
      return;
    }
    playSfx(this.scene, key, { volume: this.sfxVolume });
  }

  renderFrame(index) {
    const frame = this.frames[index];
    if (!frame) return;

    // 构造时只是预览首帧；play()才进入它，不能把帧事件/声音触发两次。
    if (this.playing) this.playFrameSound(frame);
    // 震动与镜头字段由战斗镜头统一处理（0x43f520：每个SF2对象换帧都派发）；地图场景没有battleCamera。
    if (this.playing) this.scene.battleCamera?.onFrame(frame, this);
    if (this.playing && (frame.effect_file || frame.shake || frame.hit_pose)) {
      this.onFrameEvent?.({ animKey: this.key, frame });
    }

    // 第0帧是起始槽；其他空帧必须清画面。ATT0055以空帧交给EFF继续演出，
    // 保留上一帧会让古伦德的起跳姿势一直悬在空中，和特效里的身体重叠。
    if (index === 0 && !frame.layers?.length) return;

    this.sprites.forEach((s) => s.destroy());
    this.sprites = [];

    const layers = [...(frame.layers ?? [])].sort((a, b) => a.depth - b.depth);
    let borrowed = false;
    layers.forEach((layer) => {
      const image = this.data.images?.find((i) => i.index === layer.image_index);
      const pose = image?.borrowed_hit_frame;
      if (pose && this.borrowUnit) {
        const key = this.borrowUnit.def.hurt;
        const data = this.scene.cache.json.get(`${key}-anim`);
        for (const other of data?.frames?.[pose]?.layers ?? []) {
          const part = data.images?.find((i) => i.index === other.image_index);
          if (!part) continue;
          const placed = { ...other, depth: layer.depth, blend: layer.blend, alpha: layer.alpha,
            x: layer.x + Math.trunc((image.real_size?.[0] ?? image.width) / 2) - Math.trunc(part.width / 2),
            y: layer.y + Math.trunc((image.real_size?.[1] ?? image.height) / 2) - Math.trunc(part.height / 2) };
          borrowed = this.drawLayer(key, placed, this.borrowUnit) || borrowed;
        }
      } else this.drawLayer(this.key, layer);
    });
    if (this.borrowedUnit && (!borrowed || this.borrowedUnit !== this.borrowUnit)) {
      this.borrowedUnit.releaseBorrow(this);
      this.borrowedUnit = null;
    }
    if (borrowed) {
      this.borrowedUnit = this.borrowUnit;
      this.borrowedUnit.holdBorrow(this);
    }
  }

  setDisplayOffset(x, y) {
    for (const sprite of this.sprites) {
      sprite.x += x - this.displayOffset.x;
      sprite.y += y - this.displayOffset.y;
    }
    this.displayOffset = { x, y };
  }

  drawLayer(key, layer, borrowedFrom = null) {
    const atlas = Boolean(this.scene.cache.json.get(`${key}-anim`)?.atlas);
    const textureKey = atlas ? key : `${key}-img${layer.image_index}`;
    if (!this.scene.textures.exists(textureKey)) {
      warnOnce(`sf2-tex:${textureKey}`, `动画 ${this.key} 缺少贴图 ${textureKey}`);
      return false;
    }
    const frameName = atlas ? `img_${String(layer.image_index).padStart(3, '0')}` : undefined;
    if (frameName && !this.scene.textures.get(textureKey).has(frameName)) {
      warnOnce(`sf2-frame:${textureKey}:${frameName}`, `动画 ${this.key} 缺少图集帧 ${frameName}`);
      return false;
    }
    const sprite = useXbr(this.scene.add.image(layer.x - this.originX + this.displayOffset.x, layer.y - this.originY + this.displayOffset.y, textureKey, frameName));
    sprite.setOrigin(0, 0).setBlendMode(resolveBlend(layer.blend)).setAlpha(resolveAlpha(layer));
    sprite.borrowedFrom = borrowedFrom;
    sprite.layerAlpha = resolveAlpha(layer);
    if (borrowedFrom) sprite.setAlpha(sprite.layerAlpha * borrowedFrom.visualAlpha);
    this.container.add(sprite);
    this.sprites.push(sprite);
    return true;
  }

  update(_time, delta) {
    this.sprites.forEach(s => { if (s.borrowedFrom) s.setAlpha(s.layerAlpha * s.borrowedFrom.visualAlpha); });
    if (!this.playing || this.frameCount === 0) return;

    this.elapsed += delta;
    const frame = this.frames[this.frameIndex];
    const holdMs = Math.max(1, frame?.duration ?? 1) * TICK_MS;
    if (this.elapsed < holdMs) return;

    this.elapsed -= holdMs;
    const next = this.steps ? this.stepIndex + 1 : this.frameIndex + 1;

    if (next >= (this.steps?.length ?? this.frameCount)) {
      if (!this.loop) {
        this.playing = false;
        this.borrowedUnit?.releaseBorrow(this);
        this.borrowedUnit = null;
        this.onComplete?.();
        return;
      }
      this.stepIndex = 0;
      this.frameIndex = this.steps?.[0]?.index ?? 0;
    } else {
      this.stepIndex = next;
      this.frameIndex = this.steps ? this.steps[next].index : next;
    }
    if (this.steps) this.onStep?.(this.steps[this.stepIndex]);
    this.renderFrame(this.frameIndex);
  }

  destroy() {
    this.borrowedUnit?.releaseBorrow(this);
    this.borrowedUnit = null;
    this.sprites.forEach((s) => s.destroy());
    this.container.destroy();
  }
}
