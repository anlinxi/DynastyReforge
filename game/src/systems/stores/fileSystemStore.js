/** 本地文件夹存档后端；文件名与TSF读写契约见存档格式判据。
 * 句柄保存在IndexedDB，授权由浏览器决定；恢复时先查询，必要时由用户点击重新授权。
 * 原作双向接续的范围以实测为准，不将格式兼容等同所有状态完全互通。
 */

const HANDLE_DB = 'youcheng-fs';
const HANDLE_STORE = 'handles';
const HANDLE_KEY = 'saveDir';

/** 槽号 → 文件名。抄原作：槽 0 就是 `Save001.TSF`。 */
export function fileNameOf(slot) {
  return `Save${String(Number(slot) + 1).padStart(3, '0')}.TSF`;
}

/** 文件名 → 槽号。认不出返回 null。 */
export function slotOf(name) {
  const m = /^Save(\d{3})\.TSF$/i.exec(String(name).trim());
  if (!m) return null;
  const n = Number(m[1]) - 1;
  return Number.isInteger(n) && n >= 0 ? n : null;
}

// ————————————————————————————————————————————————————————————
// 目录句柄的持久化（权限由浏览器单独管理）
// ————————————————————————————————————————————————————————————

function openHandleDb() {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') { reject(new Error('没有 IndexedDB')); return; }
    const req = indexedDB.open(HANDLE_DB, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(HANDLE_STORE)) db.createObjectStore(HANDLE_STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('句柄库打不开'));
  });
}

function handleTx(mode, work) {
  return openHandleDb().then((db) => new Promise((resolve, reject) => {
    const tx = db.transaction(HANDLE_STORE, mode);
    const req = work(tx.objectStore(HANDLE_STORE));
    let result = null;
    tx.oncomplete = () => { db.close(); resolve(result); };
    tx.onabort = () => { db.close(); reject(tx.error ?? new Error('句柄事务被中止')); };
    if (req) req.onsuccess = () => { result = req.result; };
  }));
}

let dirHandle = null;
let rememberedHandle = null;

/**
 * 权限够不够。`ask=false` 时只查不问（**启动时只能查，不能问** ——
 * 请求权限需要用户手势）。
 */
async function ensurePermission(handle, ask) {
  if (!handle?.queryPermission) return false;
  const opts = { mode: 'readwrite' };
  if ((await handle.queryPermission(opts)) === 'granted') return true;
  if (!ask) return false;
  return (await handle.requestPermission(opts)) === 'granted';
}

export const fileSystemStore = {
  kind: 'filesystem',
  label: '本地文件夹',

  available() {
    return typeof window !== 'undefined' && typeof window.showDirectoryPicker === 'function';
  },

  /** 当前用的是哪个文件夹（给界面显示）。没有就 null。 */
  dirName() {
    return dirHandle?.name ?? null;
  },

  rememberedName() { return rememberedHandle?.name ?? null; },

  async reconnect() {
    if (!rememberedHandle || !await ensurePermission(rememberedHandle, true)) return false;
    dirHandle = rememberedHandle;
    return true;
  },

  /**
   * 让用户挑一个文件夹。**必须在用户手势里调**（点击/按键回调）。
   * @returns {Promise<boolean>} 选中并拿到读写权限
   */
  async chooseDir() {
    if (!this.available()) {
      console.warn('这个浏览器没有 File System Access API（只有 Chrome/Edge 有）');
      return false;
    }
    try {
      const handle = await window.showDirectoryPicker({ id: 'youcheng-saves', mode: 'readwrite' });
      if (!(await ensurePermission(handle, true))) return false;
      await handleTx('readwrite', (store) => store.put(handle, HANDLE_KEY));
      rememberedHandle = dirHandle = handle;
      console.info(`存档文件夹已设为「${handle.name}」`);
      return true;
    } catch (err) {
      // 用户点取消会抛 AbortError —— 那不是错误。
      if (err?.name !== 'AbortError') console.warn('选文件夹失败：', err?.message ?? err);
      return false;
    }
  },

  /**
   * 启动时试着恢复上次选的文件夹。
   *
   * ⚠️ **只查权限、不请求** —— 请求必须有用户手势。查不到就返回 false，
   * 调用方退回 IndexedDB，等玩家主动点「选存档文件夹」。
   */
  async restore() {
    if (!this.available()) return false;
    try {
      const handle = await handleTx('readonly', (store) => store.get(HANDLE_KEY));
      if (!handle) return false;
      rememberedHandle = handle;
      if (!(await ensurePermission(handle, false))) {
        console.info('存档文件夹需要重新授权');
        return false;
      }
      dirHandle = handle;
      return true;
    } catch (err) {
      console.warn('恢复存档文件夹失败：', err?.message ?? err);
      return false;
    }
  },

  /** 已经拿到可用的文件夹了吗。 */
  ready() {
    return Boolean(dirHandle);
  },

  async list() {
    if (!dirHandle) return [];
    const out = [];
    try {
      for await (const [name, entry] of dirHandle.entries()) {
        if (entry.kind !== 'file') continue;
        const slot = slotOf(name);
        if (slot === null) continue;
        out.push({ slot, bytes: null });        // 列表不读内容，按需再读
      }
    } catch (err) {
      console.warn('列存档文件夹失败：', err?.message ?? err);
      return [];
    }
    return out.sort((a, b) => a.slot - b.slot);
  },

  async read(slot) {
    if (!dirHandle) return null;
    try {
      const fh = await dirHandle.getFileHandle(fileNameOf(slot));
      const file = await fh.getFile();
      return new Uint8Array(await file.arrayBuffer());
    } catch (err) {
      if (err?.name !== 'NotFoundError') {
        console.warn(`读 ${fileNameOf(slot)} 失败：`, err?.message ?? err);
      }
      return null;
    }
  },

  async write(slot, bytes) {
    if (!dirHandle) throw new Error('没有存档文件夹');
    const fh = await dirHandle.getFileHandle(fileNameOf(slot), { create: true });
    const w = await fh.createWritable();
    await w.write(Uint8Array.from(bytes));
    await w.close();
  },

  async remove(slot) {
    if (!dirHandle) return;
    try {
      await dirHandle.removeEntry(fileNameOf(slot));
    } catch (err) {
      if (err?.name !== 'NotFoundError') {
        console.warn(`删 ${fileNameOf(slot)} 失败：`, err?.message ?? err);
      }
    }
  },
};
