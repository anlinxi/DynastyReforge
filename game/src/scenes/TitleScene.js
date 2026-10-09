import { mountLanguageChoice } from '../systems/language.js';
import { backHint } from '../systems/inputHints.js';
import { mountHdChoice } from '../hd/hdChoice.js';
import { mountPatchChoices } from '../ui/titleOptions.js';
import { mountSaveFolderChoice } from '../ui/saveFolderChoice.js';
import Phaser from 'phaser';
import FieldSprite from '../systems/FieldSprite.js';
import { SLOT_COUNT, loadAllSlots, slotSummary } from '../systems/saveslot.js';
import * as TS from '../ui/tianshu.js';
import { arrowFrame } from '../ui/listArrows.js';
import { createHold, heldDirection, holdSteps } from '../ui/holdScroll.js';
import { drawSlotRows } from '../ui/slotRows.js';
import { LAYOUT_KEY, applySaveBytes } from '../systems/gameSave.js';
import { newGameEntry } from '../systems/gameStart.js';
import { gateCheck } from '../systems/authGate.js';
import { playBgm, stopBgm } from '../systems/bgm.js';
import { MENU_SPEC_KEY, layersOf, textureKey } from '../ui/menuSpec.js';
import {
  STAGE_WIDTH, STAGE_HEIGHT, TITLE, SHARED_EVENT_MAP,
} from '../config.js';
import { centerLegacyScene, uiPointer } from '../systems/stageView.js';

/** 标题进游戏：加载超过多久才显示「载入中…」，与切图（FieldScene.LOAD_HINT_MS）同值。 */
const GAME_ENTRY_HINT_MS = 400;

/**
 * 标题画面 —— 打开游戏先播片头，然后三选一。
 *
 * ## 原作的流程（判据在数据里）
 *
 * `MP0000` 槽 8 **被一条 `end` 天然切成两段**，这两段正好夹着标题画面：
 *
 * ```
 * 子事件 0  :  片头影片 → end       ← 汉堂国际，长片头
 * ──────────────── 标题画面在这里 ────────────────
 * 子事件 1  :  fade_out → play_audio 31
 *                        → play_movie 3           ← 梦境，短片
 *                        → actor_show Event-0 → 起床剧情
 * ```
 *
 * ⚠️ **这推翻了一条旧推断。** `docs/状态/复现度台账.md` 原先记着「槽 8 的两个
 * 子事件顺序连着演」——当时 `0x8D` 没解出来，就猜它们是接上的。
 * 现在看：中间那个 `end` 不是「接着演」，**是等玩家在标题画面上选**。
 * 用户描述的原作流程与数据逐条吻合。
 *
 * ## 素材（`MenusDir.DAT`）
 *
 * | 键 | 是什么 |
 * |---|---|
 * | `MEN9300` | 标题背景 640×480（双蛇 + 标题 + 版权行），1 帧 |
 * | `MEN9301/9302/9303` | 新章初始 / 前歷再續 / 返回太虛，**各 32 帧浮现动画** |
 * | `MEN8004` | 卷轴光标 36×24，6 帧 |
 *
 * 选项是**动画不是静态图**，这一点本身就说明原作进标题时三行是渐渐显出来的。
 *
 * ## ⚠️ 选项坐标是量出来的，不是解出来的
 *
 * 三个选项素材的原作图层坐标都是 **(-74,-19)** —— 相对某个基准点的负偏移，
 * 基准点由 exe 代码算，拿不到（阵形页的 `MEN7002/7004` 也是这样，
 * 16 张高亮图全挂在同一个坐标上）。所以 {@link TITLE} 里那几个数是
 * **照用户提供的原作截图量的**，见 `docs/状态/复现度台账.md`。
 */


export default class TitleScene extends Phaser.Scene {
  constructor() {
    super('Title');
  }

