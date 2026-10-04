#!/usr/bin/env python3
"""只导出简体文字美术差异，复用正式菜单/动画/精灵导出器，不接入MOD数值。"""
import argparse
import json
import tempfile
from pathlib import Path
import dat_unpack
import compose_page as C
from export_menu_ui import sheet_for
from export_sprite import export as export_sprite
from export_pack import export_one


def archive(root, name, loose):
    p = next(p for p in root.iterdir() if p.name.lower() == name.lower())
    result = {}
    with p.open('rb') as f:
        for e in dat_unpack.read_entries(f, p.stat().st_size):
            if not e.name.upper().endswith('.SF2'): continue
            f.seek(e.offset); result[e.name.upper()] = f.read(e.size)
    folder = next((p for p in root.iterdir() if p.is_dir() and p.name.lower() == loose), None)
    for p in folder.iterdir() if folder else []:
        if p.suffix.lower() == '.sf2': result[p.name.upper()] = p.read_bytes()
    return result


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument('--official', type=Path, required=True, help='官方multimedia')
    ap.add_argument('--chs', type=Path, required=True, help='简体美术chs目录')
    ap.add_argument('--out', type=Path, default=Path('game/public/assets'))
    args = ap.parse_args()
    out = args.out / 'locales/chs'; out.mkdir(parents=True, exist_ok=True)
    normal = archive(args.official, 'MenusDir.DAT', 'menus')
    translated = archive(args.chs, 'MenusDir.DAT', 'menus')
    cache = C.AssetCache({**normal, **translated})
    spec = json.loads((args.out / 'menus/menus.json').read_text())
    paths = {}
    # Shared geometry and interaction layout, only replace differing SF2 sheets.
    for key, meta in spec['assets'].items():
        # 客房背景没有文字；chs包另换过房间绘图，语言切换不能换场景美术。
        if key == 'MEN9001': continue
        name = key + '.SF2'
        if translated.get(name, normal.get(name)) == normal.get(name): continue
        image, replacement = sheet_for(cache, name)
        target = out / 'menus' / replacement['sheet']; target.parent.mkdir(parents=True, exist_ok=True)
        image.save(target)
        replacement['sheet'] = '../locales/chs/menus/' + replacement['sheet']
        spec['assets'][key] = replacement
    (out / 'menus').mkdir(exist_ok=True)
    (out / 'menus/menus.json').write_text(json.dumps(spec, ensure_ascii=False, separators=(',', ':')))
    paths['assets/menus/menus.json'] = 'assets/locales/chs/menus/menus.json'
    with tempfile.TemporaryDirectory(prefix='youcheng-locale-') as tmp:
        for key in ['MEN9300', 'MEN9301', 'MEN9302', 'MEN9303', 'MEN9304']:
            name = key + '.SF2'
            blob = translated.get(name, normal.get(name))
            if blob == normal.get(name): continue
            src = Path(tmp) / name; src.write_bytes(blob)
            export_sprite(src, out / 'menus')
            paths['assets/menus/' + key] = 'assets/locales/chs/menus/' + key
        normal = archive(args.official / 'fight', 'ItfDir.DAT', 'itf')
        translated = archive(args.chs, 'ItfDir.DAT', 'itf')
        for name, blob in translated.items():
            if blob == normal.get(name): continue
            src = Path(tmp) / name; src.write_bytes(blob)
            export_one(src, out)
            key = src.stem
            paths['assets/' + key] = 'assets/locales/chs/' + key
    manifest = Path('game/src/systems/uiLocales.json')
    manifest.write_text(json.dumps({'简': paths}, ensure_ascii=False, indent=2) + '\n')
    print(f'Exported {len(paths)} localized resource paths; official gameplay data unchanged')

if __name__ == '__main__': main()
