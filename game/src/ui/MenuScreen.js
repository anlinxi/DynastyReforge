import { menuFont, menuInk } from './nativeText.js';
/**
 * 原作的八页菜单（状态 / 法宝 / 绝学 / 及身 / 五内 / 阵形 / 天书 / 机舱）。
 *
 * **摆位全部来自 `assets/menus/menus.json`**，那份文件由 `tools/export_menu_ui.py`
 * 从原作 exe 的界面构造代码里提取。这个类只负责「按规格贴图 + 接交互」，
 * 不含任何坐标常量——一旦在这里写死数字，就回到了老路上。
 *
 * 与旧的 `StatusScreen` 的区别：那份只有状态页，坐标靠截图目测/实测，
 * 标签栏甚至是从截图裁下来的整条位图。这份八页齐全、混合模式接上、
 * 标签栏是程序化合成的。
 */
import Phaser from 'phaser';
import { flattenLayers } from './flattenLayers.js';
import { hdScaleOf, noXbr } from '../hd/hdRender.js';
import {
  MENU_SPEC_KEY, battleIndex, isDrawable, layersOf, tabHitAreas, textureKey,
} from './menuSpec.js';
import {
  EQUIP_SLOTS, allocSum, allocWunei, equipTo, memberView, selectStep, selectedMember,
} from '../systems/partyState.js';
import { advanceOf, markerFrame, paintNumber } from './glyphNumber.js';
import { createHold, heldDirection, holdSteps } from './holdScroll.js';
import { arrowFrame, ARROW_STEP_MS } from './listArrows.js';
import { fillFrame } from './fillBar.js';
import { resistFrame, rowY } from './resistBar.js';
import {
  CATEGORIES, createInventory, dispatchHeld, equipCandidates, hasHeld, itemsInCategory,
} from '../systems/inventory.js';
import { createCatalog, displayName } from '../systems/catalog.js';
import { inventoryFromSave } from '../systems/savefile.js';
import { TianshuPage } from './TianshuPage.js';
import { MenuUse } from './MenuUse.js';
import { MenuUseFx } from './MenuUseFx.js';
import { FormationPage } from './FormationPage.js';
import { CabinPage } from './CabinPage.js';
import { SKILL_KINDS, skillsOfKind } from '../systems/skillbook.js';
import { canEquip } from '../systems/equipment.js';
import { ensureArtwork } from '../systems/loader.js';
import { itemLose, itemKey } from '../systems/storyActions.js';
import { itemUnimplemented } from '../systems/itemUse.js';
import { FONT_KEY, FONT_SIZE } from '../config.js';
import DEPTHS from '../systems/depths.js';

/** 面板上的文字是深褐色。字图集是白字，用 tint 上色。 */
const TEXT_TINT = 0x3a2418;
/**
 * 天书条行首最多画几个头像。**exe 里的数**，不是我们掐的。
 *
 * 画头像的循环（簇 19，`0x00425cbb`~`0x00425d14`）是
 * `x = 38; do {…; x += 31} while (x < 193)` —— 38/69/100/131/162，正好五个。
 * 队伍上限本来就是 5（存档的队伍区也是 5 格）。
 *
 * ⚠️ 缺省值只在 `menus.json` 没给 `face.max` 时用。
const FACE_MAX = 5;

/**
 * 机能页（键名「机舱」）当前停在哪条上的高亮，传给 `CabinPage`。
 *
 * ⚠️ **这是我加的，原作没有对应素材。** 那一页只有面板、两条滑条和
 * 「空明流转」三样，`MEN0008` 那个元素在 `menus.json` 里是 `unparsed`、
 * 根本没导出，所以没有「选中框」可用。但键盘操作必须能看出光标在哪条，
 * 只好自己画一个描边。见 `docs/状态/复现度台账.md`。
 *
 * ⚠️ 颜色不能挑浅的：面板底图是米色，第一版用淡黄 `0xffe08a`，
 * **描边确实画出来了、`visible` 也是 true，但肉眼在截图上根本分辨不出**。
 * 取与面板文字同一个深褐墨色，既看得见又不跳脱。
 */
const CABIN_FOCUS_COLOR = TEXT_TINT;

/**
 * 列表条目的两种颜色，从原作及身页截图取的实际墨色。
 *
 * **红＝此刻用不了**（装备不合角色、绝学只能在战斗中用）。判据：那张截图里
 * 「白絹索帶」「琉璃法珠」「紅蓮劫焰」是红的（冰璃的兵刃，夏侯仪装不了），
 * 而「護身匕首」「古銅懷刀」是浅色的。
 */
const ROW_TINT = Object.freeze({ ok: 0xecceaf, blocked: 0xb91f0f });

/** 取 `装备.兵刃` 这种点分路径。 */
const readPath = (obj, path) => path.split('.').reduce((o, k) => o?.[k], obj);

/**
 * 菜单整体的显示层级。
 *
 * ⚠️ **必须高于 FieldScene 的 HUD（2000）。** 菜单的背景是一张不透明的
 * 640×480 全屏图，只要层级够高就自然把 HUD 和底部提示条盖住，不用另外去
 * 隐藏它们。曾经设成 900，结果左上角的坐标 HUD 压在标签栏上，
 * 天书页的「状态」那一格整个被遮掉。
 */
const DEPTH = DEPTHS.MENU;

/**
 * 非焦点层高亮的透明度。
 *
 * ⚠️ **原作没有「选中但非焦点」这个概念** —— 它是鼠标驱动的，鼠标指针本身
 * 就是焦点，所以标签栏 `MEN0003`、绝学分类 `MEN5005` 都只有「选中」一种帧。
 * 键盘导航是我们的增补，得自己造一个表达：**焦点层全亮、其余层压暗**。
 * （法宝分类 `MEN4001` 倒是有「无高亮」帧 6/7，但只此一处，不成体系。）
 */
const DIM_ALPHA = 0.55;

/**
 * 法宝页二级菜单里「暂置」那一项的帧号。
 * ⚠️ 帧号与显示顺序**相反**（高亮块 x 从右往左排），所以最左的「暂置」是帧 5。
 */
const FABAO_TEMP_FRAME = 5;

/** 一对择一显示的素材：键是「另一个」，值是何时显示本素材。 */
const EXCLUSIVE = Object.freeze({
  // 阵形页格子上的选中框：蓝=悬停、紫=已点中，同坐标同 16 帧，只能显示一个。
  // 两个都画会因为都走加亮而叠成白色。
  //
  // ⚠️ **两个都不按 `menus.json` 的坐标画。** 那两条元素写的是 (197,48)，
  // 而 16 帧**全挂在同一个层坐标 (279,240)** —— 位置由 exe 代码算，
  // 拿不到。照着画会在格盘右上角多出一个对不上任何格子的框。
  // 选中框改由 `FormationPage.drawCellCursor` 按量出来的格心画，见 `systems/formation.js`。
  MEN7002: () => false,
  MEN7004: () => false,
});

export default class MenuScreen {
  /**
   * @param {Phaser.Scene} scene
   * @param {object} party 队伍状态，见 systems/partyState.js
   * @param {object} gamedata assets/data/gamedata.json —— 数值的唯一来源
   * @param {object[]} equipment assets/data/equipment.json
   * @param {object[]} items assets/data/items.json
   * @param {object[]} skills assets/data/skills.json —— 绝学页按类型过滤、画消耗
   */
  constructor(scene, party, gamedata = null, equipment = [], items = [], skills = [],
              save = null) {
    this.scene = scene;
    this.party = party;
    this.gamedata = gamedata;
    this.equipment = equipment;
    this.items = items;
    this.skills = skills;
    /** **全局唯一的「代码 ↔ 名称」映射**。列表、判红、详情一律经它查，见 catalog.js。 */
    this.catalog = createCatalog({ equipment, items, skills });
    // **有存档就用存档的背包**，没有才用占位的 `START_PACK`。
    // 要调背包内容，改 `assets/data/saves/test.json`，别改 `inventory.js` 的常量。
    // ⚠️ **背包的正本在 registry 上**（`systems/gameState.js`），不在这里。
    // 挂在菜单上的话，剧情 `item_gain` 加的东西菜单看不见，
    // 而菜单里换的装备场景也看不见 —— 两份引用各改各的。
    const shared = scene.registry?.get?.('gameState');
    this.inventory = shared?.inventory
      ?? (save ? inventoryFromSave(save, this.catalog) : createInventory(this.catalog));
    this.visible = false;
    this.tab = 0;
    /** 焦点层级：0=标签栏，1=二级菜单/装备槽，2=列表。见 stepFocus 上方的说明。 */
    this.focus = 0;
    /** 每页各自的列表光标与滚动位置，按页 key 存。 */
    this.cursor = {};
    this.scroll = {};
    /** 及身页当前选中的装备槽下标（0兵刃 1护甲 2饰物）。 */
    this.slot = 0;
    /**
     * 五内页：当前停在第几块牌（下标同 `interactions.wunei.attrs`），
     * 以及**尚未确认**的加点暂存 `{迅:1, 烈:2, …}`。
     *
     * ⚠️ 暂存不写角色 —— 只有 `MEN6004`（回车）才写。换页、换人、关菜单
     * 一律作废，见 `clearAlloc()`。
     */
    this.attr = 0;
    this.alloc = {};
    /**
     * 各页二级菜单当前选中项的帧号，按素材名存。
     *
     * 之所以按**素材名**而不是页名：一个二级菜单就是一个素材（法宝 `MEN4001`
     * 六项、绝学 `MEN5005` 两项），帧号就是选中项，这样加新页不用改代码。
     * 法宝的初值 5 = 「暂置」，因为底下那个按钮的显示条件依赖它（见 showsActionButton）。
     */
    this.submenuFrame = { MEN4001: 5, MEN5005: 0 };
    /** 机能页（音乐/音效滑条、空明流转），见 `ui/CabinPage.js`。 */
    this.cabin = new CabinPage(this, CABIN_FOCUS_COLOR);
    /** 正在进行的一次「使用」（确认框/选人/结算），见 `ui/MenuUse.js`；`menu.use` 读它的状态。 */
    this.useFlow = new MenuUse(this);
    /**
     * **「拿一件道具放上去」的挑件模式**（`{codes:Set, onPick}`），见 `openItemPicker`。
     *
     * 剧情走到 `test_item_used` 时由 `FieldScene` 打开。开着的时候法宝页
     * 只列候选、回车＝挑中、ESC＝不放，**回调一定要兑现**（见 `toggle`）——
     * 不兑现剧情就永远停在那一条，人动不了、菜单也开不了，还不报错。
     */
    this.picker = null;
    /** 天书（存读档）页：状态、画面、热区、按键都在 `ui/TianshuPage.js`。 */
    this.tianshuPage = new TianshuPage(this);
    /** 画箭头用的时钟（毫秒）。跨一拍才重画，见 `update`。 */
    this.clock = 0;
    /**
     * 存/读要靠场景去做（切图、重建队伍），所以由外面挂两个回调进来。
     * 没挂的话天书页只能看不能用 —— 那也不该崩，见 `TianshuPage.confirm()`。
     */
    this.onSave = null;
    this.onLoad = null;
    this.onExport = null;
    this.onImport = null;
    /** 剧情存档点开的菜单，关掉时回调一次让脚本继续。 */
    this.onTianshuClose = null;
    /** 正在播的使用特效：，播完自己销毁。 */
    /** 用物品/放绝学时头顶的金光，见 `ui/MenuUseFx.js`。 */
    this.useFx = new MenuUseFx(this);
    /** 阵形页（格盘、光标格、先选人再交换），见 `ui/FormationPage.js`。 */
    this.formation = new FormationPage(this);

    this.spec = scene.cache.json.get(MENU_SPEC_KEY);
    this.container = scene.add.container(0, 0)
      .setScrollFactor(0).setDepth(DEPTH).setVisible(false);
    /** 每次换页全部重建的贴图。菜单不是每帧刷新的东西，重建比增量维护省心。 */
    this.parts = [];

    if (!this.spec) {
      console.warn('menus.json 未加载，菜单不可用');
      return;
    }
    this.bindInput();
    this.render();
  }

