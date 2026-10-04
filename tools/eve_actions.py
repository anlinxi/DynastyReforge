"""把 .eve 的槽脚本翻译成结构化动作序列，供前端直接执行。

`map_script.slot_dialogue` 只取对白，切图、条件分支、旗标这些控制流全丢了；
本模块保留整条指令序列，前端才能真的"走剧本"而不是把台词一股脑念完。

## 指令语义来源

**社区文档《剧情代码释义.txt》** ——

    ~/Game/yc/_ext/CastleScript(1)/CastleScript/剧情代码释义.txt

它逐条给出了 48 个子事件指令的格式（还附带完整 C# 源码 `SCI.cs` / `DatStream.cs`）。

⚠️ **不要去查 `SuperCastleEdit.exe`。** 它自己的说明里写着
「【待开发功能】☆集成剧情编辑器」—— **它没有这个功能**。
这条走过弯路，已记进 `CLAUDE.md`。

⚠️ **文档用十六进制指令码，本项目用十进制。** 下面 `SPECS` 表两个都标了，
对照文档时看 `0x??` 那一列。

## 子事件序号 == 数组下标

条件指令的跳转目标 Z 指的是**槽内子事件的序号**，也就是本模块产出的动作
数组的下标。因此**无法识别的指令也必须占一个位置**（`UNKNOWN`），
丢掉它们会让后面所有跳转目标整体错位。

## 旗标与那个临时标志位

旗标 X 对应存档地址 `0xE179 + X*2`。
⚠️ **`0x3E7`（999）是保留的临时标志位**，不存任何剧情进度 ——
「扣除物品/金钱是否成功」「判断装备/属性是否成立」「随机数结果」
都往那里写，随后用一条比较指令读出来。前端必须照做，
否则这几条判断全部失效（而且不会报错，只会走错分支）。
"""
from __future__ import annotations

import struct
from dataclasses import dataclass
from types import MappingProxyType
from typing import Mapping, Sequence

import map_script as ms

#: 保留的临时标志位。见模块文档。
TEMP_FLAG = 0x3E7

#: 名称字段一律预留 20 字节（不足补零）。事物名是 Big5，动画/地图名是 ASCII。
NAME_LEN = 20


# ── 字段类型 ─────────────────────────────────────────────────────
#
# 解析器是**表驱动**的：一条指令 = 一个类型名 + 一串字段。
# 逐个 opcode 手写解析函数会让这个文件涨到八百行，而它们的差别
# 只在字段布局上。

U32 = "u32"        #: 小端 32 位。**按有符号读** —— 见 `_read`。
U16 = "u16"        #: 小端 16 位。目前只有 op56 的三原色强度用到
U8 = "u8"          #: 单字节
NAME = "name"      #: 20 字节 Big5 事物名（右侧补零）
ASCII = "ascii"    #: 20 字节 ASCII 名（地图名、动画代码）
SKIP = "skip"      #: 占位，读了就丢

_WIDTH = {U32: 4, U16: 2, U8: 1, NAME: NAME_LEN, ASCII: NAME_LEN, SKIP: 4}


def _read(payload: bytes, offset: int, kind: str):
    if kind == U32:
        # ⚠️ **按有符号读。** 原作用 `0xFFFFFFFF` 表示「不指定」——
        # 事物出现（op11）时坐标写 `ffffffff` 意思是「保持原位」。
        # 按无符号读会得到 4294967295，前端会把人物摆到地图外面去。
        # 其余字段（旗标、物品代码、金钱）都远小于 2^31，有符号读没有副作用。
        return struct.unpack_from("<i", payload, offset)[0]
    if kind == U16:
        return struct.unpack_from("<H", payload, offset)[0]
    if kind == U8:
        return payload[offset]
    blob = payload[offset:offset + NAME_LEN].split(b"\x00")[0]
    return blob.decode("big5" if kind == NAME else "ascii", errors="ignore")


# ── 指令表 ───────────────────────────────────────────────────────
#
# `十进制op: (动作类型, ((字段名, 类型), …))`
# 右侧注释是《剧情代码释义.txt》里的十六进制码，对照文档时用。
#
# ⚠️ **字段名一旦定下就不要改** —— `systems/eventScript.js` 与
# `scenes/FieldScene.js` 都按名字取值，改名不会报错，只会静默失效。

