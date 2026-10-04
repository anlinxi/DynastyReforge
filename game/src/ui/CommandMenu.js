/**
 * 战斗主菜单的画法 —— 一块竹简 + 一个会闪动的光标。
 *
 * 布局、选择逻辑、素材判据全在 {@link ./cmdLayout.js}（纯函数，有回归）；
 * **这里不写坐标**。
 *
 * ## 它是滑进来的
 *
 * exe 把竹简构造在 **(700, 100)** —— 700 在 640 宽的画面外。
 * 所以原作是**从右侧滑入**，停在右缘贴边处。关闭时滑回去。
 *
 * ## ⚠️ 帧号 ≠ 图号
 *
 * 与状态条同一个坑：要走 `anim.json` 的 `frames[i].layers[].image_index`，
 * 直接拿帧号当图号会画出别的图，而且不报错。
 */
import { packImage } from './packImage.js';
import DEPTH from '../systems/depths.js';
import { BOARD, CURSOR, COMMANDS, cursorAt, moveSelection } from './cmdLayout.js';

/** 滑入/滑出用多久（毫秒）。🟡 原作的速度没解，取一个不拖沓的值。 */
const SLIDE_MS = 180;

function imageOf(scene, key, frame) {
  return packImage(scene, key, frame, { tag: '战斗菜单' });
}

export default class CommandMenu {
  constructor(scene) {
    this.scene = scene;
    this.index = 0;
    this.open = false;
    this.root = scene.add.container(BOARD.offscreenX, BOARD.y).setDepth(DEPTH.HUD);

    const board = imageOf(scene, BOARD.key, 0);
    if (board) {
      this.board = scene.add.image(board.dx, board.dy, board.key, board.frame).setOrigin(0, 0);
      this.root.add(this.board);
    }
    this.cursor = scene.add.image(0, 0, '__DEFAULT').setOrigin(0, 0).setVisible(false);
    this.root.add(this.cursor);

    this.cursorFrame = 0;
    this.sinceFrame = 0;
    this.drawCursor();
  }

  /** 当前选中的指令，如 `{ id: 'attack', label: '攻擊' }`。 */
  get selected() { return COMMANDS[this.index]; }

  drawCursor() {
    const spec = imageOf(this.scene, CURSOR.key, this.cursorFrame);
    if (!spec) { this.cursor.setVisible(false); return; }
    const at = cursorAt(this.index);
    this.cursor.setVisible(true).setTexture(spec.key, spec.frame)
      .setPosition(at.x + spec.dx, at.y + spec.dy);
  }

  move(step) {
    this.index = moveSelection(this.index, step);
    this.drawCursor();
    return this.selected;
  }

  /** 滑进来。已经开着就什么都不做。 */
  show() {
    if (this.open) return;
    this.open = true;
    this.scene.tweens.add({
      targets: this.root, x: BOARD.x, duration: SLIDE_MS, ease: 'Quad.easeOut',
    });
  }

  /** 滑回画外。 */
  hide() {
    if (!this.open) return;
    this.open = false;
    this.scene.tweens.add({
      targets: this.root, x: BOARD.offscreenX, duration: SLIDE_MS, ease: 'Quad.easeIn',
    });
  }

  /** 光标的闪动。**每帧调**，`delta` 是本帧毫秒数。 */
  update(delta) {
    if (!this.open) return;
    this.sinceFrame += delta;
    if (this.sinceFrame < CURSOR.frameMs) return;
    this.sinceFrame = 0;
    this.cursorFrame = (this.cursorFrame + 1) % CURSOR.frames;
    this.drawCursor();
  }

  destroy() { this.root.destroy(true); }
}
