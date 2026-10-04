import { playSfx } from './audioSettings.js';
/**
 * 过场演出 —— 把事件脚本吐出来的**表现类**动作真的演出来。
 *
 * 从 `FieldScene` 抽出来的原因很简单：那个文件已经 600 多行，
 * 而演出动作有二十来种，塞进去会顶到八百行上限。
 *
 * ## 分工
 *
 * * **这里**只管画面：人物显隐走位、镜头、屏幕特效、音频、过场动画段。
 * * **`FieldScene.perform`** 管流程（对白、切图）与游戏逻辑
 *   （进战斗、开商店、给物品、扣钱）—— 那些要碰队伍与背包。
 *
 * `perform()` 返回 `true` 表示"这条我接了"，`false` 表示"不归我管"，
 * 调用方据此决定要不要自己处理。
 *
 * ## 演员表（cast）
 *
 * 脚本按**名字**指人：`actor_show{name:"隱形"}`、`play_anim{anim:"動畫第一段"}`。
 * 名字来自 `map.json` 的 `objects[].name`（Big5）。
 *
 * ⚠️ **走位要播行走动画。** 只补间坐标的话人物是「贴着地滑过去」的 ——
 * 脚不动、朝向也不变。原作里士兵上前拦路是走过去的。
 *
 * ⚠️ **脚本引用的名字未必在当前图的 objects 里。** 兰州城脚本提到
 * `大夏侯儀`、`封鈴笙`、`badguy`、`wagan2` 等，其中一部分要么在
 * `placements` 里、要么根本是别的图的。查不到时**建一个不可见的锚点**
 * 而不是跳过 —— 因为 `隱形` 这类事物本来就是拿来给镜头当靶子的，
 * 跳过它镜头就不动，整段演出会停在原地。
 */

import {
  directionFromVector, frameSpan, screenFacing, standFrame, walkLayout, walkSegment,
} from './spriteLayout.js';
import { playBgm, mapBgmKey } from './bgm.js';
import { isOffstagePoint } from './mapLayers.js';

/** 一「刻」多少毫秒。`wait` 与镜头移动的耗时都按它换算。 */
export const TICK_MS = 60;

/** 走一步的耗时（毫秒/像素）。原作没给速度，取的是看起来自然的值。 */
const WALK_MS_PER_PX = 6;
const RUN_MS_PER_PX = 3;

/** `0xFFFFFFFF` 读成有符号就是 −1，语义是「保持原位」。 */
const KEEP = -1;
const keep = (v, fallback) => (v === KEEP || v === undefined || v === null ? fallback : Number(v));

/** 这些动作归本模块。列在这里是为了让分工一眼可见。 */
export const CUTSCENE_ACTIONS = new Set([
  'hero_place', 'hero_move',
  'actor_show', 'actor_hide', 'actor_place', 'actor_face',
  'actor_walk', 'actor_walk_rel', 'actor_to_center',
  'camera_follow', 'camera_hero', 'camera_move',
  'play_anim', 'play_audio',
  'flash', 'screen_shake', 'screen_tint', 'screen_tint_off',
  'fade_out_slow', 'fade_in_slow',
  'show_map_name',
]);

/**
 * 按名字取演员；没有就建一个**不可见锚点**。
 *
 * 锚点没有精灵，只有坐标 —— 镜头跟随、瞬移目标这些都只需要坐标。
 */
/**
 * **主角在剧情里按「当前行走形象的名字」被点到**，那些名字不是别的演员。
 *
 * 形象表是 `Sys.dat` 的 `MAINNPC.SCI`（下标即 `set_avatar` 的代码，
 * 由 `tools/export_party.py` 导成 `avatars.json` 的 `形象名`）：
 *
 *     0 飛龍 | 1 小夏侯儀 | 2 dead | 3 大夏侯儀 | 4 霍雍
 *
 * 进城是 `set_avatar 3`（大夏侯儀），**进大地图是 `set_avatar 1`
 * （小夏侯儀，全库 61 处）**。于是同一个主角，脚本在城里点
 * `大夏侯儀`、在大地图上点 `小夏侯儀`。
 *
 * 判据在数据里：这两个名字**从来没有 `actor_show` / `actor_hide`** ——
 * 一个要显式叫出场的替身不可能这样。`小夏侯儀` 全库 20 处，
 * 全是 `actor_walk` / `actor_place` / `actor_face`。
 *
 * ⚠️ 这里原先只认 `大夏侯儀`，注释还写着「MP3001 回忆场景里的
 * `小夏侯儀` 才是真的另建演员，那个有 show」——**那句是错的，
 * 它一次 show 都没有**。后果：大地图上的**渡口过不去**。
 * 黄河把大地图分成南北两块（原作就这么设计：不能涉水，必须坐船），
 * 渡口那两个隐形触发点问「要從這渡口往南岸去嗎？」，选「是」之后是
 * `actor_place{name:"小夏侯儀"}` 把主角挪到对岸 —— 名字认不出来，
 * 就挪了个空壳，人还在原地。迷宫里的传送多半也是这一套。
 *
 * 当成独立演员的后果（旧例）：废屋结尾第 136 条「走出屋门」推的是一个
 * 坐标停在原点、又被藏起来的空壳，于是主角站着不动，而 `await_actions`
 * 要等那 813 像素的补间走完 —— 就是「封铃笙加入之后卡了好几秒」。
 *
 * ⚠️ **`霍雍` 与 `dead` 不进这张静态表。** 霍雍在剧情里也是个真配角
 * （27 处 `actor_walk`/`place`/`face`），只有 `set_avatar 4` 之后
 * 那几段才是主角。所以除了这两个铁定的名字，还要按**当前形象**动态判 ——
 * 见 `isHero`。
 */
