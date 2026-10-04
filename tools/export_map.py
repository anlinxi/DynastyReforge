#!/usr/bin/env python3
"""导出一张地图给前端使用：地面美术 + 碰撞网格 + 场景对象 + 事件对白。

产物:
    <out>/<图号>/ground.jpg      地面美术（原样拷出的 JPEG）
    <out>/<图号>/collision.png   逐像素通行掩码（R=255 可走）
    <out>/<图号>/occlusion.png   逐像素遮挡掩码（R=255 为该画在人物上方的美术）
    <out>/<图号>/map.json        尺寸、对象列表、按槽归好的台词

对象取自归档里的场景对象表 `NP場景001.SCI`（见 tools/scene_table.py），
它给出对象真名、坐标、各自的精灵文件，以及**该对象绑定的事件槽**。
台词按槽归组（见 tools/map_script.py 的 slot_dialogue），前端拿对象的
槽号直接取词即可，不需要再猜。

`.eve` 的 op11 放置表另存为 placements，那是过场动画里临时登场的对象，
与常驻的场景对象不是一回事。

通行与遮挡都**不降采样**，各导一张与地面等尺寸的 PNG，前端逐像素查。
两层的语义与编码见 tools/map_masks.py——那里也记着为什么不能再降采样。

用法:
    python3 export_map.py <地图归档.DAT> <输出目录>
"""
from __future__ import annotations

import argparse
import hashlib
import json
import struct
import sys
import tempfile
from pathlib import Path
from types import SimpleNamespace

import sf2
import sf2_anim
import eve_actions
import map_masks
import map_script as ms
import namelist
import scene_table
import walk_regions
import export_sprite
import dat_unpack

#: 逐像素掩码的文件名，与 map.json 里的字段值一致
#: 场景对象表的类型字段，5 才是人物（见 docs/专题/地图与场景.md）。
KIND_CHARACTER = 5

COLLISION_PNG = "collision.png"
OCCLUSION_PNG = "occlusion.png"
OP_PLACE_OBJECT = 11
NAME_FIELD = 16
UNSET = 0xFFFFFFFF

#: 出生点优先锚定到城门，与剧情一致
SPAWN_ANCHOR_KEYWORDS = ("城門", "城门")

#: **别的归档的脚本点名、本图判据又留不住的东西。**
#:
#: ⚠️ **这必须是表，不能靠命令行参数。** 参数只在打那一条命令时有效，
#: 一跑全量重导就全丢了 —— `MP0102B` 的 `EVENT-0`（开场那段起床动画）
#: 就是这么丢了一次：单独导时带了 `--also-objects` 是对的，
#: 隔天重导 310 张，床上又空了。
#:
#: ⚠️ **对象那半边已经撤掉了**（连同 `--also-objects`）：`collect_objects`
#: 现在一条 SCI 记录都不砍，这两条本来就是给那道判据打的补丁，判据没了补丁也该走。
#: **精灵这半边留着**当保险 —— 它只会多导，不会少导。
#:
#: | 图 | 要留什么 | 谁点的名 |
#: |---|---|---|
#: | `MP0102B` | `EVENT-0` —— 床上那床被子 + 掀被起床的 53 帧 | `MP0000` 槽 8（开场） |
#: | `MP2503A` | `EVENT1-8` —— 蝎子那段过场里的阿吉 | `MP3001` 槽 10 |
EXTRA_BY_MAP = {
    "MP0102B": {"sprites": ("EVENT-0",)},
    "MP2503A": {"sprites": ("EVENT1-8",)},
}


#: 散装补丁目录里**不要覆盖**的后缀。`.BAK` 是作者留的备份、`.DIF` 是差分，
#: 名字撞不上归档条目，列出来只是为了说清「我们看过它们、故意不要」。
PATCH_SKIP_SUFFIX = frozenset({".BAK", ".DIF"})


def load_patch(archive: Path) -> dict[str, bytes]:
    """**官方后来的散装补丁**：`Map/<图号>/` 目录里与归档条目同名的文件。

    ## 为什么要有它

    `multimedia/Map/` 下**同时**有 `mp0302.DAT`（归档）与 `mp0302/`（目录）。
    我们原先只读归档，而三条证据说明**散装那份才是游戏实际用的**：

    | 证据 | |
    |---|---|
    | 日期 | 归档 `2001-11-01`，散装 `.EVE`/`.msg` 多是 `2001-11-06/07`，一直延到 2002-03 |
    | 只有散装的图 | **21 张没有 DAT**（含官方存档 `Save010` 所在的 `MP1001D1`）—— 游戏一定会读目录 |
    | 内容 | `.EVE` 111 张不同、`.MSG` 114 张、`.SCI` 74 张不同 + 98 个归档里没有 |

    最硬的一条来自玩家实测：迦夏之窟三根柱子是复制粘贴的，
    放错石球该掉血（`0x7D heal_points`），可**归档版第三根写成了
    `0x7E item_gain`**（于是不掉血，还往背包里塞一件代码 −46 的空物品），
    而**散装版是 `0x7D`**。这说明散装目录就是官方的修正补丁。

    ## 为什么是「覆盖」而不是「换数据源」

    散装目录里**只有脚本、对白、对象表**（全库 `.EVE` 322 / `.MSG` 319 /
    `.SCI` 193，外加零星 `.SF2`），**没有任何美术** —— 地面 JPG、MB/MK 掩码、
    精灵全在 DAT 里。所以两份都要读：美术走归档，同名文件走补丁。

    判据是**文件名撞上**，不是后缀白名单 —— 归档里没有的（`mp0302.mdt`、
    `Np0.sci`）自然就落不进来，不需要我们去判断「哪些该覆盖」。

    :returns: `{大写文件名: 字节}`，没有目录就是空字典
    """
    d = archive.parent / archive.stem
    if not d.is_dir():                      # 大小写不定：`mp0302/` vs `MP0302/`
        d = next((c for c in archive.parent.iterdir()
                  if c.is_dir() and c.name.upper() == archive.stem.upper()), None)
    if d is None or not d.is_dir():
        return {}
    out = {}
    for f in sorted(d.iterdir()):
        if not f.is_file() or f.suffix.upper() in PATCH_SKIP_SUFFIX:
            continue
        out[restore_big5_name(f.name).upper()] = f.read_bytes()
    return out


