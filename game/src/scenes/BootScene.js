import { uiAsset } from '../systems/language.js';
import { hdMenuSheet, queueHdManifest, portraitUrl } from '../hd/hdAssets.js';
import { applyHdFontStyles } from '../hd/hdFont.js';
import Phaser from 'phaser';
import {
  AVATARS_KEY, AVATAR_PRELOAD, FONTS, LANGUAGE, PARTY_SPRITES,
  PORTRAIT_CODES, PORTRAIT_INDEX_KEY, SFX_FILES, SHARED_EVENT_MAP, STAGE_HEIGHT, STAGE_WIDTH, TITLE, UI_KEYS,
} from '../config.js';

import { queueSprite, ensureMapWithSource } from '../systems/loader.js';
import { newGameEntry } from '../systems/gameStart.js';
import { MENU_SPEC_KEY, textureKey } from '../ui/menuSpec.js';
import {
  LAYOUT_KEY, MAPNAMES_KEY, SPEAKERS_KEY, SCRIPT_SOURCES_KEY, TEMPLATE_KEY,
} from '../systems/gameSave.js';
import { initStore } from '../systems/saveStore.js';
import { centerLegacyScene } from '../systems/stageView.js';
import { authGate } from '../systems/ycAuth.js';

/** 测试存档在 Phaser 缓存里的 key。见 `systems/savefile.js`。 */
export const SAVEFILE_KEY = 'savefile';

/** 载入全部 SF2 动画包（anim.json + 其引用的 PNG）。 */
/** 标题画面要的素材键，与 `config.TITLE` 一致。 */
// ⚠️ **翻页箭头不在这张表里。** `MEN8004`/`MEN8005` 由 `queueMenuSheets()`
// 按 `menus.json` 载成 **spritesheet**（数字帧号），而这张表走的是
// `multiatlas`（帧名 `img_00N`）—— 两者键名相同（`menu-<asset>`），
// 重复排会打架，而且 `MEN8005` 根本没有图集目录，只有一张 png。
const TITLE_ASSETS = [TITLE.background, ...TITLE.options, TITLE.loadPage];


/** 启动加载超过多久才显示进度，与 FieldScene.LOAD_HINT_MS 同值。 */
const BOOT_LOAD_HINT_MS = 400;

/** 开机三轮各占总进度的区间，见 showProgress。 */
const BOOT_ROUNDS = [[0, 0.4], [0.4, 0.8], [0.8, 1]];

export default class BootScene extends Phaser.Scene {
  constructor() {
    super('Boot');
  }

  /** `TitleScene` 选完之后带 `startGame: true` 回来，那时直接进图。 */
  init(data) {
    centerLegacyScene(this); // 宽屏视野：没改造的场景只用居中 640
    this.toGame = Boolean(data?.startGame);
    // 读档来的：存档自己带地图与落点，直接落到那儿，不走新游戏那份。
    this.savedEntry = data?.entry ?? null;
  }

