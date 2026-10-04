import { menuFont } from './nativeText.js';
/**
 * **諸態页** —— 战斗里看队员状态的那两块板（用户 2026-09-18 的原作截图 3）。
 *
 * ```
 *  ┌─────────────────────┐   ┌──────────────────┐
 *  │ 頭像 位階\二〇      │   │ 兵刃\九陽煌珠    │
 *  │ 慕  命 ▭▭ 324\328  │   │ 甲衣\七色蝶裳    │
 *  │ 容  氣 ▭▭ 227\227  │   │ 飾物\白獸魂石    │
 *  │ 璇  歷練\〇         │   │ 諸能\            │
 *  │ 璣                  │   │   攻擊 一〇七〇  │
 *  ├─────────────────────┤   │   護禦 一〇三〇  │
 *  │ 火▲六三 闇▲五四一七 │   │   命中   一四〇  │
 *  │ 冰▼ 四  化▲  二五  │   │   閃避     五五  │
 *  │ 雷▲ 〇  析▲  二七  │   └──────────────────┘
 *  │ 光▼     法▲        │      ↑ ITF040 180×293
 *  ├─────────────────────┤
 *  │ □□□□□□□  ← 7×2 状态格
 *  │ □□□□□□□
 *  └─────────────────────┘
 *     ↑ ITF050 238×330
 * ```
 *
 * ## 素材（都在 `docs/判据/战斗界面素材.md` 里）
 *
 * | 代号 | 是什么 |
 * |---|---|
 * | `ITF050` | 左板：板上**印着**「位階＼ 命 氣 歷練＼ 火冰雷光 闇化析法」与 7×2 空格 |
 * | `ITF040` | 右板：板上**印着**「兵刃＼ 甲衣＼ 飾物＼ 諸能＼ 攻擊 護禦 命中 閃避」 |
 * | `ITF0051` | 队员头像 69×80，7 帧＝七个人 |
 * | `ITF0053` | **竖排名字**（「夏侯儀」竖着写）21×80，7 帧 |
 * | `ITF0052` | **状态图标 25×25，23 种** —— 填进左板下方那 7×2 格 |
 * | `ITF1019` | 中文数字 17×16，**帧号＝数字本身** |
 *
 * ## ⚠️ 用的是**三位那一套**（`ITF050`/`ITF040`），不是四位的 `ITF0050`
 *
 * 两套素材成对存在：`ITF0050` 渲出来抗性是**彩色图标**，`ITF050` 是
 * **文字「火冰雷光／闇化析法」** —— 用户的原作截图是文字版。
 * exe 是 300块 MOD 版的，它点名 `ITF0050`；**我们跟官方版素材走**。
 *
 * ## 🟡 板内各处的落位
 *
 * exe 簇 7 给的是**四位那套**的子元素坐标，板型不同套不过来。
 * 这里的坐标**量自原作截图**，登记在 `docs/状态/复现度台账.md`。
 */
import { physicalAttack, physicalGuard, evasionOf } from '../systems/combat.js';
import { hasState, stateIconFrames } from '../systems/battleStates.js';
import { experienceRemaining } from '../systems/formulas.js';
import DEPTH from '../systems/depths.js';
import { FONT_KEY, FONT_SIZE } from '../config.js';
import { TEXT_TINT } from './slotRows.js';
import { SlidingBoard, imageOf } from './ListPanel.js';
import {
  GLYPH_KEY, GLYPH_ADVANCE, SMALL_GLYPH_KEY, SMALL_GLYPH_ADVANCE, digitFrames,
  LEFT_BOARD, RIGHT_BOARD, LEFT_SLOTS, RIGHT_SLOTS, RESIST_FIELDS,
} from './listLayout.js';

export {
  LEFT_BOARD, RIGHT_BOARD, LEFT_SLOTS, RIGHT_SLOTS, RESIST_FIELDS,
} from './listLayout.js';
import { noXbr } from '../hd/hdRender.js';
export { statusPackKeys } from './listLayout.js';

/**
 * ⚠️ **必须用字库原生的 24**。`yc24` 是 24×24 的点阵字，缩到 20 就是
 * 「笔画又细又断开」—— 用户原话：「这个字体也很奇怪，又变得特别细，
 * 有一些断开的感觉」。全项目别处都用 `FONT_SIZE`，只有这里写死过 20。
 */
const FONT = FONT_SIZE;