/**
 * `hero_place` 的落点压在障碍上时，最多往外挪多少像素。
 *
 * 判据：河州镇出村那条 `hero_place(2615,1710)` 落在山坡上、离最近的路
 * **21px**；48 够用，又不至于把「站在床边」挪到屋外去。
 * ⚠️ 这个上限是我定的，原作未必有「吸附」这回事，见 `docs/状态/复现度台账.md`。
 */
const PLACE_SNAP_PX = 48;

const HERO_ALIASES = new Set(['大夏侯儀', '小夏侯儀']);

/**
 * 这个名字指的是不是主角本人。
 *
 * 除了 `HERO_ALIASES` 那两个铁定的，还要看**当前的行走形象**：
 * `set_avatar 4` 把主角变成霍雍之后，脚本点 `霍雍` 推的就是主角；
 * 没变身时点 `霍雍` 推的是那个真配角。判据来自 `avatars.json` 的
 * `形象名`（`MAINNPC.SCI` 的原文），不是猜的。
 */
export function isHero(scene, key) {
  if (HERO_ALIASES.has(key)) return true;
  const code = scene?.registry?.get?.('avatarCode');
  if (code === undefined || code === null) return false;
  const names = scene?.cache?.json?.get?.('avatars')?.形象名;
  return names?.[String(code)] === key;
}

/** 主角的演员外壳。坐标读写都落到 `scene.playerPos` 与真的主角精灵上。 */
function heroActor(scene) {
  if (!scene.heroActor) {
    // 朝向直接读写主角的 scene.facing：剧情转身/走位停下的朝向要留在主角身上。
    // 原先只写到这个包装对象上，回到游戏逻辑就丢了——水镜之殿战后 actor_place 不改朝向，
    // 夏侯仪却背对镜头（用户 2026-09-30）。
    scene.heroActor = { name: '大夏侯儀', hero: true, scene };
    Object.defineProperty(scene.heroActor, 'facing', {
      get: () => scene.facing ?? 0,
      set: (value) => { scene.facing = value; },
      enumerable: true,
    });
  }
  const actor = scene.heroActor;
  actor.x = scene.playerPos?.x ?? actor.x ?? 0;
  actor.y = scene.playerPos?.y ?? actor.y ?? 0;
  actor.sprite = scene.player ?? null;
  actor.data = scene.playerData ?? null;
  return actor;
}

function actorOf(scene, name) {
  const key = String(name ?? '');
  if (!key) return null;
  if (isHero(scene, key)) return heroActor(scene);
  scene.cast ??= new Map();
  const hit = scene.cast.get(key);
  if (hit) return hit;
  // ⚠️ **名字要大小写不敏感地比。** 脚本里写的是 `ng0101-02.sf2`（小写后缀），
  // 而对象表里是 `ng0101-02.SF2`（大写）—— 严格相等会失配，
  // `actor_show` 于是静默地作用在一个凭空造出来的锚点上，什么都不显示。
  // 河州镇那四个装布娃娃/金创药的箱子就是这么打不开的。
  const lower = key.toLowerCase();
  const found = (scene.actors ?? []).find((a) => a.name === key)
    ?? (scene.actors ?? []).find((a) => String(a.name).toLowerCase() === lower);
  // 无SCI归属的剧情演员随点名进入当前层；不借用其他楼层的常驻NPC。
  const extra = !found && scene.allActors?.find(a => a.scriptOnly
    && String(a.name).toLowerCase() === lower);
  if (extra && !(scene.actors ?? []).includes(extra)) {
    extra.layer = scene.activeLayer;
    extra.sprite?.setSceneContainer(scene.layerViews?.[scene.activeLayer]?.container);
    scene.actors.push(extra);
  }
  const actor = found || extra || { name: key, x: 0, y: 0, sprite: null, anchor: true };
  scene.cast.set(key, actor);
  return actor;
}

