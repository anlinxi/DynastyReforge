import { menuFont, menuInk } from './nativeText.js';
/**
 * 购物界面。**不是八页菜单之一** —— 由剧情指令 `open_shop`（op54）弹出，
 * 背景是当前地图，界面直接盖在上面。
 *
 * **摆位全部来自 `assets/menus/menus.json` 的 `shop` 段**，那份由
 * `tools/export_menu_ui.py` 从原作 exe 的簇 6 提取。这个类只负责
 * 「按规格贴图 + 接交互」，不含坐标常量。
 *
 * ⚠️ 只有一个坐标是**截图实测**而非 exe 给的：确认框 `MEN9204`。
 * exe 那一处 x/y 从变量压栈，`extract_layout` 只认立即数。
 *
 * ⚠️ **本轮没画两样**（用户 2026-09-04 决定，见 `docs/状态/复现度台账.md`）：
 * * 「攻防閃中」预览面板 —— 官方原版有，但素材翻遍两个归档没找到
 * * 中间的物品插图 —— 素材是 `MEN4010`~`4014`，但编号↔帧号映射未建
 */
import Phaser from 'phaser';
import { ensureArtwork } from '../systems/loader.js';
import { MENU_SPEC_KEY, layersOf, tabHitAreas, textureKey } from './menuSpec.js';
import { paintNumber, advanceOf } from './glyphNumber.js';
import { arrowFrame, ARROW_STEP_MS } from './listArrows.js';
import { CATEGORIES, displayName } from '../systems/catalog.js';
import { itemsInCategory } from '../systems/inventory.js';
import {
  affordable, buy, countOf, sell, sellPrice, sellable, shopStock, signFrame,
} from '../systems/shop.js';
import { FONT_KEY, FONT_SIZE } from '../config.js';
import DEPTHS from '../systems/depths.js';
import { noXbr } from '../hd/hdRender.js';

/** 盖在场景与对话框之上。菜单是 900，对话框 2050，购物界面取中间。 */
const DEPTH = DEPTHS.SHOP;

/** 面板上的文字色，与菜单同一支墨。 */
const TEXT_TINT = 0x3a2418;
/** 买不起 / 卖不掉的那一行。与及身页「装不上」同一个红。 */
const BLOCKED_TINT = 0x8c2f24;

/**
 * 列表的行距与文字偏移。
 *
 * 🅓 **推断**：行距取素材 `MEN9203`/`MEN4003` 的格高 24，文字比条顶低 3
 * —— 后者照搬八页菜单列表的实测值（`LIST_ROWS.textDy`，那边是
 * 「字格顶 = 墨迹顶 − 2 = 条顶 + 3」）。购物界面没有单独实测过。
 */
const ROW_STEP = 24;
const TEXT_DY = 3;
/** 名称相对行左端的偏移，同样照搬八页菜单的 24。🅓 */
const NAME_DX = 24;

/**
 * 两侧列表各显示几行 —— **由下箭头的位置算**，不是按面板高度。
 *
 * ⚠️ 原先写死 10（「面板高 300 ÷ 行距 24」），而原作的判据是
 * **下箭头就是列表可视区的底**（`menus.json` 的 `listRows` 注释自己写着
 * 「行数按 (下箭头 y − 条 y) / 25 取整」）：
 *
 * ```
 * 右边背包：(266 − 53) / 24 = 8.875 → 8 行
 * 左边货架：(268 − 53) / 24 = 8.958 → 8 行
 * ```
 *
 * 多画的那两行正好越过箭头、压在面板边框上 —— 用户报的
 * 「没有翻页，会超出正常的页面部分，一路往下写」就是它。
 */
function rowsFor(panelSpec, rowSpec, arrows) {
  const down = arrows?.find((a) => a.role === 'arrow_down');
  if (!down) return 8;
  return Math.max(1, Math.floor((down.y - rowSpec.y) / ROW_STEP));
}

/**
 * 分类栏第一个分类的帧号。
 *
 * `MEN9102` 帧 0 高亮的是最右那个图标（img8），帧 1~6 才是六个分类
 * （img2~img7 = 用器/兵刃/護甲/飾物/雜類/暫置，与 `catalog.CATEGORIES` 同序）。
 */
const TAB_FRAME0 = 1;
/** 开店时默认停在哪一类。与法宝页的默认（`MenuScreen.submenuFrame.MEN4001`）一致。 */
const DEFAULT_TAB = 5;

/**
 * 箭头动画：**原作素材自带**。
 *
 * `MEN4004`（上）六帧的图层 y 是 `2,1,0,0,1,2`，`MEN4005`（下）是
 * `0,1,2,2,1,0` —— 同一张图逐帧上下偏移 2px，也就是一段 6 帧的循环跳动。
 * **翻不动的那个方向定格在"不偏移"那一帧**（上箭头帧 2、下箭头帧 0），
 * 用户要的「不跳动＝没有那一页了」就是这个。
 *
 * ⚠️ 两个箭头"不偏移"的帧号不同（上是 2、下是 0），但都用帧 0 也只差 2px，
 * 而且**静止时看不出来**，所以统一取 0，少一份表。
 */
