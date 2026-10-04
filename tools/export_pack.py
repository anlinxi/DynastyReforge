#!/usr/bin/env python3
"""把 SF2 导出成前端可直接使用的资源包：PNG 图片 + 动画 JSON。

产物结构:
    <out>/<name>/img_000.png ...
    <out>/<name>/anim.json      帧时序、图层、混合模式、音效与打击感参数

用法:
    python3 export_pack.py <out_dir> <file.SF2> [更多...]
    python3 export_pack.py <out_dir> --glob '<目录>/ATT-*.SF2'
"""
from __future__ import annotations

import argparse
import glob as globmod
import json
import struct
import sys
from pathlib import Path

import pack_atlas
import sf2
import sf2_anim
import sound_unpack
from sf2_export import write_png_rgba


def export_images(src: Path, out_dir: Path) -> list[dict]:
    """导出全部图片，返回图片元数据列表。"""
    header, images, tiles = sf2.load(src)
    meta = []

    for image in images:
        width, height, pixels = sf2.compose_image(image, tiles, header)
        if not width or not height:
            continue

        rows = []
        for y in range(height):
            row = bytearray()
            for x in range(width):
                row.extend(sf2.x1r5g5b5_to_rgba(pixels[y * width + x]))
            rows.append(bytes(row))

        name = f"img_{image.index:03d}.png"
        write_png_rgba(out_dir / name, width, height, rows)
        meta.append(
            {
                "index": image.index,
                "file": name,
                "width": width,
                "height": height,
                "real_size": [image.real_width, image.real_height],
                **({"borrowed_hit_frame": image.borrowed_hit_frame} if image.borrowed_hit_frame else {}),
            }
        )
    return meta


def export_sounds(src: Path, out_dir: Path) -> list[dict]:
    """导出内嵌音效为 WAV，索引与帧的 sound_index 对应。"""
    try:
        sounds = sound_unpack.read_sounds(src.read_bytes())
    except (struct.error, OSError):
        return []

    meta = []
    for s in sounds:
        name = f"snd_{s.index:02d}.wav"
        (out_dir / name).write_bytes(sound_unpack.build_wav(s))
        meta.append({"index": s.index, "file": name, "seconds": round(s.seconds, 3)})
    return meta


#: 算影子形状时，alpha 超过多少才算"画了东西"。JPEG 噪声与羽化边都在这之下。
ALPHA_FLOOR = 8

#: 影子"核心区"的门槛：列高 ≥ 最高列的这个比例，才算脚底那一团。
#: ⚠️ 判据表 B 组「放宽一个解析阈值先看全库会多认出几条」——
#: 0.5 时全库 16 个 STN 包里不持长兵器的两法一致（差 ≤4px），
#: 持长兵器的差 16~23px，正是要修的那一批；调到 0.3 会把枪影也算进核心区。
CORE_RATIO = 0.5


def stand_point(payload: dict, images_meta: list[dict], out_dir: Path) -> list[int] | None:
    """算出这一包自己的**站立点**（屏幕绝对坐标），写进 `anim.json`。

    ## 为什么要有它

    战斗单位要摆到某一格上时，得知道「这个贴图的哪一点算是脚」。
    此前前端按**阵营**取一个代表值（敌方拿 `STN1030`、我方拿 `STN0010`），
    而各素材的贴图宽高不同、影子中心自然也不同 —— 结果是**人站在格子外面**，
    格盘叠层一开就能看见位置号在脚底下方约 30px（用户 2026-09-16 指出）。

    ## 站立点 ＝ 影子层**最厚那一段**的中心

    影子是角色与地面的接触面，可它**不只画脚底那一团** ——
    ⚠️ **手里的长兵器、披风、坐骑，影子里都有**，一起算框中心就被拉偏。
    西夏兵 `STN1040` 手持长枪横在身前，影子层宽 103px，
    其中大半是枪影：框中心 `x=310`，而两脚之间是 `x=294`，**差 16px**。
    古倫德 `STN0050` 差 **23px**，赫蘭鐵罕 `STN2010` 差 16px。
    用户 2026-09-17 一眼看出「敌人脚下还是没站在格子正中央」。

    所以取**影子最厚的那一段**：脚底那一团又厚又密，兵器的影子是一条细线。
    做法是按列数不透明像素，取**高度 ≥ 最高列一半**的那些列，
    它们的范围中心就是站立点的 x；这些列里不透明行的中心就是 y。

    判据自洽：全库 16 个 `STN` 包里，**不持长兵器的两法一致**
    （`STN1410` 差 2px、`STN0010` 差 4px），只有持长兵器的差 16~23px；
    **y 两法几乎完全一致**（中位 0.5px、最大 1px），说明这一改
    只动 x、不会破坏上一轮已经修对的 y。

    ⚠️ **不要拿整帧不透明像素的底边** —— 那是影子的**下沿**，
    会让所有人悬在格子上方十几像素。这个错项目里犯过一次。

    ## 影子是哪一层

    **每帧图层列表里的第 0 层**。判据：逐包看下来，第 0 层总是画在最低处
    （`STN0010` 帧1 是 `(18, 322,268)` 对 `(0, 323,187)`；`MOV0010`、`RED0010`
    同形），而且它的图又扁又宽 —— 正是影子的形态。
    取**第一个有两层以上的帧**（有些帧只有一层，那是没画影子的瞬间，
    例如 `BAK0010` 转身那两帧）。

    返回 `None` 表示这一包没有影子层（纯特效包就是这样），前端照旧兜底。
    """
    import numpy as np                        # noqa: PLC0415 —— 只在这里用
    from PIL import Image                      # noqa: PLC0415


    by_index = {m["index"]: m for m in images_meta}
    for frame in payload.get("frames", []):
        layers = frame.get("layers") or []
        if len(layers) < 2:
            continue
        shadow = layers[0]
        meta = by_index.get(shadow["image_index"])
        if not meta:
            continue
        try:
            with Image.open(out_dir / meta["file"]) as im:
                alpha = np.array(im.convert("RGBA").getchannel("A")) > ALPHA_FLOOR
        except OSError:
            return None
        if not alpha.any():
            continue
        # 每列有多少不透明像素 —— 脚底那一团最厚，兵器的影子是细线
        heights = alpha.sum(axis=0)
        core = np.flatnonzero(heights >= heights.max() * CORE_RATIO)
        rows = np.flatnonzero(alpha[:, core.min():core.max() + 1].any(axis=1))
        # 图层坐标是**屏幕绝对坐标**，加上核心区在图内的位置就是绝对点
        return [
            round(shadow.get("x", 0) + (int(core.min()) + int(core.max())) / 2),
            round(shadow.get("y", 0) + (int(rows.min()) + int(rows.max())) / 2),
        ]
    return None


