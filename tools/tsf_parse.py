#!/usr/bin/env python3
"""解析 / 修改幽城幻剑录的存档 `.TSF`。

**存档没有加密**，明文小端 int32，95% 的字节是 0。

## 布局（2026-08-30 实测标定，官方版 13 个存档交叉验证）

```
+0      存档名（Big5，`\\0` 结尾，显示在读档界面上，内容是地名）
+44     背包 6 个分类，每类 4004 字节：
            数量[500]  2000 B
            代码[500]  2000 B
            条目数        4 B
        顺序：用器 / 兵刃 / 护甲 / 饰物 / 暂置 / 杂类
+24     **存档时间**：日 / 月 / 时 / 分，各 int32（@24 日、@28 月、@36 时、@40 分）
        判据：15 个存档逐个与文件修改时间吻合 —— Save002~009 都是 19/11
        （11月19日）、Save010 是 26、Save011 是 29、Save013 是 13/8。
        ⚠️ 名字是**变长**串，但这些字段是**固定偏移**（int32@8 起就对齐了）。
+24068  金钱
+24072  12 字节，❓ 未解（三个等差指针，疑似缓冲区地址，不是数据）
+48128  角色区，9 条 × 848 字节，下标即战斗角色代码（0 是占位）
+55760  1760 字节，🟡 **内存垃圾** —— `NewGame` 里全是 0xCCCCCCCC
        （MSVC 未初始化标记），真实存档里是像指针的值（1772416 / 985182 …）
+57513  **追加区长度**：`文件长度 − 67721`。67721 B 的档写 0，104657 B 的档写
        36936。16/16 全中 —— 所以两种大小**都是合法格式**，不是被改过
        （见下方「两种大小」）
+57521  **当前地图**：ASCII 路径串 `mp<图号>\\MP<mp图号>.SCI`（2026-09-05 解出）
        缓冲区**定长 50 字节**（57521~57570），串短时尾巴留着上次的残渣，
        原作不清零 —— 所以那 30 字节看着像垃圾，其实是缓冲区尾
+57571  **主角 X**（像素）
+57575  **主角 Y**（像素）
+57579  **主角朝向**，0~7（八方向）
+57583  ❓ 未解，值域 {1, 3, 4}；`MP3001`（世界地图）恒为 1
+0xE179 剧情旗标，`0xE179 + 编号×2`
```

## 两种大小都是合法的

`NewGame` / `Save001` / `Save013` 是 67721 B，其余是 104657 B。
**差值 36936 就明写在 `@57513`**，两种都是原作自己生成的。
（此前记作「被修改器改过」是错的 —— 用户 2026-09-05 新存的
`Save015~017` 也是 104657 B。）追加区仍未解，写回时原样保留。

## 写回：**以原始字节为底、只覆写认识的字段**

`write_save(原始字节, 改动) -> 新字节`。未知区（尤其 +55760 那 1760 字节的
内存垃圾、以及大档尾部的 36936 字节）**原样保留** —— 这样不必把 100% 的
字节搞懂，也能保证写出来的档原作读得了。

**自检：`read → write` 必须字节相同**（`--roundtrip`）。这是唯一可靠的回归。

## 主角坐标：**已解**（2026-09-05）

用户确认「读档后人物就出现在存档时的位置」，于是坐标一定在档里。
第一轮对照实验（`(015↔016) − (016↔017)`）没找到，原因是**方法本身有洞**：
那种相减会把落在「疑似内存垃圾区」内部的字段一并划掉，而坐标恰好
就在那片的**末尾**（57571），紧挨着地图路径缓冲区的残渣。

正确的定位方式是**看结构**而不是看差异：地图路径串在 57521，
缓冲区定长 50 字节，`57521 + 50 = 57571` —— 后面紧跟三个 int32。

判据（16/16，无例外）：

* 每个存档的 (X, Y) 都落在**它自己那张图**的尺寸内。`MP0905` 是 1024×768，
  存的是 (205, 373)；`MP3001` 是 3456×1800，存的是 (2709, 1762)
* `Save015`(745,469) → `Save016`(1333,469) → `Save017`(1333,469)：
  位置变则变、原地重存则不变
* `NewGame` 是 (549, 353) 朝向 0，地图 `MP0102B`（夏侯仪房间），
  且那一片是**干净的零**而非 `0xCC` —— 说明它是真结构，不是未初始化内存
* 朝向的取值集合是 {0,1,2,3,4,6,7}，正好是八方向的范围

判据：`44 + 6×4004 = 24068` 正好落在金钱上，两端闭合；
六个分类的「条目数」与各自非零条目数逐一吻合（12/10/9/6/20/2）。

## 角色记录：**与 `Api.enc` 同一布局**

拿 `Save001` 的夏侯仪与 `Api.enc` 第 1 条逐字节比，848 字节里
212 个 int32 **有 202 个相同**，不同的 10 个正是游戏中会变的：
八抗性（`+104~132`，存档里是算出来的内禀值）与两个装备槽。

所以 `export_gamedata.py` 已标定的 `API_FIELDS` 在这里直接可用，
反过来存档也帮我们标出了 `Api.enc` 里原先没定的几项（位阶、历练、剩余五内、
绝学数量）—— 那几项在 `Api.enc` 里全是 0，单看 enc 定不下来。

⚠️ **`NewGame.TSF` 不可用于标定。** 它是 2001 年的原始模板，布局与真实存档
对不上：五外全是 40（不是夏侯仪的 60/40/40/10/50）、抗性区多一个字段、
装备槽是 0。新建游戏时属性应当由 `Api.enc` 覆盖。**标定一律拿真实存档做。**

用法:
    python3 tsf_parse.py <存档.TSF>                     # 摘要
    python3 tsf_parse.py <存档.TSF> --json out.json     # 导出结构
    python3 tsf_parse.py <存档.TSF> --character 1       # 摊开一个角色
    python3 tsf_parse.py <存档.TSF> --verify            # 拿存档反验我们的公式

## §自检读法（`--verify`）

⚠️ **官方版自带的 `Save002`~`Save011` 是被修改器改过的**：金钱一律 ~100 万，
角色 7/8 是「位阶 60 而历练 0」的预置槽。拿它们验位阶必然对不上 ——
不是公式错，是数据本身自相矛盾。**干净的样本是 `Save001` 与 `Save013`**
（金钱 170），它们除预置槽外零不吻合。

位阶公式已被硬证据钉死：`+40` **永远等于 `历练门槛[位阶]`**，
12 个存档、每个角色、无一例外（位阶 5→1600、14→17500、24→70000）。

## §待查（2026-08-30 未解，**都不阻塞读档** —— 抗性是派生值，我们自己现算）

1. **内禀抗性 8% 对不上。** 拿 12 个官方存档 × 8 项 = 392 个采样，
   `抗性基准 + Σ(五内×系数)` 四舍五入后吻合 **361 个（92.1%）**。
   不吻合的 31 个**全部集中在角色 2 / 5 / 7**（冰璃 / 古伦德 / 霍雍），
   而角色 1 / 3 / 4 是 1/12、0/10、0/8 —— 几乎全对。
   查过一个假设并**否定**：不是「这些角色固有抗性不是 100」，
   `Api.enc` 里我方八人的 `+104~132` 全是 100。
   另试过把「魔→外法」系数从资料的 −0.75 改成 −0.7，外法从 29/49 升到 35/49，
   仍不到位，**证据不足，没有改表**。
2. **抗性偶尔存成负数**，绝对值与公式吻合，出现规律未知（见 `verify` 里的注释）。
"""
from __future__ import annotations

