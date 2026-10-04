/**
 * 剧情动作里**改游戏状态**的那一批。
 *
 * `cutscene.js` 管画面、`FieldScene` 管流程，这里管「真的加了一件物品／
 * 真的扣了钱／真的多了个队友」。全是纯函数：吃一份状态吐一份新状态，
 * 不碰场景、不碰 Phaser，好测。
 *
 * ## ⚠️ 临时旗标 0x3E7 —— 别把它当普通旗标
 *
 * 释义里对 `扣除物品`(op7F) / `扣除金钱`(op81) / `判断装备`(op83) /
 * `判断属性`(op86) 都写着同一句：
 *
 * > 如果扣除成功，`0xE179 + 0x3E7*2` 处写入 1
 * > （**此位置不用于记录任何剧情事件代码，仅作为标志位**）
 *
 * 也就是说这些指令**不自己分支**，而是把成败写进 999 号旗标，
 * 紧跟其后的比较指令去读它。所以每一条都必须回填 —— 不回填不会报错，
 * 只会静默走错分支（「钱不够」那条永远命中，羊皮卷轴永远买不成）。
 *
 * 回填由调用方通过 `runner.resolve()` 做，这里只负责算出 `ok`。
 */
import { EQUIP_SLOTS } from './partyState.js';
import { rankFromExp } from './formulas.js';
import { slotsOf } from './formation.js';

/** op86「判断角色属性」的属性代码。释义：1级别 2烈 3迅 4神 5魔 6魂。 */
export const STAT_CODES = Object.freeze({
  1: '位阶', 2: '烈', 3: '迅', 4: '神', 5: '魔', 6: '魂',
});

/** op83「判断某角色身上有无某装备」的槽位代码：0武器 1防具 2饰物。 */
export const TEST_SLOTS = Object.freeze(EQUIP_SLOTS);

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

/** 官方RPG.exe 40e440：参数是学习事件号，不是绝学代码。
 * Api步长0x350，三分支分别写角色1/3/4的+0xac列表并增加+0xa8数量。
 */
export const STORY_SKILLS = Object.freeze({
  1: Object.freeze({ member: 1, skill: '198' }), // 離火神訣
  2: Object.freeze({ member: 3, skill: '1BF' }), // 無上滅法
  3: Object.freeze({ member: 4, skill: '1A6' }), // 千煌雷烈
});

/** 永久习得；重复执行不重复插入，未在队角色也保留到重新入队。 */
export function learnStorySkill(party, which) {
  const event = STORY_SKILLS[which];
  if (!event) {
    console.warn(`learn_skill: 未知学习事件 ${which}`);
    return party;
  }
  const learn = member => {
    if (member?.code !== event.member || member.绝学?.includes(event.skill)) return member;
    return Object.freeze({ ...member, 绝学: Object.freeze([...(member.绝学 ?? []), event.skill]) });
  };
  const members = party.members.map(learn);
  const reserved = party.reserve?.[event.member];
  const restored = learn(reserved);
  if (members.every((m, i) => m === party.members[i]) && restored === reserved) return party;
  return Object.freeze({ ...party, members: Object.freeze(members),
    ...(restored !== reserved ? { reserve: Object.freeze({ ...party.reserve, [event.member]: restored }) } : {}),
  });
}

/**
 * 脚本里的物品代码 → 数据表里的键。
 *
 * ⚠️ **脚本给的是十进制数，数据表的键是十六进制字符串。**
 * 羊皮封卷在 `item_gain` 里写作 `423`，在 `items.json` 里是 `'1A7'` ——
 * 423 = 0x1A7。直接拿数字去查表必然查不到，表现是
 * 「物品进了背包但没有名字，而且掉进『杂类』」（`分类()` 也查不到）。
 *
 * `CLAUDE.md` 第三节第一条就写着这个坑：**物品编号/绝学代码是十六进制字符串**。
 * 已经是字符串的（存档、菜单传下来的）原样用，只有数字才转。
 */
