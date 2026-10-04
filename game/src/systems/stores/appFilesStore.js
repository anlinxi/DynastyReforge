/**
 * 手机 App（Capacitor 原生壳）的存档后端：App「文稿」文件夹里的 `SaveNNN.TSF`，与桌面版、原作同一文件名契约。
 *
 * 用户 2026-10-03 选定：手机存档改为文件，方便与电脑互通。Info.plist 开了文件共享
 * （UIFileSharingEnabled、LSSupportsOpeningDocumentsInPlace），所以：
 * - 插线后 Mac「访达」→ iPhone → 文件 → 幽城幻劍錄，可直接把电脑存档拖进来 / 拖出去；
 * - 手机「文件」App 里也能看到、备份。
 *
 * 通过原生壳注入的 `window.Capacitor.Plugins.Filesystem` 调用（插件 @capacitor/filesystem 装在 mobile/），
 * 网页与桌面构建不引入任何依赖；没有原生壳时 `available()` 为假。
 */
import { fileNameOf, slotOf } from './fileSystemStore.js';

/** Capacitor 的 Directory.Documents。 */
const DOCUMENTS = 'DOCUMENTS';

const fs = () => (typeof window === 'undefined' ? null : window.Capacitor?.Plugins?.Filesystem ?? null);
const native = () => Boolean(typeof window !== 'undefined' && window.Capacitor?.isNativePlatform?.());

/** Uint8Array → base64（插件读写二进制用 base64）。 */
export function toBase64(bytes) {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

/** base64 → Uint8Array。 */
export function fromBase64(text) {
  const bin = atob(text);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out;
}

export const appFilesStore = {
  kind: 'app-files',
  label: 'App 文件夹',

  available() {
    return native() && Boolean(fs());
  },

  /** 界面不显示文件夹名（手机上不需要选，用户要求开始页不显示存档位置）。 */
  dirName() {
    return null;
  },

  rememberedName() {
    return null;
  },

  async reconnect() {
    return this.restore();
  },

  /** 手机上没有“选文件夹”：位置固定是 App 文稿文件夹。 */
  async chooseDir() {
    return false;
  },

  async restore() {
    return this.available();
  },

  ready() {
    return this.available();
  },

  async list() {
    if (!this.available()) return [];
    try {
      const { files } = await fs().readdir({ path: '', directory: DOCUMENTS });
      return files
        .map((f) => slotOf(typeof f === 'string' ? f : f.name))
        .filter((slot) => slot !== null)
        .map((slot) => ({ slot, bytes: null }))
        .sort((a, b) => a.slot - b.slot);
    } catch (err) {
      console.warn('列存档失败：', err?.message ?? err);
      return [];
    }
  },

  async read(slot) {
    if (!this.available()) return null;
    try {
      const { data } = await fs().readFile({ path: fileNameOf(slot), directory: DOCUMENTS });
      return typeof data === 'string' ? fromBase64(data) : new Uint8Array(await data.arrayBuffer());
    } catch (err) {
      console.warn(`读 ${fileNameOf(slot)} 失败：`, err?.message ?? err);
      return null;
    }
  },

  async write(slot, bytes) {
    if (!this.available()) throw new Error('不在手机 App 里，没有 App 文件夹');
    await fs().writeFile({ path: fileNameOf(slot), data: toBase64(Uint8Array.from(bytes)), directory: DOCUMENTS });
  },

  async remove(slot) {
    if (!this.available()) return;
    try {
      await fs().deleteFile({ path: fileNameOf(slot), directory: DOCUMENTS });
    } catch (err) {
      console.warn(`删 ${fileNameOf(slot)} 失败：`, err?.message ?? err);
    }
  },
};
