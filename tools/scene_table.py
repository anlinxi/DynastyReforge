#!/usr/bin/env python3
"""解析场景对象表 `NP場景001.SCI` —— 对象与事件槽的对应关系就在这里。

每张地图的 `.DAT` 里除了 `.eve`/`.msg`，还有两个 `.SCI`：

    MPMP<图号>.SCI   地图级：地面 JPEG、MK/MB 层、.eve 的相对路径
    NP場景001.SCI    **场景对象表**（条目名是 Big5，按 ASCII 读会是乱码）

对象表无文件头，定长 551 字节一条，条数 = 文件长度 ÷ 551（全库 309 张地图
无一例外）。已确认的字段：

    0    100B  对象名（Big5）。未命名的对象此处填的是自己的 SF2 文件名，
                这类是布景；有中文名的（`掌櫃`/`廢屋入口`/`南方撤退線`）才是
                剧情用得上的对象
    100  i32   x        地图绝对坐标
    104  i32   y
    108  2×i16 **绘制偏移**（见下）＋2×i16 用途不明
    112  u8    ShowWithMap：1 = 随地图出现，0 = 等剧情叫（`actor_show`）
    115  u8    Mouse：0 无反应 1 放大镜 2 可拾取 3 对话 4 门 5 可放置
    117  u8    Hide：隐形（存在但不画，如触发线）
    223  u8    MaxDirections：朝向数（8 / 4 / 0）
    225  u8    DisplayShadow：画不画影子
    226  u8    StartFrame / 227 u8 EndFrame：**默认播放的帧区间**
    123  100B  该对象自己的精灵文件相对路径（`mp0212\\nb0212-1.SF2`）
    234  u8    **碰触事件槽**：走上去触发，用于出入口、撤退线、检查线
    235  u8    **交谈事件槽**：按键交谈，用于 NPC、可查看的物件
    237  u8    对象类型，实测 3 / 4（触发线）/ 5（人物）

234 / 235 的值就是 `.eve` 的记录索引，即 `docs/专题/脚本与对白.md` 所说的「槽」。

验证（mp0202 客栈）:

    掌櫃    → 槽16「西夏鐵衛軍統領赫蘭鐵罕為人貪婪殘暴…」
    中央老  → 槽27「這位公子，請坐！」
    小二    → 槽29「算啦，河西四郡…咱們就別擔心那麼多啦」
    三个房间出入口 → 全部指向槽40「嗯，這一覺睡得真舒服！」

全库 1756 个非零 id 字段中，**没有一个落进中间的空槽**；未命中的全部是
「比最后一个有脚本的槽大 1~3」，即该对象本就没有事件。

用法:
    python3 scene_table.py <地图归档.DAT>
"""
from __future__ import annotations

import argparse
import re
import struct
import sys
from dataclasses import dataclass
from pathlib import Path, PurePosixPath

import dat_unpack

RECORD_SIZE = 551
NAME_SIZE = 100
TEXT_ENCODING = "big5"

#: **绘制偏移**（`+108` 起两个 i16）。
#:
#: 最终位置 = **对象 (X, Y) ＋ 这个偏移 ＋ SF2 图层坐标**。
#:
#: 绝大多数对象是 `(-320, -260)`，即屏幕中心的负值 —— 因为 SF2 的图层坐标
#: 是按 640×480 画布摆的，减掉半屏才还原成"相对对象的偏移"。
#: **但它不是常量**：废屋的「動畫第二段」是 `(-320, -160)`。
#:
#: ⚠️ 这一条解决了「过场动画摆不对位置」的问题。此前拿 SF2 层坐标当屏幕
#: 绝对坐标画，第一段整个飘到画面右下；两段各自的偏移不同，怎么调都对不齐。
#: 按这个公式算，废屋两段动画的左上角分别落在 (340,273) 与 (332,267) ——
#: **几乎完全重合**，就是屋里的同一处。
OFF_DRAW_OFFSET = 108

