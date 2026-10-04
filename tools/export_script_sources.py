#!/usr/bin/env python3
"""导出**「没有 .EVE 的图，事件表向谁借」** → `assets/data/script_sources.json`。

## 问题

全库有 **13 张图没有自己的事件表**（`.EVE` 不在归档里）。它们是过场图：
被别的图的 `goto_map` 拉起来，用的是**拉起它的那张图**的事件槽。

运行时靠「谁把我拉进来的」（`pendingScript.map`）能对，但**读档直接落在
这种图上时那个值是空的** —— 表现是「读档到打蝎子那张图（`MP2503A`）之后
再也走不出去」：出入口拿不到触发槽。

## 判据：**看哪个候选来源真的有这张图用到的槽**

不用猜「剧情上谁最可能拉它」。两步就定死：

1. 这张图的对象用到哪些槽 —— `talk` / `touch` 字段（导出时已减 `EVENT_SLOT_BIAS`）
2. 哪些图会 `goto_map` 它 —— 全库反查

在候选里挑**槽号能全部覆盖**的那一张。以 `MP2503A` 为例：它的出入口用**槽 11**，
三个候选中 `MP1013`（槽 9/10/18/33…，没有 11）、`MP1600A`（只有 9/10）都不满足，
**只有 `MP3001` 有槽 11** —— 唯一解。

13 张里 12 张能定出唯一来源；`MP2504` 两个候选但它一个槽都不用，取哪个都一样。

## 为什么做成独立产物而不是写进 map.json

写进 `map.json` 要重导地图；而这张表只有 13 行，独立成文件既省事，
也让「靠什么定的」有一个能回看的地方。与 `speakers.json` 同一套路。

用法:
    python3 export_script_sources.py <maps 目录> <out.json>
"""
from __future__ import annotations

import collections
import json
import sys
from pathlib import Path


def load_maps(root: Path) -> dict:
    out = {}
    for path in sorted(root.glob("*/map.json")):
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except Exception as err:                       # noqa: BLE001
            print(f"⚠ {path} 读不出来：{err}", file=sys.stderr)
            continue
        out[data.get("id") or path.parent.name] = data
    return out


def slots_used(meta: dict) -> set[int]:
    """这张图的对象要用到哪些事件槽。"""
    need = set()
    for obj in meta.get("objects") or []:
        for key in ("talk", "touch"):
            value = obj.get(key)
            if isinstance(value, int):
                need.add(value)
    return need


def main(argv: list[str]) -> int:
    if len(argv) != 2:
        print(__doc__, file=sys.stderr)
        return 1
    maps = load_maps(Path(argv[0]))
    if not maps:
        print("一张地图都没读到", file=sys.stderr)
        return 1

    launchers = collections.defaultdict(set)
    for mid, meta in maps.items():
        for actions in (meta.get("scripts") or {}).values():
            for act in actions:
                if act.get("type") == "goto_map":
                    launchers[str(act.get("map", "")).upper()].add(mid)

    table, unresolved = {}, []
    for mid, meta in sorted(maps.items()):
        if meta.get("scripts") or meta.get("events"):
            continue                                   # 自己有事件表
        need = slots_used(meta)
        cands = sorted(launchers.get(mid.upper(), set()))
        fits = [c for c in cands
                if need <= {int(k) for k in (maps[c].get("scripts") or {})}]
        if len(fits) == 1:
            table[mid] = fits[0]
        elif fits:
            # 一个槽都不用的过场图，取哪个都一样 —— 取字典序第一个，留个记录。
            table[mid] = fits[0]
            unresolved.append((mid, sorted(need), fits, "多个候选都能覆盖"))
        else:
            unresolved.append((mid, sorted(need), cands, "没有候选能覆盖"))

    Path(argv[1]).parent.mkdir(parents=True, exist_ok=True)
    Path(argv[1]).write_text(json.dumps({
        "生成自": "tools/export_script_sources.py",
        "说明": "没有 .EVE 的图 → 事件表向哪张图借。判据见工具文件头。",
        "来源": table,
    }, ensure_ascii=False, indent=1), encoding="utf-8")

    print(f"{len(table)} 张过场图定出来源 -> {argv[1]}")
    for mid, src in sorted(table.items()):
        print(f"    {mid:<10} → {src}")
    for mid, need, cands, why in unresolved:
        print(f"  ⚠ {mid}（用槽 {need}）{why}：{cands}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
