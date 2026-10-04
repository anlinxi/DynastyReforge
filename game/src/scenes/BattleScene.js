import { createSustained, advanceSustained, sustainedKind, targetable } from '../systems/sustainedAction.js';
import { equippedSoul, canSummon, trainSoul, endSoulOpportunity, battleSoulSkills } from '../systems/soulStones.js';
import { addHdImage, hdFloorEntry } from '../hd/hdAssets.js';
import { LANGUAGE } from '../systems/language.js';
import { menuFont } from '../ui/nativeText.js';
import { uiAsset } from '../systems/language.js';
import { chooseEnemyAction, enemySkillSupported, DEFERRED_ENEMY_SKILLS } from '../systems/enemyAI.js';
import Phaser from 'phaser';
import { battleAssetPlan, recordPacks } from '../systems/battleAssets.js';
import { queueBattlePack, releaseBattlePack } from '../systems/battlePacks.js';
import { SNAPSHOT_KEY, playShatter } from '../systems/battleShatter.js';
import { basicBattlePacks, partyArt, queueBattleExtras } from '../systems/battleBasics.js';
import SF2Animator, { TICK_MS } from '../systems/SF2Animator.js';
import BattleCamera from '../systems/battleCamera.js';
import BattleUnit from '../systems/BattleUnit.js';
import BattlePersistentEffects from '../systems/BattlePersistentEffects.js';
import BattleFields from '../systems/battleFields.js';
import { resolveAttack, nativeRand } from '../systems/combat.js';
import { PRESENTATION, buildSkill, skillRestriction, resolveSkill } from '../systems/skills.js';
import { ActionEffects, EFFECT_ORIGIN, actorAnchor, animationPackReady, animationSlots, resolveEffectKey } from '../systems/effects.js';
import ActionBarrier from '../systems/ActionBarrier.js';
import { strikeAnimation, motionSteps } from '../systems/skillMotion.js';
import { playBgm, registerBgm } from '../systems/bgm.js';
import { allyRoster, foeRoster, enemyDef, placeDef, normalAttackRecord } from '../systems/roster.js';
import { planReinforcements } from '../systems/reinforcements.js';
import { STATE_KEY as GAME_STATE_KEY } from '../systems/gameState.js';
import { rollSpoils, applySpoils, spoilsText, writeBattleVitals } from '../systems/spoils.js';
import { battlePatches } from '../systems/gameplayOptions.js';
import { slotsOf as formationSlots } from '../systems/formation.js';
import {
  COLUMN_ORDER, effectOffset, flipColumnOrder, formationTiles, slotOffset, tileCenter,
} from '../systems/battlefield.js';
import {
  PHASE as CLOCK, createClock, advance as advanceClock,
  beginAction, enterRecover, beginGuard, resetWait, hasRecover,
  entryOf, gaugeOf,
} from '../systems/battleClock.js';
import BattleHud from '../ui/BattleHud.js';
import BattleResults from '../ui/BattleResults.js';
import CommandMenu from '../ui/CommandMenu.js';
import { ROW_CENTER_Y } from '../ui/cmdLayout.js';
import TileOverlay from '../ui/TileOverlay.js';
import TimeWheel from '../ui/TimeWheel.js';
import {
  CategoryMenu, SkillKindMenu, ListPanel, InfoBoard, ConfirmBox,
} from '../ui/ListPanel.js';
import { costOf } from '../ui/listRows.js';
import { SKILL_KINDS } from '../systems/skillbook.js';
import StatusPage from '../ui/StatusPage.js';
import EnemyInspection from '../ui/EnemyInspection.js';
import VitalFeedback from '../ui/VitalFeedback.js';
import {
  ITEM_CATEGORIES, battleCategoryOf,
  usableInBattle, listedInBattle, affordable,
} from '../ui/listLayout.js';
import {
  ACTION_KIND, SPOT, attackAction, skillAction, itemAction,
  greenTiles, blueTiles, confirmableTiles, targetsOf, weaponDamageScale,
} from '../systems/battleAction.js';
import { applyItem, consume } from '../systems/battleItem.js';
import { CAMP } from '../systems/targeting.js';
import { ReviveTargets } from '../ui/ReviveTargets.js';
import { normCode } from '../systems/catalog.js';
import { warnOnce } from '../systems/warnOnce.js';
import { resolveEncounter, FALLBACK_FLOOR, VICTORY_BGM } from '../systems/encounter.js';
import {
  STAGE_WIDTH, STAGE_HEIGHT, UNITS,
  partyPortraitFrame, TERMS, DEMO_SWARM, FONTS, FONT_SIZE,
} from '../config.js';
import { uiPointer } from '../systems/stageView.js';
import { installBattleCameras, rightAnchored } from '../systems/battleCameras.js';

/** 进战斗的地图截图与破碎画面压在一切战斗画面之上。 */
const SHATTER_DEPTH = 100000;
/**
 * 进战斗加载在这么久内完成：挂着地图截图不出字，就绪后直接碎开进战斗（原作的样子）。
 * 超过就撤掉截图换黑屏「载入中 N%」，载完直接进、不再碎 —— 用户 2026-09-28：
 * 「走着走着画面定住读条、读完再碎一下」体感比黑屏读条还差。与切图提示同值。
 */
const BATTLE_ENTRY_HINT_MS = 400;

/** 回合之间的停顿。 */
const TURN_GAP_MS = 700;
/** 打完到自动回地图之间的停顿，够看清「勝」字。按空格可以提前。 */
const RETURN_DELAY_MS = 2200;

/** 绝学明确指定的动作优先；DEFAULT对应本角色的默认动作。 */
const posePack = (stand, kind, own = null) => {
  if (own) return own;
  return stand ? String(stand).replace(/^STN/, kind) : null;
};

/**
 * 演示单位的战斗素材：只在没有存档队伍（我方退回 config.UNITS）、或遇敌组建不出敌人
 * （敌方退回演示敌人）时才要，正常游玩不载。
 */
function demoPacks(party, enemies) {
  const arts = (side) => UNITS.filter((u) => u.side === side)
    .flatMap((u) => [u.stand, u.attack, u.hurt, u.guard, u.move, u.victory, u.levelUp].filter(Boolean));
  return [...(party?.members?.length ? [] : arts('ally')), ...(enemies?.length ? [] : arts('foe'))];
}

/** 主指令闲置走表，子页面和动作演出暂停；结束后不再推进。 */
const PHASE = Object.freeze({
  LOADING: 'loading',
  RUNNING: 'running',
  READY: 'ready',
  ACTING: 'acting',
  OVER: 'over',
});

export default class BattleScene extends Phaser.Scene {
  constructor() {
    super('Battle');
    this.units = [];
    this.effects = [];
    this.pendingHitPose = 0;
    this.actionEffects = new Map();
    this.phase = PHASE.READY;
  }

  /** 入场准备本场资源：JSON到达后，在同轮Loader追加图像/声音。
   * 实际体积随队伍、已学绝学和遭遇变化；确认完整就绪后才开放战斗。
   */
  preload() {
    this.battleReady = false;
    this.interruptedChoice = null;
    this.queuedChoice = null;
    this.phase = PHASE.LOADING;
    this.sustainedActions = new Map();
    this.sustainedElapsed = 0;
    this.loadFailures = [];
    // 加载期间先挂着进战斗前的地图截图（FieldScene.enterBattle 截的），不出字；
    // 快的话就绪后碎开（原作玻璃破碎），慢了换黑屏读条（见 BATTLE_ENTRY_HINT_MS）。
    this.snapshotImage = this.textures.exists(SNAPSHOT_KEY)
      ? this.add.image(0, 0, SNAPSHOT_KEY).setOrigin(0, 0).setScrollFactor(0).setDepth(SHATTER_DEPTH)
        .setDisplaySize(this.coverWidth, STAGE_HEIGHT) : null; // 高清时截图是实际像素，按逻辑尺寸显示
    if (this.snapshotImage) this.snapshotImage.ycTop = true; // 宽屏：盖在界面之上、铺满舞台（battleCameras.js）
    this.loadingLabel = this.add.text(this.coverWidth / 2, STAGE_HEIGHT / 2, '载入中…',
      { fontFamily: 'serif', fontSize: '20px', color: '#d8c9a3' })
      .setOrigin(0.5).setScrollFactor(0).setDepth(SHATTER_DEPTH + 1).setVisible(!this.snapshotImage);
    this.loadingLabel.ycTop = true;
    // 场景在加载阶段不走自己的计时器，用浏览器定时器；主线程忙着解码时它会晚到，不影响判断方向。
    const slow = setTimeout(() => this.toSlowEntry(), BATTLE_ENTRY_HINT_MS);
    this.events.once('shutdown', () => clearTimeout(slow));
    this.cameras.main.setBackgroundColor('#000000');
    this.onLoadProgress = (progress) => this.loadingLabel?.setText(`载入中… ${Math.floor(progress * 100)}%`);
    this.onLoadError = (file) => { this.loadFailures.push(file.src ?? file.key); };
    this.load.on('progress', this.onLoadProgress);
    this.load.on('loaderror', this.onLoadError);
    // 战斗 BGM 同理：城里逛街用不到。**哪一首由遇敌群的音乐档次决定。**
    const bgm = this.plan?.bgm;
    // 战斗曲与胜利曲边读边播（见 systems/bgm.js），只登记地址，不载入解码。
    if (bgm) registerBgm(bgm.key, `audio/${bgm.file}`);
    registerBgm(VICTORY_BGM.key, `audio/${VICTORY_BGM.file}`);
    // 破碎表与音效、升级音效、名牌、战斗字模、物品插图 —— 通常进游戏的载入画面已载好（battleBasics.js）。
    this.requiredArtwork = queueBattleExtras(this);
    // 战斗背景同样按需 —— 全库 67 张，不可能全预载。
    const floors = [this.floorKey()];
    // 高清（默认开，?hd=0 关）：本场背景有高清版就另载一张
    const hdFloor = hdFloorEntry(this, this.floorKey());
    if (hdFloor && !this.textures.exists(hdFloor[0])) this.load.image(...hdFloor);
    const state = this.registry.get(GAME_STATE_KEY);
    const assets = battleAssetPlan({
      gamedata: this.cache.json.get('gamedata'), encounter: this.encounter,
      party: state?.party, allies: this.allyDefs(), inventory: state?.inventory,
      skills: this.cache.json.get('skills-full'), items: this.cache.json.get('items-full'),
      souls: this.cache.json.get('refining')?.souls,
    });
    // 本队绝学、魂石招式、背包道具、敌人绝学都按需：选定时才载（loadActionPacks），战斗结束释放（releaseOnDemand）。
    // 入场要齐：与遇敌无关的基础包（兜底背景、界面、场方效果、魂石、本队动作与普攻、蓄劲姿势，
    // 通常进游戏时已载好，见 battleBasics.js），加上本场的背景、敌人动作与普攻、敌人绝学的蓄劲姿势。
    // ⚠️ 不再带 config.ANIMATION_KEYS：那是特效浏览器的候选库（13个特效包、解码318 MB）加演示队伍/敌人，
    // 每场白载，是首战加载的最大头之一（2026-09-28 实测遇敌群117：入场1090 MB 里占387 MB）。
    this.requiredPacks = [...new Set([...basicBattlePacks(this), ...demoPacks(state?.party, assets.enemies),
      ...floors, ...assets.preloadSkills, ...assets.attacks, ...assets.enemies])];
    const preloaded = new Set(this.requiredPacks);
    this.onDemandPacks = new Set([...assets.partySkills, ...assets.enemySkills, ...assets.items]
      .filter((key) => !preloaded.has(key)));
    this.onDemandLoaded = new Set();
    this.events.once('shutdown', () => this.releaseOnDemand());
    this.requiredPacks
      .forEach((key) => {
      if (this.cache.json.exists(`${key}-anim`)) { this.queuePack(key); return; }
      this.load.json(`${key}-anim`, uiAsset(`assets/${key}/anim.json`));
      this.load.once(`filecomplete-json-${key}-anim`, () => this.queuePack(key));
    });
  }

  /** 排一个动画包的图与内嵌音效（见 systems/battlePacks.js）。 */
  queuePack(key) {
    queueBattlePack(this, key);
  }

  /** 这个行动（绝学/魂石招式/道具）要按需载的包（入场前已备好的不算）。 */
  actionPacks(action) {
    let packs = [];
    if (action?.kind === ACTION_KIND.SKILL) {
      const record = this.skillRecord(action.skill);
      packs = record ? recordPacks(record) : [];
    } else if (action?.kind === ACTION_KIND.ITEM) {
      packs = animationSlots(action.item ?? {}).map((slot) => slot.文件);
    }
    return packs.filter((key) => this.onDemandPacks?.has(key));
  }

  actionPacksReady(action) {
    return this.actionPacks(action).every((key) => animationPackReady(this, key));
  }

  /**
   * **选定一招（或一件道具）就开始载它的素材**，出手前载完（`fireAction` 不够时停表等）。
   *
   * 本队全学满约 4.3 GB 显存，入场前整批载已不可行（2026-09-27 用户决定按需）。
   * 桌面实测一招读文件+解码 0.05–0.6 秒；玩家给别人下指令、蓄劲期间都在走这段时间。
   * 载过的留到本场结束，由 `releaseOnDemand` 统一释放。
   *
   * @returns {Promise<void>} 全部就绪（或加载器已跑完仍缺——文件损坏，留日志放行）时 resolve
   */
  loadActionPacks(action) {
    const keys = this.actionPacks(action).filter((key) => !animationPackReady(this, key));
    if (!keys.length) return Promise.resolve();
    for (const key of keys) {
      if (this.onDemandLoaded.has(key)) continue;          // 已在载
      this.onDemandLoaded.add(key);
      if (this.cache.json.exists(`${key}-anim`)) { this.queuePack(key); continue; }
      this.load.json(`${key}-anim`, uiAsset(`assets/${key}/anim.json`));
      this.load.once(`filecomplete-json-${key}-anim`, () => this.queuePack(key));
    }
    if (!this.load.isLoading()) this.load.start();
    return new Promise((resolve) => {
      const check = () => {
        const ready = keys.every((key) => animationPackReady(this, key));
        if (!ready && this.load.isLoading()) return;
        this.load.off('complete', check);
        if (!ready) console.warn(`绝学素材没载全：${keys.filter((k) => !animationPackReady(this, k)).join(', ')}`);
        resolve();
      };
      this.load.on('complete', check);
      check();
    });
  }