  /** 当前页的规格。 */
  get page() {
    return this.spec.pages?.[this.tab];
  }

  get tabCount() {
    return this.spec.interactions?.tabs?.order?.length ?? 8;
  }

  // ————————————————————————— 贴图 —————————————————————————

  /**
   * 贴一个元素的全部图层。
   * @param {string} asset 素材名（不带 .SF2）
   * @param {number} frame 帧号
   */
  drawElement(asset, frame, x, y, alphaScale = 1) {
    const layers = layersOf(this.spec, asset, frame, x, y);
    // 多层整屏图（如 MEN0001 旋涡拖影 7 层）预合成一张再画，见 flattenLayers；淡入淡出时照旧逐层
    const flat = alphaScale === 1
      ? flattenLayers(this.scene, textureKey(asset), `${textureKey(asset)}-f${frame}`,
        layers.map((l) => ({ ...l, x: l.x - x, y: l.y - y })))
      : null;
    if (flat) {
      const img = this.scene.add.image(x + flat.x, y + flat.y, flat.key).setOrigin(0, 0).setScrollFactor(0);
      this.container.add(img);
      this.parts.push(img);
      return;
    }
    layers.forEach((l) => {
      const img = this.scene.add.image(l.x, l.y, textureKey(asset), l.img)
        .setOrigin(0, 0)
        .setScrollFactor(0)
        .setBlendMode(l.blend)
        .setAlpha(l.alpha * alphaScale);
      this.container.add(img);
      this.parts.push(img);
    });
  }

  /**
   * 菜单是否被不透明整屏底图（`MEN0001` 第 0 帧，640×480、全不透明）盖满。
   * 盖满时底下的地图与人物看不见，FieldScene 跳过不画（高清大画布上省掉整张地图与上百个人物）。
   */
  coversScreen() {
    if (!this.visible || !this.container.visible || this.container.alpha < 1) return false;
    return this.parts.some((p) => p.visible && p.alpha === 1 && p.texture?.key === textureKey('MEN0001')
      && p.frame?.name === 0 && p.x <= 0 && p.y <= 0 && p.displayWidth >= 640 && p.displayHeight >= 480);
  }

  /** 换页/换人之后整页重画。 */
  render(keepHits = false) {
    this.parts.forEach((p) => p.destroy());
    this.parts = [];
    if (!this.spec) return;

    if (this.page?.standalone === 'tianshu') this.tianshuPage.draw();
    else this.drawPage();

    this.drawPartyBar();
    this.drawTexts();
    this.useFlow.draw();
    if (!keepHits) this.buildTabHits();
  }

  // ————————————————————— 使用物品 / 放绝学 —————————————————————

  /** 当前列表停着的那一行。没有就 null。 */
  currentRow() {
    const rows = this.listRows(selectedMember(this.party));
    return rows[this.cursor[this.page?.key] ?? 0] ?? null;
  }

  /** 用掉最后一个之后列表短了一行，光标夹回范围。 */
  clampCursor() {
    const key = this.page?.key;
    const len = this.listLength();
    this.cursor[key] = Math.min(this.cursor[key] ?? 0, Math.max(0, len - 1));
    if ((this.scroll[key] ?? 0) > this.cursor[key]) this.scroll[key] = this.cursor[key];
  }

  /**
   * 每帧推一下箭头、按住滚动与使用特效。**由场景的 update 调**。
   * 特效节拍的说明见 `MenuUseFx.tick`。
   */
  update(time, delta) {
    this.tickArrows(time);
    this.tickHold(time);
    this.useFx.tick(delta);
  }

  /**
   * 当前页的列表还能不能往那个方向翻（`dir` −1 上 / 1 下）。
   * 箭头跳不跳、点不点得动都看它。列表页之外一律返回 false。
   */
  canPage(dir) {
    if (this.isTianshu()) return this.tianshuPage.canPage(dir);
    const page = this.spec.interactions?.listRows?.pages?.[this.page?.key];
    if (!page) return false;
    const total = this.listRows(selectedMember(this.party)).length;
    if (total <= page.rows) return false;
    const top = this.scroll[this.page.key] ?? 0;
    return dir < 0 ? top > 0 : top + page.rows < total;
  }

  /** 列表页翻一屏（点箭头走这条）。 */
  pageList(dir) {
    const page = this.spec.interactions?.listRows?.pages?.[this.page?.key];
    if (!page || !this.canPage(dir)) return;
    const key = this.page.key;
    const total = this.listRows(selectedMember(this.party)).length;
    const top = Math.min(Math.max(0, (this.scroll[key] ?? 0) + dir * page.rows),
                         Math.max(0, total - page.rows));
    this.scroll[key] = top;
    // 光标跟着页走，别留在看不见的行上；焦点也落到列表上。
    this.cursor[key] = Math.min(Math.max(top, this.cursor[key] ?? 0), top + page.rows - 1);
    this.focus = Math.min(this.maxFocus(), 2);
    this.queueRender();
  }

  /**
   * 箭头跳动：跨过一拍才重画整屏。
   *
   * ⚠️ **没有可跳的箭头时一次也不重画** —— 否则每 120ms 重建全屏贴图。
   */
  tickArrows(time) {
    if (!this.visible) return;
    if (!this.canPage(-1) && !this.canPage(1) && this.focus !== 2
        && this.page?.key !== '阵形' && !(this.page?.key === '五内' && allocSum(this.alloc))) return;
    if (Math.floor(time / ARROW_STEP_MS) === Math.floor(this.clock / ARROW_STEP_MS)) return;
    this.clock = time;
    this.render(true);
  }

  drawPage() {
    const member = selectedMember(this.party);
    const values = this.gamedata
      ? memberView(this.party, this.gamedata, this.catalog, this.pendingSwap(), this.alloc)
      : null;
    for (const e of this.page?.elements ?? []) {
      if (e.role === 'glyphs') { this.drawStatValue(e, values); continue; }
      if (e.role === 'fill' && this.fillFrameFor(e, values) !== null) {
        this.drawElement(e.asset, this.fillFrameFor(e, values), e.x, e.y);
        continue;
      }
      // ⭐ **上下翻页箭头：能翻就跳动，不能就定格。**
      // 判据在素材里（八套箭头全是 6 帧、逐帧上下偏移），见 `ui/listArrows.js`。
      // 此前一律画帧 0，所以箭头是死的，玩家看不出还有没有下一页。
      if (e.role === 'arrow_up' || e.role === 'arrow_down') {
        const dir = e.role === 'arrow_up' ? -1 : 1;
        this.drawElement(e.asset, arrowFrame(this.spec, e.asset,
                                             this.canPage(dir), this.clock), e.x, e.y);
        continue;
      }
      if (!isDrawable(e.role)) continue;
      if (EXCLUSIVE[e.asset] && !EXCLUSIVE[e.asset]()) continue;
      if (!this.showsActionButton(e)) continue;
      if (this.spec.interactions?.equipSlots?.assets?.includes(e.asset)
          && this.page?.key === '及身') continue;   // 交给 drawEquipSlots
      this.drawElement(e.asset, this.frameFor(e, member), e.x, e.y,
                       this.elementAlpha(e));
    }
    this.drawEquipSlots();
    this.formation.draw();
    this.cabin.drawFocus();
    this.drawWuneiValues(values);
    this.drawResistRows(values);
    this.drawZhunengRows(values);
    this.drawList(member);
    this.drawDetail(member);
  }

  /**
   * 详情面板：光标停着那一项的说明文字。
   *
   * 只有法宝页与绝学页有（及身页左侧是抗性与诸能）。文字取自
   * `items.详述` / `skills.绝学说明`，坐标在 `interactions.detail`。
   *
   * ⚠️ **插图没画** —— 336 张插图与物品编号的映射还没建，且已知不是严格顺序
   * 对应。硬套会给一部分物品配错图，留空更诚实。见 `docs/物品插图与简繁.md`。
   */
  drawDetail(member) {
    const cfg = this.spec.interactions?.detail;
    const panel = cfg?.pages?.[this.page?.key];
    if (!panel) return;
    const rows = this.listRows(member);
    const row = rows[this.cursor[this.page.key] ?? 0];
    if (panel.art) this.drawArtwork(row?.代码, panel.art);
    const text = this.detailText(row, panel.field);
    if (!text) return;
    // ⚠️ **不能用 `setMaxWidth`** —— Phaser 的位图文字按**空格**断词，
    // 中文没有空格，整段会挤成一行冲出面板。按每行容得下的字数硬断。
    const pad = panel.pad ?? cfg.pad;      // 每页可覆盖，见 interactions.detail
    const perLine = Math.max(1, Math.floor((panel.w - pad.x * 2) / FONT_SIZE));
    const wrapped = text.match(new RegExp(`.{1,${perLine}}`, 'g'))?.join('\n') ?? text;
    const label = this.scene.add
      .bitmapText(panel.x + pad.x, panel.y + pad.y, menuFont(), wrapped, FONT_SIZE)
      .setScrollFactor(0);
    noXbr(label);
    this.container.add(label);
    this.parts.push(label);
  }

  /**
   * 物品插图（`MEN4010`~`MEN4014`，336 张）。
   *
   * **映射是确定性的**：`表 = tables[编号 ÷ 100]`、`帧 = 编号 mod 100`，编号按
   * 十进制。判据见 `tools/render_pages.PAGE_ARTWORK` —— `MEN4012` 帧 51~55
   * 渲染出来正是金創藥/大補丸/九花玉露/十聖金丹/百草沁香（图里印着名字）。
   *
   * ⚠️ 编号 > 460 的没有插图，那 139 件全是**敌人装备栏**的数据
   * （名字叫「沙漠盜賊」「西夏兵」），玩家看不到。这里静默留空。
   */
  drawArtwork(code, at) {
    const spec = this.artworkFrame(code);
    if (!spec) return;
    // **L2：插图 4.5 MB，第一次要画时才拉**（见 loader.ensureArtwork）。
    // 拉完回调里重画一次 —— 此刻这一帧已经画完了，插图那块还是空的。
    if (ensureArtwork(this.scene, () => this.queueRender())) return;
    this.drawElement(spec.asset, spec.frame, at.x, at.y);
  }

