import { entryLayer, footprintFitsMask, footprintMisses, isOffstagePoint } from '../systems/mapLayers.js';
import { confirmHint } from '../systems/inputHints.js';
import Phaser from 'phaser';
import { addHdImage, hdAssetScale, hdGroundKey } from '../hd/hdAssets.js';
import {
  FIELD_ENCOUNTER_KEY, FIELD_STEP_MS, createFieldEncounter, enterEncounterMap,
  advanceEncounter, fieldSwarm,
} from '../systems/fieldEncounter.js';
import FieldSprite, { RUN_STRIDE_PX, STRIDE_PX } from '../systems/FieldSprite.js';
import DialogueBox from '../ui/DialogueBox.js';
import MenuScreen from '../ui/MenuScreen.js';
import ShopScreen from '../ui/ShopScreen.js';
import InnScreen from '../ui/InnScreen.js';
import { createMember } from '../systems/partyState.js';
import { gameState, updateState, STATE_KEY } from '../systems/gameState.js';
import { switchableAvatars, nextAvatar, castKeyByName } from '../systems/avatarRoster.js';
import {
  applySaveBytes, buildSaveBytes, mapNameOf, SPEAKERS_KEY, SCRIPT_SOURCES_KEY,
} from '../systems/gameSave.js';
import {
  loadAllSlots, loadSlot, saveSlot,
} from '../systems/saveslot.js';
import { authGate } from '../systems/ycAuth.js';
import { downloadTsf, pickTsf } from '../platform/browserFiles.js';
import { useFolder, folderName, folderSupported } from '../systems/saveStore.js';
import { gateGuard, startGateWatch } from '../systems/authGate.js';
import {
  expGain, healParty, itemGain, itemLose, moneyGain, moneyLose,
  partyJoin, partyLeave, testEquip, testStat, learnStorySkill,
} from '../systems/storyActions.js';
import { flagsFromSave } from '../systems/savefile.js';
import { SHARED, sharedLine } from '../systems/itemUse.js';
import { itemKey } from '../systems/storyActions.js';
import { SAVEFILE_KEY } from './BootScene.js';
import OcclusionLayer, { spriteBox } from '../systems/occlusion.js';
import GhostLayer from '../systems/ghost.js';
import { readGround, readOcclusion, takeCollision } from '../systems/pixelMask.js';
import { colorKeyedTexture, DRIFT_TICK_MS } from '../systems/layerGround.js';
import { SNAPSHOT_KEY } from '../systems/battleShatter.js';
import { touchShape, hitsShape, clearShape, footprintShape, overlapsShapes } from '../systems/touchShape.js';
import {
  ambientLoop, directionFromVector, frameSpan, idleSegments, runSegment,
  screenFacing, standFrame, walkSegment,
} from '../systems/spriteLayout.js';
import { ROAM, advanceRoamer, createRoamer, giveUp } from '../systems/roam.js';
import { FlagStore, createRunner, movieSegmentStart } from '../systems/eventScript.js';
import {
  afterCutscene, cutsceneBusy, performCutscene, isHero,
} from '../systems/cutscene.js';
import { stateToReplay, asInstant } from '../systems/replayState.js';
import { mapBgmKey, muteBgm, playBgm, stopBgm } from '../systems/bgm.js';
import { prewarmMap } from '../systems/tts.js';
import { ensureMap, unloadExcept } from '../systems/loader.js';
import {
  AVATARS_KEY, AVATAR_SPRITES, CUTSCENE_SPRITES, DEFEAT, OPENING, SHARED_EVENT_MAP,
  WORLD_MAP, WORLD_MAP_AVATAR,
  STAGE_WIDTH, STAGE_HEIGHT, FONT_KEY, FONT_SIZE,
} from '../config.js';

/** 左上角地名：原标签的米色、底框透明度与内边距（界面适配，非原作）。 */
const HUD_INK = 0xe8d9b0;
const HUD_BOX_ALPHA = 0.63;
const HUD_PAD_X = 8;
const HUD_PAD_Y = 4;
import { isPartyWiped } from '../systems/defeat.js';
import DEPTH from '../systems/depths.js';
import { installFieldCameras } from '../systems/fieldCameras.js';
import { WIDE_MAX, cameraBoundsX, onStageViewChange, stageView } from '../systems/stageView.js';

/**
 * 场景漫游：在原作地图上行走、与 NPC 交谈、踩到触发线时演对白。
 *
 * 数据来自 tools/export_map.py：
 *   ground.jpg  原作地面美术（兰州城 3840x1440）
 *   map.json    尺寸、碰撞网格、场景对象、按事件槽归好的台词
 *
 * 对象和台词的对应关系来自原作的场景对象表（`NP場景001.SCI`）：
 * 每个对象自带 talk / touch 两个事件槽号，槽里的台词就是它该说的话。
 * 早先没找到这张表，只能按名字散列随便分配一段对白，几十个 NPC 说同一句。
 *
 * 通行取自原作 MB 层（物件在地面上的占地轮廓），**逐像素判定，不降采样**；
 * 遮挡取自 MK 层。两者的语义与编码见 tools/map_masks.py。
 *
 * 事件不再是「把一个槽的台词念完」，而是由 systems/eventScript.js 执行
 * map.json 的 `scripts`——带条件分支、旗标与切换地图的完整指令序列。
 */

const WALK_SPEED = 165;
/**
 * 跑步的移动速度（Shift 切换）。取行走的 1.8 倍——跑步段每朝向同样是 4 帧，
 * 倍率再高脚步就跟不上位移，人会像在冰上滑。
 */
const RUN_SPEED = Math.round(WALK_SPEED * 1.8);
// 原作 0x409918 为 100；2026-09-20 用户批准鼠标/键盘统一放宽到 140。
const INTERACT_RANGE = 140;
/**
 * 等距投影的纵横比。地面是 2:1 的菱形，纵向一步在屏幕上只有横向的一半，
 * 按屏幕轴等速移动会斜着穿瓦片、贴着墙走不动。
 * 实测：主城区里横向平均能走 288 像素，纵向只有 200。
 */
const ISO_RATIO = 0.5;
/** 站住不动多久才开始播待机动作。 */
const IDLE_DELAY_MS = 4000;
/** 朝下，作为初始朝向。 */
const FACING_DOWN = 0;
/**
 * 门在旗标里的两个状态码。**原作自己的存法**，判据见 `doorIsOpen`。
 * ⚠️ 别把它们当成布尔 —— `flag` 是**数值**，`0` 才是「不存在」。
 */
const DOOR_CLOSED = 254;
const DOOR_OPEN = 255;
/**
 * 黑幕一档速度对应的毫秒数。op83/op84 的 speed 实测取 2 与 4 两档
 * （进店 4、出城 2）。**档位到毫秒的换算未经实机核对**，取 60ms/档
 * 让进店那档落在 0.24 秒，观感上不拖沓；要调就调这一个数。
 */
const FADE_MS_PER_STEP = 60;
/** op1 的一个 tick。原作按帧计，场景以 60fps 跑。 */
const WAIT_MS_PER_TICK = 1000 / 60;
/** 角色贴图约一格半高，避免走到地图最上缘时人物整个出画。 */
const TOP_MARGIN = 40;
const EDGE_MARGIN = 12;
/** 出生点落在障碍里时，向外找落脚点的步长。 */
const SEARCH_STEP = 8;
/**
 * 移动时逐像素试探的步长。**必须 ≤1**，否则会跨过障碍线，见 `slideAxis`。
 * 取 1 时跑步一帧最多试 5 次，代价可以忽略。
 */
const STEP_PROBE_PX = 1;
/**
 * 原作一拍的整步位移（RPG.exe 0x40a160 初始化，0x40a570 按方向移动）：
 * 横竖 6+SCI[0x77]、斜向每轴 4+SCI[0x78]；跑步 9+SCI[0x79]、6+SCI[0x7a]。
 * 原作先整步挪到落点、再按落点判踩踏与阻挡（0x409690 → 0x409a50）。
 * 城里的大形象各加值为 0；大地图的小夏侯儀（MAINNPC.SCI 第1条）是 (-3,-2,-6,-4)，
 * 即走、跑都只有横竖 3、斜向 2。
 */
const ORIGINAL_STEP = { walk: { straight: 6, diagonal: 4 }, run: { straight: 9, diagonal: 6 } };
const WORLD_MAP_STEP = { walk: { straight: 3, diagonal: 2 }, run: { straight: 3, diagonal: 2 } };
/**
 * 大地图上的移动速度 = **原作的两倍**（项目约定 D-20，用户 2026-09-28 允许的不一致：原作太慢）。
 * 原作小夏侯儀一步 3px、跑与走同速；两倍即城里走路的速度（一步 6px），跑步也不另加速。
 */
const WORLD_MAP_SPEED_RATIO = 2 * WORLD_MAP_STEP.walk.straight / ORIGINAL_STEP.walk.straight;
/**
 * 按住 Ctrl 快进对话时，两次「推进一步」之间隔多久。
 *
 * ⚠️ **不能每帧推**：一帧一步的话整段剧情在半秒内跑完，玩家来不及松手，
 * 询问句虽然会停下、但停下前那几句根本没看见。60ms 大约是「文字飞快
 * 滚过、仍能看清在演到哪」。**这个数是我定的，原作值未知**，
 * 见 `docs/状态/复现度台账.md`。
 */
const SKIP_STEP_MS = 60;
/** 黑幕：出场就意味着「这一场结束了」，连对话框都不该再露出来。见 `depths.js`。 */
const CURTAIN_DEPTH = DEPTH.CURTAIN;

/*
 * ⚠️ 这里原先还有 `GHOST_ALPHA` / `GHOST_DEPTH` / `GHOST_MIN_COVERAGE` /
 * `GHOST_ACTORS` 一整套「半透明残影」，**2026-09-13 整套删掉了**：
 *
 *   · 三个数全是调出来的（台账里标着 🔴），阈值那条注释自己都写着「调不出来」；
 *   · 覆盖率只统计 **MK** 像素 —— 被「场景对象」（伞、城墙、木柱）挡住时
 *     恒为 0，于是人走到伞后面**整个消失、连残影都没有**；
 *   · 白名单只给主角和一个 `badguy`，而**原作截图里路人同样有**。
 *
 * 原作的做法是**点阵抖动**（把贴图按棋盘格抽掉一半画在最上层），
 * 判据是用户 2026-09-13 提供的凉州城集市原作截图。见 `systems/ghost.js`。
 */

/**
 * 场景对象表的类型字段（见 docs/专题/地图与场景.md）：**只有 5 是人物**，
 * 3 是入口热点、4 是触发线、0 是布景与出入口。
 *
 * 地面美术 `MP<图号>.JPG` 已经把整幅场景烘焙进去了，`NB`/`ND`/`NE`/`NG`
 * 这些布景对象的贴图**在地面图里已经有一份**。再画一遍就是重叠两层，
 * 差一点就露馅——马车尾部那块错位的贴图就是 `馬車後`(NB0212-32) 重画出来的。
 */
const KIND_CHARACTER = 5;
// SCI中剧情人物也可为kind=0；显式方向数表示行走演员，不能当建筑遮挡物。
const isCharacterActor = actor => actor.kind === KIND_CHARACTER || actor.dirs > 0;

/**
 * `Mouse`（SCI `+0x73`）的「门」。释义原文的枚举：
 * `0 无反应 / 1 放大镜 / 2 可拾取 / 3 对话 / 4 门 / 5 可放置`。
 *
 * **哪些对象是门，SCI 自己标好了**，不用看名字里有没有「出入口」。
 */
const MOUSE_DOOR = 4;
/**
 * SCI 的 `Mouse`（`+0x73`）枚举 → 交互提示上的动词。释义原文：
 * `0 無反應 / 1 放大鏡 / 2 可拾取 / 3 對話 / 4 門 / 5 可放置`。
 *
 * ⚠️ **提示里不写对象名。** 对象名是 SCI 里的内部标识（`badguy`、
 * `nn0304-03.SF2`、`門出入口`），印在屏幕上既不好看也不是原作的做法 ——
 * 原作是鼠标移上去换一个**图标**，压根没有名字；名字要等对话开起来，
 * 由姓名牌按**说话人代码**显示（见 `speakerName`）。
 * 而机关、门这类东西本来就一直没有名字。
 *
 * 这里退而求其次用文字动词（我们是键盘操作，没有鼠标图标那一套），
 * 但至少动词是**从数据里读的**，不是把内部名字漏出来。
 */
const MOUSE_VERB = Object.freeze({
  1: '查看', 2: '拾取', 3: '交谈', 4: '开门', 5: '放置',
});

/**
 * 事件号 → 事件槽号要减的偏置。
 *
 * 对象表的 `talk`/`touch` 已经由 `scene_table._event_slot` 减过了，
 * 但 **`.eve` 脚本里 `open_door` 带的 `event` 参数没有** —— 那是另一条路。
 *
 * 判据：全游戏 99 处 `open_door`，减 2 之后指向「含 `goto_map` 的槽」的有
 * **86 处**，不减只有 36 处。`MP0101` 的 `event=12` 减 2 是槽 10
 * （`fade_out → goto_map MP0102A → fade_in`，进自己家）；不减就跑成槽 12
 * ——那是**高老丈家**的门，于是在自家门口按空格弹出
 * 「還是先跟娘商量過出門買藥的事再說」。
 */
const EVENT_SLOT_BIAS = 2;

/**
 * 超过这个尺寸的贴图不是场景摆件，而是过场用的整屏素材
 * （`wagan` 用的 EVENT2-4 是 640x480 的车厢内景），
 * 无条件画出来会在地图上盖一大块黑。等接上脚本控制流再由事件决定显隐。
 * 人物精灵最大约 64x96，200 足够把两者分开。
 */
const PROP_MAX_SIZE = 200;

/** 目标图拉不到时退回哪张。⚠️ 必须是**一定导出过**的图，否则会来回 restart。 */
const FALLBACK_MAP = 'MP0212';

/** 夏侯仪。素材在 Sys/Sys.dat，由 tools/export_party.py 导出。 */
const PLAYER_SPRITE = 'XIAHOUYI';

/**
 * 主角与队友的绘制偏移。他们的精灵来自共享库、没有 SCI 记录，
 * 用通行的 `(-320,-260)`（屏幕中心的负值）。与 `FieldSprite` 的默认值一致。
 */
const PLAYER_DRAW = Object.freeze({ x: -320, y: -260 });

/** 判断一条精灵是不是过场用的整屏素材。 */
function isCutscenePiece(sprite) {
  return (sprite?.frames ?? []).some((f) => f.w > PROP_MAX_SIZE || f.h > PROP_MAX_SIZE);
}

/**
 * 切图加载超过多久才显示「载入中…」。
 *
 * ⚠️ 原作是本地读盘、几乎瞬间，**没有「加载中」这个画面**。加载本身藏在
 * `goto_map` 自带的黑幕里，多数时候玩家看不到；只有真的慢了才提示一声，
 * 免得看起来像卡死。这个阈值是手感值，见 `docs/状态/复现度台账.md`。
 */
const LOAD_HINT_MS = 400;

/** 镜头四周收进的像素，藏原作底图最外一行的白线，见 `create` 里 `setBounds`。 */
const CAMERA_EDGE_INSET = 1;

/** `await_actions` 的轮询间隔与总上限。 */
const ACTION_WAIT_STEP_MS = 30;
// ⚠️ **要留足余量。** 废屋那段「西夏兵冲进来」是 44 帧、合计 132 刻，
// 按 110ms/刻 就是 14.5 秒 —— 旧的 15000 差一点就误判成超时。
const ACTION_WAIT_MAX_MS = 30000;

/** op83/op84 的速度档位换算成黑幕时长。 */
function fadeMs(speed) {
  return Math.max(1, Number(speed) || 1) * FADE_MS_PER_STEP;
}

/**
 * 一个对象的**踩踏判定区**：它的精灵实际画出来的那个矩形。
 *
 * ## 为什么不是「离对象坐标 N 像素以内」
 *
 * 原作的出入口是**门槛那条线**，不是一个点 —— `tools/map_masks.py` 记着 MB 层
 * 「城墙沿墙根走、**门洞处绕开**」，门洞就是墙线上的一个开口，走进开口就进去了。
 *
 * 实测 705 个带 `touch` 的对象，精灵**中位尺寸 83×30**，正是一条门槛。
 * 此前用半径 110 的圆去替代它（**门槛条的 5 倍宽**），带来三个连锁问题：
 *
 * 1. **离门老远就切图** —— 圆比门大好几倍
 * 2. **站在门口反而进不去** —— `seedTouched` 把落地时压住的槽记下来，
 *    而玩家从没走出过那个大圆，于是永远不会「重新踩上」
 * 3. **两张图之间无限来回跳** —— 客厅的落点离厨房门只有 40px、落在圆内，
 *    厨房的落点离客厅门也在圆内，两边互相弹
 *
 * 判据：拿四个真实落点比对，圆判定有 4 处误命中，**矩形一处都不命中** ——
 * 原作把落点放在门槛外侧一步（`MP0102C` 的落点 x=170，门槛矩形右缘正好也是 170）。
 *
 * 摆位与 `FieldSprite` 完全一致：`对象坐标 + 绘制偏移(dx,dy) + 帧偏移(ox,oy)`。
 *
 * @returns {{x:number,y:number,w:number,h:number}|null} 取不到就 null，调用方退回圆
 */
function touchRectOf(o, data) {
  // 取第一个有尺寸的帧。⚠️ 帧 0 可能是空帧（`empty`）或影子，要跳过。
  const frame = (data?.frames ?? []).find((f) => f && f.w && f.h);
  if (!frame) return null;
  return {
    x: o.x + (o.dx ?? 0) + (frame.ox ?? 0),
    y: o.y + (o.dy ?? 0) + (frame.oy ?? 0),
    w: frame.w,
    h: frame.h,
  };
}

export default class FieldScene extends Phaser.Scene {
  constructor() {
    super('Field');
  }

  init(data) {
    this.mapId = data?.mapId ?? 'MP0212';
    this.encounterReturn = data?.encounterReturn === true;
    /** 由 op58 指定的入场落点，没有就用地图自己的出生点。 */
    this.entry = data?.entry ?? null;
    /** 只有「新游戏」会带这一项 —— 读档进来的不演开场。见 `playOpening`。 */
    this.opening = data?.opening === true;
    /**
     * 战斗打输了回来的。**战斗场景放不了影片**（`playMovie` 是 `FieldScene`
     * 的方法），所以败阵一律回到地图再演，见 `playDefeat`。
     */
    this.defeat = data?.defeat === true;
  }

  /**
   * 这张图若没有自己的事件表，该向哪张图借。静态表由
   * `tools/export_script_sources.py` 在导出期算出来（判据见那里）。
   * 不需要借、或表里没有，返回 null。
   */
  borrowedSource() {
    if (!this.cache.json.exists(`${this.mapId}-map`)) return null;
    const meta = this.cache.json.get(`${this.mapId}-map`) ?? {};
    if (Object.keys(meta.scripts ?? {}).length
        || Object.keys(meta.events ?? {}).length) return null;
    return this.cache.json.get(SCRIPT_SOURCES_KEY)?.来源?.[this.mapId] ?? null;
  }

  /** 要借的那张图还没加载？（`create()` 的入场闸靠它多兜一道） */
  borrowedSourceMissing() {
    const from = this.borrowedSource();
    return Boolean(from) && !this.cache.json.exists(`${from}-map`);
  }

