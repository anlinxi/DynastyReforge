import { uiAsset } from './language.js';
/**
 * 按需加载 —— **「这张图要哪些资源」只在这里说一次**。
 *
 * ## 为什么要有它
 *
 * 原先 `BootScene.preload()` 把 `FIELD_MAPS` 里每一张图的地面、掩码、精灵，
 * 加上全部菜单素材、两份字库、全部 BGM、全部战斗特效**一次排队**。
 * 实测九张图（占全部 309 张的 3%）就要 8528 个请求 / 115 MB / 11.8 秒。
 * 309 张图不可能这么干。见 `docs/归档/方案-按需加载与图集.md`。
 *
 * ## 分四级
 *
 * | 级 | 内容 | 时机 |
 * |---|---|---|
 * | **L0** | 当前语言的字库、菜单壳、对话框 ui、`data/*.json` | `BootScene` |
 * | **L1** | 一张地图：地面、掩码、`map.json`、该图的精灵图集、该图的 BGM | 进图前 |
 * | **L2** | 物品插图、立绘 | 首次需要；战斗物品插图在入场准备 |
 * | **L3** | 战斗素材（`ATT/STN/HIT/EFF/FLR…`） | 第一次进战斗 |
 *
 * ## 用法
 *
 * ```js
 * await ensureMap(scene, 'MP0201A');   // 拉完才 resolve；已经在缓存里就立刻 resolve
 * ```
 *
 * ⚠️ **Phaser 的 loader 是场景级的、而且一次只能跑一轮**。同一帧里并发调用
 * 会互相打断，所以这里用一条 Promise 链串起来（`queue`），谁先谁后不重要，
 * 重要的是不重入。
 */

import { BGM_FILES, PORTRAIT_INDEX_KEY, SHARED_EVENT_MAP } from '../config.js';
import { SCRIPT_SOURCES_KEY } from './gameSave.js';
import { warnOnce } from './warnOnce.js';
import { forgetCollision, hasCollision } from './pixelMask.js';
import { resolveBgmTrack } from './bgm.js';
import { hdGroundEntry, portraitUrl } from '../hd/hdAssets.js';

/** 已经载好的地图。⚠️ 挂在 registry 上，跨 `scene.restart` 保持。 */
const LOADED_KEY = 'loadedMaps';
/** 加载队列，保证不重入。 */
let queue = Promise.resolve();

/** 掩码 URL 的版本查询串。没有 `rev` 的老产物照旧不带。 */
const rev = (meta) => (meta?.rev ? `?v=${meta.rev}` : '');

/** 这张图要哪些资源。**唯一的一份清单**，卸载时也照它删。 */
export function mapAssets(scene, mapId) {
  const meta = scene.cache.json.get(`${mapId}-map`);
  return {
    json: [[`${mapId}-map`, `assets/maps/${mapId}/map.json`]],
    images: [
      // ⚠️ **地面美术也是可选的。** `MP0000` 是纯共享事件归档（开场剧情
      // 就在里面），没有 `.JPG`、没有 MB/MK —— 无条件拉会在控制台留一条
      // "Failed to process file"，而且它根本不是用来"进"的图。
      ...(meta?.ground ? [[`${mapId}-ground`, `assets/maps/${mapId}/${meta.ground}`]] : []),
      // 高清（默认开，?hd=0 关）：另载一张高清底图用于显示；原图仍载，遮挡层靠它与掩码对齐
      ...(meta?.ground && hdGroundEntry(scene, mapId) ? [hdGroundEntry(scene, mapId)] : []),
      // ⚠️ 掩码是**可选的**：`MP3001` 没有 MK 层、`MP0205` 连 MB 层都没有。
      // 无条件拉会在控制台留一条 "Failed to process file"。
      // ⚠️ **掩码的 URL 要带 `rev`。** 它们是 `public/` 下的静态资源，
      // 重导之后路径不变、内容变了，浏览器照旧走缓存 —— 表现是
      // 「明明重导了，游戏里还是走不动」。`rev` 是掩码内容的短哈希，
      // 由 `tools/export_map.py` 写进 `map.json`。
      // 分层地图只读各层自己的通行图（FieldScene.loadMasks 的 prefix），整图那张从来用不到，不载
      // （大地图 MP3001 这张就有 24 MB）
      ...(meta?.collision && !meta?.layers?.length
        ? [[`${mapId}-collision`, `assets/maps/${mapId}/${meta.collision}${rev(meta)}`]] : []),
      ...(meta?.occlusion
        ? [[`${mapId}-occlusion`, `assets/maps/${mapId}/${meta.occlusion}${rev(meta)}`]] : []),
      ...(meta?.layers ?? []).flatMap(layer => ['collision', 'occlusion', 'ground']
        .filter(kind => layer[kind]).map(kind => [
          `${mapId}-layer-${layer.index}-${kind}`,
          `assets/maps/${mapId}/${layer[kind]}?v=${layer[kind + 'Rev'] ?? meta.rev ?? ''}`,
        ])),
    ],
    sprites: meta?.sprites ?? [],
    // **本图的曲子 + 本图剧情会切的曲子**。
    //
    // ⚠️ 只排 `meta.bgm` 是不够的：`play_audio kind=0` 全库 201 处，
    // 切的多半不是本图那首（废屋初遇切 5、河州镇出村切 12）。
    // 曲子不在缓存里时 `playBgm` 会**原样返回、不换曲**，
    // 表现就是「从兰州城到废屋到出来，全程一首曲子」——
    // 文件早就导出来了，只是没人加载。
    bgm: bgmTracks(scene, meta, mapId),
    // **这张图的脚本会用到哪几个立绘。** 与 `bgm` 同构 —— 都是
    // 「扫一遍本图脚本，把它会点名的东西排进来」。
    portraits: portraitCodes(scene, meta),
  };
}

