import { LANGUAGE } from './systems/language.js';
export { LANGUAGE };
/** 原作战斗画面基准分辨率。anim.json 中的图层坐标以此为参照。 */
export const STAGE_WIDTH = 640;
export const STAGE_HEIGHT = 480;

/**
 * 已经导出的场景地图（tools/export_map.py 的产物目录名）。
 *
 * ⚠️ **2026-09-05 起这不再是白名单。** `goto_map` 能不能进，由
 * 「那张图的 `map.json` 拉不拉得到」决定（见 `systems/loader.js`），
 * 导一张新图就能进，不用改这里。这张表现在只有两个用处：
 * **开局进哪张图**、以及给人看「导了哪些」。
 *
 * **兰州城 demo 的完整闭包是这七张**（把三张图的 `goto_map` 目标求闭包得来）：
 *
 * | 图 | 是什么 | 事件槽 |
 * |---|---|---|
 * | `MP0212`  | 城门区，废屋入口在这 | 22 |
 * | `MP0201A` | **主街** —— 城里 NPC 与三家店的门都在这 | 50 |
 * | `MP0202`  | 客栈 | 19 |
 * | `MP0205`  | 武具店 | 3 |
 * | `MP0206`  | 杂货铺 | 3 |
 * | `MP0207`  | 药铺 | 4 |
 * | `MP0208`  | 废屋内 —— 封铃笙初遇 | 1 |
 *
 * ⚠️ **主城区是 `MP0201A` 不是 `MP0212`。** 起初以为兰州城就是 `MP0212`，
 * 它其实只是城门那一片；街上 12 类 NPC、53 个精灵、43 个有台词的事件
 * 全在 `MP0201A`。
 *
 * `MP3001` 是大地图（出城用），它自己还有六十多个出口通往全国，那些图没导。
 * `MP0301` 已导出但属于出城之后，暂不挂进来。
 */
export const FIELD_MAPS = Object.freeze([
  'MP0212', 'MP0201A', 'MP0202', 'MP0205', 'MP0206', 'MP0207', 'MP0208', 'MP3001',
]);

/**
 * **共享事件归档** —— 没有地面美术，只有事件脚本，不是用来「进」的图。
 *
 * `MP0000` 里躺着 **3 个槽**：槽 1（30 张图共用的传送特效模板）、
 * **槽 8 = 开场**（片头影片 → 梦境 → 妈妈叫起床 → 交代送鸡汤）、
 * 槽 9 = 战败（黑底红字「敗降」，配它唯一的场景对象 `GameOver.SF2`）。
 *
 * 演出场地是 `MP0102B`（夏侯仪房间）：槽 8 用的 `EVENT-0.SF2` 就在
 * `mp0102b.DAT` 里，`夏侯儀老媽` 也在 MP0102B 的对象表里，
 * 而它最后那条 `hero_place(549,303)` 与开局落点对得上。
 */
/**
 * 大地图的图号，与主角在那儿的行走形象代码。
 *
 * 判据：全库 **61 处**「进大地图」都紧跟 `set_avatar 1` —— `MAINNPC.SCI`
 * 下标 1 是 `小夏侯儀`（`s1.SF2` 20×51），城里那个 `大夏侯儀` 是 36×90。
 * 剧情进大地图时由 `set_avatar` 换；**读档直接落到大地图时没有剧情跑**，
 * 得靠这两个常量补上，否则是个大人站在大地图上。
 */
export const WORLD_MAP = 'MP3001';
export const WORLD_MAP_AVATAR = 1;

export const SHARED_EVENT_MAP = 'MP0000';

/** 用户2026-09-20要求恢复阴影。地图对象服从SCI.DisplayShadow，共享人物显式启用。 */
export const SHOW_SHADOWS = true;

/**
 * **败阵（game over）**：`MP0000` 槽 9。
 *
 * 全槽只有 6 条 —— `play_audio 31 → play_movie 10（黑底红字「敗降」）
 * → fade_out → op141 → end`，末尾那条 `op141` 全库 3 处都是「影片之后回主菜单」。
 * 判据与推断都写在 `systems/defeat.js` 的文件头。
 */
