/**
 * 桌面版（Electron）本机文件夹存档后端：主进程直接读写磁盘上的 `SaveNNN.TSF`，与 `fileSystemStore` 同一接口、同一文件名契约。
 * 默认文件夹 `~/Documents/幽城幻劍錄/存档`（用户 2026-09-30 选定，PLAT-01 桌面安装版 A）；
 * “选择存档文件夹”弹系统对话框，所选路径由主进程记住。接口由 `desktop/preload.cjs` 暴露为 `window.ycDesktop.saves`，
 * 网页版没有它，`available()` 为假，照旧走浏览器后端。
 */
import { fileNameOf, slotOf } from './fileSystemStore.js';

const api = () => (typeof window === 'undefined' ? null : window.ycDesktop?.saves ?? null);

let dirPath = null;

/** 显示用：只取最后两级（如「幽城幻劍錄/存档」），完整路径太长。 */
function shortName(p) {
  return p ? p.split(/[\\/]/).filter(Boolean).slice(-2).join('/') : null;
}

export const nativeFsStore = {
  kind: 'native',
  label: '本地文件夹',

  available() {
    return Boolean(api());
  },

  dirName() {
    return shortName(dirPath);
  },

  rememberedName() {
    return shortName(dirPath);
  },

  async reconnect() {
    return this.restore();
  },

  /** 系统选文件夹对话框；取消返回 false。 */
  async chooseDir() {
    try {
      const picked = await api().choose();
      if (!picked) return false;
      dirPath = picked;
      return true;
    } catch (err) {
      console.warn('选文件夹失败：', err?.message ?? err);
      return false;
    }
  },

  /** 启动时取当前文件夹（上次所选，没有就默认文件夹，主进程会建好）。 */
  async restore() {
    if (!this.available()) return false;
    try {
      dirPath = await api().dir();
      return Boolean(dirPath);
    } catch (err) {
      console.warn('打开存档文件夹失败：', err?.message ?? err);
      return false;
    }
  },

  ready() {
    return Boolean(dirPath);
  },

  async list() {
    if (!dirPath) return [];
    try {
      return (await api().list())
        .map(slotOf)
        .filter((slot) => slot !== null)
        .map((slot) => ({ slot, bytes: null }))
        .sort((a, b) => a.slot - b.slot);
    } catch (err) {
      console.warn('列存档文件夹失败：', err?.message ?? err);
      return [];
    }
  },

  async read(slot) {
    if (!dirPath) return null;
    try {
      const bytes = await api().read(fileNameOf(slot));
      return bytes ? new Uint8Array(bytes) : null;
    } catch (err) {
      console.warn(`读 ${fileNameOf(slot)} 失败：`, err?.message ?? err);
      return null;
    }
  },

  async write(slot, bytes) {
    if (!dirPath) throw new Error('没有存档文件夹');
    await api().write(fileNameOf(slot), Uint8Array.from(bytes));
  },

  async remove(slot) {
    if (!dirPath) return;
    try {
      await api().remove(fileNameOf(slot));
    } catch (err) {
      console.warn(`删 ${fileNameOf(slot)} 失败：`, err?.message ?? err);
    }
  },
};
