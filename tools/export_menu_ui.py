#!/usr/bin/env python3
"""把八个菜单页的完整配置导出成前端能直接吃的结构化数据。

**这是菜单前端唯一的数据来源。** 坐标不在 JS 里硬编码，改摆位改这里重跑。

产物（默认 `game/public/assets/menus/`）：

* `menus.json` —— 素材表 + 八页元素表 + 交互关系
* `<素材>.png` —— 每个素材一张**精灵表**（所有图按统一格宽排成网格）

规格从哪来，一句话：**摆位来自原作 exe，素材来自归档，两处 exe 里没有的
（循环画的元素、滑入元素的落点）来自原作截图实测。** 详见 `docs/判据/数据链路.md` §2.9。

元素的 `x`/`y` 是**屏幕绝对坐标**，但还差最后一项 —— **SF2 帧层偏移**。
前端画一个元素时要走：`屏幕位置 = 元素.x/y + 该帧每一层的 layer.x/y`。
这一项没有预先叠进去，因为它**随帧号变**（换帧＝换高亮格/换档位/换角色）。

用法:
    python3 export_menu_ui.py <layout.json> <MenusDir.DAT> [-o 输出目录]
"""
from __future__ import annotations

import argparse
import json
import math
import sys
from pathlib import Path

from PIL import Image as PILImage

sys.path.insert(0, str(Path(__file__).resolve().parent))

import compose_page as C          # noqa: E402
import render_pages as R          # noqa: E402

#: 精灵表的最大边长。WebGL 的保守上限，超了有些机器会静默失败。
MAX_SHEET = 4096

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
#: 带 16 级不透明度的两种模式。其余模式 alpha 字段无意义，一律按 1。
GRADED = {"subtract16", "alpha16"}


def layer_spec(layer) -> dict:
    """一层的前端规格。`alpha` 已归一化到 0~1。"""
    blend = BLEND_MAP.get(layer.blend, "normal")
    alpha = (layer.alpha / C.ALPHA_MAX) if (layer.blend in GRADED and layer.alpha) else 1.0
    out = {"img": layer.image_index, "x": layer.x, "y": layer.y}
    if blend != "normal":
        out["blend"] = blend
    if alpha != 1.0:
        out["alpha"] = round(alpha, 4)
    return out