import argparse
import json
import re
import struct
import sys
from pathlib import Path

#: 存档头。**天书页那条记录要显示的东西全在这里** —— `MEN8001` 的第 0 帧
#: 上印着「地點/  等級/」「日期/ 年 月 日 時間/ ：」，逐项对应：
#:
#: | 条上的字 | 偏移 | 判据 |
#: |---|---|---|
#: | 地點 | `+0` 存档名 | 原作存的就是地名（「蘭州城」「西域遼疆」） |
#: | 等級 | `+20` | 与角色区的位阶一致；随进度单调增（1→3→5→…→24） |
#: | 日期 年 | `+32` | 末两位：2020→20、2022→22、2026→26、`NewGame` 2001→1 |
#: | 日期 月 | `+28` | 与文件修改时间逐个吻合 |
#: | 日期 日 | `+24` | 同上 |
#: | 時間 时 | `+36` | 同上 |
#: | 時間 分 | `+40` | 同上 |
#:
#: ⚠️ 存档名是**变长** Big5 串，但这些字段是**固定偏移** —— 名字短的时候
#: 中间那段是上次留下的垃圾，不要清。
LEVEL_OFF = 20
DATE_OFF = {"日": 24, "月": 28, "年": 32, "时": 36, "分": 40}

#: 背包区起点，以及每个分类块的三段长度。
PACK_BASE = 44
PACK_SLOTS = 500
PACK_STRIDE = PACK_SLOTS * 4 * 2 + 4          #: 数量 + 代码 + 条目数 = 4004

#: 六个分类，**顺序即存档里的顺序**。
#:
#: ⚠️ 与前端 `CATEGORIES`（法宝页帧号顺序：用器/兵刃/护甲/饰物/杂类/暂置）
#: **最后两格是反的**。判据：`Save013`（河州鎮，开局不久）只有第 5 类有东西，
#: 七件混着彩石弹珠/布袍/金创药/护身匕首 —— 那正是「捡到还没分发」的暂置。
PACK_CATEGORIES = ("用器", "兵刃", "护甲", "饰物", "暂置", "杂类")

MONEY_OFF = PACK_BASE + len(PACK_CATEGORIES) * PACK_STRIDE   #: 24068

#: ## ⭐ 存档里有**两套**背包+金钱（2026-09-12 解出）
#:
#: 一整块是 `背包(24024) + 金钱(4) + 指针(12) = 24040`，**并排放两块**：
#:
#: ```
#: 44      背包[0] 24024 ┐        24084   背包[1] 24024 ┐
#: 24068   金钱[0]     4 ├ 第 0 套  48108   金钱[1]     4 ├ 第 1 套
#: 24072   指针       12 ┘        48112   指针       12 ┘
#: 48124   当前用哪一套  4   ← 0 / 1
#: 48128   角色区
#: ```
#:
#: **两端闭合**：`44 + 2×24040 + 4 = 48128`，正好顶到角色区起点（见 `assert`）。
#: 那 12 字节「指针」是 C++ 对象里指向数量/代码数组的成员，**相差 2000 正是
#: 两个数组的间距** —— 不是数据。
#:
#: ### 判据：霍雍那段用第 1 套
#:
#: 用户拿原作截图对出来的：`Save009`（思謁之間，队伍只有霍雍）在原作里
#: **背包是空的、金钱是 0**，而第 0 套明明装着 59 件东西、967348 钱。
#:
#: | 存档 | `@48124` | 金钱[0] | 金钱[1] | 背包[1] |
#: |---|---|---|---|---|
#: | `Save009` / `Save010`（霍雍） | **1** | 967348 | **0** | **空** ← 原作显示的就是它 |
#: | `Save011`（主队，霍雍那段之后） | 0 | 967348 | **1955** | **昂昴角簪×1** |
#: | 其余 19 个 | 0 | … | 0 | 空 |
#:
#: `@48124` 为 1 的**只有那两个霍雍存档**，22/22 无例外；旗标 606 也只在这两档是 1。
#:
#: ### ❌ 两条旧结论就此推翻
#:
#: 1. **「内存A(24072~48128) 是内存快照、不是游戏数据」** —— 那 24056 字节
#:    就是第 1 套背包＋金钱。当时判它是垃圾的理由是「24026 字节恒为 0」，
#:    而**空背包在字节上就是全 0** —— 正好是我用来判定"垃圾"的特征。
#: 2. **「这里没有第 7 个物品容器」** —— 结构是真的（`40100 = 24084 + 4×4004`
#:    正是第 1 套「暂置」类的第一格），错的是把它解释成"主队的第 7 个容器"。
#:    用户那句「save011 身上并没有昂昂角簪」**恰恰证明它不属于主队**。
PACK_BLOCK = len(PACK_CATEGORIES) * PACK_STRIDE + 4 + 12     #: 24040
PACK_GROUPS = 2
ACTIVE_PACK_OFF = PACK_BASE + PACK_GROUPS * PACK_BLOCK       #: 48124


def pack_base(group: int) -> int:
    """第 `group` 套背包的起点。"""
    return PACK_BASE + int(group) * PACK_BLOCK


def money_off(group: int) -> int:
    """第 `group` 套金钱的偏移。"""
    return MONEY_OFF + int(group) * PACK_BLOCK

#: 角色区。**长度与 `Api.enc` 相同**，下标即战斗角色代码。
CHAR_BASE = 48128