export const DEFEAT = Object.freeze({
  map: SHARED_EVENT_MAP,
  slot: 9,
});

/** 标题前长片头由TitleScene播放；新章初始运行包含梦境影片的整段脚本。
 * 不保存指令下标：归档/补丁的片头指令数量不同，硬编码5会落到end。
 */
export const OPENING = Object.freeze({ slot: 8, dreamMovie: 3 });

/**
 * 标题画面。素材与判据见 `scenes/TitleScene.js`。
 *
 * ⚠️ **坐标是量出来的**：三个选项素材的原作图层坐标都是 `(-74,-19)`，
 * 是相对某个基准点的负偏移，基准点由 exe 算、拿不到。这里几个数照
 * 用户提供的原作截图量（截图 1600×1200，选项中心 x≈800、
 * 三行 y≈795/895/995，按 640/1600 折算）。见 `docs/状态/复现度台账.md`。
 */
export const TITLE = Object.freeze({
  background: 'MEN9300',
  options: ['MEN9301', 'MEN9302', 'MEN9303'],  // 新章初始 / 前歷再續 / 返回太虛
  // ⚠️ 这几个数是**锚点**，不是文字中心 —— 素材的层偏移要算进去：
  // 金字那层（`add`）画在 `锚点 + (34, 1)`、尺寸 106×30，所以文字中心
  // 落在 `锚点 + (87, 16)`。要让文字中心在截图量出的 (320, 318)，
  // 锚点就得是 (233, 302)。改坐标时改这里，别去动素材。
  centerX: 233,
  firstY: 302,
  gapY: 40,
  /** 金字中心相对锚点的纵向偏移（见上）；鼠标按「文字中心 ± 半个行距」判定，各帧的 69 高框相邻会重叠 29 像素。 */
  textCenterY: 16,
  /** 片头影片编号（`MP0000` 槽 8 子事件 0 的 `play_movie 1`）。 */
  introMovie: 1,
  /**
   * 标题画面的 BGM。
   *
   * **`fight/Audio/Mp3/Music000.mp3`（24.0 秒）** —— 用户听辨确认。
   * 由 `tools/export_music.py --fight-audio` 导成 `audio/title.mp3`。
   *
   * ⚠️ **原作的音乐不止 `Music/Music.DAT` 一处。** `fight/Audio/Mp3/` 下
   * 另有七首 `MusicNNN.mp3`，与 `Music.DAT` 的编号毫无关系。我一度只扫了
   * `Music.DAT`，据此断言「32 号是全库唯一 20 秒左右的曲子」并拿它当标题曲 ——
   * 判据本身是假的。见 `CLAUDE.md` 判据表「说『全库唯一』之前」那一条。
   */
  bgmKey: 'bgm-title',
  bgmFile: 'title.mp3',
  /**
   * 读档页素材。`MEN9304`：帧 0 是 640×480 底图、帧 1/2 是 602×93 的
   * 存档条（表头「地點/等級/日期/時間」与「未記錄」），与 `MEN8001` 同构。
   *
   * ⚠️ **读档页必须留在标题这一侧**。先前是「进游戏再打开天书页」，
   * 于是选完「前歷再續」会先闪一下卧室、还响起卧室的 BGM ——
   * 原作读档时画面上什么都没有。
   */
  loadPage: 'MEN9304',
  /** 存档行和翻页箭头坐标复用menus.json的天书布局。 */
  slotsPerPage: 4,
  /**
   * 翻页箭头的素材，**与天书页同一份**。
   * ⚠️ 不要加进 `BootScene` 的 `TITLE_ASSETS` —— 它们由 `queueMenuSheets()`
   * 按 `menus.json` 载成 spritesheet，重复排会和 multiatlas 抢同一个键。
   */
  arrows: ['MEN8004', 'MEN8005'],
  /** 仅加载失败时显示错误；正常读档页不叠加操作提示。 */
  hintY: 471,
  /**
   * 未选中的记录条画成半透明 —— **原作只有「有记录 / 未記錄」两张图，
   * 没有第三张「选中」图**，高亮只能靠透明度。7/16 这个值来自
   * `menus.json` 的 `tianshu.row.alpha`（天书页同一张条的实测值）。
   */
  slotDimAlpha: 0.4375,
  /**
   * 记录条上各字段的落位，**沿用天书页量好的那一套**
   * （`menus.json` 的 `tianshu.slots`），只有「等級/」这一处要挪。
   *
   * 判据：把两张条的墨色列扫出来比 —— 第二行（日期/年/月/日/時間/：）
   * **逐段完全一致**；第一行只有「等級/」不同，`MEN8001` 在 459~502、
   * `MEN9304` 在 429~472，**整整差 30px**。所以等级的 x 是 508 − 30。
   */
  slotLevelX: 478,
  /** 跳过片头：原作是右键；本项目其余操作都是键盘，两边都留。 */
  skipKeys: Object.freeze(['Space', 'Escape', 'Enter']),
  confirmKeys: Object.freeze(['SPACE', 'ENTER']),
  /**
   * 选中动画：32 帧。**未选中停帧 0（无框），选中播到帧 31（黑框）** ——
   * 判据是 multiply 层的亮度，见 `scenes/TitleScene.js`。
   * 帧速走 `FieldSprite` 自己那套（`dur` 字段），这里不再另定。
   */
  quitFadeMs: 600,
});

