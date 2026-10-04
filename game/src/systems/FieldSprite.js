import { playSfx } from './audioSettings.js';
import { useXbr } from '../hd/hdRender.js';
import Phaser from 'phaser';

/**
 * 走一步跨多少像素 —— 行走动画每推进一帧对应的位移。
 *
 * 🅓 手感值：原作没给「一帧走多远」这个数（`WALK_SPEED` 本身也是我们定的）。
 * 取 22 是让腿的频率与 165 px/s 的移动速度看着协调，改它只影响观感。
 *
 * ⚠️ **跑步要用更大的步长**，不能和走路共用。跑是 1.8 倍速度，
 * 共用步长的话步频也变成 1.8 倍 —— 腿倒腾得比走路夸张得多。
 * 真人跑起来是**步幅变大、步频只稍快**，所以这里给 1.4 倍步幅，
 * 剩下的 1.29 倍落到步频上。
 */
export const STRIDE_PX = 22;
export const RUN_STRIDE_PX = Math.round(STRIDE_PX * 1.4);

// 帧时长的换算率与战斗动画共用，见下面 TICK_MS 处的说明。
import { TICK_MS } from './SF2Animator.js';
import { NAMED_BLEND } from './blendModes.js';
import { warnOnce } from './warnOnce.js';
import { SHOW_SHADOWS } from '../config.js';
import DEPTH from './depths.js';

/**
 * 场景人物精灵。
 *
 * 素材由 tools/export_sprite.py 导出，已把原作的画面绝对坐标
 * 归一化成「脚底锚点」——每帧记录相对锚点的 ox/oy。
 * 因此只要把容器放在地图坐标上，贴图就会正确地站在那里，
 * 不需要再做任何人工偏移（早先用战斗素材占位时靠硬编码偏移抵消，
 * 导致判定位置与观感相差数百像素）。
 *
 * ── 一条精灵里装的不是一段动画 ──
 * 一个 SF2 含多个动作段，行走段里又按朝向分组。整条从头播到尾，
 * 人物就会自己转圈、还时不时伸懒腰——务必用 playSegment 播指定区间。
 * 分段规则见 systems/spriteLayout.js。
 */

/**
 * 原作一个时长单位对应的毫秒数。
 *
 * ⚠️ **必须与 `SF2Animator` 用同一个值。** 这里读的是同一个 SF2 字段
 * （帧头 `+0x22`「该帧播放时长」），战斗动画与对话框展开都按 55ms 换算，
 * 而这里曾经写成 110 —— 于是**只有场景与过场动画慢了整整一倍**：
 * 废屋那段「夏侯仪走到屋中间」是 20 帧、合计 60 刻，按 110 要走 6.6 秒，
 * 看起来就是慢动作。同一个字段不该有两种换算率，所以直接从那边引用
 * （见文件顶部的 import），这里不再另立常量。
 */

/**
 * 过场素材的绘制深度。地图精灵按 y 排序，最大不超过地图高度（1800）。
 *
 * ⚠️ **必须低于对话立绘**（`DialogueBox` 的 `DEPTH_PORTRAIT = 2050`）。
 * 早先取 100000，过场画面就盖在立绘与对话框之上了 ——
 * 立绘本来该压住场上的一切。
 */
/** 帧内嵌音效的音量。原作没有这个数，取与战斗一致的 0.8。 */
const SFX_VOLUME = 0.8;

const CUTSCENE_DEPTH = DEPTH.CUTSCENE;

/** 没有 SCI 记录时的绘制偏移（主角、队友这些来自共享库的精灵）。 */
const DEFAULT_DRAW_X = -320;
const DEFAULT_DRAW_Y = -260;