/** 焦点不在本侧时选中条压暗，与八页菜单同规。 */
const DIM_ALPHA = 0.55;

/**
 * 列表数字相对行顶的偏移。照搬八页菜单列表的 `qtyDy`（7）——
 * MEN 字形比 24px 的字库汉字矮，要单独往下压一点才和名称对齐。🅓
 */
const QTY_DY = 7;

/**
 * 确认框里三个数的位置（相对框左上角）。
 *
 * ⭐ **全部从素材 `MEN9204` 的像素量出来**，不是看截图猜的：
 *
 * | 量到什么 | 像素范围 | 用途 |
 * |---|---|---|
 * | 标题行「目前現有數量 ▢ 個」的空档 | `x 177..218`（宽 42），墨迹 `y 14..35` | 现有数量，右对齐 |
 * | 灰色输入框 | `x 52..95, y 42..63`（44×22） | 待成交数量，右对齐 |
 * | 总价下划线 | `y=64, x 143..260` | 总价，右对齐、坐在线上 |
 *
 * ⚠️ **互证**：exe 给的加减钮坐标是 `(32,41)` 与 `(97,41)`、素材 16×24
 * ——正好贴在灰框（52..95）左右两侧。两组数据互相印证，说明这组坐标是对的。
 */
const CONFIRM_HAVE_RIGHT = 216;
const CONFIRM_HAVE_Y = 18;
const CONFIRM_QTY_RIGHT = 93;
const CONFIRM_TOTAL_RIGHT = 258;
const CONFIRM_VALUE_Y = 47;

export default class ShopScreen {
  /**
   * @param {Phaser.Scene} scene
   * @param {object} gamedata `assets/data/gamedata.json`
   * @param {object} catalog `createCatalog()` 的结果
   */
  constructor(scene, gamedata, catalog) {
    this.scene = scene;
    this.gamedata = gamedata;
    this.catalog = catalog;
    this.spec = scene.cache.json.get(MENU_SPEC_KEY);
    this.shop = this.spec?.shop ?? null;

    this.visible = false;
    this.shopId = null;
    this.stock = [];
    /** 0 = 左边货架（买），1 = 右边背包（卖）。 */
    this.side = 0;
    /**
     * 右边背包按哪个分类过滤（`catalog.CATEGORIES` 的下标）。
     *
     * ⚠️ **只过滤右边背包，不动左边货架** —— 那六格是**背包的六个容器**
     * （暫置/雜類/飾物/護甲/兵刃/用器），而店里卖的东西是一张平表。
     * 用户原话：「这里就是背包里面怎么样，现在就怎么样，物品该在哪儿
     * 就在哪儿，可以手动切换不同的类别去看卖出价格」。
     */
    this.tab = DEFAULT_TAB;
    /** 画箭头时用的时钟（毫秒）。`update` 每跨一拍才推一次，见那里。 */
    this.clock = 0;
    this.cursor = [0, 0];
    this.scroll = [0, 0];
    /** 确认框开着的时候，这里是待成交的数量；null = 没开框。 */
    this.pending = null;
    /**
     * 确认框底行选中哪个按钮：`0` = 確定購入／賣出，`1` = 取消。
     *
     * ⚠️ **判据在素材里**：`MEN9204` 四帧是「確定賣出/取消」与
     * 「確定購入/取消」各两种，**花括号（选中框）分别套在取消与確定上** ——
     * 素材自带两态高亮就说明原作有"左右选槽"这回事。渲染对照见
     * `docs/专题/菜单.md`。此前我们买用帧 2、卖用帧 0，**两个都是"取消"高亮**，
     * 而回车却一律购买 —— 画面与行为互相矛盾。
     *
     * 🅓 **默认选「確定」没有素材依据**（四帧看不出默认是哪个），
     * 按"开框就是要买"定的。见 `docs/状态/复现度台账.md`。
     */
    this.confirmFocus = 0;
    /**
     * **开店那一刻要吃掉正在派发的那个按键。**
     *
     * 玩家按空格跟掌柜说话 → `FieldScene` 的 SPACE 处理器打开商店
     * （`visible = true`）→ **Phaser 把同一个 keydown 继续派给本类的监听器**
     * → `confirm()` 当场开出确认框。用户报的「和掌柜对话之后直接就提示了
     * 购买第一个物品的确认窗」就是它。
     *
     * 与文档里那条「`bootToField` 之后不要按 Space —— 标题场景还活着」
     * 是同一个病根：**同一次按键被两套监听器吃到**。
     */
    this.armed = false;
    /** 关掉时回调，剧情执行器靠它继续往下走。 */
    this.onClose = null;

    this.container = scene.add.container(0, 0)
      .setScrollFactor(0).setDepth(DEPTH).setVisible(false);
    this.parts = [];
    this.hits = [];

    if (!this.spec?.shop) {
      console.warn('menus.json 里没有 shop 段，购物界面不可用');
      return;
    }
    this.bindInput();
  }

