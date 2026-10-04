#!/usr/bin/env python3
"""解析地图脚本：.eve（事件字节码）与 .msg（对白文本）。

两者共用同一种容器格式:
    0x00 u32  记录数 N（实测均为 130）
    0x04 u32  记录区结束位置
    0x08 u32  同上
    0x0C u32  版本/类型
    0x10      N 条记录，每条 16 字节 = 4 个 u32
              [0] 未用（恒为 0）
              [1] 参数
              [2] **数据偏移**，等于文件长度时表示该槽为空
              [3] 参数

.msg：记录的数据偏移直接指向 Big5 文本块，一块内可含多句对白。
.eve：首条记录指向一张 u32 指令偏移表，表长由首个条目的值推定；
      按相邻偏移切分即得变长指令，每条指令首个 u32 为指令码。

已辨认的指令码（mp0212 兰州城样本）:
    58  切换地图    参数含 16 字节地图名 + 落点坐标
    11  登场对象    参数含 16 字节对象名（captain / badguy / wagan…）
    12  移除对象
    26  对象动作
    51  播放对白    负载 8 字节 = [类型, 参数, 标志, **句序号**, ...]
                    句序号是「本槽 .msg 块内的第几句」，不是全局消息编号

槽（= 记录索引）是把对白接回画面的关键:
    槽 #0~#9   同指一段主脚本，地图级事件
    槽 #10 起  各自独立，对应地图上的对象与触发点
    .eve 槽 N ↔ .msg 槽 N 同号配对
哪个对象用哪个槽，记在 `NP場景001.SCI` 里，见 tools/scene_table.py。

用法:
    python3 map_script.py <地图目录> [--messages] [--ops] [--strings] [--slots]
"""
from __future__ import annotations

import argparse
import collections
import re
import struct
import sys
from dataclasses import dataclass
from pathlib import Path

HEADER_SIZE = 16
RECORD_SIZE = 16
TEXT_ENCODING = "big5"

OP_NAMES = {
    58: "切换地图",
    11: "登场对象",
    12: "移除对象",
    26: "对象动作",
    51: "播放对白",
    5: "播放对白",
}


@dataclass(frozen=True)
class Record:
    index: int
    param1: int
    offset: int
    param2: int


def read_records(data: bytes) -> list[Record]:
    count = struct.unpack_from("<I", data, 0)[0]
    out = []
    for i in range(count):
        base = HEADER_SIZE + i * RECORD_SIZE
        if base + RECORD_SIZE > len(data):
            break
        _, p1, off, p2 = struct.unpack_from("<4I", data, base)
        out.append(Record(index=i, param1=p1, offset=off, param2=p2))
    return out


#: 句尾标记
SENTENCE_END = b"\x02"
#: 句内换行，要保留给前端
SOFT_BREAK = "\x01"


# 文本内嵌的排版控制码：`=b`/`=0` 是变色起止（剧情代码释义.txt 的例子是
# `『=b珍瓏鏡玉=0』`）；`/E` `/H` `/z` 一类紧贴换行或句尾出现，是排版指令。
# 全库 mp0212 只有 3 处 /X，mp0605、mp0901 一处都没有，剥离是安全的。
CONTROL_MARK = re.compile(r"[=/][0-9a-zA-Z]")


def _sentence_at(data: bytes, start: int) -> str:
    """取出一句：从 start 读到句尾标记，去掉控制字节但保留换行。"""
    end = data.find(SENTENCE_END, start)
    raw = data[start:end if end > start else len(data)]
    text = raw.decode(TEXT_ENCODING, errors="ignore")
    kept = "".join(c for c in text if c >= " " or c == SOFT_BREAK)
    return CONTROL_MARK.sub(lambda m: m.group(0) if m.group(0) in ("=b", "=r", "=0") else "", kept).strip()