export default class FieldSprite {
  /**
   * @param {Phaser.Scene} scene
   * @param {string} key   资源键，同 assets/sprites 下的目录名
   * @param {number} x     地图坐标
   * @param {number} y
   */
  constructor(scene, key, x, y, draw = null, topmost = false, showShadow = false) {
    this.scene = scene;
    this.key = key;
    this.data = scene.cache.json.get(`${key}-sprite`);
    this.frames = this.data?.frames ?? [];

    this.x = x;
    this.y = y;
    this.start = 0;
    this.count = this.frames.length;
    this.loop = false;
    this.playing = false;
    this.frameIndex = 0;
    this.elapsed = 0;
    this.onDone = null;

    /**
     * **绘制偏移**，来自 SCI 的 `+108`（`map.json` 的 `dx/dy`）。
     *
     * 原作的定位公式：**位置 = 对象 (x,y) ＋ 绘制偏移 ＋ SF2 图层坐标**。
     * 精灵导出时锚点取 (0,0)，所以 `ox/oy` 就是原始图层坐标，三项一加才是位置。
     *
     * ⚠️ **偏移不是常量**：绝大多数 `(-320,-260)`，废屋「動畫第二段」是
     * `(-320,-160)`。也**不能拿脚底锚点近似** —— 那对人物差 0~9 像素看不出来，
     * 对大摆件就露馅（马车后半横向差 32 像素，看着像车裂成两块）。
     *
     * 主角与队友的精灵来自共享库、没有 SCI 记录，用通行的 `(-320,-260)`。
     */
    this.draw = draw ?? { x: DEFAULT_DRAW_X, y: DEFAULT_DRAW_Y };
    /**
     * 压在最上层。**给剧情道具用**（`showWithMap === 0` 的那些）——
     * 过场画面本来就该盖住场景。
     *
     * ⚠️ 不能按「帧宽超过某个数」去判：药铺老板那条是 256×240
     * （柜台连人一起画的），照那个判据会被压到最上层，挡住整间屋子。
     */
    this.topmost = Boolean(topmost);
    this.showShadow = showShadow;
    /**
     * 外部要求的隐藏（剧情的 `actor_hide`）。
     *
     * ⚠️ **不能直接改 `image.visible`** —— `applyFrame` 每次换帧都要根据
     * 「这一帧是不是空帧」重设可见性，会把外部的隐藏冲掉。
     * 废屋那段第一、二段动画就是这么叠在一起的：脚本第 66 条明明
     * `actor_hide 動畫第一段`，可第二段一播帧，第一段又被显示回来。
     */
    this.hidden = false;

    /**
     * **一帧可以有多层**（影子 + 人物；过场动画最多 13 层），所以这里是一组贴图，
     * 不是一张。层数随帧变，按需增减，不是每帧重建 —— 换帧很频繁。
     *
     * ⚠️ **旧结构（整帧合成成一张 PNG）仍然认**：`sprite.json` 里没有 `images`
     * 的就是旧的。九张地图不可能一次全重导，中间那段时间两种结构会共存 ——
     * 只认新的会让没重导的图整个画不出来，而且不报错。
     */
    this.layered = Array.isArray(this.data?.images);
    /**
     * 走图集还是逐张 PNG。
     *
     * 图集（`load.multiatlas`）下整条精灵**只有一个纹理 key**（就是 `this.key`），
     * 层与层之间靠**帧名** `img_003` 区分。逐张 PNG 时每层一个纹理 key。
     * 旧产物没有 `atlas` 字段，走后者 —— 换产物结构不能让没重导的图整个画不出来。
     */
    this.atlas = Boolean(this.data?.atlas);
    this.parts = [];

    // 地图人物按SCI的DisplayShadow启用原素材第零帧；主角显式启用。
    // 静态人物不根据尺寸猜测阴影，避免把人物画面误画在脚下。
    this.shadow = null;
    this.image = useXbr(scene.add.image(x, y, this.textureKey(0))); // 高清试做：人物走 xBR
    this.image.setOrigin(0, 0);
    this.image.setVisible(!this.layered);
    this.buildShadow();
    this.applyFrame(0);
  }

  /** 原素材阴影在脚点深度后方绘制，并随人物隐藏。 */
  buildShadow() {
    // 地图对象由SCI的DisplayShadow决定；UI精灵默认不画。主角/共享人物显式启用。
    if (!SHOW_SHADOWS || !this.showShadow || !this.layered) return;
    const layer = this.frames[0]?.layers?.[0];
    if (!layer) return;
    const img = this.scene.add.image(0, 0, this.imageKey(layer.img)).setOrigin(0, 0);
    if (!this.setLayerTexture(img, layer.img)) {
      warnOnce(`fs-shadow:${this.key}`, `${this.key} 的影子层没预载，脚下不画影子`);
      img.destroy();
      return;
    }
    this.shadow = { img, layer };
    this.placeShadow();
  }