  preload() {
    this.showProgress();
    // 音效，键名与 cutscene.js 的 `sfx-<曲目>` 一致。**只有 8 个、共几百 KB**，
    // 而且随时可能被任何一句剧情点到，留在 L0。
    Object.entries(SFX_FILES).forEach(([track, file]) => {
      this.load.audio(`sfx-${track}`, `audio/${file}`);
    });
    // 标题画面的 BGM 边读边播，不在这里载（见 systems/bgm.js）。
    // ⚠️ **战斗素材（L3）与地图（L1）不在这里了。**
    //
    // 原先这里把 `ANIMATION_KEYS` 的全部动画包、`FIELD_MAPS` 每一张图的地面
    // 与精灵一次排队 —— 九张图就要 8528 个请求 / 115 MB / 11.8 秒，而那才占
    // 全部 309 张地图的 3%。现在：
    //   * 地图 → `systems/loader.js` 的 `ensureMap()`，进图前拉
    //   * 战斗素材 → `ensureBattle()`，第一次进战斗时拉
    //   * BGM → 跟着地图走（`mapAssets().bgm`）
    // 见 `docs/归档/方案-按需加载与图集.md`。
    //
    // 对话框界面与立绘的清单，逐帧图在第二段按清单补拉
    Object.values(UI_KEYS).forEach((key) => {
      this.load.json(`${key}-ui`, `assets/ui/${key}/ui.json`);
    });
    PORTRAIT_CODES.forEach((code) => {
      this.load.json(`portrait-${code}`, `assets/portraits/${code}/portrait.json`);
    });
    // 立绘清单 —— `loader.portraitCodes` 靠它过滤掉空壳角色。**L0 必须有**，
    // 否则第一张图的按需加载拿不到清单、一个配角立绘都排不上。
    this.load.json(PORTRAIT_INDEX_KEY, 'assets/portraits/index.json');
    queueHdManifest(this); // 高清清单（默认开，?hd=0 不读）；本机没生成高清图时清单缺失，全部用原图
    // 八页菜单的配置（tools/export_menu_ui.py 的产物）。精灵表的格宽格高写在
    // 这份 JSON 里，所以图要等它落地之后才能排队，见 queueMenuSheets。
    this.load.json(MENU_SPEC_KEY, uiAsset('assets/menus/menus.json'));
    // **标题画面素材**（`MEN9300` 背景 + 三个选项各 32 帧 + 卷轴光标）。
    // 走的是场景精灵那套产物（`sprite.json` + 图集），与八页菜单的
    // spritesheet 不是一回事，所以单独排。见 `scenes/TitleScene.js`。
    for (const key of TITLE_ASSETS) {
      this.load.json(`menu-${key}-sprite`, uiAsset(`assets/menus/${key}/sprite.json`));
      this.load.multiatlas(`menu-${key}`, uiAsset(`assets/menus/${key}/${key}.json`),
                           uiAsset(`assets/menus/${key}`));
    }
    // 数值配置（tools/export_gamedata.py 的产物）。**数只从这里来**，
    // 公式在 systems/formulas.js。见 docs/专题/数值体系.md。
    this.load.json('refining', 'assets/data/refining.json');
    this.load.json('gamedata', 'assets/data/gamedata.json');
    this.load.json('field-encounters', 'assets/data/encounters.json');
    this.load.json('equipment-full', 'assets/data/equipment.json');
    this.load.json('items-full', 'assets/data/items.json');
    this.load.json('skills-full', 'assets/data/skills.json');
    // **测试存档**（可选）。有就从它开局，没有就走默认新游戏。
    // 造一份：`python3 tools/tsf_parse.py <原作存档.TSF> --export test`，
    // 然后直接改那个 JSON —— 调数值不要再去改 inventory.js / partyState.js 的常量。
    // ⚠️ 文件不存在时 Phaser 会在控制台报一条 404，那是**预期行为**，不是错误。
    this.load.json(SAVEFILE_KEY, 'assets/data/saves/test.json');
    // 存档：字段偏移表（tsf_parse.py --layout 的产物）、图号→地名、
    // 以及**新游戏底档**。写存档一律以某个真实存档为底，见 systems/tsf.js。
    this.load.json(LAYOUT_KEY, 'assets/data/tsf_layout.json');
    this.load.json(MAPNAMES_KEY, 'assets/data/mapnames.json');
    // **全局人物代码 → 姓名**（`tools/export_speakers.py` 的产物）。
    // 对白的姓名牌查它，见 `FieldScene.speakerName`。
    this.load.json(SPEAKERS_KEY, 'assets/data/speakers.json');
    // **过场图的事件表来源**（`tools/export_script_sources.py` 的产物）。
    this.load.json(SCRIPT_SOURCES_KEY, 'assets/data/script_sources.json');
    this.load.binary(TEMPLATE_KEY, 'assets/data/NewGame.TSF');
    // **共享事件归档**（开场剧情就在里面）。它没有地面美术，不走
    // `loader.loadMap` 那条路 —— 只是一份脚本，进缓存就够了。
    // ⚠️ 进了缓存还有第二个作用：`FieldScene.scriptedNames` 会扫「缓存里
    // 所有 `-map`」，于是 `Event-0.SF2` / `夏侯儀老媽` 会被当成"剧情点过名的"
    // 建出精灵来等 `actor_show`。不载它，开场就演给空气看。
    this.load.json(`${SHARED_EVENT_MAP}-map`, `assets/maps/${SHARED_EVENT_MAP}/map.json`);
    // `set_avatar` 的形象表 + 共享角色表，由 `tools/export_party.py` 从
    // 共享库的 `MAINNPC.SCI` / `SUBNPC.SCI` 生成。**别再手填映射。**
    this.load.json(AVATARS_KEY, 'assets/data/avatars.json');
    // 只加载当前字形语言：通用白字和对白双色字体；两者共用原作字模。
    const font = FONTS[LANGUAGE];
    this.load.bitmapFont(font.key, font.texture, font.data);
    this.load.bitmapFont(font.dialogueKey, font.dialogueTexture, font.dialogueData);
    for (const style of ['red', 'blue', 'emphasis-red']) {
      const key = `${font.key}-${style}`;
      this.load.bitmapFont(key, `assets/font/${key}.png`, `assets/font/${key}.xml`);
    }
    // anim.json 落地后才知道有哪些图片，这里挂一次回调再补加载
    this.load.once('complete', () => {
      applyHdFontStyles(this, font); // 高清：按规则重绘字体阴影（繁体对白 3a；简体不要双色，含红/蓝/强调红），原版不动
      this.queueImages();
    });
  }