/** 对话框界面元素（tools/export_ui.py 的产物目录名）。 */
export const UI_KEYS = Object.freeze({
  talk: 'F-TALK',
  name: 'F-NAME',
  float: 'F-FLOAT',
  yesno: 'F-YESNO',
});

/**
 * 需要预载的对白立绘，按人物代码（`tools/export_portrait.py` 的产物目录名）。
 *
 * 名字查 `Sys.dat` 的 `Namelist.lis`：
 * `1 夏侯儀 / 2 封玲笙 / 3 冰璃 / 76 白髮少女`。
 *
 * ⚠️ **冰璃要两份。** 她在被认出名字之前，脚本用的是 `76 白髮少女`
 * （`MP0303` 槽 10、`MP0304` 槽 10 的第 162/165 条都是 76），
 * 认出之后才换成 `3 冰璃`。只导 3 的话「你沒事吧？」那几句仍然没有立绘。
 *
 * ⚠️ **这份只是 L0 常驻的那几个，不是全集。**（2026-09-11 起）
 * 55 个角色的立绘**已经全部导出**（`portraits/index.json` 是清单），
 * 其余的走**按需加载**：`loader.portraitCodes` 进图前扫该图脚本里出现的
 * `speaker` 再排队，与 `bgmTracks` 同构。
 *
 * 这里留这四个是因为**他们随时可能说话**（主角与固定队友），
 * 而 35 MB 全进 L0 会把开局拖慢 —— 那正是按需加载要避免的。
 *
 * 泛称配角（西夏士兵、神秘客…）原作的立绘文件就是 20220 字节的空壳，
 * 说话时本来就不显示立绘；`index.json` 里不会有他们。
 */
export const PORTRAIT_CODES = Object.freeze([1, 2, 3, 76]);

/** 立绘清单（`export_portrait.py --all` 的产物）：代码 -> 人名。 */
export const PORTRAIT_INDEX_KEY = 'portrait-index';

/**
 * 主角与队友的场景行走精灵。
 * 这批素材不在地图归档里，而在共享库 Sys/Sys.dat，
 * 由 tools/export_party.py 导出，因此要单独排进加载队列。
 */
export const PARTY_SPRITES = Object.freeze([
  'XIAHOUYI', 'BINGLI', 'FENGLINGSHENG',
]);

