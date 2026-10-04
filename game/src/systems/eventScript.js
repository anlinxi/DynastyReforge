/**
 * 事件脚本执行器 —— 把 map.json 的 `scripts` 动作序列真的跑起来。
 *
 * 在此之前前端只会把一个槽里的对白一股脑念完，切图、条件分支全丢了
 * （见 docs/判据/数据链路.md §6）。原作的一个槽是一段**带控制流的子事件序列**：
 *
 *     op71  判断 flag[1] == 9 → 成立跳到子事件 #5
 *     op83  黑幕出现
 *     op58  载入 mp0207，主角落在 (648,502) 朝向 5
 *     op84  黑幕消失
 *     op0   终止
 *     #5:   op51 「現在滿城的西夏軍都在搜捕我們....」
 *
 * 执行器自己消化不需要表现的指令（分支、跳转、写旗标、终止、未知指令），
 * 只把需要演出来的动作吐给调用方：`say` / `goto_map` / `fade_out` /
 * `fade_in` / `wait` / `set_avatar`。
 *
 * 指令语义出处见 tools/eve_actions.py。
 */

/** 跳转成环时的兜底步数。原作最长的槽是 152 条，留足余量。 */
export const MAX_STEPS = 4096;

/**
 * ⚠️ **保留的临时标志位**（`0x3E7` = 999）。它不存任何剧情进度。
 *
 * 「扣除物品/金钱是否成功」「判断装备/属性是否成立」「随机数结果」
 * 一律往这里写，紧跟着一条比较指令把它读出来。**不照做不会报错，
 * 只会静默走错分支** —— 原作脚本大量依赖这个约定。
 */
export const TEMP_FLAG = 0x3E7;

/**
 * 执行器**自行消化**、不吐给调用方的动作类型。
 *
 * 分三类：
 * * 控制流（`branch` / `jump` / `end`）
 * * 纯旗标运算（`set_flag` / `add_flag` / `sub_flag` / `random`）
 * * 不需要表现的（`unknown` / `noop`）
 *
 * ⚠️ **`await_actions`（op29）不在这里** —— 它要等场上的动作演完，
 * 只有调用方知道还有什么在跑。它是原作**唯一的同步点**：
 * `play_anim` / `actor_walk` 这些是「启动就走」，动画与对白本来就该并行；
 * 把它们做成阻塞式、再把 `await_actions` 当空操作，时序整个就错了
 * （表现是"话还没说完人已经砍上了"）。
 * 脚本里 `[74] play_anim` 前后各夹一条 `await_actions`，
 * 而 `[83] play_anim` 后面直接跟 `say` —— 后者就是要边播边说。
 *
 * ⚠️ `unknown` **必须留在这里且必须占一个下标** —— 条件跳转按下标寻址，
 * 丢掉一条会让后面所有分支整体错位。
 *
 * ⚠️ `test_equip` / `test_stat` / `item_lose` / `money_lose` **不在这里** ——
 * 它们要查/改游戏状态，由调用方处理完再用 `resolve()` 把结果写回临时标志位。
 */
const INTERNAL = new Set([
  'branch', 'jump', 'end', 'unknown', 'noop',
  'set_flag', 'add_flag', 'sub_flag', 'random',
  // ⭐ `use_item_here` 是**纯跳转表**（见 `itemChoicesAt`），执行器自己消化。
  // `test_item_used` 不在这里 —— 它要停下来问玩家，交给场景。
  'use_item_here',
]);

/**
 * **「拿道具放上去」那一套是怎么写的**（`test_item_used` + `use_item_here`）。
 *
 * 判据是迦夏之窟三根柱子（`MP0302` 槽 16/17/18），三槽结构一模一样：
 *
 * ```
 * 0  test_item_used target=3      没拿道具 → 往下走；拿了 → 跳 3
 * 1  say「這柱子的式樣好奇怪…」      ← 只是看看
 * 2  end
 * 3  use_item_here item=402 → 7   ┐
 * 4  use_item_here item=403 → 20  ├ 按拿出来的那件分派，**一串要整组读**
 * 5  use_item_here item=404 → 20  ┘
 * 6  end                           ← 一个都不匹配
 * 7  …放对了：orb 出现、柱子消失、扣道具、旗标506 +1，满 3 开门
 * 20 …放错了：闪红光、掉 70 命、「好痛….看來這石球不是放在這裡。」
 * ```
 *
 * ⚠️ **`target` 是跳转下标，不是「位置」。** 释义写「置放到特定位置」，
 * 可三根柱子里 `402/403/404` 的 target 分别是 `7/20/20`、`20/7/20`、
 * `20/20/7` —— 同一件道具在不同柱子上 target 不同，而 7 与 20 正是
 * 「放对」与「放错」两段的下标。它就是个 switch。
 *
 * ⚠️ **一串要整组读**，与「是/否 vs 三选一」那条同理（判据表里有）：
 * 只读第一条 `use_item_here` 会让玩家除了 402 之外拿什么都掉进 `end`，
 * 表现是「放上去没反应」。
 *
 * @param {object[]} actions 整槽脚本
 * @param {number} index `test_item_used.target`，也就是跳转表的第一条
 * @returns {number[]} 候选道具代码（**十进制**，脚本里就是这么写的）
 */
