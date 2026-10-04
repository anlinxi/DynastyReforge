/**
 * 平时（非战斗）使用物品与绝学 —— **纯函数**，吃一份状态吐一份新状态。
 *
 * 界面在 `ui/MenuScreen.js`，这里不碰 Phaser。
 *
 * ## 数据全部解自原作，出处如下
 *
 * | 事 | 出处 |
 * |---|---|
 * | 哪些平时能用 | 物品 `作用场合`（`Ail2 +172`，0不可用/1仅战斗/2仅平时/3无限制）<br>绝学 `作用场合`（`Firttech +28`，**0仅平时/1仅战斗/2无限制** —— ⚠️ 两张表的枚举不一样） |
 * | 回复量 | `上限 × 主作用量% + 附加作用量`，再按 `命作用百分数`/`气作用百分数` 分给命与气 |
 * | 作用范围 | `Ail2 +188`（2026-09-05 订正，原先写的 +180 恒为 0） |
 * | 属性增量 | `使用特效`（`Ail2 +252..268`，概率在 `+232..248`），码 `0x36~0x3C` |
 *
 * 回复整数运算现已核对官方RPG.exe：战斗物品0x42adb5、
 * 平时物品0x43b04a、平时绝学0x43b239；共用recovery.js，场合差异显式保留。
 * 社区算例不再作为回复取整的依据。复活/状态语义仍有未决项。
 *
 * **属性增量的判据**：八络血参 `增加命极` + `附加作用量 20` ↔ txt「增加２０点体力上限」；
 * 熊王金胆 `增加膂力` + 5 ↔「增加５点膂力」。属性药同一次使用分两步（RPG.exe 0x43aec0，
 * 2026-10-04 核对）：先加属性、无上限；再仅当附加作用量类型为 2/3 时回复。八络血参/冰荷仙实是
 * 类型2、主作用量100，所以吃完命/气回满到新上限；五外药是类型0，只加属性。
 */

import { isFixedRecovery, recoveryAmount } from './recovery.js';

/** 平时能用的物品「作用场合」。⚠️ 与绝学那张表的编码不同，别混。 */
const ITEM_USABLE_NOW = new Set(['仅平时', '无限制']);

/** 平时能用的绝学「作用场合」。`能否平时使用` 由导出器按 `Firttech +28` 译好。 */
const SKILL_USABLE_NOW = new Set(['仅平时', '无限制']);

/**
 * 「增加XX」特效 → 成员身上的哪个键。
 *
 * ⚠️ 与 `tools/export_gamedata.py` 的 `EFFECT_TO_FIELD` 是同一张表 ——
 * 那边导出时不翻译，这里消费时才翻译，两边靠**特效名**对齐。
 */
export const STAT_EFFECT_FIELD = Object.freeze({
  增加膂力: '膂力', 增加体魄: '体魄', 增加迅捷: '迅捷',
  增加机运: '机运', 增加灵力: '灵力',
  增加命极: '命极', 增加气极: '气极',
});

/** 机制还没做、这一版当作不可用的特效（判红 + 按不动）。当前没有。 */
export const UNIMPLEMENTED_EFFECTS = Object.freeze([]);

/**
 * 地返遁符（移形化法）。RPG.exe 0x40ced7：读当前图 SCI+0x384（导出为
 * `map.json.returnCharm`），为 1 执行事件3＝本图脚本槽1（目的地写在槽内），
 * 为 0 提示共享语 `SHARED.LEY_LINES`。
 */
export function isReturnCharm(rec) {
  return activeEffects(rec).includes('移形化法');
}

export function incenseKind(rec) {
  const effects = activeEffects(rec);
  return effects.includes('降低遇敌率') ? 'calm'
    : effects.includes('提升遇敌率') ? 'lure' : null;
}

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

/** 这条记录里概率 > 0 的特效名。空数组 = 没有特效。 */
function activeEffects(rec) {
  return (rec?.使用特效 ?? []).filter((e) => (e.概率 ?? 0) > 0).map((e) => e.特效);
}

/** 这件物品这一版做了吗。没做的按不可用处理（判红 + 按不动）。 */
export function itemUnimplemented(rec) {
  return activeEffects(rec).some((name) => UNIMPLEMENTED_EFFECTS.includes(name));
}

/** 这件物品**平时**能不能用。装备与仅战斗时的都返回 false。 */
export function itemUsableNow(rec) {
  if (!rec || rec.槽位) return false;
  return ITEM_USABLE_NOW.has(rec.作用场合) && !itemUnimplemented(rec);
}

/** 这门绝学**平时**能不能用。 */
export function skillUsableNow(rec) {
  return Boolean(rec) && SKILL_USABLE_NOW.has(rec.能否平时使用);
}