  // ————————————————————————— 开关 —————————————————————————

  /**
   * 开张。
   * @param {number} shopId 剧情 `open_shop` 给的编号
   * @param {() => void} onClose 关掉之后叫一声，剧情接着演
   */
  open(shopId, onClose = null) {
    if (!this.shop) { onClose?.(); return; }
    this.shopId = Number(shopId);
    this.stock = shopStock(this.gamedata, this.shopId, this.catalog);
    this.side = 0;
    // ⭐ **默认分类跟着法宝页走** —— 用户原话：「这里就是背包里面怎么样，
    // 现在就怎么样」。法宝页的二级菜单帧号就是 `CATEGORIES` 的下标
    // （`MenuScreen` 第 871 行，注释写着「`CATEGORIES` 的顺序就是帧号顺序」），
    // 默认是 5＝暂置。取不到就退回 5，与法宝页的默认一致。
    this.tab = Number(this.scene.statusScreen?.submenuFrame?.MEN4001 ?? DEFAULT_TAB);
    if (!Number.isFinite(this.tab) || this.tab < 0 || this.tab >= CATEGORIES.length) {
      this.tab = DEFAULT_TAB;
    }
    this.cursor = [0, 0];
    this.scroll = [0, 0];
    this.pending = null;
    this.confirmFocus = 0;
    this.onClose = onClose;
    this.visible = true;
    // ⚠️ 见 `this.armed`：开店那一帧不吃确认键，下一帧才接。
    this.armed = false;
    this.scene.time.delayedCall(0, () => { this.armed = true; });
    this.container.setVisible(true);
    // ⚠️ 场景的调试 HUD 与操作提示 depth 是 2000，**压在购物界面之上** ——
    // 不收起来的话左上角的招牌被「MP0207 (400,430)」盖住，
    // 底下还挂着「方向键行走 Shift 跑」。开店期间这两样都没有意义。
    this.scene.hud?.setVisible(false);
    this.scene.tip?.setVisible(false);
    this.render();
  }

  close() {
    if (!this.visible) return;
    this.visible = false;
    this.pending = null;
    this.container.setVisible(false);
    this.scene.hud?.setVisible(true);
    this.scene.tip?.setVisible(true);
    this.clearHits();
    const done = this.onClose;
    this.onClose = null;
    done?.();
  }

  /** 队伍与背包的正本在 registry 上，见 `systems/gameState.js`。 */
  state() {
    return this.scene.registry?.get?.('gameState') ?? null;
  }

  party() { return this.state()?.party ?? null; }

  inventory() { return this.state()?.inventory ?? []; }

  // ————————————————————————— 两侧的行 —————————————————————————

  /** 左边货架：这家店卖什么。买不起的染红。 */
  shopRows() {
    const money = this.party()?.金钱 ?? 0;
    return this.stock.map((row) => ({
      代码: row.代码,
      记录: row.记录,
      名称: displayName(row.记录) || `0x${row.代码}`,
      数值: row.售价,
      限购: row.限购,
      拦下: row.售价 > money,
    }));
  }

  /**
   * 右边背包：玩家手里有什么。
   *
   * ⚠️ **非卖品也列出来但染红**，而不是藏起来 —— 藏起来的话玩家会以为
   * 东西丢了。判据是默认售价 `-1`，见 `shop.sellable`。
   */
  bagRows() {
    const seen = new Map();
    // ⭐ **按分类栏当前那一格过滤** —— 判据与理由见 `this.tab`。
    for (const row of itemsInCategory(this.inventory(), CATEGORIES[this.tab],
                                      this.catalog)) {
      const 记录 = this.catalog?.物品?.(row.代码) ?? null;
      const at = seen.get(row.代码);
      if (at) { at.数值 += Number(row.数量) || 0; continue; }
      seen.set(row.代码, {
        代码: row.代码,
        记录,
        名称: displayName(记录) || `0x${row.代码}`,
        数值: Number(row.数量) || 0,
        拦下: !sellable(记录),
      });
    }
    return [...seen.values()];
  }

  rows(side = this.side) {
    return side === 0 ? this.shopRows() : this.bagRows();
  }

  /** 这一侧列表能显示几行。判据见 `rowsFor`。 */
  visibleRows(side = this.side) {
    const s = this.shop;
    return side === 0
      ? rowsFor(s.shopPanel, s.shopRow, s.shopArrows)
      : rowsFor(s.bagPanel, s.bagRow, s.bagArrows);
  }

  current() {
    return this.rows()[this.cursor[this.side]] ?? null;
  }

