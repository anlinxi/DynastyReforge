/**
 * **存档的存储后端** —— 游戏只认这一层接口，换平台换后端。
 *
 * ── 为什么要这一层 ──
 *
 * 1. **存档不能只活在浏览器里。** IndexedDB 一清就没，用户的原话是
 *    「避免用户浏览器缓存一清，咔，存档全没了」。
 * 2. **将来要打包成手机/桌面 App。** 那时有真文件系统，
 *    换个后端就行，上层一行不用改。
 *
 * ── 接口 ──
 *
 * ```js
 * store.kind        // 'indexeddb' | 'filesystem'
 * store.label       // 给界面显示的名字
 * store.available() // 这个环境能不能用
 * store.list()      // -> [{slot, bytes|null}]，按槽号升序
 * store.read(slot)  // -> Uint8Array | null
 * store.write(slot, bytes)
 * store.remove(slot)
 * ```
 *
 * ── 现有后端 ──
 *
 * | 后端 | 何时用 | 数据在哪 |
 * |---|---|---|
 * | `fileSystemStore` | 玩家授权了一个文件夹（Chrome/Edge） | **磁盘上的 `SaveNNN.TSF`** |
 * | `indexedDbStore` | 默认 / 没授权 / 浏览器不支持 | 浏览器里 |
 * | `nativeFsStore` | 桌面版（Electron，`window.ycDesktop`）；有它就顶替 `fileSystemStore` 并默认启用 | 磁盘上的 `SaveNNN.TSF`，默认 `~/Documents/幽城幻劍錄/存档` |
 * | `appFilesStore` | 手机 App（Capacitor 原生壳）；有它就顶替 `fileSystemStore` 并默认启用 | App「文稿」文件夹里的 `SaveNNN.TSF`，访达/「文件」App 可拖进拖出 |
 *
 * TSF双向兼容的已验范围见 `docs/判据/存档格式.md`。
 *
 * ── 切换规则 ──
 *
 * * 启动时 `initStore()` 试着恢复上次选的文件夹；**只查权限不请求**
 *   （请求必须有用户手势），恢复不了就用 IndexedDB
 * * 玩家在标题/前历再续的可见入口或天书页按 `F` 选文件夹 → `useFolder()` → 之后都走文件夹
 * * **切换不搬数据**：两边各存各的。要搬用 `copyAll()`
 */

import { indexedDbStore } from './stores/indexedDbStore.js';
import { fileSystemStore } from './stores/fileSystemStore.js';
import { nativeFsStore } from './stores/nativeFsStore.js';
import { appFilesStore } from './stores/appFilesStore.js';

/** 文件夹后端：桌面版用本机文件夹，手机 App 用 App 文件夹，网页版用浏览器的文件夹授权。每次调用时判断（测试里替换 fileSystemStore 的方法也照常生效）。 */
const folderStore = () => {
  if (nativeFsStore.available()) return nativeFsStore;
  if (appFilesStore.available()) return appFilesStore;
  return fileSystemStore;
};

/** 手机 App 首次改用文件存档时，把浏览器存储里已有的存档搬过去一次（只搬一次，之后删了也不会再冒出来）。 */
const APP_FILES_MIGRATED = 'yc-app-files-migrated';

async function migrateToAppFiles(folder) {
  let done = null;
  try { done = localStorage.getItem(APP_FILES_MIGRATED); } catch { /* 读不到就当没搬过 */ }
  if (done) return;
  try {
    if (!(await folder.list()).length) {
      const n = await copyAll(indexedDbStore, folder);
      if (n) console.info(`手机存档改为文件：从浏览器存储搬了 ${n} 个`);
    }
    localStorage.setItem(APP_FILES_MIGRATED, '1');
  } catch (err) {
    console.warn('搬存档到 App 文件夹失败：', err?.message ?? err);
  }
}

/** 当前后端。默认 IndexedDB —— 任何环境都能用。 */
let current = indexedDbStore;
let initializing = null;

/** 现在用的是哪个后端。 */
export function activeStore() {
  return current;
}

/** 文件夹后端可用吗（浏览器支不支持）。给界面决定要不要显示那个入口。 */
export function folderSupported() {
  return folderStore().available();
}

/** 当前存档文件夹的名字；没用文件夹后端就返回 null。 */
export function folderName() {
  return current === folderStore() ? folderStore().dirName() : null;
}

export function rememberedFolderName() { return folderStore().rememberedName(); }

export async function reconnectFolder() {
  if (!await folderStore().reconnect()) return false;
  current = folderStore();
  return true;
}

/**
 * 启动时调一次：能恢复上次的文件夹就用它，否则用 IndexedDB。
 *
 * ⚠️ **不会弹选择框** —— 那需要用户手势。
 */
export function initStore() {
  // Boot在标题与开局各运行一次；不能第二次异步覆盖用户刚选好的后端。
  return initializing ??= (async () => {
    // 桌面版总能恢复（没选过就是默认文件夹），所以默认就存到文件夹里
    const folder = folderStore();
    if (folder.available() && await folder.restore()) current = folder;
    if (current === appFilesStore) await migrateToAppFiles(appFilesStore);
    return current.kind;
  })();
}

/**
 * 让玩家选一个存档文件夹并切过去。**必须在用户手势里调。**
 * @returns {Promise<boolean>} 成功切换
 */
export async function useFolder() {
  if (!await folderStore().chooseDir()) return false;
  current = folderStore();
  return true;
}

/** 切回浏览器存储。 */
export function useBrowser() {
  current = indexedDbStore;
}

/**
 * 把一个后端的存档整批复制到另一个。
 *
 * 用在「我一直存在浏览器里，现在想搬到文件夹」。
 * **不删源**，冲突时目标端被覆盖。
 *
 * @returns {Promise<number>} 复制了几个
 */
export async function copyAll(from, to) {
  let n = 0;
  for (const { slot } of await from.list()) {
    const bytes = await from.read(slot);
    if (!bytes?.length) continue;
    try {
      await to.write(slot, bytes);
      n += 1;
    } catch (err) {
      console.warn(`复制槽 ${slot} 失败：`, err?.message ?? err);
    }
  }
  return n;
}

export { indexedDbStore, fileSystemStore, nativeFsStore, appFilesStore };
