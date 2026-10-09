/**
 * 防倒卖正版验证门（authGate）。
 *
 * 职责：在游戏开始前、读档/存档关键点、以及每 10 分钟的周期里，向验证服务
 * （http://ychjl.anlinxi.top/auth/）校验当日密钥，并在失败时按「放宽版惩罚」
 * 分级处理（1 次静默重试 / 2–3 次提示 / 4 次受限 / 5 次强制回标题）。
 *
 * 机制（对应《幽城幻剑录防倒卖验证方案》v2.0 定稿 D1–D12）：
 *   - 每日首验 + 离线容忍（D1）：当日 `get` 取钥成功即写入本地凭证
 *     （localStorage），当天后续验证超时/断网时跳过 verify 直接放行
 *     （本地弱校验密钥格式与内嵌日期）；
 *   - 跨日强制重取：本地日期与凭证日期不一致 → 凭证作废，下一次验证强制联网重取；
 *   - 双定时器哨兵：主定时器每 10 分钟验证一次，哨兵定时器检查心跳，
 *     发现主定时器被停就补跑一次，防止单一定时器被删后完全失效（D4）；
 *   - 前台切回补检：页面从后台切回前台立即补一次校验；
 *   - 宽限期（D11 B）：未联网首验失败时允许进入游戏，但存/读档被 gateGuard 拦下。
 *
 * 惩罚状态写入 localStorage（刷新不清除，2.6），跨日随密钥轮换自动归零。
 * 本模块不 import 任何游戏内部模块，避免循环依赖；UI 提示用「系统字体黑底」
 * 全屏文本（D10），由调用方传入的 Phaser 场景负责渲染。
 */

// 验证服务地址。拆开拼是为了让构建产物里不出现完整的 `/auth/` 字面量。
const AUTH_HOST = 'http://ychjl.anlinxi.top';
const AUTH_DIR = ['a', 'uth', '/'].join('');
const BASE_URL = AUTH_HOST + '/' + AUTH_DIR; // http://ychjl.anlinxi.top/auth/

const STORAGE_KEY = 'ycAuth.v2.credential';     // 当日凭证
const PENALTY_KEY = 'ycAuth.v2.penalty';        // 惩罚状态（刷新不清除）
const PERIODIC_MS = 10 * 60 * 1000;             // 周期验证间隔（10 分钟）
const WATCHDOG_MS = PERIODIC_MS + 5 * 60 * 1000; // 哨兵：正常心跳远小于它
const GRACE_TRIES = 3;                          // 宽限期允许的重试次数
const GRACE_WINDOW_MS = 5 * 60 * 1000;          // 宽限期窗口（5 分钟）
const FETCH_TIMEOUT_MS = 5000;                  // 验证请求超时

/** 密钥格式：`YOUCHENG + YYYYMMDD + 后缀`（实测见方案 2.2）。 */
const KEY_PATTERN = /^YOUCHENG\d{8}[A-Za-z0-9]*$/;

// 运行态
const state = {
  verified: false,        // 当日凭证当前是否有效（false 时存/读档被 gateGuard 拦下）
  failCount: 0,           // 连续验证失败次数（同日累计，跨日归零）
  restricted: false,      // 受限模式（4 次失败后开启，禁存/读档）
  locked: false,          // 疑似非正版（5 次失败或密钥无效后开启）
  graceTries: 0,          // 宽限期内已用重试次数
  graceUntil: 0,          // 宽限期截止时间戳
  lastPeriodicAt: 0,      // 上一次周期验证开始时间戳（哨兵看它）
  lastScene: null,        // 最近一次传入的场景（用于提示/回标题）
  watchStarted: false,    // 周期验证是否已启动（防重入）
  noticeText: null,       // 当前显示中的提示文本对象
};

/** 本地当日日期串 YYYYMMDD。 */
function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
}

/** 密钥内嵌日期（第 9–16 位 YYYYMMDD）。 */
function keyDate(key) { return key.slice(9, 17); }

function loadCred() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}
function saveCred(key) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ date: todayStr(), key, gotAt: Date.now() }));
  } catch { /* 存储不可用时只影响离线容忍，不致命 */ }
}
function clearCred() {
  try { localStorage.removeItem(STORAGE_KEY); } catch { /* 同上 */ }
}