SPECS: Mapping[int, tuple[str, tuple[tuple[str, str], ...]]] = MappingProxyType({
    # —— 流程与旗标 ——
    0:   ("end",          ()),                                             # 0x00
    1:   ("wait",         (("ticks", U32),)),                              # 0x01 剧情暂缓
    2:   ("set_flag",     (("flag", U32), ("value", U32))),                # 0x02 写入
    3:   ("add_flag",     (("flag", U32), ("value", U32))),                # 0x03 累加
    4:   ("sub_flag",     (("flag", U32), ("value", U32))),                # 0x04 递减
    77:  ("jump",         (("target", U32),)),                             # 0x4D 强行跳转

    # —— 事物与角色演出 ——
    11:  ("actor_show",   (("name", NAME), ("x", U32), ("y", U32),         # 0x0B 事物出现
                           ("facing", U8))),
    12:  ("actor_hide",   (("name", NAME), ("speed", U32))),               # 0x0C 事物消失
    19:  ("actor_place",  (("name", NAME), ("x", U32), ("y", U32),         # 0x13 瞬移(带朝向)
                           ("facing", U8))),
    20:  ("actor_place",  (("name", NAME), ("x", U32), ("y", U32))),       # 0x14 瞬移
    21:  ("actor_face",   (("name", NAME), ("facing", U8))),               # 0x15 改变朝向
    # mode：RPG.exe 0x40a740存入+0x34，0x40a7d0按它选路线 0先横后纵/1先纵后横/2斜走。
    22:  ("actor_walk",   (("name", NAME), ("x", U32), ("y", U32),         # 0x16 角色移动(绝对)
                           ("mode", U32), ("facing", U32),
                           ("_2", SKIP), ("_3", SKIP), ("run", U32))),
    25:  ("actor_walk_rel", (("name", NAME), ("dx", U32), ("dy", U32),     # 0x19 角色移动(相对)
                             ("_", SKIP), ("facing", U32))),
    31:  ("actor_to_center", (("name", NAME), ("_", SKIP), ("_2", SKIP),   # 0x1F 瞬移至屏幕中心
                              ("facing", U8))),
    101: ("hero_place",   (("x", U32), ("y", U32), ("facing", U8))),       # 0x65 瞬移主角
    # 0x66 瞬移主角、朝向不变：RPG.exe 0x40e320 取主角后调 0x40a2b0(保持姿态, x, y)。
    # 遁符槽1用(0,0)让主角随动画退场，宿曜之阵用它在阵眼间传送。
    102: ("hero_move",    (("x", U32), ("y", U32))),
    104: ("set_avatar",   (("avatar", U32),)),                             # 0x68 切换行走形象

    # —— 镜头 ——
    27:  ("camera_follow", (("name", NAME),)),                             # 0x1B 屏幕跟随某物
    28:  ("camera_hero",  ()),                                             # 0x1C 屏幕跟随主角
    29:  ("await_actions", ()),                                            # 0x1D 等待前述完成
    30:  ("camera_move",  (("x", U32), ("y", U32), ("duration", U32))),    # 0x1E 移动屏幕中心

    # —— 画面 ——
    # ⚠️ **动画代码是 Big5 事物名，不是 ASCII。** 释义写的是「ascii」——
    # 那是因为作者举的例子恰好都是纯英文（`res2` / `wagan` / `bird`）。
    # 兰州城废屋那一段是 `動畫第一段`，按 ASCII 解会得到 "e@q" 这种乱码，
    # 而它正是 `MP0208` objects 里的一个过场 SF2 对象 ——
    # 所以 `actor_show` + `play_anim` 是配套的：显示那个对象并播它的某一帧段。
    26:  ("play_anim",    (("anim", NAME), ("from", U32), ("to", U32),      # 0x1A 剧情动画图
                           ("loop", U32))),
    83:  ("fade_out",     (("speed", U8),)),                               # 0x53 黑幕出现
    84:  ("fade_in",      (("speed", U8),)),                               # 0x54 黑幕消失
    85:  ("flash",        (("duration", U8),)),                            # 0x55 闪光
    # 0x56 全屏色彩。⚠️ 三原色强度**曾经漏读**（只解了 alpha），
    # 于是所有屏幕染色都是同一个颜色。释义：
    #   `56000000 XXXX0000 YYYY ZZZZ WWWW`
    #   X 关系透明度（ff7f~ffff 不透明；0 浅色；1 灰色；1~0a 过渡；
    #     0A 透明彩色；>0a 透明深彩），Y/Z/W = 红/绿/蓝强度（各 2 字节）
    # ⚠️ `alpha` 是 **u16 + 2 字节填充**（释义写作 `XXXX0000`），不是 u32。
    # 按 u32 读会把填充位一起吃掉：MP3001 有一条读出 262144，
    # 而释义说这个值的范围是 `0 ~ ffff`。
    #
    # ⚠️ 三原色的**量纲还没验证**：实测取值是 16 / 4 / 1 / 65535 这种，
    # 不像 0~255。释义只说「Y、Z、W=三原色红、绿、蓝强度」没给范围。
    # 所以这里只**解出来存着**，前端暂时仍只用 alpha —— 拿不准量纲就去调色，
    # 只会调出一个看着顺眼但没有依据的值。
    86:  ("screen_tint",  (("alpha", U16), ("_pad", U16), ("red", U16),
                           ("green", U16), ("blue", U16))),
    87:  ("screen_tint_off", ()),                                          # 0x57 彩屏消失
    88:  ("screen_shake", ()),                                             # 0x58 背景晃动
    # 0x5A/0x5B 黑幕渐落/渐开。释义给了两个单字节参数但注明「X、Y暂不明」——
    # **解出来存着**：不解的话将来想查也没有素材，解了至少能看取值分布。
    90:  ("fade_out_slow", (("a", U8), ("b", U8))),
    91:  ("fade_in_slow",  (("a", U8), ("b", U8))),
    53:  ("show_map_name", ()),                                            # 0x35 显示地图名
    152: ("play_movie",   (("movie", U32),)),                              # 0x98 剧情动画
    142: ("play_audio",   (("kind", U32), ("track", U32), ("loop", U32))),  # 0x8E 音频

    # —— 场景与界面 ——
    58:  ("goto_map",     (("map", ASCII), ("_", U8), ("x", U32),          # 0x3A 载入新地图
                           ("y", U32), ("facing", U8))),
    54:  ("open_shop",    (("shop", U32),)),                               # 0x36 购物界面
    62:  ("open_save",    ()),                                             # 0x3E 存档界面
    57:  ("enter_room",   (("room", U8),)),                                # 0x39 进入客房
    143: ("open_door",    (("name", NAME), ("event", U8), ("state", U8))),  # 0x8F 开门

    # —— 战斗 ——
    55:  ("battle",       (("swarm", U32), ("must_win", U32),              # 0x37 进入战斗
                           ("on_lose", U32))),

    # —— 队伍与物品 ——
    121: ("party_leave",  (("member", U8),)),                              # 0x79 队友离开
    122: ("party_join",   (("member", U8),)),                              # 0x7A 队友加入
    124: ("heal_percent", (("hp", U32), ("mp", U32))),                     # 0x7C 全员回复(%)
    125: ("heal_points",  (("hp", U32), ("mp", U32))),                     # 0x7D 全员回复(点)
    126: ("item_gain",    (("item", U32), ("count", U32))),                # 0x7E 得到物品
    127: ("item_lose",    (("item", U32), ("count", U32))),                # 0x7F 扣除物品
    128: ("money_gain",   (("amount", U32),)),                             # 0x80 得到金钱
    129: ("money_lose",   (("amount", U32),)),                             # 0x81 扣除金钱
    135: ("equip_replace", (("member", U32), ("item", U32),                # 0x87 替换装备
                            ("keep", U32))),
    136: ("exp_gain",     (("member", U32), ("exp", U32))),                # 0x88 得到经验
    105: ("learn_skill",  (("which", U32),)),                              # 0x69 学技能

    # —— 判断：结果写进 TEMP_FLAG，随后用比较指令读 ——
    131: ("test_equip",   (("member", U32), ("slot", U32), ("item", U32))),  # 0x83
    134: ("test_stat",    (("member", U32), ("attr", U32), ("value", U32))),  # 0x86
    153: ("random",       (("max", U32),)),                                # 0x99 随机数

    # —— 道具放置类（迷宫机关，兰州城用不到，先解出来占位） ——
    148: ("use_item_here", (("item", U32), ("target", U32))),              # 0x94
    149: ("test_item_used", (("target", U32),)),                           # 0x95
    150: ("use_item_at",  (("event", U32), ("item", U32))),                # 0x96

    # 官方40da50读取payload首字节，设置当前场景层。
    61: ("switch_layer", (("layer", U8),)),                              # 0x3D

})

