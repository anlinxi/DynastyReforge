import { warnOnce } from '../systems/warnOnce.js';

/** 图集里一张图的帧名，与 export_pack/pack_atlas 产物、SF2Animator 同一规则。 */
const atlasFrame = (index) => `img_${String(index).padStart(3, '0')}`;

/**
 * 战斗界面素材包（ITF…）第 `frame` 帧要画哪张图、相对这件素材的原点偏多少。
 *
 * 包可能是**图集**（纹理键=包名，帧名 `img_NNN`，2026-09-27 起 ITF 也打图集），
 * 也可能是旧的**逐帧图**（纹理键 `<包>-img<N>`）。调用方一律用返回的 `key` + `frame` 取图。
 *
 * ⚠️ 帧号 ≠ 图号：要画哪张看 `anim.json` 图层的 `image_index`（`ITF0011` 是 13 帧 11 图）。
 *
 * @param {{normalize?: boolean, tag?: string}} [opts]
 *   normalize：以第 0 帧图层坐标为基准归零（三位那套 ITF035/036/040/050 的图层坐标是屏幕绝对坐标）；
 *   tag：缺图时日志前缀。
 * @returns {{key: string, frame: string|undefined, dx: number, dy: number}|null} 空帧或缺图返回 null
 */
export function packImage(scene, key, frame, { normalize = false, tag = '界面' } = {}) {
  const data = scene.cache.json.get(`${key}-anim`);
  const layer = data?.frames?.[frame]?.layers?.[0];
  if (!layer) return null;                       // 空帧：原作就是什么都不画
  const name = atlasFrame(layer.image_index);
  const atlas = scene.textures.exists(key) && scene.textures.get(key).has(name);
  const texture = atlas ? key : `${key}-img${layer.image_index}`;
  if (!atlas && !scene.textures.exists(texture)) {
    // 兜底跳过要留日志，否则整块静默消失，看着像「原作就没有」。
    warnOnce(`pack-tex:${texture}`, `${tag}缺素材 ${key} 图${layer.image_index}，这一块不画`);
    return null;
  }
  const base = normalize ? (data.frames[0]?.layers?.[0] ?? { x: 0, y: 0 }) : { x: 0, y: 0 };
  return {
    key: texture,
    frame: atlas ? name : undefined,
    dx: (layer.x ?? 0) - (base.x ?? 0),
    dy: (layer.y ?? 0) - (base.y ?? 0),
  };
}
