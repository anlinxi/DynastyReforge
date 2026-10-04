/**
 * ⚠️ **当前没有任何消费者。**
 *
 * 它属于**战斗执行层**。2026-09-05 删掉战斗演示页（`BattleScene`）与特效
 * 浏览页之后，这条线暂时断了 —— 但代码是有效资产，战斗真正接进主线时
 * （由剧情的 `battle` 指令拉起）会重新用上，所以留着而不是删掉。
 *
 * 同样处境的还有：`ui/StatusPanel.js`、`systems/BattleUnit.js`、
 * `systems/effects.js`、`systems/ActionBarrier.js`。
 * 见 `docs/归档/全流程可行性.md` 的战斗线。
 */
import { STAGE_WIDTH, TERMS } from '../config.js';

/** 战斗中的命/气显示。用词照搬原作：命、气。 */

const BAR_WIDTH = 168;
const BAR_HEIGHT = 9;
const ROW_GAP = 46;
const MARGIN = 14;

const COLORS = Object.freeze({
  frame: 0x6b5a3c,
  track: 0x1a1410,
  ally: 0xc0392b,
  foe: 0x8e44ad,
  qi: 0x3d7ea6,
});

export default class StatusPanel {
  /**
   * @param {Phaser.Scene} scene
   * @param {import('../systems/BattleUnit.js').default[]} units
   */
  constructor(scene, units) {
    this.scene = scene;
    this.units = units;
    // ⚠️ **按各方自己的序号排行，不是全局序号。**
    // 原先写的是 `index * 0`（也就是恒为 0），一方只要多于一个单位就会
    // 整整齐齐叠在同一行 —— 两个西夏兵的血条完全重合，看起来像只有一个。
    const seen = { ally: 0, foe: 0 };
    this.rows = units.map((unit) => {
      const side = unit.def.side === 'ally' ? 'ally' : 'foe';
      const row = seen[side];
      seen[side] += 1;
      return this.createRow(unit, row);
    });
    this.refresh();
  }

  createRow(unit, index) {
    const isAlly = unit.def.side === 'ally';
    const x = isAlly ? MARGIN : STAGE_WIDTH - MARGIN - BAR_WIDTH;
    // 我方一列在左下、敌方一列在右上，各自往下叠。
    const y = MARGIN + index * ROW_GAP + (isAlly ? ROW_GAP * 4 : 0);

    const scene = this.scene;
    const name = scene.add
      .text(x, y, unit.name, {
        fontFamily: 'serif',
        fontSize: '15px',
        color: '#e8d9b0',
        stroke: '#000000',
        strokeThickness: 3,
      })
      .setDepth(1000);

    const track = scene.add
      .rectangle(x, y + 20, BAR_WIDTH, BAR_HEIGHT, COLORS.track)
      .setOrigin(0, 0)
      .setDepth(1000)
      .setStrokeStyle(1, COLORS.frame);

    const fill = scene.add
      .rectangle(x + 1, y + 21, BAR_WIDTH - 2, BAR_HEIGHT - 2, isAlly ? COLORS.ally : COLORS.foe)
      .setOrigin(0, 0)
      .setDepth(1001);

    const value = scene.add
      .text(x, y + 32, '', {
        fontFamily: 'serif',
        fontSize: '13px',
        color: '#cdbd97',
        stroke: '#000000',
        strokeThickness: 3,
      })
      .setDepth(1000);

    return { unit, name, track, fill, value };
  }

  refresh() {
    this.rows.forEach(({ unit, fill, value }) => {
      const ratio = unit.state.maxHp > 0 ? unit.state.hp / unit.state.maxHp : 0;
      fill.width = Math.max(0, (BAR_WIDTH - 2) * ratio);
      const qi = unit.stats.气 ? `　${TERMS.qi} ${unit.state.qi}` : '';
      value.setText(`${TERMS.hp} ${unit.state.hp} / ${unit.state.maxHp}${qi}`);
    });
  }
}
