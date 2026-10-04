#!/usr/bin/env python3
"""导出对白立绘 —— Sys.dat 内的 `<人物代码>-2.SF2`。

原作对话时在画面一侧显示人物立绘（头/胸像特写），
素材与人物属性菜单里的半身像 `MEN0002.SF2` **不是同一套**。

每个文件固定 32 帧 = 16 种表情 × 2 朝向：
    帧 0-15   画布 x=0，人在左侧、面朝右
    帧 16-31  画布 x≈340-450，人在右侧、面朝左（同表情的镜像版）
对白指令的左右侧标志即在 `表情` 与 `表情+16` 之间选，见 map_script.Dialogue。

SF2 的图层坐标是**原作画面的绝对坐标**，所以每帧连同 x/y 一起导出，
渲染层照搬即可，不必自己猜立绘摆在哪一侧、贴多高。

产物:
    <out>/<代码>/p00.png … p31.png
    <out>/<代码>/portrait.json   {code, name, frames:[{file,x,y,w,h}|null]}

帧可能为空（该角色表情数不足 16 种），JSON 里对应 null，渲染层需容错。

⚠️ 相当一部分角色的立绘文件是 **20220 字节的空壳**（图片表与 TILE 表都是 0），
   例如西夏士兵(64)、西夏軍隊長(72)、神秘客(77)。这不是解析失败——
   **原作里这些配角说话时就是不显示立绘的**，对话框走满宽布局。
   本工具对空壳直接跳过、不产出目录，渲染层查不到就按无立绘处理。

用法:
    python3 export_portrait.py <Sys.dat> <输出目录> --codes 1,2,64,72,77
    python3 export_portrait.py <Sys.dat> <输出目录> --all
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import dat_unpack
import namelist
import sf2
import sf2_anim
import sf2_export

PORTRAIT_SUFFIX = "-2.SF2"
RGBA = 4


def portrait_codes(entries) -> list[int]:
    """归档里所有形如 `<数字>-2.SF2` 的条目对应的人物代码。"""
    out = []
    for entry in entries:
        name = entry.name.upper()
        if not name.endswith(PORTRAIT_SUFFIX):
            continue
        stem = name[: -len(PORTRAIT_SUFFIX)]
        if stem.isdigit():
            out.append(int(stem))
    return sorted(out)


def _rgba_rows(header, image, tiles) -> tuple[int, int, list[bytes]] | None:
    """单张图片解码成 RGBA 行。"""
    width, height, pixels = sf2.compose_image(image, tiles, header)
    if width == 0 or height == 0:
        return None
    rows = []
    for y in range(height):
        row = bytearray()
        for x in range(width):
            row.extend(sf2.x1r5g5b5_to_rgba(pixels[y * width + x]))
        rows.append(bytes(row))
    return width, height, rows


def _trim(width: int, height: int, rows: list[bytes]) -> tuple[int, int, int, int] | None:
    """非透明像素的外接框 (left, top, right, bottom)。

    逐行抽出 alpha 通道后用 lstrip/rstrip 定位，避免逐像素的 Python 循环。
    """
    left, top, right, bottom = width, height, 0, 0
    for y, row in enumerate(rows):
        alpha = bytes(row[3::RGBA])
        stripped = alpha.strip(b"\x00")
        if not stripped:
            continue
        row_left = len(alpha) - len(alpha.lstrip(b"\x00"))
        row_right = len(alpha.rstrip(b"\x00"))
        left, right = min(left, row_left), max(right, row_right)
        top, bottom = min(top, y), max(bottom, y + 1)
    return None if right <= left else (left, top, right, bottom)


def _frame_bounds(frame, sizes: dict[int, tuple[int, int]]):
    """一帧全部图层在绝对坐标系里的并集框。"""
    boxes = [
        (layer.x, layer.y, layer.x + sizes[layer.image_index][0],
         layer.y + sizes[layer.image_index][1])
        for layer in frame.layers if layer.image_index in sizes
    ]
    if not boxes:
        return None
    return (min(b[0] for b in boxes), min(b[1] for b in boxes),
            max(b[2] for b in boxes), max(b[3] for b in boxes))


def export_one(blob: bytes, code: int, name: str, out_dir: Path) -> dict | None:
    """一个角色的全部帧。整帧合成多图层——只取首层会只剩影子。

    图片表为空即空壳文件，返回 None 表示该角色在原作里就没有立绘。
    """
    header = sf2.parse_header(blob)
    images = sf2.read_images(blob, header)
    if not images:
        return None

    tiles = sf2.read_tiles(blob, header)
    frames = sf2_anim.parse_frames(blob, header)

    decoded: dict[int, tuple[int, int, list[bytes]]] = {}
    for image in images:
        got = _rgba_rows(header, image, tiles)
        if got:
            decoded[image.index] = got
    sizes = {i: (v[0], v[1]) for i, v in decoded.items()}

    out_dir.mkdir(parents=True, exist_ok=True)
    meta_frames: list[dict | None] = []

    for frame in frames:
        bounds = _frame_bounds(frame, sizes) if frame.layers else None
        if bounds is None:
            meta_frames.append(None)
            continue

        ox, oy, ex, ey = bounds
        width, height = ex - ox, ey - oy
        canvas = [bytearray(width * RGBA) for _ in range(height)]

        for layer in sorted(frame.layers, key=lambda l: l.depth):
            got = decoded.get(layer.image_index)
            if not got:
                continue
            lw, lh, rows = got
            for y in range(lh):
                target = canvas[layer.y - oy + y]
                src = rows[y]
                base = (layer.x - ox) * RGBA
                for x in range(lw):
                    if src[x * RGBA + 3]:
                        pos = base + x * RGBA
                        target[pos:pos + RGBA] = src[x * RGBA:(x + 1) * RGBA]

        packed = [bytes(row) for row in canvas]
        box = _trim(width, height, packed)
        if box is None:
            meta_frames.append(None)
            continue

        left, top, right, bottom = box
        cropped = [row[left * RGBA:right * RGBA] for row in packed[top:bottom]]
        filename = f"p{frame.index:02d}.png"
        sf2_export.write_png_rgba(out_dir / filename, right - left, bottom - top, cropped)
        meta_frames.append({
            "file": filename,
            "x": ox + left,
            "y": oy + top,
            "w": right - left,
            "h": bottom - top,
        })

    return {"code": code, "name": name, "frames": meta_frames}


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("sys_dat")
    parser.add_argument("out_dir")
    parser.add_argument("--codes", help="逗号分隔的人物代码")
    parser.add_argument("--all", action="store_true", help="导出归档内全部立绘")
    args = parser.parse_args(argv)

    sys_dat = Path(args.sys_dat)
    if not sys_dat.is_file():
        print(f"找不到 {sys_dat}", file=sys.stderr)
        return 1
    if not args.all and not args.codes:
        print("需要 --codes 或 --all", file=sys.stderr)
        return 1

    names = namelist.load(sys_dat)
    out_root = Path(args.out_dir)
    exported = 0

    with sys_dat.open("rb") as fh:
        entries = dat_unpack.read_entries(fh, sys_dat.stat().st_size)
        wanted = (portrait_codes(entries) if args.all
                  else [int(c) for c in args.codes.split(",") if c.strip()])
        by_name = {e.name.upper(): e for e in entries}

        #: 真有立绘的代码 -> 人名。写成 `index.json` 给前端按需加载用。
        #: ⚠️ **必须由工具产出，不能让前端去试。** 55 个代码里有一批是
        #: 20220 字节的空壳（原作对话就不显示立绘），前端若靠「试着加载、
        #: 404 就算没有」，控制台会被一片红色的 404 淹掉，真正的缺图反而看不见。
        #: 这也是判据表「写清单类常量要拿数据反查」的同一条。
        index: dict[str, str] = {}

        for code in wanted:
            entry = by_name.get(f"{code}{PORTRAIT_SUFFIX}")
            if entry is None:
                print(f"  代码 {code} 无立绘（{code}{PORTRAIT_SUFFIX} 不在归档内），跳过")
                continue

            fh.seek(entry.offset)
            name = names.get(code, "")
            meta = export_one(fh.read(entry.size), code, name, out_root / str(code))
            if meta is None:
                print(f"  代码 {code:>3} {name:<10} 空壳文件，原作对话不显示立绘")
                continue
            index[str(code)] = name

            (out_root / str(code) / "portrait.json").write_text(
                json.dumps(meta, ensure_ascii=False, separators=(",", ":")),
                encoding="utf-8",
            )
            filled = sum(1 for f in meta["frames"] if f)
            print(f"  代码 {code:>3} {name:<10} {filled}/{len(meta['frames'])} 帧")
            exported += 1

    # ⚠️ **只在全量导出时重写索引。** `--codes` 是挑几个导，拿它的结果
    # 覆盖索引会把别的角色抹掉 —— 「一份数据只在给了某个开关时才写」那条坑的反面。
    if args.all:
        (out_root / "index.json").write_text(
            json.dumps(index, ensure_ascii=False, indent=1, sort_keys=True),
            encoding="utf-8",
        )
        print(f"索引 -> {out_root / 'index.json'}（{len(index)} 个角色真有立绘）")
    elif not (out_root / "index.json").exists():
        print("⚠ 没有 index.json，前端按需加载会拿不到清单 —— 跑一次 --all")

    print(f"导出 {exported} 个角色到 {out_root}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
