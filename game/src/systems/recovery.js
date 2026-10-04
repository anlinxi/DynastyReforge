/** 官方固定回复分支：RPG.exe 0x42adb5、0x42c919、0x42c460。
 * 状态反转/免疫另由状态系统处理；这里计算正常目标的请求量。
 */
export const isFixedRecovery = (record) => [2, 3].includes(record?.附加作用量类型);

/** 两次整数除法各自截断，不能最后四舍五入。 */
export function recoveryAmount(stats, record, { menu = false } = {}) {
  const skill = record?.绝学代码 != null;
  const main = Number(record?.主作用量 ?? record?.绝学指数 ?? 0);
  const extra = Number(record?.附加作用量 ?? 0);
  const hpPct = Number(record?.命作用百分数 ?? 0);
  const qiPct = Number(record?.气作用百分数 ?? 0);
  const amount = (max, pct) => pct > 0
    ? Math.max(0, Math.trunc((Math.trunc((max ?? 0) * main / 100) + extra) * pct / 100)) : 0;
  // 原版差异：平时绝学的命/气共用命极基数（0x43b239）；
  // 战斗绝学补气以气极为基数，但乘命比例（0x42c9ad）。保留原作分支。
  return {
    hp: amount(stats?.命极, hpPct),
    qi: qiPct > 0 ? amount(skill && menu ? stats?.命极 : stats?.气极,
      skill && !menu ? hpPct : qiPct) : 0,
  };
}

/** 普通回复只作用于活人，返回实际增加量，供HUD和飘字共用。 */
export function restoreVitals(state, requested) {
  if (state.hp <= 0) return { state, hp: 0, qi: 0 };
  const gain = (value, cap, amount) => Math.min(Math.max(0, cap - value), Math.max(0, Math.trunc(amount ?? 0)));
  const hp = gain(state.hp, state.maxHp, requested.hp);
  const qi = gain(state.qi, state.maxQi, requested.qi);
  return { state: Object.freeze({ ...state, hp: state.hp + hp, qi: state.qi + qi }), hp, qi };
}
