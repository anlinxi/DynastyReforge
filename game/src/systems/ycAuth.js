/**
 * 时轮密钥验证模块（防倒卖加固 · 精简版）
 *
 * 模型（用户拍板定稿）：
 *  - 凭证纯内存（模块级变量），刷新/关页即失效，每次进入游戏强制重新输入
 *  - 无惩罚：输入错误可反复重输，无计数 / restricted / locked
 *  - 无 10 分钟周期验证；只保留「启动进入游戏」+「存/读档前」两个时机
 *  - 判定唯一依据：GET ?action=get 返回的 data（RSA-OAEP/SHA-1 密文）
 *    解密出 {ts, key} 后与输入逐字 === 比对，禁止本地预设格式
 *  - 存/读档每次触发都联网取现网密钥，与内存密钥不一致 → 弹窗重输 → 通过才放行
 *  - 断网宽限取消：连不上服务端直接提示错误，可重试
 */

// ————————————————————————————————————————————————————————————
// 内嵌 RSA 私钥（分片拼装 + 变量间接引用，提高静态检索门槛）
// 私钥只用于解密服务端公钥加密的载荷；服务端不保存私钥，泄露服务端也无密钥可窃
// ————————————————————————————————————————————————————————————
const _k0 = '-----BEGIN PRIVATE KEY-----\n';
const _k1 = 'MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQCfMFyhyhIpYmJm\n';
const _k2 = 'SDHN7FlqYndkqGY8WIf+2zxLJ0+IH0wOwj43JLbaJBctkLFmIWuaj/cHX9AnL9ux\n';
const _k3 = '6p9DZoYsjv5eqcEImXEOZOxl0BRCyLC6lv0L0mkywoGR+/dR/hmBOm+SJlqL2uiK\n';
const _k4 = 'Nd6ygISK3pqIrc4VK0DhFwWLdcGBs8lAvJJBdlTz/TqAG8aV8Cbq2a3F52jpqqb0\n';
const _k5 = 'h6Tv2Y3rYDA65+N+/Qcop7nF1+EFJSUtHM3WHP9bfKaw6n5yhZxSHPrX1Hjo2zAW\n';
const _k6 = 'C4zBMHdfZgbV4/3i//+MIrQ33BjgNdRsclWWYdB9i9mD1u4WXVZiJlvYt1vjLtPR\n';
const _k7 = 'XySt2wN9AgMBAAECggEAAl1UbLwqmdm5M8X3nuAut74HpR3TVmUuh8d8CDjummKi\n';
const _k8 = 'oGFnqn8SAFel2gkHv7yj2Un3HQLn2sko0MkUJjmVKSI7++hN7Nj60YBN3aHtu3rc\n';
const _k9 = 'FVv/NJD0KmVsj1TFX/NM3l4El+2vasREGJd4HsGF/zdBrRAcZsDHSulfMyUMhonG\n';
const _kA = 'yRB3zUWi9gq6Wu+QuzSAh2uBUQQ/VvuC61Sl8GYbkGyGs6cMF+OR8OpM9c8m4mXp\n';
const _kB = 'RvtYEOjeKqq0QJLnbzCjydczxQ5s3r0QLOJ+ioHALP3lkn+IMAiipSjqRbyQnljf\n';
const _kC = 'iS5/0nJQ10IEso9eZj4wSFJNHf9hqNG8SNKBDvjlWQKBgQDOASCo+B+u+VnnNy3Z\n';
const _kD = 'EL5RYOEY0+t+ICIF0IB21sU5EA+5CNnEy3Iegk8zFmfHftd5DIrO8ixsjVjES5eu\n';
const _kE = '/K2kE72wux0R+1DYHXvIvHmNyuaPU8rmoNBEun+daV6z93FT+kXA1NbpzSs/wrTR\n';
const _kF = 'UVHgCoDXGx0VTlM6RXDPplpJdQKBgQDF0qEFS8Heavxw6ofHJoWq4sUUBCFkmQGU\n';
const _kG = '9b0bCzgYBHzqySV6W96IGyUIo0B2WoGQU+0S726xD+fpWe7Alue5VonZtkvUL8w3\n';
const _kH = 'stETHqeEKE56Fn73+J40MBU87AWKJ78KN+p9YKFHrvM4hdU7mRlPQIlawODTQY1k\n';
const _kI = 'K+MglwiI6QKBgQCmuOLl3WpHAidwqYfBlXtyASYsIdcFTJw8eHJ/u3ICrK0M48zb\n';
const _kJ = 'KIxDhNL0Vb3IBy/8F9p/gh/R+tNMiqFITdd6Yz+yOL1eQDc9sR7tZxw5VW0jsn0U\n';
const _kK = 'CjKEbSu7CfxLSoe9n1+0oI0Oy62k/L+6aEYLPHTpolf3VlylXG3goJGRwQKBgB9f\n';
const _kL = 'yn3mh/bYjPTznVkueOCjWpJUHV+xDJktaDKT0u+sNoueHz2KuH5pn7QBAEZFEGtt\n';
const _kM = 'hBoOs0WNukA+LSmKRXIVkYNf8CLU+dSTnakkoXjKU7f1PWnimmS4g4XIARDqQNhE\n';
const _kN = 'CgKcgre1vYlnYGw1WdhB6gbktEOND/mlJD6U9ZuRAoGAVpVr4CIRRCPuMq42KZiZ\n';
const _kO = 'HSTHgAwDOBC36I97FOH4uZXUyfDxV1hjiuATEJTS3gqghUiX9s65ukc2jpFgk9gP\n';
const _kP = 'I/JAGfqjAoKrkkSu6biws/kmsan4OCkH4k/RyfyE/+qETwgd975G4JtcUh7nEdI1\n';
const _kQ = 'cRyJAhsKv00EmH9VSX3iWUU=\n';
const _kEnd = '-----END PRIVATE KEY-----\n';
const PRIVATE_KEY_PEM = [_k0, _k1, _k2, _k3, _k4, _k5, _k6, _k7, _k8, _k9, _kA, _kB, _kC, _kD, _kE, _kF, _kG, _kH, _kI, _kJ, _kK, _kL, _kM, _kN, _kO, _kP, _kQ, _kEnd].join('');

