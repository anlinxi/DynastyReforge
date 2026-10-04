import { playSfx } from '../systems/audioSettings.js';
import { dialoguePages, dialogueLayer } from '../systems/dialogueText.js';
import Phaser from 'phaser';
import { FONT_KEY, DIALOGUE_FONT_KEY, FONT_SIZE, STAGE_WIDTH, STAGE_HEIGHT, UI_KEYS } from '../config.js';
import { choiceKind, ANSWER_YES, ANSWER_NO } from '../systems/eventScript.js';
import { warnOnce } from '../systems/warnOnce.js';
import DEPTH from '../systems/depths.js';
import { uiPointer } from '../systems/stageView.js';
import { uiShift } from '../systems/fieldCameras.js';

/**
 * 原作对话框。
 *
 * 素材与摆位全部来自 tools/export_ui.py 与 tools/export_portrait.py 的产物，
 * SF2 的图层坐标就是原作 640×480 画面的绝对坐标，照搬即可，不必自己调位置：
 *
 *   F-TALK   正文框，落位 (2,364)。9 帧是从画面外弹出的动画，
 *            y 走 470→447→359→364，最后一步是过冲回弹，音效在第 2 帧触发
 *   F-NAME   姓名牌，帧 0 是左侧版、帧 1 是右侧版，与立绘同侧
 *   F-FLOAT  右下角「继续」小标，8 帧上下浮动
 *
 * 立绘的左右由对白指令的 side 决定：右侧取「表情 + 16」那一帧，
 * 那是美术另画的面朝左版本，不是镜像翻转。
 *
 * 相当一部分配角（西夏士兵、神秘客等）的立绘文件是空壳，
 * 原作说话时就不显示立绘——查不到立绘时保持满宽布局即可。
 */

const TICK_MS = 55;
/** 打字机每字间隔。 */
const TYPE_MS = 28;
/**
 * 正文排版。**这三个值是从原作截图实测反推的，不是调出来的**
 * （`screenshots/yc_sc/`，用字模做归一化互相关定位，相关度 0.87~0.93）：
 *
 *   第 1 行 y=380、第 2 行 y=402  →  行高 22
 *   第 2 行行首 x=60，字距 24（全角）/ 12（半角）
 *   第 1 行「哼」落在 x=132 = 60 + 「(24) + 四个半角点(48)，完全吻合
 *
 * F-TALK 落位 (2,364)，故 inset 为 58 / 16。
 */
const TEXT_INSET_X = 58;
const TEXT_INSET_Y = 16;
/**
 * ⚠️ **负行距不是笔误。** 原作行高 22 < 字高 24——点阵字模上下自带空白，
 * 靠它留出行间距，所以额外行距是 −2。按正数排版 4 行会顶穿框底。
 */
const LINE_SPACING = -2;
/**
 * 每页行数。框从 y=364 起、高 116，文字自 380 开始，
 * 4 行占 24 + 22×3 = 90px，末行底边 470 < 480，装得下；5 行就出框。
 * 原作单句最多 8 行（神秘客那段），所以必须分页翻，不能一次铺完。
 */
const MAX_LINES = 4;
/**
 * 姓名在牌身内的垂直偏移。
 * ⚠️ 这个值是给 16px 系统字调的，换成 24px 点阵字后**可能需要重调**；
 * 字更高了，牌若显窄就减小它，别去改字号（点阵字缩放必糊）。
 */
const NAME_TEXT_DY = 10;
/** 正文行高 —— 字高加负行距，见 {@link LINE_SPACING}。选项高亮按它定位。 */
const LINE_H = FONT_SIZE + LINE_SPACING;
/**
 * 被选中的那一行的墨色。
 *
 * ⚠️ **推断。** `Sys.DAT` 里 `F-*` 系列一共就 5 个
 * （TALK/NAME/FLOAT/YESNO/FASCIA，已全部导出），**没有任何一张是
 * 「正文里高亮某一行」用的**；是/否那个框靠素材自带的黑框标记选中，
 * 内嵌行选却无素材可用。所以「选中的行换个颜色」是我们自己定的表现，
 * 登记在 `docs/状态/复现度台账.md`。
 */
