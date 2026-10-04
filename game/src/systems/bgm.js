import { BGM_FILES, BGM_VOLUME, TITLE } from '../config.js';
import { musicVolume } from './audioSettings.js';
import { warnOnce } from './warnOnce.js';

/**
 * Phaser 的 `Phaser.Sound.Events.UNLOCKED` 就是这个字符串
 * （`phaser/src/sound/events/UNLOCKED_EVENT.js`）。
 *
 * ⚠️ **这里故意不 import phaser。** 本模块被 `cutscene.js` 引用，而那个
 * 模块是纯逻辑、跑在 `node --test` 里；只为一个常量把整个引擎拉进来，
 * 测试会当场 `ReferenceError: window is not defined`。
 */
const SOUND_UNLOCKED = 'unlocked';

/**
 * 背景音乐。**同一首曲子跨场景连着放，换曲才切。**
 *
 * 曲子挂在 Phaser 的全局 SoundManager 上，不随场景关闭而停。这一点是必要的：
 * 从药铺走进客栈是 `scene.restart`，两张图的 BGM 编号都是 3，若按场景生命周期
 * 停了再起，玩家每进一家店都会听见同一首曲子从头重放。
 *
 * 所以规则反过来定：**谁开场谁申明自己要哪首**，由这里决定是续放还是换。
 * 战斗场景也走这条路，否则从场景漫游按 B 进战斗时两首会叠在一起响。
 *
 * 曲目编号来自地图的 `MPMP<图号>.SCI`（见 tools/export_map.py 的 OFF_MAP_BGM），
 * 文件由 tools/export_music.py 从 Music.DAT 取出。
 */

/** 当前在放的曲子存在 registry 里，跨场景可见。 */
const REGISTRY_KEY = 'bgm-playing';
const MUTED_KEY = 'bgm-muted';

/**
 * ## 边读边播（2026-09-27 改）
 *
 * 背景音乐不再预先整首解码：原先每首解码成 32 位浮点 PCM 常驻内存（每首 29–109 MB，
 * 全库约 1.8 GB，只进不出），进图还要等解码（桌面实测每首 0.5–1.8 秒）。
 * 现在用浏览器原生音频元素流式播放：开播只需读文件（十几毫秒），内存几乎为零。
 * 循环接缝实测（bgm4/bgm12）：与整首解码相比最多多 16 毫秒静音，曲子首尾本身的静音不变。
 *
 * 曲子不再进 Phaser 缓存，而是按键名找地址：地图/剧情 `bgm-<曲号>` 查 `BGM_FILES`，
 * 标题曲查 `TITLE`，战斗曲、胜利曲由战斗场景 `registerBgm` 登记。
 */
const EXTRA_URLS = new Map([[TITLE.bgmKey, `audio/${TITLE.bgmFile}`]]);

/** 登记一首不在 `BGM_FILES` 里的曲子（战斗曲、胜利曲）。 */
export function registerBgm(key, url) {
  EXTRA_URLS.set(key, url);
}

/** 键名 → 地址；不认识返回 null。 */
export function bgmUrl(key) {
  if (EXTRA_URLS.has(key)) return EXTRA_URLS.get(key);
  const track = /^bgm-(\d+)$/.exec(String(key ?? ''))?.[1];
  const file = track != null ? BGM_FILES[track] : null;
  return file ? `audio/${file}` : null;
}

const clampVolume = (v) => Math.max(0, Math.min(1, Number(v) || 0));

/** 还活着的流式播放器的音频元素：App 进后台时要逐个暂停（见 backgroundAudio.js）。 */
const liveStreams = new Set();

/** 当前所有背景音乐音频元素（只读快照）。 */
export function bgmStreamElements() {
  return [...liveStreams];
}

