/** 行走遇敌。原程序依据见 docs/判据/行走遇敌.md；不依赖渲染或浏览器帧率。 */
export const FIELD_ENCOUNTER_KEY = 'fieldEncounter';
// Sys.dat/DDDES.SCI +17 = 20；401595/404a60/404c90按20Hz推进地图。
export const FIELD_STEP_MS = 50;
const nativeRandom = (rng) => Math.min(32767, Math.floor(rng() * 32768));

export function createFieldEncounter() {
  return { mapId: null, interval: 0, steps: 0, incense: null, incenseAge: 0 };
}

/** 403510：SCI非零只作开关，实际基数恒150；三份原程序此段相同。 */
export function rollInterval(state, rng = Math.random) {
  const base = 150 + nativeRandom(rng) % 300;
  return state.incense === 'calm' ? base * 2
    : state.incense === 'lure' ? Math.trunc(base / 3) : base;
}

export function enterEncounterMap(state, mapId, meta, returning = false, rng = Math.random) {
  if (returning && state.mapId === mapId) return state;
  state.mapId = mapId;
  state.interval = meta?.enabled ? rollInterval(state, rng) : 0;
  state.steps = 0;
  return state;
}

/** 原作使用时只改种类/有效标志；不重置已走步数，不立即重抽遇敌间隔。 */
export function useIncense(state, kind) {
  if (kind !== 'calm' && kind !== 'lure') throw new Error('未知玄香类型');
  state.incense = kind;
}

/** 4034c0：有效移动一次走路+1/跑步+2，香计数始终+1，超过1500才失效。 */
export function advanceEncounter(state, running, rng = Math.random) {
  if (state.interval) state.steps += running ? 2 : 1;
  if (state.incense && ++state.incenseAge > 1500) {
    state.incense = null;
    state.incenseAge = 0;
  }
  if (!state.interval || state.steps < state.interval) return false;
  state.steps = 0;
  state.interval = rollInterval(state, rng);
  return true;
}

/** 4093c7/44b0d0：SCI存的是变量号；大地图按64×48网格读MDT，再取4400+地区号。 */
export function fieldSwarm(data, mapId, position, flags) {
  const meta = data?.maps?.[mapId];
  if (!meta?.enabled) return 0;
  let variable = meta.swarmVariable;
  if (meta.regional) {
    const grid = data.regions;
    const col = Math.floor(position.x / grid.cellWidth);
    const row = Math.floor(position.y / grid.cellHeight);
    if (col < 0 || row < 0 || col >= grid.columns || row >= grid.rows) return 0;
    variable = grid.variableBase + grid.cells[row * grid.columns + col];
  }
  if (!variable) return 0; // 原函数变量0返回0，不读取剧情旗标0。
  return flags?.get(variable) ?? 0;
}