  /**
   * 战斗结束释放：本场按需载入的绝学素材，以及入场载的本场背景（含高清版）、敌人动作/普攻/蓄劲姿势与其音效。
   * 本队与公共基础包（basicBattlePacks，进游戏的载入画面已载）保留；下一场缺什么入场时照常补载。
   * 背景与敌人素材原先整局不放，遇到的种类越多显存越大（PERF-02：8场后多约370 MB，高清背景每张33 MB）；
   * 用户2026-09-30要求先每场都放、实玩看再遇同敌/同背景的加载是否可接受，再定是否改滑动窗口或显存上限。
   * 等场景的对象都销毁（下一帧渲染后）再删纹理。
   */
  releaseOnDemand() {
    const keep = new Set(basicBattlePacks(this));
    const entry = (this.requiredPacks ?? []).filter((key) => !keep.has(key));
    const keys = [...new Set([...(this.onDemandLoaded ?? []), ...entry])];
    const hdFloor = hdFloorEntry(this, this.floorKey())?.[0];
    this.onDemandLoaded = new Set();
    if (!keys.length && !hdFloor) return;
    this.game.events.once(Phaser.Core.Events.POST_RENDER, () => {
      for (const key of keys) releaseBattlePack(this, key);
      if (hdFloor && !keep.has(this.floorKey()) && this.textures.exists(hdFloor)) this.textures.remove(hdFloor);
    });
  }

  /**
   * 一场仗的入口：`op55 battle` 的 **`swarm` 是「遇敌群」编号**（不是遇敌组）。
   *
   * ⚠️ **2026-09-13 订正。** 群里才有**战斗背景、战斗音乐、逃跑概率**三项，
   * 组只有敌人与战利品 —— 读成组的后果是这三项永远取不到：
   * 每场仗都打在 `FLR000` 那张**量格盘用的格线图**上、全程只放一首曲子。
   * 而剧情战的群与组同号同名，所以**主线上一点都不报错**。
   * 判据（羅喉城五宿座等）与解析都在 `systems/encounter.js`。
   *
   * ⚠️ **打完要回原来那张图接着演。** `battle` 在剧情中间，后面还有话要说
   * （蝎子那场打完是「沒想到在野外會有這麼恐怖的怪物....」），
   * 回程信息由 `FieldScene` 带进来，续演靠 `pendingScript`——
   * 与 `goto_map` 完全同一套机制。
   */
  init(data) {
    this.battleCameras = installBattleCameras(this); // 宽屏：战场/界面/顶层三台相机；没开宽屏退回居中 640
    this.swarm = Number(data?.swarm ?? this.swarm ?? DEMO_SWARM);
    // ⚠️ `init` 早于 `preload`，而 `gamedata` 在 BootScene 就载好了，
    // 所以这里能解 —— 背景与曲子都要在 `preload` 里排队，必须先知道是哪张哪首。
    const got = resolveEncounter(this.cache.json.get('gamedata'), this.swarm);
    this.plan = got;
    this.encounter = got?.groupId ?? null;
    if (data?.returnTo) this.returnTo = data.returnTo;
    // `must_win=1` 的仗输了 = 游戏结束（败阵 → 主菜单），见 `finish`。
    this.mustWin = data?.mustWin ?? this.mustWin ?? 1;
    /**
     * 非必胜战打输了该跳到脚本的第几条（释义 op 0x37 的第三个字段）。
     * `null` = 这一场没给（或是必胜战）。
     */
    this.onLose = data?.onLose ?? this.onLose ?? null;
  }

  create() {
    this.load.off('progress', this.onLoadProgress);
    this.load.off('loaderror', this.onLoadError);
    // Loader的complete也会在文件失败后发出，不能用它代替完整性检查。
    const missing = [
      ...this.requiredPacks.filter((key) => !animationPackReady(this, key)),
      ...this.requiredArtwork.filter((key) => !this.textures.exists(key)),
      ...['level-up'].filter(key => !this.cache.audio.exists(key)),
      ...(!this.cache.bitmapFont.exists(FONTS[LANGUAGE].key) ? [FONTS[LANGUAGE].key] : []),
    ];
    if (missing.length) {
      this.toSlowEntry();                         // 截图还挂着时先换黑屏，失败提示才看得见
      this.phase = PHASE.OVER;
      this.loadingLabel.setText('游戏资源读取失败，无法进入战斗');
      console.error('战斗资源未就绪', { failed: this.loadFailures, missing });
      return;
    }
    this.loadingLabel.destroy();
    this.loadingLabel = null;
    // Phaser 重启场景时复用同一实例，残留引用会指向已销毁的对象，
    // 必须显式清空，否则 setPrompt 之类的惰性创建会跳过重建。
    this.resetState();
    this.events.once('shutdown', () => {
      this.pendingActions.clear();
      this.actionEffects.forEach((context) => context.cancel());
      this.actionEffects.clear();
      this.enemyInspection?.destroy();
      this.vitalFeedback?.destroy();
      this.persistentEffects?.destroy();
      this.results?.destroy();
      this.results = null;
      this.battleCamera?.destroy();
      this.battleCamera = null;
    });

    this.cameras.main.setBackgroundColor('#07060a');
    this.battleCamera = new BattleCamera(this, TICK_MS);
    this.drawFloor();

    this.fields = new BattleFields(this.cache.json.get('gamedata')?.战斗规则);
    this.persistentEffects = new BattlePersistentEffects(this);
    this.units = this.buildUnits();
    this.units.forEach((u) => { u.onFrameEvent = (e) => this.handleFrameEvent(e); });
    this.allies = this.units.filter((u) => u.def.side === 'ally');
    this.foes = this.units.filter((u) => u.def.side === 'foe');
    this.player = this.allies[0];
    this.foe = this.foes[0];

    // ⚠️ **`StatusPanel` 已经不画了**（2026-09-16，用户要求）。
    // 它是我们自绘的白字血条，**原作画面上根本没有这个东西** ——
    // 原作只在选中敌人时弹一个名牌（用户截图里的「藍衣鐵衛」），
    // 那属于「目标选取」，是二期下半的事。留着类是因为还没有替代品。
    this.hud = new BattleHud(this);
    // 主菜单：轮到我方选动作时滑进来（`beginTurn`），出手后滑回去。
    // 宽屏：指令框与法寶/絕學页、复活目标贴战场右边缘，与时轮同一列（battleCameras.js `rightAnchored`）
    this.menu = rightAnchored(this, () => new CommandMenu(this));
    // 选目标时铺在地上的绿/蓝格子。见 `ui/TileOverlay.js`。
    this.tiles = new TileOverlay(this);
    // 右下角的时轮：**转＝时间在推进，停＝时间没在流逝**（用户 2026-09-17）。
    this.wheel = new TimeWheel(this);
    // 法寶的四类板与法寶/絕學共用的列表板。见 `ui/ListPanel.js`。
    this.categories = rightAnchored(this, () => new CategoryMenu(this));
    // 絕學的两类板「咒法 / 絕技」（`ITF502`），与法寶四类板同构。
    this.kinds = rightAnchored(this, () => new SkillKindMenu(this));
    // ⭐ **两页各一块板**：法寶 `ITF0031` 帧0 218 宽、行条 `ITF3005` 200；
    // 絕學 `ITF501` 帧0 242 宽、行条 `ITF500` 225。共用一个实例画不出来。
    this.itemList = rightAnchored(this, () => new ListPanel(this, 'item'));
    this.skillList = rightAnchored(this, () => new ListPanel(this, 'skill'));
    this.reviveTargets = rightAnchored(this, () => new ReviveTargets(this));
    this.list = this.itemList;
    // 左边的说明板（法寶还多一块插图板）+「確定使用 / 是 / 否」确认框
    this.info = rightAnchored(this, () => new InfoBoard(this));
    this.confirm = rightAnchored(this, () => new ConfirmBox(this));
    // 諸態页（两块板）。见 `ui/StatusPage.js`。
    this.status = new StatusPage(this);
    this.enemyInspection = new EnemyInspection(this);
    this.vitalFeedback = new VitalFeedback(this);
    this.startBgm();
    this.bindInput();
    // ⚠️ **战斗的心跳**：三色条真的在跑，谁的绿条先满谁先动。
    // 见 `systems/battleClock.js`。**不要在这里 beginTurn** —— 开局谁都还没满。
    this.clock = createClock(this.units);
    this.battleReady = true;
    // 快：地图截图还挂着 → 碎开露出战斗画面之后才开始走表（碎的过程中 phase 仍是 LOADING）。
    // 慢：已换成黑屏读条 → 直接进。
    const begin = () => { if (this.phase !== PHASE.OVER) this.phase = PHASE.RUNNING; };
    if (this.snapshotImage) {
      this.snapshotImage.destroy();
      this.snapshotImage = null;
      playShatter(this, SHATTER_DEPTH, begin);
    } else begin();
  }

  /** 进战斗加载超过 BATTLE_ENTRY_HINT_MS：撤掉地图截图，黑屏显示「载入中 N%」，就绪后不再碎。 */
  toSlowEntry() {
    if (this.battleReady || !this.snapshotImage) return;
    this.snapshotImage.destroy();
    this.snapshotImage = null;
    if (this.textures.exists(SNAPSHOT_KEY)) this.textures.remove(SNAPSHOT_KEY);
    this.loadingLabel?.setVisible(true);
  }

  /**
   * 建这场仗的全部单位。
   *
   * 敌方来自**遇敌组**（`gamedata.遇敌组[编号].敌人` 的 `代码` 与 `位置`），
   * 我方暂时仍是 `config.UNITS` 里那几个演示定义 —— 接真队伍是 C 段的事。
   * 站位一律由 `systems/battlefield.js` 按格心算，不再手调偏移。
   *
   * ⚠️ **素材没预载的单位要跳过并留一行日志。** 建出来但没有图的单位
   * 在画面上就是"什么都没有"，从截图上根本看不出是哪一步漏了。
   */
  buildUnits() {
    const gamedata = this.cache.json.get('gamedata') ?? {};

    // ⚠️ **站位用玩家在阵形页摆的那份**，不是 `DEFAULT_ALLY_SLOTS`。
    // 不接上的话阵形页改了位置、打起来还是老样子。
    const party = this.registry.get(GAME_STATE_KEY)?.party;
    const allies = allyRoster(this.allyDefs(), formationSlots(party));
    let foes = foeRoster(gamedata, this.encounter);
    if (!foes.length) {
      // 数据没读到时退回演示敌方，摆在前排 —— 场景至少还能打开。
      console.warn(`遇敌组 ${this.encounter} 建不出敌人，退回 config.UNITS 的演示敌方`);
      foes = UNITS.filter((u) => u.side === 'foe').map((d) => placeDef(d, 7, 'foe'));
    }

    return [...allies, ...foes].map(def => this.createUnit(def)).filter(Boolean);
  }

  /** 初始敌我与中途增援共用属性、素材站立点及装备初始化。 */
  createUnit(def) {
    const gamedata = this.cache.json.get('gamedata') ?? {};
    const ready = this.cache.json.get(`${def.stand}-anim`);
    if (!ready) {
      // ⚠️ **别再 `return null`。** 少一个单位画面上看不出来，可后果是
      // 「对面是空的、开打即判胜」（肅州城门口那场就是）。缺包一律喊出来，
      // 替身表在 `systems/roster.ART_SUBSTITUTE`。
      console.error(`单位「${def.name}」的站立素材 ${def.stand} 没有产物 —— `
        + '请补进 roster.ART_SUBSTITUTE，或重跑 tools/export_battle_art.py');
      return null;
    }
    // ⚠️ **按这一包自己的站立点重算站位**（2026-09-17）。
    // `roster.placeDef` 用的是阵营代表值，而各素材的影子中心差到 46px ——
    // 后果是人站在格子外面。`stand_point` 由 `export_pack.py` 写进 anim.json。
    const sp = ready.stand_point;
    if (Array.isArray(sp) && sp.length === 2) {
      const off = slotOffset(def.slot, def.side, { x: sp[0], y: sp[1] });
      def = { ...def, offsetX: off.x, offsetY: off.y };
    } else {
      warnOnce(`stand-point:${def.stand}`,
        `${def.stand} 没有 stand_point，退回阵营代表值，站位会偏几十像素。`
        + '重跑 tools/export_battle_art.py');
    }
    // 敌方数值来自 `gamedata.敌人`，我方来自队伍状态（存档）；都没有时退回 fallbackStats。
    // 旧的 assets/stats.json、assets/equipment.json（300块 配套资料产物）已删（2026-09-27 开源盘点）。
    const data = { ...gamedata.角色?.[def.name], ...(def.stats ?? fallbackStats(def)) };
    return new BattleUnit(this, def, data);
  }

  /**
   * 我方上场的是**当前队伍里真有的人**，不是 `config.UNITS` 那份演示名单。
   *
   * ⚠️ 先前直接拿 `UNITS.filter(side==='ally')`，于是**打蝎子那场明明只有
   * 夏侯仪一个，进战斗却变成两个人** —— 封铃笙那时还没入队。
   * 队伍的正本在 registry 的 `gameState`（读档时由 `partyFromSave` 建，
   * 判据是角色记录 `+156`「不在队」）。
   *
   * `UNITS` 退化成一张「谁用哪套战斗素材」的对照表：按名字取。
   * 队伍里有、而这张表里没有的人（还没导素材的队友）跳过并留一行日志 ——
   * 少一个人在画面上看不出是漏了还是本来就没有。
   */
  allyDefs() {
    const party = this.registry.get(GAME_STATE_KEY)?.party;
    const tuned = new Map(UNITS.filter((u) => u.side === 'ally').map((u) => [u.name, u]));
    if (!party?.members?.length) {
      console.warn('战斗：registry 里没有队伍，退回 config.UNITS 的演示我方');
      return [...tuned.values()];
    }
    const out = [];
    for (const m of party.members) {
      const keys = this.partyArt(m.code);
      if (!keys) {
        console.warn(`战斗：人物代码 ${m.code}（${m.name}）不在 PARTY_ART 里`);
        continue;
      }
      // `UNITS` 只提供**手调的表现参数**（出招方式、初始配装、绝学、绘制层），
      // 素材键一律按代码算 —— 表里没有的队友照样能上场。
      const extra = tuned.get(m.name) ?? {};
      out.push({
        id: `ally${m.code}`,
        code: m.code,
        attackType: 'melee',
        loadout: [],
        skills: [],
        depth: 20,
        ...extra,
        ...keys,
        name: m.name,
        side: 'ally',
        stats: m,
      });
    }
    return out.length ? out : [...tuned.values()];
  }

