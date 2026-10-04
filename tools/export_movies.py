#!/usr/bin/env python3
"""把原作的过场影片（Bink Video）转成浏览器能放的 mp4。

## 素材

`multimedia/Mov/1.Dat` … `10.Dat`，共 10 个，合计约 600MB。
文件头是 `BIKi` —— **Bink Video rev.i**，640×480，带一条 Bink Audio 轨。
`.Dat` 只是后缀，不是我们那套归档格式，**不要用 `dat_unpack` 去拆**。

脚本里用 `play_movie{movie: N}`（op 0x98）按编号点播，N 就是文件名。
已知用途：

| 编号 | 时长 | 内容 |
|---|---|---|
| 1 | 191s | 汉堂国际资讯 LOGO + 片头 CG（`MP0000` 槽 8 第一段） |
| 3 | 55s | **梦境**（`MP0000` 槽 8 第二段开头） |
| 10 | 4s | 黑底红字「敗降」—— 战败画面（`MP0000` 槽 9，配 `GameOver.SF2`） |

## 为什么能转

FFmpeg 自带 `binkvideo` 与 `binkaudio_dct/rdft` 解码器，不需要 RAD 的
原版 SDK。实测梦境（55 秒）转码 1.5 秒、产物 2.2MB。

## 用法

    python3 tools/export_movies.py                 # 默认只转开场要用的 1,3
    python3 tools/export_movies.py --movies all    # 全部 10 个
    python3 tools/export_movies.py --movies 1,3,10 --crf 24
"""
from __future__ import annotations

import argparse
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SRC = Path.home() / "Game/幽城幻剑录/Dynasty/Castle/multimedia/Mov"
OUT = ROOT / "game/public/assets/movies"

#: 开场用到的两个。别的等真用到再转 —— 全部 600MB 源，转完也有几十 MB。
DEFAULT_MOVIES = (1, 3)

#: 画质。26 时梦境是 2.2MB / 55 秒，放大到 640×480 的画布上看不出损失。
DEFAULT_CRF = 26


def source_of(index: int, src_dir: Path = None) -> Path | None:
    """`Mov/N.Dat`。大小写不定（`1.Dat` / `1.dat`），两种都试。"""
    base = src_dir or SRC
    for name in (f"{index}.Dat", f"{index}.dat", f"{index}.DAT"):
        path = base / name
        if path.exists():
            return path
    return None


def convert(index: int, out_dir: Path, crf: int, src_dir: Path = None) -> bool:
    src = source_of(index, src_dir)
    if not src:
        print(f"⚠ 找不到影片 {index}（{SRC}）", file=sys.stderr)
        return False
    head = src.open("rb").read(4)
    if head[:3] != b"BIK":
        print(f"⚠ {src.name} 不是 Bink（头 {head!r}），跳过", file=sys.stderr)
        return False

    dst = out_dir / f"mov{index}.mp4"
    cmd = [
        "ffmpeg", "-v", "error", "-y", "-i", str(src),
        "-c:v", "libx264", "-crf", str(crf), "-preset", "slow",
        # ⚠️ **`yuv420p` 不能省** —— 不给的话 x264 会沿用源的采样格式，
        # Safari 与部分安卓浏览器直接放不出来（黑屏，不报错）。
        "-pix_fmt", "yuv420p",
        # 让 <video> 一拿到头就能起播，不必等整个文件。
        "-movflags", "+faststart",
        "-c:a", "aac", "-b:a", "96k",
        str(dst),
    ]
    subprocess.run(cmd, check=True)
    size = dst.stat().st_size
    print(f"  影片 {index}: {src.name} {src.stat().st_size / 1e6:.1f}MB"
          f" → {dst.name} {size / 1e6:.1f}MB")
    return True


def main(argv: list[str]) -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--movies", default=",".join(str(i) for i in DEFAULT_MOVIES),
                    help="要转的编号，逗号分隔；`all` = 全部")
    ap.add_argument("--src", type=Path, default=SRC)
    ap.add_argument("-o", "--out", type=Path, default=OUT)
    ap.add_argument("--crf", type=int, default=DEFAULT_CRF)
    ap.add_argument("--refining", action="store_true", help="转换客栈炼制影片；--src 指向 multimedia/Mov")
    args = ap.parse_args(argv)

    if not shutil.which("ffmpeg"):
        print("找不到 ffmpeg。FFmpeg 自带 Bink 解码器，装上就能转。", file=sys.stderr)
        return 1
    if args.refining:
        args.out.mkdir(parents=True, exist_ok=True)
        src = args.src.parent / "fight/video/move0002.bik"
        subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", str(src), "-c:v", "libx264", "-crf", str(args.crf), "-pix_fmt", "yuv420p", "-movflags", "+faststart", "-c:a", "aac", str(args.out / "refining.mp4")], check=True)
        return 0

    src_dir = args.src
    if not src_dir.is_dir():
        print(f"找不到影片目录：{src_dir}", file=sys.stderr)
        return 1

    if args.movies.strip().lower() == "all":
        wanted = sorted({int(p.stem) for p in src_dir.iterdir()
                         if p.suffix.lower() == ".dat" and p.stem.isdigit()})
    else:
        wanted = [int(s) for s in args.movies.split(",") if s.strip()]

    args.out.mkdir(parents=True, exist_ok=True)
    done = sum(convert(i, args.out, args.crf, src_dir) for i in wanted)
    print(f"-> {args.out}（{done}/{len(wanted)} 个）")
    return 0 if done else 1


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