#: 这些字段的偏移逐条抄自社区工具 CastleScript 的 `SCI.cs`
#: （`~/Game/yc/_ext/CastleScript(1)/`）——**有源码就别去猜**。
#: 此前用「kind 是不是 5」「贴图大不大」去猜显隐与播放段，猜错过好几轮。
OFF_SHOW_WITH_MAP = 0x70
OFF_MOUSE = 0x73
# RPG.exe 0x409aa4 / 0x409b38: 0 blocks, nonzero is passable (may trigger touch).
OFF_ENTRANCE = 0x74
OFF_HIDE = 0x75
OFF_MAX_DIRECTIONS = 0xDF
OFF_DISPLAY_SHADOW = 0xE1
OFF_FRAME_START = 0xE2
OFF_FRAME_END = 0xE3

#: `Mouse` 的枚举，出自《剧情代码释义.txt》。
MOUSE_KINDS = {0: "无反应", 1: "放大镜", 2: "可拾取", 3: "对话", 4: "门", 5: "可放置"}

OFF_X = 100
OFF_SPRITE = 123
OFF_TOUCH_EVENT = 234
OFF_TALK_EVENT = 235
OFF_KIND = 237
#: 朝向 0~7。判据：城门守卫成对出现，`下門左士兵` `上門左士兵` 同为 1，
#: `下門右士兵` `上門右士兵` 同为 5，左右对称
OFF_FACING = 259

#: **角色自由走动的活动范围**（`SCI.cs` 的 `RangeX` / `RangeY`，各 4 字节）。
#:
#: 释义原文：「offset=0xEF，4字节，**角色自由走动时，离默认出现地点的
#: 可允许最远横向距离**」「offset=0xF3……最远纵向距离」。
#:
#: ⚠️ **2026-09-05 订正**：这里原先写成「交互半径（椭圆）」，**错了**。
#: 它管的是 NPC 溜达的地盘，与「玩家离多远能触发」无关。
#: 踩踏触发用的是**对象精灵的矩形**（门槛条），见
#: `game/src/scenes/FieldScene.js` 的 `touchRectOf`。
#:
#: 1002 条记录里 972 条是 `(0,0)`（＝不走动 / 用引擎默认），非零的清一色
#: `(100,50)` / `(300,200)` / `(800,400)` —— X:Y 恒为 2:1，正是等距比例。
#:
#: ⚠️ 前端**尚未接线**：NPC 现在都站着不动。
OFF_RANGE_X = 0xEF
OFF_RANGE_Y = 0xF3

#: **一次性物件的存档旗标**（`SCI.cs` 的 `FlagOffset`，2 字节）。
#:
#: 释义说得很清楚：「对于每个宝箱，在 sci 文件里该宝箱数据区块 offset=0xFF 处
#: 都有个数值 Y，而如果玩家还未拾取这个宝箱的话，在存档 `0xE179+Y*2` 处会有 1，
#: 拾取过后就变为 0」。1002 条里 129 条非零。
#:
#: **不读它 = 宝箱拿完还会再出现。**
OFF_FLAG = 0xFF

#: 事件字段存的不是 .eve 的记录号，要减 2 才是。
#:
#: 判据（减 2 前 / 减 2 后）：
#:   掌櫃          西夏鐵衛軍統領赫蘭鐵罕…  →  **客倌，您要在敝店住宿嗎？**
#:   小二          算啦，河西四郡…          →  **這位公子，請坐！**
#:   badguy 神秘客  (空)                    →  **我不惜一切手段才弄到的密卷…**
#:   馬車後入口      (空)                    →  **（這馬車後門開著，裡面是…）**
#:   非自己的客房门   嗯，這一覺睡得真舒服！     →  **這不是我們住宿的客房，還是別亂進去的好**
#:   廢屋入口       現在滿城的西夏軍都在搜捕…  →  **這廢屋裡好像瀰漫著一股不詳之氣…**
#:
#: 减 2 之前每一条都"看着还算合理"，所以一开始没发现——「這位公子，請坐！」
#: 判给中央老也说得通，其实那是店小二的招呼。**语义合理不等于对，
#: 要找那种错了就明显荒谬的样本**（神秘客和马车事件本来落在空槽上）。
EVENT_SLOT_BIAS = 2

