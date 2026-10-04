/**
 * 装备系统。数据来自 `Ail2.ENC`，由 `tools/export_gamedata.py` 导出。
 *
 * 全部函数为纯函数，不修改传入对象。
 *
 * ⚠️ **2026-08-30 改过数据形态。** 原先 `可装备者` 是配套 txt 里的单字缩写串
 * （「夏霍」= 夏侯仪、霍雍），那份 txt 只有 300块 有，官方版根本不存在。
 * 现在它是**角色全名数组**，由 `Ail2.ENC` 的 `炼化类型`（单字节 +882：
 * 匕首/长剑/长枪/索带/宿玉/法袍/轻甲/重甲/男饰/女饰/通饰）映射而来 ——
 * 这才是原作「夏侯仪不能用长枪」那条限制的真身。映射表在
 * `export_gamedata.py` 的 `EQUIP_BY_REFINE`，也随 gamedata 发到前端。
 *
 * ⚠️ **兵刃准，护甲饰物是近似。** 原作那边逐件不同（光法袍就有六种组合），
 * 真值是 `Ail2.ENC` 里尚未标定的 `可装备者` 字段。现在按类型取并集，
 * 宁可放宽也不误判红。详见 `docs/专题/官方版对照.md` §5.1。
 */

/** 参与战斗计算的补正字段。 */
export const BONUS_FIELDS = Object.freeze([
  '攻击补正', '防御补正', '命中补正', '闪避补正',
  '法力补正', '必杀补正', '命极补正', '气极补正',
]);

/**
 * 该角色能否装备此物品。
 *
 * `可装备者` 是角色全名数组；**空缺（null / 缺字段）表示不限制** ——
 * 法袍与通饰就是这样，还有全部非装备条目。
 *
 * ⚠️ **等级门槛故意不判** —— 那是 300块 补丁加的，官方版没有。
 *
 * @param {object} item 装备数据
 * @param {string} characterName 角色名
 */
export function canEquip(item, characterName) {
  const rule = item?.可装备者;
  if (!Array.isArray(rule)) return true;     // null / undefined = 所有人
  return rule.includes(characterName);
}

/**
 * 汇总多件装备的补正。
 * @param {object[]} items
 * @returns {Record<string, number>}
 */
export function sumBonuses(items) {
  return items.reduce((acc, item) => {
    BONUS_FIELDS.forEach((field) => {
      const value = Number(item?.[field]);
      if (Number.isFinite(value) && value !== 0) {
        acc[field] = (acc[field] ?? 0) + value;
      }
    });
    return acc;
  }, {});
}

/**
 * 按名称取出角色可用的装备清单，过滤掉不匹配的条目。
 * @param {Record<string, object>} catalogue 全部装备
 * @param {string[]} names 要装备的名称
 * @param {string} characterName
 * @returns {{equipped: object[], rejected: string[]}}
 */
export function resolveLoadout(catalogue, names, characterName) {
  const equipped = [];
  const rejected = [];

  (names ?? []).forEach((name) => {
    const item = catalogue?.[name];
    if (!item) {
      rejected.push(`${name}（无此装备）`);
      return;
    }
    if (!canEquip(item, characterName)) {
      rejected.push(`${name}（${characterName}不可装备）`);
      return;
    }
    equipped.push({ name, ...item });
  });

  return { equipped, rejected };
}

/** 战斗使用当前代码槽位，不再次执行换装限制（敌方也有专用装备）。 */
export function battleLoadout(stats, rows) {
  if (!stats?.装备 || !Array.isArray(rows)) return null;
  const normal = (v) => String(v ?? '').replace(/^0x/i, '').replace(/^0+/, '').toUpperCase();
  return ['兵刃', '护甲', '饰物'].map((slot) => {
    const code = stats.装备[slot] ?? (slot === '护甲' ? stats.装备.甲衣 : null);
    return rows.find((r) => normal(r.物品编号) === normal(code));
  }).filter(Boolean);
}
