/**
 * 被挡住的人：**照原作的做法，把他的贴图按棋盘格抽掉一半再画在最上层。**
 *
 * ── 判据 ──
 * 原作截图（凉州城集市，用户 2026-09-13 提供）里，夏侯仪与旁边的路人走到
 * 凉棚后面时**身上是一片网点** —— 不是半透明、不是描边，是**点阵抖动**：
 * 一半像素露出来、一半让位给挡住他的东西。2001 年的常用做法。
 *
 * 此前我们自造了一套「半透明残影」（`GHOST_ALPHA=0.34` + 白名单 + 覆盖率
 * 门槛），三个数全是调出来的，而且**只统计 MK 像素** —— 被「场景对象」挡住时
 * 覆盖率恒为 0，于是人走到伞后面整个消失、连残影都没有。整套已删。
 *
 * ── 为什么这个做法不需要「判断有没有被挡住」──
 * 抽掉一半像素的副本画在**同一个位置**上：
 *
 * | 情况 | 结果 |
 * |---|---|
 * | 没被挡 | 副本盖在本体自己身上，**像素完全一样 → 看不出来** |
 * | 被挡住 | 副本盖在遮挡物上，露出半数像素 → **网点人形** |
 * | 挡住一半 | 两边各自正确 |
 *
 * 所以不需要覆盖率、不需要门槛、不需要白名单 —— 那三样正是上一版的全部毛病。
 * 只保留一个**便宜的门**（`maybeBehind`）：决定要不要为这条精灵生成贴图，
 * **门宽一点无所谓**，误判的代价只是白生成一张纹理，画面上看不出来。
 *
 * ── 棋盘格的相位取世界坐标 ──
 * ⚠️ **不能按贴图自己的左上角算。** 两个人一前一后站着时，前面那个的网点
 * 必须正好盖住后面那个的网点，否则后面的人会从前面的人身上透出来。
 * 判据是「同一个世界像素，两张副本要么都保留、要么都抽掉」——
 * 所以相位 = `(贴图世界左上角 x + y) & 1`，缓存两份。
 */
import Phaser from 'phaser';
import { warnOnce } from './warnOnce.js';
import DEPTH from './depths.js';
import { GHOST_PIPELINE, ghostMaskFor } from './ghostPipeline.js';

/**
 * 网点副本的绘制深度，**出处只有 `depths.js`**。
 *
 * ⚠️ **不能写死成一个小数字。** 场上精灵的深度就是它在地图上的 y，
 * 而最高的一张图有 2640 —— 第一版写的 1500 在 `MP1101` 上直接失效：
 * 屋顶（y=2150）压在虚影上面，人被挡住了却看不见网点。
 *
 * ⚠️ 同一层里**再按 y 微调**（`+ y / 1e5`），这样两个人重叠时，前面那个的
 * 网点压在后面那个的网点上 —— 配合「相位取世界坐标」，重叠处看到的
 * 就是前面那个人的完整身体。
 */
export const GHOST_DEPTH = DEPTH.GHOST;

/** 深度微调的分母：地图最高 2640，除以 1e5 远小于 1，不会串到别的层。 */
const DEPTH_NUDGE = 1e5;

/**
 * 遮挡覆盖层画在**它自己的 y 之上**这么多 —— 必须与
 * `systems/occlusion.js` 的 `DEPTH_ABOVE_OWNER` 一致。
 */
const MK_COVER_DEPTH = 0.5;

/** 网点再压在遮挡之上这么一点点。够它盖住遮挡，又不至于跨过下一个整数 y。 */
const GHOST_ABOVE_OCCLUDER = 0.1;

/** 镜头外多少像素内仍画网点：盖住一帧的镜头滚动（跑步一帧约 5px）还绰绰有余。 */
const VIEW_MARGIN = 64;

