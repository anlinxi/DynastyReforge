/** 官方客房与炼化；复用菜单图层、目录、库存和数字字形，配方只读导出数据。 */
import { MENU_SPEC_KEY, layersOf, tabHitAreas, textureKey } from './menuSpec.js';
import { menuFont } from './nativeText.js';
import { paintNumber } from './glyphNumber.js';
import { arrowFrame } from './listArrows.js';
import { wrapText } from './listLayout.js';
import { CATEGORIES, displayName } from '../systems/catalog.js';
import { itemsInCategory } from '../systems/inventory.js';
import { ensureArtwork } from '../systems/loader.js';
import { refineResult, refineInventory, restParty } from '../systems/refining.js';
import DEPTH from '../systems/depths.js';
import { noXbr } from '../hd/hdRender.js';

export default class InnScreen {
  constructor(scene, catalog) {
    this.scene = scene;
    this.catalog = catalog;
    this.spec = scene.cache.json.get(MENU_SPEC_KEY);
    this.data = scene.cache.json.get('refining');
    this.container = scene.add.container(0, 0).setScrollFactor(0).setDepth(DEPTH.INN).setVisible(false);
    this.visible = false;
    this.keys = event => this.key(event);
    this.keyEvents = ['UP','DOWN','LEFT','RIGHT','SPACE','ENTER','ESC'].map(k => `keydown-${k}`);
    for (const name of this.keyEvents) scene.input.keyboard.on(name, this.keys);
    scene.sys.events.once('shutdown', () => {
      for (const name of this.keyEvents) scene.input.keyboard.off(name, this.keys);
      this.disposeVideo();
    });
  }
  state() { return this.scene.registry.get('gameState'); }
  inventory() { return this.state().inventory; }
  rows(tab = this.tab) { return itemsInCategory(this.inventory(), CATEGORIES[tab], this.catalog); }
  current() { return this.rows()[this.index]; }
  open(room, onClose) {
    this.room = room;
    this.onClose = onClose;
    this.choice = 0;
    this.stage = 'room';
    this.visible = true;
    this.armed = false;
    this.scene.time.delayedCall(0, () => { this.armed = true; });
    this.curtainVisible = this.scene.curtain?.visible;
    this.scene.curtain?.setVisible(false);
    // 原入住脚本先fade_out再enter_room；相机淡出会盖住包括客房在内的全部UI。
    const fade = this.scene.cameras.main.fadeEffect;
    this.fieldWasFaded = fade.alpha > 0;
    fade.reset();
    this.container.setVisible(true);
    // 预载影片，不在确认后临时寻找素材；失败不扣材料。
    this.video = document.createElement('video');
    this.video.preload = 'auto';
    this.video.playsInline = true;
    this.video.src = this.spec.refining.movie;
    this.video.load();
    this.render();
  }
  commit(patch) {
    const state = Object.freeze({ ...this.state(), ...patch });
    this.scene.registry.set('gameState', state);
    this.scene.party = state.party;
    this.scene.statusScreen.syncState(state.party, state.inventory);
  }
  close() {
    this.clickPending = null;
    this.visible = false;
    this.container.setVisible(false);
    if (this.fieldWasFaded) this.scene.cameras.main.fadeOut(0);
    if (this.curtainVisible) this.scene.curtain?.setVisible(true);
    this.disposeVideo();
    const done = this.onClose;
    this.onClose = null;
    done?.();
  }
  disposeVideo() {
    if (!this.video) return;
    this.video.onended = null;
    this.video.onerror = null;
    this.video.pause();
    this.video.remove();
    this.video.removeAttribute('src');
    this.video.load();
    this.video = null;
  }
  key(event) {
    if (!this.visible || !this.armed || this.clickPending || ['menu', 'movie'].includes(this.stage) || event.repeat) return;
    const key = event.code;
    if (['Space', 'Enter'].includes(key)) this.accept();
    else if (key === 'Escape') this.back();
    else if (['ArrowUp', 'ArrowDown'].includes(key)) {
      const delta = key === 'ArrowUp' ? -1 : 1;
      if (this.stage === 'room') this.choice = (this.choice + delta + 3) % 3;
      else if (this.stage === 'confirm') this.confirmChoice = 1 - this.confirmChoice;
      else this.index = Math.max(0, Math.min(this.rows().length - 1, this.index + delta));
      this.render();
    } else if (['ArrowLeft', 'ArrowRight'].includes(key) && ['first', 'second'].includes(this.stage)) {
      this.tab = (this.tab + (key === 'ArrowLeft' ? 1 : -1) + CATEGORIES.length) % CATEGORIES.length;
      this.index = 0;
      this.render();
    }
  }
  back() {
    this.clickPending = null;
    if (this.stage === 'confirm') this.stage = 'second';
    else if (this.stage === 'second') { this.stage = 'first'; this.tab = this.firstTab; this.index = this.firstCursor; }
    else if (this.stage === 'first') this.stage = 'room';
    this.render();
  }
  accept() {
    if (this.stage === 'room') {
      if (this.choice === 0) {
        this.stage = 'menu';
        this.container.setVisible(false);
        this.scene.statusScreen.toggle();
        return;
      }
      if (this.choice === 2) { this.commit({ party: restParty(this.state().party) }); this.close(); return; }
      this.stage = 'first'; this.tab = 5; this.index = 0;
      ensureArtwork(this.scene, () => this.visible && this.render());
    } else if (this.stage === 'first') {
      if (!this.current()) return;
      this.first = this.current(); this.firstTab = this.tab; this.firstCursor = this.index;
      this.stage = 'second'; this.index = 0;
    } else if (this.stage === 'second') {
      if (!this.current() || !refineResult(this.data, this.first.代码, this.current().代码)) return;
      this.second = this.current(); this.stage = 'confirm'; this.confirmChoice = 0;
    } else if (this.stage === 'confirm') {
      if (this.confirmChoice) { this.back(); return; }
      this.play(); return;
    }
    this.render();
  }
  play() {
    const inventory = this.inventory();
    const transaction = refineInventory(inventory, inventory.indexOf(this.first), inventory.indexOf(this.second), this.data);
    if (!transaction) { this.stage = 'second'; this.render(); return; }
    this.stage = 'movie';
    const video = this.video;
    const rect = this.scene.game.canvas.getBoundingClientRect();
    Object.assign(video.style, { position: 'fixed', left: `${rect.left}px`, top: `${rect.top}px`, width: `${rect.width}px`, height: `${rect.height}px`, zIndex: '50', background: 'black' });
    video.currentTime = 0;
    video.onended = () => {
      video.remove();
      video.onended = null;
      this.commit({ inventory: transaction.inventory });
      this.stage = 'first'; this.tab = 5;
      this.index = Math.max(0, this.rows().findIndex(row => row.代码 === transaction.result));
      this.render();
    };
    const failed = () => {
      console.error('炼化影片无法播放，材料未消耗', video.error);
      video.remove(); this.stage = 'second'; this.render();
    };
    video.onerror = failed;
    document.body.append(video);
    video.play().catch(failed);
  }
  image(asset, frame, x, y) {
    const images = layersOf(this.spec, asset, frame, x, y).map(layer =>
      this.scene.add.image(layer.x, layer.y, textureKey(asset), layer.img)
        .setOrigin(0).setScrollFactor(0).setBlendMode(layer.blend).setAlpha(layer.alpha));
    this.container.add(images);
    return images;
  }
  animatedImage(asset, frameAt, x, y) {
    const images = this.image(asset, frameAt(this.scene.time.now), x, y);
    this.animations.push({ asset, frameAt, x, y, images });
  }
  text(value, x, y, blocked = false) {
    this.container.add(noXbr(this.scene.add.bitmapText(x, y, menuFont(blocked ? 0x8c2f24 : undefined), value, 24).setScrollFactor(0)));
  }
  hit(x, y, width, height, fn) {
    this.container.add(this.scene.add.zone(x, y, width, height).setOrigin(0).setScrollFactor(0).setInteractive()
      .on('pointerdown', (p, x, y, event) => { if (!p.leftButtonDown()) return; event.stopPropagation(); if (this.stage !== 'movie') fn(); }));
  }
  chooseRow(index) {
    if (this.clickPending) return;
    const stage = this.stage;
    const tab = this.tab;
    this.index = index;
    this.render();
    const token = this.clickPending = {};
    this.scene.time.delayedCall(90, () => {
      if (this.clickPending !== token) return;
      this.clickPending = null;
      if (this.visible && this.stage === stage && this.tab === tab && this.index === index) this.accept();
    });
  }
  drawList(tab, cursor, right = false) {
    const cfg = this.spec.refining;
    const rows = this.rows(tab), page = Math.floor(cursor / cfg.rows), start = page * cfg.rows;
    const x = right ? cfg.right[0] : cfg.left[0];
    this.image('MEN9100', right ? 1 : 0, x, cfg.left[1]);
    for (let i = start; i < Math.min(rows.length, start + cfg.rows); i++) {
      const row = rows[i], y = cfg.rowY + (i - start) * cfg.step;
      const result = right ? refineResult(this.data, this.first.代码, row.代码) : null;
      if (i === cursor) {
        const asset = right ? 'MEN9101' : 'MEN4003';
        this.animatedImage(asset, time => Math.floor(time / 120) % this.spec.assets[asset].frames.length, x + 12, y);
      }
      this.text(displayName(this.catalog.物品(row.代码)), x + 24, y + 3, right && !result);
      paintNumber(this.scene, this.container, this.spec, 'MEN0028', row.数量, { x: right ? 342 : 190, y: y + 7, align: 'left' }, []);
      if (right && result) {
        this.image('MEN9100', 5, 425, y + 3);
        this.text(displayName(this.catalog.物品(result)), 453, y + 3);
      }
      if (this.stage !== 'confirm' && ((this.stage === 'first' && !right) || (this.stage === 'second' && right))) {
        this.hit(x + 10, y, right ? 387 : 192, cfg.step, () => { this.chooseRow(i); });
      }
    }
    const width = this.spec.assets.MEN9100.sizes[right ? 1 : 0][0];
    const arrowX = x + Math.floor((width - this.spec.assets.MEN4004.cell[0]) / 2);
    for (const [asset, y, live, step] of [['MEN4004', 60, start > 0, -cfg.rows], ['MEN4005', 343, start + cfg.rows < rows.length, cfg.rows]]) {
      this.animatedImage(asset, time => arrowFrame(this.spec, asset, live, time), arrowX, y);
      if (live && this.stage !== 'confirm' && (right || this.stage === 'first')) this.hit(arrowX, y, 36, 24, () => {
        this.index = Math.max(0, Math.min(rows.length - 1, cursor + step)); this.render();
      });
    }
  }
  render() {
    if (!this.visible || ['movie', 'menu'].includes(this.stage)) return;
    this.container.removeAll(true);
    this.animations = [];
    if (this.stage === 'room') {
      const cfg = this.spec.inn;
      this.image(cfg.room, this.room, 0, 0);
      this.image(cfg.menu, this.choice, cfg.x, cfg.y);
      for (let i = 0; i < 3; i++) this.hit(cfg.hitX, cfg.hitY + i * cfg.step, cfg.width, cfg.height, () => { this.choice = i; this.accept(); });
      return;
    }
    const cfg = this.spec.refining;
    this.image('MEN9100', 6, 0, 0);
    this.drawList(this.stage === 'first' ? this.tab : this.firstTab, this.stage === 'first' ? this.index : this.firstCursor);
    const right = this.stage !== 'first';
    if (right) this.drawList(this.tab, this.index, true);
    else {
      const row = this.current(), art = this.spec.artwork;
      if (row) {
        const code = parseInt(row.代码, 16), asset = art.tables[Math.floor(code / art.perTable)];
        if (asset && this.scene.textures.exists(textureKey(asset))) this.image(asset, code % art.perTable, 320, 175);
      }
    }
    this.image('MEN9102', this.tab + 1, ...cfg.category);
    for (const a of tabHitAreas(this.spec, 'MEN9102', ...cfg.category, 7)) {
      this.hit(a.x, a.y, a.w, a.h, () => {
        if (this.stage === 'confirm') return;
        if (a.tab === 0) { this.back(); return; }
        this.tab = a.tab - 1; this.index = 0; this.render();
      });
    }
    this.image('MEN9100', 2, ...cfg.description);
    const record = this.current() && this.catalog.物品(this.current().代码);
    this.text(wrapText(record?.说明繁 || record?.详述 || '', 20, 3), 76, 400);
    if (this.stage === 'confirm') {
      this.image('MEN8006', 1 - this.confirmChoice, ...cfg.confirm);
      for (let i = 0; i < 2; i++) this.hit(cfg.confirm[0] + 15, cfg.confirm[1] + 26 + i * 32, 110, 27, () => { this.confirmChoice = i; this.accept(); });
    }
  }
  update(time) {
    if (!this.visible) return;
    if (this.stage === 'menu' && !this.scene.statusScreen.visible) {
      this.stage = 'room'; this.container.setVisible(true); this.render();
    }
    if (['first', 'second'].includes(this.stage) && Math.floor(time / 120) !== this.tick) {
      this.tick = Math.floor(time / 120);
      // 动画换帧不销毁交互区，否则鼠标按下与输入派发之间可能丢失按钮。
      for (const a of this.animations ?? []) {
        layersOf(this.spec, a.asset, a.frameAt(time), a.x, a.y).forEach((layer, i) => {
          a.images[i].setTexture(textureKey(a.asset), layer.img).setPosition(layer.x, layer.y)
            .setBlendMode(layer.blend).setAlpha(layer.alpha);
        });
      }
    }
  }
}
