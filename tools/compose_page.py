#!/usr/bin/env python3
"""按 exe 提取的布局把一簇素材拼成页面，并在原作截图里定位它属于哪一页。

`extract_layout.py` 给出「素材 + 构造坐标 + 帧号 + 偏移修正」，但**容器原点拿不到**
——它是通过寄存器传的对象槽，静态分析要再往上追一层。绕开的办法是让截图来告诉我们：

    把一簇按自身坐标拼出来 → 在截图上搜最佳平移量
    → 平移量就是容器原点，匹配得分就说明它属于哪一页

匹配只用**帧号是常量**的元素。帧号来自寄存器的（立绘、姓名按当前角色取帧）画得出来
但对不上，拿它们参与匹配只会污染得分。

坐标按 §2.9 的四项模型合成：

    位置 = 容器原点(待解) + 构造坐标 + SF2 帧层偏移 + setOffset 修正

用法:
    python3 compose_page.py <layout.json> <MenusDir.DAT> -o out/pages
    python3 compose_page.py ... --shots screenshots/yc_menu   # 顺带定位到页面
    python3 compose_page.py ... --cluster 23                  # 只拼某一簇
"""
from __future__ import annotations

import argparse
import json
import sys
from dataclasses import dataclass
from pathlib import Path

import numpy as np
from PIL import Image as PILImage

import dat_unpack
import sf2
import sf2_anim

SCREEN = (640, 480)
#: 聚簇阈值，与 extract_layout.py 保持一致。
CLUSTER_GAP = 0x300
#: 帧号来自寄存器时用哪一帧来「画个样子」。不参与匹配。
DEFAULT_FRAME = 0
#: 匹配时忽略覆盖像素太少的簇——几十个像素怎么搜都能对上，无意义。
MIN_MATCH_PIXELS = 400
#: 平移后至少要有这个比例的模板像素仍落在画面内。
#: 不设这条，按重叠数归一化的 SSD 会偏爱"移出去只剩一角"的假解。
MIN_OVERLAP = 0.9


#: `sf2_anim` 解出的 depth 里，未设定的那一档就是 u32 的 -1。它该画在最上面。
DEPTH_TOP = 0xFFFFFFFF
#: alpha 字段的上限（社区文档：0x10 为上限）。
ALPHA_MAX = 16
#: 未文档的 7 / 8 号混合模式当作什么画。取值见 `apply_layer`。
#: 实测下来 7 号那条底条要压暗，`multiply` 最接近；语义未证实，故可切换。
DEFAULT_UNKNOWN_BLEND = "multiply"


@dataclass(frozen=True)
class Placed:
    """一个已经算出屏幕位置的图层。"""

    asset: str
    x: int
    y: int
    image: PILImage.Image
    static: bool
    depth: int = DEPTH_TOP
    blend: str = "normal"
    alpha: int = 0


def load_entries(archive: Path) -> dict[str, bytes]:
    with archive.open("rb") as fh:
        entries = dat_unpack.read_entries(fh, archive.stat().st_size)
        out = {}
        for e in entries:
            fh.seek(e.offset)
            out[e.name.upper()] = fh.read(e.size)
    return out


def to_pil(width: int, height: int, pixels: list[int]) -> PILImage.Image:
    buf = bytearray(width * height * 4)
    for i, value in enumerate(pixels[:width * height]):
        buf[i * 4:i * 4 + 4] = bytes(sf2.x1r5g5b5_to_rgba(value))
    return PILImage.frombytes("RGBA", (width, height), bytes(buf))


class AssetCache:
    """一条 SF2 解一次就够，簇里同一素材常被用五六次。"""

    def __init__(self, entries: dict[str, bytes]):
        self.entries = entries
        self._parsed: dict[str, tuple] = {}

    def get(self, name: str):
        key = name.upper()
        if key in self._parsed:
            return self._parsed[key]
        blob = self.entries.get(key)
        if blob is None:
            self._parsed[key] = None
            return None
        try:
            data = sf2.inflate_variant(blob)
            header = sf2.parse_header(data)
            images = sf2.read_images(data, header)
            tiles = sf2.read_tiles(data, header)
            frames = sf2_anim.parse_frames(data, header)
        except (sf2.SF2Error, ValueError, MemoryError):
            self._parsed[key] = None
            return None
        self._parsed[key] = (header, images, tiles, frames)
        return self._parsed[key]

    def layer_image(self, name: str, image_index: int) -> PILImage.Image | None:
        parsed = self.get(name)
        if not parsed:
            return None
        header, images, tiles, _ = parsed
        if not 0 <= image_index < len(images):
            return None
        w, h, px = sf2.compose_image(images[image_index], tiles, header)
        if not w or not h:
            return None
        return to_pil(w, h, px)


