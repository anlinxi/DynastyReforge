import { soulProgress } from './soulStones.js';
/**
 * 存档槽位：**IndexedDB 为主 + 导出/导入 `.TSF`**（用户拍板）。
 *
 * ## 存的是什么
 *
 * **完整的 `.TSF` 字节**，不是我们自己的 JSON。这样：
 *
 * * 导出 = 把字节丢给下载，拿去原作能接着玩
 * * 导入 = 把字节喂进来，原作的存档我们能读
 * * 没有第二种格式，也就没有两种格式之间的转换损耗
 *
 * 一个存档 67721 字节，99 个槽约 6.6 MB —— IndexedDB 装得下
 * （`localStorage` 上限约 5 MB，而且只能存字符串，所以不能用它）。
 *
 * ## 分两层
 *
 * | 层 | 干什么 | 能不能在 node 里测 |
 * |---|---|---|
 * | `captureSave` / `applySave` | 运行时状态 ↔ `.TSF` 字节 | **能**，纯函数 |
 * | 存储后端 | IndexedDB / 本地文件夹 / 下载上传 | 不能，要浏览器 |
 *
 * 纯的那一层是全部逻辑所在，回归都压在它上面。
 */

import { readSave, readHeader, writeSave, HERO_CODE } from './tsf.js';
import { activeStore } from './saveStore.js';
import { rankFromExp } from './formulas.js';
import { slotsOf } from './formation.js';

/** 存档位数。⚠️ **原作的真实数目未经证实**，见 `docs/状态/复现度台账.md` §八。 */
export const SLOT_COUNT = 99;

/** 天书页一屏几条。素材 `MEN8001` 的布局定的。 */
export const ROWS_PER_PAGE = 4;

// ————————————————————————————————————————————————————————————
// 运行时状态 ↔ 字节（纯函数，回归都在这一层）
// ————————————————————————————————————————————————————————————

/**
 * 把当前游戏状态写成 `.TSF` 字节。
 *
 * ⚠️ **一定要给 `base`（底档字节）。** 存档有一半的字节我们还没搞懂
 * （追加区 36936 字节、`+24072` 那 12 字节…），凭空构造是在赌。
 * 由gameSave提供本局读入的原始字节；覆盖另一槽也不能借用那一槽的旧进度。
 *
 * @param {object} state
 * @param {Uint8Array} state.base 底档字节
 * @param {object} state.party `partyState` 的队伍
 * @param {readonly object[]} state.inventory 背包（扁平）
 * @param {object} state.catalog 用来判分类
 * @param {object} state.gamedata 用来算位阶
 * @param {object} state.flags `FlagStore.snapshot()`
 * @param {string} state.mapId 当前图号
 * @param {string} state.mapName 地名（`assets/data/mapnames.json`）
 * @param {{x:number,y:number,朝向:number}} state.position 主角位置
 * @param {Date} [state.now] 存档时间，缺省取当前时刻
 * @returns {Uint8Array}
 */
export function captureSave({
  base, party, inventory, catalog, gamedata, flags,
  mapId, mapName, position, now = new Date(), layout, packGroup, avatarCode,
}) {
  if (!base?.length) throw new Error('captureSave: 缺底档字节');
  const rank = rankOf(party, gamedata);
  return writeSave(base, {
    // 存档名就是**地名** —— 天书页记录条上「地點/」那一格印的就是它。
    // 取不到地名的图有 12 张（多是没有独立名字的内室），退回图号，
    // 总比留空强：留空的话读档界面上那一条看起来像坏了。
    存档名: mapName || mapId,
    等级: rank,
    年: now.getFullYear(), 月: now.getMonth() + 1, 日: now.getDate(),
    时: now.getHours(), 分: now.getMinutes(),
    金钱: party?.金钱 ?? 0,
    背包: groupPack(inventory, catalog, layout),
    // ⚠️ **把「当前用哪一套背包」原样带回去。**
    // 不带的话 `writeSave` 会沿用底档的下标；而底档在「新游戏模板」那条路上
    // 是 `NewGame.TSF`（下标 0）—— 于是读了 `Save009`（霍雍那段，下标 1）
    // 再存档，会把霍雍那套空包写进**主队那一格**，主队 59 件东西当场全没。
    ...(Number.isInteger(packGroup) ? { 当前背包: packGroup } : {}),
    角色: charactersOf(party, gamedata, layout.角色.条数),
    当前地图: mapId,
    ...(Number.isInteger(avatarCode) ? { 行走形象: avatarCode } : {}),
    位置: position,
    剧情旗标: flags,
    // 队伍区：**谁在队**与**各站哪一格**。天书页的头像画的就是这一段。
    队伍: (party?.members ?? []).map((m) => m.code),
    阵型: slotsOf(party),
  }, layout);
}

