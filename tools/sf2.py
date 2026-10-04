#!/usr/bin/env python3
"""SF2 图像格式解析（幽城幻剑录 / 汉堂国际）。

格式依据社区流传的《sf2粗略分析》文档，并在本项目样本上验证。

文件头:
    0x00  7B   ID 标识
    0x07  u16  TILE 宽度
    0x09  u16  TILE 高度
    0x0B  u8   0=幽城/lob 格式, 0x6f=寰神/tf2 格式
    0x0C  u32  动画宽度
    0x10  u32  动画高度
    0x14  u16  帧数        0x16 u32 帧信息偏移   0x1A u32 块大小
    0x1E  u16  图片数      0x20 u32 图片信息偏移 0x24 u32 块大小
    0x28  u16  TILE 数     0x2A u32 TILE 信息偏移 0x2E u32 块大小
    0x32  u16  音效数      0x34 u32 音效信息偏移 0x38 u32 块大小

层级: 帧(frame) → 若干图片(image) 叠加；图片 → 若干 TILE 拼接；TILE → RLE 像素。

TILE 像素 RLE（像素为小端 uint16，X1R5G5B5）:
    0x40..0x7F  透明像素 (v - 0x40 + 1) 个
    0x80..0xBF  其后 (v - 0x80 + 1) 个互不重复的像素
    0xC0..0xFF  其后 1 个像素，重复 (v - 0xC0 + 1) 次
"""
from __future__ import annotations

import struct
import zlib
from dataclasses import dataclass
from pathlib import Path

MAGIC = b"SF2"
TRANSPARENT = -1  # 像素序列中的透明标记

RLE_TRANSPARENT = 0x40
RLE_LITERAL = 0x80
RLE_RUN = 0xC0

IMAGE_INFO_TILE_INDEX_OFFSET = 24
IMAGE_INFO_STRIDE = 2

VARIANT_PLAIN = 0x00
VARIANT_DEFLATED = 0x6F
VARIANT_OFFSET = 0x0B
#: 0x6f 变体里，未压缩头部长度存在 0x05 的 u16。
DEFLATED_HEAD_LEN_OFFSET = 0x05
#: 头部之后是 u32 解压后长度，再跳 u32 + u16 才是 raw deflate 数据。
DEFLATED_SKIP_AFTER_LENGTH = 6
#: 负 window bits = 无 zlib 包裹的 raw deflate，对应 C# 的 DeflateStream。
RAW_DEFLATE_WBITS = -15


class SF2Error(ValueError):
    """SF2 解析失败。"""


@dataclass(frozen=True)
class SF2Header:
    tile_width: int
    tile_height: int
    variant: int
    anim_width: int
    anim_height: int
    frame_count: int
    frame_info_offset: int
    image_count: int
    image_info_offset: int
    tile_count: int
    tile_info_offset: int
    sound_count: int
    sound_info_offset: int
    # RPG.exe 0x43efe0/0x43e840：起步、途中循环、收步、移动步数、跳高、模式。
    motion: tuple[int, ...] = (0, 0, 0, 0, 0, 0)


@dataclass(frozen=True)
class Image:
    index: int
    tiles_per_row: int
    tiles_per_col: int
    real_width: int
    real_height: int
    tile_indices: tuple[int, ...]
    borrowed_hit_frame: int = 0

    @property
    def width(self) -> int:
        return self.tiles_per_row

    @property
    def height(self) -> int:
        return self.tiles_per_col


def _u16(d: bytes, o: int) -> int:
    return struct.unpack_from("<H", d, o)[0]


def _u32(d: bytes, o: int) -> int:
    return struct.unpack_from("<I", d, o)[0]