/**
 * `set_avatar`（op68「切换角色行走形象」）的代码 → 行走精灵。**兜底表**。
 *
 * ⚠️ **正本是 `assets/data/avatars.json`**（`tools/export_party.py` 从
 * 共享库的 **`MAINNPC.SCI`** 生成，那张表 5 条、下标就是 `set_avatar` 的代码）：
 *
 *     0 飛龍 Dragon.SF2 | 1 小夏侯儀 s1.SF2 | 2 dead 9.sf2
 *     3 大夏侯儀 1.SF2   | 4 霍雍 7.SF2
 *
 * 这里只留一条主角作兜底，免得 json 拉不到时连人都没有。
 *
 * ⚠️ 此前这张表是**手填的**，只有 `{3: 'XIAHOUYI'}`，注释写着其余四个
 * 「没有判据」—— 判据一直躺在 `MAINNPC.SCI` 里，没人去读。后果是
 * **大地图上主角还是城镇那个大形象**：`s1.SF2` 帧 `20×51`，
 * `1.SF2` 是 `36×90`，正好一半。全库 61 处「进大地图」都写着 `set_avatar 1`。
 */
export const AVATAR_SPRITES = Object.freeze({
  3: 'XIAHOUYI',
});

/** `avatars.json` 在 Phaser json 缓存里的键。 */
export const AVATARS_KEY = 'avatars';

/**
 * 大地图用的小形象 —— **必须预载**。
 *
 * `set_avatar` 紧跟在 `goto_map` 后面，而切图是 `scene.restart()`：
 * 换形象时没有机会再去拉资源，精灵不在缓存里就只能保持原样。
 */
export const AVATAR_PRELOAD = Object.freeze(['XIAHOUYI_S']);

/**
 * **剧情脚本里的事物名 → 队友精灵。**
 *
 * ⚠️ 队友在剧情里是按**繁体名**点的（`actor_show{name:"封鈴笙"}`），
 * 而他们的精灵**不在地图归档里**，在共享库 `Sys/Sys.dat`。
 * 没有这张表的话，脚本让封铃笙出场，场上什么都不会出现 ——
 * 而且不报错，看起来就是"剧情在自言自语"。
 *
 * `大夏侯儀` 是主角在剧情里的名字（对应 `op104` 切换行走形象的 03 号）。
 */
export const CUTSCENE_SPRITES = Object.freeze({
  大夏侯儀: 'XIAHOUYI',
  夏侯儀: 'XIAHOUYI',
  封鈴笙: 'FENGLINGSHENG',
  冰璃: 'BINGLI',
});

/**
 * 旧状态页的素材清单曾经在这里（`STATUS_IMAGES` / `STATUS_TABBARS` / …）。
 *
 * **已随旧实现一起搬到 `deprecated/`。** 八页菜单的素材与摆位现在全部来自
 * `assets/menus/menus.json`，由 `tools/export_menu_ui.py` 从原作 exe 导出，
 * 清单是数据不是常量，所以这里不再有对应的表。见 `ui/menuSpec.js`。
 */

/**
 * 原作24×24字模；源文本保留Big5解码后的码位，换字库改变字形。
 * 通用图集是白字，可用setTint；对白图集已含原作深/浅棕双色，不再tint。
 * 官方繁体为默认，简体资源保留；完整语言设置还需要切换带字的菜单图片。
 * 索引、源文件与绘字依据见docs/专题/简繁体.md。
 */
export const FONTS = Object.freeze({
  简: { key: 'yc24s', texture: 'assets/font/yc24s.png', data: 'assets/font/yc24s.xml',
    dialogueKey: 'yc24s-dialogue', dialogueTexture: 'assets/font/yc24s-dialogue.png',
    dialogueData: 'assets/font/yc24s-dialogue.xml' },
  繁: { key: 'yc24', texture: 'assets/font/yc24.png', data: 'assets/font/yc24.xml',
    dialogueKey: 'yc24-dialogue', dialogueTexture: 'assets/font/yc24-dialogue.png',
    dialogueData: 'assets/font/yc24-dialogue.xml' },
});

/** 默认官方繁体；标题页语言选择同步切换字库与UI图片。 */
export const FONT_KEY = FONTS[LANGUAGE].key;
export const DIALOGUE_FONT_KEY = FONTS[LANGUAGE].dialogueKey;

