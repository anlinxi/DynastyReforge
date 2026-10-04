#!/usr/bin/env python3
"""按地图SCI逐层补齐现有地图产物；与export_map共用解包、补丁和素材转换。"""
from pathlib import Path
from types import SimpleNamespace
import contextlib
import hashlib
import json
import struct
import sys
import export_map as em
import dat_unpack
import eve_actions
import scene_table
import map_masks

RECORD_SIZE = 0x473
OFF_EVE = 0x2CD

#: **原作数据本身的缺陷**（2026-09-28 查清，待办 MAP-11）：照原样跳过、不报错。
#: 只收查清原因的这两处；其余地图缺点名资源或对象表格式不对照旧报错，不能静默降级。
KNOWN_DEFECTS = {
    ('MP2409H1', 'MP2409H1.EVE'): '原作未用的草稿图：无脚本切入、无地名、RPG.exe无引用，点名的事件表本就不存在',
    ('MP2501B', 'NP2.SCI'): '原作打包失误：第三层对象表实为高奶奶行走精灵（SF2），该层本无对象',
}


#: **分层背景**（2026-09-28 查官方 RPG.exe，待办 MAP-17）。每层 SCI 记录里：
#:   +0x65 视差档。0x4067a0 每拍算本层偏移 = (镜头 − 基准) × 系数，0x4069e7 画时取图起点 = 镜头 + 偏移：
#:         1 → 系数 0.2（取图 1.2 倍于镜头，远景）；2 → 1.4（2.4 倍，近景）；0、10 → 不算（主层）；其余 → 1。
#:         基准进图时清零（0x40d804），另有一条未解的剧情指令（0x40e510）会重记，暂按 0 处理。
#:   +0x6E > 0 → 纯黑（16 位值为 0）透明（0x44e677）；+0x65 为 2 或 10 的层走 0x44e723，
#:         低 11 位（RGB565 的绿、蓝）为 0 即透明，不看 +0x6E。
#:   +0x6F > 0 → 640×480 循环平铺、每拍漂移 (+0x70, +0x72) 的背景，不随镜头（0x4068a0）。
#:   +0x66/+0x68/+0x6A/+0x6C → 激活层给镜头的范围（0x40ad50 → 0x4094b0）。
#: 地面图仍原样拷出 JPEG，透明与视差由前端按这些字段画（FieldScene.buildLayeredGround）。
PARALLAX = {0: 0.0, 1: 0.2, 2: 1.4, 10: 0.0}


def layer_view(chunk):
    """一层的画法字段；普通楼层全是默认值时返回空字典。"""
    mode = chunk[0x65]
    key = struct.unpack_from('<b', chunk, 0x6E)[0]
    dx, dy = struct.unpack_from('<hh', chunk, 0x70)
    bx, by = struct.unpack_from('<hh', chunk, 0x66)
    bw, bh = struct.unpack_from('<HH', chunk, 0x6A)
    view = {}
    factor = PARALLAX.get(mode, 1.0)
    if factor:
        view['parallax'] = factor
    color_key = 'greenBlue' if mode in (2, 10) else ('black' if key > 0 else None)
    if color_key:
        view['colorKey'] = color_key
    if chunk[0x6F]:
        view['drift'] = [dx, dy]
    if bw and bh:
        view['bounds'] = [bx, by, bw, bh]
    return view


def known_defect(stem, name):
    reason = KNOWN_DEFECTS.get((stem.upper(), str(name).upper()))
    if reason:
        print(f'{stem}: {name} 按原作缺陷跳过 —— {reason}')
    return bool(reason)

def records(data):
    if not data or len(data) % RECORD_SIZE:
        raise ValueError('地图SCI不是0x473的整数倍')
    return [data[i:i+RECORD_SIZE] for i in range(0,len(data),RECORD_SIZE)]

