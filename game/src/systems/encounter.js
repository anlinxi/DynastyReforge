/**
 * 一场仗从哪来 —— **`op55 battle` 的 `swarm` 是「遇敌群」编号，不是「遇敌组」**。
 *
 * ## 两级结构
 *
 * ```
 * op55 battle(swarm, must_win, on_lose)
 *   └─► 遇敌群（Layoutgr.enc，250 条）   ← swarm 指的是这张表
 *          ├─ 遇敌组[0..9]      剧情战只有一条；地区遭遇随机抽
 *          ├─ 战斗背景地图      → FLR60xx
 *          ├─ 战斗音乐          0~3 档
 *          ├─ 逃跑概率          0 / 30 / 50 / 100
 *          └─ 附加遇敌组[0..3]  ⚠️ 抽取规则没查，暂不参与
 *                 └─► 遇敌组（LayoutTeam.ENC，334 条）
 *                        ├─ 敌人 [{代码, 位置 0~7}]
 *                        ├─ 掉落金钱 下限 / 浮动
 *                        └─ 战利品 [{代码, 概率}] ×3
 * ```
 *
 * ## 判据：为什么是「群」不是「组」
 *
 * **① 羅喉城五宿座 —— 五条同时成立，这一条就够了。**
 * 五张图的图名各写着一颗星，脚本在这五张图上的 `swarm` 拿去查**遇敌群**，
 * 正好得到金木水火土；拿去查**遇敌组**则整体错开一位：
 *
 * | swarm | 地图 | 群名 | 组名 |
 * |---|---|---|---|
 * | 177 | MP2403C1 **太白**宿座（太白＝金星） | **金** | 事件77—水 |
 * | 178 | MP2403C2 **歲星**宿座（岁星＝木星） | **木** | 事件78—火 |
 * | 179 | MP2403C3 **辰星**宿座（辰星＝水星） | **水** | 事件79—土 |
 * | 180 | MP2403C4 **熒惑**宿座（荧惑＝火星） | **火** | 事件80—蛇妖 |
 * | 181 | MP2403C5 **鎮星**宿座（镇星＝土星） | **土** | 一般—高昌 |
 *
 * ② 旁证：`MP1301A/B/C`（**月牙泉底 冰窟**）`swarm=16` → 群16「月牙泉下冰窟B」，
 *    组16 是「高昌沙漠迷陣」；`MP1600A`（**往拓渾隧道入口**）`swarm=11`
 *    → 群11「拓渾古垣迴道A」，组11 是「石塔B」。
 *
 * ③ **结构判据**：一场仗必须知道「在哪打、能不能逃、放什么曲子」，
 *    而这三项**只存在于遇敌群**。读组就永远拿不到背景 —— 我们此前就是这样，
 *    于是每场仗都打在 `FLR000` 那张**量格盘用的格线图**上。
 *
 * ⚠️ **剧情战的群与组同号同名**（群104「冰璃登場」→ 组[104]），
 * 所以读错**在主线上不会报错**。这就是它躲过去这么久的原因。
 *
 * ⚠️ 全库 84 个 `swarm` 取值在两张表里都查得到，**不能靠「查得到」判断**。
 *
 * 完整原委见 `docs/专题/战斗.md` §1。
 */
import { warnOnce } from './warnOnce.js';

/**
 * 战斗地面素材编号的上界。`FlrDir.DAT` 里是 `FLR6000`~`FLR6066`，共 67 张。
 *
 * ⚠️ **这个数字会随数据变**，回归拿全库遇敌群反查求差集钉住
 * （`encounter.test.js`）。红了说明有背景号超出我们导出的范围，不要改这里的数，
 * 先去看是不是 `export_battle_art.py` 少导了。
 */
export const FLOOR_MAX = 66;

/** 量格盘用的格线图。**不是任何一张真背景**，只在解不出背景时兜底。 */
export const FALLBACK_FLOOR = 'FLR000';

