/**
 * 「缺东西」的警告，**同一处只出一次**。
 *
 * ## 为什么需要它
 *
 * 判据表有一条：**兜底跳过（`if (exists) …`）要在 `else` 里留一行日志**。
 * 这条已经咬过五次，每次表现都不一样、每次都查了一两轮：
 *
 * * `cache.audio.exists()` 静默吞掉 bgm5 与全部 19 处音效
 * * `loadMasks` 里遮挡层建不起来时置 null → **整张图谁都不被挡**
 * * `playBgm` 收到不存在的 key 原样返回 → 「从兰州城到废屋全程一首曲子」
 * * 战斗单位三道关卡各自只有一行 warn → 「入队了不上场」
 * * 场景动画的内嵌音效**整条链都是空的**（导出器/加载/播放三处都没接）
 *
 * ## 为什么不直接 `console.warn`
 *
 * 这些兜底大多在**逐帧**路径上（`renderFrame`、`setLayerTexture`、
 * `playFrameSound`）。直接 warn 会每秒刷几十条，把控制台淹掉 ——
 * 结果是「有日志」等于「没日志」，跟静默一样查不出问题。
 *
 * 所以按 `key` 去重：**一个缺失的东西只喊一次**，喊的内容要说清
 * **缺哪一块**（不是笼统的「加载失败」）。
 */

/** 已经喊过的 key。模块级，跟着页面生命周期走。 */
const shouted = new Set();

/**
 * 缺了东西就喊一声，同 `key` 只喊第一次。
 *
 * @param {string} key  去重用。**要带上具体是哪个资源**，
 *   例如 `bgm:MP1001A1:91`，不要用 `bgm` 这种粗粒度的 —— 那会把
 *   第二个不同的缺失也吞掉，正是这个工具要避免的事。
 * @param {string} message 说清**缺哪一块、后果是什么**。
 */
export function warnOnce(key, message) {
  if (shouted.has(key)) return false;
  shouted.add(key);
  console.warn(`⚠ ${message}`);
  return true;
}

/** 已经喊过多少种。给测试与诊断用。 */
export function warnedCount() {
  return shouted.size;
}

/** 清空。**只给测试用** —— 运行时清了会让同一个缺失重新刷屏。 */
export function resetWarnings() {
  shouted.clear();
}