  showProgress() {
    // ⚠️ 按 640×480 居中，不按舞台宽：相机已由 centerLegacyScene 收成居中 640 的视口，
    // 用 `this.scale.width`（宽屏时 853~1040）的一半会落在视口里偏右的位置（2026-10-03 用户报）。
    const label = this.add
      .text(STAGE_WIDTH / 2, STAGE_HEIGHT / 2, '载入中…', {
        fontFamily: 'serif',
        fontSize: '20px',
        color: '#d8c9a3',
      })
      .setOrigin(0.5)
      .setVisible(false);
    // 与切图同一规则：Boot 超过 BOOT_LOAD_HINT_MS 还没走完才显示，瞬间完成就不闪。
    this.time.delayedCall(BOOT_LOAD_HINT_MS, () => {
      if (label.active) label.setVisible(true);
    });

    // 开机分三轮（清单与数据 → 对话界面/菜单/人物清单 → 队伍贴图），Phaser 的进度每轮从 0 重算；
    // 按轮分段合成一个只增不减的百分比（同 loader.js 的 band）。轮次由 queueImages / queuePartySprites 推进。
    this.bootRound = 0;
    let shown = 0;
    this.load.on('progress', (value) => {
      const [from, to] = BOOT_ROUNDS[Math.min(this.bootRound, BOOT_ROUNDS.length - 1)];
      shown = Math.max(shown, from + (to - from) * value);
      label.setText(`载入中… ${Math.round(shown * 100)}%`);
    });
  }

  /**
   * 对话框界面图、内嵌音效、立绘逐帧图。
   * 立绘的帧可能是 null（该角色表情不足 16 种），跳过即可。
   */
  queueDialogueAssets() {
    let queued = 0;

    Object.values(UI_KEYS).forEach((key) => {
      const data = this.cache.json.get(`${key}-ui`);
      if (!data) return;

      (data.images ?? []).forEach((img) => {
        this.load.image(`${key}-i${img.index}`, `assets/ui/${key}/${img.file}`);
        queued += 1;
      });
      (data.sounds ?? []).forEach((snd) => {
        this.load.audio(`${key}-snd${snd.index}`, `assets/ui/${key}/${snd.file}`);
        queued += 1;
      });
    });

    PORTRAIT_CODES.forEach((code) => {
      const data = this.cache.json.get(`portrait-${code}`);
      (data?.frames ?? []).forEach((frame, index) => {
        if (!frame) return;
        const key = `portrait-${code}-p${index}`;
        this.load.image(key, portraitUrl(this, key, code, frame.file));
        queued += 1;
      });
    });

    return queued;
  }

  /**
   * 菜单精灵表。一个素材一张图，所有帧按统一格宽排成网格，
   * 所以走 `load.spritesheet` 而不是 `load.image`——帧号直接当 Phaser 的帧索引用。
   */
  queueMenuSheets() {
    const spec = this.cache.json.get(MENU_SPEC_KEY);
    if (!spec) {
      console.warn('menus.json 未加载，八页菜单不可用');
      return 0;
    }
    let queued = 0;
    // ⚠️ **物品插图（L2）不在这里。** `MEN4010`~`MEN4014` 共 336 张、4.5 MB，
    // 占了全部菜单素材的一半 —— 而它只有开法宝页或进商店才看得到。
    // 由 `loader.ensureArtwork()` 在第一次要画时拉，见那里。
    const lazy = new Set(spec.artwork?.tables ?? []);
    Object.entries(spec.assets ?? {}).forEach(([asset, meta]) => {
      if (lazy.has(asset)) return;
      // 高清试做：人物形象表（MEN0002/7003/8007）有 AI 高清版就读它，显示时自动缩回原尺寸
      const hd = hdMenuSheet(this, textureKey(asset), asset, meta);
      this.load.spritesheet(textureKey(asset), hd?.url ?? uiAsset(`assets/menus/${meta.sheet}`), {
        frameWidth: hd?.frameWidth ?? meta.cell[0], frameHeight: hd?.frameHeight ?? meta.cell[1],
      });
      queued += 1;
    });
    return queued;
  }