#: 六种比较跳转，payload 布局相同，只有比较方式不同。
COMPARISONS: Mapping[int, str] = MappingProxyType({
    71: "==", 72: "!=", 73: ">", 74: ">=", 75: "<", 76: "<=",
})

#: 至今**没有释义**的指令。释义文档里查无此码，出现次数也都很少。
#:
#: 官方版四张兰州城相关地图上的出现次数：`op102 ×6`、`op103 ×8`、`op107 ×2`。
#: 它们仍然会作为 `unknown` 占位（下标不能乱），只是演不出来。
#: 真要认，只能拿原作跑到那一段看画面反推 —— 成本高、收益低，先记着。
NO_SPEC = frozenset({102, 103, 107})

# 动作类型的名字常量。`export_map.py` 等调用方按名字过滤，别改字面量。
END = "end"
UNKNOWN = "unknown"
SAY = "say"
GOTO_MAP = "goto_map"
BRANCH = "branch"
JUMP = "jump"
BATTLE = "battle"
OPEN_SHOP = "open_shop"
# ⚠️ **动作类型名要在这里留常量**，测试与调用方按名字比对。
# 少一个的表现是 `AttributeError` —— tools/tests 因此红了很久没人发现，
# 因为提交前没跑过 Python 侧的回归。
FADE_OUT = "fade_out"
FADE_IN = "fade_in"
SET_FLAG = "set_flag"
SET_AVATAR = "set_avatar"