def sheet_for(cache: C.AssetCache, name: str) -> tuple[PILImage.Image, dict] | None:
    """把一个素材的所有图排成网格精灵表。

    格宽格高取全部图的最大值，**每张图左上角对齐**放进格子里 —— 这样图层坐标
    不用改：`crop_to_real` 是左上角裁的，网格与 real 共原点（见 `sf2.crop_to_real`）。
    """
    parsed = cache.get(name)
    if not parsed:
        return None
    _, images, _, frames = parsed
    tiles = [R.real_image(cache, name, i) for i in range(len(images))]
    tiles = [t for t in tiles if t is not None]
    if not tiles:
        return None
    cw = max(t.width for t in tiles)
    ch = max(t.height for t in tiles)
    cols = max(1, min(len(tiles), MAX_SHEET // max(cw, 1)))
    rows = math.ceil(len(tiles) / cols)
    if ch * rows > MAX_SHEET:
        print(f"  ⚠️ {name} 精灵表 {cw*cols}x{ch*rows} 超过 {MAX_SHEET}", file=sys.stderr)
    sheet = PILImage.new("RGBA", (cw * cols, ch * rows), (0, 0, 0, 0))
    for i, tile in enumerate(tiles):
        sheet.paste(tile, ((i % cols) * cw, (i // cols) * ch))
    meta = {
        "sheet": f"{name.split('.')[0]}.png",
        "cell": [cw, ch],
        "cols": cols,
        "count": len(tiles),
        "sizes": [[t.width, t.height] for t in tiles],
        "frames": [[layer_spec(l) for l in f.layers] for f in frames],
    }
    return sheet, meta


#: **数字字形表的排布**。三张表的「〇」位置各不相同，人工辨认（`out/` 里铺开看的）。
#: 索引即精灵表的帧号。`zero` 是数字 0 的帧，`one` 是数字 1 的帧（2~9 顺延）。
#: ⚠️ 原作的数值是**中文数字按十进制位**排，不是「十百千」的传统写法
#: （截图上 1475 写作「一四七五」），所以只需要 0~9 十个字形。
# 及身页三个装备槽的标签（兵刃/护甲/饰物）。**各 6 帧且 dynamicFrame**，
# 与选中条同规：选中时用帧 0，未选中用帧 3 并压暗。
EQUIP_SLOT_LABELS = ("MEN3001", "MEN3002", "MEN3003")

# 归档里有 103 个素材，exe 的构造调用只引用得到 52 个。**循环画的素材一个都不在里面**
# —— 它们没有独立的构造调用，`extract_layout.py` 自然扫不到，于是整个漏掉。
# 抗性管 MEN6005 就是这么丢了半天的：反复断言"素材找不到"，其实一直躺在归档里。
# 这里按需补进来；再发现循环画的新素材就往下加。
# 详情面板：选中项的**说明文字**画在哪。
#
# 只有法宝页与绝学页有 —— 及身页左侧是抗性与诸能，没有说明框。
# 文字区 = 框内缩 (+21, +18)，实测自法宝页那条描述带（框 (5,354) 407×122，
# 文字行 y 18..103、首列 21）。两页用的是同一种面板样式，所以内缩通用；
# 绝学页的框更窄，靠自动换行适配。
#
# ⚠️ **插图暂不画** —— 336 张插图与物品编号的映射还没建（已知不是严格顺序
# 对应），硬按「帧号=编号」套会给一部分物品配错图，比留空更糟。
# 见 `docs/物品插图与简繁.md`。
DETAIL_PANELS = {
    "note": "文字区 = 框 + (21,18)，宽度减两倍内缩后自动换行。插图见 artwork（映射已解开，2026-09-05）。",
    # ⚠️ **内边距两页不同**，不能共用。法宝页那条横带实测 (21,18)；
    # 绝学页那个竖框上方还有一段留白，文字从 (25,33) 起 —— 用 18 会顶到上边框。
    "pad": {"x": 21, "y": 18},
    "pages": {
        # 法宝：底部横条 MEN4002 f=2（主层 407×122）；中间那块 f=1 是插图区（未接）
        "法宝": {"x": 5, "y": 354, "w": 407, "h": 122,
                 "field": "详述", "art": {"x": 230, "y": 175, "w": 182, "h": 179}},
        # ⚠️ 绝学：左侧竖框 MEN5001 f=1。**主层是 218×200**，
        # 素材 cell 的 242×301 是最大帧的尺寸，不是这一帧的。
        "绝学": {"x": 175, "y": 175, "w": 218, "h": 200,
                 "field": "绝学说明", "pad": {"x": 25, "y": 33}},
    },
}

# 三页的列表 —— 同样是循环画，行距靠 `measure_slots.py` / 暗像素投影量出来。
#
# 规律很干净：**exe 给的 `select_bar` 起点就是第 0 行那根条的 y**，
# 文字再往下 5 px，行距三页统一 25。名称用**字库汉字**（24px 步进），
# 不是 MEN 字形素材。
LIST_ROWS = {
    "note": "行距 25、文字比条低 5px、名称 +24（绝学 +20）、数量 +141 —— "
            "三页实测一致。行数按 (下箭头 y − 条 y) / 25 取整。",
    "pitch": 25,
    # ⚠️ **3 不是 5。** 5 是从截图量的「墨迹上沿比条上沿低 5px」，但 bitmapText
    # 的 y 是**字格顶**，而字库汉字在 24×24 格内上下各有 2px 留白（实测墨迹
    # 占 2..21）。字格顶 = 墨迹顶 − 2 = 条顶 + 3。写 5 会整体下沉 2px。
    "textDy": 3,
    # 数量列用的是 MEN 字形（高 11），比字库汉字矮，单独给一个居中偏移。
    "qtyDy": 7,
    # 选中行两侧的装饰括号，相对条左端。⚠️ 只有**选中那一行**才画。
    "bracket": {"left": 1, "right": 184},
    "pages": {
        "及身": {"x": 417, "y0": 201, "rows": 9, "nameDx": 24, "qtyDx": 141,
                 "bar": "MEN3005"},
        "法宝": {"x": 422, "y0": 228, "rows": 8, "nameDx": 24, "qtyDx": 141,
                 "bar": "MEN4003"},
        # 绝学页：名称占四字，后面是**消耗图标**(+128，13 宽) 与**消耗数字**(+149)。
        # 图标蓝(MEN0025)=耗元气、红(MEN0026)=耗体力，对应气条与命条。
        "绝学": {"x": 407, "y0": 231, "rows": 8, "nameDx": 20,
                 "costDx": 128, "costValueDx": 149, "bar": "MEN5002"},
    },
}

# 两页的 8 行抗性 —— **循环画，exe 里没有坐标**，全部由 `tools/measure_slots.py`
# 在原作截图上模板匹配得到（残差 150~240，管的形状够独特）。
#
# 两页共用同一个面板素材同一帧（`MEN6001` f=1，五内页放 (470,145)、及身页放
# (20,145)），所以管的 x 是**平移关系**：五内 483 − 470 + 20 = 33，实测正好 33。
# y 与行距两页逐行一致，这是位置可信的最强判据。
RESIST_ROWS = {
    "note": "八行由循环画。行距 34.571 是 (435−193)/7 —— **不是整数**，"
            "逐行间隔实测 35/35/33/35/35/34/35，按 round(y0+dy*i) 复现得一模一样。",
    "names": ("焚火", "冰凛", "雷荧", "烨光", "魔厉", "化相", "析魂", "外法"),
    "y0": 193,
    "dy": 34.571,
    "rows": 8,
    "bar": {
        "asset": "MEN6005",
        "size": (143, 12),
        "frames": 129,
        # 游标 f0 最右 → f128 最左，**倒着数**，与命气条、五外柱同规。
        # 【实测】五内页 8 行 8/8 全中（值 40/76/56/99/71/79/87/88）：
        #     帧 = ⌊129 − (抗性值 + 100) × 128/300⌋
        # 值域 −100~200 铺满 128 像素 —— 负抗性画得出来，200 块确实有。
        # ⚠️ **单张截图 8 点**，129/128/300 这组常数还有等价写法能同样命中。
        # ⚠️ **及身页交叉验证没通过**：冰凛/雷荧两行对上了，焚火/烨光/魔厉三行
        #    反解出的符号是反的（烨光真值 99，反解 −97.7）。原因未知，**别当已解**。
        "formula": "floor(129 - (value + 100) * 128 / 300)",
        "domain": (-100, 200),
    },
    # 数字。x 偏移**相对管的左端**、y 偏移相对管的 y —— 这样两页共用一组数，
    # 因为两页的偏移实测完全一致（五内 527−483=44、及身 77−33=44，右列同理）。
    # ⚠️ **左列是预览、右列是当前**，与及身页「诸能」那块**相反**，不是笔误。
    # ⚠️ **左对齐：第一个数字的位置固定。**
    # 一度按右对齐 width=3 配过，那样左边界 = 右缘 − 39 = 509，而「焚火」标签
    # 占到 521 —— **三位数的第一位会压在「火」字上**。左对齐则三位数向右画到
    # 566，正好不碰中间那个「/」(574)。
    # 首格 dx=44 实测两页一致（五内 527−483、及身 77−33）。
# ⚠️ **有变化标记时，标记占第一格、数字从第二格开始**（及身页焚火行：
#    标记 +0、数字 +12）；没有标记的行数字直接占第一格。
    # ⚠️ 字形是 **MEN0028（12×11）不是 MEN1017（13×12）**。判据两条：
    #   1. 截图上的字步进主要是 12（12/13/12/12/12，那个 13 是 JPEG 边缘的 ±1），
    #      字高 11 —— 都对 MEN0028 的 cell。
    #   2. 蓝色版 MEN0029 **只有 12×11 这一种尺寸**。同一行两列字宽不可能不同，
    #      所以正数那套也必须是 12 宽的。
    # （13×12 那一对是 MEN1017 ↔ MEN1027，后者是亮棕不是蓝，用途待查。）
    "value": {
        "asset": "MEN0028",
        "dyFromBar": -14,
        "align": "left",
        # ⚠️ **负数不画负号，改用蓝色字形。** 原作里 `MEN0029` 与 `MEN1017`
        # 逐帧同构、只有笔画颜色不同（蓝 [17,21,46] / 棕 [70,30,10]）。
        # 判据：及身页八行的墨色与帧号反解出的正负 **8/8 分离** ——
        # 负的三行 B>R，正的五行 R 是 B 的十倍。这同时解释了字形模板匹配
        # 为什么失效：同一个字在屏幕上有两种颜色，比绝对颜色必然比不上。
        "negative": "MEN0029",
        "preview": {"dx": 44},
        "current": {"dx": 100},
        # 「焚火」这些标签和中间那个「/」每行位置固定，是**烧在面板底图里的**，不用画。
    },
    "pages": {
        # source 指的是哪一套抗性 —— 两套不是一回事，见 partyState.resistView
        "五内": {"x": 483, "source": "内禀"},
        "及身": {"x": 33, "source": "及身"},
    },
}

LOOP_DRAWN_ASSETS = (
    "MEN6005",   # 抗性计量管，143×12 × 129 帧
    "MEN0029",   # 数字字形的**蓝色版**，负数用它 —— 见 RESIST_ROWS.value.negative
    "MEN0025",   # 绝学消耗图标·蓝（元气／气条）
    "MEN0026",   # 绝学消耗图标·红（体力／命条）
    "MEN0005",   # 「确定使用／取消」对话框
    "MEN0020", "MEN0021",  # 复活死者列表及选中行：官方0x42ff30 / 0x430350
)

GLYPH_LAYOUT = {
    "MEN1017": {"one": 0, "zero": 9, "up": 11, "down": 12},
    # ⚠️ **MEN0029 是 MEN0028 的蓝色版，不是 MEN1017 的。**
    # 判据是像素：`MEN0028.png` 与 `MEN0029.png` 都是 156×11，**alpha 掩码
    # 逐像素完全相同**（0 个不同）；`MEN1017` 是 169×12，根本不同尺寸。
    # 于是 〇 也在**第 10 格**（`一二三四五六七八九 ? 〇 ▲ ▼`），不是第 9。
    #
    # 上一版照 MEN1017 写成 `zero: 9`，那一格是「?」—— 后果是**凡是负抗性里
    # 带 0 的都画成问号**（负数走蓝色字形）：霍雍的焚火 −60 / 魔厉 −60 显示成「六?」。
    # 回归 `tools/tests/test_glyph_layout.py` 按掩码相同就要求 layout 相同。
    "MEN0029": {"one": 0, "zero": 10, "up": 11, "down": 12},  # 12×11 蓝色，负数用
    "MEN1018": {"one": 0, "zero": 9, "up": 10, "down": 11},   # 15×14，金钱框
    "MEN1019": {"one": 1, "zero": 0, "up": None, "down": None},  # 17×16，〇 在最前
    "MEN1028": {"one": 0, "zero": 9, "up": None, "down": None},  # 15×14
    "MEN0028": {"one": 0, "zero": 10, "up": 11, "down": 12},   # 12×11，〇 在 ? 之后
    # ⚠️ 队伍条这两张是**阿拉伯数字**（截图上「位阶＼2」「207 \\207」），不是中文数字
    "MEN1001": {"one": 0, "zero": 9, "up": None, "down": None},  # 6×10 小号，命/气
    "MEN1002": {"one": 0, "zero": 9, "up": None, "down": None},  # 11×14 大号，位阶
}

#: 阵形页「諸能」四行的坐标。**exe 里没有**（循环画的），这里是
#: **从素材本身量出来的**：标签烤在 `MEN7001` 图 1（153×181 的諸能框）里，
#: 取深色笔画的行区间就得到 58/83/109/135（框内坐标），四行标签右缘统一 x=71。
#:
#: ⚠️ 比「对着原作截图模板匹配」更硬 —— 量的是**素材**，不是别人的截图。
#: ⚠️ 数字是**左对齐**紧跟标签：原作四行 `攻擊一七五〇 / 護禦一四〇〇 /
#: 命中一六〇 / 閃避九〇` 起点齐平、长度不齐，就是左对齐。
ZHUNENG_ROWS = {
    "note": "阵形页諸能四行。y 量自 MEN7001 图1 里烤着的标签，exe 没有这组坐标。",
    "panel": {"asset": "MEN7001", "frame": 0},
    "rows": [
        {"field": "攻击", "y": 58},
        {"field": "护禦", "y": 83},
        {"field": "命中", "y": 109},
        {"field": "闪避", "y": 135},
    ],
    "value": {"asset": "MEN1017", "dx": 73, "dy": 3, "align": "left"},
}

#: **填充条 / 柱子的绑定**：调用点 → 显示哪个值、分母是什么。
#: 帧号即档位（帧 0 是空的），所以 `帧 = round(值 / 上限 × (帧数−1))`。
#: ⚠️ 五外柱的 `上限` **是量出来的、且只是近似**：200 块位阶24 那张（五外
#: 175/201/178/171/188）五根柱子的填充比例反推出的上限高度一致（1162~1224），
#: 说明确实是同一个常数；扣掉管底描边的量测偏差后落在 1000~1100，取整数 1000。
#: 这个数只影响柱子画多满，不影响任何数值，**不必为它再花时间**。
FILL_SLOTS = {
    "0x0044838b": {"field": "命", "max": "命极"},          # 状态页 命条 MEN2002
    "0x004483ed": {"field": "气", "max": "气极"},          # 状态页 气条 MEN2003
    # 状态页五外柱 MEN2001 ×5，元素 x 依次 −87/−42/0/42/86（左→右）
    "0x00448450": {"field": "膂力", "max": 1000},
    "0x004484b3": {"field": "灵力", "max": 1000},
    "0x00448516": {"field": "体魄", "max": 1000},
    "0x0044857c": {"field": "迅捷", "max": 1000},
    "0x004485e2": {"field": "机运", "max": 1000},
}

#: **状态页数值坑的绑定**：调用点地址 → 显示哪个字段、怎么对齐。
#: ⚠️ 「填哪个字段」**exe 里查不到**（是寄存器传的），这是**看原作截图上烧死的标签**
#: 认出来的 —— 位阶/历练/命/气/膂力… 都印在坑旁边。盘点见 `docs/判据/数据链路.md` §2.9。
#: 对齐也来自截图：同一个金钱坑在三张截图上是 3/6/7 位数，反推出字段 54..≈180 右对齐。
STAT_SLOTS = {
    "0x00434d12": {"field": "金钱", "align": "right", "width": 7},   # 八页共用的金钱框
    "0x00448646": {"field": "位阶", "align": "left"},
    "0x004486a0": {"field": "已有历练", "align": "left"},
    "0x004486fa": {"field": "命", "align": "left"},
    "0x00448761": {"field": "命极", "align": "left"},
    "0x004487c3": {"field": "气", "align": "left"},
    "0x00448828": {"field": "气极", "align": "left"},
    "0x0044888a": {"field": "膂力", "align": "left", "dir": "vertical"},
    "0x004488ec": {"field": "灵力", "align": "left", "dir": "vertical"},
    "0x0044894e": {"field": "体魄", "align": "left", "dir": "vertical"},
    "0x004489b3": {"field": "迅捷", "align": "left", "dir": "vertical"},
    "0x00448a18": {"field": "机运", "align": "left", "dir": "vertical"},
    "0x00448ed5": {"field": "攻击", "align": "right", "width": 4},
    "0x00448f33": {"field": "护禦", "align": "right", "width": 4},
    "0x00448f8c": {"field": "命中", "align": "right", "width": 4},
    "0x00448fe5": {"field": "闪避", "align": "right", "width": 4},

    # —— 及身页「诸能」四行 × 两列 ——
    # ⚠️ **左列＝当前，右列＝预览**（把列表里选中的那件装备换上之后的值）。
    # 没有选中项时预览＝**卸下兵刃**，所以右列比左列少了兵刃的补正。
    # 判据见 `docs/专题/数值体系.md` §3.4bis：300 块状态页显示的单值与及身页左列逐项相等。
    # ⚠️ 抗性那八行的左右顺序**与这里相反**（左＝预览、右＝当前），别弄混。
    "0x0042f2d0": {"field": "攻击", "align": "left"},
    "0x0042f32e": {"field": "攻击", "align": "left", "variant": "预览"},
    "0x0042f390": {"field": "护禦", "align": "left"},
    "0x0042f3e9": {"field": "护禦", "align": "left", "variant": "预览"},
    "0x0042f44b": {"field": "命中", "align": "left"},
    "0x0042f4a4": {"field": "命中", "align": "left", "variant": "预览"},
    "0x0042f506": {"field": "闪避", "align": "left"},
    "0x0042f55f": {"field": "闪避", "align": "left", "variant": "预览"},
}


#: 顶部队伍条里的数值。**格内坐标来自 exe 簇 25**（不是量的），
#: 与位阶牌/命气条/小人同一个格原点。字宽字距也在那几条调用的立即数里。
PARTY_NUMBERS = (
    {"asset": "MEN1002", "x": 77, "y": 25, "field": "位阶"},
    {"asset": "MEN1001", "x": 37, "y": 58, "field": "命"},
    {"asset": "MEN1001", "x": 74, "y": 58, "field": "命极"},
    {"asset": "MEN1001", "x": 37, "y": 86, "field": "气"},
    {"asset": "MEN1001", "x": 74, "y": 86, "field": "气极"},
)

#: **汉字文本槽**（装备名、物品名这类）。用原作点阵字体画，见 `ui/glyphText`。
#: ⚠️ 位置**不在 exe 里**（那里只登记数字字形元素），是从 300 块状态页截图量的：
#: 三行装备名左缘都在 x=521，y 依次 184 / 220 / 255（行距约 36），字号 24 原尺寸。
TEXT_SLOTS = {
    "及身": [
        {"field": "装备.兵刃", "x": 290, "y": 182},
        {"field": "装备.护甲", "x": 290, "y": 216},
        {"field": "装备.饰物", "x": 290, "y": 250},
    ],
    "状态": [
        {"field": "装备.兵刃", "x": 521, "y": 182},
        {"field": "装备.护甲", "x": 521, "y": 218},
        {"field": "装备.饰物", "x": 521, "y": 253},
    ],
}


def party_bar_spec() -> dict:
    """顶部队伍条。**exe 里没有它的坐标**（各格由循环画），全是截图实测，见 §2.9。"""
    plate, plate_i, plate_x, plate_y = R.PARTY_BAR["plate"]
    fig, fig_cx, fig_bottom = R.PARTY_BAR["figure"]
    return {
        "note": "格原点 = 位阶牌屏幕 x − 牌的格内 x。间距不等距(105/104/104/104)，"
                "按 base+step 算会让第 0 格差 1px，故直接列实测值。",
        "slotX": [x - plate_x for x in R.PARTY_BAR["plate_x"]],
        "slotY": R.PARTY_BAR["slot_y"],
        "plate": {"asset": plate.split(".")[0], "img": plate_i, "x": plate_x, "y": plate_y},
        "hp": {"asset": R.PARTY_BAR["hp"][0].split(".")[0],
               "x": R.PARTY_BAR["hp"][1], "y": R.PARTY_BAR["hp"][2], "role": "fill"},
        "qi": {"asset": R.PARTY_BAR["qi"][0].split(".")[0],
               "x": R.PARTY_BAR["qi"][1], "y": R.PARTY_BAR["qi"][2], "role": "fill"},
        "figure": {"asset": fig.split(".")[0], "centerX": fig_cx, "bottomY": fig_bottom,
                   "note": "七个角色的图尺寸各不相同(33x90~39x97)，是**底对齐+水平居中**，"
                           "不是左上角对齐。"},
        "slots": 5,
        "numbers": list(PARTY_NUMBERS),
    }


def tianshu_spec() -> dict:
    """天书（存档）页。不走共用外壳，四条记录循环画，见 §8.18。"""
    s = R.PAGE_TIANSHU
    row_asset, row_img, row_x, row_y0, row_step = s["row"]
    face_asset, face_x0, face_step, face_dy = s["face"]
    idx_asset, idx_x, idx_y = s["index"]
    return {
        "background": {"asset": s["background"][0].split(".")[0], "img": s["background"][1]},
        "tabbar": {"asset": R.TABBAR["asset"].split(".")[0],
                   "x": R.TABBAR["origin_tianshu"][0], "y": R.TABBAR["origin_tianshu"][1]},
        "row": {"asset": row_asset.split(".")[0], "img": row_img,
                "x": row_x, "y0": row_y0, "step": row_step,
                "alpha": round(s["row_alpha"], 4),
                "note": "记录条的半透明是**元素级**的，SF2 里写着 alpha=0。"
                        "7/16 是逐档实测，来源尚未在 exe 里找到，见 §8.19。"},
        "face": {"asset": face_asset.split(".")[0],
                 "x0": face_x0, "step": face_step, "dy": face_dy,
                 # exe 的循环上界（x < 193，38 起步进 31）决定了**最多 5 个**。
                 "max": 5},
        "index": {"asset": idx_asset.split(".")[0], "x": idx_x, "y": idx_y},
        "arrows": [{"asset": a.split(".")[0], "x": x, "y": y, "role": role}
                   for (a, x, y), role in zip(s["arrows"], ("arrow_up", "arrow_down"))],
        "rows": 4,
        # ⚠️ **这三个框此前从没导出过**，天书页的交互全在它们身上：
        #   MEN8002 三帧＝「今況記錄」（存档）/「前歷再續」（读档）/「取消」
        #   MEN8003 两帧＝「確定／取消」（存档前的覆盖确认）
        #   MEN8006 两帧＝「確定／取消」（读档前的确认，与 8003 逐字节同尺寸）
        #   MEN8008 ＝「讀取中 ...」进度条
        # 坐标：MEN8002 的 (420, 260) 是 **exe 里就有的**（`建元素(子级)` 那一处）。
        # 8003/8006 的 x/y 在 exe 里从变量压栈取不到，**沿用 8002 的位置** ——
        # 三者尺寸完全相同（192×144），是同一处弹出的接续框。这一条是推断，
        # 见 `docs/状态/复现度台账.md` §八。
        # 条上各项的落点。**从 `MEN8001` 第 0 帧的标签美术字量出来的** ——
        # 标签（「地點/」「等級/」「日期/ 年 月 日」「時間/ ：」）是烤在图里的
        # 15px 美术字，值填在标签之间的空档里。量法：取条内暗像素的列游程，
        # 标签段之间的空白就是值的位置。
        #
        # ⚠️ **exe 里没有这些坐标**（天书页 0 个元素），所以是实测不是解出来的，
        # 已登记 `docs/状态/复现度台账.md` §八。
        # ⚠️ 步进不写在这里 —— `glyphNumber.advanceOf` 从 cell 宽现算（+2 字距），
        # 写第二份就会漂移。
        # ⚠️ 数字用 `MEN1018`（15×14）而不是 24px 字库 —— 标签只有 15px 高，
        # 用 24 号会比标签还大。地名没有小号字库可用（原作只发 font24.fnt），
        # 只能用 24 号，因此 y 要往上提让它与标签居中对齐。
        "slots": {
            "地名": {"x": 254, "y": 27, "font": 24},
            "等级": {"x": 508, "y": 32},
            "年": {"x": 256, "y": 64}, "月": {"x": 309, "y": 64},
            "日": {"x": 357, "y": 64},
            "时": {"x": 476, "y": 64}, "分": {"x": 522, "y": 64},
            "asset": "MEN1018",
        },
        "menu": {"asset": "MEN8002", "x": 420, "y": 260,
                 "frames": {"save": 0, "load": 1, "cancel": 2}},
        "confirmSave": {"asset": "MEN8003", "x": 420, "y": 260,
                        "frames": {"cancel": 0, "ok": 1}},
        "confirmLoad": {"asset": "MEN8006", "x": 420, "y": 260,
                        "frames": {"cancel": 0, "ok": 1}},
        # 「讀取中 ...」。**整帧画在 (0,0) 就对了** —— 层偏移是 SF2 自带的
        # （压暗横幅在 y=191 且是 multiply，小框在 (245,216)），
        # 而 exe 给 MEN8008 的元素坐标正是 (0, 0)。不要自己算居中。
        "busy": {"asset": "MEN8008", "frame": 0, "x": 0, "y": 0},
    }


def shop_spec() -> dict:
    """购物界面。**不是八页之一**，由剧情 `open_shop`（op54）弹出。

    摆位见 `render_pages.PAGE_SHOP` 的模块注释：几乎全部来自 exe 簇 6，
    只有确认框的坐标是截图实测（exe 那一处取不到）。
    """
    s = R.PAGE_SHOP

    def one(key):
        """(素材, x, y) 三元组 → dict。"""
        a, x, y = s[key]
        return {"asset": a.split(".")[0], "x": x, "y": y}

    def framed(key):
        """(素材, 帧, x, y) 四元组 → dict。"""
        a, f, x, y = s[key]
        return {"asset": a.split(".")[0], "frame": f, "x": x, "y": y}

    def pair(key):
        return [{"asset": a.split(".")[0], "x": x, "y": y, "role": role}
                for (a, x, y), role in zip(s[key], ("arrow_up", "arrow_down"))]

    return {
        "sign": {**one("sign"), "frames": s["sign_frames"],
                 "note": "帧号 = 商店种类。判据：三家已知店 + 全 57 家商品类别交叉，"
                         "种类3=武器鋪(3) 种类1=雜貨鋪(4) 种类2=藥鋪(5)。"},
        "money": framed("money"),
        "moneyGlyphs": one("money_glyphs"),
        "tabs": one("tabs"),
        "shopPanel": framed("shop_panel"),
        "shopRow": one("shop_row"),
        "shopPrice": one("shop_price"),
        "shopArrows": pair("shop_arrows"),
        "detailPanel": framed("detail_panel"),
        "bagPanel": framed("bag_panel"),
        "bagRow": one("bag_row"),
        "bagQty": one("bag_qty"),
        "bagArrows": pair("bag_arrows"),
        "confirm": {**one("confirm"),
                    "note": "⚠️ 这个坐标**不是 exe 给的** —— 那一处 x/y 从变量压栈，"
                            "extract_layout 只认立即数。(268,300) 是从原作截图量的。"},
        "confirmParts": [{"asset": a.split(".")[0], "x": x, "y": y}
                         for a, x, y in s["confirm_parts"]],
        "rowStep": s["row_step"],
        "rows": s["rows"],
        # 商店中间那块就是插图区，与法宝页同一块素材同一尺寸。
        "art": {"x": s["detail_panel"][2], "y": s["detail_panel"][3]},
        "notDrawn": ["攻防閃中预览面板（官方原版有，素材没找到）"],
    }


def confirm_use_spec() -> dict:
    """「確定使用／取消」确认框。法宝页与绝学页共用，摆位见 `render_pages.PAGE_CONFIRM_USE`。"""
    asset, x, y = R.PAGE_CONFIRM_USE["box"]
    return {
        "box": {"asset": asset.split(".")[0], "x": x, "y": y,
                "note": "帧号即当前焦点：0=取消高亮、1=確定使用高亮。"
                        "⚠️ 坐标是原作截图实测 —— exe 那一处 x/y 从变量压栈，取不到。"},
        "hits": [{"role": role, "x": hx, "y": hy, "w": w, "h": h}
                 for role, hx, hy, w, h in R.PAGE_CONFIRM_USE["hits"]],
    }


def use_fx_spec() -> dict:
    """用物品 / 放绝学的金光特效，以及绝学页的耗气/耗血图标。

    摆位见 `render_pages.MENU_USE_FX`。
    """
    s = R.MENU_USE_FX
    return {
        "asset": s["asset"].split(".")[0],
        "at": {"x": s["at"][0], "y": s["at"][1]},
        "anchor": {"x": s["anchor"][0], "y": s["anchor"][1]},
        "tickMs": s["tick_ms"],
        "scale": s["scale"],
        "blend": s["blend"],
        "costIcon": {"asset": s["cost_icon"].split(".")[0], "frames": s["cost_frames"]},
        "note": s["note"],
    }


def artwork_spec() -> dict:
    """物品插图。映射见 `render_pages.PAGE_ARTWORK` 的说明（确定性，不是猜的）。"""
    a = R.PAGE_ARTWORK
    return {
        "tables": [t.split(".")[0] for t in a["tables"]],
        "perTable": a["perTable"],
        "size": {"w": a["size"][0], "h": a["size"][1]},
        "note": "表 = tables[编号÷perTable]，帧 = 编号 mod perTable。编号按十进制。"
                "编号 > 460 的没有插图 —— 那些是敌人装备栏的数据，玩家看不到。",
    }


def wunei_arrow_elements() -> list[dict]:
    """五内页十个加点箭头。exe 里只有一个无坐标的调用点，坐标是实测，见 §2.9。"""
    spec = R.WUNEI_ARROWS
    out = []
    for k, (lx, rx, y) in enumerate(spec["pairs"]):
        for side, asset, x in (("left", spec["left"], lx), ("right", spec["right"], rx)):
            out.append({
                "id": f"五内:alloc_{side}_{k}",
                "asset": asset.split(".")[0],
                "frame": 0,
                "dynamicFrame": False,
                "x": x, "y": y,
                "role": f"alloc_{side}",
                "attr": k,          # 属性序号，见 interactions.wunei.attrs
                "site": "measured",
            })
    return out


def wunei_value_slots() -> dict:
    """五块牌上的点数 + 中央的剩余五内。坐标实测，量法见 `R.WUNEI_VALUES`。

    点数的 x 由**加点箭头**推出来：两个箭头之间就是牌内区，点数在其中居中。
    这样五块牌只有一处口径，不用各记一个数。
    """
    spec = R.WUNEI_VALUES
    arrows = R.WUNEI_ARROWS
    slots = []
    for k, (lx, rx, y) in enumerate(arrows["pairs"]):
        slots.append({
            "attr": k,
            "x": (lx + spec["arrow_w"] + rx) // 2,   # 居中：`x` 是**中心**不是左缘
            "y": y + spec["dy"],
        })
    rx, ry = spec["remain"]
    return {
        "asset": spec["asset"].split(".")[0],
        "align": "center",
        "note": "点数与剩余五内都是循环画的，坐标实测（量法见 render_pages.WUNEI_VALUES）。"
                "⚠️ `x` 是**中心**，配 drawNumber 的 align=center —— 位数变化时往两边长。",
        "slots": slots,
        "remain": {"x": rx, "y": ry},
    }


def interactions() -> dict:
    """按钮之间的逻辑关系。**规则来自用户对原作的描述 + exe 的素材帧结构。**"""
    return {
        "tabs": {
            "asset": R.TABBAR["asset"].split(".")[0],
            "order": list(R.TAB_ORDER),
            "note": "帧号 = 选中的标签序号。第 9 帧(index 8)是最右那个「离开」，不是页面。",
            "extraFrames": {"leave": 8},
        },
        "fabao": {
            "submenu": {
                "asset": "MEN4001",
                "items": ["用器", "兵刃", "护甲", "饰物", "杂类", "暂置"],
                "note": "⚠️ 帧号与显示顺序**相反**：高亮块 x=336/270/206/139/77/16，"
                        "帧 0 是最右的「用器」，帧 5 是最左的「暂置」。",
                # 因为上面这条，**方向键要对帧号取反**：按 → 应该让高亮往右走，
                # 也就是帧号 −1。绝学页的 MEN5005 是正序（帧 0 在左），不取反。
                "reversed": True,
                "frameOfItem": {"用器": 0, "兵刃": 1, "护甲": 2, "饰物": 3, "杂类": 4, "暂置": 5},
                "emptyFrame": 6,
            },
            "actionButton": {
                "note": "捡到的物品先进「暂置」。选中暂置时底下是**分发**（可分到具体分类），"
                        "进入具体分类后变成**弃置**。二者择一，不同时出现。",
                "distribute": {"asset": "MEN4006", "showWhen": "submenu.frame == 5"},
                "discard": {"asset": "MEN4008", "showWhen": "submenu.frame != 5"},
                "frames": {"idle": 0, "hover": 1},
            },
        },
        "juexue": {
            "submenu": {
                "asset": "MEN5005",
                "items": ["絕技", "咒法"],
                "note": "构造在屏幕外 (700,141)，是滑入动画起点；落点 (461,138) 实测。",
                # ⚠️ **和法宝页一样，帧号与屏幕左右相反。** 判据在素材里：
                # frame0 的高亮块画在 x=118（右＝咒法），frame1 画在 x=53（左＝绝技）。
                # 曾经按显示顺序写成 絕技=0，结果封铃笙的两门咒法跑到「绝技」下面。
                "frameOfItem": {"咒法": 0, "絕技": 1},
                "reversed": True,
            },
        },
        "zhenxing": {
            "selectBox": {
                "note": "格子上的选中框：MEN7002 蓝 = 悬停/未点中，MEN7004 紫 = 已点中。"
                        "同坐标同 16 帧，**只能显示一个**；两个都画会因为都走加亮而叠成白色。",
                "hover": "MEN7002", "active": "MEN7004",
                "frames": 16,
                "frameIsSlot": True,
            },
            "figures": {"asset": "MEN7003", "slots": 8,
                        "note": "八个格子上的小人由循环画，坐标 exe 里没有 —— **尚未实测**。"},
        },
        "wunei": {
            "attrs": ["烈", "迅", "神", "魂", "魔"],  # 顺序＝下面 alloc 箭头的顺序
            "note": "五块属性牌各有左右加点箭头；中间「蘊魄」那块**没有箭头**，"
                    "两端是烧在盘面图里的雕花。确认键是牌下方的 MEN6004。",
            "confirm": {"asset": "MEN6004"},
            "arrowFrames": {"idle": 0, "pressed": 1},
            "value": wunei_value_slots(),
        },
        "paging": {
            "note": "每个带列表的页面都有上下翻页箭头，role 为 arrow_up / arrow_down。",
        },
        "resistBar": {
            "note": "两页的抗性计量管：**一根管由两截拼成**，各 64×9，合起来 128 宽，"
                    "中间那个菱形是两截的分界装饰。**帧号倒着数**（f0 满、f58 空），"
                    "与命气条同规。⚠️ **「帧号 ↔ 抗性值」的映射规则尚未测出**，"
                    "0 抗性时游标停哪、负抗性怎么画都还不知道。",
            "negative": "MEN0007",
            "positive": "MEN0006",
            "frames": 59,
        },
        "detail": DETAIL_PANELS,
        "equipSlots": {
            "note": "及身页三个装备槽。assets 顺序＝兵刃/护甲/饰物，与 EQUIP_SLOTS 一致。"
                    "各 6 帧且 dynamicFrame —— 选中用帧 0，未选中用帧 3 并压暗。",
            "assets": list(EQUIP_SLOT_LABELS),
            "slots": ["兵刃", "护甲", "饰物"],
        },
        "listRows": {
            **{k: v for k, v in LIST_ROWS.items()},
        },
        "resistRows": {
            **{k: v for k, v in RESIST_ROWS.items() if k != "bar"},
            "bar": RESIST_ROWS["bar"],
        },
        "zhunengRows": ZHUNENG_ROWS,
        "unresolved": [
            # ⚠️ **推翻旧结论**：这里原先写「选中物品的白框 —— 素材尚未找到」，**是错的**。
            # 白框一直在，就是 role=select_bar 的 MEN4003/MEN5002/MEN3005（各 6 帧，
            # 200×24 / 226×24）。那 6 帧是**闪烁动画**（宽度在 196~200 间呼吸），
            # 不是 6 个行位置。exe 也给了它的起始位置。真正缺的只有**行距**。
            "列表的行距 —— 8 行由循环画，exe 只给得出第一行；选中条素材与起点都已有",
            "两页 8 抗性的数字与计量管坐标（循环画，未实测）",
            "抗性计量管的「帧号 ↔ 数值」映射（见 resistBar）",
            "五内五块牌上的点数坐标、蘊魄牌的剩余五内坐标（循环画，未实测）",
            "物品插图素材 —— 详情面板中间那张图，归档里还没找过",
            "装备详情显示什么（equipment.json 没有描述文本，只有属性列与「补充」）",
            "三页列表面板顶部的 MEN1019、五内页 MEN1028+MEN0028 —— "
            "现有截图里这些位置都是空的，语义待定",
            # ✅ 阵形页的 MEN1017 已定：就是「諸能」四行的数字（2026-09-12，
            #    用户给的原作阵形页截图上印着 攻擊一七五〇/護禦一四〇〇/命中一六〇/閃避九〇）。
            #    坐标见 ZHUNENG_ROWS —— exe 那个 (368,295) 对不上框内任何一行，没有采用。
            "阵形页八个格子上小人 MEN7003 的坐标（循环画，未实测）",
            "MEN0008 解不开，见 §8.16；前端跳过",
            "运行时数值的字形内容（role=glyphs 的元素只有位置，没有内容）",
        ],
    }


def revive_target_spec():
    # 官方0x42ff30构造于(700,240)，0x4302b0横向滑至350；四行命为0者。
    return {"asset": "MEN0020", "x": 350, "y": 240, "offscreenX": 700,
            "rowAsset": "MEN0021", "rowX": 10, "rowY": 32, "rowStep": 32,
            "rowWidth": 130, "rowHeight": 30, "textX": 27, "textY": 35,
            "source": "官方EXE 0x42ff30/0x430350；按队伍顺序列出命为0者，最多4人"}



def inn_specs():
    inn = {"room": "MEN9001", "menu": "MEN9002", "x": 500, "y": 90,
                      "hitX": 512, "hitY": 126, "step": 26, "width": 110, "height": 22,
                      "source": "官方413570/413a6a；room参数选背景帧，歇息回满命气"}
    refining = {"left": [40,50], "right": [195,50], "rowY": 103, "step": 25,
                           "rows": 9, "description": [40,385], "category": [250,15],
                           "confirm": [420,325], "movie": "assets/movies/refining.mp4",
                           "source": "官方炼化界面构造40f6d0/410ea0/4113e0及用户炼化截图640x480归一化"}
    return inn, refining

def main(argv: list[str]) -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("layout", type=Path)
    ap.add_argument("archive", type=Path)
    ap.add_argument("-o", "--outdir", type=Path,
                    default=Path("game/public/assets/menus"))
    ap.add_argument("--refresh-revive", action="store_true",
                    help="只重建复活选择素材与布局，保留其余菜单页的生成结果")
    ap.add_argument("--refresh-inn", action="store_true", help="仅重建客栈炼化素材与布局")
    args = ap.parse_args(argv)

    cache = C.AssetCache(C.load_entries(args.archive))
    if args.refresh_inn:
        path = args.outdir / "menus.json"
        doc = json.loads(path.read_text())
        for name in ("MEN9001", "MEN9002", "MEN9100", "MEN9101", "MEN9102"):
            sheet, meta = sheet_for(cache, name + ".SF2")
            sheet.save(args.outdir / meta["sheet"], optimize=True)
            doc["assets"][name] = meta
        doc["inn"], doc["refining"] = inn_specs()
        path.write_text(json.dumps(doc, ensure_ascii=False, indent=1))
        print("已更新客栈与炼化素材/布局")
        return 0
    if args.refresh_revive:
        path = args.outdir / "menus.json"
        doc = json.loads(path.read_text())
        for name in ("MEN0020", "MEN0021"):
            sheet, meta = sheet_for(cache, name + ".SF2")
            sheet.save(args.outdir / meta["sheet"], optimize=True)
            doc["assets"][name] = meta
        doc["reviveTarget"] = revive_target_spec()
        path.write_text(json.dumps(doc, ensure_ascii=False, indent=1))
        print("已重建复活选择列表的2份素材与原作布局")
        return 0
    rows = json.loads(args.layout.read_text())
    groups = C.clusters_from(rows)
    args.outdir.mkdir(parents=True, exist_ok=True)

    pages = []
    for page in R.TAB_ORDER:
        if page == "天书":
            pages.append({"key": page, "tab": R.TAB_ORDER.index(page),
                          "standalone": "tianshu", "elements": []})
            continue
        frames = {R.TABBAR["asset"]: R.TAB_ORDER.index(page), **R.FILL_FRAMES,
                  "MEN0001.SF2#2": R.SETTLED["bg_frame"]}
        shift = R.SETTLED["shift"].get(page, (0, 0))
        elements = R.page_elements(groups, cache, page, frames, shift)
        for e in elements:
            e["asset"] = e["asset"].split(".")[0]
        if page == "五内":
            elements += wunei_arrow_elements()
        pages.append({"key": page, "tab": R.TAB_ORDER.index(page), "elements": elements})

    # 需要哪些素材：八页用到的 + 队伍条 + 天书页
    used: set[str] = {e["asset"] for p in pages for e in p["elements"]}
    used |= {R.PARTY_BAR[k][0].split(".")[0] for k in ("plate", "hp", "qi", "figure")}
    used |= {n["asset"] for n in PARTY_NUMBERS}
    used |= {R.PAGE_TIANSHU["background"][0].split(".")[0],
             R.PAGE_TIANSHU["row"][0].split(".")[0],
             R.PAGE_TIANSHU["face"][0].split(".")[0],
             R.PAGE_TIANSHU["index"][0].split(".")[0],
             R.TABBAR["asset"].split(".")[0]}
    used |= {a.split(".")[0] for a, _, _ in R.PAGE_TIANSHU["arrows"]}
    # 天书页的三个对话框 + 「讀取中」条，见 tianshu_spec() 里的说明
    used |= {"MEN8002", "MEN8003", "MEN8006", "MEN8008"}
    used.add(tianshu_spec()["slots"]["asset"])      # 条上的数字字形表
    used |= {R.EXCLUSIVE_PAIR_SHOW.split(".")[0]} | {a.split(".")[0] for a in R.EXCLUSIVE_PAIR}
    used |= {a.split(".")[0] for a in R.SELECT_BOX}
    used |= set(LOOP_DRAWN_ASSETS)
    # 购物界面（不是八页之一，由 open_shop 弹出），见 shop_spec()
    used |= {v["asset"] for k, v in shop_spec().items()
             if isinstance(v, dict) and "asset" in v}
    used |= {e["asset"] for k in ("shopArrows", "bagArrows", "confirmParts")
             for e in shop_spec()[k]}
    # 「確定使用／取消」框（法宝页与绝学页共用），见 confirm_use_spec()
    used.add(confirm_use_spec()["box"]["asset"])
    # 用物品 / 放绝学的金光特效，以及绝学页的耗气/耗血图标，见 use_fx_spec()
    used |= {use_fx_spec()["asset"], use_fx_spec()["costIcon"]["asset"]}
    # 物品插图五张表，见 artwork_spec()
    used |= {t.split(".")[0] for t in R.PAGE_ARTWORK["tables"]}

    used |= {"MEN9001", "MEN9002", "MEN9100", "MEN9101", "MEN9102"}
    assets, skipped = {}, []
    for name in sorted(used):
        made = sheet_for(cache, f"{name}.SF2")
        if made is None:
            skipped.append(name)
            continue
        sheet, meta = made
        sheet.save(args.outdir / meta["sheet"], optimize=True)
        assets[name] = meta

    doc = {
        "screen": list(C.SCREEN),
        "generatedBy": "tools/export_menu_ui.py",
        "howToPlace": "屏幕位置 = 元素.x/y + 该帧每一层的 layer.x/y。"
                      "层的先后就是图层表顺序，**不要按 depth 排**（见 §8.19）。",
        "assets": assets,
        "pages": pages,
        "tabbar": {"asset": R.TABBAR["asset"].split(".")[0]},
        "partyBar": party_bar_spec(),
        "tianshu": tianshu_spec(),
        "shop": shop_spec(),
        "confirmUse": confirm_use_spec(),
        "reviveTarget": revive_target_spec(),
        "useFx": use_fx_spec(),
        "artwork": artwork_spec(),
        "interactions": interactions(),
        "glyphLayout": GLYPH_LAYOUT,
        "statSlots": STAT_SLOTS,
        "textSlots": TEXT_SLOTS,
        "fillSlots": FILL_SLOTS,
        "unparsed": skipped,
    }
    doc["inn"], doc["refining"] = inn_specs()
    target = args.outdir / "menus.json"
    target.write_text(json.dumps(doc, ensure_ascii=False, indent=1))

    total = sum(f.stat().st_size for f in args.outdir.glob("*.png"))
    print(f"素材 {len(assets)} 张精灵表，{total/1e6:.2f} MB"
          + (f"；解不开跳过: {skipped}" if skipped else ""))
    for p in pages:
        print(f"  {p['key']}: {len(p['elements'])} 个元素")
    print(f"-> {target}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
