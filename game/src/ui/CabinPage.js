import { LEVELS, audioSettings, frameOf, setLevel } from '../systems/audioSettings.js';
import { refreshBgmVolume } from '../systems/bgm.js';
import { uiPointer } from '../systems/stageView.js';

/**
 * 两条滑条：素材名 → 它调的是哪一路。
 *
 * 判据是面板底图 `MEN0010`（375×199，摆在 225,140）上印着的字：**「音乐」在上、
 * 「音效」在下**，两条凹槽的位置与这两个元素的 y（221 / 293）逐一对得上。
 * `x`/`width` 取自元素自身的摆位与素材格宽，鼠标点击按它换算档位。
 */
export const CABIN_BARS = Object.freeze({ MEN0011: '音乐', MEN0012: '音效' });

/** 「空明流转」（退出游戏）那一项的素材。 */
const EXIT_ASSET = 'MEN0013';

/**
 * 机能页（游戏里显示「机能」；`menus.json` 里这一页的键名是「机舱」，沿用不改）：
 * 音乐、音效两条滑条与「空明流转」。
 *
 * 光标行 `row`：0=音乐 1=音效 2=空明流转。档位本身不存在这里 —— 它在 registry 上，
 * 见 `systems/audioSettings.js`。⚠️ 手机 App 里音乐滑条无效（iOS 不让网页改原生音频元素音量），
 * 用户定用机身音量键，见待办 AUDIO-04。
 * （2026-10-04 从 MenuScreen 拆出，QA-04；行为不变。）
 */
export class CabinPage {
  /**
   * @param {import('./MenuScreen.js').default} menu
   * @param {number} focusColor 光标描边颜色（与面板文字同一墨色，见 MenuScreen 的说明）
   */
  constructor(menu, focusColor) {
    this.menu = menu;
    this.focusColor = focusColor;
    this.row = 0;
  }

  get active() {
    return this.menu.page?.key === '机舱';
  }

  /** 两条滑条的元素（按面板上的顺序：音乐在上、音效在下）。 */
  bars() {
    if (!this.active) return [];
    return (this.menu.page.elements ?? [])
      .filter((e) => CABIN_BARS[e.asset])
      .sort((a, b) => a.y - b.y);
  }

  /** 光标停着的那条。 */
  currentBar() {
    return this.bars()[this.row] ?? null;
  }

  /** 光标是不是停在「空明流转」上（它排在两条滑条之后）。 */
  onExit() {
    return this.menu.focus === 1 && this.row === this.bars().length;
  }

  /** 元素该画第几帧；不是这一页的元素返回 `undefined`，交回菜单按默认处理。 */
  frameFor(element) {
    if (element.asset === EXIT_ASSET) return this.onExit() ? 1 : 0;
    // 两条音量滑条：帧号就是档位，**但倒着数**，见 audioSettings.frameOf。
    if (CABIN_BARS[element.asset]) return frameOf(audioSettings(this.menu.scene)[CABIN_BARS[element.asset]]);
    return undefined;
  }

  /** ↑↓：两条滑条与「空明流转」之间走，不越界换层 —— 与及身页三个槽同一套手感（退出走 ← 或 ESC）。 */
  moveRow(step) {
    const next = this.row + step;
    if (next < 0 || next > this.bars().length) return;
    this.row = next;
    this.menu.queueRender();
  }

  /** ←→：加减一档并立刻应用到正在放的曲子。 */
  stepLevel(dir) {
    const bar = this.currentBar();
    if (!bar) return;
    const kind = CABIN_BARS[bar.asset];
    this.setKind(kind, audioSettings(this.menu.scene)[kind] + dir);
  }

  setKind(kind, level) {
    const { scene } = this.menu;
    setLevel(scene, kind, level);
    if (kind === '音乐') refreshBgmVolume(scene);
    this.menu.queueRender();
  }

  /** 回车：只有停在「空明流转」上才有动作。 */
  confirm() {
    if (this.onExit()) this.exitGame();
  }

  /**
   * 光标那条的描边。**原作没有这个素材**（`MEN0008` 未导出），键盘操作又必须看得出光标在哪条，
   * 只好自己画。只在焦点真的落在滑条上（层1）时画，层0 停在标签栏时不画。
   */
  drawFocus() {
    const menu = this.menu;
    if (!this.active || menu.focus !== 1) return;
    const bar = this.currentBar();
    if (!bar) return;
    const [w, h] = menu.spec.assets?.[bar.asset]?.cell ?? [0, 0];
    const box = menu.scene.add
      .rectangle(bar.x - 2, bar.y - 2, w + 4, h + 4)
      .setOrigin(0, 0)
      .setScrollFactor(0)
      .setStrokeStyle(1, this.focusColor, 0.9);
    menu.container.add(box);
    menu.parts.push(box);
  }

  /**
   * 两条滑条的点击区：**点条上哪一段就跳到哪一档**。
   *
   * 滑条是 10 等分，落点占条宽的比例决定档位。按住拖也走这条路
   * （`pointermove` 时按键仍按下才算），与「点一下就跳档」是同一套换算。
   */
  buildHits() {
    const menu = this.menu;
    this.bars().forEach((el, i) => {
      const [w, h] = menu.spec.assets?.[el.asset]?.cell ?? [0, 0];
      if (!w) return;
      const kind = CABIN_BARS[el.asset];
      // 条本身只有 12 像素高，照原样做热区太难点中，上下各放宽一点。
      const pad = 6;
      const pick = (pointer) => {
        const ratio = (uiPointer(pointer).x - el.x) / w;
        menu.focus = Math.max(menu.focus, 1);
        this.row = i;
        this.setKind(kind, Math.floor(ratio * LEVELS));
      };
      const zone = menu.addZone(
        { x: el.x, y: el.y - pad, w, h: h + pad * 2 },
        () => { if (menu.focus !== 1 || this.row !== i) { menu.focus = 1; this.row = i; menu.queueRender(); } },
        pick,
      );
      zone.on('pointermove', (pointer) => { if (pointer.isDown) pick(pointer); });
    });
    if (!this.active) return;
    const exit = menu.page.elements.find(e => e.asset === EXIT_ASSET);
    if (!exit) return;
    const [w, h] = menu.spec.assets[exit.asset].cell;
    menu.addZone({ x: exit.x, y: exit.y, w, h }, () => {
      if (menu.focus !== 1 || this.row !== this.bars().length) {
        menu.focus = 1;
        this.row = this.bars().length;
        menu.queueRender();
      }
    }, () => this.exitGame());
  }

  /** 浏览器版退出到标题；复用场景的音频与生命周期清理。 */
  exitGame() {
    this.menu.scene.returnToTitle();
  }
}