  /** 物品编码 → `{asset, frame}`。查不到返回 null。 */
  artworkFrame(code) {
    const cfg = this.spec.artwork;
    if (!cfg || code === undefined || code === null) return null;
    const n = parseInt(String(code), 16);
    if (!Number.isFinite(n) || n < 0) return null;
    const table = Math.floor(n / cfg.perTable);
    if (table >= cfg.tables.length) return null;
    const asset = cfg.tables[table];
    const frame = n % cfg.perTable;
    // 空帧（那个编号没有插图）画出来是空的，不必特判 —— `layersOf` 会返回 []。
    return this.spec.assets?.[asset] ? { asset, frame } : null;
  }

  /**
   * 取某一行的说明文字。
   *
   * ⚠️ **优先用 `说明繁`**（`Ail2.ENC` 记录 +392 的 Big5 原文）—— 字库按 Big5
   * 码位索引，配套 txt 里那份简体「详述」画出来会缺字。
   * 绝学目前只有简体说明（`Magiccon.enc` 一条 64 B 放不下），会缺字，
   * 见 `docs/专题/简繁体.md`。
   */
  detailText(row, field) {
    if (!row) return null;
    const rec = row.记录 ?? this.catalog.物品(row.代码);
    const raw = rec?.说明繁 || rec?.[field];
    return raw ? String(raw) : null;
  }

  /**
   * 三页的列表（法宝 / 绝学 / 及身）。
   *
   * **行距 25、文字比条低 5px 都是实测的**，配置在 `interactions.listRows`。
   * exe 给的 `select_bar` 起点正好是第 0 行那根条的 y，所以起点不用另外量。
   *
   * ⚠️ 名称用**字库汉字**画（24px），不是 MEN 字形素材；字库是繁体，
   * 所以要走 `traditional()` 换成繁体名，否则「护」这种字缺字。
   */
  drawList(member) {
    const cfg = this.spec.interactions?.listRows;
    const page = cfg?.pages?.[this.page?.key];
    if (!page) return;
    const rows = this.listRows(member);
    const cursor = this.cursor[this.page.key] ?? 0;
    const top = this.scroll[this.page.key] ?? 0;

    for (let i = 0; i < page.rows; i += 1) {
      const row = rows[top + i];
      if (!row) break;
      const y = page.y0 + cfg.pitch * i;
      const selected = top + i === cursor;
      if (selected) {
        // 选中条那 6 帧是**宽度呼吸动画**（200/200/198/196/196/198）。
        // 焦点在列表时播放完整呼吸帧；离开列表才定格压暗。
        const focused = this.focus === 2;
        this.drawElement(page.bar, focused ? Math.floor(this.clock / ARROW_STEP_MS) % this.spec.assets[page.bar].frames.length : 3, page.x, y,
                         focused ? 1 : DIM_ALPHA);
      }
      // 一律用**这一行的记录**上的繁体名（字库是 Big5 繁体）。
      // 行里带的是代码不是名称，所以查不到记录就画不出名字 —— 那是数据问题，
      // 不该在这里用名字去兜底（名字重名，兜出来的可能是别的东西）。
      const name = displayName(row.记录 ?? this.catalog.物品(row.代码));
      const tint = this.rowBlocked(row, member) ? ROW_TINT.blocked : TEXT_TINT;
      const label = this.scene.add
        .bitmapText(page.x + page.nameDx, y + cfg.textDy, menuFont(), name, FONT_SIZE)
        .setScrollFactor(0);
      noXbr(label);
      menuInk(label, tint);
      this.container.add(label);
      this.parts.push(label);

      const qtyGlyphs = this.spec.interactions?.resistRows?.value?.asset;
      const numY = y + (cfg.qtyDy ?? cfg.textDy);
      if (page.qtyDx && qtyGlyphs && Number.isFinite(row.数量)) {
        paintNumber(this.scene, this.container, this.spec, qtyGlyphs, row.数量,
                    { x: page.x + page.qtyDx, y: numY, align: 'left' }, this.parts);
      }
      if (page.costDx && row.记录) {
        this.drawSkillCost(page, row.记录, y, numY, qtyGlyphs, member);
      }
    }
  }

  /**
   * 绝学列表右侧的消耗：一个图标 + 一个数字。
   *
   * **图标颜色就是消耗什么**：蓝(`MEN0025`)＝元气（气条），红(`MEN0026`)＝体力
   * （命条）。原作里两者只会有一个不为 0。
   */
  drawSkillCost(page, skill, y, numY, glyphs, member) {
    // ⚠️ **用 `消耗元气值`/`消耗体力值`（来自 Firttech.enc 的纯数字）**，
    // 不要用配套 txt 的「消耗元气」——那一列可能是**文字**，例如释剑之契写的是
    // 「自身气极×100%」，`Number()` 得 NaN，消耗整个不显示。
    let qi = Number(skill.消耗元气值 ?? skill.消耗元气) || 0;
    // ⚠️ **有的绝学消耗的是气极的百分比，不是固定点数**（`元气消耗按百分比`，
    // 来自 Firttech.enc +485）。释剑之契是「气极×100%」—— 该显示的是这个角色
    // 此刻的气极，不是数字 100。
    if (skill.元气消耗按百分比 && member) {
      qi = Math.floor((member.气极 ?? 0) * qi / 100);
    }
    const hp = Number(skill.消耗体力值 ?? skill.消耗体力) || 0;
    const cost = qi || hp;
    if (!cost) return;
    // ⚠️ **图标是 `MEN5006`（2 帧：0 红勾玉＝耗体力、1 蓝圆＝耗元气）。**
    // 原先写的是 `MEN0025`/`MEN0026` 的**帧 0** —— 那两张其实是**阿拉伯数字
    // 字形表**（0~9 各一帧，图标在末尾的帧 10/11），所以画出来是个蓝色的「0」字。
    const icon = this.spec.useFx?.costIcon;
    if (icon) {
      this.drawElement(icon.asset, qi ? icon.frames.qi : icon.frames.hp,
                       page.x + page.costDx, y + 4);
    }
    if (glyphs) {
      paintNumber(this.scene, this.container, this.spec, glyphs, cost,
                  { x: page.x + page.costValueDx, y: numY, align: 'left' }, this.parts);
    }
  }

  /**
   * 「假设换装」：光标停着的那一件，换进当前选中的装备槽。
   *
   * **这就是预览列的输入。** 只有及身页、且焦点已经进到列表时才有 ——
   * 光标还没落到任何一行时预览等于当前，两列相同，这是正确的「无变化」。
   *
   * ⚠️ 曾经把它写死成「卸下兵刃」（`variant: "无兵刃"`），那是把原作截图里
   * **某一次定格**当成了规则 —— 那张截图之所以像卸装备，只是因为光标停在空行。
   */
  pendingSwap() {
    if (this.page?.key !== '及身' || this.focus !== 2) return null;
    const rows = this.listRows(selectedMember(this.party));
    const row = rows[this.cursor['及身'] ?? 0];
    return { 槽: EQUIP_SLOTS[this.slot], 代码: row?.代码 ?? null };
  }

  /** 及身页三个装备槽的选中态。选中用帧 0，未选中用帧 3 并压暗。 */
  drawEquipSlots() {
    const cfg = this.spec.interactions?.equipSlots;
    if (!cfg || this.page?.key !== '及身') return;
    cfg.assets.forEach((asset, i) => {
      const el = this.page.elements.find((e) => e.asset === asset);
      if (!el) return;
      const on = this.focus >= 1 && i === this.slot;
      this.drawElement(asset, on ? 0 : 3, el.x, el.y, on ? 1 : DIM_ALPHA);
    });
  }

  /**
   * 这一行此刻能不能用 —— 能用画常色，不能用画红色。
   *
   * 绝学看 `作用场合`（`Firttech.enc` +28，值 0仅平时 / 1仅战斗时 / 2无限制）：
   * **菜单是非战斗状态**，所以「仅战斗时」的绝学在这里点不动，原作把它画成红的。
   * 判据：你给的截图里雷引之术（仅战斗时）是红的、气愈之术（无限制）是正常色。
   *
   * 装备看 `可装备者`（`Ail2.ENC` 的兵刃类型限制，如「夏霍」= 夏侯仪、霍雍）：
   * **当前选中的角色**拿不动这件兵刃时画成红的。判据是原作的兵器分段本身 ——
   * 夏侯仪的剑与武英仲的枪在数据里就是两段不同的「可装备者」。
   *
   * ⚠️ **`可装备级别` 故意不判**，一律视为可用。300 块补丁才加的等级门槛，
   * 是否影响显示色未经截图印证，先不猜（见 `菜单交互与数值联动.md` §8）。
   */
  rowBlocked(row, member) {
    // ⚠️ **`row.记录` 只有绝学页的行才有**（`skillsOfKind` 带着它）。
    // 法宝页与及身页的行是 `{代码, 数量}`，属性一律回目录查 ——
    // 原先只写 `row.记录?.能否平时使用`，于是法宝页的「仅战斗时」判红
    // **从来没生效过**（暂置格里的冰蟾砂一直是黑的，原作是红的）。
    const rec = row.记录 ?? this.catalog.物品(row.代码);
    if (!rec) return false;
    if (rec.能否平时使用 === '仅战斗时' || rec.作用场合 === '仅战斗时') return true;
    // 装备：当前这个人拿不动就是红的。
    if (rec.槽位) return Boolean(member?.name && !canEquip(rec, member.name));
    // 物品「作用场合 = 不可用」（炼化材料那一批）也是红的。
    // 判据是原作截图：暂置格里「朱蕊晶花」是红的，而它正是这一类。
    if (rec.作用场合 === '不可用') return true;
    // 机制还没做的地返遁符。⚠️ **与原作不符** ——
    // 原作里它们是白色可用。判红是为了不出现「点了没反应」，见 itemUse.js。
    return itemUnimplemented(rec);
  }

  /**
   * 当前页列表里该显示什么。
   *
   * * 及身 —— 背包里**当前槽**的装备。⚠️ 槽位选中还没做，暂时固定兵刃。
   * * 法宝 —— 背包里当前分类的东西。
   * * 绝学 —— 角色已学会的绝学（`{名称}`，没有数量）。
   */
  listRows(member) {
    const key = this.page?.key;
    if (key === '绝学') {
      // ⚠️ 二级菜单帧号 0=絕技 / 1=咒法，对应数据里的「绝技」「咒术」。
      // 不过滤的话两类绝学会在两个分类下都出现。
      const kind = SKILL_KINDS[this.submenuFrame.MEN5005 ?? 0];
      return skillsOfKind(this.catalog, member?.绝学, kind);
    }
    if (key === '及身') {
      return equipCandidates(this.inventory, EQUIP_SLOTS[this.slot], this.catalog);
    }
    if (key === '法宝') {
      // ⭐ **「拿一件放上去」模式**：只列这一处认的那几件，且**只列身上真有的**。
      // 列全部候选会泄题（三个黑石球哪个放哪根柱子正是谜题本身），
      // 见 `openItemPicker`。
      if (this.picker) {
        return this.inventory.filter((row) => this.picker.codes.has(itemKey(row.代码)));
      }
      // ⚠️ **帧号就是分类下标，不要再反转。** `reversed` 只用于**方向键移动**
      // （帧号与屏幕上的左右相反），查表时反转会把分类整体错位 ——
      // 曾经因此把布袍显示在「饰物」格里。`CATEGORIES` 的顺序就是帧号顺序。
      const frame = this.submenuFrame[this.currentSubmenu()] ?? 0;
      return itemsInCategory(this.inventory, CATEGORIES[frame], this.catalog);
    }
    return [];
  }