const CHOICE_TINT = 0x9c2b1b;
/**
 * `F-YESNO` 的帧号 → 哪一项带黑框。
 *
 * ⚠️ **别按帧号顺序猜，两张图是反的。** 三张图与三帧的关系是
 * 帧 0~3 → 图 2、帧 4 → 图 0、帧 5 → 图 1；而把图 0/图 1 分别与
 * 「都不带框」的图 2 做像素差：
 *
 * ```
 * 图 0 差在 y 42~69  ← 下面那行 =「否」
 * 图 1 差在 y 15~42  ← 上面那行 =「是」
 * ```
 *
 * 所以 **是 = 帧 5、否 = 帧 4**。我第一版按帧号顺序写成了是=4/否=5，
 * 实机上表现为「按 ↓ 选到否，黑框却还套在是上面」。
 */
const YESNO_FRAME = Object.freeze({ [ANSWER_YES]: 5, [ANSWER_NO]: 4 });

const DEPTH_PORTRAIT = DEPTH.PORTRAIT;
const DEPTH_FRAME = DEPTH.DIALOGUE;
const SIDE_RIGHT = 1;
/** F-TALK 弹出动画的落位帧，静态显示取它。 */
const TALK_SETTLED_FRAME = 4;

export default class DialogueBox {
  constructor(scene) {
    this.scene = scene;
    this.visible = false;
    this.typing = false;
    this.onFinish = null;

    this.container = scene.add.container(0, 0)
      .setScrollFactor(0)
      .setDepth(DEPTH_FRAME)
      .setVisible(false);

    this.portrait = scene.add.image(0, 0, '__MISSING')
      .setOrigin(0, 0)
      .setScrollFactor(0)
      .setDepth(DEPTH_PORTRAIT)
      .setVisible(false);
    this.portrait.ycFree = true; // 宽屏：立绘不被居中 640 的边界裁掉（fieldCameras.js）

    // 每个 UI 元素的一帧可能有多层（姓名牌就是牌身 + 装饰线两层），
    // 各自维护一个图片池，按帧的图层数增减
    this.framePool = [];
    this.namePool = [];
    this.floatPool = [];
    this.yesnoPool = [];

    // 原作402ee0(mode5)：姓名和正文共用浅色左右边缘+深色字心，禁止再tint。
    this.nameText = scene.add.bitmapText(0, 0, DIALOGUE_FONT_KEY, '', FONT_SIZE)
      .setOrigin(0.5, 0);

    this.bodyText = scene.add.bitmapText(0, 0, DIALOGUE_FONT_KEY, '', FONT_SIZE)
      .setOrigin(0, 0)
      .setLineSpacing(LINE_SPACING);

    this.emphasisText = ['blue', 'emphasis-red'].map((style) => scene.add
      .bitmapText(0, 0, `${FONT_KEY}-${style}`, '', FONT_SIZE)
      .setOrigin(0, 0).setLineSpacing(LINE_SPACING));

    // 选中的那一行：把同样的字用高亮墨色**原位盖一遍**。
    // 白字图集只覆盖字心，保留正文浅色边缘；选中色仍是已登记的适配取舍。
    this.choiceHi = scene.add.bitmapText(0, 0, FONT_KEY, '', FONT_SIZE)
      .setOrigin(0, 0)
      .setTint(CHOICE_TINT)
      .setVisible(false);

    // 容器内按加入顺序渲染，文字最后加保证压在最上层
    this.container.add([this.nameText, this.bodyText, ...this.emphasisText, this.choiceHi]);

    this.floatTimer = 0;
    this.floatFrame = 1;
  }

  /** 读取 export_ui.py 产出的 ui.json。缺失时返回 null，调用方需容错。 */
  ui(key) {
    return this.scene.cache.json.get(`${key}-ui`) ?? null;
  }

