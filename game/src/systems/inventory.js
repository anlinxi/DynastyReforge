/**
 * 背包 —— 队伍持有的物品与装备。
 *
 * ⚠️ **开局内容是占位，不是原作数据。** 原作的开局背包存在存档里。
 * 真实内容定下来之前，**不要拿它做任何数值推断**。
 *
 * 条目结构 `{代码, 数量}`。**代码是主键，不是名称** —— 官方版里
 * 刻盘碎片有七条不同记录、西夏兵有三条，按名称查只看得见第一条。
 * 物品的属性一律回 `catalog` 查，**不在这里冗余**，免得两处不同步。
 */
import { CATEGORIES, createCatalog } from './catalog.js';

export { CATEGORIES };

/**
 * 开局背包的**名称**清单。⚠️ **占位 + 测试用，不是原作内容。**
 *
 * 这里故意写名称而不是代码 —— 夹具要给人读。`createInventory()` 会在
 * 建背包时通过 `catalog.代码()` 换成代码，名字写错会**当场抛错**，
 * 不会静默变成空条目。
 *
 * 配置意图：三个槽位齐全，且每个槽都有「当前角色装得上」与「装不上」两种，
 * 好让换装与「用不了变红」两条链当场试得出来。判红依据是
 * `Ail2.ENC` 的 `炼化类型`（匕首/长剑/长枪/索带/宿玉/法袍/轻甲/重甲/男饰/女饰/通饰）。
 *
 * ⚠️ **不要放已经穿在身上的装备**（护身匕首、布袍是夏侯仪的开局装备）。
 * 背包与装备槽是两个容器，同一件东西只能在一处 —— 否则及身页的候选列表里
 * 会出现「用当前这件替换当前这件」，换了等于没换。
 */
export const START_PACK = Object.freeze([
  // 用器
  { 名称: '金创药', 数量: 3 },
  { 名称: '聚元散', 数量: 2 },
  // 兵刃 —— 按炼化类型分：匕首=夏霍、长剑=冰、索带=封高、长枪=古萧。
  { 名称: '古铜怀刀', 数量: 1 },   // 匕首 —— 只有夏侯仪能用
  { 名称: '长剑', 数量: 1 },       // 长剑 —— 只有冰璃
  { 名称: '青钢剑', 数量: 1 },     // 长剑
  { 名称: '白绢索带', 数量: 1 },   // 索带 —— 只有封铃笙
  { 名称: '铁枪', 数量: 1 },       // 长枪 —— 队里三个人都装不上，应当全红
  // 护甲
  { 名称: '厚织长衣', 数量: 1 },   // 法袍 —— 所有人
  { 名称: '软革里衣', 数量: 1 },   // 轻甲 —— 冰璃可，夏侯仪与封铃笙红
  { 名称: '金缎铁袍', 数量: 1 },   // 法袍
  { 名称: '铜钉皮铠', 数量: 1 },   // 重甲 —— 三人全红（夏侯仪穿不了重甲）
  // 饰物
  { 名称: '辟邪玉佩', 数量: 1 },   // 通饰 —— 所有人
  { 名称: '护命神符', 数量: 1 },   // 通饰
  { 名称: '朱蕊晶花', 数量: 1 },   // 女饰 —— 夏侯仪红
  { 名称: '琅环玉璧', 数量: 1 },   // 男饰 —— 冰璃与封铃笙红
]);

/**
 * 建背包。
 *
 * @param {object} catalog `createCatalog()` 的结果
 * @param {{名称?: string, 代码?: string, 数量?: number}[]} rows
 *        缺省用 `START_PACK`。给 `名称` 会换成代码；给 `代码` 原样用。
 */
export function createInventory(catalog, rows = null) {
  const source = rows ?? START_PACK;
  return Object.freeze(source.map((r) => Object.freeze({
    代码: r.代码 ?? catalog.代码(r.名称),
    数量: r.数量 ?? 1,
    ...(r.暂置 ? { 暂置: true } : {}),
  })));
}

/** 背包里属于某分类的条目。「暂置」由条目自己带，不由物品决定。 */
export function itemsInCategory(inventory, category, catalog) {
  if (category === '暂置') return inventory.filter((row) => row.暂置);
  return inventory.filter((row) => !row.暂置 && catalog.分类(row.代码) === category);
}

/**
 * 及身页某个槽的候选列表：**背包里该槽的装备**。
 *
 * ⚠️ 当前**已装备**的那件不在背包里（穿在身上），原作列表里也看不到它 ——
 * 及身页截图印证了这点：夏侯仪装着凛日神刀，列表里没有凛日神刀。
 */
export function equipCandidates(inventory, slot, catalog) {
  return inventory.filter((row) => catalog.槽位(row.代码) === slot);
}

/**
 * **分发**：把「暂置」里的东西归入各自的分类。
 *
 * 原作逻辑 —— 捡到的东西先堆在暂置格，玩家点一下「分发」才会按类型
 * 归到用器/兵刃/护甲/饰物/杂类里。所以「暂置」不是物品的属性，
 * 而是**背包条目自己的状态**，分发就是把这个状态摘掉。
 *
 * ⚠️ **要合并同码条目。** 暂置里有 6 个金创药、用器格里已经有 50 个时，
 * 分发后应当是一条 56 个，不是两条。不合并的话列表里会出现两行金创药，
 * 而且换装/消耗那些按代码查的逻辑只会认到第一条。
 *
 * @returns {object[]} 新的背包（不改原数组）
 */
export function dispatchHeld(inventory) {
  const merged = [];
  const at = new Map();
  for (const row of inventory ?? []) {
    const index = at.get(row.代码);
    if (index === undefined) {
      at.set(row.代码, merged.length);
      const { 暂置: _held, ...rest } = row;
      merged.push({ ...rest });
    } else {
      merged[index].数量 = (merged[index].数量 ?? 1) + (row.数量 ?? 1);
    }
  }
  return Object.freeze(merged.map((r) => Object.freeze(r)));
}

/** 背包里还有没有待分发的东西。按钮该不该有反应看它。 */
export const hasHeld = (inventory) => (inventory ?? []).some((r) => r.暂置);

/** 建目录的快捷方式，给场景启动时用。 */
export { createCatalog };
