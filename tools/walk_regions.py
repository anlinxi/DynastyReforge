#!/usr/bin/env python3
"""通行区域分析：MB 层 -> 可通行掩码 -> 连通块 -> 出生点。

## 碰撞在 MB，不在 MK

这是 2.5D 斜视角：**能不能走看的是角色的脚踩在哪块地面上**，
而不是身体有没有被画面上的东西挡住。两层的分工正是如此：

- **`MB` = 碰撞层。** 1~2 像素的闭合细线，围出每个物件**在地面上的占地**。
  线把地图分成若干多边形，**包含街道的那一块就是可走区**。
- **`MK` = 遮挡层。** 大面积色块，覆盖屋顶、屋檐、伞盖这些**画在地面之上**
  的部分，用来决定何时把地面美术盖到角色身上。

判据是把两层叠到地面美术上直接看（`game/shot_collision.mjs`）：
一把伞，MK 的红色盖住**整个伞盖**，MB 的蓝色只盖住**伞杆底座**。
摊子、门楼同理——MK 是整个屋顶，MB 只有柱脚。

> ⚠️ **曾经把两层用反了**，拿 MK 当碰撞，于是伞下、屋檐下、廊道里全都
> 走不过去，而屋顶反倒能走。当时还用「NPC 是否站在可通行格上」做验证，
> 看着有 7/12 命中就信了——那个判据根本不成立：室内 NPC 本来就坐在
> 桌椅上，站在"障碍"上是正常的。**统计代理指标不能替代看一眼画面。**

## 分区

MB 的多边形会把地图分成主区（街道）与若干建筑占地。
mp0212 主区占全图 70%，21 个可交互对象里 17 个落在其中，
南门守卫、废屋的 badguy、马车旁的对象全在同一区——城内可以走通。
落在别的区里的是 `藥舖入口` `客棧入口` 这类门，它们本就嵌在建筑里。

**出生点必须落在主区**，否则哪儿都去不了。

用法:
    python3 walk_regions.py <地图归档.DAT> [--anchor 右上城門入口]
"""
from __future__ import annotations

import argparse
import sys
from collections import deque
from dataclasses import dataclass
from pathlib import Path

import sf2
import dat_unpack
import scene_table

#: 出生点从锚点向城内退让的距离，避免正好卡在门框里
SPAWN_INSET = 48


class WalkMaskError(ValueError):
    """MK 层缺失或无法解码。"""


@dataclass(frozen=True)
class WalkMask:
    width: int
    height: int
    free: bytes          # 每像素 1 = 可通行
    label: tuple[int, ...]   # 每像素所属连通块编号，0 = 障碍
    sizes: tuple[int, ...]   # 各连通块的像素数，下标即编号

    def region_at(self, x: int, y: int) -> int:
        if not (0 <= x < self.width and 0 <= y < self.height):
            return 0
        return self.label[y * self.width + x]

    @property
    def main_region(self) -> int:
        return max(range(1, len(self.sizes)), key=lambda k: self.sizes[k], default=0)

    @property
    def walkable_pixels(self) -> int:
        return sum(self.sizes[1:])


#: 碰撞层前缀。MK 是遮挡层，不要拿来做碰撞。
COLLISION_LAYER = "MB"


def load_layer(archive: Path, prefix: str = COLLISION_LAYER) -> tuple[int, int, list[int]]:
    with archive.open("rb") as fh:
        entries = dat_unpack.read_entries(fh, archive.stat().st_size)
        entry = next((e for e in entries if e.name.upper().startswith(prefix)
                      and e.name.upper().endswith(".SF2")), None)
        if entry is None:
            raise WalkMaskError(f"{archive.name} 里没有 {prefix} 层")
        fh.seek(entry.offset)
        data = fh.read(entry.size)
    header = sf2.parse_header(data)
    images = sf2.read_images(data, header)
    if not images:
        raise WalkMaskError(f"{archive.name} 的 {prefix} 层没有图像")
    composed = sf2.compose_image(images[0], sf2.read_tiles(data, header), header)
    return sf2.crop_to_real(images[0], *composed)


def region_at(mask: "WalkMask", x: int, y: int) -> int:
    """(x,y) 落在哪个连通块里；不可通行处返回 0。"""
    if not (0 <= x < mask.width and 0 <= y < mask.height):
        return 0
    return mask.label[int(y) * mask.width + int(x)]


