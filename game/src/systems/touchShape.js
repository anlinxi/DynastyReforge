/**
 * 原作像素形状：鼠标命中用当前显示帧；通行/踩踏用双方第零帧。
 * 依据 RPG.exe 0x4080d0：mode=0 与 mode=1 选择不同帧。
 * 不透明像素参与判断，矩形只用于快速裁剪。脚印是否绘制成阴影不影响碰撞。
 */

/** 一条精灵的 alpha 缓存，键是纹理 key。跨对象共享（同一精灵常被用好几次）。 */
const pages = new WeakMap();

/** 整页图集的 alpha 位图。**一条精灵只读一次**，之后按帧切。 */
function pageAlpha(scene, key) {
  let byScene = pages.get(scene);
  if (!byScene) { byScene = new Map(); pages.set(scene, byScene); }
  if (byScene.has(key)) return byScene.get(key);

  let out = null;
  if (scene.textures?.exists?.(key)) {
    const source = scene.textures.get(key).getSourceImage();
    const { width, height } = source ?? {};
    if (width && height) {
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(source, 0, 0);
      const { data } = ctx.getImageData(0, 0, width, height);
      const bits = new Uint8Array(width * height);
      for (let i = 0; i < bits.length; i += 1) bits[i] = data[i * 4 + 3] > 0 ? 1 : 0;
      out = { width, height, bits };
    }
  }
  byScene.set(key, out);
  return out;
}

/** 图集里某一帧在页上的位置。逐张 PNG 时整张就是那一帧。 */
function cutOf(scene, key, frameName) {
  const tex = scene.textures?.get?.(key);
  if (!tex) return null;
  const frame = frameName ? tex.get(frameName) : tex.get();
  if (!frame) return null;
  return { x: frame.cutX ?? 0, y: frame.cutY ?? 0,
           w: frame.cutWidth ?? frame.width, h: frame.cutHeight ?? frame.height };
}

/** 帧名。与 `FieldSprite.frameName` / `pack_atlas.py` 一致。 */
const frameName = (index) => `img_${String(index).padStart(3, '0')}`;

/**
 * 一帧的组成层。**三代产物都要认**（判据表：只认最新的会让没重导的图整个失效）：
 * 图集分层、逐张 PNG 分层、每帧一张。
 */
function layersOf(data, frame, frameIndex) {
  if (Array.isArray(data?.images)) {
    return (frame.layers ?? []).map((l) => ({
      img: l.img, ox: l.ox ?? frame.ox ?? 0, oy: l.oy ?? frame.oy ?? 0,
    }));
  }
  return [{ img: frameIndex, ox: frame.ox ?? 0, oy: frame.oy ?? 0, whole: true }];
}

/** 鼠标命中跟随视觉帧；与下面固定第零帧的 footprintShape 分开。 */
function frameForShape(actor) {
  const frames = actor.data?.frames ?? [];
  const current = actor.sprite?.frameIndex;
  if (Number.isInteger(current) && frames[current]?.w && frames[current]?.h) {
    return current;
  }
  return frames.findIndex((f) => f && f.w && f.h);
}

/** 某一帧的包围盒。与 `FieldScene.touchRectOf` 同一个公式，只是指定帧。 */
function rectOfFrame(actor, frame) {
  if (!frame?.w || !frame?.h) return null;
  return {
    x: actor.x + (actor.dx ?? 0) + (frame.ox ?? 0),
    y: actor.y + (actor.dy ?? 0) + (frame.oy ?? 0),
    w: frame.w,
    h: frame.h,
  };
}