  /**
   * 把影子摆到脚下。位置公式与别的层一样：`位置 + 绘制偏移 + 图层坐标`。
   *
   * ⚠️ **`alpha` 与 `blend` 要照层里写的来。** 影子层自带 `alpha: 0.5`
   * （原作数据里就有），不套用的话地上是一坨**纯黑饼**，而不是半透的影子。
   * 第一版就漏了这一条，截图一看就露馅。
   */
  placeShadow() {
    if (!this.shadow) return;
    const { img, layer } = this.shadow;
    img.setPosition(this.x + this.draw.x + layer.ox, this.y + this.draw.y + layer.oy);
    img.setDepth((this.topmost ? CUTSCENE_DEPTH : this.y) - 0.01);
    img.setBlendMode(NAMED_BLEND[layer.blend ?? 'normal'] ?? NAMED_BLEND.normal);
    img.setAlpha(layer.alpha ?? 1);
    img.setVisible(!this.hidden);
  }

  /** 旧结构：一帧一张图。 */
  textureKey(index) {
    return `${this.key}-f${index}`;
  }

  /** 新结构：一层一张图，跨帧共享。**图集模式下整条精灵共用 `this.key`。** */
  imageKey(index) {
    return this.atlas ? this.key : `${this.key}-i${index}`;
  }

  /** 图集里的帧名。与 `pack_atlas.py` 写进 multiatlas 的 `filename` 一致。 */
  static frameName(index) {
    return `img_${String(index).padStart(3, '0')}`;
  }

  /** 给一个贴图对象换成第 `index` 层的图。返回是否换成功。 */
  setLayerTexture(img, index) {
    const key = this.imageKey(index);
    if (!this.scene.textures.exists(key)) return false;
    if (this.atlas) {
      const name = FieldSprite.frameName(index);
      if (!this.scene.textures.get(key).has(name)) return false;
      img.setTexture(key, name);
    } else {
      img.setTexture(key);
    }
    return true;
  }

  /** 多层地图的精灵在所属层内按y排序；界面仍在场景顶层。 */
  setSceneContainer(container) {
    this.sceneContainer = container;
    if (container) {
      // Phaser Container.add 会从传入数组中删掉已在容器里的对象。
      // 切图续演可能再次指定同层；逐个加入，不能让引擎改写人物持有的 parts。
      for (const part of this.parts) container.add(part);
      if (!this.layered) container.add(this.image);
      if (this.shadow) container.add(this.shadow.img);
    }
  }

  /** 需要几个贴图对象就备几个，多的销毁。 */
  ensureParts(n) {
    while (this.parts.length < n) {
      // 建的时候不指定帧 —— `applyLayers` 紧接着就会 `setLayerTexture`。
      const img = useXbr(this.scene.add.image(this.x, this.y, this.imageKey(0)));
      img.setOrigin(0, 0);
      this.parts.push(img);
      this.sceneContainer?.add(img);
    }
    while (this.parts.length > n) this.parts.pop().destroy();
  }

  get frameCount() {
    return this.frames.length;
  }

  /**
   * 帧上标记了音效就放一声。
   *
   * ⚠️ **这条线一度整个是空的**：场景精灵从来没导过内嵌音效
   * （`export_sprite.py` 里没有代码），这里也没有播放代码 ——
   * 于是废屋那段法术（`EVENT2-3`，6 条音效挂在帧 2/18/28/35/41/44）
   * 烧士兵时只有画面没有声音。战斗那边（`SF2Animator.playFrameSound`）
   * 一直是有的，两边差着一整条链。
   *
   * 全库 4102 个场景精灵里 265 个带音效，不是个别现象。
   */
  playFrameSound(frame) {
    const index = frame?.snd;
    if (index === undefined || index < 0) return;
    // ⚠️ **藏着的东西不该发声。** `actor_hide` 的语义就是「它不在场上了」，
    // 而帧音效原先不看 `hidden` —— 迦夏之窟那个机关修好后会循环播
    // （每轮一声「嘎吱」），剧情把它 `actor_hide` 之后声音还在响。
    if (this.hidden) return;
    const key = `${this.key}-snd${index}`;
    if (!this.scene.cache.audio.exists(key)) {
      // 兜底跳过要留日志（判据表）：少一声在画面上完全看不出来。
      // ⚠️ 用 warnOnce：这是**逐帧**路径，直接 warn 会每秒刷几十条，
      // 把控制台淹掉就等于没有日志。
      warnOnce(`fs-snd:${key}`, `${this.key} 帧音效 ${key} 没载入，这一声不响`);
      return;
    }
    playSfx(this.scene, key, { volume: SFX_VOLUME });
  }