#: 顶层构造函数的地址（见 §2.9 的函数表）。子级都挂在某个顶层元素下面。
TOPLEVEL_CALLEE = "0x004310e0"


def toplevel_boxes(group: list[dict], cache: "AssetCache") -> list[tuple[int, int, int, int]]:
    """一簇里各顶层元素的屏幕矩形，按构造顺序。子级要挂在其中之一下面。"""
    boxes = []
    for row in group:
        if row.get("callee") != TOPLEVEL_CALLEE or row["x"] is None:
            continue
        size = _frame_extent(row, cache)
        if size is None:
            continue
        boxes.append((row["x"], row["y"], size[0], size[1]))
    return boxes


def _frame_extent(row: dict, cache: "AssetCache") -> tuple[int, int] | None:
    """一次构造画出来占多大（取它用的那一帧，各层并集）。

    ⚠️ **必须算上 setOffset**，否则会被帧层偏移骗到。阵形页的选中菱形就是这样：
    它的帧层偏移是 (279,240)、setOffset 是 (-320,-260)，净偏移只有 (186,8)；
    只看帧层偏移会算出 361×281，判定「哪个顶层都放不进」而退回第一个，
    菱形就飘到棋盘外面去了。算上修正后是 268×49，正好放得进地板。
    """
    name = row["asset"].split("\\")[-1]
    parsed = cache.get(name)
    if not parsed:
        return None
    header, images, _, frames = parsed
    idx = row["frame"] if row["frame"] is not None else 0
    if not 0 <= idx < len(frames):
        idx = 0
    dx, dy = (row.get("offset") or (0, 0))
    w = h = 0
    for layer in frames[idx].layers:
        if not 0 <= layer.image_index < len(images):
            continue
        im = images[layer.image_index]
        w = max(w, layer.x + dx + (im.real_width or im.width * 48))
        h = max(h, layer.y + dy + (im.real_height or im.height * 48))
    return (w, h) if w > 0 and h > 0 else None


def pick_origin(row: dict, boxes: list[tuple[int, int, int, int]],
                cache: "AssetCache") -> tuple[int, int]:
    """子级挂在哪个顶层下面 —— **判据是「放得进谁的矩形」**。

    构造顺序解决不了这件事，两簇的方向正好相反：

    * 簇23 立绘必须挂**第一个**顶层（背景）—— 挂标签栏会挪到 (65,243)
    * 簇26「分发」必须挂**最后一个**顶层（右侧面板）—— 挂第一个会飞到 (383,408)

    而「放得进谁」两处都成立：立绘 384×384 放不进标签栏（高只有 48）；
    「分发」在 y+268 处放不进分类条（高也只有 48）。
    多个都放得进时取**面积最大的**，即最外层的容器。三种取法都试过：

    * 取**最小**：法宝上翻页箭头 36×24 在 (87,9)，放得进分类条也放得进右面板，
      按最小会挂到分类条上，箭头跑进标签行。
    * 取**最近构造**：及身页上箭头会挂到 (700,240) 那个屏幕外的滑入元素上，
      落到 x=787 直接看不见；而且上下一对箭头会挂到不同的框上。
    * 取**最大**：已知例子全部成立 —— 簇23 立绘→背景、簇26 分发→右面板、
      及身/绝学/法宝的上下箭头→各自的右侧列表框（与截图实测的 (497,154)/(497,443) 吻合）、
      阵形选中框→地板。
    """
    size = _frame_extent(row, cache)
    if size is None or not boxes or row["x"] is None or row["y"] is None:
        return boxes[0][:2] if boxes else (0, 0)

    cw, ch = size
    fits = [b for b in boxes
            if row["x"] + cw <= b[2] and row["y"] + ch <= b[3]]
    if not fits:
        return boxes[0][:2]
    return max(fits, key=lambda b: b[2] * b[3])[:2]