export default class StatusPage {
  constructor(scene) {
    this.scene = scene;
    this.left = new SlidingBoard(scene, LEFT_BOARD, DEPTH.HUD);
    this.right = new SlidingBoard(scene, RIGHT_BOARD, DEPTH.HUD);
    this.left.paint();
    this.right.paint();
    this.index = 0;
    /** 名字 → 对象，惰性建。 */
    this.parts = new Map();
    this.numbers = new Map();
    this.stateIcons = [];
  }

  get open() { return this.left.open; }

  img(container, name, key, frame, x, y) {
    // ⚠️ 一律走 `imageOf`：帧号≠图号，而且三位那套素材的图层坐标是
    // **屏幕绝对坐标**（见 `ListPanel.imageOf` 的说明）。
    const spec = imageOf(this.scene, key, frame);
    let obj = this.parts.get(name);
    if (!spec) { if (obj) obj.setVisible(false); return; }
    if (!obj) {
      obj = this.scene.add.image(0, 0, '__DEFAULT').setOrigin(0, 0);
      container.add(obj);
      this.parts.set(name, obj);
    }
    obj.setVisible(true).setTexture(spec.key, spec.frame).setPosition(x + spec.dx, y + spec.dy);
  }

  /**
   * 画一串数字。**左对齐**、按 `step` 逐位排 —— exe 给的就是
   * `(x, y, step, step)`：左上角加步进，不是右对齐。
   *
   * ⚠️ 两套字形表不能混：位階/歷練是大字形 `ITF1019`（17×16，步进 18），
   * 命/氣的当前与上限是小字形 `ITF0012`（6×10，步进 6）。上一版全用了大的，
   * 数一长就冲出板外。
   */
  number(container, name, value, x, y, key = GLYPH_KEY, step = GLYPH_ADVANCE) {
    const frames = value == null ? [] : digitFrames(value);
    const pool = this.numbers.get(name) ?? [];
    this.numbers.set(name, pool);
    frames.forEach((frame, k) => {
      const spec = imageOf(this.scene, key, frame);
      let obj = pool[k];
      if (!spec) { if (obj) obj.setVisible(false); return; }
      if (!obj) {
        obj = this.scene.add.image(0, 0, '__DEFAULT').setOrigin(0, 0);
        container.add(obj);
        pool[k] = obj;
      }
      obj.setVisible(true).setTexture(spec.key, spec.frame)
        .setPosition(x + step * k + spec.dx, y + spec.dy);
    });
    for (let k = frames.length; k < pool.length; k += 1) pool[k]?.setVisible(false);
  }

  /** 右板那四行装备名用系统字（原作那四个词是板上印的，名字是动态的）。 */
  label(container, name, text, x, y) {
    let obj = this.parts.get(name);
    if (!obj) {
      obj = noXbr(this.scene.add.bitmapText(0, 0, menuFont(), '', FONT));
      container.add(obj);
      this.parts.set(name, obj);
    }
    obj.setVisible(true).setText(text ?? '').setPosition(x, y);
  }

