import { FIELD_MAPS } from '../config.js';
import { applySaveBytes, resetRunRegistry, templateBytes } from './gameSave.js';

/**
 * 开局进哪张图与哪份状态。
 *
 * ⚠️ **原作的起点是 `MP0102B`（夏侯仪房间），不是兰州城。**
 * 判据：`NewGame.TSF` 的存档名是「夏侯儀房間」、地图串是 `MP0102B`、
 * 坐标 (549, 353) 朝向 0 —— 全部从那份档里读出来，不是我们定的。
 * 所以开局不写死图号，而是**读 `NewGame.TSF`**，与读任何一个存档同一条路径。
 *
 * `FIELD_MAPS[0]`（兰州城城门）保留成兜底：`NewGame.TSF` 拉不到时用它，
 * 免得连游戏都进不去。
 */
const FALLBACK_START_MAP = FIELD_MAPS[0];

/**
 * 新游戏：清掉上一局的跨场景残留，读 `NewGame.TSF` 得到队伍、背包、旗标、地图、落点。
 *
 * **走的就是读档那条路**，开新游戏与读存档因此是同一条代码路径，
 * 不会出现「新游戏对了、读档错了」这种分叉。读不出来就退回兰州城城门，
 * **不要让游戏进不去**。
 *
 * 清哪些键、为什么，见 `systems/gameSave.js` 的 `resetRunRegistry`。
 *
 * @returns {{mapId:string, entry?:object, opening?:boolean}} 直接转给 `FieldScene`
 */
export function newGameEntry(scene) {
  resetRunRegistry(scene);
  // 上一局读档留下的「事件表来源」不能跟着进来。
  // ⚠️ **只能清在这里，不能放进 `resetRunRegistry`** —— 标题页读档是
  // 「先 `applySaveBytes` 再写 hint」，清在那边会把刚写下的值抹掉。
  // 见 `systems/saveslot.js` 的 `saveSlot`。
  scene.registry.set('scriptSourceHint', null);
  try {
    const { mapId, entry, save } = applySaveBytes(scene, templateBytes(scene));
    if (!mapId) throw new Error('NewGame.TSF 里没有地图串');
    console.info(`新游戏：「${save.存档名}」${mapId} `
      + `(${entry.x}, ${entry.y}) 朝向 ${entry.facing}`);
    // ⚠️ **只有新游戏才演开场**，读档进来的不演。
    return { mapId, entry, opening: true };
  } catch (err) {
    console.warn('读 NewGame.TSF 失败，退回兰州城城门开局：', err?.message ?? err);
    return { mapId: FALLBACK_START_MAP };
  }
}
