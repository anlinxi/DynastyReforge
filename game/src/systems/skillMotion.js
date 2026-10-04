/** 官方RPG.exe 0x41facb、0x43efe0、0x43e840；详见战斗动画数据判据。 */
import { tileCenter } from './battlefield.js';

export function skillDestination(skill, actor, target) {
  const code = Number(skill.攻击位置码 ?? 0);
  if (!code || !target?.def?.tile) return null;
  let { u, v } = target.def.tile;
  const direction = target.def.side === 'foe' ? 1 : -1;
  if (code >= 2 && code <= 4) u += direction * (code - 1);
  else if (code === 5) { u += direction * 2; v = 1; }
  else if (code === 6) { u = 3; v = 1; }
  else if (code !== 1) throw new Error(`未知绝学攻击位置：${code}`);
  const point = tileCenter(u, v);
  // 保留现有站位校正；位移使用相同格盘，避免起步时跳动。
  const home = tileCenter(actor.def.tile.u, actor.def.tile.v);
  return { x: actor.baseX + point.x - home.x, y: actor.baseY + point.y - home.y };
}

/** SF2头部指定三个动画段；移动段循环，不能用整包时长匀速位移。 */
export function motionSteps(data) {
  const m = data.motion;
  if (!m) throw new Error('移动素材缺少motion参数，须重建资产');
  const { start_frames: start, loop_frames: loop, end_frames: end, jump_height: height } = m;
  const travel = Math.max(1, m.travel_steps);
  const steps = [];
  const push = (index, progress, lift = 0) => {
    // 原作播放器到文件帧上限即结束；部分原始文件的段长越界，不能读不存在的帧。
    if (index < data.frames.length) steps.push({ index, progress, lift });
  };
  for (let i = 0; i < start; i += 1) push(1 + i, 0);
  for (let i = 0; i < travel; i += 1) {
    const half = Math.trunc(travel / 2), step = i + 1;
    const peak = 48 * height;
    const lift = half > 0 && height > 0 && step < travel
      ? (step <= half ? Math.trunc(peak * step / half)
        : peak - Math.trunc(peak * (step - half) / half)) : 0;
    push(1 + start + (loop > 0 ? i % loop : 0), step / travel, lift);
  }
  for (let i = 0; i < end; i += 1) push(1 + start + loop + i, 1);
  return steps;
}

/** 普通攻击全体落空才取MIS；原作其它绝学类别仍取ATT（0x423c70）。 */
export function strikeAnimation(skill, outcomes, defaultCast) {
  if (skill.绝学类型码 === 0 && outcomes.every((result) => !result.hit)) return skill.missAnim;
  return skill.攻击动作原值 === 'NULL' ? null : skill.anim ?? defaultCast ?? null;
}