  applyFrame(index) {
    const frame = this.frames[index];
    if (!frame) return;
    this.placeShadow();            // 影子跟着位置/深度/显隐走
    this.playFrameSound(frame);
    if (this.layered) { this.applyLayers(frame); return; }
    // 空帧（原作占位用）：只是不画，帧号照样往前走 —— 帧号必须与脚本对齐。
    this.image.setVisible(!this.hidden && !frame.empty);
    if (frame.empty) return;
    const key = this.textureKey(index);
    if (this.scene.textures.exists(key)) this.image.setTexture(key);
    this.image.setPosition(this.x + this.draw.x + frame.ox,
                           this.y + this.draw.y + frame.oy);
    this.image.setDepth(this.topmost ? CUTSCENE_DEPTH : this.y);
  }

  /**
   * 分层画一帧。**每层各自的混合模式** —— 这正是分层的全部意义。
   *
   * 废屋那段法术的 `image0` 是「中心金黄、四周纯黑」的全屏光晕、`subtract16`
   * （＝加亮），按加法画是屋里亮起金光；早先整帧合成时它被当半透明黑，
   * 在画面正中糊出一团暗块 —— 玩家说的「黑圈」。
   */
  applyLayers(frame) {
    const layers = frame.empty ? [] : (frame.layers ?? []);
    this.ensureParts(layers.length);
    const depth = this.topmost ? CUTSCENE_DEPTH : this.y;
    layers.forEach((l, i) => {
      const img = this.parts[i];
      // 兜底跳过要留日志（判据表）：素材没预载时这一层画不出来，别静默。
      if (!this.setLayerTexture(img, l.img)) {
        console.warn(`${this.key} 第 ${l.img} 层没预载，这一层不画`);
        img.setVisible(false);
        return;
      }
      img.setPosition(this.x + this.draw.x + l.ox, this.y + this.draw.y + l.oy);
      img.setDepth(depth);
      img.setBlendMode(NAMED_BLEND[l.blend ?? 'normal'] ?? NAMED_BLEND.normal);
      img.setAlpha(l.alpha ?? 1);
      img.setVisible(!this.hidden);
    });
  }

  /** 剧情的显隐。**走这里，不要直接改 `image.visible`**，见 `hidden`。 */
  setHidden(hidden) {
    this.hidden = Boolean(hidden);
    if (this.layered) { this.applyFrame(this.frameIndex); return this; }
    this.image.setVisible(!this.hidden && !this.frames[this.frameIndex]?.empty);
    return this;
  }

  setPosition(x, y) {
    this.x = x;
    this.y = y;
    this.applyFrame(this.frameIndex);
    return this;
  }

  /**
   * 播放一个帧区间。区间没变时不重置进度，避免每帧调用导致动画卡在首帧。
   * @param {number} start  起始帧
   * @param {number} count  帧数
   * @param {{loop?: boolean, onDone?: () => void, at?: number}} [options]
   *   at 指定从段内第几帧起播——同一张精灵的几个 NPC 若都从头开始，
   *   会整齐划一地同时抬手，看着像复制粘贴。
   */
  playSegment(start, count, options = {}) {
    const first = Phaser.Math.Clamp(start, 0, Math.max(this.frameCount - 1, 0));
    const length = Phaser.Math.Clamp(count, 1, this.frameCount - first);
    const unchanged = first === this.start && length === this.count && this.playing;
    this.start = first;
    this.count = length;
    this.loop = options.loop ?? true;
    // ⚠️ **换段时要把上一段的回调销掉。**
    //
    // 直接覆盖 `onDone` 会让「还在播」这个登记永远销不了号
    // （`cutscene.track` 靠它把动作从 `scene.running` 里移除）。
    // 攒下的僵尸会让之后每一条 `await_actions` 都空等到 15 秒上限，
    // 超时后一次性放行 —— 表现就是「小兵进门那段动画整个没了，
    // 一上来就是砍人」。被打断也算结束，照样通知一次。
    const interrupted = this.onDone;
    this.onDone = options.onDone ?? null;
    if (interrupted && interrupted !== this.onDone) interrupted();
    this.playing = length > 1;
    if (!unchanged) {
      const at = Phaser.Math.Clamp(Math.floor(options.at ?? 0), 0, length - 1);
      this.frameIndex = first + at;
      this.elapsed = 0;
      this.applyFrame(this.frameIndex);
    }
    return this;
  }

