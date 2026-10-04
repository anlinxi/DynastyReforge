#!/usr/bin/env python3
"""导出**人物代码 → 姓名** → `assets/data/speakers.json`。

## 为什么单独一张表

对白指令（op05/op33/op51）的第一个字节是**人物代码**，姓名牌上印的就是它
对应的名字。名字表在 `Sys/Namelist.lis`（`tools/namelist.py` 解析），
**是全局的，与地图无关**。

⚠️ **从前是按图存的，而且只在给了 `--sys` 时才写。**
`export_map.py` 里那句 `if args.sys: meta["names"] = ...` ——
于是 317 张图里**只有 21 张带 `names`**，其余的对白全都没有姓名牌。
表现：遇冰璃那一整段（`MP0303`/`MP0304`）不论谁说话都只有立绘、没有名字。
这正是 `CLAUDE.md` 判据表里「**一张图需要额外保留某个东西 → 写进工具里的
表，不要靠命令行参数**」那一条的翻版：`--sys` 是命令行参数，隔天重导就丢了。

改成一份全局产物之后，前端查表即可，不必为了补名字重导 317 张地图。

用法:
    python3 export_speakers.py <Sys.dat> <out.json>
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

import namelist


def main(argv: list[str]) -> int:
    if len(argv) != 2:
        print(__doc__, file=sys.stderr)
        return 1
    sys_dat, out_path = Path(argv[0]), Path(argv[1])
    if not sys_dat.is_file():
        print(f"找不到 {sys_dat}", file=sys.stderr)
        return 1

    names = namelist.load(sys_dat)
    # 代码 0 是系统旁白（名字为空），留着 —— 前端据此判断「不显示姓名牌」。
    table = {str(code): text for code, text in sorted(names.items()) if text}

    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps({
        "生成自": "tools/export_speakers.py",
        "说明": "人物代码 → 姓名。对白指令的第一个字节就是这个代码。",
        "姓名": table,
    }, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"{len(table)} 个人名 -> {out_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
