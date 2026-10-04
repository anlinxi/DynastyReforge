import { hdScaleOf } from '../hd/hdRender.js';
import { layersOf, textureKey } from './menuSpec.js';
import { ARROW_STEP_MS } from './listArrows.js';
import {
  slotCenter, slotToCell, cellToSlot, slotsOf, moveTo, ROWS, COLS, TILE_SIZE,
} from '../systems/formation.js';
import { uiPointer } from '../systems/stageView.js';

/** 阵形页格子上的小人与选中框。 */
const FORMATION_PAWN = 'MEN7003';
const FORMATION_BOX = 'MEN7002';
/** 小人贴图底边比格心低几像素（脚踩在格子中央偏下一点）。**手感值**。 */
const PAWN_FOOT = 6;
/** 没被选中的队员画淡一点，好认出「现在动的是谁」。**手感值**。 */
const PAWN_DIM = 0.75;

/**
 * 阵形页的控制器：格盘上的队员、光标格、先选人再交换。
 *
 * 格心是量出来的（`systems/formation.js`），与战场用同一套 `位置 0~7 → 格` 的映射，
 * 所以这一页看到的就是打起来的站位。站位改动写回队伍（`menu.party`）并 `menu.pushState()`。
 * 菜单本体保留 `formationSlot` / `formationSource` 读写接口（验证脚本在用）。
 * （2026-10-04 从 MenuScreen 拆出，QA-04；行为不变。）
 */
export class FormationPage {
  /** @param {import('./MenuScreen.js').default} menu */
  constructor(menu) {
    this.menu = menu;
    /** 光标停在哪一格（位置 0~7）；`null` = 还没进来过，第一次取时停在选中那个人身上。 */
    this.slot = null;
    /** 已选中、等着换位置的队员下标；`null` = 还没选人。 */
    this.source = null;
  }

  /** 光标停在哪一格（位置 0~7）。第一次进来停在选中那个人身上。 */
  cell() {
    if (this.slot === undefined || this.slot === null) {
      const { party } = this.menu;
      const slots = slotsOf(party);
      this.slot = slots[party?.选中 ?? 0] ?? slots[0] ?? 7;
    }
    return this.slot;
  }

  /**
   * **阵形页：把队员画到格盘上，并标出光标格。**
   *
   * ⚠️ 这一页此前是**一张静态图** —— 格盘画着，上面一个人都没有，
   * 也没法换位置。用户的原话：「你现在菜单阵型里面都没有人，
   * 我怎么知道战斗时候人站得对不对啊？」
   *
   * 小人用 `MEN7003`：**帧序 = 战斗角色代码 − 1**，与半身立绘、竖排姓名
   * 同一套编号（见 `ui/menuSpec.js`）。
   */
  draw() {
    const menu = this.menu;
    if (menu.page?.key !== '阵形') return;
    const members = menu.party?.members ?? [];
    if (!members.length) return;
    const slots = slotsOf(menu.party);

    // 先画光标格（在人下面），层1 才显示 —— 层0 时焦点在标签栏上。
    const sourceSlot = this.source == null ? null : slots[this.source];
    if (menu.focus === 1 && this.cell() !== sourceSlot) this.drawCellCursor(this.cell());
    if (sourceSlot != null) this.drawCellCursor(sourceSlot, 'MEN7004');

    // 靠后的先画，前排压住后排。
    const order = members
      .map((m, i) => ({ m, i, slot: slots[i] }))
      .sort((a, b) => slotCenter(a.slot).y - slotCenter(b.slot).y);
    for (const { m, i, slot } of order) {
      const at = slotCenter(slot);
      const frame = Math.max(0, Number(m.code ?? 1) - 1);
      // `drawTile` 按图号贴，原点在左上 —— 小人要脚踩格心，所以往回挪半身。
      const meta = menu.spec.assets?.[FORMATION_PAWN];
      const w = meta?.cell?.[0] ?? 0;
      const h = meta?.cell?.[1] ?? 0;
      menu.drawTile(FORMATION_PAWN, frame, at.x - w / 2, at.y - h + PAWN_FOOT,
                    this.source == null || i === this.source ? 1 : PAWN_DIM);
    }
  }