/**
 * 这次使用是哪一类。界面靠它决定接下来做什么。
 *
 * * `heal`  —— 回复命/气。走 `healTargets`
 * * `stat`  —— 增加属性。走 `applyStat`
 * * `story` —— 剧情道具（钥匙、碎片…）：效果字段全 0，原作是切回地图找对象用。
 *              这一版只做"用错地方"那半边，见 `WRONG_PLACE`
 * * `incense` —— 两种玄香，菜单扣物品后更新共享行走遇敌状态
 * * `returnCharm` —— 地返遁符，回地图执行本图槽1
 * * `none`  —— 用不了
 */
export function useKind(rec) {
  if (!itemUsableNow(rec)) return 'none';
  if (incenseKind(rec)) return 'incense';
  if (isReturnCharm(rec)) return 'returnCharm';
  const effects = activeEffects(rec);
  if (effects.some((name) => STAT_EFFECT_FIELD[name])) return 'stat';
  if ((rec.主作用量 ?? 0) || (rec.附加作用量 ?? 0)) return 'heal';
  return 'story';
}

/**
 * 剧情道具用在不该用的地方时，原作弹的那句话。
 *
 * **原文照抄**（繁体，字库按 Big5 索引，见 `docs/专题/简繁体.md`）。
 */
/**
 * 「用错地方」那句的**兜底**。
 *
 * ⚠️ **正本在 `MP0000.MSG` 的槽 0**（共享提示语，9 句）——
 * 判据是 `EVENT_SLOT_BIAS`：对象表的事件编号 = 槽号 + 2，
 * 所以槽 0 / 槽 1 永远不可能被对象引用，它们不是事件，
 * 是引擎自己要用的句子。用 `sharedLine(scene, SHARED.WRONG_PLACE)` 取。
 * 这里留一句只为 `MP0000` 拉不到时不至于弹个空框。
 */
export const WRONG_PLACE = '「這樣東西似乎不是在此處使用。」';

/**
 * `MP0000.MSG` 槽 0 那 9 句共享提示语的下标。**顺序就是原作的顺序**，
 * 不要重排 —— 下标即身份。
 */
export const SHARED = Object.freeze({
  WRONG_PLACE: 0,        // 「這樣東西似乎不是在此處使用。」
  WRONG_PLACE_ALT: 1,    // 「這樣東西似乎不是用在這裡....」
  LEY_LINES: 2,          // 「此處地脈紊亂，無法乘之遁挪。」  —— 遁符
  KITE_NEEDS_SPACE: 3,   // 「這紙鳶需得到天地寬廣之處方能使用。」
  NO_LANDING: 4,         // 「底下有人煙障礙，不適合落地收龍之舉。」
  SCROLL_REVEAL: 5,      // 羊皮卷轴上浮现文字
  SCROLL_PUZZLE: 6,      // 「這文字是我從未見過的樣式…」
  WARD_CALM: 7,          // 鎮辟玄香：遇敌率下降
  WARD_LURE: 8,          // 鬼魅玄香：遇敌率上升
});

/**
 * 取一句共享提示语。`MP0000` 没进缓存时退回 `fallback`。
 * @param {Phaser.Scene} scene
 * @param {number} index `SHARED` 里的下标
 */
export function sharedLine(scene, index, fallback = WRONG_PLACE) {
  const lines = scene?.cache?.json?.get?.('MP0000-map')?.shared;
  return lines?.[index] ?? fallback;
}

/** 作用范围是不是全体。⚠️ 只认「全体」；直列/横排是战斗概念，平时不出现。 */
export const isWholeParty = (rec) => rec?.作用范围 === '全体' || rec?.作用范围格 === '全体';

/**
 * 一次使用会回复多少命与气。
 *
 * @param {object} member 目标（要它的 `命极`/`气极`）
 * @param {object} rec    物品记录，或绝学记录（绝学的"主作用量"叫 `绝学指数`）
 * @returns {{命: number, 气: number}} 回复点数（未夹上限，夹上限在 `healTargets` 里做）
 */
export function healAmount(member, rec) {
  const gain = recoveryAmount(member, rec, { menu: true });
  return { 命: gain.hp, 气: gain.qi };
}

/**
 * 把回复落到队伍上。
 *
 * @param {number[]} targets 要回复谁（成员下标）
 */
export function healTargets(party, rec, targets) {
  const want = new Set(targets);
  return Object.freeze({
    ...party,
    members: Object.freeze(party.members.map((m, i) => {
      if (!want.has(i)) return m;
      const gain = healAmount(m, rec);
      return Object.freeze({
        ...m,
        命: clamp(m.命 + gain.命, 0, m.命极),
        气: clamp(m.气 + gain.气, 0, m.气极),
      });
    })),
  });
}