function buildShape(scene, actor, index = frameForShape(actor)) {
  const data = actor.data;
  if (!data) return null;
  const frame = data.frames?.[index];
  if (!frame) return null;
  // ⚠️ **包围盒要跟着同一帧算。** 拿 `actor.touchRect`（按第一帧算的）
  // 配当前帧的像素，两者尺寸对不上，bits 会整片错位。
  const rect = rectOfFrame(actor, frame) ?? actor.touchRect;
  if (!rect) return null;

  const bits = new Uint8Array(rect.w * rect.h);
  let painted = 0;
  for (const layer of layersOf(data, frame, index)) {
    const atlas = Boolean(data.atlas);
    const key = atlas ? actor.sprite?.key ?? data.name : `${data.name}-i${layer.img}`;
    const page = pageAlpha(scene, key);
    const cut = cutOf(scene, key, atlas ? frameName(layer.img) : null);
    if (!page || !cut) continue;
    // 层在帧包围盒里的落位：两边都是「相对对象绘制原点」的偏移，直接相减。
    const dx = layer.ox - (frame.ox ?? 0);
    const dy = layer.oy - (frame.oy ?? 0);
    for (let y = 0; y < cut.h; y += 1) {
      const ty = y + dy;
      if (ty < 0 || ty >= rect.h) continue;
      for (let x = 0; x < cut.w; x += 1) {
        const tx = x + dx;
        if (tx < 0 || tx >= rect.w) continue;
        if (!page.bits[(cut.y + y) * page.width + (cut.x + x)]) continue;
        bits[ty * rect.w + tx] = 1;
        painted += 1;
      }
    }
  }
  return painted ? { ...rect, bits } : null;
}

/**
 * 这个对象当前视觉帧的命中形状。算一次存在 actor 上。
 *
 * @returns {{x,y,w,h,bits}|{x,y,w,h}|null} 有 `bits` 的是像素形状，
 *   没有的是退回来的包围盒。
 */
export function touchShape(scene, actor) {
  if (actor.touchShape !== undefined) return actor.touchShape;
  let shape = null;
  try {
    shape = buildShape(scene, actor);
  } catch (err) {
    console.warn(`${actor.name} 的踩踏形状算不出来：`, err?.message ?? err);
  }
  if (!shape && actor.touchRect) {
    console.warn(`${actor.name} 取不到像素形状，退回包围盒 `
                 + `${actor.touchRect.w}x${actor.touchRect.h}`);
    shape = actor.touchRect;
  }
  actor.touchShape = shape;
  return shape;
}

/** 点在形状里。有 `bits` 就逐像素查，否则当矩形。 */
export function hitsShape(shape, x, y) {
  if (!shape) return false;
  const px = Math.floor(x - shape.x);
  const py = Math.floor(y - shape.y);
  if (px < 0 || py < 0 || px >= shape.w || py >= shape.h) return false;
  return shape.bits ? shape.bits[py * shape.w + px] === 1 : true;
}

/** 换帧之后形状要重算（门开了、动画走到别的帧）。 */
export function clearShape(actor) {
  delete actor.touchShape;
}


/** RPG.exe 0x4080d0(mode=1): 通行、对象碰撞、踩踏一律使用第零帧。
 * 与鼠标的当前视觉帧分开缓存；碰撞不会随人物抬手/门板动画忽大忽小。
 */
export function footprintShape(scene, actor, x = actor.x, y = actor.y) {
  const data = actor.data ?? actor.sprite?.data;
  const key = actor.sprite?.key ?? data?.name;
  if (actor.footprintData !== data || actor.footprintKey !== key) {
    const draw = actor.sprite?.draw;
    actor.footprint = buildShape(scene, { ...actor, data, x: 0, y: 0,
      dx: actor.dx ?? draw?.x ?? 0, dy: actor.dy ?? draw?.y ?? 0 }, 0);
    actor.footprintData = data;
    actor.footprintKey = key;
  }
  const shape = actor.footprint;
  return shape ? { ...shape, x: Math.round(x + shape.x), y: Math.round(y + shape.y) } : null;
}

/** 两个原作像素形状相交；先裁交集，不把包围盒内的空白当实体。 */
export function overlapsShapes(a, b) {
  if (!a || !b) return false;
  const x0 = Math.max(a.x, b.x), y0 = Math.max(a.y, b.y);
  const x1 = Math.min(a.x + a.w, b.x + b.w), y1 = Math.min(a.y + a.h, b.y + b.h);
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
    if (hitsShape(a, x, y) && hitsShape(b, x, y)) return true;
  }
  return false;
}