/**
 * 取这个演员的精灵定义（帧布局表），用来算站立帧与行走段。
 *
 * 存在 Phaser 的 json 缓存里，key 是 `<精灵名>-sprite`（见 BootScene）。
 * 锚点没有精灵，返回 null。
 */
function spriteData(scene, actor) {
  if (actor?.data) return actor.data;
  const key = actor?.sprite?.key ?? actor?.spriteKey;
  return key ? (scene.cache?.json?.get?.(`${key}-sprite`) ?? null) : null;
}

/**
 * 让演员摆出该有的姿势。
 *
 * ⚠️ **剧情期间必须显式换帧。** `FieldScene.update` 在对话框挂着时就 return 了，
 * 走不到 `updatePlayerAnimation` —— 只改 `facing` 字段而不换帧，
 * 人物会一直保持上一次的朝向（打完仗转身说话时玩家只看到背影）。
 *
 * 行走图按朝向挑站立帧；其余（单帧 NPC、过场素材）用 SCI 给的起始帧。
 */
function poseActor(scene, actor, facing) {
  if (!actor?.sprite?.hold) return;
  if (facing !== undefined && facing !== null) actor.facing = screenFacing(facing);
  const data = spriteData(scene, actor);
  // ⚠️ **这一条必须排在「行走图按朝向挑站立帧」前面。**
  //
  // `gearanm` 开局旗标是 0（藏着），是剧情 `actor_show GEARANM` 把它放出来的
  // —— 所以循环只能在这里起，光改建场那一处没用。而它有 20 帧，
  // `walkLayout` 会把它**误判成有朝向的行走图**，于是落到 `standFrame` 定格在
  // 帧 1：画面上机关纹丝不动、那声「嘎吱」也不响。
  //
  // 只在「起>止 且 帧数>1」时命中，全库 72 个起>止里只有 17 个，
  // 而那 17 个全是剧情叫出来的演出对象。见 `spriteLayout.frameSpan`。
  const [gFrom, gTo] = (actor.frames ?? []).map(Number);
  const span = gFrom > gTo ? frameSpan(actor.frames) : null;
  if (span && span.count > 1) {
    actor.sprite.playSegment?.(span.start, span.count, { loop: true });
    return;
  }
  const dirs = walkLayout(data ?? {}).directions;
  if (data && dirs > 0) {
    actor.sprite.hold(standFrame(data, actor.facing ?? 0));
    return;
  }
  const start = Number(actor.frames?.[0]);
  if (Number.isFinite(start)) actor.sprite.hold(start);
}

/**
 * 主角因站在画外被藏起后，`actor_place 大夏侯儀` 放回场内要重新现身。
 * 赫蘭鐵罕战前把主角放到(0,0)，战后按(0,0)进图被藏；随后第105条只有
 * actor_place 放回，不经 hero_place —— 不解除就一直隐身。
 * 只处理「因画外而藏」这一种，开场等剧情主动藏起的主角不受影响。
 */
function syncHeroOffstage(scene, x, y) {
  const offstage = isOffstagePoint({ x, y }, scene.mapWidth, scene.mapHeight);
  if (offstage) {
    scene.heroOffstage = true;
    scene.player?.setHidden?.(true);
  } else if (scene.heroOffstage) {
    scene.heroOffstage = false;
    scene.player?.setHidden?.(false);
  }
}

/**
 * 剧情走位的拐点（不含起点）。原作 RPG.exe 0x40a7d0 不查通行、不寻路，
 * 按 actor_walk 第三字段选路线：0＝先横后纵，1＝先纵后横，2＝先斜走到一轴对齐再直走
 * （其他值原作记错误日志后落入斜走分支）。绕开冰池这类障碍靠脚本作者选对模式。
 * 未给模式（actor_walk_rel 尚未核实）保持直线。
 */
export function walkWaypoints(from, to, mode) {
  const end = { x: to.x, y: to.y };
  if (mode === undefined || mode === null) return [end];
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  if (!dx || !dy) return [end];
  if (mode === 0) return [{ x: to.x, y: from.y }, end];
  if (mode === 1) return [{ x: from.x, y: to.y }, end];
  const m = Math.min(Math.abs(dx), Math.abs(dy));
  const corner = { x: from.x + Math.sign(dx) * m, y: from.y + Math.sign(dy) * m };
  return corner.x === to.x && corner.y === to.y ? [end] : [corner, end];
}

