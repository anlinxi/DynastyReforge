import Phaser from 'phaser';
import FieldSprite from '../systems/FieldSprite.js';
import CursorLayer from '../ui/cursorLayer.js';

const CURSOR_KEYS = ['CURSOR', 'mousedefault', 'mousewait'];

/**
 * 只管指针，不截获任何游戏输入。素材沿用 FieldSprite 的分层与 SF2 时序，
 * 但**不画进游戏画面**：当前帧画在独立的指针图层（ui/cursorLayer.js）上。
 * 鼠标移动时立即挪位置、重算形状（方向箭头/手势）；游戏每帧推进动画，
 * 主角走动后箭头方向也随之更新。
 */
export default class CursorScene extends Phaser.Scene {
  constructor() { super({ key: 'Cursor', active: true }); }

  preload() {
    this.load.json('cursors', 'assets/cursors/cursors.json');
    for (const key of CURSOR_KEYS) {
      this.load.json(`${key}-sprite`, `assets/cursors/${key}/sprite.json`);
      this.load.multiatlas(key, `assets/cursors/${key}/${key}.json`, `assets/cursors/${key}`);
    }
  }

  create() {
    this.input.enabled = false;
    this.spec = this.cache.json.get('cursors');
    // 精灵只用来走时序、取当前帧，始终隐藏，不进游戏画面
    this.sprites = Object.fromEntries(CURSOR_KEYS.map((key) => {
      const sprite = new FieldSprite(this, key, 0, 0, { x: -320, y: -260 }, true);
      sprite.setHidden(true);
      return [key, sprite];
    }));
    const canvas = this.game.canvas;
    this.layer = new CursorLayer(canvas);
    this.over = false;
    this.mouseVisible = false;
    const move = (event) => {
      this.over = true;
      this.mouseVisible = true;
      this.layer.moveTo(event.clientX, event.clientY);
      this.refresh();
    };
    const leave = () => {
      this.over = false;
      this.mouseVisible = false;
      this.layer.setVisible(false);
    };
    // 键盘接管选择，不让悬停抢焦点；指针仍显示。
    const keyboard = () => { this.mouseVisible = false; };
    canvas.addEventListener('mousemove', move);
    canvas.addEventListener('mouseleave', leave);
    window.addEventListener('keydown', keyboard);
    this.events.once('shutdown', () => {
      canvas.removeEventListener('mousemove', move);
      canvas.removeEventListener('mouseleave', leave);
      window.removeEventListener('keydown', keyboard);
      this.layer.destroy();
    });
  }

  /** 当前该用哪条指针、哪一段帧。与原先逐帧判断的规则相同。 */
  cursorSegment() {
    let key = 'CURSOR', start, count = 1;
    let state = { kind: 'hand' };
    if (this.scene.isActive('Battle')) { key = 'mousedefault'; start = 0; }
    else if (this.mouseVisible && this.scene.isActive('Field')) {
      state = this.scene.get('Field').mouseCursor(this.input.manager.mousePointer);
    }
    if (start == null) {
      if (state.kind === 'direction') start = this.spec.directionFrames[state.direction];
      else if (state.disabled && this.spec.disabled[state.kind] != null) start = this.spec.disabled[state.kind];
      else [start, count] = this.spec.segments[state.kind] ?? this.spec.segments.hand;
    }
    return { key, start, count };
  }

  /** 重算形状并把当前帧画到指针图层。鼠标移动与每个游戏帧都调用。 */
  refresh() {
    if (!this.sprites || !this.over) return;
    const { key, start, count } = this.cursorSegment();
    const sprite = this.sprites[key];
    const segment = `${key}:${start}:${count}`;
    if (segment !== this.segment) { sprite.playSegment(start, count); this.segment = segment; }
    this.key = key;
    this.drawCurrent();
  }

  drawCurrent() {
    const sprite = this.sprites[this.key];
    const frame = sprite?.frames[sprite.frameIndex];
    if (!frame || frame.empty) { this.layer.setVisible(false); return; }
    const layers = (frame.layers ?? []).map((l) => ({
      key: sprite.imageKey(l.img),
      frame: sprite.atlas ? FieldSprite.frameName(l.img) : undefined,
      dx: sprite.draw.x + l.ox,
      dy: sprite.draw.y + l.oy,
      alpha: l.alpha,
      blend: l.blend,
    }));
    this.layer.draw(this.textures, layers, `${this.key}:${sprite.frameIndex}`);
    this.layer.setVisible(true);
  }

  update(time, delta) {
    if (!this.sprites || !this.over) return;
    this.refresh();
    this.sprites[this.key]?.update(time, delta);
    this.drawCurrent();
  }
}