  /**
   * 我方素材包 **和敌方一样从数据反查**，不看 `config.UNITS`（清单见 `battleBasics.basicBattlePacks`）。
   *
   * ⚠️ 从前我方素材只在 `ANIMATION_KEYS` 里静态列着（那是 `UNITS` 派生的），
   * 于是**新入队的人预载不到、`buildUnits` 里那句「没预载就不上场」把他吞掉**，
   * 只留一行 warn —— 冰璃入队之后战斗里还是两个人，就是这么来的。
   */
  partyArt(code) {
    return partyArt(this.cache.json.get('gamedata'), code);
  }

  /** 清空上一轮留下的引用，供 scene.restart 使用。 */
  resetState() {
    this.actionEffects?.forEach((context) => context.cancel());
    this.actionEffects = new Map();
    this.units.forEach((u) => u.destroy?.());
    this.units = [];
    this.effects.forEach((f) => f.destroy?.());
    this.effects = [];
    this.player = null;
    this.foe = null;
    this.allies = [];
    this.foes = [];
    this.clock = [];
    this.pendingActions = new Map();
    this.fled = false;
    this.spoils = null;
    this.upgrades = [];
    this.actor = null;
    this.target = null;
    this.marker?.destroy();
    this.marker = null;
    this.prompt = null;
    this.grid?.destroy(true);
    this.grid = null;
    this.wheel?.destroy();
    this.wheel = null;
    this.categories?.destroy();
    this.categories = null;
    this.kinds?.destroy();
    this.kinds = null;
    // ⚠️ 两块板都要销毁 —— 只销毁 `this.list` 会漏掉没在用的那一块，
    // 下次进战斗它还挂在场上。
    this.itemList?.destroy();
    this.skillList?.destroy();
    this.reviveTargets?.destroy();
    this.reviveTargets = null;
    this.itemList = null;
    this.skillList = null;
    this.list = null;
    this.info?.destroy();
    this.info = null;
    this.confirm?.destroy();
    this.confirm = null;
    this.status?.destroy();
    this.status = null;
    this.pick = { stage: 'main', action: null, tiles: [], at: 0 };
    this.phase = PHASE.READY;
  }

  /**
   * 响应动画帧上的原作事件：引发特效、受击姿势（震动与镜头见 battleCamera）。
   * 特效落点跟随施术者当前所在位置（近战突进后即为目标身前）。
   */
  handleFrameEvent({ animKey, frame, unit }) {
    const context = this.actionEffects.get(unit);
    if (context && context.actionKeys.has(animKey)) {
      context.react?.(frame);
      context.trigger(frame, `actor:${animKey}`);
      return;
    }
    if (frame.hit_pose) this.pendingHitPose = frame.hit_pose;
    if (!frame.effect_file) return;
    const key = resolveEffectKey(this.cache, animKey, frame.effect_file);
    if (!key) return;

    // 落点跟随**本次行动的目标**。场上不止一个敌人之后，
    // 「我方就打 this.foe、敌方就打 this.player」已经不成立了。
    this.playEffect(key, this.target ?? unit);
  }

  /** 铺原作战斗地面。FLR 的第 0 张图为 640x480 整幅底图。 */
  /**
   * 战斗地面。
   *
   * ⚠️ **三代产物都要认**（判据表：只认最新的会让画面整个空掉，而且不报错）。
   * 这里原先只认逐张 PNG 的 `FLR000-img0`，而素材早就打成图集了 ——
   * 于是一路走 `else`，战斗背景是一块纯色，石板地一次都没画出来过。
   */
  /**
   * 这一场在哪张地面上打 —— **来自遇敌群的 `战斗背景地图`**。
   *
   * ⚠️ 解不出来时退回 `FLR000`，那是**量格盘用的格线图**、不是任何一张真背景。
   * `resolveEncounter` 已经为此出过一次声（`floorFallback`），这里不再重复喊。
   */
  floorKey() {
    return this.plan?.floorKey ?? FALLBACK_FLOOR;
  }

  drawFloor() {
    const FLOOR_KEY = this.floorKey();
    const data = this.cache.json.get(`${FLOOR_KEY}-anim`);
    // ⚠️ **战斗背景是 800×600，画面是 640×480 —— 原作是 1:1 居中裁剪，不是缩放。**
    //
    // 判据（2026-09-16，用户提供了蘭州城無人廢屋那一场的原作截图）：
    // 用**顶部状态条的框宽当尺子**做无标度比值 —— 框宽 116px 是素材定死的，
    // 所以不依赖截图分辨率。量「桌上青绿罐子 ↔ 箱子上蓝垫子」的距离：
    //   原作截图 ＝ 2.98 个框宽 ＝ 345 游戏像素；源图里 ＝ 351 源像素。
    //   比值 0.98 ≈ 1.0 → **1:1**（若是缩放 0.8，比值就该是 0.8）。
    // 再由两个物体各自反解偏移，x 得到 77 与 80 —— 正是**居中**的 80。
    //
    // ⚠️ **2026-09-16 上午我改成过「缩放 0.8」，是错的**，当天下午用这张
    // 截图推翻。缩放虽然也修掉了「敌人站到墙上」，但把像素美术糊掉了，
    // 而且多出来的 160×120 本来是**给镜头移动/震动留的余量**
    // （SF2 帧数据里有 `screen_move_dir` / `screen_move_time` 两个字段）。
    //
    // ⚠️ 尺寸要取**帧**的、不是 `anim_size` 的：`FLR000` 的 `anim_size` 是
    // [800,600]（它第 4 帧有 832×624），可它第 0 帧只有 640×480。
    const frame = data?.frames?.[0];
    const srcW = frame?.width || STAGE_WIDTH;
    const srcH = frame?.height || STAGE_HEIGHT;
    // 居中：把图往左上挪半个差值，画布之外的部分自然被裁掉。
    // **将来做镜头推移时，改的就是这两个数。**
    const ox = Math.round((srcW - STAGE_WIDTH) / 2);
    const oy = Math.round((srcH - STAGE_HEIGHT) / 2);

    const hdKey = hdFloorEntry(this, FLOOR_KEY)?.[0];
    if (hdKey && this.textures.exists(hdKey)) {
      this.battleCameras?.backdrop(addHdImage(this, -ox, -oy, hdKey).setDepth(0)); // 宽屏两侧补边按本场背景做
      return;
    }
    if (data?.atlas && this.textures.exists(FLOOR_KEY)) {
      this.battleCameras?.backdrop(this.add.image(-ox, -oy, FLOOR_KEY, 'img_000').setOrigin(0, 0).setDepth(0));
      return;
    }
    const key = `${FLOOR_KEY}-img0`;
    if (this.textures.exists(key)) {
      this.battleCameras?.backdrop(this.add.image(-ox, -oy, key).setOrigin(0, 0).setDepth(0));
      return;
    }
    console.warn(`战斗地面 ${FLOOR_KEY} 没载入，用纯色顶替`);
    this.add.rectangle(this.battleBaseScrollX ?? 0, 0, this.battleWidth ?? STAGE_WIDTH, STAGE_HEIGHT, 0x241d28).setOrigin(0, 0);
  }

  /**
   * **格盘叠层（调试用，G 键开关）。**
   *
   * 为什么值得单独做一个：阵型对不对，光看画面是**判断不了**的 ——
   * 两个一模一样的西夏兵一左一右站着，谁在位置 7 谁在位置 5 根本看不出来，
   * 更别说验「一排四格从哪头数起」这种方向问题。
   *
   * 叠层画三样：
   * 1. `FLR000` 的**第 2 帧**——那本来就是原作自带的格线图（第 0 帧才是石板地）；
   * 2. 每一格的**位置号**，我方绿、敌方红；
   * 3. 每个单位脚下的**落点十字**，用来核对它是不是真站在格心上。
   */
  toggleGrid() {
    if (this.grid) {
      this.grid.destroy(true);
      this.grid = null;
      this.prompt?.setVisible(false);
      return;
    }
    this.prompt?.setVisible(true);
    this.grid = this.add.container(0, 0).setDepth(950);

    // ⚠️ 格线图只有 `FLR000` 的第 2 帧有，**与这一场的背景无关**。
    const gridArt = `${FALLBACK_FLOOR}-img2`;
    if (this.textures.exists(gridArt)) {
      this.grid.add(this.add.image(0, 0, gridArt).setOrigin(0, 0).setAlpha(0.55));
    }

    for (const side of ['foe', 'ally']) {
      const color = side === 'foe' ? '#ff9a9a' : '#9affb0';
      for (const t of formationTiles(side)) {
        this.grid.add(this.add.text(t.x, t.y, String(t.slot), {
          fontFamily: 'monospace', fontSize: '13px', color,
          stroke: '#000', strokeThickness: 3,
        }).setOrigin(0.5));
      }
    }

    // 单位实际落点：格心画个十字，站歪了一眼就看见。
    for (const u of this.units) {
      const { u: tu, v: tv } = u.def.tile ?? {};
      if (tu === undefined) continue;
      const { x, y } = tileCenter(tu, tv);
      const mark = this.add.graphics();
      mark.lineStyle(1, u.def.side === 'foe' ? 0xff4444 : 0x44ff66, 0.9);
      mark.strokeCircle(x, y, 5);
      mark.lineBetween(x - 9, y, x + 9, y);
      mark.lineBetween(x, y - 5, x, y + 5);
      this.grid.add(mark);
      this.grid.add(this.add.text(x, y - 58, `${u.name}\n位置${u.def.slot}`, {
        fontFamily: 'serif', fontSize: '12px', align: 'center',
        color: u.def.side === 'foe' ? '#ffd0d0' : '#d0ffd8',
        stroke: '#000', strokeThickness: 3,
      }).setOrigin(0.5));
    }
  }

  bindInput() {
    // ⭐ **上下左右与确认一律按 `stage` 分派**（主菜单 / 四类板 / 列表 / 选目标），
    // 别在这儿堆 `if` —— 那样每加一个子界面就要改六个键。
    this.input.keyboard.on('keydown-SPACE', (event) => {
      if (this.results) { if (!event.repeat) this.results.next(); return; }
      this.confirmCommand();
    });
    this.input.on('pointerdown', (p) => this.onPointerDown(p));
    this.input.keyboard.on('keydown-UP', () => this.moveCursor(-1));
    this.input.keyboard.on('keydown-DOWN', () => this.moveCursor(1));
    this.input.keyboard.on('keydown-LEFT', () => this.moveSide(-1));
    this.input.keyboard.on('keydown-RIGHT', () => this.moveSide(1));
    // ESC 退一步：选目标 → 列表 → 四类板 → 主菜单
    this.input.keyboard.on('keydown-ESC', () => this.backStage());
    // ⭐ **鼠标悬停换目标** —— 原作就是靠鼠标指的（用户 2026-09-16 口述）。
    this.input.on('pointermove', (p) => this.hoverTarget(p));
    this.input.mouse?.disableContextMenu();
    this.input.keyboard.on('keydown-ENTER', () => this.results ? this.results.next() : this.confirmCommand());
    ['A','E','S','V','D','R'].forEach((key,index) => {
      this.input.keyboard.on(`keydown-${key}`, () => {
        if (!this.canChoose() || this.stage !== 'main') return;
        this.menu.index = index; this.menu.drawCursor(); this.chooseCommand();
      });
    });
    this.input.keyboard.on('keydown-G', () => this.toggleGrid());
    // ⚠️ **调试用**：一排四格的朝向没有数据判据（见 battlefield.js 模块头），
    // 按 H 当场翻，对着原版看一眼就能定死。定死之后把默认值写进去、
    // 这个键就可以删了。
    this.input.keyboard.on('keydown-H', () => {
      flipColumnOrder();
      this.scene.restart();
    });
    // 换一场看阵型。遇敌群 1 =「迦夏之窟洞外」的遭遇池，104 =「冰璃登場」。
    this.input.keyboard.on('keydown-N', () => {
      this.scene.restart({ swarm: this.swarm === DEMO_SWARM ? 104 : DEMO_SWARM });
    });
    // ⚠️ 原来这里还有 M（回地图）与 F（特效浏览页）两个调试入口。
    // 特效浏览页 2026-09-05 已删；回地图现在由 `finish` 自己做。
  }

  /**
   * 战斗要用的绝学表。**数值全部来自 `skills.json`**（`Firttech.enc` 解出），
   * 这里只把它与表现层（动画/特效）配起来。
   *
   * ⚠️ 绝学代码是**十六进制字符串**，比对前统一成大写 —— `as_num` 那类
   * 隐式转换会把 `12D` 截成 12，这个坑在项目里咬过不止一次。
   */
  buildSkillTable() {
    const table = this.cache.json.get('skills-full') ?? [];
    const byCode = new Map(table.map((r) => [String(r.绝学代码).toUpperCase(), r]));
    const out = {};
    for (const [id, view] of Object.entries(PRESENTATION)) {
      const rec = byCode.get(String(view.code).toUpperCase());
      if (rec) out[id] = buildSkill(rec, { ...view, id });
      else console.warn(`绝学 ${id}（代码 ${view.code}）在 skills.json 里找不到`);
    }
    return out;
  }

  get skills() {
    if (!this._skills) this._skills = this.buildSkillTable();
    return this._skills;
  }

  get idlePrompt() {
    const hints = (this.player?.def.skills ?? []).map((id, i) => {
      const s = this.skills[id];
      if (!s) return null;
      const cost = s.costHp ? `耗${TERMS.hp}${s.costHp}` : `耗${TERMS.qi}${s.costQi}`;
      return `${i + 1} → ${s.name}（${cost}）`;
    }).filter(Boolean);
    const live = this.foes?.filter((f) => f.alive).length ?? 0;
    return [`空格 → ${TERMS.attack}`, ...hints,
            ...(live > 1 ? ['←→ → 换目标'] : []),
            `G → 格盘  H → 翻转排布(${COLUMN_ORDER()})  `
            + `N → 换遇敌群(${this.swarm}→组${this.encounter})`].join('　');
  }