#: **两端闭合**：两套背包块 + 那个「当前用哪一套」的 int32，正好顶到角色区。
#: 这一行是整段结构最硬的自检 —— 少算一个字节它立刻就不成立。
assert ACTIVE_PACK_OFF + 4 == CHAR_BASE, "背包两块 + 当前下标 应当正好接到角色区"
CHAR_STRIDE = 848
CHAR_COUNT = 9

#: 角色记录里已标定的字段。偏移与 `Api.enc` 通用。
#:
#: 位阶 / 历练 / 剩余五内 / 绝学数量 这四项是**靠存档定出来的** ——
#: 它们在 `Api.enc` 里全是 0，单看 enc 无从下手。做法是拿同一个角色
#: 在六个不同进度的存档上做差分，位阶 1→1→3→11→21→24 单调增长，
#: 而 `+40` 恰好等于 `历练门槛[位阶]`（600/9700/70000 逐个对得上），
#: 这一条同时验证了门槛表的读法。
CHAR_FIELDS = {
    0: "角色代码",
    32: "位阶",
    36: "已有历练",
    40: "下阶门槛",       # 派生值，等于 历练门槛[位阶]；留着当自检用
    44: "命极", 48: "命", 52: "气极", 56: "气",
    60: "膂力", 64: "体魄", 68: "灵力", 72: "迅捷", 76: "机运",
    80: "剩余五内",
    #: **曾入队**（0 = 加入过，1 = 从未加入）。2026-09-05 解出，
    #: **2026-09-11 订正语义** —— 它不是「当前队伍」。
    #:
    #: 判据：拿 16 个存档按主线进度（旗标 1）排序，这一列**严格单调**地
    #: 从「一个都没有」长到七个人，入队顺序与剧情指令 `party_join` 的
    #: member 序列 **2,3,4,5,8 完全一致**。
    #:
    #: ⚠️ **但它只增不减，所以拿它当队伍是错的。** `Save009`（思謁之間）
    #: 这一列是 `{1,2,3,4,5}`，而原作那条存档的头像只有**霍雍一个人**；
    #: `Save011` 是 `{1,2,3,4,5,7,8}` 七个人，原作画的是**三个**。
    #: 当前队伍在**队伍区**（见 `PARTY_*`），别再用这一列。
    156: "曾入队",
    168: "绝学数量",
    # 官方战斗单位+0x84c对应角色记录；4232d0/421a00/423470读写这十个计数。
    **{316 + i * 4: f"魂石熟练{i+1}" for i in range(5)},
    **{336 + i * 4: f"魂石积累{i+1}" for i in range(5)},
}

#: ## 队伍区 —— **当前队伍是谁、各站哪一格**（2026-09-11 解出）
#:
#: 三段连着的定长数组，夹在「内存B」那片运行时垃圾里，但它们本身是**结构**：
#:
#: ```
#: 56608  成员代码[5]   int32，只有前「人数」个算数，后面是上一次的残渣
#: 56648  阵型位置[5]   int32，与成员一一对应，取值 0~7（战场格号）
#: 56688  人数          int32
#: ```
#:
#: ### 判据一：人数与原作画面逐条吻合（22/22）
#:
#: | 存档 | 人数 | 前「人数」个成员 | 原作天书页画了几个头像 |
#: |---|---|---|---|
#: | `Save002` 蘭州城 | 2 | 夏侯仪 / 封铃笙 | —— |
#: | `Save008` 鐵衛軍石塔 | 5 | 夏侯仪/冰璃/封铃笙/慕容璇玑/古伦德 | —— |
#: | **`Save009` 思謁之間** | **1** | **霍雍** | **1** ✅ 用户截图 |
#: | **`Save010` 樓蘭城** | **1** | **霍雍** | **1** ✅ |
#: | **`Save011` 居遠客棧** | **3** | 夏侯仪/冰璃/慕容璇玑 | **3** ✅ |
#:
#: `Save009` 同时是 `AVATAR_OFF=4`（行走形象＝霍雍）那两个存档之一 ——
#: 两处独立字段互证「这一段主角就是霍雍一个人」。
#:
#: ### 判据二：阵型位置「前 n 个互不相同」（22/22）
#:
#: 一格站一个人，所以前「人数」个位置必须两两不同。22 个存档全中，
#: 且取值全落在 `0~7`（与遇敌组的 `位置` 同一套格号，见
#: `game/src/systems/battlefield.js`）。尾巴上的残渣会重复 ——
#: 例如 `Save011` 全数组是 `[0,1,2,3,4]` 而人数 3，`Save004` 是
#: `[5,1,0,4,4]` 末尾撞了一对，**正说明只能读前 n 个**。
#:
#: ⚠️ 曾经拿角色记录的 `+156` 当队伍，那是错的 —— 见该字段的注释。
PARTY_CODES_OFF = 56608
PARTY_SLOTS_OFF = 56648
PARTY_COUNT_OFF = 56688
PARTY_MAX = 5

CHAR_NAME_OFF, CHAR_NAME_LEN = 4, 20
WUNEI_OFF = 84                     #: 迅 烈 神 魔 魂，各 4 字节
RESIST_OFF = 104                   #: 八抗性（内禀），**有符号** —— 实测出现过 −90
EQUIP_OFF = 144                    #: 兵刃 / 护甲 / 饰物
SKILL_OFF, SKILL_MAX = 172, 36     #: 绝学代码表，exe 原话「最多３６种」

WUNEI = ("迅", "烈", "神", "魔", "魂")
RESISTS = ("焚火", "冰凛", "雷荧", "烨光", "魔厉", "化相", "析魂", "外法")
EQUIP_SLOTS = ("兵刃", "护甲", "饰物")


def i32(data: bytes, off: int) -> int:
    """小端有符号 int32。**必须有符号** —— 抗性会是负数（实测 −90）。"""
    return struct.unpack_from("<i", data, off)[0]


def big5(blob: bytes) -> str:
    text = blob.split(b"\x00")[0]
    try:
        return text.decode("big5")
    except UnicodeDecodeError:
        return text.decode("big5", errors="replace")


def read_active_pack(data: bytes) -> int:
    """当前用的是哪一套背包（0 主队 / 1 霍雍那段）。判据见 `PACK_BLOCK` 的注释。"""
    v = i32(data, ACTIVE_PACK_OFF)
    if not 0 <= v < PACK_GROUPS:
        print(f"⚠️ 当前背包下标是 {v}，不在 0~{PACK_GROUPS - 1}，按 0 处理")
        return 0
    return v