  create() {
    centerLegacyScene(this);
    mountLanguageChoice(this);
    mountHdChoice(this);
    mountPatchChoices(this);
    this.saveFolderChoice = mountSaveFolderChoice(this, async () => {
      if (this.mode === 'load') this.paintSlots(await loadAllSlots());
    });
    this.cameras.main.setBackgroundColor('#000000');
    this.mode = 'title';
    this.input.mouse?.disableContextMenu();
    this.input.on('pointerdown', p => this.pointerChoose(p));
    this.input.on('pointermove', p => this.pointerTitle(p));
    this.index = 0;
    this.options = [];
    this.chosen = false;
    // 片头看过一次之后（比如选了「返回太虛」转回来），不再从头播 ——
    // 原作退出是真的退出，我们只能回到这里，再看一遍三分钟片头太难受。
    if (this.registry.get('sawOpeningMovie')) this.showTitle();
    else this.playIntro();
  }

  /**
   * 片头影片。**右键与空格都能跳过** —— 原作是右键，本项目其余操作全是键盘。
   *
   * 走的是 `MP0000` 槽 8 子事件 0 那条 `play_movie 1` ——「漢堂國際 logo ＋
   * 沙漠长片头」**连着放完**，才出标题。这里不跑脚本执行器（那需要一整个
   * `FieldScene`），直接放同一个影片文件。
   */
  playIntro() {
    this.registry.set('sawOpeningMovie', true);
    const parent = this.game.canvas.parentElement ?? document.body;
    if (getComputedStyle(parent).position === 'static') parent.style.position = 'relative';

    const video = document.createElement('video');
    video.src = `assets/movies/mov${TITLE.introMovie}.mp4`;
    Object.assign(video.style, {
      position: 'absolute', left: '0', top: '0', width: '100%', height: '100%',
      objectFit: 'contain', background: '#000', zIndex: '50',
    });
    video.playsInline = true;

    let done = false;
    const cleanup = () => {
      if (done) return false;
      done = true;
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('contextmenu', onRight, true);
      window.removeEventListener('mousedown', onRight, true);
      video.pause();
      video.remove();
      this.events.off('shutdown', cleanup);
      return true;
    };
    this.events.once('shutdown', cleanup);
    const finish = () => {
      if (!cleanup()) return;
      // ⚠️ **手动解锁音频。** 浏览器要有一次用户手势才让声音出来，
      // Phaser 的 SoundManager 自己在 window 上挂了 keydown/click 监听来解锁 ——
      // 可我们跳过片头的那几个监听是**捕获阶段 + `stopPropagation`**，
      // 把那次按键截胡了。后果：进标题**没有音乐**，非得再按一下方向键
      // （那次按键没被截）才响。
      this.sound?.unlock?.();
      this.showTitle();
    };
    const onKey = (ev) => {
      if (!TITLE.skipKeys.includes(ev.code)) return;
      ev.preventDefault();
      ev.stopPropagation();
      finish();
    };
    // 原作用右键跳过。`contextmenu` 要挡掉，否则弹出浏览器菜单。
    const onRight = (ev) => {
      if (ev.type === 'mousedown' && ev.button !== 2) return;
      ev.preventDefault();
      ev.stopPropagation();
      finish();
    };
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('contextmenu', onRight, true);
    window.addEventListener('mousedown', onRight, true);

    video.addEventListener('ended', finish);
    video.addEventListener('error', () => {
      console.warn(`片头影片放不了：${video.src}（跑 tools/export_movies.py 转码）`);
      finish();
    });
    parent.appendChild(video);
    video.play?.().catch((err) => {
      console.warn(`片头自动播放被拦下（${err?.name}），直接进标题`);
      finish();
    });
  }

