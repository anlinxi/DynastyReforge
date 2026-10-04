/**
 * 全局游戏状态 —— 队伍与背包。
 *
 * ## 为什么必须有这一层
 *
 * 在此之前，**队伍挂在 `FieldScene` 上、背包挂在 `MenuScreen` 上**，
 * 而 `goto_map` 是走 `scene.restart()` 的 —— 于是**每换一张地图，
 * 两样东西全部重建**。在药铺买了羊皮卷轴，走出门就没了。
 *
 * 剧情里的 `item_gain` / `money_lose` / `party_join` 这些动作要真的生效，
 * 状态就得活得比场景久。Phaser 的 `registry` 挂在 Game 上而不是 Scene 上，
 * 正好用来放它。
 *
 * ## 不可变
 *
 * 整份状态是冻的，任何改动都返回**新的一份**再存回 registry。
 * 这样「上一帧的引用悄悄变了值」这类 bug 不会发生，也方便将来做存档快照。
 *
 * ## ⚠️ 这里不放派生值
 *
 * 命极/气极这类**换装时一次性写入**的量存在成员身上（见 `partyState`），
 * 而攻击力/防御力/抗性一律现算（`formulas.js`）。存进来就会有两个来源。
 */
import { createParty } from './partyState.js';
import { createCatalog, createInventory } from './inventory.js';
import { inventoryFromSave, partyFromSave } from './savefile.js';

/** 挂在 Phaser registry 上的键。 */
export const STATE_KEY = 'gameState';

/**
 * registry 上记「当前用哪一套背包」的键（0 主队 / 1 霍雍那段）。
 *
 * 存档里有**两套**背包+金钱，读进来的是哪一套，存回去就得是哪一套 ——
 * 详见 `systems/tsf.js` 的 `activePack`。**只有这一份正本**：
 * `gameSave.js` 与这里都用它，不要再写一个字符串。
 */
export const PACK_GROUP_KEY = 'packGroup';

/**
 * 取全局状态；第一次调用时按存档或默认值建起来。
 *
 * @param {Phaser.Scene} scene
 * @param {object} gamedata
 * @param {object|null} save `assets/data/saves/*.json`，没有就走默认开局
 */
export function gameState(scene, gamedata, save = null, tables = null) {
  const has = scene.registry.get(STATE_KEY);
  if (has) return has;

  // ⚠️ **`createCatalog` 要的是 `{equipment, items, skills}` 三张表，不是 `gamedata`。**
  // 这里原先传的是 `gamedata` —— 那份 JSON 里根本没有这三个键，于是目录是空的，
  // 读档时 61 件物品**全部**被判成「代码不在目录里」跳过，registry 上的背包
  // 一直是空数组。表现是**法宝页与及身页永远没有东西**，而且不报错
  // （`inventoryFromSave` 只 `console.warn` 一行，混在一堆载入日志里看不见）。
  //
  // ⚠️ 空数组是 truthy —— `MenuScreen` 那句 `shared?.inventory ?? …` 的兜底
  // 因此永远不触发，它自己那份正确的目录反而用不上。
  // 2026-09-05 修。
  const catalog = createCatalog(tables ?? gamedata);
  let party;
  let inventory;
  // 读档失败不能让场景开不起来 —— 退回默认，并在控制台说清为什么。
  try {
    party = save ? partyFromSave(save, gamedata) : createParty(gamedata);
    inventory = save ? inventoryFromSave(save, catalog) : createInventory(catalog);
    // 测试存档（`saves/test.json`）也可能来自霍雍那段 —— 把它那一套带上，
    // 否则从它开局存档会写到主队那一格。
    scene.registry.set(PACK_GROUP_KEY, save?.当前背包 ?? 0);
    // 行走形象也一样：测试存档若来自霍雍那段，地图上就该是霍雍。
    if (Number.isInteger(save?.行走形象)) scene.registry.set('avatarCode', save.行走形象);
    if (save) console.info(`从存档「${save.存档名 ?? '?'}」开局，${party.members.length} 人`);
  } catch (err) {
    console.warn('读档失败，退回默认开局：', err.message);
    party = createParty(gamedata);
    inventory = createInventory(catalog);
  }
  const state = Object.freeze({ party, inventory, catalog });
  scene.registry.set(STATE_KEY, state);
  return state;
}

/**
 * 改状态：给一份补丁，存回 registry，返回新的整份。
 *
 * ⚠️ **一定要走这里**，不要直接改 `state.party`／`state.inventory` ——
 * 那样菜单与场景会各拿各的引用，改了一处另一处看不见。
 */
export function updateState(scene, patch) {
  const next = Object.freeze({ ...(scene.registry.get(STATE_KEY) ?? {}), ...patch });
  scene.registry.set(STATE_KEY, next);
  return next;
}

/** 丢掉全局状态（读档、重开新游戏时用）。 */
export function resetState(scene) {
  scene.registry.set(STATE_KEY, null);
}
