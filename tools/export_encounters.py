#!/usr/bin/env python3
"""导出行走遇敌参数；SCI字段、MDT分区按RPG.exe 4093bb/403769读取。

只读官方Map目录，独立产物避免为三个字段重导全部美术。
用法：python tools/export_encounters.py <multimedia/Map> <输出.json>
"""
import argparse
import json
import struct
from pathlib import Path

import dat_unpack
from export_map import load_patch, make_reader


def export(root):
    maps = {}
    for archive in sorted(root.iterdir()):
        if archive.suffix.lower() != '.dat':
            continue
        with archive.open('rb') as stream:
            entries = dat_unpack.read_entries(stream, archive.stat().st_size)
            read = make_reader(stream, load_patch(archive))
            entry = next((e for e in entries if e.name.upper().startswith('MPMP')
                          and e.name.upper().endswith('.SCI')), None)
            if entry is None:
                continue
            data = read(entry)
            enabled, variable = struct.unpack_from('<ii', data, 0x378)
            maps[archive.stem.upper()] = dict(enabled=enabled != 0,
                sourceInterval=enabled, swarmVariable=variable, regional=bool(data[0x1a1]))
    # 原程序固定读取该文件；散装补丁优先，与地图读取规则相同。
    archive = next(p for p in root.iterdir() if p.name.lower() == 'mp3001.dat')
    with archive.open('rb') as stream:
        entries = dat_unpack.read_entries(stream, archive.stat().st_size)
        read = make_reader(stream, load_patch(archive))
        entry = next(e for e in entries if e.name.lower().endswith('mp3001.mdt'))
        data = read(entry)
    cell_width, cell_height, columns, rows = struct.unpack_from('<4H', data)
    assert len(data) == 8 + columns * rows * 2
    cells = list(struct.unpack_from(f'<{columns * rows}H', data, 8))
    assert (cell_width, cell_height, columns) == (64, 48, 54)
    return dict(maps=maps, regions=dict(cellWidth=cell_width, cellHeight=cell_height,
        columns=columns, rows=rows, variableBase=4400, cells=cells))


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('map_dir', type=Path)
    parser.add_argument('output', type=Path)
    args = parser.parse_args()
    data = export(args.map_dir)
    args.output.write_text(json.dumps(data, ensure_ascii=False, separators=(',', ':')) + '\n')
    print(f"{len(data['maps'])} maps, {len(data['regions']['cells'])} region cells → {args.output}")