  /**
   * 五内页 / 及身页的八行抗性：一根计量管 + 预览与当前两列数字。
   *
   * **这八行 exe 里没有坐标**（循环画的），坐标由 `tools/measure_slots.py`
   * 在原作截图上模板匹配得到，落在 `interactions.resistRows`。
   *
   * ⚠️ **左列是预览、右列是当前**，与本页「诸能」那块**相反**。
   * ⚠️ 预览目前恒等于当前 —— 预览的真正输入是「列表里光标停着的那一项」，
   *    而列表和光标还没做（见 `docs/专题/菜单.md` §3.3 B）。
   *    **这是占位，不是规则。**
   */
  drawResistRows(values) {
    const rows = this.spec.interactions?.resistRows;
    const page = rows?.pages?.[this.page?.key];
    const set = values?.抗性?.[page?.source];
    if (!page || !set) return;
    // **左列一律是预览、右列是当前**：及身页的预览＝换上光标那件之后的及身抗性，
    // 五内页的预览＝按「存量 + 暂存加点」现算的内禀抗性。
    // 没有暂存/没选装备时预览等于当前，两列相同 —— 那是正确的「无变化」。
    const PREVIEW_OF = { 及身: '及身预览', 内禀: '内禀预览' };
    const prev = values?.抗性?.[PREVIEW_OF[page.source] ?? page.source] ?? set;
    const { asset, negative, dyFromBar, align, preview, current } = rows.value;
    rows.names.forEach((name, i) => {
      const value = set[name];
      if (!Number.isFinite(value)) return;
      const y = rowY(rows, i);
      const frame = resistFrame(rows, value);
      if (frame !== null) this.drawElement(rows.bar.asset, frame, page.x, y);
      // ⚠️ **负数不画负号，改用蓝色字形**（`MEN0029`，与 `MEN0028` 逐帧同构），
      // 画的是绝对值，正负体现在用哪套字上。
      // ⚠️ **左＝预览、右＝当前**，与本页「诸能」那块相反，不是笔误。
      for (const [col, v] of [[preview, prev[name] ?? value], [current, value]]) {
        if (!Number.isFinite(v)) continue;
        paintNumber(this.scene, this.container, this.spec, v < 0 ? negative : asset,
                    Math.abs(v), { x: page.x + col.dx, y: y + dyFromBar, align },
                    this.parts);
      }
    });
  }

  /**
   * **阵形页「諸能」四行**：攻击 / 护禦 / 命中 / 闪避。
   *
   * ⚠️ 这四个数原先根本没画 —— 那一页的 `MEN1017` 元素在 `statSlots` 里没有绑定，
   * 而 `statSlots` 一个坑只能对一个字段，四行是循环画的，套不进去。
   * 用户对着原作截图指出来：原作那四行印着 `攻擊一七五〇 / 護禦一四〇〇 /
   * 命中一六〇 / 閃避九〇`，我们这边是空的。
   *
   * 坐标来自 `menus.json` 的 `interactions.zhunengRows`，**量自素材本身**
   * （标签烤在 `MEN7001` 图 1 里）。面板原点从本页元素表里找 `MEN7001` 帧 0 那条，
   * 不写死 —— 面板位置本来就是 exe 给的。
   */
  drawZhunengRows(values) {
    const rows = this.spec.interactions?.zhunengRows;
    if (!rows || this.page?.key !== '阵形' || !values) return;
    const panel = (this.page.elements ?? []).find(
      (e) => e.asset === rows.panel.asset && e.frame === rows.panel.frame,
    );
    if (!panel) { console.warn('阵形页找不到諸能框，四行数值没画'); return; }
    const { asset, dx, dy, align } = rows.value;
    for (const row of rows.rows) {
      const value = values[row.field];
      if (!Number.isFinite(value)) continue;
      paintNumber(this.scene, this.container, this.spec, asset, value,
                  { x: panel.x + dx, y: panel.y + row.y + dy, align }, this.parts);
    }
  }

  /**
   * 填充条 / 柱子的档位。**帧号就是档位**，帧 0 是空的。
   *
   * 绑定在 `menus.json` 的 `fillSlots` 里（按 exe 调用点索引）：
   * `max` 是数字就直接当分母（五外柱），是字符串就再去 values 里取（命极/气极）。
   * 没绑定的返回 null，交回给通用路径按导出的默认帧画。
   */
  fillFrameFor(element, values) {
    const slot = this.spec.fillSlots?.[element.site];
    if (!slot || !values) return null;
    const value = values[slot.field];
    const max = typeof slot.max === 'number' ? slot.max : values[slot.max];
    if (!Number.isFinite(value) || !Number.isFinite(max) || max <= 0) return null;
    return fillFrame(this.spec, element.asset, value / max);
  }

  /**
   * 画一个运行时数值。
   *
   * 「哪个坑填哪个字段」在 `menus.json` 的 `statSlots` 里（按 exe 调用点索引），
   * 值由 `memberView()` 现算 —— 两边**靠字段名对齐**，加坑不用改这里。
   * 没有绑定或算不出值的坑就跳过（其余七页的坑目前都还没绑）。
   */
  drawStatValue(element, values) {
    const slot = this.spec.statSlots?.[element.site];
    if (!slot || !values) return;
    const value = values[slot.variant ? `${slot.field}@${slot.variant}` : slot.field];
    if (!Number.isFinite(value)) return;
    // ⚠️ **预览列的第一格是留给 ▲▼ 标记的，数字从第二格开始。**
    // 实测原作及身页：预览列的数字不论几位都从 x=329 起，而标记在 315，
    // 而 exe 给这个元素的坐标是 314 —— 正好是标记那一格。差 15 就是一个步进。
    const advance = advanceOf(this.spec, element.asset);
    const lead = slot.variant ? advance : 0;
    paintNumber(this.scene, this.container, this.spec, element.asset, value,
                { ...slot, x: element.x + lead, y: element.y }, this.parts);

    if (!slot.variant) return;
    const frame = markerFrame(this.spec, element.asset, value - values[slot.field]);
    if (frame === null) return;
    const mark = this.scene.add
      .image(element.x, element.y, textureKey(element.asset), frame)
      .setOrigin(0, 0).setScrollFactor(0);
    this.container.add(mark);
    this.parts.push(mark);
  }

  /**
   * 元素的实际帧号。`dynamicFrame` 的那些在 exe 里帧号来自寄存器，
   * 导出时填的是默认值，这里按当前状态改写。
   */
  frameFor(element, member) {
    switch (element.role) {
      case 'alloc_confirm':
        return allocSum(this.alloc) ? Math.floor(this.clock / ARROW_STEP_MS) % this.spec.assets[element.asset].frames.length : 0;
      case 'tabbar':
        return this.tab;
      // 立绘与姓名**是同一套编号**（anim 帧序 + 1 = 战斗角色代码），见 menuSpec.BATTLE_ORDER。
      // 两条都走 battleIndex，`member.code - 1` 与它等值，但按名字取更不容易搞错。
      case 'portrait':
      case 'name':
        return battleIndex(member?.name);
      case 'submenu':
        return this.submenuFrame[element.asset] ?? element.frame;
      default:
        return this.cabin.frameFor(element) ?? element.frame;
    }
  }

  /**
   * 法宝页底下那个按钮：**选中「暂置」时是分发，其余分类时是弃置**，二者择一。
   * 原作逻辑：捡到的东西先进暂置，得点分发才会归到用器/兵刃/护甲/饰物/杂类里。
   */
  showsActionButton(element) {
    if (element.role !== 'action') return true;
    const inTemp = this.submenuFrame.MEN4001 === FABAO_TEMP_FRAME;
    return element.asset === 'MEN4006' ? inTemp : !inTemp;
  }

  /** 法宝页当前是不是停在「暂置」那一格。 */
  inTempCategory() {
    return this.page?.key === '法宝' && this.submenuFrame.MEN4001 === FABAO_TEMP_FRAME;
  }

  /**
   * 分发（`MEN4006`）：把暂置里的东西归入各自分类。
   *
   * 分完光标要夹回范围 —— 暂置格此刻空了，光标还停在原来那一行的话，
   * 详情区会去读一个不存在的条目。
   */
  dispatch() {
    if (!hasHeld(this.inventory)) return;
    this.inventory = dispatchHeld(this.inventory);
    this.pushState();
    this.cursor['法宝'] = 0;
    this.scroll['法宝'] = 0;
    this.queueRender();
  }

  /** 用户2026-09-20选择：每次弃置当前条目一件，不新增数量框。 */
  discardOne() {
    if (!this.visible || this.page?.key !== '法宝' || this.inTempCategory() || this.use || this.picker) return;
    const row = this.currentRow();
    if (!row) return;
    // 只扣本分类选中的条目；同代码的暂置物品不受影响。
    const lost = itemLose([row], row.代码, 1);
    if (!lost.ok) return;
    this.inventory = Object.freeze(this.inventory.flatMap(r => r === row ? lost.inventory : [r]));
    this.pushState();
    this.clampCursor();
    this.render();
  }

  /** 当前页的二级菜单素材名，没有就返回 null。 */
  currentSubmenu() {
    return this.page?.elements?.find((e) => e.role === 'submenu')?.asset ?? null;
  }

  /** 二级菜单的项数与帧号方向。从 `interactions` 里那张表读，不写死。 */
  submenuInfo(asset) {
    const groups = Object.values(this.spec.interactions ?? {});
    const sub = groups.find((g) => g?.submenu?.asset === asset)?.submenu;
    return { size: sub?.items?.length ?? 0, reversed: !!sub?.reversed };
  }

  /**
   * 在当前页的二级菜单里移动选中项。绝学页也吃这条，不是法宝专用。
   *
   * ⚠️ **法宝页的帧号与显示顺序相反**（帧 0 是最右的「用器」、帧 5 是最左的
   * 「暂置」），所以按 → 要让帧号 **−1** 才会看到高亮往右走。这条差异由
   * `interactions.fabao.submenu.reversed` 标出来，不在代码里按页名写死。
   */
  stepSubmenu(dir = 1) {
    const asset = this.currentSubmenu();
    if (!asset) return;
    const { size, reversed } = this.submenuInfo(asset);
    if (!size) return;
    const step = reversed ? -dir : dir;
    const cur = this.submenuFrame[asset] ?? 0;
    this.submenuFrame[asset] = ((cur + step) % size + size) % size;
    this.render();
  }