/** 纹理键：抽掉一半像素的那一份。相位两种，各缓存一张。 */
export function ditherKey(texKey, frameName, phase) {
  return `dither:${phase}:${texKey}:${frameName ?? '_'}`;
}

/**
 * 造一张「按棋盘格抽掉一半像素」的纹理，已经有就直接用。
 *
 * ⚠️ **只剩兜底用**：WebGL 且有遮挡贴图时，网点由显卡管线逐像素判（`ghostPipeline.js`），
 * 不再生成副本。这里只服务 Canvas 渲染器或缺遮挡贴图的图。
 *
 * @param {Phaser.Scene} scene
 * @param {string} texKey 源纹理键
 * @param {string|undefined} frameName 图集帧名；旧结构（一帧一张图）不传
 * @param {0|1} phase 棋盘格相位，见模块文档
 * @returns {string|null} 纹理键；源贴图取不到时返回 null（**并留一行日志**）
 */
export function ditheredTexture(scene, texKey, frameName, phase) {
  const outKey = ditherKey(texKey, frameName, phase);
  if (scene.textures.exists(outKey)) return outKey;

  const frame = scene.textures.getFrame(texKey, frameName);
  if (!frame?.cutWidth || !frame?.cutHeight) {
    // 兜底跳过要出声（判据表 F 组）：静默的话表现是「人被挡住就彻底消失」。
    warnOnce(`ghost:${outKey}`, `网点副本建不起来：${texKey}/${frameName ?? '-'}`);
    return null;
  }

  const { cutX, cutY, cutWidth, cutHeight } = frame;
  // ⚠️ **必须用 willReadFrequently 的 CPU 画布读写像素。** Phaser createCanvas 的画布默认
  // 显卡加速，getImageData 会逼浏览器等显卡并把像素搬回内存，每次卡主线程数十毫秒。
  // 沙洲城上百个NPC动画帧陆续需要网点副本，实测走路掉到约15帧/秒、81%时间耗在这里（2026-09-27）。
  const cpu = document.createElement('canvas');
  cpu.width = cutWidth;
  cpu.height = cutHeight;
  const ctx = cpu.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(frame.source.image, cutX, cutY, cutWidth, cutHeight,
                0, 0, cutWidth, cutHeight);

  const pixels = ctx.getImageData(0, 0, cutWidth, cutHeight);
  const data = pixels.data;
  for (let y = 0; y < cutHeight; y += 1) {
    for (let x = 0; x < cutWidth; x += 1) {
      if (((x + y + phase) & 1) === 0) continue;   // 留下的那一半
      data[(y * cutWidth + x) * 4 + 3] = 0;        // 抽掉的那一半
    }
  }
  ctx.putImageData(pixels, 0, 0);
  const canvas = scene.textures.addCanvas(outKey, cpu);
  // ⚠️ **运行时新建的画布纹理不继承 `pixelArt` 的 NEAREST。**
  // 不设的话它按 LINEAR 采样：保留的那半像素会和旁边**被抽掉的透明像素**
  // 插值，混出一圈半透明边 —— 画面上就是「网点那半发暗」，
  // 在深色的门板、屋顶上尤其刺眼。实测差值正好是整片棋盘格，
  // 而纹理内容与源帧**逐像素完全相同**（1111/1111），一度以为是错位。
  canvas.setFilter(Phaser.Textures.FilterMode.NEAREST);
  return outKey;
}

/** 两个轴对齐矩形相交。边挨着不算。 */
export function overlaps(a, b) {
  return a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
}

/**
 * 一张图里所有「可能挡住人」的东西。
 *
 * 这是**便宜的门**，不是精确判定：用各帧并集的包围盒 + 「y 更大才画在前面」。
 * 宽一点无所谓（见模块文档），所以不做逐像素。
 */
