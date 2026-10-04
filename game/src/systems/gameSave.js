/**
 * 运行时的存档 / 读档编排：**把跑着的游戏状态与 `.TSF` 字节接起来**。
 *
 * 分工：
 *
 * | 模块 | 管什么 |
 * |---|---|
 * | `tsf.js` | 字节 ↔ 结构 |
 * | `saveslot.js` | 槽位、IndexedDB、导出/导入 |
 * | **这里** | 从 `registry` 取状态、写回 `registry`、告诉场景该去哪张图 |
 *
 * 单独成一个模块是因为 `FieldScene` 已经 1200 多行 —— 存读档整块塞进去
 * 会让它更难看，而这一块与场景的耦合其实只有「主角在哪」和「切图」两点。
 */

import { STATE_KEY, PACK_GROUP_KEY, resetState } from './gameState.js';
import { captureSave } from './saveslot.js';
import { partyFromSave, inventoryFromSave } from './savefile.js';
import { readSave } from './tsf.js';
import { createCatalog } from './inventory.js';
import { screenFacing } from './spriteLayout.js';
import { FlagStore } from './eventScript.js';

/** Phaser 缓存里的键。**底档模板**与**偏移表**都在 `BootScene` 里排队。 */
export const LAYOUT_KEY = 'tsfLayout';
export const TEMPLATE_KEY = 'tsfTemplate';
/** 本局最近读入的完整字节；未知区与非当前背包不能借用目标槽。 */
export const SAVE_BASE_KEY = 'currentSaveBase';
export const MAPNAMES_KEY = 'mapNames';
/**
 * 全局的**人物代码 → 姓名**表（`assets/data/speakers.json`）。
 *
 * ⚠️ 人名本来就与地图无关，从前却按图存在 `map.json` 的 `names` 里，
 * 而且**只在导出时给了 `--sys` 才写** —— 317 张图里只有 21 张带，
 * 其余的对白全都没有姓名牌（遇冰璃那一整段就是这么变成「有立绘没名字」的）。
 * 见 `tools/export_speakers.py` 的文件头。
 */
export const SPEAKERS_KEY = 'speakers';
/**
 * **没有 `.EVE` 的过场图 → 事件表向哪张图借**（`assets/data/script_sources.json`）。
 *
 * 判据见 `tools/export_script_sources.py`：拿「这张图的对象用到哪些槽」
 * 去候选来源里筛，`MP2503A` 用槽 11，三个候选中只有 `MP3001` 有。
 * ⚠️ **这一层是给读档用的** —— 运行时的 `pendingScript.map` 在读档时是空的。
 */
export const SCRIPT_SOURCES_KEY = 'scriptSources';

/** 图号 → 地名。取不到返回 null，由 `captureSave` 退回图号。 */
export function mapNameOf(scene, mapId) {
  const table = scene.cache.json.get(MAPNAMES_KEY)?.地名;
  return table?.[String(mapId).toUpperCase()] ?? null;
}

/**
 * 把当前局面写成 `.TSF` 字节。
 *
 * @param {Phaser.Scene} scene
 * @param {object} where `{mapId, x, y, facing}` —— `facing` 是**屏幕方向**，
 *   这里换算回原作编号再存（`screenFacing` 是对合函数，两边都用它）
 * 保存基底来自当前局。只有尚未读入任何存档的开发入口才退回新游戏模板。
 */
export function buildSaveBytes(scene, where) {
  const layout = scene.cache.json.get(LAYOUT_KEY);
  if (!layout) throw new Error('tsf_layout.json 没加载，存档做不了');
  const template = scene.registry.get(SAVE_BASE_KEY) ?? templateBytes(scene);
  const state = scene.registry.get(STATE_KEY);
  if (!state?.party) throw new Error('还没有队伍，存档做不了');
  return captureSave({
    base: template,
    party: state.party,
    inventory: state.inventory ?? [],
    catalog: state.catalog ?? createCatalog({}),
    gamedata: scene.cache.json.get('gamedata') ?? {},
    flags: scene.registry.get('flags')?.snapshot() ?? {},
    // 读档时记下来的「当前用哪一套背包」（霍雍那段是第 1 套）。
    packGroup: scene.registry.get(PACK_GROUP_KEY),
    avatarCode: scene.registry.get('avatarCode'),
    mapId: where.mapId,
    mapName: mapNameOf(scene, where.mapId),
    position: {
      x: Math.round(where.x),
      y: Math.round(where.y),
      朝向: screenFacing(where.facing ?? 0),
    },
    layout,
  });
}

