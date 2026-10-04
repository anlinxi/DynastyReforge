/**
 * 把桌面版的本机能力安全地交给游戏页面（contextIsolation 下只暴露这几个调用）。
 * 游戏端见 game/src/systems/stores/nativeFsStore.js；主进程实现见 main.cjs registerSaveIpc。
 */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('ycDesktop', {
  /** 标题「返回太虛」照原作退出应用。 */
  app: { quit: () => ipcRenderer.invoke('app:quit') },
  saves: {
    dir: () => ipcRenderer.invoke('saves:dir'),
    choose: () => ipcRenderer.invoke('saves:choose'),
    list: () => ipcRenderer.invoke('saves:list'),
    read: (name) => ipcRenderer.invoke('saves:read', name),
    write: (name, bytes) => ipcRenderer.invoke('saves:write', name, bytes),
    remove: (name) => ipcRenderer.invoke('saves:remove', name),
  },
});