@dataclass(frozen=True)
class Action:
    """一条子事件。`index` 即它在槽内的序号，也是跳转目标的取值。"""

    index: int
    op: int
    type: str
    data: Mapping[str, object] = MappingProxyType({})

    def to_dict(self) -> dict:
        return {"index": self.index, "op": self.op, "type": self.type, **self.data}


def _action(index: int, op: int, type_: str, **data: object) -> Action:
    return Action(index=index, op=op, type=type_, data=MappingProxyType(dict(data)))


def _decode(payload: bytes, fields: tuple[tuple[str, str], ...]) -> dict | None:
    """按字段表切 payload。**长度不够就返回 None**，让调用方降级成 unknown。

    ⚠️ 原作脚本尾部存在被截断的指令，硬解会抛异常拖垮整槽。
    """
    out, offset = {}, 0
    for name, kind in fields:
        width = _WIDTH[kind]
        if offset + width > len(payload):
            return None
        if not name.startswith("_"):
            out[name] = _read(payload, offset, kind)
        offset += width
    return out


def parse_action(index: int, ins: ms.Instruction, pool: Sequence[str]) -> Action:
    """把一条指令翻译成动作。认不出或 payload 不够长时降级为 `UNKNOWN`。"""
    op, payload = ins.code, ins.payload

    # 对白单独处理：正文要从 msg 池里按序号取。
    if op in ms.OP_DIALOGUE:
        line = ms.parse_dialogue(payload, tuple(pool))
        if line is not None:
            return _action(index, op, "say", **line.to_dict())
        return _action(index, op, UNKNOWN)

    if op in COMPARISONS:
        fields = _decode(payload, (("flag", U32), ("value", U32), ("target", U32)))
        if fields is not None:
            return _action(index, op, "branch", compare=COMPARISONS[op], **fields)
        return _action(index, op, UNKNOWN)

    spec = SPECS.get(op)
    if spec is not None:
        type_, fields = spec
        decoded = _decode(payload, fields)
        if decoded is not None:
            return _action(index, op, type_, **decoded)

    return _action(index, op, UNKNOWN)


def slot_actions(eve: bytes, msg: bytes) -> dict[int, tuple[Action, ...]]:
    """每个槽的完整动作序列，顺序与序号都与原作子事件一一对应。

    与 `map_script.slot_dialogue` 不同，这里**不做相邻去重**——
    去重会打乱下标，而条件跳转正是按下标寻址的。重复的对白由执行器
    走条件分支自然避开，不需要在数据层压缩。
    """
    pools = ms.message_sentences(msg)
    return {
        slot: tuple(
            parse_action(i, ins, pools.get(slot, ()))
            for i, ins in enumerate(script)
        )
        for slot, script in ms.slot_scripts(eve).items()
    }
