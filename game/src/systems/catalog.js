/**
 * 物品与绝学的总目录 —— **全局唯一的「代码 ↔ 简体名 ↔ 繁体名」映射处**。
 *
 * 除了这里，代码里任何地方都不该再写 `rows.find(r => r.名称 === '金创药')`。
 *
 * ## 为什么主键是代码不是名称
 *
 * **名称会重。** 官方版实测：装备 44 条重名（西夏兵×3、藍衣鐵衛×4）、
 * 用器 14 条（**刻盤碎片×7**、黑石球×3）、绝学繁体名 37 条
 * （紫琰飛煌 冰璃与葛云衣各一门，数值不同）。
 * 拿名称当主键时 `find` 只会命中第一条 —— 七片刻盘碎片在数据里是七条不同记录，
 * 而代码里永远只看得见一片。这不是「将来可能出问题」，是**当下就在丢数据**。
 *
 * 代码则天然唯一：物品用 `Ail2.ENC` 的记录下标（`物品编号`），
 * 官方绝学用 `Firttech.enc` 的记录位置（`绝学代码`，原程序不按+0重排），都是**十六进制字符串**。
 *
 * ## 名称还留着做什么
 *
 * 两件事，都不是程序逻辑：
 * * **渲染** —— 字库是 Big5 繁体，界面画的一律是 `名称繁`；
 * * **人查** —— 我们讨论时说的是简体（「铁枪对夏侯仪应该是红的」），
 *   测试夹具里写简体也比写 `'3D'` 可读。`查()` 就是给这两件事用的。
 *
 * ⚠️ 简体名来自 300块 配套资料，**官方版有 42% 的物品查不到简体名**
 * （大多是敌人的武器条目，玩家拿不到）。查不到时 `名称` 里放的就是繁体，
 * 界面照画不误 —— 见 `docs/专题/官方版对照.md` §4。
 *
 * ⚠️ **代码一律当字符串处理并转成大写。** `物品编号` 里既有 `"2"` 也有 `"3D"`，
 * 按十进制 `Number()` 会把 `"3D"` 变成 `NaN`、把 `"65"` 变成 65（真值是 101）。
 * 这个坑在 `export_gamedata.py` 的 `HEX_KEYS` 那里已经踩过一次。
 */

/** 代码规范化：去空白、转大写。非法输入返回 `''`。 */
export const normCode = (code) => String(code ?? '').trim().toUpperCase();

/** 一件东西该显示什么名字：**繁体优先**（字库是 Big5 繁体）。 */
export const displayName = (record) => record?.名称繁 || record?.名称 || '';

/** 法宝页六个分类。⚠️ 顺序＝二级菜单的 items 顺序，不是帧号顺序（帧号是反的）。 */
export const CATEGORIES = Object.freeze(['用器', '兵刃', '护甲', '饰物', '杂类', '暂置']);

/**
 * 建两张索引：代码 → 记录，名称 → 代码数组。
 *
 * 名称索引**存数组不存单条** —— 这正是重名不再丢数据的地方。
 * 简体名与繁体名都进同一张表，所以 `查('铁枪')` 和 `查('鐵槍')` 都认。
 */
function buildIndex(rows, codeKey) {
  const byCode = new Map();
  const byName = new Map();
  for (const row of rows ?? []) {
    const code = normCode(row?.[codeKey]);
    if (!code || byCode.has(code)) continue;
    byCode.set(code, row);
    // ⚠️ **`名称` 与 `名称繁` 常常是同一个串**（简繁同形，如「刻盤碎片」「黑石球」，
    // 以及查不到简体名时 `名称` 里放的就是繁体）。不去重的话同一条会被推两次，
    // `查全部('刻盘碎片')` 会返回 14 条而不是 7 条。
    for (const name of new Set([row.名称, row.名称繁])) {
      const key = String(name ?? '').trim();
      if (!key) continue;
      const list = byName.get(key);
      if (list) list.push(code);
      else byName.set(key, [code]);
    }
  }
  return { byCode, byName };
}

/**
 * 建目录。
 *
 * 装备与用器**共用一套代码空间**（都是 `Ail2.ENC` 的记录下标），所以合成一张
 * `物品` 索引；绝学是另一套代码空间，单独一张。
 *
 * @param {{equipment?: object[], items?: object[], skills?: object[]}} tables
 */
export function createCatalog({ equipment = [], items = [], skills = [] } = {}) {
  const goods = buildIndex([...equipment, ...items], '物品编号');
  const arts = buildIndex(skills, '绝学代码');

  const pick = (index, name) => {
    const codes = index.byName.get(String(name ?? '').trim()) ?? [];
    return codes.length ? index.byCode.get(codes[0]) : null;
  };
  const all = (index, name) =>
    (index.byName.get(String(name ?? '').trim()) ?? []).map((c) => index.byCode.get(c));

  return Object.freeze({
    /** 按代码取物品（装备与用器同一套代码）。查不到返回 null。 */
    物品: (code) => goods.byCode.get(normCode(code)) ?? null,
    /** 按代码取绝学。查不到返回 null。 */
    绝学: (code) => arts.byCode.get(normCode(code)) ?? null,

    /**
     * 按名称取物品，简体繁体都认。
     * ⚠️ **重名时返回代码最小的那条**（`buildIndex` 的插入序）。
     * 名称本来就不足以定位，要精确请用代码；拿不准就用 `查全部`。
     */
    查: (name) => pick(goods, name),
    /** 按名称取**全部**同名物品。刻盘碎片会给回七条。 */
    查全部: (name) => all(goods, name),
    /** 按名称取绝学，简体繁体都认。重名规则同 `查`。 */
    查绝学: (name) => pick(arts, name),
    /** 按名称取全部同名绝学。紫琰飞煌会给回两条（冰璃、葛云衣）。 */
    查绝学全部: (name) => all(arts, name),

    /**
     * 名称 → 代码。**写测试夹具时用它**，别在夹具里硬写十六进制。
     * 查不到抛错 —— 夹具里写错名字应当当场炸，不该静默变成空槽。
     */
    代码: (name) => {
      const hit = pick(goods, name);
      if (!hit) throw new Error(`目录里没有这件东西：${name}`);
      return normCode(hit.物品编号);
    },
    绝学代码: (name) => {
      const hit = pick(arts, name);
      if (!hit) throw new Error(`目录里没有这门绝学：${name}`);
      return normCode(hit.绝学代码);
    },

    /** 该代码的装备槽位（兵刃/护甲/饰物）；不是装备返回 null。 */
    槽位: (code) => goods.byCode.get(normCode(code))?.槽位 ?? null,

    /**
     * 该代码归法宝页哪个分类。
     * ⚠️「暂置」是**捡到还没分发**的状态，由背包条目自己带，不由物品决定。
     */
    分类: (code) => {
      const row = goods.byCode.get(normCode(code));
      if (!row) return '杂类';
      return row.槽位 ?? (row.物品类别 === '用器' ? '用器' : '杂类');
    },

    /** 统计用。 */
    规模: () => ({ 物品: goods.byCode.size, 绝学: arts.byCode.size }),
  });
}