def message_sentences(data: bytes) -> dict[int, tuple[str, ...]]:
    """.msg：槽 -> 该槽的句子表。

    记录指向的不是一整段文本，而是**一张句子偏移表**：

        [u32 恒 0][u32 句偏移 × 记录的 param2]

    param2 就是句数，句子以 `\\x02` 结束、句内 `\\x01` 是框内换行。
    op51 / op5 的句序号索引的正是这张表。

    早先按「」正则从「上一条偏移到下一条偏移」的整段里抓句子，句数和顺序
    都可能错：块界会把邻近记录的文本截断（mp0202 的槽 22/30/31 因此抓不到
    任何字），带（）的旁白也会整句漏掉。
    """
    out: dict[int, tuple[str, ...]] = {}
    for r in read_records(data):
        if not 0 < r.offset < len(data) or r.param2 <= 0:
            continue
        need = (r.param2 + 1) * 4
        if r.offset + need > len(data):
            continue
        pointers = struct.unpack_from(f"<{r.param2 + 1}I", data, r.offset)[1:]
        lines = tuple(
            s for s in (_sentence_at(data, p) for p in pointers if 0 < p < len(data)) if s
        )
        if lines:
            out[r.index] = lines
    return out


def message_blocks(data: bytes) -> dict[int, str]:
    """.msg：槽 -> 整段文本。逐句取出后拼接，供人工速览。"""
    return {slot: "".join(lines) for slot, lines in message_sentences(data).items()}


def script_entries(data: bytes) -> list[int]:
    """全部脚本入口。记录[0] 指向主指令表，其余记录各自是独立事件的入口。"""
    records = read_records(data)
    return sorted({r.offset for r in records if 0 < r.offset < len(data)})


def _offsets_at(data: bytes, table: int) -> list[int]:
    """读取位于 table 处的 u32 偏移表。表长由首个条目的值推定。"""
    if not 0 < table < len(data) or table + 4 > len(data):
        return []
    first = struct.unpack_from("<I", data, table)[0]
    if not table < first <= len(data):
        return []

    count = (first - table) // 4
    out = []
    for i in range(count):
        pos = table + i * 4
        if pos + 4 > len(data):
            break
        value = struct.unpack_from("<I", data, pos)[0]
        if not 0 < value <= len(data) or (out and value < out[-1]):
            break
        out.append(value)
    return out


def instruction_offsets(data: bytes) -> list[int]:
    """全部指令偏移。

    每个脚本入口自身也是「偏移表 + 指令数据」的结构，不止首条记录如此。
    只解析首条会漏掉其余入口的指令——某些地图因此只解出个位数指令。
    """
    collected = set()
    for entry in script_entries(data):
        collected.update(_offsets_at(data, entry))
    return sorted(collected)


def instructions(data: bytes) -> list[tuple[int, int, bytes]]:
    """切分为 (偏移, 指令码, 负载)。"""
    offsets = instruction_offsets(data)
    out = []
    for i, off in enumerate(offsets):
        end = offsets[i + 1] if i + 1 < len(offsets) else len(data)
        if end <= off or off + 4 > len(data):
            continue
        code = struct.unpack_from("<I", data, off)[0]
        out.append((off, code, data[off + 4:end]))
    return out


#: 两个播放对白的指令。op51 是主力（9227 次），op5 少些（2540 次），
#: 负载同构；mp0202 的槽 28/29 只有 op5，漏读会让那些 NPC 一言不发。
OP_DIALOGUE = (51, 5)
#: 对白负载共 8 字节，逐字节含义出自
#: `~/Game/yc/_ext/CastleScript(1)/CastleScript/剧情代码释义.txt`：
#:
#:     [0] 人物代码   查 namelist.py，同时决定用哪个 <代码>-2.SF2 立绘
#:     [1] 表情代码   立绘文件内的表情序号（0-15）
#:     [2] 左右侧     00 左 / 01 右
#:     [3] 句序号     该槽句子表内的第几句
#:     [7] 段落结束   01 表示这句放完后对话栏消失
DIALOGUE_SPEAKER_BYTE = 0
DIALOGUE_EMOTION_BYTE = 1
DIALOGUE_SIDE_BYTE = 2
#: ⚠️ **句序号是 u32，不是一个字节。** 释义 op05/op33 的格式是
#: `XX YY ZZ WWWWWWWW UU` —— `W` 占 4 字节。只读低位的话，句子池超过 256 条
#: 的槽会**静默取到错的句子**：全库 227 条对白（mp0610a 槽 9、mp1013）
#: 真实行号 256~301，被截成 0~45，台词整段串到别人身上。
DIALOGUE_LINE_BYTE = 3
DIALOGUE_LINE_WIDTH = 4
DIALOGUE_END_BYTE = 7
DIALOGUE_PAYLOAD = 8