def inflate_variant(data: bytes) -> bytes:
    """把 0x6f 变体还原成 0x00 变体的等价字节流。

    0x6f 不是「另一种图片信息块布局」——它就是 0x00 格式被 raw deflate
    压过一遍：文件开头保留一段未压缩头部，其后是压缩体。解压拼回去、
    再把 0x0B 的变体标记改写成 0，就能交给完全相同的解析流程。

    依据 ``~/Game/yc/_x/SF2View/Form1.cs`` 的 ``LoadSF2``（第 249 行起）。
    非 0x6f 的输入原样返回。
    """
    if len(data) <= VARIANT_OFFSET or data[VARIANT_OFFSET] != VARIANT_DEFLATED:
        return data

    head_len = _u16(data, DEFLATED_HEAD_LEN_OFFSET)
    if head_len > len(data):
        raise SF2Error(f"0x6f 头部长度 {head_len} 超出文件大小 {len(data)}")

    body_start = head_len + 4 + DEFLATED_SKIP_AFTER_LENGTH
    if body_start > len(data):
        raise SF2Error(f"0x6f 压缩体起点 {body_start} 超出文件大小 {len(data)}")

    # 这个 u32 是还原后文件的总长（头部 + 解压体），不是压缩体自身的长度。
    expected_total = _u32(data, head_len)
    try:
        body = zlib.decompressobj(RAW_DEFLATE_WBITS).decompress(data[body_start:])
    except zlib.error as exc:
        raise SF2Error(f"0x6f 解压失败: {exc}") from exc
    if head_len + len(body) != expected_total:
        raise SF2Error(
            f"0x6f 还原后长度 {head_len + len(body)} 与声明的 {expected_total} 不符"
        )

    restored = bytearray(data[:head_len] + body)
    restored[VARIANT_OFFSET] = VARIANT_PLAIN
    return bytes(restored)


def parse_header(data: bytes) -> SF2Header:
    if not data.startswith(MAGIC):
        raise SF2Error(f"magic 不匹配: {data[:4]!r}")
    return SF2Header(
        tile_width=_u16(data, 0x07),
        tile_height=_u16(data, 0x09),
        variant=data[0x0B],
        anim_width=_u32(data, 0x0C),
        anim_height=_u32(data, 0x10),
        frame_count=_u16(data, 0x14),
        frame_info_offset=_u32(data, 0x16),
        image_count=_u16(data, 0x1E),
        image_info_offset=_u32(data, 0x20),
        tile_count=_u16(data, 0x28),
        tile_info_offset=_u32(data, 0x2A),
        sound_count=_u16(data, 0x32),
        sound_info_offset=_u32(data, 0x34),
        motion=struct.unpack_from('<6h', data, 0x3C) if len(data) >= 0x48 else (0,) * 6,
    )


def decode_tile(data: bytes, start: int, pixel_total: int) -> list[int]:
    """解码一个 TILE 的 RLE 像素流，返回长度为 pixel_total 的像素列表。

    透明像素以 TRANSPARENT 表示。数据不足时用透明补齐。
    """
    pixels: list[int] = []
    i = start
    n = len(data)

    while len(pixels) < pixel_total and i < n:
        ctrl = data[i]
        i += 1

        if RLE_TRANSPARENT <= ctrl < RLE_LITERAL:
            pixels.extend([TRANSPARENT] * (ctrl - RLE_TRANSPARENT + 1))
        elif RLE_LITERAL <= ctrl < RLE_RUN:
            count = ctrl - RLE_LITERAL + 1
            if i + count * 2 > n:
                break
            pixels.extend(struct.unpack_from(f"<{count}H", data, i))
            i += count * 2
        elif ctrl >= RLE_RUN:
            count = ctrl - RLE_RUN + 1
            if i + 2 > n:
                break
            pixels.extend([_u16(data, i)] * count)
            i += 2
        else:
            # < 0x40 未在文档中定义，遇到即停止，避免污染输出
            break

    if len(pixels) < pixel_total:
        pixels.extend([TRANSPARENT] * (pixel_total - len(pixels)))
    return pixels[:pixel_total]


def read_tiles(data: bytes, header: SF2Header) -> list[list[int]]:
    """解码全部 TILE。"""
    pixel_total = header.tile_width * header.tile_height
    tiles = []
    for i in range(header.tile_count):
        ptr = header.tile_info_offset + i * 4
        if ptr + 4 > len(data):
            break
        tiles.append(decode_tile(data, _u32(data, ptr), pixel_total))
    return tiles