/**
 * 战斗曲：**遇敌群的档次 Y → `Music03Y`**。
 *
 * 档次来自 `Layoutgr.enc +136`（0/1/2/3）。**三条独立判据一致**（2026-09-17）：
 *
 * 1. **档次字段本身**：值 3 恰好只落在「最終決戰 A1/A2/B1/B2/C」五条上，
 *    一条不多一条不少（`encounter.test.js` 钉着）。
 * 2. **用户听辨**：`Music030` 是**普通战斗**、`Music031/032/033` 是**特殊战斗**、
 *    `Music020` 是**战斗胜利**。
 * 3. **命名**：`Music03<档次>` 正好四首，与 0/1/2/3 一一对应；
 *    而档次 0 有 **207 个遇敌群**（普通遭遇），正对「普通战斗」。
 *
 * | 档次 | 谁用 | 群数 | 文件 |
 * |---|---|---|---|
 * | 0 | 普通遭遇 | 207 | `battle0.mp3` ← `Music030` |
 * | 1 | 剧情战（冰璃登場、沙漠營地決戰…） | 21 | `battle1.mp3` ← `Music031` |
 * | 2 | 强敌（封豨、羅喉降臨、最強兵器…） | 17 | `battle2.mp3` ← `Music032` |
 * | 3 | **最終決戰** | 5 | `battle3.mp3` ← `Music033` |
 *
 * ⚠️ **`fight/Audio/Mp3/` 里另外三首不是战斗曲，别再按命名规律往里凑**：
 * `Music000` ＝ 标题画面、**`Music010` ＝ 店铺曲**（与 `Music.DAT/3.MP3`
 * 逐字节相同）、`Music020` ＝ **战斗胜利**（战后流程用）。
 * 2026-09-16 我按 `Music0<档次><变体>` 把档次 1 配给 `Music010`，
 * 用户实机一听就是商店的曲子 —— 见 `docs/专题/战斗.md` §1.4 的教训。
 */
export const BATTLE_BGM = Object.freeze({
  0: { key: 'bgm-battle0', file: 'battle0.mp3' },
  1: { key: 'bgm-battle1', file: 'battle1.mp3' },
  2: { key: 'bgm-battle2', file: 'battle2.mp3' },
  3: { key: 'bgm-battle3', file: 'battle3.mp3' },
});

/** 战斗**胜利**时放的（战后流程）。用户 2026-09-17 听辨确认。 */
export const VICTORY_BGM = Object.freeze({ key: 'bgm-victory', file: 'victory.mp3' });

/**
 * 战斗背景号 → 素材键。
 *
 * 判据：`FlrDir.DAT` 的 `FLR6000`~`FLR6066` 共 67 张，而全库遇敌群的
 * `战斗背景地图` 取值域正好是 0~65。逐张渲染核对过四条（都在同一段剧情上）：
 *
 * | 遇敌群 | 背景号 | 画的是 |
 * |---|---|---|
 * | 102 離火神訣發動（蘭州城廢屋） | 7 | 木地板破屋、翻倒的桌凳酒坛 |
 * | 103 下車遭遇戰（迦夏之窟門前） | 8 | 洞口外的岩地 |
 * | 2 迦夏之窟洞內 | 9 | 洞内土地 + 雕花石门 |
 * | 104 冰璃登場（迦夏之窟內部） | 10 | 蓝色石砌大殿 |
 *
 * @returns {string|null} 越界或不是数就是 `null`（调用方负责兜底并出声）
 */
export function floorKeyOf(bg) {
  // ⚠️ **只认真正的数字。** `Number('')` 与 `Number(null)` 都是 0，
  // 照 `Number.isInteger` 判会把「字段缺失」悄悄变成「背景 0」——
  // 这个项目栽在「静默地退化成某个缺省值」上已经不止一次了。
  if (typeof bg !== 'number' || !Number.isInteger(bg)) return null;
  if (bg < 0 || bg > FLOOR_MAX) return null;
  return `FLR60${String(bg).padStart(2, '0')}`;
}

/** 这一场放哪首曲子。档次不认识时退回 0 档（普通战斗）。 */
export function battleBgmOf(tier) {
  return BATTLE_BGM[Number(tier)] ?? BATTLE_BGM[0];
}