/**
 * 这张图要哪几个立绘：扫本图脚本里所有 `say` 的 `speaker`。
 *
 * ⚠️ **要过 `index.json`。** 55 个代码里有一批是空壳（原作对话就不显示
 * 立绘），脚本照样会写那个 speaker；不过滤的话每句话都去拉一个不存在的
 * 文件，控制台被 404 淹掉，真正的缺图反而看不见。
 * 索引由 `tools/export_portrait.py --all` 产出。
 */
function portraitCodes(scene, meta) {
  const index = scene.cache.json.get(PORTRAIT_INDEX_KEY);
  if (!index) return [];
  const want = new Set();
  for (const acts of Object.values(meta?.scripts ?? {})) {
    for (const a of acts) {
      if (a?.type !== 'say') continue;
      const code = Number(a.speaker);
      if (Number.isFinite(code) && index[String(code)]) want.add(code);
    }
  }
  return [...want];
}

/**
 * 这张图要哪几首曲子：地图自己的 + 它的脚本会切的 + **共享事件归档的**。
 *
 * ⚠️ **`MP0000` 那一份不能漏。** 它是全局脚本库，**任何一张图上都可能跑到**：
 * 槽 9 是败阵（`play_audio track=31` 然后放「敗降」），槽 8 是开场。
 * 只扫本图的话，在迦夏之窟被机关打死时控制台只留一行
 * 「要放的曲子 bgm-31 不在缓存里 —— 不换曲」，**影片照放、曲子是上一首**。
 *
 * 判据仍然是**拿数据反查**，不是手写清单 —— `MP0000` 由 `BootScene` 预载进缓存，
 * 这里照样扫它的 `scripts`。
 */
function bgmTracks(scene, meta, mapId = null) {
  const want = new Set();
  const flags = scene?.registry?.get('flags');
  if (meta?.bgm) want.add(resolveBgmTrack(meta.bgm, flags));
  const json = scene?.cache?.json;
  const shared = json?.get(`${SHARED_EVENT_MAP}-map`);
  // ⚠️ **借来的脚本也要扫。** 9 张图自己没有事件表，向别的图借
  // （`script_sources.json`，见 `FieldScene.borrowedSource`）。
  // 借来的脚本里的 `play_audio kind=0` 属于**那张图**的 meta，本图没有。
  const from = mapId ? json?.get(SCRIPT_SOURCES_KEY)?.来源?.[mapId] : null;
  const borrowed = from ? json?.get(`${from}-map`) : null;
  for (const src of [meta, shared, borrowed]) {
    for (const acts of Object.values(src?.scripts ?? {})) {
      for (const a of acts) {
        if (a?.type === 'play_audio' && Number(a.kind) === 0 && a.track) want.add(resolveBgmTrack(a.track, flags));
      }
    }
  }
  return [...want].filter(track => track > 0);
}