  /**
   * 播放一次性特效（原作 effXXX.sf2）。
   *
   * 特效图层坐标本身就是按「敌方基准位」设计的落点（见 config.js 的
   * 战场坐标约定），所以容器只需跟随目标单位的站位偏移即可，
   * 不能再做任何居中对齐——那会把落点整体推偏。
   */
  playEffect(key, unit, onFinished, presentation = {}) {
    const data = key && this.cache.json.get(`${key}-anim`);
    if (!data) {
      onFinished?.();
      return;
    }

    // ⚠️ 平移量按**敌方基准点**算，不是按目标那一方的 —— 见 battlefield
    // 的 `effectOffset`。特效素材本来就是画在敌方基准位上的。
    const { x, y } = presentation.x == null ? effectOffset(unit?.def?.tile) : presentation;
    const projectile = key.startsWith('SHO') && presentation.actor && data.motion;
    const start = projectile ? actorAnchor(presentation.actor) : null;
    const steps = projectile ? motionSteps(data) : null;
    const fx = new SF2Animator(this, key, { x, y, depth: presentation.depth ?? 500,
      borrowUnit: unit,
      onFrameEvent: (event) => {
        presentation.onFrameEvent?.(event);
      } });
    fx.play({ loop: false, steps, onStep: steps ? ({ progress, lift }) => {
      fx.container.setPosition(start.x - EFFECT_ORIGIN.x + (x - (start.x - EFFECT_ORIGIN.x)) * progress,
        start.y - EFFECT_ORIGIN.y + (y - (start.y - EFFECT_ORIGIN.y)) * progress - lift);
    } : null, onComplete: () => { fx.destroy(); onFinished?.(); } });
    this.effects.push(fx);
  }

  /** 战斗曲：**哪一首由遇敌群的音乐档次决定**（0 杂兵 / 1 剧情 / 2 强敌 / 3 决战）。 */
  startBgm() {
    // 走公共入口：场景漫游按 B 进战斗时，先把地图那首停掉再起战斗曲，
    // 否则两首会叠在一起响。见 systems/bgm.js。
    this.bgm = playBgm(this, this.plan?.bgm?.key);
  }

  /**
   * 玩家这一轮走到哪一步了 —— **六个指令共用的状态机**。
   *
   * ```
   * main ──攻擊──────────────────────────────→ target ──确认──→ 出手
   *   ├───法寶──→ category ──选类──→ list ──选件──→ target
   *   ├───絕學──────────────→ list ──选门──→ target
   *   ├───防禦 / 退卻 ─────────────────────────────────→ 出手
   *   └───諸態──────────────→ status
   * ```
   *
   * `ESC` 退一步，退到 `main` 为止。**上下左右与空格按 `stage` 分派**，
   * 别在 `bindInput` 里堆 `if` —— 那样每加一个子界面就要改六个键。
   */
  get stage() { return this.pick?.stage ?? 'main'; }

  /** 回到主菜单那一步，把子界面收起来。 */
  toMainStage() {
    this.reviveTargets?.hide();
    this.pick = { stage: 'main', action: null, tiles: [], at: 0 };
    this.itemList?.hide();
    this.skillList?.hide();
    this.categories?.hide();
    this.kinds?.hide();
    this.info?.hide();
    this.confirm?.hide();
    this.status?.hide();
    this.tiles?.hide();
    this.hideMarkers();
    this.menu?.show();
    this.setPrompt(this.idlePrompt);
  }

  /** `ESC`：退一步。 */
  backStage() {
    if (!this.canChoose()) return;
    switch (this.stage) {
      case 'status':
      case 'skillKind':
        return this.toMainStage();
      case 'confirm':
        // 从确认框退回来：回到列表那一步
        this.confirm?.hide();
        this.pick = { ...this.pick, stage: 'list' };
        this.list?.show();
        return undefined;
      case 'target':
      case 'deadTarget':
        // 从选目标退回来：法寶/絕學退回列表，攻擊直接退回主菜单
        if (this.pick.action?.kind === ACTION_KIND.ATTACK) return this.toMainStage();
        this.pick = { ...this.pick, stage: 'list' };
        this.tiles?.hide();
        this.reviveTargets?.hide();
        this.hideMarkers();
        this.list?.show();
        this.describeRow();
        return undefined;
      case 'list':
        // 法寶的列表退回四类板，絕學的直接退回主菜单
        this.itemList?.hide();
        this.skillList?.hide();
        // ⚠️ **说明板要跟着收。** 漏了它的表现是「退回上一级，左边那两个框
        // 还杵在那儿」—— 用户 2026-09-18 报的 bug。
        this.info?.hide();
        if (this.pick.category) {
          this.pick = { ...this.pick, stage: 'category' };
          this.categories?.show(this.pick.categoryIndex ?? 0);
          return undefined;
        }
        if (this.pick.skillKind != null) {
          this.pick = { ...this.pick, stage: 'skillKind' };
          this.kinds?.show(this.pick.skillKind);
          return undefined;
        }
        return this.toMainStage();
      case 'category':
        return this.toMainStage();
      default:
        return undefined;
    }
  }

  /** 上下键：按当前这一步分派。 */
  moveCursor(step) {
    if (!this.canChoose()) return;
    switch (this.stage) {
      case 'category': this.categories?.move(step); break;
      case 'skillKind': this.kinds?.move(step); break;
      case 'confirm': this.confirm?.toggle(); break;
      case 'status': this.cycleStatus(step); break;
      case 'list': this.list?.move(step); this.describeRow(); break;
      case 'deadTarget': this.reviveTargets?.move(step); break;
      // 选目标时上下也换格 —— 一排四格，上下相当于前后排
      case 'target': this.moveTarget(step); break;
      default: this.menu?.move(step); this.setPrompt(this.idlePrompt); break;
    }
  }

  /** 左右键：主菜单不用，选目标时换格。 */
  moveSide(step) {
    if (!this.canChoose()) return;
    if (this.stage === 'target') this.moveTarget(step);
  }

  /**
   * 点一下鼠标。
   *
   * ⚠️ 上一版是一句 `pointerdown → confirmCommand()` —— **点屏幕任何地方
   * 都会弹「確定使用」**，而列表页的翻页箭头压根没接鼠标。
   * 用户 2026-09-19：「上下翻键按钮没有办法鼠标点击…不论鼠标点击哪里，
   * 都会跳出确认使用」。
   *
   * 列表页的规矩（与原作一致的最简形）：
   * * 点翻页箭头 → 整页翻
   * * 点某一行 → 先选中它；**再点同一行才确认**
   * * 点别处 → 什么都不做
   */
  onPointerDown(pointer) {
    if (pointer.rightButtonDown()) { if (!this.results) this.backStage(); return; }
    if (!pointer.leftButtonDown()) return;
    if (this.results) return this.results.next();
    if (!this.canChoose()) return undefined;
    if (this.stage === 'deadTarget') {
      const index = this.reviveTargets.hitTest(pointer);
      if (index < 0) return undefined;
      if (index === this.reviveTargets.index) return this.confirmDeadTarget();
      this.reviveTargets.index = index;
      this.reviveTargets.draw();
      return undefined;
    }
    if (['main', 'category', 'skillKind'].includes(this.stage)) {
      const board = this.stage === 'main' ? this.menu : this.stage === 'category' ? this.categories : this.kinds;
      const rows = this.stage === 'main' ? ROW_CENTER_Y : this.stage === 'category' ? [37,67,98,130] : [37,67];
      const ui = uiPointer(pointer, board?.root);
      if (!board || ui.x < board.root.x || ui.x > board.root.x+107) return;
      const index = rows.findIndex(y => Math.abs(ui.y-board.root.y-y) < 15);
      if (index < 0) return;
      board.index = index;
      if (this.stage === 'main') board.drawCursor(); else board.paint(index);
      return this.confirmCommand();
    }
    if (this.stage === 'confirm') {
      const box = this.confirm;
      const hit = box?.hitTest(pointer);
      if (!hit) return;
      const yes = hit === 'confirm';
      if (box.yes !== yes) box.toggle();
      return this.answerConfirm();
    }
    if (this.stage === 'target') { if (this.hoverTarget(pointer)) return this.confirmTarget(); return; }
    if (this.stage === 'status') return this.cycleStatus(1);
    if (this.stage !== 'list' || !this.list) return;

    const hit = this.list.hitTest(pointer);
    if (!hit) return undefined;
    if (hit.kind === 'up' || hit.kind === 'down') {
      this.list.page(hit.kind === 'up' ? -1 : 1);
      this.describeRow();
      return undefined;
    }
    if (hit.index === this.list.index) return this.askConfirm();
    this.list.index = hit.index;
    this.list.draw();
    this.describeRow();
    return undefined;
  }

  /** 确认键：按当前这一步分派。 */
  confirmCommand() {
    if (!this.canChoose()) return undefined;
    switch (this.stage) {
      case 'category': return this.openItemList();
      case 'skillKind': return this.openSkillList();
      case 'list': return this.askConfirm();
      case 'confirm': return this.answerConfirm();
      case 'status': return this.toMainStage();
      case 'target': return this.confirmTarget();
      case 'deadTarget': return this.confirmDeadTarget();
      default: return this.chooseCommand();
    }
  }

  /** 主菜单选中的那一项该走哪条路。 */
  chooseCommand() {
    switch (this.menu?.selected?.id) {
      case 'attack': return this.beginTargeting(attackAction(this.weaponRangeOf(this.player)));
      case 'item': return this.openCategories();
      case 'skill': return this.openSkillKinds();
      case 'guard': return this.playerGuard();
      case 'flee': return this.playerFlee();
      case 'status': return this.openStatus();
      default: return undefined;
    }
  }

  // ── 法寶 ────────────────────────────────────────────────────────────

  /** 法寶第一步：弹四类板（用器 / 兵刃 / 雜類 / 暫置）。 */
  openCategories() {
    this.pick = { ...this.pick, stage: 'category', categoryIndex: 0, skillKind: null };
    this.menu?.hide();
    this.info?.hide();
    this.categories?.show(0);
    this.setPrompt('法寶：選一類');
    return undefined;
  }

  /** 背包里这一类、战斗中列得出来的条目。 */
  bagRows(category) {
    const bag = this.registry.get(GAME_STATE_KEY)?.inventory ?? [];
    const rows = [];
    for (const row of bag) {
      const held = Boolean(row.暂置);
      if (category.bag === '暂置' ? !held : held) continue;
      const rec = this.itemRecord(row.代码);
      if (!rec || !listedInBattle(rec)) continue;
      if (category.bag !== '暂置' && battleCategoryOf(rec) !== category.bag) continue;
      rows.push({
        label: rec.名称繁 ?? rec.名称 ?? row.代码,
        count: Number(row.数量) || 0,
        enabled: usableInBattle(rec),
        // 说明文字走**繁体**（字库按 Big5 码位索引，喂简体是静默丢字）
        info: rec.说明繁 ?? rec.说明 ?? '',
        payload: { rec, code: row.代码, 编号: rec.物品编号 },
      });
    }
    return rows;
  }

  /**
   * 物品代码（**十六进制字符串**，判据表 B 组）→ 记录。
   *
   * ⚠️ **要并上装备表。** `items-full` 只有 141 条（用器 95 / 杂类 46），
   * 装备的 333 条在 `equipment-full` 里。只查前者的后果是**「兵刃」那一格
   * 永远是空的**，而且一声不吭 —— 用户看到的「东西都混在一起」就是这个。
   */
  itemRecord(code) {
    if (!this._itemByCode) {
      // ⚠️ **键是 `items-full`/`equipment-full`，不是 `items`/`equipment`。**
      const items = this.cache.json.get('items-full');
      const equip = this.cache.json.get('equipment-full');
      if (!Array.isArray(items)) {
        warnOnce('item-table', '物品表 items-full 没载入，法寶列表会是空的');
        return null;
      }
      if (!Array.isArray(equip)) {
        warnOnce('equip-table', '装备表 equipment-full 没载入，兵刃那一格会是空的');
      }
      this._itemByCode = new Map(
        [...items, ...(Array.isArray(equip) ? equip : [])]
          .map((r) => [normCode(r.物品编号), r]));
    }
    return this._itemByCode.get(normCode(code)) ?? null;
  }

  /** 法寶第二步：这一类的列表。 */
  openItemList() {
    const index = this.categories?.index ?? 0;
    const category = ITEM_CATEGORIES[index];
    const rows = this.bagRows(category);
    this.pick = {
      ...this.pick, stage: 'list', category, categoryIndex: index,
    };
    this.categories?.hide();
    this.skillList?.hide();
    this.list = this.itemList;
    this.list.setRows(rows);
    this.list.show();
    this.describeRow();
    return undefined;
  }

  // ── 絕學 ────────────────────────────────────────────────────────────

  /**
   * 絕學：这一位角色学过的全部绝学。
   *
   * ⚠️ **气不够的要列出来但选不了**（灰着），不是不显示 ——
   * 原作列表里看得见自己还放不出的招。
   */
  /** 絕學第一步：弹「咒法 / 絕技」两类板。 */
  openSkillKinds() {
    this.pick = { ...this.pick, stage: 'skillKind', skillKind: 0, category: null };
    this.menu?.hide();
    this.info?.hide();
    this.kinds?.show(0);
    this.setPrompt('絕學：選一類');
    return undefined;
  }

  /**
   * 絕學第二步：这一类的绝学列表。
   *
   * 分类规则**复用 `systems/skillbook.SKILL_KINDS`**（帧 0 咒法收
   * 咒法+阵法、帧 1 絕技收绝技）—— 与平时菜单的绝学页同一份判据。
   */
  openSkillList() {
    const kind = this.kinds?.index ?? 0;
    const want = SKILL_KINDS[kind] ?? [];
    const rows = [];
    for (const skill of this.skillsOf(this.player)) {
      if (want.length && !want.includes(skill.绝学类型)) continue;
      rows.push({
        label: skill.name,
        // ⭐ 消耗走**与平时菜单同一份** `listRows.costOf()`：一个图标 + 一个数
        // （蓝圆＝耗元气、红勾玉＝耗体力），就是原作列表里名字右边那个点。
        cost: costOf(skill, this.player.combatStats),
        enabled: affordable(skill, this.player.state) && !(skillRestriction(skill, this.player.combatStats) || this.fields.spellRestriction(skill)),
        info: skill.说明繁 ?? skill.说明 ?? '',
        payload: { skill },
      });
    }
    this.pick = { ...this.pick, stage: 'list', category: null, skillKind: kind };
    this.kinds?.hide();
    this.itemList?.hide();
    this.list = this.skillList;
    this.list.setRows(rows);
    this.list.show();
    this.describeRow();
    return undefined;
  }

  /**
   * 列表上按确认 → **先弹「確定使用 / 是 / 否」**（原作截图 1 就是这样）。
   *
   * ⚠️ 用不了的那一行（红字）按下去不弹框，只提示 —— 原作列表里
   * 看得见但选不动。
   */
  askConfirm() {
    const row = this.list?.selected;
    if (!row) { this.setPrompt('這裡什麼都沒有'); return undefined; }
    if (row.enabled === false) {
      this.setPrompt(row.payload?.skill ? ((skillRestriction(row.payload.skill, this.player.combatStats) || this.fields.spellRestriction(row.payload.skill)) || `${TERMS.qi}不足`) : '這件現在用不了');
      return undefined;
    }
    this.pick = { ...this.pick, stage: 'confirm' };
    this.confirm?.show();
    return undefined;
  }