def export_layers(archive, map_file, sprite_dir=None):
    archive, map_file = Path(archive), Path(map_file)
    patch=em.load_patch(archive)
    with archive.open('rb') if archive.exists() else contextlib.nullcontext(None) as fh:
        entries=list(dat_unpack.read_entries(fh,archive.stat().st_size)) if fh else []
        known={e.name.upper() for e in entries}
        entries += [SimpleNamespace(name=k,size=len(v),offset=0) for k,v in patch.items() if k not in known]
        read=em.make_reader(fh,patch)
        by_name={e.name.upper():e for e in entries}
        sci=next((e for e in entries if e.name.upper().startswith('MPMP') and e.name.upper().endswith('.SCI')),None)
        if not sci:return None
        chunks=records(read(sci)); meta=json.loads(map_file.read_text());stem=meta['id']; out=map_file.parent
        # 指令重导保留完整动作和原下标，不能只改noop名称而丢失层号。
        # 同名优先：MP1608归档另含MP1602.EVE/MSG（MAP-12）。
        eve=em.pick_named(entries,archive.stem,'.EVE')
        msg=em.pick_named(entries,archive.stem,'.MSG')
        if eve and msg:
            scripts={str(k):[a.to_dict() for a in v] for k,v in eve_actions.slot_actions(read(eve),read(msg)).items()}
            for k,old in meta.get('scripts',{}).items():
                new=scripts.get(k,[])
                if len(new)!=len(old):raise ValueError(f'{stem}:{k} 指令条数不一致')
                for a,b in zip(old,new):
                    if a.get('op')==0x3d:
                        a.clear();a.update(b)
        if len(chunks)==1:
            map_file.write_text(json.dumps(meta,ensure_ascii=False,separators=(',',':')))
            return {'map':stem,'layers':1}
        if not meta.get('ground'):
            source = em.read_map_path(chunks[0], em.OFF_MAP_GROUND)
            if source not in by_name:
                raise ValueError(f'{stem}: 首层地面资源缺失 {source}')
            blob = read(by_name[source])
            end = blob.rfind(b'\xff\xd9')
            blob = blob[:end+2] if end > 0 else blob
            if not em.jpeg_size(blob):
                raise ValueError(f'{stem}: {source}不是有效JPEG')
            (out/'ground.jpg').write_bytes(blob)
            meta['ground'] = 'ground.jpg'
            meta['groundSource'] = source
        width,height=em.jpeg_size((out/meta['ground']).read_bytes())
        meta['width'], meta['height'] = width, height
        layers=[]; objects=[]; missing=[]
        views=[layer_view(c) for c in chunks]
        layered=any(k in v for v in views for k in ('parallax','colorKey','drift'))
        def named(chunk,off):
            name=em.read_map_path(chunk,off)
            if name and name not in by_name and not known_defect(stem,name):raise ValueError(f'{stem}: 层资源缺失 {name}')
            return by_name.get(name)
        for i,chunk in enumerate(chunks):
            layer={'index':i,'initialActive':bool(chunk[0])}
            for off,field,opaque in [(em.OFF_MAP_MB,'collision',False),(em.OFF_MAP_MK,'occlusion',True)]:
                e=named(chunk,off)
                if not e:continue
                raw=read(e);w,h,pixels=em._compose(raw)
                bits=map_masks.opaque_bits(pixels)
                if not opaque:bits=bytearray(1-b for b in bits)
                bits=em.fit_mask(bits,w,h,width,height,em.layer_origin(raw))
                filename=f'layer-{i}-{field}.png'
                map_masks.write_mask_png(out/filename,width,height,bits)
                layer[field]=filename;layer[field+'Source']=e.name
                layer[field+'Rev']=hashlib.sha256(bytes(bits)).hexdigest()[:12]
            e=named(chunk,em.OFF_MAP_ESCI)
            layer['objectSource']=e.name if e else None
            if e and not (len(read(e))%scene_table.RECORD_SIZE and known_defect(stem,e.name)):
                raw=read(e)
                if len(raw)%scene_table.RECORD_SIZE:raise ValueError(f'{stem}: {e.name}不是对象表')
                for obj in em.collect_objects(raw):objects.append({**obj,'layer':i})
            bg=named(chunk,em.OFF_MAP_GROUND)
            if layered:
                layer.update(views[i])
            if bg and (i or layered):
                blob=read(bg);end=blob.rfind(b'\xff\xd9');filename=f'layer-{i}-ground.jpg'
                (out/filename).write_bytes(blob[:end+2] if end>0 else blob);layer['ground']=filename
            ev=named(chunk,OFF_EVE)
            if ev and eve and read(ev)!=read(eve):raise ValueError(f'{stem}: 多层不同EVE尚需独立脚本表')
            layer['events']=bool(ev);layers.append(layer)
        available={f'{stem}-{Path(e.name).stem.upper()}':e for e in entries if e.name.upper().endswith('.SF2')}
        for obj in objects:
            key=obj['sprite']
            if key not in available:
                alt=next((a for a in scene_table.sprite_aliases(key) if a in available),None)
                if alt:obj['sprite']=alt
                elif not scene_table.looks_like_junk(scene_table.sprite_file_stem(key)):
                    if key.startswith(stem+'-'):missing.append(key)
        meta['layers']=layers;meta['initialLayer']=next((l['index'] for l in reversed(layers) if l['initialActive']),0)
        if layered:
            # 每层地面各自画（含第 0 层），镜头范围取激活层的矩形（原作 0x40ad50）。
            meta['layeredGround']=True
            bounds=views[meta['initialLayer']].get('bounds')
            if bounds:meta['width'],meta['height']=bounds[2],bounds[3]
        meta['objects']=objects
        wanted={o['sprite'] for o in objects}
        keys=(wanted&available.keys())|{k for k in wanted if k.startswith('MP') and not k.startswith(stem+'-')}
        previous=set(meta.get('sprites',[]));meta['sprites']=sorted(previous|keys)
        if sprite_dir:
            target=Path(sprite_dir)
            todo=[(available[k],k) for k in keys if k in available and not (target/k/'sprite.json').exists()]
            em.export_sprites(read,todo,target)
        map_file.write_text(json.dumps(meta,ensure_ascii=False,separators=(',',':')))
        return {'map':stem,'layers':len(layers),'objects':len(objects),'missingSprites':sorted(set(missing))}

if __name__=='__main__':
    print(json.dumps(export_layers(*sys.argv[1:]),ensure_ascii=False))