  /** 悬停与选中分别复用原作16帧贴图；选中色偏红，混合方式仍待对照。 */
  drawCellCursor(slot, asset = FORMATION_BOX) {
    const menu = this.menu;
    const at = slotCenter(slot);
    const meta = menu.spec.assets[asset];
    const [w, h] = meta.cell;
    const frame = Math.floor(menu.clock / ARROW_STEP_MS) % meta.frames.length;
    const origin = layersOf(menu.spec, asset, frame, 0, 0)[0];
    // 原贴图约82×41，而格盘实际一格约114×58；按格盘两个轴的跨度铺满。
    const { width, height } = TILE_SIZE;
    // 显式缩放会盖掉高清图自带的 1/倍数，要自己除掉（2 倍菜单图下框曾放大一倍铺出格盘）。
    const hd = hdScaleOf(textureKey(asset));
    for (const layer of layersOf(menu.spec, asset, frame, 0, 0)) {
      const img = menu.scene.add.image(at.x - width / 2 + (layer.x - origin.x) * width / w,
        at.y - height / 2 + (layer.y - origin.y) * height / h, textureKey(asset), layer.img)
        .setOrigin(0).setScrollFactor(0).setScale(width / w / hd, height / h / hd)
        .setBlendMode(layer.blend).setAlpha(layer.alpha);
      menu.container.add(img); menu.parts.push(img);
    }
  }

  /** 光标在格盘上走一步。行/列都不越界。 */
  step(dRow, dCol) {
    const { row, col } = slotToCell(this.cell());
    const r = Math.min(ROWS - 1, Math.max(0, row + dRow));
    const c = Math.min(COLS - 1, Math.max(0, col + dCol));
    this.slot = cellToSlot(r, c);
    this.menu.render();
  }

  /**
   * 先选人：光标格上有人就记为来源；已经选了人就把他挪到光标格，格上有人则两人对调。
   *
   * 站位**会存进存档** —— 存档的队伍区 `@56648` 就是阵型格号
   * （2026-09-11 解出，见 `tools/tsf_parse.py` 的 `PARTY_SLOTS_OFF`），
   * 由 `saveslot.captureSave` 跟队伍一起写出去。
   */
  placeHere() {
    const menu = this.menu;
    const slots = slotsOf(menu.party);
    if (this.source == null) {
      const index = slots.indexOf(this.cell());
      if (index < 0 || !menu.party?.members?.[index]) return;
      this.source = index;
      menu.render();
      return;
    }
    const next = moveTo(slots, this.source, this.cell());
    this.source = null;
    menu.party = Object.freeze({ ...menu.party, 站位: Object.freeze(next) });
    menu.pushState();
    menu.render();
  }

  /** 撤销「已选人」（ESC）；返回 true 表示这一下被它吃掉了。 */
  cancelSource() {
    if (this.source == null) return false;
    this.source = null;
    this.menu.render();
    return true;
  }

  /**
   * 格盘的点击区：先按小人贴图的不透明像素命中（前排优先），没点中人再找最近的空格。
   * 悬停把光标移过去，点击走 `placeHere`。
   */
  buildHits() {
    const menu = this.menu;
    if (menu.page?.key !== '阵形') return;
    const pick = (pointer) => {
      const p = uiPointer(pointer); // 宽屏时扣掉居中 640 界面的左边距
      const slots = slotsOf(menu.party);
      const [w, h] = menu.spec.assets[FORMATION_PAWN].cell;
      const pawns = menu.party.members.map((member, i) => ({ slot: slots[i], member, ...slotCenter(slots[i]) })).sort((a,b) => b.y-a.y);
      let at = pawns.find(a => {
        const x = Math.floor(p.x-a.x+w/2), y = Math.floor(p.y-a.y+h-PAWN_FOOT);
        if (x < 0 || y < 0 || x >= w || y >= h) return false;
        return menu.scene.textures.getPixelAlpha(x,y,textureKey(FORMATION_PAWN),Math.max(0,Number(a.member.code)-1)) > 0;
      });
      if (!at) {
        at = Array.from({ length: 8 }, (_, slot) => ({ slot, ...slotCenter(slot) }))
          .sort((a,b) => ((a.x-p.x)/(TILE_SIZE.width/2))**2+((a.y-p.y)/(TILE_SIZE.height/2))**2
            - ((b.x-p.x)/(TILE_SIZE.width/2))**2-((b.y-p.y)/(TILE_SIZE.height/2))**2)[0];
        if (Math.abs(at.x-p.x)/(TILE_SIZE.width/2) + Math.abs(at.y-p.y)/(TILE_SIZE.height/2) > 1) return;
      }
      return at.slot;
    };
    const hover = p => {
      const slot = pick(p);
      if (slot == null) return false;
      if (menu.focus !== 1 || this.slot !== slot) {
        menu.focus = 1;
        this.slot = slot;
        menu.queueRender();
      }
      return true;
    };
    menu.addZone({ x: 289, y: 210, w: 342, h: 254 }, null, p => {
      if (hover(p)) this.placeHere();
    }).on('pointermove', hover);
  }
}
