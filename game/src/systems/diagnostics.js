/**
 * 诊断模式（游戏页面一侧）：用户实玩时后台收集卡顿、内存、贴图、音效等数据（2026-10-03 用户要求：
 * 「我来玩，你实时监控」，查桌面版久玩卡顿、鼠标卡、技能没音效）。
 *
 * 平时只登记 `window.__ycDiag` 这个入口，**不采样、不挂钩**，对正常游戏零开销；
 * 桌面版以 `YC_DIAG=1` 启动时由主进程调 `start()`，之后每秒调一次 `drain()` 取走这一秒的数据写日志
 * （见 desktop/diagnostics.cjs）。F8 小面板、F9 标记也由主进程转过来。
 */

const LONG_TASK_MS = 50;
const TEXTURE_EVERY_N = 5; // 贴图统计每 5 秒一次（遍历几百张贴图，不必每秒）

/** 帧间隔统计。纯函数。 */
export function frameStats(deltas) {
  if (!deltas.length) return { frames: 0, p50: 0, p95: 0, max: 0, over50: 0 };
  const sorted = [...deltas].sort((a, b) => a - b);
  const pct = (p) => Math.round(sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))]);
  return {
    frames: deltas.length,
    p50: pct(0.5),
    p95: pct(0.95),
    max: Math.round(sorted.at(-1)),
    over50: deltas.filter((d) => d > LONG_TASK_MS).length,
  };
}

/** 贴图键 → 类别。纯函数。 */
export function textureCategory(key) {
  if (/^yc24|^font/.test(key)) return '字库';
  if (/^menu-/.test(key)) return '菜单';
  if (/portrait|^F-|^TALK/i.test(key)) return '立绘对话框';
  if (/^(ATT|EFF|MIS|RED|HIT|MOV|DEF|DIE|STD|FLR|ITF|stone|SKL|BTL|WIN|HURT|CAST|MAG)/i.test(key)) return '战斗';
  if (/^MP\d/i.test(key)) return '地图';
  return '其他';
}

function textureTally(game) {
  const cats = {};
  let total = 0;
  let count = 0;
  for (const [key, tex] of Object.entries(game.textures.list)) {
    if (key.startsWith('__')) continue;
    let bytes = 0;
    for (const s of tex.source ?? []) bytes += (s.width || 0) * (s.height || 0) * 4;
    const c = textureCategory(key);
    cats[c] = (cats[c] ?? 0) + bytes;
    total += bytes;
    count += 1;
  }
  const mb = (v) => Math.round(v / 1048576);
  return { count, mb: mb(total), cats: Object.fromEntries(Object.entries(cats).map(([k, v]) => [k, mb(v)])) };
}

function gameState(game) {
  const active = game.scene.getScenes(true).map((s) => s.scene.key);
  const field = game.scene.getScene('Field');
  const battle = game.scene.getScene('Battle');
  return {
    scenes: active,
    map: field?.mapId ?? null,
    pos: field?.playerPos ? [Math.round(field.playerPos.x), Math.round(field.playerPos.y)] : null,
    running: game.registry.get('running') === true,
    battle: battle?.scene.isActive() ? { phase: battle.phase ?? null, stage: battle.stage ?? null, swarm: battle.swarm ?? null } : null,
    // 开着的整屏界面：菜单（哪一页）、商店、客栈
    ui: field?.statusScreen?.visible ? `菜单:${field.statusScreen.page?.key ?? '?'}`
      : field?.shopScreen?.visible ? '商店' : field?.innScreen?.visible ? '客栈' : null,
    sounds: game.sound?.sounds?.length ?? null,
    // 音效通道（running/suspended）、Phaser 认为是否失焦、窗口是否有焦点、页面是否隐藏：查「整局音效不响」
    audio: game.sound?.context?.state ?? null,
    lostFocus: game.sound?.gameLostFocus ?? null,
    focus: document.hasFocus(),
    hidden: document.hidden,
  };
}

/**
 * 登记入口。只在这里挂 `window.__ycDiag`，真正开始采样要等 `start()`。
 * @param {Phaser.Game} game
 */
