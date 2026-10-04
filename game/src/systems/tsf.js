/**
 * 浏览器里读写原作存档 `.TSF`。**与 `tools/tsf_parse.py` 是同一套字段。**
 *
 * ## 为什么直接操作原作格式，而不是自己定一个 JSON
 *
 * 用户拍板要**双向兼容**：我们存的档原作能读、原作的档我们能读。
 * 于是 IndexedDB 里存的就是**完整的 `.TSF` 字节**，导出 = 把字节丢给下载，
 * 导入 = 把字节喂进来。没有第二种格式，也就没有两种格式之间的转换损耗。
 *
 * ## 偏移只有一份正本
 *
 * 全部偏移来自 `assets/data/tsf_layout.json`，那是
 * `python3 tools/tsf_parse.py --layout` 的**生成物**，有回归
 * （`tools/tests/test_tsf.py::test_layout_json_up_to_date`）盯着。
 * ⚠️ **不要在这里写死任何偏移** —— 抄第二份就是埋一个「两边不同步」的雷，
 * 而且不报错，只是读出来的数不对。
 *
 * ## 写回策略：以原始字节为底、只覆写认识的字段
 *
 * 存档有一半的字节我们还没搞懂（追加区 36936 字节、`+24072` 那 12 字节…）。
 * **凭空构造一个存档是在赌**，所以一律以某个真实存档为底 —— 新游戏用
 * `assets/data/NewGame.TSF`，续存用上一次的字节。
 *
 * ⚠️ **绝不要「整段清零再写」。** 存档名、地图路径、背包尾部三处都是
 * 「变长内容 + 后面紧跟别的数据 + 原作自己不清零」，清一次就毁一次。
 * Python 那边为此踩了三次，判据写在 `docs/归档/方案-存档.md` §〇。
 */

import { decodeBig5, encodeBig5 } from './big5.js';

/** 存档名后面必须留一个 `\0`。**只写「内容 + 终止符」，不动后面。** */
const TERMINATOR = 1;

const view = (bytes) => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

const readI32 = (dv, off) => dv.getInt32(off, true);
const writeI32 = (dv, off, value) => dv.setInt32(off, Math.trunc(Number(value) || 0), true);

/** 物品/绝学代码在表里是**十六进制字符串**（脚本给十进制 423，表里是 `'1A7'`）。 */
const toHex = (code) => (code ? code.toString(16).toUpperCase() : null);
const fromHex = (code) => {
  if (code === null || code === undefined || code === '') return 0;
  return typeof code === 'string' ? parseInt(code, 16) : Math.trunc(code);
};

// ————————————————————————————————————————————————————————————
// 读
// ————————————————————————————————————————————————————————————

/**
 * 只读天书页那条记录要显示的东西。**不解全档** —— 列 99 个槽位时
 * 一个个全解要几十毫秒，而条上只印着五项。
 */
export function readHeader(bytes, layout) {
  const dv = view(bytes);
  const d = layout.日期;
  return {
    存档名: decodeBig5(bytes.subarray(layout.存档名.偏移,
                                      layout.存档名.偏移 + layout.存档名.上限)),
    等级: readI32(dv, layout.等级),
    年: readI32(dv, d.年), 月: readI32(dv, d.月), 日: readI32(dv, d.日),
    时: readI32(dv, d.时), 分: readI32(dv, d.分),
    当前地图: readMap(bytes, layout),
    队伍: readPartyCodes(bytes, layout),
  };
}

/** 主角的战斗角色代码。 */
export const HERO_CODE = 1;

/**
 * 那次存档时**队伍里有谁**（战斗角色代码，按队伍顺序）。
 *
 * 判据是**队伍区**：`@56608` 成员代码 5×i32、`@56688` 人数、
 * `@56648` 阵型格号 5×i32。**只读前「人数」个**，后面是上一次的残渣。
 * 逐条判据写在 `tools/tsf_parse.py` 的 `PARTY_CODES_OFF` 注释里。
 *
 * ⚠️ **不要用角色记录的 `+156`（曾入队）。** 那一列只增不减：
 * `Save009`（思謁之間）它是 `{1,2,3,4,5}`，而原作那条存档的天书页头像
 * **只有霍雍一个**；`Save011` 它是七个人，原作画的是**三个**。
 * 拿它当队伍的后果就是「每条存档都是五个人」。
 */
