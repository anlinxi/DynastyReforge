"""高清素材（UI-10 H5 试做）：用 Real-ESRGAN 把地图底图、立绘、战斗背景放大 4 倍。

产物写到 game/public/assets-hd/（衍生素材，不进仓库），并写 manifest.json 供游戏在 ?hd=1 时查：
  {"scale": 4, "maps": {"MP0301": "maps/MP0301/ground.jpg"}, "portraits": {...}, "floors": {...}}

模型（2026-09-29 用户按试样对比选定）：
  地图底图、战斗背景 → realesrgan-x4plus（通用，保留质感）
  立绘                → realesrgan-x4plus-anime（动漫插画，线条干净）
  菜单形象、界面包形象 → 同立绘（2026-09-30 用户要求：人物菜单半身像 MEN0002、天书侧脸 MEN8007、
                         诸态头像 ITF0051、战斗状态栏头像 ITF0002）。逐帧放大再拼回，避免相邻人物互相渗色。
                         像素小人 MEN7003 不做：AI 放大后难看，改走 xBR（hdAssets.PIXEL_MENU_SHEETS）。
  界面（--ui）         → realesrgan-x4plus，**存 2 倍**（用户 2026-09-30 看过 B2 对比后选定；4 倍时菜单一次加载
                         约 850 MB 显存、15 张图宽超 8192）：其余菜单精灵表与界面包，逐帧拼进带 16 像素透明间隔的
                         大图一次放大（省去逐帧启动模型），放大 4 倍后缩到 2 倍，再按原布局拼回；清单里记各自倍数。

用法：
  python3 tools/hd_upscale.py --esrgan <realesrgan-ncnn-vulkan 路径> --maps MP0301 MP0304 --floors all --portraits all
  python3 tools/hd_upscale.py --esrgan <...> --menus MEN0002 MEN8007 --packs ITF0051 ITF0002
  python3 tools/hd_upscale.py --esrgan <...> --ui
已生成的文件跳过（--force 重做）。只处理带 ground 的非多层地图；多层地图（MAP-17）暂不支持。
"""
import argparse
import shutil
import json
import subprocess
import sys
import tempfile
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
#: 素材根目录（提取输出目录，即 game/public）。`--public` 可改，见 main。
PUBLIC = ROOT / 'game/public'
ASSETS = PUBLIC / 'assets'
OUT = PUBLIC / 'assets-hd'
SCALE = 4
MAP_MODEL = 'realesrgan-x4plus'
PORTRAIT_MODEL = 'realesrgan-x4plus-anime'
JPEG_QUALITY = 90


def run_esrgan(esrgan: Path, src: Path, dst: Path, model: str) -> None:
    cmd = [str(esrgan), '-i', str(src), '-o', str(dst), '-n', model, '-s', str(SCALE),
           '-m', str(esrgan.parent / 'models')]
    result = subprocess.run(cmd, capture_output=True, text=True)
    if result.returncode != 0 or not dst.exists():
        raise RuntimeError(f'Real-ESRGAN 失败：{src}\n{result.stderr[-800:]}')


#: 立绘存 2 倍（用户 2026-09-30 看 4/2 倍对比后定）：4 倍全量约 1.2 GB 显存，2 倍约 0.3 GB。
PORTRAIT_STORE_SCALE = 2


def upscale_image(esrgan: Path, image: Image.Image, dst: Path, model: str, keep_alpha: bool,
                  store_scale: int = SCALE) -> None:
    """放大一张图并存到 dst（.jpg 去透明，.png 保留透明）；store_scale 小于模型倍数时缩到该倍数再存。"""
    dst.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory() as tmp:
        src = Path(tmp) / 'in.png'
        out = Path(tmp) / 'out.png'
        (image if keep_alpha else image.convert('RGB')).save(src)
        run_esrgan(esrgan, src, out, model)
        result = Image.open(out)
        expected = (image.width * SCALE, image.height * SCALE)
        if result.size != expected:
            raise RuntimeError(f'{dst}: 输出尺寸 {result.size} ≠ {expected}')
        if store_scale != SCALE:
            result = downscale(result.convert('RGBA'), (image.width * store_scale, image.height * store_scale))
        if dst.suffix == '.jpg':
            result.convert('RGB').save(dst, quality=JPEG_QUALITY)
        else:
            result.save(dst)


