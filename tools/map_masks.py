#!/usr/bin/env python3
"""把 MB / MK 两层做成前端可以**逐像素**查的掩码 PNG。

## 为什么不再降采样

原先把 MB 降采样成 8 像素网格塞进 map.json，纯粹是因为 JSON 装不下
3840×1440。但 MB 的线宽只有 4~8 像素，取格中心采样时线经常从相邻两个
格心之间穿过去——墙上于是出现规律的孔，玩家从孔里钻上屋顶。
**那个 bug 是降采样造出来的，原作数据里没有。** 改成 PNG 就没有损失。

## 两层各自是什么（已用原作数据核实）

- **MB = 地面障碍轮廓。** 美术逐图手描的落地占位：一把伞只圈伞杆底座，
  一张桌子只圈桌腿，城墙沿墙根走、门洞处绕开。判定只有一条：
  **脚不能跨过线**。不需要任何"哪块是墙哪块是地板"的规则。
- **MK = 遮挡层。** 覆盖建筑主体、屋顶、伞盖这些画在地面之上的美术。
  447 条地图记录里有 77 条只有 MB 没有 MK，反过来一条都没有——
  可见 MB 是必备的通行数据，MK 只是可选的表现层。

## 遮挡怎么判：MK 无条件盖在人物上方

遮挡是**画面层级**问题，跟能不能走无关。规则只有一条：

    MK 覆盖到的美术，一律画在人物上方。

因为 MK 圈的本来就只是**悬在可走地面之上**的那部分美术——屋顶、屋檐、
伞盖、栏杆。人站在它的屏幕范围里，就意味着人在它下面或后面。

> 试过更"讲道理"的做法：把 MK 切成物件、记下每件的墙根，只有墙根比脚下
> 更靠下才遮。结果更差——同一列上屋顶、墙、底下的凉棚是一整段连续像素，
> 墙根取到最下面那个，整片屋顶都会盖到人身上；为此加的"墙根突变处断开"
> 又把连续结构从中间劈开，人被一条**竖直直线**切成两半。
> 实机对比后改回无条件，两处报错的站位都明显更对。

## ⚠️ MK 只是遮挡的**一条腿**，另一条是场景对象

MK 盖不全：`MP0401` 只覆盖全图 **24.0%**、`MP1101` **27.1%** ——
集市那把伞、整道城墙、佛寺门楼一带 MK 里一个像素都没有。
**没盖的那些是 `.SCI` 对象表里的精灵**，按对象的 `y` 排序画在人物前后。

判据：一个精灵如果和底图同位置逐像素相同（凉棚 `nn0401b-34` 平均色差
**2.6/255**），它就不是布景，是遮挡物。见 `docs/专题/通行与遮挡.md`，
体检 `tools/occluder_audit.py`。

（曾经写在这儿的「部分木柱不在 MK 里，是原作数据本身的取舍」是**错的** ——
柱子在对象表里，是导出器把它砍了。）
"""
from __future__ import annotations

import sys
from pathlib import Path

import sf2
import walk_regions
from sf2_export import write_png_rgba


def opaque_bits(pixels) -> bytes:
    """二值层 -> 每像素 1 = 有色（不透明）。"""
    return bytes(0 if v == sf2.TRANSPARENT else 1 for v in pixels)


def walkable_bits(mask: walk_regions.WalkMask, region: int | None = None) -> bytes:
    """可通行掩码，每像素 1 = 可走。

    指定 region 时只保留该连通块。跨不过线的区域走也走不到，封掉它可以
    避免出生点或传送落到走不出去的角落里。
    """
    if region is None:
        return bytes(mask.free)
    return bytes(1 if lab == region else 0 for lab in mask.label)


def write_mask_png(path: Path, width: int, height: int, bits) -> None:
    """R = 255 表示真（可走 / 是遮挡物）。A 恒为 255，免得浏览器按预乘 alpha 把 R 抹掉。"""
    rows = []
    for y in range(height):
        row = bytearray()
        base = y * width
        for x in range(width):
            v = 255 if bits[base + x] else 0
            row += bytes((v, v, v, 255))
        rows.append(bytes(row))
    write_png_rgba(path, width, height, rows)


def main(argv: list[str]) -> int:
    """独立跑一遍，便于对照统计。"""
    if not argv:
        print(__doc__)
        return 1
    archive = Path(argv[0])
    mask = walk_regions.analyse(*walk_regions.load_layer(archive, "MB"))
    bits = walkable_bits(mask, mask.main_region)
    walkable = sum(bits)
    print(f"{archive.name}: {mask.width}x{mask.height} "
          f"可走 {walkable} 像素 ({walkable / len(bits):.1%})")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
