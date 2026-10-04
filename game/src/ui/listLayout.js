/**
 * 战斗里三个**二级界面**的布局与选择逻辑 —— 法寶 / 絕學的列表页、諸態页。
 * **纯函数，不碰 Phaser**；画的是 `ui/ListPanel.js` 与 `ui/StatusPage.js`。
 *
 * 素材总账在 **`docs/判据/战斗界面素材.md`**（生成物）。
 *
 * ## 这一版的数**几乎全是 exe 真值**，不是量的
 *
 * `tools/extract_layout.py` 抽 `push y; push x; push <素材名>; call 建元素`。
 * 上一版只用了这一条，漏了另外三条，于是一路目测：
 *
 * 1. **`设帧号`**（`call 0x43e6f0`）—— `ITF0031` 在法寶页构造了**三次**，
 *    帧号分别是 **0 / 1 / 2**：它是**三块不同形状的板**，不是一块板用三次。
 *    帧 0 列表底板 218×300、帧 1 说明板 265×148、帧 2 插图板 182×179。
 *    上一版只用帧 0，还自己另挑了 `ITF035` 去当说明板与插图板。
 * 2. **`滑入补间`**（`call 0x431cd0(起点, 落点, …)`）—— exe 的构造坐标常常是
 *    屏幕外的滑入**起点**（x=−300 / y=500 / x=700），**落点一直写在这个调用里**。
 * 3. **子元素的格**（`call 0x4312c0(x, y, 格宽, 格高, 素材, 父)`）——
 *    行条那条是 `(7, 52, 200, 25)`，**行距 25**。上一版目测写 30，
 *    按 30 排第 8 行会压到 y=268 的下翻页箭头上。
 *
 * 全部落点：
 *
 * ```
 *   −300 → 292  法寶列表板     700 → 520  法寶四类板
 *    500 → 300  法寶说明板     500 → 120  法寶插图板
 *   −300 → 260  絕學列表板     700 → 520  絕學两类板
 *   −300 →  30  絕學说明板
 *   −500 →  26  諸態左板       700 → 283  諸態右板
 * ```
 *
 * ⚠️ **两条自洽验证**（不是巧合）：插图板 120+179 = **299**、说明板从 **300**
 * 起，两块严丝合缝地叠着；说明板 15+265 = **280**、插图板 98+182 = **280**，
 * 右缘对齐。
 *
 * ## 原作自己就在复用菜单素材
 *
 * | 用在哪 | 素材 | 判据 |
 * |---|---|---|
 * | 法寶插图板里的道具画 | `Menus\Men4010.sf2`…`4014` | exe 在插图板里直接建了它，贴在板内 (0,0)；格子 **182×179** 与插图板尺寸**完全一致** |
 * | 絕學说明板 | `Menus\MEN5001.SF2` 帧1 | exe 点名（与 `ITF501` 帧1 同尺寸 218×200） |
 * | 消耗图标 | `Menus\MEN5006.SF2` | exe 点名，絕學行内 x=140 |
 * | 確定使用框 | `Menus\MEN0005.SF2` | 179×87，**「確定使用／取消」**两帧＝选中哪一行。⚠️ 战斗里**不是** `ITF036`（那件印的是「確定使用／是／否」） |
 *
 * ## 说明文字是**定宽定行**的，也写在 exe 里
 *
 * ```
 *   法寶说明板  起点 (10,25)  每行 10 字  最多 4 行   （`0x2c=4`  / `0x30=0xa`）
 *   絕學说明板  起点 (20,30)  每行  7 字  最多 6 行   （`0x2c=6`  / `0x30=7`）
 * ```
 */

/**
 * 法寶的四类。**字已经印在 `ITF0030` 板上**，这里只留 id 与背包分类的对应。
 *
 * ⚠️ `bag` 必须与 `systems/catalog.js` 的 `分类()` 返回值对得上 ——
 * 上一版写的是 `'武器'`，而 `分类()` 给的是 **`'兵刃'`**，于是四类**一个都筛不出来**，
 * 表现是「所有东西混在一起」（其实是四格里都落到了同一个兜底分支）。
 *
 * ⚠️ 原作这块板只有四行，**没有护甲/饰物** —— 那两类在战斗里不列出来。
 * 判据只有「板上印着这四个字、4 帧」，护甲饰物去哪了没有直接判据，已登台账。
 */
