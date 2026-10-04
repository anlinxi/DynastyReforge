#!/usr/bin/env python3
"""标题画面与天书上翻箭头的菜单动画 → `<输出目录>/<条目>/`（场景精灵格式：sprite.json + 图集）。

`game/src/config.js` 的标题画面（背景 MEN9300、三个选项 MEN9301–9303 各 32 帧浮现、读档页 MEN9304）
与天书上翻箭头 MEN8004 按逐帧动画播放，不走 `export_menu_ui.py` 的单帧图表。
原先 2026-09-08 做标题画面时手工用 export_sprite 导出；2026-09-28 收进一键提取（开源发布 P2），
否则干净环境里标题画面没有图。素材都在官方 `MenusDir.DAT`，散装 `menus/` 目录里没有这几条。

用法：python3 tools/export_title.py <MenusDir.DAT> <输出目录，通常 game/public/assets/menus>
"""
from __future__ import annotations

import sys
import tempfile
from pathlib import Path

import dat_unpack
import export_sprite

#: 标题画面背景、三个选项、读档页，与天书上翻箭头。
ENTRIES = ("MEN9300", "MEN9301", "MEN9302", "MEN9303", "MEN9304", "MEN8004")


def main(argv: list[str]) -> int:
    if len(argv) != 2:
        print(__doc__, file=sys.stderr)
        return 1
    archive, out = Path(argv[0]), Path(argv[1])
    out.mkdir(parents=True, exist_ok=True)
    with archive.open("rb") as fh, tempfile.TemporaryDirectory() as tmp:
        entries = {Path(e.name).stem.upper(): e for e in dat_unpack.read_entries(fh, archive.stat().st_size)}
        for name in ENTRIES:
            entry = entries.get(name)
            if entry is None:
                print(f"{archive.name} 里没有 {name}.SF2", file=sys.stderr)
                return 1
            fh.seek(entry.offset)
            staged = Path(tmp) / f"{name}.SF2"
            staged.write_bytes(fh.read(entry.size))
            if not export_sprite.export(staged, out):
                print(f"{name} 导出失败", file=sys.stderr)
                return 1
    print(f"-> {out}（{len(ENTRIES)} 条）")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
