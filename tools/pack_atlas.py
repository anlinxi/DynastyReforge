#!/usr/bin/env python3
"""把一个精灵目录里的逐层 PNG 打成 **Phaser multiatlas**。

## 为什么要打包

分层出图之后，一个精灵目录动辄上百张 PNG（`EVENT2-3-2` 有 296 张），
150 个目录合计 **5807 张**。实测九张地图启动要 **8528 个 HTTP 请求**、
建 4117 个纹理 —— 而那才占全部 309 张地图的 3%。见 `docs/归档/全流程可行性.md`。

打包后一个精灵 = **1 个 JSON + N 张图集 PNG**（N 通常是 1），
请求数降 2×~52×，纹理对象同比例降。

## 为什么用 multiatlas 而不是普通 atlas

普通 `load.atlas` 一个 key 只对一张 PNG。而 `EVENT2-4` 的图总面积估算下来
边长约 3990px —— 离 4096 只差 100px，**不能假定一张装得下**。
`load.multiatlas` 允许一个 JSON 引用多张 PNG，Phaser 自己管，
帧名在整个 key 内唯一，前端取帧的写法不变。

产物:
    <out>/<KEY>.json      multiatlas 清单
    <out>/<KEY>-0.png ...  图集页，通常只有一张

用法:
    python3 pack_atlas.py <精灵目录> [-o 输出目录] [--max-side 2048]
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from PIL import Image

#: 图集页的边长上限。
#:
#: ⚠️ **取 2048 不是 4096。** 桌面 GPU 普遍支持 4096（甚至 8192），但移动端
#: 与老显卡的 `MAX_TEXTURE_SIZE` 常常只有 2048 —— 超了 WebGL 会**静默失败**
#: （贴图变黑或整张不画），而不是报错。宁可多出一两页，也不要赌。
DEFAULT_MAX_SIDE = 2048

#: 每张图周围留的空白。相邻帧采样时会因线性插值吃到隔壁一行像素（"渗色"）。
#: 我们全程 `setOrigin(0,0)` 且不缩放，理论上不会渗，但留 1px 是标准做法，
#: 代价可以忽略。
PADDING = 1


class OversizeImage(Exception):
    """单张图就超过图集上限 —— 这条精灵不打图集，退回逐层 PNG。"""


def shelf_pack(sizes: list[tuple[int, int]], max_side: int) -> tuple[list[dict], list[tuple[int, int]]]:
    """**货架装箱**：按高度降序排，一行行往里填，填不下就换行；换不下就开新页。

    不用 MaxRects 那类算法是因为**不值得** —— 这些图尺寸相近（多数是同一个
    SF2 里同一套 tile 网格切出来的），货架法的浪费本来就小，而且结果稳定、
    可复现，出问题时容易看懂。

    @return (每张图的落位 [{page,x,y}], 每页的尺寸 [(w,h)])
    """
    order = sorted(range(len(sizes)), key=lambda i: (-sizes[i][1], -sizes[i][0]))
    placed: list[dict | None] = [None] * len(sizes)
    pages: list[tuple[int, int]] = []

    page = 0
    x = y = shelf_h = 0
    page_w = page_h = 0

    def close_page():
        nonlocal page_w, page_h
        if page >= len(pages):
            pages.append((page_w, page_h))
        else:
            pages[page] = (page_w, page_h)

    for i in order:
        w, h = sizes[i]
        pw, ph = w + PADDING, h + PADDING
        if pw > max_side or ph > max_side:
            # **单张就超上限** —— 整条精灵退回逐层 PNG，不打图集。
            # ⚠️ 这真的会发生：`mp0602` 里有一张 **2495×182** 的长条素材。
            # 不能靠"把上限提到 4096"绕过 —— 移动端与老显卡的
            # `MAX_TEXTURE_SIZE` 常常只有 2048，超了 WebGL **静默失败**。
            # 前端三代产物都认（见 `FieldSprite` / `loader.queueSprite`），
            # 所以退回逐层是安全的，只是那一条精灵多几个请求。
            raise OversizeImage(f"单张图 {w}×{h} 超过图集上限 {max_side}")
        if x + pw > max_side:                 # 换货架
            x = 0
            y += shelf_h
            shelf_h = 0
        if y + ph > max_side:                 # 换页
            close_page()
            page += 1
            x = y = shelf_h = 0
            page_w = page_h = 0
        placed[i] = {"page": page, "x": x, "y": y}
        x += pw
        shelf_h = max(shelf_h, ph)
        page_w = max(page_w, x)
        page_h = max(page_h, y + shelf_h)
    close_page()
    return placed, pages


def pack(src_dir: Path, out_dir: Path, key: str | None = None,
         max_side: int = DEFAULT_MAX_SIDE) -> dict | None:
    """打包一个精灵目录。返回 `{key, pages, frames}`，没有图则返回 None。"""
    key = key or src_dir.name
    files = sorted(src_dir.glob("img_*.png"))
    if not files:
        return None

    images = [Image.open(f).convert("RGBA") for f in files]
    sizes = [im.size for im in images]
    try:
        placed, pages = shelf_pack(sizes, max_side)
    except OversizeImage as exc:
        print(f"  {key}: {exc} → 不打图集，保留逐层 PNG", file=sys.stderr)
        for im in images:
            im.close()
        return None

    out_dir.mkdir(parents=True, exist_ok=True)
    canvases = [Image.new("RGBA", (max(1, w), max(1, h)), (0, 0, 0, 0)) for w, h in pages]
    for im, at in zip(images, placed):
        canvases[at["page"]].paste(im, (at["x"], at["y"]))

    textures = []
    for p, canvas in enumerate(canvases):
        name = f"{key}-{p}.png"
        canvas.save(out_dir / name, optimize=True)
        frames = []
        for f, im, at in zip(files, images, placed):
            if at["page"] != p:
                continue
            w, h = im.size
            frames.append({
                "filename": f.stem,          # img_000 —— 与 sprite.json 的 img 序号对得上
                "frame": {"x": at["x"], "y": at["y"], "w": w, "h": h},
                "rotated": False,
                "trimmed": False,
                "spriteSourceSize": {"x": 0, "y": 0, "w": w, "h": h},
                "sourceSize": {"w": w, "h": h},
            })
        textures.append({
            "image": name,
            "format": "RGBA8888",
            "size": {"w": canvas.width, "h": canvas.height},
            "scale": 1,
            "frames": frames,
        })

    (out_dir / f"{key}.json").write_text(
        json.dumps({"textures": textures,
                    "meta": {"app": "tools/pack_atlas.py", "version": "1.0"}},
                   ensure_ascii=False, separators=(",", ":")),
        encoding="utf-8",
    )
    for im in images:
        im.close()
    return {"key": key, "pages": len(pages), "frames": len(files),
            "size": [pages[0][0], pages[0][1]] if pages else [0, 0]}


def main(argv: list[str]) -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("dirs", nargs="+", type=Path, help="精灵目录（含 img_*.png）")
    ap.add_argument("-o", "--outdir", type=Path, default=None,
                    help="输出目录，缺省就地生成")
    ap.add_argument("--max-side", type=int, default=DEFAULT_MAX_SIDE)
    ap.add_argument("--clean", action="store_true",
                    help="打包后删掉原始的 img_*.png")
    args = ap.parse_args(argv)

    total_pages = 0
    for d in args.dirs:
        if not d.is_dir():
            print(f"跳过 {d}：不是目录", file=sys.stderr)
            continue
        got = pack(d, args.outdir or d, max_side=args.max_side)
        if not got:
            continue
        total_pages += got["pages"]
        flag = "  ⚠️ 多页" if got["pages"] > 1 else ""
        print(f"  {got['key']:<16} {got['frames']:>3} 帧 → {got['pages']} 页 "
              f"{got['size'][0]}×{got['size'][1]}{flag}")
        if args.clean:
            for f in d.glob("img_*.png"):
                f.unlink()
    print(f"共 {total_pages} 页图集")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