SIDE_RIGHT = 1
#: 立绘每个文件 32 帧 = 16 表情 × 2 朝向，右侧那半在 +16
EMOTIONS_PER_SIDE = 16

#: 注意：对象表里 234/235 存的是「事件编号」，比这里的记录槽号大 2。
#: 那个减法在 scene_table._event_slot 里做（见 EVENT_SLOT_BIAS），
#: 本模块一律按**记录槽号**说话，不要在这里再减一次。


@dataclass(frozen=True)
class Instruction:
    offset: int
    code: int
    payload: bytes


def _owning_records(data: bytes) -> list[Record]:
    """同一段脚本被多条记录指向时，只认真正拥有它的那条。

    地图级主脚本被槽 #0~#9 一起指着，但只有其中一条的 param2 写着指令数
    （mp0212 是槽 #9，152 条），其余为 0。把这段脚本算到每个槽头上会让
    句序号大面积对不上——.msg 那边的句子也只挂在同一个槽号下。
    """
    by_offset: dict[int, Record] = {}
    for r in read_records(data):
        if not 0 < r.offset < len(data):
            continue
        current = by_offset.get(r.offset)
        if current is None or r.param2 > current.param2:
            by_offset[r.offset] = r
    return sorted(by_offset.values(), key=lambda r: r.index)


def slot_scripts(data: bytes) -> dict[int, tuple[Instruction, ...]]:
    """按槽切分指令流，保留槽内的先后顺序。

    `instructions()` 把所有入口的指令合并成一条全局列表，槽的归属在那一步
    就丢掉了；要知道「哪句话属于哪个对象」必须按槽分开读。
    """
    boundaries = instruction_offsets(data)
    position = {off: i for i, off in enumerate(boundaries)}

    out: dict[int, tuple[Instruction, ...]] = {}
    for record in _owning_records(data):
        script = []
        for off in _offsets_at(data, record.offset):
            i = position.get(off)
            end = boundaries[i + 1] if i is not None and i + 1 < len(boundaries) else len(data)
            if end <= off or off + 4 > len(data):
                continue
            code = struct.unpack_from("<I", data, off)[0]
            script.append(Instruction(offset=off, code=code, payload=data[off + 4:end]))
        if script:
            out[record.index] = tuple(script)
    return out


@dataclass(frozen=True)
class Dialogue:
    """一句对白，连同说话人与立绘信息。"""

    speaker: int
    emotion: int
    side: int
    line: int
    end: bool
    text: str

    @property
    def portrait_frame(self) -> int:
        """立绘帧号。右侧朝向是美术另画的面朝左版本，位于 +16，不是镜像翻转。"""
        return self.emotion + (EMOTIONS_PER_SIDE if self.side == SIDE_RIGHT else 0)

    def to_dict(self) -> dict:
        return {
            "speaker": self.speaker, "emotion": self.emotion, "side": self.side,
            "frame": self.portrait_frame, "end": self.end, "text": self.text,
        }


def parse_dialogue(payload: bytes, pool: tuple[str, ...]) -> Dialogue | None:
    if len(payload) < DIALOGUE_PAYLOAD:
        return None
    index = int.from_bytes(
        payload[DIALOGUE_LINE_BYTE:DIALOGUE_LINE_BYTE + DIALOGUE_LINE_WIDTH], "little")
    if index >= len(pool):
        return None
    return Dialogue(
        speaker=payload[DIALOGUE_SPEAKER_BYTE],
        emotion=payload[DIALOGUE_EMOTION_BYTE],
        side=payload[DIALOGUE_SIDE_BYTE],
        line=index,
        end=bool(payload[DIALOGUE_END_BYTE]),
        text=pool[index],
    )


