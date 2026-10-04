/** 本场战斗的素材需求。只读数据，不访问Phaser、浏览器或发起加载。
 * 场景负责执行清单；敌人、增援、魂石和菜单共用已有规则，不各猜一套。
 */
import { animationSlots } from './effects.js';
import { DEFERRED_SKILLS } from './skills.js';
import { equippedSoul, soulCodes, soulPack } from './soulStones.js';
import { foeRoster, enemyDef, rosterAnimKeys, normalAttackRecord } from './roster.js';
import { reinforcementCodes } from './reinforcements.js';
import { normCode } from './catalog.js';

const POSE_FIELDS = ['蓄劲动作', '移动动作', '攻击动作', '失误动作', '归位动作'];
const unique = values => [...new Set(values)];
export const recordPacks = record => record
  ? [...POSE_FIELDS.map(key => record[key]).filter(Boolean), ...animationSlots(record).map(slot => slot.文件)]
  : [];

const live = code => !DEFERRED_SKILLS[normCode(code)];   // 已封印能力既不施放也不要求缺失素材
const skillIndex = skills => new Map((skills ?? []).map(row => [normCode(row.绝学代码), row]));
const attackPacks = (gamedata, defs) => defs.flatMap(def => recordPacks(normalAttackRecord(gamedata, def.code)));

/**
 * 与遇敌无关的本队部分。进游戏的载入画面据此先载好蓄劲姿势、普攻、魂石（见 battleBasics.js）。
 * 本队自己学的绝学与魂石招式都由玩家在绝学列表里选：选定时再载（BattleScene.loadActionPacks），
 * 只有蓄劲姿势要入场前备好 —— 提交指令那一刻就要摆出来。
 * 全队学满约 4.3 GB 显存；魂石三招大特效约 0.38 GB，不能再整批入场前载（2026-09-27/28）。
 */
export function partyBattleAssets({ gamedata, party, allies = [], skills = [], souls = [] }) {
  const members = party?.members ?? [];
  const byCode = skillIndex(skills);
  const partySkills = [];
  const chargePoses = [];
  for (const member of members) {
    for (const code of [...(member.绝学 ?? []), ...soulCodes(equippedSoul(member, souls))].filter(live)) {
      const record = byCode.get(normCode(code));
      partySkills.push(...recordPacks(record));
      if (record?.蓄劲动作) chargePoses.push(record.蓄劲动作);
    }
  }
  return {
    partySkills: unique(partySkills),
    chargePoses: unique(chargePoses),
    attacks: unique(attackPacks(gamedata, allies)),
    souls: unique(souls.filter(stone => members.some(member => equippedSoul(member, [stone]))).map(soulPack)),
  };
}

/** encounter是已抽出的遇敌组，不是剧情指令传入的遇敌群。 */
export function battleAssetPlan({ gamedata, encounter, party, allies = [], inventory = [],
  skills = [], items = [], souls = [] }) {
  const own = partyBattleAssets({ gamedata, party, allies, skills, souls });
  const initial = foeRoster(gamedata, encounter);
  const enemies = reinforcementCodes(initial.map(def => def.code), gamedata?.敌人)
    .map((code, index) => enemyDef(gamedata, code, index));
  const byCode = skillIndex(skills);
  // 敌人绝学与本队同一机制：敌方 AI 选定时才载（BattleScene.commit → loadActionPacks），
  // 敌人蓄劲期间载完，出手前未就绪则停表等；只有蓄劲姿势入场前备好 —— 提交那一刻就要摆出来。
  // 入场前整批载时，重的遇敌群光敌人绝学就上 GB（遇敌群156 为1.34 GB），首次遇到必黑屏读条（2026-09-28）。
  const enemySkills = [];
  const enemyChargePoses = [];
  for (const def of enemies) {
    for (const code of (def.stats?.绝学 ?? []).filter(live)) {
      const record = byCode.get(normCode(code));
      enemySkills.push(...recordPacks(record));
      if (record?.蓄劲动作) enemyChargePoses.push(record.蓄劲动作);
    }
  }
  const held = new Set(inventory.filter(row => row.数量 > 0).map(row => normCode(row.代码)));
  return {
    skills: unique([...own.partySkills, ...enemySkills]),
    partySkills: own.partySkills,
    enemySkills: unique(enemySkills),
    preloadSkills: unique([...enemyChargePoses, ...own.chargePoses]),
    attacks: unique([...own.attacks, ...attackPacks(gamedata, enemies)]),
    items: unique((items ?? []).filter(row => held.has(normCode(row.物品编号))
      && ['仅战斗时', '无限制'].includes(row.作用场合))
      .flatMap(row => animationSlots(row).map(slot => slot.文件))),
    enemies: rosterAnimKeys(enemies),
    souls: own.souls,
  };
}