  // ————————————————————————— 贴图 —————————————————————————

  drawElement(asset, frame, x, y, alpha = 1) {
    layersOf(this.spec, asset, frame, x, y).forEach((l) => {
      const img = this.scene.add.image(l.x, l.y, textureKey(asset), l.img)
        .setOrigin(0, 0).setScrollFactor(0)
        .setBlendMode(l.blend).setAlpha(l.alpha * alpha);
      this.container.add(img);
      this.parts.push(img);
    });
  }

  text(str, x, y, tint = TEXT_TINT) {
    const t = noXbr(this.scene.add.bitmapText(x, y, menuFont(), str, FONT_SIZE)
      .setScrollFactor(0));
    menuInk(t, tint);
    this.container.add(t);
    this.parts.push(t);
    return t;
  }

  render(keepHits = false) {
    this.parts.forEach((p) => p.destroy());
    this.parts = [];
    if (!keepHits) this.clearHits();
    if (!this.visible || !this.shop) return;

    const s = this.shop;
    // 招牌：帧号由商店种类决定，只影响这块牌子上的字
    this.drawElement(s.sign.asset, signFrame(this.gamedata, this.shopId, s),
                     s.sign.x, s.sign.y);
    // 金钱框
    this.drawElement(s.money.asset, s.money.frame, s.money.x, s.money.y);
    paintNumber(this.scene, this.container, this.spec, s.moneyGlyphs.asset,
                this.party()?.金钱 ?? 0,
                { x: s.money.x + s.moneyGlyphs.x, y: s.money.y + s.moneyGlyphs.y,
                  align: 'left' },
                this.parts);
    // ⭐ **分类栏：高亮当前那一类。**
    // 判据在素材里：`MEN9102` 的 img2~img7 是**六个分类各自的高亮块**
    // （用器/兵刃/護甲/飾物/雜類/暫置，与 `catalog.CATEGORIES` 同序），
    // 帧 1~6 一一对应；img8（35×49）是最右那个图标的高亮，帧 0 用它。
    // ⚠️ 此前一律画**帧 0** —— 也就是高亮最右那个图标、不是任何分类，
    // 于是分类栏完全是摆设（用户读成「全都挂在暂置这一栏」）。
    this.drawElement(s.tabs.asset, TAB_FRAME0 + this.tab, s.tabs.x, s.tabs.y);
    // 三块面板
    this.drawElement(s.shopPanel.asset, s.shopPanel.frame, s.shopPanel.x, s.shopPanel.y);
    this.drawElement(s.detailPanel.asset, s.detailPanel.frame,
                     s.detailPanel.x, s.detailPanel.y);
    this.drawElement(s.bagPanel.asset, s.bagPanel.frame, s.bagPanel.x, s.bagPanel.y);
    // ⭐ **两侧的上下箭头：能翻页就跳动，不能就定格。**
    // 判据在素材里 —— `MEN4004`（上）六帧的 y 是 `2,1,0,0,1,2`，
    // `MEN4005`（下）是 `0,1,2,2,1,0`：**同一张图逐帧上下偏移 2px，
    // 就是原作自带的循环跳动**。此前只画帧 0，所以箭头是死的。
    [[0, s.shopPanel, s.shopArrows], [1, s.bagPanel, s.bagArrows]]
      .forEach(([side, base, arrows]) => {
        arrows.forEach((a) => {
          const up = a.role === 'arrow_up';
          const live = this.canScroll(side, up ? -1 : 1);
          this.drawElement(a.asset, arrowFrame(this.spec, a.asset, live, this.clock),
                           base.x + a.x, base.y + a.y);
        });
      });

    this.drawList(0, s.shopPanel, s.shopRow, s.shopPrice);
    this.drawList(1, s.bagPanel, s.bagRow, s.bagQty);
    this.drawDetail();
    if (this.pending !== null) this.drawConfirm();
    if (!keepHits) this.buildHits();
  }

  /** 一侧的列表。`glyph` 是右边那一列数字（左=价格，右=数量）。 */
  drawList(side, panel, rowSpec, glyph) {
    const rows = this.rows(side);
    const top = this.scroll[side];
    const focused = this.side === side && this.pending === null;
    const shown = this.visibleRows(side);
    for (let i = 0; i < shown; i += 1) {
      const row = rows[top + i];
      if (!row) break;
      const x = panel.x + rowSpec.x;
      const y = panel.y + rowSpec.y + ROW_STEP * i;
      const on = this.cursor[side] === top + i;
      // ⚠️ **只有选中那一行才画条。** 每行都画的话满屏白框，
      // 完全看不出光标在哪 —— 八页菜单的列表也是 `if (selected)`。
      // 选中条那几帧是宽度呼吸动画：焦点在本侧用最宽的帧 0，
      // 不在时用帧 3 并压暗，与菜单同规。
      if (on) this.drawElement(rowSpec.asset, focused ? 0 : 3, x, y, focused ? 1 : DIM_ALPHA);
      this.text(row.名称, x + NAME_DX, y + TEXT_DY,
                row.拦下 ? BLOCKED_TINT : TEXT_TINT);
      // ⚠️ **数字不能用 `MEN1018`/`MEN1019`（金钱框那套）** —— 它们每帧的图
      // 高度不一样（「一」只有 3px、「〇」有 14px），而精灵表是左上角对齐，
      // 于是矮的字贴着条顶、圆的字压出条底，一行数字高低不齐。
      // 列表要用 `MEN0028`（12×11，各帧齐平），八页菜单的数量列就是它。
      paintNumber(this.scene, this.container, this.spec, this.glyphAsset(), row.数值,
                  { x: x + glyph.x, y: y + QTY_DY, align: 'left' }, this.parts);
    }
  }