  create() {
    // 防倒卖验证：进入游戏后启动 10 分钟周期验证（D4）。双定时器哨兵 + 前台
    // 切回补检在 authGate 内部实现，这里防重入（资源未到 restart 重进 create 时忽略）。
    startGateWatch(this);
    this.fieldCameras = installFieldCameras(this); // 宽屏视野：世界相机铺满，界面相机居中 640（没开时什么也不做）
    this.enteringBattle = false;
    this.leaving = false;
    // 新章初始在梦境结束前不显示卧室；脚本的淡出本身会先画出一帧地图。
    this.cameras.main.setAlpha(this.opening ? 0 : 1);
    if (this.opening) muteBgm(this, true);
    // ⚠️ **资源可能还没到。** 按需加载之后，`BootScene` 不再预载任何地图 ——
    // 进这张图的路子有两条：`enterMap`（自己会先 `ensureMap`）与
    // `scene.start('Field')`（按 M、或开局）。后者不经过 `enterMap`，
    // 所以这里兜一道：没到就先拉，拉完 `restart` 重来一遍。
    // 不兜的话 `meta` 是空对象，地图**画不出来也不报错**。
    if (!this.cache.json.exists(`${this.mapId}-map`) || !this.textures.exists(`${this.mapId}-ground`)
        || this.borrowedSourceMissing()) {
      this.loading = true;          // ⚠️ 必须置位：`update()` 靠它早退，见那里
      const label = this.showLoading();
      let shown = 0;
      // ⚠️ **必须延后一帧再启动 loader。** 在 `create()` 里同步调
      // `load.start()` 会让 Phaser 的场景 loader 卡在 loading 状态再也不完成
      // （它此刻还在 create 生命周期内）。延后一帧，等场景真正跑起来。
      this.time.delayedCall(0, () => {
        ensureMap(this, this.mapId, (v) => {
          shown = Math.max(shown, v);
          if (label.active) label.setText(`载入中… ${Math.round(shown * 100)}%`);
        }).then(() => {
          if (!this.cache.json.exists(`${this.mapId}-map`)) {
            console.warn(`${this.mapId} 拉不到，回落到 ${FALLBACK_MAP}`);
            this.scene.restart({ mapId: FALLBACK_MAP });
            return;
          }
          // ⚠️ **`opening` 也要带过去**：开局那张图几乎一定要走这条「先拉再
          // restart」的路，丢了它开场剧情就永远不会演。
          // ⚠️ **过场图还要把「借事件表的那张图」一并拉进来。**
          // 不拉的话 `inheritScripts` 拿不到它，出入口没有触发槽 ——
          // 「读档到打蝎子那张图之后再也出不去」。见 `borrowedSourceMissing`。
          const borrow = this.borrowedSource();
          const rest = borrow && !this.cache.json.exists(`${borrow}-map`)
            ? ensureMap(this, borrow) : Promise.resolve();
          rest.then(() => this.scene.restart({ mapId: this.mapId, entry: this.entry,
            opening: this.opening, encounterReturn: this.encounterReturn }));
        });
      });
      return;
    }
    this.loading = false;
    this.meta = this.cache.json.get(`${this.mapId}-map`) ?? {};
    const pendingLayer = this.registry.get('pendingScript');
    this.activeLayer = entryLayer(this.meta, this.entry,
      this.cache.json.get(`${pendingLayer?.map}-map`)?.scripts?.[String(pendingLayer?.slot)],
      pendingLayer?.cursor);
    this.layerViews = (this.meta.layers ?? [this.meta]).map((layer, i) => ({
      meta: layer, container: this.meta.layers ? this.add.container(0, 0).setDepth(i + 1) : null,
    }));
    this.allActors = null;
    this.encounterData = this.cache.json.get('field-encounters');
    this.encounterState = this.registry.get(FIELD_ENCOUNTER_KEY) ?? createFieldEncounter();
    enterEncounterMap(this.encounterState, this.mapId,
      this.encounterData?.maps?.[this.mapId], this.encounterReturn);
    this.registry.set(FIELD_ENCOUNTER_KEY, this.encounterState);
    this.encounterTime = 0;
    // ⚠️ `entry.facing` 来自事件指令，是**原作朝向编号**，要换算，见 `screenFacing`。
    this.facing = this.entry ? screenFacing(this.entry.facing) : FACING_DOWN;
    this.idleFor = 0;
    this.events = this.meta.events ?? {};
    this.scripts = this.meta.scripts ?? {};
    this.inheritScripts();
    // TTS：进图预合成当前图全部对白语音（含跨图继承的脚本），
    // 玩家开口第一句不用等首响。fire-and-forget，失败静默、不阻塞进图。
    prewarmMap(this.scripts);
    // ⚠️ **切图也要停循环音效。** 跨图续演时 `enterMap` 直接把 `runner`
    // 置空、**不走 `endScript`**，所以只靠那一处停不掉 —— 马车那段正是
    // 「上车（马蹄声起）→ 切到车厢 → 切到迦夏之窟外」，中间一次都没经过
    // `endScript`。⚠️ 这条是我定的：原作会不会让某个循环音效跨图持续，
    // 没有依据，见 `docs/状态/复现度台账.md`。
    this.stopLoopSfx();
    this.names = this.meta.names ?? {};
    /**
     * 当前正压在身上的触发槽。触发按**跨进去的那一刻**算，站着不动不会反复弹。
     *
     * 不能改成「触发过就永久拉黑」：兰州城的出生点 (3576,270) 就落在
     * 「右上城門入口」的判定框内，而从大地图走回来时人也正站在城门口——
     * 一进图就会被立刻弹走，两张图之间来回弹。入场时先把已经压住的槽
     * 记进来（见 seedTouched），人走开再回来才重新触发。
     */
    this.inside = new Set();
    /** 正在跑的事件脚本，null 表示没有剧情在演。 */
    this.runner = null;
    /** 正卡在 `await_actions` 上。这期间按键不推进脚本，见 `resumeScript`。 */
    this.waiting = false;
    /**
     * 演员表：事物名 → 对象。由 `systems/cutscene.js` 按需填充。
     * **必须随场景重建** —— 留着旧场景的对象会拿到已销毁的精灵。
     */
    this.cast = new Map();
    /** 镜头当前盯着谁；null 表示跟主角。剧情用 `camera_follow` 改它。 */
    this.cameraTarget = null;
    /** 对话框上正显示的那一句。 */
    this.line = null;
    /** 限时提示（如目标地图尚未导出），到点后让位给常驻操作提示。 */
    this.notice = null;
    /**
     * 「描述句演完之后该问玩家拿哪件道具」。见 `askForItem` / `askPendingItem`。
     * **必须随场景重建清掉** —— 留着旧槽号会在新图上跑错脚本。
     */
    this.pendingItemAsk = null;
    this.heldItem = null;
    this.blockMouseMove = false;
    this.playerPointerActor = null;

    // 剧情旗标跨地图存活：进店出店之后剧情阶段不该被重置
    // 旗标跨场景保持；**首次建立时用测试存档里的初值**。
    // 没有存档就全是 0，主线停在开局 —— 那时进废屋只切图不演剧情，
    // 是原作逻辑（废屋初遇要 flag1==8），见 savefile.flagsFromSave。
    this.flags = this.registry.get('flags')
      ?? new FlagStore(flagsFromSave(this.cache.json.get(SAVEFILE_KEY)));
    this.registry.set('flags', this.flags);

    this.mapWidth = this.meta.width ?? STAGE_WIDTH;
    this.mapHeight = this.meta.height ?? STAGE_HEIGHT;

    // 本图的曲子。药铺与客栈同为曲目 3，从一家走进另一家不会重头放，
    // 见 systems/bgm.js。
    if (!this.opening) playBgm(this, mapBgmKey(this.meta.bgm, this.flags));

    // 分层背景图（沙漠、楼兰云层、观星楼…）每层地面各画各的，见 buildLayeredGround。
    if (!this.meta.layeredGround) {
      // 高清（默认开，?hd=0 关）：有高清底图就显示它（按原尺寸），否则原图
      const hdKey = hdGroundKey(this.mapId);
      if (this.textures.exists(hdKey)) addHdImage(this, 0, 0, hdKey).setDepth(0);
      else this.add.image(0, 0, `${this.mapId}-ground`).setOrigin(0, 0).setDepth(0);
    }
    // 四周各收 1 像素：原作有 3 张底图最外一行带白线（MP0801/MP0801A 肃州城顶边、
    // MP2002A 呼延崇住处底边，原作 JPEG 自带），镜头卷到边上就露出来。
    // 地图不比画面大的那一向不收，否则反而露出 1 像素画外的黑边。
    const applyBounds = () => {
      const bx = cameraBoundsX(this.mapWidth, stageView().width, CAMERA_EDGE_INSET);
      const insetY = this.mapHeight >= STAGE_HEIGHT + 2 * CAMERA_EDGE_INSET ? CAMERA_EDGE_INSET : 0;
      this.cameras.main.setBounds(bx.x, insetY, bx.width, this.mapHeight - 2 * insetY);
    };
    applyBounds();
    this.sys.events.once('shutdown', onStageViewChange(applyBounds)); // 窗口宽高比变了，宽屏的边界跟着变

    // ⚠️ **卸掉更早的地图，保留当前图与上一张「不同的」图。**
    // 进店出店是最常见的回头路，卸了马上又要拉回来。精灵几乎不共享
    // （九张图 141 个精灵里只有 3 个被 2 张以上图用），所以整批卸是安全的。
    // 战斗回来、同图读档都会重建本图：不能因此把上一张图当成旧图卸掉 ——
    // 否则肃州城门口打完仗走出城，大地图已被卸，要黑屏重读（2026-09-28 用户报）。
    const trail = this.registry.get('mapTrail') ?? [];
    const kept = trail[0] === this.mapId ? trail : [this.mapId, trail[0]];
    this.registry.set('mapTrail', kept);
    unloadExcept(this, kept);

    // ⚠️ **切图时清掉遗留的影片层。** `<video>` 挂在画布的父元素上，
    // 不属于任何 Phaser 场景 —— `scene.restart()` 不会带走它，
    // 于是新地图会被一张停住的影片整个盖住（画面全黑/定格，也不报错）。
    this.movieEl?.remove();
    this.movieEl = null;
    this.input.keyboard.enabled = true;

    this.loadMasks();
    this.spawnObjects();
    this.collectDoors();
    this.spawnPlayer();
    // 顺序要紧：得先有对象的判定区和主角落点，才知道落地时压住了哪些槽
    this.seedTouched();
    this.buildHud();
    this.dialogue = new DialogueBox(this);

    this.cursors = this.input.keyboard.createCursorKeys();
    // ⚠️ **Shift 是开关，不是「按住」。** 用户要求：按一下切成跑，再按一下切回走。
    // 一直按着走长路太累，而原作那个手感我们本来也没有依据。
    // 状态跨切图保持（记在 registry 上）—— 每进一张图都退回走路会莫名其妙。
    this.input.keyboard.on('keydown-SHIFT', () => {
      if (!this.fieldInputAvailable()) return;
      const next = !this.registry.get('running');
      this.registry.set('running', next);
      this.notice = { text: next ? '跑' : '走', until: this.time.now + 900 };
    });
    // **Tab：换地图上操作的角色。⚠️ 原作没有**，见 `switchAvatar` 的说明。
    this.input.keyboard.on('keydown-TAB', (e) => {
      e?.preventDefault?.();                 // 别让浏览器把焦点挪走
      this.switchAvatar();
    });
    // 按住 Ctrl 快进对话（原作就有）。左右两个 Ctrl 都认。
    this.skipKey = this.input.keyboard.addKey(Phaser.Input.Keyboard.KeyCodes.CTRL);
    this.input.keyboard.on('keydown-SPACE', () => {
      if (this.statusScreen?.visible) { this.statusScreen.confirm(); return; }
      if (this.dialogue?.visible) { this.talk(); return; }
      if (this.fieldInputAvailable()) this.time.delayedCall(0, () => this.talk());
    });
    this.input.keyboard.on('keydown-ENTER', () => {
      // 先完成本次按键分派，避免新打开的剧情道具页立即收到同一次确认。
      if (!this.statusScreen?.visible) this.time.delayedCall(0, () => this.talk());
    });
    this.input.mouse?.disableContextMenu();
    this.input.on('pointerdown', p => this.fieldPointerDown(p));
    this.input.on('pointerup', p => { if (!p.rightButtonDown()) this.blockMouseMove = false; });
    this.input.on('gameout', () => { this.blockMouseMove = true; });
    // 选择句换选项。是/否框是竖排的（是上否下）、内嵌行选也是竖着一行一行，
    // 所以主用 ↑↓；←→ 一并收下，免得玩家按错。不在选择态时这四个键归走路，
    // `moveChoice` 自己会判断并返回 false。
    for (const [code, delta] of [['UP', -1], ['LEFT', -1], ['DOWN', 1], ['RIGHT', 1]]) {
      this.input.keyboard.on(`keydown-${code}`, () => this.dialogue?.moveChoice(delta));
    }
    this.buildStatusScreen();

    // 是带着黑幕切过来的。**有待续演的脚本就把幕交给它拉**（脚本里
    // `goto_map` 后面通常紧跟一条 `fade_in`），否则自己拉 ——
    // 两边都拉会闪一下，两边都不拉则进店全黑。
    // ⚠️ **败阵排在最前** —— 打输了回来的这一趟不该再续演剧情、也不该演开场。
    if (this.defeat) this.playDefeat();
    else if (this.registry.get('pendingScript')) this.resumePendingScript();
    else if (this.opening) this.playOpening();
    else if (this.resumeSavedRoom()) { /* 客房存档直接回客房，不能落在外面的关门中。 */ }
    else if (this.entry) this.cameras.main.fadeIn(fadeMs(4));
  }

  /** 整屏界面（菜单含天书、商店、客栈）开着？宽屏时两侧据此盖黑（fieldCameras.js）。 */
  fullScreenUiOpen() {
    return Boolean(this.statusScreen?.visible || this.shopScreen?.visible || this.innScreen?.visible);
  }

  resumeSavedRoom() {
    const event = this.entry?.resumeEvent;
    if (!(event > EVENT_SLOT_BIAS)) return false;
    const slot = event - EVENT_SLOT_BIAS;
    // 只接已查明的客房恢复；其他可恢复事件的原作语义仍需分别核定。
    if (!this.slotActions(slot)?.some(a => a.type === 'enter_room')) return false;
    this.entry.resumeEvent = 0;
    this.startScript(slot);
    return true;
  }

  /**
   * **败阵**：演 `MP0000` 槽 9，演完回主菜单。
   *
   * 这一槽就是原作的战败流程，我们**照搬着跑**，不自己编一套演出：
   * `play_audio 31 → play_movie 10（黑底红字「敗降」）→ fade_out → op141 → end`。
   * 末尾那条 `op141` 我们没实现成指令（那要动导出器），改用
   * `queueAfterScript` 接「回标题页」—— 判据见 `systems/defeat.js` 文件头。
   *
   * ⚠️ **缺什么都得走到主菜单。** 槽 9 不在缓存里（`MP0000` 没导）、
   * 影片没转码，都不能把玩家卡在一张血条为 0 的地图上 —— 直接回标题。
   */
  playDefeat() {
    this.pendingDefeat = false;
    // ⭐ **先把画面盖黑再演。** 槽 9 要先过 `op102` 与 `play_audio 31`
    // 才轮到 `play_movie`，这中间地图一直亮着 —— 用户报的「死了之后播放
    // 败阵之战，中间有一段间隙会显示当前的游戏画面」就是这几百毫秒。
    // 影片是盖在 canvas 之上的 DOM `<video>`，所以这张幕不会挡住它。
    this.blackout();
    // ⚠️ **续演的挂单要清掉。** `pendingScript` 存在 registry 上，
    // 跨场景不会自己消失 —— 留着的话下一局新游戏一进图就会接着演上一局
    // 死在半截的那段剧情。同一个病根在「读档没清 `avatarCode`」上犯过。
    this.registry.set('pendingScript', null);
    const script = this.cache.json.get(`${DEFEAT.map}-map`)?.scripts?.[String(DEFEAT.slot)];
    if (!script?.length) {
      console.warn(`败阵剧情跑不了：${DEFEAT.map} 槽 ${DEFEAT.slot} 不在缓存里`
                   + '（跑 tools/export_map.py 导 mp0000.DAT），直接回主菜单');
      this.returnToTitle();
      return;
    }
    this.queueAfterScript(() => this.returnToTitle());
    this.startScript(DEFEAT.slot, 0, DEFEAT.map);
  }

  /**
   * 回《幽城幻剑录》主菜单。
   *
   * ⚠️ **循环音效与地图 BGM 都要自己停。** `scene.start` 不会停 `sound`，
   * 留着的话标题页的曲子会和马蹄声叠在一起。
   */
  returnToTitle() {
    this.stopLoopSfx();
    stopBgm(this);
    this.scene.start('Title');
  }

  /**
   * **把整张画面盖黑**，盖到离开这个场景为止。
   *
   * 用在「接下来要演的东西不该让玩家看见地图」的场合（现在只有败阵）。
   * 用一张 `setScrollFactor(0)` 的黑矩形而不是 `camera.fadeOut(0)` ——
   * 后者会被剧情里任何一条 `fade_in` / `resetFX` 当场抹掉，
   * 而 `MP0000` 槽 9 后面正好有 `fade_out`，两套幕会互相打。
   *
   * ⚠️ 不用清理：出去的路只有 `scene.start`，它会销毁场景里的一切。
   */
  blackout() {
    if (this.curtain) return;
    this.curtain = this.add.rectangle(0, 0, WIDE_MAX, STAGE_HEIGHT, 0x000000) // 按最宽建，窗口变宽也盖得满
      .setOrigin(0, 0).setScrollFactor(0).setDepth(CURTAIN_DEPTH);
    this.curtain.ycFullStage = true; // 宽屏：盖满整个舞台宽并压在界面之上（fieldCameras.js）
  }

  /**
   * 开场剧情：`MP0000` 的槽 8，**两个子事件顺序演**。
   *
   * 片头影片（汉堂 LOGO + CG）→ 梦境影片 → 躺在床上 → 妈妈走过来叫起床
   * →「....是夢？」→ 交代把鸡汤送给高老丈 → 妈妈去厨房 → 起床下地。
   *
   * ⚠️ **脚本住在 `MP0000`，演出场地是这张图**（`MP0102B`）——
   * `startScript` 的第三个参数就是干这个的（长过场住在出发那张图里，
   * 废屋那一段同理）。`MP0000` 由 `BootScene` 预载进缓存。
   *
   * ⚠️ **不能一次跑整槽**：`index 4` 有一条 `end`，跑到那儿就收场了。
   * 那条 `end` 前面是没解出来的 `0x8D`，我们按 `end` 切段、顺序跑绕过去，
   * 见 `config.OPENING` 与 `docs/状态/复现度台账.md`。
   */
  playOpening() {
    const script = this.cache.json.get(`${SHARED_EVENT_MAP}-map`)?.scripts?.[String(OPENING.slot)];
    if (!script?.length) {
      console.warn(`开场剧情跑不了：${SHARED_EVENT_MAP} 槽 ${OPENING.slot} 不在缓存里`
                   + '（跑 tools/export_map.py 导 mp0000.DAT）');
      this.cameras.main.fadeIn(fadeMs(4));
      return;
    }
    // 取包含梦境影片的子事件，不依赖重导后可能变化的动作下标。
    const start = movieSegmentStart(script, OPENING.dreamMovie);
    this.startScript(OPENING.slot, start, SHARED_EVENT_MAP);
  }

  /**
   * 八页菜单（状态 / 法宝 / 绝学 / 及身 / 五内 / 阵形 / 天书 / 机舱）。
   *
   * ESC 开关；开着时 ←→ 切页、↑↓ 切人、点标签也能切页，角色不走动。
   * 摆位来自 `assets/menus/menus.json`，见 ui/menuSpec.js。
   *
   * 队伍状态建在场景里而不是全局：目前还没有存档，切地图本来就会重建。
   * 等接上背包与存档，这份 party 要提到跨场景的位置去。
   */
  buildStatusScreen() {
    const gamedata = this.cache.json.get('gamedata');
    if (!gamedata) {
      console.warn('gamedata.json 未加载，本场景不提供菜单');
      return;
    }
    // ⚠️ **队伍与背包挂在 registry 上，不挂在场景上。**
    // `goto_map` 走的是 `scene.restart()` —— 挂在场景上的话每换一张图就
    // 全部重建，在药铺买的羊皮卷轴走出门就没了。见 systems/gameState.js。
    const save = this.cache.json.get(SAVEFILE_KEY);
    // 目录的三张表。⚠️ **一定要传下去** —— 不传的话 `gameState` 会拿 `gamedata`
    // 去建目录，建出来是空的，读档的背包会被整份丢掉。见 gameState.js 的说明。
    const tables = {
      equipment: this.cache.json.get('equipment-full') ?? [],
      items: this.cache.json.get('items-full') ?? [],
      skills: this.cache.json.get('skills-full') ?? [],
    };
    let state;
    try {
      state = gameState(this, gamedata, save, tables);
    } catch (err) {
      console.warn('建队伍/背包失败，本场景不提供菜单：', err.message);
      return;
    }
    this.party = state.party;
    this.statusScreen = new MenuScreen(this, this.party, gamedata,
      tables.equipment, tables.items, tables.skills, save ?? null);
    // 购物界面与菜单共用同一份目录（跨物品/装备两张表查名字与售价）
    this.shopScreen = new ShopScreen(this, gamedata, this.statusScreen.catalog);
    this.innScreen = new InnScreen(this, this.statusScreen.catalog);
    this.wireSaveSlots();
    this.cullUnderMenu();
  }

  /**
   * 菜单盖满整屏时，这一帧只画菜单层及以上，底下的地图与人物跳过。
   * 不改任何对象的显隐，菜单一关就照常画。高清下沙州城菜单页 29 帧的原因之一（2026-09-30）。
   */
  cullUnderMenu() {
    const cameras = this.cameras;
    if (cameras.ycCullUnderMenu) return;
    cameras.ycCullUnderMenu = true;
    const visibleChildren = cameras.getVisibleChildren.bind(cameras);
    cameras.getVisibleChildren = (children, camera) => {
      const list = visibleChildren(children, camera);
      return this.statusScreen?.coversScreen?.() ? list.filter((o) => (o.depth ?? 0) >= DEPTH.MENU) : list;
    };
  }

  /**
   * op55：打一场。**拉起 `BattleScene`，打完回到这里接着演。**
   *
   * ⚠️ **与 `goto_map` 是同一套跨场景续演机制**（`pendingScript`）——
   * `battle` 后面通常还有话要说（蝎子那场打完是「沒想到在野外會有這麼
   * 恐怖的怪物....」），不存进度的话剧情断在开打那一刻，而且不报错。
   *
   * ⚠️ **`swarm` 是「遇敌群」编号，不是「遇敌组」**（2026-09-13 订正）。
   * 群里才有**战斗背景、战斗音乐、逃跑概率**，组只有敌人与战利品 ——
   * 读成组的后果是这三项永远取不到，而剧情战的群与组同号同名，
   * 所以**主线上一点都不报错**。解析交给 `systems/encounter.js`。
   */
  enterBattle(action) {
    if (this.enteringBattle) return false;          // 等截图回调的那一帧里别再进一次
    const swarm = Number(action?.swarm);
    if (!Number.isFinite(swarm)) {
      console.warn('battle: 没有遇敌群编号，跳过这一场');
      return false;
    }
    if (this.runner && !this.runner.done && this.script) {
      this.registry.set('pendingScript', {
        map: this.script.map,
        slot: this.script.slot,
        cursor: this.runner.cursor,
      });
    }
    this.runner = null;
    // 回程：**回到开打时站的那一格**，不是这张图的落点。
    const back = {
      mapId: this.mapId,
      encounterReturn: true,
      // 朝向用开打那一刻主角的实际朝向（换回原作编号；screenFacing 正反同式）。原先取“进这张图时的朝向”，
      // 水镜之殿打完赫兰铁汗后夏侯仪背对镜头——原作战后 actor_place 不改朝向，应保持战前脚本走位时的朝下（用户 2026-09-30）。
      entry: { x: this.playerPos.x, y: this.playerPos.y, facing: screenFacing(this.facing ?? FACING_DOWN), layer: this.activeLayer },
    };
    // ⭐ **`must_win` 与 `on_lose` 都要带过去。** 释义（op 0x37）：
    // 「必胜战斗」= 输了游戏结束；「非必胜战斗，胜则步入下一子事件，
    // **败则跳转到第 Z 个子事件**」。
    const start = () => this.scene.start('Battle', {
      swarm,
      returnTo: back,
      mustWin: action?.must_win ?? 1,
      onLose: Number.isFinite(Number(action?.on_lose)) ? Number(action.on_lose) : null,
    });
    // ⭐ 进战斗前把地图画面截下来：战斗加载期间挂着它，就绪后碎开（原作 FBX 玻璃破碎，
    // 见 systems/battleShatter.js）。截图要等下一帧渲染完才回调。
    if (this.textures.exists(SNAPSHOT_KEY)) this.textures.remove(SNAPSHOT_KEY);
    this.enteringBattle = true;
    this.game.renderer.snapshot((image) => {
      // 整屏截图：宽屏时战斗把它铺满舞台再碎开（battleCameras.js `coverWidth`）
      if (image instanceof HTMLImageElement) this.textures.addImage(SNAPSHOT_KEY, image);
      start();
    });
    return true;
  }

