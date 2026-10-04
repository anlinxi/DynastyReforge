/**
 * 进战斗的玻璃破碎：进战斗前的地图画面碎开飞散，露出底下的战斗画面。
 *
 * 数据是原作的 `Fight\Other\FBX_Table0.FBX`（`tools/export_battle_transition.py` 导出为
 * `assets/transition/shatter.fbx`），格式与解码照 RPG.exe 0x44e5ca，见那个工具的说明。
 * 原作先建好战斗场景，再开播（0x4325f0）并放 `WAV0001.WAV`；我们首战要载几秒，
 * 所以加载期间先把地图截图挂在屏幕上，战斗就绪后再碎（BattleScene）。
 *
 * 帧速：原作每拍画一帧，拍速未在代码里直接查到，按地图逻辑 20Hz 取 50ms/帧（推断）；
 * 30 帧里第 21 帧起已全空，看得见的破碎约 1 秒。
 */
export const SHATTER_KEY = 'battle-shatter-table';
export const SHATTER_SFX = 'sfx-shatter';
export const SNAPSHOT_KEY = 'battle-snapshot';
const FRAME_MS = 50;
const WIDTH = 640;
const HEIGHT = 480;

/** 帧表：`[{width, height, size, offset}]`。 */
export function shatterFrames(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const count = view.getUint32(0, true);
  return Array.from({ length: count }, (_, i) => {
    const at = 4 + 16 * i;
    return { width: view.getUint32(at, true), height: view.getUint32(at + 4, true),
      size: view.getUint32(at + 8, true), offset: view.getUint32(at + 12, true) };
  });
}

/**
 * 解一帧：`out[i]` = `src[源偏移]`，跳过的像素写 `empty`（透明）。
 * `src`/`out` 是 Uint32Array（一个像素一个数），与原作按 16 位像素逐点搬同一规则。
 */
export function decodeShatterFrame(bytes, frame, src, out, empty = 0) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let p = frame.offset;
  for (let y = 0; y < frame.height; y += 1) {
    let x = 0;
    while (x < frame.width) {
      const b = bytes[p]; p += 1;
      const n = (b & 0x3f) + 1;
      const at = y * frame.width + x;
      switch (b >> 6) {
        case 0: {                                   // 连续复制
          const from = view.getUint32(p, true); p += 4;
          for (let k = 0; k < n; k += 1) out[at + k] = src[from + k];
          break;
        }
        case 2:                                     // 逐点复制
          for (let k = 0; k < n; k += 1) { out[at + k] = src[view.getUint32(p, true)]; p += 4; }
          break;
        case 3: {                                   // 同色填满
          const color = src[view.getUint32(p, true)]; p += 4;
          out.fill(color, at, at + n);
          break;
        }
        default:                                    // 跳过：露出底下的战斗画面
          out.fill(empty, at, at + n);
      }
      x += n;
    }
  }
}

/**
 * 播放破碎。缺表或缺截图时直接 `onDone`（不挡进战斗）。
 * @param {Phaser.Scene} scene 战斗场景（已画好）
 * @param {number} depth 盖在战斗画面之上的深度
 */
export function playShatter(scene, depth, onDone) {
  const raw = scene.cache.binary.get(SHATTER_KEY);
  if (!raw || !scene.textures.exists(SNAPSHOT_KEY)) { onDone(); return; }
  const bytes = new Uint8Array(raw);
  const frames = shatterFrames(bytes);
  const shot = document.createElement('canvas');
  shot.width = WIDTH; shot.height = HEIGHT;
  const shotCtx = shot.getContext('2d', { willReadFrequently: true });
  shotCtx.drawImage(scene.textures.get(SNAPSHOT_KEY).getSourceImage(), 0, 0, WIDTH, HEIGHT);
  const src = new Uint32Array(shotCtx.getImageData(0, 0, WIDTH, HEIGHT).data.buffer);
  const key = `${SNAPSHOT_KEY}-shards`;
  if (scene.textures.exists(key)) scene.textures.remove(key);
  const canvas = scene.textures.createCanvas(key, WIDTH, HEIGHT);
  const image = scene.add.image(0, 0, key).setOrigin(0, 0).setScrollFactor(0).setDepth(depth);
  // 宽屏：破碎表是 640×480 的，整屏截图被压进去解码，再把结果拉宽到铺满舞台显示（顶层相机，见 battleCameras.js）
  image.setDisplaySize(scene.coverWidth ?? WIDTH, HEIGHT);
  image.ycTop = true;
  const pixels = canvas.getContext().createImageData(WIDTH, HEIGHT);
  const out = new Uint32Array(pixels.data.buffer);
  const draw = (i) => {
    decodeShatterFrame(bytes, frames[i], src, out);
    canvas.getContext().putImageData(pixels, 0, 0);
    canvas.refresh();
  };
  draw(0);
  if (scene.cache.audio.exists(SHATTER_SFX)) scene.sound.play(SHATTER_SFX);
  let i = 1;
  scene.time.addEvent({ delay: FRAME_MS, repeat: frames.length - 2, callback: () => {
    draw(i);
    i += 1;
    if (i < frames.length) return;
    image.destroy();
    scene.textures.remove(key);
    scene.textures.remove(SNAPSHOT_KEY);
    onDone();
  } });
}