/** 把演员挪到某处，精灵与遮挡层一起跟着走。 */
function placeActor(actor, x, y) {
  actor.x = x;
  actor.y = y;
  actor.sprite?.setPosition?.(x, y);
  actor.occluder?.update?.(x, y);
  // 主角外壳：真正的位置在 `scene.playerPos`，遮挡与镜头也是另一套。
  if (actor.hero && actor.scene) {
    actor.scene.playerPos = { x, y };
    syncHeroOffstage(actor.scene, x, y);
    actor.scene.playerOccluder?.update?.(x, y);
    if (!actor.scene.cameraTarget) actor.scene.follow?.setPosition?.(x, y);
  }
}

/**
 * 主角的落点。
 *
 * ⚠️ **不要吸附到最近的可走点。** 剧情常用 `hero_place` 把主角挪到**画外**
 * 让替身演出（废屋那段第 18 条就是 `(800,800)`，地图只有 832×624 高）。
 * 吸附会把他拽回场上 —— 于是画面里出现**两个夏侯仪**：一个是真主角，
 * 一个是剧情演员「大夏侯儀」。
 */
function placeHero(scene, x, y, facing) {
  // ⚠️ **落点可能压在障碍上。** 河州镇出村那条 `hero_place(2615,1710)`
  // 就落在山坡上，离最近的路 21px —— 直接放上去的话玩家**一步都动不了**：
  // `slideAxis` 每一步都问「下一个像素可不可走」，从障碍里出发第一问就是否。
  // 进图那条路（`this.entry`）早就过了 `findOpenSpot`，只有这条漏了。
  // 挪动上限很小（`PLACE_SNAP_PX`），剧情里的精确站位不会被挪跑。
  const asked = { x: Number(x), y: Number(y) };
  const offstage = isOffstagePoint(asked, scene.mapWidth, scene.mapHeight);
  const spot = offstage
    ? asked : (scene.findOpenSpot?.(asked.x, asked.y, PLACE_SNAP_PX) ?? asked);
  if (spot.x !== asked.x || spot.y !== asked.y) {
    console.info(`hero_place (${asked.x},${asked.y}) 压在障碍上，挪到 (${spot.x},${spot.y})`);
  }
  scene.playerPos = { ...spot };
  // ⚠️ **`hero_place` 就是「把主角放到场上」** —— 开场那一段里，人是躺在
  // 床上的（`EVENT-0` 那条 53 帧的过场精灵在演），主角本体要等这条指令
  // 才现身。不放出来的话画面上是**两个夏侯仪**：一个在床上翻身，
  // 一个站在床边看着。见 `FieldScene.playOpening`。
  scene.heroOffstage = offstage;
  scene.player?.setHidden?.(offstage);
  scene.player?.setPosition?.(spot.x, spot.y);
  scene.playerOccluder?.update?.(spot.x, spot.y);
  scene.follow?.setPosition?.(spot.x, spot.y);
  // ⚠️ 指令给的是**原作朝向编号**，要换成屏幕方向序号，见 `screenFacing`。
  if (facing !== undefined && facing !== null) {
    scene.facing = screenFacing(facing);
    // ⚠️ **还要真的换帧。** 剧情演出期间 `FieldScene.update` 走不到
    // `updatePlayerAnimation`（对话框一挂就 return 了），只改 `scene.facing`
    // 不换帧，主角会一直保持进屋时那个朝向 —— 打完仗转过来说话时
    // 玩家看到的是背影，而不是面朝倒地的士兵。
    if (scene.playerData && scene.player?.hold) {
      scene.player.hold(standFrame(scene.playerData, scene.facing));
    }
  }
}

/**
 * 演一条动作。
 *
 * @param {Phaser.Scene} scene 场景（要能拿到 cameras / time / tweens / actors）
 * @param {object} action 事件脚本的一条动作
 * @param {() => void} done 演完之后回调，驱动脚本往下走
 * @returns {boolean} 接了没有
 */
/**
 * 登记一个**要花时间**的动作。
 *
 * 原作模型是「启动就走」：`play_anim` / `actor_walk` 一旦开始，脚本立刻
 * 往下跑，动画与对白并行；要同步时脚本自己会插一条 `await_actions`。
 * 所以这里把"还在跑"记进 `scene.running`，由 `FieldScene` 在
 * `await_actions` 那一刻去等。
 */
