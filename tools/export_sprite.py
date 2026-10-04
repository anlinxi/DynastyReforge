#!/usr/bin/env python3
"""导出场景人物精灵，并归一化为「脚底锚点」以便挂到地图坐标上。

SF2 的图层坐标是原作战斗/场景画面的绝对坐标，直接使用会让贴图与
逻辑位置对不上。这里统一改成相对锚点：以全部帧的水平中心、
垂直最低点作为锚点（即人物脚底），前端按该锚点贴到地图坐标即可。

产物:
    <out>/<名称>/img_000.png ...  **每个图层一张**（图跨帧共享，天然去重）
    <out>/<名称>/sprite.json      {images:[{index,file,w,h}],
                                   frames:[{dur, layers:[{img,ox,oy,blend,alpha}]}]}

⚠️ **2026-09-05 改成分层出图。** 原先是整帧合成成一张 PNG，
**混合模式在合成那一刻就丢了** —— 废屋法术那张「中心金黄四周纯黑」的
全屏光晕因此被当成半透明黑画，在画面正中糊出一团暗块（玩家说的「黑圈」）。

用法:
    python3 export_sprite.py <out_dir> <a.SF2> [b.SF2 ...]
"""
from __future__ import annotations

import argparse
import json
import struct
import sys
from pathlib import Path

import pack_atlas
import sf2
import sf2_anim
import sound_unpack
from sf2_export import write_png_rgba


def render_image(header, images, tiles, index):
    image = next((im for im in images if im.index == index), None)
    if image is None:
        return None
    return sf2.compose_image(image, tiles, header)


#: 影子帧比人物矮得多，用它当高度阈值把两者分开
SHADOW_HEIGHT_RATIO = 0.7


#: 超过这个尺寸的就不是人物精灵，而是过场用的整屏素材。
#: 与前端 `FieldScene.PROP_MAX_SIZE` 同一个数 —— 人物精灵最大约 64×96。
PROP_MAX_SIZE = 200

#: 过场动画至少有这么多帧。单帧的大图是摆件/大个子 NPC，不是过场。
CUTSCENE_MIN_FRAMES = 2

#: SF2 的绘制模式 → 前端的混合模式名。
#:
#: ⚠️ **三处必须一致**：这里、`export_menu_ui.BLEND_MAP`、
#: 前端的 `systems/blendModes.js`。同一个 `blend` 字段没有理由在菜单、场景、
#: 战斗里各画各的 —— 曾经就是这样，于是同一批素材在菜单里是金光、
#: 在过场动画里是黑块。
#:
#: **`subtract16` 是加亮，不是减色。** 社区 2 号文档叫「16级Subtract」，
#: 按字面写成减色会把菜单选中项涂黑；用它的素材形态一律是
#: 「亮色主体 + 纯黑背景」（废屋那张 640×480 的中心金黄椭圆光晕、火焰、爆炸云）。
#:
#: **`unknown8` 也是加亮**（2026-09-05 订正，原先写的是正片叠底）。
#: 判据：`EVENT2-3` 帧 33~35 用它画的 `img86~88` 是「暗红火焰球 + 纯黑圆背景」，
#: 按正片叠底画，那圈纯黑会把画面乘成黑 —— **画面正中那个黑圆盘就是这么来的**，
#: 也就是玩家一直说的「黑圈」。战斗动画里的 87 处同样是暗红 + 30~45% 近黑像素。
#: ⚠️ **`unknown7` 仍然是正片叠底**，别一起改：菜单标签栏 / 二级菜单 / 商店
#: 分类栏的**底板层**用的是它，那里就是要压暗背景。两者恰好分得很干净 ——
#: 菜单里只有 unknown7，场景与战斗里只有 unknown8。
BLEND_MAP = {
    "normal": "normal", "opaque": "normal",
    "unknown7": "multiply",
    "unknown8": "add",
    "subtract16": "add",
    "alpha16": "normal",
    "invert": "normal",       # 全库未出现；真出现了要单独处理
}

#: 带 16 级不透明度的两种模式。其余模式的 alpha 字段是废值，一律按 1。
GRADED = frozenset({"alpha16", "subtract16"})