def map_jobs(map_ids):
    for map_id in map_ids:
        meta = json.loads((ASSETS / 'maps' / map_id / 'map.json').read_text(encoding='utf-8'))
        if meta.get('layers') or meta.get('layeredGround'):
            print(f'跳过 {map_id}：多层地图暂不支持', file=sys.stderr)
            continue
        if not meta.get('ground'):
            continue
        rel = f'maps/{map_id}/ground.jpg'
        yield map_id, rel, lambda m=meta, i=map_id: Image.open(ASSETS / 'maps' / i / m['ground'])


def floor_jobs(keys):
    for key in keys:
        atlas = json.loads((ASSETS / key / f'{key}.json').read_text(encoding='utf-8'))
        tex = atlas['textures'][0]
        frame = next(f for f in tex['frames'] if f['filename'] == 'img_000')['frame']
        box = (frame['x'], frame['y'], frame['x'] + frame['w'], frame['y'] + frame['h'])
        rel = f'floors/{key}.jpg'
        yield key, rel, lambda t=tex, k=key, b=box: Image.open(ASSETS / k / t['image']).crop(b)


def portrait_jobs(codes):
    for code in codes:
        data = json.loads((ASSETS / 'portraits' / code / 'portrait.json').read_text(encoding='utf-8'))
        for frame in data.get('frames') or []:
            if not frame:
                continue
            rel = f"portraits/{code}/{frame['file']}"
            yield rel, rel, lambda c=code, f=frame['file']: Image.open(ASSETS / 'portraits' / c / f)


def upscale_cells(esrgan: Path, sheet: Image.Image, boxes, model: str) -> Image.Image:
    """逐格放大：每个 (x, y, w, h) 单独放大后贴到 4 倍大的新图的对应位置。"""
    out = Image.new('RGBA', (sheet.width * SCALE, sheet.height * SCALE), (0, 0, 0, 0))
    with tempfile.TemporaryDirectory() as tmp:
        for i, (x, y, w, h) in enumerate(boxes):
            if w <= 0 or h <= 0:
                continue
            src = Path(tmp) / f'c{i}.png'
            dst = Path(tmp) / f'c{i}-out.png'
            sheet.crop((x, y, x + w, y + h)).save(src)
            run_esrgan(esrgan, src, dst, model)
            cell = Image.open(dst).convert('RGBA')
            if cell.size != (w * SCALE, h * SCALE):
                raise RuntimeError(f'格 {i} 输出尺寸 {cell.size} ≠ {(w * SCALE, h * SCALE)}')
            out.paste(cell, (x * SCALE, y * SCALE))
    return out