function track(scene, start) {
  scene.running ??= new Set();
  const token = {};
  scene.running.add(token);
  start(() => scene.running.delete(token));
}

/**
 * **过场动画通道** —— 一次只演一段，后来的显隐指令排队等。
 *
 * ## 为什么需要它
 *
 * 废屋初遇第 64～66 条是这样的：
 *
 * ```
 * 64  play_anim  動畫第一段 45→88   ← 西夏兵冲进屋，44 帧、合计 14.5 秒
 * 65  actor_show 動畫第二段          ← 第二段的起始帧是「五个人摆好架势」
 * 66  actor_hide 動畫第一段
 * ```
 *
 * 照字面立刻执行，两件事同时坏掉：**第一段刚起手就被藏了**（用户看到的
 * 「小兵进来的动画没了，直接摆好架势砍人」），**第二段的定格画面同时叠上来**
 * （「一下好几个动画一起放，人怎么多了」）。而 `await_actions` 仍在等那
 * 14.5 秒的动画跑完 —— 于是画面停着不动很久，就是「在砍我那儿停顿了很久」。
 *
 * 释义 op1D「等待前述子事件完成」本身就说明子事件是**有生命周期的异步体**；
 * 作用在过场动画素材上的显隐自然排在当前这一段之后。过场动画天然互斥
 * （同一时刻只演一段），所以一条通道就够，不必按演员分别排队。
 *
 * 哪些名字算「过场动画素材」由 `scene.animNames` 给出 —— 那是从本图脚本里
 * 所有 `play_anim` 的目标名收集来的，是数据不是猜测。
 */
function animGate(scene) {
  scene.animGate ??= { busy: false, queue: [] };
  return scene.animGate;
}

/** 这个名字是不是过场动画素材（本图脚本里被 `play_anim` 点过名）。 */
const isAnimCast = (scene, name) => Boolean(scene.animNames?.has(String(name ?? '')));

/** 通道空就直接做，通道忙就排队。 */
function throughGate(scene, name, fn) {
  const gate = animGate(scene);
  if (!gate.busy || !isAnimCast(scene, name)) { fn(); return; }
  gate.queue.push(fn);
}

/**
 * 过场动画还在演吗 —— 给 `FieldScene` 判断对白该不该等。
 *
 * ⚠️ **只挡整屏过场动画，不挡走位。** 两者的原作行为不一样：
 * 走位是并行的（MP0212 槽 16 的两个士兵是同时上前拦路的，脚本自己在
 * 第 19 条插了 `await_actions` 才让他们说话；MP3001 槽 14 有连着 8 条），
 * 而整屏过场动画期间**根本不出对话框** —— 所以原作里演动画时无从跳过。
 */
export const cutsceneBusy = (scene) => Boolean(scene.animGate?.busy);

/** 排一件事在当前这段过场动画之后。通道空就立刻做。 */
export function afterCutscene(scene, fn) {
  const gate = animGate(scene);
  if (!gate.busy) { fn(); return; }
  gate.queue.push(fn);
}

/** 一段动画演完：放行队列里攒下的显隐。 */
function openGate(scene) {
  const gate = animGate(scene);
  gate.busy = false;
  // ⚠️ 先取出再执行 —— 队列里可能又是一条 `play_anim`，它会把通道重新占上。
  for (const fn of gate.queue.splice(0)) fn();
}

