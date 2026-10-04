/**
 * 商店：买价、卖价、库存、成交。**纯函数，不碰界面。**
 *
 * ── 规则从哪来 ──
 * 除「卖价」外全部来自原作数据，逐条见 `docs/专题/菜单.md`：
 *
 * * `商店种类` —— exe 规格区原话「只影响进入购物介面后左上角所显示的文字」
 * * `商品售价` —— exe 原话「**如为零**，则商品按照物品资料中的默认售价销售」
 * * `单次可购买数` —— exe 原话「最多９９件，**如为零，也指９９件**」
 *
 * ⚠️ **货物随剧情变不在这个模块里。** 那是剧情脚本自己的分支：
 * 武具店那一槽是 `branch 旗标1>46 → open_shop 45`、`>39 → 33`、`>28 → 21`、
 * 否则 `open_shop 1`。执行器早就支持，这里只管「给定商店编号，卖什么」。
 */

import { normCode } from './catalog.js';

/** 单次可购买数的上限。exe：「最多９９件，如为零，也指９９件」。 */
export const MAX_PER_VISIT = 99;

/**
 * 卖价 = 默认售价 × 这个比例。
 *
 * 🅓 **推断，用户 2026-09-04 拍板用 1/2。** 数据里没有卖价字段
 * （exe 规格区通篇没有「卖」相关字段）。判据是配套资料《用器资料》的
 * 【卖价】栏：73/74 条精确等于 `默认售价 ÷ 2`。
 *
 * ⚠️ 那份资料是 300MOD 的，而 MOD 说明写着「回收价调为售价的四分之一」，
 * 与资料自己列的数据矛盾。已核对 MOD 与官方的默认售价完全相同（6/6 比值
 * 1.00），逐条实测值比一句说明更可信。见 `docs/状态/复现度台账.md`。
 */
export const SELL_RATIO = 0.5;

/**
 * ⚠️ **卖价按「物品表默认售价」算，不按「店家售价」。**
 *
 * 店家可以自己定价（420 件商品里有 8 件与默认价不同），若按店家价折半，
 * 大补丸在沙漠商队买价 3000、卖回 1500，来回刷差价。按默认售价 400 的
 * 一半是 200，没这个洞。
 *
 * 🅓 这条是从刷钱漏洞反推的，**资料没有明说**。
 */
export function sellPrice(record) {
  const base = Number(record?.商店售价);
  if (!Number.isFinite(base) || base < 0) return null;   // 非卖品，见 sellable
  return Math.floor(base * SELL_RATIO);
}

/**
 * 这件东西能不能卖。
 *
 * **判据是默认售价为 `-1`** —— 配套资料里标「非卖品」的 18 条，
 * 在物品表里的默认售价**全部是 -1**（全表 141 条里有 68 个）。
 */
export function sellable(record) {
  return Number.isFinite(Number(record?.商店售价)) && Number(record.商店售价) >= 0;
}

/**
 * 一家店的货架。
 *
 * @param {object} gamedata `assets/data/gamedata.json`
 * @param {number} shopId 剧情指令 `open_shop` 给的编号
 * @param {object} catalog `createCatalog()` 的结果，用来跨物品/装备两张表查
 * @returns {{代码: string, 售价: number, 限购: number, 记录: object}[]}
 */
export function shopStock(gamedata, shopId, catalog) {
  const shop = (gamedata?.商店售货 ?? []).find((s) => s.编号 === Number(shopId));
  if (!shop) {
    console.warn(`商店 ${shopId} 不在 gamedata.商店售货 里，货架按空处理`);
    return [];
  }
  return (shop.商品 ?? []).map((c) => {
    // ⚠️ **脚本给的是十进制，两张表的编号是十六进制字符串。**
    // 这是项目里的老坑（CLAUDE.md 判据表），不转就查不到名字。
    const 代码 = normCode(Number(c.物品代码).toString(16));
    const 记录 = catalog?.物品?.(代码) ?? null;
    // exe：售价为零则按物品资料中的默认售价销售
    const 表价 = Number(记录?.商店售价);
    const 售价 = Number(c.售价) || (Number.isFinite(表价) && 表价 > 0 ? 表价 : 0);
    // exe：最多 99 件，如为零，也指 99 件
    const 限购 = Number(c.单次可购买数) || MAX_PER_VISIT;
    if (!记录) console.warn(`商店 ${shopId} 的商品 0x${代码} 在物品/装备表里查不到`);
    return { 代码, 售价, 限购: Math.min(限购, MAX_PER_VISIT), 记录 };
  });
}