/** 浏览器里的流式播放器：对外与 Phaser 声音对象同一组方法，`playBgm` 其余规则不变。 */
function htmlStream(url, { loop, volume }) {
  const el = new Audio(url);
  liveStreams.add(el);
  el.loop = loop;
  el.preload = 'auto';
  el.volume = clampVolume(volume);
  return {
    manager: {},
    pendingRemove: false,
    get isPlaying() { return !el.paused; },
    get volume() { return el.volume; },
    play() {
      el.play().catch((err) => warnOnce(`bgm-stream:${url}`, `背景音乐 ${url} 播不出来：${err?.message ?? err}`));
    },
    stop() { el.pause(); },
    destroy() {
      el.pause();
      liveStreams.delete(el);
      el.removeAttribute('src');
      el.load();
      this.pendingRemove = true;
    },
    setVolume(v) { el.volume = clampVolume(v); },
  };
}

/** 单元测试用：换掉播放器（node 里没有 Audio）。工厂签名 `(url, {loop, volume}, key, scene)`。 */
let createStream = htmlStream;
export function setBgmStreamFactory(factory) {
  createStream = factory ?? htmlStream;
}

/**
 * 放一首曲子；已经在放同一首就什么都不做。
 *
 * ⚠️ **剧情的 `play_audio kind=0` 也必须走这里**，不能直接 `scene.sound.play`——
 * 那是「再叠一层」，于是废屋初遇切到 bgm5 之后城门区的 bgm4 还在底下响，
 * 两首一起放；而且 registry 不知道换过曲，战斗完再想换回来也换不动。
 *
 * @param {boolean} [loop] 循环放。剧情里有一次性的曲子
 *   （释义 op8E 的 `Z=1 循环；Z=0 只播放一次`），所以不能写死 true。
 * @returns 正在放的播放器（见 htmlStream），没有这首的文件时返回 null
 */
export function playBgm(scene, key, volume = null, loop = true) {
  if (!key) return null;
  // ⚠️ **不换曲要出声。** 这一行返回 null 的后果是「音乐一直是上一首」，
  // 而玩家看不出这是 bug —— 它跟「这张图本来就没音乐」长得一模一样。
  // 「从兰州城到废屋到出来全程一首」就是在这里静默掉的：曲子早导出来了，
  // 只是没排进缓存。见判据表「写清单类常量」那条。
  const url = bgmUrl(key);
  if (!url) {
    warnOnce(`bgm-play:${key}`,
      `要放的曲子「${key}」没有文件 —— 不换曲，继续放上一首。`
      + '查 config.BGM_FILES 里有没有这条，战斗曲/胜利曲有没有 registerBgm。');
    return null;
  }
  // 机舱页那条音乐滑条乘在基准音量上。传了 volume 的调用方（剧情里
  // 指定音量的那种）优先，不传就按设置走。
  const level = volume ?? BGM_VOLUME * musicVolume(scene);
  const muted = scene.registry.get(MUTED_KEY) === true;

  const current = scene.registry.get(REGISTRY_KEY);
  if (current?.key === key && current.sound?.isPlaying && current.loop === loop) {
    return current.sound;
  }

  // 上一首若还挂着「解锁后补播」的回调，必须先摘掉：它闭包里的那个 sound
  // 下一行就要被 destroy，解锁事件再触发就会去播一个已销毁的对象。
  if (current?.pendingUnlock) {
    scene.sound.off(SOUND_UNLOCKED, current.pendingUnlock);
  }
  current?.sound?.stop();
  current?.sound?.destroy();

  const sound = createStream(url, { loop, volume: muted ? 0 : level }, key, scene);

  /**
   * 浏览器在用户交互前会锁住音频，解锁后再补一次播放。
   *
   * 守卫不能省：destroy 过的 sound 其 manager 会被置空，此时再 play()
   * 会让 Phaser 在 resetConfig 里对 null 赋值而抛错。那个异常是在事件回调里
   * 抛的，会直接打断整个游戏循环——表现为「开局直接切地图就完全卡死，
   * 但先在战斗场景操作一下再切就正常」（先操作等于提前解锁，回调在 sound
   * 还活着时就跑完了）。
   */
  const tryPlay = () => {
    if (!sound.manager || sound.pendingRemove) return;
    if (scene.registry.get(MUTED_KEY)) return;
    if (!sound.isPlaying) sound.play();
  };

  let pendingUnlock = null;
  if (scene.sound.locked) {
    pendingUnlock = tryPlay;
    scene.sound.once(SOUND_UNLOCKED, tryPlay);
  } else {
    tryPlay();
  }
  scene.registry.set(REGISTRY_KEY, { key, sound, pendingUnlock, loop,
    ...(muted ? { mutedFrom: level, deferredStart: true } : {}) });
  return sound;
}

