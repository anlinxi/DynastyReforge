/** 官方411920：专用配方→奇石调整→类别/相性推导。代码入参是原表十六进制字符串。 */
const id = (code) => Number.parseInt(String(code), 16);
const key = (code) => code.toString(16).toUpperCase();
function findItem(data, kind, affinity, level, stone = false) {
  for (const rank of [level, level > 1 ? level - 1 : level]) {
    let found = data.items.find(v => v.kind === kind && v.affinity === affinity && v.level === rank);
    if (!found) found = data.items.find(v => v.kind === kind && (stone ? affinity === 0 : v.affinity === 0) && v.level === rank);
    if (found) return found.code;
  }
  return -1;
}
export function refineResult(data, first, second) {
  const a = id(first), b = id(second), x = data?.items[a], y = data?.items[b];
  if (!x || !y || a === b) return null;
  const pair = data.specific.find(([p,q]) => (p === a && q === b) || (p === b && q === a));
  if (pair) return pair[2] > 0 ? key(pair[2]) : null;
  if (!(x.kind === 17 && y.kind === 17)) {
    const base = y.kind === 17 ? x : y;
    const reagent = base === x ? b : a;
    const index = data.stoneModifiers.findIndex(v => v[9] === reagent);
    if (index >= 0 && base.affinity >= 0 && base.affinity <= 8) {
      const level = Math.max(1, Math.min(index <= 7 ? 4 : 9, base.level + data.stoneModifiers[index][base.affinity]));
      const result = findItem(data, base.kind, base.affinity, level, true);
      if (result >= 0 && result !== base.code) return result > 0 ? key(result) : null;
    }
  }
  if (x.level < 0 || y.level < 0 || x.affinity === -1 || y.affinity === -1 || !x.kind || !y.kind || (x.kind === 17 && y.kind === 17)) return null;
  const r = x.resist.map((v,i) => Math.trunc((v+y.resist[i])/2));
  const diffs = [r[0]-r[1],r[1]-r[0],r[2]-r[7],r[3]-r[4],r[4]-r[3],r[5]-r[6],r[6]-r[5],r[7]-r[2]];
  const min = Math.min(200, ...diffs);
  const affinity = diffs.filter(v => v === min).length === 1 ? diffs.indexOf(min)+1 : 0;
  const level = Math.min(9, Math.trunc((x.level+y.level+1)/2));
  const kind = data.kinds[x.kind*17+y.kind] ?? 0;
  const result = findItem(data, kind, affinity, level);
  return result > 0 ? key(result) : null;
}
/** 原列表按行选材料；普通背包和暂置同码行不能互相代扣。动画结束才一次提交。 */
export function refineInventory(inventory, firstIndex, secondIndex, data) {
  const a=inventory[firstIndex], b=inventory[secondIndex];
  if (!a || !b || firstIndex===secondIndex || a.数量<1 || b.数量<1) return null;
  const result=refineResult(data,a.代码,b.代码);
  if (!result) return null;
  const rows=inventory.map((row,i)=>({...row,数量:row.数量-Number(i===firstIndex||i===secondIndex)})).filter(row=>row.数量>0);
  const held=rows.find(row=>row.暂置&&row.代码===result);
  if(held) held.数量++; else rows.push({代码:result,数量:1,暂置:true});
  return {result,inventory:Object.freeze(rows.map(Object.freeze))};
}
export function restParty(party) {
  const heal=m=>Object.freeze({...m,命:m.命极??m.命,气:m.气极??m.气});
  return Object.freeze({...party,members:Object.freeze(party.members.map(heal)),reserve:Object.freeze(Object.fromEntries(Object.entries(party.reserve??{}).map(([k,m])=>[k,heal(m)])))});
}