  /**
   * **场上要预载的行走精灵 —— 从 `avatars.json` 反查，不手写。**
   *
   * 两张表求并集：`形象`（`MAINNPC.SCI`，`set_avatar` 的 5 个）
   * ＋ `共享角色`（`SUBNPC.SCI`，剧情里出场的 5 个队友）。
   *
   * ⚠️ **手写清单漏了 6 个。** `PARTY_SPRITES` 只有夏侯仪/冰璃/封铃笙，
   * 加上 `AVATAR_PRELOAD` 的小夏侯仪一共 4 个，而实际导出了 **10 个**。
   * 差的是 `FEILONG / GEYUNYI / GULUNDE / HUOYONG / MURONGXUANJI /
   * XIAHOUYI_DEAD` —— 后果全是**静默失效**：
   *
   * * `set_avatar 4`（霍雍，全库 3 处）→「精灵没预载，保持原样」，
   *   走的还是夏侯仪；读霍雍那段的存档也一样
   * * `actor_show 慕容璇璣 / 古倫德 / 葛雲衣` → 场上什么都不出现
   *
   * 这是判据表「写清单类常量要拿数据反查求差集」的第四次翻版
   * （前三次是 `BGM_FILES`、`SFX_FILES`、战斗素材）。
   *
   * `avatars.json` 在第一段加载里就进缓存了（`preload` 里排的），
   * 这一步读得到。拿不到就退回两张手写表 —— 总比一个人都没有强。
   */
  fieldSpriteKeys() {
    const table = this.cache.json.get(AVATARS_KEY);
    const fromData = [
      ...Object.values(table?.形象 ?? {}),
      ...Object.values(table?.共享角色 ?? {}),
    ].filter((k) => typeof k === 'string' && k);
    if (!fromData.length) {
      console.warn('avatars.json 拉不到，行走精灵退回手写清单（霍雍等 6 个会缺）');
    }
    return [...new Set([...PARTY_SPRITES, ...AVATAR_PRELOAD, ...fromData])];
  }

  queueImages() {
    this.bootRound = 1;
    let queued = this.queueDialogueAssets() + this.queueMenuSheets();
    // 主角与队友的素材来自共享库，**不挂在任何一张地图下**，所以留在 L0。
    // 他们每张图都在场，按需加载也省不掉。
    // ⚠️ **大地图的小形象 `AVATAR_PRELOAD` 也要在这一步载 sprite.json**，
    // 否则下一步的 `queueSprite` 拿不到帧表，图集就不会排队 ——
    // 表现是「`set_avatar 1` 说精灵没预载，保持原样」，大地图上还是大形象。
    this.fieldSpriteKeys().forEach((key) => {
      this.load.json(`${key}-sprite`, `assets/sprites/${key}/sprite.json`);
      queued += 1;
    });
    if (queued === 0) {
      this.startGame();
      return;
    }
    // 第三段：精灵清单落地后再拉队友的贴图
    this.load.once('complete', () => this.queuePartySprites());
    this.load.start();
  }

  /**
   * 载完之后去哪：**默认先进标题画面**。
   *
   * ⚠️ 判据是 `MP0000` 槽 8 那条把片头与梦境切开的 `end`，见 `config.OPENING`。
   * 标题选完**不再回到 Boot**（`TitleScene.enterGame` 直接走加载页，见那里）；
   * `startGame: true` 只剩验证脚本 `verify/browser.mjs` 的 `bootToField` 在用。
   */
  async startGame() {
    // 选存储后端：能恢复上次选的文件夹就用它，否则浏览器存储。
    // 标题读档页必须等后端恢复，不能短暂把磁盘档误显示成空档。
    // ⚠️ 这里**不会弹文件夹选择框**（那需要用户手势），见 `saveStore.initStore`。
    await initStore().catch((err) => console.warn('存储后端初始化失败：', err?.message ?? err));
    // 防倒卖验证闸门：未通过（联网取钥 + 输入比对）不放行进入任何后续画面。
    await authGate();
    if (this.toGame) {
      const entry = this.savedEntry ?? newGameEntry(this);
      await ensureMapWithSource(this, entry.mapId);
      this.scene.start('Field', entry);
      return;
    }
    this.scene.start('Title');
  }

  /** 主角与队友的贴图。地图精灵由 `systems/loader.js` 进图时拉。 */
  queuePartySprites() {
    this.bootRound = 2;
    let queued = 0;
    // ⚠️ **大地图的小形象也要预载**：`set_avatar` 紧跟 `goto_map`，
    // 而切图是 `scene.restart()` —— 那时没有机会再去拉资源。
    this.fieldSpriteKeys()
      .forEach((key) => queueSprite(this, key, () => { queued += 1; }));
    if (queued === 0) {
      this.startGame();
      return;
    }
    this.load.once('complete', () => this.startGame());
    this.load.start();
  }
}
