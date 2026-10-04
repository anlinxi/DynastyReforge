/** 剧情画外脚点保留原坐标，不参与可走点吸附。地图尺寸未知时不推断。 */
export function isOffstagePoint({ x, y }, width, height) {
  return Number.isFinite(width) && Number.isFinite(height)
    && (x <= 0 || y <= 0 || x >= width || y >= height);
}

/** 原场景SCI默认层；跨图紧接的切层必须先于出生点通行校正。 */
export function entryLayer(meta, entry, actions, cursor) {
  if (Number.isInteger(entry?.layer)) return entry.layer; // 战斗原地返回
  let layer = meta.initialLayer ?? 0;
  if (!Array.isArray(actions) || !Number.isInteger(cursor)) return layer;
  let start = 0;
  for (let i = 0; i < cursor; i++) if (actions[i]?.type === 'goto_map') start = i + 1;
  for (let i = start; i < cursor; i++) {
    if (actions[i]?.type === 'switch_layer') layer = actions[i].layer;
  }
  if (actions[cursor]?.type === 'switch_layer') layer = actions[cursor].layer;
  return layer;
}

/** 脚印里有几个像素落在不可走处（出界也算）。纯函数。 */
export function footprintMisses(shape, mask) {
  if (!shape || !mask) return 0;
  let misses = 0;
  for (let y = 0; y < shape.h; y++) for (let x = 0; x < shape.w; x++) {
    if (shape.bits && !shape.bits[y * shape.w + x]) continue;
    const px = shape.x + x, py = shape.y + y;
    if (px < 0 || py < 0 || px >= mask.width || py >= mask.height
        || mask.bits[py * mask.width + px] !== 1) misses += 1;
  }
  return misses;
}

/** 完全按人物第零帧的不透明像素检查地形；不以包围盒代替脚印。 */
export function footprintFitsMask(shape, mask) {
  return footprintMisses(shape, mask) === 0;
}
