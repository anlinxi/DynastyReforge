/** 原程序433950 mode9：浅色左右边、深色字心；禁止再次乘墨色tint。 */
import { FONT_KEY, DIALOGUE_FONT_KEY } from '../config.js';
export function menuFont(tint = 0x3a2418) {
  return [0xb91f0f, 0xff0000, 0x8b2b1d, 0x8c2f24].includes(tint) ? `${FONT_KEY}-red` : DIALOGUE_FONT_KEY;
}
export function menuInk(text, tint) {
  return text.setFont(menuFont(tint)).clearTint();
}