export function itemChoicesAt(actions, index) {
  const out = [];
  for (let i = Number(index); i >= 0 && i < (actions?.length ?? 0); i += 1) {
    if (actions[i]?.type !== 'use_item_here') break;
    out.push(Number(actions[i].item));
  }
  return out;
}

const COMPARE = Object.freeze({
  '==': (a, b) => a === b,
  '!=': (a, b) => a !== b,
  '>': (a, b) => a > b,
  '>=': (a, b) => a >= b,
  '<': (a, b) => a < b,
  '<=': (a, b) => a <= b,
});

/**
 * 剧情旗标。原作把它们存在存档的 `0xE179 + 编号*2` 处，
 * 这里只需要「编号 → 值」这层语义，未写过的一律为 0。
 */
export class FlagStore {
  #values;

  constructor(initial = {}) {
    this.#values = new Map(
      Object.entries(initial).map(([key, value]) => [Number(key), Number(value)]),
    );
  }

  get(flag) {
    return this.#values.get(Number(flag)) ?? 0;
  }

  /**
   * 这个旗标**被写过吗**。
   *
   * ⚠️ **「没写过」与「写成 0」是两回事。** 场景对象的存在与否看 `SCI +0xFF`
   * 那个旗标：释义原话「玩家**还未拾取**时存档 `0xE179+Y*2` 处**会有 1**，
   * 拾取过后变为 0」—— 也就是新游戏那些位置本来就是 1。
   * 而 `get()` 对没写过的返回 0，直接拿它判断会让**所有带旗标的对象一开局就消失**
   * （兰州城的三个士兵、卖羊皮封卷的都是这么没的）。
   */
  has(flag) {
    return this.#values.has(Number(flag));
  }

  set(flag, value) {
    this.#values.set(Number(flag), Number(value));
  }

  /** 导出快照，供存档使用。 */
  snapshot() {
    return Object.fromEntries(this.#values);
  }
}

/**
 * `0x3E7` 是**通用返回值寄存器**，不只是「是/否的答案」。
 *
 * ## 判据：全库 105 组连续读 `0x3E7` 的分支
 *
 * 往这里写的一共五类，写完紧跟着一条比较把它读出来：
 *
 * | 前一条 | `999` 的含义 | 处数 |
 * |---|---|---|
 * | `money_lose` / `item_lose` | 扣得动＝1 | 12 |
 * | `test_equip` / `test_stat` | 判定成立＝1 | 8 |
 * | `random` | 1~max 的随机数 | 3 |
 * | **`say`** | **玩家选了第几行** | 82 |
 *
 * 原作的选择**没有独立 opcode**：`剧情代码释义.txt` 的 48 条里没有，
 * 对白指令的 8 字节 payload 也没有任何一位标记问句（逐字节扫过全库 6478 条
 * 对白：字节 0~2 是人物/表情/左右侧，字节 3~6 是行号 u32，字节 7 是
 * 「告一段落」，`op5` 与 `op51` 只是概率差别 6.2% vs 0.8%）。
 * 所以引擎只可能是**向后看**：对白后面跟着几条读 `0x3E7` 的比较，
 * 这句就是选择句，那几个比较值就是可选项。
 *
 * ## 值＝最后一页上的第几行（1 起）
 *
 * 选项就写在对白正文里，用 `\x01` 分段。`MP0304` 槽 10：
 *
 * ```
 * 65  say  8 段：4 句心理描述 + 「我該怎麼回答」+ 三个「」选项
 * 66  branch 999==2 → 70      「....真對不住，驚擾了姑娘....」
 * 67  branch 999==3 → 73      「....我沒事。姑娘是....」
 * 68  branch 999==4 → 76      「是妳........」   ← 这一支还 add_flag 551
 * 69  end                     （没选＝直接结束）
 * ```
 *
 * 8 段 ＝ 两页（每页 4 行），第 2 页是第 4~7 段，选项落在行 2/3/4 ——
 * 正是那三个比较值。复核：`MP1101` 槽 81（4 段一页，选项在行 3/4 → 值 3/4）、
 * `MP0701` 槽 27（4 段，值 2/3/4）、`MP0610A` 槽 9（3 段，值 2/3）全部吻合。
 *
 * ## 是/否是同一机制的退化形态
 *
 * 值域落在 `{1,2}` 时原作弹的是独立的小框 `F-YESNO`（素材落位 (488,299)，
 * 三张图分别是「是」带黑框 / 「否」带黑框 / 都不带），**是=1、否=2**。
 * 判据：`MP0202` 客栈「您要在敝店住宿嗎？」`999==1` → 「是的，請給我們一間客房」；
 * `MP0704` 槽 15「準備好了麼？」`==1` → 出发、`==2` → 再等等。
 *
 * ⚠️ 从前 `resolve(false)` 写的是 **0**，而原作的「否」是 **2** ——
 * `MP0704` 那类把两支都写出来的问句永远走不进否支。
 *
 * @param {Array<number>} values 连续 999 分支的比较值
 * @returns {'yesno'|'lines'} 该弹哪种选择
 */
