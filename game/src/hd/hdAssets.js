import { HD_ASSETS_ENABLED, registerHdKey, registerXbrKey, useHdTexture } from './hdRender.js';
import { LANGUAGE, uiAsset } from '../systems/language.js';

/**
 * 高清素材清单（UI-10 H5 试做）：`tools/hd_upscale.py` 生成 `assets-hd/manifest.json`，
 * 列出已有的高清地图底图、战斗背景、立绘。高清开启（默认，`?hd=0` 关）时读；清单缺失或其中没有的照旧用原图。
 *
 * 高清图按原尺寸显示（缩 1/scale），逻辑坐标、碰撞与遮挡掩码都不变。
 */

export const HD_MANIFEST_KEY = 'hd-manifest';

/** 菜单里的像素人物表：不用 AI（放大后难看，用户 2026-09-30），原图走 xBR。 */
const PIXEL_MENU_SHEETS = new Set(['MEN7003']);
const HD_ROOT = 'assets-hd/';

/** BootScene 第一轮排队。未开高清不排。 */
export function queueHdManifest(scene) {
  if (HD_ASSETS_ENABLED) scene.load.json(HD_MANIFEST_KEY, `${HD_ROOT}manifest.json`);
}

function manifest(scene) {
  return HD_ASSETS_ENABLED ? scene.cache.json.get(HD_MANIFEST_KEY) ?? null : null;
}

/**
 * 清单条目：旧格式是相对路径字符串（倍数取清单的 scale，4 倍）；
 * 界面批次是 {path, scale}（2 倍，用户 2026-09-30 选定）。
 * @returns {{path: string, scale: number}|null}
 */
function entryOf(scene, group, name) {
  const entry = manifest(scene)?.[group]?.[name];
  if (!entry) return null;
  return typeof entry === 'string' ? { path: entry, scale: hdAssetScale(scene) } : entry;
}

/** 语言 → 清单 `locales` 下的目录（`hd_upscale.py --ui-locale`）。 */
const LOCALE_DIRS = Object.freeze({ 简: 'chs' });

/**
 * 界面素材查哪份清单：语言版素材查 `locales.<语言>`（简体图单独放大，用户 2026-09-30 要求），其余查主清单。
 * 语言版没有对应高清图时返回 null，照旧用语言版原图，绝不回落到繁体高清图。
 */
function uiManifest(scene, isLocalized) {
  const root = manifest(scene);
  if (!isLocalized) return root;
  return root?.locales?.[LOCALE_DIRS[LANGUAGE]] ?? null;
}

/**
 * 这份素材当前是否用的是语言版（如简体界面图）；是则不换高清（高清图是繁体原图做的）。
 * 两种写法都要认：语言映射表里的路径前缀（ITF 包），以及简体 menus.json 直接写的
 * `../locales/chs/menus/MEN0004.png` 相对路径——漏认后者时简体菜单被换成繁体高清图，
 * 格子尺寸不同（MEN0004 37/38 宽）整页错位（2026-09-30 用户报）。
 */
const localized = (path) => uiAsset(path) !== path || path.includes('/locales/');

/** 高清图相对原图的倍数；没有清单时为 1。 */
export function hdAssetScale(scene) {
  return manifest(scene)?.scale ?? 1;
}

/** 地图底图的高清版：[贴图键, 地址]，没有则 null。键与原图分开，遮挡层仍读原图对齐掩码。 */
export function hdGroundEntry(scene, mapId) {
  const rel = manifest(scene)?.maps?.[mapId];
  return rel ? [hdGroundKey(mapId), `${HD_ROOT}${rel}`] : null;
}

export function hdGroundKey(mapId) {
  return `${mapId}-ground-hd`;
}

/** 战斗背景的高清版：[贴图键, 地址]，没有则 null。 */
export function hdFloorEntry(scene, floorKey) {
  const rel = manifest(scene)?.floors?.[floorKey];
  return rel ? [`${floorKey}-hd`, `${HD_ROOT}${rel}`] : null;
}

/** 立绘帧地址：有高清版就用高清版（贴图键不变，登记倍数，显示时自动缩回原尺寸）。 */
export function portraitUrl(scene, key, code, file) {
  const rel = `portraits/${code}/${file}`;
  // 立绘 2026-09-30 起存 2 倍（清单条目带倍数），旧清单的字符串条目按 4 倍
  const entry = entryOf(scene, 'portraits', rel);
  if (entry) {
    registerHdKey(key, entry.scale);
    return `${HD_ROOT}${entry.path}`;
  }
  return `assets/${rel}`;
}

/**
 * 菜单精灵表（menus.json 网格）：有高清版就返回高清地址与放大后的格子尺寸，并登记贴图键。
 * @returns {{url: string, frameWidth: number, frameHeight: number}|null}
 */
export function hdMenuSheet(scene, textureKey, asset, meta) {
  const source = uiManifest(scene, localized(`assets/menus/${meta.sheet}`));
  if (PIXEL_MENU_SHEETS.has(asset) || source?.xbr?.menus?.includes(asset)) registerXbrKey(textureKey);
  const entry = source === manifest(scene) ? entryOf(scene, 'menus', asset) : source?.menus?.[asset];
  if (!entry) return null;
  const s = entry.scale;
  // ⚠️ 放大后的整张图超过显卡贴图上限就用原版图：画不出的贴图显示成黑块。
  // iPhone（WebKit）上限 8192，MEN0002 菜单面板 4 倍后宽 9520，状态页左半边全黑（2026-10-03 模拟器）；电脑 Chrome 一般 16384。
  const rows = Math.ceil((meta.count ?? meta.cols ?? 1) / (meta.cols ?? 1));
  const limit = scene.renderer?.getMaxTextureSize?.();
  if (limit && Math.max((meta.cols ?? 1) * meta.cell[0] * s, rows * meta.cell[1] * s) > limit) return null;
  registerHdKey(textureKey, s, s >= 4);
  return { url: `${HD_ROOT}${entry.path}`, frameWidth: meta.cell[0] * s, frameHeight: meta.cell[1] * s };
}

/**
 * 动画包图集（如 ITF0051 头像）：有高清版就返回高清图集 JSON 与所在目录，并登记贴图键。
 * @returns {{json: string, path: string}|null}
 */
export function hdPackAtlas(scene, key) {
  // 数字、细条等小字形包不做 AI（清单 xbr.packs），原图走 xBR
  const source = uiManifest(scene, localized(`assets/${key}`));
  if (source?.xbr?.packs?.includes(key)) registerXbrKey(key);
  const entry = source === manifest(scene) ? entryOf(scene, 'packs', key) : source?.packs?.[key];
  if (!entry) return null;
  registerHdKey(key, entry.scale, entry.scale >= 4);
  const rel = entry.path;
  return { json: `${HD_ROOT}${rel}`, path: `${HD_ROOT}${rel.slice(0, rel.lastIndexOf('/'))}` };
}

/** 在 (x, y) 按原尺寸放一张高清图（左上角对齐），返回显示对象。 */
export function addHdImage(scene, x, y, key) {
  return useHdTexture(scene.add.image(x, y, key).setOrigin(0, 0).setScale(1 / hdAssetScale(scene)));
}