export function readPartyCodes(bytes, layout) {
  return readParty(bytes, layout).成员;
}

/**
 * 队伍区整份：`{人数, 成员, 阵型}`。
 *
 * `阵型[i]` 是成员 `i` 的战场格号 `0~7`，与遇敌组的 `位置` 同一套
 * （见 `systems/battlefield.js`）。22 个官方存档里「前 n 个互不相同」
 * 无一例外 —— 一格站一个人。
 */
export function readParty(bytes, layout) {
  const p = layout.队伍;
  if (!p) {
    console.warn('tsf_layout.json 里没有「队伍」一节，队伍退回只有主角');
    return Object.freeze({ 人数: 1, 成员: [HERO_CODE], 阵型: [0] });
  }
  const dv = view(bytes);
  const n = Math.max(0, Math.min(readI32(dv, p.人数), p.上限));
  const 成员 = [];
  const 阵型 = [];
  for (let i = 0; i < n; i += 1) {
    成员.push(readI32(dv, p.成员 + i * 4));
    阵型.push(readI32(dv, p.阵型 + i * 4));
  }
  // 空队伍是坏数据（读档会得到一支没有人的队）—— 退回主角一人。
  if (!成员.length) {
    console.warn('存档的队伍人数是 0，退回只有主角');
    return Object.freeze({ 人数: 1, 成员: [HERO_CODE], 阵型: [0] });
  }
  return Object.freeze({ 人数: 成员.length, 成员: Object.freeze(成员), 阵型: Object.freeze(阵型) });
}

/** 当前地图。⚠️ **图号大小写在原档里是乱的**（`mp0212` / `MP0102B` / `MP0610a`）。 */
export function readMap(bytes, layout) {
  const raw = bytes.subarray(layout.当前地图.偏移,
                             layout.当前地图.偏移 + layout.当前地图.上限);
  let end = raw.indexOf(0);
  if (end < 0) end = raw.length;
  const text = String.fromCharCode(...raw.subarray(0, end));
  const m = /^[Mm][Pp]([0-9A-Za-z]+)\\/.exec(text);
  return m ? `MP${m[1].toUpperCase()}` : null;
}

/**
 * **主角当前的行走形象代码**（`set_avatar` 的那个值，存档 `@57583`）。
 *
 * `avatars.json` 的 `形象` 表下标就是它：`0 飛龍 / 1 小夏侯儀 / 2 dead /
 * 3 大夏侯儀 / 4 霍雍`。20 个存档里取值只有 {1,3,4}，且与地图对得上 ——
 * 三个 `MP3001`（大地图）全是 1，`Save009`/`Save010`（霍雍那段）是 4。
 *
 * ⚠️ **读档必须恢复它。** 剧情里 `set_avatar` 发生在过去，读档时脚本不会重跑；
 * 不读这一项的后果就是**读霍雍那段的存档，走的还是夏侯仪**。
 */
export function readAvatar(bytes, layout) {
  if (!Number.isInteger(layout.行走形象)) return null;
  return readI32(view(bytes), layout.行走形象);
}

/** 主角位置与朝向。像素坐标，与 `map.json` 同一坐标系。 */
export function readPosition(bytes, layout) {
  const dv = view(bytes);
  return {
    x: readI32(dv, layout.位置.x),
    y: readI32(dv, layout.位置.y),
    朝向: readI32(dv, layout.位置.朝向),
  };
}