def read_pack(data: bytes, group: int = 0) -> dict[str, list[dict]]:
    """六个分类的背包。

    ⚠️ **以「条目数」为准，不要扫到 0 为止。** 数量数组与代码数组里都留着
    上一次存档的残渣（`Save013` 的兵刃格后面还躺着代码 8~30、数量 43/44/16…
    这类模板垃圾），按 0 截断会把垃圾当成物品读进来。
    """
    out = {}
    for index, name in enumerate(PACK_CATEGORIES):
        base = pack_base(group) + index * PACK_STRIDE
        count = i32(data, base + PACK_SLOTS * 4 * 2)
        rows = []
        for i in range(max(0, min(count, PACK_SLOTS))):
            code = i32(data, base + PACK_SLOTS * 4 + i * 4)
            qty = i32(data, base + i * 4)
            if code:
                rows.append({"代码": f"{code:X}", "数量": qty})
        out[name] = rows
    return out


def read_party(data: bytes) -> dict:
    """当前队伍：成员代码与各自的阵型格号。判据见 `PARTY_CODES_OFF` 的注释。

    **只读前「人数」个** —— 数组尾巴是上一次的残渣，会重复。
    """
    n = max(0, min(i32(data, PARTY_COUNT_OFF), PARTY_MAX))
    return {
        "人数": n,
        "成员": [i32(data, PARTY_CODES_OFF + 4 * i) for i in range(n)],
        "阵型": [i32(data, PARTY_SLOTS_OFF + 4 * i) for i in range(n)],
    }


def write_party(buf: bytearray, party: dict) -> None:
    """写当前队伍。**只写前 n 个 + 人数，不清尾巴** —— 与背包同一条规矩：
    原作自己就留着残渣，清零会让字节级 round-trip 立刻不过。
    """
    codes = list(party.get("成员") or [])
    slots = list(party.get("阵型") or [])
    if len(codes) > PARTY_MAX:
        raise ValueError(f"队伍有 {len(codes)} 人，超过 {PARTY_MAX}")
    for i, code in enumerate(codes):
        put_i32(buf, PARTY_CODES_OFF + 4 * i, code)
        if i < len(slots):
            put_i32(buf, PARTY_SLOTS_OFF + 4 * i, slots[i])
    put_i32(buf, PARTY_COUNT_OFF, len(codes))


def read_character(data: bytes, index: int) -> dict:
    base = CHAR_BASE + index * CHAR_STRIDE
    rec = {name: i32(data, base + off) for off, name in CHAR_FIELDS.items()}
    rec["名称繁"] = big5(data[base + CHAR_NAME_OFF: base + CHAR_NAME_OFF + CHAR_NAME_LEN])
    rec["五内"] = {w: i32(data, base + WUNEI_OFF + 4 * i) for i, w in enumerate(WUNEI)}
    rec["内禀抗性"] = {r: i32(data, base + RESIST_OFF + 4 * i) for i, r in enumerate(RESISTS)}
    rec["装备"] = {
        s: (f"{c:X}" if (c := i32(data, base + EQUIP_OFF + 4 * i)) else None)
        for i, s in enumerate(EQUIP_SLOTS)
    }
    # ⚠️ **只取前「绝学数量」门。** 后面躺着 `Api.enc` 模板留下的整条候选表
    # （夏侯仪那条有 27 个代码），照单全收会让开局角色凭空会 27 门绝学。
    n = max(0, min(rec.get("绝学数量", 0), SKILL_MAX))
    rec["绝学"] = [f"{c:X}" for i in range(n)
                   if (c := i32(data, base + SKILL_OFF + 4 * i))]
    return rec


# ————————————————————————————————————————————————————————————
# 写回
# ————————————————————————————————————————————————————————————

#: 存档名的最大长度。名字本身**变长**，这只是个安全上限。
NAME_MAX = 24

#: 当前地图那个路径串的位置与最大长度。格式 `mp<图号>\MP<mp图号>.SCI`。
MAP_PATH_OFF = 57521
MAP_PATH_MAX = 40

#: 主角在当前地图上的位置。**像素坐标**，与导出的 `map.json` 同一坐标系。
#:
#: ⚠️ 这三个字段紧跟在地图路径缓冲区（`57521 + 50`）后面，**不是 4 字节对齐**的
#: —— 别为了"看起来整齐"去挪偏移。判据见模块头「主角坐标」。
POS_X_OFF = 57571
POS_Y_OFF = 57575
FACING_OFF = 57579

#: 朝向的合法范围（八方向）。实测 16 个存档取到过 {0,1,2,3,4,6,7}。
FACING_MAX = 8

#: 追加区长度字段。`文件长度 − 67721`，16/16 全中。**只读不写** ——
#: 我们从不改文件长度，写回时它必须保持原值。
TAIL_LEN_OFF = 57513
BASE_SIZE = 67721

#: 剧情旗标区。释义原话：`存档[0xE179 + 编号×2]`。
FLAG_BASE = 0xE179
FLAG_STRIDE = 2
FLAG_MAX = 5000


def put_i32(buf: bytearray, off: int, value: int) -> None:
    """写一个小端有符号 int32。**必须有符号** —— 抗性会是负数。"""
    struct.pack_into("<i", buf, off, int(value))


def write_pack(buf: bytearray, pack: dict[str, list[dict]], group: int = 0) -> None:
    """写六个分类的背包。

    ⚠️ **只写前 N 条 + 条目数，不清尾巴。** 原作自己就是这么干的 ——
    `Save013` 的兵刃格「条目数」之后还躺着上一次的残渣，而读档按条目数
    读前 N 条、根本不看尾巴（见 `read_pack`）。
    清零看起来更干净，但会破坏**字节级自检**（`roundtrip`），
    而那是验证写回唯一可靠的手段；为了一点洁癖丢掉它不划算。
    """
    for index, name in enumerate(PACK_CATEGORIES):
        base = pack_base(group) + index * PACK_STRIDE
        rows = pack.get(name) or []
        if len(rows) > PACK_SLOTS:
            raise ValueError(f"背包「{name}」有 {len(rows)} 种，超过 {PACK_SLOTS} 格")
        for i, row in enumerate(rows):
            code = row["代码"]
            put_i32(buf, base + i * 4, row.get("数量", 1))
            put_i32(buf, base + PACK_SLOTS * 4 + i * 4,
                    int(code, 16) if isinstance(code, str) else int(code))
        put_i32(buf, base + PACK_SLOTS * 4 * 2, len(rows))


