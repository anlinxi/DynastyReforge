/*
 * 手机 App 补丁加载（PLAT-07）。构建时 vite.config.js 把页面里的程序入口换成本脚本 + 两个全局量：
 *   window.__YC_ENTRY__   App 自带的程序入口（/assets/index-xxx.js）
 *   window.__YC_VERSION__ App 自带的版本号
 *
 * 手机上 App 包内只读，补丁不能像电脑版那样直接覆盖文件（tools/make_patch.py）。做法：
 * 玩家把电脑补丁解压出的文件夹（含 game/ 与 patch.json）放进 App 存档文件夹
 * （iPhone「文稿」/ 安卓 Android/data/<包名>/files/）；启动时找版本比自带新的补丁，
 * 从补丁加载程序入口，并让读文件请求「补丁里有就用补丁的」，其余仍读 App 自带的。
 * 补丁程序加载失败退回自带版本；删掉补丁文件夹即恢复。电脑版与网页版直接加载自带入口。
 *
 * ⚠️ 本文件随完整安装包发布、补丁改不了它，所以只用最基本的写法，任何异常都退回自带版本。
 */
(function () {
  'use strict';
  var builtIn = window.__YC_ENTRY__;
  var version = window.__YC_VERSION__ || '0';

  function loadEntry(src, onFail) {
    var s = document.createElement('script');
    s.type = 'module';
    s.crossOrigin = 'anonymous';
    s.src = src;
    if (onFail) s.onerror = onFail;
    document.head.appendChild(s);
  }

  /** "1.4.10" 与 "1.4.9" 按数字逐段比。 */
  function compareVersion(a, b) {
    var x = String(a).split('.'), y = String(b).split('.');
    for (var i = 0; i < Math.max(x.length, y.length); i += 1) {
      var d = (parseInt(x[i], 10) || 0) - (parseInt(y[i], 10) || 0);
      if (d) return d;
    }
    return 0;
  }

  var cap = window.Capacitor;
  var fs = cap && cap.Plugins && cap.Plugins.Filesystem;
  if (!builtIn || !cap || !cap.isNativePlatform || !cap.isNativePlatform() || !fs || !cap.convertFileSrc) {
    loadEntry(builtIn);
    return;
  }
  // 与存档同一文件夹（systems/stores/appFilesStore.js saveDirectory）
  var directory = cap.getPlatform && cap.getPlatform() === 'android' ? 'EXTERNAL' : 'DOCUMENTS';

  /** 读一个补丁文件夹的 patch.json；不合用返回 null。 */
  function readPatch(folder) {
    return fs.readFile({ path: folder + '/patch.json', directory: directory, encoding: 'utf8' })
      .then(function (res) {
        var p = JSON.parse(res.data);
        if (!p || !p.to || !p.entry || !p.files || compareVersion(p.to, version) <= 0) return null;
        return { folder: folder, to: String(p.to), entry: String(p.entry), files: p.files };
      })
      .catch(function () { return null; });
  }

  /** App 文件夹里版本最高、且比自带新的补丁。 */
  function findPatch() {
    return fs.readdir({ path: '', directory: directory }).then(function (res) {
      var dirs = (res.files || []).filter(function (f) { return f.type === 'directory'; })
        .map(function (f) { return f.name; });
      return Promise.all(dirs.map(readPatch));
    }).then(function (list) {
      return list.filter(Boolean).sort(function (a, b) { return compareVersion(b.to, a.to); })[0] || null;
    });
  }

  /** 补丁 game/ 文件夹对应的网页可读地址前缀。 */
  function patchBase(folder) {
    return fs.getUri({ path: folder + '/game', directory: directory }).then(function (res) {
      return cap.convertFileSrc(res.uri).replace(/\/+$/, '');
    });
  }

  function encodeRel(rel) {
    return rel.split('/').map(encodeURIComponent).join('/');
  }

  /** 让读文件请求「补丁里有就用补丁的」：XHR（游戏引擎）、fetch、Audio/video/img 的 src。 */
  var overlayOn = false;

  function installOverlay(table) {
    overlayOn = true;
    function mapUrl(url) {
      if (!overlayOn) return url;
      try {
        var u = new URL(String(url), location.href);
        if (u.origin !== location.origin) return url;
        var rel = decodeURIComponent(u.pathname.replace(/^\/+/, ''));
        return Object.prototype.hasOwnProperty.call(table, rel) ? table[rel] : url;
      } catch (e) {
        return url;
      }
    }
    var open = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function (method, url) {
      var args = Array.prototype.slice.call(arguments);
      args[1] = mapUrl(url);
      return open.apply(this, args);
    };
    if (window.fetch) {
      var fetch0 = window.fetch;
      window.fetch = function (input, init) {
        return fetch0.call(this, typeof input === 'string' || input instanceof URL ? mapUrl(input) : input, init);
      };
    }
    [HTMLMediaElement, HTMLImageElement].forEach(function (Ctor) {
      var desc = Object.getOwnPropertyDescriptor(Ctor.prototype, 'src');
      if (!desc || !desc.set) return;
      Object.defineProperty(Ctor.prototype, 'src', {
        configurable: true, enumerable: desc.enumerable, get: desc.get,
        set: function (v) { desc.set.call(this, mapUrl(v)); },
      });
    });
    var Audio0 = window.Audio;
    if (Audio0) {
      var PatchedAudio = function (src) { return src === undefined ? new Audio0() : new Audio0(mapUrl(src)); };
      PatchedAudio.prototype = Audio0.prototype;
      window.Audio = PatchedAudio;
    }
  }

  findPatch().then(function (patch) {
    if (!patch) { loadEntry(builtIn); return; }
    return patchBase(patch.folder).then(function (base) {
      var table = {};
      Object.keys(patch.files).forEach(function (rel) { table[rel] = base + '/' + encodeRel(rel); });
      if (!table[patch.entry.replace(/^\/+/, '')]) { loadEntry(builtIn); return; }
      installOverlay(table);
      window.__YC_PATCH__ = { version: patch.to, folder: patch.folder, files: Object.keys(table).length };
      loadEntry(table[patch.entry.replace(/^\/+/, '')], function () {
        // 补丁程序读不出来：关掉覆盖、退回自带版本（否则自带程序会读到补丁里的新数据）
        overlayOn = false;
        window.__YC_PATCH__ = null;
        loadEntry(builtIn);
      });
    });
  }).catch(function () {
    loadEntry(builtIn);
  });
})();