def opaque_box(width: int, height: int, pixels) -> tuple[int, int, int, int] | None:
    """图像里真正有颜色的范围 (左, 右, 上, 下)。

    图层矩形四周常带一圈透明留白，按矩形算脚底会把锚点定到鞋底以下。
    """
    left, right, top, bottom = width, 0, height, 0
    for y in range(height):
        row = y * width
        for x in range(width):
            if pixels[row + x] != sf2.TRANSPARENT:
                if x < left:
                    left = x
                if x >= right:
                    right = x + 1
                if y < top:
                    top = y
                bottom = y + 1
    return (left, right, top, bottom) if right > left else None


def frame_extent(header, images, tiles, frame) -> tuple[int, int, int, int] | None:
    """一帧合成后、只算不透明像素的包围盒 (左, 右, 上, 下)。"""
    box = None
    for layer in frame.layers:
        rendered = render_image(header, images, tiles, layer.image_index)
        if not rendered:
            continue
        inner = opaque_box(*rendered)
        if not inner:
            continue
        edges = (layer.x + inner[0], layer.x + inner[1],
                 layer.y + inner[2], layer.y + inner[3])
        box = edges if box is None else (
            min(box[0], edges[0]), max(box[1], edges[1]),
            min(box[2], edges[2]), max(box[3], edges[3]),
        )
    return box


def character_extents(extents: list) -> list:
    """只留人物帧，去掉单独的影子帧。

    **帧 0 是一张单独的影子图**（夏侯仪 64x48，人物帧 64x96），它的底边比
    人物鞋底还低 20~30 像素。早先拿「所有帧里最低的一点」当脚底锚点，
    等于把整个人物往上抬了这么多——画面上人已经踩到墙头了，判定点还在
    墙根外面，看起来就是"该拦的时候不拦"。判定点必须落在鞋底。
    """
    boxes = [e for e in extents if e]
    if not boxes:
        return []
    tallest = max(b - t for _, _, t, b in boxes)
    return [e for e in boxes if (e[3] - e[2]) >= tallest * SHADOW_HEIGHT_RATIO]


def export_sounds(src: Path, out_dir: Path) -> list[dict]:
    """导出精灵里**内嵌的音效**，索引与帧的 `sound_index` 对应。

    ⚠️ **这条线一度整个是空的。** 场景精灵从来没导过音效，`FieldSprite`
    也没有播放代码 —— 于是废屋那段法术（`EVENT2-3.SF2`，**6 条内嵌音效**）
    烧士兵时只有画面没有声音，蝎子那段（`EVENT1-8.SF2`，7 条）同理。
    而战斗那边（`export_pack.py` / `SF2Animator`）一直是有的。

    全库 4102 个场景精灵里 **265 个带内嵌音效**，不是个别现象。
    """
    try:
        sounds = sound_unpack.read_sounds(src.read_bytes())
    except (struct.error, OSError, ValueError) as err:
        print(f"  ⚠ {src.stem} 的音效读不出来（{err}），这个精灵没有声音")
        return []
    meta = []
    for snd in sounds:
        name = f"snd_{snd.index:02d}.wav"
        (out_dir / name).write_bytes(sound_unpack.build_wav(snd))
        meta.append({"index": snd.index, "file": name,
                     "seconds": round(snd.seconds, 3)})
    return meta