#: 对象名以此结尾的是布景，原作没给它起名字，直接填了文件名
UNNAMED_SUFFIX = ".sf2"


class SceneTableError(ValueError):
    """场景对象表格式不符合预期。"""


@dataclass(frozen=True)
class SceneObject:
    """场景里的一个对象。字段全部只读，改动请构造新实例。"""

    index: int
    name: str
    x: int
    y: int
    sprite: str
    touch_event: int
    talk_event: int
    kind: int
    facing: int
    #: 绘制偏移，见 `OFF_DRAW_OFFSET`。最终位置 = (x,y) + (dx,dy) + SF2 层坐标。
    dx: int
    dy: int
    #: 1 = 随地图出现；0 = 等剧情用 `actor_show` 叫。
    show_with_map: int
    #: 鼠标形状，也就是交互类型，见 `MOUSE_KINDS`。
    mouse: int
    #: 隐形：存在但不画（触发线一类）。
    hide: int
    #: 朝向数（8 / 4 / 0）与影子。
    directions: int
    shadow: int
    #: 默认播放的帧区间（**1 起算**，与 SF2 帧号一致）。
    frame_start: int
    frame_end: int
    #: NPC 自由走动范围；不是交互距离。见 OFF_RANGE_X。
    range_x: int = 0
    range_y: int = 0
    #: 一次性物件的存档旗标编号（宝箱等）。`0` = 不是一次性的。见 OFF_FLAG。
    flag: int = 0
    entrance: int = 0

    @property
    def named(self) -> bool:
        """原作是否给它起了名字。没起名的是布景。"""
        return not self.name.lower().endswith(UNNAMED_SUFFIX)

    @property
    def interactive(self) -> bool:
        return bool(self.touch_event or self.talk_event)


def _text(raw: bytes) -> str:
    return raw.split(b"\0")[0].decode(TEXT_ENCODING, errors="replace")


def _event_slot(raw: int) -> int:
    """事件字段 -> .eve 记录号。0 表示没有事件。"""
    return raw - EVENT_SLOT_BIAS if raw > EVENT_SLOT_BIAS else 0


