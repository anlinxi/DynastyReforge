#!/usr/bin/env python3
"""导出**地图名**（「蘭州城」「鐵衛軍石塔 三樓」）→ `assets/data/mapnames.json`。

## 为什么需要它

存档名存的就是**地名** —— `.TSF` 的 `+0` 那个 Big5 串，天书页的记录条上
印着「地點/」的那一格。要能存档就必须有这张表。

## 它在哪

`.eve` 指令 `0x35 show_map_name` 的释义写着「读取地图名称（在游戏屏幕
左上角显示的那个，**msg 文件里有相应名称**）」。

具体位置：`.MSG` 头部的第二个 u32 指向**第一张句子表**（格式见
`map_script.message_sentences`：`[u32 恒 0][u32 句偏移 × N]`），
**那张表的第一句就是地图名**。

⚠️ **不要把它写成常数 `0x828`。** 多数图确实是 2088，但那只是
`8 + 记录数×16` 的巧合（130 条记录）—— `MP0209` 只有 99 条记录，
表在 1592；`MP0301A` 36 条，表在 584，整个文件才 895 字节，
按 2088 读会直接越界。

⚠️ 句子以 `\\x02` 结尾（不是 `\\0`）。按 `\\0` 截断会把结尾的 `\\x02` 带出来。

## 判据

拿 9 个官方存档的存档名交叉验证，逐个吻合：

| 图 | 存档 | 名字 |
|---|---|---|
| `MP0212` | Save002/015/016/017 | 蘭州城 |
| `MP0102B` | NewGame | 夏侯儀房間 |
| `MP0905` | Save008 | 鐵衛軍石塔 三樓 |
| `MP3001` | Save001/004/007 | 西域遼疆 |
| `MP0101` | Save013 | 河州鎮 |

回归在 `tools/tests/test_map_names.py`。

用法：
    python3 tools/export_map_names.py ~/Game/幽城幻剑录/Dynasty/Castle/multimedia/Map
"""
from __future__ import annotations

import argparse
import json
import struct
import sys
from pathlib import Path

import dat_unpack

#: 头部里「第一张句子表的偏移」所在的位置。**表的位置是变的**，见文件头。
TABLE_PTR = 4

#: 句子的结束标记。⚠️ **不是 `\0`** —— 句内 `\x01` 是框内换行。
SENTENCE_END = 0x02

OUT = Path(__file__).resolve().parent.parent / "game/public/assets/data/mapnames.json"


def read_map_name(msg: bytes) -> str | None:
    """从一份 `.MSG` 里取地图名。

    取不到返回 None（**不抛**，缺一张不该拖垮整批）。
    ⚠️ 有些图的第一句**本来就是空的**（`MP0203`/`MP0204`/`MP1410` 等 14 张，
    多是没有独立名字的内室），那也返回 None —— 由调用方决定怎么兜底。
    """
    if len(msg) < TABLE_PTR + 4:
        return None
    table = struct.unpack_from("<I", msg, TABLE_PTR)[0]
    if not 0 < table or table + 8 > len(msg):
        return None
    # [u32 恒 0][u32 第一句的偏移]
    first = struct.unpack_from("<I", msg, table + 4)[0]
    if not 0 < first < len(msg):
        return None
    end = msg.find(bytes([SENTENCE_END]), first)
    if end < 0:
        return None
    blob = msg[first:end].split(b"\x00")[0]
    if not blob:
        return None
    try:
        return blob.decode("big5")
    except UnicodeDecodeError:
        return blob.decode("big5", errors="replace")


def msg_of(archive: Path) -> bytes | None:
    """从一个地图归档里取出 `.MSG`。"""
    with archive.open("rb") as fh:
        for entry in dat_unpack.read_entries(fh, archive.stat().st_size):
            if entry.name.upper().endswith(".MSG"):
                fh.seek(entry.offset)
                return fh.read(entry.size)
    return None


def collect(map_dir: Path) -> dict[str, str]:
    out = {}
    missing = []
    # ⚠️ **扩展名大小写两种都有**（`MP1001e1.DAT` 与 `Mp3001.dat`）。
    # 只 glob `*.DAT` 会漏掉 15 张，其中就有大地图 `Mp3001` ——
    # 而且不报错，只是那些图的地名变成 None。
    archives = sorted((q for q in map_dir.iterdir()
                       if q.is_file() and q.suffix.lower() == ".dat"),
                      key=lambda q: q.stem.upper())
    for archive in archives:
        msg = msg_of(archive)
        name = read_map_name(msg) if msg else None
        if name:
            out[archive.stem.upper()] = name
        else:
            missing.append(archive.stem)
    if missing:
        # ⚠️ 兜底跳过必须留日志 —— 静默吞掉的话，存档名会莫名其妙变成图号。
        print(f"⚠️ {len(missing)} 张图取不到地名：{'、'.join(missing[:12])}"
              + ("…" if len(missing) > 12 else ""), file=sys.stderr)
    return out


def main(argv: list[str]) -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("map_dir", type=Path, help="原作的 Map 目录（含 MP*.DAT）")
    ap.add_argument("-o", "--out", type=Path, default=OUT)
    args = ap.parse_args(argv)

    if not args.map_dir.is_dir():
        print(f"找不到目录：{args.map_dir}", file=sys.stderr)
        return 1
    names = collect(args.map_dir)
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps({
        "生成自": "tools/export_map_names.py",
        "说明": "图号 → 地名。存档名（.TSF +0）存的就是它。",
        "地名": names,
    }, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"-> {args.out}（{len(names)} 张图）")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
