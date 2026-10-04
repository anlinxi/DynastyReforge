import { menuFont, menuInk } from './nativeText.js';
/**
 * 战斗里的二级界面：**法寶 / 絕學的列表页**（说明板 + 插图板 + 列表板 +
 * 分类板 + 確定使用框）。
 *
 * 布局、每页几行、能不能选，全在 {@link ./listLayout.js}（纯函数，有回归）；
 * **这个文件里不要写坐标**。素材总账见 `docs/判据/战斗界面素材.md`。
 *
 * ## 两种素材、两个滑入方向
 *
 * | | 战斗素材 | 菜单素材 |
 * |---|---|---|
 * | 载入 | `anim.json` + `<key>-img<N>` 纹理 | `menu-<key>` 精灵表 |
 * | 取帧 | `imageOf()`（帧号≠图号，还要按第 0 帧归零） | 帧号直接当帧用 |
 * | 谁 | `ITF0031`/`ITF501`/`ITF0030`/`ITF502`/`ITF3005`/`ITF500` | `MEN5001`/`MEN0005`/`MEN5006`/`MEN4010…` |
 *
 * 滑入方向取决于 exe 给的构造坐标：法寶的说明板与插图板是**从下方**
 * （y=500）滑上来的，其余是左右。`SlidingBoard` 两种都认。
 */
import DEPTH from '../systems/depths.js';
import { warnOnce } from '../systems/warnOnce.js';
import { FONT_KEY } from '../config.js';
// ⭐ **列表行的样式与判据与平时菜单共用这一份**（`ui/listRows.js`）——
// 字号、墨色、红字、选中条的帧，一处都不要在这个文件里另定。
import { TEXT_TINT, ROW_FONT, drawRows, glyphTint } from './listRows.js';
import { MENU_SPEC_KEY, layersOf, textureKey } from './menuSpec.js';
import { ensureArtwork } from '../systems/loader.js';
import { packImage } from './packImage.js';
import {
  CATEGORY_BOARD, ITEM_CATEGORIES, SKILL_KIND_BOARD,
  LIST_BOARD, LIST_ROW, LIST_FLOURISH,
  SKILL_LIST_BOARD, SKILL_ROW, SKILL_FLOURISH,
  ROWS_PER_PAGE, rowY, pageSlice, pageOf, ARROW_SIZE,
  INFO_BOARD, SKILL_INFO_BOARD, ART_BOARD, ARTWORK, artworkOf,
  CONFIRM_BOX, GLYPH_KEY, GLYPH_ADVANCE, COST_ICON,
  digitFrames, wrapText,
} from './listLayout.js';
import { uiPointer } from '../systems/stageView.js';
import { noXbr } from '../hd/hdRender.js';

/** 滑进/滑出用多久。与主菜单同一个手感值。 */
const SLIDE_MS = 180;
/** 翻页箭头摆一帧多久。🟡 原作的帧时长没解，先用场景动画那套的 110ms。 */
const ARROW_FRAME_MS = 110;
/** 说明板里的字号。与列表同一个值 —— 见 `ui/listRows.js`。 */
const LIST_FONT = ROW_FONT;

/**
 * 第 `frame` 帧实际要画哪张图、相对**这件素材自己的原点**偏多少。
 *
 * ⚠️ 两条坑叠在一起：
 *
 * 1. **帧号 ≠ 图号** —— `anim.json` 的 `image_index` 才是要画哪张
 *    （`ITF0011` 是 13 帧 11 图）。
 * 2. ⭐ **有的素材图层坐标是屏幕绝对坐标**：四位那套（`ITF0031`/`ITF0030`/
 *    `ITF3005`）是 `(0,0)`，**三位那套**（`ITF035`/`ITF036`/`ITF040`/`ITF050`）
 *    是 **`(320,260)`**。直接当偏移加上去，板会飞到右下角。
 *    所以这里**以第 0 帧的图层坐标为基准归零**。
 */
function imageOf(scene, key, frame) {
  return packImage(scene, key, frame, { normalize: true, tag: '二级界面' });
}

export { imageOf };

/**
 * 把一张图设成某件素材的某一帧。两种素材都认，返回画得出来没有。
 *
 * ⚠️ 菜单素材**不能走 `imageOf`** —— 它们是精灵表，帧号直接当帧用。
 * 混了会一路刷 `has no frame`，而画面上「没有板」和「板没滑进来」长得一样。
 */
