/**
 * 诊断模式（桌面版主进程一侧）：用户实玩、后台实时收集（2026-10-03 用户要求，查久玩卡顿、鼠标卡、技能没音效）。
 * 以 `YC_DIAG=1` 启动才加载；不影响正常游戏。游戏页面一侧见 game/src/systems/diagnostics.js。
 *
 * 每秒写一行 JSON 到日志（默认 ~/Library/Logs/幽城幻劍錄/diag-时间.jsonl，`YC_DIAG_FILE` 可改）：
 *   各进程 CPU% 与内存（app.getAppMetrics）+ 页面这一秒的帧耗时、长任务、堆内存、贴图、游戏状态、音效播放与缺失、警告。
 * 后台一直采样 CPU（每 10 秒轮换一段，只留最近两段）。按键（拦在主进程，游戏收不到）：
 *   反斜杠 \ 或 F8：显示/隐藏左上角小面板；反引号 ` 或 F9：标记“刚才卡了”，5 秒后把前后约 20 秒的 CPU 采样
 *   存成 .cpuprofile 并写热点摘要（触控栏 MacBook 没有实体 F 键，2026-10-03 用户）。
 */
const fs = require('node:fs');
const path = require('node:path');

const ROTATE_MS = 10000;
const AFTER_MARK_MS = 5000;

/** CPU 采样的自身耗时排行（前 12）。 */
function hotFunctions(profile) {
  const self = new Map();
  const byId = new Map(profile.nodes.map((n) => [n.id, n]));
  const { samples = [], timeDeltas = [] } = profile;
  for (let i = 0; i < samples.length; i += 1) {
    const cf = byId.get(samples[i])?.callFrame;
    if (!cf) continue;
    const key = `${cf.functionName || '(anon)'} ${cf.url.split('/').pop()}:${cf.lineNumber + 1}`;
    self.set(key, (self.get(key) ?? 0) + (timeDeltas[i] ?? 0));
  }
  const total = [...self.values()].reduce((a, b) => a + b, 0) || 1;
  return [...self.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12)
    .map(([k, v]) => `${(v / total * 100).toFixed(1)}% ${k}`);
}

function stamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

module.exports = function startDiagnostics(win, app) {
  const file = process.env.YC_DIAG_FILE || path.join(app.getPath('logs'), `diag-${stamp()}.jsonl`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const dir = path.dirname(file);
  const base = path.basename(file, '.jsonl');
  const write = (obj) => fs.appendFileSync(file, `${JSON.stringify({ t: Date.now(), ...obj })}\n`);
  console.log(`YC_DIAG 日志：${file}`);
  write({ kind: 'start', versions: process.versions, gpu: app.getGPUFeatureStatus() });

  const wc = win.webContents;
  const js = (code) => wc.executeJavaScript(code).catch(() => null);

  // ———— 每秒：进程 + 页面 ————
  const timer = setInterval(async () => {
    if (win.isDestroyed()) { clearInterval(timer); return; }
    const proc = app.getAppMetrics().map((m) => ({
      type: m.type, pid: m.pid, cpu: Math.round(m.cpu.percentCPUUsage), mb: Math.round(m.memory.workingSetSize / 1024),
    }));
    const pick = (type) => proc.find((p) => p.type === type) ?? {};
    const summary = { renderer: pick('Tab').cpu ?? '?', rendererMB: pick('Tab').mb ?? '?', gpu: pick('GPU').cpu ?? '?', gpuMB: pick('GPU').mb ?? '?' };
    await js(`window.__ycDiag?.setProc(${JSON.stringify(summary)}); true`);
    const page = await js('window.__ycDiag?.drain() ?? null');
    write({ kind: 'sec', proc, page });
  }, 1000);

  wc.on('did-finish-load', () => { js('window.__ycDiag?.start()'); write({ kind: 'load' }); });
  wc.on('render-process-gone', (_e, details) => write({ kind: 'gone', details }));

  // ———— CPU 采样：一直开着，每 10 秒轮换，保留最近两段 ————
  const dbg = wc.debugger;
  let prev = null;
  let profiling = false;
  let rotating = Promise.resolve();
  const send = (method, params) => dbg.sendCommand(method, params);
  async function startProfile() {
    await send('Profiler.start');
    profiling = true;
  }
  async function stopProfile() {
    if (!profiling) return null;
    profiling = false;
    const { profile } = await send('Profiler.stop');
    return profile;
  }
  async function attach() {
    try {
      dbg.attach('1.3');
      await send('Profiler.enable');
      await send('Profiler.setSamplingInterval', { interval: 1000 }); // 1 毫秒一采样
      await startProfile();
    } catch (err) {
      write({ kind: 'warn', msg: `CPU 采样开不了：${err.message}` });
    }
  }
  attach();
  const rotateTimer = setInterval(() => {
    rotating = rotating.then(async () => {
      if (!dbg.isAttached()) return;
      const p = await stopProfile().catch(() => null);
      if (p) prev = p;
      await startProfile().catch(() => {});
    });
  }, ROTATE_MS);

  // ———— 按键：F8 面板、F9 标记 ————
  let marks = 0;
  wc.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return;
    // 触控栏 MacBook 没有实体 F 键：反引号（esc 下方）＝标记，反斜杠＝面板；按键位判断，中文输入法下也有效
    if (input.key === 'F8' || input.code === 'Backslash') {
      event.preventDefault();
      js('window.__ycDiag?.toggleOverlay()');
    } else if (input.key === 'F9' || input.code === 'Backquote') {
      event.preventDefault();
      marks += 1;
      const n = marks;
      write({ kind: 'mark', n });
      js(`(() => { const o = document.createElement('div'); o.textContent = '已标记 #${n}，正在保存前后约 20 秒的数据';
        Object.assign(o.style, {position:'fixed',right:'12px',top:'12px',zIndex:'10003',font:'14px sans-serif',color:'#fff',
        background:'rgba(160,30,30,0.85)',padding:'6px 10px',pointerEvents:'none'}); document.body.append(o);
        setTimeout(() => o.remove(), 3000); return true; })()`);
      setTimeout(() => {
        rotating = rotating.then(async () => {
          if (!dbg.isAttached()) return;
          const cur = await stopProfile().catch(() => null);
          const parts = [prev, cur].filter(Boolean);
          parts.forEach((p, i) => fs.writeFileSync(path.join(dir, `${base}-mark${n}-${i}.cpuprofile`), JSON.stringify(p)));
          write({ kind: 'markProfile', n, files: parts.length, hot: parts.map(hotFunctions) });
          prev = cur;
          await startProfile().catch(() => {});
        });
      }, AFTER_MARK_MS);
    }
  });

  win.on('closed', () => { clearInterval(timer); clearInterval(rotateTimer); write({ kind: 'end' }); });

  // 自查（YC_DIAG_SELFTEST=1，配合 YC_HIDE_WINDOW）：12 秒时模拟按 F9，25 秒后退出
  if (process.env.YC_DIAG_SELFTEST) {
    setTimeout(() => wc.sendInputEvent({ type: 'keyDown', keyCode: 'F9' }), 12000);
    setTimeout(() => app.quit(), 25000);
  }
};