  /**
   * 把天书页接到 IndexedDB 上。
   *
   * ⚠️ **每次进场景都要重挂** —— `goto_map` 走的是 `scene.restart()`，
   * `MenuScreen` 是新建的，上一份的回调随旧对象一起没了。
   */
  wireSaveSlots() {
    const menu = this.statusScreen;
    if (!menu) return;
    menu.saveRestriction = () => this.activeLayer !== (this.meta.initialLayer ?? 0)
      ? '此層無法可靠讀回，請返回入口樓層後記錄。' : '';
    menu.saveNotice = () => this.notice?.save && this.time.now < this.notice.until
      ? this.notice.text : '';
    menu.onSave = (slot) => this.saveToSlot(slot);
    menu.onLoad = (slot) => this.loadFromSlot(slot);
    menu.onExport = (slot) => loadSlot(slot).then((bytes) => {
      if (!bytes) return;
      const name = downloadTsf(bytes, slot);
      this.notice = { text: `已导出 ${name}`, until: this.time.now + 2500 };
    });
    menu.onImport = (slot) => pickTsf().then((bytes) => {
      if (!bytes) return null;
      return saveSlot(slot, bytes)
        .then(() => loadAllSlots())
        .then((rows) => {
          menu.refreshSlots(rows);
          this.notice = { text: `已导入到第 ${slot + 1} 格`, until: this.time.now + 2500 };
        });
    });
    menu.onPickFolder = () => useFolder().then((ok) => {
      if (!ok) {
        this.notice = { text: folderSupported() ? '没有选文件夹' : '这个浏览器不支持选文件夹',
                        until: this.time.now + 3000 };
        return null;
      }
      this.notice = { text: `存档文件夹：${folderName() ?? '已设置'}`, until: this.time.now + 3000 };
      return loadAllSlots().then((rows) => menu.refreshSlots(rows));
    });
    loadAllSlots().then((rows) => menu.refreshSlots(rows));
  }

  /** 存到某个槽；底档归当前局，目标槽仅决定写到哪里。 */
  saveToSlot(slot) {
    if (this.statusScreen?.saveRestriction?.()) {
      this.statusScreen.render();
      return Promise.resolve(false);
    }
    // 存读档闸门：联网取现网密钥与内存比对，未通过不放行
    return authGate()
      .then(() => gateGuard()) // 防倒卖验证：存档拦截（D6），未验证/受限/锁定时阻止写入
      .then(() => {
        const bytes = buildSaveBytes(this, {
          mapId: this.mapId,
          x: this.playerPos?.x ?? 0,
          y: this.playerPos?.y ?? 0,
          facing: this.facing ?? 0,
        });
        // ⚠️ **把事件表的来源一并存下来。** 这 13 张没有 `.EVE` 的图
        // （`MP2503A` 打蝎子那张就是其一）靠继承别的图的事件表，
        // 而来源是运行时才知道的；不存的话读档回来出入口没有触发槽，人出不去。
        // 这个字段是我们自己加的，见 `saveslot.saveSlot`。
        // ⚠️ **不带任何额外字段** —— 存的就是纯 `.TSF`，与原作字节级通用。
        //
        // 曾经这里存过 `scriptSource`（「没有事件表的图向谁借脚本」），
        // 理由是「静态映射只解决一半」。**那个理由是错的**：14 张没有事件表
        // 的图里 **13 张一个带触发的对象都没有**（根本不需要脚本），
        // 唯一需要的 `MP2503A`（出入口 `touch=11`）静态表已经指向 `MP3001`，
        // 而那张图确实有槽 11。见 `docs/判据/存档格式.md`。
        return saveSlot(slot, bytes);
      })
      .then(() => loadAllSlots())
      .then((rows) => {
        this.statusScreen?.refreshSlots(rows);
        this.notice = { text: `已存入第 ${slot + 1} 格`, save: true, until: this.time.now + 2000 };
        if (this.statusScreen?.visible) this.statusScreen.render();
      })
      .catch((err) => {
        // ⚠️ 存档失败必须让人看见 —— 只写控制台的话，玩家以为存上了。
        console.warn('存档失败：', err?.message ?? err);
        this.notice = { text: `存檔失敗：${err?.message ?? err}`, save: true, until: this.time.now + 4000 };
        if (this.statusScreen?.visible) this.statusScreen.render();
      });
  }

  /** 从某个槽读档：换掉全局状态，然后切到存档记的那张图与那个落点。 */
  loadFromSlot(slot) {
    // 存读档闸门：联网取现网密钥与内存比对，未通过不放行
    return authGate().then(() => loadSlot(slot)).then((bytes) => {
      if (!bytes) throw new Error(`第 ${slot + 1} 格是空的`);
      this.enterSave(bytes);
    }).catch((err) => {
      console.warn('读档失败：', err?.message ?? err);
      this.notice = { text: `读档失败：${err?.message ?? err}`, until: this.time.now + 4000 };
    });
  }

  /**
   * 把一份存档字节装进游戏。导入 `.TSF` 与读槽位走的是同一条路。
   *
   * @param {object|null} [extra] 槽位的附带数据，见 `saveslot.saveSlot`。
   *   `.TSF` 里没有这东西，所以导入的存档拿不到，只能是 null。
   */
  enterSave(bytes, extra = null) {
    const { mapId, entry } = applySaveBytes(this, bytes);
    if (!mapId) throw new Error('存档里没有地图');
    // ⚠️ **进图前要把剧情执行器与菜单收掉** —— 读档相当于换了一局，
    // 留着的话新场景会接着演上一局演到一半的那段。
    this.runner = null;
    this.registry.set('pendingScript', null);
    // ⚠️ 这里曾经从附带数据里取「事件表来自哪张图」，**已删** ——
    // 静态表 `script_sources.json` 就够用，见 `inheritScripts`。
    this.statusScreen?.visible && this.statusScreen.toggle();
    // ⭐ **读档走加载页，不走 `enterAfterLoad`。**
    // 后者的前提是「加载放在黑幕里」—— 那是给剧情 `goto_map` 写的
    // （脚本自带 `fade_out`）。读档**没有黑幕**，于是 `ensureMap` 那几百毫秒里
    // 旧地图一直亮着，而且还在跑 `update()`（人能走、踩踏照样触发）。
    // 用户原话：「中间都有一段间隙会显示当前的（上一张地图的）游戏画面，
    // 很不和谐也容易出现意想不到的问题」。见 `scenes/LoadingScene.js`。
    this.scene.start('Loading', { mapId, entry, text: '读取中…', silent: true });
  }

  /**
   * 读入逐像素的通行与遮挡掩码。
   * 缺任何一张就退化：没有通行掩码则处处可走，没有遮挡则不做遮挡，
   * 但都不至于让场景开不起来。
   */
  loadMasks() {
    this.driftLayers = [];
    const baseGround = readGround(this, `${this.mapId}-ground`);
    // 高清遮挡直接从高清底图源图剪块，不读回整张像素（8192×6144 读回一次约 0.64 秒）
    const hdKey = hdGroundKey(this.mapId);
    const hdImage = this.textures.exists(hdKey) ? this.textures.get(hdKey).getSourceImage() : null;
    const hdGround = hdImage
      ? { image: hdImage, width: hdImage.width, height: hdImage.height, scale: hdAssetScale(this) } : null;
    for (const [i, view] of this.layerViews.entries()) {
      const prefix = this.meta.layers ? `${this.mapId}-layer-${i}` : this.mapId;
      const ground = view.meta.ground && i > 0 ? readGround(this, `${prefix}-ground`) : baseGround;
      view.walk = takeCollision(this, `${prefix}-collision`); // 读完即释放贴图，见 pixelMask.js
      view.mask = readOcclusion(this, `${prefix}-occlusion`);
      view.maskKey = `${prefix}-occlusion`;
      if (view.meta.collision && !view.walk) throw new Error(`${prefix}: 通行掩码未加载`);
      view.occlusion = OcclusionLayer.usable(view.mask, ground)
        ? new OcclusionLayer(this, view.mask, ground, i, view.container, ground === baseGround ? hdGround : null) : null;
      if (view.meta.ground && i > 0 && !this.meta.layeredGround) {
        view.container.add(this.add.image(0, 0, `${prefix}-ground`).setOrigin(0, 0).setDepth(0));
      }
    }
    if (this.meta.layeredGround) this.buildLayeredGround();
    const current = this.layerViews[this.activeLayer];
    if (!current) throw new Error(`${this.mapId}: 无效楼层 ${this.activeLayer}`);
    this.walk = current.walk;
    this.occlusion = current.occlusion;
    this.resetLayerGhost();
  }

  /**
   * 分层背景：每层地面照原作画法（RPG.exe 0x4067a0/0x4068a0/0x44e677/0x44e723，字段见
   * `tools/export_map_layers.py` 的 `PARALLAX`）。
   *
   * 放在场景根上、深度夹在两层之间（第 i 层地面 = i + 0.5，第 i 层的人物容器 = i + 1），
   * 因为容器里的子对象不认自己的 scrollFactor：
   * * 视差层：取图起点 = 镜头 ×（1 + 系数）→ `scrollFactor = 1 + 系数`，渲染时按当帧镜头算，不滞后；
   * * 漂移层：640×480 循环平铺、固定在屏幕上，每拍挪 (dx, dy)，见 `advanceDrift`；
   * * 颜色键：黑（或绿蓝为 0）的像素抠成透明，露出下面的层。
   */
  buildLayeredGround() {
    for (const [i, view] of this.layerViews.entries()) {
      const meta = view.meta;
      if (!meta.ground) continue;
      const raw = `${this.mapId}-layer-${i}-ground`;
      if (!this.textures.exists(raw)) continue;
      const key = meta.colorKey ? colorKeyedTexture(this, raw, meta.colorKey) : raw;
      if (meta.drift) {
        const sprite = this.add.tileSprite(0, 0, WIDE_MAX, STAGE_HEIGHT, key) // 按最宽建，窗口变宽也铺得满
          .setOrigin(0, 0).setScrollFactor(0).setDepth(i + 0.5);
        this.driftLayers.push({ sprite, dx: meta.drift[0], dy: meta.drift[1] });
        continue;
      }
      this.add.image(0, 0, key).setOrigin(0, 0).setDepth(i + 0.5).setScrollFactor(1 + (meta.parallax ?? 0));
    }
  }

  /** 漂移背景按原作每拍挪 (dx, dy)（0x4067a0 的 +0x6F 分支），循环平铺。 */
  advanceDrift(delta) {
    for (const layer of this.driftLayers ?? []) {
      layer.sprite.tilePositionX += (layer.dx * delta) / DRIFT_TICK_MS;
      layer.sprite.tilePositionY += (layer.dy * delta) / DRIFT_TICK_MS;
    }
  }

  resetLayerGhost() {
    const view = this.layerViews[this.activeLayer];
    this.ghostLayer?.destroy();
    this.ghostLayer = new GhostLayer(this, view.mask ?? null, view.maskKey, view.container);
    this.ghostLayer.setOccluders((this.actors ?? [])
      .filter(a => a.sprite && a.box && !isCharacterActor(a))
      .map(a => ({
        get visible() { return !a.sprite.hidden; }, get y() { return a.y; },
        get left() { return a.x + a.box.left; }, get right() { return a.x + a.box.right; },
        get top() { return a.y + a.box.top; }, get bottom() { return a.y + a.box.bottom; },
      })));
  }

  switchLayer(index) {
    index = Number(index);
    const view = this.layerViews[index];
    if (!Number.isInteger(index) || !view) throw new Error(`${this.mapId}: 无效切层 ${index}`);
    this.activeLayer = index;
    this.cast?.clear();
    this.actors = (this.allActors ?? this.actors).filter(a => (a.layer ?? 0) === index);
    this.roamers = this.actors.filter(a => a.roamer && a.sprite);
    this.walk = view.walk;
    this.occlusion = view.occlusion;
    this.collectDoors();
    this.player?.setSceneContainer(view.container);
    this.playerOccluder?.destroy();
    this.playerOccluder = this.occlusion?.attach(this.playerData, PLAYER_DRAW) ?? null;
    this.playerOccluder?.update(this.playerPos.x, this.playerPos.y);
    this.resetLayerGhost();
    this.seedTouched();
  }

  /**
   * 按场景对象表布置。**只画人物**（kind=5）。
   * 布景与出入口的美术已经烘焙在地面图里，再画一遍会重叠错位；
   * 触发线本就是不可见的判定区；内景剖面（马车内部一类）要等剧情放人进去才画。
   */
  spawnObjects() {
    // **剧情点过名的事物一律建精灵**（哪怕 kind 不是人物、哪怕是整屏过场素材），
    // 只是先藏着 —— `actor_show` / `play_anim` 会把它们叫出来。
    //
    // ⚠️ 早先这里只画 `kind === 5` 且不是整屏素材的，理由是「过场素材
    // 无条件画出来会在地图上盖一大块黑」。那在**脚本控制流还没接上**时是对的；
    // 现在接上了，再排除就变成了「废屋里演到初遇却什么都看不见」——
    // 那一段的封铃笙与士兵全画在 `動畫第一段`/`動畫第二段` 这两条整屏素材里。
    const cued = this.scriptedNames();
    this.actors = (this.meta.objects ?? []).map((o) => {
      const data = this.cache.json.get(`${o.sprite}-sprite`);
      // 建不出精灵的对象在控制台留一行 —— 「NPC 在、能对话、但看不见」
      // 这类问题从画面上是查不出原因的。
      if (!data) {
        if (o.kind === KIND_CHARACTER) {
          console.warn(`场景对象「${o.name}」没有精灵数据：${o.sprite}-sprite 未加载`);
        }
        return { ...o, sprite: null, touchRect: null };
      }
      // ⚠️ **显隐看 `showWithMap`，那是 SCI 的原始字段。**
      // 1 = 随地图出现（NPC、摆件），0 = 等剧情用 `actor_show` 叫（过场素材、
      // 剧情人物）。`hide` = 1 的是隐形物（触发线），一律不画。
      //
      // 此前拿「kind 是不是 5」「贴图大不大」去猜，猜错过好几轮 ——
      // 药铺老板 256×240 被当成整屏过场素材藏了起来，废屋的过场素材
      // 又因为 kind≠5 一个都不建。**有原始字段就别去猜。**
      // ⚠️ **还要看剧情旗标。** SCI 的 `FlagOffset`（+0xFF）非零时，
      // 这个对象只在存档旗标为 1 时存在；剧情用 `set_flag` 把它关掉。
      // 兰州城 `badguy` 是 1227，卖完羊皮封卷那一槽就 `set_flag 1227=0`；
      // `其餘士兵A/B/C` 是 1025，废屋剧情结束时一起关掉。
      // 不读它的后果：剧情推进之后该消失的人一直站在场上。
      // ⚠️ **没写过的旗标算「还在」**，不是算 0。见 FlagStore.has 的说明。
      //
      // ⚠️ **判据是「非零」，不是「等于 1」。**（2026-09-11 订正）
      // 写成 `=== 1` 的后果是**地宫的门全都开着**：那些门的旗标开局值是
      // **254**，`254 !== 1` 于是门被判成不存在，只作为隐藏精灵建出来等
      // `actor_show`；而 `isSolidDoor` 要求 `sprite.hidden !== true`，
      // 藏着的门**既看不见也不挡路**。
      //
      // 判据来自数据分布：全库 544 个带 `flag` 的对象，开局值**只有三种** ——
      // `0`(344) / `1`(190) / `254`(10)，而 **254 这 10 个里 7 个正是
      // `mouse=4` 的可见门**（`MP0303 gate`、`MP0604` 三扇牢门、
      // `MP0601A 地下水道`、`MP0603 地窖`、`MP0607A 大門`）。
      // 一个布尔字段里不会只在「门」这一类上冒出 `0xFE`。
      //
      // 旁证：`eventScript` 对旗标用的是 `compare(flags.get(f), value)` 与
      // 加减法 —— **旗标本来就是数值**，把它当布尔读才是那条错的假设。
      //
      // ⚠️ 254 的**确切语义仍是推断**，已登记进 `docs/状态/复现度台账.md`。
      // 回归 `tools/tests/test_door_flags.py` 钉住这个分布，它变了就该回头重看。
      const byFlag = !o.flag || !this.flags.has(o.flag) || this.flags.get(o.flag) !== 0;
      // ⚠️ **有 `flag` 时 `showWithMap` 失效，不是两者相与。**
      // 释义原文：「如果 offset=0xFF 处非 0，那麽 offset=0x70 处失去意义，
      // 意即，**前者控制事物出现的优先权高于后者**。」
      //
      // 写成 `showWithMap === 1 && byFlag` 的后果：所有「有旗标、
      // 但 `showWithMap=0`」的东西**永远不出现** —— 厨房那锅鸡汤
      // （`showWithMap=0`、`flag=1003`）就是这么拿不到的，
      // 而它正是开局主线「送鸡汤给高老丈」的道具。宝箱、剧情道具同理。
      const exists = o.flag ? byFlag : o.showWithMap === 1;
      const visible = exists && !o.hide;
      // 旗标关着、只是为了等 `actor_show` 才建出来的，先藏好。
      // ⚠️ **旗标关掉的对象要连交谈槽一起摘掉。**
      // 只把 `sprite` 置空的话，人看不见但走过去照样提示「空格 交谈」——
      // 卖羊皮封卷的走了之后那个空位还能对话，就是这么来的。
      // ⚠️ **剧情点过名的事物即使旗标是 0 也要建精灵**（藏着等 `actor_show`）。
      //
      // 这条早退原先在 `cued` 那条**之前**，于是「旗标为 0 但剧情马上要叫它」
      // 的对象一律建不出来，`actor_show` 找不到目标、静默失败。河州镇一整条
      // 支线就断在这里：跟`猛哭`说完话，脚本第 9 条 `actor_show 不哭了`
      // （flag1010 当时是 0）没生效 —— **小孩直接消失**而不是「不哭了」；
      // 后面槽 35 的 `actor_show ng0101-02~05`（四个盒子，flag1004~1007 是 0）
      // 同样无效，**布娃娃和金创药都取不到**。
      //
      // 保留 `talk`/`touch` 也是有意的：交互能不能用**看精灵藏没藏**
      // （`nearbyActor` 过滤 `sprite.hidden`），不必再把槽号清零。
      if (!byFlag && !this.isCued(cued, o.name)) {
        return { ...o, sprite: null, talk: 0, touch: 0, absent: true };
      }
      // ⚠️ **`touchRect` 必须在早退之前算。**
      // 出入口全是**隐形触发物**（`hide=1`），一律走这条早退 —— 漏算的话
      // 它们的判定区永远是 null，于是全部退回圆判定，门槛矩形形同虚设。
      // 同一个坑 `CLAUDE.md` 判据表里记过：「纯显示的更新放在所有早退之前」。
      if (!visible && !this.isCued(cued, o.name)) {
        // ⚠️ **`data` 也要带走。** 判定形状是**精灵画出来的像素**
        // （见 `systems/touchShape.js`），而这条早退的对象恰恰是
        // 650 个隐形触发线的全部 —— 不带 `data` 的话它们一个都算不出
        // 像素形状，全部退回包围盒，等于这次改动完全没生效。
        return { ...o, sprite: null, touchRect: touchRectOf(o, data), data };
      }

      // ⚠️ **不要按「开局看不看得见」决定 `topmost`。**
      //
      // 这里原先写的是 `!visible` —— 意思是「旗标关着、等 `actor_show` 的东西
      // 压在最上层」。可那把**带旗标的 564 个普通对象**（宝箱、门、机关、
      // 剧情 NPC）全锁进了 `CUTSCENE_DEPTH`：`actor_show` 放出来之后它们
      // **盖住场上一切**，人走过去被切掉半截。迦夏之窟那个机关就是这么
      // 把主角上半身吃掉的。真正接近整屏的过场素材只有 **3 个**。
      //
      // 判据是原作只有一套排序：**按 y**。`CUTSCENE_DEPTH` 是我们为
      // 「整屏过场动画别被场景盖住」加的补丁，不该扩散到普通场景对象上。
      const sprite = new FieldSprite(this, o.sprite, o.x, o.y,
                                     { x: o.dx, y: o.dy }, false, Boolean(o.shadow));
      // ⚠️ **帧区间以 SCI 记的 `frames`（起始帧, 结束帧）为准，它才是原作的指令。**
      //
      // `ambientLoop` 只是「没有该字段时」的兜底：它把**帧数≥2 且不是行走图**的
      // 精灵一律当成原地动作循环。客人喝酒扇扇子是对的，**但门不是** ——
      // 客栈五扇门各有 2~4 帧，那是**开门的过程**，被当成喝酒动画循环播，
      // 于是二楼的门一开一合没完没了（帧号实测在 1→2→3 转圈）。
      // 而 SCI 给它们记的是 `[1, 1]`：**起=止，就是定格**，等 `open_door`
      // （op8F）来推它。
      //
      // 对 NPC 来说这不改变任何行为：MP0202 里每个 NPC 的 SCI 区间
      // （掌櫃 `[1,62]`、中央老 `[1,30]`、小二 `[1,40]`…）与 `ambientLoop`
      // 算出来的逐一相等 —— 两者都是「跳过 0 号影子帧、播剩下全部」。
      // ⚠️ **行走图（`dirs`≠0）不看这个区间。** 城门口的士兵、`badguy`、
      // `messager` 这 15 个 SCI 也写 `[1,1]`，但对它们「第 1 帧」没有意义 ——
      // 该按 `facing` 去挑自己朝向的站立帧，照搬 1 会让全体转向同一边。
      const [from, to] = (o.frames ?? []).map(Number);
      const ranged = visible && o.dirs === 0
        && Number.isFinite(from) && Number.isFinite(to)
        && from >= 0 && to >= from && to < sprite.frameCount;
      // ⚠️ **起 > 止不是动画区间，是「默认停在 `from`、等指令来推」。**
      // （2026-09-11 补。**这是「门被当成喝酒动画」那个坑的第二次**。）
      //
      // `ranged` 要求 `to >= from`，于是 `frames=[2,1]` 这种**起大于止**的
      // 落不进去，转头掉进 `ambientLoop` 被当成原地动作循环播 ——
      // 表现就是**地宫的门不停地一开一合**。
      //
      // 全库这样的对象有 **72 个、全部 `hide=0`**：21 个 `(2,1)`（多是门）、
      // 10 个 `(3,1)`（`level_*`/`sw_g`/`木星` 这些机关开关），其余是
      // `dragon(58,15)`、`true_ladder(81,1)`、`meet(140,1)` 这类**等剧情
      // `play_anim` 来推的演出对象**。它们的共同点是「有多个状态，默认停在
      // 第一个」，不是自播的循环。
      //
      // 判据：`ND0303-02`/`ND0604-01`/`ND0603-06` 三扇门逐图渲染，
      // `frames[0]` 指向的那一帧都是**关着**的那张（见 `复现度台账.md`）。
      //
      // 排掉之后它们会落到最后那条 `else` 的 `sprite.hold(from)` —— 正是要的。
      // ⚠️ **「起>止」时第二个数是帧数，不是止。** 见 `spriteLayout.frameSpan`。
      // `gate [2,1]` = 帧 2 一帧（门定格在关着）、
      // `gearanm [3,2]` = 帧 3~4（齿轮微弱地来回转，而帧 3 带那声「嘎吱」）。
      const span = visible && o.dirs === 0 && from > to ? frameSpan(o.frames) : null;
      const looping = span && span.count > 1 ? span : null;
      const parked = !looping && visible && o.dirs === 0
        && Number.isFinite(from) && Number.isFinite(to) && from > to;
      // ⚠️ **行走图（`dirs`≠0）不进 `ambientLoop`。**
      // 上面 `ranged` 已经把它们排除在「SCI 帧区间」之外，可这一行原先没排，
      // 于是它们落进「原地动作循环」，**整条行走图被当成动画播** ——
      // 河州镇的「不哭了」（`dirs=4`、`frames=[1,1]`）就是这么**原地转圈**的。
      // 行走图该走最后那条 `standFrame(按朝向挑站立帧)`。
      const ambient = visible && !ranged && !parked && o.dirs === 0
        ? ambientLoop(data) : null;

      if (looping) {
        sprite.playSegment(looping.start, looping.count, { loop: true });
      } else if (ranged && from === to) {
        sprite.hold(from);
      } else if (ranged) {
        // 起播帧随机错开，否则同一张精灵的几个人会同时抬手。
        const count = to - from + 1;
        sprite.playSegment(from, count, {
          loop: true,
          at: Math.floor(Math.random() * count),
        });
      } else if (ambient) {
        sprite.playSegment(ambient.start, ambient.count, {
          loop: true,
          at: Math.floor(Math.random() * ambient.count),
        });
      } else {
        // 行走图的 NPC 站着不动，用自己朝向的站立帧，别把整条精灵播成转圈
        // ⚠️ **优先用 SCI 给的起始帧**（`frames[0]`）。它是原作指定的默认姿势；
        // 只有行走图才该按朝向去挑站立帧。
        if (Number.isFinite(from) && from > 0 && o.dirs === 0) sprite.hold(from);
        else sprite.hold(standFrame(data, screenFacing(o.facing)));
      }
      // 剧情道具先藏着，等 `actor_show` 叫它。随地图出现的一开始就站在那。
      if (!visible) sprite.setHidden(true);
      // ⚠️ **要问精灵自己用的是哪个纹理**，不要拼键名。
      // 这里原先写死 `${o.sprite}-f0`（第三代「每帧一张」的键），而现在精灵是
      // **图集**，键就是 `o.sprite` 本身 —— `-f0` 永远不存在，于是**每一个
      // 用图集的对象都会刷一条假告警**，把真正的缺图淹掉了。
      // 三代产物的键各不相同，唯一可靠的问法是 `sprite.mainFrame.key`。
      else if (!this.textures.exists(sprite.mainFrame?.key ?? `${o.sprite}-f0`)) {
        console.warn(`场景对象「${o.name}」的贴图没加载：${o.sprite}`);
      }
      // NPC 不挪窝，覆盖层按当前位置算一次就够（动作只换帧，不换站位）
      const view = this.layerViews[o.layer ?? 0];
      sprite.setSceneContainer(view.container);
      const occluder = view.occlusion?.attach(data, { x: o.dx, y: o.dy }) ?? null;
      occluder?.update(o.x, o.y);
      // `data`（帧布局表）留在演员身上：溜达时要按它算行走段与站立帧，
      // `cutscene.spriteData` 也是先看这一项。
      return {
        ...o, sprite, occluder, data,
        // 各帧并集的包围盒，**相对对象坐标**。网点虚影拿它当「谁可能挡住谁」
        // 的便宜判据，见 `systems/ghost.js`。与遮挡覆盖层同一个函数算，
        // 免得两处口径漂移。
        box: spriteBox(data?.frames, { x: o.dx, y: o.dy }),
        touchRect: touchRectOf(o, data),
        roamer: visible ? createRoamer(o) : null,
      };
    });
    this.spawnCastExtras(cued);
    this.allActors = this.actors;
    this.actors = this.allActors.filter(a => (a.layer ?? 0) === this.activeLayer);
    // 人挡人只按深度排序；网点只穿透景物。读取演员当前位置/显隐，不能保留建场快照。
    this.ghostLayer?.setOccluders(this.actors
      .filter(a => a.sprite && a.box && !isCharacterActor(a))
      .map(a => ({
        get visible() { return !a.sprite.hidden; },
        get y() { return a.y; },
        get left() { return a.x + a.box.left; }, get right() { return a.x + a.box.right; },
        get top() { return a.y + a.box.top; }, get bottom() { return a.y + a.box.bottom; },
      })));
    // 会溜达的就那几个（全游戏 3955 个对象里只有 79 个有 `RangeX/RangeY`），
    // 单拎一张表出来，免得每帧扫全部演员。
    this.roamers = this.actors.filter((a) => a.roamer && a.sprite);
  }

