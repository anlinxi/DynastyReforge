#!/usr/bin/env python3
"""将官方/简体Font24导出为BMFont，保留原Big5码位与原生符号。

原程序索引及对白三次绘字依据见docs/专题/简繁体.md。
默认同时生成白字通用图集与原作双色对白图集，不依赖系统字体。
python tools/export_font.py <font24.fnt> <out_dir> [--name yc24]
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path
from typing import Iterator, NamedTuple

try:
    from PIL import Image
    from sf2 import x1r5g5b5_to_rgba
except ImportError:  # pragma: no cover - 只在缺依赖时走到
    print("需要 Pillow: pip3 install Pillow", file=sys.stderr)
    raise

#: 每字 24×24 单色点阵 = 每行 3 字节 × 24 行
GLYPH_SIZE = 24
GLYPH_BYTES = 72

#: 单字节区占前 256 块，汉字区紧随其后
HANZI_BASE = 256
#: Big5 每区 157 字：低位 0x40–0x7E（63 个）+ 0xA1–0xFE（94 个）
BIG5_ZONE = 157
#: 符号与汉字分别寻址；C9起跳过汉字区的408个未收录块。
BIG5_HI_RANGE = range(0xA1, 0xFA)
SYMBOL_BASE = 13350
BIG5_LO_RANGE = tuple(range(0x40, 0x7F)) + tuple(range(0xA1, 0xFF))

#: 单字节区里只导可见 ASCII。127–255 全是「?」占位符，不导
ASCII_RANGE = range(0x20, 0x7F)



class Glyph(NamedTuple):
    """一个字符及它的 24 行点阵。

    `rows` 每个元素的低24位是该行的原作点阵，不替换或转换文字码位。
    """

    char: str
    advance: int
    rows: tuple[int, ...]


def glyph_index(char: str) -> int:
    """原函数433950/402ee0：ASCII、A1–A3符号、非连续汉字区。"""
    encoded = char.encode("big5")
    if len(encoded) == 1:
        return encoded[0]
    high, low = encoded
    offset = low - 0x40 if low <= 0x7E else low - 0x62
    if high < 0xA4:
        return SYMBOL_BASE + (high - 0xA1) * BIG5_ZONE + offset
    return HANZI_BASE + (high - 0xA4) * BIG5_ZONE + offset - (408 if high >= 0xC9 else 0)


def read_rows(data: bytes, index: int) -> tuple[int, ...]:
    """取一个块，返回 24 个整数，每个的低 24 位是该行的点阵。"""
    start = index * GLYPH_BYTES
    block = data[start:start + GLYPH_BYTES]
    return tuple(
        (block[r * 3] << 16) | (block[r * 3 + 1] << 8) | block[r * 3 + 2]
        for r in range(GLYPH_SIZE)
    )


def iter_glyphs(data: bytes, block_count: int,
                ascii_advance: int) -> Iterator[Glyph]:
    """枚举字库里所有能对上 Unicode 字符的块。

    Big5 有空洞，解不出字符的码位直接跳过——那些位置的字模即便有内容，
    也没有对应的字符可以拿来查表。
    """
    for code in ASCII_RANGE:
        if code < block_count:
            yield Glyph(chr(code), ascii_advance, read_rows(data, code))

    seen = set(map(chr, ASCII_RANGE))
    for high in BIG5_HI_RANGE:
        for low in BIG5_LO_RANGE:
            try:
                char = bytes((high, low)).decode("big5")
            except UnicodeDecodeError:
                continue
            if char in seen:
                continue
            seen.add(char)
            index = glyph_index(char)
            if 0 <= index < block_count:
                yield Glyph(char, GLYPH_SIZE, read_rows(data, index))


def build_atlas(glyphs: tuple[Glyph, ...], columns: int) -> Image.Image:
    """把所有字模画进一张白字透明底的图集。

    直接拼 RGBA 字节再 frombytes，比逐像素 putpixel 快一个数量级；
    只有墨点才写入，空白处保持全 0（透明）。
    """
    rows = (len(glyphs) + columns - 1) // columns
    width = columns * GLYPH_SIZE
    height = rows * GLYPH_SIZE
    buffer = bytearray(width * height * 4)

    for slot, glyph in enumerate(glyphs):
        origin_x = (slot % columns) * GLYPH_SIZE
        origin_y = (slot // columns) * GLYPH_SIZE
        for row_index, bits in enumerate(glyph.rows):
            if not bits:
                continue
            y = origin_y + row_index
            for col in range(GLYPH_SIZE):
                if bits & (0x800000 >> col):
                    offset = (y * width + origin_x + col) * 4
                    buffer[offset:offset + 4] = b"\xff\xff\xff\xff"

    return Image.frombytes("RGBA", (width, height), bytes(buffer))


def build_dialogue_atlas(glyphs: tuple[Glyph, ...], columns: int,
                         center: int = 0x2060, edge: int = 0x562c) -> Image.Image:
    """402ee0(mode5)：先浅色(-1,0)/(1,0)，再深色(0,0)，左右各留1px。"""
    rows = (len(glyphs) + columns - 1) // columns
    image = Image.new('RGBA', (columns * 26, rows * 24))
    for slot, glyph in enumerate(glyphs):
        mask = Image.frombytes('L', (24, 24), bytes(
            255 if row & (0x800000 >> x) else 0 for row in glyph.rows for x in range(24)))
        x, y = (slot % columns) * 26, (slot // columns) * 24
        for dx, color in [(0, edge), (2, edge), (1, center)]:
            ink = Image.new('RGBA', (24, 24), x1r5g5b5_to_rgba(color))
            ink.putalpha(mask)
            image.alpha_composite(ink, (x + dx, y))
    return image


def build_bmfont_xml(glyphs: tuple[Glyph, ...], columns: int,
                     size: tuple[int, int], name: str, dialogue: bool = False) -> str:
    """BMFont 的 XML 变体，Phaser 的 load.bitmapFont 直接吃这个格式。"""
    width, height = size
    lines = [
        '<?xml version="1.0" encoding="utf-8"?>',
        "<font>",
        f'  <info face="{name}" size="{GLYPH_SIZE}" bold="0" italic="0" '
        f'charset="" unicode="1" stretchH="100" smooth="0" aa="1" '
        f'padding="0,0,0,0" spacing="0,0"/>',
        f'  <common lineHeight="{GLYPH_SIZE}" base="{GLYPH_SIZE}" '
        f'scaleW="{width}" scaleH="{height}" pages="1" packed="0"/>',
        "  <pages>",
        f'    <page id="0" file="{name}.png"/>',
        "  </pages>",
        f'  <chars count="{len(glyphs)}">',
    ]
    cell_width = 26 if dialogue else GLYPH_SIZE
    for slot, glyph in enumerate(glyphs):
        x = (slot % columns) * cell_width
        y = (slot // columns) * GLYPH_SIZE
        lines.append(
            f'    <char id="{ord(glyph.char)}" x="{x}" y="{y}" '
            f'width="{cell_width}" height="{GLYPH_SIZE}" '
            f'xoffset="{-1 if dialogue else 0}" yoffset="0" xadvance="{glyph.advance}" '
            f'page="0" chnl="15"/>'
        )
    lines += ["  </chars>", "</font>", ""]
    return "\n".join(lines)


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("font", help="原始字库：官方multimedia/Font/font24.fnt或简体chs/Font24.fnt")
    parser.add_argument("out_dir", help="输出目录，通常是 game/public/assets/font")
    parser.add_argument("--name", default="yc24", help="字体名，默认 yc24")
    parser.add_argument("--columns", type=int, default=128,
                        help="图集每行放多少字，默认 128")
    parser.add_argument("--ascii-advance", type=int, default=GLYPH_SIZE // 2,
                        help="单字节字符的步进，默认 12（半角）")
    args = parser.parse_args(argv)

    font_path = Path(args.font)
    if not font_path.is_file():
        print(f"找不到字库: {font_path}", file=sys.stderr)
        return 1
    if args.columns <= 0:
        print("--columns 必须为正", file=sys.stderr)
        return 1

    data = font_path.read_bytes()
    if len(data) % GLYPH_BYTES:
        print(f"⚠ 字库大小 {len(data)} 不是 {GLYPH_BYTES} 的整数倍，"
              f"格式可能不符", file=sys.stderr)
    block_count = len(data) // GLYPH_BYTES

    glyphs = tuple(iter_glyphs(data, block_count, args.ascii_advance))
    if not glyphs:
        print("没有解出任何字符，索引公式可能不适用于这份字库", file=sys.stderr)
        return 1

    blank = sum(1 for g in glyphs if not any(g.rows))
    out_dir = Path(args.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)

    atlas = build_atlas(glyphs, args.columns)
    png_path = out_dir / f"{args.name}.png"
    atlas.save(png_path, optimize=True)

    xml_path = out_dir / f"{args.name}.xml"
    xml_path.write_text(
        build_bmfont_xml(glyphs, args.columns, atlas.size, args.name),
        encoding="utf-8",
    )

    print(f"字库 {block_count} 块 -> 导出 {len(glyphs)} 字"
          f"（空白字模 {blank} 个）")
    # 433950 mode9菜单调色板46b280；402ee0的对白=r使用不同浅红边。
    for suffix, center, edge in [('dialogue', 0x2060, 0x562c),
                                  ('red', 0x7c00, 0x7a2e),
                                  ('blue', 0x0d31, 0x4232),
                                  ('emphasis-red', 0x7c00, 0x7d84)]:
        image = build_dialogue_atlas(glyphs, args.columns, center, edge)
        name = f"{args.name}-{suffix}"
        image.save(out_dir / f"{name}.png", optimize=True)
        (out_dir / f"{name}.xml").write_text(build_bmfont_xml(
            glyphs, args.columns, image.size, name, dialogue=True), encoding="utf-8")
    print(f"  {png_path.name}  {atlas.size[0]}×{atlas.size[1]}  "
          f"{png_path.stat().st_size / 1024:.0f} KB")
    print(f"  {xml_path.name}  {xml_path.stat().st_size / 1024:.0f} KB")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
