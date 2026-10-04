import { menuFont } from './nativeText.js';
import { FONT_SIZE } from '../config.js';
import DEPTH from '../systems/depths.js';
import { imageOf } from './ListPanel.js';
import { TEXT_TINT } from './slotRows.js';
import { digitFrames } from './listLayout.js';
import { barFrame } from './hudLayout.js';
import { experienceRemaining } from '../systems/formulas.js';
import { playSfx } from '../systems/audioSettings.js';

// 0x4125e7–0x412917的构造坐标；正文/五外对照screenshots/yc_sc/战斗胜利-*。
const BOARD = { x: 90, y: 100 };
const ATTRIBUTES = [['膂力', '膂力'], ['灵力', '靈力'], ['体魄', '體魄'], ['迅捷', '迅捷'], ['机运', '機運']];
const RED = 0xff0000;

/** 原作战利框和成长板；文字颜色分段，已有历练保留在角色，页面只显示距下阶所需。 */
export default class BattleResults {
  constructor(scene, spoils, upgrades, catalog, done, { retreat = false } = {}) {
    this.scene = scene; this.catalog = catalog; this.done = done; this.index = -1;
    this.spoils = spoils;
    const loot = (spoils?.物品 ?? []).map(code => `獲得物品  ${catalog?.物品(code)?.名称繁 ?? code}`);
    this.pages = retreat ? [{ retreat: true }] : [{ reward: true }];
    for (let i = 0; i < loot.length; i += 3) this.pages.push({ lines: loot.slice(i, i + 3) });
    for (const upgrade of upgrades ?? []) {
      this.pages.push({ upgrade });
      for (let i = 0; i < (upgrade.learned?.length ?? 0); i += 4) {
        this.pages.push({ upgrade, learned: upgrade.learned.slice(i, i + 4) });
      }
    }
    this.root = scene.add.container(0, 0).setDepth(DEPTH.HUD + 100);
    this.next();
  }
  put(key, frame, x, y) {
    const art = imageOf(this.scene, key, frame);
    if (art) this.root.add(this.scene.add.image(x + art.dx, y + art.dy, art.key, art.frame).setOrigin(0, 0));
  }
  text(value, x, y, tint = TEXT_TINT) {
    const obj = this.scene.add.bitmapText(x, y, menuFont(tint), value, FONT_SIZE);
    this.root.add(obj); return obj;
  }
  number(value, x, y, key = 'ITF0012', step = 6) {
    digitFrames(value).forEach((frame, i) => this.put(key, frame, x + i * step, y));
  }
  fragments(parts, x, y) {
    for (const [value, tint] of parts) x += this.text(value, x, y, tint).width;
  }
  next() {
    if (this.closed) return;
    this.root.removeAll(true);
    const page = this.pages[++this.index];
    if (!page) { this.closed = true; this.destroy(); this.done?.(); return; }
    const { x, y } = BOARD;
    if (page.retreat) {
      this.put('ITF0400', 0, x, y);
      this.text('      全  隊  脫  逃', x + 26, y + 15);
    } else if (page.reward) {
      this.put('ITF0400', 0, x, y);
      this.text('      交  戰  全  勝', x + 26, y + 15);
      this.fragments([['獲得經驗值 ', TEXT_TINT], [String(this.spoils?.历练 ?? 0), RED]], x + 26, y + 43);
      this.fragments([['獲得金錢 ', TEXT_TINT], [String(this.spoils?.金钱 ?? 0), RED], [' 兩', TEXT_TINT]], x + 26, y + 71);
    } else if (page.lines) {
      this.put('ITF0400', 0, x, y);
      page.lines.forEach((line, i) => this.text(line, x + 26, y + 15 + i * 28));
    } else {
      const { before, after } = page.upgrade;
      if (!page.learned) playSfx(this.scene, 'level-up');
      this.put('ITF0400', 1, x, y);
      this.put('ITF0051', after.code - 1, x + 40, y + 32);
      this.put('ITF0053', after.code - 1, x + 14, y + 32);
      this.number(after.位阶, x + 171, y + 32, 'ITF1019', 18);
      for (const [key, cur, max, bx, by, yy] of [
        ['ITF0004', after.命, after.命极, 146, 62, 69],
        ['ITF0005', after.气, after.气极, 145, 91, 97],
      ]) {
        const count = this.scene.cache.json.get(`${key}-anim`)?.frames.length ?? 69;
        this.put(key, barFrame(max ? cur / max : 0, count), x + bx, y + by);
        this.number(cur, x + 152, y + yy); this.number(max, x + 190, y + yy);
      }
      this.number(experienceRemaining(after, this.scene.cache.json.get('gamedata')?.历练门槛),
        x + 67, y + 122, 'ITF1019', 18);
      if (page.learned) {
        // 提示标题与技能列表分层；沿用点阵原尺寸，避免缩放破坏笔画。
        this.text('習得絕學', x + 120, y + 160, 0x8b2b1d).setOrigin(0.5, 0);
        this.root.add(this.scene.add.rectangle(x + 32, y + 188, 176, 1, 0x8b6a40, 0.55).setOrigin(0, 0));
        page.learned.forEach((code, i) => this.text(this.catalog?.绝学(code)?.名称繁 ?? code,
          x + 40, y + 194 + i * 24));
      } else {
        ATTRIBUTES.forEach(([key, title], i) => {
          const yy = y + 160 + i * 28;
          this.text(title, x + 25, yy);
          this.text(String(before[key]), x + 90, yy);
          this.text('>', x + 140, yy);
          this.text(String(after[key]), x + 168, yy);
        });
      }
    }
  }
  destroy() { this.root?.destroy(); this.root = null; }
}