function setFrame(scene, img, spec, frame, x = 0, y = 0) {
  if (spec.menu) {
    const tex = textureKey(spec.key);
    if (!scene.textures.exists(tex)) {
      warnOnce(`menu-tex:${tex}`, `二级界面缺菜单素材 ${spec.key}，这一块不画`);
      img.setVisible(false);
      return false;
    }
    img.setVisible(true).setTexture(tex, frame).setPosition(x, y);
    return true;
  }
  const art = imageOf(scene, spec.key, frame);
  if (!art) { img.setVisible(false); return false; }
  img.setVisible(true).setTexture(art.key, art.frame).setPosition(x + art.dx, y + art.dy);
  return true;
}

/**
 * 一块从画面外滑进来的板。几个二级界面共用这套开合。
 *
 * `offscreenX` 给了就横向滑，`offscreenY` 给了就纵向滑 —— 判据是 exe 的
 * 构造坐标：法寶说明板与插图板构造在 y=500（画面下方 480 之外）。
 */
export class SlidingBoard {
  constructor(scene, spec, depth = DEPTH.HUD) {
    this.scene = scene;
    this.spec = spec;
    this.open = false;
    this.axis = spec.offscreenY != null ? 'y' : 'x';
    this.parked = spec.offscreenY ?? spec.offscreenX ?? (this.axis === 'y' ? spec.y : spec.x);
    this.root = scene.add
      .container(this.axis === 'x' ? this.parked : spec.x,
        this.axis === 'y' ? this.parked : spec.y)
      .setDepth(depth);
    this.board = scene.add.image(0, 0, '__DEFAULT').setOrigin(0, 0);
    this.root.add(this.board);
  }

  paint(frame = this.spec.frame ?? 0) {
    setFrame(this.scene, this.board, this.spec, frame);
  }

  slide(to, ease) {
    this.scene.tweens.add({
      targets: this.root, [this.axis]: to, duration: SLIDE_MS, ease,
    });
  }

  slideIn() {
    if (this.open) return;
    this.open = true;
    this.slide(this.axis === 'y' ? this.spec.y : this.spec.x, 'Quad.easeOut');
  }

  slideOut() {
    if (!this.open) return;
    this.open = false;
    this.slide(this.parked, 'Quad.easeIn');
  }

  destroy() { this.root.destroy(true); }
}

/**
 * **法寶的四类板**（用器 / 兵刃 / 雜類 / 暫置）。
 *
 * ⭐ 四个字**已经印在 `ITF0030` 上**，而且 **4 帧就是「选中哪一行」**
 * （选中那一行的字带装饰爪）—— 所以不用另画光标，选第 i 项画第 i 帧。
 */
export class CategoryMenu extends SlidingBoard {
  constructor(scene) {
    super(scene, CATEGORY_BOARD);
    this.index = 0;
    this.paint(0);
  }

  get selected() { return ITEM_CATEGORIES[this.index]; }

  /** 上下选。四类是固定项，**会回绕**（和主菜单一样，与列表不同）。 */
  move(step) {
    const n = ITEM_CATEGORIES.length;
    this.index = ((this.index + step) % n + n) % n;
    this.paint(this.index);
    return this.selected;
  }

  show(index = 0) {
    this.index = Math.min(ITEM_CATEGORIES.length - 1, Math.max(0, index));
    this.paint(this.index);
    this.slideIn();
  }

  hide() { this.slideOut(); }
}

/** **絕學的两类板「咒法 / 絕技」**（`ITF502`）。与四类板同构。 */
export class SkillKindMenu extends SlidingBoard {
  constructor(scene) {
    super(scene, SKILL_KIND_BOARD);
    this.index = 0;
    this.paint(0);
  }

  get selected() { return this.index; }

  move(step) {
    this.index = ((this.index + step) % 2 + 2) % 2;
    this.paint(this.index);
    return this.index;
  }

  show(index = 0) {
    this.index = index === 1 ? 1 : 0;
    this.paint(this.index);
    this.slideIn();
  }

  hide() { this.slideOut(); }
}

/**
 * **左边的说明板**。法寶与絕學是两套不同的板：
 *
 * | | 板 | 每行 | 最多 | 插图板 |
 * |---|---|---|---|---|
 * | 法寶 | `ITF0031` 帧1 265×148 @ (15,300) | 10 字 | 4 行 | 有，`ITF0031` 帧2 @ (98,120) |
 * | 絕學 | `MEN5001` 帧1 218×200 @ (30,120) | 7 字 | 6 行 | 无 |
 *
 * 插图板里贴的是**平时菜单那份道具画**（`MEN4010`~`4014`，格子 182×179，
 * 与插图板尺寸完全一致）——⭐ 原作自己就是这么复用的。
 */