  /**
   * 换一个人。
   *
   * @param {object} unit `BattleUnit`
   * @param {number} portraitFrame 头像/竖名的帧号（＝人物代码 − 1）
   * @param {object} [equip] `{兵刃, 甲衣, 飾物, 諸能}` 名字
   */
  render(unit, portraitFrame = 0, equip = {}) {
    if (!unit) return;
    const L = this.left.root;
    const R = this.right.root;
    const s = LEFT_SLOTS;

    const enemy = unit.def?.side === 'foe';
    this.img(L, 'portrait', s.portrait.key, portraitFrame, s.portrait.x, s.portrait.y);
    this.img(L, 'vname', s.vname.key, portraitFrame, s.vname.x, s.vname.y);

    this.parts.get('portrait')?.setVisible(!enemy);
    this.parts.get('vname')?.setVisible(!enemy);
    const enemyName = enemy ? [...unit.name].map((ch, i) => `${i > 0 && i % 2 === 0 ? '\n' : ''}${ch}`).join('') : '';
    this.label(L, 'enemyName', enemyName, s.portrait.x, s.portrait.y);
    const hp = unit.state?.hp ?? 0;
    const maxHp = unit.state?.maxHp ?? 1;
    const qi = unit.state?.qi ?? 0;
    const maxQi = unit.state?.maxQi ?? 0;

    // 命/氣两条槽：`ITF0004`/`ITF0005` 各 69 帧，**帧 0 最满**。
    const barFrame = (cur, max) => Math.max(
      0, Math.min(68, Math.round((1 - (max ? cur / max : 0)) * 68)));
    this.img(L, 'hpBar', s.hpBar.key, barFrame(hp, maxHp), s.hpBar.x, s.hpBar.y);
    this.img(L, 'qiBar', s.qiBar.key, barFrame(qi, maxQi), s.qiBar.x, s.qiBar.y);

    this.number(L, 'rank', Number(unit.stats?.位阶) || 0, s.rank.x, s.rank.y,
      GLYPH_KEY, s.rank.step);
    this.number(L, 'drill', experienceRemaining(unit.stats, this.scene.cache.json.get('gamedata')?.历练门槛), s.drill.x, s.drill.y,
      GLYPH_KEY, s.drill.step);
    for (const [name, value, slot] of [
      ['hpCur', hp, s.hpCur], ['hpMax', maxHp, s.hpMax],
      ['mpCur', qi, s.mpCur], ['mpMax', maxQi, s.mpMax],
    ]) {
      this.number(L, name, value, slot.x, slot.y, SMALL_GLYPH_KEY, SMALL_GLYPH_ADVANCE);
    }

    // 八抗性：板上印着「火冰雷光／闇化析法」，这里只画数。
    // BattleUnit提供双方真实及身抗性；没有依据的数据保持空白，不以0伪装。
    RESIST_FIELDS.forEach((col, ci) => {
      col.forEach((field, ri) => {
        const raw = unit.resists?.[field] ?? unit.stats?.[field];
        const x = ci === 0 ? s.resist.leftX : s.resist.rightX;
        this.number(L, `resist${ci}${ri}`, raw == null ? null : Number(raw),
          x, s.resist.firstY + s.resist.step * ri);
      });
    });

    this.drawStates(L, stateIconFrames(unit.statuses, this.scene.cache.json.get('gamedata')?.战斗规则));

    this.label(R, 'weapon', equip.兵刃 ?? '', RIGHT_SLOTS.weapon.x, RIGHT_SLOTS.weapon.y);
    this.label(R, 'armor', equip.甲衣 ?? '', RIGHT_SLOTS.armor.x, RIGHT_SLOTS.armor.y);
    this.label(R, 'trinket', equip.飾物 ?? '', RIGHT_SLOTS.trinket.x, RIGHT_SLOTS.trinket.y);
    this.label(R, 'talent', equip.諸能 ?? '', RIGHT_SLOTS.talent.x, RIGHT_SLOTS.talent.y);

    // 攻擊/護禦/命中/閃避。⚠️ 字段名是 `equipment.BONUS_FIELDS` 里那套
    // （`攻击补正`…），写成 `攻击`/`护御` 会全是 0 —— 实机上是一排「〇」。
    const b = unit.bonuses ?? {};
    const base = unit.combatStats ?? unit.stats ?? {};
    [
      physicalAttack(base, b),
      physicalGuard(base, b),
      Math.trunc((100 + (b.命中补正 ?? 0)) * (hasState(base, 26) ? 1.3 : hasState(base, 7) ? .7 : 1)),
      evasionOf(base, b),
    ].forEach((value, i) => {
      this.number(R, `stat${i}`, value,
        RIGHT_SLOTS.stats.x, RIGHT_SLOTS.stats.ys[i]);
    });
  }

  /**
   * 左板下方的 **7×2 状态格**。
   *
   * 槽位和对抗状态的显示优先级来自原作固定分支，空格保留原位。
   */
  drawStates(container, states) {
    const s = LEFT_SLOTS.states;
    const list = (states ?? []).slice(0, s.cols * s.rows);
    list.forEach((frame, i) => {
      const spec = imageOf(this.scene, s.key, frame);
      let obj = this.stateIcons[i];
      if (!spec) { if (obj) obj.setVisible(false); return; }
      if (!obj) {
        obj = this.scene.add.image(0, 0, '__DEFAULT').setOrigin(0, 0);
        container.add(obj);
        this.stateIcons[i] = obj;
      }
      obj.setVisible(true).setTexture(spec.key, spec.frame)
        .setPosition(s.x + s.stepX * (i % s.cols) + spec.dx,
          s.y + s.stepY * Math.floor(i / s.cols) + spec.dy);
    });
    for (let i = list.length; i < this.stateIcons.length; i += 1) {
      this.stateIcons[i]?.setVisible(false);
    }
  }

  show() { this.left.slideIn(); this.right.slideIn(); }

  hide() { this.left.slideOut(); this.right.slideOut(); }

  destroy() { this.left.destroy(); this.right.destroy(); }
}