def region_by_votes(mask: "WalkMask", points) -> int:
    """按落点票选可走区，票数相同时取面积大的。

    面积最大的连通块**不一定是可走地面**：内景图里房间外那一大片黑背景
    是一整块，比房间地板还大，直接取最大就会把背景当成可走区——
    "地面走不了、黑背景能走"就是这么来的。

    NPC 一定站在可走地面上，所以拿场景里的人物坐标来投票最稳。
    一票都没有（图上没人）时退回面积最大的那块。
    """
    votes: dict[int, int] = {}
    for x, y in points:
        region = region_at(mask, x, y)
        if region:
            votes[region] = votes.get(region, 0) + 1
    if not votes:
        return mask.main_region
    return max(votes, key=lambda r: (votes[r], mask.sizes[r]))


def analyse(width: int, height: int, pixels) -> WalkMask:
    """按遮罩层建掩码并做连通块标号。**透明处可通行**。

    内景外景是同一套约定：MB 描的都是障碍轮廓，其余留白。曾经以为内景
    反过来把地板涂实，那是误判——内景走不动的真正原因是取了面积最大的
    连通块（房间外的黑背景比地板还大），见 `region_by_votes`。
    """
    free = bytearray(1 if v == sf2.TRANSPARENT else 0 for v in pixels)
    label = [0] * (width * height)
    sizes = [0]
    current = 0

    for start in range(width * height):
        if not free[start] or label[start]:
            continue
        current += 1
        label[start] = current
        queue = deque([start])
        count = 1
        while queue:
            i = queue.popleft()
            x = i % width
            for j, inside in ((i - 1, x > 0), (i + 1, x < width - 1),
                              (i - width, i >= width),
                              (i + width, i < width * height - width)):
                if inside and free[j] and not label[j]:
                    label[j] = current
                    count += 1
                    queue.append(j)
        sizes.append(count)

    return WalkMask(width=width, height=height, free=bytes(free),
                    label=tuple(label), sizes=tuple(sizes))


def downsample(mask: WalkMask, cell: int, region: int | None = None) -> list[list[int]]:
    """降采样成 0/1 网格，1 = 可通行。取格中心，格越小越贴合原始形状。

    只保留指定连通块可以避免玩家被"传送"进走不到的区域——但默认不裁剪，
    因为剧情脚本可能把角色放到别的区块去。
    """
    cols, rows = mask.width // cell, mask.height // cell
    grid = []
    for gy in range(rows):
        row = []
        for gx in range(cols):
            x = gx * cell + cell // 2
            y = gy * cell + cell // 2
            lab = mask.region_at(x, y)
            row.append(1 if lab and (region is None or lab == region) else 0)
        grid.append(row)
    return grid


def spawn_near(mask: WalkMask, anchor: tuple[int, int], region: int,
               toward: tuple[int, int]) -> tuple[int, int] | None:
    """在指定连通块里，找离锚点最近、且朝 toward 方向退让过的落脚点。"""
    ax, ay = anchor
    tx, ty = toward
    dx = 1 if tx > ax else -1
    dy = 1 if ty > ay else -1
    preferred = (ax + dx * SPAWN_INSET, ay + dy * SPAWN_INSET)

    for base in (preferred, anchor):
        for radius in range(0, 400, 4):
            for ox in range(-radius, radius + 1, 4):
                for oy in (-radius, radius):
                    p = (base[0] + ox, base[1] + oy)
                    if mask.region_at(*p) == region:
                        return p
            for oy in range(-radius, radius + 1, 4):
                for ox in (-radius, radius):
                    p = (base[0] + ox, base[1] + oy)
                    if mask.region_at(*p) == region:
                        return p
    return None


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("archive")
    parser.add_argument("--anchor", help="出生点锚定的场景对象名")
    args = parser.parse_args(argv)

    archive = Path(args.archive)
    mask = analyse(*load_layer(archive))
    main_id = mask.main_region
    total = mask.walkable_pixels
    print(f"{archive.name}: {mask.width}x{mask.height}  "
          f"可通行 {total} 像素  连通块 {len(mask.sizes) - 1} 个")
    ranked = sorted(range(1, len(mask.sizes)), key=lambda k: -mask.sizes[k])
    for k in ranked[:5]:
        print(f"   块#{k}{' ←主区' if k == main_id else '':<5} "
              f"{mask.sizes[k]:>9} = {mask.sizes[k] / total:5.1%}")

    objects = scene_table.load(archive)
    inside = sum(1 for o in objects if o.interactive
                 and mask.region_at(o.x, o.y) == main_id)
    live = sum(1 for o in objects if o.interactive)
    print(f"   可交互对象落在主区: {inside}/{live}")

    if args.anchor:
        target = next((o for o in objects if o.name == args.anchor), None)
        if target is None:
            print(f"找不到对象「{args.anchor}」", file=sys.stderr)
            return 1
        centre = (mask.width // 2, mask.height // 2)
        spot = spawn_near(mask, (target.x, target.y), main_id, centre)
        print(f"   以「{args.anchor}」({target.x},{target.y}) 为锚点的出生点: {spot}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
