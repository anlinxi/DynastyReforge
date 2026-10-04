#!/usr/bin/env python3
"""按 exe 布局把八个菜单页各拼一张，与原作截图并排出对比图。

页面 = **共用外壳簇** + **内容簇**。对应关系见 `docs/判据/数据链路.md` §2.9 的
「簇 ↔ 页面对应表」，判据是拼图后与八张原作截图比残差，不是目测。

两类值 exe 里没有，本工具**逐页解**而不是猜：

* **动态帧号** —— 立绘/姓名按当前角色、条与柱按数值、逐页背景按页面。
  给一组候选，取与截图残差最小的那个，并在报告里印出来选了哪帧。
* **滑入元素的落点** —— 机舱页的面板构造 x=690 在屏幕外（§2.9），
  最终位置靠在截图上搜平移量得到。

天书页不走共用外壳（没有立绘/姓名/金钱框），单独拼，见 `PAGE_TIANSHU`。

用法:
    python3 render_pages.py <layout.json> <MenusDir.DAT> <截图目录> -o out/pages
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import numpy as np
from PIL import Image as PILImage, ImageDraw, ImageFont

import compose_page as C
import sf2

#: 标签顺序取自原作标签栏烧进图里的字，也是 `MEN0009` 的帧序。
TAB_ORDER = ("状态", "法宝", "绝学", "及身", "五内", "阵形", "天书", "机舱")

#: 页面 → (外壳簇, 内容簇...)。截图文件名与页名的对照见 `SHOT_ALIAS`。
PAGE_CLUSTERS = {
    "状态": (23, 34, 35),
    "法宝": (23, 26),
    "绝学": (23, 27),
    "及身": (23, 20, 21),
    "五内": (23, 29),
    "阵形": (23, 28),
    "机舱": (23, 19),
}
#: 截图文件名里的别字。
SHOT_ALIAS = {"阵形": "阵型", "机舱": "机能"}

#: 帧号来自寄存器时的候选。逐页取残差最小的那个。
FRAME_CANDIDATES = {
    "MEN0001.SF2": (0, 1, 2, 4),       # 逐页背景
}

#: **填充类素材**：帧号就是填充档位，帧 0 是空的。样张里给个中间档才看得出是条进度管。
#: 判据是帧数——59/128/129/173 这种远多于「一套字形」的，就是档位表。
FILL_FRAMES = {
    "MEN2001.SF2": 40,    # 状态页属性柱（128 档）
    "MEN2002.SF2": 120,   # 命条（173 档）
    "MEN2003.SF2": 90,    # 气条（173 档）
    "MEN6005.SF2": 60,    # 五内 / 及身页的属性管（129 档）
    "MEN0006.SF2": 30,    # 队伍条小命条（59 档）
    "MEN0007.SF2": 30,    # 队伍条小气条（59 档）
}

#: **数字字形表**：11–13 帧、64×48 的一套字形，画出来是一个个数字。
#: 它们的内容是**运行时数据**，exe 里没有 —— 样张里不画，否则满屏莫名其妙的「〇」。
GLYPH_TABLES = frozenset({
    "MEN0028.SF2", "MEN0029.SF2", "MEN1001.SF2", "MEN1002.SF2", "MEN1017.SF2",
    "MEN1018.SF2", "MEN1019.SF2", "MEN1026.SF2", "MEN1027.SF2", "MEN1028.SF2",
    "MEN1029.SF2", "MEN1038.SF2",
})
DEFAULT_FRAME = 0

#: 法宝页底部「分发 / 弃置」是**一对择一按钮**，不是两个都显示。
#: 原作逻辑（用户提供）：捡到的物品先进「暂置」分类，选中暂置时显示**分发**，
#: 可分发到用器 / 兵刃 / 护甲 / 饰物 / 杂类；**进入具体分类后变成弃置**。
#: 样张按原作截图那一刻的状态（暂置被选中）只画分发。
EXCLUSIVE_PAIR = frozenset({"MEN4006.SF2", "MEN4008.SF2"})
EXCLUSIVE_PAIR_SHOW = "MEN4006.SF2"

#: **默认态不显示的弹出面板**。判据是构造 x ≥ 640（在屏幕外，是滑入动画的起点）
#: 且 `SLIDE_IN` 里没有实测落点 —— 也就是原作八张截图里都看不到它。
#: 及身页的 `MEN0020`（153×181 弹出框）就是这种：它自己飞在屏幕外没画出来，
#: 但它的子元素 `MEN0021`（132×24 标题条）被「取最大可容框」的父容器规则捡进了
#: 右侧物品框，于是右框里凭空多出第二个小框 —— 原作那里只有一条选中框。
#: 父元素被排除时，**它的子元素也要一起排除**。
POPUP_PANELS = frozenset({"MEN0020.SF2", "MEN0021.SF2"})

#: 阵形页格子上的选中框：MEN7002为蓝色悬停；MEN7004当前产物偏红，原作紫色合成仍待核对。
#: 两者同素材规格、同坐标、同 16 帧，只能显示一个。原作截图是蓝，故画 MEN7002。
#: 两个都画的话紫的会盖住蓝的，而且两层都走加亮，叠出来发白。
SELECT_BOX = frozenset({"MEN7002.SF2", "MEN7004.SF2"})
SELECT_BOX_SHOW = "MEN7002.SF2"

#: 顶部队伍条：每页都有，但**不在任何簇里** —— 各格由循环画，格原点是算出来的。
#: 格内布局取自簇 25（`extract_layout` 解得的相对坐标），格原点与间距从截图扫得：
#: 位阶牌在五张截图上一致落在 x=152/256/360/464/568、y=26，牌的格内坐标是 (36,25)。
PARTY_BAR = {
    #: 五格的**位阶牌屏幕 x**，实测。⚠️ 不是严格等距（间距 105/104/104/104），
    #: 按 base+step 算会让第 0 格差 1px —— 那 1px 就使残差从 41 涨到 68，
    #: 所以直接列实测值，不要用步进算。牌的格内坐标是 (36,25)，格原点 = 牌 x − 36。
    "plate_x": (151, 256, 360, 464, 568),
    "slot_y": 1,
    "plate": ("MEN0001.SF2", 1, 36, 25),        # 位阶牌：素材, 图号, 格内 x, y
    "hp": ("MEN0006.SF2", 37, 46),              # 命条（59 档）
    "qi": ("MEN0007.SF2", 37, 74),              # 气条（59 档）
    #: 小人 `MEN7003` 的格内坐标 exe 里没有（走循环）。七个角色的 real 尺寸各不相同
    #: （33×90 ~ 39×97），固定左上角对不齐 —— 实测是**底对齐 + 水平居中**：
    #: 四个高置信匹配的 `偏移y + 高` 全等于 97，中心 x 全等于 27.5。
    "figure": ("MEN7003.SF2", 27.5, 97),        # 素材, 格内中心 x, 底边 y
}

#: 标签栏。共用外壳里 `MEN0009` 的帧原点是 (65,105)；天书页的栏在最顶上，
#: 位置另测（那页 y=100 处是存档记录条）。
#: ⚠️ **用 `MEN0003` 不是 `MEN0009`。** 两条几乎一样，差别在：
#: `MEN0009` 的文字层里「天书」是**灰的**、且只有 8 个高亮块（没有天书那一格）；
#: `MEN0003` 的「天书」是金色、有 9 个高亮块。前者应是**不能存档时天书灰掉**的那条。
#: 原作菜单截图都是可存档状态，故用 `MEN0003`。曾误用 `MEN0009`，
#: 表现为每一页的「天书」都发灰、且选中天书页时没有高亮。
TABBAR = {"asset": "MEN0003.SF2", "origin_tianshu": (65, 12)}
#: 共用外壳里标签栏那个元素的素材名（exe 里写的是 MEN0009，按上面的理由换掉）
TABBAR_SWAP = {"MEN0009.SF2": "MEN0003.SF2"}

#: 天书页：不走外壳，四条记录循环画，行距实测。
PAGE_TIANSHU = {
    "background": ("MEN0001.SF2", 4),
    "row": ("MEN8001.SF2", 0, 20, 75, 95),      # 素材, 图号, x, 首行 y, 行距
    #: 队伍头像。**条内**坐标 —— 画的时候要加上条的 x=20。
    #:
    #: 判据是 exe 的画头像循环（`0x00425cbb`~`0x00425d14`，簇 19）：
    #:
    #: ```
    #: mov $0x26,%ebp            ; x = 38
    #: .loop:  push $0xa         ; y = 10
    #:         push %ebp         ; x
    #:         call 0x431c10     ; 建元素(子级) MEN8007.SF2
    #:         add  $0x1f,%ebp   ; x += 31
    #:         cmp  $0xc1,%ebp   ; 直到 x >= 193
    #:         jl   .loop
    #: ```
    #:
    #: 38 / 69 / 100 / 131 / 162 —— **正好 5 个**，所以「最多画五个头像」
    #: 也是 exe 里的数，不是我们掐的。
    #:
    #: ⚠️ 上一版写 58，那是**加过条 x 的绝对值**，代码又加了一次 20 ——
    #: 头像整体右移 20px，五个人时压到「地點/」「日期/」标签上。
    "face": ("MEN8007.SF2", 38, 31, 10),        # 素材, 条内 x0, 间距, y 偏移
    #: 条右上角那个**槽位编号**（原作画的是 九 / 一〇 / 一一 / 一二）。
    #: exe 簇 19 `0x00425c5d`：`push $0x21c(540); push $0xa(10); push $0x11,$0x11`
    #: → 条内 (540,10)，字宽高 17×17，素材 `MEN1019`（〇一二三…九）。
    #: 同一簇里「等級」那一处是 `MEN1028 (507,32)`，与我们独立实测的
    #: (508,32) 只差 1 —— 两条独立路径互证这一簇的坐标就是**条内**坐标。
    "index": ("MEN1019.SF2", 540, 10),          # 素材, 条内 x, y
    "party": ((0,), (0, 1), (0, 1, 2), (0, 1, 2)),
    #: 记录条的元素级透明度。7/16 是逐档实测出来的，来源见 §8.19，尚未在 exe 里找到。
    "row_alpha": 7 / 16,
    #: 上下翻页箭头。绝对坐标，取自簇 12（`MEN8004` 上 / `MEN8005` 下）。
    "arrows": (("MEN8004.SF2", 303, 45), ("MEN8005.SF2", 303, 455)),
}

#: 购物界面。**不是八页之一** —— 由剧情指令 `open_shop`（op54）弹出，
#: 背景是当前地图，界面直接盖在上面。
#:
#: 摆位几乎全部来自 exe 的**簇 6**（`0x00415a1c–0x0041669d`，16 个元素）：
#:
#:     MEN9200(5,5)帧3/4/5  招牌      MEN9102(242,140)     分类栏
#:     MEN0001(6,130)帧3    金钱框    MEN1018(40,13)       金钱数字
#:     MEN9200(5,174)帧7    左·商店   MEN9203(7,53)        商品行
#:     MEN1018(144,15)      价格      MEN4004(95,11)/MEN4005(95,268)  左箭头
#:     MEN4002(238,175)帧1  中·详情
#:     MEN4002(420,175)     右·背包   MEN4003(7,53)        背包行
#:     MEN1019(147,16)      数量      MEN4004(87,9)/MEN4005(87,266)   右箭头
#:
#: ⚠️ **子元素坐标是相对容器的**（见 `extract_layout` 模块头），行/数字/箭头
#: 那几项都要加上各自面板的原点。
#:
#: ⚠️ **确认框 `MEN9204` 的坐标 exe 里取不到**（x/y 都是 None —— 那一处大概
#: 是从变量压栈，`extract_layout` 只认立即数）。这里的 (268,300) 是**从用户
#: 提供的原作截图量的**：框在 640×480 里占 292×116，而素材是 297×112，对得上。
#: 与五内页那对箭头同一种情况，见 `WUNEI_ARROWS`。
#:
#: 招牌帧号 = 商店种类映射，判据是三家已知店 + 全 57 家商品类别交叉：
#: 种类3=武器鋪(帧3)、种类1=雜貨鋪(帧4)、种类2=藥鋪(帧5)。
#:
#: **本轮不画的两样**（用户 2026-09-04 决定）：
#: * 「攻防閃中」预览面板 —— 官方原版有，但素材翻遍 `MenusDir`(106) 与
#:   `Sys.dat`(145) 都没找到，先不画。
#: * 中间的物品插图 —— 素材是 `MEN4010`~`4014`（336 张），但**编号↔帧号的
#:   映射没建**且已知不是顺序对应，硬套会配错图。留空，见
#:   `菜单交互与数值联动.md` §10。
PAGE_SHOP = {
    #: 招牌。帧号运行时按商店种类选。
    "sign": ("MEN9200.SF2", 5, 5),
    #: 商店种类 → 招牌帧号。
    "sign_frames": {3: 3, 1: 4, 2: 5},
    #: 金钱框与它的数字（数字是子元素，坐标相对框）。
    "money": ("MEN0001.SF2", 3, 6, 130),
    "money_glyphs": ("MEN1018.SF2", 40, 13),
    #: 分类栏，9 帧（6 类 × 高亮 + 空）。
    "tabs": ("MEN9102.SF2", 242, 140),
    #: 左：商店商品列表。面板 / 行（相对面板）/ 行距 / 价格数字（相对行）。
    "shop_panel": ("MEN9200.SF2", 7, 5, 174),
    "shop_row": ("MEN9203.SF2", 7, 53),
    "shop_price": ("MEN1018.SF2", 144, 15),
    "shop_arrows": (("MEN4004.SF2", 95, 11), ("MEN4005.SF2", 95, 268)),
    #: 中：详情面板（插图本轮留空）。
    "detail_panel": ("MEN4002.SF2", 1, 238, 175),
    #: 右：背包列表。
    "bag_panel": ("MEN4002.SF2", 0, 420, 175),
    "bag_row": ("MEN4003.SF2", 7, 53),
    "bag_qty": ("MEN1019.SF2", 147, 16),
    "bag_arrows": (("MEN4004.SF2", 87, 9), ("MEN4005.SF2", 87, 266)),
    #: 确认框。⚠️ 坐标是截图实测，不是 exe 给的。
    "confirm": ("MEN9204.SF2", 268, 300),
    "confirm_parts": (("MEN9206.SF2", 32, 41), ("MEN9206.SF2", 97, 41)),
    #: 列表行距。素材 MEN9203 高 24 / MEN4003 高 24，逐行紧排。
    "row_step": 24,
    "rows": 10,
}

#: **「確定使用／取消」确认框**（`MEN0005`，179×87，两帧）。
#:
#: 法宝页与绝学页共用同一个框：选中一行按确定就弹它。
#: 帧 0 =「取消」被括号框住、帧 1 =「確定使用」被括号框住 —— 也就是**帧号即当前焦点**。
#:
#: ⚠️ **坐标是从原作截图量的，不是 exe 给的。** exe 里 `MEN0005` 那一处
#: （`0x0042711d`「建元素(顶层)」）的 x/y 从变量压栈，`extract_layout` 只认立即数，
#: 与购物确认框 `MEN9204` 是同一种情况。已登记进 `docs/状态/复现度台账.md`。
PAGE_CONFIRM_USE = {
    "box": ("MEN0005.SF2", 282, 306),
    #: 两行的点击热区（相对框左上角）。框内上半是「確定使用」、下半是「取消」。
    "hits": (("confirm", 0, 4, 179, 40), ("cancel", 0, 44, 179, 40)),
}

#: **用物品 / 放绝学的金光特效**（`MEN0016`，21 帧）与绝学页的**耗气/耗血图标**。
#:
#: ⚠️ **这是菜单自己的素材，不是战斗那套。** 曾经拿 `Ail2 +716` 的
#: 「使用动画文件一」（金创药＝`EFF3001`）去画，那是**战斗里**用物品的动画：
#: 蓝色、148×163、按整幅战斗画面构图。菜单里是 `MEN0016` —— **本来就是金色的**，
#: 21 帧「光环张开 → 粒子上升 → 散尽」，尺寸随帧从 128×96 长到 128×192。
#:
#: ⚠️ 耗气/耗血图标是 **`MEN5006`**（2 帧：0 红勾玉＝耗体力、1 蓝圆＝耗元气）。
#: 原先用的是 `MEN0025`/`MEN0026` 的**帧 0** —— 那两张是**阿拉伯数字字形表**
#: （0~9 各一帧，图标其实在末尾的帧 10/11），所以画出来是个蓝色的「0」字。
MENU_USE_FX = {
    "asset": "MEN0016.SF2",
    #: **锚点**：帧 1（第一个有内容的帧）里那圈光环的中心，在**原作画面坐标**下的位置。
    #: 帧 1 的层坐标是 (269,230)、图 105×64，光环占图的上部 —— 中心取 (269+52, 230+15)。
    #: 画的时候 `屏幕位置 = 落点 − 锚点 + 该帧的 layer.x/y`，这样**整组按同一偏移平移**，
    #: 原作那 21 帧之间的相对运动（粒子上升、图往上长）原样保留。
    "anchor": (321, 245),
    #: 落点：光环中心该落在队伍条一格里的哪个点（相对 `PARTY_BAR` 的 slotX[k] / slotY）。
    #: ⚠️ **量自原作截图**：光环套在小人腰部。exe 里没有这一处的坐标。
    "at": (27, 46),
    #: 缩放。⚠️ **量自原作截图**：那里光环横跨约 54 像素，而素材原生的环占满图宽
    #: （帧 1 是 105 宽）—— 整整两倍。队伍条一格才 104×97，素材原样画会横跨整格。
    #: **exe 里没有缩放字段**，已登记进 `docs/状态/复现度台账.md`。
    "scale": 0.5,
    #: 每帧多少毫秒。⚠️ **菜单 SF2 没有帧表**（`sf2_anim.parse_frames` 返回 0 帧），
    #: 所以帧时长无从读取。取战斗动画的节拍 `SF2Animator.TICK_MS = 55`。
    "tick_ms": 55,
    #: 混合模式。⚠️ 同样**没有字段可读**。判据是素材形态：金色亮部 + 黑边、
    #: 透明底 —— 与战斗那批 `subtract16` 层同一种画法，故按加法叠。
    "blend": "add",
    "cost_icon": "MEN5006.SF2",
    #: 帧号：0＝红勾玉（消耗体力）、1＝蓝圆（消耗元气）。判据是原作绝学页截图，
    #: 那里每行绝学名后面跟的正是一个蓝圆。
    "cost_frames": {"hp": 0, "qi": 1},
    "note": "MEN0016 是菜单自己的金光特效，与战斗的 EFF3001 无关；"
            "帧时长与混合模式无字段可读，见 docs/状态/复现度台账.md §七。",
}

#: **物品插图**（`MEN4010`~`MEN4014`，336 张 182×179）。
#:
#: **映射是确定性的，2026-09-05 解开**：
#:
#:     表 = MEN40(10 + 物品编号 ÷ 100)     帧 = 物品编号 mod 100
#:
#: 物品编号是十六进制字符串，这里按**十进制值**算。
#: 判据：`MEN4012` 帧 51~55 渲染出来是金創藥 / 大補丸 / 九花玉露 / 十聖金丹 /
#: 百草沁香，正对编号 `FB`~`FF` = 251~255；图里印着物品名，一眼可核。
#:
#: 覆盖情况（474 件物品）：
#: * 编号 ≤ 460 的 335 件里 **334 件有图**，只缺「幻剑煌熇」(`26`) —— 那一帧
#:   在原作素材里本来就是空的。
#: * 编号 > 460 的 139 件**全是杂类、商店不卖、开局也没有** —— 名字是
#:   「沙漠盜賊」「西夏兵」「漢軍」，那是**敌人装备栏**的数据，玩家看不到。
#:   原作没给它们画插图，合理。
#: * 另有 2 张图（编号 0 与 365）没有对应物品，忽略。
PAGE_ARTWORK = {
    "tables": ("MEN4010.SF2", "MEN4011.SF2", "MEN4012.SF2", "MEN4013.SF2", "MEN4014.SF2"),
    "perTable": 100,
    #: 插图在法宝页画在哪：`MEN4002` 帧 1 那块插图区（182×179），
    #: 元素坐标取自 `DETAIL_PANELS["法宝"]["art"]`。
    "size": (182, 179),
}

#: 五内页每个属性牌两端的**加点箭头**：`MEN6002` 左、`MEN6003` 右，都是 15×27。
#: exe 里这一对只有一个调用点（0x004410df）且**没有坐标** —— 五个牌是循环画的，
#: 坐标在循环体里算，`extract_layout` 拿不到，故这里列实测值。
#: 量法：这两个箭头在原作 `五内.jpeg` 上是**可见的静态贴图**（我先前误当成牌子雕花），
#: 用它们的位图在中央盘区域做模板匹配，五对峰值残差 13~21、干净可分；
#: 三张图里 **`img2`（帧 0，未按下态）残差最低**，故取 img2。
#: ⚠️ 中间「蘊魄」那块牌**没有箭头** —— 它两端是牌子自带的雕花（已在盘面图里），
#: 那里的确认键是牌下方的 `MEN6004`（22×17，ctor 已给，不用补）。
WUNEI_ARROWS = {
    "image_index": 2,
    #: (左箭头 x, 右箭头 x, y)，自上而下：列 / 迅 / 神 / 魂 / 魔
    "pairs": ((296, 347, 235), (201, 251, 302), (393, 443, 302),
              (234, 284, 423), (359, 409, 423)),
    "left": "MEN6002.SF2",
    "right": "MEN6003.SF2",
}

#: 五块牌上的**点数**与中央「蘊魄」牌下的**剩余五内**。同为循环画，坐标不在 exe 里。
#:
#: **量法（2026-08-29，第四次实测循环画元素）。** 字形的模板匹配对颜色敏感、
#: 已知会失效（§8.21 结论 2），所以这次不用模板匹配，改用**笔画包围盒**：
#: 加点箭头的坐标上一轮已经量准，两个箭头之间就是牌内区，在那一带按亮度阈值
#: 取行列投影，一次就分离出牌的上下边框线与字的笔画。
#:
#: 判据三条：
#:   1. 「神」牌上两字笔画 x[410..423] 与 x[425..438] —— **字距 15、字宽 14**，
#:      故字形表是 `MEN1017`（cell 13×12 → advance 15）。⚠️ **不是**五内页元素表里
#:      那两个 glyphs（`MEN0028` advance 14、`MEN1028` advance 17，都对不上）——
#:      那两个在截图里是空的，与牌上的点数无关。
#:   2. 五块牌的字框 y 一律 = 箭头 y + 8：牌内区高 21、字高 12，正是居中。
#:   3. 点数在两箭头之间**居中**（牌是定宽雕花框，位数变化时往两边长）：
#:      「魂」牌几何居中算得 266.5、实测 266。
#:
#: ⚠️ 截图 `screenshots/yc_menu/五内.jpeg` 是 **639×480**，量之前必须先缩回
#: 640×480，否则整体偏 1px（CLAUDE.md §5）。
WUNEI_VALUES = {
    "asset": "MEN1017.SF2",
    "arrow_w": 15,       # MEN6002/6003 的宽，用来求两箭头之间的中心
    "dy": 8,             # 字框 y 相对箭头 y
    #: 剩余五内的中心 x / 字框 y。实测笔画 x[307..334]、y[321..332]，
    #: 牌内区 y[317..338] 高 22、字高 12 → 居中 322，取实测 321。
    "remain": (321, 321),
}

FONT_CANDIDATES = ("/System/Library/Fonts/Hiragino Sans GB.ttc",
                   "/System/Library/Fonts/STHeiti Medium.ttc")


def load_font(size: int):
    for path in FONT_CANDIDATES:
        if Path(path).exists():
            try:
                return ImageFont.truetype(path, size)
            except OSError:
                continue
    return ImageFont.load_default()


def real_image(cache: C.AssetCache, asset: str, index: int) -> PILImage.Image | None:
    """按 `real` 尺寸取图。⚠️ grid 与 real 差很远，筛尺寸/摆位一律用 real。"""
    parsed = cache.get(asset)
    if not parsed:
        return None
    header, images, tiles, _ = parsed
    if not 0 <= index < len(images):
        return None
    w, h, px = sf2.compose_image(images[index], tiles, header)
    w, h, px = sf2.crop_to_real(images[index], w, h, px)
    return C.to_pil(w, h, px)


def flatten(img: PILImage.Image) -> PILImage.Image:
    out = PILImage.new("RGB", C.SCREEN, (0, 0, 0))
    out.paste(img, (0, 0), img)
    return out


def diff(a: PILImage.Image, shot: np.ndarray) -> float:
    return float(np.abs(np.asarray(a, dtype=np.float64) - shot).mean())


#: 元素角色。**这是给前端用的语义标签**，决定它是死贴图还是要接逻辑。
#: 判据都写在值旁边，改素材时对着这张表核一遍。
ROLES = {
    # —— 共用外壳 ——
    "MEN0003.SF2": "tabbar",          # 一级标签栏，帧号 = 选中页
    "MEN0002.SF2": "portrait",        # 半身立绘，帧号 = 对话人物代码
    "MEN0004.SF2": "name",            # 左上竖排姓名，帧号 = 战斗角色代码（与立绘不同套！）
    "MEN0008.SF2": "unparsed",        # 解不开，见 §8.16。前端跳过
    # —— 翻页箭头（上 / 下）——
    "MEN4004.SF2": "arrow_up", "MEN4005.SF2": "arrow_down",      # 法宝
    "MEN5003.SF2": "arrow_up", "MEN5004.SF2": "arrow_down",      # 绝学
    "MEN3006.SF2": "arrow_up", "MEN3007.SF2": "arrow_down",      # 及身
    "MEN8004.SF2": "arrow_up", "MEN8005.SF2": "arrow_down",      # 天书
    # —— 列表里的选中条 ——
    "MEN4003.SF2": "select_bar", "MEN5002.SF2": "select_bar",
    "MEN3005.SF2": "select_bar",
    # —— 按钮 ——
    "MEN4006.SF2": "action", "MEN4008.SF2": "action",            # 分发 / 弃置
    "MEN6002.SF2": "alloc_left", "MEN6003.SF2": "alloc_right",   # 五内加点
    "MEN6004.SF2": "alloc_confirm",
    # —— 二级菜单 ——
    "MEN4001.SF2": "submenu",         # 法宝：暂置/杂类/饰物/护甲/兵刃/用器
    "MEN5005.SF2": "submenu",         # 绝学：絕技/咒法
    # —— 阵形 ——
    "MEN7002.SF2": "select_box", "MEN7004.SF2": "select_box",
    "MEN7003.SF2": "figure",          # 格子上的小人，循环画
}


def role_of(name: str, row: dict) -> str:
    """元素角色。顺序有讲究：具名表优先，其次按「帧数说明用途」的通则。"""
    if name in ROLES:
        return ROLES[name]
    if name in GLYPH_TABLES:
        return "glyphs"               # 运行时数值，位置有、内容没有
    if name in FILL_FRAMES:
        return "fill"                 # 帧号就是填充档位，帧 0 是空的
    if name in POPUP_PANELS:
        return "popup"
    return "static"


def page_elements(groups, cache, page: str, frames: dict[str, int],
                  shift: tuple[int, int] = (0, 0)) -> list[dict]:
    """一页的元素规格（只有摆位，不含像素）。

    **样张渲染与 JSON 导出都走这一条**，免得「图上是对的、导出的数是另一套」。
    返回的 `x`/`y` 是**屏幕绝对坐标**（父容器原点、构造坐标、setOffset 都已叠好），
    还差最后一项「SF2 帧层偏移」—— 那一项留给消费方，因为它随帧号变。
    """
    out: list[dict] = []
    for n, gid in enumerate(PAGE_CLUSTERS[page]):
        group = groups[gid]
        boxes = C.toplevel_boxes(group, cache)
        seen: dict[str, int] = {}
        for row in group:
            r = dict(row)
            name = r["asset"].split("\\")[-1].upper()
            if name in TABBAR_SWAP:
                name = TABBAR_SWAP[name]
                r["asset"] = "Menus\\" + name
            if name in POPUP_PANELS:
                continue                    # 默认态不显示，见 POPUP_PANELS
            if r["call_site"] in MEASURED_OVERRIDE:
                r["x"], r["y"] = MEASURED_OVERRIDE[r["call_site"]]
            if name in SLIDE_IN:
                # 构造坐标是入场动画的起点，换成实测落点；落点是**绝对屏幕坐标**，
                # 所以同时标成顶层，免得再叠一次父容器原点
                r["x"], r["y"] = SLIDE_IN[name]
                r["callee"] = C.TOPLEVEL_CALLEE
            if r["x"] is None or r["y"] is None:
                continue                    # 循环画的，坐标不在 exe 里，见 §2.9
            seen[name] = seen.get(name, 0) + 1
            key = f"{name}#{seen[name]}"
            dynamic = r["frame"] is None
            frame = r["frame"]
            if dynamic:
                frame = frames.get(key, frames.get(
                    name, FILL_FRAMES.get(name, DEFAULT_FRAME)))
            ox, oy = (0, 0) if r["callee"] == C.TOPLEVEL_CALLEE else C.pick_origin(r, boxes, cache)
            dx, dy = (r["offset"] or (0, 0))
            out.append({
                "id": f"{page}:{key}",
                "asset": name,
                "frame": frame,
                "dynamicFrame": dynamic,    # 帧号来自寄存器：立绘按角色、条按数值、标签按页
                "x": ox + r["x"] + dx + (shift[0] if n else 0),
                "y": oy + r["y"] + dy + (shift[1] if n else 0),
                "role": role_of(name, r),
                "site": r["call_site"],
            })
    return out


def build_page(groups, cache, page: str, frames: dict[str, int],
               shift: tuple[int, int] = (0, 0),
               party: list[C.Placed] | None = None) -> PILImage.Image:
    """按给定的动态帧号拼一页。`shift` 只作用于内容簇（滑入元素的落点）。"""
    placed: list[C.Placed] = []
    for e in page_elements(groups, cache, page, frames, shift):
        if not draw_in_sample(e):
            continue
        placed += C.place({"asset": e["asset"], "frame": e["frame"],
                           "x": e["x"], "y": e["y"], "offset": None,
                           "callee": C.TOPLEVEL_CALLEE}, cache)
    placed += (party or [])
    img, _ = C.compose(placed)
    return flatten(img)


def draw_in_sample(e: dict) -> bool:
    """样张要不要画这个元素。**只影响样张，不影响导出的规格**。

    样张是「默认态的定格」，而导出的 JSON 要把择一的两边都留着给前端接逻辑。
    """
    name, role = e["asset"], e["role"]
    if role == "glyphs":
        return False                        # 运行时数值，exe 里没有内容
    if role == "unparsed":
        return False
    if name in EXCLUSIVE_PAIR and name != EXCLUSIVE_PAIR_SHOW:
        return False                        # 择一显示，见 EXCLUSIVE_PAIR
    if name in SELECT_BOX and name != SELECT_BOX_SHOW:
        return False                        # 择一显示，见 SELECT_BOX
    return True


def solve_frames(groups, cache, page: str, shot: np.ndarray, party) -> tuple[dict, float]:
    """逐个解动态帧号：固定其余，扫某一项的候选，取残差最小。"""
    tab = TAB_ORDER.index(page)
    frames = {"MEN0009.SF2": tab, **FILL_FRAMES}
    # 逐页背景是簇23 里第 2 个 MEN0001（第 1 个是固定帧 0 的底图）
    best = (float("inf"), 0)
    for cand in FRAME_CANDIDATES["MEN0001.SF2"]:
        trial = {**frames, "MEN0001.SF2#2": cand}
        score = diff(build_page(groups, cache, page, trial, party=party), shot)
        best = min(best, (score, cand))
    frames["MEN0001.SF2#2"] = best[1]
    return frames, best[0]


def solve_shift(groups, cache, page: str, frames: dict, shot: np.ndarray, party,
                span: int = 480) -> tuple[tuple[int, int], float]:
    """内容簇整体平移多少最像。给滑入元素用（构造 x 在屏幕外，见 §2.9）。"""
    best = ((0, 0), diff(build_page(groups, cache, page, frames, party=party), shot))
    for dx in range(-span, 1, 15):
        score = diff(build_page(groups, cache, page, frames, (dx, 0), party), shot)
        if score < best[1]:
            best = ((dx, 0), score)
    return best


#: ⚠️ **不要拿「与截图的像素差异」去调任何参数。**
#: 截图里有大量本工具**故意不画**的东西：运行时数值、不同存档的角色与队伍人数。
#: 朝这个数优化就是朝噪声优化 —— 曾经据此得出「加了队伍条反而更差」的错误结论，
#: 实际只是格子越多、缺的数值越多。这个数只能当「有没有整块画飞」的粗筛。
#: 下面这些定值都是**另有判据**定下来的（见 §2.9 / §8.18），不是搜出来的。
SETTLED = {
    #: 逐页背景取 MEN0001 帧1（27×211 竖条的 alpha16 渐隐拖影），见 §8.19
    "bg_frame": 1,
    #: 内容簇的整体平移。机舱页 -465 = 构造 x 690 − 面板落点 225（滑入动画起点）。
    #: ⚠️ 绝学页原来挂着 (-15,0)，那是用「与截图的像素差异」搜出来的，已删 ——
    #: 它把右框也从 400 挪到 385，而右框实测就在 396，本来是对的。
    "shift": {"机舱": (-465, 0)},
}

#: **滑入元素的落点**：构造 x 在屏幕外（≥640）的元素，是入场动画的起点，
#: 最终位置得另定。每个的位移**各不相同**，不能用一个全局平移套。
#: 单位是「最终 x」，从原作截图上量得。
SLIDE_IN = {
    #: 绝学页二级菜单「絕技 咒法」，构造在 (700,141)。
    #: ⚠️ 量落点时要**减掉帧层偏移**：整条文字层在 (57,2)，截图上文字左边缘在 x≈518，
    #: 故元素原点 = 518−57 = 461。曾直接把 518 当原点用，整体右移 57px，
    #: 「咒法」被推出屏幕外看不见。
    "MEN5005.SF2": (461, 138),
}

#: **按调用点覆盖坐标**：exe 给的值与截图实测对不上的个别元素。
#: 键用调用点地址（唯一），免得误伤同一素材的其它实例。
MEASURED_OVERRIDE = {
    #: 绝学页左侧详情框。exe 构造在 (195,175)，截图实测 (175,175)，**差 20px 原因未明**：
    #: 该元素没有 setOffset、帧层偏移也是 (0,0)。用户实机对比也说它偏右，两边一致，
    #: 故采信实测值。同页右框 exe 说 400、实测 396，差 4 属正常，不改。
    "0x0043ce2a": (175, 175),
}

#: 各截图里队伍有几人。**这是各张截图的存档状态，不是能从素材推断的东西**，
#: 所以直接列出来。逐格拿位阶牌比残差可以验证（有人 36~51、空格 54~56），
#: 但当判据不可靠：`法宝.jpeg` 是 639×**477** 的那张（CLAUDE.md §四 警告过），
#: 拉伸到 480 后整体错位，第 0 格读数会跟空格一样高。
PARTY_COUNT = {
    "状态": 1, "法宝": 3, "绝学": 5, "及身": 5,
    "五内": 5, "阵形": 5, "天书": 0, "机舱": 3,
}


def build_party_bar(cache, count: int) -> list[C.Placed]:
    """顶部队伍条。第 k 格画第 k 个角色 —— 匹配结果就是这个恒等对应。"""
    placed: list[C.Placed] = []
    y0 = PARTY_BAR["slot_y"]
    for k in range(count):
        asset, index, ox, oy = PARTY_BAR["plate"]
        sx = PARTY_BAR["plate_x"][k] - ox      # 格原点 = 牌 x − 牌的格内 x
        img = real_image(cache, asset, index)
        if img is not None:
            placed.append(C.Placed(asset, sx + ox, y0 + oy, img, True))
        for key, frame in (("hp", FILL_FRAMES["MEN0006.SF2"]),
                           ("qi", FILL_FRAMES["MEN0007.SF2"])):
            name, ox, oy = PARTY_BAR[key]
            bar = _frame_image(cache, name, frame)
            if bar is not None:
                placed.append(C.Placed(name, sx + ox, y0 + oy, bar, True))
        name, cx, bottom = PARTY_BAR["figure"]
        fig = real_image(cache, name, k)
        if fig is not None:
            placed.append(C.Placed(name, round(sx + cx - fig.width / 2),
                                   y0 + bottom - fig.height, fig, True))
    return placed


def build_wunei_arrows(cache) -> list[C.Placed]:
    """五内页五个属性牌两端的加点箭头。坐标来源见 `WUNEI_ARROWS`。"""
    spec = WUNEI_ARROWS
    idx = spec["image_index"]
    placed: list[C.Placed] = []
    for lx, rx, y in spec["pairs"]:
        for name, x in ((spec["left"], lx), (spec["right"], rx)):
            img = real_image(cache, name, idx)
            if img is not None:
                placed.append(C.Placed(name, x, y, img, True))
    return placed


def _frame_image(cache, asset: str, frame: int) -> PILImage.Image | None:
    """取某一帧合成后的小图（条与柱这类单层素材用）。"""
    parsed = cache.get(asset)
    if not parsed:
        return None
    frames = parsed[3]
    if not 0 <= frame < len(frames) or not frames[frame].layers:
        return None
    return real_image(cache, asset, frames[frame].layers[0].image_index)


def build_tabbar(cache, tab: int) -> list[C.Placed]:
    """标签栏。天书页也有（在最顶上），但它不走共用外壳，得单独画。"""
    parsed = cache.get(TABBAR["asset"])
    if not parsed or not 0 <= tab < len(parsed[3]):
        return []
    ox, oy = TABBAR["origin_tianshu"]
    out = []
    for layer in parsed[3][tab].layers:      # 表顺序即绘制顺序，见 compose_page.place
        img = cache.layer_image(TABBAR["asset"], layer.image_index)
        if img is not None:
            out.append(C.Placed(TABBAR["asset"], ox + layer.x, oy + layer.y, img, True,
                                layer.depth, layer.blend, layer.alpha))
    return out


def build_tianshu(cache) -> PILImage.Image:
    spec = PAGE_TIANSHU
    placed = [C.Placed("bg", 0, 0, real_image(cache, *spec["background"]), True)]
    placed += build_tabbar(cache, TAB_ORDER.index("天书"))
    for name, ax, ay in spec["arrows"]:
        arrow = real_image(cache, name, 0)
        if arrow is not None:
            placed.append(C.Placed(name, ax, ay, arrow, True))
    asset, index, x, y0, step = spec["row"]
    bar = real_image(cache, asset, index)
    face_asset, fx0, fstep, fdy = spec["face"]
    for k, party in enumerate(spec["party"]):
        y = y0 + step * k
        placed.append(C.Placed("row", x, y, bar, True,
                               blend="alpha16", alpha=round(spec["row_alpha"] * 16)))
        for j, who in enumerate(party):
            placed.append(C.Placed("face", fx0 + fstep * j, y + fdy,
                                   real_image(cache, face_asset, who), True))
    img, _ = C.compose(placed)
    return flatten(img)


def contact_sheet(pairs: list[tuple[str, PILImage.Image, PILImage.Image, float]],
                  path: Path) -> None:
    """每行一页：复刻 | 原作 | 页名与差异。"""
    pad, label = 6, 20
    w = C.SCREEN[0] * 2 + pad * 3
    h = len(pairs) * (C.SCREEN[1] + label + pad) + pad
    sheet = PILImage.new("RGB", (w, h), (22, 22, 28))
    draw = ImageDraw.Draw(sheet)
    font = load_font(15)
    for i, (name, mine, shot, score) in enumerate(pairs):
        y = pad + i * (C.SCREEN[1] + label + pad)
        draw.text((pad, y), f"{name}　　复刻 ← | → 原作",
                  font=font, fill=(235, 228, 210))
        sheet.paste(mine, (pad, y + label))
        sheet.paste(shot, (C.SCREEN[0] + pad * 2, y + label))
    sheet.save(path)


def main(argv: list[str]) -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("layout", type=Path)
    ap.add_argument("archive", type=Path)
    ap.add_argument("shots", type=Path)
    ap.add_argument("-o", "--outdir", type=Path, default=Path("out/pages"))
    args = ap.parse_args(argv)

    rows = json.loads(args.layout.read_text())
    cache = C.AssetCache(C.load_entries(args.archive))
    groups = C.clusters_from(rows)
    args.outdir.mkdir(parents=True, exist_ok=True)

    def load(page: str) -> np.ndarray | None:
        stem = SHOT_ALIAS.get(page, page)
        for ext in (".jpg", ".jpeg", ".png"):
            p = args.shots / f"{stem}{ext}"
            if p.is_file():
                img = PILImage.open(p).convert("RGB")
                if img.size != C.SCREEN:
                    img = img.resize(C.SCREEN, PILImage.LANCZOS)
                return np.asarray(img, dtype=np.float64)
        return None

    pairs = []
    for page in TAB_ORDER:
        shot = load(page)
        if shot is None:
            print(f"{page}: 找不到截图，跳过", file=sys.stderr)
            continue
        if page == "天书":
            mine = build_tianshu(cache)
            note = "单独拼（不走外壳）"
        else:
            n = PARTY_COUNT.get(page, 0)
            party = build_party_bar(cache, n)
            frames = {"MEN0003.SF2": TAB_ORDER.index(page), **FILL_FRAMES,
                      "MEN0001.SF2#2": SETTLED["bg_frame"]}
            shift = SETTLED["shift"].get(page, (0, 0))
            extra = build_wunei_arrows(cache) if page == "五内" else []
            mine = build_page(groups, cache, page, frames, shift, party + extra)
            note = (f"队伍 {n} 人" + ("　+加点箭头" if extra else "")
                    + (f" 内容平移{shift}" if shift != (0, 0) else ""))
        score = diff(mine, shot)
        mine.save(args.outdir / f"page_{page}.png")
        pairs.append((page, mine, PILImage.fromarray(shot.astype(np.uint8)), score))
        print(f"  {page}  {note}")

    contact_sheet(pairs, args.outdir / "八页对比.png")
    print(f"\n-> {args.outdir}/八页对比.png")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