export class InfoBoard {
  constructor(scene) {
    this.scene = scene;
    this.item = this.makeBoard(INFO_BOARD);
    this.skill = this.makeBoard(SKILL_INFO_BOARD);
    this.art = new SlidingBoard(scene, ART_BOARD);
    this.art.paint();
    // 道具插图画在插图板里，压在板面之上
    this.artwork = scene.add.image(ARTWORK.dx, ARTWORK.dy, '__DEFAULT')
      .setOrigin(0, 0).setVisible(false);
    this.art.root.add(this.artwork);
  }

  makeBoard(spec) {
    const board = new SlidingBoard(this.scene, spec);
    board.paint();
    board.text = noXbr(this.scene.add
      .bitmapText(spec.pad.x, spec.pad.y, menuFont(), '', LIST_FONT));
    board.text.setLineSpacing?.(spec.lineH - LIST_FONT);
    board.root.add(board.text);
    return board;
  }

  /**
   * @param {string} text 说明文字（**繁体** —— 字库按 Big5 码位索引，
   *   喂简体是**静默丢字**）
   * @param {string|null} artCode 物品编号（十六进制串）；给了就画插图
   */
  show(text, artCode = null) {
    const skill = artCode === null;
    const board = skill ? this.skill : this.item;
    const other = skill ? this.item : this.skill;
    board.text.setText(wrapText(text, board.spec.perLine, board.spec.maxLines));
    board.slideIn();
    other.slideOut();
    if (skill) { this.art.slideOut(); return; }
    this.art.slideIn();
    this.paintArtwork(artCode);
  }

  /**
   * 画道具插图。
   *
   * ⚠️ **帧号 ≠ 精灵表里的格号。** `menus.json` 的 `frames[帧][0].img` 才是
   * 格号，中间是有空帧的（那个编号没有插图）—— `MEN4012` 一共 **100 帧**、
   * 只有 **59 张图**，帧 53 对应 img 33。直接把帧号丢进 `setTexture` 会画出
   * **另一件道具**（用户：「这里的图像和对应的物品不匹配」）。
   * 菜单页一直是走 `layersOf()` 取 `img` 的，**照搬过来就对了**。
   *
   * 插图复用菜单L2资源；战斗已在入场准备，缓存存在时不会再请求。
   */
  paintArtwork(code) {
    const hit = artworkOf(code);
    if (!hit) { this.artwork.setVisible(false); return; }
    if (ensureArtwork(this.scene, () => this.paintArtwork(code))) return;
    const spec = this.scene.cache.json.get(MENU_SPEC_KEY);
    const layer = layersOf(spec, hit.asset, hit.frame, ARTWORK.dx, ARTWORK.dy)[0];
    const tex = textureKey(hit.asset);
    if (!layer || !this.scene.textures.exists(tex)) {
      this.artwork.setVisible(false);
      return;
    }
    this.artwork.setVisible(true).setTexture(tex, layer.img)
      .setPosition(layer.x, layer.y);
  }

  hide() {
    this.item.slideOut();
    this.skill.slideOut();
    this.art.slideOut();
  }

  destroy() {
    this.item.destroy(); this.skill.destroy(); this.art.destroy();
  }
}

/**
 * **「確定使用 / 取消」框** —— 菜单的 `MEN0005`，2 帧＝选中哪一行。
 *
 * ⚠️ **不是 `ITF036`**（那件印的是「確定使用／是／否」三行）。
 * 判据是用户的原作截图：弹出来的框只有两行，第二行是「取　消」。
 */
export class ConfirmBox extends SlidingBoard {
  constructor(scene) {
    super(scene, CONFIRM_BOX);
    this.yes = true;
    this.root.setVisible(false);
    this.paint(CONFIRM_BOX.frames.confirm);
  }

  hitTest(pointer) {
    const hits = this.scene.cache.json.get(MENU_SPEC_KEY)?.confirmUse?.hits ?? [];
    const p = uiPointer(pointer, this.root);
    const x = p.x - this.root.x, y = p.y - this.root.y;
    return hits.find(h => x >= h.x && x < h.x+h.w && y >= h.y && y < h.y+h.h)?.role ?? null;
  }

  /** ↑↓ 切「確定使用 / 取消」。 */
  toggle() {
    this.yes = !this.yes;
    this.paint(this.yes ? CONFIRM_BOX.frames.confirm : CONFIRM_BOX.frames.cancel);
    return this.yes;
  }

  show() {
    this.yes = true;
    this.paint(CONFIRM_BOX.frames.confirm);
    this.root.setVisible(true);
    this.open = true;
  }

  hide() { this.root.setVisible(false); this.open = false; }
}

