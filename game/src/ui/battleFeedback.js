/** 原作反馈布局。官方EXE 0x4304c0小框、0x446b50/0x446e60飘字；用户原作截图复核。 */
export const INSPECTION = Object.freeze({ x: 0, y: 355, width: 249, height: 112,
  board: 'ITF0028', name: { x: 123, y: 10 },
  hp: { key: 'ITF0004', x: 34, y: 42, valueY: 50 },
  qi: { key: 'ITF0005', x: 34, y: 71, valueY: 80 },
  currentX: 45, maxX: 84, resistX: [135, 189], resistY: 38, resistStep: 18,
});
export const inspectionPackKeys = () => ['ITF0028', 'ITF0004', 'ITF0005', 'ITF0012'];
export const FEEDBACK_TICKS = 25;
export const FEEDBACK_ADVANCE = 12;

/** 命气独立显示；正值回复、负值损失。图标帧10=红勾玉，11=蓝圆，帧≠图号。 */
export function vitalLabels(change) {
  return ['hp', 'qi'].flatMap((channel) => {
    const delta = Math.trunc(change[channel] ?? 0);
    return delta ? [{ channel, delta, asset: delta > 0 ? 'MEN0025' : 'MEN0026',
      frames: [channel === 'hp' ? 10 : 11, ...String(Math.abs(delta)).split('').map(Number)] }] : [];
  });
}

/** 原作25逻辑帧，每帧移动2px；回复从上方50px下降，损失从原点上升。 */
export function vitalFrame(delta, tick) {
  const t = Math.min(FEEDBACK_TICKS, Math.max(0, Math.floor(tick)));
  return { y: delta > 0 ? -50 + t * 2 : -t * 2,
    alpha: t <= 17 ? 1 : Math.max(0, (25 - t) / 8) };
}
