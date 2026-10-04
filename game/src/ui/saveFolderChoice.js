import { folderSupported, folderName, rememberedFolderName, useFolder } from '../systems/saveStore.js';

/** 装在手机 App（Capacitor 原生壳）里运行？壳会注入 `window.Capacitor`。 */
function inNativeApp() {
  return Boolean(window.Capacitor?.isNativePlatform?.());
}

/** 标题与前历再续共用；授权必须直接由点击或F键发起。 */
export function mountSaveFolderChoice(scene, onChanged) {
  // 手机 App：存档固定在 App 文件夹（访达/「文件」App 可拖进拖出），开始页不显示存档位置（用户 2026-10-03）。
  if (inNativeApp()) return { choose: () => {}, refresh: () => {} };
  const panel = document.createElement('div');
  panel.className = 'save-folder-choice';
  const status = document.createElement('span');
  const connect = document.createElement('button');
  panel.append(status, connect);
  let busy = false;
  const refresh = () => {
    const active = folderName(), remembered = rememberedFolderName();
    status.textContent = active ? `存檔：${active}` : remembered
      ? `存檔文件夾「${remembered}」待授權` : '存檔：瀏覽器內';
    connect.textContent = '選擇文件夾 [F]';
    connect.disabled = busy || !folderSupported();
    // 不能选文件夹的环境（iPhone App、Safari、Firefox）：按钮点了也没用，直接不显示（2026-10-03 用户报）。
    // 手机 App 的存档本来就在 App 自己的空间里，不需要选。
    connect.hidden = !folderSupported();
    if (!folderSupported()) status.textContent = '存檔：瀏覽器內';
  };
  const choose = async () => {
    if (busy || !folderSupported()) return;
    busy = true;
    const result = useFolder();
    refresh();
    try {
      if (await result) await onChanged?.();
      else status.textContent = '未連接文件夾；現有存檔未刪除';
    } catch (err) { status.textContent = `存檔文件夾：${err.message}`; }
    finally {
      busy = false; connect.disabled = !folderSupported();
      if (folderName()) refresh();
      connect.blur();
    }
  };
  connect.onclick = () => choose();
  panel.addEventListener('keydown', e => e.stopPropagation());
  document.body.append(panel); refresh();
  scene.events.once('shutdown', () => panel.remove());
  return { choose, refresh };
}