/**
 * **列表板** —— 法寶与絕學各一套（板宽、行条宽、装饰 x 都不同）。
 *
 * 每一行是 `{ label, count, cost, enabled, payload, info }`：
 * `label` 画名字，`count` 画**中文数字**，`cost` 画消耗图标＋数，
 * `enabled=false` 的画成**红字**（列出来但选不了）。
 */
export class ListPanel extends SlidingBoard {
  /** @param {'item'|'skill'} kind 哪一页 —— 决定用哪块板、哪条行条。 */
  constructor(scene, kind = 'item') {
    const skill = kind === 'skill';
    super(scene, skill ? SKILL_LIST_BOARD : LIST_BOARD);
    this.kind = kind;
    this.row = skill ? SKILL_ROW : LIST_ROW;
    this.flourishSpec = skill ? SKILL_FLOURISH : LIST_FLOURISH;
    this.rows = [];
    this.index = 0;

    this.highlight = scene.add.image(0, 0, '__DEFAULT').setOrigin(0, 0).setVisible(false);
    this.root.add(this.highlight);

    this.flourish = {};
    for (const [side, spec] of Object.entries(this.flourishSpec)) {
      const img = scene.add.image(spec.x, spec.y, '__DEFAULT').setOrigin(0, 0).setVisible(false);
      this.root.add(img);
      this.flourish[side] = img;
    }

    /**
     * 翻页箭头的**摆动帧**。`ITF3006`/`ITF3007` 各 6 帧、图只有一张 ——
     * 动画全在图层的 y 偏移里（上箭头 2→1→0→0→1→2，下箭头反过来），
     * 也就是**上下轻轻点头**。只有「这个方向还有页」时才动。
     * 用户 2026-09-19：「可以翻页的时候它也不跳动」。
     */
    this.arrowFrame = 0;
    this.arrowTimer = scene.time.addEvent({
      delay: ARROW_FRAME_MS,
      loop: true,
      callback: () => { this.arrowFrame = (this.arrowFrame + 1) % 6; this.paintArrows(); },
    });

    this.labels = [];
    this.numbers = [];
    this.icons = [];
    for (let i = 0; i < ROWS_PER_PAGE; i += 1) {
      const label = noXbr(scene.add.bitmapText(0, 0, menuFont(), '', ROW_FONT));
      this.root.add(label);
      this.labels.push(label);
      this.numbers.push([]);
      this.icons.push(null);
    }
    this.paint();
  }

  get selected() { return this.rows[this.index] ?? null; }

  setRows(rows) {
    this.rows = [...(rows ?? [])];
    this.index = 0;
    this.draw();
  }

  /** 上下选。**到头就停，不回绕**。 */
  move(step) {
    const n = this.rows.length;
    if (!n) return null;
    this.index = Math.min(n - 1, Math.max(0, this.index + step));
    this.draw();
    return this.selected;
  }

  resetRow(i) {
    this.labels[i].setVisible(false);
    this.numbers[i].forEach((img) => img.setVisible(false));
    this.icons[i]?.setVisible(false);
  }

  /**
   * 画一串**中文数字**（`ITF1019`，帧号＝数字本身），**左对齐**。
   * 步进 16 是 exe 真值。
   */
  putNumber(i, value, x, y, tint) {
    const pool = this.numbers[i];
    const frames = digitFrames(value);
    frames.forEach((frame, k) => {
      const spec = imageOf(this.scene, GLYPH_KEY, frame);
      let img = pool[k];
      if (!spec) { if (img) img.setVisible(false); return; }
      if (!img) {
        img = this.scene.add.image(0, 0, spec.key, spec.frame).setOrigin(0, 0);
        this.root.add(img);
        pool[k] = img;
      }
      // ⚠️ `ITF1019` 的图**自带墨色**，不能再拿墨色去 tint（会相乘变粗）。
      // 判据写在 `ui/listRows.glyphTint`。
      img.setVisible(true).setTexture(spec.key, spec.frame).setTint(glyphTint(tint))
        .setPosition(x + GLYPH_ADVANCE * k + spec.dx, y + spec.dy);
    });
    for (let k = frames.length; k < pool.length; k += 1) pool[k]?.setVisible(false);
  }