/** 字号。**只能是 24** —— 点阵字不能缩放，见上。 */
export const FONT_SIZE = 24;


/**
 * ⚠️ **战斗地面与战斗 BGM 都不在这里了**（2026-09-13）。
 *
 * 两者都由**遇敌群**决定（`战斗背景地图` → `FLR60xx`、`战斗音乐` → 四档曲子），
 * 解析在 `systems/encounter.js`。写死在 config 里的那两个常量是这条 bug 的形状：
 * `FLOOR_KEY='FLR000'` 是**量格盘用的格线图**、`BGM_FILE='zhanzhen.mp3'`
 * **逐字节等于 `Music030`**（强敌级），于是每场仗都在调试图上、放同一首曲子。
 */
export const BGM_VOLUME = 0.45;

/**
 * 地图背景音乐。曲目号 → `public/audio/` 里的文件。
 *
 * 曲目号来自每张图的 `MPMP<图号>.SCI` 的 `0x331`，`export_map.py` 已写进
 * `map.json` 的 `bgm` 字段。
 *
 * ⚠️ **这张表要拿数据反查求差集**，不要只列「当前 demo 用到的」——
 * 兰州城那一轮只导了 6 首（1~5、7），于是**河州镇一进去就没有音乐**
 * （它用的是 6 号）。现在按 307 张图实际用到的号全导：
 * `python3 tools/export_music.py <Music.DAT> game/public/audio --tracks <号,号,…>`
 * 回归 `config.test.js` 盯着「每张图要的曲目都在表里」。
 *
 * 大于50的编号是剧情变量（官方4032da→44b0d0），变量值才是曲号。
 * 例如楼兰91在Save009/010中为19，随剧情也会改为5、18或31。
 * 由bgm.resolveBgmTrack统一解析，不能给91~98伪造文件或当成静音标记。
 *
 * ⚠️ **表里要连「剧情切的曲子」一起反查**（`play_audio kind=0`）。
 * 先前只按「哪张图用哪首」求过差集，于是 **8/12/21/23 四首没导** ——
 * 而 `playBgm` 收到不存在的 key 会**原样返回、不换曲**，表现正是
 * 「从兰州城到废屋到出来，全程一首曲子」。12 号被 28 处剧情用到，
 * 河州镇出村那一声就是它。
 *
 * ⚠️ **31 号没有完整曲子**：`31.MP3` 只有 1.0 秒、`31.WAV` 1.96 秒，
 * 两个都是短件。13 张图与 10 处剧情用它，只能循环播这段短的。
 * `export_music.py` 现在会自己发现「MP3 比同号 WAV 还小」并改用 WAV。
 */