  /**
   * 标题画面本体：背景 + 三个选项。**没有光标**。
   *
   * ⚠️ **那 32 帧是「选中」动画，不是「浮现」动画。**
   * 每帧两层：`add` 那层是金字（33 层里恒为 `img 0`，逐帧不变），
   * 变的是 `multiply` 那层 ——
   *
   * | 帧 | multiply 层平均亮度 | 最暗像素 | 效果 |
   * |---|---|---|---|
   * | 0 | **246**（近白） | 206 | 正片叠底几乎不改背景 = **没有框** |
   * | 8~31 | 207 | **0**（纯黑） | = **黑框** |
   *
   * 所以：**未选中停在帧 0，选中播到帧 31**。三行一起播完是错的 ——
   * 那样三个都带框，看不出选的是哪个。
   *
   * ⚠️ 我一度还加了个 `MEN8004` 卷轴当光标挂在右边 —— **那是画蛇添足**。
   * 用户截图里「新章初始」右边那个东西是**鼠标指针**，不是游戏元素；
   * 原作的选中标记就是这圈黑框，素材里本来就带着。
   */
  showTitle() {
    this.input.keyboard.on('keydown-F', e => { if (!e.repeat) this.saveFolderChoice.choose(); });
    // 标题的曲子（`fight/Audio/Mp3/Music000.mp3`，见 `config.TITLE.bgmFile`）。
    // **读档页也接着放** —— 读档页是标题的一层，原作在那儿并没有换曲。
    this.sound?.unlock?.();
    playBgm(this, TITLE.bgmKey);

    this.add.image(0, 0, `menu-${TITLE.background}`, 'img_000')
      .setOrigin(0, 0).setDepth(0);

    TITLE.options.forEach((key, i) => {
      const y = TITLE.firstY + i * TITLE.gapY;
      // `draw` 传 0 —— 默认的 (-320,-260) 是地图精灵的绘制偏移，这里不适用。
      const sprite = new FieldSprite(this, `menu-${key}`, TITLE.centerX, y, { x: 0, y: 0 }, true);
      sprite.hold(0);                       // 一律先摆成「没框」
      this.options.push({ key, sprite, y });
    });
    this.highlight();

    this.input.keyboard.on('keydown-UP', () => this.move(-1));
    this.input.keyboard.on('keydown-DOWN', () => this.move(1));
    for (const code of TITLE.confirmKeys) {
      this.input.keyboard.on(`keydown-${code}`, () => this.choose());
    }
  }

  pointerTitle(rawPointer) {
    if (this.mode !== 'title' || this.chosen) return -1;
    const pointer = uiPointer(rawPointer);
    // 纵向不用帧框：每帧都是锚点上 19、下 50（高 69），行距只有 40，相邻两项重叠 29 像素，
    // 从上往下找会让下一项的上半段一直算上一项（用户 2026-10-01 报）。改按文字中心 ± 半个行距。
    const index = this.options.findIndex(opt => {
      const f = opt.sprite.data.frames[opt.sprite.frameIndex];
      return f && pointer.x >= TITLE.centerX+f.ox && pointer.x < TITLE.centerX+f.ox+f.w
        && Math.abs(pointer.y - (opt.y + TITLE.textCenterY)) < TITLE.gapY / 2;
    });
    if (index >= 0 && index !== this.index) { this.index = index; this.highlight(); }
    return index;
  }

  pointerChoose(pointer) {
    if (pointer.rightButtonDown()) { if (this.mode === 'load') this.backToTitle(); return; }
    if (!pointer.leftButtonDown()) return;
    if (this.mode === 'title') { if (this.pointerTitle(pointer) >= 0) this.choose(); return; }
    if (this.mode !== 'load' || this.chosen || !this.slotRecords) return;
    const t = this.cache.json.get(MENU_SPEC_KEY).tianshu;
    const ui = uiPointer(pointer);
    const row = Math.floor((ui.y-t.row.y0)/t.row.step);
    if (ui.x < t.row.x || ui.x > 620 || row < 0 || row >= t.rows) return;
    this.ts = { ...this.ts, cursor: this.ts.scroll+row };
    this.renderSlots();
    this.loadPicked();
  }

  move(delta) {
    if (this.chosen) return;
    this.index = (this.index + delta + this.options.length) % this.options.length;
    this.highlight();
  }

  /** 选中的那一行播出黑框，其余退回没框的帧 0。 */
  highlight() {
    this.options.forEach((opt, i) => {
      if (!opt.sprite) return;
      if (i === this.index) opt.sprite.playSegment(0, opt.sprite.frameCount, { loop: false });
      else { opt.sprite.playSegment(0, 1, { loop: false }); opt.sprite.hold(0); }
    });
  }