/** 已载入的地图集合（registry 上的正本）。 */
function loadedSet(scene) {
  let set = scene.registry.get(LOADED_KEY);
  if (!set) {
    set = new Set();
    scene.registry.set(LOADED_KEY, set);
  }
  return set;
}

/** 把一批加载任务跑完。空任务直接 resolve，**不要空跑 loader**。 */
export function runLoader(scene, queueUp, onProgress = null) {
  return new Promise((resolve, reject) => {
    let queued = 0;
    const add = () => { queued += 1; };
    try {
      queueUp(add);
    } catch (err) {
      reject(err);
      return;
    }
    if (!queued) { onProgress?.(1); resolve(0); return; }
    const tick = (v) => onProgress?.(v);
    scene.load.on('progress', tick);
    scene.load.once('complete', () => { scene.load.off('progress', tick); onProgress?.(1); resolve(queued); });
    // ⚠️ **单个文件失败不能让整批卡住。** 缺一张贴图是「那个东西不显示」，
    // 而 reject 会让整张地图进不去。留日志，继续。
    scene.load.once('loaderror', (file) => console.warn(`加载失败：${file?.key} ${file?.url}`));
    scene.load.start();
  });
}

/**
 * 确保一张地图的资源都在。已经在就立刻返回。
 *
 * @returns {Promise<number>} 这次实际排队的文件数（0 = 全在缓存里）
 */
export function ensureMap(scene, mapId, onProgress = null) {
    // 串到队列上：Phaser 的 loader 不能重入。
  queue = queue.then(() => loadMap(scene, mapId, onProgress)).catch((err) => {
    console.warn(`加载地图 ${mapId} 失败：`, err?.message ?? err);
    return 0;
  });
  return queue;
}

/**
 * 把地图以外的一段加载（如进游戏时的战斗基础素材，见 `battleBasics.js`）排进同一条队列。
 * 失败只留日志、照常 resolve：缺素材由用到它的地方兜底，不能让加载页卡住。
 */
export function enqueueLoad(label, task) {
  queue = queue.then(task).catch((err) => {
    console.warn(`加载${label}失败：`, err?.message ?? err);
    return 0;
  });
  return queue;
}

/**
 * 进图前一次拉齐：这张图，外加它借事件表的那张图（`script_sources.json`，
 * 见 `FieldScene.borrowedSource`）。少了后者，`FieldScene.create` 进场发现缺它，
 * 会再显示一次「载入中」拉完重启 —— 读档到过场图时就是两遍加载。
 */
export async function ensureMapWithSource(scene, mapId, onProgress = null) {
  const from = scene.cache.json.get(SCRIPT_SOURCES_KEY)?.来源?.[mapId];
  const both = Boolean(from) && !scene.cache.json.exists(`${from}-map`);
  await ensureMap(scene, mapId, band(onProgress, 0, both ? 0.9 : 1));
  if (both) await ensureMap(scene, from, band(onProgress, 0.9, 1));
}

/**
 * 把一段 0→1 的进度映射到总进度的 [from, to] 区间。
 *
 * 一张图要分三轮载（清单 → 地面/碰撞/人物清单 → 人物图集），Phaser 的进度每轮从 0 重算，
 * 直接显示就是「100% 之后又从 0% 开始」。按各轮大致耗时分段，合成一个只增不减的百分比：
 * 第二轮有整张地面图要解码，最费时。
 */
export function band(onProgress, from, to) {
  return onProgress ? (v) => onProgress(from + (to - from) * v) : null;
}

/** 三轮各占总进度的区间，见 `band`。 */
const MAP_ROUNDS = [[0, 0.05], [0.05, 0.6], [0.6, 1]];