  /** 确认框里选完：「是」进选目标，「否」退回列表。 */
  answerConfirm() {
    const yes = this.confirm?.yes;
    this.confirm?.hide();
    if (!yes) {
      this.pick = { ...this.pick, stage: 'list' };
      this.list?.show();
      return undefined;
    }
    return this.chooseFromList();
  }

  // ── 諸態 ──────────────────────────────────────────────────────────

  /**
   * 諸態页：两块板 + **左键（或上下键）切下一个人**（用户最早的口述）。
   * 数值与菜单角色页同源。见 `ui/StatusPage.js`。
   */
  openStatus() {
    this.pick = { ...this.pick, stage: 'status', who: this.allies.indexOf(this.player) };
    this.menu?.hide();
    this.renderStatus();
    this.status?.show();
    this.setPrompt('諸態　↑↓ 或點一下換人　ESC 退出');
    return undefined;
  }

  /** 切到下一个队友。 */
  cycleStatus(step) {
    const n = this.allies.length;
    if (!n) return;
    this.pick = { ...this.pick, who: ((this.pick.who ?? 0) + step % n + n) % n };
    this.renderStatus();
  }

  renderStatus(unit = this.allies[this.pick?.who ?? 0]) {
    if (!unit) return;
    const catalogue = this.cache.json.get('equipment-full');
    const nameOf = (code) => {
      if (!code || !Array.isArray(catalogue)) return '';
      const want = normCode(code);
      const rec = catalogue.find((r) => normCode(r.物品编号) === want);
      return rec?.名称繁 ?? rec?.名称 ?? '';
    };
    const gear = unit.stats?.装备 ?? {};
    this.status?.render(unit, partyPortraitFrame(unit.stats?.code) ?? 0, {
      兵刃: nameOf(gear.兵刃),
      甲衣: nameOf(gear.甲衣 ?? gear.护甲),
      飾物: nameOf(gear.饰物),
      諸能: nameOf(gear.诸能),
    });
  }

  /** 列表上选中那一行 → 做成一个 `action` → 进选目标。 */
  chooseFromList() {
    const row = this.list?.selected;
    if (!row) { this.setPrompt('這裡什麼都沒有'); return undefined; }
    if (row.enabled === false) {
      this.setPrompt(row.payload?.skill ? ((skillRestriction(row.payload.skill, this.player.combatStats) || this.fields.spellRestriction(row.payload.skill)) || `${TERMS.qi}不足`) : '這件現在用不了');
      return undefined;
    }
    const { skill, rec } = row.payload ?? {};
    if (skill) return this.beginTargeting(skillAction(skill, this.skillRecord(skill)));
    if (rec) {
      this.pick = { ...this.pick, itemCode: row.payload.code };
      return this.beginTargeting(itemAction(rec));
    }
    return undefined;
  }

  /**
   * 这一位角色**学过哪些绝学**。
   *
   * ⚠️ 判据是**角色数据里的已学绝学代码**（`gamedata.角色[].绝学`，
   * 十六进制字符串数组，从存档读进来的队伍成员也带着它），
   * **不是 `config.UNITS` 里那张手写的 `skills`** —— 判据表 F 组
   * 「写清单类常量要拿数据反查」。手写清单的表现是**队伍里没写进表的人
   * 一门绝学都放不出来**（慕容璇玑、冰璃全都空着），而且不报错。
   */
  skillsOf(unit) {
    const codes = battleSoulSkills(unit?.stats, unit?.soulStone, this.cache.json.get('refining')?.souls);
    // 明确的空列表就是尚未习得；不能借演示招式掩盖剧情写入遗漏。
    if (Array.isArray(unit?.stats?.绝学) || codes.length) {
      return codes.map((c) => this.skillByCode(c)).filter(Boolean);
    }
    return (unit?.def?.skills ?? []).map((id) => this.skills[id]).filter(Boolean);
  }

  /**
   * 绝学代码（**十六进制字符串**）→ 能用的绝学对象。
   *
   * `PRESENTATION` 里配过表现（动画/特效）的优先用那一份；没配过的
   * 直接拿 `skills.json` 建一个，**表现退化成默认出招动作**——
   * 总比「这门绝学在列表里根本不出现」强。
   */
  skillByCode(code) {
    const want = String(code).toUpperCase();
    for (const s of Object.values(this.skills)) {
      if (String(s.code).toUpperCase() === want) return s;
    }
    const rec = this.skillRecord({ code: want });
    return rec ? buildSkill(rec, { id: want, code: want }) : null;
  }

  /** 绝学的原始记录（`作用对象`/`作用范围`/`前后排判定` 在这儿）。 */
  skillRecord(skill) {
    if (!this._skillByCode) {
      const rows = this.cache.json.get('skills-full') ?? [];
      this._skillByCode = new Map(rows.map((r) => [String(r.绝学代码).toUpperCase(), r]));
    }
    return this._skillByCode.get(String(skill?.code).toUpperCase()) ?? null;
  }

  /** 列表光标停在哪一行，底下说明写什么。 */
  describeRow() {
    const row = this.list?.selected;
    // ⭐ 左边那块说明板跟着光标走（原作截图里选中「雷引之術」左边就写着它的说明）。
    // 法寶多一块插图板，絕學没有。
    // 法寶传物品编号（插图板要画那件道具的画），絕學传 null（没有插图板）。
    const artCode = this.pick?.category ? (row?.payload?.编号 ?? '') : null;
    this.info?.show(row?.info ?? '', artCode);
    this.setPrompt(row ? row.label : '（空）');
  }

  // ── 选目标（模块 F）────────────────────────────────────────────────

  /**
   * 进选目标：**绿格铺这次动作能指的整整 8 格**，蓝格是当前会打到的。
   *
   * 光标的起点优先落在**站着人的、能确认的**格上 —— 否则玩家一进来
   * 看到光标压在空地上，还以为选不了。
   */
  /**
   * 某一方**还活着的人**占的格。前排是相对的，选目标时必须带上它 ——
   * 否则前排四个倒了之后，近战就够不着后排，仗打不完。
   */
  liveTiles(side) {
    return this.units
      .filter((u) => targetable(u) && u.def.side === side && u.def.tile)
      .map((u) => ({ ...u.def.tile }));
  }

  /** 这次动作打的是哪一方（绿格铺在哪一侧）。 */
  campSide(action) {
    return action?.camp === CAMP.FOE ? 'foe' : 'ally';
  }

  actionTiles(action) {
    if (action?.camp === CAMP.DEAD) return this.units.filter((u) => !u.alive
      && u.def.side === (this.player?.def.side ?? 'ally')).map((u) => u.def.tile);
    return this.liveTiles(this.campSide(action));
  }

  beginTargeting(action) {
    if (action.camp === CAMP.DEAD) {
      this.hideChoiceUI();
      this.pick = { ...this.pick, stage: 'deadTarget', action };
      this.reviveTargets.show(this.allies);
      return undefined;
    }
    const actorTile = this.player?.def?.tile
      ? { side: this.player.def.side, ...this.player.def.tile } : null;
    const tiles = greenTiles(action, actorTile);
    const alive = this.actionTiles(action);
    const stops = this.targetStops(action, tiles, actorTile, alive);
    const at = stops.length ? stops[0] : 0;

    this.pick = {
      ...this.pick, stage: 'target', action, tiles, stops, at, actorTile,
    };
    this.menu?.hide();
    this.itemList?.hide();
    this.skillList?.hide();
    this.categories?.hide();
    // ⭐ **左边那两块板也要收**（说明板 + 插图板）与絕學的两类板、確定使用框。
    // 用户 2026-09-19：「选择敌方目标，这个时候左边的法宝介绍页面应该消失，
    // 他挡在这儿肯定是不对的。绝学也有一样的问题。」
    // ⚠️ 上一版只收了菜单与列表，`info`/`kinds`/`confirm` 三处漏了 ——
    // 与判据表 E 组「一个界面打开时，把每条路径都数出来」是同一类：
    // **退出也要把每一块都数出来**。
    this.info?.hide();
    this.kinds?.hide();
    this.confirm?.hide();
    this.refreshTiles();
    this.showMarkers();
    return undefined;
  }

  /**
   * 光标**能停在哪几格** —— 返回 `tiles` 里的下标。
   *
   * 判据：原作的光标只在**站着人的格子**之间跳。空地既选不中
   * （`confirmTarget` 会说「那裡沒有人」），又不该变蓝 —— 用户 2026-09-19：
   * 「还是能够落在没有人站的格子上，尤其是落在没有人站的格子上的时候，
   * 竟然格子还会变蓝。」
   *
   * 两级兜底：有人且指得上的 → 只是指得上的 → 全部绿格。
   * 兜底是为了「这一下确实指不到任何人」时光标仍有地方待着，不至于卡死。
   */
  targetStops(action, tiles, actorTile, alive) {
    const key = (t) => `${t.u},${t.v}`;
    const ok = new Set(confirmableTiles(action, actorTile, alive).map(key));
    const taken = new Set((alive ?? []).map(key));
    const pick = (f) => tiles.map((t, i) => (f(t) ? i : -1)).filter((i) => i >= 0);
    const both = pick((t) => ok.has(key(t)) && taken.has(key(t)));
    if (both.length) return both;
    const reach = pick((t) => ok.has(key(t)));
    return reach.length ? reach : tiles.map((_, i) => i);
  }

  /** 光标在**能停的格子**之间移动（空地跳过去）。 */
  moveTarget(step) {
    const { tiles, stops } = this.pick ?? {};
    if (!tiles?.length) return;
    const list = stops?.length ? stops : tiles.map((_, i) => i);
    const cur = Math.max(0, list.indexOf(this.pick.at));
    const n = list.length;
    this.pick = { ...this.pick, at: list[((cur + step) % n + n) % n] };
    this.refreshTiles();
    this.showMarkers();
  }

  /**
   * 鼠标悬停换目标 —— **原作就是靠鼠标指的**（用户 2026-09-16 口述）。
   * 找离指针最近的那一格；太远就不动，免得随便晃一下就换人。
   */
  hoverTarget(pointer) {
    if (!this.canChoose() || this.stage !== 'target') return;
    const { tiles } = this.pick ?? {};
    if (!tiles?.length) return;
    const world = pointer.positionToCamera(this.cameras.main); // 战场相机的世界坐标（宽屏下 pointer.worldX 可能来自别的相机）
    // ⚠️ 只吸附到**能停的格子**，与键盘那条同一份判据（见 `targetStops`）。
    const list = this.pick.stops?.length ? this.pick.stops : tiles.map((_, i) => i);
    let best = -1;
    let bestD = Infinity;
    for (const i of list) {
      const t = tiles[i];
      const c = tileCenter(t.u, t.v);
      const d = (c.x - world.x) ** 2 + (c.y - world.y) ** 2;
      if (d < bestD) { bestD = d; best = i; }
    }
    // 一格的半宽约 54px，超过一格半就当没指到
    if (best < 0 || bestD > 80 * 80) return false;
    if (best === this.pick.at) return true;
    this.pick = { ...this.pick, at: best };
    this.refreshTiles();
    this.showMarkers();
    return true;
  }

  /** 当前光标那一格。 */
  get aimTile() {
    const { tiles, at } = this.pick ?? {};
    return tiles?.[at] ?? null;
  }

  /**
   * 重铺格子。绿＝这次动作可以指的**整整 8 格**（用户：不管格子上有没有人）；
   * 蓝＝指着当前那一格时**实际会打到**的那几格。
   */
  refreshTiles() {
    if (!this.tiles) return;
    if (!this.canChoose() || this.stage !== 'target') {
      this.tiles.hide();
      return;
    }
    const { action, tiles, actorTile } = this.pick;
    this.tiles.show(tiles,
      blueTiles(action, this.aimTile, actorTile, this.actionTiles(action)));
  }

  /** 确认目标 → 出手。打不到人就不让确认。 */
  confirmDeadTarget() {
    const target = this.reviveTargets.selected;
    if (!target || target.alive) return undefined;
    const { action } = this.pick;
    this.commit(this.player, action, [target]);
    return undefined;
  }

  confirmTarget() {
    const { action, actorTile } = this.pick;
    const alive = this.actionTiles(action);
    const targets = targetsOf(action, this.aimTile, this.units, actorTile, alive);
    if (!targets.length) {
      this.setPrompt(blueTiles(action, this.aimTile, actorTile, alive).length
        ? '那裡沒有人' : '這個位置指不上');
      return undefined;
    }
    this.setPrompt(`${this.player.name}　${action.label}`);
    this.commit(this.player, action, targets);
    return undefined;
  }

  // ── 防禦 / 退卻 ────────────────────────────────────────────────────

  /**
   * 防禦 —— **不经过蓄劲，直接从最右端开始回气**（用户口述的原作行为）。
   *
   * 官方0x422b44传防御状态，0x42ca77仅将物理部分整除2；咒术部分不减。
   * 标记在回气走完那一刻清掉 —— 也就是「持续一回合」。
   */
  playerGuard() {
    if (this.deferChoice({ kind: 'guard', unit: this.player })) return;
    return this.guardUnit(this.player);
  }

  guardUnit(unit) {
    unit.guarding = true;
    this.setPrompt(`${unit.name} 防禦`);
    // ⭐ **防禦有防禦姿势**，一直摆到回气走完（用户 2026-09-18）。
    // 素材是 `DEF` 那一类（`DefDir.DAT`，我方七人各一包），
    // 包名＝站立包把 `STN` 换成 `DEF`。
    unit.holdPose(posePack(unit.def.stand, 'DEF'), 'guardAnim');
    this.clock = beginGuard(this.clock, unit);
    if (!this.interruptedChoice) this.pick = { stage: 'main', action: null, tiles: [], at: 0 };
    this.resume();
    return undefined;
  }

  /** 原作主菜单第六项提交1EA：按动作本身的蓄劲/回气，完成蓄劲才掷逃跑概率。 */
  playerFlee() {
    const skill = this.skillByCode('1EA');
    return this.commit(this.player, skillAction(skill), [this.player]);
  }

  resolveFlee(unit) {
    const chance = Number(this.plan?.escapeChance) || 0;
    if (nativeRand() % 100 < chance) {
      this.fled = true;
      return this.finish(false);
    }
    this.setPrompt(chance > 0 ? '退卻失敗' : '這一戰退不得');
    return this.afterAction(unit);
  }

  // ── 出手 ───────────────────────────────────────────────────────────