def write_character(buf: bytearray, index: int, rec: dict) -> None:
    """写一个角色。**只覆写认识的字段**，其余（动画文件名等）原样留着。"""
    base = CHAR_BASE + index * CHAR_STRIDE
    for off, name in CHAR_FIELDS.items():
        if name in rec:
            put_i32(buf, base + off, rec[name])
    for i, w in enumerate(WUNEI):
        if w in (rec.get("五内") or {}):
            put_i32(buf, base + WUNEI_OFF + 4 * i, rec["五内"][w])
    for i, r in enumerate(RESISTS):
        if r in (rec.get("内禀抗性") or {}):
            put_i32(buf, base + RESIST_OFF + 4 * i, rec["内禀抗性"][r])
    for i, sslot in enumerate(EQUIP_SLOTS):
        if sslot in (rec.get("装备") or {}):
            code = rec["装备"][sslot]
            put_i32(buf, base + EQUIP_OFF + 4 * i,
                    0 if not code else (int(code, 16) if isinstance(code, str) else int(code)))
    if "绝学" in rec:
        # 同背包：**只写前 N 门 + 数量，不清尾巴**。`Api.enc` 的模板在这里
        # 留了整条候选表（夏侯仪那条 27 个代码），原作按「绝学数量」读。
        codes = rec["绝学"][:SKILL_MAX]
        for i, c in enumerate(codes):
            put_i32(buf, base + SKILL_OFF + 4 * i,
                    int(c, 16) if isinstance(c, str) else int(c))
        put_i32(buf, base + 168, len(codes))              # 绝学数量


def write_map(buf: bytearray, map_id: str) -> None:
    """写当前地图。模板是 `{图号}\\MP{图号}.SCI`。

    ⚠️ **图号的大小写在原档里是乱的**，三种都出现过：

    * 全小写 `mp0212\\MPmp0212.SCI`（多数）
    * 全大写 `MP0102B\\MPMP0102B.SCI`（`NewGame`）
    * **混合** `MP0610a\\MPMP0610a.SCI`（`Save005`）

    所以没有"规则"可循。做法是：**图号没变就一个字节都不写** ——
    既忠实，也保住了字节级自检（那是验证写回唯一可靠的手段）。
    真要换图时才重建，用小写（多数派）。
    """
    if read_map(buf) == normalise_map_id(map_id):
        return                                   # 没换图，别动原串
    ident = "mp" + normalise_map_id(map_id)[2:].lower()
    text = f"{ident}\\MP{ident}.SCI".encode("ascii")
    if len(text) + 1 > MAP_PATH_MAX:
        raise ValueError(f"地图路径 {text!r} 超过 {MAP_PATH_MAX} 字节")
    # ⚠️ **只写「串 + 一个 \0」，不清后面**（同存档名）。这一片是「当前场景
    # 的资源路径表」，紧跟着还有别的串（`Save002` 后面就是 `MP0000\MP0000.MSG`），
    # 而且 57571 起就是主角坐标。整段清零会把它们抹掉。
    buf[MAP_PATH_OFF:MAP_PATH_OFF + len(text) + 1] = text + b"\x00"


def normalise_map_id(map_id: str) -> str:
    """把各种写法的图号收敛成 `MP0212` 这种规范形式。"""
    ident = map_id[2:] if map_id[:2].upper() == "MP" else map_id
    return "MP" + ident.upper()


def read_flags(data: bytes) -> dict[int, int]:
    """剧情旗标，**只收非零的**。

    ⚠️ 写回那边（`write_flags`）与前端 `FlagStore` 都要区分「没写过」与
    「写成 0」，所以**别拿这一份去写回存档** —— 它只给 `to_gamesave`
    造前端的测试存档用。
    """
    out = {}
    for i in range(FLAG_MAX):
        off = FLAG_BASE + i * FLAG_STRIDE
        if off + 2 > len(data):
            break
        v = struct.unpack_from("<H", data, off)[0]
        if v:
            out[i] = v
    return out


def write_flags(buf: bytearray, flags: dict) -> None:
    """写剧情旗标。键是编号（十进制），值 0~65535。"""
    for key, value in (flags or {}).items():
        n = int(key)
        if not 0 <= n < FLAG_MAX:
            raise ValueError(f"旗标编号 {n} 越界")
        off = FLAG_BASE + n * FLAG_STRIDE
        if off + 2 > len(buf):
            raise ValueError(f"旗标 {n} 落在 {off}，超出存档长度 {len(buf)}")
        struct.pack_into("<H", buf, off, int(value) & 0xFFFF)


def write_save(original: bytes, changes: dict) -> bytes:
    """**以原始字节为底、只覆写认识的字段。**

    `changes` 里没有的键一概不动 —— 未知区（+24072 那 12 字节、+55760 那片
    内存垃圾、大档尾部 36936 字节）因此原样保留，写出来的档原作仍然读得了。

    ⚠️ **不要从零构造一个存档**。那 47% 没标定的字节里有什么、原作读档时
    会不会用到，我们并不知道；凭空写 0 是在赌。
    """
    buf = bytearray(original)
    if "存档名" in changes:
        # ⚠️ **只写「名字 + 一个 \0」，绝不清后面。**
        # 名字是**变长** Big5 串（「蘭州城」6 B、「西域遼疆」8 B），
        # 之后紧跟别的数据，而且原作**不清零** —— `Save015` 的第 7~8 字节
        # 就是上一次存档留下的垃圾。把 0~44 整段清零会毁掉那些字段，
        # round-trip 立刻不过（首个差异就落在第 7 字节）。
        blob = changes["存档名"].encode("big5", errors="replace")[:NAME_MAX - 1]
        buf[0:len(blob) + 1] = blob + b"\x00"
    # ⚠️ **写进「当前那一套」**，不是永远写第 0 套。霍雍那段用的是第 1 套，
    # 写错地方的后果是：他捡的东西进了主队的包，而他自己的包永远是空的。
    group = changes.get("当前背包", read_active_pack(bytes(original)))
    if "当前背包" in changes:
        put_i32(buf, ACTIVE_PACK_OFF, group)
    if "金钱" in changes:
        put_i32(buf, money_off(group), changes["金钱"])
    if "背包" in changes:
        write_pack(buf, changes["背包"], group)
    for i, rec in enumerate(changes.get("角色") or []):
        if rec:
            write_character(buf, i, rec)
    if changes.get("当前地图"):
        write_map(buf, changes["当前地图"])
    if changes.get("位置"):
        write_position(buf, changes["位置"])
    if changes.get("行走形象") is not None:
        write_avatar(buf, changes["行走形象"])
    if changes.get("队伍"):
        write_party(buf, changes["队伍"])
    write_header(buf, changes)
    if "旗标" in changes:
        write_flags(buf, changes["旗标"])
    return bytes(buf)