export default class GhostLayer {
  /**
   * @param {Phaser.Scene} scene
   * @param {{bits: Uint8Array, width: number, height: number}|null} mk
   *   MK 遮挡掩码。**对象之外还有它** —— 屋顶那种大片美术不是对象。
   * @param {string|null} maskTexture 遮挡层贴图键（`<图号>-occlusion`）。
   *   网点只许出现在遮挡层有像素的地方，见下面「只留在遮挡层上」。
   */
  constructor(scene, mk = null, maskTexture = null, container = null) {
    this.scene = scene;
    this.mk = mk;
    this.container = container;
    /**
     * **网点只许出现在真正被挡住的像素上** —— 按遮挡层裁。
     *
     * `maybeBehind()` 是一道**故意放宽**的门（包围盒 + 8px 抽样），网点又画在遮挡物之上；
     * 不裁的话，误判的棋盘格会盖到**站在空地上的别人**身上（用户 2026-09-19 肅州城门口：
     * `guard_left`/`guard_right` 在城门洞下，主角走到跟前被糊上网点）。
     * 遮挡贴图与地面同坐标、同尺寸，裁剪在显卡管线里逐像素做（`ghostPipeline.js`）。
     * 取不到（非 WebGL、没有遮挡贴图）时为 null：退回 CPU 网点副本、不裁 —— 顶多是老样子。
     */
    this.mask = ghostMaskFor(scene, maskTexture);
    if (!this.mask && maskTexture) warnOnce('ghost-clip', '网点虚影用不了显卡管线，退回不裁剪的网点副本');
    /** @type {Array<{y: number, left: number, top: number, right: number, bottom: number}>} */
    this.boxes = [];
    /** 每个角色一张副本。键由调用方给（主角 `'player'`，NPC 用对象序号）。 */
    this.ghosts = new Map();
  }

  /** 场上对象的包围盒，建完演员之后调一次。**不可变**：整张表换掉，不改原表。 */
  setOccluders(boxes) {
    this.boxes = Object.freeze(boxes.slice());
  }

  /**
   * 这个位置**可能**被挡住吗。宽一点没关系，见模块文档。
   *
   * ⚠️ MK 那一半要看**掩码本身**，不能看 `Occluder.coverage` ——
   * 那是上一版的错：它只统计 MK，于是被对象挡住时恒为 0。
   */
  maybeBehind(box, y) {
    return this.occluderDepth(box, y) != null;
  }

  /**
   * **挡住他的东西画在哪一层** —— 网点要紧贴在它上面，返回 `null` 表示没被挡。
   *
   * ⚠️ ⚠️ **网点不能画在「所有精灵之上」。** 上一版用固定的
   * `DEPTH.GHOST`（2700+，高过全库最高的地图 y=2640），理由是「要盖过屋顶」。
   * 可这样一来，**站在他前面的人也盖不住他的网点** —— 画面上就是
   * 「两个人一重叠，后面那个的棋盘格糊在前面那个身上」。
   * 用户 2026-09-19 在肅州城门口连报三次。
   *
   * 原作的层次其实很直白：**网点紧跟在挡住他的那个东西后面画**。
   * 于是「比那个东西更靠前的人」自然盖得住它。对照 `occlusion.js`：
   * 每个人的遮挡覆盖层画在 `他自己的 y + 0.5`，同一条道理。
   *
   * 两种遮挡各自的层：
   *
   * * **MK 地面遮挡**（屋顶、城墙那种画进地面的）—— 覆盖层在 `他的 y + 0.5`
   * * **场景对象**（伞、柱子）—— 对象精灵在 `对象的 y`
   */
  occluderDepth(box, y) {
    let best = null;
    const bump = (v) => { best = best == null ? v : Math.max(best, v); };
    if (this.mk && this.mkTouches(box)) bump(y + MK_COVER_DEPTH);
    for (const o of this.boxes) {
      if (o.visible !== false && o.y > y && overlaps(box, o)) bump(o.y);
    }
    return best;
  }

