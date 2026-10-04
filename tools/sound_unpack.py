#!/usr/bin/env python3
"""从 SF2 音效容器（fight/Audio/sound*.SF2）提取 PCM 并封装为 WAV。

音效表位置见 SF2 头 0x32(数量) / 0x34(表偏移)，表内每项为 u32 绝对偏移。
每条音效:
    +0  u8   通道数
    +1  u8   位深
    +2  u16  采样率
    +4  u32  PCM 数据长度（文档记作 2 字节，实测为 4 字节）
    +16      PCM 数据

用法:
    python3 sound_unpack.py <输出目录> <sound01.SF2> [更多...]
"""
from __future__ import annotations

import argparse
import struct
import sys
from dataclasses import dataclass
from pathlib import Path

SOUND_COUNT_OFFSET = 0x32
SOUND_TABLE_OFFSET = 0x34
PCM_DATA_OFFSET = 16
VALID_CHANNELS = (1, 2)
VALID_BITS = (8, 16)


@dataclass(frozen=True)
class Sound:
    index: int
    channels: int
    bits: int
    rate: int
    pcm: bytes

    @property
    def seconds(self) -> float:
        byte_rate = self.rate * self.channels * (self.bits // 8)
        return len(self.pcm) / byte_rate if byte_rate else 0.0


def build_wav(sound: Sound) -> bytes:
    """按 RIFF/WAVE 规范封装 PCM。"""
    block_align = sound.channels * (sound.bits // 8)
    byte_rate = sound.rate * block_align
    fmt = struct.pack(
        "<4sIHHIIHH",
        b"fmt ", 16, 1, sound.channels, sound.rate, byte_rate, block_align, sound.bits,
    )
    data = b"data" + struct.pack("<I", len(sound.pcm)) + sound.pcm
    body = b"WAVE" + fmt + data
    return b"RIFF" + struct.pack("<I", len(body)) + body


def read_sounds(data: bytes) -> list[Sound]:
    count = struct.unpack_from("<H", data, SOUND_COUNT_OFFSET)[0]
    table = struct.unpack_from("<I", data, SOUND_TABLE_OFFSET)[0]
    sounds: list[Sound] = []

    for i in range(count):
        ptr = table + i * 4
        if ptr + 4 > len(data):
            break
        base = struct.unpack_from("<I", data, ptr)[0]
        if base + PCM_DATA_OFFSET > len(data):
            continue

        channels, bits = data[base], data[base + 1]
        rate = struct.unpack_from("<H", data, base + 2)[0]
        length = struct.unpack_from("<I", data, base + 4)[0]

        if channels not in VALID_CHANNELS or bits not in VALID_BITS or rate <= 0:
            continue
        start = base + PCM_DATA_OFFSET
        pcm = data[start:start + length]
        if len(pcm) < length:
            continue

        sounds.append(Sound(index=i, channels=channels, bits=bits, rate=rate, pcm=pcm))
    return sounds


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("out_dir")
    parser.add_argument("sources", nargs="+")
    args = parser.parse_args(argv)

    out_dir = Path(args.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    total = 0

    for src in args.sources:
        path = Path(src)
        if not path.is_file():
            continue
        try:
            sounds = read_sounds(path.read_bytes())
        except (struct.error, OSError) as exc:
            print(f"跳过 {path.name}: {exc}", file=sys.stderr)
            continue

        print(f"=== {path.name}: {len(sounds)} 条 ===")
        for s in sounds:
            name = f"{path.stem}_{s.index:02d}.wav"
            (out_dir / name).write_bytes(build_wav(s))
            print(
                f"  {name}  {s.channels}ch {s.bits}bit {s.rate}Hz  "
                f"{s.seconds:.2f}s  {len(s.pcm)} bytes"
            )
            total += 1

    print(f"\n共导出 {total} 个 WAV -> {out_dir}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
