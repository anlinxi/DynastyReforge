/**
 * 右下角的**时轮** —— 战斗里唯一一个「时间在不在流逝」的可见指示。
 *
 * > 用户 2026-09-17：「时轮转动时，代表时间在推进；时轮停止转动时，
 * > 代表时间没有在流逝。」
 *
 * 所以它不是装饰：**它就是 `systems/battleClock.js` 有没有在跑的那盏灯**。
 * 选菜单、演出招时时钟暂停，轮子也就停住。
 *
 * ## 素材
 *
 * | 代号 | 是什么 | 尺寸 | 帧 | 每帧 |
 * |---|---|---|---|---|
 * | `ITF0210` | **时轮**：青铜绿圆盘，内圈刻符文、外圈一圈金齿、一根指针 | 131×128 | **60** | `duration=2` → 110ms，转一圈 6.6 秒 |
 *
 * 原始文件：`multimedia/fight/ItfDir.DAT` 里的 `ITF0210.SF2`；
 * 产物：`game/public/assets/ITF0210/`。
 *
 * ⚠️ **不是 `ITF3004`。** `docs/专题/战斗.md` 里曾把「右下角那个青铜罗盘」
 * 记成 `ITF3004`（218×331 两帧）—— 那个渲出来是**两张空白竹简面板**。
 * 又一次「按尺寸帧数推、没渲出来看图」（判据表 E 组）。
 *
 * ## 摆在哪
 *
 * exe 把它构造在 **(320, 220)**（`tools/extract_layout.py` 簇 5，
 * 调用点 `0x0041b46d`，⚠️ 要用 300块版 `exe/大众难度.exe` +
 * 两层目录的 `--pattern`）。加上图层自带的 `(207,156)` 就是屏幕上的
 * **(527, 376)** —— 圆盘的右下角**超出 640×480 画面之外**，只露左上一块。
 * 与用户提供的原作截图逐处吻合。
 *
 * 「exe 坐标 + 图层坐标」是本项目一贯的模型，顶部状态条也是这么画对的。
 */
import { packImage } from './packImage.js';
import DEPTH from '../systems/depths.js';
import { TICK_MS } from '../systems/SF2Animator.js';

/** 时轮的素材代号。这一块要预载什么，拿它反查，别另写清单。 */
export const WHEEL_ART = 'ITF0210';

/** exe 里的构造坐标（`extract_layout.py` 簇 5）。 */
export const WHEEL_ORIGIN = Object.freeze({ x: 320, y: 220 });

export default class TimeWheel {
  constructor(scene) {
    this.scene = scene;
    this.frame = 0;
    this.since = 0;
    this.image = scene.add.image(0, 0, '__DEFAULT')
      .setOrigin(0, 0)
      .setDepth(DEPTH.HUD)
      .setVisible(false);
    // 宽屏：时轮是贴着原作画面右下角、被边缘切掉一截的装饰；界面居中 640 后切口落在画面中间很怪，
    // 改画在右侧界面相机，贴战场画面的右边缘、在那里被切（battleCameras.js）
    this.image.ycRight = true;
    this.draw();
  }

  /** `anim.json` 里第 `frame` 帧实际要画哪张图、贴在哪。 */
  spec(frame) {
    const data = this.scene.cache.json.get(`${WHEEL_ART}-anim`);
    const layer = data?.frames?.[frame]?.layers?.[0];
    const img = packImage(this.scene, WHEEL_ART, frame, { tag: '时轮' });
    if (!layer || !img) return null;
    return {
      key: img.key,
      frame: img.frame,
      x: WHEEL_ORIGIN.x + (layer.x ?? 0),
      y: WHEEL_ORIGIN.y + (layer.y ?? 0),
      hold: Math.max(1, data.frames[frame].duration ?? 1) * TICK_MS,
    };
  }

  draw() {
    const spec = this.spec(this.frame);
    if (!spec) { this.image.setVisible(false); return; }
    this.image.setVisible(true).setTexture(spec.key, spec.frame).setPosition(spec.x, spec.y);
  }

  /**
   * **只在时间真的在走的时候转。**
   *
   * @param {number} delta 本帧毫秒；时钟暂停时传 0（或干脆别调）
   */
  update(delta) {
    const step = Number(delta);
    if (!Number.isFinite(step) || step <= 0) return;   // 停住：时间没在流逝
    const spec = this.spec(this.frame);
    if (!spec) return;
    this.since += step;
    if (this.since < spec.hold) return;
    this.since = 0;
    const count = this.scene.cache.json.get(`${WHEEL_ART}-anim`)?.frames?.length ?? 1;
    this.frame = (this.frame + 1) % Math.max(1, count);
    this.draw();
  }

  setVisible(v) { this.image.setVisible(v); return this; }

  destroy() { this.image.destroy(); }
}