/**
 * ⭐ **存档里有两套背包+金钱**（2026-09-12 解出）。
 *
 * 整块 = `背包(24024) + 金钱(4) + 指针(12) = 24040`，并排两块，
 * 后面紧跟一个 int32 说**当前用哪一套**（`layout.背包.当前`，值 0/1）。
 *
 * **第 1 套是霍雍那段用的。** 判据是用户给的原作截图：`Save009`
 * （队伍只有霍雍）在原作里背包是空的、金钱是 0 —— 而第 0 套装着 59 件东西。
 * 逐条判据写在 `tools/tsf_parse.py` 的 `PACK_BLOCK` 注释里。
 *
 * ⚠️ **读写都要认这个下标。** 永远读第 0 套的后果是「霍雍那段背着主队的
 * 全部家当」；永远写第 0 套的后果是「他捡的东西进了主队的包」。
 */
export function activePack(bytes, layout) {
  const off = layout.背包?.当前;
  if (!Number.isInteger(off)) return 0;            // 老 layout，退回第 0 套
  const v = readI32(view(bytes), off);
  const n = layout.背包.组数 ?? 1;
  if (!(Number.isInteger(v) && v >= 0 && v < n)) {
    console.warn(`存档的「当前背包」是 ${v}，不在 0~${n - 1}，按 0 处理`);
    return 0;
  }
  return v;
}

const packBase = (layout, group) => layout.背包.起点 + group * (layout.背包.组步长 ?? 0);
const moneyOff = (layout, group) => layout.金钱 + group * (layout.背包.组步长 ?? 0);

/**
 * 六个分类的背包，摊平成前端要的那一份。
 *
 * ⚠️ **以「条目数」为准，不要扫到 0 为止** —— 数组尾部留着上次存档的残渣，
 * 按 0 截断会把垃圾当成物品读进来。
 */
function readPack(bytes, layout, group = 0) {
  const dv = view(bytes);
  const { 起点, 槽位, 步长, 分类 } = layout.背包;
  const grouped = {};
  分类.forEach((name, index) => {
    const base = packBase(layout, group) + index * 步长;
    const count = readI32(dv, base + 槽位 * 8);
    const rows = [];
    for (let i = 0; i < Math.max(0, Math.min(count, 槽位)); i += 1) {
      const code = readI32(dv, base + 槽位 * 4 + i * 4);
      if (!code) continue;
      rows.push(Object.freeze({ 代码: toHex(code), 数量: readI32(dv, base + i * 4) }));
    }
    grouped[name] = Object.freeze(rows);
  });
  return Object.freeze(grouped);
}

/**
 * 分类背包 → 前端要的**扁平**数组。
 *
 * 前端的 `inventory` 不分格，分类由 `catalog.分类()` 现判；
 * 只有「暂置」是条目自己的状态，所以单独打个标记。
 */
export function flattenPack(grouped) {
  const rows = [];
  for (const [name, list] of Object.entries(grouped ?? {})) {
    for (const row of list) {
      rows.push(Object.freeze({ ...row, ...(name === '暂置' ? { 暂置: true } : {}) }));
    }
  }
  return Object.freeze(rows);
}

/** 一个角色的原始状态。**派生值（抗性/攻击）一律不采信**，由 `formulas.js` 现算。 */
function readCharacter(bytes, layout, index) {
  const dv = view(bytes);
  const c = layout.角色;
  const base = c.起点 + index * c.步长;
  const rec = {};
  for (const [off, name] of Object.entries(c.字段)) {
    rec[name] = readI32(dv, base + Number(off));
  }
  c.五内.键.forEach((w, i) => { rec[w] = readI32(dv, base + c.五内.偏移 + 4 * i); });
  rec.装备 = {};
  c.装备.键.forEach((slot, i) => {
    rec.装备[slot] = toHex(readI32(dv, base + c.装备.偏移 + 4 * i));
  });
  const n = Math.max(0, Math.min(rec.绝学数量 ?? 0, c.绝学.上限));
  rec.绝学 = [];
  for (let i = 0; i < n; i += 1) {
    const code = readI32(dv, base + c.绝学.偏移 + 4 * i);
    if (code) rec.绝学.push(toHex(code));
  }
  return rec;
}

