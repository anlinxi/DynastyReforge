#!/usr/bin/env python3
"""把 SF2 中的图片导出为带透明通道的 PNG。

用法:
    python3 sf2_export.py <file.SF2> <输出目录> [--limit 8] [--info]
"""
from __future__ import annotations

import argparse
import struct
import sys
import zlib
from pathlib import Path

import sf2


def write_png_rgba(path: Path, width: int, height: int, rows: list[bytes]) -> None:
    """写出 8 位 RGBA PNG（无滤波）。"""
    raw = b"".join(b"\x00" + row for row in rows)

    def chunk(tag: bytes, payload: bytes) -> bytes:
        body = tag + payload
        return struct.pack(">I", len(payload)) + body + struct.pack(">I", zlib.crc32(body))

    ihdr = struct.pack(">IIBBBBB", width, height, 8, 6, 0, 0, 0)
    path.write_bytes(
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", ihdr)
        + chunk(b"IDAT", zlib.compress(raw, 9))
        + chunk(b"IEND", b"")
    )


def export(src: Path, out_dir: Path, limit: int, show_info: bool) -> int:
    try:
        header, images, tiles = sf2.load(src)
    except (sf2.SF2Error, OSError, struct.error) as exc:
        print(f"解析失败 {src}: {exc}", file=sys.stderr)
        return 0

    if show_info:
        print(
            f"  TILE {header.tile_width}x{header.tile_height} 共{header.tile_count} | "
            f"动画 {header.anim_width}x{header.anim_height} | "
            f"帧{header.frame_count} 图片{header.image_count} 音效{header.sound_count} | "
            f"变体 0x{header.variant:02x}"
        )

    out_dir.mkdir(parents=True, exist_ok=True)
    written = 0

    for image in images[:limit]:
        width, height, pixels = sf2.compose_image(image, tiles, header)
        if width == 0 or height == 0:
            continue

        rows = []
        for y in range(height):
            row = bytearray()
            for x in range(width):
                row.extend(sf2.x1r5g5b5_to_rgba(pixels[y * width + x]))
            rows.append(bytes(row))

        opaque = sum(1 for p in pixels if p != sf2.TRANSPARENT)
        name = f"{src.stem}_img{image.index:03d}_{width}x{height}.png"
        write_png_rgba(out_dir / name, width, height, rows)
        written += 1
        print(
            f"    图片{image.index}: {image.tiles_per_row}x{image.tiles_per_col} tiles "
            f"-> {width}x{height}, 不透明像素 {opaque * 100 // max(len(pixels), 1)}% -> {name}"
        )

    return written


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("sources", nargs="+")
    parser.add_argument("out_dir")
    parser.add_argument("--limit", type=int, default=8)
    parser.add_argument("--info", action="store_true")
    args = parser.parse_args(argv)

    out_dir = Path(args.out_dir)
    total = 0
    for s in args.sources:
        path = Path(s)
        if not path.is_file():
            continue
        print(f"=== {path.name} ===")
        total += export(path, out_dir, args.limit, args.info)

    print(f"\n共导出 {total} 张 PNG 到 {out_dir}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