  /**
   * 把某个 UI 元素的一帧铺到画面上，返回实际画出的图层。
   *
   * 图层坐标是原作 640×480 画面的绝对坐标，照搬即可。
   * 池里多余的图片隐藏而不销毁，避免每句对白都重建对象。
   */
  drawFrame(key, frameIndex, pool) {
    const data = this.ui(key);
    const layers = data?.frames?.[frameIndex]?.layers ?? [];
    const drawn = [];

    layers.forEach((layer, i) => {
      const texture = `${key}-i${layer.image}`;
      if (!this.scene.textures.exists(texture)) return;

      if (!pool[i]) {
        pool[i] = this.scene.add.image(0, 0, texture).setOrigin(0, 0);
        // 插在文字之前，文字始终压在最上
        this.container.addAt(pool[i], drawn.length);
      }
      pool[i].setTexture(texture).setPosition(layer.x, layer.y).setVisible(true);
      const size = (data.images ?? []).find((img) => img.index === layer.image);
      // `index` 是 SF2 里的图号 —— 查 `images[].box` 要用它，别拿 Phaser 对象去查。
      drawn.push({ image: pool[i], index: layer.image,
                   x: layer.x, y: layer.y, w: size?.w ?? 0, h: size?.h ?? 0 });
    });

    pool.slice(layers.length).forEach((img) => img.setVisible(false));
    return drawn;
  }

  hidePool(pool) {
    pool.forEach((img) => img.setVisible(false));
  }

  /**
   * 播放一段对白。
   *
   * 一段事件里的第一句会先放原作的弹出动画（框从画面外升起），
   * 后续各句直接换文字——否则每句都弹一次，又吵又拖沓。
   *
   * @param {{speaker:number, frame:number, side:number, text:string}} line
   * @param {string} speakerName
   */
  show(line, speakerName) {
    // 上一句若是选择句，选项要收掉 —— 不收的话框会挂在后面每一句上。
    this.clearChoice();
    const opening = !this.visible;
    this.visible = true;
    this.container.setVisible(true);
    this.pending = line;

    this.placePortrait(line);
    this.placeNamePlate(line, speakerName);

    if (opening) {
      this.startOpenAnimation();
      return;
    }
    this.placeFrame(TALK_SETTLED_FRAME);
    this.startTyping(line.text);
  }

  placeFrame(frameIndex) {
    const drawn = this.drawFrame(UI_KEYS.talk, frameIndex, this.framePool);
    if (drawn.length) this.frameSpot = drawn[0];
  }

  /** 原作的弹出动画：F-TALK 帧 1→4，y 走 470→447→359→364，最后一步是过冲回弹。 */
  startOpenAnimation() {
    this.openFrame = 1;
    this.openTimer = 0;
    this.bodyText.setText('');
    this.emphasisText.forEach((t) => t.setText(''));
    this.hidePool(this.floatPool);
    this.placeFrame(this.openFrame);
    this.playFrameSound(this.openFrame);
  }

  advanceOpenAnimation(delta) {
    const frames = this.ui(UI_KEYS.talk)?.frames ?? [];
    this.openTimer += delta;
    if (this.openTimer < (frames[this.openFrame]?.duration ?? 1) * TICK_MS) return;

    this.openTimer = 0;
    this.openFrame += 1;
    if (this.openFrame >= TALK_SETTLED_FRAME) {
      this.finishOpenAnimation();
      return;
    }
    this.placeFrame(this.openFrame);
    this.playFrameSound(this.openFrame);
  }

  finishOpenAnimation() {
    this.openFrame = null;
    this.placeFrame(TALK_SETTLED_FRAME);
    this.startTyping(this.pending?.text ?? '');
  }

  placePortrait(line) {
    const data = this.scene.cache.json.get(`portrait-${line.speaker}`);
    const frame = data?.frames?.[line.frame] ?? null;
    const texture = `portrait-${line.speaker}-p${line.frame}`;

    // ⚠️ 分两种情况，**只有第二种是缺东西**：
    // ① `!frame` —— 原作这个角色/这句话本来就不显示立绘（空壳），是正常的
    // ② 有 frame 但贴图不在 —— **该有立绘却没画出来**，多半是没预载
    //    （`PORTRAIT_CODES` 只有 4 个，归档里有 55 个），画面上看不出是 bug
    if (frame && !this.scene.textures.exists(texture)) {
      warnOnce(`portrait:${line.speaker}`,
        `角色 ${line.speaker} 该有立绘（帧 ${line.frame}）但贴图 ${texture} 不在 —— `
        + '这句话不显示立绘。立绘是 L2 按需加载，见 config.PORTRAIT_CODES。');
    }
    if (!frame || !this.scene.textures.exists(texture)) {
      this.portrait.setVisible(false);
      return;
    }
    // x/y 是原作画面的绝对坐标，直接照搬
    this.portrait.setTexture(texture).setPosition(frame.x + uiShift(this.scene, frame.x + frame.w / 2), frame.y).setVisible(true);
  }