#: **主角当前的行走形象代码**（`set_avatar` 的值）。
#:
#: 判据：20 个存档横比，取值只有 1/3/4，且与 `avatars.json` 的形象表严丝合缝——
#:
#: | 值 | 形象 | 出现在 |
#: |---|---|---|
#: | `1` | `XIAHOUYI_S` 小夏侯儀 | **三个 `MP3001`（大地图）存档全是它** |
#: | `3` | `XIAHOUYI` 大夏侯儀 | 其余普通地图 |
#: | `4` | `HUOYONG` 霍雍 | `Save009`/`Save010`，那段剧情主角正是霍雍 |
#:
#: ⚠️ 这解释了「`set_avatar` 全库 49 处所在的槽没有 `set_flag` 伴随」——
#: **它不走旗标，存在这里。**
AVATAR_OFF = 57583

#: 布局 JSON 的落点。**前端读的就是它** —— 偏移只有这一份正本。
LAYOUT_OUT = Path(__file__).resolve().parent.parent / "game/public/assets/data/tsf_layout.json"


def layout() -> dict:
    """把全部偏移导成 JSON，供 `game/src/systems/tsf.js` 读。

    ⚠️ **不要在 JS 里再抄一份常量。** 这些偏移是一点点解出来的，
    抄第二份就等于埋一个「两边不同步」的雷 —— `TICK_MS` 那次就是这么
    对了动画、错了走路。有回归 `test_layout_matches_module` 盯着：
    这里少导一项、或者两边改一处忘另一处，测试立刻红。
    """
    return {
        "生成自": "tools/tsf_parse.py --layout",
        "说明": "`.TSF` 存档的字段偏移。判据见 tools/tsf_parse.py 的模块头。",
        "基准长度": BASE_SIZE,
        "追加区长度偏移": TAIL_LEN_OFF,
        "存档名": {"偏移": 0, "上限": NAME_MAX},
        "等级": LEVEL_OFF,
        "日期": DATE_OFF,
        "金钱": MONEY_OFF,
        "行走形象": AVATAR_OFF,
        "背包": {
            "起点": PACK_BASE, "槽位": PACK_SLOTS, "步长": PACK_STRIDE,
            "分类": list(PACK_CATEGORIES),
            # ⭐ 两套并排，整块 24040 = 背包 24024 + 金钱 4 + 指针 12。
            # `当前` 是那个 int32 的偏移，值 0/1。判据见 tsf_parse 的 PACK_BLOCK。
            "组数": PACK_GROUPS, "组步长": PACK_BLOCK, "当前": ACTIVE_PACK_OFF,
        },
        "角色": {
            "起点": CHAR_BASE, "步长": CHAR_STRIDE, "条数": CHAR_COUNT,
            "字段": {str(k): v for k, v in CHAR_FIELDS.items()},
            "名字": {"偏移": CHAR_NAME_OFF, "长度": CHAR_NAME_LEN},
            "五内": {"偏移": WUNEI_OFF, "键": list(WUNEI)},
            "抗性": {"偏移": RESIST_OFF, "键": list(RESISTS)},
            "装备": {"偏移": EQUIP_OFF, "键": list(EQUIP_SLOTS)},
            "绝学": {"偏移": SKILL_OFF, "上限": SKILL_MAX},
        },
        "当前地图": {"偏移": MAP_PATH_OFF, "上限": MAP_PATH_MAX},
        "位置": {"x": POS_X_OFF, "y": POS_Y_OFF, "朝向": FACING_OFF,
                 "朝向上限": FACING_MAX},
        "旗标": {"起点": FLAG_BASE, "步长": FLAG_STRIDE, "上限": FLAG_MAX},
        "队伍": {"成员": PARTY_CODES_OFF, "阵型": PARTY_SLOTS_OFF,
                 "人数": PARTY_COUNT_OFF, "上限": PARTY_MAX},
    }


def roundtrip(path: Path) -> tuple[bool, str]:
    """**读进来再写出去，字节必须相同。** 这是写回唯一可靠的回归。"""
    original = path.read_bytes()
    save = parse(path)
    out = write_save(original, {
        "存档名": save["存档名"],
        "当前背包": save.get("当前背包", 0),
        "金钱": save["金钱"],
        "背包": save["背包"],
        "角色": save["角色"],
        "当前地图": save.get("当前地图"),
        "位置": save.get("位置"),
        "等级": save.get("等级"),
        **{k: save.get(k) for k in DATE_OFF},
    })
    if out == original:
        return True, "字节相同"
    bad = [i for i in range(min(len(out), len(original))) if out[i] != original[i]]
    return False, f"{len(bad)} 字节不同，首个在 {bad[0]}（0x{bad[0]:X}）"


def read_header(data: bytes) -> dict:
    """存档头：等级与存档时间。天书页那条记录要显示的就是它们。"""
    return {
        "等级": i32(data, LEVEL_OFF),
        **{k: i32(data, off) for k, off in DATE_OFF.items()},
    }


def write_header(buf: bytearray, header: dict) -> None:
    """写等级与存档时间。**年只写末两位**（原作就是这么存的）。"""
    if header.get("等级") is not None:
        put_i32(buf, LEVEL_OFF, header["等级"])
    for key, off in DATE_OFF.items():
        if header.get(key) is not None:
            value = int(header[key])
            if key == "年" and value >= 100:
                value %= 100
            put_i32(buf, off, value)


def read_avatar(data: bytes) -> int | None:
    """主角当前的行走形象代码。见 `AVATAR_OFF`。"""
    if len(data) < AVATAR_OFF + 4:
        return None
    return i32(data, AVATAR_OFF)


def write_avatar(buf: bytearray, code: int) -> None:
    put_i32(buf, AVATAR_OFF, int(code))


def read_position(data: bytes) -> dict:
    """主角在当前地图上的位置与朝向。像素坐标，原点左上，与 `map.json` 同制。

    判据见模块头「主角坐标」—— 16 个存档的 (X, Y) 逐个落在各自地图的尺寸内。
    """
    return {
        "x": i32(data, POS_X_OFF),
        "y": i32(data, POS_Y_OFF),
        "朝向": i32(data, FACING_OFF),
    }


def write_position(buf: bytearray, pos: dict) -> None:
    """写主角位置与朝向。**三个独立字段，没有变长内容，可以直接写。**"""
    if pos.get("x") is not None:
        put_i32(buf, POS_X_OFF, pos["x"])
    if pos.get("y") is not None:
        put_i32(buf, POS_Y_OFF, pos["y"])
    facing = pos.get("朝向")
    if facing is not None:
        if not 0 <= int(facing) < FACING_MAX:
            raise ValueError(f"朝向 {facing} 越界，应在 0~{FACING_MAX - 1}")
        put_i32(buf, FACING_OFF, facing)