  // ————————————————————— 焦点层级 —————————————————————
  //
  // 方向键覆盖**界面上看得见的移动**，切人物这种正交操作交给 Tab：
  //
  //   层0 标签栏     ←→ 切页        ↓ 进层1              ESC 关菜单
  //   层1 二级菜单   ←→ 切分类      ↓ 进层2   ↑ 回层0    ESC 回层0
  //   层2 列表       ↑↓ 移光标      ←→ 翻页   回车 确认
  //
  // 两页的层1 不走「切分类」这一路，因为它们没有二级菜单：
  //   及身页 层1 = 三个装备槽   ↑↓ 选槽    → 进列表
  //   五内页 层1 = 五块属性牌   ↑↓ 选牌    **←→ 加减点**   回车 确认写入
  // 五内页没有层2。

  /**
   * 某个 role 该用多深的透明度：**焦点所在那一层全亮，其余压暗**。
   * 与焦点无关的元素（底图、立绘、面板）一律全亮。
   */
  focusAlpha(role) {
    const layer = { tabbar: 0, submenu: 1 }[role];
    if (layer === undefined) return 1;
    return layer === this.focus ? 1 : DIM_ALPHA;
  }

  /**
   * 单个元素的透明度。多数元素只看**它所属的层**是不是焦点层（`focusAlpha`），
   * 但五内页的加点箭头还要看**停在哪一块牌**上 —— 只有当前那块牌的一对箭头全亮。
   */
  elementAlpha(e) {
    if (e.role === 'alloc_left' || e.role === 'alloc_right') {
      return (this.focus === 1 && e.attr === this.attr) ? 1 : DIM_ALPHA;
    }
    return this.focusAlpha(e.role);
  }

  /**
   * 五内页：五块牌上的点数 + 中央「蘊魄」牌下的剩余五内。
   *
   * 两处都是**循环画**的，坐标 exe 里没有，实测在 `interactions.wunei.value`
   * （量法见 `tools/render_pages.py` 的 `WUNEI_VALUES`）。
   *
   * ⚠️ 字形表是 `MEN1017`（advance 15），**不是**这一页元素表里那两个 glyphs
   * （`MEN0028` / `MEN1028`）—— 那两个在原作截图里是空的，与点数无关。
   * ⚠️ `x` 是**中心**（`align: center`）：牌是定宽雕花框，位数变化时往两边长。
   *
   * 牌上显示的是「存量 + 暂存」、中央显示的是「剩余 − 暂存」，都由 `memberView`
   * 算好，这里只负责画。
   */
  drawWuneiValues(values) {
    const cfg = this.spec.interactions?.wunei?.value;
    const attrs = this.spec.interactions?.wunei?.attrs;
    if (this.page?.key !== '五内' || !cfg || !attrs || !values) return;
    const put = (value, x, y) => {
      if (!Number.isFinite(value)) return;
      paintNumber(this.scene, this.container, this.spec, cfg.asset, value,
                  { x, y, align: cfg.align }, this.parts);
    };
    for (const slot of cfg.slots ?? []) put(values[attrs[slot.attr]], slot.x, slot.y);
    if (cfg.remain) put(values.剩余五内, cfg.remain.x, cfg.remain.y);
  }

  /** 当前页最深能到第几层。 */
  maxFocus() {
    const hasList = !!this.spec.interactions?.listRows?.pages?.[this.page?.key];
    // 及身页没有二级菜单但有列表 —— 它的层1 该是三个装备槽，选中态还没做，
    // 所以那一页现在从层0 直接跳到列表。
    if (this.currentSubmenu()) return hasList ? 2 : 1;
    // 五内页没有二级菜单也没有列表，但层1 是**五块属性牌**：↑↓ 选牌、←→ 加减点。
    if (this.page?.key === '五内') return 1;
    // 机舱页层1 是音量与退出：↑↓ 选项、←→ 加减音量、确认退出。
    if (this.page?.key === '机舱') return 1;
    // 阵形页层1 是**格盘**：↑↓←→ 走格子、回车把当前选中的人挪过去。
    if (this.page?.key === '阵形') return 1;
    return hasList ? 2 : 0;
  }

  /** 五内页当前停着的属性名（'迅' / '烈' / …）。 */
  currentAttr() {
    return this.spec.interactions?.wunei?.attrs?.[this.attr] ?? null;
  }

  /**
   * 改一次暂存加点。**只动暂存，不动角色。**
   *
   * 两端都夹死：加不过「剩余五内」，减不到负数（负数等于动用存量，
   * 那是退点，原作没有）。夹住而不是拒绝，是为了让按住方向键时手感连续。
   */
  stepAlloc(dir) {
    const name = this.currentAttr();
    const member = selectedMember(this.party);
    if (!name || !member) return;
    const cur = this.alloc[name] ?? 0;
    const rest = member.剩余五内 - allocSum(this.alloc);
    const next = Math.max(0, cur + (dir > 0 ? Math.min(1, rest) : -1));
    if (next === cur) return;
    this.alloc = { ...this.alloc, [name]: next };
    this.queueRender();
  }

  /** 换页/换人/关菜单都作废暂存 —— 没按确认就不算数。 */
  clearAlloc() {
    if (allocSum(this.alloc) === 0) return;
    this.alloc = {};
  }

  /** 当前页列表有几行数据。用来夹住光标与滚动。 */
  listLength() {
    return this.listRows(selectedMember(this.party)).length;
  }

  /**
   * 层2 的上下：移动光标，必要时带着视窗滚动。
   *
   * 光标撞到列表顶还继续往上时，**退回层1**（或层0）—— 这样方向键在整个
   * 菜单里是连续的，不会卡在列表里出不来。
   */
  moveCursor(step) {
    const key = this.page?.key;
    const page = this.spec.interactions?.listRows?.pages?.[key];
    const len = this.listLength();
    if (!page || !len) { this.stepFocus(step); return; }
    const cur = this.cursor[key] ?? 0;
    // ⚠️ **两端循环**（到顶按上跳到底、到底按下跳到顶）。
    // 早先是「撞到两端就停」，那样按上毫无反应，用户会以为卡住了；
    // 循环则明确告诉他「退出上一层不是按上」，自然会去试 ←。
    // 整页翻（← →）不循环，夹在范围内即可。
    const next = Math.abs(step) === 1
      ? (cur + step + len) % len
      : Math.min(len - 1, Math.max(0, cur + step));
    this.cursor[key] = next;
    // 视窗跟着光标走，保证光标始终可见。
    const top = this.scroll[key] ?? 0;
    if (next < top) this.scroll[key] = next;
    else if (next >= top + page.rows) this.scroll[key] = next - page.rows + 1;
    this.render();
  }

  /** 进/退一层。越界不动。到层2 时把光标归位到当前选中项。 */
  stepFocus(delta) {
    const next = Math.min(this.maxFocus(), Math.max(0, this.focus + delta));
    if (next === this.focus) return;
    this.focus = next;
    if (next === 2 && this.cursor[this.page?.key] === undefined) {
      this.cursor[this.page.key] = 0;
      this.scroll[this.page.key] = 0;
    }
    this.render();
  }

  /** 当前层的上下：层2 是移光标，其余是进退层。 */
  vertical(step) {
    if (this.use) { this.useFlow.navigate(step, 0); return; }
    // 天书页整页归它自己：↑↓ 在 99 条记录之间走，开着框时归框。
    if (this.isTianshu()) { this.tianshuPage.navigate(step); return; }
    if (this.focus === 2) { this.moveCursor(step); return; }
    if (this.focus === 1 && this.page?.key === '阵形') { this.formation.step(step, 0); return; }
    if (this.focus === 1 && this.page?.key === '机舱') { this.cabin.moveRow(step); return; }
    if (this.focus === 1 && this.page?.key === '五内') {
      // 五块牌循环选。↑↓ 只在牌之间走，退出层1 走 ← 或 ESC ——
      // 与及身页三个槽同一套手感。
      const count = this.spec.interactions?.wunei?.attrs?.length ?? 5;
      this.attr = ((this.attr + step) % count + count) % count;
      this.queueRender();
      return;
    }
    if (this.focus === 1 && this.page?.key === '及身') {
      // ⚠️ **↑↓ 只在三个槽之间走，不负责进出层** —— 进列表走 →，退出走 ←。
      // 让它「越界就换层」会导致按下永远换不到护甲/饰物：第一下从层0 进层1
      // （槽仍是兵刃），第二下就越界跳进列表了。
      const next = this.slot + step;
      if (next < 0 || next >= EQUIP_SLOTS.length) return;
      this.setSlot(next);
      return;
    }
    this.stepFocus(step);
  }

  /** 换装备槽。候选列表整批换了，光标归位。 */
  setSlot(i) {
    if (i === this.slot) return;
    this.slot = i;
    this.cursor['及身'] = 0;
    this.scroll['及身'] = 0;
    this.queueRender();
  }

  /**
   * 当前层的左右。
   *
   * * 层0 —— 切页
   * * 层1 —— 有二级菜单的页切分类；**及身页没有二级菜单，← → 用来进出列表**
   * * 层2 —— **← 退回上一层**，→ 翻页
   *
   * 及身页因此是：↓ 进槽 → ↑↓ 选槽 → **→ 进列表** → ↑↓ 选装备 → 回车换上，
   * ← 一路退回去。
   */
  stepHorizontal(dir) {
    if (this.use) { this.useFlow.navigate(0, dir); return; }
    // ⚠️ 天书页**开着框时 ← 是退一层**，没开框才让 ←→ 去切页 ——
    // 不这么分的话，在确认框上按 ← 会直接翻到隔壁页，框还留在屏幕上。
    if (this.isTianshu() && this.tianshuPage.back()) return;
    if (this.focus === 0) { this.goTo(this.tab + dir); return; }
    if (this.focus === 1 && this.page?.key === '阵形') { this.formation.step(0, dir); return; }
    if (this.focus === 1) {
      // 机舱页的 ←→ 是**加减音量**（这一页没有二级菜单）。
      // ⚠️ 这里**不给 ← 兼「退层」**：五内页那套「没有暂存时 ← 退层」在这儿
      // 行不通 —— 音量没有「暂存」，唯一能类比的条件是「已经减到最小」，
      // 那会变成一路调小音量、到底之后再按一下就弹出页面。退层交给 ESC。
      if (this.page?.key === '机舱') { this.cabin.stepLevel(dir); return; }
      // 五内页的 ←→ 是**加减点**，不是切分类（这一页没有二级菜单）。
      // ⚠️ 但 ← 还兼着「退层」：**当前这块牌没有暂存时**，← 退回标签栏，
      // 与其它页的 ← 一致；有暂存时 ← 先把点退回去。
      // 不这么做的话五内页就只能靠 ESC 退出，与全菜单的手感不一致。
      if (this.page?.key === '五内') {
        if (dir < 0 && (this.alloc[this.currentAttr()] ?? 0) === 0) {
          this.stepFocus(-1);
          return;
        }
        this.stepAlloc(dir);
        return;
      }
      if (this.currentSubmenu()) { this.stepSubmenu(dir); return; }
      // ⚠️ **没有候选就不让进列表** —— 空列表进去后光标无处可落，
      // 预览列会按「卸下」算出一组变化，而右边又没有任何一行对应它，
      // 看起来像凭空冒出来的数字。
      if (dir > 0 && this.listLength() === 0) return;
      this.stepFocus(dir > 0 ? 1 : -1);
      return;
    }
    if (dir < 0) { this.stepFocus(-1); return; }
    const page = this.spec.interactions?.listRows?.pages?.[this.page?.key];
    if (page) this.moveCursor(page.rows);
  }

