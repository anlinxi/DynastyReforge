import { useHdTexture } from '../hd/hdRender.js';

/**
 * 遮挡：把该挡在人物前面的那部分地面美术，重新画到人物上方。
 *
 * ── 为什么需要它 ──
 * 这是 2.5D 斜视角，屏幕上看着像"屋顶"的位置，其实是那栋建筑**背后的地面**。
 * 人物走到那儿本来就走得过去，只是应当被建筑挡住。没有遮挡时人物被画在屋顶
 * 之上，看着像爬上了房顶。
 *
 * ── 规则：MK 覆盖到的美术无条件盖在人物上方 ──
 * MK 圈的本来就只是**悬在可走地面之上**的那部分美术——屋顶、屋檐、伞盖、
 * 栏杆。人站进它的屏幕范围，就意味着人在它下面或后面。
 *
 * > 试过更"讲道理"的做法：把 MK 切成物件、记下每件的墙根，只有墙根比脚下
 * > 更靠下才遮。结果更差——同一列上屋顶、墙、底下的凉棚是一整段连续像素，
 * > 墙根取到最下面那个，整片屋顶都会盖到人身上；为此加的"墙根突变处断开"
 * > 又把连续结构从中间劈开，人被一条竖直直线切成两半。实机对比后改回无条件。
 *
 * ── ⚠️ MK 只是遮挡的一条腿 ──
 * MK 盖不全（`MP0401` 24.0%、`MP1101` 27.1%）。集市的伞、城墙、门楼都不在
 * MK 里 —— 那些是 `.SCI` 对象表里的精灵，靠 `FieldSprite` 的 `y` 深度排序
 * 挡人，**不走这个模块**。所以这里覆盖率为 0 不代表人没被挡住
 * （`paintGhost` 正是这么误判的，见 docs/状态/待办.md §4a）。
 * 原委：docs/专题/通行与遮挡.md
 *
 * ── 实现 ──
 * 遮挡只对人物有意义，所以不铺满全屏，而是给每个精灵配一小块跟随它的画布，
 * 只重画精灵自己那点范围（约 64×96）。静止的 NPC 只算一次。
 */

/** 覆盖层压在自己那个精灵上方，但仍要低于站得更靠前（y 更大）的精灵。 */
const DEPTH_ABOVE_OWNER = 0.5;

/** 精灵没有帧信息时的兜底包围盒，够罩住常见的人物贴图。 */
const FALLBACK_BOX = Object.freeze({
  left: -40, top: -110, right: 40, bottom: 8,
});

/**
 * 精灵各帧**相对对象坐标**的并集包围盒。
 *
 * ⚠️ **必须把绘制偏移加进来。** `sprite.json` 的 `ox/oy` 现在是 SF2 的
 * **原始图层坐标**（三百上下），不是"相对脚底的小偏移"——
 * 真正的位置是 `对象(x,y) + 绘制偏移(dx,dy) + (ox,oy)`，见 `FieldSprite`。
 * 不加偏移的话采样窗口整个跑到人物右下几百像素处，**遮挡全部失效**。
 *
 * ⚠️ **空帧要跳过。** 它们只有 `{empty, dur}`，没有 `ox/w`；
 * `?? 0` 会把 `left` 硬拉到 0，同样毁掉窗口。
 */
export function spriteBox(frames, draw) {
  const dx = draw?.x ?? 0;
  const dy = draw?.y ?? 0;
  const usable = (frames ?? []).filter((f) => !f.empty && Number.isFinite(f.ox));
  if (!usable.length) return FALLBACK_BOX;
  return usable.reduce((box, f) => ({
    left: Math.min(box.left, f.ox + dx),
    top: Math.min(box.top, f.oy + dy),
    right: Math.max(box.right, f.ox + dx + (f.w ?? 0)),
    bottom: Math.max(box.bottom, f.oy + dy + (f.h ?? 0)),
  }), {
    left: Infinity, top: Infinity, right: -Infinity, bottom: -Infinity,
  });
}

/** 一个精灵专用的覆盖层。 */
class Occluder {
  constructor(layer, key, box) {
    this.layer = layer;
    this.box = box;
    this.width = Math.max(1, Math.ceil(box.right - box.left));
    this.height = Math.max(1, Math.ceil(box.bottom - box.top));
    /** 上一次重画时，包围盒里有多大比例被遮住。给残影用。 */
    this.coverage = 0;

    // 场景重启时同名画布还在，先撤掉，否则 createCanvas 拿不到新贴图
    if (layer.scene.textures.exists(key)) layer.scene.textures.remove(key);
    // 高清试做：画布按高清底图的倍数建，显示时缩回原尺寸（掩码判断仍按原像素）
    this.hdScale = layer.hd?.scale ?? 1;
    this.texture = layer.scene.textures.createCanvas(key, this.width * this.hdScale, this.height * this.hdScale);
    this.image = layer.scene.add.image(0, 0, key).setOrigin(0, 0).setVisible(false);
    if (layer.hd) useHdTexture(this.image.setScale(1 / this.hdScale));
    layer.container?.add(this.image);
    this.lastX = null;
    this.lastY = null;
  }

