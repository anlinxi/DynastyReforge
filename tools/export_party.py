#!/usr/bin/env python3
"""从共享库导出主角、队友、以及 `set_avatar` 用的几个行走形象。

素材不在任何一张地图的归档里，而在 `Sys/Sys.dat`（145 条）。
**对应关系有两张正本表**，都是场景对象表那种格式（定长 551 字节，
见 tools/scene_table.py），只是坐标全为 0 —— 这些角色由剧情脚本决定
何时何地登场：

## `SUBNPC.SCI`（10 条）—— 剧情按名字点的事物

    隱形 → Hide.SF2   冰璃 → 2.SF2     封鈴笙 → 3.SF2
    慕容璇璣 → 4.SF2   古倫德 → 5.SF2   葛雲衣 → 6.SF2
    Exit → Exit.SF2   Recall → Recall.SF2   fly/land → …

`FieldScene` 那张手填的 `CUTSCENE_SPRITES` 就该由它生成。

## `MAINNPC.SCI`（5 条）—— **`set_avatar`（op68）的映射表，下标即代码**

    0 飛龍 Dragon.SF2 | 1 小夏侯儀 s1.SF2 | 2 dead 9.sf2
    3 大夏侯儀 1.SF2   | 4 霍雍 7.SF2

⚠️ **这张表此前完全没被用过。** 释义只给了一行文字枚举
（`00黑龙 01小夏侯仪 02夏抱冰 03大夏侯仪 04霍雍`），我们据此手填了
`AVATAR_SPRITES = {3: 'XIAHOUYI'}`，其余四个「没有判据」——
判据一直躺在这张表里。后果是**大地图上主角还是城镇里那个大形象**：
`s1.SF2` 帧宽高 `20×51`，`1.SF2` 是 `36×90`，**正好一半**。
全库 `set_avatar` 用 1（61 次，每一处「进大地图」）与 3（62 次，出大地图）。

**夏侯儀不在 `SUBNPC.SCI` 里**——他是主角。`MAINNPC.SCI` 第 3 条确认了
`大夏侯儀 → 1.SF2`，与此前「按编号推断 + 画面确认」的结论一致。

`Sys/Namelist.lis` 是角色名表，第一个就是夏侯儀，可作旁证。

产物除精灵外还有一份 `avatars.json`（两张表的内容），前端据它派人，
**不要再手填映射**。

用法:
    python3 export_party.py <Sys 目录> <输出目录> [--data <json 输出目录>]
"""
from __future__ import annotations

import argparse
import json
import sys
import tempfile
from pathlib import Path

import dat_unpack
import export_sprite
import scene_table

#: 资源键 -> Sys.dat 里的条目名。键名进 URL，故用 ASCII。
#: 名字是我们起的（表里是繁体），文件编号来自 `SUBNPC.SCI` / `MAINNPC.SCI`。
PARTY = {
    "XIAHOUYI": "1.SF2",       # 夏侯儀   MAINNPC[3] 大夏侯儀
    "BINGLI": "2.SF2",         # 冰璃
    "FENGLINGSHENG": "3.SF2",  # 封鈴笙
    "MURONGXUANJI": "4.SF2",   # 慕容璇璣
    "GULUNDE": "5.SF2",        # 古倫德
    "GEYUNYI": "6.SF2",        # 葛雲衣
    # ── set_avatar 的另外四个形象（MAINNPC.SCI）──────────────
    "XIAHOUYI_S": "s1.SF2",    # 小夏侯儀 —— **大地图上就是他**，20×51，只有大形象一半
    "FEILONG": "Dragon.SF2",   # 飛龍
    "XIAHOUYI_DEAD": "9.sf2",  # dead —— 夏侯仪抱着人的形象
    "HUOYONG": "7.SF2",        # 霍雍
}

#: 文件名（大写）-> 资源键。给两张 SCI 表反查用。
BY_FILE = {v.upper(): k for k, v in PARTY.items()}


def read_table(sys_dir: Path, name: str) -> tuple[scene_table.SceneObject, ...]:
    """读 `SUBNPC.SCI` / `MAINNPC.SCI`：共享角色的名字与精灵文件。

    ⚠️ **两张表在 `Sys.dat` 归档里，磁盘上没有同名文件。**
    先按归档找，找不到再看磁盘（有人手工解包过的话）。
    """
    archive = sys_dir / "Sys.dat"
    if archive.is_file():
        with archive.open("rb") as fh:
            for e in dat_unpack.read_entries(fh, archive.stat().st_size):
                if e.name.upper() == name.upper():
                    fh.seek(e.offset)
                    return scene_table.parse(fh.read(e.size))
    path = sys_dir / name
    return scene_table.parse(path.read_bytes()) if path.is_file() else ()


def sprite_key(sprite: str) -> str | None:
    """SCI 里记的精灵文件名 -> 我们的资源键。表里没有的返回 None。"""
    return BY_FILE.get(Path(str(sprite)).name.upper())


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("sys_dir")
    parser.add_argument("out_dir")
    parser.add_argument("--data", type=Path, default=None,
                        help="把两张 SCI 表写成 avatars.json 到这个目录")
    args = parser.parse_args(argv)

    sys_dir = Path(args.sys_dir)
    archive = sys_dir / "Sys.dat"
    if not archive.is_file():
        print(f"找不到共享库: {archive}", file=sys.stderr)
        return 1

    # ⚠️ **`MAINNPC.SCI` 的下标就是 `set_avatar` 的代码**，见文件头。
    avatars = {}
    names = {}
    for code, o in enumerate(read_table(sys_dir, "MAINNPC.SCI")):
        key = sprite_key(o.sprite)
        print(f"  set_avatar {code} = {o.name} -> {o.sprite} => {key or '（没导）'}")
        # ⚠️ **名字也要导。** 剧情脚本按**当前形象的名字**指主角：
        # 大地图上是 `actor_place{name:"小夏侯儀"}`（渡口过河就是这么写的），
        # 城里是 `大夏侯儀`。前端拿它判「这条指令推的是不是主角本人」，
        # 见 `cutscene.actorOf`。
        names[str(code)] = o.name
        if key:
            avatars[str(code)] = key
    cast = {}
    for o in read_table(sys_dir, "SUBNPC.SCI"):
        key = sprite_key(o.sprite)
        print(f"  SUBNPC: {o.name} -> {o.sprite} => {key or '（没导）'}")
        if key:
            cast[o.name] = key
    if args.data:
        args.data.mkdir(parents=True, exist_ok=True)
        (args.data / "avatars.json").write_text(
            json.dumps({"形象": avatars, "形象名": names, "共享角色": cast},
                       ensure_ascii=False, indent=1),
            encoding="utf-8")
        print(f"  -> {args.data / 'avatars.json'}")

    out_dir = Path(args.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    wanted = {v.upper(): k for k, v in PARTY.items()}

    with archive.open("rb") as fh, tempfile.TemporaryDirectory() as tmp:
        for entry in dat_unpack.read_entries(fh, archive.stat().st_size):
            key = wanted.get(entry.name.upper())
            if not key:
                continue
            fh.seek(entry.offset)
            staged = Path(tmp) / f"{key}.SF2"
            staged.write_bytes(fh.read(entry.size))
            result = export_sprite.export(staged, out_dir)
            print(f"  {key}: {result['frames'] if result else 0} 帧")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
