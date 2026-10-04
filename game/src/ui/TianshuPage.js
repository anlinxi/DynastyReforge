import { layersOf, textureKey } from './menuSpec.js';
import { drawSlotRows } from './slotRows.js';
import { arrowFrame } from './listArrows.js';
import * as TS from './tianshu.js';
import { SLOT_COUNT, slotSummary } from '../systems/saveslot.js';

/**
 * 天书（存读档）页的控制器：状态、画面、热区、按键都在这里，菜单本体只转发。
 *
 * 交互是从素材解出来的（见 `ui/tianshu.js`）：选一条记录 → `MEN8002` 三选项
 * （今況記錄／前歷再續／取消）→ 再确认一次。
 *
 * 借用菜单的只有画图/挂热区的底层手段（`drawTile`/`drawElement`/`addZone`/`render`）、
 * 当前页签与时钟，以及场景挂在菜单上的回调（`onSave`/`onLoad`/`onExport`/`onImport`/
 * `onPickFolder`/`saveRestriction`/`saveNotice`）—— 场景照旧挂在菜单上，这里经 `menu` 取。
 * （2026-10-04 从 MenuScreen 拆出，QA-04；行为不变。）
 */
export class TianshuPage {
  /** @param {import('./MenuScreen.js').default} menu */
  constructor(menu) {
    this.menu = menu;
    /** 状态机的当前状态，见 `ui/tianshu.js`。 */
    this.state = TS.createState();
    /** 槽号 → 存档摘要。由 `refreshSlots()` 从存储灌进来。 */
    this.slotSummaries = new Map();
  }

  get rows() {
    return this.menu.spec?.tianshu?.rows ?? 4;
  }

  /** 每次打开天书页都从头来（光标回第一条、没有框）。 */
  reset() {
    this.state = TS.createState();
  }

  /** 开着三选项/确认/读取中的框？开着时整页输入归框。 */
  get hasDialog() {
    return Boolean(this.state?.dialog);
  }

  /** 四条记录的翻页能力。共 `SLOT_COUNT` 个槽。 */
  canPage(dir) {
    const top = this.state?.scroll ?? 0;
    return dir < 0 ? top > 0 : top + this.rows < SLOT_COUNT;
  }

  /** ↑↓：在 99 条记录之间走，开着框时归框（`TS.navigate` 自己分）。 */
  navigate(step) {
    this.state = TS.navigate(this.state, step, SLOT_COUNT, this.rows);
    this.menu.queueRender();
  }

  /** 开着框时退一层；返回 true 表示这一下被框吃掉了。 */
  back() {
    if (!this.hasDialog) return false;
    const back = TS.back(this.state);
    if (back) { this.state = back; this.menu.queueRender(); }
    return true;
  }

  /** 翻一屏。走的就是键盘那条路（`TS.navigate`），状态只有一份。 */
  pageBy(step) {
    if (this.hasDialog) return;      // 开着确认框时不翻页
    this.state = TS.pageBy(this.state, step, SLOT_COUNT, this.rows);
    this.menu.queueRender();
  }

  /**
   * 天书（存档）页。不走共用外壳：没有立绘、姓名、金钱框，四条记录循环画。
   *
   * 记录条 `MEN8001` 有两帧：**第 0 帧是有记录的**（印着「地點/ 等級/
   * 日期/ 年 月 日 時間/ ：」），**第 1 帧是「未記錄」**（空槽）。
   * 值填在标签之间的空档里，落点见 `menus.json` 的 `tianshu.slots`。
   */
  draw() {
    const menu = this.menu;
    const t = menu.spec.tianshu;
    if (!t) return;
    menu.drawTile(t.background.asset, t.background.img, 0, 0);
    menu.drawElement(t.tabbar.asset, menu.tab, t.tabbar.x, t.tabbar.y);
    // 与别的页同一套：能翻才跳。见 `ui/listArrows.js`。
    t.arrows.forEach((a) => {
      const dir = a.role === 'arrow_up' ? -1 : 1;
      menu.drawElement(a.asset, arrowFrame(menu.spec, a.asset,
                                           this.canPage(dir), menu.clock), a.x, a.y);
    });

    // 记录条怎么画在 `ui/slotRows.js` —— **标题读档页用的是同一份**。
    drawSlotRows({ scene: menu.scene, container: menu.container, parts: menu.parts },
                 menu.spec, t, TS.visibleRows(this.state, this.slotSummaries, t.rows));
    this.drawDialog(t);
    const restriction = menu.saveRestriction?.() || menu.saveNotice?.();
    if (restriction) {
      const bg = menu.scene.add.rectangle(320, 459, 640, 32, 0x18100b, 0.95).setScrollFactor(0);
      // 平台保存提示使用清晰的单层字，不把纸面复合字染成浅色放到黑底上。
      const label = menu.scene.add.text(320, 459, restriction, {
        fontFamily: 'sans-serif', fontSize: '17px', color: '#f0d5ac',
      }).setOrigin(0.5).setScrollFactor(0);
      menu.container.add([bg, label]); menu.parts.push(bg, label);
    }
  }