def place(row: dict, cache: AssetCache,
          origin: tuple[int, int] = (0, 0)) -> list[Placed]:
    """把一次构造展开成若干已定位的图层。顶层元素用自身坐标，子级加上容器原点。"""
    if row["x"] is None or row["y"] is None:
        return []
    ox, oy = (0, 0) if row.get("callee") == TOPLEVEL_CALLEE else origin
    # ⚠️ 容器原点也可能解不出来（战斗界面有几簇没有可匹配的静态元素）——
    # 当 0 处理，画个样子出来，别整条链崩掉。
    ox, oy = (ox or 0), (oy or 0)
    name = row["asset"].split("\\")[-1]
    parsed = cache.get(name)
    if not parsed:
        return []
    _, _, _, frames = parsed

    static = row["frame"] is not None
    idx = row["frame"] if static else DEFAULT_FRAME
    if not 0 <= idx < len(frames):
        idx = 0
    dx, dy = (row["offset"] or (0, 0))

    out: list[Placed] = []
    # **图层表的先后就是绘制顺序，不要按 depth 排。**
    # 全库复核：MenusDir 里 152 个多层帧，把 `depth == 0xFFFFFFFF` 的层剔掉之后，
    # 表顺序**无一例外**是 depth 升序 —— 也就是说表顺序已经等于 depth 想表达的次序，
    # 排序不会带来任何新信息，只会被 0xFFFFFFFF 坑。
    # ⚠️ 0xFFFFFFFF **不是"最大所以最上层"，是"没设"的哨兵**。
    # 曾把它当最大值排到顶，结果标签栏帧 0~6 的高亮块（depth=5）被压到
    # 文字条（depth=0xFFFFFFFF）底下，选中的那两个字变成一团灰糊；
    # 而帧 7/8 的高亮块恰好也写着 0xFFFFFFFF、靠稳定排序留在了表尾，
    # 于是只有「机能」「离开」两格是对的 —— 一眼就能看出是排序错，不是坐标错。
    # 正确观感见二级菜单的同一套三层写法（MEN5005 / MEN4001）：
    # 底板(unknown7) → 文字条(normal) → 高亮块(subtract16)，高亮**永远是最后一层**。
    for layer in frames[idx].layers:
        img = cache.layer_image(name, layer.image_index)
        if img is None:
            continue
        # ⚠️ **图层坐标可能是 None**（战斗界面的 `ITF*` 里有这种），
        # 菜单素材没遇到过，所以原先直接相加 —— 拼战斗页时当场 TypeError。
        out.append(Placed(asset=name,
                          x=ox + row["x"] + (layer.x or 0) + dx,
                          y=oy + row["y"] + (layer.y or 0) + dy,
                          image=img, static=static,
                          depth=layer.depth, blend=layer.blend, alpha=layer.alpha))
    return out


def _clip(p: Placed) -> tuple[np.ndarray, int, int, int, int] | None:
    """把一层裁到画面内，返回 (RGBA 浮点数组, x0, y0, x1, y1)。全在画外返回 None。"""
    x0, y0 = max(0, p.x), max(0, p.y)
    x1 = min(SCREEN[0], p.x + p.image.width)
    y1 = min(SCREEN[1], p.y + p.image.height)
    if x1 <= x0 or y1 <= y0:
        return None
    tile = p.image.crop((x0 - p.x, y0 - p.y, x1 - p.x, y1 - p.y))
    return np.asarray(tile, dtype=np.float64), x0, y0, x1, y1