export const BGM_FILES = Object.freeze({
  1:  'bgm1.mp3',          // 1 张图：MP3001…
  2:  'bgm2.mp3',          // 4 张图：MP0201A、MP0401、MP0701…，剧情切曲 9 处
  3:  'bgm3.mp3',          // 18 张图：MP0202、MP0205、MP0206…，剧情切曲 1 处
  4:  'bgm4.mp3',          // 27 张图：MP0212、MP0501、MP0502…，剧情切曲 15 处
  5:  'bgm5.mp3',          // 1 张图：MP0907…，剧情切曲 54 处
  6:  'bgm6.mp3',          // 7 张图：MP0101、MP0102A、MP0102B…
  7:  'bgm7.mp3',          // 30 张图：MP0301、MP0301A、MP0302…，剧情切曲 13 处
  8:  'bgm8.mp3',          // 剧情切曲 12 处
  9:  'bgm9.mp3',          // 6 张图：MP0901、MP0902、MP0903…
  10: 'bgm10.mp3',         // 19 张图：MP1403、MP1404、MP14041…
  11: 'bgm11.mp3',         // 8 张图：MP0605、MP0606、MP0607A…，剧情切曲 7 处
  12: 'bgm12.mp3',         // 剧情切曲 28 处
  13: 'bgm13.mp3',         // 7 张图：MP0104、MP0104A、MP0107A…，剧情切曲 12 处
  14: 'bgm14.mp3',         // 13 张图：MP1600B、MP1603A1、MP1603A2…，剧情切曲 1 处
  15: 'bgm15.mp3',         // 5 张图：MP1801、MP1803-1、MP1803-2…，剧情切曲 1 处
  16: 'bgm16.mp3',         // 12 张图：MP0806、MP1501、MP1502…
  17: 'bgm17.mp3',         // 7 张图：MP1103A、MP1103B、MP1103C…，剧情切曲 3 处
  18: 'bgm18.mp3',         // 15 张图：MP1001I、MP1002A1、MP1002A2…，剧情切曲 4 处
  19: 'bgm19.mp3',         // 楼兰等地图的音乐变量91：原作Music.DAT/19.MP3
  20: 'bgm20.mp3',         // 2 张图：MP1002G、MP2003…
  21: 'bgm21.mp3',         // 剧情切曲 2 处
  22: 'bgm22.mp3',         // 24 张图：MP1009A、MP1009B、MP1009C…，剧情切曲 5 处
  23: 'bgm23.mp3',         // 剧情切曲 4 处
  24: 'bgm24.mp3',         // 2 张图：MP2401、MP2409L1…
  31: 'bgm31.wav',         // 13 张图：MP0106、MP0209、MP0607B…，剧情切曲 30 处
});

/**
 * 音效（`play_audio` 的 `kind=1`）。曲目号 → `Music.DAT` 里的 `<号>.WAV`。
 *
 * ⚠️ **拿数据反查**：全库 `play_audio kind=1` 点到 **31 个编号**，
 * 而这里一度只列了兰州城 demo 七张图用到的 **8 个** —— 缺的 23 个里
 * 就有马蹄声（24 号，13.1 秒）。`cutscene.js` 用 `cache.audio.exists()`
 * 兜底，缺了不报错也不提示，只能靠这张表自己对齐。
 * （`0` 号在归档里不存在，多半是「停止」的意思，留空即可。）
 */
export const SFX_FILES = Object.freeze({
  1:  'sfx1.wav',      // 4 处
  2:  'sfx2.wav',      // 36 处
  3:  'sfx3.wav',      // 17 处
  4:  'sfx4.wav',      // 171 处
  5:  'sfx5.wav',      // 106 处
  6:  'sfx6.wav',      // 29 处
  7:  'sfx7.wav',      // 1 处
  8:  'sfx8.wav',      // 1 处
  9:  'sfx9.wav',      // 1 处
  10: 'sfx10.wav',     // 1 处
  11: 'sfx11.wav',     // 12 处
  12: 'sfx12.wav',     // 9 处
  13: 'sfx13.wav',     // 60 处
  14: 'sfx14.wav',     // 30 处
  15: 'sfx15.wav',     // 51 处
  16: 'sfx16.wav',     // 1 处
  17: 'sfx17.wav',     // 131 处
  18: 'sfx18.wav',     // 54 处
  19: 'sfx19.wav',     // 1 处
  20: 'sfx20.wav',     // 37 处
  21: 'sfx21.wav',     // 3 处
  22: 'sfx22.wav',     // 2 处
  23: 'sfx23.wav',     // 3 处
  24: 'sfx24.wav',     // 11 处
  25: 'sfx25.wav',     // 1 处
  26: 'sfx26.wav',     // 10 处
  27: 'sfx27.wav',     // 2 处
  29: 'sfx29.wav',     // 2 处
  30: 'sfx30.wav',     // 1 处
  31: 'sfx31.wav',     // 1 处
  // ⚠️ **32 号不在 `Music.DAT` 里** —— 归档的 WAV 只到 31。它是**散装文件**
  // （`Music/32.wav` 与 `Map/Music/32.wav`，两份相同，2001-11-15 比归档晚），
  // 与地图那边的散装补丁是同一个模式。`export_music.find_loose` 负责回落。
  32: 'sfx32.wav',     // 3 处（MP2409B 槽 9/10、MP2409C1 槽 9）
});