  /**
   * ESC 一个键管三件事：**没开就开、有层可退就退一层、已在最外层才关**。
   *
   * ⚠️ 绑定处**不能加 `this.visible &&` 守卫** —— 菜单是靠 ESC 打开的，
   * 加了守卫就永远打不开。（真踩过：构建过、27 个测试全绿、菜单进不去。）
   */
  escape() {
    this.clickPending = null;
    // ⚠️ **购物界面开着时 ESC 归它**（撤销数量框 / 关店）。
    // 这里没有 `this.visible` 守卫是有意的（菜单靠 ESC 打开），
    // 所以必须显式让开，否则在店里按 ESC 会把菜单也弹出来盖在上面。
    if (this.scene.shopScreen?.visible || (this.scene.innScreen?.visible && !this.visible)) return;
    if (!this.visible && this.scene.heldItem != null) { this.scene.heldItem = null; return; }
    if (!this.visible) { if (this.scene.fieldInputAvailable?.()) this.toggle(); }
    else if (this.picker) this.toggle();       // 挑件模式：ESC＝不放，关菜单回剧情
    else if (this.use) this.useFlow.cancel();       // 确认框/选人开着时，ESC 只撤销这一次使用
    else if (this.isTianshu() && this.tianshuPage.back()) { /* 框吃掉了这一下 */ }
    else if (this.formation.cancelSource()) { /* 撤掉已选的人 */ }
    else if (this.focus > 0) this.stepFocus(-1);
    else this.toggle();
  }

  /**
   * 回车确认。目标有两个：五内页是**暂存加点**，及身页是**列表里光标停着那一件**。
   * 其余页没有可确认的对象，直接返回 —— 不要在这里塞临时行为。
   */
  confirm() {
    if (this.clickPending) return;
    // 「拿一件放上去」模式：回车就是**挑中这一件**，不走平时那套使用流程
    //（那套会弹「確定使用」再选人，而放石球既不选人也不回血）。
    if (this.picker) { this.pickForScript(); return; }
    // 一次使用正在进行时，回车归它（确认框的两行 / 选人的落点）。
    if (this.use) { this.useFlow.confirm(); return; }
    if (this.isTianshu()) { this.tianshuPage.confirm(); return; }
    if (this.page?.key === '机舱') { this.cabin.confirm(); return; }
    if (this.page?.key === '五内') { this.confirmAlloc(); return; }
    if (this.page?.key === '阵形' && this.focus === 1) { this.formation.placeHere(); return; }
    // ⚠️ **先试使用，再落回分发。** 暂置格里也能用东西（原作截图里
    // 金创药就躺在暂置格，选中按确定照样弹「確定使用」），
    // 所以不能让「在暂置格」直接吃掉回车。
    if (this.useFlow.begin()) return;
    if (this.page?.key === '法宝' && this.inTempCategory()) { this.dispatch(); return; }
    if (this.page?.key !== '及身' || this.focus !== 2) return;
    const member = selectedMember(this.party);
    const rows = this.listRows(member);
    const row = rows[this.cursor['及身'] ?? 0];
    if (!row) return;
    // ⚠️ **红色不是提示，是禁令** —— 画成红的那一行必须真的装不上。
    // 只染色不拦截的话，冰璃照样能装上夏侯仪的匕首，红色就成了摆设。
    if (this.rowBlocked(row, member)) return;
    const out = equipTo(this.party, this.inventory, this.catalog,
                        EQUIP_SLOTS[this.slot], row.代码);
    this.party = out.party;
    this.inventory = out.inventory;
    this.pushState();
    // 换完候选少了一件、多了换下来那件，光标夹回范围。
    const len = this.listRows(selectedMember(this.party)).length;
    this.cursor['及身'] = Math.min(this.cursor['及身'] ?? 0, Math.max(0, len - 1));
    this.queueRender();
  }

  /**
   * 五内加点确认（`MEN6004`）：把暂存写进角色，暂存清零。
   *
   * 写完两列抗性会变得相同 —— 左列的输入（存量+暂存）此刻就等于右列的存量，
   * 这正是「已生效」的表现，不需要另外处理。
   */
  confirmAlloc() {
    if (allocSum(this.alloc) === 0) return;
    this.party = allocWunei(this.party, this.alloc);
    this.pushState();
    this.alloc = {};
    this.queueRender();
  }

  /** 顶部队伍条。各格由循环画，坐标 exe 里没有，是截图实测（见 §2.9）。 */
  drawPartyBar() {
    const bar = this.spec.partyBar;
    if (!bar || this.page?.standalone === 'tianshu') return;
    const members = this.party?.members ?? [];
    const count = Math.min(members.length, bar.slots);
    for (let k = 0; k < count; k += 1) {
      const sx = bar.slotX[k];
      const sy = bar.slotY;
      this.drawTile(bar.plate.asset, bar.plate.img, sx + bar.plate.x, sy + bar.plate.y);
      // 条与柱这类填充素材：**帧号就是档位**，帧 0 是空的
      this.drawTile(bar.hp.asset, this.fillFrame(bar.hp.asset, members[k], '命'),
                    sx + bar.hp.x, sy + bar.hp.y);
      this.drawTile(bar.qi.asset, this.fillFrame(bar.qi.asset, members[k], '气'),
                    sx + bar.qi.x, sy + bar.qi.y);
      this.drawFigure(bar, sx, sy, members[k]);
      this.drawSlotNumbers(bar, sx, sy, members[k]);
    }
  }

  /**
   * 队伍条格内的位阶 / 命 / 气数值。
   * 格内坐标来自 exe 簇 25（`partyBar.numbers`），不是量的。
   * ⚠️ 这两张字形表是**阿拉伯数字**，与面板里的中文数字不是一套。
   */
  drawSlotNumbers(bar, sx, sy, member) {
    if (!this.gamedata || !member) return;
    const view = memberView({ ...this.party, 选中: this.party.members.indexOf(member) },
                            this.gamedata, this.catalog);
    for (const n of bar.numbers ?? []) {
      const value = view[n.field];
      if (!Number.isFinite(value)) continue;
      paintNumber(this.scene, this.container, this.spec, n.asset, value,
                  { x: sx + n.x, y: sy + n.y }, this.parts);
    }
  }

  /** 队伍条里的小人：**底对齐 + 水平居中**，不是左上角对齐（七个角色图高不一）。 */
  drawFigure(bar, sx, sy, member) {
    const asset = bar.figure.asset;
    const index = battleIndex(member?.name);
    const size = this.spec.assets?.[asset]?.sizes?.[index];
    if (!size) return;
    this.drawTile(asset, index,
                  Math.round(sx + bar.figure.centerX - size[0] / 2),
                  sy + bar.figure.bottomY - size[1]);
  }

  /** 队伍条里那两根小条的档位。命极/气极缺失时按满算。 */
  fillFrame(asset, member, stat) {
    const cur = member?.[stat];
    const max = member?.[`${stat}极`] ?? cur;
    const ratio = (Number.isFinite(cur) && Number.isFinite(max) && max > 0) ? cur / max : 1;
    return fillFrame(this.spec, asset, ratio);
  }

  /**
   * 剧情改了状态之后叫一下，把菜单这份引用换成新的。
   *
   * 不叫的话：在药铺买了东西、封铃笙入了队，打开菜单看到的还是旧的。
   */
  syncState(party, inventory) {
    if (party) this.party = party;
    if (inventory) this.inventory = inventory;
    // ⚠️ **收到新状态要重画。** 原先只设了个 `this.dirty` —— 而 `dirty`
    // 全项目**没有任何地方读**，等于什么都没做：剧情把血扣了，菜单里还是旧数，
    // 要切一下页（那条路会 render）才更新。用户对着放错石球那一下报的就是这个。
    this.clampCursors();
    if (this.visible) this.queueRender();
  }

  /**
   * 把各页的列表光标夹回范围内。
   *
   * ⚠️ **列表会在菜单开着的时候变短** —— 剧情 `item_lose` 扣掉一件、
   * 或者「挑一件放上去」模式退出时从 3 行候选切回整格背包。光标留在原处
   * 就会指到表外，`drawList` 照样画那一行，出来是**一条没有名字的空条目**
   * （用户截图里杂类最后那一行）。
   */
  clampCursors() {
    // ⚠️ **只夹当前这一页。** `listRows` 是按 `this.page` 算的，而 `page`
    // 是个 **getter**（从 `tab` 推出来）—— 想挨页算就得临时改 `page`，
    // 赋值当场抛 `TypeError: Cannot set property page`。第一版就是这么写的。
    // 别的页等玩家翻过去时自然会经过这里，夹当前页够用。
    const key = this.page?.key;
    if (!key || this.cursor?.[key] === undefined) return;
    const n = this.listRows(selectedMember(this.party)).length;
    this.cursor[key] = Math.max(0, Math.min(this.cursor[key], Math.max(0, n - 1)));
  }

  /** 菜单自己改完状态（换装、分发、加点）写回全局，否则出了菜单就丢。 */
  pushState() {
    this.scene.registry?.set?.('gameState', Object.freeze({
      ...(this.scene.registry.get('gameState') ?? {}),
      party: this.party,
      inventory: this.inventory,
    }));
  }

  /** 贴单张图（不走帧表，直接按图号）。队伍条与天书页的循环元素用。 */
  drawTile(asset, index, x, y, alpha = 1) {
    if (!this.spec.assets?.[asset]) return;
    const img = this.scene.add.image(x, y, textureKey(asset), index)
      .setOrigin(0, 0).setScrollFactor(0).setAlpha(alpha);
    this.container.add(img);
    this.parts.push(img);
  }

  /**
   * 汉字文本（装备名等），用**原作点阵字体**画。
   *
   * ⚠️ **必须按 24 原尺寸**，缩放会糊 —— 点阵字没有矢量轮廓可重采样（见 config.js）。
   * 位置在 `menus.json` 的 `textSlots` 里（从原作截图量的，exe 里没有登记）。
   */
  drawTexts() {
    const slots = this.spec.textSlots?.[this.page?.key];
    if (!slots) return;
    const member = selectedMember(this.party);
    for (const slot of slots) {
      const raw = readPath(member, slot.field);
      // ⚠️ **`装备.*` 里存的是代码不是名称** —— 主键换成代码之后，这里必须
      // 经目录换成繁体名再画，否则屏幕上会出现「65」这种十六进制。
      // 字库按 Big5 码位索引，画的必须是繁体。
      const text = slot.field?.startsWith('装备.')
        ? displayName(this.catalog.物品(raw))
        : (raw ? String(raw) : null);
      if (!text) continue;
      const label = this.scene.add.bitmapText(slot.x, slot.y, menuFont(), text, FONT_SIZE)
        .setScrollFactor(0);
      noXbr(label);
      this.container.add(label);
      this.parts.push(label);
    }
  }

  /**
   * 按名称查繁体名。**只给调试与外部传进来的名字用**，界面路径已经不走它了。
   *
   * ⚠️ 名称重名（官方版装备 44 条、用器 14 条），返回的可能不是你要的那条。
   * 界面一律走代码，见 `systems/catalog.js` 的文件头。
   */
  traditional(name) {
    return displayName(this.catalog.查(name)) || null;
  }