def export(src: Path, out_root: Path) -> dict | None:
    try:
        header, images, tiles = sf2.load(src)
        _, frames = sf2_anim.load_animation(src)
    except (sf2.SF2Error, OSError, struct.error) as exc:
        print(f"跳过 {src.name}: {exc}", file=sys.stderr)
        return None

    # ⚠️ **一帧都不能漏，帧号就是原始帧号。**
    #
    # 事件脚本按原始帧号点段（`play_anim{動畫第二段, 2→11}`），
    # 而这里若把「没有图层」或「渲染失败」的帧跳过去，后面所有帧号就前移。
    # `EVENT2-3` 原始 90 帧，早先只导出 64 帧 —— **错位 25 帧**，
    # 于是「士兵进门」那段播成了别的，看起来像"一进屋就砍人"。
    #
    # 空帧照样占一个位置，只是不写 PNG（`empty: true`），前端跳过绘制。
    used = list(frames)
    if not any(f.layers for f in used):
        return None

    extents = [frame_extent(header, images, tiles, f) for f in used if f.layers]
    body = character_extents(extents)
    if not body:
        return None
    # ⚠️ **锚点一律取 (0,0)，`ox/oy` 就是 SF2 的原始图层坐标。**
    #
    # 原作的定位公式（社区工具 CastleScript 的 `SCI.cs` 给出）是：
    #
    #     位置 = 对象(X, Y) ＋ SCI 的绘制偏移 ＋ SF2 图层坐标
    #
    # 绘制偏移在 SCI 的 `+108`，绝大多数是 `(-320, -260)`（屏幕中心的负值），
    # **但不是常量** —— 废屋「動畫第二段」是 `(-320, -160)`。
    #
    # 此前这里算的是「脚底锚点」（水平取人物帧中线、垂直取站立首帧底边），
    # 那是对人物**近似成立**的经验做法：药铺老板差 (6,9)、客栈掌柜差 (0,1)，
    # 看不出来。但对大摆件就露馅 —— 马车后半 `NB0212-32` **横向差 32 像素**，
    # 与地面美术里的车身错开，看着像"马车裂成了两块"。
    # 过场动画更是完全对不上（那本来就没有"脚底"可言）。
    #
    # 现在统一成原作公式，偏移交给前端按 `map.json` 的 `dx/dy` 加。
    anchor_x = anchor_y = 0

    out_dir = out_root / src.stem
    out_dir.mkdir(parents=True, exist_ok=True)
    # ⚠️ **先清掉上一次的产物。** 换过两次结构了（整帧合成 `f000.png` →
    # 分层 `img_000.png` → 图集 `<KEY>-0.png`），不清的话三代文件叠在目录里：
    # 分层那一轮就留下 141 个目录、8.9 MB 的死文件，而且**不会报错** ——
    # 前端只按 `sprite.json` 取，多出来的没人引用，只是白白占体积和请求数。
    for stale in list(out_dir.glob("f[0-9]*.png")) + list(out_dir.glob("img_*.png")) \
            + list(out_dir.glob(f"{src.stem}-*.png")) + list(out_dir.glob(f"{src.stem}.json")):
        stale.unlink()

    # ⚠️ **每层单独出图，不再整帧合成。**
    #
    # 合成那一刻**混合模式就丢了** —— 而 `subtract16` 是**加亮**不是变暗
    # （`export_menu_ui.BLEND_MAP` 早有判据：社区文档叫「16级Subtract」，
    # 实测是加亮，按字面写成减色会把选中项涂黑）。
    # 废屋那段法术的 `image0` 是一张 640×480、**中心金黄四周纯黑**的椭圆光晕，
    # 按加亮画是「屋里亮起金光再淡出」；早先当半透明黑合成，中心最实，
    # 于是画面正中糊上一团暗块 —— 那就是玩家看到的**「黑圈」**。
    #
    # 图是**跨帧共享**的（`EVENT2-3` 542 个图层引用只有 161 张唯一图），
    # 所以分层出图张数虽多，总像素量反而降 —— 合成路径每帧都要写一张
    # 整帧包围盒（最大 640×480）的 PNG。
    used_imgs: dict[int, dict] = {}
    for f in used:
        for layer in f.layers or []:
            if layer.image_index in used_imgs:
                continue
            image = next((im for im in images if im.index == layer.image_index), None)
            rendered = render_image(header, images, tiles, layer.image_index)
            if not rendered or image is None:
                continue
            # ⚠️ **必须裁到 real 尺寸。** `compose_image` 返回的是 **tile 网格**
            # 尺寸（向上取整到整块 64×48），右下多出一条空白。整帧合成那条老路
            # 是按「不透明像素包围盒」裁的，所以多出来那条自然被切掉；分层出图
            # 直接写整张，不裁的话每层都会大一圈 —— 遮挡覆盖层（`occlusion`）
            # 跟着变大，残影的覆盖率判定就失准了。
            w, h, pixels = sf2.crop_to_real(image, *rendered)
            name = f"img_{layer.image_index:03d}.png"
            rows = [bytes(b for x in range(w)
                          for b in sf2.x1r5g5b5_to_rgba(pixels[y * w + x]))
                    for y in range(h)]
            write_png_rgba(out_dir / name, w, h, rows)
            used_imgs[layer.image_index] = {"index": layer.image_index,
                                            "file": name, "w": w, "h": h}

    meta = []
    for f in used:
        # ⚠️ **一帧都不能漏，帧号就是原始帧号**（见上面的说明）。
        # 空帧照样占位，只是没有图层。
        layers = []
        for layer in sorted(f.layers or [], key=lambda l: l.depth):
            if layer.image_index not in used_imgs:
                continue
            item = {
                "img": layer.image_index,
                "ox": round(layer.x - anchor_x),
                "oy": round(layer.y - anchor_y),
            }
            blend = BLEND_MAP.get(layer.blend, "normal")
            if blend != "normal":
                item["blend"] = blend
            # alpha 只对分级的两种模式有意义；其余模式那个字段是废值
            # （`normal` 层的 alpha 常常是 0，当成"全透明"会把人物整个画没）。
            if layer.blend in GRADED and layer.alpha:
                item["alpha"] = round(min(layer.alpha, sf2_anim.ALPHA_MAX)
                                      / sf2_anim.ALPHA_MAX, 4)
            layers.append(item)
        entry = {"dur": max(1, f.duration)}
        # 原作把音效挂在帧上（`sf2_anim` 的 `sound_index`，-1 = 没有）。
        if getattr(f, "sound_index", -1) is not None and f.sound_index >= 0:
            entry["snd"] = f.sound_index
        if layers:
            # ⚠️ **整帧包围盒照旧输出**（`ox/oy/w/h`）。分层之后前端画的是
            # 各层，但另外两个消费者仍然按整帧算：`occlusion.spriteBox` 用它
            # 定遮挡覆盖层的大小，`FieldScene.isCutscenePiece` 用它区分
            # 「人物精灵」与「过场整屏素材」。留着它们，那两处一行都不用改。
            boxes = [(l["ox"], l["oy"],
                      used_imgs[l["img"]]["w"], used_imgs[l["img"]]["h"]) for l in layers]
            left = min(b[0] for b in boxes)
            top = min(b[1] for b in boxes)
            entry.update({
                "ox": left, "oy": top,
                "w": max(b[0] + b[2] for b in boxes) - left,
                "h": max(b[1] + b[3] for b in boxes) - top,
                "layers": layers,
            })
        else:
            entry["empty"] = True
        meta.append(entry)

    # **打成图集，然后删掉逐层 PNG。**
    #
    # 一个精灵的逐层图动辄上百张（`EVENT2-3-2` 有 296 张），150 个目录合计
    # 5807 张 —— 实测九张地图启动要 **8528 个 HTTP 请求**。打包后一个精灵
    # 只剩「1 个 JSON + 通常 1 张 PNG」。见 `docs/归档/方案-按需加载与图集.md`。
    packed = pack_atlas.pack(out_dir, out_dir, key=src.stem)
    if packed:
        for f in out_dir.glob("img_*.png"):
            f.unlink()

    sounds = export_sounds(src, out_dir)
    doc = {"name": src.stem,
           "images": [used_imgs[k] for k in sorted(used_imgs)],
           "frames": meta}
    if sounds:
        doc["sounds"] = sounds
    if packed:
        # 前端据此走 `load.multiatlas`；没有这个字段就退回逐张 PNG（旧产物）。
        doc["atlas"] = {"json": f"{src.stem}.json", "pages": packed["pages"]}
    (out_dir / "sprite.json").write_text(
        json.dumps(doc, ensure_ascii=False, separators=(",", ":")),
        encoding="utf-8",
    )
    return {"name": src.stem, "frames": len(meta),
            "pages": packed["pages"] if packed else 0, "sounds": len(sounds)}


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("out_dir")
    parser.add_argument("sources", nargs="+")
    args = parser.parse_args(argv)

    out_root = Path(args.out_dir)
    for s in args.sources:
        path = Path(s)
        if not path.is_file():
            continue
        result = export(path, out_root)
        if result:
            print(f"  {result['name']}: {result['frames']} 帧")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