def slot_dialogue(eve: bytes, msg: bytes) -> dict[int, tuple[Dialogue, ...]]:
    """每个槽实际会说出的台词，按脚本里对白指令出现的顺序排好。

    句序号只在**本槽**的句子表内有意义，所以必须先按槽切分再取句。

    **相邻完全相同的调用只保留一条**：原作用条件指令（op71/74/75）在同一
    段脚本里铺开多个互斥分支，分支之间常引用同一句台词，顺序播放会把同一
    句说好几遍（mp0212 的槽 26 有 4 条一模一样的 op51）。
    """
    pools = message_sentences(msg)
    out: dict[int, tuple[Dialogue, ...]] = {}
    for slot, script in slot_scripts(eve).items():
        pool = pools.get(slot, ())
        if not pool:
            continue

        lines: list[Dialogue] = []
        for ins in script:
            if ins.code not in OP_DIALOGUE:
                continue
            line = parse_dialogue(ins.payload, pool)
            if line is None or (lines and lines[-1] == line):
                continue
            lines.append(line)
        if lines:
            out[slot] = tuple(lines)
    return out


def dialogue_ids(data: bytes) -> list[tuple[int, int, int]]:
    """从指令流中取出全部对白调用，返回 (指令偏移, 说话者, 句序号)。"""
    out = []
    for off, code, payload in instructions(data):
        if code in OP_DIALOGUE and len(payload) > DIALOGUE_LINE_BYTE:
            out.append((off, payload[0], payload[DIALOGUE_LINE_BYTE]))
    return out


def find_strings(data: bytes, min_len: int = 3) -> list[tuple[int, str]]:
    """脚本中的对象名/地图名以 NUL 结尾的 ASCII 存放。"""
    return [
        (m.start(), m.group()[:-1].decode("ascii"))
        for m in re.finditer(rb"[\x20-\x7e]{%d,}\x00" % min_len, data)
    ]


def locate(map_dir: Path) -> tuple[Path | None, Path | None]:
    eve = next((p for p in map_dir.iterdir() if p.suffix.lower() == ".eve"), None)
    msg = next((p for p in map_dir.iterdir() if p.suffix.lower() == ".msg"), None)
    return eve, msg


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("map_dir")
    parser.add_argument("--messages", action="store_true", help="打印对白")
    parser.add_argument("--ops", action="store_true", help="打印指令码统计")
    parser.add_argument("--strings", action="store_true", help="打印脚本内的名称")
    parser.add_argument("--dialogue", action="store_true", help="按脚本顺序打印对白链")
    parser.add_argument("--slots", action="store_true", help="按槽打印台词")
    parser.add_argument("--limit", type=int, default=12)
    args = parser.parse_args(argv)

    map_dir = Path(args.map_dir)
    if not map_dir.is_dir():
        print(f"不是目录: {map_dir}", file=sys.stderr)
        return 1

    eve_path, msg_path = locate(map_dir)
    print(f"=== {map_dir.name} ===")

    if msg_path:
        msg = msg_path.read_bytes()
        blocks = message_blocks(msg)
        print(f"{msg_path.name}: {len(msg)} 字节，{len(blocks)} 条对白")
        if args.messages:
            for idx, text in list(blocks.items())[: args.limit]:
                clean = re.sub(r"[^　-鿿「」『』，。！？…、：]", "", text)
                if clean:
                    print(f"  #{idx:>3}: {clean[:60]}")

    if eve_path:
        eve = eve_path.read_bytes()
        ins = instructions(eve)
        print(f"{eve_path.name}: {len(eve)} 字节，{len(ins)} 条指令")
        if args.ops:
            counter = collections.Counter(code for _, code, _ in ins)
            for code, n in counter.most_common(args.limit):
                print(f"  指令 {code:>4} x{n:<4} {OP_NAMES.get(code, '')}")
        if args.strings:
            names = collections.Counter(s for _, s in find_strings(eve))
            print(f"  脚本内名称: {dict(names)}")
        print(f"  脚本入口: {len(script_entries(eve))} 个")

        if args.slots and msg_path:
            for slot, lines in sorted(slot_dialogue(eve, msg_path.read_bytes()).items()):
                print(f"  槽#{slot}")
                for line in lines[: args.limit]:
                    print(f"      {line[:56]}")

        if args.dialogue and msg_path:
            blocks = message_blocks(msg_path.read_bytes())
            shown = 0
            for _, kind, line_no in dialogue_ids(eve):
                text = re.sub(r"[^　-鿿「」『』，。！？…、：]", "", blocks.get(line_no, ""))
                if not text:
                    continue
                print(f"    句{line_no:<3} 类型{kind:<3} {text[:56]}")
                shown += 1
                if shown >= args.limit:
                    break

    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