  /** 停在某一帧，不再走时序。 */
  hold(index) {
    this.playing = false;
    // 与 `playSegment` 同理：打断也要销号，否则 `await_actions` 会空等到超时。
    const interrupted = this.onDone;
    this.onDone = null;
    interrupted?.();
    this.start = index;
    this.count = 1;
    this.frameIndex = Phaser.Math.Clamp(index, 0, Math.max(this.frameCount - 1, 0));
    this.elapsed = 0;
    this.applyFrame(this.frameIndex);
    return this;
  }

  stop() {
    this.playing = false;
    return this;
  }

  /**
   * 按**走过的距离**推进一帧（行走/奔跑用）。
   *
   * ⚠️ **行走循环不能挂在墙钟上。** 帧时长 `TICK_MS` 是 SF2 自己的节拍，
   * 过场动画必须照它播；而走路的快慢由我们的 `WALK_SPEED` 决定 ——
   * 两者没有任何关系。挂在墙钟上的后果是：`TICK_MS` 一调，腿的频率就变，
   * 而人还是那个速度，于是「两条腿一直在倒腾」（把 110 改成 55 之后就是）。
   *
   * 按距离推进则永远对：一步跨 {@link STRIDE_PX} 像素，走多远迈多少步，
   * 不管速度怎么调都不会出现脚底打滑。
   *
   * @param {number} pixels 这一帧走了多少像素
   * @param {number} [stride] 一步跨多少像素（跑步比走路大，见 RUN_STRIDE_PX）
   */
  advance(pixels, stride = STRIDE_PX) {
    if (this.count < 2) return this;
    const span = Math.max(1, stride);
    this.walked = (this.walked ?? 0) + Math.abs(pixels);
    const steps = Math.floor(this.walked / span);
    if (!steps) return this;
    this.walked -= steps * span;
    this.frameIndex = this.start + ((this.frameIndex - this.start + steps) % this.count);
    this.applyFrame(this.frameIndex);
    return this;
  }

  update(_time, delta) {
    if (!this.playing || this.count < 2) return;
    this.elapsed += delta;
    const hold = Math.max(1, this.frames[this.frameIndex]?.dur ?? 1) * TICK_MS;
    if (this.elapsed < hold) return;

    this.elapsed -= hold;
    const next = this.frameIndex + 1;
    if (next < this.start + this.count) {
      this.frameIndex = next;
      this.applyFrame(this.frameIndex);
      return;
    }
    if (this.loop) {
      this.frameIndex = this.start;
      this.applyFrame(this.frameIndex);
      return;
    }
    this.playing = false;
    const done = this.onDone;
    this.onDone = null;
    done?.();
  }

  /**
   * **代表这条精灵的那张贴图**，给残影这类"复制一份当前画面"的用法。
   *
   * 分层之后 `this.image` 是个空壳（旧结构才用它），所以外部一律走这里。
   * 分层时取第一个可见的层 —— 影子在层 0、人物在层 1，取第一个可见的
   * 通常就是影子…… ⚠️ **取最后一个**：图层表顺序就是绘制顺序，
   * 最后画的那层压在最上面，也就是人物本体。
   */
  get mainImage() {
    if (!this.layered) return this.image;
    for (let i = this.parts.length - 1; i >= 0; i -= 1) {
      if (this.parts[i].visible) return this.parts[i];
    }
    return this.parts[this.parts.length - 1] ?? this.image;
  }

  /**
   * 当前该显示的**纹理键与帧名**，给残影这类「复制一份当前画面」的用法。
   *
   * ⚠️ **图集模式下必须连帧名一起给。** `scene.add.image(x, y, key)` 不传帧名时
   * Phaser 会取图集的**第一帧** —— 而人物精灵的 `img_000` 恰恰是**影子**
   * （`XIAHOUYI` 帧 0 是 37×15 的扁椭圆，帧 1 起才是人物）。
   * 于是残影画出来是一团黑圈，贴在人物贴图的左上角、看着像顶在脑袋上。
   * 这个坑 2026-09-05 的分层改造引入过一次。
   */
  get mainFrame() {
    const img = this.mainImage;
    return { key: img?.texture?.key, frame: this.atlas ? img?.frame?.name : undefined };
  }

  destroy() {
    this.parts.forEach((p) => p.destroy());
    this.parts = [];
    // ⚠️ 影子不在 `parts` 里（它是单独加的、要排在人物前面），得自己销毁 ——
    // 漏了就是「换形象/切图之后地上留着一圈黑影」。
    this.shadow?.img?.destroy();
    this.shadow = null;
    this.image.destroy();
  }
}