  /**
   * 本图的事件脚本点过名的事物。
   *
   * `actor_show{name}` / `play_anim{anim}` / `camera_follow{name}` 这些都按
   * **事物名**指人。名字对不上就等于剧情演了个寂寞 —— 而且不会报错。
   */
  scriptedNames() {
    const names = new Set();
    this.animNames = new Set();
    // ⚠️ **要扫全部地图，不能只扫当前图。** 长过场住在**出发那张图**的槽里 ——
    // 废屋那一段的 `actor_show{動畫第一段}` 写在 `MP0212` 的槽 9 里，
    // 而它演的时候人已经在 `MP0208` 了。只扫当前图，废屋里就一个事物都不建，
    // 剧情照演但**画面上什么都没有**。
    // ⚠️ **扫「缓存里实际有的图」，不是 `FIELD_MAPS`。**
    // 按需加载之后没进过的图根本不在缓存里，照 `FIELD_MAPS` 扫会拿到一堆
    // `undefined`；而进过的图（尤其是**上一张图** —— 长过场的出发点）
    // 一定在缓存里。`map.json` 一旦拉过就不卸，所以这份集合只增不减。
    for (const key of this.cache.json.getKeys().filter((k) => k.endsWith('-map'))) {
      const scripts = this.cache.json.get(key)?.scripts ?? {};
      for (const actions of Object.values(scripts)) {
        for (const a of actions ?? []) {
          if (a.name) names.add(a.name);
          // ⚠️ `play_anim` 的目标另记一份：`cutscene.js` 的**过场动画通道**
          // 靠它区分「过场动画素材」与普通 NPC —— 前者的显隐要排在
          // 正在演的那一段之后，后者立刻生效。
          if (a.anim) { names.add(a.anim); this.animNames.add(a.anim); }
        }
      }
    }
    return names;
  }

  /**
   * 这个名字被剧情点过吗。**大小写不敏感** —— 脚本里写 `ng0101-02.sf2`
   * （小写后缀），对象表里写 `ng0101-02.SF2`（大写），直接比会漏，
   * 于是那几个箱子建不出精灵、`actor_show` 静默失败。
   */
  isCued(cued, name) {
    if (cued.has(name)) return true;
    const lower = String(name ?? '').toLowerCase();
    for (const n of cued) if (String(n).toLowerCase() === lower) return true;
    return false;
  }

  /**
   * 剧情点了名、但本图 `objects` 里没有的事物 —— 给它们补一个演员。
   *
   * 两类：
   * * **队友**（封鈴笙、大夏侯儀…）—— 精灵在共享库里，查 `CUTSCENE_SPRITES`。
   * * **锚点**（隱形、captain 这些）—— 没有精灵，只要坐标；
   *   `placements` 里有初始站位就用它。
   */
  spawnCastExtras(cued) {
    // ⚠️ **重名判定必须大小写不敏感** —— 对象表写 `ng0101-02.SF2`，
    // 脚本写 `ng0101-02.sf2`。严格比的后果不是「少建一个」，而是
    // **多建一个同名空壳**：坐标 (0,0)、没有精灵、没有 `talk` 槽。
    // `cutscene.actorOf` 先做严格相等匹配，命中的正是这个空壳，
    // 于是 `actor_show` 显示了个什么都没有的东西，真箱子还藏着 ——
    // 河州镇那四个装布娃娃/金创药的箱子当场取不到、重进地图才能取
    // （重进时旗标已是 1，箱子按 `showWithMap` 正常建出来）就是这么来的。
    const known = new Set(this.actors.map((a) => String(a.name).toLowerCase()));
    const spots = new Map((this.meta.placements ?? []).map((p) => [p.name, p]));
    for (const name of cued) {
      if (known.has(String(name).toLowerCase())) continue;
      // ⚠️ **`大夏侯儀` 是主角本人，不要再建一个。** 建了就是画面上凭空
      // 多出来的第二个夏侯仪，而剧情让他「走出屋门」时推的还是那个空壳。
      // 判据见 `cutscene.js` 的 `HERO_ALIASES`。
      if (name === '大夏侯儀') continue;
      const at = spots.get(name) ?? { x: 0, y: 0 };
      const key = this.castSpriteKey(name);
      const data = key ? this.cache.json.get(`${key}-sprite`) : null;
      const sprite = data ? new FieldSprite(this, key, at.x, at.y, null, false, true) : null;
      // 一律先藏着 —— 剧情用 `actor_show` 叫它们出场。
      sprite?.setHidden(true);
      sprite?.setSceneContainer(this.layerViews[this.activeLayer].container);
      this.actors.push({ scriptOnly: true, layer: this.activeLayer, name, x: at.x, y: at.y, kind: KIND_CHARACTER,
                         facing: 0, sprite, occluder: null, data,
                         box: spriteBox(data?.frames, null) });
    }
  }

  /**
   * 剧情点名的事物 → 精灵键。
   *
   * 两条路，缺一不可：
   *
   * 1. **队友按繁体名点**（`actor_show{name:"封鈴笙"}`），精灵在共享库
   *    `Sys.dat` 里，只能查 `CUTSCENE_SPRITES` 那张表。
   * 2. **过场素材按文件名点**（`actor_show{name:"Event-0.SF2"}`）——
   *    去掉 `.SF2` 后缀、转大写就是精灵键（`EVENT-0`）。
   *
   * ⚠️ 第 2 条原先没有，于是开场那一整段「躺在床上 → 翻身 → 起床下地」
   * （`EVENT-0`，53 帧）作用在一个没有精灵的空壳上，**画面上什么都没有**。
   * 素材本身是有的：`map.json` 的 `sprites` 里列着，加载队列也拉了。
   */
  castSpriteKey(name) {
    // ⚠️ **正本是 `avatars.json`**（`共享角色` 的键就是脚本用的繁体名）。
    // `CUTSCENE_SPRITES` 只是别名补丁（脚本里出现过「夏侯儀」这种少「大」字的写法）。
    // 从前只有那张手填的四条表，于是凉州城那段 `actor_show 慕容璇璣/古倫德`
    // **场上什么都不出现** —— 五个人的合影只来了两个，而且不报错。
    const mapped = castKeyByName(this.cache.json.get(AVATARS_KEY), CUTSCENE_SPRITES)[name];
    if (mapped) return mapped;
    const file = String(name ?? '').replace(/\.sf2$/i, '').toUpperCase();
    if (!file) return null;
    if (this.cache.json.exists(`${file}-sprite`)) return file;
    // ⚠️ **精灵键带图号前缀**（`MP0102B-EVENT-0`，见 `scene_table.sprite_key`），
    // 而脚本里 `actor_show` 点的是**裸文件名**（`Event-0.SF2`）。
    // 在本图的精灵表里按后缀找回来 —— 不找的话开场那段 53 帧的起床动画
    // 又会作用在一个没有精灵的空壳上（画面上什么都没有，且不报错）。
    const suffix = `-${file}`;
    const hit = (this.meta?.sprites ?? []).find((k) => k.toUpperCase().endsWith(suffix));
    return hit && this.cache.json.exists(`${hit}-sprite`) ? hit : null;
  }

  spawnPlayer() {
    // op58 带来的落点优先：从兰州城进药铺，人该站在药铺的门内侧，
    // 而不是药铺地图自己的出生点
    const spawn = this.entry ?? this.meta.spawn ?? { x: 400, y: 520 };
    const start = { x: spawn.x, y: spawn.y };
    this.playerPos = { ...start };

    // 剧情换过行走形象的话按那个来（`set_avatar`）。记在 registry 上，
    // 因为 `goto_map` 会重启场景 —— 挂在场景上换完立刻就没了。
    // ⚠️ **没有形象记录时按本图定**：大地图上主角是小形象。
    // 判据：全库 61 处「进大地图」都紧跟一条 `set_avatar 1`
    // （`小夏侯儀`，`s1.SF2` 20×51，正好是城里那个 36×90 的一半）。
    // 读档直接落到大地图时没有剧情跑，不补这一条就是个大人站在大地图上。
    // ⚠️ 读档时只记了**形象代码**（存档 `@57583`），精灵键在这里查 ——
    // `avatars.json` 是正本，`gameSave` 里再查一遍就是抄第二份。
    // 不接这一条的后果：读霍雍那段的存档（代码 4），地图上走的还是夏侯仪。
    const wanted = this.registry.get('avatarSprite')
      ?? this.avatarKey(this.registry.get('avatarCode'))
      ?? this.defaultHeroSprite();
    // ⚠️ 最后那一档原先写死 `'NP104'`（兰州城的西夏兵）。精灵键现在带图号前缀
    // （`MP0212-NP104`），裸名字不存在了 —— 而且"拿本图任意一个精灵当主角"
    // 本来就只是别让场景崩掉，前一档已经在做这件事。写死的名字只会是个
    // 永远命不中的死分支。
    const key = (wanted && this.cache.json.get(`${wanted}-sprite`) && wanted)
      || (this.cache.json.get(`${PLAYER_SPRITE}-sprite`) ? PLAYER_SPRITE : null)
      || (this.meta.sprites ?? []).find((k) => this.cache.json.get(`${k}-sprite`))
      || null;
    this.playerData = this.cache.json.get(`${key}-sprite`);
    this.idles = idleSegments(this.playerData);
    // 帧 0 只有影子，站定时要停在朝向的首帧而不是它
    this.player = this.playerData
      ? new FieldSprite(this, key, start.x, start.y, null, false, true)
      : null;
    this.player?.hold(standFrame(this.playerData, this.facing));
    // 旧存档/脚本落点也须容纳完整脚印，否则仅脚点可走会让读档后动不了。
    // 剧情用画外落点让过场动画代演；不能把(0,0)拉回车厢左上角。
    const offstage = Boolean(this.entry && isOffstagePoint(spawn, this.mapWidth, this.mapHeight));
    if (!offstage) {
      Object.assign(start, this.findOpenSpot(spawn.x, spawn.y, 400,
        (x, y) => this.walkable(x, y) && footprintFitsMask(this.playerFootprint(x, y), this.walk)));
    }
    Object.assign(this.playerPos, start);
    this.player?.setPosition(start.x, start.y);
    // 素材脚底可越过脚点5px；画外代演时本体、阴影与网点都应退场。
    // 记下「因画外而藏」，之后剧情把主角放回场内时由 cutscene 解除。
    this.heroOffstage = offstage;
    if (offstage) this.player?.setHidden(true);
    this.player?.setSceneContainer(this.layerViews[this.activeLayer].container);
    if (!this.player) {
      this.fallback = this.add.circle(start.x, start.y, 9, 0xd8c9a3).setDepth(start.y);
    }
    this.playerOccluder = this.occlusion?.attach(this.playerData, PLAYER_DRAW) ?? null;
    this.playerOccluder?.update(start.x, start.y);
    // ⚠️ **开场时主角先不出场。** 那一段人躺在床上，演的是 `EVENT-0`
    // 那条 53 帧的过场精灵；主角本体要等脚本最后那条 `hero_place(549,303)`
    // 才放出来（见 `cutscene.placeHero`）。不藏的话画面上是**两个夏侯仪**。
    if (this.opening) this.player?.setHidden(true);
    // 主角各帧并集的包围盒，网点虚影拿它当「可能被谁挡住」的判据。
    this.playerBox = spriteBox(this.playerData?.frames, PLAYER_DRAW);

    this.follow = this.add.rectangle(start.x, start.y, 2, 2, 0, 0);
    this.cameras.main.startFollow(this.follow, true, 0.12, 0.12);
  }

  /**
   * 现在是不是跑。**Shift 切换**（见 `create` 里的绑定）。
   *
   * ⚠️ **不再要求"这条精灵有跑步段"。** 从前加了那个条件，于是 Tab 换成
   * 队友之后 Shift 完全没反应 —— 队友的精灵只有 41 帧（影子 + 站立 8 +
   * 行走 8×4），**没有跑步段**。用户拍板：没有跑步段就**用走路帧加速播**，
   * 别让人"跑不动"。动画怎么退回见 `updatePlayerAnimation`。
   */
  wantsRun() {
    return Boolean(this.registry.get('running'));
  }

  /** 这条精灵有没有真正的跑步段。没有的话跑起来只能拿走路帧顶。 */
  hasRunFrames() {
    return runSegment(this.playerData, this.facing) !== null;
  }

  /** 走动时按朝向播行走/跑步段；站定先停住，久了才播待机动作。 */
  /**
   * @param {number|boolean} moving 这一帧走了多少像素（0/false = 站着）
   */
  updatePlayerAnimation(moving, delta, running = false) {
    if (!this.player || !this.playerData) return;
    if (moving) {
      this.idleFor = 0;
      this.resting = false;
      // ⚠️ **没有跑步段就退回走路帧**（Tab 换成的队友都是这种，41 帧）。
      const run = running ? runSegment(this.playerData, this.facing) : null;
      const seg = run || walkSegment(this.playerData, this.facing);
      // ⚠️ **按走过的距离推进，不按时间。** 用 `playSegment(loop)` 的话
      // 帧率由 SF2 的 `TICK_MS` 决定，与移动速度毫无关系 —— 表现就是
      // 「两条腿一直在倒腾」。见 FieldSprite.advance 的说明。
      if (this.player.start !== seg.start || this.player.count !== seg.count) {
        this.player.playSegment(seg.start, seg.count, { loop: true });
        this.player.stop();
      }
      // ⚠️ **步幅按「实际在播哪一段」取，不是按「想不想跑」。**
      // `advance` 是「每走 stride 像素换一帧」：跑步段的步子大，所以 stride 也大。
      // 拿走路帧顶替跑步时仍用 `STRIDE_PX` —— 人跑得快、每像素的换帧率不变，
      // 于是腿自然就倒腾得快了，这正是用户要的「走路帧加速播」。
      // 反过来（用 RUN_STRIDE_PX）会变成「跑得飞快、腿却比走路还慢」。
      this.player.advance(Number(moving) || 0, run ? RUN_STRIDE_PX : STRIDE_PX);
      return;
    }

    if (!this.resting) {
      this.resting = true;
      this.player.hold(standFrame(this.playerData, this.facing));
    }
    this.idleFor += delta;
    if (this.idleFor < IDLE_DELAY_MS || !this.idles.length) return;

    this.idleFor = 0;
    const pick = this.idles[Math.floor(Math.random() * this.idles.length)];
    this.player.playSegment(pick.start, pick.count, {
      loop: false,
      onDone: () => {
        this.resting = false;
      },
    });
  }

  /**
   * 沿一个轴推进，**逐像素试探**，返回真正走了多少像素。
   *
   * ⚠️ **不能只测目标点。** MB 描的是**障碍轮廓线**，实测线宽只有
   * 4~14 像素（MP0101 全图横扫，众数 4~6）。而一帧的位移是
   * 走路 `165×16.7ms ≈ 2.75px`、**跑步 `297×16.7ms ≈ 4.95px`** ——
   * 「测一下目标像素能不能站」的写法让跑步**一步跨过整条线**，
   * 落在线另一侧的可走区里；那一侧是房子的墙面，于是人就站到墙上去了，
   * 而且一旦过了线，那一整片都能走。走路步长不到 3px 跨不过去，
   * 所以表现成「跑起来有概率上墙、慢走大多上不去」，还跟帧率有关。
   *
   * 逐像素推进等于把线段与障碍线求交，**任何步长都跨不过一条 ≥1px 的线**。
   * 分轴调用，贴着墙推的时候仍能沿墙滑动。
   *
   * @param {'x'|'y'} axis
   * @param {number} delta 这一帧想在该轴上走的位移（可正可负、可含小数）
   */
  slideAxis(axis, delta) {
    if (!delta) return 0;
    const sign = Math.sign(delta);
    const other = axis === 'x' ? 'y' : 'x';
    let left = Math.abs(delta);
    let moved = 0;
    while (left > 0) {
      const stride = Math.min(STEP_PROBE_PX, left);
      const next = this.playerPos[axis] + sign * stride;
      const probe = { [axis]: next, [other]: this.playerPos[other] };
      // ⚠️ **脚印已经压着不可走处时，只要不压得更多就放行**（脱困）。剧情 `actor_walk` 会把主角
      // 放到脚印压线的位置：河州镇李氏药铺进门剧情把人摆到柜台前 (490,409)，脚印上沿 19 像素压在
      // 柜台边，往哪边试 1 像素都还压着，判成全挡、永远走不动（2026-10-03 用户真机报，电脑同样）。
      // 正常站位（压线 0）时与原判据完全一样：新落点压线就挡。
      const misses = footprintMisses(this.playerFootprint(probe.x, probe.y), this.walk);
      if (!this.walkable(probe.x, probe.y) || this.playerHitsObject(probe.x, probe.y)
          || (misses > 0 && misses >= footprintMisses(this.playerFootprint(), this.walk))) {
        this.bumpTouchAt();
        break;
      }
      this.playerPos[axis] = next;
      moved += stride;
      left -= stride;
    }
    return moved;
  }

  /**
   * 被通行图挡住的那一步也要先查踩踏（原作 0x409b11：先触发踩踏，再决定是否挡住）。
   * ⚠️ 查的是**原作一整步的落点**（ORIGINAL_STEP），不是 1px 试探点：沙洲城药铺的门槛
   * 在墙线另一侧，街上脚印永远压不到，差 3~4px；原作一步 6px 正好够着（2026-09-27）。
   */
  bumpTouchAt() {
    const intent = this.moveIntent;
    if (this.bumpTouch != null || !intent) return;
    const step = (this.mapId === WORLD_MAP ? WORLD_MAP_STEP : ORIGINAL_STEP)[this.wantsRun() ? 'run' : 'walk'];
    const reach = intent.x && intent.y ? step.diagonal : step.straight;
    const shape = this.playerFootprint(this.playerPos.x + intent.x * reach,
                                       this.playerPos.y + intent.y * reach);
    const hit = this.actors.find((a) => a.touch && this.slotActions(a.touch)
      && this.actorIsPresent(a) && overlapsShapes(shape, footprintShape(this, a)));
    if (hit) this.bumpTouch = hit.touch;
  }

  playerFootprint(x = this.playerPos.x, y = this.playerPos.y) {
    const actor = this.playerFootprintActor ??= {};
    Object.assign(actor, { data: this.playerData, sprite: this.player });
    return footprintShape(this, actor, x, y);
  }