  /** MK 在这块包围盒里有没有画东西。**按 8px 步长抽样**就够 —— 这只是道门。 */
  mkTouches(box) {
    const { bits, width, height } = this.mk;
    const x0 = Math.max(0, Math.floor(box.left));
    const x1 = Math.min(width - 1, Math.ceil(box.right));
    const y0 = Math.max(0, Math.floor(box.top));
    const y1 = Math.min(height - 1, Math.ceil(box.bottom));
    for (let y = y0; y <= y1; y += 8) {
      const row = y * width;
      for (let x = x0; x <= x1; x += 8) {
        if (bits[row + x]) return true;
      }
    }
    return false;
  }

  /**
   * 画（或撤掉）一个角色的网点副本。
   *
   * @param {string|number} id 角色标识，同一个角色每次传同一个
   * @param {object} sprite `FieldSprite`
   * @param {{left,top,right,bottom}} box 该角色各帧并集的包围盒（已含世界坐标）
   * @param {number} y 脚下的 y，用来和遮挡物比前后
   */
  paint(id, sprite, box, y) {
    const image = sprite?.mainImage;
    const live = Boolean(image && image.visible && !sprite.hidden) && this.onScreen(box);
    const occY = live ? this.occluderDepth(box, y) : null;
    if (occY == null) {
      this.ghosts.get(id)?.setVisible(false);
      return;
    }

    const { key, frame } = sprite.mainFrame;
    if (!key) { this.ghosts.get(id)?.setVisible(false); return; }

    // 显卡管线：直接用本体的贴图与帧，抽半与裁剪在着色器里做。兜底：CPU 网点副本。
    let texture = key;
    let frameName = frame;
    if (!this.mask) {
      const phase = (Math.round(image.x) + Math.round(image.y)) & 1;
      texture = ditheredTexture(this.scene, key, frame, phase);
      frameName = undefined;
      if (!texture) { this.ghosts.get(id)?.setVisible(false); return; }
    }

    let ghost = this.ghosts.get(id);
    if (!ghost) {
      // 懒建：一张图上百个精灵，大多数一辈子不会被挡住。
      ghost = this.scene.add.image(image.x, image.y, texture, frameName).setOrigin(0, 0);
      if (this.mask) {
        ghost.setPipeline(GHOST_PIPELINE);
        ghost.ghostMask = this.mask;
      }
      this.container?.add(ghost);
      this.ghosts.set(id, ghost);
    }
    ghost
      .setVisible(true)
      .setTexture(texture, frameName)
      .setPosition(image.x, image.y)
      // ⭐ **紧贴挡住他的那个东西**，不是压在所有精灵之上 —— 见 `occluderDepth`。
      // 再按自己的 y 微调，好让两个都被挡住的人之间也有先后。
      .setDepth(occY + GHOST_ABOVE_OCCLUDER + y / DEPTH_NUDGE);
  }

  /**
   * 在镜头里（含 VIEW_MARGIN 余量）吗。**Phaser 不会替我们跳过镜头外的物体**：
   * 沙洲城街上同时 29 个网点人影，多数在画面外，照样每个切一次管线、画一次，
   * Intel UHD 630 上把一帧撑过 16.7ms 掉到 30 帧（2026-09-27 实测）。
   * 这里读的是上一帧的镜头位置，余量盖得住一帧的滚动。
   */
  onScreen(box) {
    const view = this.scene.cameras?.main?.worldView;
    if (!view) return true;
    return box.right > view.x - VIEW_MARGIN && box.left < view.right + VIEW_MARGIN
      && box.bottom > view.y - VIEW_MARGIN && box.top < view.bottom + VIEW_MARGIN;
  }

  /** 切图/重建场景时清干净，否则上一张图的网点会留在屏幕上。 */
  destroy() {
    for (const ghost of this.ghosts.values()) ghost.destroy();
    this.ghosts.clear();
    this.boxes = [];
    this.mask = null;
  }
}
