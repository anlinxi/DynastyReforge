/** 对话语音 TTS 开关（仿 systems/gameplayOptions.js 的战斗补丁骨架）。默认开。 */
export const TTS_DEFAULT = true;
export const TTS_STORAGE_KEY = 'youcheng-tts';

const defaultStorage = () => (typeof localStorage === 'undefined' ? null : localStorage);

/**
 * 当前 TTS 开关：只记关掉的（存 '0'），其余（含没存过、存储读不到）按默认开。
 * 每次 playLine 前现读，标题页改了即时生效，不用重新载入。
 */
export function ttsEnabled(storage = defaultStorage()) {
  try {
    return storage?.getItem(TTS_STORAGE_KEY) !== '0';
  } catch {
    return TTS_DEFAULT;
  }
}

/** 保存开关；存不了（隐私模式等）返回 false，只影响本次。 */
export function setTtsEnabled(enabled, storage = defaultStorage()) {
  try {
    storage?.setItem(TTS_STORAGE_KEY, enabled ? '1' : '0');
    return Boolean(storage);
  } catch {
    return false;
  }
}