  actorIsPresent(actor) {
    if (actor.absent || actor.hidden) return false;
    // ⚠️ 隐形判定物（出入口、事件线，hide≠0）**不看精灵藏没藏**：它的精灵本来就藏着。
    // 只要**任何一张缓存地图**的脚本点过它的名字就会建出（藏着的）精灵 —— 沙洲城开门脚本
    // 点了「藥舖出入口」，药铺里同名的出口也被建了精灵，于是判成不在场、出不了门（2026-09-27）。
    // 在不在场看剧情显式显隐（actor_show/actor_hide 写的 hidden），否则看旗标/随图出现。
    if (actor.hide) {
      return actor.hidden === false
        || (actor.flag ? this.flags.get(actor.flag) !== 0 : actor.showWithMap === 1);
    }
    return Boolean(actor.sprite && !actor.sprite.hidden);
  }

  playerHitsObject(x, y) {
    const player = this.playerFootprint(x, y);
    const blocker = this.actors.find(actor => actor.entrance === 0 && !actor.doorOpen
      && this.actorIsPresent(actor) && overlapsShapes(player, footprintShape(this, actor)));
    // 原作 0x409b11 先触发踩踏事件，再按 EntranceFlag 决定是否挡住移动。
    // 城镇入口自身可能不可穿过，不能等脚跨进去才尝试切图。
    if (blocker?.touch && this.slotActions(blocker.touch)) this.bumpTouch = blocker.touch;
    return Boolean(blocker);
  }

  shapeHitsObject(shape, movingActor = null) {
    return this.actors.some(actor => actor !== movingActor && actor.entrance === 0 && !actor.doorOpen
      && this.actorIsPresent(actor) && overlapsShapes(shape, footprintShape(this, actor)));
  }

  npcHitsObject(actor, x, y) {
    const shape = footprintShape(this, actor, x, y);
    return overlapsShapes(shape, this.playerFootprint()) || this.shapeHitsObject(shape, actor);
  }

  /**
   * 从给定点附近找一个可通行的落脚点。
   *
   * @param limit 最远找多少像素。**剧情把人放在哪儿是有讲究的**，
   *   挪太远就成了「站错地方」，所以 `hero_place` 只给很小的余量。
   */
  findOpenSpot(x, y, limit = 400, canStand = (px, py) => this.walkable(px, py)) {
    if (canStand(x, y)) return { x, y };
    for (let r = SEARCH_STEP; r < limit; r += SEARCH_STEP) {
      for (const [dx, dy] of [[r, 0], [-r, 0], [0, r], [0, -r], [r, r], [-r, -r]]) {
        if (canStand(x + dx, y + dy)) return { x: x + dx, y: y + dy };
      }
    }
    return { x, y };
  }

  buildHud() {
    // 地名用原作24点阵白字图集染米色（高清专题H1）：系统字体在640×480画布里
    // 只有十几像素高，放大后发糊。点阵按Big5码位索引，简体模式自动换简体字形。
    this.hudBox = this.add.graphics().setScrollFactor(0).setDepth(DEPTH.HUD).setVisible(false);
    this.hud = this.add.bitmapText(HUD_PAD_X + 8, HUD_PAD_Y + 8, FONT_KEY, '', FONT_SIZE)
      .setTint(HUD_INK).setScrollFactor(0).setDepth(DEPTH.HUD).setVisible(false);
    this.hudName = null;

    this.tip = this.add.text(STAGE_WIDTH / 2, STAGE_HEIGHT - 22, '', {
      fontFamily: 'serif', fontSize: '15px', color: '#f2e6cc',
      backgroundColor: '#000000b0', padding: { x: 10, y: 6 },
    }).setOrigin(0.5).setScrollFactor(0).setDepth(DEPTH.HUD);
  }

  /** 左上角地名；没有地名的图文字与底框一起隐藏。只在地名变化时重画底框。 */
  showPlaceName(name) {
    if (name === this.hudName) return;
    this.hudName = name;
    this.hud.setVisible(Boolean(name));
    this.hudBox.setVisible(Boolean(name)).clear();
    if (!name) return;
    this.hud.setText(name);
    this.hudBox.fillStyle(0x000000, HUD_BOX_ALPHA)
      .fillRect(8, 8, this.hud.width + HUD_PAD_X * 2, this.hud.height + HUD_PAD_Y * 2);
  }

  /** 脚底那一个像素在不在可走区。逐像素查，墙上不会再有采样漏出来的孔。 */
  walkable(x, y) {
    if (x < EDGE_MARGIN || y < TOP_MARGIN) return false;
    if (x > this.mapWidth - EDGE_MARGIN || y > this.mapHeight - EDGE_MARGIN) return false;
    // ⚠️ **关着的门挡路。** 门开了（`open_door state=2`）这条就自动失效，
    // 那块门槛立刻变回踩踏触发区。判据与理由见 `isSolidDoor`。
    for (const door of this.solidDoors ?? []) {
      if (this.isSolidDoor(door) && this.doorBlocks(door, x, y)) return false;
    }
    if (!this.walk) return true;

    const px = Math.floor(x);
    const py = Math.floor(y);
    if (px < 0 || py < 0 || px >= this.walk.width || py >= this.walk.height) return false;
    return this.walk.bits[py * this.walk.width + px] === 1;
  }

  /**
   * 关着的门挡住哪一块地。
   *
   * **判据：凡是「这扇门会被画在人上面」的地方，都不许站。**
   * 也就是「在门的包围盒里」且「脚下的 y ≤ 门的 y」。
   *
   * ## 为什么不是踩踏那套逐像素形状
   *
   * `MP1101` 佛寺大門量出来是这样（帧 1，世界 181,1161 ~ 299,1321）：
   *
   * | 列 | 门画出来的 y 范围 |
   * |---|---|
   * | x=187 | 1169 ~ **1297** |
   * | x=240 | 1187 ~ 1309 |
   * | x=295 | 1190 ~ **1319** |
   *
   * 门的接地线是**斜的**（左端 1297、右端 1319），而深度排序只有**一个**
   * `y = 1309`。主角站到 `(187,1301)` —— 按那一列他在门前面（1301 > 1297），
   * 按排序却在门后面（1301 < 1309），于是**整个人被门吃掉半截**。
   * 逐像素形状拦不住他：1301 正落在门左下角的透明缺口里。
   *
   * 所以这里拦的正是「排序会出错」的那块地。**用户 2026-09-13 拍板：
   * 往关着的门走会被挡住，挡到哪一线不重要** —— 那就按最省事又不出错的来。
   *
   * ## ⚠️ ⚠️ 但那块地是**加**上去的，不是**换**掉原来的像素形状
   *
   * 第一版写成了「只挡 `y ≤ 门的 y`」，把原来的「门画出来的像素一律挡」
   * 顶掉了。后果：`MP0303` 那扇 `gate` 的像素一直画到 **y=735**，而门的
   * `y` 是 **703** —— **704~735 这 32 行门像素不挡路**了。玩家从下方走上去
   * 直接踩到门的 `touch=10`，于是**跳过整段机关剧情**，第一次按门就进了
   * 水晶之殿、直接开演冰璃那一段。
   *
   * 判据是原作脚本自己的结构：`gate` 同时挂着 `talk=12`（按空格 → 演
   * 「日月圖形」→ 门打不开 → `actor_show GEARANM`）与 `touch=10`（踩上去
   * → 进图）。**门关着的时候踩踏区必须够不着**，否则 `talk` 那条线整段作废。
   *
   * ⚠️ 门一开（`open_door state=2`）`isSolidDoor` 就是 false，这条自动失效，
   * 那块地立刻变回踩踏触发区。
   */
  doorBlocks(door, x, y) {
    const shape = touchShape(this, door);
    if (!shape) return false;
    // ① **门画出来的像素**：这一半是原来就有的，丢不得 —— 见下面 ⚠️⚠️。
    if (hitsShape(shape, x, y)) return true;
    // ② 加上「门会被画在人上面」的那块地（门的包围盒内、脚下 y ≤ 门的 y）。
    return y <= door.y
        && x >= shape.x && x < shape.x + shape.w
        && y >= shape.y && y < shape.y + shape.h;
  }

  /**
   * 被挡住的人：把他的贴图**按棋盘格抽掉一半**再画在最上层。
   *
   * 判据是原作截图（凉州城集市）：夏侯仪与路人走到凉棚后面时身上是**网点**。
   * 做法与为什么不需要「判断有没有被挡住」写在 `systems/ghost.js`。
   *
   * ⚠️ **所有「人」都要给，不是白名单。** 上一版只给主角与点名的 `badguy`，
   * 而原作截图里路人同样是网点。
   *
   * ⚠️ ⚠️ **但只给人，道具一个都不许给。** 第一版给场上每个精灵都发了虚影，
   * 于是**门自己的网点副本**（深度 2700）反过来盖在站在门前面的主角身上 ——
   * 画面上是「人好端端站在门外，身上却爬满棋盘格」。查了很久才发现罪魁是
   * `dither:0:MP1101-ND1101-01`，而不是主角自己的虚影（他那会儿根本没虚影）。
   *
   * SCI人物kind=5及显式行走方向数共同识别人物，不能漏掉kind=0剧情士兵。
   */
  updateGhost() {
    if (!this.ghostLayer) return;
    if (this.player && this.playerBox) {
      const { x, y } = this.playerPos;
      this.ghostLayer.paint('player', this.player, {
        left: x + this.playerBox.left, right: x + this.playerBox.right,
        top: y + this.playerBox.top, bottom: y + this.playerBox.bottom,
      }, y);
    }
    for (let i = 0; i < this.actors.length; i += 1) {
      const actor = this.actors[i];
      if (!actor.sprite || !actor.box) continue;
      // 只有人有网点虚影，道具没有。理由见上面那段 ⚠️⚠️。
      if (!isCharacterActor(actor)) continue;
      this.ghostLayer.paint(i, actor.sprite, {
        left: actor.x + actor.box.left, right: actor.x + actor.box.right,
        top: actor.y + actor.box.top, bottom: actor.y + actor.box.bottom,
      }, actor.y);
    }
    for (const view of this.layerViews) view.container?.sort('depth');
  }

  distanceTo(actor) {
    return Phaser.Math.Distance.Between(actor.x, actor.y, this.playerPos.x, this.playerPos.y);
  }

  /**
   * **过场地图沿用把它拉起来的那张图的事件表。**
   *
   * `MP2503A`（蝎子那段）的归档里**没有 `.EVE`、没有 `.MSG`** —— 全库
   * 13 张这样的图，只有它的对象挂了事件号。它那两个出入口写的是 `touch=11`，
   * 而槽 11 在 `MP3001` 里：
   *
   * ```
   * branch flag504 == 2  →  fade_out → goto_map mp3001(2805,1720) → set_avatar 1
   * ```
   *
   * `flag504=2` 正是这段剧情自己在 `MP3001` 槽 10 末尾设的。判据严丝合缝：
   * 打完蝎子往出口走 → 回大地图。不继承的话 `slotActions(11)` 返回 null，
   * 玩家**被永远关在过场图里**。
   *
   * ⚠️ **只在本图完全没有事件表时继承**，不做逐槽回落 ——
   * 有自己 `.eve` 的图缺某个槽是另一回事（多半是槽号算错），
   * 悄悄拿上一张图的同号槽去演会演出完全无关的剧情。
   */
  inheritScripts() {
    const KEY = 'lastScripts';
    this.scriptSource = this.mapId;
    if (Object.keys(this.scripts).length || Object.keys(this.events).length) {
      this.registry.set(KEY, { events: this.events, scripts: this.scripts, map: this.mapId });
      return;
    }
    // ⚠️ **来源是「把我拉起来的那张图」，不是「上一张图」。**
    // 上一张图取决于玩家怎么走过来的：读档之后直奔蝎子那段，上一张
    // 恰好是自己家（`MP0102B`），于是 `MP2503A` 的出口槽 11 取到了
    // 家里衣柜那一槽 —— 往右走弹出「衣櫃裡只有一件布袍」，还反复拿到布袍，
    // 而且**永远出不去**。重走一遍上一张变成大地图，就又对了，
    // 这种「有时对有时错」正是判据不稳的招牌。
    //
    // `pendingScript.map` 记的才是真正的来源（`MP3001` 槽 10 的 `goto_map`
    // 把这张过场图拉起来，那一槽就住在 `MP3001` 里）。
    const from = this.registry.get('pendingScript')?.map;
    const cued = from ? this.cache.json.get(`${from}-map`) : null;
    if (cued?.scripts) {
      this.scripts = cued.scripts;
      this.events = cued.events ?? {};
      this.scriptSource = from;
      console.info(`${this.mapId} 没有自己的事件表，用拉起它的 ${from} 的`
                   + `（${Object.keys(this.scripts).length} 个槽）`);
      return;
    }
    // **静态表**：`assets/data/script_sources.json`，由 `export_script_sources.py`
    // 在导出期算出来 —— 判据是「这张图的对象用到哪些槽」与「哪些图会
    // `goto_map` 它」的交集。13 张过场图里 12 张能定出唯一来源。
    //
    // ⚠️ **这一层要能兜住旧存档。** 存档里的附带字段（下一层）只有**这次改动
    // 之后新存的档**才有；用户手上那些旧档一个都没有，光靠附带字段等于没修。
    const fixed = this.cache.json.get(SCRIPT_SOURCES_KEY)?.来源?.[this.mapId];
    const known = fixed ? this.cache.json.get(`${fixed}-map`) : null;
    if (known?.scripts) {
      this.scripts = known.scripts;
      this.events = known.events ?? {};
      this.scriptSource = fixed;
      console.info(`${this.mapId} 没有自己的事件表，按静态表用 ${fixed} 的`
                   + `（${Object.keys(this.scripts).length} 个槽）`);
      return;
    }
    if (fixed) {
      console.warn(`${this.mapId} 的事件表该向 ${fixed} 借，但那张图还没加载`);
    }

    // ⚠️ 这里曾经有一层「从存档的附带数据取来源」，**2026-09-11 删了**。
    // 理由：静态表覆盖了**唯一真正需要脚本**的那张图。14 张没有事件表的图里
    // 13 张一个带触发的对象都没有，`MP2503A` 是独苗（`touch=11` → `MP3001`）。
    // 删掉它，存档就是纯 `.TSF`、与原作通用。

    const prev = this.registry.get(KEY);
    if (!prev) {
      console.warn(`${this.mapId} 没有事件表，也没有上一张图可继承`);
      return;
    }
    // 退回「上一张图」——只在没人拉、直接进来时（调试、读档进过场图）。
    console.warn(`${this.mapId} 没有事件表、也没人拉它进来，退回上一张图 ${prev.map}`);
    this.scripts = prev.scripts ?? {};
    this.events = prev.events ?? {};
    // ⚠️ **来源图号也要跟着继承。** 跨图续演是按图号把脚本取回来的
    // （`startScript` 的 `sourceMap`）—— 记成 `MP2503A` 的话，回到大地图
    // 那一刻 `MP2503A-map` 里根本没有 `scripts`，**`goto_map` 后面的
    // `set_avatar 1` 与 `fade_in` 就全丢了**：人回到了大地图，
    // 形象却还是近景那个大夏侯仪，比正常的小形象大一倍。
    this.scriptSource = prev.map ?? this.mapId;
  }

  /**
   * 一个事件槽要演的动作序列。
   *
   * 优先用 `scripts`（带分支、旗标、切图的完整指令流）；地图若还是旧版
   * 导出、只有 `events` 里的纯对白，就包成一串 `say`，至少 NPC 还会说话。
   */
  slotActions(slot) {
    if (slot === undefined || slot === null) return null;
    const key = String(slot);
    if (this.scripts[key]?.length) return this.scripts[key];

    const lines = this.events[key];
    return lines?.length
      ? lines.map((line, index) => ({ ...line, index, type: 'say' }))
      : null;
  }

  /** 站得最近、且真有话可说的对象。 */
  /**
   * 站得最近、且**看得见**、且真有话可说的对象。
   *
   * ⚠️ **藏起来的不算。** 剧情用 `actor_hide` 把人藏走之后（卖羊皮封卷的
   * `badguy` 成交后就走掉藏了），只看 `talk` 槽和距离的话，
   * 玩家走到那个空位仍会看到「空格 与…交谈」并且真能对上话。
   */
  nearbyActor() {
    return this.actors
      .filter((a) => a.mouse && !a.hide && a.talk && !a.doorOpen && !a.hidden && a.sprite?.hidden !== true
                     && this.slotActions(a.talk) && this.talkDistance(a) < INTERACT_RANGE)
      // ⚠️ **面朝着的优先，不是单纯取最近的。**
      //
      // 原作是**鼠标点击**触发（释义：`0xEB` 鼠标在其上左击后触发的事件），
      // 想跟谁说话就点谁，没有"最近的那个"这回事。我们用键盘，就得有个
      // 选择规则 —— 只按距离排的话，厨房里站在灶台前想拿鸡汤，
      // **旁边的夏媽会把交互抢走**（锅离可站点 55px、夏媽就站在可走区里）。
      //
      // 规则：先看**主角面朝的半边**里有没有候选，有就在里面挑最近的；
      // 一个都没有再退回全局最近。这样「走过去、面朝它、按空格」总是对的。
      .sort((a, b) => (this.facingScore(b) - this.facingScore(a))
                      || (this.distanceTo(a) - this.distanceTo(b)))[0];
  }

  /** 原作 0x409918 按当前坐标量距离；出生位置的框不能用于移动 NPC。 */
  talkDistance(actor) { return this.distanceTo(actor); }

  interactionVerb(actor) {
    const actions = this.slotActions(actor.talk) ?? [];
    if (actions.some(a => a.type === 'open_save')) return '天書';
    // kind=0也包含静态NPC；有对方台词仍是交谈。只有主角自述的静态目标提示查看。
    if (actor.mouse === 3 && !isCharacterActor(actor)) {
      const reply = actions.some(a => a.type === 'say' && a.speaker > 0 && ![1, 7].includes(a.speaker));
      if (!reply) return actions.some(a => a.type === 'item_gain' || a.type === 'money_gain') ? '拾取' : '查看';
    }
    return MOUSE_VERB[actor.mouse] ?? '查看';
  }

  /**
   * 这个对象是不是在主角面朝的方向上。1 = 是，0 = 不是。
   *
   * 用**刚才的移动向量**判，不用 `facing` 编号 —— 编号有两套约定，反推容易错。
   * 还没走过一步时（刚进图）一律给 1，退化成纯按距离，与从前一致。
   */
  facingScore(actor) {
    const v = this.faceVec;
    if (!v || (!v.x && !v.y)) return 1;
    const dx = actor.x - this.playerPos.x;
    // 纵向按等距比例还原，否则上下方向的夹角会被压扁。
    const dy = (actor.y - this.playerPos.y) * ISO_RATIO;
    const len = Math.hypot(dx, dy) || 1;
    return (dx / len) * v.x + (dy / len) * (v.y * ISO_RATIO) > 0 ? 1 : 0;
  }

  /**
   * 对白姓名牌上写谁。
   *
   * 先查这张图自带的 `names`（老产物才有），再退到**全局人名表**
   * `speakers.json`。
   *
   * ⚠️ **不能只靠地图自带的那份。** 那是 `export_map.py` 在给了 `--sys`
   * 时才写的，317 张图里只有 21 张有 —— 遇冰璃那一整段（`MP0303`/`MP0304`）
   * 不论谁说话都只有立绘没有名字，就是这么来的。
   *
   * 代码 0 是**系统旁白**（「得到『羊皮封卷』！」那种），表里没有它，
   * 返回空串 = 不显示姓名牌，正合原作。
   */
  speakerName(code) {
    const key = String(code);
    return this.names[key]
      || this.cache.json.get(SPEAKERS_KEY)?.姓名?.[key]
      || '';
  }

  /** 与最近的对象交谈；对话进行中则补全打字 / 翻页 / 翻到下一句。 */
  talk() {
    // ⚠️ **购物界面开着时空格归它。** 不挡的话按一下既在店里确认购买、
    // 又在场景里跟旁边的 NPC 搭话，两套流程叠在一起跑。
    if (this.statusScreen?.visible || this.shopScreen?.visible || this.innScreen?.visible) return;
    if (this.dialogue.visible) {
      // `advance()` 回真＝这一句念完了。要不要收对话框看**脚本自己给的
      // 「告一段落」位**（释义 op05/op33 的 U 字节：「若是，当句对话完后，
      // 对话栏将消失」），不要自己猜。
      //
      // ⚠️ **这一位是对白与演出的分界线。** 原作是「演动画时根本没有对话框，
      // 所以无从跳过；有对话框时随便你狂按」。收了框，`talk()` 下一次按键
      // 就走不进这个分支了 —— 不需要另外拿锁去禁按键。
      const answering = this.dialogue.answering;
      const picked = this.dialogue.answerValue;
      if (!this.dialogue.advance()) return;
      // 选择句：按下去的那一刻把**选中项的比较值**写进临时标志位，
      // 紧跟的那一组比较指令读它。⚠️ 写的是原样的值（是=1/否=2/行号），
      // 不是布尔 —— 用 `resolve(true/false)` 的话「否」会写成 0，
      // `MP0704` 那类 `==2` 的否支永远走不到。
      if (answering) this.runner?.answer(picked);
      if (this.line?.end) this.dialogue.hide();
      this.resumeScript();
      return;
    }
    // 剧情演出中（黑幕、等待）不该被空格另起一段
    if (this.runner) return;
    const actor = this.nearbyActor();
    if (actor) this.interactWith(actor);
  }

  interactWith(actor) {
    const actions = this.slotActions(actor.talk);
    const item = this.heldItem ?? null;
    this.heldItem = null;
    if (item != null && !actions?.some(a => ['test_item_used', 'use_item_here'].includes(a.type))) {
      this.sayLine(sharedLine(this, SHARED.WRONG_PLACE));
    } else if (actions) this.startScript(actor.talk, 0, null, item);
  }

  /**
   * 按住 Ctrl 快进对话 —— 相当于替玩家连按空格。
   *
   * ⚠️ **询问句必须停下。** `answering` 为真＝选项已经摆出来了，
   * 这时再「替玩家按一下」等于替他选了默认的「是」——
   * 渡口那句「要從這渡口往南岸去嗎？」会在玩家没看清时就把人送过河。
   * 正文（还在打字、还在翻页）照旧快进。
   *
   * ⚠️ 走的是 `talk()` 同一条路，所以「这一句要不要收框」「答案怎么写回」
   * 这些判断只有一份，不会两边走岔。
   */
  updateSkip() {
    if (!this.skipKey?.isDown) return;
    if (!this.dialogue?.visible || this.dialogue.answering) return;
    if (this.time.now < (this.nextSkipAt ?? 0)) return;
    this.nextSkipAt = this.time.now + SKIP_STEP_MS;
    this.talk();
  }

  /** 资源没到时的过渡画面。**只有这一句**，加载完就 `restart` 掉。 */
  showLoading() {
    this.cameras.main.setBackgroundColor('#000000');
    return this.add.text(STAGE_WIDTH / 2, STAGE_HEIGHT / 2, '载入中…',
                         { fontFamily: 'serif', fontSize: '20px', color: '#d8c9a3' })
      .setOrigin(0.5).setScrollFactor(0).setDepth(DEPTH.TOP);
  }