  /**
   * 姓名牌。帧 0 是左侧版、帧 1 是右侧版，与立绘同侧。
   * 每帧两层：牌身与装饰线——只画一层会让文字溢出到框外。
   * 旁白（人物代码 0）没有名字，此时不显示牌子。
   */
  placeNamePlate(line, speakerName) {
    const name = (speakerName ?? '').trim();
    if (!name) {
      this.hidePool(this.namePool);
      this.nameText.setText('');
      return;
    }

    const frameIndex = line.side === SIDE_RIGHT ? 1 : 0;
    const drawn = this.drawFrame(UI_KEYS.name, frameIndex, this.namePool);
    if (!drawn.length) {
      this.nameText.setText('');
      return;
    }

    // 牌身是面积最大的那层，文字居中于它。
    //
    // ⚠️ **要按真正有像素的范围居中，不能用标称宽度。** UI 图是
    // **不裁剪**写出的（图层坐标按未裁剪的画布给），右侧常留一条透明边 ——
    // `F-NAME` 标称 192 宽而实际只画到 x=153，中心差 20 像素，
    // 「西夏士兵」的「兵」正好被右边框压住。`box` 由 `tools/export_ui.py` 导出。
    const plate = drawn.reduce((a, b) => (b.w * b.h > a.w * a.h ? b : a));
    const box = this.imageBox(UI_KEYS.name, plate.index);
    const midX = box ? (box[0] + box[2]) / 2 : plate.w / 2;
    this.nameText
      .setText(name)
      .setPosition(plate.x + midX, plate.y + NAME_TEXT_DY);
  }

  /** 某张 UI 图真正有像素的范围 `[left, top, right, bottom]`；没导出就返回 null。 */
  imageBox(key, index) {
    return (this.ui(key)?.images ?? []).find((i) => i.index === index)?.box ?? null;
  }