/**
 * 天书页那条记录上「等級/」印的数 —— **是主角夏侯仪的位阶，不是队首的**。
 *
 * 判据：22 个官方存档里头部等级与**角色 1 的位阶**逐个吻合，无一例外。
 * 而 `Save009`/`Save010`（思謁之間、樓蘭城）那两段队伍里只有霍雍、
 * 他的位阶是模板值 60，头部照样写 **24** —— 队首说了不算。
 *
 * ⚠️ 主角不在队时（就是霍雍那两段）**返回 undefined**，让 `writeSave`
 * 跳过这一项、保留底档原值。拿霍雍的 60 去写会把存档列表上的等级写成 60。
 */
function rankOf(party, gamedata) {
  const hero = (party?.members ?? []).find((m) => m?.code === HERO_CODE);
  if (!hero) {
    console.warn('存档：队伍里没有夏侯仪，头部「等級」保留底档原值');
    return undefined;
  }
  return hero.位阶 ?? rankFromExp(hero.已有历练 ?? 0, gamedata?.历练门槛);
}

// ⚠️ **位阶现算，不从 `memberView` 拿** —— 存档要的是原始状态，
// 而 `memberView` 还掺着换装预览、加点预览这些界面态。
// `rankFromExp` 的正本在 `formulas.js`，这里只是调用。

/** 扁平背包 → 存档的六格。分类靠 `catalog`，「暂置」由条目自己带。 */
function groupPack(inventory, catalog, layout) {
  const grouped = Object.fromEntries(layout.背包.分类.map((name) => [name, []]));
  for (const row of inventory ?? []) {
    const name = row.暂置 ? '暂置' : catalog.分类(row.代码);
    // 认不出的分类归「杂类」，并留一行 —— 静默丢掉的话存档里会少东西。
    const bucket = grouped[name] ?? grouped.杂类;
    if (!grouped[name]) console.warn(`存档：分类「${name}」不在存档布局里，${row.代码} 归杂类`);
    bucket.push({ 代码: row.代码, 数量: row.数量 ?? 1 });
  }
  return grouped;
}

/**
 * 队伍 → 存档的角色区。**只写原始状态**，抗性那些派生值不碰。
 *
 * ⚠️ **「曾入队」只清不置。** 那一列（`+156`，0 = 加入过）在原作里
 * **只增不减** —— `Save004` 封铃笙不在队伍里，她那一格仍是 0。
 * 从前这里给「不在队的人」写 1，那是把原作的名册抹掉：临时离队一次
 * （剧情里常有）就等于「从没来过」。现在只把在队的人置 0，其余不动。
 */
function charactersOf(party, gamedata, slots = 9) {
  const out = {};
  const active = new Set((party?.members ?? []).map((m) => m.code));
  for (const m of [...Object.values(party?.reserve ?? {}), ...(party?.members ?? [])]) {
    if (!m?.code) continue;
    out[String(m.code)] = {
      角色代码: m.code,
      曾入队: active.has(m.code) ? 0 : (m.曾入队 ?? 0),
      // ⚠️ **写成员自己的位阶**，别拿历练重算 —— 读进来是 21 就该存回 21。
      // 重算的话，读一个修改器改过的档再存回去，就把错的写死了。
      位阶: m.位阶 ?? rankFromExp(m.已有历练 ?? 0, gamedata?.历练门槛),
      已有历练: m.已有历练 ?? 0,
      命极: m.命极, 命: m.命, 气极: m.气极, 气: m.气,
      膂力: m.膂力, 体魄: m.体魄, 灵力: m.灵力, 迅捷: m.迅捷, 机运: m.机运,
      剩余五内: m.剩余五内 ?? 0,
      迅: m.迅, 烈: m.烈, 神: m.神, 魔: m.魔, 魂: m.魂,
      装备: { ...m.装备 },
      绝学: [...(m.绝学 ?? [])],
      ...soulProgress(m),
    };
  }
  return out;
}