  /**
   * 切图加载超过 LOAD_HINT_MS：在黑幕上显示「载入中… N%」。
   * ⚠️ 主镜头的淡出黑幕盖在它所有物体之上（原先那行提示放在底部提示栏里，其实一直被盖住），
   * 所以这行字单独放一个镜头：主镜头忽略它，新镜头只画它。场景 restart 时一起清掉。
   */
  showLoadingOverFade() {
    const label = this.add.text(STAGE_WIDTH / 2, STAGE_HEIGHT / 2, '载入中…',
                                { fontFamily: 'serif', fontSize: '20px', color: '#d8c9a3' })
      .setOrigin(0.5).setScrollFactor(0);
    this.cameras.main.ignore(label);
    const cam = this.cameras.add(stageView().offsetX, 0, STAGE_WIDTH, STAGE_HEIGHT);
    cam.ignore(this.children.list.filter((o) => o !== label));
    return { label, clear: () => { label.destroy(); this.cameras.remove(cam); } };
  }

  /**
   * 不走脚本、直接说一句话。
   *
   * 目前只有一个用处：菜单里对着剧情道具按「確定使用」之后，回地图弹
   * 「這樣東西似乎不是在此處使用。」（原作原文）。
   *
   * ⚠️ **`end: true`** —— 这一句说完框就该收掉，没有后续。不给这一位的话
   * 按空格会走进 `talk()` 里 `resumeScript()` 那条路，而这里根本没有脚本在跑。
   */
  sayLine(text) {
    if (this.runner || this.dialogue.visible) return;
    const line = { type: 'say', text, speaker: -1, end: true };
    this.line = line;
    this.dialogue.show(line, '');
  }

  /** 当前脚印实际接触的事件槽，不能退回任意半径。 */
  touchedSlots() {
    return new Set(
      this.actors
        .filter((a) => a.touch && this.slotActions(a.touch) && this.steppedOn(a))
        .map((a) => a.touch),
    );
  }

  /**
   * 脚底是不是踩在这个对象的触发区上。
   *
   * **判定形状是精灵画出来的像素**，不是它的包围盒 —— 理由与判据见
   * `systems/touchShape.js`。705 个带 `touch` 的对象里 650 个 `hide=1`，
   * 那些永远不显示的像素**就是原作的判定形状**。
   */
  steppedOn(actor) {
    if (!this.actorIsPresent(actor)) return false;
    return overlapsShapes(this.playerFootprint(), footprintShape(this, actor));
  }

  /** 入场时先记下已经压住的触发槽，免得一落地就被自己脚下的门弹走。 */
  seedTouched() {
    this.bumpTouch = null;
    this.inside = this.touchedSlots();
  }

  /** 跨进一个触发区就演。站着不动不会重复触发，走开再回来会。 */
  checkTouchTriggers() {
    if (this.runner || this.dialogue.visible) return;

    const now = this.touchedSlots();
    // 被挡住的那一步也算踩着（原作 0x409b11 先判踩踏），但同样要「新踩进」才演。
    // ⚠️ 不能绕过 inside 直接演：切图时脚本已结束、新图还在异步加载，人仍推着
    // 大地图城门，每帧重开进城脚本，淡出从亮处重来而形象已换 —— 进城先变大（2026-09-27 回归）。
    if (this.bumpTouch != null) now.add(this.bumpTouch);
    this.bumpTouch = null;
    const entered = [...now].find((slot) => !this.inside.has(slot));
    this.inside = now;
    if (entered !== undefined) this.startScript(entered);
  }

  /** 地返遁符：事件3＝本图槽1；本图没有时用 MP0000 的默认槽1（RPG.exe 0x40b230）。 */
  useReturnCharm() {
    if (this.slotActions(1)?.length) this.startScript(1);
    else this.startScript(1, 0, 'MP0000');
  }

  /**
   * 开演一个事件槽。分支、旗标、跳转都由执行器消化，这里只负责把它
   * 吐出来的动作演出来。
   */
  startScript(slot, start = 0, sourceMap = null, useItem = null) {
    const actions = sourceMap
      ? (this.cache.json.get(`${sourceMap}-map`)?.scripts ?? {})[String(slot)]
      : this.slotActions(slot);
    if (!actions?.length) return;
    // ⭐ **开演之前先把形象切回主角。**
    //
    // Tab 换人（我们加的，原作没有）只改外观，剧情仍然认为主角是夏侯仪。
    // 不切回去的话，用户操作着冰璃时一段剧情开演，画面上就是
    // **「冰璃在说夏侯仪的台词，然后又从她身体里走出来一个冰璃」** ——
    // 因为脚本会 `actor_show 冰璃` 再把她 `actor_to_center` 到主角身上。
    this.restoreHeroAvatar();
    // 记下来源与槽号 —— 跨地图续演时要靠它把脚本从**原来那张图**取回来。
    this.script = { map: sourceMap ?? this.scriptSource ?? this.mapId, slot };
    this.runner = createRunner(actions, this.flags, Math.random, start);
    // ⚠️ **要在 `resumeScript` 之前塞进去** —— 从跳转表那一条起跑时，
    // 第一条就是 `use_item_here`，它当场就要读这个值。
    if (useItem !== null) this.runner.useItem(useItem);
    this.resumeScript();
  }

  /**
   * 换地图之后接着演。
   *
   * ⚠️ **脚本属于原来那张图，不是新图。** 废屋那一槽住在 `MP0212` 里，
   * 而它第 8 条就切到了 `MP0208`；到了新场景再按槽号去查 `MP0208` 的脚本，
   * 查到的是另一段完全不相干的东西（或者什么都查不到，剧情就断在这）。
   * 所以续演时必须带着来源图号。
   */
  resumePendingScript() {
    const pending = this.registry.get('pendingScript');
    if (!pending) return;
    this.registry.set('pendingScript', null);
    this.replayState(pending);
    this.startScript(pending.slot, pending.cursor, pending.map);
  }

  /**
   * 续演之前，把**剧情已经建立的状态**重放一遍。
   *
   * ⚠️ **原作没有这个步骤，是我们的架构逼出来的。** 原作一个进程跑到底，
   * 场上有谁、站在哪、镜头盯着谁从不会丢，所以脚本只交代一次 ——
   * `MP0304` 槽 10 第 33 条 `actor_show 封鈴笙`，第 97 条打完仗回来，
   * 它**不会**再 show 一次。而我们 `scene.start` 重建了场景，人就没了。
   *
   * 挑哪些指令、为什么只留最后一条、为什么主角不算，全在
   * `systems/replayState.js` 的文件头。这里只负责「不出声地演一遍」：
   * 不排队、不等待、不播音效 —— 那些是演出，重放的是**状态**。
   */
  replayState(pending) {
    const actions = this.cache.json.get(`${pending.map}-map`)?.scripts?.[String(pending.slot)];
    if (!actions?.length) return;
    const wanted = stateToReplay(actions, pending.cursor, (n) => isHero(this, n));
    if (!wanted.length) return;

    let done = 0;
    for (const act of wanted) {
      const instant = asInstant(act);
      if (!instant) continue;
      // `performCutscene` 的第三个参数是「演完了叫我」，这里一律给空函数：
      // 重放不进队列、不推进脚本。
      if (performCutscene(this, instant, () => {})) done += 1;
    }
    console.info(`${this.mapId} 续演前重放了 ${done} 条状态指令`
                 + `（槽 ${pending.slot} 的第 0~${pending.cursor - 1} 条）`);
  }

  /** 取下一个要演的动作；取不到就收场。 */
  resumeScript() {
    // ⚠️ **等待场上动作时，按键不许推进脚本。**
    //
    // `say` 显示之后对话框一直挂着，于是 `await_actions` 在等的同时，
    // 玩家按空格会走 `talk()` → `dialogue.advance()` → 这里 ——
    // **同步点就被绕过去了**，动画还没播完剧情已经跑到后面，
    // 表现是「狂按空格一下子就瞬移到小兵摆好架势开打」。
    if (!this.runner || this.waiting) return;
    const action = this.runner.next();
    if (action) this.perform(action);
    else this.endScript();
  }

  /**
   * **`test_item_used`：问玩家要不要拿一件道具放上去。**（A 方案）
   *
   * 原作是「先在菜单里点物品、再点场景里的目标」两步鼠标操作；我们全键盘，
   * 于是改成**在目标前按空格 → 跳法宝页只列候选 → 选中 → 放上去**。
   * 用户拍板：「物品使用逻辑就用你说的这个 A」。
   *
   * 脚本的结构见 `eventScript.itemChoicesAt`：这一条的 `target` 指向
   * 一串 `use_item_here`，那串就是「这一处认哪几件」。
   *
   * 四条出口，**每一条都必须让脚本继续走**，否则剧情停在这儿、人物动不了：
   *
   * | 情况 | 怎么走 |
   * |---|---|
   * | 已经拿着道具（原作那条路留着） | 直接跳进跳转表 |
   * | 候选一件都不在身上 | 不弹菜单，走「只是看看」那一支（原作的描述句） |
   * | 玩家挑了一件 | 记下它 → 跳进跳转表 → 由 `use_item_here` 分派对/错 |
   * | 玩家按 ESC | 也走「只是看看」那一支 |
   *
   * ⚠️ **只列身上真有的候选，且不标出哪件是对的。** 三根柱子认的是
   * 402/403/404，三件**都叫「黑石球」** —— 谜题就是"哪个放哪根"，
   * 列表里照样是三行一模一样的名字。
   */
  askForItem(action) {
    const runner = this.runner;
    if (!runner) return;
    if (runner.holdingItem()) {                 // 原作路径：菜单里已经拿出来了
      runner.jump(action.target);
      this.resumeScript();
      return;
    }
    // 脚本里的道具代码是**十进制**，背包里是**十六进制字符串** —— 判据表有这条。
    const byHex = new Map(runner.itemChoices(action.target)
      .map((code) => [itemKey(code), code]));
    const held = new Set((this.registry.get(STATE_KEY)?.inventory ?? [])
      .map((row) => itemKey(row.代码)));
    const choices = [...byHex.keys()].filter((hex) => held.has(hex));
    if (!choices.length) { this.resumeScript(); return; }

    // ⭐ **先让描述句演完，再弹选单。**
    //
    // 原作是两步：点一下柱子 → 「這柱子的式樣好奇怪….」→ 玩家自己去菜单里
    // 拿道具 → 再点柱子 → 放上去。所以**描述句一定在选道具之前**。
    // 第一版做成了「按空格直接弹选单、选完才演描述句」，顺序是反的，
    // 用户一眼看出来。
    //
    // 脚本这条之后就是 `say` + `end`，所以这里只记一笔、让脚本自己走完，
    // 收场时（`endScript`）再弹选单 —— 选中之后**从跳转表那一条重新进脚本**。
    this.pendingItemAsk = {
      slot: this.script?.slot, map: this.script?.map,
      target: action.target, choices, byHex,
    };
    this.resumeScript();
  }

  /**
   * 描述句演完了，该问「要放哪件」了。由 `endScript` 调。
   *
   * 选中之后**重新开一遍脚本**，从 `test_item_used.target`（跳转表第一条）起 ——
   * 那正是原作「玩家拿着道具再点一次柱子」走的路。
   */
  askPendingItem() {
    const ask = this.pendingItemAsk;
    this.pendingItemAsk = null;
    if (!ask || ask.slot === undefined || ask.slot === null) return;
    this.statusScreen?.openItemPicker(ask.choices, (hex) => {
      if (hex === null || !ask.byHex.has(hex)) return;    // 没挑就什么都不做
      this.startScript(ask.slot, ask.target, ask.map, ask.byHex.get(hex));
    });
  }

  /**
   * 等场上的动作演完。
   *
   * `systems/cutscene.js` 把还在跑的补间/动画登记在 `this.running` 里。
   * ⚠️ **要设上限**：某条动画的结束回调万一没触发（素材缺帧、场景中途重启），
   * 不封顶就永远停在这一条，整段剧情静默卡死。
   */
  waitForActions(waited = 0) {
    if (!this.runner) return;
    this.waiting = true;
    if (!this.running?.size || waited >= ACTION_WAIT_MAX_MS) {
      this.waiting = false;
      if (waited >= ACTION_WAIT_MAX_MS && this.running?.size) {
        console.warn(`等待场上动作超时（还有 ${this.running.size} 个没结束），继续演下去`);
        this.running.clear();
      }
      this.resumeScript();
      return;
    }
    this.time.delayedCall(ACTION_WAIT_STEP_MS,
                          () => this.waitForActions(waited + ACTION_WAIT_STEP_MS));
  }

  endScript() {
    // ⚠️ **先把「还欠玩家一次提问」取出来再清场** —— `askPendingItem` 要
    // 用 `this.script` 里的槽号与来源图把脚本重新跑一遍。
    const ask = this.pendingItemAsk;
    this.runner = null;
    this.script = null;
    this.waiting = false;
    this.running?.clear();
    // ⚠️ **镜头要还给主角。** 全库 `camera_follow` **318 次**、
    // `camera_hero` 只有 **152 次** —— 166 次没有配对的还原指令，
    // 所以原作必然是「剧情一收场镜头就回主角」，而不是靠脚本自己写回来。
    // 不还的表现是**人能走、镜头不动**：迦夏之窟外下了马车之后，
    // 往哪个方向走都是「夏侯仪走出画面消失、地图纹丝不动」。
    this.cameraTarget = null;
    // ⚠️ **循环音效要停。** `play_audio kind=1 loop=1` 全库 18 处
    // （马蹄 `track=24` 占 9 处），播了没人停的话下了马车马蹄声还在响。
    this.stopLoopSfx();
    // 通道也要清 —— 留着 busy 会让下一段剧情的显隐全排进一个永远不放行的队列。
    this.animGate = { busy: false, queue: [] };
    this.line = null;
    this.dialogue.hide();
    // ⭐ **败阵要抢在下面两件事之前，而且把它们全吃掉。**
    // 全灭之后既不该续演下一段（`afterScript`），也不该弹「要放哪件道具」——
    // 后者会当场把菜单的挑件页开出来，开完再切场景就是一个关不掉的选单；
    // 前者会先 `startScript` 一段新的，再被 `playDefeat` 的 `startScript` 冲掉。
    if (this.pendingDefeat) {
      this.afterScript = null;
      this.pendingItemAsk = null;
      this.playDefeat();
      return;
    }
    // 一段演完之后接着演下一段（同一槽的下一个子事件）。见 `queueAfterScript`。
    const next = this.afterScript;
    this.afterScript = null;
    if (next) next();
    // ⭐ **描述句演完了，再问「要放哪件」** —— 顺序见 `askForItem`。
    // 放在最后：前面那些清场（镜头、音效、对话框）都得先做完。
    if (ask) { this.pendingItemAsk = ask; this.askPendingItem(); }
  }

  /**
   * 停掉所有还在循环的剧情音效。
   *
   * 循环音效由 `cutscene.js` 的 `play_audio`（`kind=1 loop=1`）登记进
   * `this.loopSfx`。一次性音效（773 处）自己会放完，不登记也不用管。
   */
  stopLoopSfx() {
    for (const sound of this.loopSfx ?? []) {
      try { sound.stop(); sound.destroy(); } catch (err) {
        console.warn('停循环音效失败：', err?.message ?? err);
      }
    }
    this.loopSfx = [];
  }

  /** 这一段脚本收场之后接着做什么。**只排一个**，谁排谁负责。 */
  queueAfterScript(fn) {
    this.afterScript = fn;
  }

  /**
   * `play_movie`（op98「播放劇情動畫」）。
   *
   * 原作的影片是 **Bink Video**（`multimedia/Mov/N.Dat`，头四字节 `BIKi`），
   * 浏览器放不了，`tools/export_movies.py` 用 ffmpeg 转成
   * `assets/movies/movN.mp4`（ffmpeg 自带 binkvideo/binkaudio 解码器）。
   *
   * 盖一个全屏 `<video>` 在 canvas 上，播完（或玩家按键跳过）再 `resumeScript()`。
   *
   * ⚠️ **跳过是我们加的**，原作能不能跳没有依据，见 `docs/状态/复现度台账.md`。
   * ⚠️ **没有影片文件也必须放行**：转码是可选步骤，缺文件就当这一条演完了，
   *    否则整段剧情静默卡死在这里。
   */
  playMovie(action) {
    const index = Number(action.movie);
    const done = () => {
      this.cameras.main.setAlpha(1);
      this.movieEl?.remove();
      this.movieEl = null;
      this.input.keyboard.enabled = true;
      // ⚠️ **影片期间地图 BGM 要静音** —— 影片自带音轨，两首曲子叠在一起。
      muteBgm(this, false);
      this.resumeScript();
    };
    if (!Number.isFinite(index)) { done(); return; }

    const parent = this.game.canvas?.parentElement;
    if (!parent) { console.warn(`play_movie ${index}: 没有画布容器`); done(); return; }

    const video = document.createElement('video');
    video.src = `assets/movies/mov${index}.mp4`;
    video.autoplay = true;
    video.playsInline = true;
    Object.assign(video.style, {
      position: 'absolute', inset: '0', width: '100%', height: '100%',
      objectFit: 'contain', background: '#000', zIndex: '9999',
    });
    // ⚠️ **`getComputedStyle` 不能少**：容器若是 static，绝对定位会跑到
    // 更外层的祖先上去，影片盖不住画布。
    if (getComputedStyle(parent).position === 'static') parent.style.position = 'relative';

    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      window.removeEventListener('keydown', skip, true);
      done();
    };
    const skip = (ev) => {
      if (!['Space', 'Escape', 'Enter'].includes(ev.code)) return;
      ev.preventDefault();
      ev.stopPropagation();
      finish();
    };
    video.addEventListener('ended', finish);
    video.addEventListener('error', () => {
      console.warn(`play_movie ${index}: 放不了 ${video.src}`
                   + '（跑 tools/export_movies.py 转码）');
      finish();
    });
    window.addEventListener('keydown', skip, true);
    // 影片播放期间键盘归它 —— 不停的话空格会同时推进对话框。
    this.input.keyboard.enabled = false;
    // 原作放过场影片时只有影片自己的声音，见 `bgm.muteBgm`。
    muteBgm(this, true);