/**
 * 剧情旗标。**全部 5000 个都读**，包括写成 0 的。
 *
 * ⚠️ 「没写过」与「写成 0」是两回事（见 `eventScript.FlagStore.has`）：
 * 场景对象的 `flag` 在**新游戏时本来就是 1**（「玩家还未拾取」），
 * 拾取后才变 0。只读非零项的话，那些「已经拿走的东西」会因为
 * `has()` 返回 false 而重新出现在地上。
 */
function readFlags(bytes, layout) {
  const dv = view(bytes);
  const { 起点, 步长, 上限 } = layout.旗标;
  const out = {};
  for (let i = 0; i < 上限; i += 1) {
    const off = 起点 + i * 步长;
    if (off + 2 > bytes.length) break;
    out[i] = dv.getUint16(off, true);
  }
  return out;
}

/**
 * 解一整个存档。产物形状与 `tools/tsf_parse.py` 的 `to_gamesave()` 一致，
 * 所以 `savefile.js` 的 `partyFromSave` / `inventoryFromSave` 原样能用。
 */
export function readSave(bytes, layout) {
  if (bytes.length < layout.基准长度) {
    throw new Error(`存档只有 ${bytes.length} 字节，不足 ${layout.基准长度}，不像 .TSF`);
  }
  const dv = view(bytes);
  // ⚠️ **只收在队的人。** 角色区是预填模板，9 条全有数值 ——
  // 按「命极非零」收会让开局就有 8 个人（真实开局只有夏侯仪一个）。
  const 队伍区 = readParty(bytes, layout);
  const 队伍 = 队伍区.成员;
  const 角色 = {};
  for (const i of 队伍) {
    角色[String(i)] = Object.freeze({ 代码: i, ...readCharacter(bytes, layout, i) });
  }
  // 全部 9 条的原始记录，写回时要用（未在队的也得原样保留）。
  const 角色全表 = {};
  for (let i = 1; i < layout.角色.条数; i += 1) {
    角色全表[String(i)] = Object.freeze(readCharacter(bytes, layout, i));
  }
  const 当前背包 = activePack(bytes, layout);
  return Object.freeze({
    ...readHeader(bytes, layout),
    // ⭐ `金钱`/`背包` 一律指**当前那一套**，下游不用关心有两套。
    当前背包,
    金钱: readI32(dv, moneyOff(layout, 当前背包)),
    位置: readPosition(bytes, layout),
    行走形象: readAvatar(bytes, layout),
    // 队伍与阵型是同一段数据的两半，一起给出去。`队伍` 也在 header 里，
    // 这里不覆盖它（两处读的是同一个数组）。
    阵型: 队伍区.阵型,
    // 两份：`背包` 给前端（扁平），`背包分类` 给写回（六格，与原作同形）。
    背包: flattenPack(readPack(bytes, layout, 当前背包)),
    背包分类: readPack(bytes, layout, 当前背包),
    角色: Object.freeze(角色),
    角色全表: Object.freeze(角色全表),
    剧情旗标: Object.freeze(readFlags(bytes, layout)),
  });
}

// ————————————————————————————————————————————————————————————
// 写
// ————————————————————————————————————————————————————————————

/**
 * **以 `original` 为底、只覆写 `changes` 里出现的字段。**
 *
 * @param {Uint8Array} original 底档字节（新游戏用 `NewGame.TSF`，续存用上一次的）
 * @param {object} changes 只放要改的键；没给的一概不动
 * @returns {Uint8Array} **新的字节数组**，`original` 不被修改
 */
