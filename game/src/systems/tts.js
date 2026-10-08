/**
 * 对话语音 TTS 播放（需求文档 §4.2 / §6 / §7 落地）。
 *
 * 职责：
 * - `synthesize(text, voice)`：请求开发期后端（CORS 已放行），解析 `resp.data.audioBase64`
 *   （§2.1 实测响应 `{code, msg, data:{audioBase64}}`）为 Blob URL，本地 Map 缓存 LRU ≤ 200。
 * - `playLine(text, speaker)`：按说话人声线播一句对白；开关关掉时不播；静默失败不打断游戏。
 * - `stopTts()`：停当前语音；并用序号让「上一句还没回来的异步合成结果」作废。
 * - `prewarmMap(scripts)`：进图时对当前图 `say` 脚本预合成（并发 2、单图限流 60），
 *   避免玩家开口第一句等首响。
 *
 * ⚠️ 只做「播/停」，不碰 Phaser 音效通道；与 bgm.js（原生 Audio）同级，靠
 * `backgroundAudio.js` 的页面失焦钩子一起停。
 */
import { Converter } from 'opencc-js';
import { TTS_CONFIG } from '../config.js';
import { ttsEnabled } from './ttsSettings.js';
import { voiceFor } from '../data/ttsVoiceMap.js';

/** 本地语音缓存（key = voice:speed:text → Blob URL），LRU 上限见 TTS_CONFIG.REQUEST_CACHE_LIMIT。 */
const TTS_CACHE = new Map();

let currentAudio = null;
/** 播放序号：每次 playLine/stopTts 递增，异步合成回来对不上号就丢弃（快进/切句竞态）。 */
let playSeq = 0;
let volume = 1.0;

/** 繁→简转换（OpenCC tw→cn）。后台音色按普通话简体发音，繁体文本朗读会出错（已实测确认），统一转简体再合成；缓存 key 用转换后文本，简繁同文命中同一缓存。
 * 选 tw→cn 而非 t→cn：t→cn 漏掉台式助词「著」（帶著→带著 不转「着」），后台会误读 zhù；tw→cn 可覆盖（帶著→带着、執著→执着）。
 * 再补两个词表都不处理的字形：妳→你；tw→cn 会把「卓著/巨著」误转成「卓着/巨着」，反修回简体正确写法。 */
const tw2cn = Converter({ from: 'tw', to: 'cn' });
const toSimplified = (s) => tw2cn(s)
  .replace(/妳/g, '你')
  .replace(/卓着/g, '卓著')
  .replace(/巨着/g, '巨著');

/**
 * 台词清洗：
 * - `\u0001` 是原作句内换行（导出时保留），替成逗号停顿，朗读不哽住（可改常量换句号/顿号）；
 * - `=b / =r / =0` 是强调色标记（dialogueText.js 的 markdown 式旁注），朗读会读成乱码，剥掉；
 * - 去掉台词首尾的「」引号（主人要求：归一化时一并去掉，朗读更自然且利于缓存归一）；
 * - 最后统一转简体（见上方注释）。
 */
function cleanText(text) {
  return toSimplified(String(text ?? '')
    .replace(/\u0001/g, '，')
    .replace(/=b|=r|=0/g, '')
    .replace(/「|」/g, '')
    .trim());
}

/** LRU：命中提尾；超限淘汰最久未用的 Blob URL。 */
function cacheSet(key, url) {
  if (TTS_CACHE.has(key)) TTS_CACHE.delete(key);
  TTS_CACHE.set(key, url);
  while (TTS_CACHE.size > TTS_CONFIG.REQUEST_CACHE_LIMIT) {
    const oldest = TTS_CACHE.keys().next().value;
    const oldUrl = TTS_CACHE.get(oldest);
    TTS_CACHE.delete(oldest);
    try { URL.revokeObjectURL(oldUrl); } catch { /* 静默 */ }
  }
}

