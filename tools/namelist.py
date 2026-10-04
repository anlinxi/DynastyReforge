#!/usr/bin/env python3
"""解析 Sys.dat 内的 NAMELIST.LIS —— 人物代码到姓名的对照表。

对白指令 op51 的首字节是人物代码，本表把它翻译成姓名，
同时也决定该角色用哪个 `<代码>-2.SF2` 表情立绘文件。

结构:
    0x1C 起为 u32 偏移表，name_offset[代码] = u32 @ (0x1C + 代码*4)
    偏移指向 Big5 字符串，NUL 结尾

原始姓名带前导空格，那是原作为 153×37 姓名牌做的居中排版，
本模块一律 strip，居中交给渲染层。

校验点：代码 0x1F 应为「高皇君」（剧情代码释义.txt 记载）。

用法:
    python3 namelist.py <Sys.dat> [--json 输出.json]
"""
from __future__ import annotations

import argparse
import json
import struct
import sys
from pathlib import Path

import dat_unpack

TABLE_START = 0x1C
ENTRY_NAME = "NAMELIST.LIS"
MAX_CODES = 256
ENCODING = "big5"
CHECK_CODE = 0x1F
CHECK_NAME = "高皇君"


def parse(data: bytes) -> dict[int, str]:
    """偏移表 -> {人物代码: 姓名}。遇到越界偏移即认定表已到尾。"""
    names: dict[int, str] = {}
    for code in range(MAX_CODES):
        pos = TABLE_START + code * 4
        if pos + 4 > len(data):
            break

        offset = struct.unpack_from("<I", data, pos)[0]
        if not 0 < offset < len(data):
            # 代码 0 是系统旁白，偏移为 0 属正常；此后的越界值表示表结束
            if code == 0:
                names[code] = ""
                continue
            break

        end = data.find(b"\0", offset)
        raw = data[offset:end if end >= 0 else len(data)]
        names[code] = raw.decode(ENCODING, errors="replace").strip()
    return names


def load(sys_dat: Path) -> dict[int, str]:
    """从 Sys.dat 归档里取出并解析人名表。"""
    with sys_dat.open("rb") as fh:
        entries = dat_unpack.read_entries(fh, sys_dat.stat().st_size)
        entry = next((e for e in entries if e.name.upper() == ENTRY_NAME), None)
        if entry is None:
            raise FileNotFoundError(f"{sys_dat} 内没有 {ENTRY_NAME}")
        fh.seek(entry.offset)
        return parse(fh.read(entry.size))


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("sys_dat")
    parser.add_argument("--json", help="写出 JSON")
    args = parser.parse_args(argv)

    path = Path(args.sys_dat)
    if not path.is_file():
        print(f"找不到 {path}", file=sys.stderr)
        return 1

    names = load(path)
    actual = names.get(CHECK_CODE)
    if actual != CHECK_NAME:
        print(f"⚠️ 校验失败：代码 0x{CHECK_CODE:02X} 应为「{CHECK_NAME}」，实得「{actual}」",
              file=sys.stderr)
        return 1

    print(f"解出 {len(names)} 个人名，校验通过（0x{CHECK_CODE:02X}={CHECK_NAME}）")
    for code in sorted(names)[:12]:
        print(f"  {code:>3} = {names[code]!r}")

    if args.json:
        out = Path(args.json)
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_text(
            json.dumps({str(k): v for k, v in names.items()},
                       ensure_ascii=False, separators=(",", ":")),
            encoding="utf-8",
        )
        print(f"写出 {out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
