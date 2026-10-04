/**
 * 桌面版（PLAT-01；2026-09-27 原型，2026-09-30 起按桌面安装版 A 打包）：Electron 窗口加载 game/dist 构建产物。
 * 用自定义协议 app:// 读本地文件，避免 file:// 下 fetch 受限；素材从本地磁盘读，不经HTTP。
 * 开发时读仓库 game/dist（环境变量 YC_DIST 可另指）；打包后读应用内 Resources/game（electron-builder extraResources）。
 * 高清默认开；YC_HD=0 走原版（等同网页版 ?hd=0，见 docs/专题/高清.md）；YC_QUERY 追加其他网址参数。
 *
 * 存档：主进程直接读写文件夹里的 SaveNNN.TSF（游戏端 nativeFsStore，经 preload.cjs 的 window.ycDesktop.saves），
 * 默认 ~/Documents/幽城幻劍錄/存档（用户 2026-09-30 定），“选择存档文件夹”改选别处后记在 userData/settings.json。
 */
const { app, BrowserWindow, Menu, dialog, ipcMain, protocol, net, session } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

app.setName('幽城幻劍錄');
// 放开声音自动播放：浏览器规定要先有一次键盘/鼠标操作才出声，按手柄不算（PLAT-03）。
// 桌面版是本机程序，没有这层顾虑；不放开的话只用手柄的玩家听不到片头与标题音乐。
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
// 隔离设置与存档目录（YC_USER_DATA），不碰玩家真实数据
if (process.env.YC_USER_DATA) app.setPath('userData', process.env.YC_USER_DATA);

const DIST = path.resolve(process.env.YC_DIST
  ?? (app.isPackaged ? path.join(process.resourcesPath, 'game') : path.join(__dirname, '..', 'game', 'dist')));

protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
]);

// ———— 设置（存档文件夹、窗口大小） ————

const settingsPath = () => path.join(app.getPath('userData'), 'settings.json');

function readSettings() {
  try {
    return JSON.parse(fs.readFileSync(settingsPath(), 'utf8'));
  } catch {
    return {};
  }
}

function writeSettings(patch) {
  const next = { ...readSettings(), ...patch };
  fs.mkdirSync(path.dirname(settingsPath()), { recursive: true });
  fs.writeFileSync(settingsPath(), JSON.stringify(next, null, 2));
}

// ———— 存档 ————

/** 只认原作的存档文件名，挡住路径穿越。 */
const SAVE_NAME = /^Save\d{3}\.TSF$/i;

const defaultSaveDir = () => path.join(app.getPath('documents'), '幽城幻劍錄', '存档');

function saveDir() {
  const dir = process.env.YC_SAVE_DIR || readSettings().saveDir || defaultSaveDir();
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function saveFile(name) {
  if (!SAVE_NAME.test(String(name))) throw new Error(`不是存档文件名：${name}`);
  return path.join(saveDir(), name);
}

function registerSaveIpc() {
  ipcMain.handle('saves:dir', () => saveDir());
  ipcMain.handle('saves:choose', async (event) => {
    const result = await dialog.showOpenDialog(BrowserWindow.fromWebContents(event.sender), {
      title: '选择存档文件夹', defaultPath: saveDir(), properties: ['openDirectory', 'createDirectory'],
    });
    if (result.canceled || !result.filePaths[0]) return null;
    writeSettings({ saveDir: result.filePaths[0] });
    return result.filePaths[0];
  });
  ipcMain.handle('saves:list', () => fs.readdirSync(saveDir()).filter((name) => SAVE_NAME.test(name)));
  ipcMain.handle('saves:read', (_event, name) => {
    try {
      return fs.readFileSync(saveFile(name));
    } catch (err) {
      if (err.code === 'ENOENT') return null;
      throw err;
    }
  });
  // 先写临时文件再改名：写到一半断电也不会留下半个存档
  ipcMain.handle('saves:write', (_event, name, bytes) => {
    const file = saveFile(name);
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, Buffer.from(bytes));
    fs.renameSync(tmp, file);
  });
  ipcMain.handle('saves:remove', (_event, name) => fs.rmSync(saveFile(name), { force: true }));
}

// ———— 窗口与菜单 ————

function buildMenu() {
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { role: 'appMenu' },
    { label: '显示', submenu: [{ role: 'togglefullscreen', label: '全屏' }] },
    { role: 'windowMenu', label: '窗口' },
  ]));
}

function createWindow() {
  const bounds = readSettings().window ?? {};
  const win = new BrowserWindow({
    width: bounds.width ?? 1280, height: bounds.height ?? 1000, x: bounds.x, y: bounds.y,
    backgroundColor: '#000000', title: '幽城幻剑录 高清复刻', autoHideMenuBar: true,
    // 自动自测/诊断自查时不在用户屏幕上弹窗（YC_HIDE_WINDOW=1）
    show: !process.env.YC_HIDE_WINDOW,
    webPreferences: { contextIsolation: true, preload: path.join(__dirname, 'preload.cjs') },
  });
  if (bounds.fullScreen && !process.env.YC_HIDE_WINDOW) win.setFullScreen(true);
  win.on('close', () => writeSettings({ window: { ...win.getNormalBounds(), fullScreen: win.isFullScreen() } }));
  // YC_QUERY 追加网址参数（如 "cursor=os&hdfont=0"），与网页版同名
  const query = [process.env.YC_HD === '0' ? 'hd=0' : '', process.env.YC_QUERY ?? ''].filter(Boolean).join('&');
  win.loadURL(`app://game/index.html${query ? `?${query}` : ''}`);
  return win;
}

app.whenReady().then(() => {
  protocol.handle('app', (request) => {
    const { pathname } = new URL(request.url);
    const file = path.join(DIST, decodeURIComponent(pathname));
    if (!file.startsWith(DIST)) return new Response('forbidden', { status: 403 });
    return net.fetch(pathToFileURL(file).toString());
  });
  // 网页端的文件夹授权（File System Access API）在桌面版已由 nativeFsStore 取代，保留放行以防旧入口。
  session.defaultSession.setPermissionRequestHandler((_wc, _perm, cb) => cb(true));
  registerSaveIpc();
  ipcMain.handle('app:quit', () => app.quit());
  buildMenu();
  const win = createWindow();
  // 诊断模式：用户实玩、后台收集卡顿/内存/音效数据（见 diagnostics.cjs）。可与正常游戏同时开
  if (process.env.YC_DIAG) require('./diagnostics.cjs')(win, app);
});

app.on('window-all-closed', () => app.quit());