  /** 列表数字用的字形。取菜单列表同一套，理由见 `drawList`。 */
  glyphAsset() {
    return this.spec.interactions?.resistRows?.value?.asset ?? 'MEN0028';
  }

  /**
   * 中间那块：物品说明。
   *
   * ⚠️ **插图没画** —— `MEN4010`~`4014` 共 336 张在归档里，但物品编号 ↔
   * 帧号的映射还没建，且已知不是顺序对应。硬套会给一部分物品配错图，
   * 留空更诚实。见 `docs/专题/菜单.md` §10。
   */
  /**
   * 中间那块面板。
   *
   * ⚠️ **本轮什么都不画。** 原作这里是**物品插图**（`MEN4010`~`4014` 共 336 张），
   * 但编号↔帧号的映射还没建。曾经拿说明文字顶上，24px 的点阵字在这块
   * 182 宽的板子里又大又挤，比空着还难看 —— 用户 2026-09-04 定：先空着。
   */
  /**
   * 中间那块：**选中商品的插图**。
   *
   * 映射与法宝页共用（`MenuScreen.artworkFrame`），说明见那里。
   * ⚠️ 一度这里什么都不画（映射还没解开时用户说「没有就先空着」）。
   */
  drawDetail() {
    const at = this.spec.shop?.art;
    const cfg = this.spec.artwork;
    if (!at || !cfg) return;
    const row = this.current();
    if (!row) return;
    const n = parseInt(String(row.代码), 16);
    if (!Number.isFinite(n) || n < 0) return;
    const table = Math.floor(n / cfg.perTable);
    if (table >= cfg.tables.length) return;
    const asset = cfg.tables[table];
    if (!this.spec.assets?.[asset]) return;
    // L2：插图第一次要画时才拉，与法宝页共用，见 loader.ensureArtwork。
    if (ensureArtwork(this.scene, () => this.render())) return;
    this.drawElement(asset, n % cfg.perTable, at.x, at.y);
  }

  /**
   * 确认框：现有数量 + 待成交数量 + 总价 + 「確定購入／賣出」。
   *
   * 帧号：素材四帧是「確定賣出/取消」两种高亮 ×「確定購入/取消」两种。
   * 买用帧 2、卖用帧 0（都是「确定」那一侧高亮）。
   *
   * 🅓 **框内三个数的位置全是从原作截图量的**，exe 里没有 ——
   * 标题行那句印着「目前現有數量　個」，中间的数字缺口在两字之间。
   * 见 `docs/状态/复现度台账.md`。
   */
  drawConfirm() {
    const c = this.shop.confirm;
    // ⭐ **帧号 = 买卖 × 选中槽**。素材四帧（渲染对照见 `docs/专题/菜单.md`）：
    //   0 確定賣出/【取消】   1 【確定賣出】/取消
    //   2 確定購入/【取消】   3 【確定購入】/取消
    // 也就是「取消选中」是偶数帧、「確定选中」是奇数帧。
    // ⚠️ 此前写的是「买用帧 2、卖用帧 0」并注释成"都是确定那一侧高亮" ——
    // **读反了，两个都是取消高亮**，而回车一律购买，画面与行为矛盾。
    const base = this.side === 0 ? 2 : 0;
    this.drawElement(c.asset, base + (this.confirmFocus === 0 ? 1 : 0), c.x, c.y);
    // ⭐ **加减钮**（`MEN9206`，16×24）—— 规格里 `confirmParts` 本来就有
    // exe 给的两处 (32,41)/(97,41)，而这里从来没画，于是"点击的那个部位
    // 看不到箭头"。两张图＝减号与加号；帧 0/1 是 img1（左，减）、
    // 帧 2/3 是 img0（右，加），x 偏 1px 是按下态。
    (this.shop.confirmParts ?? []).forEach((part, i) => {
      this.drawElement(part.asset, i === 0 ? 0 : 2, c.x + part.x, c.y + part.y);
    });
    const row = this.current();
    const unit = this.side === 0 ? row?.数值 : sellPrice(row?.记录);
    const glyph = this.glyphAsset();
    const adv = advanceOf(this.spec, glyph);
    // 右对齐：`drawNumber` 的语义是「字段左端 + (width−位数) 个步进」，
    // 所以末位的右沿 = 左端 + width×步进。给定右边界就反算左端。
    const num = (value, right, y, width) => paintNumber(
      this.scene, this.container, this.spec, glyph, value,
      { x: c.x + right - width * adv, y: c.y + y, align: 'right', width }, this.parts);
    // ⭐ **三个数的位置全是从素材像素量出来的**（不是看截图猜的），
    // 见本文件顶部 `CONFIRM_*` 常量的说明。字形用列表那一套
    // （`MEN0028`，各帧齐平）—— 原先用 24px **汉字字库**画阿拉伯数字，
    // 高低不齐又和素材的字号不搭，用户报的「数字歪七扭八、特别丑」就是它。
    num(countOf(this.inventory(), row?.代码), CONFIRM_HAVE_RIGHT, CONFIRM_HAVE_Y, 3);
    num(this.pending, CONFIRM_QTY_RIGHT, CONFIRM_VALUE_Y, 3);
    num((unit ?? 0) * this.pending, CONFIRM_TOTAL_RIGHT, CONFIRM_VALUE_Y, 7);
  }