/**
 * 合成一条语音（并缓存）。任何失败都静默返回 null —— 游戏照常跑，顶多是没声音。
 * @param {string} text 已清洗文本
 * @param {string} voice '中文男' / '中文女'（服务实测音色 id）
 * @param {number} [speed]
 * @returns {Promise<string|null>} Blob URL
 */
export async function synthesize(text, voice, speed = TTS_CONFIG.SPEED) {
  const clean = cleanText(text);
  if (!clean) return null;
  const key = `${voice}:${speed}:${clean}`;
  if (TTS_CACHE.has(key)) return TTS_CACHE.get(key);
  try {
    const resp = await fetch(`${TTS_CONFIG.API_BASE}/synthesize`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: clean, voice, speed, format: TTS_CONFIG.FORMAT }),
    });
    if (!resp.ok) return null;
    const json = await resp.json();
    const b64 = json?.data?.audioBase64;
    if (!b64) return null;
    const binary = atob(b64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    const url = URL.createObjectURL(new Blob([bytes], { type: `audio/${TTS_CONFIG.FORMAT}` }));
    cacheSet(key, url);
    return url;
  } catch {
    return null;
  }
}

/**
 * 播一句对白。开关关掉、文本空、合成失败都不出声且不抛错。
 * @param {string} text 原始台词（含换行/色标）
 * @param {number} speaker 说话人代码（0=旁白）
 */
export function playLine(text, speaker) {
  if (!ttsEnabled()) return;
  stopTts();
  const clean = cleanText(text);
  if (!clean) return;
  const seq = playSeq;
  const voice = voiceFor(speaker);
  synthesize(clean, voice).then((url) => {
    if (!url || seq !== playSeq) return;
    try {
      const audio = new Audio(url);
      audio.volume = volume;
      currentAudio = audio;
      audio.play().catch(() => { /* 浏览器自动播放拦截等，静默 */ });
    } catch { /* 静默 */ }
  });
}

/** 停当前语音，并作废尚未返回的合成请求（advance/ask/hide/切句/失焦都会调）。 */
export function stopTts() {
  playSeq += 1;
  if (!currentAudio) return;
  try { currentAudio.pause(); } catch { /* 静默 */ }
  currentAudio = null;
}

/** 音量（0~1），配套 titleOptions 的「语音音量」可留待后续。 */
export function ttsVolume(next) {
  if (typeof next === 'number') {
    volume = next;
    if (currentAudio) { try { currentAudio.volume = volume; } catch { /* 静默 */ } }
  }
  return volume;
}

/**
 * 进图预合成：收集当前图全部 `say` 脚本的文本，按声线去重，并发预合成。
 * 静默失败、超限截断，绝不阻塞进图。
 * @param {object} scripts map.json 的 `scripts`（槽号 → 动作数组）
 * @returns {Promise<void>}
 */
export async function prewarmMap(scripts) {
  if (!TTS_CONFIG.PREWARM_ON_MAP_ENTER || !ttsEnabled()) return;
  const jobs = [];
  const seen = new Set();
  for (const actions of Object.values(scripts ?? {})) {
    for (const action of actions ?? []) {
      if (action?.type !== 'say') continue;
      const clean = cleanText(action.text);
      if (!clean || seen.has(clean)) continue;
      seen.add(clean);
      jobs.push({ text: clean, voice: voiceFor(action.speaker) });
      if (jobs.length >= TTS_CONFIG.PREWARM_LIMIT) break;
    }
    if (jobs.length >= TTS_CONFIG.PREWARM_LIMIT) break;
  }
  const workers = Math.min(TTS_CONFIG.PREWARM_CONCURRENCY, jobs.length);
  if (!workers) return;
  let cursor = 0;
  const run = async () => {
    while (cursor < jobs.length) {
      const job = jobs[cursor];
      cursor += 1;
      try { await synthesize(job.text, job.voice); } catch { /* 静默 */ }
    }
  };
  await Promise.all(Array.from({ length: workers }, run));
}