/** 接口地址分片拼装（不直接暴露完整域名串，提升逆向门槛） */
const API_BASE = ['https://', 'ychjl', '.anlinxi', '.top', '/auth/'].join('');

/** 时间戳新鲜度窗口：±5 分钟（与定稿一致） */
const TS_WINDOW_MS = 5 * 60 * 1000;

/** 内存凭证：当日密钥。刷新/关页即失效 */
let sessionKey = null;

// ————————————————————————————————————————————————————————————
// 小工具
// ————————————————————————————————————————————————————————————

/** PEM → ArrayBuffer（去掉头尾与换行，Base64 解码） */
function pemToArrayBuffer(pem) {
  const b64 = pem
    .replace('-----BEGIN PRIVATE KEY-----', '')
    .replace('-----END PRIVATE KEY-----', '')
    .replace(/\s+/g, '');
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
  return bytes.buffer;
}

/** Base64 字符串 → ArrayBuffer */
function base64ToArrayBuffer(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
  return bytes.buffer;
}

/** 黑底白字输入弹窗；返回用户输入文本（不显示任何服务器地址） */
function showKeyPrompt(message) {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.style.cssText = [
      'position:fixed', 'inset:0', 'z-index:2147483000',
      'background:#000', 'display:flex', 'flex-direction:column',
      'align-items:center', 'justify-content:center',
    ].join(';');

    const title = document.createElement('div');
    title.textContent = '输入时轮密钥';
    title.style.cssText = 'color:#fff;font-size:22px;font-family:serif;letter-spacing:4px;margin-bottom:14px;';

    const hint = document.createElement('div');
    hint.textContent = message || ' ';
    hint.style.cssText = 'color:#e77;font-size:14px;font-family:serif;min-height:18px;margin-bottom:12px;';

    const input = document.createElement('input');
    input.type = 'text';
    input.autocomplete = 'off';
    input.style.cssText = [
      'width:min(320px,70vw)', 'padding:9px 12px',
      'background:#111', 'color:#fff', 'border:1px solid #666',
      'font-size:16px', 'text-align:center', 'outline:none',
    ].join(';');

    const btn = document.createElement('button');
    btn.textContent = '确认';
    btn.style.cssText = [
      'margin-top:16px', 'padding:9px 36px', 'background:#222',
      'color:#fff', 'border:1px solid #888', 'font-size:16px', 'cursor:pointer',
    ].join(';');

    const done = () => {
      const value = input.value.trim();
      if (!value) return;
      document.body.removeChild(overlay);
      resolve(value);
    };
    btn.onclick = done;
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') done(); });
    overlay.appendChild(title);
    overlay.appendChild(hint);
    overlay.appendChild(input);
    overlay.appendChild(btn);
    document.body.appendChild(overlay);
    input.focus();
  });
}