  // ————————————————————————— 交互 —————————————————————————

  /** 这一侧还能不能往那个方向翻（`dir` −1 上 / 1 下）。箭头跳不跳看它。 */
  canScroll(side, dir) {
    const total = this.rows(side).length;
    const shown = this.visibleRows(side);
    if (total <= shown) return false;
    return dir < 0 ? this.scroll[side] > 0 : this.scroll[side] + shown < total;
  }

  /** 翻一页（点箭头走这条）。 */
  page(side, dir) {
    if (!this.canScroll(side, dir)) return;
    const shown = this.visibleRows(side);
    const total = this.rows(side).length;
    const top = Math.min(Math.max(0, this.scroll[side] + dir * shown),
                         Math.max(0, total - shown));
    this.scroll[side] = top;
    this.side = side;
    // 光标跟着页走，别留在看不见的行上
    this.cursor[side] = Math.min(Math.max(top, this.cursor[side]), top + shown - 1);
    this.render();
  }

  /** 切分类（只影响右边背包）。 */
  setTab(index) {
    const n = Number(index);
    if (!Number.isFinite(n)) return;      // 兜住 undefined/NaN，别把 tab 变成 NaN
    const next = ((n % CATEGORIES.length) + CATEGORIES.length) % CATEGORIES.length;
    if (next === this.tab) return;
    this.tab = next;
    this.cursor[1] = 0;
    this.scroll[1] = 0;
    this.side = 1;
    this.render();
  }

  /**
   * 箭头的跳动 —— 由场景每帧叫一次。
   *
   * ⚠️ **只在有箭头要跳的时候才重画**，否则每 120ms 重建整屏贴图。
   */
  update(time) {
    if (!this.visible || this.pending !== null) return;
    const live = [0, 1].some((side) => this.canScroll(side, -1) || this.canScroll(side, 1));
    if (!live) return;
    // 只在跨过一拍时重画 —— 每帧重建整屏贴图太浪费。
    if (Math.floor(time / ARROW_STEP_MS) === Math.floor(this.clock / ARROW_STEP_MS)) return;
    this.clock = time;
    this.render(true);
  }

  /** 当前这一侧一次最多能成交几件。 */
  maxCount() {
    const row = this.current();
    if (!row || row.拦下) return 0;
    if (this.side === 0) {
      return affordable(this.party()?.金钱 ?? 0, row.数值, row.限购);
    }
    return countOf(this.inventory(), row.代码);
  }

  move(step) {
    // ⭐ **开着确认框时：上下改数量**（↑ 加、↓ 减），左右换选中槽。
    // 用户拍板：「应该上下更改数量，左右移动选中槽」。
    // 此前四个方向都在改数量，「確定購入／取消」形同摆设。
    if (this.pending !== null) { this.stepCount(step > 0 ? -1 : 1); return; }
    const len = this.rows().length;
    if (!len) return;
    const next = Math.min(len - 1, Math.max(0, this.cursor[this.side] + step));
    this.cursor[this.side] = next;
    // 光标出界就滚动
    const top = this.scroll[this.side];
    if (next < top) this.scroll[this.side] = next;
    else if (next >= top + this.visibleRows()) {
      this.scroll[this.side] = next - this.visibleRows() + 1;
    }
    this.render();
  }