async function loadMap(scene, mapId, onProgress = null) {
  const loaded = loadedSet(scene);
  if (loaded.has(mapId)) {
    // 同图读另一进度时，美术可复用，音乐变量却可能变了，须重新核对依赖。
    return runLoader(scene, add => {
      for (const track of mapAssets(scene, mapId).bgm) queueBgm(scene, track, add);
    }, onProgress);
  }

  // **两轮**：先把 map.json 拿到手，才知道要哪些精灵、哪首曲子。
  await runLoader(scene, (add) => {
    if (!scene.cache.json.exists(`${mapId}-map`)) {
      scene.load.json(`${mapId}-map`, `assets/maps/${mapId}/map.json`);
      add();
    }
  }, band(onProgress, ...MAP_ROUNDS[0]));
  if (!scene.cache.json.exists(`${mapId}-map`)) {
    throw new Error(`${mapId} 的 map.json 拉不到（这张图还没导出？）`);
  }

  const want = mapAssets(scene, mapId);
  const n = await runLoader(scene, (add) => {
    for (const [key, url] of want.images) {
      // 通行图读成掩码后贴图已释放，掩码还在就不再载（pixelMask.takeCollision）
      if (scene.textures.exists(key) || hasCollision(key)) continue;
      scene.load.image(key, url);
      add();
    }
    for (const key of want.sprites) {
      if (scene.cache.json.exists(`${key}-sprite`)) continue;
      scene.load.json(`${key}-sprite`, `assets/sprites/${key}/sprite.json`);
      add();
    }
    for (const track of want.bgm) queueBgm(scene, track, add);
    for (const code of want.portraits) {
      if (scene.cache.json.exists(`portrait-${code}`)) continue;
      scene.load.json(`portrait-${code}`, `assets/portraits/${code}/portrait.json`);
      add();
    }
  }, band(onProgress, ...MAP_ROUNDS[1]));

  // 精灵清单落地后才知道图集叫什么 —— 第三轮。
  const n2 = await runLoader(scene, (add) => {
    for (const key of want.sprites) queueSprite(scene, key, add);
    // 立绘的帧图 —— 要等上一轮的 `portrait.json` 落地才知道有哪些帧。
    for (const code of want.portraits) queuePortraitFrames(scene, code, add);
  }, band(onProgress, ...MAP_ROUNDS[2]));

  loaded.add(mapId);
  return n + n2;
}

/**
 * 排一条精灵的贴图。
 *
 * ⚠️ **三代产物都要认**：图集（现在）、逐层 PNG、每帧一张（最早）。
 * 只认最新的会让没重导的图整个画不出来，而且不报错。
 */
export function queueSprite(scene, key, add = () => {}) {
  const sprite = scene.cache.json.get(`${key}-sprite`);
  if (!sprite) return;
  // **内嵌音效**（`sprite.json` 的 `sounds`，帧上用 `snd` 指过来）。
  // 全库 4102 个场景精灵里 265 个有，废屋那段法术就是其一。
  // 键名与 `FieldSprite.playFrameSound` 一致。
  for (const snd of sprite.sounds ?? []) {
    const k = `${key}-snd${snd.index}`;
    if (scene.cache.audio.exists(k)) continue;
    scene.load.audio(k, `assets/sprites/${key}/${snd.file}`);
    add();
  }
  if (sprite.atlas) {
    if (scene.textures.exists(key)) return;
    scene.load.multiatlas(key, `assets/sprites/${key}/${sprite.atlas.json}`,
                          `assets/sprites/${key}`);
    add();
    return;
  }
  if (Array.isArray(sprite.images)) {
    sprite.images.forEach((img) => {
      const k = `${key}-i${img.index}`;
      if (scene.textures.exists(k)) return;
      scene.load.image(k, `assets/sprites/${key}/${img.file}`);
      add();
    });
    return;
  }
  (sprite.frames ?? []).forEach((f, i) => {
    const k = `${key}-f${i}`;
    if (!f.file || scene.textures.exists(k)) return;
    scene.load.image(k, `assets/sprites/${key}/${f.file}`);
    add();
  });
}

/**
 * 排一个立绘的帧图。键名与 `DialogueBox.placePortrait` 一致
 * （`portrait-<代码>-p<帧号>`）。
 *
 * 空帧是常态（角色表情数不足 16 种），`portrait.json` 里记的是 null。
 */
function queuePortraitFrames(scene, code, add) {
  const data = scene.cache.json.get(`portrait-${code}`);
  if (!data) return;
  (data.frames ?? []).forEach((frame, index) => {
    const key = `portrait-${code}-p${index}`;
    if (!frame || scene.textures.exists(key)) return;
    scene.load.image(key, portraitUrl(scene, key, code, frame.file));
    add();
  });
}

