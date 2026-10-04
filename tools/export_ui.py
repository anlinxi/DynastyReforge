#!/usr/bin/env python3
"""导出对话框界面 —— Sys.dat 内的 F-* 系列 SF2。

原作对话框的**全套表现都是数据驱动的**，一点都不用自己设计：

    F-TALK    正文框。9 帧是从屏幕外弹出的动画，y 走 470→447→359→364
              （最后一步是过冲回弹），**音效在第 2 帧触发**，落位于 (2,364)
    F-NAME    姓名牌。2 帧分别是左侧版 (16,339) 与右侧版 (472,338)，与立绘同侧
    F-FLOAT   右下角「继续」小标，8 帧上下浮动
    F-YESNO   是/否确认框，落位 (488,299)
    F-FASCIA  短横幅

SF2 的图层坐标是原作画面（640×480）的绝对坐标，直接照搬即可。
F-TALK 头部 sound_count=2，两段开/关提示音内嵌在同一文件里。

产物:
    <out>/<元素>/i00.png …          图片，按图片索引命名
    <out>/<元素>/snd_00.wav …       内嵌音效（仅 F-TALK 有）
    <out>/<元素>/ui.json            {name, anim:{w,h}, images:[...],
                                     frames:[{duration,sound,layers:[{image,x,y}]}]}

用法:
    python3 export_ui.py <Sys.dat> <输出目录>
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import dat_unpack
import sf2
import sf2_anim
import sf2_export
import sound_unpack

ELEMENTS = ("F-TALK.SF2", "F-NAME.SF2", "F-FLOAT.SF2", "F-YESNO.SF2", "F-FASCIA.SF2")
RGBA = 4
NO_SOUND = -1


def _write_image(blob: bytes, header, image, tiles, out_dir: Path) -> dict | None:
    """整张写出，**不裁剪**——图层坐标是按未裁剪的画布给的。"""
    width, height, pixels = sf2.compose_image(image, tiles, header)
    if width == 0 or height == 0:
        return None

    rows = []
    for y in range(height):
        row = bytearray()
        for x in range(width):
            row.extend(sf2.x1r5g5b5_to_rgba(pixels[y * width + x]))
        rows.append(bytes(row))

    filename = f"i{image.index:02d}.png"
    sf2_export.write_png_rgba(out_dir / filename, width, height, rows)
    # ⚠️ **同时记下真正有像素的范围。**
    #
    # 画布是**不裁剪**写出的（图层坐标按未裁剪算），所以右侧/底部常有一条
    # 透明边。拿标称的 `w/h` 去居中就会偏 —— 姓名牌 `F-NAME` 标称 192 宽，
    # 实际只画到 x=152，中心差 20 像素，「西夏士兵」的「兵」正好被右边框压住。
    box = _opaque_box(width, height, pixels)
    return {"index": image.index, "file": filename, "w": width, "h": height,
            **({"box": list(box)} if box else {})}


def _opaque_box(width: int, height: int, pixels) -> tuple[int, int, int, int] | None:
    """有像素的范围 `(left, top, right, bottom)`，右下为**开区间**。"""
    left, top = width, height
    right = bottom = 0
    for y in range(height):
        base = y * width
        for x in range(width):
            if pixels[base + x] == sf2.TRANSPARENT:
                continue
            if x < left:
                left = x
            if x >= right:
                right = x + 1
            if y < top:
                top = y
            if y >= bottom:
                bottom = y + 1
    return (left, top, right, bottom) if right > left else None


def export_one(blob: bytes, name: str, out_dir: Path) -> dict:
    header = sf2.parse_header(blob)
    images = sf2.read_images(blob, header)
    tiles = sf2.read_tiles(blob, header)
    frames = sf2_anim.parse_frames(blob, header)

    out_dir.mkdir(parents=True, exist_ok=True)
    image_meta = [m for im in images
                  if (m := _write_image(blob, header, im, tiles, out_dir))]

    sounds = []
    if header.sound_count:
        try:
            for snd in sound_unpack.read_sounds(blob):
                filename = f"snd_{snd.index:02d}.wav"
                (out_dir / filename).write_bytes(sound_unpack.build_wav(snd))
                sounds.append({"index": snd.index, "file": filename})
        except (ValueError, IndexError) as exc:
            print(f"    音效解析失败（{exc}），跳过", file=sys.stderr)

    frame_meta = [{
        "duration": f.duration,
        "sound": f.sound_index if f.sound_index != NO_SOUND else None,
        "layers": [{"image": l.image_index, "x": l.x, "y": l.y}
                   for l in sorted(f.layers, key=lambda l: l.depth)],
    } for f in frames]

    return {
        "name": name,
        "anim": {"w": header.anim_width, "h": header.anim_height},
        "images": image_meta,
        "sounds": sounds,
        "frames": frame_meta,
    }


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("sys_dat")
    parser.add_argument("out_dir")
    args = parser.parse_args(argv)

    sys_dat = Path(args.sys_dat)
    if not sys_dat.is_file():
        print(f"找不到 {sys_dat}", file=sys.stderr)
        return 1

    out_root = Path(args.out_dir)
    with sys_dat.open("rb") as fh:
        entries = dat_unpack.read_entries(fh, sys_dat.stat().st_size)
        by_name = {e.name.upper(): e for e in entries}

        for element in ELEMENTS:
            entry = by_name.get(element)
            if entry is None:
                print(f"  {element} 不在归档内，跳过", file=sys.stderr)
                continue

            fh.seek(entry.offset)
            key = element.rsplit(".", 1)[0]
            meta = export_one(fh.read(entry.size), key, out_root / key)
            (out_root / key / "ui.json").write_text(
                json.dumps(meta, ensure_ascii=False, separators=(",", ":")),
                encoding="utf-8",
            )
            print(f"  {key:<10} {len(meta['images'])} 图 "
                  f"{len(meta['frames'])} 帧 {len(meta['sounds'])} 音效")

    print(f"导出到 {out_root}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
