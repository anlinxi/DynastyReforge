/**
 * **跨场景重建之后，把剧情已经建立的状态重放一遍。**
 *
 * ── 为什么需要它（原作没有这个问题）──
 *
 * 原作是一个进程从头跑到尾，场上有谁、站在哪、镜头盯着谁，**从来不会丢**。
 * 所以脚本里只会交代**一次**：
 *
 * ```
 * MP0304 槽 10：
 *    #33  actor_show 封鈴笙      ← 剧情让她出场
 *    #97  battle                 ← 我们 scene.start('Battle')，场景被销毁重建
 *    #99~ 接着演……                ← 脚本不会再 show 一次
 * ```
 *
 * `封鈴笙` **不在 MP0304 的对象表里**（她是共享角色），场景一重建就没了 ——
 * 战斗打完回来，画面上少了一个人。同一个病根还制造过：
 *
 * * 战斗回来后 `set_avatar 1` 与 `fade_in` 全丢 → 人回大地图**形象大一倍**
 * * 剧情结束镜头不还给主角 → 人能走、地图不动
 *
 * 三次表现各不相同，所以看起来像三个 bug。**根子是一个：我们重建了场景，
 * 而重建是实现细节，原作不知道，脚本也不会为它多写一句。**
 * 见 `docs/专题/病根.md` 病根 E。
 *
 * ── 重放什么 ──
 *
 * 只重放**状态类**指令 —— 那些「说完之后世界就一直是那样」的：
 * 显隐、站位、朝向、镜头靶子、行走形象、门的开合。
 * **不重放**对白、动画、等待、音效、淡入淡出 —— 那些是**演出**，
 * 演过就过去了，再演一遍就是重播剧情。
 *
 * ── 三条必须守住的规矩 ──
 *
 * 1. **只取当前这张图的那一段。** 脚本可以横跨好几张图（废屋那一槽第 8 条
 *    就 `goto_map` 了）。要从**游标前最后一条 `goto_map`** 算起，
 *    否则会把上一张图的演员搬到这张图上。
 * 2. **同一个对象只留最后一次。** `actor_place` 重放全部的话，人会停在
 *    中途的某个位置上；只认最后一条才是「此刻应该在哪」。
 * 3. **主角不在重放之列。** 他的位置由入场点（`entry` / 战斗的 `returnTo`）
 *    显式带着，而且那是**更新的**值；重放旧的 `hero_place` 会把他挪回去。
 */

/** 会让「当前是哪张图」改变的指令 —— 重放的起点由它划定。 */
const MAP_CHANGE = new Set(['goto_map']);

/**
 * 状态类指令 → 这条指令在**哪个维度**上覆盖谁。
 *
 * `key` 决定「同一个对象的上一条会被这一条盖掉」。
 */
const STATE_KIND = {
  actor_show: (a) => `visible:${a.name}`,
  actor_hide: (a) => `visible:${a.name}`,
  actor_place: (a) => `where:${a.name}`,
  actor_walk: (a) => `where:${a.name}`,
  actor_walk_rel: (a) => `where:${a.name}`,
  actor_to_center: (a) => `where:${a.name}`,
  actor_face: (a) => `facing:${a.name}`,
  set_avatar: () => 'avatar',
  camera_follow: () => 'camera',
  camera_hero: () => 'camera',
  open_door: (a) => `door:${a.name}`,
};

/**
 * 游标之前、属于**当前这张图**的那一段里，需要重放的状态指令。
 *
 * @param {Array<object>} actions 整个槽的动作序列（下标即子事件号）
 * @param {number} cursor 续演要从第几条开始
 * @param {(name:string) => boolean} isHero 判断某个名字是不是主角（主角不重放）
 * @returns {Array<object>} 按原顺序排列、每个维度只保留最后一条
 */
export function stateToReplay(actions, cursor, isHero = () => false) {
  const list = Array.isArray(actions) ? actions : [];
  const end = Number.isInteger(cursor) ? Math.min(cursor, list.length) : 0;

  // 规矩 1：从游标前最后一次换图算起。
  let start = 0;
  for (let i = 0; i < end; i += 1) {
    if (MAP_CHANGE.has(list[i]?.type)) start = i + 1;
  }

  // 规矩 2：同一维度只留最后一条。用 Map 保序。
  const latest = new Map();
  let layer = 0;
  const layered = list.slice(start, end).some(a => a?.type === 'switch_layer');
  for (let i = start; i < end; i += 1) {
    const act = list[i];
    if (act?.type === 'switch_layer') {
      layer = act.layer;
      latest.set(`layer-switch:${i}`, act);
      continue;
    }
    const kind = STATE_KIND[act?.type];
    if (!kind) continue;
    // 规矩 3：主角不重放。
    if (act.name && isHero(act.name)) continue;
    const dimension = kind(act);
    const key = /^(visible|where|facing|door):/.test(dimension) ? `${layer}:${dimension}` : dimension;
    if (layered) latest.delete(key); // 跨层重放顺序跟随最新指令所处楼层
    latest.set(key, act);
  }
  return [...latest.values()];
}

/**
 * 把「走过去」压成「直接站在那儿」—— 重放不该再演一遍走路。
 *
 * `actor_walk_rel` 的坐标是**相对屏幕中心控制者**的，重放时那个原点未必还在，
 * 所以它只保留朝向、不改位置（`x/y` 置 null 让调用方跳过挪位）。
 */
export function asInstant(action) {
  if (action.type === 'actor_walk') {
    return { ...action, type: 'actor_place', x: action.x, y: action.y };
  }
  if (action.type === 'actor_walk_rel') {
    return action.facing === undefined ? null
      : { type: 'actor_face', name: action.name, facing: action.facing };
  }
  return action;
}