  /** 绝学消耗那个图标：蓝圆＝耗元气、红勾玉＝耗体力（菜单素材 `MEN5006`）。 */
  putIcon(i, kind, x, y) {
    const tex = textureKey(COST_ICON.key);
    let img = this.icons[i];
    if (!this.scene.textures.exists(tex)) {
      warnOnce(`cost-icon:${tex}`, `消耗图标 ${COST_ICON.key} 没载入，绝学列表不画那个点`);
      if (img) img.setVisible(false);
      return;
    }
    if (!img) {
      img = this.scene.add.image(0, 0, tex, 0).setOrigin(0, 0);
      this.root.add(img);
      this.icons[i] = img;
    }
    img.setVisible(true).setTexture(tex, COST_ICON.frames[kind] ?? 1).setPosition(x, y);
  }

  draw() {
    this.paint();
    const { start } = pageSlice(this.index, this.rows.length);
    for (let i = 0; i < ROWS_PER_PAGE; i += 1) this.resetRow(i);

    // ⭐ **行怎么画由 `ui/listRows.js` 说了算**（与平时菜单同一份）；
    // 这里只提供「怎么贴图」那四支笔。
    drawRows(
      { rows: this.rows, cursor: this.index, top: start, perPage: ROWS_PER_PAGE },
      { ...this.row, y0: rowY(0), pitch: this.row.step },
      {
        bar: (i, frame, x, y) => {
          const hi = imageOf(this.scene, this.row.key, frame);
          if (!hi) { this.highlight.setVisible(false); return; }
          this.highlight.setVisible(true).setTexture(hi.key, hi.frame)
            .setPosition(x + hi.dx, y + hi.dy);
        },
        text: (i, str, x, y, tint) => {
          menuInk(this.labels[i], tint).setVisible(true).setText(str).setPosition(x, y);
        },
        number: (i, value, x, y, tint) => this.putNumber(i, value, x, y, tint),
        icon: (i, kind, x, y) => this.putIcon(i, kind, x, y),
      },
    );
    if (!this.rows.length) this.highlight.setVisible(false);

    this.paintArrows();
  }

  /** 这个方向还有没有页可翻。 */
  canPage(step) {
    const n = this.rows.length;
    if (n <= ROWS_PER_PAGE) return false;
    const next = pageOf(this.index) + step;
    return next >= 0 && next * ROWS_PER_PAGE < n;
  }

  /** 画上下翻页箭头：**还有页才摆动，没有页就藏起来**。 */
  paintArrows() {
    for (const [side, spec] of Object.entries(this.flourishSpec)) {
      const img = this.flourish[side];
      if (!img) continue;
      if (!this.open || !this.canPage(side === 'top' ? -1 : 1)) {
        img.setVisible(false);
        continue;
      }
      setFrame(this.scene, img, spec, this.arrowFrame, spec.x, spec.y);
    }
  }

  /** 整页翻。到头就停，与 `moveIndex` 同一条判据（列表不回绕）。 */
  page(step) {
    if (!this.canPage(step)) return null;
    const n = this.rows.length;
    const at = (pageOf(this.index) + step) * ROWS_PER_PAGE;
    this.index = Math.min(n - 1, Math.max(0, at));
    this.draw();
    return this.selected;
  }

  /**
   * 指针落在这块板的哪儿。
   *
   * ⚠️ 上一版战斗里**只有一条 `pointerdown → confirmCommand()`** ——
   * 点屏幕任何地方都会弹「確定使用」，而翻页箭头压根没接鼠标。
   * 用户 2026-09-19 报。
   *
   * @returns {{kind:'up'|'down'}|{kind:'row', index:number}|null}
   *   `null` ＝ 没点在这块板上，调用方**什么都别做**。
   */
  hitTest(pointer) {
    if (!this.open) return null;
    const ui = uiPointer(pointer, this.root);
    const lx = ui.x - this.root.x;
    const ly = ui.y - this.root.y;
    for (const [side, spec] of Object.entries(this.flourishSpec)) {
      const step = side === 'top' ? -1 : 1;
      if (!this.canPage(step)) continue;
      if (lx >= spec.x && lx < spec.x + ARROW_SIZE.w
        && ly >= spec.y && ly < spec.y + ARROW_SIZE.h) {
        return { kind: step < 0 ? 'up' : 'down' };
      }
    }
    const { start } = pageSlice(this.index, this.rows.length);
    for (let i = 0; i < ROWS_PER_PAGE; i += 1) {
      const row = this.rows[start + i];
      if (!row) break;
      const top = rowY(i);
      if (lx >= this.row.x && lx < this.row.x + this.row.width
        && ly >= top && ly < top + this.row.height) {
        return { kind: 'row', index: start + i };
      }
    }
    return null;
  }

  show() { this.draw(); this.slideIn(); }

  hide() { this.slideOut(); this.paintArrows(); }

  destroy() {
    this.arrowTimer?.remove();
    this.arrowTimer = null;
    super.destroy();
  }
}