/**
 * 属性药：把 `使用特效` 里的「增加XX」落到一个成员身上。
 *
 * 照 RPG.exe 0x43aec0（菜单用物品）：按特效码 0x36~0x3C 把 `附加作用量` 直接加到属性上，
 * **不设上限、不碰当前命气**（跳转表 0x43b130/0x43b154，0x43b023 起七条加法）。
 * 回复是同一次使用里紧接着的另一步，见 `useItem`。
 */
export function applyStat(party, rec, target) {
  const gains = activeEffects(rec)
    .map((name) => STAT_EFFECT_FIELD[name])
    .filter(Boolean);
  if (!gains.length) return party;
  const amount = Number(rec?.附加作用量 ?? 0);

  return Object.freeze({
    ...party,
    members: Object.freeze(party.members.map((m, i) => {
      if (i !== target) return m;
      const next = { ...m };
      for (const field of gains) {
        next[field] = (next[field] ?? 0) + amount;
      }
      return Object.freeze(next);
    })),
  });
}

/**
 * 用一件物品。**只算队伍状态，不管扣物品** —— 扣物品由调用方走 `itemLose`，
 * 因为背包与队伍是两份状态，混在一个函数里返回两样东西反而难用。
 *
 * @param {number} target 单体时用谁；全体时忽略
 * @returns {{party: object, targets: number[], kind: string}}
 *          `targets` 是实际受影响的下标，界面拿它决定在谁头上放特效
 */
export function useItem(party, rec, target) {
  const kind = useKind(rec);
  const targets = isWholeParty(rec)
    ? party.members.map((_, i) => i)
    : [clamp(target ?? 0, 0, party.members.length - 1)];

  if (kind === 'heal') return { party: healTargets(party, rec, targets), targets, kind };
  // 属性药在数据里全是单体，全体的一件都没有；真出现了也只作用于第一个目标。
  // 原作先加属性，再仅当附加作用量类型为 2/3 时按回复公式回复（RPG.exe 0x43af2a），
  // 上限用加完后的新值：八络血参/冰荷仙实因此回满命/气，五外药（类型0）不回复。
  if (kind === 'stat') {
    const raised = applyStat(party, rec, targets[0]);
    const next = isFixedRecovery(rec) ? healTargets(raised, rec, [targets[0]]) : raised;
    return { party: next, targets, kind };
  }
  return { party, targets: [], kind };
}

/**
 * 平时放一门绝学。
 *
 * 与物品的两点不同：
 * 1. **要扣施法者的元气**（`消耗元气值` / `消耗体力值`）。不够就整笔不放。
 * 2. 单体时**由玩家选目标**（物品是直接用在当前 Tab 那个人身上）——
 *    这是原作行为，见你给的截图：確定使用之后光标跑到队伍条上选人。
 *
 * ⚠️ 绝学的"主作用量"字段叫 `绝学指数`。恢复系咒法**不受灵力影响**
 * （exe 规格区原话：「若为回复性咒术（咒术相性为回复）则除外」），
 * 所以这里和物品共用同一个 `healAmount`，不走 `skills.js` 的伤害公式。
 *
 * @returns {{party: object, targets: number[], ok: boolean}} `ok:false` = 元气不够
 */
export function useSkill(party, rec, caster, target) {
  const costMp = Number(rec?.消耗元气值 ?? 0);
  const costHp = Number(rec?.消耗体力值 ?? 0);
  const who = party.members[caster];
  if (!who || who.气 < costMp || who.命 <= costHp) return { party, targets: [], ok: false };

  const targets = isWholeParty(rec)
    ? party.members.map((_, i) => i)
    : [clamp(target ?? caster, 0, party.members.length - 1)];

  const healed = healTargets(party, rec, targets);
  return {
    party: Object.freeze({
      ...healed,
      members: Object.freeze(healed.members.map((m, i) => (i === caster
        ? Object.freeze({ ...m, 气: clamp(m.气 - costMp, 0, m.气极), 命: clamp(m.命 - costHp, 1, m.命极) })
        : m))),
    }),
    targets,
    ok: true,
  };
}

/**
 * ⚠️ **菜单里的使用特效不看 `使用动画` 这个字段。**
 *
 * `Ail2 +716` 给的（金创药 `EFF3001`、百草沁香 `EFF3002`）是**战斗里**用物品的
 * 动画，按整幅战斗画面构图、而且是蓝色的。菜单有自己的一套金光素材 `MEN0016`，
 * 摆位与节拍在 `menus.json` 的 `useFx` 里，见 `tools/render_pages.MENU_USE_FX`。
 *
 * 字段仍然导出着，战斗线接进来时直接可用。
 */
