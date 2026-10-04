#!/usr/bin/env python3
"""导出官方地图/战斗鼠标；复用场景精灵分层、混合模式与图集导出器。

python3 tools/export_cursors.py /path/to/Dynasty/Castle game/public/assets/cursors
地图帧分段来自 CURSOR.SCI +0xe2..0xe7；交互类型对应 SCI Mouse 字段。
"""
import argparse
import hashlib
import json
import tempfile
from pathlib import Path
import dat_unpack
import export_sprite
from PIL import Image


def export(root, out):
    archive = root / 'multimedia/Sys/Sys.dat'
    with archive.open('rb') as fh:
        entries = {e.name.upper(): e for e in dat_unpack.read_entries(fh, archive.stat().st_size)}
        sources = {}
        for name in ('CURSOR.SF2', 'CURSOR.SCI'):
            e = entries[name]
            fh.seek(e.offset)
            sources[name] = fh.read(e.size)
    sci = sources['CURSOR.SCI']
    start, length = sci[0xe4], sci[0xe5]
    disabled = sci[0xe6]
    assert (start, length, disabled) == (9, 25, 184)
    with tempfile.TemporaryDirectory() as temp:
        src = Path(temp) / 'CURSOR.SF2'
        src.write_bytes(sources['CURSOR.SF2'])
        assert export_sprite.export(src, out)
    for name in ('mousedefault', 'mousewait'):
        assert export_sprite.export(root / f'multimedia/fight/mouse/{name}.sf2', out)
    # DOM 影片盖在 Phaser 画布之上，使用同一原作手指的静态 CSS 副本。
    folder = out / 'CURSOR'
    atlas = json.loads((folder / 'CURSOR.json').read_text())
    data = json.loads((folder / 'sprite.json').read_text())
    layer = data['frames'][6]['layers'][0]
    name = f"img_{layer['img']:03d}"
    for page in atlas['textures']:
        for entry in page['frames']:
            if entry['filename'] == name:
                r = entry['frame']
                with Image.open(folder / page['image']) as image:
                    image.crop((r['x'], r['y'], r['x']+r['w'], r['y']+r['h'])).save(out / 'pointer.png')
    spec = {
        'source': 'multimedia/Sys/Sys.dat:CURSOR.SCI/CURSOR.SF2',
        'sha256': {k: hashlib.sha256(v).hexdigest() for k,v in sources.items()},
        'draw': [-320, -260],
        'segments': {kind: [start+i*length, length] for i,kind in enumerate(
            ['inspect', 'pickup', 'talk', 'door', 'place', 'itemTarget', 'book'])},
        'disabled': {kind: disabled+i for i,kind in enumerate(['inspect','pickup','talk','door','place'])},
        # Runtime: south, southwest, west, northwest, north, northeast, east, southeast.
        'directionFrames': [1,8,7,6,5,4,3,2],
    }
    spec['segments']['hand'] = [6, 1]  # 普通指向手指；134 是使用道具时的选对象光标。
    (out/'cursors.json').write_text(json.dumps(spec, ensure_ascii=False, indent=2)+'\n')

if __name__ == '__main__':
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('official', type=Path); p.add_argument('output', type=Path)
    a=p.parse_args(); export(a.official, a.output)