  /** 三选项框 / 确认框 / 「讀取中」。**帧号就是焦点**，见 `ui/tianshu.js`。 */
  drawDialog(t) {
    const d = this.state.dialog;
    if (!d) return;
    const box = {
      [TS.STAGE.MENU]: t.menu,
      [TS.STAGE.CONFIRM_SAVE]: t.confirmSave,
      [TS.STAGE.CONFIRM_LOAD]: t.confirmLoad,
      [TS.STAGE.BUSY]: t.busy,
    }[d.stage];
    if (!box) { console.warn(`menus.json 的 tianshu 缺 ${d.stage}，框画不出来`); return; }
    // 「讀取中」那一帧的层偏移是 SF2 自带的（压暗横幅 + 小框），整帧画在 (0,0)。
    // ⚠️ **其余三个框的帧号与屏幕顺序是反的**（帧 0 是最下面那项），
    // 所以 `pick`（屏幕下标）要经 `frameOf` 换算，见 `ui/tianshu.js` 文件头。
    const frame = d.stage === TS.STAGE.BUSY
      ? box.frame
      : TS.frameOf(TS.itemCount(d.stage), d.pick);
    this.menu.drawElement(box.asset, frame, box.x, box.y);
  }

  /** 记录条（或开着的框里各项）的点击区。 */
  buildHits() {
    const menu = this.menu;
    const t = menu.spec.tianshu;
    const dialog = this.state.dialog;
    if (dialog) {
      if (dialog.stage === TS.STAGE.BUSY) return;
      const box = t[dialog.stage];
      const [w,h] = menu.spec.assets[box.asset].cell;
      const n = TS.itemCount(dialog.stage);
      const pitch = (h - 24) / n;
      for (let pick = 0; pick < n; pick++) {
        menu.addZone({ x: box.x+8, y: box.y+12+pick*pitch, w: w-16, h: pitch }, null, () => {
          this.state = { ...this.state, dialog: { ...dialog, pick } };
          this.confirm();
        });
      }
      return;
    }
    const [w,h] = menu.spec.assets[t.row.asset].sizes[0];
    for (let row = 0; row < t.rows; row++) {
      menu.addZone({ x: t.row.x, y: t.row.y0+row*t.row.step, w, h }, null, () => {
        this.state = { ...this.state, cursor: this.state.scroll+row };
        this.confirm();
      });
    }
  }

  /** 上下箭头的点击区。 */
  buildArrowHits() {
    const menu = this.menu;
    const t = menu.spec?.tianshu;
    for (const a of t?.arrows ?? []) {
      const first = layersOf(menu.spec, a.asset, 0, a.x, a.y)[0];
      if (!first) continue;
      const frame = menu.scene.textures.get(textureKey(a.asset))?.get(first.img);
      const w = frame?.width;
      const h = frame?.height;
      if (!w || !h) {
        // 兜底跳过要出声（判据表）：点不动的箭头在画面上跟能点的一模一样。
        console.warn(`⚠ 天书页箭头 ${a.asset} 取不到尺寸，翻页点不了`);
        continue;
      }
      const step = a.role === 'arrow_up' ? -this.rows : this.rows;
      menu.addZone({ x: first.x, y: first.y, w, h }, null, () => this.pageBy(step));
    }
  }

  /** 天书页的回车。派出去的 `save` / `load` 交给场景做。 */
  confirm() {
    const menu = this.menu;
    const occupied = this.slotSummaries.has(this.state.cursor);
    const { state, action } = TS.confirm(this.state, { occupied });
    this.state = state;
    menu.render();
    if (!action) return;
    const slot = this.state.cursor;
    const fn = action === 'save' ? menu.onSave : menu.onLoad;
    if (!fn) {
      // ⚠️ 没挂回调不能静默 —— 表现会是「按了確定什么都没发生」。
      console.warn(`天书页没有挂 ${action} 回调，${action === 'save' ? '存档' : '读档'}做不了`);
      this.state = TS.done(this.state);
      menu.render();
      return;
    }
    Promise.resolve(fn(slot))
      .catch((err) => console.warn(`${action} 失败：`, err?.message ?? err))
      .then(() => { this.state = TS.done(this.state); menu.render(); });
  }

  /** 把当前槽导成 `.TSF` 文件。空槽不导。 */
  exportSlot() {
    if (this.hasDialog) return;                    // 开着框时不抢按键
    const slot = this.state.cursor;
    if (!this.slotSummaries.has(slot)) return;
    Promise.resolve(this.menu.onExport?.(slot))
      .catch((err) => console.warn('导出失败：', err?.message ?? err));
  }

  /** 从 `.TSF` 文件导入到当前槽。 */
  importSlot() {
    if (this.hasDialog) return;
    Promise.resolve(this.menu.onImport?.(this.state.cursor))
      .catch((err) => console.warn('导入失败：', err?.message ?? err));
  }

  /**
   * 选一个本地文件夹当存档位置。**原作没有这个功能**，
   * 它解决的是「浏览器缓存一清存档全没」。见 `systems/saveStore.js`。
   *
   * ⭐ 可以直接选**原作的 `Save/` 目录** —— 我们的存档是纯 `.TSF`、
   * 与原作字节级通用，选中之后两边的档互相看得见。
   */
  pickFolder() {
    if (this.hasDialog) return;
    Promise.resolve(this.menu.onPickFolder?.())
      .catch((err) => console.warn('选存档文件夹失败：', err?.message ?? err));
  }

  /** 把槽位摘要拉回来，然后重画。 */
  refreshSlots(records) {
    const layout = this.menu.scene.cache.json.get('tsfLayout');
    this.slotSummaries = new Map();
    if (!layout) return;
    for (const rec of records ?? []) {
      const summary = slotSummary(rec, layout);
      if (summary) this.slotSummaries.set(rec.slot, summary);
    }
    if (this.menu.visible) this.menu.render();
  }
}
