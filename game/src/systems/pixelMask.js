/**
 * 把已载入的贴图解成可以逐像素查的数组。
 *
 * 地图的通行与遮挡都是 3840×1440 的逐像素数据（见 tools/map_masks.py）。
 * 早先为了塞进 map.json 把它降采样成 8 像素网格，而 MB 的线宽只有 4~8 像素，
 * 取格中心时线会从两个格心之间漏过去——墙上出现规律的孔，玩家从孔里钻上屋顶。
 * 现在原样送 PNG，这里只负责把它读回内存，不做任何近似。
 */

/** 一次性把贴图画到离屏画布上取回 RGBA。 */
function readPixels(scene, key) {
  if (!scene.textures.exists(key)) return null;
  const source = scene.textures.get(key).getSourceImage();
  const { width, height } = source;
  if (!width || !height) return null;

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(source, 0, 0);
  return { width, height, data: ctx.getImageData(0, 0, width, height).data };
}

/**
 * 二值掩码：PNG 的红色通道，255 = 真。
 * 通行（collision.png，真 = 可走）与遮挡（occlusion.png，真 = 画在人物上方）
 * 共用这一种编码。
 * @returns {{width: number, height: number, bits: Uint8Array}|null}
 */
export function readWalkable(scene, key) {
  const src = readPixels(scene, key);
  if (!src) return null;

  const bits = new Uint8Array(src.width * src.height);
  for (let i = 0; i < bits.length; i += 1) {
    bits[i] = src.data[i * 4] > 127 ? 1 : 0;
  }
  return { width: src.width, height: src.height, bits };
}

/**
 * 通行掩码缓存：贴图键 → 掩码。通行图读成标记数组后贴图就没用了，却按 RGBA 常驻显存/内存
 * （大地图 MP3001 三张各 3840 宽，共约 72 MB；手机上内核另留一份解码图，翻倍）。
 * 所以读完即释放贴图，只留每像素 1 字节的标记数组；回到同一张图（打完仗回来）直接用，不再重载图片。
 * 离开地图卸素材时由 loader 一并忘掉（`forgetCollision`）。
 */
const collisionCache = new Map();

/** 这个通行图键已经读成掩码了吗（loader 据此不再排队载入图片）。 */
export function hasCollision(key) {
  return collisionCache.has(key);
}

/** 卸图时忘掉掩码。 */
export function forgetCollision(key) {
  collisionCache.delete(key);
}

/**
 * 取通行掩码：有缓存直接用；否则从贴图读出、记住，并释放贴图。
 * @returns {{width: number, height: number, bits: Uint8Array}|null}
 */
export function takeCollision(scene, key) {
  if (collisionCache.has(key)) return collisionCache.get(key);
  const mask = readWalkable(scene, key);
  if (!mask) return null;
  collisionCache.set(key, mask);
  scene.textures.remove(key);
  return mask;
}

/**
 * 遮挡掩码：occlusion.png 的红色通道，255 = 该像素的美术画在人物上方。
 * @returns {{width: number, height: number, bits: Uint8Array}|null}
 */
export function readOcclusion(scene, key) {
  return readWalkable(scene, key);
}

/** 地面美术的原始像素，遮挡层要从这里取色重画到人物上方。 */
export function readGround(scene, key) {
  return readPixels(scene, key);
}