  choose() {
    if (this.chosen) return;
    this.chosen = true;
    const pick = this.options[this.index]?.key;
    if (pick === TITLE.options[0]) this.newGame();
    else if (pick === TITLE.options[1]) this.loadGame();
    else this.quit();
  }

  /**
   * 新章初始 —— 接 `MP0000` 槽 8 的**子事件 1**（梦境影片 → 起床）。
   *
   * ⚠️ 子事件 0 的长片头已经由 `playIntro` 在标题**之前**整条放过了
   * （漢堂國際 logo 与沙漠连着放，放完才出标题），不能再放一遍。
   */
  newGame() {
    stopBgm(this);
    this.enterGame(newGameEntry(this));
  }

  /**
   * 进游戏：只加载要去的那张图（开机素材 Boot 早已载完）。
   *
   * ⚠️ 以前这里重新启动 `Boot` —— 它把开机那批文件整轮再排一遍（标题图集、字体
   * 描述会重新下载），进度走到 100% 后才开始载地图，地图又分三轮、进度从 0% 重来：
   * 用户看到的就是「新章初始/前历再续」两遍 loading（2026-09-27）。
   * 现在与游戏里读档、切图同一条路：黑屏加载，超过 GAME_ENTRY_HINT_MS 才显示一行字。
   */
  async enterGame(entry) {
    // 防倒卖验证：真正进游戏前的强拦截（D3，enterGame 挂点）。
    // 宽限（未联网）时放行但存/读档被 gateGuard 拦下（D11 B）；
    // 密钥无效/已锁定则停留标题页并已提示，可再次点击重试。
    if (this._entering) return;
    this._entering = true;
    try {
      const auth = await gateCheck('enter', this).catch(() => ({ ok: false }));
      if (!auth.ok) return;
      this.scene.start('Loading', { ...entry, text: '载入中…', hintDelayMs: GAME_ENTRY_HINT_MS });
    } finally {
      this._entering = false;
    }
  }

  /**
   * 前歷再續 —— 读档。**整个过程留在标题这一侧，不进游戏。**
   *
   * ⚠️ 先前的做法是「先进游戏、再打开天书页」，于是选完会**闪一下卧室、
   * 还响起卧室的 BGM** —— 原作读档时画面上什么都没有。
   * 读进来的存档自己带地图与落点，进游戏时直接落到那儿。
   */
  loadGame() {
    this.chosen = false;                    // 读档页可以按 ESC 退回来
    for (const opt of this.options) opt.sprite?.destroy?.();
    this.options = [];
    this.input.keyboard.removeAllListeners();
    this.showLoadPage();
  }