// ————————————————————————————————————————————————————————————
// 核心：联网取当日密钥（解密 + 时间戳校验）
// ————————————————————————————————————————————————————————————

/**
 * GET /auth/?action=get → Base64 密文 → RSA-OAEP(SHA-1) 解密 → { ts, key }
 * 校验时间戳 |now - ts| ≤ 5 分钟；超窗抛错（调用方可提示重试）
 * @returns {Promise<{ts:number, key:string}>}
 */
async function fetchRemoteKey() {
  const resp = await fetch(`${API_BASE}?action=get`, { cache: 'no-store' });
  if (!resp.ok) throw new Error(`取钥请求失败：HTTP ${resp.status}`);
  const json = await resp.json();
  if (json?.code !== '200' || typeof json?.data !== 'string' || !json.data) {
    throw new Error(`服务端返回异常：${json?.msg ?? '未知错误'}`);
  }
  const key = await crypto.subtle.importKey(
    'pkcs8',
    pemToArrayBuffer(PRIVATE_KEY_PEM),
    { name: 'RSA-OAEP', hash: 'SHA-1' },
    false,
    ['decrypt'],
  );
  const decrypted = await crypto.subtle.decrypt(
    { name: 'RSA-OAEP' },
    key,
    base64ToArrayBuffer(json.data),
  );
  const payload = JSON.parse(new TextDecoder().decode(decrypted));
  if (typeof payload?.ts !== 'number' || typeof payload?.key !== 'string' || !payload.key) {
    throw new Error('密钥载荷非法');
  }
  if (Math.abs(Date.now() - payload.ts * 1000) > TS_WINDOW_MS) {
    throw new Error('密钥已过期，请重新获取');
  }
  return { ts: payload.ts, key: payload.key };
}

// ————————————————————————————————————————————————————————————
// 验证流程（启动 / 存读档共用）
// ————————————————————————————————————————————————————————————

/**
 * 完整校验循环：
 * 1. 联网取现网密钥
 * 2. 与内存 sessionKey 逐字 === 比对，一致 → 放行
 * 3. 不一致 / 无内存凭证 → 弹窗输入（可反复重输，无惩罚）
 * 4. 断网 / 服务端异常 → 提示错误，短暂停顿后重试
 * @returns {Promise<true>} 通过后始终返回 true
 */
async function verifyLoop(message) {
  let msg = message || '';
  for (;;) {
    let remote;
    try {
      remote = await fetchRemoteKey();
    } catch (err) {
      console.warn('[时轮密钥] 联网取钥失败：', err?.message ?? err);
      msg = '无法连接验证服务，请重试';
      await new Promise((r) => setTimeout(r, 900));
      continue;
    }
    if (sessionKey !== null && sessionKey === remote.key) return true;
    const entered = await showKeyPrompt(msg);
    if (entered !== remote.key) {
      sessionKey = null;
      msg = '密钥与当日密钥不一致，请重新输入';
      continue;
    }
    sessionKey = entered;
    return true;
  }
}

// ————————————————————————————————————————————————————————————
// 对外接口
// ————————————————————————————————————————————————————————————

/**
 * 启动强制验证：页面加载后调用，未通过不放行进入游戏。
 * 仅供 main.js 在拉起 Phaser 前调用一次。
 */
export function installAuthGate() {
  return verifyLoop();
}

/**
 * 存/读档等关键操作前的闸门：每次触发都联网取现网密钥，
 * 与内存密钥比对；不一致弹窗重输，未通过不放行。
 */
export function authGate() {
  return verifyLoop();
}

/** 仅调试用：查看当前是否已通过验证（不暴露密钥本身） */
export function isAuthed() {
  return sessionKey !== null;
}