export function itemKey(code) {
  if (typeof code === 'number') return code.toString(16).toUpperCase();
  return String(code ?? '').trim().toUpperCase();
}

/** 队伍里第 n 个成员（剧情用的是**战斗角色代码**，1 起算）。 */
function memberByCode(party, code) {
  return party.members.find((m) => m.code === Number(code)) ?? null;
}

/**
 * 加物品。
 *
 * ⚠️ **进「暂置」，不是直接归类。** 原作是「捡到的东西先堆在暂置格，
 * 玩家点一下『分发』才按类型归进用器/兵刃/护甲/饰物/杂类」——
 * `inventory.js` 的 `dispatchHeld` 就是干这个的。直接归类的话，
 * 剧情给的东西会绕过分发那一步，而且分类查不到时会掉进「杂类」。
 */
export function itemGain(inventory, code, count = 1) {
  const key = itemKey(code);
  // ⚠️ **负数/零代码不是物品。** 归档版 `MP0302` 槽 18 有一条
  // `item_gain item=-70`（原作把 `0x7D heal_points` 写成了 `0x7E item_gain`，
  // 散装的补丁版是对的）—— 照单收下就会在背包里多出**一行有数量、没名字**
  // 的空条目（目录里查不到 `-46`），用户在迦夏之窟碰到过。
  // 静默丢掉也不行，判据表：兜底跳过要留一行日志。
  // ⚠️ 代码有两种写法：脚本给**十进制数**、背包里是**十六进制串**。
  // 拿归一化之后的 key 按十六进制判，别直接 `Number(code)` —— `'A'` 会变 NaN。
  const value = typeof code === 'number' ? code : parseInt(key, 16);
  if (!(value > 0)) {
    console.warn(`item_gain 收到非法物品代码 ${code}，跳过 —— `
      + '多半是脚本里那条 `0x7E/0x7D` 写反了（见 storyActions.itemGain 的注释）');
    return inventory;
  }
  const at = inventory.findIndex((r) => itemKey(r.代码) === key && r.暂置);
  if (at < 0) {
    return Object.freeze([...inventory, Object.freeze({ 代码: key, 数量: count, 暂置: true })]);
  }
  return Object.freeze(inventory.map((r, i) => (
    i === at ? Object.freeze({ ...r, 数量: (r.数量 ?? 1) + count }) : r)));
}

/**
 * 扣物品。**数量不够就整笔不动**（原作是「扣除成功」才写标志位）。
 *
 * @returns {{inventory: object[], ok: boolean}}
 */
export function itemLose(inventory, code, count = 1) {
  const key = itemKey(code);
  const have = inventory
    .filter((r) => itemKey(r.代码) === key)
    .reduce((n, r) => n + (r.数量 ?? 1), 0);
  if (have < count) return { inventory, ok: false };

  let left = count;
  const out = [];
  for (const row of inventory) {
    if (left <= 0 || itemKey(row.代码) !== key) { out.push(row); continue; }
    const take = Math.min(left, row.数量 ?? 1);
    left -= take;
    const rest = (row.数量 ?? 1) - take;
    if (rest > 0) out.push(Object.freeze({ ...row, 数量: rest }));
  }
  return { inventory: Object.freeze(out), ok: true };
}

/** 加钱。 */
export function moneyGain(party, amount) {
  return Object.freeze({ ...party, 金钱: (party.金钱 ?? 0) + Number(amount || 0) });
}

/** 扣钱。**不够就一分不扣**，并回 `ok:false`。 */
export function moneyLose(party, amount) {
  const need = Number(amount || 0);
  if ((party.金钱 ?? 0) < need) return { party, ok: false };
  return { party: Object.freeze({ ...party, 金钱: party.金钱 - need }), ok: true };
}