  /** 左右：没开确认框时换边（货架↔背包），开着时**换选中槽**。 */
  horizontal(dir) {
    if (this.pending !== null) {
      // 0 = 確定購入／賣出，1 = 取消。只有两个槽，夹住不循环。
      this.confirmFocus = Math.min(1, Math.max(0, this.confirmFocus + dir));
      this.render();
      return;
    }
    const next = this.side + dir;
    if (next < 0 || next > 1) return;
    this.side = next;
    this.render();
  }

  stepCount(dir) {
    const max = this.maxCount();
    if (max <= 0) return;
    this.pending = Math.min(max, Math.max(1, this.pending + dir));
    this.render();
  }

  /**
   * 回车：没开框就开框；开着框就**执行选中的那个槽**。
   *
   * ⚠️ **不再是"回车一律购买"**。用户原话：「按回车确认购买，或者选中
   * 『取消』后按回车取消，这样才对，现在不论什么时候，回车都是购买」。
   * ESC 保留成"直接取消"。
   */
  confirm() {
    // ⚠️ 见 `this.armed`：打开商店那一次按键不算。
    if (!this.armed) return;
    if (this.pending === null) {
      const max = this.maxCount();
      if (max <= 0) return;      // 买不起 / 卖不掉 / 没东西，不开框
      this.pending = 1;
      this.confirmFocus = 0;     // 🅓 默认停在「確定」，素材看不出原作默认
      this.render();
      return;
    }
    if (this.confirmFocus === 1) { this.cancelPending(); return; }
    this.commit();
  }

  /** 撤掉确认框（选「取消」或按 ESC）。 */
  cancelPending() {
    this.pending = null;
    this.confirmFocus = 0;
    this.render();
  }

  commit() {
    const row = this.current();
    const state = this.state();
    if (!row || !state) { this.pending = null; this.render(); return; }
    const out = this.side === 0
      ? buy(state.party, state.inventory, { 代码: row.代码, 售价: row.数值 }, this.pending)
      : sell(state.party, state.inventory, row.代码, row.记录, this.pending);
    if (out.ok) {
      // 正本在 registry 上，改完要写回去，否则菜单与剧情看不见
      this.scene.registry.set('gameState',
                              Object.freeze({ ...state, party: out.party,
                                              inventory: out.inventory }));
      this.scene.statusScreen?.syncState?.(out.party, out.inventory);
    }
    this.pending = null;
    this.confirmFocus = 0;
    // 卖光了光标会越界，夹回去
    const len = this.rows().length;
    this.cursor[this.side] = Math.min(this.cursor[this.side], Math.max(0, len - 1));
    this.render();
  }

  /** ESC：开着确认框就撤销，否则关店。**用户明确要求保留这条**。 */
  escape() {
    if (this.pending !== null) { this.cancelPending(); return; }
    this.close();
  }

  bindInput() {
    const kb = this.scene.input.keyboard;
    // ⚠️ **每个都要 `this.visible &&` 守卫** —— 购物界面与场景漫游共用键盘，
    // 不守卫的话关了店还在吃方向键，人物会跟着走。
    kb.on('keydown-UP', () => this.visible && this.move(-1));
    kb.on('keydown-DOWN', () => this.visible && this.move(1));
    kb.on('keydown-LEFT', () => this.visible && this.horizontal(-1));
    kb.on('keydown-RIGHT', () => this.visible && this.horizontal(1));
    kb.on('keydown-ENTER', () => this.visible && this.confirm());
    kb.on('keydown-SPACE', () => this.visible && this.confirm());
    kb.on('keydown-ESC', () => this.visible && this.escape());
    // ⭐ **分类栏用 Tab 切**（与八页菜单「Tab 切人」同一个键位习惯）。
    // 原作是鼠标点，键盘怎么切没有依据 —— 🅓，见复现度台账。
    kb.on('keydown-TAB', (ev) => {
      if (!this.visible) return;
      ev.preventDefault?.();
      this.setTab(this.tab + 1);
    });
    // 分类栏（MEN9102）本轮只画不接：原作那六格是过滤背包分类用的，
    // 但商店卖的东西不分类，右边背包按分类过滤要不要跟着切，**没有依据**，
    // 先不做，见 docs/状态/复现度台账.md。
  }

  clearHits() {
    this.hits.forEach((z) => z.destroy());
    this.hits = [];
  }

  addZone(x, y, w, h, onClick) {
    const z = this.scene.add.zone(x, y, w, h)
      .setOrigin(0, 0).setScrollFactor(0).setDepth(DEPTH + 1)
      .setInteractive({ useHandCursor: true });
    z.on('pointerdown', (p, x, y, event) => {
      if (!p.leftButtonDown()) return;
      event.stopPropagation();
      onClick(p);
    });
    this.hits.push(z);
    return z;
  }