  /**
   * 敲定这一次动作：**进这一整条**（蓝 + 紫），让时钟继续跑。
   *
   * 蓄劲时长来自绝学的 `蓄劲秒`（`Firttech.enc +140`）；普攻与法寶都是 0，
   * 下一帧就到点、当场打出去。
   */
  commit(unit, action = null, targets = []) {
    // 选定就开始载这一招/这件道具的素材（按需），不等它：蓄劲、给别人下指令的时间都在载。
    this.loadActionPacks(action);
    if (this.deferChoice({ kind: 'action', unit, action, targets })) return;
    this.pendingActions.set(unit, { action, targets: [...targets] });
    this.clock = beginAction(this.clock, unit, action);
    // ⭐ **蓄劲期间摆蓄劲的姿势**（原作 `Firttech.enc +156 蓄劲动作`，
    // 例如摄魂鬼爪是 `RED0011`）。蓄劲时长为 0 的（普攻/法寶）不摆。
    if (action?.charge > 0) {
      unit.holdPose(posePack(unit.def.stand, 'RED', action.skill?.chargeAnim ?? unit.def.charge), 'chargeAnim');
    }
    this.resume();
    return undefined;
  }

  /** 收起选择界面，让时钟继续跑。 */
  resume() {
    if (this.phase === PHASE.OVER) return;
    if (this.drainChoice() || this.restoreChoice()) return;
    this.hideChoiceUI();
    this.phase = PHASE.RUNNING;
  }

  hideChoiceUI() {
    // ⚠️ **每一块都要收。** 少收一块就会留在画面上，而且不报错 ——
    // 加新板的时候最容易漏这儿。
    this.menu?.hide();
    this.itemList?.hide();
    this.skillList?.hide();
    this.reviveTargets?.hide();
    this.categories?.hide();
    this.kinds?.hide();
    this.info?.hide();
    this.confirm?.hide();
    this.status?.hide();
    this.tiles?.hide();
    this.hideMarkers();
  }

  /** 演出暂停时钟，但已轮到的玩家仍可浏览菜单。确认的指令等本次演出结束再提交。 */
  canChoose() {
    return !!this.player?.alive && !this.queuedChoice && (this.phase === PHASE.READY
      || (this.phase === PHASE.ACTING && this.interruptedChoice?.player === this.player));
  }

  deferChoice(command) {
    if (this.phase !== PHASE.ACTING || command.unit !== this.interruptedChoice?.player) return false;
    this.queuedChoice = command;
    this.hideChoiceUI();
    return true;
  }

  drainChoice() {
    const command = this.queuedChoice;
    if (!command) return false;
    this.queuedChoice = null;
    this.interruptedChoice = null;
    this.phase = PHASE.RUNNING;
    if (!command.unit.alive) return false;
    this.player = command.unit;
    this.actor = command.unit;
    if (command.kind === 'action') this.commit(command.unit, command.action, command.targets);
    else this.guardUnit(command.unit);
    return true;
  }

  /** 保存正在选择的角色；菜单位置保持实时值，避免演完后回到旧页面。 */
  interruptChoice() {
    if (this.phase === PHASE.READY && this.player?.alive) {
      this.interruptedChoice = { player: this.player };
    }
  }

  restoreChoice() {
    const saved = this.interruptedChoice;
    this.interruptedChoice = null;
    if (!saved) return false;
    if (!saved.player.alive) { this.hideChoiceUI(); return false; }
    this.player = saved.player;
    this.actor = saved.player;
    this.phase = PHASE.READY;
    this.refreshChoice();
    this.refreshTiles();
    this.showMarkers();
    return true;
  }

  /** 选单开启期间可能被扣气、封咒或解除场方效果，不能沿用打开时的可用性。 */
  refreshChoice() {
    if (!this.player?.alive) return;
    if (this.stage === 'status') this.renderStatus();
    if (this.stage !== 'list' && this.stage !== 'confirm') return;
    let changed = false;
    for (const row of this.list?.rows ?? []) {
      const skill = row.payload?.skill;
      if (!skill) continue;
      const enabled = affordable(skill, this.player.state)
        && !(skillRestriction(skill, this.player.combatStats) || this.fields.spellRestriction(skill));
      if (row.enabled !== enabled) { row.enabled = enabled; changed = true; }
    }
    if (changed) this.list.draw();
  }

  clockRunning() {
    return this.phase === PHASE.RUNNING
      || (this.phase === PHASE.READY && !!this.player && this.stage === 'main');
  }

  /**
   * 蓄劲走满 —— **真正打出去**。动作演完之前时钟停住（`PHASE.ACTING`）。
   *
   * 用户原作确认：执行动作时暂停；恢复主指令闲置后再走表。
   */
  fireAction(unit) {
    const pending = this.pendingActions.get(unit);
    // 已提交到潜地目标的行动保留到目标再现，不能删载荷、扣费或空放。
    if (pending?.targets?.[0]?.alive && !targetable(pending.targets[0]) && pending.targets[0] !== unit) return;
    this.pendingActions.delete(unit);
    if (this.phase === PHASE.OVER) return undefined;
    // 重复/过期回调不能消费其他人的动作，也不能打断正在演出的动作。
    if (!pending) return undefined;
    if (!unit?.alive) return this.afterAction(unit);

    this.interruptChoice();
    this.actor = unit;
    this.phase = PHASE.ACTING;
    const action = pending.action;
    // 蓄劲走满素材还没载完：停着表（ACTING）等它，载完再出手 —— 不跳过、不扣费重来。
    if (!this.actionPacksReady(action)) {
      this.pendingActions.set(unit, pending);
      this.loadActionPacks(action).then(() => {
        if (this.phase !== PHASE.OVER && this.pendingActions.get(unit) === pending) this.fireAction(unit);
      });
      return undefined;
    }
    const alive = (pending.targets ?? []).filter((t) => action?.camp === CAMP.DEAD ? !t.alive : targetable(t));
    if (!alive.length) return this.afterAction(unit);
    this.target = alive[0];
    if (action?.kind === ACTION_KIND.SKILL) {
      unit.payCost(action.skill);
      unit.soulActionCode = action.skill.code;
      unit.stats = trainSoul(unit.stats, equippedSoul(unit.stats, this.cache.json.get('refining')?.souls), action.skill.code);
      if (action.skill.code === '1EA') return this.resolveFlee(unit);
    }

    switch (action?.kind) {
      case ACTION_KIND.SKILL: return this.performSkill(unit, alive, action.skill);
      case ACTION_KIND.ITEM: return this.performItem(unit, alive, action.item);
      default: return this.performAttack(unit, alive, action);
    }
  }

  /** 普攻的演出。多个目标（直列/横排武器）时**一次动作打到所有人**。 */
  performAttack(actor, targets, action = null) {
    const rec = normalAttackRecord(this.cache.json.get('gamedata'), actor.def.code);
    if (rec) return this.performSkill(actor, targets, buildSkill(rec), action ?? attackAction(this.weaponRangeOf(actor)));
    const first = targets[0];
    this.setPrompt(`${actor.name} 攻向 ${first.name}`);
    const barrier = new ActionBarrier(() => this.afterAction(actor));
    // ⭐ **走不走过去看武器**：`武器攻击范围` 带「前排」的才冲上去。
    // 慕容璇玑的九陽煌珠是「任意单体」—— 原地出手。
    const lunge = action ? action.spot === SPOT.FRONT : null;
    actor.attack(first, () => {
      const costs = new Map();
      targets.forEach(t => this.strike(actor, t, weaponDamageScale(action, t, first), costs));
      this.fields.pay(costs);
    }, barrier.track(), lunge);
    barrier.seal();
    return undefined;
  }

  /** 绝学的演出与结算。 */
  performSkill(actor, targets, skill, action = null) {
    if (sustainedKind(skill)) return this.performSustained(actor, skill);
    const first = targets[0];
    this.setPrompt(`${actor.name}　${skill.name}　→　${first.name}`);

    // 一次判定供动作分支与最终结算共用，不能为选择MIS额外掷一次命中。
    const normal = action?.kind === ACTION_KIND.ATTACK;
    if (!normal) this.fields.cast(skill, actor);
    const outcomes = targets.map((target) => (normal ? resolveAttack : resolveSkill)(
      ...(normal ? [] : [skill]), actor.combatStats, target.combatStats, {
      attackerBonuses: actor.bonuses, defenderBonuses: target.bonuses, defenderResist: target.resists,
      attackerWeapon: actor.weapon, defenderEquipment: target.equipment, halfPhysical: !!target.guarding,
      ...this.fields.options(target),
    }));

    const reacted = new Set();
    const settle = () => {
      const fieldCosts = new Map();
      for (const [index, target] of targets.entries()) {
        const outcome = outcomes[index];
        if (!outcome.hit) { this.showEvade(target, !reacted.has(target)); continue; }
        const revive = skill.作用对象 === '死者' || skill.作用对象码 === 3;
        if (revive && target.revive()) this.clock = resetWait(this.clock, target);
        const hp = outcome.kind === 'recovery' ? -(outcome.hpRecovery ?? 0) : outcome.damage ?? 0;
        const qi = outcome.kind === 'recovery' ? -(outcome.qiRecovery ?? 0) : outcome.qiDamage ?? 0;
        const applied = this.fields.intercept(target, hp, qi, fieldCosts);
        this.showVitalChange(target, target.applyVitals(applied.hp, applied.qi, normal ? {} : skill,
          { penetration: normal && weaponDamageScale(action, target, first) === .5, reaction: !reacted.has(target) }), normal && outcome.critical);
        if (outcome.drained || outcome.drainedQi) {
          this.showVitalChange(actor, actor.applyVitals(-(outcome.drained ?? 0), -(outcome.drainedQi ?? 0)));
        }
        const effects = normal ? actor.weapon?.攻击特效 ?? [] : skill.附加特效 ?? [];
        if (target.alive) target.applyStates(skill, actor, effects);
        this.applySpecialSkill(skill, target);
      }
      this.fields.pay(fieldCosts);
      this.pendingHitPose = 0;
    };

    let settled = false;
    const settleOnce = () => {
      if (settled || !context.active) return;
      settled = true;
      settle();
    };
    const finish = () => {
      context.cancel();
      actor.borrowTarget = null;
      this.actionEffects.delete(actor);
      if (skill.code === '1C0') this.inspectEnemy(first);
      this.summonReinforcements(skill.code);
      this.afterAction(actor);
    };
    let barrier = new ActionBarrier(() => {
      settleOnce();
      // 原作等攻击及其特效结束再归位；返回段也可能触发特效。
      barrier = new ActionBarrier(finish);
      actor.returnSkill(cast, barrier.track());
      barrier.seal();
    });
    const actionDone = barrier.track();
    // DEFAULT使用人物表的施法动作；NULL不制造普通攻击来代替。
    const cast = { ...skill, anim: strikeAnimation(skill, outcomes, actor.def.cast),
      moveAnim: skill.移动动作原值 === 'DEFAULT' ? actor.def.move : skill.moveAnim,
      backAnim: skill.归位动作原值 === 'DEFAULT' ? actor.def.back : skill.backAnim,
    };
    const context = new ActionEffects({ record: skill, actor, targets,
      play: (slot, placement, onFrameEvent) => {
        this.playEffect(slot.文件, placement.target, barrier.track(), {
          ...placement,
          actor,
          onFrameEvent: (event) => {
            if (!context.active) return;
            context.react(event.frame);
            onFrameEvent(event);
          },
        });
      },
    });
    context.react = (frame) => this.reactToFrame(frame, targets, outcomes, reacted);
    context.actionKeys = new Set([cast.anim, cast.moveAnim, cast.backAnim].filter(Boolean));
    this.actionEffects.set(actor, context);
    actor.borrowTarget = outcomes[0]?.hit ? first : null;
    // 423690的受击标记只驱动姿势；420ed0(2)在整段演出结束后才显示数值。
    actor.useSkill(cast, first, () => {}, actionDone);
    barrier.seal();
    return undefined;
  }

  performSustained(actor, skill) {
    actor.sustained = createSustained(skill);
    this.sustainedActions.set(actor, skill);
    this.setPrompt(`${actor.name}　${skill.name}`);
    // 费用已在fireAction扣除；作用在持续结束时结算，不能每次循环治疗一次。
    actor.beginSustained(skill, actor, () => {
      if (this.phase === PHASE.OVER) return;
      this.clock = enterRecover(this.clock, actor);
      if (this.wiped(this.foes)) return this.finish(true);
      if (this.wiped(this.allies)) return this.finish(false);
      if (!this.drainChoice() && !this.restoreChoice()) this.phase = PHASE.RUNNING;
    });
  }

  tickSustained(delta) {
    this.sustainedElapsed += delta;
    const ticks = Math.floor(this.sustainedElapsed / 55);
    this.sustainedElapsed -= ticks * 55;
    for (const [unit, skill] of this.sustainedActions) {
      if (unit.alive && !advanceSustained(unit.sustained, ticks)) continue;
      this.sustainedActions.delete(unit);
      if (unit.alive) {
        const outcome = resolveSkill(skill, unit.combatStats, unit.combatStats, {
          attackerBonuses: unit.bonuses, defenderBonuses: unit.bonuses,
          attackerWeapon: unit.weapon, defenderEquipment: unit.equipment, ...this.fields.options(unit),
        });
        if (outcome.hit) {
          const costs = new Map();
          const hp = outcome.kind === 'recovery' ? -(outcome.hpRecovery ?? 0) : outcome.damage ?? 0;
          const qi = outcome.kind === 'recovery' ? -(outcome.qiRecovery ?? 0) : outcome.qiDamage ?? 0;
          const applied = this.fields.intercept(unit, hp, qi, costs);
          this.showVitalChange(unit, unit.applyVitals(applied.hp, applied.qi, skill, { reaction: false }));
          this.fields.pay(costs);
        }
      }
      // 独立收尾，不能调用afterAction而覆盖另一个人的出手/菜单状态。
      unit.endSustained(() => {});
    }
  }

