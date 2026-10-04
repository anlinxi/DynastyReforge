#!/usr/bin/env python3
"""解包幽城幻剑录的 .DAT 资源归档。

结构:
    **0x3B** 起为条目表，每条 39 字节（0x27）
        +0   文件名（ASCII，NUL 结尾，25 字节内）
        +25  u32 该文件在归档中的绝对偏移
    文件大小取自被指向文件自身的头部（SF2 头 0x34 即文件总长）。

⚠️ **条目自身声明的长度不可信，要拿「到下一条的偏移」兜底。**
`ItfDir.DAT` 末尾三条 `ITF501`/`ITF502`/`ITF503` 的 SF2 头部 0x34 写着
199934/50341/20551，而归档里到下一条只有 87101/27655/18752 字节 ——
旧代码一句 `if not 0 < size <= archive_size - offset: continue` 把它们
**静默丢掉**，于是官方版被判成「没有絕學的列表板与咒法/絕技板」，
还差点去 300块 MOD 的归档里拿（那份是**简体重画**的「绝技」）。
按边界切出来三条**全都解得开**：242×301 列表板 + 218×200 说明板、
107×108 咒法/絕技板（繁体）、43×20 两个小标签。
**这是「漏读第一条」那条判据的镜像：那次丢头，这次丢尾。**

⚠️ **表起点是 0x3B 不是 0x62。** 早先写成 0x62，于是**每个归档都漏读了
第一条**，而且漏得毫无征兆 —— 后面的条目全都正常，只是第一个文件凭空消失。

代价很大，一路误导了好几轮：
  * `mp0207.DAT` 的第一条正是 `0207N001.SF2`（药铺老板）。因为读不到它，
    先是被判成「NPC 精灵真的不存在」，后来又编了一套「别名解析」
    把它错指到 `NN0207-01`（那其实是柜台），于是「药铺老板的位置摆了个柜子」。
  * `mp0208.DAT` 的第一条是 `EVENT2-3-2.SF2`（废屋初遇的第一段动画）。
    读不到它，别名规则把「動畫第一段」错指到 `EVENT2-3`（那是第二段），
    于是一进废屋就直接播了战斗那一段。

判据（社区文档《剧情代码释义.txt》原话）：
    「所有 dat 包的第一个有效文件的文件名的开头代码都是出现在 offset=0x3B 处，
      它的索引部分占据 0x27 字节；然后第二个文件名必定出现在 0x62=0x3B+0x27」
实测四个归档的 0x3B 处依次是 `EVENT2-3-2.SF2` / `0207N001.SF2` /
`0201N001C.SF2` / `1-1.SF2`，且偏移都指向归档头部尚未被任何条目覆盖的那一段。

用法:
    python3 dat_unpack.py <archive.DAT> --list [--filter ATT01]
    python3 dat_unpack.py <archive.DAT> <输出目录> [--filter ATT01]
"""
from __future__ import annotations

import argparse
import struct
import sys
from dataclasses import dataclass
from pathlib import Path

TABLE_START = 0x3B
ENTRY_SIZE = 39
NAME_FIELD_LEN = 25
OFFSET_FIELD = 25
SF2_SIZE_FIELD = 0x34   # 图像数据块总长，同时是内嵌音效表的偏移
SF2_SOUND_BLOCK = 0x38  # 音效数据块长度，紧跟在图像数据之后
SF2_HEADER_MIN = 0x3C
MAX_ENTRIES = 100_000


@dataclass(frozen=True)
class Entry:
    name: str
    offset: int
    size: int


#: 归档条目名的编码。**不是 ASCII** —— 原作是繁体中文版，条目名里有中文
#: （`ND0304-02出入口.SF2`、`NG0401-香包.SF2`、`NN0607A-左.SF2`…）。
#:
#: ⚠️ 这里原先写的是 `ascii`，中文全变成 `\ufffd`，而**对象表那边
#: （`scene_table.TEXT_ENCODING`）解的是 big5** —— 两边名字对不上，
#: 于是 `export_map` 匹配精灵时找不到条目，**84 个对象的精灵一个都没导出来**，
#: 涉及 31 个归档。后果最刺眼的一处：`MP0304` 的出口精灵没导 →
#: 踩踏形状取不到、退回包围盒 → 进图那一刻人就在框内、`seedTouched` 记成
#: 「已压住」→ **走出去不算「跨进去」，人出不来**，得走远再回来才行。
#:
#: Big5 对 ASCII 字节是兼容的，所以全库按前后缀筛条目的地方
#: （`startswith("MB")` / `endswith(".SF2")` …）一个都不受影响。
NAME_ENCODING = "big5"