export function choiceKind(values) {
  return values.every((v) => v === 1 || v === 2) ? 'yesno' : 'lines';
}

/** 是/否框的两个取值。**否是 2，不是 0。** */
export const ANSWER_YES = 1;
export const ANSWER_NO = 2;

/** 这一条动作是不是「读临时标志位」的比较。 */
export function isQuestion(action) {
  return action?.type === 'branch' && Number(action.flag) === TEMP_FLAG;
}

/**
 * 建一个执行器。反复调用 `next()` 取下一个要演的动作，返回 `null` 表示这段演完了。
 *
 * @param {Array<object>} actions 一个槽的动作序列，下标即子事件序号
 * @param {FlagStore} flags 剧情旗标
 * @param {() => number} rng 随机源，测试里注入固定值
 * @param {number} start 从第几条开始 —— **跨地图续演**用，见 `cursor`
 */
export function createRunner(actions, flags = new FlagStore(), rng = Math.random,
                             start = 0) {
  const script = Array.isArray(actions) ? actions : [];
  let cursor = Number.isInteger(start) && start >= 0 ? start : 0;
  let steps = 0;
  let finished = false;
  /**
   * 玩家刚拿出来要放上去的那件道具（十进制代码），没拿就是 null。
   * 由场景在玩家选完之后调 `useItem()` 写进来，`use_item_here` 读它分派。
   */
  let usedItem = null;

  const jumpTo = (target) => {
    const next = Number(target);
    // 越界的跳转目标按结束处理：原作脚本里确实存在指向槽外的分支，
    // 崩掉整个场景比停下来糟糕得多。
    if (!Number.isInteger(next) || next < 0 || next >= script.length) {
      finished = true;
      return;
    }
    cursor = next;
  };

  const consume = (action) => {
    switch (action.type) {
      case 'end':
        finished = true;
        return;
      case 'branch': {
        const compare = COMPARE[action.compare];
        const hit = compare
          ? compare(flags.get(action.flag), Number(action.value))
          : false;
        if (hit) jumpTo(action.target);
        else cursor += 1;
        return;
      }
      case 'jump':
        jumpTo(action.target);
        return;
      case 'set_flag':
        flags.set(action.flag, action.value);
        cursor += 1;
        return;
      case 'add_flag':
        flags.set(action.flag, flags.get(action.flag) + Number(action.value));
        cursor += 1;
        return;
      case 'sub_flag':
        flags.set(action.flag, flags.get(action.flag) - Number(action.value));
        cursor += 1;
        return;
      case 'use_item_here':
        // 跳转表的一格：拿出来的正是这件 → 跳过去，并把「拿着」这个状态清掉
        //（一次交互只放一件；不清的话下一根柱子会以为玩家又拿了同一件）。
        if (usedItem !== null && Number(action.item) === usedItem) {
          usedItem = null;
          jumpTo(action.target);
        } else {
          cursor += 1;
        }
        return;
      case 'random':
        // 原作：在临时标志位产生 1～max 的随机数，随后用比较指令读。
        flags.set(TEMP_FLAG, 1 + Math.floor(rng() * Math.max(1, Number(action.max))));
        cursor += 1;
        return;
      default:
        // unknown：占位跳过，保持后续跳转目标的下标不错位
        cursor += 1;
    }
  };

  return {
    /**
     * 把一条「要查游戏状态」的动作的结果写回临时标志位。
     *
     * 调用方拿到 `test_equip` / `test_stat` / `item_lose` / `money_lose`
     * 这类动作，自己去查背包或角色，然后调这个把成败告诉执行器 ——
     * 紧跟着的比较指令就是读它。
     *
     * @param {boolean} ok 成立/扣除成功
     */
    resolve(ok) {
      flags.set(TEMP_FLAG, ok ? 1 : 0);
    },

    /**
     * 告诉执行器「玩家拿出了哪件道具」。紧跟着的那串 `use_item_here` 读它。
     * 传 null 表示取消（那就走「只是看看」那一支）。
     */
    useItem(code) {
      usedItem = code === null || code === undefined ? null : Number(code);
    },

    /** 现在手上拿着道具吗。`test_item_used` 要靠它决定是直接跳还是先问玩家。 */
    holdingItem() {
      return usedItem !== null;
    },

    /** 外部要求的跳转（`test_item_used` 选完之后跳进跳转表）。 */
    jump(target) {
      jumpTo(target);
    },

    /** 从某一条起的**整组** `use_item_here` 候选，见 `itemChoicesAt`。 */
    itemChoices(index) {
      return itemChoicesAt(script, index);
    },

    next() {
      while (!finished && cursor < script.length) {
        if (++steps > MAX_STEPS) {
          finished = true;
          break;
        }
        const action = script[cursor];
        if (!action) {
          finished = true;
          break;
        }
        if (!INTERNAL.has(action.type)) {
          cursor += 1;
          return action;
        }
        consume(action);
      }
      return null;
    },

    /**
     * 下一条**未消化**的动作长什么样，不推进游标。
     *
     * ⚠️ 用途只有一个：**判断当前这句对白是不是「询问」**。
     * 原作的是/否选择没有独立指令，也没有任何字段标记 —— 判据是
     * 「这句对白的下一条正在读临时标志位 `0x3E7`」。见 `isQuestion`。
     */
    peek() {
      return script[cursor] ?? null;
    },

    /**
     * 当前这句对白后面跟着的**整组**选择分支的比较值，按脚本顺序。
     * 不是选择句就返回空数组。
     *
     * ⚠️ **要一次读完连续的那一串**，不能只看一条：`MP0304` 的三选一是
     * `999==2 / ==3 / ==4` 三条并排，只看第一条就只知道有 2，
     * 弹出是/否选「是」写 1，三条一条都不命中，脚本静默走到 `end` ——
     * 表现就是「对话卡死、框还留在屏幕上」。
     */
    peekChoices() {
      const values = [];
      for (let i = cursor; i < script.length; i += 1) {
        if (!isQuestion(script[i])) break;
        values.push(Number(script[i].value));
      }
      return values;
    },

    /**
     * 玩家选完了，把**选项本身的值**写回临时标志位。
     *
     * 与 {@link resolve} 分开是因为语义不同：`resolve` 写的是布尔成败
     * （扣钱扣物品判装备），这里写的是原样的比较值（是=1/否=2/行号）。
     * 混成一个函数的话，`否` 会被写成 0 而不是 2。
     *
     * @param {number} value 被选中的那一支的比较值
     */
    answer(value) {
      flags.set(TEMP_FLAG, Number(value));
    },

    get done() {
      return finished || cursor >= script.length;
    },

    /**
     * 下一条要执行的子事件序号。**跨地图续演靠它**。
     *
     * 原作有大量「切图之后接着演」的过场 —— 兰州城废屋那一槽
     * `goto_map` 在第 8 条，而对白从第 15 条才开始。换场景等于重建场景对象，
     * 执行器会连同旧场景一起没掉；把这个值连同槽号存进 registry，
     * 新场景起来后用 `start` 参数接着跑。
     */
    get cursor() {
      return cursor;
    },
  };
}

/** 找到指定影片所在的子事件起点，保留影片之前的淡出、音乐等指令。 */
export function movieSegmentStart(actions, movie) {
  const at = actions.findIndex(a => a.type === 'play_movie' && Number(a.movie) === Number(movie));
  if (at < 0) throw new Error(`剧情缺少影片 ${movie}`);
  for (let i = at - 1; i >= 0; i--) {
    if (actions[i].type === 'end') return i + 1;
  }
  return 0;
}