def parse(data: bytes) -> tuple[SceneObject, ...]:
    """把整份 `NP場景001.SCI` 切成对象列表。"""
    if not data:
        return ()
    if len(data) % RECORD_SIZE:
        raise SceneTableError(
            f"长度 {len(data)} 不是 {RECORD_SIZE} 的整数倍，格式与预期不符"
        )

    out = []
    for i in range(len(data) // RECORD_SIZE):
        r = data[i * RECORD_SIZE:(i + 1) * RECORD_SIZE]
        x, y = struct.unpack_from("<2i", r, OFF_X)
        dx, dy = struct.unpack_from("<2h", r, OFF_DRAW_OFFSET)
        out.append(SceneObject(
            index=i,
            name=_text(r[:NAME_SIZE]),
            x=x,
            y=y,
            sprite=_text(r[OFF_SPRITE:OFF_SPRITE + NAME_SIZE]).replace("\\", "/"),
            touch_event=_event_slot(r[OFF_TOUCH_EVENT]),
            talk_event=_event_slot(r[OFF_TALK_EVENT]),
            kind=r[OFF_KIND],
            facing=r[OFF_FACING],
            dx=dx, dy=dy,
            show_with_map=r[OFF_SHOW_WITH_MAP],
            mouse=r[OFF_MOUSE],
            hide=r[OFF_HIDE],
            entrance=r[OFF_ENTRANCE],
            directions=r[OFF_MAX_DIRECTIONS],
            shadow=r[OFF_DISPLAY_SHADOW],
            frame_start=r[OFF_FRAME_START],
            frame_end=r[OFF_FRAME_END],
            range_x=struct.unpack_from("<i", r, OFF_RANGE_X)[0],
            range_y=struct.unpack_from("<i", r, OFF_RANGE_Y)[0],
            flag=struct.unpack_from("<H", r, OFF_FLAG)[0],
        ))
    return tuple(out)


#: ⚠️ **这里曾经有一套「别名解析」，已删。**
#:
#: 它是给一个**错误前提**打的补丁：当时以为「SCI 写 `0207N001`、归档里叫
#: `NN0207-01`，原作数据自己对不上」。真相是 `dat_unpack.TABLE_START` 写错了
#: （0x62 应为 0x3B），**每个归档的第一条都没被读出来** —— 而 `0207N001.SF2`
#: 恰好就是 `mp0207.DAT` 的第一条。
#:
#: 那套补丁把药铺老板错指到了 `NN0207-01`（那其实是柜台），把废屋的
#: 「動畫第一段」错指到 `EVENT2-3`（那是第二段），于是「老板的位置摆了个柜子」
#: 「一进废屋就播战斗那段」。**修好根因后全库 5047 处引用有 88.6% 本归档直接
#: 命中、0.3% 跨归档，真缺的只剩 42 处（多数还是空槽的垃圾字节）。**
#:
#: 教训：**先确认「找不到」是不是自己的解析器的问题，再去怀疑原作数据。**


#: 空槽的残留字节长这样：太短，或含不可打印字符。
def looks_like_junk(stem: str) -> bool:
    return len(stem) < 3 or not stem.isprintable() or stem.strip(".-_") == ""


def sprite_aliases(stem: str) -> list[str]:
    """候选写法。**现在只有它自己** —— 别名规则已删，见上面的说明。"""
    return [stem]


def sprite_key(sprite_path: str) -> str:
    """精灵路径 → 资源键。**必须带上图文件夹。**

        mp0212/nb0212-1.SF2  →  MP0212-NB0212-1

    ## ⚠️ 为什么不能只取文件名

    这一行曾经是 `return Path(sprite_path).stem.upper()` —— 把图文件夹扔掉。
    而**原作存的就是「图文件夹 + 文件名」的相对路径**（字段 123，100 字节，
    实测 230/230 条全都带文件夹，一个例外都没有）。

    原作按完整路径取文件，`mp0706\\001.SF2` 与 `mp1402\\001.SF2` 毫无歧义。
    我们扔掉文件夹之后，全部精灵挤进同一个 `sprites/` 目录、**后导盖先导**：

    * 全库 **56 个名字**同名不同内容（`001.SF2` 在 13 个归档里是 13 个不同角色）
    * **63 个对象画成了别人**（`MP0706/掌櫃的` 画成了 `MP1402` 的嵩陽門人）
    * 另有 33 个是同一角色的不同动作集，帧数不对、动作段播不出来

    判据是**渲染出来看图**，对照见 `docs/图/精灵撞名对照.png`；
    体检工具 `tools/sprite_name_audit.py`。

    ⚠️ **跨图引用照样带对方的图号**（全库 14 处，例：`MP0209` 的对象引用
    `mp0204/nb0204.SF2` → `MP0204-NB0204`）。那张图导出时会产出同一个键，
    所以前端拿得到 —— 而按旧写法它会撞上 `MP0209` 自己那个同名文件，
    **显示成另一个东西**。
    """
    path = str(sprite_path).replace("\\", "/")
    pure = PurePosixPath(path)
    folder = pure.parent.name.upper()
    stem = PurePosixPath(pure.name).stem.upper()
    return f"{folder}-{stem}" if folder else stem


def sprite_file_stem(key: str) -> str:
    """资源键 → 原始文件名（去掉图文件夹前缀）。`MP0212-NB0212-1` → `NB0212-1`。

    ⚠️ 文件名里本来就可能有 `-`（`NB0212-1`），所以只能切**第一个** `-`。
    图文件夹名里没有 `-`（全库图号是 `MP0212` / `MP2101A&B` 这种）。
    """
    return key.split("-", 1)[1] if "-" in key else key


def tail_number(name: str) -> str | None:
    """文件名末尾那串数字（去前导零）。`NP新圖004.SCI` → `4`。

    ⚠️ **只能靠数字比。** 归档条目名与地图级 SCI 里那个字符串**编码不同**
    （归档里解出来是 `NP?s??001.SCI` 这样的乱码，SCI 里是 `NP新圖001.SCI`），
    汉字部分对不上，数字是唯一可靠的部分。
    """
    m = re.search(r"(\d+)$", PurePosixPath(str(name).replace("\\", "/")).stem)
    if not m:
        return None
    return m.group(1).lstrip("0") or "0"


def pick_entry(entries, named: str | None = None):
    """一个归档里有好几个对象表时，挑哪一个。

    ## 判据（两级）

    1. **地图级 SCI 的 `0x205` 点了名**（`SCI.cs` 的 `EventSCIPath`）——
       按末尾数字认；同一个数字有多个候选时取**文件名最长**的
       （`NP新圖001.SCI` 比 `NP1.SCI` 长，而点名的正是带中文那个）
    2. 点名取不到 → **第一个长度是 551 整数倍的**

    ## 为什么不能"取第一个"

    89 个归档有**多个**非 `MP` 开头的 `.SCI`。按"取第一个"：

    * **`MP1007C` 压根导不出来** —— 它的 `NP0.SCI` 有 158581 字节、
      **头四字节是 `SF2\x05`，那根本不是对象表而是一张图**，
      `parse` 直接抛「不是 551 的整数倍」。后果是那张图只有 `ground.jpg`、
      **没有 `map.json`**，进去是空的
    * 另有 **5 张取的不是点名那个**：`MP1006B` `MP1003A` `MP1009C`
      `MP1603B2` `MP2409A2` —— 对象数从 15/9/2/9/1 变成 15/11/6/7/6，
      也就是那几张图**少画了一批对象**（或画了别的分区的）

    这是判据表「归档里同一类文件有好几个 → 先按图号挑，别取第一个」
    在**对象表**上的翻版（上一次是 `MP1101` 里两个 MB，取错让整座沙州城
    93% 判成不可走）。
    """
    ok = [e for e in entries
          if e.name.upper().endswith(".SCI") and not e.name.upper().startswith("MP")
          and e.size and e.size % RECORD_SIZE == 0]
    if not ok:
        return None
    want = tail_number(named) if named else None
    if want is not None:
        hit = [e for e in ok if tail_number(e.name) == want]
        if hit:
            return max(hit, key=lambda e: len(e.name))
    return ok[0]


def find_entry(archive: Path) -> bytes | None:
    """从 `.DAT` 里取出场景对象表。挑选判据见 `pick_entry`。

    ⚠️ 这条路**拿不到地图级 SCI 的点名**（调用方只给了归档路径），
    所以只走第二级判据。`export_map.py` 走的是带点名的那条。
    """
    with archive.open("rb") as fh:
        entries = dat_unpack.read_entries(fh, archive.stat().st_size)
        e = pick_entry(entries)
        if e is None:
            return None
        fh.seek(e.offset)
        return fh.read(e.size)


def load(archive: Path) -> tuple[SceneObject, ...]:
    data = find_entry(archive)
    return parse(data) if data else ()


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("archive")
    parser.add_argument("--all", action="store_true", help="连布景一并列出")
    args = parser.parse_args(argv)

    archive = Path(args.archive)
    if not archive.is_file():
        print(f"找不到归档: {archive}", file=sys.stderr)
        return 1

    objects = load(archive)
    if not objects:
        print("该归档没有场景对象表", file=sys.stderr)
        return 1

    print(f"=== {archive.name} 共 {len(objects)} 个对象 ===")
    for o in objects:
        if not (args.all or o.named or o.interactive):
            continue
        events = []
        if o.touch_event:
            events.append(f"碰触→槽{o.touch_event}")
        if o.talk_event:
            events.append(f"交谈→槽{o.talk_event}")
        print(f"#{o.index:<3} {o.name:<16} ({o.x:>5},{o.y:>5}) "
              f"类型{o.kind} 朝向{o.facing} {sprite_key(o.sprite):<16} {' '.join(events)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