def restore_big5_name(name: str) -> str:
    """散装补丁的中文文件名还原成 Big5 读法。

    原作文件名是 Big5 字节，在 macOS/Linux 上解压时常被按 GB18030 解码：
    `NP新圖001.SCI` 变成 `NP穝瓜001.SCI`，与归档条目对不上，补丁悄悄失效。
    2026-09-28 查出 97 个对象表因此从未生效，其中 42 个（41 张图）内容与归档版不同；
    另有 `皇甫申.SF2` 等 5 个只在散装目录里的精灵同样认不出。

    判据：正常的 Big5 文件名一定能编回 Big5；编不回、而按 GB18030 编回字节再按 Big5
    解得通的才是乱码。反过来对正常名字硬还原会得到「縫綰菁釱」这类乱码，所以必须先判。
    """
    if name.isascii():
        return name
    try:
        name.encode("big5")
        return name
    except UnicodeEncodeError:
        pass
    try:
        return name.encode("gb18030").decode("big5")
    except (UnicodeEncodeError, UnicodeDecodeError):
        return name


def make_reader(fh, patch: dict[str, bytes]):
    """取某条归档记录的字节，**同名的散装补丁优先**。见 `load_patch`。"""
    used = set()

    def read(entry) -> bytes:
        hit = patch.get(Path(entry.name).name.upper())
        if hit is not None:
            used.add(entry.name.upper())
            return hit
        fh.seek(entry.offset)
        return fh.read(entry.size)

    read.used = used
    return read


#: 地图级 `MPMP<图号>.SCI` 里 BGM 编号的偏移。出处是社区文档
#: 《剧情代码释义.txt》，在本项目四张图上核对过：兰州城 4、药铺 3、
#: 客栈 3、大地图 1——店铺共用一曲，合语义。曲目文件见 tools/export_music.py。
OFF_MAP_BGM = 0x331


#: 地图级 `MPMP<图号>.SCI` 里三条资源路径的偏移。出处是 CastleScript 的
#: `SCI.cs`（`bgpath` / `mkpath` / `mbpath`），值形如 `MP3001\\mb3001.SF2`。
OFF_MAP_GROUND, OFF_MAP_MK, OFF_MAP_MB = 0x74, 0xD9, 0x13D
#: 同一条记录里**对象表**的路径（`SCI.cs` 的 `EventSCIPath`）。
#: 89 个归档有多个非 `MP` 开头的 `.SCI`，靠它点名才知道该用哪个 ——
#: 详见 `scene_table.pick_entry`。
OFF_MAP_ESCI = 0x205
#: 地返遁符可用标志。RPG.exe 0x40ced7 经 0x40ae50/0x40a0d0 读当前图 SCI+0x384，
#: 为 1 执行事件3（本图槽1），为 0 提示共享语「此處地脈紊亂，無法乘之遁挪。」
OFF_MAP_RETURN_CHARM = 0x384


def pick_named(entries, stem: str, ext: str):
    """归档内同扩展名的条目里优先取与图号同名者。

    MP1608 归档另含 MP1602.EVE/MSG；按出现顺序取第一个会把别图脚本导进来（MAP-12）。
    """
    same = [e for e in entries if Path(e.name).suffix.upper() == ext]
    return next((e for e in same if Path(e.name).stem.upper() == stem.upper()), same[0] if same else None)


def return_charm(map_sci: bytes | None) -> bool:
    """地图级 SCI 的地返遁符标志；读不到按不可用。"""
    if not map_sci or len(map_sci) < OFF_MAP_RETURN_CHARM + 4:
        return False
    return struct.unpack_from("<i", map_sci, OFF_MAP_RETURN_CHARM)[0] != 0
#: 路径字段的长度上限（下一个字段的偏移之差）。
MAP_PATH_LEN = 100


def read_map_path(sci: bytes | None, off: int) -> str | None:
    """地图级 SCI 里记的某条资源路径 -> 文件名（大写）。"""
    if not sci or len(sci) <= off:
        return None
    raw = sci[off:off + MAP_PATH_LEN].split(b"\0")[0]
    text = raw.decode("big5", errors="replace").replace("\\", "/").strip()
    return text.rsplit("/", 1)[-1].upper() or None


def pick_by_sci(entries: list, want: str | None, fallback: list):
    """**优先用地图级 SCI 点名的那个文件。**

    ⚠️ 这一条查了三轮才查对。归档里同一类文件常有好几个，先前是靠
    「名字里含本图图号」去猜，还在注释里写死了一句**错的**推断——
    「`MB0605-1/-2/-3` 与 `MB3001-01` 这些带后缀的分层文件才是实际在用的」。

    实情：`Mp3001` 的 SCI 写的是 `mb3001.SF2`，而 `MB3001-01.SF2`
    **画满了 67% 的像素**（正常 MB 是 2.4% 的轮廓线）。取错的后果是
    大地图可走区从 97.6% 缩成 32.9%，**六座城镇的进城触发线一条都踩不到**
    （它们 0% 落在可走区上）—— 玩家在城外怎么走都进不去。

    判据就在原始数据里：`SCI.cs` 的 `bgpath`/`mkpath`/`mbpath`。
    全库 322 张有 MB 的图里，按图号猜与 SCI 点名的**有 21 张不一致**。
    SCI 没写或写的文件不在归档里（9 张）才退回原来的猜法。
    """
    if want:
        hit = next((e for e in entries if e.name.upper() == want), None)
        if hit:
            return hit
    return (fallback or [None])[0]


def read_bgm(sci: bytes | None) -> int | None:
    """地图级 SCI 里记的 BGM 编号；没有这张表或编号为 0 时返回 None。"""
    if not sci or len(sci) <= OFF_MAP_BGM:
        return None
    return sci[OFF_MAP_BGM] or None


def _compose(sf2_data: bytes) -> tuple[int, int, list[int]]:
    """SF2 字节 -> (宽, 高, 像素)。"""
    header = sf2.parse_header(sf2_data)
    images = sf2.read_images(sf2_data, header)
    composed = sf2.compose_image(images[0], sf2.read_tiles(sf2_data, header), header)
    # tile 网格是向上取整的，掩码必须裁回真实尺寸，否则地图边缘多出一条
    # 没有数据却能走进去的带子。见 sf2.crop_to_real。
    return sf2.crop_to_real(images[0], *composed)