export function writeSave(original, changes, layout) {
  const bytes = Uint8Array.from(original);       // 不改入参
  const dv = view(bytes);

  if (changes.存档名 !== undefined) {
    // ⚠️ **只写「名字 + 一个 \0」，绝不清后面。** 名字是变长 Big5 串，
    // 之后紧跟别的数据，而且原作不清零 —— `Save015` 第 7~8 字节
    // 就是上次存档留下的垃圾。
    const blob = encodeBig5(changes.存档名);
    if (blob.length + TERMINATOR > layout.存档名.上限) {
      throw new Error(`存档名「${changes.存档名}」超过 ${layout.存档名.上限} 字节`);
    }
    bytes.set(blob, layout.存档名.偏移);
    bytes[layout.存档名.偏移 + blob.length] = 0;
  }

  if (changes.等级 !== undefined) writeI32(dv, layout.等级, changes.等级);
  for (const [key, off] of Object.entries(layout.日期)) {
    if (changes[key] === undefined) continue;
    // **年只写末两位** —— 原作就是这么存的（2026 → 26）。
    writeI32(dv, off, key === '年' ? Number(changes[key]) % 100 : changes[key]);
  }
  // ⚠️ 写进**当前那一套**。`changes.当前背包` 没给就沿用底档里的那个。
  const group = changes.当前背包 ?? activePack(bytes, layout);
  if (changes.当前背包 !== undefined && Number.isInteger(layout.背包?.当前)) {
    writeI32(dv, layout.背包.当前, group);
  }
  if (changes.金钱 !== undefined) writeI32(dv, moneyOff(layout, group), changes.金钱);
  if (changes.背包) writePack(dv, changes.背包, layout, group);
  if (changes.角色) writeCharacters(dv, changes.角色, layout);
  if (changes.当前地图) writeMap(bytes, changes.当前地图, layout);
  if (changes.位置) writePosition(dv, changes.位置, layout);
  if (changes.行走形象 !== undefined && changes.行走形象 !== null
      && Number.isInteger(layout.行走形象)) {
    writeI32(dv, layout.行走形象, changes.行走形象);
  }
  if (changes.队伍) writeParty(dv, changes.队伍, changes.阵型, layout);
  if (changes.剧情旗标) writeFlags(dv, changes.剧情旗标, bytes.length, layout);
  return bytes;
}

/**
 * 写背包。入参是**按六格分好的**那一份（形状与 `readSave().背包分类` 一致）——
 * 分类要靠 `catalog`，那是调用方的事，这里不猜。
 *
 * ⚠️ **只写前 N 条 + 条目数，不清尾巴** —— 原作自己就留着残渣，
 * 读档按条目数读前 N 条、根本不看尾巴。清零会让字节级自检立刻不过。
 */
function writePack(dv, grouped, layout, group = 0) {
  const { 槽位, 步长, 分类 } = layout.背包;
  分类.forEach((name, index) => {
    const base = packBase(layout, group) + index * 步长;
    const mine = grouped[name] ?? [];
    if (mine.length > 槽位) {
      throw new Error(`背包「${name}」有 ${mine.length} 种，超过 ${槽位} 格`);
    }
    mine.forEach((row, i) => {
      writeI32(dv, base + i * 4, row.数量 ?? 1);
      writeI32(dv, base + 槽位 * 4 + i * 4, fromHex(row.代码));
    });
    writeI32(dv, base + 槽位 * 8, mine.length);
  });
}

/** 写角色。**只覆写认识的字段**，动画文件名那些原样留着。 */
function writeCharacters(dv, members, layout) {
  const c = layout.角色;
  for (const [key, rec] of Object.entries(members)) {
    const index = Number(key);
    if (!Number.isInteger(index) || index < 1 || index >= c.条数) continue;
    const base = c.起点 + index * c.步长;
    for (const [off, name] of Object.entries(c.字段)) {
      if (rec[name] !== undefined) writeI32(dv, base + Number(off), rec[name]);
    }
    c.五内.键.forEach((w, i) => {
      if (rec[w] !== undefined) writeI32(dv, base + c.五内.偏移 + 4 * i, rec[w]);
    });
    c.装备.键.forEach((slot, i) => {
      if (rec.装备?.[slot] !== undefined) {
        writeI32(dv, base + c.装备.偏移 + 4 * i, fromHex(rec.装备[slot]));
      }
    });
    if (rec.绝学) {
      const codes = rec.绝学.slice(0, c.绝学.上限);
      codes.forEach((code, i) => writeI32(dv, base + c.绝学.偏移 + 4 * i, fromHex(code)));
      // 「绝学数量」的偏移从字段表里查 —— 写死 168 就是抄第二份常量。
      const countOff = Object.entries(c.字段).find(([, n]) => n === '绝学数量')?.[0];
      if (countOff !== undefined) writeI32(dv, base + Number(countOff), codes.length);
    }
  }
}