export const ITEM_CATEGORIES = Object.freeze([
  Object.freeze({ id: 'tool', label: '用器', bag: '用器' }),
  Object.freeze({ id: 'arms', label: '兵刃', bag: '兵刃' }),
  Object.freeze({ id: 'misc', label: '雜類', bag: '杂类' }),
  Object.freeze({ id: 'held', label: '暫置', bag: '暂置' }),
]);

/**
 * 一条记录归战斗的哪一类 —— 与平时菜单的 `systems/catalog.分类()` 同一条规则：
 * **装备看 `槽位`（兵刃/护甲/饰物），其余看 `物品类别`**（用器，否则杂类）。
 *
 * ⚠️ `物品类别` 在两张表里的取值**不是一套**：`items.json` 是 用器/杂类，
 * `equipment.json` 是 武器/防具/饰物。直接拿它去比「兵刃」永远不命中。
 *
 * ⚠️ 战斗那块板只有四行，**护甲与饰物在战斗里没有格子** —— 它们归到
 * `护甲`/`饰物`，四类都不收，于是不出现在任何一页。这是照板上印的四个字
 * 推的，原作把它们放哪没有直接判据，已登台账。
 */
export function battleCategoryOf(record) {
  if (!record) return null;
  return record.槽位 ?? (record.物品类别 === '用器' ? '用器' : '杂类');
}

/** 法寶的四类板。`x` 是 exe 的滑入落点，`offscreenX` 是它的起点。 */
export const CATEGORY_BOARD = Object.freeze({
  key: 'ITF0030', frame: 0, width: 107, height: 165, x: 520, y: 120, offscreenX: 700,
});

/**
 * **絕學的两类板「咒法 / 絕技」**（`ITF502`，107×108，2 帧＝选中哪一行）。
 *
 * ⚠️ 这一件曾被判成「官方版归档没有、只有 300块 MOD 有」—— **是解包器漏读**
 * （`dat_unpack` 按条目自报长度做合法性检查，归档末尾几条被静默丢掉）。
 * 官方版一直有，而且是**繁体「絕技」**；MOD 那份是简体重画的「绝技」。
 *
 * 分类规则复用 `systems/skillbook.js` 的 `SKILL_KINDS`：
 * 帧 0「咒法」收 `咒法`+`阵法`，帧 1「絕技」收 `绝技`。
 */
export const SKILL_KIND_BOARD = Object.freeze({
  key: 'ITF502', frame: 0, width: 107, height: 108, x: 520, y: 120, offscreenX: 700,
});

/** 四行 / 两行的中心 y，量自板的像素（逐帧扫墨迹带，只有选中那行更高）。 */
export const CATEGORY_ROW_Y = Object.freeze([37, 67, 98, 130]);

/** 一页几行。原作战斗截图的用器列表正好 8 行，菜单两页也都是 8。 */
export const ROWS_PER_PAGE = 8;

/**
 * 列表行在**板内**的几何 —— 法寶与絕學共用这几个数（exe 两页给的完全一样）。
 *
 * ```
 *   行条 x=7  首行 y=52  行距 25
 *   名字 x=29          （= 行条 x + 22）
 *   数字 y = 行条 y + 5 （`ITF1019` 17×16 在 24 高的行里居中正是 +4~5）
 * ```
 */
const ROW_GEOM = { x: 7, firstY: 52, step: 25, nameDx: 22, textDy: 0, qtyDy: 5 };

/**
 * **法寶**这一页：列表板 + 行条 + 装饰 + 说明板 + 插图板。
 *
 * `LIST_ROW.qtyDx` 是**相对行条**的：exe 给的是板内 147，行条在板内 7。
 */
export const LIST_BOARD = Object.freeze({
  key: 'ITF0031', frame: 0, width: 218, height: 300, x: 292, y: 120, offscreenX: -300,
});
export const LIST_ROW = Object.freeze({
  key: 'ITF3005', width: 200, height: 24, ...ROW_GEOM, qtyDx: 140,
});
/** 翻页箭头的尺寸（`ITF3006`/`ITF3007` 都是 36×24），鼠标命中区就是它。 */
export const ARROW_SIZE = Object.freeze({ w: 36, h: 24 });

export const LIST_FLOURISH = Object.freeze({
  top: { key: 'ITF3006', x: 87, y: 9 },
  bottom: { key: 'ITF3007', x: 87, y: 268 },
});

/**
 * **絕學**这一页：换一块更宽的板（242×301）与更宽的行条（225），
 * 装饰也随之往右挪到 103 —— `(242−36)/2 = 103`，与 exe 给的值分毫不差。
 */