def menu_jobs(esrgan: Path, assets):
    """菜单精灵表（menus.json 的 cell/cols/count 网格）。产物：assets-hd/menus/<sheet>。"""
    spec = json.loads((ASSETS / 'menus' / 'menus.json').read_text(encoding='utf-8'))['assets']
    for asset in assets:
        meta = spec[asset]
        cw, ch = meta['cell']
        boxes = [((i % meta['cols']) * cw, (i // meta['cols']) * ch, cw, ch) for i in range(meta['count'])]
        rel = f"menus/{meta['sheet']}"
        yield asset, rel, lambda m=meta, b=boxes: upscale_cells(
            esrgan, Image.open(ASSETS / 'menus' / m['sheet']).convert('RGBA'), b, PORTRAIT_MODEL)


def pack_jobs(esrgan: Path, keys, force: bool):
    """界面/战斗动画包的图集：每帧放大贴到 4 倍页上，图集 JSON 坐标同乘 4。产物：assets-hd/<key>/。"""
    for key in keys:
        anim = json.loads((ASSETS / key / 'anim.json').read_text(encoding='utf-8'))
        atlas_name = anim['atlas']['json']
        atlas = json.loads((ASSETS / key / atlas_name).read_text(encoding='utf-8'))
        out_dir = OUT / key
        out_dir.mkdir(parents=True, exist_ok=True)
        for tex in atlas['textures']:
            dst = out_dir / tex['image']
            if force or not dst.exists():
                page = Image.open(ASSETS / key / tex['image']).convert('RGBA')
                boxes = [(f['frame']['x'], f['frame']['y'], f['frame']['w'], f['frame']['h']) for f in tex['frames']]
                upscale_cells(esrgan, page, boxes, PORTRAIT_MODEL).save(dst)
            tex['size'] = {k: v * SCALE for k, v in tex['size'].items()}
            tex['scale'] = 1
            for f in tex['frames']:
                for part in ('frame', 'spriteSourceSize', 'sourceSize'):
                    f[part] = {k: v * SCALE for k, v in f[part].items()}
        (out_dir / atlas_name).write_text(json.dumps(atlas, ensure_ascii=False), encoding='utf-8')
        yield key, f'{key}/{atlas_name}'


UI_SCALE = 2
UI_MODEL = 'realesrgan-x4plus'
UI_GUTTER = 16
UI_SHEET_W = 2048
# 已单独做过 4 倍的人物形象、像素小人（走 xBR）不在界面批次里
UI_SKIP_MENUS = {'MEN0002', 'MEN8007', 'MEN7003'}
UI_SKIP_PACKS = {'ITF0002', 'ITF0051'}


GLYPH_MAX_H = 16

#: 界面语言版（`game/src/systems/uiLocales.json` 的键）：简体菜单表与界面包另有一套图，单独放大（用户 2026-09-30 要求）。
UI_LOCALES = {'chs': '简'}


def ui_sources(locale=None):
    """界面批次的来源：(menus.json, 界面包目录列表, 是否只取语言版菜单表)。"""
    if not locale:
        return ASSETS / 'menus' / 'menus.json', sorted(p.parent for p in ASSETS.glob('ITF*/anim.json')), False
    paths = json.loads((ROOT / 'game/src/systems/uiLocales.json').read_text(encoding='utf-8'))[UI_LOCALES[locale]]
    packs = sorted(PUBLIC / target for source, target in paths.items()
                   if Path(source).name.startswith('ITF') and (PUBLIC / target / 'anim.json').exists())
    return ASSETS / 'locales' / locale / 'menus' / 'menus.json', packs, True


def ui_glyph_assets(locale=None):
    """数字、小字形与细条（实际内容高 ≤16 像素）：AI 放大小字形会画出杂色镶边（用户 2026-09-30 看到红色数字坏了），
    这些不做 AI，运行时原图走 xBR。返回 (菜单表集合, 界面包集合)。"""
    spec_path, pack_dirs, _ = ui_sources(locale)
    spec = json.loads(spec_path.read_text(encoding='utf-8'))['assets']
    menus = {k for k, m in spec.items() if m['cell'][1] <= GLYPH_MAX_H}
    packs = set()
    for anim_path in (d / 'anim.json' for d in pack_dirs):
        anim = json.loads(anim_path.read_text(encoding='utf-8'))
        if not anim.get('atlas'):
            continue
        atlas = json.loads((anim_path.parent / anim['atlas']['json']).read_text(encoding='utf-8'))
        tallest = 0
        for tex in atlas['textures']:
            page = Image.open(anim_path.parent / tex['image']).convert('RGBA')
            for f in tex['frames']:
                r = f['frame']
                box = page.crop((r['x'], r['y'], r['x'] + r['w'], r['y'] + r['h'])).getbbox()
                if box:
                    tallest = max(tallest, box[3] - box[1])
        if tallest <= GLYPH_MAX_H:
            packs.add(anim_path.parent.name)
    return menus, packs


def ui_cells(locale=None):
    """界面批次的全部帧：(组, 素材, 源图路径, 格/帧框)。菜单跳过人物形象与物品插图表；语言版只取该语言自己的图。"""
    spec_path, pack_dirs, localized_only = ui_sources(locale)
    spec = json.loads(spec_path.read_text(encoding='utf-8'))
    art = set(spec.get('artwork', {}).get('tables', []))
    glyph_menus, glyph_packs = ui_glyph_assets(locale)
    for asset, meta in spec['assets'].items():
        if asset in UI_SKIP_MENUS or asset in art or asset in glyph_menus:
            continue
        if localized_only and 'locales/' not in meta['sheet']:
            continue
        cw, ch = meta['cell']
        sheet = (ASSETS / 'menus' / meta['sheet']).resolve()  # 简体表写成 ../locales/chs/menus/…
        for i in range(meta['count']):
            yield 'menus', asset, sheet, ((i % meta['cols']) * cw, (i // meta['cols']) * ch, cw, ch)
    for anim_path in (d / 'anim.json' for d in pack_dirs):
        key = anim_path.parent.name
        anim = json.loads(anim_path.read_text(encoding='utf-8'))
        if key in UI_SKIP_PACKS or key in glyph_packs or not anim.get('atlas'):
            continue
        atlas = json.loads((anim_path.parent / anim['atlas']['json']).read_text(encoding='utf-8'))
        for tex in atlas['textures']:
            for f in tex['frames']:
                fr = f['frame']
                yield 'packs', key, anim_path.parent / tex['image'], (fr['x'], fr['y'], fr['w'], fr['h'])


def shelf_pack(sizes, width):
    """简单货架排布：返回每块的 (x, y) 与总高。块间与四周留 UI_GUTTER 透明间隔。"""
    x = y = UI_GUTTER
    row_h = 0
    spots = []
    for w, h in sizes:
        if x + w + UI_GUTTER > width and x > UI_GUTTER:
            x = UI_GUTTER
            y += row_h + UI_GUTTER
            row_h = 0
        spots.append((x, y))
        x += w + UI_GUTTER
        row_h = max(row_h, h)
    return spots, y + row_h + UI_GUTTER


def downscale(image: Image.Image, size) -> Image.Image:
    """带透明的缩小先预乘，避免透明边缘发黑。"""
    return image.convert('RGBa').resize(size, Image.LANCZOS).convert('RGBA')


def upscale_batch(esrgan: Path, crops):
    """把一批小图拼成大图放大 4 倍、缩到 UI_SCALE 倍，再切回。返回与 crops 同序的结果。"""
    spots, height = shelf_pack([c.size for c in crops], UI_SHEET_W)
    sheet = Image.new('RGBA', (UI_SHEET_W, height), (0, 0, 0, 0))
    for c, (x, y) in zip(crops, spots):
        sheet.paste(c, (x, y))
    with tempfile.TemporaryDirectory() as tmp:
        src, dst = Path(tmp) / 'in.png', Path(tmp) / 'out.png'
        sheet.save(src)
        run_esrgan(esrgan, src, dst, UI_MODEL)
        big = Image.open(dst).convert('RGBA')
    big = downscale(big, (UI_SHEET_W * UI_SCALE, height * UI_SCALE))
    return [big.crop((x * UI_SCALE, y * UI_SCALE, (x + c.width) * UI_SCALE, (y + c.height) * UI_SCALE))
            for c, (x, y) in zip(crops, spots)]


def build_ui(esrgan: Path, manifest: dict, force: bool, locale=None) -> None:
    """界面批次：全部帧分批放大后，按原布局拼回菜单表与界面包图集，写清单（带倍数）。
    语言版写进 manifest.locales[locale]，产物在 ui/locales/<locale>/ 下。"""
    target = manifest.setdefault('locales', {}).setdefault(locale, {}) if locale else manifest
    target.setdefault('menus', {})
    target.setdefault('packs', {})
    cells = list(ui_cells(locale))
    sources = {}
    crops = []
    for group, asset, path, (x, y, w, h) in cells:
        img = sources.setdefault(path, Image.open(path).convert('RGBA'))
        crops.append(img.crop((x, y, x + w, y + h)))
    results = []
    batch, area = [], 0
    for c in crops + [None]:
        if c is not None and area + c.width * c.height < 1_500_000:
            batch.append(c)
            area += (c.width + UI_GUTTER) * (c.height + UI_GUTTER)
            continue
        if batch:
            results += upscale_batch(esrgan, batch)
            print(f'ui: {len(results)}/{len(crops)}', flush=True)
        batch, area = ([c], (c.width + UI_GUTTER) * (c.height + UI_GUTTER)) if c is not None else ([], 0)
    # 按原布局拼回：每张源图一张 UI_SCALE 倍的新图
    outputs = {}
    for (group, asset, path, (x, y, w, h)), up in zip(cells, results):
        base = sources[path]
        canvas = outputs.setdefault(path, Image.new('RGBA', (base.width * UI_SCALE, base.height * UI_SCALE), (0, 0, 0, 0)))
        canvas.paste(up, (x * UI_SCALE, y * UI_SCALE))
    for path, canvas in outputs.items():
        rel = path.relative_to(ASSETS)
        dst = OUT / 'ui' / rel
        dst.parent.mkdir(parents=True, exist_ok=True)
        canvas.save(dst)
    for group, asset, path, _ in cells:
        if group == 'menus':
            target['menus'][asset] = {'path': f"ui/{path.relative_to(ASSETS).as_posix()}", 'scale': UI_SCALE}
    pack_dirs = {p.parent for g, _, p, _ in cells if g == 'packs'}
    for folder in sorted(pack_dirs):
        key = folder.name
        rel_dir = folder.relative_to(ASSETS).as_posix()
        anim = json.loads((folder / 'anim.json').read_text(encoding='utf-8'))
        name = anim['atlas']['json']
        atlas = json.loads((folder / name).read_text(encoding='utf-8'))
        for tex in atlas['textures']:
            tex['size'] = {k: v * UI_SCALE for k, v in tex['size'].items()}
            tex['scale'] = 1
            for f in tex['frames']:
                for part in ('frame', 'spriteSourceSize', 'sourceSize'):
                    f[part] = {k: v * UI_SCALE for k, v in f[part].items()}
        (OUT / 'ui' / rel_dir / name).write_text(json.dumps(atlas, ensure_ascii=False), encoding='utf-8')
        target['packs'][key] = {'path': f'ui/{rel_dir}/{name}', 'scale': UI_SCALE}
    glyph_menus, glyph_packs = ui_glyph_assets(locale)
    target['xbr'] = {'menus': sorted(glyph_menus), 'packs': sorted(glyph_packs)}


def portraits_to_store_scale(backup: Path) -> None:
    """已有 4 倍立绘缩到 PORTRAIT_STORE_SCALE 倍存回原路径，清单改为带倍数；4 倍原图移到 backup（不进构建）。"""
    manifest_path = OUT / 'manifest.json'
    manifest = json.loads(manifest_path.read_text(encoding='utf-8'))
    done = 0
    for key, entry in manifest.get('portraits', {}).items():
        if not isinstance(entry, str):
            continue                                  # 已是带倍数的新格式
        src = OUT / entry
        keep = backup / entry
        keep.parent.mkdir(parents=True, exist_ok=True)
        shutil.move(src, keep)
        big = Image.open(keep).convert('RGBA')
        size = (big.width * PORTRAIT_STORE_SCALE // SCALE, big.height * PORTRAIT_STORE_SCALE // SCALE)
        downscale(big, size).save(src)
        manifest['portraits'][key] = {'path': entry, 'scale': PORTRAIT_STORE_SCALE}
        done += 1
    manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=1), encoding='utf-8')
    print(f'portraits → {PORTRAIT_STORE_SCALE}x: {done}，4 倍原图备份在 {backup}')


def resolve(values, universe):
    return sorted(universe) if values == ['all'] else values


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--esrgan', required=True, type=Path, help='realesrgan-ncnn-vulkan 可执行文件')
    parser.add_argument('--maps', nargs='*', default=[])
    parser.add_argument('--floors', nargs='*', default=[], help='FLR 包名，或 all')
    parser.add_argument('--portraits', nargs='*', default=[], help='立绘代码，或 all')
    parser.add_argument('--menus', nargs='*', default=[], help='菜单精灵表名，如 MEN0002')
    parser.add_argument('--packs', nargs='*', default=[], help='动画包名（图集），如 ITF0051')
    parser.add_argument('--ui', action='store_true', help='界面批次（菜单表与界面包，存 2 倍）')
    parser.add_argument('--ui-locale', choices=sorted(UI_LOCALES), help='语言版界面批次（只放大该语言自己的菜单表与界面包）')
    parser.add_argument('--portraits-to-2x', type=Path, metavar='备份目录',
                        help='把已有 4 倍立绘缩成 2 倍（不重跑 AI），原 4 倍图先移到备份目录')
    parser.add_argument('--force', action='store_true')
    parser.add_argument('--public', type=Path, help='素材根目录（提取输出目录），默认仓库 game/public；高清图写到其下 assets-hd/')
    args = parser.parse_args()
    if args.public:
        global PUBLIC, ASSETS, OUT
        PUBLIC = args.public.resolve()
        ASSETS, OUT = PUBLIC / 'assets', PUBLIC / 'assets-hd'
    if args.portraits_to_2x:
        portraits_to_store_scale(args.portraits_to_2x)
        return
    if not args.esrgan.exists():
        sys.exit(f'找不到 Real-ESRGAN：{args.esrgan}')

    manifest_path = OUT / 'manifest.json'
    manifest = json.loads(manifest_path.read_text(encoding='utf-8')) if manifest_path.exists() else {}
    manifest = {'scale': SCALE, 'maps': {}, 'floors': {}, 'portraits': {}, 'menus': {}, 'packs': {}, **manifest}

    floors = resolve(args.floors, [p.name for p in ASSETS.glob('FLR*') if (p / f'{p.name}.json').exists()])
    portraits = resolve(args.portraits, [p.name for p in (ASSETS / 'portraits').iterdir()
                                         if (p / 'portrait.json').exists()])
    groups = [
        ('maps', map_jobs(args.maps), MAP_MODEL, False, SCALE),
        ('floors', floor_jobs(floors), MAP_MODEL, False, SCALE),
        ('portraits', portrait_jobs(portraits), PORTRAIT_MODEL, True, PORTRAIT_STORE_SCALE),
    ]
    for group, jobs, model, alpha, store in groups:
        done = 0
        for key, rel, load in jobs:
            dst = OUT / rel
            if args.force or not dst.exists():
                upscale_image(args.esrgan, load(), dst, model, alpha, store)
            manifest[group] = {**manifest[group], key: rel if store == SCALE else {'path': rel, 'scale': store}}
            done += 1
        print(f'{group}: {done}')
        manifest_path.parent.mkdir(parents=True, exist_ok=True)
        manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=1), encoding='utf-8')

    for asset, rel, build in menu_jobs(args.esrgan, args.menus):
        dst = OUT / rel
        if args.force or not dst.exists():
            dst.parent.mkdir(parents=True, exist_ok=True)
            build().save(dst)
        manifest['menus'] = {**manifest['menus'], asset: rel}
    for key, rel in pack_jobs(args.esrgan, args.packs, args.force):
        manifest['packs'] = {**manifest['packs'], key: rel}
    print(f"menus: {len(args.menus)}  packs: {len(args.packs)}")
    if args.ui:
        build_ui(args.esrgan, manifest, args.force)
    if args.ui_locale:
        build_ui(args.esrgan, manifest, args.force, args.ui_locale)
    manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=1), encoding='utf-8')


if __name__ == '__main__':
    main()
