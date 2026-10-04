/** 官方44338f/4448cb/444ef6：类型5/6是持续行动，不是附加状态或场方。 */
export const SUSTAINED = Object.freeze({ BURROW: 5, VINES: 6 });
export function sustainedKind(skill) {
  const kind = Number(skill?.绝学类型码);
  return kind === SUSTAINED.BURROW || kind === SUSTAINED.VINES ? kind : null;
}
export function createSustained(skill) {
  const kind = sustainedKind(skill);
  return kind == null ? null : { kind, remaining: Math.max(0, Math.round(Number(skill.回气秒 ?? skill.recover ?? 0) * 20000)), stage: 'enter' };
}
/** 每次原控制器更新扣500；时间调度由Scene提供，不把标称回气秒直接当墙钟秒。 */
export function advanceSustained(state, ticks) {
  if (!state || state.stage !== 'hold') return false;
  state.remaining = Math.max(0, state.remaining - Math.max(0, Math.trunc(ticks)) * 500);
  return state.remaining === 0;
}
/** 445fea：潜地者不进入目标格索引；仍活着且仍占敌人槽，不影响胜负判断。 */
export function targetable(unit) {
  return Boolean(unit?.alive) && unit.sustained?.kind !== SUSTAINED.BURROW;
}
/** 421503在特殊状态处理后、贯穿前仅清命变化，气和附加状态保持各自规则。 */
export function sustainedVitals(state, hp, qi) {
  return { hp: state?.kind === SUSTAINED.VINES ? 0 : hp, qi };
}
