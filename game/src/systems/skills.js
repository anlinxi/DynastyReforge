/**
 * 绝学的战斗结算。
 *
 * 参数由 export_gamedata.py 从 Firttech.enc 导出到 skills.json。
 * 固定作用类型2/3的正常回复已核对官方RPG.exe，交给 recovery.js。
 * 伤害公共计算按官方函数原生差分，见officialDamage.js。
 * 蓄劲/回气由 BattleScene 与 battleClock 执行。
 */

import { hasState } from './battleStates.js';
import { isFixedRecovery, recoveryAmount } from './recovery.js';

import { magicHit, skillPhysical, skillMagic, weaponMagic, splitDamage, drainDamage } from './officialDamage.js';

/** 原作特殊执行尚未接通的能力；敌方不选、玩家菜单不可用，避免扣费后无作用。 */
export const DEFERRED_SKILLS = Object.freeze({
  '148': '妖光邪眼：原始归位素材缺源',
  '15A': '非天死潭：持续规则与原始循环素材缺源',
  '17C': '封炎灭阵：持续规则与循环素材缺源',
  '1CB': '伥魂大法：特殊作用待核对',
  '1CD': '幽魄厉界：不可把未明作用猜成反射',
});

export const PRESENTATION = Object.freeze({
  shehunguizhao: { code: '12D' }, lihuoshenjue: { code: '198' },
});
/** 该单位当前能否施放此绝学（体力必须留有余地，不能自尽）。 */
export function canUseSkill(skill, state) {
  if (!skill) return false;
  if (skillRestriction(skill, state)) return false;
  if ((skill.costQi ?? 0) > (state.qi ?? 0)) return false;
  return state.hp > (skill.costHp ?? 0);
}

/** 官方0x41a3a8/0x41a71b：按绝学类别限制，不按伤害公式类型猜咒法。 */
export function skillRestriction(skill, stats) {
  if (DEFERRED_SKILLS[skill?.code ?? skill?.绝学代码]) return '此術尚未開放';
  const kind = skill?.绝学类型码;
  if (kind === 2) {
    if (hasState(stats, 2)) return '封咒中，無法使用咒法';
    if (hasState(stats, 15)) return '狂暴中，無法使用咒法';
    if (hasState(stats, 16)) return '操偶中，無法使用咒法';
  }
  if (kind === 1 && hasState(stats, 16)) return '操偶中，無法使用絕技';
  return '';
}

/**
 * 把 `skills.json` 的一条记录 + 表现层配置，拼成战斗要用的绝学对象。
 * @param {object} rec skills.json 的一条
 * @param {object} view 表现层（anim / effect）
 */
/** 动作字段的值：`NULL` 与空串都表示「这一门没有这个动作」。 */
const actionPack = (name) => {
  const text = String(name ?? '').trim().toUpperCase();
  return text && text !== 'NULL' ? text : null;
};

export function buildSkill(rec, view = {}) {
  if (!rec) return null;
  // 元气消耗可以是「气极的百分比」（释剑之契那类），此处按点数用；
  // 百分比型要拿施法者气极现算，交给调用方，见 `元气消耗按百分比`。
  return Object.freeze({
    ...rec,
    id: view.id ?? rec.绝学代码,
    code: rec.绝学代码,
    name: rec.名称繁 || rec.名称,
    // ⭐ **五个动作来自原作数据**（`Firttech.enc` +156/166/176/186/196，
    // 字段名与偏移抄自 exe 规格区）。此前一直没导，于是绝学**没有出招姿势、
    // 蓄劲期间人站着不动** —— 用户 2026-09-18 报的「蓄力也有对应的姿势」。
    // view保留为显式预览覆盖；正常游戏不再手配具名技能的动作。
    anim: view.anim ?? actionPack(rec.攻击动作),
    chargeAnim: actionPack(rec.蓄劲动作),
    moveAnim: actionPack(rec.移动动作),
    missAnim: actionPack(rec.失误动作),
    backAnim: actionPack(rec.归位动作),
    // ⭐ **特效来自原作数据**：`Firttech.enc +250 动画文件一`
    // （雷引之術＝`EFF3031`，形如 `EFF*` 法术特效 / `SHO*` 投射物）。
    // 一直没接，表现是**绝学打出去一点特效都没有** —— 用户 2026-09-18 报。
    // 旧首槽接口保留；战斗演出实际消费完整动画槽和触发表。
    effect: view.effect ?? actionPack(rec.动画文件一),
    costHp: rec.消耗体力值 ?? 0,
    costQi: rec.消耗元气值 ?? 0,
    charge: rec.蓄劲秒 ?? 0,
    recover: rec.回气秒 ?? 0,
    accuracy: rec.附加作用命中率 ?? 100,
    range: rec.作用范围 ?? rec.作用范围格,
  });
}

/**
 * 结算一次绝学。
 *
 * 伤害算出来之后要按 `命作用百分数` / `气作用百分数` **分配到命与气** ——
 * 这两个数不是随便加的修饰：摄魂鬼爪的命作用是 0、气作用是 100，
 * 正对应资料里那句「目标损失伤害值等量的气」。同理 `吸命/吸气百分数`
 * 决定自身回复多少。
 *
 * @returns {{hit: boolean, damage: number, qiDamage: number,
 *            drained: number, drainedQi: number, effects: object[]}}
 */
export function resolveSkill(skill, attacker, defender, options = {}) {
  const {
    attackerBonuses = {},
  } = options;
  const miss = { hit: false, damage: 0, qiDamage: 0, drained: 0, drainedQi: 0, effects: [] };
  if (!skill) return miss;

  // 官方以附加作用量类型2/3分流，不按技能名字或目标阵营猜。
  // 此分支不受攻击命中判定、灵力、防御和随机伤害浮动影响。
  const blocked = (options.blockSpell && skill.绝学类型码 === 2)
    || (options.blockPhysical && [0, 1].includes(skill.绝学类型码));
  if (isFixedRecovery(skill)) {
    const gain = options.blockLight || blocked ? { hp: 0, qi: 0 } : recoveryAmount(defender, skill);
    return { ...miss, ...drainDamage(-gain.hp, -gain.qi, skill, options), hit: true, kind: 'recovery', hpRecovery: gain.hp, qiRecovery: gain.qi,
      effects: skill.附加特效 ?? [], element: skill.咒术相性 };
  }

  let physical = skillPhysical(skill, attacker, defender, options);
  const hit = magicHit(skill, attacker, defender, options);
  let magic = hit ? skillMagic(skill, attacker, defender, options) : 0;
  if (skill.绝技类型 >= 2 && skill.绝技类型 <= 6) magic = 0;
  magic += weaponMagic(attacker, defender, options);
  if (options.halfPhysical && skill.咒术相性码 !== 10) physical = Math.trunc(physical / 2);
  if (skill.咒术相性码 === 10) physical = 0;
  if (hasState(attacker, 15)) physical *= 2;
  if (hasState(attacker, 10)) physical = Math.trunc(physical / 2);
  let total = physical + magic;
  if (skill.绝学类型码 === 2) total += Math.trunc(total * (attackerBonuses.法力补正 ?? 0) / 100);
  if (blocked) total = 0;
  const result = splitDamage(total, skill, defender, options);
  return { ...result, hit: !!(result.damage || result.qiDamage || skill.附加特效?.length),
    effects: skill.附加特效 ?? [], element: skill.咒术相性 };

}