/** 排一首 BGM。键名与 `systems/bgm.js` 的 `mapBgmKey` 一致。 */
function queueBgm(scene, track, add) {
  const file = BGM_FILES[track];
  const key = `bgm-${track}`;
  // ⚠️ **别静默跳过。** 这里曾是「全程一首曲子」的第一现场：`BGM_FILES`
  // 少了四首（8/12/21/23），排不进来、`playBgm` 又原样返回不换曲，
  // 于是从兰州城到废屋到出来一路没换过音乐，**控制台一声不吭**。
  // 调用者须先解析音乐变量；此处只接收实际曲号。
  if (!file) {
    warnOnce(`bgm-file:${track}`,
      `曲目号 ${track} 在 BGM_FILES 里没有条目 —— 这张图不会有自己的音乐`
      + `（会保持上一首）。要么是曲子没导出，要么这个号的含义还没解出来。`);
    return;
  }
  // 背景音乐改为边读边播（见 bgm.js），不再预先载入解码；这里只核对曲号有文件。
  void key; void add;
}

/**
 * **L2：物品插图**（`MEN4010`~`MEN4014`，336 张、4.5 MB）。
 *
 * 菜单法宝页、商店按需加载；战斗通过queueArtwork在preload阶段准备，
 * 避免首次选物品时发起请求。已缓存时不会重复排队。
 *
 * ⚠️ 拉完要 `render()` 一次：调用方多半正卡在「已经画完了但插图是空的」那一帧。
 */
export function ensureArtwork(scene, onReady) {
  const spec = scene.cache.json.get('menus');
  const cfg = spec?.artwork;
  if (!cfg) return false;
  const missing = cfg.tables.filter((a) => !scene.textures.exists(`menu-${a}`));
  if (!missing.length) return false;
  if (artworkLoading) return true;               // 已经在拉了，别重复排队
  artworkLoading = true;
  runLoader(scene, (add) => queueArtwork(scene, add))
    .then(() => { artworkLoading = false; onReady?.(); })
    .catch(() => { artworkLoading = false; });
  return true;                                   // 「这一帧还画不出来」
}
let artworkLoading = false;

/** 共用插图排队；不启动Loader，供战斗preload与平时按需加载共用。 */
export function queueArtwork(scene, add = () => {}) {
  const spec = scene.cache.json.get('menus');
  const assets = spec?.artwork?.tables ?? [];
  for (const asset of assets) {
    if (scene.textures.exists(`menu-${asset}`)) continue;
    const meta = spec.assets?.[asset];
    if (!meta) continue;
    scene.load.spritesheet(`menu-${asset}`, uiAsset(`assets/menus/${meta.sheet}`),
      { frameWidth: meta.cell[0], frameHeight: meta.cell[1] });
    add();
  }
  return assets.map((asset) => `menu-${asset}`);
}

/**
 * 卸掉不再需要的地图。**保留当前图与上一张图** ——
 * 进店出店是最常见的回头路，卸了马上又要拉回来。
 *
 * ⚠️ **精灵几乎不共享**：实测九张图用到 141 个精灵，被 2 张以上图共用的
 * **只有 3 个**。所以可以整批卸，不必做引用计数。那 3 个即使误卸，
 * 下次进图会重新拉，只是多一次请求。
 */
export function unloadExcept(scene, keep) {
  const loaded = loadedSet(scene);
  const keepSet = new Set(keep.filter(Boolean));
  const alive = new Set();
  for (const id of keepSet) {
    for (const key of mapAssets(scene, id).sprites) alive.add(key);
  }
  let freed = 0;
  for (const id of [...loaded]) {
    if (keepSet.has(id)) continue;
    const want = mapAssets(scene, id);
    for (const [key] of want.images) {
      forgetCollision(key);
      if (scene.textures.exists(key)) { scene.textures.remove(key); freed += 1; }
      // 分层背景抠过透明的画布贴图（layerGround.colorKeyedTexture）随原图一起卸
      if (scene.textures.exists(`${key}-keyed`)) { scene.textures.remove(`${key}-keyed`); freed += 1; }
    }
    for (const key of want.sprites) {
      // 还被保留的图用着就别删
      if (alive.has(key)) continue;
      if (scene.textures.exists(key)) { scene.textures.remove(key); freed += 1; }
    }
    loaded.delete(id);
  }
  return freed;
}