  // ————————————————————————— 交互 —————————————————————————

  /**
   * 二级菜单每一项的点击区。
   *
   * **不用另外量坐标** —— 每一帧的最后一层就是那一项的高亮块，它的 x/y 和
   * 尺寸正好圈出该项。法宝页帧号与屏幕左右相反，这里按帧取所以天然对得上。
   */
  submenuHits(asset, ox, oy) {
    const meta = this.spec.assets?.[asset];
    const { size } = this.submenuInfo(asset);
    const out = [];
    for (let f = 0; f < size; f += 1) {
      const layer = meta?.frames?.[f]?.slice(-1)[0];
      if (!layer) continue;
      const [w, h] = meta.sizes[layer.img] ?? [0, 0];
      out.push({ frame: f, x: ox + layer.x, y: oy + layer.y, w, h });
    }
    return out;
  }

  /** 列表每一行的点击区。行距与起点都在 `interactions.listRows` 里。 */
  listHits() {
    const cfg = this.spec.interactions?.listRows;
    const page = cfg?.pages?.[this.page?.key];
    if (!page) return [];
    const meta = this.spec.assets?.[page.bar];
    const [w, h] = meta?.sizes?.[0] ?? [200, 24];
    const top = this.scroll[this.page.key] ?? 0;
    const len = this.listLength();
    const out = [];
    for (let i = 0; i < page.rows && top + i < len; i += 1) {
      out.push({ index: top + i, x: page.x, y: page.y0 + cfg.pitch * i, w, h });
    }
    return out;
  }

  /**
   * 加一个交互区。**悬停即把焦点移过去** —— 鼠标与键盘共用同一份状态
   * （`focus` / `submenuFrame` / `cursor`），所以两者不会打架：鼠标移到哪，
   * 键盘就从哪继续走。
   */
  addZone(a, onHover, onClick) {
    const zone = this.scene.add.zone(a.x, a.y, a.w, a.h)
      .setOrigin(0, 0).setScrollFactor(0).setDepth(DEPTH + 1)
      .setInteractive({ useHandCursor: true });
    // ⚠️ **两个回调都要判空。** Phaser 的事件发射器收到 `null` 监听器会
    // **抛 TypeError**，而这个函数在每次 render 里跑 —— 一处传空，
    // 整个菜单就再也画不出来，表现是「游戏卡死」而不是报个错。
    // 分发按钮只需要点击、不需要悬停，就踩过这个坑。
    if (onHover) zone.on('pointerover', () => {
      if (this.scene.game.scene.getScene('Cursor')?.mouseVisible) onHover();
    });
    if (onClick) zone.on('pointerdown', (p, x, y, event) => {
      if (!p.leftButtonDown()) return;
      event.stopPropagation();
      onClick(p);
    });
    zone.setVisible(this.visible);
    this.hits.push(zone);
    return zone;
  }

  buildTabHits() {
    this.hits?.forEach((z) => z.destroy());
    // ⚠️ **确认框开着时只挂它自己的热区。** 其余热区照挂的话，鼠标从框上
    // 移开会顺手把焦点移到底下的列表，选中项在框还开着的时候就被换掉了。
    if (this.use) { this.hits = []; this.useFlow.buildHits(); return; }
    this.hits = [];
    if (this.isTianshu() && this.tianshuPage.hasDialog) { this.tianshuPage.buildHits(); return; }
    const el = this.page?.standalone === 'tianshu'
      ? { asset: this.spec.tianshu.tabbar.asset, ...this.spec.tianshu.tabbar }
      : this.page?.elements?.find((e) => e.role === 'tabbar');
    if (!el) { this.hits = []; return; }
    this.hits = [];
    tabHitAreas(this.spec, el.asset, el.x, el.y, this.tabCount + 1).forEach((a) => {
      this.addZone(a, () => this.setFocus(0), () => a.tab === this.tabCount ? this.toggle() : this.goTo(a.tab));
    });

    if (this.page?.standalone === 'tianshu') { this.tianshuPage.buildArrowHits(); this.tianshuPage.buildHits(); }
    else this.buildListArrowHits();

    const sub = this.page?.elements?.find((e) => e.role === 'submenu');
    if (sub) {
      this.submenuHits(sub.asset, sub.x, sub.y).forEach((a) => {
        this.addZone(a, () => this.pickSubmenu(sub.asset, a.frame), () => this.pickSubmenu(sub.asset, a.frame));
      });
    }
    this.listHits().forEach((a) => {
      this.addZone(a, () => this.pickRow(a.index), () => {
        if (this.clickPending) return;
        this.pickRow(a.index);
        this.render();
        const key = this.page.key;
        const token = this.clickPending = {};
        this.scene.time.delayedCall(90, () => {
          if (this.clickPending !== token) return;
          this.clickPending = null;
          if (this.visible && this.page.key === key && this.focus === 2 && this.cursor[key] === a.index) this.confirm();
        });
      });
    });
    // 法宝页底下那个按钮。**只给当前显示的那一个挂点击区** ——
    // 分发与弃置画在同一处，两个都挂的话点一下会触发到被隐藏的那个。
    for (const el of this.page?.elements ?? []) {
      if (el.role !== 'action' || !this.showsActionButton(el)) continue;
      const [w, h] = this.spec.assets?.[el.asset]?.cell ?? [0, 0];
      if (!w) continue;
      this.addZone({ x: el.x, y: el.y, w, h }, null,
                   () => { if (el.asset === 'MEN4006') this.dispatch(); else if (el.asset === 'MEN4008') this.discardOne(); });
    }
    // 及身页三个装备槽：悬停即选中该槽（鼠标与键盘共用 this.slot / this.focus）
    this.cabin.buildHits();
    this.buildMemberAndFormationHits();
    this.buildWuneiHits();
    const eq = this.spec.interactions?.equipSlots;
    if (eq && this.page?.key === '及身') {
      eq.assets.forEach((asset, i) => {
        const el = this.page.elements.find((e) => e.asset === asset);
        const [w, h] = this.spec.assets?.[asset]?.cell ?? [0, 0];
        if (!el || !w) return;
        const selectSlot = () => {
          const changed = this.focus < 1 || this.slot !== i;
          this.focus = Math.max(this.focus, 1);
          this.slot = i;
          if (changed) { this.cursor['及身'] = 0; this.scroll['及身'] = 0;
                         this.queueRender(); }
        };
        this.addZone({ x: el.x, y: el.y, w, h }, selectSlot, selectSlot);
      });
    }
  }

  /**
   * 使用流程的点击区：确认框的两行，或选人时队伍条的五格。
   *
   * 热区尺寸来自 `menus.json` 的 `confirmUse.hits`（`render_pages.PAGE_CONFIRM_USE`）。
   */
  /**
   * 天书页上下箭头的点击区 —— **一次翻一屏**。
   *
   * 用户的原话：「现在存档只能按键盘上下一条一条翻，而没办法一页一页翻。
   * 存档页面上面有一个向上的箭头，下面有一个向下的箭头，界面上面用鼠标
   * 点击它，应该能够上下翻页才对」。
   *
   * 箭头**一直画着**（`TianshuPage.draw` 里那行 `t.arrows.forEach`），
   * 只是从来没挂过热区 —— 画出来却点不了，比没画还误导人。
   *
   * ⚠️ 尺寸从**纹理**取，不从 `menus.json` 取：那份规格里
   * `assets[...].images` 是 null，只有图层坐标。而 `MEN8005` 的第 2 层
   * 落在 (289,453) —— 拿整帧的包围盒当热区会得到一个横跨半屏的框。
   * **只用第一层（img 0）**，那才是箭头本身。
   */
  /**
   * **列表页（法宝/绝学/及身）上下箭头的点击区** —— 一次翻一屏。
   *
   * 用户：「这两个箭头应该是可以点击的」「这个功能也要在商店、角色菜单栏里
   * 的相关列表中实现」。此前这三页的箭头**画出来了但点不动**，
   * 和天书页修之前一样 —— 画出来却点不了比没画还误导人。
   *
   * ⚠️ 尺寸从**纹理**取，理由同 `TianshuPage.buildArrowHits`（规格里没有图尺寸）。
   * ⚠️ **翻不动就不挂** —— 与箭头"不跳动"的表达一致，点了没反应更糟。
   */
  buildMemberAndFormationHits() {
    if (!this.isTianshu()) {
      const bar = this.spec.partyBar;
      this.party.members.forEach((m, index) => {
        this.addZone({ x: bar.slotX[index], y: bar.slotY, w: 104, h: 97 }, null,
          () => this.stepMember(index - this.party.选中));
      });
    }
    this.formation.buildHits();
  }

  buildWuneiHits() {
    if (this.page?.key !== '五内') return;
    for (const el of this.page.elements) {
      if (!el.role?.startsWith('alloc_')) continue;
      const [w,h] = this.spec.assets[el.asset].cell;
      this.addZone({ x: el.x, y: el.y, w, h }, null, () => {
        this.focus = 1;
        if (el.role === 'alloc_confirm') this.confirmAlloc();
        else { this.attr = el.attr; this.stepAlloc(el.role === 'alloc_right' ? 1 : -1); }
      });
    }
  }

  buildListArrowHits() {
    for (const e of this.page?.elements ?? []) {
      if (e.role !== 'arrow_up' && e.role !== 'arrow_down') continue;
      const dir = e.role === 'arrow_up' ? -1 : 1;
      if (!this.canPage(dir)) continue;
      const first = layersOf(this.spec, e.asset, 0, e.x, e.y)[0];
      if (!first) continue;
      const frame = this.scene.textures.get(textureKey(e.asset))?.get(first.img);
      if (!frame?.width || !frame?.height) {
        console.warn(`⚠ ${this.page?.key}页箭头 ${e.asset} 取不到尺寸，翻页点不了`);
        continue;
      }
      // 高清界面图按倍数放大过，可点范围要按显示尺寸（逻辑像素）算
      const s = hdScaleOf(textureKey(e.asset));
      this.addZone({ x: first.x, y: first.y, w: frame.width / s, h: frame.height / s },
                   null, () => this.pageList(dir));
    }
  }

  /**
   * 推迟一帧重画。
   *
   * ⚠️ **鼠标回调里不能直接 `render()`** —— `render()` 会 destroy 掉所有交互区，
   * 包括**正在派发这次事件的那一个**，Phaser 的输入系统会在遍历中被抽掉元素。
   * 键盘路径没这个问题，但统一走这里更省心（延迟一帧看不出来）。
   */
  queueRender() {
    if (this.pending) return;
    this.pending = true;
    this.scene.time.delayedCall(0, () => {
      this.pending = false;
      this.render();
    });
  }

  /** 只改焦点层，不动别的。相同就不重画。 */
  setFocus(layer) {
    const next = Math.min(this.maxFocus(), Math.max(0, layer));
    if (next === this.focus) return;
    this.focus = next;
    this.queueRender();
  }

  /** 鼠标选中二级菜单的某一项：焦点进层1，并把该项设为选中。 */
  pickSubmenu(asset, frame) {
    if (this.focus === 1 && this.submenuFrame[asset] === frame) return;
    this.focus = Math.min(this.maxFocus(), 1);
    this.submenuFrame[asset] = frame;
    this.queueRender();
  }

