import Phaser from 'phaser';

/**
 * 网点虚影的显卡管线：**棋盘格抽掉一半 + 只留在遮挡层上**，都在着色器里逐像素判。
 *
 * 为什么不再用「网点副本贴图 + 位图遮罩」（2026-09-27 改）：
 * 每个带 BitmapMask 的对象，WebGL 每帧要为它多画两遍整屏（遮罩一遍、被遮一遍）。
 * 沙洲城街上同时 27 个网点人影，Intel UHD 630 上走路只有 18 帧/秒，关掉网点 59 帧。
 * 另外网点副本要在 CPU 上逐帧生成贴图，新动画帧第一次出现时会卡一下。
 *
 * 现在网点人影直接用本体**同一张贴图、同一帧**，由这里的片元着色器：
 * 1. 按世界像素坐标 `(x + y)` 的奇偶抽掉一半（相位取世界坐标，理由见 `ghost.js`）；
 * 2. 查遮挡层（`<图号>-occlusion`，与地面同坐标、同尺寸）：没有遮挡的像素丢掉，
 *    与原来位图遮罩的效果相同（遮罩 alpha 乘到颜色上）。
 *
 * 每个人影的帧位置不同，参数在 `onBind` 里逐个设（先 flush 上一个）——
 * 一个人影一次绘制，27 个人影就是 27 次绘制，与画 27 个普通人物同一量级。
 */
export const GHOST_PIPELINE = 'YcGhost';

/** 遮挡贴图绑在这个纹理槽；本管线只用 0 号槽画人物，1 号空着。 */
const MASK_UNIT = 1;

const FRAG = `
#define SHADER_NAME YC_GHOST_FS
#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif
uniform sampler2D uMainSampler;
uniform sampler2D uMask;
uniform vec2 uTexSize;   // 这一帧所在图集页的宽高
uniform vec2 uCut;       // 这一帧在图集页上的左上角
uniform vec2 uWorld;     // 这一帧左上角落在世界哪个像素
uniform vec2 uMaskSize;  // 遮挡贴图宽高（= 地面宽高）
varying vec2 outTexCoord;
varying vec4 outTint;
void main ()
{
    vec2 world = uWorld + floor(outTexCoord * uTexSize - uCut);
    if (mod(world.x + world.y, 2.0) >= 1.0) discard;
    float cover = texture2D(uMask, (world + 0.5) / uMaskSize).a;
    if (cover <= 0.0) discard;
    vec4 texture = texture2D(uMainSampler, outTexCoord);
    gl_FragColor = texture * vec4(outTint.bgr * outTint.a, outTint.a) * cover;
}
`;

class GhostPipeline extends Phaser.Renderer.WebGL.Pipelines.SinglePipeline {
  constructor(game) {
    super({ game, name: GHOST_PIPELINE, fragShader: FRAG });
  }

  boot() {
    super.boot();
    this.set1i('uMask', MASK_UNIT);
  }

  /** 每个人影各自的帧位置与遮挡贴图。上一个人影先画掉，再换参数。 */
  onBind(ghost) {
    const mask = ghost?.ghostMask;
    const frame = ghost?.frame;
    if (!mask || !frame) return;
    this.flush();
    this.set2f('uTexSize', frame.source.width, frame.source.height);
    this.set2f('uCut', frame.cutX, frame.cutY);
    this.set2f('uWorld', Math.round(ghost.x) + frame.x, Math.round(ghost.y) + frame.y);
    this.set2f('uMaskSize', mask.width, mask.height);
    this.set1i('uMask', MASK_UNIT);
    this.bindTexture(mask.texture, MASK_UNIT);
    // ⚠️ 绑完切回 0 号槽：本管线 flush 时假定当前槽是 0（SinglePipeline 的 forceZero）。
    // 其他管线重新激活时会清掉自己的纹理缓存（WebGLPipeline.bind），1 号槽被占不会串图。
    this.gl.activeTexture(this.gl.TEXTURE0);
  }
}

/**
 * 在这个场景的渲染器上备好网点管线，返回遮挡贴图的描述；用不了（非 WebGL、没有遮挡贴图）返回 null，
 * 调用方退回 CPU 生成网点副本的旧做法。
 *
 * @returns {{texture: object, width: number, height: number}|null}
 */
export function ghostMaskFor(scene, maskKey) {
  const renderer = scene.game?.renderer;
  if (renderer?.type !== Phaser.WEBGL || !maskKey || !scene.textures?.exists?.(maskKey)) return null;
  const source = scene.textures.get(maskKey).source?.[0];
  if (!source?.glTexture) return null;
  if (!renderer.pipelines.has(GHOST_PIPELINE)) renderer.pipelines.add(GHOST_PIPELINE, new GhostPipeline(scene.game));
  return { texture: source.glTexture, width: source.width, height: source.height };
}
