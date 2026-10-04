/**
 * 机舱页（设置页）的两条音量。
 *
 * 存在 registry 上而不是挂在菜单对象上 —— 菜单每次 `scene.restart()` 都会
 * 重建（`goto_map` 一定 restart），挂在它身上的话一进店出店音量就跳回默认。
 * 与队伍、背包同一个理由，见 `systems/gameState.js`。
 *
 * ── 档位与帧号 ──
 * 两条滑条素材（音乐 `MEN0011` / 音效 `MEN0012`）各 10 帧。
 * ⚠️ **帧号是倒着数的**：帧 0 满格，帧 9 最短。所以 `frameOf()` 要减一下，
 * 直接把档位当帧号会让音量条左右颠倒。（菜单里 `MEN1017` 那个游标也是
 * 倒序，同一个脾气。）
 */

/** registry 里的键。 */
const KEY = 'audioSettings';

/** 滑条的档数，等于素材帧数。 */
export const LEVELS = 10;

/** 默认档位。原作默认值不知道，取满格；进 `docs/状态/复现度台账.md`。 */
const DEFAULT_LEVEL = LEVELS - 1;

/** 十档从静音到满音量；最低档按用户要求必须为零。 */
export function volumeOf(level) {
  return clampLevel(level) / (LEVELS - 1);
}

/** 档位 → 该画第几帧。**倒序**，见模块头。 */
export function frameOf(level) {
  return LEVELS - 1 - clampLevel(level);
}

export function clampLevel(level) {
  const n = Math.round(Number(level));
  if (!Number.isFinite(n)) return DEFAULT_LEVEL;
  return Math.min(LEVELS - 1, Math.max(0, n));
}

/** 当前设置。没有就建一份默认的。返回的是冻结副本，改要走 `setLevel`。 */
export function audioSettings(scene) {
  const stored = scene?.registry?.get?.(KEY);
  if (stored) return stored;
  const fresh = Object.freeze({ 音乐: DEFAULT_LEVEL, 音效: DEFAULT_LEVEL });
  scene?.registry?.set?.(KEY, fresh);
  return fresh;
}

/**
 * 改一条的档位，返回新的设置。
 * @param {'音乐'|'音效'} kind
 */
export function setLevel(scene, kind, level) {
  const next = Object.freeze({
    ...audioSettings(scene),
    [kind]: clampLevel(level),
  });
  scene?.registry?.set?.(KEY, next);
  if (kind === '音效') {
    for (const sound of scene?.sound?.sounds ?? []) {
      if (sound.ycSfxBaseVolume !== undefined && !sound.pendingRemove) {
        sound.setVolume(sound.ycSfxBaseVolume * volumeOf(next.音效));
      }
    }
  }
  return next;
}

/** 音乐音量（0~1），给 `bgm.js` 用。 */
export function musicVolume(scene) {
  return volumeOf(audioSettings(scene).音乐);
}

/** 音效音量（0~1）。 */
export function sfxVolume(scene) {
  return volumeOf(audioSettings(scene).音效);
}

/** 所有游戏音效共用档位，含正在播放的循环音效；影片音轨由影片自身管理。 */
export function playSfx(scene, key, { volume = 1, ...options } = {}) {
  const sound = scene.sound.add(key, { ...options, volume: volume * sfxVolume(scene) });
  sound.ycSfxBaseVolume = volume;
  sound.once?.('complete', () => sound.destroy());
  sound.play();
  return sound;
}
