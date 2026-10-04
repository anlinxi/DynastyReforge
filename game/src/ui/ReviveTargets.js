/** 原作复活专用四行列表：0x42ff30 / 0x430350，布局随菜单素材生成。 */
import { FONT_KEY } from '../config.js';
import { SlidingBoard } from './ListPanel.js';
import { MENU_SPEC_KEY, textureKey } from './menuSpec.js';
import { TEXT_TINT, ROW_FONT } from './listRows.js';
import { uiPointer } from '../systems/stageView.js';

export class ReviveTargets extends SlidingBoard {
  constructor(scene) {
    const spec = scene.cache.json.get(MENU_SPEC_KEY).reviveTarget;
    super(scene, { ...spec, key: spec.asset, menu: true });
    this.index = 0;
    this.units = [];
    this.paint();
    this.highlight = scene.add.image(spec.rowX, spec.rowY, textureKey(spec.rowAsset), 0).setOrigin(0, 0);
    this.labels = Array.from({ length: 4 }, (_, i) => scene.add.bitmapText(
      spec.textX, spec.textY + i * spec.rowStep, FONT_KEY, '', ROW_FONT).setTint(TEXT_TINT));
    this.root.add([this.highlight, ...this.labels]);
  }

  get selected() { return this.units[this.index] ?? null; }
  show(units) {
    this.units = units.filter(unit => !unit.alive).slice(0, 4);
    this.index = 0;
    this.draw();
    this.slideIn();
  }
  draw() {
    const characters = this.scene.cache.json.get('gamedata')?.角色 ?? {};
    this.labels.forEach((label, i) => {
      const unit = this.units[i];
      label.setText(unit ? characters[unit.name]?.名称繁 ?? unit.name : '');
    });
    this.highlight.setVisible(!!this.selected).setY(this.spec.rowY + this.index * this.spec.rowStep);
  }
  move(step) {
    this.index = Math.max(0, Math.min(this.units.length - 1, this.index + step));
    this.draw();
  }
  hitTest(pointer) {
    if (!this.open) return -1;
    const { rowX, rowY, rowWidth, rowHeight, rowStep } = this.spec;
    const ui = uiPointer(pointer, this.root);
    const x = ui.x - this.root.x, y = ui.y - this.root.y - rowY;
    const row = Math.floor(y / rowStep);
    return x >= rowX && x < rowX + rowWidth && row >= 0 && row < this.units.length
      && y % rowStep < rowHeight ? row : -1;
  }
  hide() { this.slideOut(); }
}