  /**
   * 按人物当前站位重算覆盖层。位置没变就不重画。
   * @param {number} x 地图坐标（脚底锚点）
   * @param {number} y
   */
  update(x, y) {
    const ix = Math.round(x);
    const iy = Math.round(y);
    this.image.setPosition(ix + this.box.left, iy + this.box.top);
    this.image.setDepth(y + DEPTH_ABOVE_OWNER);
    if (ix === this.lastX && iy === this.lastY) return;

    this.lastX = ix;
    this.lastY = iy;
    this.redraw(ix, iy);
  }

  redraw(feetX, feetY) {
    const { bits, ground, mapWidth, mapHeight } = this.layer;
    const ctx = this.texture.context;
    const s = this.hdScale;
    // 高清：先按原掩码做一张 1 倍遮罩（只填 alpha），再从高清底图剪一块、用遮罩裁；不读回整张高清像素
    const pixels = ctx.createImageData(this.width, this.height);
    const out = pixels.data;

    const originX = feetX + this.box.left;
    const originY = feetY + this.box.top;
    let covered = 0;

    for (let row = 0; row < this.height; row += 1) {
      const worldY = originY + row;
      if (worldY < 0 || worldY >= mapHeight) continue;
      const worldRow = worldY * mapWidth;
      const outRow = row * this.width;

      for (let col = 0; col < this.width; col += 1) {
        const worldX = originX + col;
        if (worldX < 0 || worldX >= mapWidth) continue;

        const src = worldRow + worldX;
        if (!bits[src]) continue;

        const d = (outRow + col) * 4;
        if (s === 1) {
          const g = src * 4;
          out[d] = ground[g];
          out[d + 1] = ground[g + 1];
          out[d + 2] = ground[g + 2];
        }
        out[d + 3] = 255;
        covered += 1;
      }
    }

    this.coverage = covered / (this.width * this.height);
    this.image.setVisible(covered > 0);
    if (!covered) return;
    if (s === 1) ctx.putImageData(pixels, 0, 0);
    else this.drawHd(ctx, pixels, originX, originY);
    this.texture.refresh();
  }

  /** 高清：剪下高清底图对应的一块，再用 1 倍遮罩（最近邻放大）裁出被遮住的部分。 */
  drawHd(ctx, maskPixels, originX, originY) {
    const { image, scale: s } = this.layer.hd;
    const { mapWidth, mapHeight } = this.layer;
    if (!this.maskCanvas) {
      this.maskCanvas = document.createElement('canvas');
      this.maskCanvas.width = this.width;
      this.maskCanvas.height = this.height;
    }
    this.maskCanvas.getContext('2d').putImageData(maskPixels, 0, 0);
    ctx.clearRect(0, 0, this.width * s, this.height * s);
    // 只剪地图范围内的部分（包围盒可能伸出地图边）
    const x0 = Math.max(0, originX), y0 = Math.max(0, originY);
    const x1 = Math.min(mapWidth, originX + this.width), y1 = Math.min(mapHeight, originY + this.height);
    if (x1 <= x0 || y1 <= y0) return;
    ctx.globalCompositeOperation = 'source-over';
    ctx.drawImage(image, x0 * s, y0 * s, (x1 - x0) * s, (y1 - y0) * s,
      (x0 - originX) * s, (y0 - originY) * s, (x1 - x0) * s, (y1 - y0) * s);
    ctx.globalCompositeOperation = 'destination-in';
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(this.maskCanvas, 0, 0, this.width * s, this.height * s);
    ctx.globalCompositeOperation = 'source-over';
  }

  destroy() {
    this.image.destroy();
  }
}

export default class OcclusionLayer {
  /**
   * @param {Phaser.Scene} scene
   * @param {{bits: Uint8Array, width: number, height: number}} mask 逐像素遮挡掩码
   * @param {{data: Uint8ClampedArray}} ground 地面美术像素
   */
  constructor(scene, mask, ground, id = 0, container = null, hd = null) {
    this.scene = scene;
    /** 高清试做：{scale, width, height, image}（高清底图的源图），尺寸须是掩码的整数倍，否则不用 */
    this.hd = hd && hd.width === mask.width * hd.scale && hd.height === mask.height * hd.scale ? hd : null;
    this.bits = mask.bits;
    this.mapWidth = mask.width;
    this.mapHeight = mask.height;
    this.ground = ground.data;
    this.serial = 0;
    this.id = id;
    this.container = container;
  }

  /** 两张图尺寸对不上就别硬来，宁可不遮也不要错位。 */
  static usable(mask, ground) {
    return Boolean(mask && ground
      && mask.width === ground.width && mask.height === ground.height);
  }

  /**
   * 给一个精灵挂上覆盖层。
   * @param {{frames?: Array}} spriteData 精灵清单，用来定包围盒
   * @param {{x: number, y: number}} draw 绘制偏移，见 `spriteBox`
   */
  attach(spriteData, draw = null) {
    this.serial += 1;
    return new Occluder(this, `occluder-${this.id}-${this.serial}`,
                        spriteBox(spriteData?.frames, draw));
  }
}