/**
 * 对话语音 TTS（需求文档 §4.5）。
 * API_BASE 是开发期直连后台（CORS 已放行）；`/synthesize` 返回
 * `{code, msg, data:{audioBase64}}`（§2.1 实测），请求体见 `systems/tts.js`。
 */
export const TTS_CONFIG = Object.freeze({
  /** 后端网关地址（开发期直连，CORS 已放行）。 */
  API_BASE: 'https://hk.anlinxi.top/gateway/have-fun-native/tts',
  /** 语速倍率，1.0 = 正常。 */
  SPEED: 1.0,
  /** 合成音频格式（后端返回的 audioBase64 解码后即此格式）。 */
  FORMAT: 'mp3',
  /** 进图预合成开关（§7）。 */
  PREWARM_ON_MAP_ENTER: true,
  /** 预合成并发数（§7：2 并发，避免抢带宽）。 */
  PREWARM_CONCURRENCY: 2,
  /** 单图预合成总量上限（§7：≤60 条/图）。 */
  PREWARM_LIMIT: 60,
  /** 客户端语音缓存 LRU 上限（§6：200）。 */
  REQUEST_CACHE_LIMIT: 200,
});

// ⚠️ `MP0208`（废屋内）的 SCI 里**没有 BGM 编号**，`map.json` 的 `bgm` 是 null。
// 那不是漏导 —— 原作进废屋就是沿用上一张图的曲子（`playBgm` 收到空 key 会
// 原样续放）。别为了"补齐"给它随便指一首。

/** 幽城术语，界面文案一律照搬原作用词。 */
export const TERMS = Object.freeze({
  hp: '命',
  qi: '气',
  attack: '攻击',
  guard: '防御',
  skill: '绝技',
  qi: '气',
  spell: '咒法',
  victory: '战胜',
  defeat: '力竭',
});

/**
 * 参战单位。素材键对应 public/assets/<key>/。
 *
 * ── 战场坐标约定（改动战场布局前务必先读）──
 * SF2 图层坐标是原作 640x480 战斗画面的绝对坐标，每个动画都按
 * 「单人构图的基准位」绘制：我方素材基准位约 (322,228)，
 * 敌方素材基准位约 (270,210)。两者仅相距约 50px，直接并排会重叠。
 *
 * 关键：**特效素材是按敌方基准位设计落点的**
 * （如我方普攻特效 EFFA0010 中心 (277,222)，正落在敌方基准位上）。
 * 因此敌方一律保持 offset 为 0，特效才会自然命中；
 * 只把我方沿等距方向前移，避免两边挤在一起。
 *
 * 要调整战场布局时：改我方 offset 是安全的；
 * 动敌方 offset 会让所有特效脱靶，除非同时补偿 playEffect 的落点。
 */
export const UNITS = Object.freeze([
  {
    id: 'xiahou',
    name: '夏侯仪',
    side: 'ally',
    stand: 'STN0010',
    attack: 'ATT0010',
    hurt: 'HIT0010',
    guard: 'DEF0010',
    move: 'MOV0010',
    victory: 'END0010', levelUp: 'LUP0010',
    attackType: 'melee',
    loadout: ['护身匕首'],
    skills: ['shehunguizhao', 'lihuoshenjue'],
    // 我方沿等距方向前移到近处，敌方留在基准位
    offsetX: 64,
    offsetY: 58,
    depth: 20,
  },
    {
    // 第二个我方单位。**光看一个人是判断不出阵型的** —— 兵和主角各站一边，
    // 左右关系全靠脑补；两个人一摆，队形是横排还是纵列一眼就分得清。
    // 她也正是废屋那一战真正会上场的队友。
    id: 'fengling',
    name: '封铃笙',
    side: 'ally',
    stand: 'STN0030',
    attack: 'ATT0030',
    // ⚠️ 这一行原先写的是 `HIT0010` —— **夏侯仪的受击素材**。
    // 后果：封铃笙挨打时画面上倒下去的是夏侯仪。
    // `HIT0030`/`DEF0030`/`MOV0030`/`END0030` 归档里一直都有，只是没导。
    hurt: 'HIT0030',
    guard: 'DEF0030',
    move: 'MOV0030',
    victory: 'END0030', levelUp: 'LUP0030',
    attackType: 'melee',
    loadout: [],
    skills: [],
    depth: 20,
  },
{
    id: 'soldier',
    name: '西夏兵',
    side: 'foe',
    stand: 'STN1030',
    attack: 'ATT1030',
    hurt: 'HIT1030',
    attackType: 'melee',
    loadout: [],
    offsetX: 0,
    offsetY: 0,
    depth: 12,
  },
]);