    parent.appendChild(video);
    this.movieEl = video;
    // 浏览器可能拦自动播放（没有用户手势）。拦了就当放过了，别卡住。
    video.play?.().catch((err) => {
      console.warn(`play_movie ${index}: 自动播放被拦下（${err?.name}）`);
      finish();
    });
  }

  /**
   * `set_avatar`（op68「切换角色行走形象」）。
   *
   * 释义：`00黑龙 01小夏侯仪 02夏抱冰 03大夏侯仪 04霍雍`，
   * 「一般用于出入大地图时；如果无此子事件，则切换地图不更改行走形象」。
   *
   * 形象记在 registry 上而不是场景上 —— 脚本里这条常与 `goto_map` 挨着，
   * 而切图是 `scene.restart()`，挂在场景上换完立刻就没了。
   *
   * ⚠️ **认不出的代码留一行日志并保持原样**，不要静默换成错的人。
   * 映射表只填了能验证的那一个，理由见 `config.AVATAR_SPRITES`。
   */
  /**
   * `set_avatar` 的代码 → 精灵键。
   *
   * **正本是 `avatars.json`**（`tools/export_party.py` 从共享库的
   * `MAINNPC.SCI` 生成，那张表的下标就是代码）；`AVATAR_SPRITES` 只是
   * json 拉不到时的兜底。见 `config.js` 里那两段注释。
   */
  avatarKey(code) {
    const table = this.cache.json.get(AVATARS_KEY)?.形象;
    return table?.[String(code)] ?? AVATAR_SPRITES[Number(code)] ?? null;
  }

  setAvatar(code) {
    const key = this.avatarKey(code);
    if (!key) {
      console.warn(`set_avatar: 行走形象代码 ${code} 还没有对应精灵，保持原样`);
      return;
    }
    // ⚠️ **代码也要记。** 剧情按「当前形象的名字」点主角
    // （大地图上是 `小夏侯儀`），`cutscene.isHero` 靠它反查。
    if (this.useAvatarSprite(key)) this.registry.set('avatarCode', Number(code));
  }

  /**
   * 就地把主角换成某条行走精灵。**只管外观**，不碰 `avatarCode`。
   *
   * `set_avatar`（剧情）与 Tab（我们加的换人）都走这里，区别只在
   * 前者还会记下形象代码。
   *
   * @returns {boolean} 换成功了没有
   */
  useAvatarSprite(key) {
    const data = this.cache.json.get(`${key}-sprite`);
    if (!data) {
      console.warn(`换行走形象：精灵 ${key} 没预载，保持原样`);
      return false;
    }
    this.registry.set('avatarSprite', key);
    if (this.player?.key === key) return true;

    // 就地换：位置、朝向、遮挡、残影都要跟着重建，
    // 少一样的表现分别是「人瞬移回出生点」「转身不换帧」「不再被建筑挡住」。
    const at = { ...this.playerPos };
    this.player?.destroy();
    this.playerData = data;
    this.idles = idleSegments(data);
    this.player = new FieldSprite(this, key, at.x, at.y, null, false, true);
    this.player.setSceneContainer(this.layerViews[this.activeLayer].container);
    this.player.hold(standFrame(data, this.facing));
    this.playerOccluder = this.occlusion?.attach(data, PLAYER_DRAW) ?? null;
    this.playerOccluder?.update(at.x, at.y);
    this.playerBox = spriteBox(data?.frames, PLAYER_DRAW);
    return true;
  }

  /**
   * 把地图上的形象切回**主角**（`avatarCode` 指的那个）。
   *
   * Tab 换过人之后 `avatarSprite` 指着队友，而剧情里的主角仍然是夏侯仪 ——
   * 剧情一开演必须先切回来，见 `startScript`。已经是主角就什么都不做。
   */
  defaultHeroSprite() {
    return this.mapId === WORLD_MAP ? this.avatarKey(WORLD_MAP_AVATAR) : PLAYER_SPRITE;
  }

  restoreHeroAvatar() {
    // 与入场默认形象一致；无形象记录的世界地图不能在触发事件时突然变大。
    const hero = this.avatarKey(this.registry.get('avatarCode')) ?? this.defaultHeroSprite();
    // 大/小夏侯仪都是主角；普通触发事件不能替代set_avatar改变地图比例。
    // 包括入场后gameState才从测试存档补入形象码、显示与登记暂不同步的入口。
    const xiahou = [this.avatarKey(1), this.avatarKey(3)];
    if (xiahou.includes(this.player?.key) && xiahou.includes(hero)) return;
    if (!hero || this.player?.key === hero) return;
    this.useAvatarSprite(hero);
  }

  /**
   * **Tab：换地图上操作的角色。⚠️ 原作没有这个机制**（判据见
   * `systems/avatarRoster.js` 的模块头），是用户要的架构新增，台账 🔵。
   *
   * **只换外观**：队伍顺序、菜单队首、战斗出场、存档的 `@57583` 一概不动。
   * 用户原话：「纯换地图角色，不改菜单的东西」。
   *
   * ⚠️ 所以这里**不设 `avatarCode`** —— 剧情仍然认为主角是夏侯仪，
   * 一条 `set_avatar` 就能把外观收回去。代价是：剧情若正好让某个队友出场，
   * 而你又正操作着他，场上会出现两个同样的人。台账里记着。
   *
   * ⚠️ **剧情演着的时候不许换** —— 换精灵要重建 `player`，
   * 而剧情正拿着它做补间/摆位。
   */
  fieldInputAvailable() {
    return Boolean(this.playerPos) && !this.loading && !this.leaving && !this.runner && !this.dialogue?.visible
      && !this.statusScreen?.visible && !this.shopScreen?.visible && !this.innScreen?.visible;
  }

  pointerActor(pointer) {
    const p = pointer.positionToCamera(this.cameras.main);
    return [...(this.actors ?? [])].sort((a, b) => b.y - a.y).find(a => {
      if (!a.mouse || a.doorOpen || a.hidden || a.sprite?.hidden === true || a.hide) return false;
      const signature = `${a.x}:${a.y}:${a.sprite?.frameIndex}`;
      if (a.pointerSignature !== signature) { clearShape(a); a.pointerSignature = signature; }
      return hitsShape(touchShape(this, a), p.x, p.y);
    });
  }

  pointerOnPlayer(pointer) {
    if (!this.player || this.player.hidden) return false;
    const p = pointer.positionToCamera(this.cameras.main);
    const actor = this.playerPointerActor ??= {};
    const signature = `${this.player.key}:${this.player.frameIndex}`;
    if (actor.signature !== signature) { clearShape(actor); actor.signature = signature; }
    const dx = this.playerPos.x - (actor.x ?? this.playerPos.x);
    const dy = this.playerPos.y - (actor.y ?? this.playerPos.y);
    if (actor.touchShape) { actor.touchShape.x += dx; actor.touchShape.y += dy; }
    Object.assign(actor, { x: this.playerPos.x, y: this.playerPos.y, dx: this.player.draw?.x ?? 0,
      dy: this.player.draw?.y ?? 0, data: this.player.data, sprite: this.player, key: this.player.key });
    return hitsShape(touchShape(this, actor), p.x, p.y);
  }

  mouseCursor(pointer) {
    if (!this.fieldInputAvailable()) return { kind: 'hand' };
    const a = this.pointerActor(pointer);
    if (this.heldItem != null) return a
      ? { kind: 'place', disabled: this.distanceTo(a) >= INTERACT_RANGE }
      : { kind: 'itemTarget' };
    if (this.pointerOnPlayer(pointer)) return { kind: 'book' };
    if (a) return { kind: ['hand','inspect','pickup','talk','door','place'][a.mouse] ?? 'hand',
      disabled: a.mouse < 5 && this.distanceTo(a) >= INTERACT_RANGE };
    const p = pointer.positionToCamera(this.cameras.main);
    return { kind: 'direction', direction: directionFromVector(p.x - this.playerPos.x, p.y - this.playerPos.y + 40) ?? 0 };
  }

  fieldPointerDown(pointer) {
    if (pointer.rightButtonDown()) {
      this.blockMouseMove = !this.fieldInputAvailable();
      if (this.heldItem != null) { this.heldItem = null; this.blockMouseMove = true; return; }
      if (pointer.leftButtonDown() && !this.blockMouseMove) this.registry.set('running', !this.wantsRun());
      if (this.statusScreen?.visible) this.statusScreen.escape();
      else if (this.shopScreen?.visible) this.shopScreen.escape();
      else if (this.innScreen?.visible && this.innScreen.stage !== 'movie') this.innScreen.back();
      return;
    }
    if (!pointer.leftButtonDown() || this.statusScreen?.visible || this.shopScreen?.visible || this.innScreen?.visible) return;
    if (this.dialogue?.visible) {
      if (this.dialogue.pickAt(pointer)) this.talk();
      return;
    }
    if (!this.fieldInputAvailable()) return;
    if (this.heldItem == null && this.pointerOnPlayer(pointer)) { this.statusScreen.toggle(); return; }
    const actor = this.pointerActor(pointer);
    if (actor && (this.heldItem == null && actor.mouse >= 5 || this.distanceTo(actor) < INTERACT_RANGE)) {
      this.interactWith(actor);
    }
  }

  switchAvatar() {
    if (!this.fieldInputAvailable()) return;
    // ⚠️ **大地图上不许换人。** 那儿原作只有 `小夏侯儀`（`s1.SF2` 20×51）在走，
    // 城里那个 `大夏侯儀` 是 `1.SF2` 36×90 —— **正好一倍大**。队友的行走精灵
    // 全是城里那个尺寸，Tab 换上去就是「人凭空大一圈」（用户 2026-09-19 报）。
    // 判据：全库 61 处「进大地图」都紧跟 `set_avatar 1`（`WORLD_MAP_AVATAR`），
    // 即大地图上只认那一条小精灵。
    if (this.mapId === WORLD_MAP) {
      this.notice = { text: '大地圖上不換人', until: this.time.now + 1200 };
      return;
    }
    const party = this.registry.get(STATE_KEY)?.party;
    // ⚠️ **主角那一格要按「形象代码」查，不能用 ** ——
    // Tab 自己就在改 ，拿它当"主角长什么样"会让代码 1 变成
    // 当前正操作的那个队友，轮换表当场塌成两个人来回跳（实测过）。
    const keys = switchableAvatars(
      party, this.cache.json.get(AVATARS_KEY),
      this.avatarKey(this.registry.get('avatarCode')),
      (k) => Boolean(this.cache.json.get(`${k}-sprite`)),
    );
    const next = nextAvatar(keys, this.player?.key);
    if (!next) return;                       // 队伍只有一个人，Tab 没反应
    this.useAvatarSprite(next);
  }

  /**
   * `open_shop`（op54「彈出購物介面」）。
   *
   * **货物随剧情变不在这里** —— 那是脚本自己的分支。武具店那一槽是
   * `branch 旗标1>46 → open_shop 45`、`>39 → 33`、`>28 → 21`、否则 `open_shop 1`，
   * 阈值判断由执行器完成，到这里 `action.shop` 已经是定好的那一个编号。
   *
   * ⚠️ **关店之后才继续演** —— 店里那句「多謝惠顧！歡迎再來！」就在
   * `open_shop` 的下一条。所以 `resumeScript` 挂在关店回调上，不能立即调。
   */
  openShop(action) {
    if (!this.shopScreen) {
      console.warn('购物界面没建起来，跳过 open_shop');
      this.resumeScript();
      return;
    }
    this.shopScreen.open(action.shop, () => this.resumeScript());
  }

  /**
   * `open_door`（op8F「開門」）。
   *
   * 释义原文只说对了一半：
   * 「X=門的名稱，Y=**跳轉至**第幾個事件（不是子事件，是事件），
   * 02（**可能**是門的狀態，開/關，02可能指代第2幀圖片，不確定）」。
   *
   * 数据把两处不确定都定死了：
   *
   * **`state` 就是帧号。** 门精灵逐帧渲染过（`NE0101-01/02/05` 都一样）：
   * 帧 0 = 一条蓝色细线（**门槛判定条**，就是 `touchRect` 用的那个矩形），
   * 帧 1 = **门关着**，帧 2/3 = **门开着**。SCI 给门的定格帧写的是 `[1,1]`
   * ——**初始就是关的**。于是 `state=2` 是开（全游戏 76 处），
   * `state=1` 是关（16 处，`MP0604` 牢门 `event=0 state=1` 就是纯粹关门）。
   *
   * **`event` 不是「跳转」，是「挂到这扇门上当踩踏事件」。** 三条反证：
   * * `MP0608` 槽 16 开门之后还有 7 条要演（NPC 走位 → 主角走位 → 才切图），
   *   立刻跳转的话这 7 条永远演不到
   * * `MP0902` 开牢门后紧接 `actor_hide 牢門` / `actor_show door2`
   * * `MP0604` 右牢房门的 `event` 指回**它自己那一槽** —— 立刻跳转就是死循环
   *
   * 挂成**踩踏**（不是交谈）：带 `open_door` 的门自己都没有 `touch` 槽，
   * 而原作的体验是「先开门，看见里面有路了，走进去才切图」。
   *
   * ⚠️ 事件号要减 `EVENT_SLOT_BIAS`，见那个常量。
   */
  openDoor(action) {
    const door = this.doorNamed(action.name);
    if (!door) {
      console.warn(`open_door: 本图没有名叫「${action.name}」的门`);
      return false;
    }
    this.rememberDoorInteraction(door);
    const target = Number(action.state);
    if (Number.isFinite(target) && door.sprite) {
      // ⚠️ **`state` 是「播**到**第几帧」，不是「跳到第几帧」。**
      //
      // 原先写的是 `hold(state)` —— 一瞬间就成了开完的样子，
      // **中间的开门过程整段丢掉**（`MP0301` 那扇门开时地上会升起绿色气体，
      // 就在帧 4~13 那段）。用户报「咔嚓一下，一瞬间就变成打开之后的了」。
      //
      // 判据是素材的帧结构 —— 门的精灵整条就是一套开门动画：
      //
      // | 门 | 帧 0 | 关着 | 开门过程 | 开完 | 脚本给的 `state` |
      // |---|---|---|---|---|---|
      // | `ND0301-01`(25 帧) | 判定条 | 帧 2 | **帧 4~13**（img 2~10，高 363→346） | 帧 14~24 | **22** |
      // | `ND0302-05`(17 帧) | 判定条 | 帧 2 | 帧 3~15 | 帧 16 | **14** |
      // | `ND0303-02`(4 帧) | 判定条 | 帧 2 | 无中间帧 | 帧 1 | **1** |
      //
      // 那些 `20/22/14/11` 的大 `state` 正是**动画末帧** —— 它们只有在
      // 「播到那一帧」的读法下才讲得通。
      const from = door.sprite.frameIndex ?? this.closedFrameOf(door);
      const settle = () => {
        this.applyDoorState(door, target !== this.closedFrameOf(door));
        // ⚠️ **把门的状态写回旗标 —— 这是原作自己的存法。**
        // 判据是存档差分：原版里开一次门，整个存档只改了一个字节，
        // 就是这扇门 `flag` 位上的 `254 → 255`（见 `doorIsOpen`）。
        // 这样它天然跨场景、跨存档，不需要我们自己再存一份。
        if (door.flag) {
          this.flags?.set?.(door.flag, door.doorOpen ? DOOR_OPEN : DOOR_CLOSED);
        }
      };
      if (target > from) {
        // ⚠️ **整段播完之前不放行**：`doorOpen` 留到 `onDone` 里才置，
        // 于是开门动画期间门仍然挡路 —— 那正是原作的样子（门还没开完）。
        door.sprite.playSegment(from, target - from + 1, { loop: false, onDone: settle });
      } else {
        // 往回走（关门、或已经在目标帧上）。**倒放没有判据**，直接定格。
        door.sprite.hold(target);
        settle();
      }
    }

    const slot = Number(action.event) - EVENT_SLOT_BIAS;
    // event 可以是空事件（`end` / `noop`）—— 那就只是开/关门，没有后续。
    if (target !== this.closedFrameOf(door) && this.slotActions(slot)) door.touch = slot;

    // ⚠️ **挂上之后要重新登记「此刻已经踩着的槽」**，否则玩家若正好站在
    // 门槛上（剧情把人放过去的情况），新挂的槽会被当成「刚踩进来」立刻触发。
    this.seedTouched();
    return false;         // 不改跑别的槽，调用方照常 resumeScript
  }

  /**
   * NPC 在自己那一小块地盘里溜达。范围来自 SCI 的 `RangeX/RangeY`，
   * 走法是我们编的 —— 判据与手感值见 `systems/roam.js` 的文件头。
   *
   * ⚠️ **剧情演出期间不走。** 那时 `actor_walk` 正拿补间推同一批人
   * （高老丈家那段就把封铃笙他们四个推来推去），两边都写位置会打架。
   */
  updateRoamers(delta) {
    if (this.runner || !this.roamers?.length) return;
    const speed = WALK_SPEED * ROAM.SPEED_RATIO;
    for (const actor of this.roamers) {
      if (actor.hidden || actor.sprite?.hidden) continue;
      const at = { x: actor.x, y: actor.y };
      const { roamer, dx, dy } = advanceRoamer(actor.roamer, at, delta, {
        speed, canStand: (x, y) => this.walkable(x, y) && !this.npcHitsObject(actor, x, y),
      });
      actor.roamer = roamer;
      if (!dx && !dy) {
        this.poseRoamer(actor, 0, 0);
        continue;
      }
      // 走的时候仍旧过一次逐像素扫掠 —— 挑点时虽然验过落点可走，
      // 中间未必走得通（`slideAxis` 的理由见那里）。
      const moved = this.slideActor(actor, dx, dy);
      if (moved < Math.hypot(dx, dy) * 0.25) actor.roamer = giveUp(roamer);
      this.poseRoamer(actor, dx, dy);
    }
  }

  /** 把一个 NPC 沿两轴逐像素推过去，返回真正走了多少像素。 */
  slideActor(actor, dx, dy) {
    let moved = 0;
    for (const [axis, delta] of [['x', dx], ['y', dy]]) {
      if (!delta) continue;
      const sign = Math.sign(delta);
      let left = Math.abs(delta);
      while (left > 0) {
        const stride = Math.min(STEP_PROBE_PX, left);
        const next = actor[axis] + sign * stride;
        const x = axis === 'x' ? next : actor.x;
        const y = axis === 'y' ? next : actor.y;
        if (!this.walkable(x, y) || this.npcHitsObject(actor, x, y)) break;
        actor[axis] = next;
        moved += stride;
        left -= stride;
      }
    }
    actor.sprite?.setPosition(actor.x, actor.y);
    actor.occluder?.update(actor.x, actor.y);
    return moved;
  }

  /** 溜达中的 NPC 该播哪一段：在走就走路段，停下就用朝向的站立帧。 */
  poseRoamer(actor, dx, dy) {
    const sheet = actor.data;
    if (!sheet || !actor.sprite) return;
    const dir = directionFromVector(dx, dy * ISO_RATIO);
    if (dir === null) {
      if (actor.roamWalking) {
        actor.roamWalking = false;
        actor.sprite.hold(standFrame(sheet, actor.roamFacing ?? screenFacing(actor.facing)));
      }
      return;
    }
    actor.roamFacing = dir;
    const seg = walkSegment(sheet, dir);
    if (actor.sprite.start !== seg.start || actor.sprite.count !== seg.count) {
      actor.sprite.playSegment(seg.start, seg.count, { loop: true });
      actor.sprite.stop();
    }
    actor.roamWalking = true;
    // ⚠️ **按走过的距离推进，不按时间** —— 与主角同理，见 `FieldSprite.advance`。
    actor.sprite.advance(Math.hypot(dx, dy), STRIDE_PX);
  }

  /**
   * 本图脚本里被 `open_door` 点过名的对象名（小写）。
   *
   * ⚠️ **`Mouse=4` 漏门。** 全库被 `open_door` 点名的 87 个对象里
   * **13 个不是 `mouse=4`**：`MP0301`/`MP0302` 的「門出入口」是 `1`（放大镜）、
   * `MP0801` 那几家铺子的出入口是 `2`（可拾取）、`MP1009E 右上密室門` 是 `0`。
   * 名字全都带「出入口 / 門」—— **它们就是门**，`Mouse` 只是鼠标光标长什么样，
   * 不是「这东西是不是门」。
   *
   * 后果：`MP0301` 的门画出来是关着的，却**不挡路，走上去直接切图**。
   * 判据换成「原作脚本自己拿 `open_door` 推它」—— 那是数据说的，比枚举硬。
   */
  scriptedDoorNames() {
    const names = new Set();
    for (const acts of Object.values(this.scripts ?? {})) {
      for (const a of acts) {
        if (a?.type === 'open_door' && a.name) names.add(String(a.name).toLowerCase());
      }
    }
    return names;
  }

  collectDoors() {
    const scripted = this.scriptedDoorNames();
    // ⚠️ **只把「有开关两态」的补进来。** 那 13 个里 10 个是 `frames=[1,1]`
    // （药铺、杂货铺的出入口）—— **起=止就没有「关」这个状态**，
    // 原作里本来就是走过去直接进，补进来反而会把店门堵死。
    // 三扇两态的才是用户撞上的那种：`MP0301`/`MP0302` 的門出入口、`MP1202 右方密門`。
    const twoState = (a) => {
      const [from, to] = (a.frames ?? []).map(Number);
      return Number.isFinite(from) && Number.isFinite(to) && from !== to;
    };
    this.solidDoors = this.actors.filter(
      (a) => !a.hide && a.sprite
             && (a.mouse === MOUSE_DOOR
                 || (scripted.has(String(a.name).toLowerCase()) && twoState(a))));
    // `isSolidDoor` 靠它认门 —— 那边不再重复判 `mouse`，见那里的说明。
    this.doorSet = new Set(this.solidDoors);
    for (const door of this.solidDoors) this.rememberDoorInteraction(door);
    this.restoreDoors();
    // 出房落点可能压在门框内，但不能因此把“关门画面”当作开门。
    // spawnPlayer 通过 findOpenSpot 找附近可通行点；交互、阻挡由真实门态决定。
  }

  /**
   * 把**之前开过的门**恢复成开着的样子。
   *
   * ⚠️ **这曾经是病根 E 的第四次**（走出去再回来，石门又关上了）。
   *
   * 当时我以为「原作靠进程不重建保持，没有对应数据」，于是自己造了一套
   * `worldState` 去存。**那是错的** —— 原作有机制，就存在门自己的 `flag` 位上
   * （`254` 关 / `255` 开），判据见 `doorIsOpen`。
   *
   * 找到它的办法是**存档差分**：在原版里把那件事做一遍，前后各存一档，
   * 差出来的字节就是答案。这次差出来**只有一个字节**。
   */
  restoreDoors() {
    for (const door of this.solidDoors ?? []) {
      const open = this.doorIsOpen(door);
      if (open) {
        door.sprite?.hold?.(this.openFrameOf(door));
        // 普通门的 SCI 可能没有 touch；恢复开门时也要恢复脚本挂上的入口。
        const slots = new Set(this.doorOpenActions(door)
          .map(a => Number(a.event) - EVENT_SLOT_BIAS).filter(slot => this.slotActions(slot)));
        if (slots.size === 1) door.touch = [...slots][0];
      }
      this.applyDoorState(door, open);
    }
  }

  rememberDoorInteraction(door) {
    door.closedInteraction ??= { talk: door.talk, mouse: door.mouse, touch: door.touch };
  }

  /** 开门切换为踩踏，关门恢复原交互；显示和碰撞使用同一个 doorOpen。 */
  applyDoorState(door, open) {
    this.rememberDoorInteraction(door);
    door.doorOpen = open;
    clearShape(door);
    if (open) {
      door.talk = null;
      door.mouse = 0;
    } else {
      Object.assign(door, door.closedInteraction);
    }
  }

  /** 按名字找门。大小写不敏感 —— 脚本与对象表的后缀大小写对不上过。 */
  doorNamed(name) {
    const key = String(name ?? '').toLowerCase();
    return this.actors.find((a) => String(a.name).toLowerCase() === key
                                   && a.sprite) ?? null;
  }

  /** 这扇门「关着」是第几帧 —— SCI 的定格帧就是关的那一帧。 */
  closedFrameOf(door) {
    const from = Number((door.frames ?? [])[0]);
    return Number.isFinite(from) ? from : 1;
  }

  /**
   * 这扇门「开着」是第几帧。
   *
   * ⚠️ **`frames` 不是「起始帧, 结束帧」，是「关着的帧, 开着的帧」。**
   * 判据是 9 扇有旗标的门逐帧比对 —— `frames[0]` 与 `frames[1]` 用的
   * **img 各不相同**，而 `frames[1]` 那张正是开着的样子（8/9 命中，
   * 第 9 扇 `MP2101A&B 洞穴出入口` 是 `[1,1]` 的单态门）：
   *
   * | 门 | `frames` | 帧→img |
   * |---|---|---|
   * | `MP0301 門出入口` | `[2,1]` | 帧2→img1（关） / 帧1→img11（开） |
   * | `MP0302 門出入口` | `[2,1]` | 帧2→img0（关） / 帧1→img5（开） |
   * | `MP0303 gate` | `[2,1]` | 帧2→img0（关） / 帧1→img1（开） |
   *
   * 这也解释了为什么它写成 `[2,1]` 而不是 `[1,2]`。
   */
  openFrameOf(door) {
    const to = Number((door.frames ?? [])[1]);
    const closed = this.closedFrameOf(door);
    if (Number.isFinite(to) && to !== closed) return to;
    // 夏侯仪家/老妇人家等 SCI 是 [1,1]，开门动作明确指定 state=2。
    // 不能因初始帧相同，就把关闭的画面用于“已开门”的旗标。
    const targets = new Set(this.doorOpenActions(door).map(a => Number(a.state)));
    return targets.size === 1 ? [...targets][0] : (Number.isFinite(to) ? to : closed);
  }

  doorOpenActions(door) {
    const name = String(door.name).toLowerCase();
    const closed = this.closedFrameOf(door);
    return Object.values(this.scripts ?? {}).flat().filter(a =>
      a.type === 'open_door' && String(a.name).toLowerCase() === name
      && Number.isFinite(Number(a.state)) && Number(a.state) !== closed);
  }

  /**
   * 这扇门此刻开着吗 —— **从旗标读，这是原作自己的存法**。
   *
   * ⚠️ **判据来自存档差分**（用户在原版里开门前后各存一档）：
   * 开门这个动作在整个存档里**只改了一个字节**——
   *
   * ```
   * Save018 → Save019：旗标 1028: 254 → 255
   * ```
   *
   * 而 1028 正是 `MP0301 門出入口` 的 `flag`。11 个不同进度的官方存档全部吻合：
   * 越往后玩，值为 255 的门越多（`Save001` 一扇没有，`Save003` 起
   * 1028/1029/1031 变 255，`Save005` 起再加 1079/1114/1121），
   * 而这 9 个旗标**全部属于门**。
   *
   * | 旗标值 | 含义 |
   * |---|---|
   * | `0` | 这个对象不存在 |
   * | `1` | 存在（普通对象） |
   * | **`254`** | **门存在且关着** |
   * | **`255`** | **门存在且开着** |
   *
   * 所以门的开关**天然跨场景、跨存档** —— 旗标本来就在存档里、
   * `FlagStore` 本来就挂在 registry 上。**不需要我们自己再存一份。**
   */
  doorIsOpen(door) {
    if (!door?.flag) return false;
    return this.flags?.get(door.flag) === DOOR_OPEN;
  }

  /**
   * 关着的门挡不挡路。
   *
   * SCI 里**没有**「门是障碍」这种字段：MB 在门槛处只是往里凹了一个门宽、
   * 约 20px 深的槽，也就是原作允许你站到门槛上。所以「关着的门拦住人」
   * 是我们自己加的一条规则（用户拍板：`docs/状态/复现度台账.md` 有登记）——
   * 不加的话门没开就往里走，人会被建筑的遮挡层整个盖住、凭空消失。
   *
   * 只有**看得见的实体门**（`mouse=4` 且 `hide≠1`）算数：`河州鎮出入口`、
   * `高老丈家出入口` 这些是 `hide=1` 的隐形门槛线，本来就该一踩就走。
   *
   * ⚠️ **还要看精灵藏没藏。** 同一处常常叠着两扇门：河州镇夏侯仪家门口
   * 就有 `夏侯儀家出入口`（flag 1089）与 `夏侯儀抄家出入口`（flag 1221）
   * 两个对象，按剧情阶段只该出现一个；旗标关着的那个仍会**建出隐藏精灵**
   * 等 `actor_show`（见 `spawnObjects` 里 `cued` 那段）。不查这一项的话，
   * 开了门也还是走不进去 —— 挡路的是那扇根本没画出来的门。
   */
  isSolidDoor(actor) {
    // ⚠️ **「是不是门」只由 `collectDoors` 说了算，这里不要再判一遍 `mouse`。**
    // 原先这里重复写了 `actor.mouse === MOUSE_DOOR`，于是 `collectDoors` 把
    // `MP0301` 那扇 `mouse=1` 的门补进 `solidDoors` 之后，**这一行又把它否了**
    // —— 门照样不挡路。判据表「改名字比较要 grep 出全部比较点一次改完」的同款。
    return this.doorSet?.has(actor) === true
           && actor.sprite?.hidden !== true && !actor.doorOpen;
  }

  /**
   * 会改游戏状态的那批剧情动作。
   *
   * 纯逻辑在 `systems/storyActions.js`，这里只负责**取状态、写回、回填旗标**。
   *
   * ⚠️ **`resolve()` 必须调。** 释义对扣除/判断类指令都写着「如果扣除成功，
   * `0xE179 + 0x3E7*2` 处写入 1」—— 它们自己不分支，成败写进 999 号旗标，
   * 由紧跟其后的比较指令去读。不回填不报错，只会静默走错分支：
   * 兰州城那句「三百五十两…这可不是一笔小数目」的分支就是这么一直命中的。
   */
  applyStory(action) {
    const gamedata = this.cache.json.get('gamedata');
    const state = this.registry.get('gameState');
    if (!state || !gamedata) {
      console.warn(`剧情动作 ${action.type} 没有游戏状态可改，跳过`);
      this.runner?.resolve(false);
      return;
    }
    let { party, inventory } = state;
    let ok = true;

    switch (action.type) {
      case 'learn_skill':
        party = learnStorySkill(party, action.which);
        break;
      case 'item_gain':
        inventory = itemGain(inventory, action.item, Number(action.count) || 1);
        break;
      case 'item_lose': {
        const r = itemLose(inventory, action.item, Number(action.count) || 1);
        inventory = r.inventory; ok = r.ok;
        break;
      }
      case 'money_gain':
        party = moneyGain(party, action.amount);
        break;
      case 'money_lose': {
        const r = moneyLose(party, action.amount);
        party = r.party; ok = r.ok;
        break;
      }
      case 'party_join':
        party = partyJoin(party, gamedata, action.member, createMember);
        break;
      case 'party_leave':
        party = partyLeave(party, action.member);
        break;
      case 'heal_percent':
        party = healParty(party, action.hp, action.mp, 'percent');
        break;
      case 'heal_points':
        party = healParty(party, action.hp, action.mp, 'points');
        break;
      case 'exp_gain':
        party = expGain(party, action.member, action.exp, gamedata);
        break;
      case 'test_equip':
        ok = testEquip(party, action.member, action.slot, action.item);
        break;
      case 'test_stat':
        ok = testStat(party, action.member, action.attr, action.value);
        break;
      default:
        console.warn(`applyStory 收到不认识的动作 ${action.type}`);
        ok = false;
    }

    if (party !== state.party || inventory !== state.inventory) {
      updateState(this, { party, inventory });
      this.party = party;
      // 菜单是另一份引用，不同步的话打开菜单看到的还是旧数据。
      this.statusScreen?.syncState?.(party, inventory);
    }
    // ⭐ **全灭 = 败阵。** 只登记，**不当场打断脚本** —— 迦夏之窟放错石球是
    // `heal_points -70` 紧跟一句「好痛....」，当场切走会把那句话吃掉，
    // 而且半途掐断脚本会留下没清的镜头/音效。等这一段收场（`endScript`）再演。
    if (isPartyWiped(party)) this.pendingDefeat = true;
    this.runner?.resolve(ok);
  }

  /**
   * 演一个动作。异步的（对白等按键、黑幕等淡完、op1 等计时）各自在结束时
   * 回调 `resumeScript`；不认识的直接跳过——执行器已保证跳转下标不错位。
   *
   * 说话人名字查 map.json 的人名表，不能拿对象名当说话人：
   * 对象叫「馬車後入口」，说话的却是夏侯仪与封铃笙。
   */
  perform(action) {
    const camera = this.cameras.main;
    // 表现类（人物走位、镜头、特效、过场动画）全交给 systems/cutscene.js，
    // 这里只留流程与游戏逻辑。接了就返回，没接才往下走。
    if (performCutscene(this, action, () => this.resumeScript())) return;
    switch (action.type) {
      // ⚠️ **原作唯一的同步点**（释义 0x1D「等待前述子事件完成」）。
      // 动画与走位是「启动就走」，脚本要同步时自己插一条这个。
      // 场上还有动作在跑就每帧回来看一次，跑完再继续。
      case 'await_actions':
        this.waitForActions();
        return;
      case 'test_item_used':
        this.askForItem(action);
        return;
      case 'say':
        // ⚠️ **整屏过场动画演完了才出对话框。**
        // 废屋第 64~67 条：`play_anim 第一段 45→88`（西夏兵走进屋、站定、
        // 摆架势）之后没有 `await_actions` 就直接 `say` 了，照字面执行就是
        // 「人还在往里走，话已经说上了」。原作是演动画时根本没有对话框 ——
        // 这也正是「动画不能跳过、对白随便跳」那个手感的来源。
        //
        // 只等过场动画，**不等走位**：走位是并行的，脚本要同步时自己会插
        // `await_actions`（槽 16 的两个士兵拦路就是这么写的）。
        //
        // 这里不 `resumeScript()` —— `say` 本来就要等玩家按键，
        // 所以队列里最多只会积着一句。
        if (cutsceneBusy(this)) {
          afterCutscene(this, () => this.perform(action));
          return;
        }
        // 对外暴露「当前这一句」，verify_talk.mjs / verify_dialogue.mjs 靠它核对。
        // `action.end` 就是原作的「告一段落」位，`talk()` 靠它决定收不收框。
        this.line = action;
        this.dialogue.show(action, this.speakerName(action.speaker));
        // ⚠️ **选择没有独立指令**，判据是「下一条正在读临时标志位 0x3E7」。
        // 要把**连续的那一整串**分支都读出来：只看第一条的话，三选一
        // 会被当成是/否，选「是」写 1，`==2/3/4` 一条都不命中，
        // 脚本静默走到 `end` —— 表现就是对话卡死。见 eventScript 的判据段。
        this.dialogue.ask(this.runner?.peekChoices() ?? []);
        return;
      case 'goto_map':
        this.enterMap(action);
        return;
      case 'fade_out':
      case 'fade_in': {
        // 淡出完成之前不能让旧对白的Space/快进提前执行set_avatar/goto_map。
        const runner = this.runner;
        this.waiting = true;
        const out = action.type === 'fade_out';
        camera.once(out ? 'camerafadeoutcomplete' : 'camerafadeincomplete', () => {
          if (this.runner !== runner) return;
          this.waiting = false;
          this.resumeScript();
        });
        camera[out ? 'fadeOut' : 'fadeIn'](fadeMs(action.speed));
        return;
      }
      case 'wait':
        this.time.delayedCall(
          Math.max(0, Number(action.ticks) || 0) * WAIT_MS_PER_TICK,
          () => this.resumeScript(),
        );
        return;
      // ⚠️ **这几条要查/改游戏状态，查完必须 `resolve()` 把成败写回临时标志位**
      // —— 紧跟着的比较指令读的就是它（释义：「如果扣除成功，
      // `0xE179+0x3E7*2` 处写入 1，此位置…仅作为标志位」）。
      // 不回填不会报错，只会静默走错分支。
      case 'item_lose':
      case 'money_lose':
      case 'test_equip':
      case 'test_stat':
      case 'item_gain':
      case 'money_gain':
      case 'party_join':
      case 'party_leave':
      case 'heal_percent':
      case 'heal_points':
      case 'exp_gain':
      case 'learn_skill':
        this.applyStory(action);
        this.resumeScript();
        return;

      case 'set_avatar':
        this.setAvatar(action.avatar);
        this.resumeScript();
        return;
      case 'open_door':
        if (!this.openDoor(action)) this.resumeScript();
        return;
      case 'open_shop':
        // ⚠️ **不能在这里 resumeScript** —— 关店之后才轮到下一条
        // （店里那句「多謝惠顧！歡迎再來！」就在 open_shop 的下一条）。
        this.openShop(action);
        return;

      case 'battle':
        // ⚠️ **进战斗就不 resumeScript** —— 场景换走了，后续由
        // `pendingScript` 在打完回来时接上。拉不起来才当场跳过。
        if (this.enterBattle(action)) return;
        this.resumeScript();
        return;

      case 'open_save':
        // 剧情里的存档点（笔台、天书…）。**不 resumeScript** ——
        // 存完档关掉菜单，脚本的下一条才该轮到（与 `open_shop` 同理）。
        if (!this.statusScreen?.openTianshu(() => this.resumeScript())) this.resumeScript();
        return;

      case 'play_movie':
        // ⚠️ **自己负责 resumeScript**（影片播完/被跳过才轮到下一条）。
        this.playMovie(action);
        return;

      case 'enter_room':
        // RPG.exe 40d6d5写当前事件到998；40d67b在离开客房时清零。
        this.flags.set(998, this.script.slot + EVENT_SLOT_BIAS);
        this.innScreen.open(action.room, () => { this.flags.set(998, 0); this.resumeScript(); });
        return;

      // 尚未接线的游戏逻辑；不能因放行剧情就视为已实现。
      case 'equip_replace':   // 剧情换装，demo 八图里没用到
        this.pending = action.type;
        this.resumeScript();
        return;

      default:
        // 认不出的动作占位放行。⚠️ **这里不留日志是有意的** ——
        // `unknown` 在 demo 八图里有 17 条（4 个释义文档里查无此码的
        // opcode），每帧刷屏没有用。要查缺口跑覆盖统计，别看控制台。
        this.resumeScript();
    }
  }

  /**
   * op58：换地图，落点与朝向都由指令给定。
   *
   * **没有白名单** —— 能不能进由「那张图的 `map.json` 拉不拉得到」决定，
   * 导一张新图就能进，不用改代码。大地图上通往全国的六十多个出口绝大多数
   * 还没导出，那种情况下把幕拉开、停在原地并提示一声，比黑着屏卡死强。
   */
  enterMap(action) {
    const mapId = String(action.map ?? '').toUpperCase();
    // ⚠️ **不再有硬编码白名单。** 能不能进由「`map.json` 拉不拉得到」决定 ——
    // 导一张新图就能进，不用改代码。拉不到时 `ensureMap` 会 reject，
    // 我们在下面退回原地并提示。
    //
    // ⚠️ **换场景会销毁执行器，所以进度必须先存出去。**
    // 原作大量过场是「切图之后接着演」—— 兰州城废屋那一槽 `goto_map`
    // 在第 8 条，而对白从第 15 条才开始。不存进度的话剧情就断在门口，
    // 而且不会报错，看起来只是"进屋之后什么都没发生"。
    // 旗标本来就在 registry 里跨场景保持，这里只需要再带上「演到哪了」。
    if (this.runner && !this.runner.done && this.script) {
      this.registry.set('pendingScript', {
        map: this.script.map,
        slot: this.script.slot,
        cursor: this.runner.cursor,
      });
    }
    this.runner = null;
    this.enterAfterLoad(mapId, { x: action.x, y: action.y, facing: action.facing },
                        action.map);
  }

  /**
   * 拉完那张图的资源再切场景。
   *
   * **加载放在黑幕里**：`goto_map` 前面本来就有 `fade_out`，此刻画面已经全黑，
   * 玩家看不到加载。慢的话（超过 `LOAD_HINT_MS`）在黑屏中央写一行小字。
   * ⚠️ 原作是本地读盘、几乎瞬间，**没有「加载中」这个画面** —— 这行小字是
   * 我们加的，见 `docs/归档/方案-按需加载与图集.md` §3.4。
   */
  enterAfterLoad(mapId, entry, rawName) {
    // ⚠️ **切图一开始旧图就冻住**（`update` 早退、不收操作）。执行器此刻已清空，
    // 不冻的话等新图加载的这段时间里触碰检查照跑：剧情刚把人推进出口判定区
    // （肃州城打完城门兵后走出城），出口被当成「新踩进」再演一遍出城 ——
    // 淡出从亮处重来、画面闪一下，还要再读一遍图（2026-09-28 用户报）。
    this.leaving = true;
    let hintView = null;
    let shown = 0;
    const paint = () => hintView?.label.setText(`载入中… ${Math.round(shown * 100)}%`);
    const hint = this.time.delayedCall(LOAD_HINT_MS, () => { hintView = this.showLoadingOverFade(); paint(); });
    ensureMap(this, mapId, (v) => { shown = Math.max(shown, v); paint(); })
      .then(() => {
        hint.remove();
        if (!this.cache.json.exists(`${mapId}-map`)) throw new Error('map.json 拉不到');
        this.scene.restart({ mapId, entry });
      })
      .catch(() => {
        hint.remove();
        hintView?.clear();
        this.leaving = false;
        this.endScript();
        this.cameras.main.resetFX();
        this.notice = { text: `「${rawName || mapId}」尚未导出`, until: this.time.now + 2500 };
      });
  }

  update(time, delta) {
    // ⚠️ **资源还没到时 `create()` 提前 return 了**，`this.actors` 这些都还没建。
    // 不早退的话每一帧都抛 TypeError（而且是 `undefined.forEach` 这种看不出
    // 来源的），画面卡在「载入中…」上，看起来像加载卡住。
    if (this.loading || this.enteringBattle || this.leaving) return;
    (this.allActors ?? this.actors).forEach((a) => a.sprite?.update(time, delta));
    this.player?.update(time, delta);
    // 镜头盯着某个事物时每帧跟上 —— 那个事物可能正被 `actor_walk` 的
    // 补间推着走，只在 `camera_follow` 那一刻设一次位置是不够的。
    if (this.cameraTarget) {
      this.follow?.setPosition(this.cameraTarget.x, this.cameraTarget.y);
    }
    // 放在早退之前是为了菜单/购物界面开着时 NPC 也照走（那两个界面都会
    // 从下面 return 出去）。**剧情演出期间由 `updateRoamers` 自己让路** ——
    // 那时 `actor_walk` 正拿补间推同一批人，两边都写位置会打架。
    this.updateRoamers(delta);
    // ⚠️ **纯显示的更新必须放在所有早退之前。**
    // 网点虚影只是「这个人被挡住了，把他标出来」，与能不能操作无关；
    // 放在 `if (this.runner) return` 后面的话，剧情演出期间它不刷新 ——
    // 城门口士兵冲过来拦路时，虚影就僵在他原来站的位置上。
    //
    // 这个坑**踩到第三次**了：`updatePlayerAnimation` 不跑导致「打完仗
    // 背对尸体说话」、`poseActor` 不换帧也是同一个原因。
    // 判据很简单：**这段代码改的是画面还是状态？改画面的一律前置。**
    //
    // ⚠️ ⚠️ **但它必须排在「谁动过」的后面。** 虚影读的是精灵当前的贴图
    // 位置，而这一帧里**主角在函数末尾才 `setPosition`、NPC 在
    // `updateRoamers` 里才挪窝** —— 排在它们前面就等于**用上一帧的位置画**，
    // 跑步一帧 4.95px、走路 2.75px，画面上就是**一个偏移的副本＝重影**
    // （静止时偏移 0，所以只有动起来才看得见）。
    // 所以这里画的是 NPC 那一半，主角那一半在末尾移动完之后**再画一次**。
    this.updateGhost();
    this.advanceDrift(delta);
    // ⚠️ 同上：**纯显示的更新放在早退之前**。菜单里的使用特效
    // （`SF2Animator` 不自走，得每帧推）就在下面那个 `return` 后面 ——
    // 而菜单开着的时候恰恰每次都会走那条 return，特效会僵在第一帧。
    this.statusScreen?.update?.(time, delta);
    // ⚠️ 同理：购物界面的**上下箭头跳动**也要每帧推，而且必须在下面那条
    // `return` 之前 —— 那条 return 在购物界面开着时每次都会走。
    this.shopScreen?.update?.(time, delta);
    // 同理：底部操作提示（「空格 交谈」）在剧情、对白、菜单/商店/客栈期间藏起来。
    // 它只在函数末尾刷新，而下面这些情形都会先 return，提示框就冻在进剧情前那一帧（用户 2026-09-30）。
    if (this.runner || this.dialogue?.visible || this.statusScreen?.visible
      || this.shopScreen?.visible || this.innScreen?.visible) this.tip?.setVisible(false);
    this.innScreen?.update(time, delta);

    // 状态页与购物界面都盖住整个画面，开着的时候不走动也不触发对白
    if (this.statusScreen?.visible || this.shopScreen?.visible || this.innScreen?.visible) return;
    if (this.dialogue.visible) {
      this.dialogue.update(delta);
      this.updateSkip();
      return;
    }
    // 黑幕、等待这些没有对话框的演出期间也不能走动
    if (this.runner) return;

    let ux = 0;
    let uy = 0;
    if (this.cursors.left.isDown) ux -= 1;
    if (this.cursors.right.isDown) ux += 1;
    if (this.cursors.up.isDown) uy -= 1;
    if (this.cursors.down.isDown) uy += 1;

    const pointer = this.input.activePointer;
    if (!ux && !uy && pointer.rightButtonDown() && this.input.manager.isOver && !this.blockMouseMove) {
      const at = pointer.positionToCamera(this.cameras.main);
      const dx = at.x - this.playerPos.x, dy = at.y - (this.playerPos.y - 40);
      if (Math.hypot(dx, dy) > 20) {
        const angle = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4);
        ux = Math.round(Math.cos(angle)); uy = Math.round(Math.sin(angle));
      }
    }
    // 这一帧往哪推（没按就是 null）：被挡时按原作整步落点查踩踏，见 bumpTouchAt。
    this.moveIntent = ux || uy ? { x: ux, y: uy } : null;
    const direction = directionFromVector(ux, uy * ISO_RATIO);
    if (direction !== null) this.facing = direction;

    const running = this.wantsRun();
    // 纵向按等距比例压扁，斜走才落在地面菱形的对角线上
    const length = Math.hypot(ux, uy * ISO_RATIO) || 1;
    const speed = this.mapId === WORLD_MAP ? WALK_SPEED * WORLD_MAP_SPEED_RATIO
      : (running ? RUN_SPEED : WALK_SPEED);
    const step = (speed * delta) / 1000;
    const dx = (ux / length) * step;
    const dy = ((uy * ISO_RATIO) / length) * step;

    // 分轴判定，贴墙时仍可沿墙滑动。
    // ⚠️ **记的是真正走了多少像素**，不是「有没有按方向键」——
    // 行走动画按位移推进，贴着墙推的时候腿就该停下（原地踏步才是穿帮）。
    // ⚠️ **记朝向向量，不要靠 `facing` 编号反推。**
    // 编号到方向的映射有两套约定（原作编号 vs 屏幕方向，见 `screenFacing`），
    // 反推一次错一次。这里直接把「刚才往哪推」存下来，交谈选目标时用。
    this.faceVec = { x: ux / (Math.hypot(ux, uy) || 1), y: uy / (Math.hypot(ux, uy) || 1) };
    const moved = this.slideAxis('x', dx) + this.slideAxis('y', dy);
    // 大地图上跑与走同速（见 WORLD_MAP_SPEED_RATIO），只播走路动作。
    this.updatePlayerAnimation(moved, delta, running && this.mapId !== WORLD_MAP);

    const { x, y } = this.playerPos;
    this.player?.setPosition(x, y);
    this.fallback?.setPosition(x, y).setDepth(y);
    // ⚠️ **剧情把镜头绑到别的事物上时，主角不许抢镜头。**
    // 原作用一个叫「隱形」的不可见事物当镜头靶子（`camera_follow`），
    // 这里若无条件跟主角，镜头会被拽回来，长过场就看不见了。
    if (!this.cameraTarget) this.follow.setPosition(x, y);
    // 走一步就要重算：挡在人物前面的建筑随站位而变
    this.playerOccluder?.update(x, y);
    // ⚠️ **主角动完必须立刻重画虚影**，理由见上面那段 ⚠️⚠️ ——
    // 上面那次用的是移动**之前**的位置，跑起来会差 4.95px，看着就是重影。
    this.updateGhost();

    this.checkTouchTriggers();
    // 剧情触发优先；只计实际移动，菜单/对白/加载均已在上面早退。
    if (!this.runner && !this.loading && !this.dialogue.visible && moved > 0) {
      this.encounterTime += delta;
      while (this.encounterTime >= FIELD_STEP_MS) {
        this.encounterTime -= FIELD_STEP_MS;
        if (!advanceEncounter(this.encounterState, running)) continue;
        const swarm = fieldSwarm(this.encounterData, this.mapId, this.playerPos,
          this.registry.get('flags'));
        if (swarm > 0) { this.enterBattle({ swarm }); return; }
      }
    }

    const near = this.nearbyActor();
    this.showPlaceName(mapNameOf(this, this.mapId));
    if (this.notice && time < this.notice.until) {
      this.tip.setText(this.notice.text).setVisible(true);
      return;
    }
    // 用户2026-09-27：常驻操作说明没必要，只在身边有可交互对象时提示；
    // 空文字也要连底框一起藏起来。
    this.tip.setVisible(Boolean(near));
    // 键名按输入方式给：触屏是「確認」，键盘是「空格」（systems/inputHints.js）
    if (near) this.tip.setText(`${confirmHint()} ${this.interactionVerb(near)}`);
  }
}