  /**
   * 原作用 `00 01` 在句内换行，导出时原样保留成 `` 交给渲染层，
   * 这里换成真正的换行；超出一页的部分翻页显示。
   */
  paginate(text) {
    const lines = (text ?? '').replace(//g, '\n').split('\n');
    const pages = [];
    for (let i = 0; i < lines.length; i += MAX_LINES) {
      pages.push(lines.slice(i, i + MAX_LINES).join('\n'));
    }
    return pages.length ? pages : [''];
  }

  startTyping(text) {
    this.styledPages = dialoguePages(text, MAX_LINES);
    this.pages = this.styledPages.map((p) => p.text);
    this.pageIndex = 0;
    const spot = this.frameSpot;
    this.bodyText.setPosition(spot.x + TEXT_INSET_X, spot.y + TEXT_INSET_Y);
    this.emphasisText.forEach((t) => t.setPosition(this.bodyText.x, this.bodyText.y));
    this.typePage();
  }

  paintText(count) {
    const page = this.styledPages[this.pageIndex];
    this.bodyText.setText(dialogueLayer(page, 'normal', count));
    this.emphasisText[0].setText(dialogueLayer(page, 'blue', count));
    this.emphasisText[1].setText(dialogueLayer(page, 'red', count));
  }

  typePage() {
    this.fullText = this.pages[this.pageIndex] ?? '';
    this.charCount = 0;
    this.typeTimer = 0;
    this.typing = true;
    this.bodyText.setText('');
    this.emphasisText.forEach((t) => t.setText(''));
    this.hidePool(this.floatPool);
    // 翻到新一页＝还没到选项那一页，先把痕迹收掉；到了最后一页
    // 再由 `advance()` 摆出来。
    this.choiceShown = false;
    this.clearChoiceMarks();
  }

  /**
   * 原作的对话提示音内嵌在 F-TALK.SF2 里，由帧自己的 sound 字段指定触发时机
   * （弹出动画的第 2 帧），不是我们自己挑的时间点。
   */
  playFrameSound(frameIndex) {
    const index = this.ui(UI_KEYS.talk)?.frames?.[frameIndex]?.sound;
    if (index === null || index === undefined) return;

    const key = `${UI_KEYS.talk}-snd${index}`;
    if (this.scene.cache.audio.exists(key)) playSfx(this.scene, key);
  }

  /**
   * 把这一句变成**选择句**。
   *
   * @param {Array<number>} values 紧跟这句的那一组 `999` 分支的比较值，
   *   由 `runner.peekChoices()` 给出。空数组＝不是选择句。
   *
   * 两种形态（判据见 `systems/eventScript.js` 的 `choiceKind`）：
   * * **是/否** —— 值域落在 `{1,2}`。弹原作的 `F-YESNO` 小框。
   *   ⚠️ 无论脚本只写了 `==1` 还是两支都写，框里**永远是两行**：
   *   `MP0202` 客栈只写了 `==1`，选「否」是靠**落空往下走**，
   *   所以不能按「脚本写了几支就给几个选项」来摆。
   * * **内嵌行选** —— 选项就是对白最后一页的第 `值` 行（1 起）。
   *
   * ⚠️ **要等正文放完才出选项**。打字还在跑、或者还有下一页时就把选项
   * 摆出来，玩家会在没读完的情况下按下去。
   */
  ask(values) {
    const list = (values ?? []).map(Number).filter(Number.isInteger);
    if (!list.length) return this;
    this.question = true;
    this.choiceKind = choiceKind(list);
    this.choiceOptions = this.choiceKind === 'yesno'
      ? [ANSWER_YES, ANSWER_NO]
      : [...new Set(list)].sort((a, b) => a - b);
    this.choiceIndex = 0;          // 默认停在第一项（是 / 第一个选项）
    return this;
  }

  /** 正文放完了吗（选项该不该出现）。 */
  get answering() {
    return Boolean(this.question) && !this.typing
      && this.openFrame === null
      && this.pageIndex + 1 >= this.pages.length;
  }

  /** 选中项要写进临时标志位的值。是=1、否=2、内嵌行选=行号。 */
  get answerValue() {
    return this.choiceOptions?.[this.choiceIndex] ?? ANSWER_YES;
  }

  /**
   * 换一个选项。是/否框是竖排的（是在上、否在下），所以 ↑↓ 与 ←→ 都收。
   * @returns {boolean} 有没有吃掉这次按键
   */
  pickAt(rawPointer) {
    if (!this.answering || !this.choiceShown) return true;
    const pointer = uiPointer(rawPointer); // 宽屏时扣掉居中 640 界面的左边距
    let index = -1;
    if (this.choiceKind === 'yesno') {
      if (pointer.x >= 488 && pointer.x <= 630) {
        if (pointer.y >= 314 && pointer.y < 341) index = 0;
        if (pointer.y >= 341 && pointer.y < 369) index = 1;
      }
    } else if (pointer.x >= this.bodyText.x && pointer.x < 625) {
      const row = Math.floor((pointer.y - this.bodyText.y) / LINE_H) + 1;
      index = this.choiceOptions.indexOf(row);
    }
    if (index < 0) return false;
    this.choiceIndex = index; this.drawChoices(); return true;
  }

  moveChoice(delta) {
    if (!this.answering || !this.choiceOptions?.length) return false;
    const n = this.choiceOptions.length;
    this.choiceIndex = (this.choiceIndex + delta + n) % n;
    this.drawChoices();
    return true;
  }

  /** 把选项摆出来（或收掉）。 */
  drawChoices() {
    if (!this.answering) { this.choiceShown = false; this.clearChoiceMarks(); return; }
    if (this.choiceKind === 'yesno') this.drawYesNo();
    else this.drawLineCursor();
    this.choiceShown = true;
  }

  /**
   * 是/否框：原作素材 `F-YESNO`，落位 (488,299) 由素材自己给，不用我们摆。
   * 三张图分别是「是」带黑框、「否」带黑框、都不带 —— 选中标记是
   * **素材自带的黑框**，跟标题画面那三个选项是同一套做法。
   */
  drawYesNo() {
    this.choiceHi.setVisible(false);
    const frame = YESNO_FRAME[this.answerValue];
    if (frame === undefined) { this.hidePool(this.yesnoPool); return; }
    this.drawFrame(UI_KEYS.yesno, frame, this.yesnoPool);
  }

  /**
   * 内嵌行选：把选中的那一行用高亮墨色原位盖一遍。
   *
   * 值就是**最后一页上的第几行**（1 起），见 `eventScript.js` 的判据段。
   */
  drawLineCursor() {
    this.hidePool(this.yesnoPool);
    const lines = (this.pages?.[this.pageIndex] ?? '').split('\n');
    const row = this.answerValue - 1;
    const text = lines[row];
    if (text === undefined) { this.choiceHi.setVisible(false); return; }
    this.choiceHi
      .setText(text)
      .setPosition(this.bodyText.x, this.bodyText.y + row * LINE_H)
      .setVisible(true);
  }

  /** 收掉选项的一切痕迹。换句、收框、以及正文还没放完时都要调。 */
  clearChoiceMarks() {
    this.hidePool(this.yesnoPool);
    this.choiceHi.setVisible(false);
  }

  /** 这句不再是选择句。 */
  clearChoice() {
    this.question = false;
    this.choiceOptions = null;
    this.choiceIndex = 0;
    this.choiceShown = false;
    this.clearChoiceMarks();
  }

  /**
   * 空格的处理：打字未完先补全，还有下一页就翻页。
   * 返回 true 表示这句已放完，调用方可以推进到下一句。
   */
  advance() {
    if (!this.visible) return false;

    if (this.openFrame !== null && this.openFrame !== undefined) {
      this.finishOpenAnimation();
      return false;
    }

    if (this.typing) {
      this.charCount = this.fullText.length;
      this.paintText(this.fullText.length);
      this.typing = false;
      return false;
    }

    if (this.pageIndex + 1 < this.pages.length) {
      this.pageIndex += 1;
      this.typePage();
      return false;
    }
    // 选择句：正文放完先把选项摆出来，**再按一次**才算答完。
    if (this.question && !this.choiceShown) {
      this.drawChoices();
      return false;
    }
    return true;
  }

  hide() {
    this.visible = false;
    this.typing = false;
    this.openFrame = null;
    this.pending = null;
    this.clearChoice();
    this.container.setVisible(false);
    this.portrait.setVisible(false);
  }

  update(delta) {
    if (!this.visible) return;

    if (this.openFrame !== null && this.openFrame !== undefined) {
      this.advanceOpenAnimation(delta);
      return;
    }

    if (this.typing) {
      this.typeTimer += delta;
      while (this.typeTimer >= TYPE_MS && this.charCount < this.fullText.length) {
        this.typeTimer -= TYPE_MS;
        this.charCount += 1;
      }
      this.paintText(this.charCount);
      if (this.charCount >= this.fullText.length) this.typing = false;
      return;
    }

    this.animateFloatMark(delta);
  }

  /** 打字结束后，右下角小标按原作的 8 帧上下浮动（帧 0 是空帧，从 1 起循环）。 */
  animateFloatMark(delta) {
    const frames = this.ui(UI_KEYS.float)?.frames ?? [];
    if (frames.length < 2) return;

    this.floatTimer += delta;
    const hold = (frames[this.floatFrame]?.duration ?? 2) * TICK_MS;
    if (this.floatTimer >= hold) {
      this.floatTimer = 0;
      this.floatFrame += 1;
      if (this.floatFrame >= frames.length) this.floatFrame = 1;
    }
    this.drawFrame(UI_KEYS.float, this.floatFrame, this.floatPool);
  }

  destroy() {
    this.container.destroy();
    this.portrait.destroy();
  }
}