/** 招牌帧号。`商店种类` 只决定左上角那块牌子的字，不影响别的。 */
export function signFrame(gamedata, shopId, spec) {
  const shop = (gamedata?.商店售货 ?? []).find((s) => s.编号 === Number(shopId));
  const map = spec?.sign?.frames ?? {};
  return map[String(shop?.商店种类)] ?? map['3'] ?? 3;
}

/** 一次能买几件：受限购、钱包、以及（买）背包无上限共同约束。 */
export function affordable(money, unitPrice, limit) {
  if (!(unitPrice > 0)) return Math.max(0, limit ?? 0);
  return Math.max(0, Math.min(limit ?? MAX_PER_VISIT, Math.floor(money / unitPrice)));
}

/**
 * 买。钱不够或数量非法时**原样返回**，`ok:false`。
 *
 * ⚠️ **买来的东西不进「暂置」。** 暂置是「捡到的东西先堆着等分发」那套
 * （见 `inventory.dispatchHeld`）；花钱买的是玩家自己挑的，直接归类。
 * 🅓 这一条没有原作依据 —— 见 `docs/状态/复现度台账.md`。
 */
export function buy(party, inventory, { 代码, 售价 }, count) {
  const n = Math.floor(Number(count));
  const cost = 售价 * n;
  if (!(n > 0) || !(cost >= 0) || (party?.金钱 ?? 0) < cost) {
    return { party, inventory, ok: false };
  }
  return {
    party: Object.freeze({ ...party, 金钱: party.金钱 - cost }),
    inventory: addItem(inventory, 代码, n),
    ok: true,
  };
}

/**
 * 卖。数量超过持有量、或该物品不可卖时**原样返回**。
 *
 * @param {object} record 物品/装备表里的那条，卖价按它的默认售价算
 */
export function sell(party, inventory, 代码, record, count) {
  const n = Math.floor(Number(count));
  const price = sellPrice(record);
  const have = countOf(inventory, 代码);
  if (!(n > 0) || n > have || price === null || !sellable(record)) {
    return { party, inventory, ok: false };
  }
  return {
    party: Object.freeze({ ...party, 金钱: (party?.金钱 ?? 0) + price * n }),
    inventory: removeItem(inventory, 代码, n),
    ok: true,
  };
}

/** 背包里某个代码有几件。**「暂置」的也算** —— 那也是玩家的东西。 */
export function countOf(inventory, 代码) {
  const key = normCode(代码);
  return (inventory ?? [])
    .filter((r) => normCode(r.代码) === key)
    .reduce((sum, r) => sum + (Number(r.数量) || 0), 0);
}

/** 加进背包。已有同码的（且不是暂置）就并进去，否则新起一行。 */
function addItem(inventory, 代码, count) {
  const key = normCode(代码);
  const at = (inventory ?? []).findIndex((r) => normCode(r.代码) === key && !r.暂置);
  if (at < 0) {
    return Object.freeze([...(inventory ?? []),
                          Object.freeze({ 代码: key, 数量: count })]);
  }
  return Object.freeze(inventory.map((r, i) => (
    i === at ? Object.freeze({ ...r, 数量: (Number(r.数量) || 0) + count }) : r
  )));
}

/** 从背包扣。扣到 0 就把那一行删掉。先扣非暂置的，不够再扣暂置的。 */
function removeItem(inventory, 代码, count) {
  const key = normCode(代码);
  let left = count;
  const out = [];
  // 先扣非暂置的，不够再动暂置里的 —— 暂置是「捡到还没分发」的，动它最后
  const order = [
    ...(inventory ?? []).map((r, i) => ({ r, i })).filter(({ r }) => !r.暂置),
    ...(inventory ?? []).map((r, i) => ({ r, i })).filter(({ r }) => r.暂置),
  ];
  const take = new Map();
  for (const { r, i } of order) {
    if (left <= 0 || normCode(r.代码) !== key) continue;
    const n = Math.min(left, Number(r.数量) || 0);
    take.set(i, n);
    left -= n;
  }
  (inventory ?? []).forEach((r, i) => {
    const n = take.get(i) ?? 0;
    const rest = (Number(r.数量) || 0) - n;
    if (n && rest <= 0) return;              // 扣光了，这一行不要了
    out.push(n ? Object.freeze({ ...r, 数量: rest }) : r);
  });
  return Object.freeze(out);
}