  /** 鼠标选中列表的某一行：焦点进层2，并把光标移过去。 */
  pickRow(index) {
    const key = this.page?.key;
    if (this.focus === 2 && this.cursor[key] === index) return;
    this.focus = Math.min(this.maxFocus(), 2);
    this.cursor[key] = index;
    this.queueRender();
  }

  /**
   * 按住 ↑/↓ 在 99 条存档之间连续滚。**只在天书页**，见 `ui/holdScroll.js`。
   *
   * ⚠️ 开着确认框时不滚 —— 那时 ↑↓ 归框里的两三个选项，连发会乱跳。
   * `TS.navigate` 自己也判了这一条，这里提前退出只是省掉每帧的重画。
   */
  tickHold(time) {
    if (!this.visible || !this.holdKeys || !this.isTianshu()) return;
    if (this.tianshuPage.hasDialog) { this.hold = createHold(); return; }
    const dir = heldDirection(this.holdKeys.up, this.holdKeys.down);
    const got = holdSteps(this.hold, dir, time);
    this.hold = got.state;
    for (let i = 0; i < got.steps; i += 1) this.vertical(dir);
  }

  bindInput() {
    const kb = this.scene.input.keyboard;
    kb.on('keydown-ESC', () => this.escape());   // ⚠️ 不加 visible 守卫，见 escape()
    kb.on('keydown-LEFT', () => this.visible && this.stepHorizontal(-1));
    kb.on('keydown-RIGHT', () => this.visible && this.stepHorizontal(1));
    kb.on('keydown-UP', () => this.visible && this.vertical(-1));
    kb.on('keydown-DOWN', () => this.visible && this.vertical(1));
    // 按住不放连续滚。**只给天书页** —— 别的页一屏就那么几行，
    // 连发反而会冲过头。每帧在 `update` 里推，见 `ui/holdScroll.js`。
    this.holdKeys = {
      up: kb.addKey(Phaser.Input.Keyboard.KeyCodes.UP),
      down: kb.addKey(Phaser.Input.Keyboard.KeyCodes.DOWN),
    };
    this.hold = createHold();
    kb.on('keydown-ENTER', () => this.visible && this.confirm());
    for (const key of ['BACKSPACE', 'DELETE']) kb.on(`keydown-${key}`, ev => {
      if (this.visible && this.page?.key === '法宝' && this.focus === 2 && !ev.repeat) {
        ev.preventDefault(); this.discardOne();
      }
    });
    kb.on('keydown', ev => {
      if (!this.visible || this.use || this.picker || this.tianshuPage.hasDialog) return;
      if (ev.code === 'BracketLeft') this.goTo(this.tab-1);
      if (ev.code === 'BracketRight') this.goTo(this.tab+1);
    });
    // 导出 / 导入 `.TSF`。**原作没有这两个功能**（它直接写磁盘），
    // 浏览器没有文件系统，所以这是我们加的，按键与提示都记在推断清单里。
    kb.on('keydown-E', () => this.visible && this.isTianshu() && this.tianshuPage.exportSlot());
    kb.on('keydown-I', () => this.visible && this.isTianshu() && this.tianshuPage.importSlot());
    // **F：选存档文件夹**（原作没有，见 `systems/saveStore.js`）。
    // ⚠️ 必须在按键回调里直接调 —— `showDirectoryPicker` 要求用户手势，
    // 放进 Promise 的后续回调里会被浏览器拒掉。
    kb.on('keydown-F', () => this.visible && this.isTianshu() && this.tianshuPage.pickFolder());
    // 切人物与焦点位置正交，所以不占方向键。Shift+Tab 反向。
    kb.on('keydown-TAB', (ev) => {
      if (!this.visible) return;
      ev.preventDefault();
      // ⚠️ 使用流程里不许换人 —— 换掉的正是物品的目标、绝学的施法者。
      if (this.use) return;
      this.stepMember(ev.shiftKey ? -1 : 1);
    });
  }

  /**
   * 直接打开天书页。剧情的 `open_save`（存档点）走这里。
   *
   * 页号**从规格里查**，不写死 —— 八页的次序将来若变，这里不用跟着改。
   */
  openTianshu(onClose = null) {
    const tab = (this.spec?.pages ?? []).findIndex((p) => p.standalone === 'tianshu');
    if (tab < 0) { console.warn('menus.json 里没有天书页，存档点打不开'); return false; }
    this.onTianshuClose = onClose;
    this.tab = tab;
    this.focus = 0;
    this.tianshuPage.reset();
    // `toggle()` 现在打开时也会 `render()`（见那里），但**菜单已经开着时
    // 不会走 toggle** —— 剧情在菜单开着的时候弹存档点就是这种情形，
    // 所以这一次 `queueRender` 还得留着。
    if (!this.visible) this.toggle();
    this.queueRender();
    return true;
  }

  /**
   * **「拿一件道具放上去」**：跳到法宝页，只列这一处认的那几件，等玩家挑。
   *
   * ## 为什么是这个交互（A 方案，用户拍板）
   *
   * 原作是**先在菜单里点物品、再点场景里的目标**（鼠标两步）。我们是全键盘，
   * 于是改成**走到目标前按 Enter → 跳法宝页只列候选 → 选中 → 放上去**。
   * 用户原话：「物品使用逻辑就用你说的这个 A」。
   *
   * ⚠️ **只列玩家身上真有的候选**，而且**不告诉他哪件是对的** ——
   * 迦夏之窟三根柱子认的是 402/403/404，三件**都叫「黑石球」**，
   * 谜题就是"哪个放哪根"。列表里照样是三行一模一样的名字，与原作一致。
   *
   * @param {Set<string>|string[]} codes 候选道具的**十六进制代码**
   * @param {(code: string|null) => void} onPick 挑中回调；ESC 取消时传 null
   * @returns {boolean} 打开了没有（法宝页不在 `menus.json` 里就 false）
   */
  openItemPicker(codes, onPick) {
    const tab = (this.spec?.pages ?? []).findIndex((p) => p.key === '法宝');
    if (tab < 0) { console.warn('menus.json 里没有法宝页，道具选不了'); return false; }
    this.picker = { codes: new Set([...codes].map(itemKey)), onPick };
    this.tab = tab;
    // ⚠️ 焦点要落到**列表**上（法宝页的 focus 2 才是列表），
    // 停在标签栏的话方向键在换页，玩家选不了东西。
    this.focus = 2;
    this.cursor['法宝'] = 0;
    this.use = null;
    // ⚠️ **打开之后一定要重画。** 这里曾经只靠容器里上一次画好的内容，
    // 于是从地图直接弹出来的是**上次停在的那一页**（截图上是状态页），
    // 而 `tab` 其实已经切到法宝了。`toggle()` 现在打开时也 `render()`，
    // 但菜单**已经开着**时不走 toggle，所以这一次仍要留。
    if (!this.visible) this.toggle();
    this.queueRender();
    return true;
  }

  /** 挑件模式下按回车：把光标停着那一件交出去，然后关菜单。 */
  pickForScript() {
    const rows = this.listRows(selectedMember(this.party));
    const row = rows[this.cursor['法宝'] ?? 0];
    if (!row) return;                       // 一件都没有时回车不该有反应
    const pick = this.picker;
    this.picker = null;                     // 先摘掉，`toggle` 里就不会再当成取消
    this.clampCursors();                    // 列表从候选切回整格背包，光标要跟着夹
    this.toggle();                          // 关菜单回地图
    pick.onPick(itemKey(row.代码));
  }

  /** 阵形页光标格与已选来源（对外接口不变：验证脚本读写这两个）。 */
  get formationSlot() { return this.formation.slot; }
  set formationSlot(slot) { this.formation.slot = slot; }
  get formationSource() { return this.formation.source; }
  set formationSource(index) { this.formation.source = index; }

  /** 正在进行的一次使用的状态，`null` = 没有。方向键/回车先问它。 */
  get use() { return this.useFlow.state; }
  set use(state) { this.useFlow.state = state; }

  /** 天书状态机的当前状态（对外接口不变：验证脚本读 `statusScreen.tianshu.dialog`）。 */
  get tianshu() { return this.tianshuPage.state; }
  set tianshu(state) { this.tianshuPage.state = state; }

  /** 槽位摘要。场景在存读档后调用它刷新，见 `TianshuPage.refreshSlots`。 */
  refreshSlots(records) { this.tianshuPage.refreshSlots(records); }

  /** 当前是不是天书页。整页的输入都归 `ui/TianshuPage.js`。 */
  isTianshu() {
    return this.page?.standalone === 'tianshu';
  }

  goTo(tab) {
    this.clickPending = null;
    const next = ((tab % this.tabCount) + this.tabCount) % this.tabCount;
    if (next === this.tab) return;
    this.tab = next;
    this.formationSource = null;
    this.focus = 0;   // 每页的层数不同，换页必须回到最外层（光标按页保留）
    this.clearAlloc();
    this.render();
  }

  stepMember(step) {
    this.clickPending = null;
    if (!this.party?.members?.length) return;
    // ⚠️ 先作废暂存再切人 —— 暂存是**属于某个角色**的，带过去会把甲的加点
    // 记在乙头上。
    this.clearAlloc();
    this.party = selectStep(this.party, step);
    this.render();
  }

  toggle() {
    this.clickPending = null;
    this.visible = !this.visible;
    this.formationSource = null;
    // ⭐ **打开时必须重画。** 这里原先只在 `!visible`（关闭）那一支 `render()`，
    // 打开就只是 `container.setVisible(true)` —— 画面上是**上一次画的内容**。
    // 于是剧情把血扣了（`syncState` 因为菜单没开而没重画），玩家按 ESC 打开
    // 看到的还是旧数，**得按一下方向键**（那条路会 `queueRender`）才更新。
    //
    // ⚠️ 这是同一个病根的**第三次**：`openTianshu`（存档点）与
    // `openItemPicker`（挑道具）上一轮各修过一次，而 ESC 这条主路漏了。
    // 判据表里那一行「一个界面打开时 → 确认它会重绘」说的就是这儿。
    if (this.visible) this.render();
    if (!this.visible) {
      // 剧情存档点开的菜单：关掉之后脚本才接着往下走（与 `open_shop` 同理）。
      const done = this.onTianshuClose;
      this.onTianshuClose = null;
      if (done) done();
      // ⚠️ **挑件的回调一定要兑现**，哪怕玩家是按 ESC 关的 ——
      // 不兑现的话剧情永远停在 `test_item_used` 那一条，人物动不了、
      // 菜单也开不了，而且不报错。传 null＝没挑。
      const pick = this.picker;
      this.picker = null;
      if (pick) { this.clampCursors(); pick.onPick(null); }
      this.clearAlloc();
      // 没用完的确认框与还在播的特效都跟着菜单一起收掉 ——
      // 特效挂在菜单的 container 之外（自带 container），不收会留在画面上。
      this.use = null;
      this.useFx.clear();
      this.render();
    }
    this.container.setVisible(this.visible);
    this.hits?.forEach((z) => z.setVisible(this.visible));
  }
}