/** 底档模板（`NewGame.TSF`）。**必须有** —— 凭空构造存档是在赌。 */
export function templateBytes(scene) {
  const raw = scene.cache.binary.get(TEMPLATE_KEY);
  if (!raw) throw new Error('NewGame.TSF 没加载，存档做不了');
  return new Uint8Array(raw);
}

/**
 * 开新一局（含读档）要清掉的**跨场景残留**。
 *
 * ⚠️ `avatarSprite`/`avatarCode` 是 `set_avatar` 写在 registry 上的，
 * 本来就该跨切图保持（进大地图换小形象、回城换回大形象）。可是
 * **读档相当于重开一局**，上一局留下的形象会跟着进来 ——
 * 表现就是「读档之后人物变小了」（上一局最后停在大地图，
 * `avatarCode` 还是 1＝小夏侯儀）。形象由 `FieldScene` 按存档所在的图重定。
 *
 * ⚠️ **必须放在 `applySaveBytes` 里**，不能只在某一条读档路径上清。
 * 读档有两条路：标题页的「前歷再續」走 `BootScene`，游戏里天书页读档走
 * `FieldScene.enterSave` —— 从前只有前者清了，于是**第二次读档人又变小**。
 * 放在这里就是「凡是装存档字节，一律清」，以后新增读档入口也不会漏。
 */
export function resetRunRegistry(scene) {
  for (const key of ['avatarSprite', 'avatarCode', 'pendingScript', 'lastScripts', SAVE_BASE_KEY]) {
    scene.registry.set(key, null);
  }
}

/**
 * 读档：把字节变成新的全局状态，返回该去哪张图、落在哪。
 *
 * ⚠️ **先 `resetState` 再重建。** `gameState()` 见到 registry 上已有状态
 * 就直接返回旧的 —— 不清掉的话读档会「什么都没变」，而且不报错。
 *
 * @returns {{mapId:string, entry:{x:number,y:number,facing:number}}}
 */
export function applySaveBytes(scene, bytes) {
  const layout = scene.cache.json.get(LAYOUT_KEY);
  if (!layout) throw new Error('tsf_layout.json 没加载，读档做不了');
  const save = readSave(bytes, layout);
  const gamedata = scene.cache.json.get('gamedata') ?? {};
  const catalog = createCatalog({
    equipment: scene.cache.json.get('equipment-full') ?? [],
    items: scene.cache.json.get('items-full') ?? [],
    skills: scene.cache.json.get('skills-full') ?? [],
  });
  const party = partyFromSave(save, gamedata);
  const inventory = inventoryFromSave(save, catalog);

  resetState(scene);
  resetRunRegistry(scene);
  scene.registry.set(SAVE_BASE_KEY, new Uint8Array(bytes));
  scene.registry.set(STATE_KEY, Object.freeze({ party, inventory, catalog }));
  // ⭐ 存档有**两套**背包+金钱，第 1 套是霍雍那段用的（见 `systems/tsf.js`
  // 的 `activePack`）。记住读进来的是哪一套，存档时原样写回去。
  scene.registry.set(PACK_GROUP_KEY, save.当前背包 ?? 0);
  // ⭐ **恢复行走形象**（存档 `@57583`）。`resetRunRegistry` 刚把它清掉了 ——
  // 那是为了不让上一局的形象带进来，但存档里本来就写着该用哪个，要补回去。
  // 不补的后果：读霍雍那段的存档（`Save009`，形象码 4），地图上走的还是夏侯仪。
  // ⚠️ 只记**代码**，精灵键交给 `FieldScene.avatarKey` 按 `avatars.json` 查 ——
  // 那张表是正本，这里再查一遍就是抄第二份。
  if (Number.isInteger(save.行走形象)) scene.registry.set('avatarCode', save.行走形象);
  // ⚠️ 旗标要**整份换掉**，不是合并 —— 合并会把这一局已经推过的进度
  // 留在读回来的档上（存档点之后又走了一段，读档后那段还算数）。
  // ⚠️ 也**不能置 null**：`FieldScene` 见到 null 会退回测试存档 `test.json`
  // 的初值重建，于是读档读出来的是**别的档**的剧情进度。
  scene.registry.set('flags', new FlagStore(save.剧情旗标));
  return {
    save,
    mapId: save.当前地图,
    entry: {
      x: save.位置.x,
      y: save.位置.y,
      // 存的是原作编号，进场景要屏幕方向 —— 同一个对合函数换回去。
      facing: save.位置.朝向,
      // 官方客房在旗标998保存返回事件号；不是地图坐标能表达的室内状态。
      resumeEvent: scene.registry.get('flags').get(998),
    },
  };
}