def _clean_name(raw: bytes) -> str:
    return raw.split(b"\0")[0].decode(NAME_ENCODING, "replace").strip()


def read_entries(fh, archive_size: int) -> list[Entry]:
    fh.seek(TABLE_START)
    table = fh.read(min(MAX_ENTRIES * ENTRY_SIZE, archive_size - TABLE_START))

    entries: list[Entry] = []
    for i in range(len(table) // ENTRY_SIZE):
        base = i * ENTRY_SIZE
        name = _clean_name(table[base:base + NAME_FIELD_LEN])
        if not name or not name.isprintable():
            break

        offset = struct.unpack_from("<I", table, base + OFFSET_FIELD)[0]
        if not 0 < offset < archive_size:
            break

        fh.seek(offset)
        head = fh.read(SF2_HEADER_MIN)
        if len(head) < 4:
            continue

        if head.startswith(b"SF2"):
            # 完整条目 = 图像数据块 + 音效数据块，只取前者会丢掉内嵌音效
            size = (
                struct.unpack_from("<I", head, SF2_SIZE_FIELD)[0]
                + struct.unpack_from("<I", head, SF2_SOUND_BLOCK)[0]
            )
        else:
            # 非 SF2 条目（地图归档中的 .JPG/.EVE/.MSG/.SCI 等）自身不带长度，
            # 以下一个条目的偏移为界。地图的地面美术即以 JPEG 存放，
            # 早先只认 SF2 magic 会把它整个跳过。
            size = 0

        entries.append(Entry(name=name, offset=offset, size=size))

    # 长度一律拿**边界**校一遍。判据在模块头：归档末尾几条的 SF2 头部声明
    # 长度会超过实际存放的字节数，旧代码据此把它们丢掉，而按边界切出来
    # 完全解得开 —— **声明长度只是上界的参考，边界才是事实**。
    bounds = {e.offset for e in entries} | {archive_size}
    entries = [
        _bounded(e, min(b for b in bounds if b > e.offset) - e.offset)
        for e in entries
    ]

    return entries


def _bounded(entry: Entry, room: int) -> Entry:
    """把条目长度夹到「到下一条的偏移」以内；没有声明长度的直接用边界。"""
    size = entry.size if 0 < entry.size <= room else room
    return entry if size == entry.size else Entry(entry.name, entry.offset, size)


def extract(fh, entry: Entry, out_dir: Path) -> Path:
    fh.seek(entry.offset)
    data = fh.read(entry.size)
    path = out_dir / entry.name
    path.write_bytes(data)
    return path


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("archive")
    parser.add_argument("out_dir", nargs="?")
    parser.add_argument("--list", action="store_true", help="只列出条目")
    parser.add_argument("--filter", help="只处理文件名包含该串的条目（不区分大小写）")
    parser.add_argument("--limit", type=int, default=0)
    args = parser.parse_args(argv)

    archive = Path(args.archive)
    if not archive.is_file():
        print(f"归档不存在: {archive}", file=sys.stderr)
        return 1

    with archive.open("rb") as fh:
        entries = read_entries(fh, archive.stat().st_size)
        if args.filter:
            key = args.filter.lower()
            entries = [e for e in entries if key in e.name.lower()]
        if args.limit:
            entries = entries[: args.limit]

        print(f"{archive.name}: 命中 {len(entries)} 个条目")

        if args.list or not args.out_dir:
            for e in entries[:40]:
                print(f"  {e.name:<20} offset={e.offset:<12} size={e.size}")
            if len(entries) > 40:
                print(f"  … 另有 {len(entries) - 40} 个")
            return 0

        out_dir = Path(args.out_dir)
        out_dir.mkdir(parents=True, exist_ok=True)
        for e in entries:
            extract(fh, e, out_dir)
            print(f"  {e.name} ({e.size} bytes)")

    print(f"\n解出 {len(entries)} 个文件 -> {args.out_dir}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
