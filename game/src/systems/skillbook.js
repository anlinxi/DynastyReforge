/**
 * 菜单绝学页的查询。
 *
 * ⚠️ **与 `systems/skills.js` 不是一回事**：那个是**战斗**用的，手写了每门绝学
 * 的执行公式（`SKILLS` / `canUseSkill` / `resolveSkill`）；这里只做**菜单列表**
 * 要的事 —— 按名称查资料、按类型分组。数据来自 `assets/data/skills.json`。
 */

/**
 * 二级菜单**帧号** → 该格收哪几种 `绝学类型`。
 *
 * ⚠️ **帧号与屏幕左右相反** —— `MEN5005` 的 frame0 高亮块画在 x=118（右＝咒法），
 * frame1 画在 x=53（左＝绝技）。所以这个数组按**帧号**排，不是按显示顺序。
 *
 * ⚠️ **一格收多种。** `Firttech.enc` 的绝学类型有六种（普攻/绝技/咒法/阵法/
 * 蛰伏/绝对防御），而菜单只有两格：**阵法归咒法格**；普攻、蛰伏、绝对防御
 * 不是玩家能选的绝学，一格都不进。
 *
 * ⚠️ **值是中文名不是码。** 曾经这里写 `['咒术','绝技']` 而导出的字段叫
 * `绝学类型码`（数字），两边对不上，**绝学页整页空白**且不报错 ——
 * 换数据骨架时踩过这个坑。导出端现在两个都给：`绝学类型码` 与 `绝学类型`。
 */
export const SKILL_KINDS = Object.freeze([['咒法', '阵法'], ['绝技']]);

/**
 * 角色某一类（绝技／咒术）的绝学，按 `绝学类型` 过滤。
 *
 * ⚠️ **入参是绝学代码列表，不是名称列表。** 官方版绝学繁体名有 37 条重名
 * （紫琰飛煌 冰璃与葛云衣各一门，数值不同），按名称查只看得见第一条。
 * 名称 → 代码的翻译在 `tools/export_gamedata.py` 的 `resolve_known_skills()`
 * 里一次性做完，运行时不再按名字找东西。
 *
 * @param {object} catalog `createCatalog()` 的结果
 * @param {string[]} codes 角色已学的绝学代码
 * @param {string} kind 「绝技」或「咒术」
 */
export function skillsOfKind(catalog, codes, kinds) {
  const want = Array.isArray(kinds) ? kinds : [kinds];
  return (codes ?? [])
    .map((代码) => ({ 代码, 记录: catalog.绝学(代码) }))
    .filter((r) => want.includes(r.记录?.绝学类型));
}
