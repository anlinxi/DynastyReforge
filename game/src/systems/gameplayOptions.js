/** 用户2026-09-20确认的默认补丁取舍（D-03 最大成长、D-11 必定掉宝）；设置界面只经此唯一入口读写。 */
export const BATTLE_PATCHES = Object.freeze({
  maximumGrowth: true,
  guaranteedDrops: true,
});

/**
 * 标题页的「成長 / 掉寶」选择存在本机（用户2026-10-04定：放标题页，三端同一份代码）。
 * 只记关掉的：存 '0' 表示改回原作，其余（含没存过、存储读不到）都按默认开。
 */
export const PATCH_STORAGE_KEYS = Object.freeze({
  maximumGrowth: 'youcheng-max-growth',
  guaranteedDrops: 'youcheng-guaranteed-drops',
});

const defaultStorage = () => (typeof localStorage === 'undefined' ? null : localStorage);

/** 当前生效的补丁开关。每次结算时现读，标题页改了从下一场战斗起生效，不用重新载入。 */
export function battlePatches(storage = defaultStorage()) {
  const read = (key) => {
    try { return storage?.getItem(PATCH_STORAGE_KEYS[key]) !== '0'; } catch { return BATTLE_PATCHES[key]; }
  };
  return Object.freeze({
    maximumGrowth: read('maximumGrowth'),
    guaranteedDrops: read('guaranteedDrops'),
  });
}

/** 保存一个开关；存不了（隐私模式等）返回 false，只影响本次。 */
export function setBattlePatch(key, enabled, storage = defaultStorage()) {
  if (!(key in PATCH_STORAGE_KEYS)) throw new Error(`没有这个补丁开关：${key}`);
  try {
    storage?.setItem(PATCH_STORAGE_KEYS[key], enabled ? '1' : '0');
    return Boolean(storage);
  } catch {
    return false;
  }
}