def read_images(data: bytes, header: SF2Header) -> list[Image]:
    """读取图片信息（tile 网格布局 + tile 索引表）。"""
    images = []
    for i in range(header.image_count):
        ptr = header.image_info_offset + i * 4
        if ptr + 4 > len(data):
            break
        base = _u32(data, ptr)
        if base + IMAGE_INFO_TILE_INDEX_OFFSET > len(data):
            break

        per_row, per_col = _u16(data, base), _u16(data, base + 2)
        count = per_row * per_col
        idx_start = base + IMAGE_INFO_TILE_INDEX_OFFSET
        if count <= 0 or idx_start + count * IMAGE_INFO_STRIDE > len(data):
            continue

        images.append(
            Image(
                index=i,
                tiles_per_row=per_row,
                tiles_per_col=per_col,
                real_width=_u32(data, base + 4),
                real_height=_u32(data, base + 8),
                borrowed_hit_frame=_u32(data, base + 12),
                tile_indices=struct.unpack_from(f"<{count}H", data, idx_start),
            )
        )
    return images


def compose_image(image: Image, tiles: list[list[int]], header: SF2Header) -> tuple[int, int, list[int]]:
    """把 TILE 按网格拼成完整图片，返回 (宽, 高, 像素)。

    返回的是 **tile 网格尺寸**（向上取整到整块），右下会多出一条空白。
    真实尺寸另记在 `image.real_width/real_height` 里，要用的调用方自己裁
    （见 `walk_regions.load_layer`）。

    ⚠️ 这里不裁是**刻意的**：本函数是九个导出工具的共同出口，战斗动画、
    立绘、对话框的落点都是按现有尺寸校准的（见 docs/专题/战斗.md）。
    在此裁剪会让全部素材尺寸变化，特效可能整体脱靶。要不要统一在这里裁，
    见 docs/状态/待办.md。
    """
    tw, th = header.tile_width, header.tile_height
    width, height = image.tiles_per_row * tw, image.tiles_per_col * th
    canvas = [TRANSPARENT] * (width * height)

    for cell, tile_idx in enumerate(image.tile_indices):
        if tile_idx >= len(tiles):
            continue
        tile = tiles[tile_idx]
        gx, gy = (cell % image.tiles_per_row) * tw, (cell // image.tiles_per_row) * th
        for row in range(th):
            dst = (gy + row) * width + gx
            canvas[dst:dst + tw] = tile[row * tw:(row + 1) * tw]

    return width, height, canvas


def crop_to_real(image: Image, width: int, height: int, pixels: list[int]):
    """把 `compose_image` 的 tile 网格结果裁到 `real_*` 记的真实尺寸。

    tile 网格向上取整到整块，右下多出的那条是空白（透明）。掩码类的调用方
    必须裁：不裁的话那条空白按"透明=可走"被判成可走，地图边缘会多出一条
    没有数据却能走进去的带子。

    依据：MP3001 的地面美术高 1800，**不是 tile 高 48 的整数倍**，而它的 MB
    `real_height` 恰好也是 1800——只有采信 `real_*` 才能和地面精确对上。

    `real_*` 为 0 或大于网格时当作没记，原样返回。
    """
    w = width if not 0 < image.real_width <= width else image.real_width
    h = height if not 0 < image.real_height <= height else image.real_height
    if (w, h) == (width, height):
        return width, height, pixels
    return w, h, [v for y in range(h) for v in pixels[y * width:y * width + w]]


def x1r5g5b5_to_rgba(value: int) -> tuple[int, int, int, int]:
    """X1R5G5B5 -> RGBA8888；TRANSPARENT 转全透明。"""
    if value == TRANSPARENT:
        return (0, 0, 0, 0)
    r, g, b = (value >> 10) & 0x1F, (value >> 5) & 0x1F, value & 0x1F
    expand = lambda c: (c << 3) | (c >> 2)
    return expand(r), expand(g), expand(b), 255


def load(path: Path | str) -> tuple[SF2Header, list[Image], list[list[int]]]:
    """解析 SF2，返回 (头部, 图片列表, TILE 像素表)。"""
    data = inflate_variant(Path(path).read_bytes())
    header = parse_header(data)
    return header, read_images(data, header), read_tiles(data, header)