def apply_layer(canvas: np.ndarray, p: Placed, unknown_blend: str) -> None:
    """把一层按它自己的混合模式画到画布上（就地修改 canvas 的 RGB 与覆盖标记）。

    模式取自 SF2 图层记录的「绘制模式」字段，社区文档只列了
    `0 正常 / 1 16级alpha / 2 16级Subtract / 4 不透明 / 5 反色`；
    实际归档里还有 **7 号 131 层、8 号 81 层**，两者 alpha 恒为 0，语义未证实，
    统一交给 `unknown_blend` 决定，好用原作截图反推。

    ⚠️ 一直忽略这个字段的后果见 `docs/判据/数据链路.md` §8.19：标签栏画成亮金实心条、
    天书页记录条画成不透明，都是这么来的。
    """
    clipped = _clip(p)
    if clipped is None:
        return
    tile, x0, y0, x1, y1 = clipped
    src, cover = tile[:, :, :3], tile[:, :, 3] > 0
    if not cover.any():
        return

    mode = unknown_blend if p.blend in ("unknown7", "unknown8") else p.blend
    dst = canvas[y0:y1, x0:x1, :3]
    factor = (p.alpha / ALPHA_MAX) if p.alpha else 1.0

    if mode == "subtract16":
        # ⚠️ 社区文档把 2 号叫「16级Subtract」，但**实际效果是加亮不是减色**。
        # 按字面写成 dst-src，标签栏选中项会被涂成黑块（用户实机对比发现）；
        # 原作那一格实测比邻格亮 +35。改成加法后与原作一致。
        out = dst + src * factor
    elif mode == "alpha16":
        out = dst * (1.0 - factor) + src * factor
    elif mode == "invert":
        out = 255.0 - dst
    elif mode == "multiply":
        out = dst * src / 255.0
    elif mode == "screen":
        out = 255.0 - (255.0 - dst) * (255.0 - src) / 255.0
    elif mode == "add":
        out = dst + src
    elif mode == "half":
        out = (dst + src) * 0.5
    else:                                    # normal / opaque
        out = src

    dst[cover] = np.clip(out, 0.0, 255.0)[cover]
    canvas[y0:y1, x0:x1, 3][cover] = 255.0


def compose(placed: list[Placed], only_static: bool = False,
            unknown_blend: str = DEFAULT_UNKNOWN_BLEND) -> tuple[PILImage.Image, np.ndarray]:
    """画到 640×480 画布，返回 (图, 有内容的掩码)。

    次序：**元素之间按构造顺序，元素内部按图层表顺序**（见 `place` 里的说明，
    表顺序即绘制顺序，depth 不作排序键）。
    """
    canvas = np.zeros((SCREEN[1], SCREEN[0], 4), dtype=np.float64)
    for layer in placed:
        if only_static and not layer.static:
            continue
        apply_layer(canvas, layer, unknown_blend)

    mask = canvas[:, :, 3] > 0
    img = PILImage.fromarray(np.clip(canvas, 0, 255).astype(np.uint8), "RGBA")
    return img, mask


def best_offset(template: np.ndarray, mask: np.ndarray,
                shot: np.ndarray) -> tuple[int, int, float]:
    """带掩码的平移搜索：找 (dx,dy) 使模板与截图的均方差最小。

    ⚠️ 必须用**线性**相关（零填充），不能直接对等长数组做 FFT ——
    那是循环相关，平移出画面的部分会绕回来，重叠像素数恒等于全量，
    于是"移出去只剩一角"这种假解拿不到应有的惩罚。

    SSD 拆成三项相关来算：

        SSD(d) = Σ m·T²  −  2·corr(m·T, I)(d)  +  corr(m, I²)(d)

    返回 (dx, dy, 每像素 RMS 误差)。重叠不足 MIN_OVERLAP 的平移量作废。
    """
    from scipy.signal import fftconvolve

    h, w = shot.shape
    th, tw = mask.shape
    t = np.where(mask, template, 0).astype(np.float64)
    m = mask.astype(np.float64)
    img = shot.astype(np.float64)

    def corr(a: np.ndarray, b: np.ndarray) -> np.ndarray:
        """corr(a,b)[dy,dx] = Σ a(y,x)·b(y+dy, x+dx)，索引已归到 (dy+th-1, dx+tw-1)。"""
        return fftconvolve(b, a[::-1, ::-1], mode="full")

    ssd = (float((m * t * t).sum())
           - 2.0 * corr(m * t, img)
           + corr(m, img * img))
    count = corr(m, np.ones_like(img))

    total = float(m.sum())
    with np.errstate(invalid="ignore", divide="ignore"):
        rms = np.sqrt(np.maximum(ssd, 0.0) / np.maximum(count, 1.0))
    rms = np.where(count >= MIN_OVERLAP * total, rms, np.inf)
    if not np.isfinite(rms).any():
        return 0, 0, float("inf")

    flat = int(np.argmin(rms))
    iy, ix = divmod(flat, rms.shape[1])
    return ix - (tw - 1), iy - (th - 1), float(rms.flat[flat])