/**
 * 解析一场仗：遇敌群编号 → 这一场要的全部东西。
 *
 * @param {object} gamedata `assets/data/gamedata.json`
 * @param {number} swarmId `op55 battle` 的 `swarm`
 * @param {() => number} [rng] 取 `[0,1)`，地区遭遇随机抽组时用；注入便于测试
 * @returns {{
 *   swarmId: number, swarmName: string, groupId: number|null,
 *   floorKey: string, floorFallback: boolean,
 *   bgm: {key: string, file: string}, bgmTier: number, escapeChance: number,
 * } | null} 群不在表里返回 `null`
 */
export function resolveEncounter(gamedata, swarmId, rng = Math.random) {
  const id = Number(swarmId);
  const swarm = (gamedata?.遇敌群 ?? []).find((s) => Number(s?.编号) === id);
  if (!swarm) {
    // ⚠️ **不要在这里悄悄退回「把它当遇敌组号」**。那样背景与曲子会一直是错的，
    // 而画面上看不出来 —— 正是这条 bug 原来的样子。
    warnOnce(`swarm-missing:${id}`,
      `遇敌群 ${id} 不在数据里：这一场的敌人、背景、音乐、逃跑率全都取不到`);
    return null;
  }

  // 剧情战的 `遇敌组` 只有一条；地区遭遇有最多十条，随机抽。
  // 424430的正常抽组分支只读取+24/+28；+216“附加遇敌组”不进入此分支。
  const pool = (swarm.遇敌组 ?? []).filter((g) => Number.isFinite(Number(g)));
  const draw = (length) => Math.min(32767, Math.floor(rng() * 32768)) % length;
  const groupId = pool.length
    ? Number(pool[draw(pool.length)])
    : null;
  if (groupId === null) {
    warnOnce(`swarm-empty:${id}`, `遇敌群 ${id}「${swarm.名称}」一个遇敌组都没有`);
  }

  const floors = swarm.战斗背景地图 ?? [];
  const bg = floors.length ? floors[draw(floors.length)] : undefined;
  const floorKey = floorKeyOf(bg);
  if (!floorKey) {
    // 判据表：「整张图静默退化」要说清楚缺哪块。背景没了画面不会崩，
    // 但会变回那张格线调试图，而那看着像「地面画错了」。
    warnOnce(`swarm-floor:${id}`,
      `遇敌群 ${id}「${swarm.名称}」的战斗背景地图是 ${bg}，`
      + `解不出 FLR60xx（有效 0~${FLOOR_MAX}），退回格线图 ${FALLBACK_FLOOR}`);
  }

  const bgmTier = Number(swarm.战斗音乐 ?? 0);
  return {
    swarmId: id,
    swarmName: String(swarm.名称 ?? ''),
    groupId,
    floorKey: floorKey ?? FALLBACK_FLOOR,
    floorFallback: !floorKey,
    bgm: battleBgmOf(bgmTier),
    bgmTier,
    escapeChance: Number(swarm.逃跑概率 ?? 0),
  };
}

/**
 * 这一期要导出/预载哪些战斗背景 —— **拿数据反查，不要写清单**。
 *
 * 判据表 F 组：`BGM_FILES` 与 `SFX_FILES` 都在「手写清单」上栽过
 * （八首曲子没导、23 个音效没导，表现都是「静默地不换 / 不响」）。
 *
 * @param {object} gamedata
 * @param {number[]} swarmIds 要覆盖的遇敌群编号；不给就是全库
 * @returns {string[]} 去重后的 `FLR60xx` 键
 */
export function floorKeysFor(gamedata, swarmIds = null) {
  const want = swarmIds ? new Set(swarmIds.map(Number)) : null;
  const keys = new Set();
  for (const s of gamedata?.遇敌群 ?? []) {
    if (want && !want.has(Number(s?.编号))) continue;
    const k = floorKeyOf((s.战斗背景地图 ?? [])[0]);
    if (k) keys.add(k);
  }
  return [...keys].sort();
}
