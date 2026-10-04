"""高清素材包：把本机生成好的 assets-hd/ 打成一个 zip，给不方便自己生成的人直接放进去用。

    python3 tools/hd_pack.py make  <素材目录> <输出.zip>     # 素材目录＝提取输出目录（含 assets-hd/）
    python3 tools/hd_pack.py install <包.zip 或文件夹> <素材目录>
    python3 tools/hd_pack.py check <素材目录>

游戏启动时读 `<素材目录>/assets-hd/manifest.json`，有就用高清图、没有就全用原图，所以装包＝放对位置。
装包前后都按清单逐项核对：清单里列的每张图（含图集里引用的贴图页）都要在，缺一张就报错，不装半套。
包里只有 AI 放大后的衍生图，基础素材仍须用自己的原作提取（`tools/extract.py`）。
"""
import argparse
import json
import shutil
import sys
import tempfile
import zipfile
from pathlib import Path

HD_DIR = 'assets-hd'
MANIFEST = 'manifest.json'


def manifest_files(hd: Path) -> list[Path]:
    """清单引用的全部文件（相对 hd）。图集 json 再展开它引用的贴图页。"""
    manifest = json.loads((hd / MANIFEST).read_text(encoding='utf-8'))
    paths: list[str] = []

    def collect(node) -> None:
        if isinstance(node, str) and '/' in node and node.rsplit('.', 1)[-1] in ('png', 'jpg', 'json'):
            paths.append(node)
        elif isinstance(node, dict):
            for key, value in node.items():
                if key != 'xbr':          # xbr 列的是素材名（实时滤镜），不是文件
                    collect(value)
        elif isinstance(node, list):
            for value in node:
                collect(value)

    collect({k: v for k, v in manifest.items() if k != 'scale'})
    files = []
    for rel in paths:
        files.append(Path(rel))
        if rel.endswith('.json') and (hd / rel).exists():
            atlas = json.loads((hd / rel).read_text(encoding='utf-8'))
            for tex in atlas.get('textures', []):
                if isinstance(tex, dict) and tex.get('image'):
                    files.append(Path(rel).parent / tex['image'])
    return files


def check(hd: Path) -> int:
    """缺清单或缺文件就退出；返回清单引用的文件数。"""
    if not (hd / MANIFEST).is_file():
        sys.exit(f'✘ {hd} 里没有 {MANIFEST}，不是高清素材包')
    missing = [str(f) for f in manifest_files(hd) if not (hd / f).is_file()]
    if missing:
        sys.exit(f"✘ 高清素材缺 {len(missing)} 个文件：{'、'.join(missing[:8])}{' …' if len(missing) > 8 else ''}")
    return len(manifest_files(hd))


def make(public: Path, out: Path) -> None:
    hd = public / HD_DIR
    count = check(hd)
    out.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(out, 'w', zipfile.ZIP_STORED) as z:   # png/jpg 已压缩，再压无益
        for f in sorted(hd.rglob('*')):
            if f.is_file():
                z.write(f, Path(HD_DIR) / f.relative_to(hd))
    print(f'✔ 高清素材包 {out}（清单 {count} 个文件，{out.stat().st_size / 1048576:.0f} MB）')


def _find_hd_root(root: Path) -> Path:
    """包里 manifest.json 可能在根上，也可能在 assets-hd/ 下。"""
    for candidate in (root / HD_DIR, root):
        if (candidate / MANIFEST).is_file():
            return candidate
    sys.exit(f'✘ {root} 里找不到 {MANIFEST}，不是高清素材包')


def install(pack: Path, public: Path) -> None:
    if not (public / 'assets').is_dir():
        sys.exit(f'✘ {public} 不是素材目录（要先用 tools/extract.py 提取出 assets/）')
    with tempfile.TemporaryDirectory() as tmp:
        if pack.is_file():
            with zipfile.ZipFile(pack) as z:
                z.extractall(tmp)
            src = _find_hd_root(Path(tmp))
        else:
            src = _find_hd_root(pack)
        count = check(src)
        dst = public / HD_DIR
        if dst.exists():
            shutil.rmtree(dst)
        shutil.copytree(src, dst)
    print(f'✔ 已装入高清素材：{dst}（清单 {count} 个文件）')


def main() -> None:
    for stream in (sys.stdout, sys.stderr):   # 中文 Windows 命令行默认 GBK，打印 ✔ ✘ 会报错
        if hasattr(stream, 'reconfigure'):
            stream.reconfigure(encoding='utf-8', errors='replace')
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest='cmd', required=True)
    m = sub.add_parser('make', help='把素材目录里的 assets-hd/ 打成 zip')
    m.add_argument('public', type=Path)
    m.add_argument('out', type=Path)
    i = sub.add_parser('install', help='把高清素材包装进素材目录')
    i.add_argument('pack', type=Path)
    i.add_argument('public', type=Path)
    c = sub.add_parser('check', help='核对素材目录里的高清素材是否齐全')
    c.add_argument('public', type=Path)
    args = parser.parse_args()
    if args.cmd == 'make':
        make(args.public, args.out)
    elif args.cmd == 'install':
        install(args.pack, args.public)
    else:
        print(f'✔ 高清素材齐全（清单 {check(args.public / HD_DIR)} 个文件）')


if __name__ == '__main__':
    main()
