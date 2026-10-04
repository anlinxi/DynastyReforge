/**
 * 存档后端：**IndexedDB**（浏览器默认，也是没授权文件夹时的兜底）。
 *
 * 实现 `saveStore.js` 定义的接口。这份是把原先写在 `saveslot.js` 里的
 * 那套原样搬过来的 —— 行为一个字没改。
 *
 * ⚠️ **它的数据活在浏览器里**：清网站数据、换浏览器、换设备都会丢。
 * 这正是要做文件夹后端的原因，见 `fileSystemStore.js`。
 */

const DB_NAME = 'youcheng';
const DB_VERSION = 1;
const STORE = 'saves';

let dbPromise = null;

function openStore() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('这个环境没有 IndexedDB，存档不可用'));
      return;
    }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: 'slot' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('IndexedDB 打不开'));
  });
  return dbPromise;
}

/** 把一次事务包成 Promise。 */
function run(mode, work) {
  return openStore().then((db) => new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, mode);
    const req = work(tx.objectStore(STORE));
    let result = null;
    // 请求成功时事务仍可能abort（例如提交失败）；只有complete才是保存成功。
    tx.oncomplete = () => resolve(result);
    tx.onabort = () => reject(tx.error ?? new Error('存档事务被中止'));
    if (!req) return;
    req.onsuccess = () => { result = req.result; };
    req.onerror = () => reject(req.error ?? new Error('存档读写失败'));
  }));
}

export const indexedDbStore = {
  kind: 'indexeddb',
  label: '浏览器存储',

  /** 这个环境能不能用。 */
  available() {
    return typeof indexedDB !== 'undefined';
  },

  /** 已占用的槽：`[{slot, bytes}]`，按槽号升序。 */
  async list() {
    try {
      const rows = await run('readonly', (store) => store.getAll());
      return (rows ?? [])
        .slice()
        .sort((a, b) => a.slot - b.slot)
        .map((r) => ({ slot: r.slot, bytes: r.bytes ? new Uint8Array(r.bytes) : null }));
    } catch (err) {
      console.warn('读存档列表失败：', err?.message ?? err);
      return [];
    }
  },

  async read(slot) {
    const row = await run('readonly', (store) => store.get(Number(slot)));
    return row?.bytes ? new Uint8Array(row.bytes) : null;
  },

  async write(slot, bytes) {
    const copy = Uint8Array.from(bytes);
    await run('readwrite', (store) => store.put({
      slot: Number(slot), bytes: copy.buffer, 更新于: Date.now(),
    }));
  },

  async remove(slot) {
    await run('readwrite', (store) => store.delete(Number(slot)));
  },
};