export function installDiagnostics(game) {
  if (typeof window === 'undefined') return;
  let started = false;
  let deltas = [];
  let longTasks = [];
  let plays = [];
  let missing = [];
  let warnings = [];
  let tick = 0;
  let resizes = { renderer: 0, refresh: 0, last: null };
  let overlay = null;
  let lastProc = null;

  const record = (list, item, cap = 200) => { if (list.length < cap) list.push(item); };

  function hookSound() {
    const sound = game.sound;
    if (!sound || sound.__ycDiagHooked) return;
    sound.__ycDiagHooked = true;
    const exists = (key) => game.cache.audio.exists(key);
    for (const name of ['play', 'add']) {
      const original = sound[name].bind(sound);
      sound[name] = (key, ...rest) => {
        const k = typeof key === 'string' ? key : key?.key;
        // 只在 add 记播放：play(key) 内部也走 add；游戏音效（playSfx）是先 add 再 play
        if (name === 'add') record(plays, k);
        if (k && !exists(k)) record(missing, `${name}:${k}`);
        return original(key, ...rest);
      };
    }
  }

  /** 数画布重设与 Phaser 重排次数（查“尺寸没变却反复重设”的循环），并记下当时的尺寸。 */
  function hookResize() {
    const r = game.renderer;
    if (!r?.resize || r.__ycDiagHooked) return;
    r.__ycDiagHooked = true;
    const resize = r.resize;
    r.resize = (w, h) => {
      resizes.renderer += 1;
      const box = document.getElementById('game')?.getBoundingClientRect();
      const c = game.canvas.getBoundingClientRect();
      resizes.last = `逻辑${w}x${h} 画布${game.canvas.width}x${game.canvas.height} 显示${c.x.toFixed(2)},${c.y.toFixed(2)},${c.width.toFixed(2)}x${c.height.toFixed(2)}`
        + (box ? ` 外层${box.width.toFixed(2)}x${box.height.toFixed(2)}` : '');
      return resize(w, h);
    };
    const refresh = game.scale.refresh.bind(game.scale);
    game.scale.refresh = (...a) => { resizes.refresh += 1; return refresh(...a); };
  }

  function hookConsole() {
    for (const level of ['warn', 'error']) {
      const original = console[level].bind(console);
      console[level] = (...args) => {
        record(warnings, `${level}: ${args.map((a) => (a instanceof Error ? a.message : String(a))).join(' ').slice(0, 200)}`, 50);
        original(...args);
      };
    }
  }

  function updateOverlay(page) {
    if (!overlay || overlay.hidden) return;
    const f = page.frame;
    const proc = lastProc ? `CPU 画面${lastProc.renderer}% 显卡${lastProc.gpu}% · 内存 画面${lastProc.rendererMB}MB 显卡${lastProc.gpuMB}MB` : '';
    overlay.textContent = `帧 ${f.frames}/秒 p95 ${f.p95}ms 最长 ${f.max}ms 卡顿 ${page.longTasks.length}`
      + ` · 堆 ${page.heapMB ?? '?'}MB${page.textures ? ` · 贴图 ${page.textures.mb}MB/${page.textures.count}张` : ''}`
      + (proc ? `\n${proc}` : '');
  }

  window.__ycDiag = {
    start() {
      if (started) return true;
      started = true;
      let last = performance.now();
      const loop = (t) => { deltas.push(t - last); last = t; requestAnimationFrame(loop); };
      requestAnimationFrame(loop);
      try {
        new PerformanceObserver((list) => {
          for (const e of list.getEntries()) record(longTasks, [Math.round(e.startTime), Math.round(e.duration)]);
        }).observe({ type: 'longtask', buffered: false });
      } catch { /* 不支持长任务统计的环境就不记 */ }
      hookSound();
      hookConsole();
      hookResize();
      return true;
    },
    /** 取走这一秒的数据（主进程每秒调一次）。 */
    drain() {
      tick += 1;
      const page = {
        frame: frameStats(deltas),
        longTasks,
        heapMB: performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1048576) : null,
        state: gameState(game),
        plays,
        missing,
        warnings,
        textures: tick % TEXTURE_EVERY_N === 1 ? textureTally(game) : null,
        resizes: resizes.renderer || resizes.refresh ? resizes : null,
      };
      deltas = []; longTasks = []; plays = []; missing = []; warnings = [];
      resizes = { renderer: 0, refresh: 0, last: null };
      updateOverlay(page);
      return page;
    },
    /** 主进程送来的进程数据，只用于小面板显示。 */
    setProc(proc) { lastProc = proc; },
    toggleOverlay() {
      if (!overlay) {
        overlay = document.createElement('div');
        Object.assign(overlay.style, {
          position: 'fixed', left: '8px', top: '8px', zIndex: '10002', pointerEvents: 'none', whiteSpace: 'pre',
          font: '12px/1.4 Menlo, monospace', color: '#e8e8e8', background: 'rgba(0,0,0,0.6)', padding: '4px 8px',
        });
        overlay.textContent = '诊断模式：数据每秒更新';
        document.body.append(overlay);
        return true;
      }
      overlay.hidden = !overlay.hidden;
      return !overlay.hidden;
    },
  };
}