/** 人物代码与官方动作编号对应；移动/归位/默认施法另读Api字段。
 * 代码2为冰璃、3为封铃笙；旧“2/3互换”注释已失效。
 * 导出侧对应表在tools/export_battle_art.py。
 */
export const PARTY_ART = Object.freeze({
  1: '0010',   // 夏侯儀
  2: '0020',   // 冰璃
  3: '0030',   // 封鈴笙
  4: '0040',   // 慕容璇璣
  5: '0050',   // 古倫德
  6: '0060',   // 葛雲衣
  7: '0070',   // 霍雍
});

/** 我方战斗包；原记录指定NULL的动作不靠编号猜造。 */
export function partyArtKeys(code, character = null) {
  const art = PARTY_ART[Number(code)];
  if (!art) return null;
  return {
    stand: `STN${art}`, attack: `ATT${art}`, hurt: `HIT${art}`,
    guard: `DEF${art}`,
    move: character && '移动动作' in character ? character.移动动作 : `MOV${art}`,
    victory: `END${art}`, levelUp: `LUP${art}`, cast: character?.默认施法动作 ?? null,
    // ⭐ **蓄劲（RED）、落空（MIS）、走回（BAK）也要列进来** —— 它们是
    // 出招演出的几个阶段，缺一个的表现是「那一段人站着不动」而**不报错**。
    // `RED` 是蓄劲：判据是绝学记录的 `蓄劲动作` 字段解出来就是 `RED00X1`
    // 那种（`Firttech.enc +156`，字段名抄自 exe 规格区）。
    charge: `RED${art}`, miss: `MIS${art}`,
    back: character && '归位动作' in character ? character.归位动作 : `BAK${art}`,
  };
}

/**
 * 战斗顶部状态条里，这个人的**头像是第几帧**（素材 `ITF0002`，8 帧）。
 *
 * **帧号 ＝ 战斗素材编号 / 10 − 1**（`0010`→帧0、`0020`→帧1、…、`0080`→帧7）。
 *
 * 判据：把八帧渲染出来与用户提供的原作战斗截图逐个比对 ——
 * 帧0 绿褐发男（夏侯儀）/ **帧1 白发女（冰璃）** / **帧2 蓝发额有红点（封鈴笙）** /
 * 帧3 棕红发额有红点（慕容璇璣）/ 帧4 咧嘴金发汉子（古倫德）/
 * 帧5 棕发眨眼少女（葛雲衣）/ 帧6 蓝发男（霍雍）/ 帧7 白发女（冰璃另一形态）。
 *
 * 人物代码顺序与PARTY_ART一致：冰璃代码2取帧1，封铃笙代码3取帧2。
 */
export function partyPortraitFrame(code) {
  const art = PARTY_ART[Number(code)];
  if (!art) return null;
  return Number(art) / 10 - 1;
}


/**
 * 单独进战斗（场景里按 B、或战斗场景自己重启）时打哪一场。
 *
 * ⚠️ **这是「遇敌群」编号，不是遇敌组**（2026-09-13 订正，见 `systems/encounter.js`）。
 * 群 1 =「迦夏之窟洞外」的**遭遇池**（十个组，随机抽一个），背景 `FLR6008`
 * 洞口岩地、音乐 0 档、逃跑率 30。剧情战斗由 `op55` 自己带群号进来，不走这个缺省值。
 */
export const DEMO_SWARM = 1;