export function performCutscene(scene, action, done) {
  const camera = scene.cameras.main;
  const finish = () => done?.();

  switch (action.type) {
    // ── 主角与演员 ──────────────────────────────────────────
    case 'hero_place':
      placeHero(scene, action.x, action.y, action.facing);
      finish();
      return true;

    // 0x66：同 hero_place 但不改朝向（RPG.exe 0x40e320）。
    case 'hero_move':
      placeHero(scene, action.x, action.y);
      finish();
      return true;

    case 'actor_show': {
      const actor = actorOf(scene, action.name);
      if (!actor) { finish(); return true; }
      if (animGate(scene).busy && isAnimCast(scene, action.name)) {
        throughGate(scene, action.name, () => performCutscene(scene, action, null));
        finish();
        return true;
      }
      // ⚠️ 坐标可能是 −1（保持原位）—— 原作用它表示「就在自己该在的地方出现」。
      placeActor(actor, keep(action.x, actor.x), keep(action.y, actor.y));
      // ⚠️ **回到该有的姿势**：行走图按朝向挑站立帧，其余用 SCI 给的起始帧。
      // 不重置的话精灵会停在上一段动画的末帧 —— 废屋那段「士兵刚进门」
      // 的画面就直接跳成了砍完之后的定格。
      poseActor(scene, actor, action.facing);
      actor.sprite?.setHidden?.(false);
      actor.hidden = false;
      finish();
      return true;
    }

    case 'actor_hide': {
      // ⚠️ 排在当前这段动画之后 —— 见 `animGate` 的注释，
      // 立刻执行会把正在演的「西夏兵冲进屋」整段藏掉。
      throughGate(scene, action.name, () => {
        const actor = actorOf(scene, action.name);
        actor?.sprite?.setHidden?.(true);
        if (actor) actor.hidden = true;
      });
      finish();
      return true;
    }

    case 'actor_place': {
      const actor = actorOf(scene, action.name);
      if (actor) {
        placeActor(actor, keep(action.x, actor.x), keep(action.y, actor.y));
        poseActor(scene, actor, action.facing);
      }
      finish();
      return true;
    }

    case 'actor_face':
      poseActor(scene, actorOf(scene, action.name), action.facing);
      finish();
      return true;

    case 'actor_walk':
    case 'actor_walk_rel': {
      const actor = actorOf(scene, action.name);
      if (!actor) { finish(); return true; }
      // 相对坐标以**屏幕中心的控制者**为原点（释义原话），近似取主角。
      const origin = action.type === 'actor_walk_rel'
        ? (scene.playerPos ?? { x: 0, y: 0 })
        : { x: 0, y: 0 };
      const tx = origin.x + keep(action.x ?? action.dx, actor.x);
      const ty = origin.y + keep(action.y ?? action.dy, actor.y);
      const speed = action.run ? RUN_MS_PER_PX : WALK_MS_PER_PX;
      // ⚠️ **朝向按实际走向算，不要直接信指令里的那个值。**
      // 指令给的是**走完之后**的朝向（士兵上前拦路，停下时转过来面对主角），
      // 拿它当走路时的朝向，人就会横着平移。每一段按该段向量取方向，
      // 停下再摆成指令要求的朝向。
      const endDir = action.facing === undefined ? NaN : screenFacing(action.facing);
      const data = spriteData(scene, actor);
      const legs = walkWaypoints({ x: actor.x, y: actor.y }, { x: tx, y: ty },
        action.type === 'actor_walk' ? action.mode : undefined);
      track(scene, (settle) => {
        let lastDir = null;
        const walkLeg = (i) => {
          if (i >= legs.length) {
            // 停下：站定帧，朝向用指令给的那个（没给就保持走向）。
            const face = Number.isFinite(endDir) ? endDir : lastDir;
            actor.facing = face ?? actor.facing;
            if (data && actor.sprite?.hold) actor.sprite.hold(standFrame(data, actor.facing ?? 0));
            settle();
            return;
          }
          const leg = legs[i];
          const dx = leg.x - actor.x;
          const dy = leg.y - actor.y;
          const moveDir = directionFromVector(dx, dy);
          if (data && moveDir !== null && moveDir !== lastDir) {
            const seg = walkSegment(data, moveDir);
            actor.sprite?.playSegment?.(seg.start, seg.count, { loop: true });
          }
          lastDir = moveDir ?? lastDir;
          scene.tweens.add({
            targets: actor,
            x: leg.x,
            y: leg.y,
            duration: Math.max(1, Math.round(Math.hypot(dx, dy) * speed)),
            onUpdate: () => placeActor(actor, actor.x, actor.y),
            onComplete: () => walkLeg(i + 1),
          });
        };
        walkLeg(0);
      });
      finish();
      return true;
    }

    case 'actor_to_center': {
      // ⭐ **瞬移到主角身上，不是瞬移到镜头靶子上。**（2026-09-13 订正）
      //
      // 释义原话是「将操作对象瞬移至**屏幕中心控制者**处」，我们照字面读成了
      // `cameraTarget`。两条判据说明该读成主角：
      //
      // 1. 全库 8 处写的是 `actor_to_center 隱形`，而此刻镜头正绑在 `隱形` 上 ——
      //    照字面理解那是「把它移到它自己」，**纯空操作**。读成「移到主角」
      //    才讲得通：那是「把镜头靶子收回主角身上」。`MP1803-3` 槽 9 更明白：
      //    先 `actor_to_center 隱形`，再让四个队友 to_center。
      // 2. 用户给的原作截图（凉州城那段五人合影）：按脚本的偏移量
      //    （−90 / −45 / 0 / +55 / +100）从主角处散开，左到右正好是截图里
      //    封鈴笙/冰璃/夏侯儀/慕容璇璣/古倫德 的顺序，y 差不超过 35px＝挤在一排。
      //    照 `cameraTarget` 算（`隱形` 在主角下方 132px），主角会孤零零高出一截 ——
      //    正是用户看到的「队友从对面那个 NPC 身上走出来」。
      const actor = actorOf(scene, action.name);
      const target = scene.playerPos;
      if (actor && target) placeActor(actor, target.x, target.y);
      poseActor(scene, actor, action.facing);
      finish();
      return true;
    }

    // ── 镜头 ────────────────────────────────────────────────
    case 'camera_follow': {
      const actor = actorOf(scene, action.name);
      if (actor) {
        scene.cameraTarget = actor;
        scene.follow?.setPosition?.(actor.x, actor.y);
      }
      finish();
      return true;
    }

    case 'camera_hero':
      scene.cameraTarget = null;
      if (scene.playerPos) scene.follow?.setPosition?.(scene.playerPos.x, scene.playerPos.y);
      finish();
      return true;

    /**
     * `camera_move`（op1E「移動螢幕中心」）。
     *
     * ⚠️ **推的是被绑定的那个事物，不是相机跟随点。**
     * 释义在这条底下专门写着「运用 1E 指令前需把屏幕中心点绑定在『隐形』上，
     * 即之前须有 1B 指令」—— 也就是说 1E 移动的正是 1B 绑上去的那个东西。
     *
     * 从前这里补间的是 `scene.follow` 本身，而 `FieldScene.update()` 每帧
     * 都会把 `follow` 拉回 `cameraTarget` 的位置，**补间当场被覆盖，等于没动**。
     * 表现是「镜头钉死在主角进图那一点」：`MP0304` 第 18 条要把镜头推到
     * (1102,1200)，敌人从那边进场，结果主角他们往下走 400+ px 走出画面，
     * 镜头纹丝不动。全库 118 处 `camera_move`、33 张图全中。
     */
    case 'camera_move': {
      // 释义：「Z＝移动所需耗时，**单位不明**（此值越小越快，为 0 时瞬移）」。
      //
      // ⚠️ **一刻就是一刻，不要再乘 4。** 从前写的是 `TICK_MS * 4`，
      // 那个 4 没有任何出处。量纲上一算就知道不对：全库 118 处里
      // `MP0303` 槽 10 第 25 条是 `duration=100`、要推 300px ——
      // 乘 4 之后是 **22 秒**，于是「冰璃现身」那段镜头直到玩家按过五六句
      // 对白才推到位，用户的原话是「移动速度特别慢」「第一张截图时就该
      // 往上移了，却是第二张才移」。**时机与速度是同一个 bug。**
      //
      // 取 `TICK_MS`(60ms) 的判据是量纲合理性：拿同一槽内连续两条
      // `camera_move` 反推「每单位走多少像素」（45 个样本，中位 20px/单位），
      // 三种换算下的中位镜头速度是
      // `16.7ms → 1199px/s`（两帧扫过整屏，太快）、
      // `60ms → 333px/s`（半秒扫过屏宽，合理）、
      // `240ms → 83px/s`（8 秒才扫过一屏，太慢）。
      // 极端样本也只有 60ms 说得通：`MP3001` 槽2 距离 1453/耗时 100 → 6 秒；
      // `MP0607A` 距离 361/耗时 3 → 0.18 秒，正合释义「为 0 时瞬移」的邻域。
      // 仍是**推断**（释义自己写着单位不明），登记在 `docs/状态/复现度台账.md`。
      const ms = Math.max(0, Number(action.duration) || 0) * TICK_MS;
      const target = scene.cameraTarget ?? scene.follow;
      if (!target) { finish(); return true; }
      const to = { x: Number(action.x), y: Number(action.y) };
      if (!ms) {
        if (target.setPosition) target.setPosition(to.x, to.y);
        else Object.assign(target, to);
        scene.follow?.setPosition?.(to.x, to.y);
        finish();
        return true;
      }
      track(scene, (settle) => scene.tweens.add({
        targets: target,
        x: to.x, y: to.y,
        duration: ms, onComplete: settle,
      }));
      finish();
      return true;
    }

    // ── 过场动画段 ──────────────────────────────────────────
    case 'play_anim': {
      // `anim` 是**事物名**（Big5），指向本图 objects 里的一个过场 SF2。
      // 兰州城废屋的初遇就是这么演的：`動畫第一段` 播 2~21 帧、`動畫第二段` 接着播。
      if (animGate(scene).busy && isAnimCast(scene, action.anim)) {
        throughGate(scene, action.anim, () => performCutscene(scene, action, null));
        finish();
        return true;
      }
      const actor = actorOf(scene, action.anim);
      const from = Number(action.from) || 0;
      const to = Number(action.to) || from;
      const count = Math.max(1, to - from + 1);
      if (!actor?.sprite?.playSegment) { finish(); return true; }
      actor.sprite.setHidden?.(false);
      // ⚠️ 回调叫 `onDone` 不是 `onComplete`，而且 `playSegment` 只在
      // **帧数 > 1** 时才真的走时序 —— 单帧（`from === to`，脚本里很常见，
      // 用来定格一个姿势）永远不会回调，必须自己放行，否则剧情卡死在那一帧。
      const single = count <= 1 || action.loop;
      if (single) {
        actor.sprite.playSegment(from, count, { loop: Boolean(action.loop), onDone: null });
      } else {
        animGate(scene).busy = true;
        track(scene, (settle) => actor.sprite.playSegment(from, count, {
          loop: false,
          onDone: () => { settle(); openGate(scene); },
        }));
      }
      finish();
      return true;
    }

    // ── 音频 ────────────────────────────────────────────────
    case 'switch_layer':
      scene.switchLayer(action.layer);
      finish();
      return true;

    case 'play_audio': {
      // kind: 0 音乐(MP3)、1 音效(WAV)。曲目编号 → BootScene 预载的 key。
      //
      // ⚠️ **音乐是「换曲」，音效才是「叠一层」。** 两者都用
      // `scene.sound.play` 的话，废屋初遇切到 bgm5 时城门区的 bgm4
      // 还在底下响 —— 两首一起放，而且之后再也换不回来（registry
      // 根本不知道曲子换过）。音乐一律走 `bgm.js`。
      if (Number(action.kind) === 0) {
        playBgm(scene, mapBgmKey(action.track, scene.flags), undefined, Boolean(action.loop));
        finish();
        return true;
      }
      // ⚠️ **`track=0` 是「停掉循环音效」，不是某条音效。**
      // 判据：`0` 号在 `Music.DAT` 里根本不存在；全库 `kind=1 track=0`
      // 只有 **2 处**，而**每一处前面都有一条循环音效** ——
      // `MP0212` 槽 30 #78 停的是 #53 起的马蹄声（`track=10 loop=1`），
      // `MP1013` 槽 10 #638 停的是 `track=24`。2/2 命中。
      // 没有这一条的表现：下了马车马蹄声还在响。
      if (Number(action.track) === 0) {
        scene.stopLoopSfx?.();
        finish();
        return true;
      }
      const key = `sfx-${action.track}`;
      if (scene.cache.audio.exists(key)) {
        const loop = Boolean(action.loop);
        const sound = playSfx(scene, key, { loop });
        // ⚠️ **循环音效要登记，剧情收场时统一停**（`FieldScene.stopLoopSfx`）。
        // 全库 `kind=1 loop=1` 只有 18 处，马蹄 `track=24` 占 9 处 ——
        // 不停的话下了马车马蹄声还在响，而且切图也带不走。
        // 一次性音效（773 处）自己放完就没了，不登记。
        if (loop) {
          scene.loopSfx = scene.loopSfx ?? [];
          scene.loopSfx.push(sound);
        }
      } else {
        // 兜底跳过要留日志（判据表）：缺一条音效在画面上什么都看不出来。
        console.warn(`play_audio: 音效 ${key} 没预载，这一声不响`);
      }
      finish();
      return true;
    }

    // ── 屏幕特效 ────────────────────────────────────────────
    case 'flash':
      camera.flash(Math.max(80, (Number(action.duration) || 1) * TICK_MS * 2));
      finish();
      return true;

    case 'screen_shake':
      camera.shake(300, 0.008);
      finish();
      return true;

    case 'screen_tint':
    case 'screen_tint_off':
      // 全屏色彩：释义给了透明度与三原色的编码，但兰州城这一段只用到
      // 「盖上/揭掉」两下，颜色细节先不还原。留着入口，别静默吞掉。
      finish();
      return true;

    case 'fade_out_slow':
      camera.once('camerafadeoutcomplete', finish);
      camera.fadeOut(TICK_MS * 20);
      return true;

    case 'fade_in_slow':
      camera.once('camerafadeincomplete', finish);
      camera.fadeIn(TICK_MS * 20);
      return true;

    // ── 尚未表现，但要显式列出来 ────────────────────────────
    case 'show_map_name':
      // 屏幕左上角那个地名。文字在 msg 里，取法见《剧情代码释义.txt》0x35。
      finish();
      return true;

    default:
      return false;
  }
}
