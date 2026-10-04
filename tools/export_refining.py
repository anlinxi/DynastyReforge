#!/usr/bin/env python3
"""官方炼化原表与物品推导字段；不从MOD配方说明反推。"""
import argparse, hashlib, json, struct
from pathlib import Path
from enc_decode import decode
from pe_image import load

def export(public, exe):
    files={n:decode((public/n).read_bytes()) for n in ('Ail2.ENC','Refinek.enc','Refinet.enc','Miscinfo.enc')}
    ail=files['Ail2.ENC']; pe=load(exe); __import__('exe_tables').check(pe)
    i32=lambda b,o:struct.unpack_from('<i',b,o)[0]
    items=[]
    for code in range(len(ail)//926):
        o=code*926
        items.append({'code':code,'level':i32(ail,o+36),'kind':i32(ail,o+882),'affinity':i32(ail,o+886),'resist':list(struct.unpack_from('<8i',ail,o+120))})
    stone=[list(struct.unpack_from('<10i',pe.data,pe.va_to_offset(0x468f60)+i*40)) for i in range(16)]
    misc=files['Miscinfo.enc']
    souls=[{'type':i,'art':misc[4+i*50:4+(i+1)*50].split(b'\0')[0].decode('ascii'),'skills':list(struct.unpack_from('<2I',misc,0x130+i*8)),'items':list(struct.unpack_from('<2I',misc,0x160+i*8)),'trainingSpells':list(struct.unpack_from('<5I',misc,0x190+(i-1)*20))} for i in range(1,6)]
    return {'source':{'exe':hashlib.sha256(pe.data).hexdigest(),**{n:hashlib.sha256((public/n).read_bytes()).hexdigest() for n in files}},'items':items,'kinds':list(struct.unpack('<289i',files['Refinek.enc'])),'specific':[list(row) for row in struct.iter_unpack('<3I',files['Refinet.enc'])],'stoneModifiers':stone,'souls':souls}

if __name__=='__main__':
    ap=argparse.ArgumentParser(description=__doc__);ap.add_argument('--public',type=Path,required=True);ap.add_argument('--exe',type=Path,required=True);ap.add_argument('--out',type=Path,default=Path('game/public/assets/data/refining.json'));a=ap.parse_args();d=export(a.public,a.exe);a.out.write_text(json.dumps(d,ensure_ascii=False,separators=(',',':'))+'\n');print(len(d['items']),'items;',len(d['specific']),'specific recipes; 5 soul stones')