  /**
   * 用一件法寶：伤害 / 回复 / 复活，判据全在 `systems/battleItem.js`。
   * **用完扣背包**（`consume`，不可变）。
   */
  performItem(actor, targets, record) {
    const name = record?.名称繁 ?? record?.名称 ?? '法寶';
    this.setPrompt(`${actor.name} 用了 ${name}`);
    const reacted = new Set();
    const outcomes = targets.map((target) => applyItem(record, target.combatStats, target, Math.random, {
      actor: actor.combatStats, attackerWeapon: actor.weapon, defenderBonuses: target.bonuses,
      defenderEquipment: target.equipment, halfPhysical: !!target.guarding, ...this.fields.options(target),
    }));
    let settled = false;
    const settle = () => {
      if (settled || !context.active) return;
      settled = true;
      const fieldCosts = new Map();
      for (const [index, target] of targets.entries()) {
        const got = outcomes[index];
        if (!got.hit) { this.showEvade(target, !reacted.has(target)); continue; }
        if (got.kind === 'revive' && target.revive()) this.clock = resetWait(this.clock, target);
        const applied = this.fields.intercept(target, (got.damage ?? 0) - (got.hp ?? 0), (got.qiDamage ?? 0) - (got.qi ?? 0), fieldCosts);
        this.showVitalChange(target, target.applyVitals(applied.hp, applied.qi, record, { reaction: !reacted.has(target) }));
        if (got.drained || got.drainedQi) this.showVitalChange(actor, actor.applyVitals(-(got.drained ?? 0), -(got.drainedQi ?? 0)));
        if (target.alive) target.applyStates(record, actor);
      }
      this.fields.pay(fieldCosts);
    };
    const barrier = new ActionBarrier(() => {
      settle();
      context.cancel();
      this.actionEffects.delete(actor);
      this.afterAction(actor);
    });
    const context = new ActionEffects({ record, actor, targets,
      play: (slot, placement, onFrameEvent) => this.playEffect(slot.文件, placement.target,
        barrier.track(), { ...placement, onFrameEvent: (event) => {
          if (!context.active) return;
          context.react(event.frame);
          onFrameEvent(event);
        } }),
    });
    context.react = (frame) => this.reactToFrame(frame, targets, outcomes, reacted);
    context.actionKeys = new Set();
    this.actionEffects.set(actor, context);
    // 编号随已提交的物品记录走，不能从可能已切到另一人的选择面板取。
    this.spendItem(record.物品编号);
    context.trigger({ index: 0, effect_file: 1 }, 'item');
    barrier.seal();
    return undefined;
  }

  /** 原程序423712：每个标记都可重播HIT/DEF，但整次行动只结算一次数值。 */
  reactToFrame(frame, targets, outcomes, reacted) {
    if (frame.hit_pose !== 1) return;
    targets.forEach((target, index) => {
      if (!target.alive) return;
      if (outcomes[index].hit) target.hurt();
      else target.evade();
      reacted.add(target);
    });
  }

  showVitalChange(unit, change) {
    this.vitalFeedback.show(unit, change);
  }

  applySpecialSkill(skill, target) {
    const code = skill.code;
    if (code === '1D0') target.statuses = { ...target.statuses, 16: 1000000 };
    const kind = this.cache.json.get('gamedata')?.战斗规则?.时轮?.[code];
    if (!kind) return;
    this.clock = this.clock.map((entry) => {
      if (entry.unit !== target || (kind !== 'ready' && entry.phase !== CLOCK.WAIT)) return entry;
      const progress = kind === 'halve' ? entry.progress / 2 : kind === 'reset' ? 0
        : kind === 'half' ? .5 : (entry.phase === CLOCK.CHARGE ? entry.release : 1);
      return { ...entry, progress };
    });
  }

  inspectEnemy(unit) {
    this.enemyInspection.show(unit);
  }

  /** 背包里扣掉一件。**整份状态换新的，不原地改**。 */
  spendItem(code) {
    if (!code) return;
    const state = this.registry.get(GAME_STATE_KEY);
    if (!state?.inventory) return;
    this.registry.set(GAME_STATE_KEY,
      Object.freeze({ ...state, inventory: consume(state.inventory, code) }));
  }

  /** 原作行动结束后补入敌人；死亡槽销毁旧实例，复用敌方编号。 */
  summonReinforcements(code) {
    const slots = Array(8).fill(null);
    for (const unit of this.foes) slots[Number(unit.def.id.slice(3))] = unit;
    const additions = planReinforcements(code, slots.map(unit => unit && ({
      alive: unit.alive, slot: unit.def.slot, size: unit.stats.占格类型,
    })));
    const data = this.cache.json.get('gamedata');
    for (const { code: enemy, slot, index } of additions) {
      const old = slots[index];
      if (old) {
        this.pendingActions.delete(old);
        this.clock = this.clock.filter(entry => entry.unit !== old);
        this.units = this.units.filter(unit => unit !== old);
        this.foes = this.foes.filter(unit => unit !== old);
        old.destroy();
      }
      const def = placeDef(enemyDef(data, enemy, index), slot, 'foe');
      const unit = this.createUnit({ ...def, stats: { ...def.stats, 命: def.stats.命极 } });
      unit.onFrameEvent = event => this.handleFrameEvent(event);
      this.units.push(unit); this.foes.push(unit);
      this.clock.push(...createClock([unit]));
      if (this.foe === old) this.foe = unit;
    }
    return additions;
  }

  /**
   * 动作演完 → **进回气**（紫条从右往左退）。
   *
   * 回气时长来自绝学的 `回气秒`；普攻走缺省值。
   * ⚠️ **不要在这里等 `TURN_GAP_MS`** —— 回气本身就是那个间隔，
   * 再加一段死等就变回「回合之间卡一下」的回合制手感。
   */
  afterAction(unit) {
    // 0x442be6：一次行动结束，取消跟随并在5拍内回中。
    this.battleCamera?.reset();
    if (this.phase === PHASE.OVER) return undefined;
    // ⭐ **收姿势**：蓄劲摆的是 `RED00X0`，打完要回站立，否则那个人
    // 会一直保持蓄劲的架势站到下一轮（实机上看着像「卡住了」）。
    // 防禦的姿势不在这里收 —— 它要保持到那一段紫条走完，见 `onDue`。
    if (unit?.alive && !unit.guarding) unit.idle();
    if (unit) {
      // ⭐ **紫接着蓝停下的那一点走**（`enterRecover` 不动 progress）；
      // 普攻没有紫段（蓄劲＝回气＝0），**直接回绿条**。
      const entry = entryOf(this.clock, unit);
      if (!hasRecover(entry)) endSoulOpportunity(unit);
      this.clock = hasRecover(entry)
        ? enterRecover(this.clock, unit)
        : resetWait(this.clock, unit);
    }
    if (this.wiped(this.foes)) return this.finish(true);
    if (this.wiped(this.allies)) return this.finish(false);
    if (this.drainChoice() || this.restoreChoice()) return undefined;
    this.phase = PHASE.RUNNING;
    return undefined;
  }

  /**
   * 结算一次命中：伤害、受击表现、震屏、飘字。
   * 不负责推进回合——回合何时交手由 ActionBarrier 统一判定，
   * 必须等出招动作与特效全部播完。
   */
  strike(attacker, defender, scale = 1, fieldCosts = new Map()) {
    const raw = resolveAttack(attacker.combatStats, defender.combatStats, {
      attackerBonuses: attacker.bonuses, attackerWeapon: attacker.weapon, defenderEquipment: defender.equipment,
      defenderBonuses: defender.bonuses, halfPhysical: !!defender.guarding, ...this.fields.options(defender),
    });
    const { hit, critical } = raw;
    // 防御已在共同计算中只减物理部分；贯穿减伤另由目标范围决定。
    // 防禦持续到那一段紫条走完 —— 标记在 `onDue` 的回气分支里清。
    const damage = raw.damage;
    this.pendingHitPose = 0;
    if (!hit) {
      this.showEvade(defender);
      return;
    }
    const applied = this.fields.intercept(defender, damage, 0, fieldCosts);
    this.showVitalChange(defender, defender.applyVitals(applied.hp, applied.qi, {}, { penetration: scale === .5 }), critical);
    if (raw.drained || raw.drainedQi) this.showVitalChange(attacker, attacker.applyVitals(-raw.drained, -raw.drainedQi));
  }

  /**
   * **某根条走满了。** 时钟每帧只交一个上来，处理完才继续跑。
   *
   * * 绿满 → 轮到他选动作（我方弹菜单、敌方跑 AI）
   * * 蓝满 → 打出去
   * * 紫满 → 回到绿，重新涨
   */
  onDue(entry) {
    const unit = entry.unit;
    if (entry.phase === CLOCK.CHARGE) return this.fireAction(unit);
    if (entry.phase === CLOCK.RECOVER) {
      endSoulOpportunity(unit);
      // 防禦「持续一回合」＝ 持续到这一段紫条走完；姿势也在这一刻收。
      if (unit.guarding) unit.idle();
      unit.guarding = false;
      this.clock = resetWait(this.clock, unit);
      return undefined;
    }
    return this.beginTurn(unit);
  }

  /**
   * 轮到谁了 —— **绿条涨满的那一刻**。
   *
   * 我方主指令闲置继续走表；打开任何子页面暂停（用户2026-09-20确认）；
   * 敌方隔 `TURN_GAP_MS` 自己出手，那一下停顿是给玩家看清「轮到谁」用的。
   */
  beginTurn(unit) {
    if (this.phase === PHASE.OVER) return undefined;
    if (this.wiped(this.foes)) return this.finish(true);
    if (this.wiped(this.allies)) return this.finish(false);
    // 条满的那一瞬间人没了：下一帧时钟会把他的条归零，这里什么都不做。
    if (!unit?.alive) return undefined;

    if (unit.def.side === 'ally' && !unit.soulChecked) {
      unit.soulChecked = true;
      const stone = equippedSoul(unit.stats, this.cache.json.get('refining')?.souls);
      if (canSummon(unit.stats, stone)) unit.soulStone = stone;
    }
    if (unit.def.side !== 'ally') this.interruptChoice();
    this.actor = unit;
    if (unit.def.side === 'ally') {
      this.player = unit;
      this.retarget();
      this.phase = PHASE.READY;
      // 每次轮到人都从头开始：主菜单那一步，子界面全收起来。
      this.toMainStage();
      this.showMarkers();
      return undefined;
    }
    this.phase = PHASE.ACTING;
    if (!this.interruptedChoice) this.hideChoiceUI();
    this.time.delayedCall(TURN_GAP_MS, () => this.foeTurn());
    return undefined;
  }

  /** Enemy_AI行动概率与MagicCon条件选招，复用敌我共同动作、目标与费用流程。 */
  foeTurn() {
    if (this.phase === PHASE.OVER) return undefined;
    const actor = this.actor;
    if (!actor?.alive) return this.afterAction(actor);
    const strategy = this.cache.json.get('gamedata')?.敌人策略;
    const choice = chooseEnemyAction(actor, this.foes, this.allies, strategy,
      code => this.skillRecord({ code }), {
        spellBlocked: this.fields.has('ally', 2) || this.fields.has('foe', 2),
        canUse: code => {
          if (enemySkillSupported(code)) return true;
          warnOnce(`enemy-skill-${code}`, `${DEFERRED_ENEMY_SKILLS[code]}；该技能暂不进入敌方候选`);
          return false;
        },
      });
    if (choice === -1) return this.guardUnit(actor);
    const skill = choice > 0 ? this.skillByCode(choice.toString(16).toUpperCase()) : null;
    const action = skill ? skillAction(skill, this.skillRecord(skill)) : attackAction(this.weaponRangeOf(actor));
    const tile = { ...actor.def.tile, side: actor.def.side };
    const live = this.units.filter(u => action.camp === CAMP.DEAD ? !u.alive : targetable(u));
    const aliveTiles = live.map(u => u.def.tile);
    const legal = confirmableTiles(action, tile, aliveTiles);
    const candidates = live.filter(u => legal.some(t => t.u === u.def.tile.u && t.v === u.def.tile.v));
    const target = candidates[Math.floor(Math.random() * candidates.length)];
    if (!target) return this.afterAction(actor);
    this.target = target;
    const targets = targetsOf(action, target.def.tile, this.units, tile, aliveTiles);
    return this.commit(actor, action, [target, ...targets.filter(u => u !== target)]);
  }

  /** 这个单位该打谁：敌方随机挑一个活着的我方，我方打当前选中的敌人。 */
  pickTarget(unit) {
    if (unit?.def?.side === 'foe') {
      const live = this.allies.filter((u) => targetable(u));
      return live.length ? live[Math.floor(Math.random() * live.length)] : null;
    }
    return targetable(this.foe) ? this.foe : this.foes.find(targetable) ?? null;
  }

  /**
   * 这一位角色的武器打多远 —— **返回原始的 `武器攻击范围` 字符串**，
   * 怎么解由 `systems/battleAction.attackAction()` 一家管。
   *
   * `stats.装备.兵刃` 是物品代码（**十六进制字符串**，判据表 B 组），
   * 到 `equipment.json` 里查 `武器攻击范围`（`Ail2.ENC +52`）。
   * 空手或查不到就按「前排单体」。
   */
  weaponRangeOf(unit) {
    const code = unit?.stats?.装备?.兵刃;
    if (!code) return null;
    // ⚠️ **要用 `equipment-full`，不是 `equipment`。** 两代产物并存：
    //   * `assets/equipment.json`（键 `equipment`）是**旧的**，按名称索引的
    //     dict、212 条、只有攻击/命中/必杀几个补正 —— **没有 `武器攻击范围`**；
    //   * `assets/data/equipment.json`（键 `equipment-full`）是现在的正本，
    //     333 条、数组、字段全，`物品编号` 是**十六进制字符串**。
    // 拿错那份的表现是 `rows.find is not a function` —— 这次还好会抛错；
    // 若旧那份恰好也是数组，就会静默地全都退化成「前排单体」。
    const rows = this.cache.json.get('equipment-full');
    if (!Array.isArray(rows)) {
      warnOnce('weapon-table', '装备表 equipment-full 没载入，武器范围一律按前排单体');
      return null;
    }
    const want = normCode(code);
    const rec = rows.find((r) => normCode(r.物品编号) === want);
    return rec?.武器攻击范围 ?? null;
  }

  /** 目标名牌按参考图放在左上；不再叠加开发用的行动/目标文字。 */
  showMarkers() {
    this.hideMarkers();
    if (this.stage !== 'target' || !this.canChoose()) return;
    const aim = this.aimTile;
    const target = this.units.find(u => targetable(u) && u.def.tile?.u === aim?.u && u.def.tile?.v === aim?.v);
    if (!target) return;
    this.marker = this.add.container(5, 100).setDepth(920);
    const texture = this.textures.get('battle-nameplate');
    if (!texture.has('battle-name')) texture.add('battle-name', 0, 0, 0, 252, 46);
    this.marker.add(this.add.nineslice(0, 0, 'battle-nameplate', 'battle-name', 153, 40, 12, 12, 12, 12).setOrigin(0, 0));
    this.marker.add(this.add.bitmapText(77, 10, menuFont(), target.name, FONT_SIZE)
      .setOrigin(0.5, 0));
  }