def read_map(data: bytes) -> str | None:
    """当前地图。`+57521` 起的 `mp<图号>\\MP<mp图号>.SCI`，取出图号。"""
    blob = data[MAP_PATH_OFF:MAP_PATH_OFF + MAP_PATH_MAX].split(b"\x00")[0]
    # ⚠️ **大小写两种都有**：多数是 `mp0212\\…`，但 `NewGame` 与 `Save005`
    # 是 `MP0102B\\…`。只认小写会把开局存档读成「没有地图」。
    m = re.match(rb"[Mm][Pp]([0-9A-Za-z]+)\\", blob)
    return ("MP" + m.group(1).decode().upper()) if m else None


def parse(path: Path) -> dict:
    data = path.read_bytes()
    if len(data) < MONEY_OFF + 4:
        raise ValueError(f"{path.name} 只有 {len(data)} 字节，装不下背包区，不像存档")
    return {
        "文件": path.name,
        "字节": len(data),
        "存档名": big5(data[:64]),
        # ⭐ `金钱`/`背包` 一律指**当前那一套** —— 下游（前端、to_gamesave）
        # 不用关心有两套。要看另一套翻 `背包全部`/`金钱全部`。
        "当前背包": read_active_pack(data),
        "金钱": i32(data, money_off(read_active_pack(data))),
        "背包": read_pack(data, read_active_pack(data)),
        "金钱全部": [i32(data, money_off(g)) for g in range(PACK_GROUPS)],
        "背包全部": [read_pack(data, g) for g in range(PACK_GROUPS)],
        "角色": [read_character(data, i) for i in range(CHAR_COUNT)],
        **read_header(data),
        "当前地图": read_map(data),
        "位置": read_position(data),
        "行走形象": read_avatar(data),
        "旗标": read_flags(data),
        "队伍": read_party(data),
    }


def summarise(save: dict) -> None:
    pos = save.get("位置") or {}
    party = save.get("队伍") or {}
    print(f"{save['文件']}  {save['字节']} B  「{save['存档名']}」  金钱 {save['金钱']}  "
          f"{save.get('当前地图') or '?'} ({pos.get('x')}, {pos.get('y')}) 朝向 {pos.get('朝向')}")
    if party.get("人数"):
        pairs = "、".join(f"{c}@{q}" for c, q in zip(party["成员"], party["阵型"]))
        print(f"  队伍 {party['人数']} 人：{pairs}（代码@阵型格）")
    for name, rows in save["背包"].items():
        if rows:
            print(f"  背包·{name}: {len(rows)} 种 —— "
                  + "、".join(f"{r['代码']}×{r['数量']}" for r in rows[:8])
                  + ("…" if len(rows) > 8 else ""))
    for i, c in enumerate(save["角色"]):
        if not c["命极"]:
            continue
        print(f"  角色[{i}] 位阶{c['位阶']:<3} 历练{c['已有历练']:<7} "
              f"命{c['命']}/{c['命极']} 气{c['气']}/{c['气极']} "
              f"剩余五内{c['剩余五内']:<3} 五内{list(c['五内'].values())} "
              f"绝学{len(c['绝学'])}门 装备{list(c['装备'].values())}")


#: 自检要用的两样东西，从 `gamedata.json` 读 —— 不在这里复制常量。
GAMEDATA = Path(__file__).resolve().parent.parent / "game/public/assets/data/gamedata.json"


def verify(save: dict) -> list[str]:
    """拿存档里的值**反验我们的公式**。返回不吻合的项。

    存档是原作自己算出来的结果，是最硬的判据 —— 比任何配套资料都硬。
    两项：

    * **内禀抗性** `= 抗性基准 + Σ(五内 × 系数)`。官方版必须用「原版」那张
      系数表；用「本补丁」算出来八项全错（五内 12×5 时前者给
      82/88/82/88/88/94/94/94，后者给 91/91/94/94/94/100/100/100）。
    * **位阶** `= 满足「已有历练 ≥ 门槛[n]」的最大 n`。
    """
    data = json.loads(GAMEDATA.read_text())
    table = data["五内抗性系数"]["原版" if data.get("版本") == "官方" else "本补丁"]
    base = data["常数"]["抗性基准"]
    # ⚠️ **门槛表尾部是 0 填充**（101 档里只有 99 档有值）。不截掉的话
    # 「历练 ≥ 门槛」对每一个尾部的 0 都成立，位阶一律算成 100。
    marks = data["历练门槛"]
    marks = marks[:next((i for i in range(1, len(marks)) if marks[i] == 0), len(marks))]
    bad = []
    for i, c in enumerate(save["角色"]):
        # ⚠️ **跳过 0 号**。它是模板槽（命极 1000、五内 99×5、抗性全 100），
        # 不是真角色，拿它验公式必然全错。
        if i == 0 or not c["命极"]:
            continue
        # ⚠️ **跳过没入过队的角色**：八项抗性原样是 100 说明游戏从没给它算过，
        # 那是 `Api.enc` 的初值，拿它验公式只会得到假阳性。
        if all(v == 100 for v in c["内禀抗性"].values()):
            continue
        for name in RESISTS:
            want = base + sum(c["五内"][w] * table.get(w, {}).get(name, 0) for w in WUNEI)
            got = c["内禀抗性"][name]
            # ⚠️ **先取绝对值再比**。这一格有时是负数，而绝对值与公式吻合
            # （Save002 角色1 雷荧 = −76，公式 75.5）。负号出现得没规律 ——
            # 同一个「化相」在 Save002 为负、在 Save005 为正，也与数值大小无关，
            # 说明这一格里还塞着别的信息。**尚未查清，见文件末 §待查。**
            if abs(abs(got) - want) > 0.5:
                bad.append(f"角色[{i}] {name} 抗性：存档 {got}，公式算出 {want}")
        # ⚠️ **位阶从 1 起算**：门槛表下标 0 对应位阶 1（`formulas.rankFromExp`
        # 也是这么实现的，它的测试断言 `rankFromExp(0) === 1`）。
        rank = 1 + max((n for n, m in enumerate(marks) if c["已有历练"] >= m), default=0)
        if rank != c["位阶"]:
            bad.append(f"角色[{i}] 位阶：存档 {c['位阶']}，按历练 {c['已有历练']} 算出 {rank}")
        if c["位阶"] < len(marks) and c["下阶门槛"] != marks[c["位阶"]]:
            bad.append(f"角色[{i}] 下阶门槛：存档 {c['下阶门槛']}，表里是 {marks[c['位阶']]}")
    return bad