def rms_at_origin(template: np.ndarray, mask: np.ndarray, shot: np.ndarray) -> float:
    """不平移，直接比。**这是定页面的主判据。**

    实测下来绝大多数簇的容器原点就是 (0,0)（簇 21/26/27/28/29/35 搜出来都是），
    而全屏背景那类簇纹理均匀、平移代价极小，搜索反而会被带偏。
    要定「这一簇属于哪一页」，固定原点比搜索稳得多。
    """
    if not mask.any():
        return float("inf")
    diff = template.astype(np.float64) - shot.astype(np.float64)
    return float(np.sqrt((diff[mask] ** 2).mean()))


def load_shot(path: Path) -> np.ndarray:
    img = PILImage.open(path).convert("L")
    if img.size != SCREEN:
        img = img.resize(SCREEN, PILImage.LANCZOS)   # 639×480 这类缩放过的先统一
    return np.array(img)


def clusters_from(rows: list[dict]) -> dict[int, list[dict]]:
    out: dict[int, list[dict]] = {}
    ordered = sorted(rows, key=lambda r: int(r["call_site"], 16))
    gid, last = 1, None
    for r in ordered:
        cs = int(r["call_site"], 16)
        if last is not None and cs - last > CLUSTER_GAP:
            gid += 1
        out.setdefault(gid, []).append(r)
        last = cs
    return out


def main(argv: list[str]) -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("layout", type=Path)
    ap.add_argument("archive", type=Path)
    ap.add_argument("-o", "--outdir", type=Path, default=Path("out/pages"))
    ap.add_argument("--shots", type=Path, default=None, help="原作截图目录")
    ap.add_argument("--cluster", type=int, default=None)
    args = ap.parse_args(argv)

    rows = json.loads(args.layout.read_text())
    cache = AssetCache(load_entries(args.archive))
    groups = clusters_from(rows)
    args.outdir.mkdir(parents=True, exist_ok=True)

    shots = {}
    if args.shots:
        for p in sorted(args.shots.iterdir()):
            if p.suffix.lower() in (".png", ".jpg", ".jpeg"):
                shots[p.stem] = load_shot(p)
        print(f"截图 {len(shots)} 张：{', '.join(shots)}\n")

    report = []
    for gid, group in groups.items():
        if args.cluster and gid != args.cluster:
            continue
        boxes = toplevel_boxes(group, cache)
        placed = [pl for row in group
                  for pl in place(row, cache, pick_origin(row, boxes, cache))]
        if not placed:
            continue
        full, _ = compose(placed)
        full.save(args.outdir / f"cluster{gid:02d}.png")

        # 匹配必须用**只含静态元素**的那张：拿完整图当模板的话，动态元素
        # （按当前角色取帧的立绘、按属性值取帧的柱子）会盖在静态区上，
        # 掩码说"这里是静态背景"，模板里却是一张未必对的立绘。
        static_img, static_mask = compose(placed, only_static=True)
        line = {"cluster": gid, "elements": len(group), "static_px": int(static_mask.sum())}

        if shots and static_mask.sum() >= MIN_MATCH_PIXELS:
            gray = np.array(static_img.convert("L"))
            scored = []
            for name, shot in shots.items():
                fixed = rms_at_origin(gray, static_mask, shot)
                scored.append((fixed, name))
            scored.sort()
            line["fixed"] = [{"page": n, "rms": round(r, 2)} for r, n in scored]
            # 只对最优那一页搜平移量，用来求容器原点
            top = scored[0][1]
            dx, dy, rms = best_offset(gray, static_mask, shots[top])
            line["best"] = [{"page": top, "rms": round(rms, 2), "dx": dx, "dy": dy}]
        report.append(line)
        assets = sorted({r['asset'].split('\\')[-1].upper().replace('.SF2', '')
                         for r in group})
        fixed = line.get("fixed")
        if fixed:
            margin = fixed[1]["rms"] - fixed[0]["rms"]
            b = line["best"][0]
            tag = (f"→ {fixed[0]['page']} rms={fixed[0]['rms']:6.2f} "
                   f"(次优 {fixed[1]['page']} {fixed[1]['rms']:.2f}, 差 {margin:5.2f}) "
                   f"搜到平移({b['dx']},{b['dy']})")
        else:
            tag = "（静态像素太少，不匹配）"
        print(f"簇{gid:2d} {len(group):2d}个 静态{line['static_px']:6d}px {tag}")
        print(f"        {' '.join(assets)}")

    (args.outdir / "match.json").write_text(
        json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"\n-> {args.outdir}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