  hideMarkers() {
    this.marker?.destroy(true);
    this.marker = null;
  }

  /**
   * 当前目标：`this.foe` 死了就换下一个还活着的。
   *
   * ⚠️ `作用范围`（单体/直列/横排/全体）与 `前后排判定` 还没做，
   * 现在一律按单体处理。见 `docs/归档/兰州城Demo计划.md` 的 TODO。
   */
  retarget() {
    if (this.foe?.alive) return this.foe;
    this.foe = this.foes.find((f) => f.alive) ?? this.foe;
    return this.foe;
  }

  /** 一方是不是全灭了。 */
  wiped(units) {
    return !units.some((u) => u.alive);
  }

  /**
   * 单位头顶的位置，飘字用。
   *
   * ⚠️ **不能再用 `STAGE_WIDTH/2 + offsetX`。** 那是格盘之前的老约定
   * （偏移相对画面中心）；现在偏移是「格心 − 素材基准点」，
   * 照老式子算，伤害数字会飘到离本人一百来像素的地方。
   */
  unitAnchor(unit) {
    const t = unit?.def?.tile;
    if (t) return tileCenter(t.u, t.v);
    return { x: STAGE_WIDTH / 2 + (unit?.def?.offsetX ?? 0),
             y: STAGE_HEIGHT / 2 + (unit?.def?.offsetY ?? 0) };
  }

  /** 闪避表现：目标DEF姿势 + 「避」字；失误特效由原始攻击记录触发。 */
  showEvade(unit, reaction = true) {
    if (reaction) unit.evade();

    const { x, y: base } = this.unitAnchor(unit);
    const y = base - 70;
    const label = this.add
      .text(x, y, '避', {
        fontFamily: 'serif',
        fontSize: '26px',
        color: '#bcd6f0',
        stroke: '#0d1a2a',
        strokeThickness: 4,
      })
      .setOrigin(0.5)
      .setDepth(900);

    this.tweens.add({
      targets: label, y: y - 30, alpha: 0, duration: 700,
      ease: 'Quad.easeOut', onComplete: () => label.destroy(),
    });
  }

  floatDamage(unit, damage) {
    this.vitalFeedback.show(unit, { hp: -damage });
  }

  finish(playerWon) {
    if (this.phase === PHASE.OVER) return;
    this.units.forEach(endSoulOpportunity);
    const state = this.registry.get(GAME_STATE_KEY);
    if (state?.party) this.registry.set(GAME_STATE_KEY, Object.freeze({ ...state, party: writeBattleVitals(state.party, this.units) }));
    this.enemyInspection?.clear();
    this.phase = PHASE.OVER;
    this.interruptedChoice = null;
    this.queuedChoice = null;
    this.hideChoiceUI();
    this.pendingActions.clear();
    this.sustainedActions?.clear();
    this.units.forEach(u => { u.sustained = null; u.sustainedCast = null; });
    this.actionEffects?.forEach((context) => context.cancel());
    this.actionEffects?.clear();
    if (this.fled) {
      this.results = new BattleResults(this, null, [], null, () => {
        this.results = null;
        if (this.returnTo) this.scene.start('Field', this.returnTo);
      }, { retreat: true });
      return;
    }
    if (playerWon) {
      playBgm(this, VICTORY_BGM.key);
      this.settleSpoils();
      this.menu?.hide(); this.hideMarkers(); this.tiles?.hide();
      this.fields.entries = [];
      this.units.forEach(u => { u.statuses = {}; });
      for (const unit of this.allies) unit.celebrate(this.upgrades?.some(u => u.after.code === unit.def.code));
      this.results = new BattleResults(this, this.spoils, this.upgrades,
        this.registry.get(GAME_STATE_KEY)?.catalog, () => {
          this.results = null;
          if (this.returnTo) this.scene.start('Field', this.returnTo);
        });
      return;
    }
    if (!this.returnTo) {
      // 没有回程＝单独进来看阵型的调试路径，停在原地。
      this.setPrompt(playerWon ? TERMS.victory : TERMS.defeat);
      return;
    }
    // ⭐ **必胜战打输了 = 败阵**（释义 0x37：「必胜战斗」/「非必胜战斗，
    // 胜则步入下一子事件，败则跳转到第 Z 个子事件」）。演出照搬 `MP0000` 槽 9，
    // 但**影片只有 `FieldScene` 放得了**（`playMovie` 是它的方法），
    // 所以这里只负责把人送回地图并带上 `defeat`，由那边接着演。
    if (!playerWon && this.mustWin) {
      this.setPrompt(TERMS.defeat);
      // ⭐ **经加载页过去，不要直接进地图。** 直接 `scene.start('Field')` 的话
      // Field 会**先把那张地图画出来**，过一两帧才开始放影片 —— 画面上是
      // 「战斗结束 → 闪一下上一张地图 → 敗降」。用户报的就是这个闪。
      // 加载页本身就是纯黑，天然当黑幕用。
      // ⚠️ `silent: false` —— 曲子留着，`MP0000` 槽 9 自己会 `play_audio 31`。
      this.time.delayedCall(RETURN_DELAY_MS, () => this.scene.start('Loading', {
        ...this.returnTo, defeat: true, text: '', silent: false,
      }));
      return;
    }
    // ⭐ **非必胜战打输了要跳 `on_lose`。** 释义：「非必胜战斗，胜则步入
    // 下一子事件，**败则跳转到第 Z 个子事件**」。
    //
    // 全库 104 条 `battle` 里只有 3 条 `must_win=0`，全在 `MP0610A` 槽 9
    // 那段**三连战**（敌群 114 → 115 → 116），三条的 `on_lose` 都指向
    // index 230 —— 也就是三连战打完之后的那段剧情。
    //
    // 不接这一条的后果**不是剧情断掉**（终点一样），而是：队伍已经全倒，
    // 却还要被拉去打第二、第三场，**连吃两次秒败**才进后续剧情。
    //
    // 实现就是改一个游标：`pendingScript` 是 `enterBattle` 存的
    // `{map, slot, cursor}`，把 `cursor` 换成 `on_lose` 即可 ——
    // 回地图后 `resumePendingScript` 会从那里接着演。
    // ⚠️ **必胜战的 `on_lose` 是 0，不能当真**（全库那一条 `MP0610A` index49
    // 就是 `must_win=1, on_lose=0`）。走到这里 `mustWin` 必为假，
    // 但显式写出来，免得将来谁挪动分支顺序时把人送回槽首重演一遍。
    if (!playerWon && !this.mustWin && this.onLose !== null) {
      const pending = this.registry.get('pendingScript');
      if (pending) {
        this.registry.set('pendingScript', { ...pending, cursor: this.onLose });
      } else {
        console.warn(`非必胜战打输，但没有待续演的脚本 —— on_lose=${this.onLose} 跳不了`);
      }
    }
    const gained = this.spoils
      ? spoilsText(this.spoils, this.registry.get(GAME_STATE_KEY)?.catalog) : '';
    this.setPrompt(`${playerWon ? TERMS.victory : TERMS.defeat}`
      + (gained ? `　${gained}` : '') + '　·　空格继续');
    let returned = false;
    const back = () => { if (returned) return; returned = true; this.scene.start('Field', this.returnTo); };
    this.input.keyboard.once('keydown-SPACE', back);
    this.time.delayedCall(RETURN_DELAY_MS, back);
  }

  /**
   * 打赢之后把战利并进全局状态：**历练、银两、战利品**。
   *
   * 数据全在遇敌组里（掉落金钱上下限、战利品代码+概率），敌人各自的
   * `已有历练` 求和当本场历练 —— 算法与判据见 `systems/spoils.js`。
   *
   * ⚠️ **只在打赢时结算，而且只结算一次**（`phase` 已置 OVER，`finish`
   * 不会重入）。
   */
  settleSpoils() {
    const gamedata = this.cache.json.get('gamedata');
    const state = this.registry.get(GAME_STATE_KEY);
    if (!gamedata || !state?.party) return;

    // 标题页「成長 / 掉寶」的选择，每场结算现读（gameplayOptions.js）
    const patches = battlePatches();
    const spoils = rollSpoils(gamedata, this.encounter, Math.random, patches);
    if (!spoils.历练 && !spoils.金钱 && !spoils.物品.length) return;

    const next = applySpoils(state.party, state.inventory, spoils,
                             this.cache.json.get('gamedata'), patches);
    this.registry.set(GAME_STATE_KEY, Object.freeze({
      ...state, party: next.party, inventory: next.inventory,
    }));
    this.spoils = spoils;
    this.upgrades = next.upgrades;
    // 结果页期间顶部队伍条也应显示已经结算的命气和位阶。
    for (const unit of this.allies) {
      const member = next.party.members.find(m => m.code === unit.def.code);
      if (!member) continue;
      unit.stats = { ...unit.stats, ...member };
      unit.state = { ...unit.state, hp: member.命, maxHp: member.命极, qi: member.气, maxQi: member.气极 };
    }
    console.info('战后结算：', spoilsText(spoils, state.catalog));
  }

  /**
   * 底部那行文字提示。
   *
   * ⚠️ **默认不显示**（2026-09-16，用户要求）——「空格→攻击　G→格盘…」
   * 这类调试键位说明**原作画面上没有**，看着脏。按 **`G`** 连同格盘叠层
   * 一起打开，调试时才看得到。
   *
   * 原作用来告诉玩家「谁在做什么」的是**别的东西**（选中敌人时的名牌、
   * 伤害数字），那些属于「目标选取」与「结算表现」，分别在二期下半与三期。
   */
  setPrompt(text) {
    this.promptText = text;
    if (!this.prompt) {
      this.prompt = this.add
        .text(STAGE_WIDTH / 2, STAGE_HEIGHT - 26, '', {
          fontFamily: 'serif',
          fontSize: '17px',
          color: '#e8d9b0',
          backgroundColor: '#000000a0',
          padding: { x: 12, y: 6 },
        })
        .setOrigin(0.5)
        .setDepth(1000)
        .setVisible(Boolean(this.grid));
    }
    this.prompt.setText(text).setVisible(Boolean(this.grid));
  }

  /**
   * 顶部状态条要画的数据。**每帧重算** —— 判据表 E 组：改了状态却不重画，
   * 剧情或战斗扣了血，界面上还是旧数。
   *
   * `gauge`/`phase` 直接取自**战斗时钟**（`systems/battleClock.js`）——
   * 绿=等待 / 蓝=蓄劲 / 紫=回气，紫条的「从右往左」已由 `gaugeOf` 取反。
   */
  /**
   * 顶部状态条里**正在选指令的那一格**的下标（没有就 −1）。
   *
   * 判据：用户 2026-09-19 —— 「当前在为哪个角色选择指令，哪个角色的
   * 人物头像状态栏就下沉」。所以看的是 `this.player`（轮到他、正在等按键），
   * **不是 `this.actor`**（那个在敌方回合里指着敌人）。
   */
  hudActive() {
    if ((this.phase !== PHASE.READY && !this.interruptedChoice) || !this.player) return -1;
    return this.units.filter((u) => u.def.side === 'ally').indexOf(this.player);
  }

  hudUnits() {
    const allies = this.units.filter((u) => u.def.side === 'ally');
    return allies.map((u) => {
      const entry = entryOf(this.clock, u);
      return {
        portraitFrame: partyPortraitFrame(u.stats?.code) ?? 0,
        rank: Number(u.stats?.位阶) || 0,
        hp: { cur: u.state.hp, max: u.state.maxHp },
        mp: { cur: u.state.qi ?? 0, max: u.state.maxQi },
        gauge: gaugeOf(entry),
        // 回气条要知道**释放点**在哪，才能把右边留空（见 `hudLayout.recoverKeepWidth`）
        release: entry?.release ?? 0,
        phase: entry?.phase ?? CLOCK.WAIT,
      };
    });
  }

  update(time, delta) {
    if (this.battleReady === false) return;
    this.enemyInspection?.refresh();
    this.vitalFeedback?.update(delta);
    // 只有主指令闲置继续走表；分类、列表、确认、诸态、目标与动作演出均暂停。
    if (this.clockRunning()) {
      this.fields.tick(delta);
      this.tickSustained(delta);
      for (const unit of this.units) {
        const change = unit.tickStatuses(delta);
        if (change.hp || change.qi) this.showVitalChange(unit, change);
      }
      if (this.wiped(this.foes)) return this.finish(true);
      if (this.wiped(this.allies)) return this.finish(false);
      if (this.phase === PHASE.READY && !this.player?.alive) this.resume();
      if (this.phase === PHASE.READY) this.refreshChoice();
      this.units.forEach(unit => { unit.fieldClockMods = this.fields.clockMods(unit); unit.fieldHolding = this.fields.entries.some(e => e.owner === unit); });
      const got = advanceClock(this.clock, delta);
      this.clock = got.clock;
      // 时钟已经清掉死者的动作；载荷同步清理，不影响其他蓄劲者。
      for (const unit of this.pendingActions.keys()) {
        if (!unit.alive) { this.pendingActions.delete(unit); endSoulOpportunity(unit); }
      }
      // 一帧只处理一个 —— 剩下的停在满格，下一帧接着轮。
      // 正在选指令的角色保留菜单；其他我方绿满排队，敌方与已蓄劲者仍可行动。
      const due = got.ready.find(e => {
        const target = this.pendingActions.get(e.unit)?.targets?.[0];
        if (e.phase === CLOCK.CHARGE && target?.alive && !targetable(target) && target !== e.unit) return false;
        return this.phase !== PHASE.READY || e.phase !== CLOCK.WAIT || e.unit.def.side !== 'ally';
      });
      if (due) this.onDue(due);
    }
    // ⭐ 下沉的那一格是**正在选指令的人**（`hudLayout.boxOrigin` 的 `active`）。
    this.hud?.render(this.hudUnits(), this.hudActive());
    this.menu?.update(delta);
    this.tiles?.update(delta);
    // ⭐ 时轮只在时钟真的在跑的时候转 —— 它就是「时间有没有在流逝」那盏灯。
    this.wheel?.update(this.clockRunning() ? delta : 0);
    this.units.forEach((u) => u.update(time, delta));
    this.persistentEffects?.update(time, delta);
    this.effects = this.effects.filter((f) => f.container?.active !== false);
    this.effects.forEach((f) => f.update(time, delta));
    this.battleCamera?.update(delta);
  }
}

/** 数值表缺条目时的兜底，保证场景仍可运行。 */
function fallbackStats(def) {
  return { name: def.name, 命: 300, 气: 0, 位阶: 5, 膂力: 50, 体魄: 50, 迅捷: 15, 机运: 15 };
}
