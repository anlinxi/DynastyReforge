#!/usr/bin/env python3
"""解密幽城幻剑录 public/ 下的 .enc 数据表。

加密方式极简：明文按字节与一个**逐字节递增、在 255 处回绕**的计数器异或。

    明文[i] = 密文[i] XOR (i % 255)

⚠️ **原先写的是 `i & 0xFF`，那是错的**，它只在前 255 字节碰巧一致。
从偏移 255 起两者开始错开，越往后偏得越多，解出来的仍是密文。
判据是 `Miscinfo.enc`：它前 6 条记录是 `Fight\\Other\\Stone000..005.sf2`，
第 6 条横跨偏移 255，**只有 `i % 255` 能把它解对**。
全库复核：改对之后 `Layoutgr.enc` 的香农熵从 8.00（与密文无异）降到 0.56，
`Magictb` / `Refinek` / `Refinet` 的 u32 **100% 落进小值区**。

表现特征是密文中绝大多数字节恰好等于计数器值——因为这些表很稀疏，
明文多为 0，异或后就留下了计数器本身。

解出的表多为 uint32 数组。例如 Magictb.enc 是 9 个 u32 一条记录，
首条 `[1,10,20,0,0,0,20,10,301]`，末位 301(=0x12D，摄魂鬼爪) 是绝学代码，
可与 data/skills.json 交叉验证。

用法:
    python3 enc_decode.py <file.enc> [输出.bin] [--u32 24] [--find 301]
"""
from __future__ import annotations

import argparse
import struct
import sys
from pathlib import Path


#: 计数器的回绕周期。**是 255 不是 256**，见模块文档。
KEY_PERIOD = 255


def decode(data: bytes) -> bytes:
    """明文 = 密文 XOR (偏移 % 255)。"""
    return bytes(b ^ (i % KEY_PERIOD) for i, b in enumerate(data))


def as_u32(data: bytes) -> list[int]:
    count = len(data) // 4
    return list(struct.unpack_from(f"<{count}I", data, 0))


def guess_record_size(values: list[int], marker: int) -> list[int]:
    """给定一个已知会出现在每条记录中的值，推测记录长度（以 u32 计）。"""
    positions = [i for i, v in enumerate(values) if v == marker]
    if len(positions) < 2:
        return []
    return [b - a for a, b in zip(positions, positions[1:])]


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source")
    parser.add_argument("output", nargs="?")
    parser.add_argument("--u32", type=int, default=0, help="打印前 N 个 uint32")
    parser.add_argument("--find", type=int, action="append", help="定位某个数值出现的位置")
    args = parser.parse_args(argv)

    src = Path(args.source)
    if not src.is_file():
        print(f"文件不存在: {src}", file=sys.stderr)
        return 1

    plain = decode(src.read_bytes())
    print(f"{src.name}: {len(plain)} 字节，{len(plain)//4} 个 uint32")

    if args.output:
        Path(args.output).write_bytes(plain)
        print(f"已写出: {args.output}")

    values = as_u32(plain)
    if args.u32:
        for i in range(0, min(args.u32, len(values)), 8):
            row = " ".join(f"{v:>8}" for v in values[i:i + 8])
            print(f"  [{i:>4}] {row}")

    for marker in args.find or []:
        positions = [i for i, v in enumerate(values) if v == marker]
        print(f"  数值 {marker} 出现 {len(positions)} 次，前若干位置: {positions[:12]}")
        gaps = guess_record_size(values, marker)
        if gaps:
            print(f"    相邻间隔（u32 数）: {gaps[:12]}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
