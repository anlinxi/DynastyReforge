/**
 * **队伍成员 → 地图上的行走精灵键。**
 *
 * 给「Tab 换地图上操作的角色」用。从 `FieldScene` 分出来是因为那个文件
 * 已经两千多行，而这里要接两张数据表。
 *
 * ## ⚠️ 这个功能**原作没有**
 *
 * 用户知道，也仍然要（原话：「我确实看了原作没有这个机制，但是我想实现」）。
 * 四条判据说明原作不可能有：
 *
 * 1. `MAINNPC.SCI`（`set_avatar` 的映射表）只有 5 条 —— 飛龍 / 小夏侯儀 /
 *    dead / 大夏侯儀 / 霍雍，**队友一条都不在里面**
 * 2. 存档只有**一个**行走形象字段（`@57583`），全库取值只有 `{1, 3, 4}`
 * 3. 全库 129 处 `set_avatar` **全部由剧情脚本发出**，没有玩家自主切换的指令
 * 4. 队友的精灵只有 41 帧（影子 + 站立 8 + 行走 8×4），**没有跑步段**
 *
 * 所以它在复现度台账里是 🔵 架构新增。**只换外观**：队伍顺序、菜单队首、
 * 战斗出场、存档的 `@57583` 一概不动（用户拍板：「纯换地图角色，不改菜单的东西」）。
 *
 * ## 代码 → 精灵键是怎么对上的
 *
 * ```
 * 代码 1 夏侯仪 → 当前行走形象（大地图上是小夏侯仪，所以要动态取）
 * 代码 7 霍雍   → avatars.json 的 形象[4]
 * 代码 2~6      → avatars.json 的 共享角色（SUBNPC.SCI）
 * ```
 *
 * ⚠️ 2~6 这一段是**按顺序对的**，不是按名字：`共享角色` 的键是**繁体**
 * （`封鈴笙`），而 `gamedata.队伍顺序` 是简体（`封铃笙`），两边没有共同的键。
 * 好在 `SUBNPC.SCI` 的顺序与队伍顺序里第 2~6 位严丝合缝：
 *
 * | 队伍顺序[1..5] | 冰璃 | 封铃笙 | 慕容璇玑 | 古伦德 | 葛云衣 |
 * | 共享角色（顺序） | 冰璃 | 封鈴笙 | 慕容璇璣 | 古倫德 | 葛雲衣 |
 *
 * **这是推断，不是判据**（台账 🟡）。两张表的长度或顺序一变就会静默错位，
 * 所以 `avatarRoster.test.js` 把结果逐条钉住了 —— 错位当场红。
 */

/** 主角的战斗角色代码。 */
const HERO_CODE = 1;
/** 霍雍的战斗角色代码，以及他在 `形象` 表里的下标。 */
const HUOYONG_CODE = 7;
const HUOYONG_AVATAR = 4;
/** `共享角色` 覆盖的战斗角色代码区间（冰璃 2 ~ 葛云衣 6）。 */
const SHARED_FIRST = 2;

/**
 * 战斗角色代码 → 行走精灵键。
 *
 * @param {object} avatars `assets/data/avatars.json`
 * @param {string|null} heroSprite 主角当前的行走形象键（`registry.avatarSprite`）
 * @returns {Map<number, string>} 认不出的代码不会出现在表里
 */
export function avatarKeyByCode(avatars, heroSprite = null) {
  const out = new Map();
  const 形象 = avatars?.形象 ?? {};
  const 共享 = Object.values(avatars?.共享角色 ?? {});
  // 主角：优先用当前形象（大地图上是小夏侯仪），退回 `形象` 表里的大夏侯仪。
  const hero = heroSprite || 形象['3'];
  if (hero) out.set(HERO_CODE, hero);
  共享.forEach((key, i) => { if (key) out.set(SHARED_FIRST + i, key); });
  if (形象[String(HUOYONG_AVATAR)]) out.set(HUOYONG_CODE, 形象[String(HUOYONG_AVATAR)]);
  return out;
}

/**
 * Tab 能在哪些精灵之间轮换。
 *
 * **只收队伍里真有、而且精灵真载进来了的人** —— 载不进来的换过去就是
 * 一摊影子（`standFrame` 会退回帧 0）。`hasSprite` 由调用方给，
 * 通常是 `(key) => Boolean(scene.cache.json.get(`${key}-sprite`))`。
 *
 * @returns {string[]} 精灵键，按队伍顺序；队伍为空时返回空数组
 */
export function switchableAvatars(party, avatars, heroSprite, hasSprite = () => true) {
  const table = avatarKeyByCode(avatars, heroSprite);
  const seen = new Set();
  const out = [];
  for (const m of party?.members ?? []) {
    const key = table.get(Number(m?.code));
    if (!key || seen.has(key) || !hasSprite(key)) continue;
    seen.add(key);
    out.push(key);
  }
  return out;
}

/**
 * 轮换到下一个。当前那个不在表里（比如剧情刚把形象换成飛龍）就从头开始。
 *
 * @returns {string|null} 下一个精灵键；可换的不足两个时返回 null
 */
export function nextAvatar(keys, current) {
  if (!keys || keys.length < 2) return null;
  const i = keys.indexOf(current);
  return keys[(i + 1) % keys.length];
}


/**
 * **剧情里点名的事物 → 行走精灵键。**（`actor_show{name:"封鈴笙"}` 那种）
 *
 * 两张表求并集，**都来自 `avatars.json`**：
 *
 * * `共享角色`（`SUBNPC.SCI`）—— 键就是**繁体名**，正好是脚本用的写法
 * * `形象名`/`形象`（`MAINNPC.SCI`）—— 大夏侯儀 / 小夏侯儀 / 霍雍 / 飛龍
 *
 * ⚠️ **不要再手写这张表。** 上一版 `config.CUTSCENE_SPRITES` 是手填的四条
 * （大夏侯儀 / 夏侯儀 / 封鈴笙 / 冰璃），于是凉州城那段剧情里
 * `actor_show 慕容璇璣` 与 `actor_show 古倫德` **在场上什么都不出现** ——
 * 五个人的合影只来了两个，而且不报错。判据表「清单类常量要拿数据反查」
 * 的第五次翻版。
 *
 * @param {object} avatars `assets/data/avatars.json`
 * @param {object} extra 额外的别名（脚本里出现过、但两张表都没有的写法）
 * @returns {Record<string, string>} 名字 → 精灵键
 */
export function castKeyByName(avatars, extra = {}) {
  const out = { ...(avatars?.共享角色 ?? {}) };
  const 形象 = avatars?.形象 ?? {};
  for (const [code, name] of Object.entries(avatars?.形象名 ?? {})) {
    if (name && 形象[code]) out[name] = 形象[code];
  }
  return Object.freeze({ ...out, ...extra });
}