  /**
   * 分类栏的点击区：六格分类 + 最右那个「退出」图标。
   *
   * ⚠️ **格子的位置从素材反推**：底图 `img0`（378×21）画的就是那一行标签，
   * 而 `img2`~`img7` 是各格的高亮块（宽 52~54、高 32）。高亮块在精灵表里
   * 没有 ox/oy（导出器只认立即数），所以格宽按**六等分标签行**取 ——
   * 378 / 6 = 63，与高亮块 52~54 同量级，用于点击足够。
   * 🅓 这一条是推断，见 `docs/状态/复现度台账.md`。
   *
   * ⚠️ **顺序**：`CATEGORIES` 是 用器/兵刃/护甲/饰物/杂类/暂置，
   * 而画面上从左到右是 暫置/雜類/飾物/護甲/兵刃/用器 —— **反的**，
   * 所以第 i 格对应 `CATEGORIES[5 - i]`。这一点与 `catalog.CATEGORIES`
   * 注释里那句「顺序＝二级菜单的 items 顺序，不是帧号顺序（帧号是反的）」一致。
   */
  tabHits() {
    const t = this.shop.tabs;
    return tabHitAreas(this.spec, t.asset, t.x, t.y, CATEGORIES.length + 1)
      .map(a => ({ ...a, run: () => a.tab === 0 ? this.close() : this.setTab(a.tab - 1) }));
  }

  /**
   * 确认框上的四个可点区域（相对框左上角）。
   *
   * 🅓 **全部从原作截图量的**，exe 只给了 `MEN9206`（加减钮）两处子元素坐标
   * (32,41)/(97,41)，「確定」「取消」两块没有记录。见 `docs/状态/复现度台账.md`。
   */
  confirmHits() {
    const c = this.shop.confirm;
    const [w, h] = this.spec.assets?.[c.asset]?.cell ?? [297, 112];
    return [
      // 数字左右的加减钮。exe 给的就是这两处。
      { x: 26, y: 36, w: 20, h: 28, run: () => this.stepCount(-1) },
      { x: 90, y: 36, w: 20, h: 28, run: () => this.stepCount(1) },
      // 底行：左「確定購入／賣出」，右「取消」。
      // 点下去顺手把选中槽移过去，这样画面上的花括号与实际动作一致。
      { x: 20, y: h - 34, w: 150, h: 30,
        run: () => { this.confirmFocus = 0; this.commit(); } },
      { x: 180, y: h - 34, w: 100, h: 30,
        run: () => { this.confirmFocus = 1; this.cancelPending(); } },
    ].map((z) => ({ ...z, x: c.x + z.x, y: c.y + z.y }));
  }

  /** 鼠标：点行选中，再点一次开确认框；开着框时点框上的按钮。 */
  buildHits() {
    if (this.pending !== null) {
      // ⚠️ 「確定購入」「取消」不是摆设，得真能点 —— 键盘是回车/ESC，
      // 数量的加减键盘用 ←→，鼠标用数字两侧那两个钮。
      this.confirmHits().forEach((z) => this.addZone(z.x, z.y, z.w, z.h, z.run));
      return;
    }
    const s = this.shop;
    // ⭐ **上下箭头可点**（用户：「这两个箭头应该是可以点击的」）。
    // 点击区取素材尺寸 36×24，翻不动时不挂 —— 免得点了没反应还以为坏了。
    [[0, s.shopPanel, s.shopArrows], [1, s.bagPanel, s.bagArrows]]
      .forEach(([side, base, arrows]) => {
        arrows.forEach((a) => {
          const dir = a.role === 'arrow_up' ? -1 : 1;
          if (!this.canScroll(side, dir)) return;
          const [w, h] = this.spec.assets?.[a.asset]?.cell ?? [36, 24];
          this.addZone(base.x + a.x, base.y + a.y, w, h, () => this.page(side, dir));
        });
      });
    // ⭐ **分类栏六格可点** + **最右那个发光图标 = 退出**。
    // 判据：`MEN9102` 的 img2~img7 是六个分类的高亮块（52~54×32）、
    // img8（35×49）是最右图标的高亮 —— 尺寸就是它们各自的点击区。
    // 用户：「点击那个箭头之后，应该跟 ESC 一样退出这个商店购物界面」。
    this.tabHits().forEach((z) => this.addZone(z.x, z.y, z.w, z.h, z.run));
    [[0, s.shopPanel, s.shopRow], [1, s.bagPanel, s.bagRow]].forEach(([side, panel, rowSpec]) => {
      const [w, h] = this.spec.assets?.[rowSpec.asset]?.cell ?? [0, 0];
      if (!w) return;
      const rows = this.rows(side);
      const top = this.scroll[side];
      const shown = this.visibleRows(side);
      for (let i = 0; i < shown && rows[top + i]; i += 1) {
        const index = top + i;
        this.addZone(panel.x + rowSpec.x, panel.y + rowSpec.y + ROW_STEP * i, w, h, () => {
          if (this.side === side && this.cursor[side] === index) { this.confirm(); return; }
          this.side = side;
          this.cursor[side] = index;
          this.render();
        });
      }
    });
  }
}