/**
 * 写当前地图。模板是 `{图号}\MP{图号}.SCI`。
 *
 * ⚠️ **图号没变就一个字节都不写。** 大小写在原档里是乱的（三种都出现过），
 * 重建一次就会让 round-trip 立刻不过。
 */
function writeMap(bytes, mapId, layout) {
  const want = String(mapId).toUpperCase();
  if (readMap(bytes, layout) === want) return;
  const ident = `mp${want.replace(/^MP/, '').toLowerCase()}`;
  const text = `${ident}\\MP${ident}.SCI`;
  if (text.length + TERMINATOR > layout.当前地图.上限) {
    throw new Error(`地图路径 ${text} 超过 ${layout.当前地图.上限} 字节`);
  }
  for (let i = 0; i < text.length; i += 1) {
    bytes[layout.当前地图.偏移 + i] = text.charCodeAt(i);
  }
  bytes[layout.当前地图.偏移 + text.length] = 0;
}

function writePosition(dv, pos, layout) {
  if (pos.x !== undefined) writeI32(dv, layout.位置.x, Math.round(pos.x));
  if (pos.y !== undefined) writeI32(dv, layout.位置.y, Math.round(pos.y));
  if (pos.朝向 !== undefined) {
    const facing = Math.trunc(pos.朝向);
    if (!(facing >= 0 && facing < layout.位置.朝向上限)) {
      throw new Error(`朝向 ${pos.朝向} 越界，应在 0~${layout.位置.朝向上限 - 1}`);
    }
    writeI32(dv, layout.位置.朝向, facing);
  }
}

/**
 * 写队伍区：成员代码、阵型格号、人数。
 *
 * ⚠️ **只写前 n 个 + 人数，不清尾巴** —— 与背包同一条规矩，原作自己就
 * 留着残渣（`Save011` 的成员数组是 `[1,2,4,4,5]` 而人数 3）。清零会让
 * 字节级 round-trip 立刻不过。
 *
 * ⚠️ **队伍变了一定要写。** 不写的后果不是报错，是「存档里的队伍永远是
 * 底档那一份」—— 玩家在剧情里收了人，存出来还是一个人。
 */
function writeParty(dv, codes, slots, layout) {
  const p = layout.队伍;
  if (!p) { console.warn('tsf_layout.json 里没有「队伍」一节，队伍没写进存档'); return; }
  const list = Array.from(codes ?? []);
  if (list.length > p.上限) {
    throw new Error(`队伍有 ${list.length} 人，超过 ${p.上限}`);
  }
  list.forEach((code, i) => {
    writeI32(dv, p.成员 + i * 4, code);
    const slot = Number(slots?.[i]);
    if (Number.isInteger(slot)) writeI32(dv, p.阵型 + i * 4, slot);
  });
  writeI32(dv, p.人数, list.length);
}

function writeFlags(dv, flags, length, layout) {
  const { 起点, 步长, 上限 } = layout.旗标;
  for (const [key, value] of Object.entries(flags)) {
    const n = Number(key);
    if (!Number.isInteger(n) || n < 0 || n >= 上限) continue;
    const off = 起点 + n * 步长;
    if (off + 2 > length) continue;
    dv.setUint16(off, Number(value) & 0xFFFF, true);
  }
}