  /** 读档页：`MEN9304` 底图 + 存档条 + 每格的摘要。 */
  showLoadPage() {
    this.input.keyboard.on('keydown-F', e => { if (!e.repeat) this.saveFolderChoice.choose(); });
    this.mode = 'load';
    // ⚠️ **导航与天书页共用同一个状态机**（`ui/tianshu.js`）——
    // 此前这里另写了一套 `moveSlot`，于是天书页有的翻页这儿没有。
    // 用户原话：「这块能不能直接复用天书的代码呀？为什么要整个重新做一套？」
    this.ts = TS.createState();
    this.slotParts = [];
    this.add.image(0, 0, `menu-${TITLE.loadPage}`, 'img_002')
      .setOrigin(0, 0).setDepth(100);

    // ⚠️ **操作提示用系统字，不用原作点阵字库。**
    // 字库按 **Big5 码位**索引（`yc24s` 只是把字形画成简体，id 仍是繁体
    // 码位；实测 13419 个 id 里有 `選讀鍵單檔`、没有 `选读键单档`），
    // 喂简体进去是**静默丢字** —— 「↑↓ 选　空格 读取」画出来是「空格 取」。
    // 而 `↑↓` 这种符号两边都没有。这行提示是我们自己加的、原作没有对应美术，
    // 与 `FieldScene` 的 HUD 走同一套系统字即可。见 `docs/专题/简繁体.md`。
    this.slotHint = this.add.text(STAGE_WIDTH / 2, TITLE.hintY, '读取中…', {
      fontFamily: 'serif', fontSize: '15px', color: '#e8d9b0',
      stroke: '#000', strokeThickness: 3,
    }).setOrigin(0.5, 0.5).setDepth(140);

    loadAllSlots()
      .then((records) => this.paintSlots(records))
      .catch((err) => {
        console.warn('读不出存档列表：', err?.message ?? err);
        this.slotHint.setText(backHint() === 'ESC' ? '存档读不出来  ESC 返回' : '存档读不出来，按「返回」回标题');
      });

    this.input.keyboard.on('keydown-UP', () => this.moveSlot(-1));
    this.input.keyboard.on('keydown-DOWN', () => this.moveSlot(1));
    // 按住不放连续滚 —— 每帧在 `update` 里推，见 `ui/holdScroll.js`。
    // ⚠️ **不要用 PgUp/PgDn**：Mac 键盘上压根没这两个键。翻页走箭头。
    this.holdKeys = {
      up: this.input.keyboard.addKey(Phaser.Input.Keyboard.KeyCodes.UP),
      down: this.input.keyboard.addKey(Phaser.Input.Keyboard.KeyCodes.DOWN),
    };
    this.hold = createHold();
    this.input.keyboard.on('keydown-ESC', () => this.backToTitle());
    for (const code of TITLE.confirmKeys) {
      this.input.keyboard.on(`keydown-${code}`, () => this.loadPicked());
    }
  }

  /**
   * 把存档摘要画成一行行。
   *
   * ⚠️ **值要填进条上模板的空格里，不能另起一行自己排。**
   * 记录条 `MEN9304` 的第 0 帧印着「地點/ 　等級/ ／ 日期/ 年 月 日 時間/ ：」，
   * 那些标签是**画进美术里的 15px 字**（原作只发一个 `font24.fnt`，
   * 没有小号字库）。从前是在条上另画两行 24px 简体字，于是两套字叠在一起 ——
   * 用户说的「字体明显有问题」就是这个。
   *
   * 现在照天书页那一套（`ui/MenuScreen.drawSlotText`）：
   * * **地名**用 24px 字库，落在「地點/」右边（row-local 254,27）
   * * **数字**用 `MEN1018`（15×14 的字形表），与条上 15px 的标签美术字同高
   *
   * 落位来自 `menus.json` 的 `tianshu.slots`，只有等级要挪 30px，
   * 判据见 `config.TITLE.slotLevelX`。
   */
  paintSlots(records) {
    const layout = this.cache.json.get(LAYOUT_KEY);
    // ⚠️ **按槽号建表，不要把空槽过滤掉。** 天书页列的是 99 个槽、
    // 空的画成「未記錄」，这一页也该一样 —— 过滤之后两页的行为就对不上了
    // （同一个槽在两页里的位置不同，↑↓ 的落点也不同）。
    this.slotSummaries = new Map();
    this.slotRecords = new Map();
    for (const rec of records ?? []) {
      const info = slotSummary(rec, layout);
      if (!info) continue;
      this.slotSummaries.set(info.slot, info);
      this.slotRecords.set(info.slot, rec);
    }
    this.ts = TS.createState();
    this.slotHint.setText('');
    this.renderSlots();
  }

  /**
   * 一屏四条。**空位也要画成「未記錄」**，原作那一页不会露出底图。
   *
   * 条怎么画走 `ui/slotRows.js` —— **和天书页同一份**。这一页只是
   * 换了底图（`MEN9304` 与 `MEN8001` 同构）、不印槽位编号、等级往右挪一点。
   */
  renderSlots() {
    this.slotParts?.forEach((o) => o.destroy());
    this.slotParts = [];
    this.slotBox?.destroy();
    this.slotBox = this.add.container(0, 0).setDepth(110);

    const spec = this.cache.json.get(MENU_SPEC_KEY);
    if (!spec) return;
    drawSlotRows(
      { scene: this, container: this.slotBox, parts: this.slotParts },
      spec, this.slotStyle(spec),
      TS.visibleRows(this.ts, this.slotSummaries ?? new Map(), TITLE.slotsPerPage),
    );
    this.drawArrows(spec);
  }