/**
 * 停掉当前这首并清空登记。
 *
 * ⚠️ **不能靠「下一首会顶掉它」**：标题画面的曲子放完之后，紧接着是
 * 长片头影片，而影片期间 BGM 是**静音不是停**（见 `muteBgm`）——
 * 不显式停掉，标题那首会在片头放完后从静音里回来，压在卧室的曲子底下。
 */
export function stopBgm(scene) {
  scene?.registry?.set?.(MUTED_KEY, false);
  const current = scene?.registry?.get?.(REGISTRY_KEY);
  if (!current) return;
  if (current.pendingUnlock) scene.sound.off(SOUND_UNLOCKED, current.pendingUnlock);
  current.sound?.stop();
  current.sound?.destroy();
  scene.registry.set(REGISTRY_KEY, null);
}

/**
 * 把当前设置的音量应用到**正在放的那首**。
 *
 * 机舱页拖滑条时要立刻听见变化，而 `playBgm` 只在换曲时才建新的 Sound ——
 * 不主动推一把的话，得等下次换地图才生效。
 */
/**
 * 影片播放期间把 BGM 静音，播完恢复。
 *
 * ⚠️ **原作放过场影片时只有影片自己的声音。** 影片带音轨（Bink Audio），
 * 与地图 BGM 叠在一起是两首曲子同时响 —— 开场那段片头尤其明显，
 * 夏侯仪家的曲子一直在底下垫着。
 *
 * **静音而不是停掉**：影片可以被玩家按空格跳过，跳过之后要立刻接着响，
 * 停掉再重播会从头开始、还要再等一次解码。
 *
 * @param {boolean} muted
 * @returns {number|null} 之前的音量，供调用方自己记（这里也会记一份）
 */
export function muteBgm(scene, muted) {
  // 先记静音状态：加载/淡出期间还没有声道，之后脚本换曲也不能漏出一声。
  scene.registry.set(MUTED_KEY, muted);
  const current = scene?.registry?.get?.(REGISTRY_KEY);
  if (!current?.sound) return null;
  if (muted) {
    if (current.mutedFrom === undefined) current.mutedFrom = current.sound.volume;
    current.sound.setVolume(0);
  } else if (current.mutedFrom !== undefined) {
    current.sound.setVolume(current.mutedFrom);
    delete current.mutedFrom;
    // 准备影片期间请求的新曲只登记，不创建播放源；影片结束才允许发声。
    if (current.deferredStart && !scene.sound.locked && !current.sound.isPlaying) current.sound.play();
    delete current.deferredStart;
  }
  return current.mutedFrom ?? null;
}

export function refreshBgmVolume(scene) {
  const current = scene?.registry?.get?.(REGISTRY_KEY);
  if (!current?.sound || current.sound.pendingRemove) return;
  const volume = BGM_VOLUME * musicVolume(scene);
  if (scene.registry.get(MUTED_KEY)) current.mutedFrom = volume;
  current.sound.setVolume(scene.registry.get(MUTED_KEY) ? 0 : volume);
}

/** 官方4032da→44b0d0：大于50的是剧情变量号，取一次变量值作为曲号。 */
export function resolveBgmTrack(track, flags) {
  return Number(track) > 50 ? (flags?.get(Number(track)) ?? 0) : Number(track);
}

/** 地图/脚本音乐共用原作的曲号解析。0不切曲。 */
export function mapBgmKey(track, flags) {
  const resolved = resolveBgmTrack(track, flags);
  return resolved > 0 ? `bgm-${resolved}` : null;
}
