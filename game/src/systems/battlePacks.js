/**
 * 战斗动画包的加载排队（BattleScene 使用）。
 * 2026-09-27 曾用于地图后台预热（RES-01 方案B），实测预热期间纹理上传卡住主线程、
 * 走路掉到约24帧/秒并出现“瞬移”，用户决定撤销预热；入场首次加载时间回到约12–15秒。
 */
import { uiAsset } from './language.js';
import { hdPackAtlas } from '../hd/hdAssets.js';

/**
 * 排一个动画包的图与内嵌音效。已在缓存里的跳过。
 * 图集：整个包 1 个 JSON + N 页 PNG；旧产物没有 `atlas` 字段，退回逐张。
 */
/**
 * 释放一个战斗包：纹理、内嵌音效、清单。按需载入的本队绝学在战斗结束后调用（BattleScene）。
 * 须在场景关闭、用到它的对象都销毁之后再调。
 */
export function releaseBattlePack(scene, key) {
  const data = scene.cache.json.get(`${key}-anim`);
  if (!data) return;
  const textures = data.atlas ? [key] : (data.images ?? []).map((img) => `${key}-img${img.index}`);
  for (const k of textures) if (scene.textures.exists(k)) scene.textures.remove(k);
  for (const snd of data.sounds ?? []) {
    const k = `${key}-snd${snd.index}`;
    if (scene.cache.audio.exists(k)) scene.cache.audio.remove(k);
  }
  scene.cache.json.remove(`${key}-anim`);
}

/** @param {() => void} [add] 每排一个文件调一次（`loader.runLoader` 靠它知道有没有东西要载） */
export function queueBattlePack(scene, key, add = () => {}) {
  const data = scene.cache.json.get(`${key}-anim`);
  if (!data) return;
  if (data.atlas) {
    if (!scene.textures.exists(key)) {
      // 高清试做：头像包（ITF0051）有 AI 高清图集就读它，显示时自动缩回原尺寸
      const hd = hdPackAtlas(scene, key);
      scene.load.multiatlas(key, hd?.json ?? uiAsset(`assets/${key}/${data.atlas.json}`), hd?.path ?? uiAsset(`assets/${key}`));
      add();
    }
  } else {
    (data.images ?? []).forEach((img) => {
      const k = `${key}-img${img.index}`;
      if (!scene.textures.exists(k)) { scene.load.image(k, uiAsset(`assets/${key}/${img.file}`)); add(); }
    });
  }
  // 内嵌音效：索引与帧的 sound_index 一一对应
  (data.sounds ?? []).forEach((snd) => {
    const k = `${key}-snd${snd.index}`;
    if (!scene.cache.audio.exists(k)) { scene.load.audio(k, uiAsset(`assets/${key}/${snd.file}`)); add(); }
  });
}