/**
 * 队友加入。
 *
 * ⚠️ **剧情用的是战斗角色代码**（夏侯仪 1、冰璃 2、封铃笙 3…），
 * 而 `characters.json` 的「代码」是对话人物代码 —— 两者不通用，
 * 这条坑 `CLAUDE.md` 专门警告过。这里靠 `gamedata.队伍顺序` 换算：
 * **战斗代码 = 队伍顺序里的下标 + 1**。
 */
export function partyJoin(party, gamedata, code, makeMember) {
  const n = Number(code);
  if (memberByCode(party, n)) return party;          // 已经在队里，别加两遍
  const name = (gamedata?.队伍顺序 ?? [])[n - 1];
  const base = name && gamedata?.角色?.[name];
  if (!base) {
    console.warn(`party_join: 队友代码 ${code} 在 gamedata.队伍顺序 里对不上人`);
    return party;
  }
  const saved = party.reserve?.[n];
  const member = Object.freeze({
    ...(saved ?? makeMember(name, base, gamedata?.开局装备?.[name], gamedata)), 曾入队: 0,
  });
  const reserve = { ...party.reserve };
  delete reserve[n];
  const joined = { ...party, members: Object.freeze([...party.members, member]), reserve: Object.freeze(reserve) };
  return Object.freeze({ ...joined, 站位: Object.freeze(slotsOf(joined)) });
}

/** 队友离开。 */
export function partyLeave(party, code) {
  const n = Number(code);
  const index = party.members.findIndex((m) => m.code === n);
  const members = party.members.filter((m) => m.code !== n);
  if (members.length === party.members.length) return party;
  return Object.freeze({
    ...party,
    members: Object.freeze(members),
    reserve: Object.freeze({ ...party.reserve, [n]: Object.freeze({ ...party.members[index], 曾入队: 0 }) }),
    站位: Object.freeze(slotsOf(party).filter((_, i) => i !== index)),
    选中: clamp(party.选中 ?? 0, 0, Math.max(0, members.length - 1)),
  });
}

/**
 * 全员回复。
 *
 * @param {'percent'|'points'} mode op7C 是百分比、op7D 是点数
 */
export function healParty(party, hp, mp, mode) {
  const heal = (cur, max, amount) => (mode === 'percent'
    ? clamp(cur + Math.round(max * (Number(amount) || 0) / 100), 0, max)
    : clamp(cur + (Number(amount) || 0), 0, max));
  return Object.freeze({
    ...party,
    members: Object.freeze(party.members.map((m) => Object.freeze({
      ...m,
      命: heal(m.命, m.命极, hp),
      气: heal(m.气, m.气极, mp),
    }))),
  });
}

/** 给某人加历练。位阶的换算归 `formulas`，这里只加数。 */
export function expGain(party, code, exp, gamedata = null) {
  const n = Number(code);
  // ⚠️ 位阶跟着历练走，理由同 `spoils.applySpoils`。
  const 门槛 = gamedata?.历练门槛;
  return Object.freeze({
    ...party,
    members: Object.freeze(party.members.map((m) => {
      if (m.code !== n) return m;
      const next = (m.已有历练 ?? 0) + Number(exp || 0);
      return Object.freeze({ ...m, 已有历练: next, 位阶: rankFromExp(next, 门槛) });
    })),
  });
}

/** op83：某人某个槽上装的是不是这件东西。 */
export function testEquip(party, code, slot, item) {
  const m = memberByCode(party, code);
  const key = TEST_SLOTS[Number(slot)];
  if (!m || !key) return false;
  return itemKey(m.装备?.[key] ?? '') === itemKey(item);
}

/** op86：某人某项属性是不是**大于**给定值（释义原话「需大于此数值」）。 */
export function testStat(party, code, attr, value) {
  const m = memberByCode(party, code);
  const key = STAT_CODES[Number(attr)];
  if (!m || !key) return false;
  return (Number(m[key]) || 0) > Number(value || 0);
}