/** 字节 → 读档要用的那一份。就是 `tsf.readSave`，这里只是给个对称的名字。 */
export function applySave(bytes, layout) {
  return readSave(bytes, layout);
}

/** 一条记录在天书页上要显示的东西。空槽返回 null。 */
export function slotSummary(record, layout) {
  if (!record?.bytes) return null;
  const bytes = record.bytes instanceof Uint8Array
    ? record.bytes : new Uint8Array(record.bytes);
  try {
    return { slot: record.slot, ...readHeader(bytes, layout) };
  } catch (err) {
    // ⚠️ 坏档不能让整页崩掉 —— 那会让人以为所有存档都没了。
    console.warn(`存档槽 ${record.slot} 读不出来：`, err?.message ?? err);
    return null;
  }
}

// ————————————————————————————————————————————————————————————
// 存档后端访问（浏览器选择与下载见 platform/browserFiles.js）
// ————————————————————————————————————————————————————————————


/**
 * 全部已占用的槽位，按槽号升序。
 *
 * ⚠️ **后端可能不带 `bytes`**（文件夹后端列目录时不读文件内容），
 * 调用方要看摘要就自己 `loadSlot(slot)`。
 */
export async function loadAllSlots() {
  const store = activeStore();
  let rows;
  try {
    rows = await store.list();
  } catch (err) {
    console.warn('读存档列表失败：', err?.message ?? err);
    return [];
  }
  // ⚠️ **文件夹后端列目录时不读文件内容**（99 个文件逐个读太慢）。
  // 而天书页要拿字节算摘要（地名/等级/日期），所以这里补读。
  // 读一个 67KB 的文件很快，且只在打开天书页时发生。
  const out = [];
  for (const row of rows) {
    if (row.bytes?.length) { out.push(row); continue; }
    try {
      const bytes = await store.read(row.slot);
      if (bytes?.length) out.push({ ...row, bytes });
    } catch (err) {
      console.warn(`读存档槽 ${row.slot} 的内容失败：`, err?.message ?? err);
    }
  }
  return out;
}

/** 读一个槽的字节。没有就返回 null。 */
export function loadSlot(slot) {
  return activeStore().read(Number(slot)).catch((err) => {
    console.warn(`读存档槽 ${slot} 失败：`, err?.message ?? err);
    return null;
  });
}

/**
 * 写一个槽。
 *
 * ⚠️ **存的是纯 `.TSF` 字节，不带任何额外字段** —— 互通范围见存档判据，不能据格式相同推断全状态兼容。
 *
 * 曾经这里有个 `extra` 参数存 `scriptSource`（「没有事件表的图向谁借脚本」），
 * **2026-09-11 删了**：14 张没有 `.EVE` 的图里 13 张压根不需要脚本，
 * 唯一需要的 `MP2503A` 静态表已经覆盖。见 `docs/判据/存档格式.md`。
 *
 * 存到哪由后端决定（浏览器 / 本地文件夹），见 `systems/saveStore.js`。
 */
export function saveSlot(slot, bytes) {
  const n = Number(slot);
  if (!Number.isInteger(n) || n < 0 || n >= SLOT_COUNT) {
    return Promise.reject(new Error(`存档槽 ${slot} 越界（0~${SLOT_COUNT - 1}）`));
  }
  return activeStore().write(n, bytes);
}

/** 删一个槽。 */
export function deleteSlot(slot) {
  return activeStore().remove(Number(slot));
}