function loadPenalty() {
  try {
    const raw = localStorage.getItem(PENALTY_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}
function savePenalty() {
  try {
    localStorage.setItem(PENALTY_KEY, JSON.stringify({
      date: todayStr(),
      failCount: state.failCount,
      restricted: state.restricted,
      locked: state.locked,
    }));
  } catch { /* 同上 */ }
}
function clearPenalty() {
  try { localStorage.removeItem(PENALTY_KEY); } catch { /* 同上 */ }
  state.failCount = 0;
  state.restricted = false;
  state.locked = false;
}
/** 模块加载时恢复惩罚状态；跨日自动归零。 */
function restorePenalty() {
  const p = loadPenalty();
  if (!p || p.date !== todayStr()) { clearPenalty(); return; }
  state.failCount = p.failCount || 0;
  state.restricted = !!p.restricted;
  state.locked = !!p.locked;
}

/** 带超时的 JSON 请求。网络层错误抛 {kind:'net'}；业务层错误抛 {kind:'bad'}。 */
async function fetchJson(url) {
  let res;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
    res = await fetch(url, { signal: ctrl.signal, cache: 'no-store' });
    clearTimeout(timer);
  } catch {
    const e = new Error('验证服务连接失败');
    e.kind = 'net';
    throw e;
  }
  if (!res.ok) {
    const e = new Error(`验证服务响应异常（HTTP ${res.status}）`);
    e.kind = 'bad';
    throw e;
  }
  let json;
  try { json = await res.json(); } catch {
    const e = new Error('验证服务响应不是合法 JSON');
    e.kind = 'bad';
    throw e;
  }
  if (!json || typeof json.code !== 'string') {
    const e = new Error('验证服务响应缺少 code 字段');
    e.kind = 'bad';
    throw e;
  }
  return json;
}

function getKeyUrl() { return `${BASE_URL}?action=get`; }
function verifyUrl(key) { return `${BASE_URL}?action=verify&token=${encodeURIComponent(key)}`; }

/** 全屏系统字体黑底提示（D10）。同一时刻只保留一条，4 秒后自动消失。 */
function showNotice(text, scene) {
  const s = scene || state.lastScene;
  if (!s || typeof s.add !== 'function') return;
  if (state.noticeText && state.noticeText.active) state.noticeText.destroy();
  const w = s.scale?.width ?? 640;
  const h = s.scale?.height ?? 360;
  const t = s.add.text(w / 2, h / 2, text, {
    fontFamily: 'sans-serif',
    fontSize: '20px',
    color: '#ffffff',
    backgroundColor: 'rgba(0, 0, 0, 0.85)',
    align: 'center',
    wordWrap: { width: Math.max(w - 80, 120) },
  }).setOrigin(0.5).setScrollFactor(0).setDepth(99999);
  state.noticeText = t;
  s.time?.delayedCall?.(4000, () => { if (t.active) t.destroy(); });
}

/** 强制回标题页并标记「疑似非正版」（第 5 次失败 / 密钥无效）。 */
function forceBackToTitle(scene) {
  showNotice('此游戏疑似非正版，已停止运行', scene);
  const s = scene || state.lastScene;
  if (!s) return;
  setTimeout(() => {
    try {
      const g = s.scene?.game;
      const target = g?.scene?.getScenes?.(true)?.[0] ?? s;
      target.scene.start('Title');
    } catch { /* 场景可能已切走，忽略 */ }
  }, 1500);
}

/** 单次失败计数与分级（D4 放宽版）。返回是否仍可游玩。 */
function countFailure(scene) {
  state.failCount += 1;
  if (state.failCount >= 5) {
    state.restricted = true;
    state.verified = false;
    state.locked = true;
    savePenalty();
    forceBackToTitle(scene);
    return false;
  }
  if (state.failCount >= 4) {
    state.restricted = true;
    state.verified = false;
    savePenalty();
    showNotice('验证异常，存档与读档已暂停', scene);
    return false;
  }
  if (state.failCount >= 2) {
    savePenalty();
    showNotice('验证失败，正在重试', scene);
  } else {
    savePenalty(); // 第 1 次：静默重试，不打扰玩家
  }
  return true;
}

/** 每日首验/重取：联网 get 当日密钥并落凭证。失败按 kind 抛错。 */
async function fetchTodayKey() {
  const json = await fetchJson(getKeyUrl());
  const key = json.data;
  if (json.code !== '200' || typeof key !== 'string' || !KEY_PATTERN.test(key)) {
    const e = new Error('密钥格式异常');
    e.kind = 'bad';
    throw e;
  }
  if (keyDate(key) !== todayStr()) {
    const e = new Error('密钥日期与本地不一致');
    e.kind = 'bad';
    throw e;
  }
  saveCred(key);
  return key;
}

/**
 * 主校验入口：一次性验证（游戏开始前 / 周期）。
 *
 * @param {string} reason 'boot' | 'enter' | 'periodic'
 * @param {object} [ctx] 传入的 Phaser 场景（用于提示与回标题）
 * @returns {Promise<{ok:boolean, grace?:boolean, offline?:boolean, penalty?:string}>}
 */
export async function gateCheck(reason, ctx) {
  const scene = ctx || state.lastScene;
  // 跨日：凭证作废 + 惩罚归零，强制重取（2.2.4）
  const cred = loadCred();
  if (cred && cred.date !== todayStr()) { clearCred(); clearPenalty(); }
  if (state.locked) {
    forceBackToTitle(scene);
    return { ok: false, penalty: 'locked' };
  }

  const credNow = loadCred();
  const hasValidCred = !!credNow && keyDate(credNow.key) === todayStr();

  if (!hasValidCred) {
    // 今日尚未取钥 → 每日首验（D1）
    try {
      const key = await fetchTodayKey();
      // 取钥成功后再 verify 一次，确认服务端判定；网络抖动则信任 get 结果
      try {
        const v = await fetchJson(verifyUrl(key));
        if (v.code === '401') {
          clearCred();
          throw Object.assign(new Error('密钥被服务端拒绝'), { kind: 'bad' });
        }
      } catch (err) {
        if (err.kind === 'bad') throw err;
      }
      state.verified = true;
      state.restricted = false;
      state.failCount = 0;
      state.graceTries = 0;
      state.graceUntil = 0;
      savePenalty();
      return { ok: true };
    } catch (err) {
      if (err.kind === 'net') {
        // 断网/超时且无当日凭证 → 宽限期（D11 B：可进游戏，但禁存/读档）
        const now = Date.now();
        if (state.graceUntil < now) { state.graceTries = 0; state.graceUntil = now + GRACE_WINDOW_MS; }
        state.graceTries += 1;
        state.restricted = true;
        state.verified = false;
        if (state.graceTries <= GRACE_TRIES) {
          showNotice('未连接验证服务器，已进入离线宽限：可继续游玩，存档/读档暂不可用', scene);
        } else {
          showNotice('仍无法连接验证服务器，存档/读档保持暂停', scene);
        }
        return { ok: true, grace: true };
      }
      // 密钥无效 / 格式异常：计失败（疑似非正版信号）
      const alive = countFailure(scene);
      return { ok: alive, penalty: 'invalid' };
    }
  }

  // 当日已有取钥凭证 → 联网 verify 刷新；失败时离线容忍（D1）
  try {
    const v = await fetchJson(verifyUrl(credNow.key));
    if (v.code === '401') {
      // 密钥已失效：清凭证 → 重新 get → 再 verify 一次（2.2.5）
      clearCred();
      try {
        const key = await fetchTodayKey();
        const v2 = await fetchJson(verifyUrl(key));
        if (v2.code !== '200') throw Object.assign(new Error('重取后仍被拒绝'), { kind: 'bad' });
      } catch (err) {
        if (err.kind !== 'bad') {
          // 重取时网络抖动：保留刚 get 到的凭证，离线放行
          state.verified = true;
          return { ok: true, offline: true };
        }
        const alive = countFailure(scene);
        return { ok: alive, penalty: 'invalid' };
      }
      state.verified = true;
      state.restricted = false;
      state.failCount = 0;
      savePenalty();
      return { ok: true };
    }
    if (v.code !== '200') {
      const alive = countFailure(scene);
      return { ok: alive, penalty: 'invalid' };
    }
    state.verified = true;
    state.restricted = false;
    state.failCount = 0;
    savePenalty();
    return { ok: true };
  } catch (err) {
    if (err.kind === 'bad') {
      const alive = countFailure(scene);
      return { ok: alive, penalty: 'invalid' };
    }
    // 网络失败 + 有当日凭证 → 离线放行（本地弱校验已在 hasValidCred 完成）
    state.verified = true;
    return { ok: true, offline: true };
  }
}

/**
 * 同步拦截：未通过验证时抛错（存/读档汇聚点调用，D5/D6）。
 * 在 gateCheck 之前/之间均可安全调用：当日凭证有效才放行。
 */
export function gateGuard() {
  if (state.locked) {
    throw new Error('此游戏疑似非正版，存档/读档已禁用');
  }
  if (!state.verified) {
    throw new Error('正版验证未通过，存档/读档暂不可用');
  }
}

/**
 * 启动周期验证（D4）：每 10 分钟验证一次 + 双定时器哨兵 + 前台切回补检。
 * 防重入：重复调用（如 FieldScene 因资源未到 restart 重进 create）会直接忽略。
 */
export function startGateWatch(scene) {
  if (state.watchStarted) return;
  state.watchStarted = true;
  state.lastScene = scene;
  const tick = () => {
    state.lastPeriodicAt = Date.now();
    gateCheck('periodic', scene)
      .catch(() => { /* 惩罚与提示已在 gateCheck 内处理 */ });
  };
  tick(); // 进游戏立即补一次，快速暴露验证失败
  window.setInterval(tick, PERIODIC_MS);
  // 哨兵定时器：主定时器若被停（删除/覆盖），超过正常间隔即补跑
  window.setInterval(() => {
    if (Date.now() - state.lastPeriodicAt > WATCHDOG_MS) tick();
  }, WATCHDOG_MS);
  // 前台切回补检：防止「验证通过后一直挂着不触发定时器」
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && Date.now() - state.lastPeriodicAt > PERIODIC_MS / 2) tick();
  });
}

restorePenalty();