#: 不打图集的包前缀。ITF 界面包原先排除（界面取图只认逐帧纹理）；2026-09-27 界面改走
#: game/src/ui/packImage.js（图集/逐帧都认）后放开 —— 2221 张逐帧小图在桌面版读文件就要约 2.7 秒。
ATLAS_EXCLUDE_PREFIXES: tuple[str, ...] = ()


def export_one(src: Path, out_root: Path) -> dict | None:
    out_dir = out_root / src.stem
    out_dir.mkdir(parents=True, exist_ok=True)

    try:
        images_meta = export_images(src, out_dir)
        header, frames = sf2_anim.load_animation(src)
    except (sf2.SF2Error, OSError, struct.error) as exc:
        print(f"  跳过 {src.name}: {exc}", file=sys.stderr)
        return None

    sounds_meta = export_sounds(src, out_dir)

    payload = sf2_anim.to_dict(header, frames)
    payload["source"] = src.name
    payload["images"] = images_meta
    payload["sounds"] = sounds_meta
    # **每个包自己的站立点** —— 前端摆位用，见 stand_point 的说明。
    anchor = stand_point(payload, images_meta, out_dir)
    if anchor:
        payload["stand_point"] = anchor
    # 逐帧PNG打成multiatlas（前端见 BattleScene.queuePack / SF2Animator 的 atlas 分支；
    # ITF界面包经 ui/packImage.js 同样认图集，2026-09-27 起不再排除）。打完删逐帧图。
    if not src.stem.upper().startswith(ATLAS_EXCLUDE_PREFIXES):
        packed = pack_atlas.pack(out_dir, out_dir, key=src.stem)
        if packed:
            for f in out_dir.glob("img_*.png"):
                f.unlink()
            payload["atlas"] = {"json": f"{src.stem}.json", "pages": packed["pages"]}
    (out_dir / "anim.json").write_text(
        json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8"
    )

    return {
        "name": src.stem,
        "frames": header.frame_count,
        "images": len(images_meta),
        "sounds": len(sounds_meta),
        "tile": [header.tile_width, header.tile_height],
    }


def update_manifest(out_root: Path, exported: list[dict]):
    """增量导出只替换本次包，保留已存在的其他包。"""
    path = out_root / 'manifest.json'
    previous = json.loads(path.read_text()) if path.is_file() else []
    rows = {row['name']: row for row in previous}
    rows.update({row['name']: row for row in exported})
    path.write_text(json.dumps(list(rows.values()), ensure_ascii=False, indent=2), encoding='utf-8')


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("out_dir")
    parser.add_argument("sources", nargs="*")
    parser.add_argument("--glob", help="按通配符批量选取")
    parser.add_argument("--limit", type=int, default=0, help="最多处理多少个文件")
    args = parser.parse_args(argv)

    paths = [Path(s) for s in args.sources]
    if args.glob:
        paths.extend(Path(p) for p in sorted(globmod.glob(args.glob)))
    paths = [p for p in paths if p.is_file()]
    if args.limit:
        paths = paths[: args.limit]

    if not paths:
        print("没有匹配到文件", file=sys.stderr)
        return 1

    out_root = Path(args.out_dir)
    manifest = []
    for path in paths:
        result = export_one(path, out_root)
        if result:
            manifest.append(result)
            print(
                f"  {result['name']}: {result['frames']} 帧, "
                f"{result['images']} 图, {result['sounds']} 音效"
            )

    update_manifest(out_root, manifest)
    print(f"\n完成 {len(manifest)}/{len(paths)} 个 -> {out_root}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