  /**
   * 上下两个**可点的翻页箭头** —— 素材与做法都照天书页
   * （`menus.json` 的 `tianshu.arrows`：`MEN8004` 上 / `MEN8005` 下）。
   *
   * ⚠️ **翻不动的时候画成暗的**（`arrowFrame`），与天书页同一套 ——
   * 画出来却点不了比没画还误导人。
   *
   * 与天书共用落位和逐帧图层偏移，不把动画帧号误当纹理页号。
   */
  drawArrows(spec) {
    this.arrowHits?.forEach((z) => z.destroy());
    this.arrowHits = [];
    this.arrowImgs = [];
    for (const a of spec.tianshu?.arrows ?? []) {
      const dir = a.role === 'arrow_up' ? -1 : 1;
      const first = this.arrowLayer(spec, a, dir);
      if (!first) continue;
      const tex = this.textures.get(textureKey(a.asset));
      const frame = tex?.get(first.img);
      if (!frame?.width || !frame?.height) {
        // 兜底跳过要出声（判据表）：点不动的箭头和能点的长得一模一样。
        console.warn(`⚠ 读档页箭头 ${a.asset} 取不到尺寸，翻页点不了`);
        continue;
      }
      const img = this.add.image(first.x, first.y, textureKey(a.asset),
                                 first.img)
        .setOrigin(0, 0);
      this.slotBox.add(img);
      this.arrowImgs.push({ img, arrow: a, dir });
      const zone = this.add.zone(first.x, first.y, frame.width, frame.height)
        .setOrigin(0, 0).setDepth(120).setInteractive({ useHandCursor: true });
      zone.on('pointerdown', (p,x,y,event) => {
        if (!p.leftButtonDown()) return;
        event.stopPropagation();
        this.pageSlot(dir);
      });
      this.arrowHits.push(zone);
    }
  }

  /**
   * 这一页的记录条长什么样。形状同 `menus.json` 的 `tianshu`，**只改三处**：
   *
   * | | 天书页 | 这一页 |
   * |---|---|---|
   * | 条底图 | `MEN8001` | `MEN9304`（帧 0 有记录 / 帧 1 未記錄） |
   * | 槽位编号 | `MEN1019` | **不印**（这一页的美术上没有那一格） |
   * | 等级 x | 508 | `TITLE.slotLevelX`（条上标签位置不同） |
   *
   * 头像与其余字段的落位直接借天书那份 —— 两张条本来就是同构的。
   */
  slotStyle(spec) {
    const t = spec.tianshu ?? {};
    return {
      row: {
        // ⚠️ **帧标识两边不一样**：天书的 `MEN8001` 是 spritesheet（数字帧号），
        // 这一页的 `MEN9304` 是独立图集（帧名 `img_00N`）。两种都直接交给
        // Phaser，`slotRows` 不去猜。
        asset: TITLE.loadPage, img: 'img_000', emptyImg: 'img_001',
        x: t.row.x, y0: t.row.y0, step: t.row.step,
        alpha: TITLE.slotDimAlpha,
      },
      face: t.face,
      index: null,
      slots: t.slots && { ...t.slots, 等级: { ...t.slots.等级, x: TITLE.slotLevelX } },
    };
  }

  /** ↑↓ 走一条。**与天书页同一条路**，状态只有一份。 */
  moveSlot(step) {
    this.ts = TS.navigate(this.ts, step, SLOT_COUNT, TITLE.slotsPerPage);
    this.renderSlots();
  }

  /** 箭头翻一屏。**与天书页同一条路**（`TS.pageBy`，步长 ±rows）。 */
  pageSlot(step) {
    this.ts = TS.pageBy(this.ts, step * TITLE.slotsPerPage, SLOT_COUNT, TITLE.slotsPerPage);
    this.renderSlots();
  }

