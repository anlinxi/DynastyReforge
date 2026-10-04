/**
 * Big5 编解码。**只为写存档而存在。**
 *
 * ## 为什么要自己写
 *
 * 浏览器的 `TextDecoder('big5')` 是标配，但 **`TextEncoder` 只会 UTF-8** ——
 * 规范里就没有别的编码。而写 `.TSF` 存档必须写 Big5：存档名存的是**地名**
 * （「蘭州城」「西域遼疆」），要和原作双向兼容就不能换编码。
 *
 * ## 反向表是**推出来的**，不是抄的
 *
 * 不引第三方库、也不额外背一张几万条的映射表 —— 直接拿 `TextDecoder`
 * 把 Big5 的全部合法双字节组合解一遍，反过来建 Unicode→Big5 的表。
 * 这样表的正确性由浏览器自己的编码表担保，**不会与解码那一半漂移**。
 *
 * 代价是首次编码时要跑约两万次解码。所以**惰性建表**：不写存档就不建。
 * 实测建一次几十毫秒，而且只在第一次存档时发生。
 */

/** 双字节区的首字节范围。 */
const LEAD_MIN = 0x81;
const LEAD_MAX = 0xFE;
/** 次字节的两段。中间 `0x7F~0xA0` 是空洞。 */
const TRAIL_RANGES = Object.freeze([[0x40, 0x7E], [0xA1, 0xFE]]);

/** 编不出来的字用它顶替，并留一行日志。 */
const FALLBACK = 0x3F;      // '?'

let reverse = null;

/** Unicode 字符 → Big5 双字节码。**惰性建表**，见文件头。 */
function reverseTable() {
  if (reverse) return reverse;
  reverse = new Map();
  // fatal:true 才能把非法组合区分出来 —— 否则它们会静默变成 U+FFFD，
  // 于是「一个替换字符」会占掉一个真字的位置。
  const decoder = new TextDecoder('big5', { fatal: true });
  const pair = new Uint8Array(2);
  for (let lead = LEAD_MIN; lead <= LEAD_MAX; lead += 1) {
    for (const [lo, hi] of TRAIL_RANGES) {
      for (let trail = lo; trail <= hi; trail += 1) {
        pair[0] = lead;
        pair[1] = trail;
        let ch;
        try {
          ch = decoder.decode(pair);
        } catch {
          continue;                       // 非法组合，跳过
        }
        if (ch.length !== 1) continue;
        // ⚠️ **先到先得**。Big5 里有重复编码的字（同一个字两个码位），
        // 取靠前的那个 —— 原作用的就是常用区，不是相容区。
        if (!reverse.has(ch)) reverse.set(ch, (lead << 8) | trail);
      }
    }
  }
  return reverse;
}

/**
 * Big5 字节 → 字符串。**遇到 `\0` 就停** —— 存档里名字后面是上次的残渣。
 *
 * @param {Uint8Array} bytes
 */
export function decodeBig5(bytes) {
  let end = bytes.indexOf(0);
  if (end < 0) end = bytes.length;
  // fatal:false：残渣里可能有非法字节，宁可出现替换字符也不要整个抛掉。
  return new TextDecoder('big5').decode(bytes.subarray(0, end));
}

/**
 * 字符串 → Big5 字节。**不含结尾的 `\0`**，由调用方决定要不要补。
 *
 * 编不出来的字（简体字、Big5 里没有的字）会退成 `?` 并留一行日志 ——
 * 静默替换的话，存档名会莫名其妙少几个字而看不出原因。
 */
export function encodeBig5(text) {
  const table = reverseTable();
  const out = [];
  const missing = [];
  for (const ch of String(text ?? '')) {
    const code = ch.codePointAt(0);
    if (code < 0x80) {                    // ASCII 直通
      out.push(code);
      continue;
    }
    const big5 = table.get(ch);
    if (big5 === undefined) {
      missing.push(ch);
      out.push(FALLBACK);
      continue;
    }
    out.push(big5 >> 8, big5 & 0xFF);
  }
  if (missing.length) {
    console.warn(`Big5 编不出这些字，已用 ? 顶替：${missing.join('')}`
      + '（字库是繁体，简体字要先转繁）');
  }
  return Uint8Array.from(out);
}
