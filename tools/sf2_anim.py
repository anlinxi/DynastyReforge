#!/usr/bin/env python3
"""SF2 动画层解析 — 帧时序、打击感参数、图层合成信息。

帧信息块结构（基地址来自帧信息偏移表）:
    +0x00 u32  该帧相对屏幕水平偏移
    +0x04 u32  该帧相对屏幕竖直偏移
    +0x08 u32  帧宽度
    +0x0C u32  帧高度
    +0x20 i16  播放第几个音效（-1 为无）
    +0x22 u16  该帧播放时长（越小越快）
    +0x24 u32  屏幕震动幅度
    +0x28 u32  受击事件：1=按命中选HIT/DEF短动作，2~7=颜色事件；不是HIT帧序
    +0x30 u32  引发的特效文件（effXXX.sf2）编号
    +0x34 u32  屏幕移动方向
    +0x38 u32  屏幕移动时间
    +0x54 u16  本帧包含的图片数 m
    +0x5E      m 个图层记录，每个 29 字节

图层记录（29 字节）:
    +0  u16 图片索引     +2  i16 屏幕 x 偏移   +4  i16 屏幕 y 偏移
    +6  u32 层数（0 最先绘制）
    +10 u8  绘制模式 0=正常 1=16级alpha 2=16级Subtract 4=不透明 5=反色
    +11 u8  透明度/颜色深度（0x10 为上限）
"""
from __future__ import annotations

import struct
from dataclasses import dataclass, asdict
from pathlib import Path

import sf2

LAYER_LIST_OFFSET = 0x5E
LAYER_RECORD_SIZE = 29
LAYER_COUNT_OFFSET = 0x54
ALPHA_MAX = 0x10

BLEND_MODES = {
    0: "normal",
    1: "alpha16",
    2: "subtract16",
    3: "mode3",
    4: "opaque",
    5: "invert",
}


@dataclass(frozen=True)
class Layer:
    image_index: int
    x: int
    y: int
    depth: int
    blend: str
    alpha: int


@dataclass(frozen=True)
class Frame:
    index: int
    x: int
    y: int
    width: int
    height: int
    sound_index: int
    duration: int
    shake: int
    hit_pose: int
    effect_file: int
    screen_move_dir: int
    screen_move_time: int
    # 以下三项 RPG.exe 0x43f520 读取（BTL-29）；导出时只在非零时写出，见 frame_dict。
    screen_follow: int  # +0x3c 1/2/4 镜头跟随本对象移动（z=0/280/280），3/4 移完锁定，5 解除
    screen_zoom: int    # +0x40 1 放大到 z=320，2 还原 z=0，3 立即 z=320
    screen_reset: int   # +0x44 1 取消跟随并回中、还原放大
    layers: tuple[Layer, ...]


def _u16(d: bytes, o: int) -> int:
    return struct.unpack_from("<H", d, o)[0]


def _i16(d: bytes, o: int) -> int:
    return struct.unpack_from("<h", d, o)[0]


def _u32(d: bytes, o: int) -> int:
    return struct.unpack_from("<I", d, o)[0]


def parse_layers(data: bytes, base: int, count: int) -> tuple[Layer, ...]:
    layers = []
    for i in range(count):
        o = base + LAYER_LIST_OFFSET + i * LAYER_RECORD_SIZE
        if o + LAYER_RECORD_SIZE > len(data):
            break
        mode = data[o + 10]
        layers.append(
            Layer(
                image_index=_u16(data, o),
                x=_i16(data, o + 2),
                y=_i16(data, o + 4),
                depth=_u32(data, o + 6),
                blend=BLEND_MODES.get(mode, f"unknown{mode}"),
                alpha=min(data[o + 11], ALPHA_MAX),
            )
        )
    return tuple(layers)


def parse_frames(data: bytes, header: sf2.SF2Header) -> list[Frame]:
    frames: list[Frame] = []
    for i in range(header.frame_count):
        ptr = header.frame_info_offset + i * 4
        if ptr + 4 > len(data):
            break
        base = _u32(data, ptr)
        if base + LAYER_LIST_OFFSET > len(data):
            break

        layer_count = _u16(data, base + LAYER_COUNT_OFFSET)
        frames.append(
            Frame(
                index=i,
                x=_u32(data, base + 0x00),
                y=_u32(data, base + 0x04),
                width=_u32(data, base + 0x08),
                height=_u32(data, base + 0x0C),
                sound_index=_i16(data, base + 0x20),
                duration=_u16(data, base + 0x22),
                shake=_u32(data, base + 0x24),
                hit_pose=_u32(data, base + 0x28),
                effect_file=_u32(data, base + 0x30),
                screen_move_dir=_u32(data, base + 0x34),
                screen_move_time=_u32(data, base + 0x38),
                screen_follow=_u32(data, base + 0x3C),
                screen_zoom=_u32(data, base + 0x40),
                screen_reset=_u32(data, base + 0x44),
                layers=parse_layers(data, base, layer_count),
            )
        )
    return frames


def load_animation(path: Path | str) -> tuple[sf2.SF2Header, list[Frame]]:
    data = sf2.inflate_variant(Path(path).read_bytes())
    header = sf2.parse_header(data)
    return header, parse_frames(data, header)


#: 只在非零时写出的镜头字段（绝大多数帧为零，不让全库 anim.json 平白多出三列）。
SPARSE_CAMERA_FIELDS = ("screen_follow", "screen_zoom", "screen_reset")


def frame_dict(frame: Frame) -> dict:
    doc = asdict(frame)
    for key in SPARSE_CAMERA_FIELDS:
        if not doc[key]:
            del doc[key]
    return doc


def to_dict(header: sf2.SF2Header, frames: list[Frame]) -> dict:
    return {
        "motion": dict(zip(('start_frames', 'loop_frames', 'end_frames', 'travel_steps', 'jump_height', 'mode'), header.motion)),
        "tile": [header.tile_width, header.tile_height],
        "anim_size": [header.anim_width, header.anim_height],
        "counts": {
            "frames": header.frame_count,
            "images": header.image_count,
            "tiles": header.tile_count,
            "sounds": header.sound_count,
        },
        "frames": [frame_dict(f) for f in frames],
    }


def main(argv: list[str]) -> int:
    if not argv:
        print(__doc__)
        return 1

    for p in argv:
        path = Path(p)
        if not path.is_file():
            continue
        header, frames = load_animation(path)
        print(f"=== {path.name} ===")
        print(f"  {header.frame_count} 帧, {header.image_count} 图片, {header.sound_count} 音效")
        for f in frames[:6]:
            layer_desc = ", ".join(
                f"img{l.image_index}@({l.x},{l.y})z{l.depth}/{l.blend}" for l in f.layers[:3]
            )
            print(
                f"  帧{f.index:>2}: 时长={f.duration:<4} 震屏={f.shake:<4} 音效={f.sound_index:<3} "
                f"受击={f.hit_pose} 特效={f.effect_file} | {layer_desc}"
            )
        print()
    return 0


if __name__ == "__main__":
    raise SystemExit(main(__import__("sys").argv[1:]))