  /** 这个方向还翻得动吗 —— 翻不动的箭头画成暗的，与天书页同一套。 */
  canPage(dir) {
    const top = this.ts?.scroll ?? 0;
    return dir < 0 ? top > 0 : top + TITLE.slotsPerPage < SLOT_COUNT;
  }

  /** 读进选中的那一格 —— 存档自己带地图与落点。 */
  loadPicked() {
    const pick = this.slotRecords?.get(this.ts?.cursor);
    if (!pick) return;
    const bytes = pick.bytes instanceof Uint8Array
      ? pick.bytes : new Uint8Array(pick.bytes);
    let where = null;
    try {
      where = applySaveBytes(this, bytes);
    } catch (err) {
      console.warn('读档失败：', err?.message ?? err);
      this.slotHint.setText(`读档失败：${err?.message ?? err}`);
      return;
    }
    if (!where?.mapId) { this.slotHint.setText('这个存档里没有地图'); return; }
    // 事件表的来源随槽位一起存着（`saveslot.saveSlot` 的附带数据）。
    // 没有它，读档落在那 13 张没有 `.EVE` 的图上就出不去。
    this.registry.set('scriptSourceHint', pick.附带?.scriptSource ?? null);
    stopBgm(this);
    this.enterGame({ mapId: where.mapId, entry: where.entry });
  }

  backToTitle() {
    this.input.keyboard.removeAllListeners();
    this.scene.restart();
  }

  /**
   * 返回太虛 —— 原作是退出游戏。
   *
   * 桌面版照原作关闭应用（用户 2026-10-01）。浏览器里 `window.close()` 基本会被拦，
   * 所以网页版**回到片头影片重来**（D-08，用户拍板）。这一条最接近「退出之后再打开」。
   */
  quit() {
    stopBgm(this);
    const desktopQuit = typeof window !== 'undefined' ? window.ycDesktop?.app?.quit : null;
    if (desktopQuit) {
      this.cameras.main.fadeOut(TITLE.quitFadeMs);
      this.cameras.main.once('camerafadeoutcomplete', () => desktopQuit());
      return;
    }
    this.registry.set('sawOpeningMovie', false);
    this.cameras.main.fadeOut(TITLE.quitFadeMs);
    this.cameras.main.once('camerafadeoutcomplete', () => this.scene.restart());
  }

  /** `FieldSprite` 不自走，每帧推一次；读档页还要推「按住连滚」。 */
  update(time, delta) {
    for (const opt of this.options) opt.sprite?.update?.(time, delta);
    if (this.mode !== 'load' || !this.holdKeys) return;
    const dir = heldDirection(this.holdKeys.up, this.holdKeys.down);
    const got = holdSteps(this.hold, dir, time);
    this.hold = got.state;
    for (let i = 0; i < got.steps; i += 1) this.moveSlot(dir);
    // 箭头要跟着「还翻不翻得动」闪 —— 与天书页的 `tickArrows` 同一个意思。
    if (!got.steps && this.slotBox) this.refreshArrows();
  }

  /** 使用天书相同的动画帧→图层映射；六帧只有一张图，变化的是偏移。 */
  arrowLayer(spec, arrow, dir) {
    return layersOf(spec, arrow.asset,
      arrowFrame(spec, arrow.asset, this.canPage(dir), this.time.now), arrow.x, arrow.y)[0];
  }

  refreshArrows() {
    const spec = this.cache.json.get(MENU_SPEC_KEY);
    if (!spec) return;
    (this.arrowImgs ?? []).forEach(({ img, arrow, dir }) => {
      const layer = this.arrowLayer(spec, arrow, dir);
      if (layer) img.setFrame(layer.img).setPosition(layer.x, layer.y);
    });
  }

  /** 这一页要哪些素材。`BootScene` 预载它们，键名与这里一致。 */
  static get assetKeys() {
    return [TITLE.background, ...TITLE.options];
  }
}

export { SHARED_EVENT_MAP };