export const SKILL_LIST_BOARD = Object.freeze({
  key: 'ITF501', frame: 0, width: 242, height: 301, x: 260, y: 120, offscreenX: -300,
});
export const SKILL_ROW = Object.freeze({
  key: 'ITF500', width: 225, height: 24, ...ROW_GEOM,
  costDx: 133, costValueDx: 153,          // exe 板内 140 / 160，减行条 x=7
});
export const SKILL_FLOURISH = Object.freeze({
  top: { key: 'ITF3006', x: 103, y: 9 },
  bottom: { key: 'ITF3007', x: 103, y: 268 },
});

/**
 * 法寶的说明板 = **`ITF0031` 帧 1**（265×148），落在 (15,300)，
 * 正好接在插图板（120+179=299）底下。
 */
export const INFO_BOARD = Object.freeze({
  key: 'ITF0031', frame: 1, width: 265, height: 148, x: 15, y: 300, offscreenY: 500,
  pad: { x: 10, y: 25 }, lineH: 25, perLine: 10, maxLines: 4,
});

/** 絕學的说明板 = **`MEN5001` 帧 1**（218×200，与 `ITF501` 帧1 同尺寸）。 */
export const SKILL_INFO_BOARD = Object.freeze({
  key: 'MEN5001', menu: true, frame: 1, width: 218, height: 200,
  x: 30, y: 120, offscreenX: -300,
  pad: { x: 20, y: 30 }, lineH: 25, perLine: 7, maxLines: 6,
});

/** 法寶的插图板 = **`ITF0031` 帧 2**（182×179），落在 (98,120)。 */
export const ART_BOARD = Object.freeze({
  key: 'ITF0031', frame: 2, width: 182, height: 179, x: 98, y: 120, offscreenY: 500,
});

/**
 * 插图板里贴的**道具画** —— 与平时菜单同一份（`menus.json` 顶层 `artwork`）。
 *
 * 映射是确定性的：`表 = tables[编号 ÷ perTable]`、`帧 = 编号 mod perTable`，
 * **编号先按十六进制解成数**（`物品编号` 存的是十六进制串）。
 * 判据见 `ui/MenuScreen.artworkFrame` —— `MEN4012` 帧 51~55 渲出来正是
 * 金創藥/大補丸/九花玉露/十聖金丹/百草沁香，图里印着名字。
 */
export const ARTWORK = Object.freeze({
  tables: Object.freeze(['MEN4010', 'MEN4011', 'MEN4012', 'MEN4013', 'MEN4014']),
  perTable: 100, width: 182, height: 179, dx: 0, dy: 0,
});

/** 物品编号（十六进制串）→ `{asset, frame}`；没有插图返回 null。 */
export function artworkOf(code) {
  const n = parseInt(String(code ?? ''), 16);
  if (!Number.isFinite(n) || n < 0) return null;
  const table = Math.floor(n / ARTWORK.perTable);
  if (table >= ARTWORK.tables.length) return null;
  return { asset: ARTWORK.tables[table], frame: n % ARTWORK.perTable };
}

/**
 * **「確定使用 / 取消」框** —— 菜单的 `MEN0005`（179×87，2 帧）。
 *
 * ⚠️ **不是 `ITF036`**：那件印的是「確定使用／**是**／**否**」三行，
 * 而原作战斗里弹的是**两行**「確定使用／取消」，用户的原作截图为准。
 * 帧 0 选中「取消」、帧 1 选中「確定使用」（选中那行带装饰爪）。
 *
 * 🟡 落点量自原作截图 —— exe 里这个框的坐标在寄存器里（共用的对话框函数），
 * 工具取不到。已登台账。
 */
export const CONFIRM_BOX = Object.freeze({
  key: 'MEN0005', menu: true, width: 179, height: 87, x: 244, y: 304,
  frames: Object.freeze({ cancel: 0, confirm: 1 }),
});

/** 这一块要预载哪些**战斗归档**的包。菜单素材不在里面（加载方式不同）。 */
export function listPackKeys() {
  return [...new Set([
    CATEGORY_BOARD.key, SKILL_KIND_BOARD.key,
    LIST_BOARD.key, LIST_ROW.key, SKILL_LIST_BOARD.key, SKILL_ROW.key,
    LIST_FLOURISH.top.key, LIST_FLOURISH.bottom.key,
    INFO_BOARD.key, ART_BOARD.key, GLYPH_KEY,
  ])].sort();
}

/** 这一块要用哪些**菜单**素材（走 `menu-<名>` 纹理，由 BootScene 载）。 */
export function listMenuKeys() {
  return [SKILL_INFO_BOARD.key, CONFIRM_BOX.key, COST_ICON.key].sort();
}

