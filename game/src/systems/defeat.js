/**
 * **败阵（game over）的判定。**
 *
 * ## 原作是怎么做的
 *
 * `MP0000` 槽 9 就是战败流程，全槽只有 6 条：
 *
 * ```
 * op102(未解) → play_audio track=31 → play_movie 10
 *             → fade_out speed=16 → op141(未解) → end
 * ```
 *
 * 影片 10 是 4 秒的黑底红字「敗降」（`multimedia/Mov/10.Dat`，Bink Video，
 * 由 `tools/export_movies.py` 转成 `assets/movies/mov10.mp4`）。
 * 这个归档里唯一的场景对象就叫 `GameOver.SF2`。
 *
 * ⚠️ **`op141`（0x8D）全库只有 3 处，三处都是「`play_movie` → 它 → `end`」**：
 *
 * | 出处 | 前面那条影片 | 是什么场合 |
 * |---|---|---|
 * | `MP0000` 槽 8 index 3 | 影片 1 | 汉堂 LOGO ＋ 片头 |
 * | `MP0000` 槽 9 index 4 | 影片 10 | **败阵** |
 * | `MP1013` 槽 10 index 1203 | 影片 9 | **通关结局**（前面是 `ed2` 动画） |
 *
 * 片头之后、败阵之后、通关之后 —— 三处的共同点只有一个：**回主菜单**。
 * 我们没有把它实现成指令（那要动导出器），而是由 `FieldScene.playDefeat`
 * 用 `queueAfterScript` 接上，效果一样。这条记在 `docs/状态/复现度台账.md`。
 *
 * ## 「算不算全灭」用的是战斗那一套
 *
 * `BattleScene.wiped()` 的判据是 **`!units.some(u => u.alive)`**，
 * 也就是**一个活的都没有**。地图上掉血走同一条判据，不另立一套 ——
 * `heal_points` 是「全员回复(点)」，负数时所有人同时掉，
 * 谁的命最少谁先归零，用「主角死」还是「全灭」在表现上差好几下。
 * ⚠️ 用哪一条**没有原作判据**，选全灭是因为它与战斗那边一致。
 */

/**
 * 队伍是不是全灭了（一个活的都没有）。
 *
 * ⚠️ **空队伍不算全灭。** 剧情里 `party_leave` 可能把人暂时清空
 * （送鸡汤那段主角就是一个人走的），判成全灭会当场 game over。
 *
 * @param {{members?: Array<{命?: number}>}} party
 */
export function isPartyWiped(party) {
  const members = party?.members ?? [];
  if (!members.length) return false;
  return members.every((m) => !(Number(m?.命) > 0));
}
