#!/usr/bin/env python3
"""进战斗的玻璃破碎转场：从官方原作取破碎表与音效。

原作（RPG.exe）：
- 0x42d0e0 读 `Fight\\Other\\FBX_Table0.FBX`；0x4325f0 先建好战斗场景，再 0x42d030 开播并放
  `Fight/Audio/WAV0001.WAV`；0x42cf70 每拍画一帧，调 0x44e5ca 解码。
- 文件：u32 帧数，随后每帧 16 字节 (宽, 高, 字节数, 偏移)。帧数据逐行、每行宽个像素，
  控制字节低 6 位 +1 为长度，高两位：00 后跟 u32 源偏移，连续复制；10 后跟“长度”个 u32 源偏移，
  逐点复制；01 跳过（露出底下的战斗画面）；11 后跟 u32 源偏移，用该点颜色填满。
  源偏移是被打碎的那张画面（进战斗前的地图画面）上的像素序号。
- `FBX_Table2.FBX` 与 Table0 逐字节相同；`FBX_Table1.fbx`（24 帧渐散）程序里没有直接引用，不导。

用法：python3 tools/export_battle_transition.py [--multimedia 原作multimedia目录] [--out game/public]
"""
from __future__ import annotations

import argparse
import shutil
import struct
import sys
from pathlib import Path

DEFAULT_MULTIMEDIA = Path.home() / "Game/幽城幻剑录/Dynasty/Castle/multimedia"
ROOT = Path(__file__).resolve().parent.parent


def find_ci(folder: Path, name: str) -> Path:
    """按不区分大小写找文件（原作目录里大小写不统一）。"""
    for p in folder.iterdir():
        if p.name.lower() == name.lower():
            return p
    raise FileNotFoundError(f"{folder} 里没有 {name}")


def check_table(data: bytes) -> int:
    """逐帧按 0x44e5ca 的规则走一遍，长度必须刚好对上；返回帧数。"""
    count = struct.unpack_from("<I", data, 0)[0]
    for i in range(count):
        w, h, size, off = struct.unpack_from("<IIII", data, 4 + 16 * i)
        p = off
        for _ in range(h):
            left = w
            while left > 0:
                b = data[p]
                p += 1
                n = (b & 0x3F) + 1
                kind = b >> 6
                p += {0: 4, 1: 0, 2: 4 * n, 3: 4}[kind]
                left -= n
            if left:
                raise ValueError(f"第 {i} 帧有一行像素数对不上")
        if p != off + size:
            raise ValueError(f"第 {i} 帧字节数对不上：{p - off} ≠ {size}")
    return count


def main(argv: list[str]) -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--multimedia", type=Path, default=DEFAULT_MULTIMEDIA)
    ap.add_argument("--out", type=Path, default=ROOT / "game/public")
    args = ap.parse_args(argv)

    fight = args.multimedia / "fight"
    table = find_ci(fight / "Other", "FBX_Table0.fbx")
    sound = find_ci(fight / "Audio", "wav0001.wav")
    frames = check_table(table.read_bytes())

    (args.out / "assets/transition").mkdir(parents=True, exist_ok=True)
    (args.out / "audio").mkdir(parents=True, exist_ok=True)
    shutil.copyfile(table, args.out / "assets/transition/shatter.fbx")
    shutil.copyfile(sound, args.out / "audio/shatter.wav")
    print(f"破碎表 {frames} 帧 → assets/transition/shatter.fbx；音效 → audio/shatter.wav")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