#: 读档产物的落点。前端 `BootScene` 从这里加载。
SAVE_OUT = Path(__file__).resolve().parent.parent / "game/public/assets/data/saves"


def to_gamesave(save: dict) -> dict:
    """把解析结果收敛成**前端要用的那一份**。

    只留**原始状态**，派生值一律丢掉 —— 抗性、攻击、护禦这些由
    `formulas.js` 现算。存档里的抗性快照我们不采信（见 §待查 1），
    而且就算采信也会与现算的两处不同步。

    背包在存档里分成六格；前端的 `inventory` 是一个扁平数组，
    分类由 `catalog.分类()` 现判，只有「暂置」是条目自己的状态 ——
    所以这里**只给暂置打标记**，其余五格摊平。
    """
    pack = []
    for category, rows in save["背包"].items():
        for row in rows:
            entry = {"代码": row["代码"], "数量": row["数量"]}
            if category == "暂置":
                entry["暂置"] = True
            pack.append(entry)
    # ⚠️ **只收队伍区里的那几个人。**「命极非零」是错的判据 —— 角色区是
    # 预填模板，九条全有数值，照它收会得到八个人（`Save011` 的真队伍是三个）。
    # 判据见 `PARTY_CODES_OFF`。
    party = save.get("队伍") or {}
    members = {}
    for index in party.get("成员") or []:
        if index <= 0 or index >= len(save["角色"]):
            print(f"⚠️ 队伍里的代码 {index} 不在角色区，跳过")
            continue
        c = save["角色"][index]
        members[str(index)] = {
            "代码": index,
            "位阶": c["位阶"], "已有历练": c["已有历练"],
            "命": c["命"], "命极": c["命极"], "气": c["气"], "气极": c["气极"],
            "膂力": c["膂力"], "体魄": c["体魄"], "灵力": c["灵力"],
            "迅捷": c["迅捷"], "机运": c["机运"],
            "剩余五内": c["剩余五内"],
            **c["五内"],
            "装备": c["装备"],
            "绝学": c["绝学"],
        }
    return {
        "生成自": "tools/tsf_parse.py",
        "来源": save["文件"],
        "存档名": save["存档名"],
        # ⭐ 两套背包里用的是哪一套。前端 `gameState` 要把它记进 registry，
        # 否则从这份测试存档开局再存档，会写到另一套那一格去。
        "当前背包": save.get("当前背包", 0),
        "金钱": save["金钱"],
        "当前地图": save.get("当前地图"),
        "位置": save.get("位置"),
        # 主角当前的行走形象代码（`set_avatar` 的值）。霍雍那段是 4。
        "行走形象": save.get("行走形象"),
        # ⭐ **剧情旗标要带上**（只带非零的，5000 个全带会把文件撑大）。
        #
        # ⚠️ 这一项此前**根本没导**，而入库的 `test.json` 里手工写着一条
        # `旗标1 = 8`。于是「用 `--export` 重导一次 test.json」＝
        # **把整个剧情进度静默清零** —— 表现是剧情分支全都走不到，
        # 而且不报错（`branch 旗标1==29` 直接不成立，脚本安静地走另一支）。
        # 2026-09-13 我自己重导了几次才发现。
        "剧情旗标": {str(k): v for k, v in (save.get("旗标") or {}).items() if v},
        "剧情旗标说明": "非零的剧情旗标，来自存档。旗标1 是主线进度。",
        "背包": pack,
        "角色": members,
        # 队伍顺序与各自的阵型格号。前端 `partyFromSave` 按代码对上去。
        "队伍": list(party.get("成员") or []),
        "阵型": list(party.get("阵型") or []),
    }


def main(argv: list[str]) -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("save", type=Path, nargs="*")
    ap.add_argument("--json", type=Path, help="把结构写成 JSON")
    ap.add_argument("--character", type=int, help="摊开某个角色的全部 848 字节")
    ap.add_argument("--verify", action="store_true",
                    help="拿存档的值反验抗性与位阶公式")
    ap.add_argument("--layout", action="store_true",
                    help=f"把字段偏移导成 JSON（{LAYOUT_OUT.name}），供前端读")
    ap.add_argument("--layout-out", type=Path, default=LAYOUT_OUT,
                    help="--layout 写到哪（一键提取 tools/extract.py 指向新目录）")
    ap.add_argument("--export", metavar="名字",
                    help="导成前端能读的存档（写进 game/public/assets/data/saves/）")
    args = ap.parse_args(argv)

    if args.layout:
        args.layout_out.parent.mkdir(parents=True, exist_ok=True)
        args.layout_out.write_text(json.dumps(layout(), ensure_ascii=False, indent=1),
                                   encoding="utf-8")
        print(f"-> {args.layout_out}")
    if not args.save:
        if not args.layout:
            print("要么给存档路径，要么用 --layout", file=sys.stderr)
            return 1
        return 0

    saves = []
    for path in args.save:
        if not path.is_file():
            print(f"找不到存档：{path}", file=sys.stderr)
            return 1
        save = parse(path)
        saves.append(save)
        summarise(save)
        if args.verify:
            bad = verify(save)
            print(f"  自检：{'全部吻合 ✔' if not bad else f'{len(bad)} 处不吻合 ✘'}")
            for line in bad[:12]:
                print(f"    {line}")
        if args.character is not None:
            data = path.read_bytes()
            base = CHAR_BASE + args.character * CHAR_STRIDE
            print(f"  —— 角色[{args.character}] 的 848 字节 ——")
            for off in range(0, CHAR_STRIDE, 4):
                value = i32(data, base + off)
                if value:
                    print(f"    +{off:<4}{CHAR_FIELDS.get(off, '?'):<10}{value}")

    if args.export:
        if len(saves) != 1:
            print("--export 一次只能导一个存档", file=sys.stderr)
            return 1
        SAVE_OUT.mkdir(parents=True, exist_ok=True)
        out = SAVE_OUT / f"{args.export}.json"
        out.write_text(json.dumps(to_gamesave(saves[0]), ensure_ascii=False, indent=1))
        print(f"-> {out}")

    if args.json:
        args.json.write_text(json.dumps(saves if len(saves) > 1 else saves[0],
                                        ensure_ascii=False, indent=1))
        print(f"-> {args.json}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