/**
 * **中文数字的字形表**：`ITF1019`（17×16，13 帧）。
 * 渲出来是 `〇一二三四五六七八九`，**帧号＝数字本身**。
 * 步进 **16** 是 exe 真值（`call(x, y, 16, 16, ITF1019, …)`）。
 */
export const GLYPH_KEY = 'ITF1019';
export const GLYPH_ADVANCE = 16;

/** 顶部状态条/諸態页那套**阿拉伯数字**（`ITF0012`，6×10），步进 6（exe）。 */
export const SMALL_GLYPH_KEY = 'ITF0012';
export const SMALL_GLYPH_ADVANCE = 6;

/**
 * 绝学消耗那个小图标 —— **与平时菜单同一件素材**：`MEN5006`，
 * 帧 0 红勾玉＝耗体力、帧 1 蓝圆＝耗元气。
 */
export const COST_ICON = Object.freeze({
  key: 'MEN5006', frames: Object.freeze({ hp: 0, qi: 1 }),
});

/** 一个数拆成要画的帧号（每一位一帧）。 */
export function digitFrames(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return [];
  return String(Math.max(0, Math.round(n))).split('').map((c) => Number(c));
}

/** 第 `i` 行（页内下标）在板内的 y（行条的顶）。两页同一套几何。 */
export function rowY(i) {
  return ROW_GEOM.firstY + ROW_GEOM.step * i;
}

/**
 * 上下移动选择，**到头不回绕**（原作的列表是滚动的，不是循环的）。
 */
export function moveIndex(index, step, count) {
  if (count <= 0) return 0;
  const next = (Number(index) || 0) + step;
  return Math.min(count - 1, Math.max(0, next));
}

/** 全局下标 → 页码。 */
export const pageOf = (index) => Math.floor(Math.max(0, index) / ROWS_PER_PAGE);

/** 这一页要显示哪几条（全局下标区间）。 */
export function pageSlice(index, count) {
  const start = pageOf(index) * ROWS_PER_PAGE;
  return { start, end: Math.min(count, start + ROWS_PER_PAGE) };
}

/**
 * **战斗里能不能用这件东西**。
 *
 * 判据是 `作用场合`（`Ail2.ENC +172`，四值）：全库分布
 * 仅平时 47 / 不可用 42 / 仅战斗时 38 / 无限制 14，**装备 333 件全是「不可用」**。
 * ⚠️ 「仅平时」的在战斗里**要列出来但不能选**（原作画成**红字**）。
 */
export function usableInBattle(record) {
  return record?.作用场合 === '仅战斗时' || record?.作用场合 === '无限制';
}

/**
 * 这件东西在战斗的法寶列表里该不该出现。
 *
 * ⚠️ **装备也要列**（全都是「不可用」）—— 用户原话：「不能在战斗中使用的
 * 东西（**比如一些兵器**）显示为红色」。所以这里只挡掉没有记录的行。
 */
export function listedInBattle(record) {
  return Boolean(record);
}

/** **气/体力够不够放这门绝学**。 */
export function affordable(skill, state) {
  const hp = Number(state?.hp) || 0;
  const qi = Number(state?.qi) || 0;
  return hp > (Number(skill?.costHp) || 0) && qi >= (Number(skill?.costQi) || 0);
}

/**
 * 按每行几个字硬断行 —— 中文没有空格，Phaser 的 `setMaxWidth` 断不了。
 *
 * ⚠️ **标点不许另起一行**：满行之后遇到标点就挂在行尾（原作截图里
 * 「…引雷御電，」的逗号跟在行末）。
 */
export function wrapText(text, perLine = INFO_BOARD.perLine, maxLines = 0) {
  const body = String(text ?? '').replace(/\s+/g, '');
  if (!body) return '';
  const n = Math.max(1, perLine);
  const out = [];
  let line = '';
  for (const ch of body) {
    if (line.length >= n && !'，。、；：！？」）'.includes(ch)) {
      out.push(line);
      line = '';
    }
    line += ch;
  }
  if (line) out.push(line);
  return (maxLines > 0 ? out.slice(0, maxLines) : out).join('\n');
}

// ── 諸態页（`ui/StatusPage.js` 画）──────────────────────────────────