def pick_spawn(mask: walk_regions.WalkMask,
               objects: tuple[scene_table.SceneObject, ...],
               region: int | None = None,
               origin: tuple[int, int] = (0, 0)) -> tuple[int, int] | None:
    """出生点：城门内侧，且必须落在**可走**的那个连通块里。

    这一步不能省。mp0212 的可通行区被城墙分成主城 68.7%、南门外 10.1%、
    废屋后巷 16.4% 三块，随手指定坐标很容易掉进走不出去的小块——
    先前写死的 (400,520) 就落在废屋后巷，导致 23 个对象里 22 个走不到。

    ⚠️ **两处坐标系换算，缺一个出生点就落在墙里**：

    1. `region` 要用**票选出来的那一块**，不是 `mask.main_region`（面积最大）。
       内景图的黑背景比地板大，取最大会把人生在屋外。
    2. `mask` 是 MB 自己的坐标系，比地面小、还带原点偏移（见 `fit_mask`）。
       传进去的对象坐标要**减** origin，返回的结果要**加**回去。

    这两条 2026-09-05 之前都错着，表现是「出生点落在不可走处」——
    然后 `FieldScene.findOpenSpot` 把人推到最近的可走点，于是
    「进屋再出来不是同一个地方」。
    """
    region = region or mask.main_region
    if not region:
        return None

    ox, oy = origin
    gates = [o for o in objects
             if any(k in o.name for k in SPAWN_ANCHOR_KEYWORDS)]
    centre = (mask.width // 2, mask.height // 2)
    spot = None
    for gate in gates:
        spot = walk_regions.spawn_near(mask, (gate.x - ox, gate.y - oy), region, centre)
        if spot:
            break
    if not spot:
        spot = walk_regions.spawn_near(mask, centre, region, centre)
    return (spot[0] + ox, spot[1] + oy) if spot else None


def collect_placements(eve_data: bytes) -> list[dict]:
    """从 .eve 取出 op11 的对象放置表（过场动画里临时登场的对象）。"""
    out = []
    for _, code, payload in ms.instructions(eve_data):
        if code != OP_PLACE_OBJECT or len(payload) < NAME_FIELD + 12:
            continue
        name = payload[:NAME_FIELD].split(b"\0")[0].decode("big5", errors="replace")
        _, x, y = struct.unpack_from("<3I", payload, NAME_FIELD)
        if x == UNSET or y == UNSET:
            continue
        out.append({"name": name, "x": x, "y": y})
    return out


def collect_objects(sci_data: bytes) -> list[dict]:
    """场景对象表 -> 前端要的对象列表。**一条不砍。**

    ## ⚠️ 这里曾经按「没起名 + 不可交互 + 静态 → 不导」砍掉全库 1207 条

    理由写着「静态布景已经烘焙进地面 JPG，再画一遍会重影」。
    **那条理由把结论弄反了。** 判据是逐像素量出来的：

    > **一个精灵如果和底图同位置逐像素相同，它就不是布景，是遮挡物。**

    集市那把凉棚 `nn0401b-34`（252×113）按
    `对象(x,y)+绘制偏移(dx,dy)+图层(ox,oy)` 摆到底图上，13865 个不透明像素
    **平均色差 2.6/255**（JPEG 噪声量级）。一张和底图完全一样的切片，
    唯一可能的用途就是**在角色走到它后面时重画在角色上方** ——
    这正是原作遮挡的另一条腿，另一条是 MK 层。

    砍掉它们的后果就是玩家看到的那些：集市的伞不挡人、城墙不挡人
    （`nn0401a-01/02` 渲出来正是那道石阶）、待办里挂着的「部分木柱不挡人」
    （`nn0401b-04…b-21` 那一串 19×40 的就是棚子的柱）。

    全库体检 `tools/occluder_audit.py`，判据表 `docs/判据/遮挡物体检.md`：
    1207 条里 1002 条与底图吻合，**不吻合的不等于不该画** ——
    `MP0203` 的 `NP001/NP002` 是站在那儿的人，本来就没烘进底图。
    原委见 `docs/专题/通行与遮挡.md`。

    ⚠️ 「会动的必须留下」那条老判据现在是这条的子集，但别把它忘了：
    兰州城门口那两匹马（`0201N001C.SF2`，没起名、没挂事件、1→70 帧循环）
    和 `MP0102B` 床上那床被子（`EVENT-0.SF2`，被 `MP0000` 槽 8 推到帧 52
    演掀被起床）都曾经这么丢过。
    """
    out = []
    for o in scene_table.parse(sci_data):
        entry = {
            "name": o.name,
            "x": o.x,
            "y": o.y,
            "sprite": scene_table.sprite_key(o.sprite),
            # 绘制偏移与显隐/交互/播放段 —— 全部来自 SCI 的原始字段，
            # 不再靠「kind 是不是 5」「贴图大不大」去猜。见 scene_table 的常量。
            "dx": o.dx, "dy": o.dy,
            "showWithMap": o.show_with_map,
            "mouse": o.mouse,
            "hide": o.hide,
            "entrance": o.entrance,
            "dirs": o.directions,
            "shadow": o.shadow,
            "frames": [o.frame_start, o.frame_end],
            # **存在与否由剧情旗标决定**（`SCI.cs` 的 `FlagOffset`，见
            # scene_table.OFF_FLAG）。`flag != 0` 时，只有存档里
            # `0xE179 + flag*2` 处为 1 才该出现。
            # 例：兰州城 `badguy` 是 1227，卖完羊皮封卷那一槽 `set_flag 1227=0`；
            # 城里 `其餘士兵A/B/C` 是 1025，废屋剧情结束时一起关掉。
            **({"flag": o.flag} if o.flag else {}),
            **({"range": [o.range_x, o.range_y]} if o.range_x or o.range_y else {}),
            "kind": o.kind,
            "facing": o.facing,
        }
        if o.talk_event:
            entry["talk"] = o.talk_event
        if o.touch_event:
            entry["touch"] = o.touch_event
        out.append(entry)
    return out


def export_sprites(read, entries: list, out_dir: Path) -> None:
    """把归档里的场景精灵解出来交给 export_sprite 逐帧导出。

    export_sprite 只认磁盘文件，所以先把条目落到临时目录再交给它。

    :param entries: `[(归档条目, 资源键)]` —— 键由调用方给，
        因为它要与 `map.json` 的 `sprites`、`scene_table.sprite_key` 完全一致
        （**带图号前缀**，理由见 `sprite_key` 的文档）。
    """
    out_dir.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory() as tmp:
        for entry, key in entries:
            # ⚠️ 临时文件名**就是资源键** —— `export_sprite` 按 `src.stem`
            # 命名输出目录与图集，所以键名必须在这一步定下来。
            path = Path(tmp) / f"{key}.SF2"
            path.write_bytes(read(entry))
            result = export_sprite.export(path, out_dir)
            print(f"  精灵 {path.stem}: {result['frames'] if result else 0} 帧")


def jpeg_size(blob: bytes) -> tuple[int, int] | None:
    """从 JPEG 字节流读出宽高。**不引第三方库** —— 这个工具只依赖标准库。

    做法是扫 SOF 段（`FFC0`~`FFCF`，跳过 `FFC4` 霍夫曼表与 `FFC8`/`FFCC`）。
    """
    i = 2
    while i + 9 < len(blob):
        if blob[i] != 0xFF:
            i += 1
            continue
        marker = blob[i + 1]
        if 0xC0 <= marker <= 0xCF and marker not in (0xC4, 0xC8, 0xCC):
            height = int.from_bytes(blob[i + 5:i + 7], "big")
            width = int.from_bytes(blob[i + 7:i + 9], "big")
            return (width, height) if width and height else None
        if marker in (0xD8, 0x01) or 0xD0 <= marker <= 0xD7:
            i += 2
            continue
        i += 2 + int.from_bytes(blob[i + 2:i + 4], "big")
    return None


def layer_origin(sf2_data: bytes) -> tuple[int, int]:
    """图层在地图坐标系里的左上角。**不是恒为 (0,0)。**

    ⚠️ **漏读它 = 整张遮挡图错位。** MB/MK 的 tile 网格只覆盖「这一层真有
    内容」的那块包围盒，它摆在地图上的哪个位置写在 SF2 的**帧图层记录**里
    （`sf2_anim.parse_frames` 的 `layers[0].x/y`），与精灵的 `ox/oy` 同一个
    字段。593 个 MB/MK 图层里 15 个非零，`mp0202` 客栈是 (235,112)。

    按 (0,0) 铺的后果**不报错、只是画面不对**：客栈的遮挡整体左上移 235×112，
    二楼栏杆与屏风的遮挡被平移到一楼庭院，站在庭院里的人腰部以下被「地面」
    抹掉，看着像半截人。demo 九张图里只有 `mp0202` 中招，外景图偏移都是 0，
    所以这个坑藏了很久。
    """
    header = sf2.parse_header(sf2_data)
    frames = sf2_anim.parse_frames(sf2_data, header)
    if not frames or not frames[0].layers:
        return (0, 0)
    layer = frames[0].layers[0]
    return (int(layer.x), int(layer.y))


def fit_mask(bits, src_w: int, src_h: int, dst_w: int, dst_h: int,
             origin: tuple[int, int] = (0, 0)):
    """把掩码铺到 `dst_w × dst_h` 的画布上，**按 `origin` 落位**，其余补 0。

    源超出目标的部分裁掉（不该发生，但别崩）。原点为 (0,0) 且尺寸相同时
    原样返回。原点的来历见 `layer_origin`。
    """
    ox, oy = origin
    if (src_w, src_h) == (dst_w, dst_h) and (ox, oy) == (0, 0):
        return bits
    out = bytearray(dst_w * dst_h)
    for y in range(src_h):
        dy = y + oy
        if not 0 <= dy < dst_h:
            continue
        start = max(0, -ox)
        end = min(src_w, dst_w - ox)
        if start >= end:
            continue
        out[dy * dst_w + ox + start: dy * dst_w + ox + end] = \
            bits[y * src_w + start: y * src_w + end]
    return bytes(out)


def refresh_dialogue(archive: Path, map_file: Path) -> dict:
    """只重导MSG文字；不重导地图美术、碰撞或改动EVE逻辑。支持仅有散装源的图。"""
    import re
    blobs = load_patch(archive)
    if archive.exists():
        with archive.open("rb") as fh:
            entries = dat_unpack.read_entries(fh, archive.stat().st_size)
            read = make_reader(fh, blobs)
            blobs = {**blobs, **{Path(e.name).name.upper(): read(e) for e in entries
                                if Path(e.name).suffix.upper() in (".EVE", ".MSG")}}
    stem = archive.stem.upper()
    eve = blobs.get(f"{stem}.EVE") or next((v for k, v in blobs.items() if k.endswith(".EVE")), None)
    msg = blobs.get(f"{stem}.MSG") or next((v for k, v in blobs.items() if k.endswith(".MSG")), None)
    meta = json.loads(map_file.read_text(encoding="utf-8"))
    if not eve or not msg:
        if meta.get("scripts") or meta.get("events"):
            raise ValueError(f"{map_file}: 有运行脚本但未找到官方EVE/MSG")
        return meta
    scripts = {str(k): [a.to_dict() for a in v] for k, v in eve_actions.slot_actions(eve, msg).items()}
    events = {str(k): [a.to_dict() for a in v] for k, v in ms.slot_dialogue(eve, msg).items()}
    plain = lambda t: re.sub(r"=[br0]", "", t)
    def update(old, new):
        if isinstance(old, dict):
            for key, value in old.items():
                if key == "text" and isinstance(value, str):
                    candidate = new[key]
                    if plain(value) != plain(candidate):
                        raise ValueError(f"{map_file}: 正文也发生变化，停止仅颜色重导: {value!r} -> {candidate!r}")
                    old[key] = candidate
                elif key in new:
                    update(value, new[key])
        elif isinstance(old, list):
            if len(old) != len(new):
                raise ValueError(f"{map_file}: 脚本条数变化，停止仅文字重导")
            for left, right in zip(old, new):
                update(left, right)
    update(meta.get("scripts", {}), scripts)
    update(meta.get("events", {}), events)
    if "shared" in meta:
        shared = list(ms.message_sentences(msg).get(0) or ())[:len(meta["shared"])]
        if list(map(plain, shared)) != list(map(plain, meta["shared"])):
            raise ValueError(f"{map_file}: 共享提示语正文变化")
        meta["shared"] = shared
    return meta


def refresh_scripts(archive: Path, map_file: Path) -> dict:
    """重解EVE动作并写入地返标志；只允许「unknown→新解出的指令」，其余差异即停。"""
    blobs = load_patch(archive)
    if archive.exists():
        with archive.open("rb") as fh:
            entries = dat_unpack.read_entries(fh, archive.stat().st_size)
            read = make_reader(fh, blobs)
            blobs = {**blobs, **{Path(e.name).name.upper(): read(e) for e in entries
                                if Path(e.name).suffix.upper() in (".EVE", ".MSG", ".SCI")}}
    meta = json.loads(map_file.read_text(encoding="utf-8"))
    header = next((v for k, v in blobs.items() if k.startswith("MPMP") and k.endswith(".SCI")), None)
    meta["returnCharm"] = return_charm(header)
    # MP1608 归档里另有 MP1602.EVE/MSG；与图号同名者优先。
    stem = archive.stem.upper()
    pick = lambda ext: blobs.get(f"{stem}{ext}") or next(
        (v for k, v in blobs.items() if k.endswith(ext)), None)
    eve, msg = pick(".EVE"), pick(".MSG")
    if not eve or not msg:
        return meta
    fresh = {str(k): [a.to_dict() for a in v] for k, v in eve_actions.slot_actions(eve, msg).items()}
    old = meta.get("scripts", {})
    if set(old) != set(fresh):
        raise ValueError(f"{map_file}: 脚本槽集合变化，停止仅脚本重导")
    for slot, actions in old.items():
        if len(actions) != len(fresh[slot]):
            raise ValueError(f"{map_file}: 槽{slot}条数变化")
        for i, (a, b) in enumerate(zip(actions, fresh[slot])):
            # 已解指令只允许新增字段（如 actor_walk.mode），原有字段一律不许变。
            grown = a.get("type") != eve_actions.UNKNOWN and all(b.get(k) == v for k, v in a.items())
            if a != b and a.get("type") != eve_actions.UNKNOWN and not grown:
                raise ValueError(f"{map_file}: 槽{slot}#{i}已解指令发生变化 {a} -> {b}")
            actions[i] = b
    return meta


def refresh_object_flags(archive: Path, map_file: Path) -> dict:
    """只补 SCI 的通行字段；保留现有精灵别名、对白与地图美术。"""
    meta = json.loads(map_file.read_text())
    with archive.open('rb') as fh:
        entries = dat_unpack.read_entries(fh, archive.stat().st_size)
        read = make_reader(fh, load_patch(archive))
        header = next((e for e in entries if e.name.upper().startswith('MPMP')
                       and e.name.upper().endswith('.SCI')), None)
        raw = read(header) if header else None
        entry = scene_table.pick_entry(entries, read_map_path(raw, OFF_MAP_ESCI))
        objects = scene_table.parse(read(entry)) if entry else ()
    old = meta.get('objects', [])
    if len(old) != len(objects) or any(a['name'] != b.name for a, b in zip(old, objects)):
        raise ValueError(f'{map_file}: 对象表顺序不一致，不修改')
    for target, source in zip(old, objects):
        target['entrance'] = source.entrance
    return meta


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("archive")
    parser.add_argument("out_dir")
    parser.add_argument("--object-flags-only", action="store_true", help="仅刷新已有 map.json 的 SCI 通行字段")
    parser.add_argument("--text-only", action="store_true", help="仅从官方MSG刷新已有map.json的对白文字")
    parser.add_argument("--scripts-only", action="store_true",
                        help="仅重解已有map.json的脚本（只接受unknown→新解指令）并写入地返标志")
    parser.add_argument("--sprite-dir", help="同时把用到的场景精灵导到该目录")
    parser.add_argument("--sys", help="Sys.dat 路径，用于把人物代码翻成姓名")
    parser.add_argument("--also-sprites", default=None,
                        help="额外要导的精灵名，逗号分隔。用于**别的归档的脚本**点名的"
                             "素材（如 MP0102B 的 EVENT-0，点它的是 MP0000 的槽 8）")
    parser.add_argument("--stand-points", type=Path, default=None,
                        help="落脚点表（tools/collect_stand_points.py 的产物）。"
                             "**强烈建议带上** —— 不带的话内景图的可走区很可能选错")
    args = parser.parse_args(argv)

    archive = Path(args.archive)
    stem = archive.stem.upper()
    if args.object_flags_only:
        target = Path(args.out_dir) / stem / "map.json"
        meta = refresh_object_flags(archive, target)
        target.write_text(json.dumps(meta, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
        return 0
    if args.scripts_only:
        target = Path(args.out_dir) / stem / "map.json"
        meta = refresh_scripts(archive, target)
        target.write_text(json.dumps(meta, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
        return 0
    if args.text_only:
        target = Path(args.out_dir) / stem / "map.json"
        meta = refresh_dialogue(archive, target)
        target.write_text(json.dumps(meta, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
        return 0
    stand_points = {}
    if args.stand_points:
        if not args.stand_points.exists():
            print(f"落脚点表不在：{args.stand_points}"
                  f"（跑 tools/collect_stand_points.py 生成）", file=sys.stderr)
            return 1
        stand_points = json.loads(args.stand_points.read_text(encoding="utf-8"))
    out_dir = Path(args.out_dir) / stem
    out_dir.mkdir(parents=True, exist_ok=True)

    with archive.open("rb") as fh:
        entries = dat_unpack.read_entries(fh, archive.stat().st_size)

        # ⭐ **官方后来的散装补丁优先** —— 见 `load_patch` 的判据。
        # 迦夏之窟最左那根柱子放错石球不掉血，成因就是归档版把
        # `0x7D heal_points` 写成了 `0x7E item_gain`，而补丁版是对的。
        patch = load_patch(archive)
        read = make_reader(fh, patch)
        # 只在散装目录里的精灵也要算进来：对象表（多为补丁版）点名的 `SAVE.SF2`、`OOH.SF2`、
        # `皇甫申.SF2` 等在 21 张图里只有散装一份，不收的话这些对象永远没有素材
        # （MP2409L1 的 ND0701-03 即此）。其他只在补丁里的文件照旧不收，见 `load_patch`。
        known = {e.name.upper() for e in entries}
        entries = list(entries) + [SimpleNamespace(name=k, size=len(v), offset=0)
                                   for k, v in patch.items() if k not in known and k.endswith(".SF2")]

        by_suffix = {}
        for e in entries:
            by_suffix.setdefault(Path(e.name).suffix.upper(), []).append(e)

        # ⚠️ **地图级 SCI 要最先读** —— 地面、MK、MB 用哪个文件由它说了算
        # （`SCI.cs` 的 `bgpath`/`mkpath`/`mbpath`），见 `pick_by_sci`。
        map_sci = next((e for e in entries if e.name.upper().startswith("MPMP")
                        and e.name.upper().endswith(".SCI")), None)
        map_sci_bytes = read(map_sci) if map_sci else None

        jpgs = [e for e in by_suffix.get(".JPG", []) if e.name.upper().startswith("MP")]
        ground_path = read_map_path(map_sci_bytes, OFF_MAP_GROUND)
        # 没有 MP 开头的 JPG 时按 SCI 点名在全部 JPG 里找：MP1704 点的地面叫 `MB1704.JPG`
        # （640×576），原先被前缀过滤掉，整张图没有地面（MAP-03）。有 MP 候选的图维持原取法 ——
        # 另有 8 张 SCI 点名 CLOUD/BG 背景层的多层图（楼兰、观星楼、MP2410），要按分层画法另查。
        jpg = pick_by_sci(jpgs, ground_path, jpgs) or pick_by_sci(by_suffix.get(".JPG", []), ground_path, [])
        mks = [e for e in entries if e.name.upper().startswith("MK")]
        mk = pick_by_sci(mks, read_map_path(map_sci_bytes, OFF_MAP_MK), mks)
        eve = pick_named(entries, stem, ".EVE")

        # ⚠️ **没有地面美术不等于这个归档没用。**
        # `MP0000` 就是一个**纯共享事件文件**：没有 `.JPG`、没有 MB/MK，
        # 只有 `.EVE`（3 个槽，含**开场剧情**：片头影片 → 梦境 → 妈妈叫起床
        # → 交代送鸡汤）、`.MSG`（对白池）与一条 `GameOver.SF2` 记录。
        # 这里原先直接 `return 1`，于是整个开场从来没被导出来过。
        #
        # 没有地面就只导「与画面无关」的那半边：objects / events / scripts /
        # placements。前端把它当**全局脚本库**用，不当地图进。
        ground_size = None
        meta = {"id": stem, "returnCharm": return_charm(map_sci_bytes)}
        if jpg:
            blob = read(jpg)
            end = blob.rfind(b"\xff\xd9")
            ground_bytes = blob[: end + 2] if end > 0 else blob
            (out_dir / "ground.jpg").write_bytes(ground_bytes)
            # ⚠️ **地面美术的尺寸就是地图的坐标系。** 掩码必须铺到这个尺寸上 ——
            # 详见下面写掩码那一段的说明。
            ground_size = jpeg_size(ground_bytes)
            meta["ground"] = "ground.jpg"
        else:
            print("没有地面美术 —— 当作纯事件归档导（只出 scripts / events / objects）")

        # 本图的背景音乐编号，见 OFF_MAP_BGM
        bgm = read_bgm(map_sci_bytes)
        if bgm is not None:
            meta["bgm"] = bgm
            print(f"背景音乐 曲目 {bgm}")

        msg = pick_named(entries, stem, ".MSG")
        # ⭐ **对象表按地图级 SCI 的 `0x205` 点名挑**（`SCI.cs` 的 `EventSCIPath`），
        # 不是"取第一个" —— 89 个归档有多个对象表，取第一个会让 6 张图取错
        # （`MP1007C` 的第一个压根是张 SF2 图，整张图导不出来）。判据见 `pick_entry`。
        sci = scene_table.pick_entry(
            entries, read_map_path(map_sci_bytes, OFF_MAP_ESCI))
        objects = scene_table.parse(read(sci)) if sci else ()

        # 碰撞用 MB（物件在地面上的占地），MK 是遮挡层，见 tools/map_masks.py
        #
        # ⚠️ **一个归档里可能有好几个 `MB*`，用哪个由地图级 SCI 说了算**
        # （`SCI.cs` 的 `mbpath`，偏移 0x13D）。理由与判据见 `pick_by_sci`。
        # 退回来的猜法（名字里含本图图号）只在 SCI 没写时用。
        stem_num = stem[2:] if stem.upper().startswith("MP") else stem
        mbs = [e for e in entries if e.name.upper().startswith("MB")
               and e.name.upper().endswith(".SF2")]
        same = [e for e in mbs if stem_num.upper() in e.name.upper()]
        collide = pick_by_sci(mbs, read_map_path(map_sci_bytes, OFF_MAP_MB), same or mbs)
        if collide and mbs and collide is not mbs[0]:
            print(f"⚠ 归档里有 {len(mbs)} 个 MB，用了 {collide.name}"
                  f"（第一个是 {mbs[0].name}）")
        if collide:
            collide_bytes = read(collide)
            collide_origin = layer_origin(collide_bytes)
            mask = walk_regions.analyse(*_compose(collide_bytes))
            # ⚠️ **面积最大的连通块不一定是可走地面** —— 内景图里房间外那一大片
            # 黑背景是一整块，比房间地板还大。选错的表现是「地板走不了、
            # 黑背景能走」，而且一点都不报错。`MP0102B`（夏侯仪房间，原作起点）
            # 就是这么变成走不出门的。
            #
            # 判据是**人物确实站在那里的坐标**投票，来源见
            # `tools/collect_stand_points.py`：官方存档的主角坐标、别的图
            # `goto_map` 进来的落点、剧情里 `actor_show`/`actor_walk` 的坐标、
            # ⚠️ ⚠️ **可走 = MB 上没画东西的像素。就这一条。**
            #
            # 这里曾经做「连通域分析 → 按落脚点票选出一块 → 只留那一块」。
            # **那不是原作的机制，是我们的补丁**，而且补丁的前提已经没了：
            # 它存在的理由是「移动判定拦不住线」—— 早先前端只测目标像素，
            # 4~6px 的障碍线一步就跨过去，只好靠「只有这一块能走」把人关住。
            # 2026-09-06 前端换成逐像素扫掠（`FieldScene.slideAxis`）之后，
            # 线本身就挡得住人了。
            #
            # 拿数据验过（判据是「玩家进图后实际能走到多大范围」，
            # 这是能直接量的事实，不含任何推断）：
            #
            # | 图 | 票选那一块 | 非障碍+不许穿线，从落点实际可达 | 全部非障碍 |
            # |---|---|---|---|
            # | MP0105 药铺 |  7.7% |  **7.7%** | 98.2% |
            # | MP0202 客栈 | 28.4% | **28.4%** | 96.5% |
            # | MP0603     | 15.9% | **15.9%** | 98.4% |
            # | MP0102B 房间| 75.8% | **75.8%** | 97.4% |
            # | MP0201A 主街| 64.2% | **64.2%** | 93.2% |
            # | MP0101 河州镇| 89.5% | **89.5%** | 97.5% |
            # | **MP3001 大地图**| 30.3% | **32.9%** | 32.9% |
            #
            # **每一张图，实际可达都恰好等于票选出来的那一块** —— 线本来就是
            # 闭合的，玩家自然被围住，不需要谁去"选"。选块唯一的作用是把
            # 玩家**不在**的那些块整个删掉，而那是有害的：大地图南边的整片
            # 路网就是这么没的（30.3% vs 32.9%），河州镇出口周围因此全黑，
            # **人一出城就四个方向全动不了**。
            #
            # 选块还是三次「选错块」事故的共同成因：MP0102B 走不出第一个房间、
            # MP0102D 书房卡死、MP0105 药铺卡死。判据（投票）本身就没有依据。
            #
            # 于是 `collect_stand_points.py` / `region_by_votes` /
            # `--stand-points` 全部退役 —— 保留只为诊断，不再参与导出。
            bits = map_masks.walkable_bits(mask)
            # ⚠️ **掩码必须与地面美术同尺寸，否则整张图的通行判定都是错位的。**
            #
            # 两件事会让 MB 比地面小：
            #   ① `sf2.crop_to_real` 把它裁到 MB 自己有内容的范围
            #      （药铺 832×624 → 795×577、兰州城 3840 → 3832）；
            #   ② 有些图的 MB **tile 网格本身**就比地面小
            #      （废屋 MB 11×12 块 = 704×576，地面 13×13 块 = 832×624）。
            #
            # 前端按地面坐标查掩码，尺寸对不上就整体错位 —— 表现正是
            # 「地板走不了，反而能走到墙上和画面外的黑边里」。
            # 补出来的边一律判**不可走**：那些地方要么是 MB 没标到的画外区，
            # 要么就是室内图四周的黑边，两种都不该走进去。
            width, height = ground_size or (mask.width, mask.height)
            bits = fit_mask(bits, mask.width, mask.height, width, height,
                            collide_origin)
            map_masks.write_mask_png(out_dir / COLLISION_PNG, width, height, bits)
            # ⚠️ **掩码要带版本号，否则重导之后浏览器还拿着旧的。**
            # `collision.png` 是 `public/` 下的静态资源，路径不变、内容变了，
            # 浏览器照旧走缓存 —— 我自己就在验证时中过一次：探针量出来的
            # 数字和 numpy 算的对不上，查了半天是缓存。前端把 `rev` 拼进
            # URL 的查询串（见 `systems/loader.js`）。
            rev = hashlib.sha1(bytes(bits)).hexdigest()[:8]
            meta.update(width=width, height=height, collision=COLLISION_PNG, rev=rev)
            print(f"碰撞掩码 {width}x{height} 逐像素"
                  + (f"（MB 只有 {mask.width}x{mask.height}，其余补成不可走）"
                     if (width, height) != (mask.width, mask.height) else "") + "，"
                  f"可走 {sum(bits) / len(bits):.1%}"
                  f"（MB 分成 {len(mask.sizes) - 1} 块，**全部保留**）")

            # 遮挡层：MK 覆盖到的美术一律画在人物上方（见 tools/map_masks.py）
            if mk:
                mk_bytes = read(mk)
                ow, oh, opixels = _compose(mk_bytes)
                bits = map_masks.opaque_bits(opixels)
                # 遮挡层同样要与地面对齐，理由见上。补出来的边判**不遮挡** ——
                # 画外的黑边上没有美术，硬说它盖在人身上只会凭空糊一块。
                bits = fit_mask(bits, ow, oh, width, height, layer_origin(mk_bytes))
                map_masks.write_mask_png(out_dir / OCCLUSION_PNG, width, height, bits)
                meta["occlusion"] = OCCLUSION_PNG
                print(f"遮挡掩码 {width}x{height}，覆盖 {sum(bits) / len(bits):.1%}")

            # 出生点仍要落在**面积最大的那一块**里：它只是「没有 op58 落点时
            # 的兜底位置」，随便挑一个可走像素可能挑进某个封死的小角落。
            spawn = pick_spawn(mask, objects, mask.main_region, collide_origin)
            if spawn:
                meta["spawn"] = {"x": spawn[0], "y": spawn[1]}
                print(f"出生点 {spawn}")

        if sci:
            meta["objects"] = collect_objects(read(sci))
            print(f"场景对象 {len(meta['objects'])} 个"
                  f"（可交互 {sum(1 for o in meta['objects'] if 'talk' in o or 'touch' in o)} 个）")

        if eve:
            meta["placements"] = collect_placements(read(eve))
            print(f"op11 临时登场 {len(meta['placements'])} 处")

        if eve and msg:
            # 键是**记录槽号**。对象表里 234/235 存的是事件编号，比槽号大 2，
            # scene_table._event_slot 已经减过（见那里的 EVENT_SLOT_BIAS），
            # 所以 o.talk / o.touch 拿来直接查这张表即可，这里不要再动。
            eve_bytes, msg_bytes = read(eve), read(msg)

            # ⚠️ **槽 0 的对白是「共享提示语」，不属于任何事件。**
            # 判据是 `EVENT_SLOT_BIAS`：对象表的事件编号 = 槽号 + 2，
            # 所以**槽 0 与槽 1 永远不可能被对象引用** —— 它们不是事件，
            # 是引擎自己要用的句子。`MP0000` 的槽 0 有 9 句：
            # 「這樣東西似乎不是在此處使用。」「此處地脈紊亂，無法乘之遁挪。」
            # 「這紙鳶需得到天地寬廣之處方能使用。」「用了這『鎮辟玄香』之後…」…
            # 前端此前把第一句硬编码在 `itemUse.WRONG_PLACE` 里。
            #
            # ⚠️ `MP0000.MSG` 号称有 128 个槽，**其中 125 个是空的** ——
            # `message_sentences` 对空槽没判空，越界读出了后面的数据
            # （槽 1~7 是同一句的逐字节右移，槽 10~127 全是 `&.6>FNV^`）。
            # 那是解析器的毛病，这里只取槽 0，不碰它。
            shared = ms.message_sentences(msg_bytes).get(0) or ()
            if shared:
                meta["shared"] = list(shared)
                print(f"共享提示语（MSG 槽 0）{len(shared)} 句：{shared[0][:22]}…")

            by_slot = ms.slot_dialogue(eve_bytes, msg_bytes)
            meta["events"] = {
                str(slot): [line.to_dict() for line in lines]
                for slot, lines in sorted(by_slot.items())
            }
            total = sum(len(v) for v in meta["events"].values())
            print(f"有台词的事件 {len(meta['events'])} 个，共 {total} 句")

            # `events` 只有对白，切图与条件分支都不在里面。要让门真的通向
            # 别的地图，前端得拿到整条指令序列——见 tools/eve_actions.py。
            by_action = eve_actions.slot_actions(eve_bytes, msg_bytes)
            meta["scripts"] = {
                str(slot): [action.to_dict() for action in actions]
                for slot, actions in sorted(by_action.items())
            }
            gotos = [a for acts in by_action.values() for a in acts
                     if a.type == eve_actions.GOTO_MAP]
            print(f"事件脚本 {len(meta['scripts'])} 槽，"
                  f"其中切换地图 {len(gotos)} 处 → "
                  + "、".join(sorted({str(a.data['map']) for a in gotos})))

            # 说话人从完整脚本里取：分支里才出现的角色不在去重后的 events 中，
            # 漏掉会让那句话没有姓名牌。
            speakers = {int(a.data["speaker"]) for acts in by_action.values()
                        for a in acts if a.type == eve_actions.SAY}
            if args.sys:
                names = namelist.load(Path(args.sys))
                meta["names"] = {str(c): names.get(c, "") for c in sorted(speakers)}
                print("说话人 " + "、".join(
                    meta["names"][str(c)] or "旁白" for c in sorted(speakers)))

        # 只留归档里真有素材的精灵，前端据此排加载队列。
        #
        # ⚠️ **要过一遍别名。** SCI 写的名字与归档里的文件名**并不总是一致**——
        # 药铺 SCI 写 `0207N001`，归档里那个文件叫 `NN0207-01`，
        # 结果就是"药铺没有老板"。见 `scene_table.SPRITE_ALIASES`。
        # ⚠️ **键名带图号**，与 `scene_table.sprite_key` 一致（理由见那里）：
        # 本归档的文件一律 `<本图号>-<文件名>`。
        available = {f"{stem}-{Path(e.name).stem.upper()}" for e in entries
                     if e.name.upper().endswith(".SF2")}
        renamed = 0
        junk = 0
        for o in meta.get("objects", []):
            key = o["sprite"]
            if key in available:
                continue
            if scene_table.looks_like_junk(scene_table.sprite_file_stem(key)):
                junk += 1
                continue
            alt = next((a for a in scene_table.sprite_aliases(key) if a in available), None)
            if alt:
                o["sprite"] = alt
                renamed += 1
        # ⚠️ **有些素材归档里有、却没有任何对象引用它。**
        # `MP0102B` 的 `EVENT-0.SF2`（开场「躺在床上 → 翻身 → 起床下地」
        # 那整段过场画面）就是这样：点它的是 **`MP0000` 的槽 8**，
        # 而 `MP0000` 是另一个归档 —— 本归档的 SCI 里没有它的记录，
        # 于是它既不进 `sprites`、也不会被 `--sprite-dir` 导出来，
        # `actor_show Event-0.SF2` 就作用在一个没有精灵的锚点上。
        #
        # 不能「把归档里所有没引用的 SF2 都导了」：3920 个 SF2 里有
        # **1767 个**没有对象引用，绝大多数是已经烘焙进地面美术的布景
        # （`NN*`），导出来纯属浪费。所以要点名给。
        # `--also-sprites` 与 `EXTRA_BY_MAP` 写的是**裸文件名**（`EVENT-0`），
        # 这里补上本图前缀。
        extra = {f"{stem}-{s.strip().upper()}"
                 for s in (args.also_sprites or "").split(",") if s.strip()}
        extra |= {f"{stem}-{s.upper()}" for s in EXTRA_BY_MAP.get(stem, {}).get("sprites", ())}
        missing = extra - available
        if missing:
            print(f"⚠ --also-sprites 里这些归档里没有：{sorted(missing)}", file=sys.stderr)
        # ⚠️ **跨图引用要放行。** 全库 14 处对象引用的是**别的图**文件夹里的精灵
        # （例：`MP0209` 的对象指向 `mp0204/nb0204.SF2`）。那个键由 `MP0204`
        # 自己导出时产出，所以前端拿得到 —— 卡掉的话那些对象永远没有素材。
        # 判据：前缀是个真图号（`MP…`）。开发期残留的 `NPC養殖場/`（11 处引用，
        # 发布版里**根本没有这个目录**）因此被排除。
        wanted_keys = {o["sprite"] for o in meta.get("objects", [])} | extra
        cross = {k for k in wanted_keys - available
                 if k.upper().startswith("MP") and not k.startswith(f"{stem}-")}
        meta["sprites"] = sorted((wanted_keys & available) | cross)
        note = (f"，改名找回 {renamed} 个" if renamed else "") + (f"，空槽 {junk} 个" if junk else "")
        print(f"用到的精灵 {len(meta['sprites'])} 个{note}")

        if args.sprite_dir:
            wanted = set(meta["sprites"])
            todo = [(e, f"{stem}-{Path(e.name).stem.upper()}") for e in entries
                    if f"{stem}-{Path(e.name).stem.upper()}" in wanted]
            export_sprites(read, todo, Path(args.sprite_dir))

        # ⚠️ **覆盖了什么必须说出来。** 静默换数据源 = 下次出问题没人想得到
        # 这儿；一个都没覆盖也要说，否则「补丁明明在那儿却没生效」看不出来。
        if read.used:
            print(f"散装补丁覆盖 {len(read.used)} 个：{'、'.join(sorted(read.used))}")
        elif patch:
            print(f"散装目录有 {len(patch)} 个文件，但没有一个与归档条目同名")
        else:
            print("没有散装补丁目录，全部用归档")

    (out_dir / "map.json").write_text(
        json.dumps(meta, ensure_ascii=False, separators=(",", ":")), encoding="utf-8"
    )
    # 多层地图必须与单层导出一起维护，避免全量重导再次丢楼层。
    from export_map_layers import export_layers
    export_layers(archive, out_dir / "map.json", args.sprite_dir)
    print(f"导出到 {out_dir}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
