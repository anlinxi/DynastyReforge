/**
 * 每场战斗都要、与遇敌无关的素材 —— 进游戏的载入画面里先载好（用户 2026-09-28 要求），
 * 首战入场只剩本场的战斗背景、敌人及其绝学，快的话挂着地图截图直接碎开进战斗。
 *
 * 战斗入场（`BattleScene.preload`）用同一份清单兜底：队伍变了（新入队、换魂石）而载入画面
 * 没赶上的，入场时补。地图上后台预热 2026-09-27 试过，纹理上传卡走路，已撤（见 battlePacks.js），
 * 所以只在本来就黑屏的载入画面里载。
 */
import { hudPackKeys } from '../ui/hudLayout.js';
import { cmdPackKeys } from '../ui/cmdLayout.js';
import { tilePackKeys } from '../ui/TileOverlay.js';
import { WHEEL_ART } from '../ui/TimeWheel.js';
import { listPackKeys, statusPackKeys } from '../ui/listLayout.js';
import { inspectionPackKeys } from '../ui/battleFeedback.js';
import { persistentPackKeys } from './battleFields.js';
import { FALLBACK_FLOOR } from './encounter.js';
import { FONTS, partyArtKeys } from '../config.js';
import { LANGUAGE, uiAsset } from './language.js';
import { partyBattleAssets } from './battleAssets.js';
import { queueBattlePack } from './battlePacks.js';
import { SHATTER_KEY, SHATTER_SFX } from './battleShatter.js';
import { STATE_KEY } from './gameState.js';
import { band, enqueueLoad, queueArtwork, runLoader } from './loader.js';

const unique = (values) => [...new Set(values)];
/** 入场清单那一轮占加载页进度的比例；包里的图才是大头。 */
const MANIFEST_SHARE = 0.1;

/** 战斗界面（顶部状态条、指令、格子、列表、状态页、查看敌人、时间轮）用到的界面包。 */
export function battleUiPacks() {
  return [...hudPackKeys(), ...cmdPackKeys(), ...tilePackKeys(), ...listPackKeys(), ...statusPackKeys(),
    ...inspectionPackKeys(), WHEEL_ART, 'ITF0400'];
}

/** 人物代码 → 这个人的战斗动作包表（站立、攻击、受击、施法…），查不到返回 null。 */
export function partyArt(gamedata, code) {
  const characters = gamedata?.角色 ?? {};
  return partyArtKeys(code, Object.values(characters).find((c) => c.代码 === Number(code)));
}

/**
 * 与遇敌无关、每场都要的包：兜底背景、界面、场方效果、已装魂石、本队动作与普攻、蓄劲姿势。
 * 队伍取 registry 里的当前存档；没有队伍时只剩界面这些。
 */
export function basicBattlePacks(scene) {
  const gamedata = scene.cache.json.get('gamedata');
  const party = scene.registry.get(STATE_KEY)?.party;
  const arts = (party?.members ?? []).map((m) => ({ code: m.code, keys: partyArt(gamedata, m.code) }))
    .filter((m) => m.keys);
  const own = partyBattleAssets({
    gamedata, party, allies: arts.map(({ code }) => ({ code })),
    skills: scene.cache.json.get('skills-full') ?? [], souls: scene.cache.json.get('refining')?.souls ?? [],
  });
  return unique([FALLBACK_FLOOR, ...battleUiPacks(), ...persistentPackKeys(gamedata?.战斗规则), ...own.souls,
    ...arts.flatMap(({ keys }) => Object.values(keys).filter(Boolean)), ...own.chargePoses, ...own.attacks]);
}

/**
 * 零散小件：名牌、战斗物品插图、战斗用原作字模、升级音效、进战斗破碎表与音效。
 * @returns {string[]} 要核对的插图键（名牌 + 物品插图）
 */
export function queueBattleExtras(scene, add = () => {}) {
  const need = (exists, queue) => { if (!exists) { queue(); add(); } };
  need(scene.cache.binary.exists(SHATTER_KEY), () => scene.load.binary(SHATTER_KEY, 'assets/transition/shatter.fbx'));
  need(scene.cache.audio.exists(SHATTER_SFX), () => scene.load.audio(SHATTER_SFX, 'audio/shatter.wav'));
  need(scene.cache.audio.exists('level-up'), () => scene.load.audio('level-up', 'audio/level-up.wav'));
  need(scene.textures.exists('battle-nameplate'),
    () => scene.load.image('battle-nameplate', 'assets/ui/F-FASCIA/i00.png'));
  // 战斗名牌、战后文字按用户给出的官方截图使用原作字模，其他页面语言不变。
  const font = FONTS[LANGUAGE];
  need(scene.cache.bitmapFont.exists(font.key), () => scene.load.bitmapFont(font.key, font.texture, font.data));
  return ['battle-nameplate', ...queueArtwork(scene, add)];
}

/**
 * 载齐战斗基础素材（载入画面用）：先各包清单与零散小件，再各包的图与音效。已在缓存里的跳过。
 * @param {(v: number) => void} [onProgress] 0→1
 * @returns {Promise<number>} 第二轮排队的文件数（0 = 早就载齐）
 */
export function ensureBattleBasics(scene, onProgress = null) {
  return enqueueLoad('战斗基础素材', async () => {
    const keys = basicBattlePacks(scene);
    await runLoader(scene, (add) => {
      queueBattleExtras(scene, add);
      for (const key of keys) {
        if (scene.cache.json.exists(`${key}-anim`)) continue;
        scene.load.json(`${key}-anim`, uiAsset(`assets/${key}/anim.json`));
        add();
      }
    }, band(onProgress, 0, MANIFEST_SHARE));
    return runLoader(scene, (add) => keys.forEach((key) => queueBattlePack(scene, key, add)),
      band(onProgress, MANIFEST_SHARE, 1));
  });
}