/**
 * 左板：位階/命/氣/歷練 + 八抗性 + 7×2 状态格。
 *
 * ⭐ **是 `ITF0050`（四位）不是 `ITF050`（三位）** —— 两件成对存在，
 * `ITF050` 渲出来抗性是**彩色小图标**、`ITF0050` 是**文字「火冰雷光／闇化析法」**，
 * 用户的原作截图是文字版，exe 点名的也正是 `ITF0050`。
 */
export const LEFT_BOARD = Object.freeze({
  key: 'ITF0050', frame: 0, width: 241, height: 332, x: 26, y: 121, offscreenX: -280,
});

/**
 * 右板：装备与四项战斗数值。
 *
 * ⭐ **是 `ITF0050` 的帧 1**（186×295），不是另一件 `ITF040` ——
 * exe 簇 8 就是「`ITF0050` 帧 1 从右边滑入」，落点 283。
 */
export const RIGHT_BOARD = Object.freeze({
  key: 'ITF0050', frame: 1, width: 186, height: 295, x: 283, y: 121, offscreenX: 700,
});

/**
 * 左板内各处的落位 —— **除标 🟡 的以外全是 exe 真值**（簇 7）。
 *
 * 数字一律**左对齐**、按 `step` 逐位排（exe 给的 `(x, y, step, step)`）。
 */
export const LEFT_SLOTS = Object.freeze({
  portrait: { key: 'ITF0051', x: 40, y: 32 },
  vname: { key: 'ITF0053', x: 14, y: 32 },
  hpBar: { key: 'ITF0004', x: 146, y: 62 },
  qiBar: { key: 'ITF0005', x: 145, y: 91 },
  /** 位階与歷練用大字形 `ITF1019`，步进 18（exe）。 */
  rank: { x: 171, y: 32, step: 18 },
  drill: { x: 67, y: 122, step: 18 },
  /** 命/氣的当前与上限用小字形 `ITF0012`，步进 6（exe）。 */
  hpCur: { x: 152, y: 69 }, hpMax: { x: 190, y: 69 },
  mpCur: { x: 152, y: 97 }, mpMax: { x: 190, y: 97 },
  /** 7×2 状态格（`ITF0052` 25×25）。exe 给了两行的 y（249/278）与首列 x。 */
  states: {
    key: 'ITF0052', x: 20, y: 249, stepX: 29, stepY: 29, cols: 7, rows: 2,
  },
  /** 🟡 八抗性的数：exe 在循环里，量自原作截图。 */
  resist: { leftX: 60, rightX: 150, firstY: 151, step: 21 },
});

/**
 * 右板内各处的落位 —— **量自 `ITF0050` 帧1 自己的像素**（exe 这几处在循环里）。
 *
 * 扫「明显比羊皮纸底色暗」的像素，内区（去掉 14px 边框）得到 8 条墨迹带：
 *
 * ```
 *   y 40-57   75-92   108-125  144-161   ← 兵刃＼ 護甲＼ 飾物＼ 諸能＼（x 19..72）
 *   y 174-191 199-216 225-241  251-268   ← 攻擊 護禦 命中 閃避（x 71..108）
 * ```
 *
 * 值画在标签右边：装备名从 x=76 起、四项数值从 x=112 起。
 * 字的顶比墨迹带高 3px（24px 字格里墨迹占 18px）。
 *
 * ⚠️ 上一版写的 22/55/88/121 是目测的，**整体高了 18px** —— 用户一眼看出
 * 「装备名称位置太高，已经错位了」。
 */
export const RIGHT_SLOTS = Object.freeze({
  weapon: { x: 76, y: 37 }, armor: { x: 76, y: 72 },
  trinket: { x: 76, y: 105 }, talent: { x: 76, y: 141 },
  /** 四项数值各自的 y（步进 25/26/26 不等距，所以逐个列出来）。 */
  stats: { x: 112, ys: Object.freeze([171, 196, 222, 248]) },
});

/** 八抗性的字段名，顺序与板上印的一致（左列四个、右列四个）。 */
export const RESIST_FIELDS = Object.freeze([
  ['焚火', '冰凛', '雷荧', '烨光'],
  ['魔厉', '化相', '析魂', '外法'],
]);

/** 这一页要预载哪些包 —— 拿上面的表反查。 */
export function statusPackKeys() {
  return [...new Set([
    LEFT_BOARD.key, RIGHT_BOARD.key,
    LEFT_SLOTS.portrait.key, LEFT_SLOTS.vname.key, LEFT_SLOTS.states.key,
    LEFT_SLOTS.hpBar.key, LEFT_SLOTS.qiBar.key, GLYPH_KEY, SMALL_GLYPH_KEY,
  ])].sort();
}
