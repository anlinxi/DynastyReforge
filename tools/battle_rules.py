"""官方战斗状态表及特殊处理分派；只读 RPG.exe 里的数据表（见 exe_tables），不移用MOD表。"""
import hashlib
import struct
from pe_image import load
import exe_tables

OFFICIAL_SHA256 = '0c214d911382c5b652c1b89c8fae779f0f2e1f9506aba6c8b06be21e337d9aac'

#: 已见过的 RPG.exe（只用于提示是哪一版；能不能用看 exe_tables 里的数据表，不看整文件哈希）。
#: 台湾第三版硬盘版随附的三款免CD（2026-10-04 逐字节比对）：长度相同，只差 0x40a0c2（随时存档，6 字节）
#: 与 0x443a23~0x443d82（最大成长/最大掉宝，4 处 29 字节）两段代码，我们读的数据表三者相同。
KNOWN_EXE_SHA256 = {
    OFFICIAL_SHA256: '5in1_nocd（免CD+随时存档+最大成长+最大掉宝）',
    '7a933ae498fc41b7ef09bf7ad1b581b3573dc1133dbb04c4210137642b69dbef': '3in1_nocd（免CD+随时存档）',
    'b10c65f56051e5a625b6c34857bcb73bd002efe3c158b6bd0cc2bb17fa871dcf': '2in1_nocd（免CD）',
}


def load_rules(path, names):
    pe = load(path)
    digest = hashlib.sha256(pe.data).hexdigest()
    exe_tables.check(pe)

    def read(va, fmt):
        return struct.unpack_from(fmt, pe.data, pe.va_to_offset(va))

    # 官方诸态0x41cd79..0x41d10b逐状态选图；0为空格，绝不能按状态码直接取帧。
    icons = {0: 1, 21: 12, 5: 2, 24: 3, 3: 7, 22: 6, 4: 17, 23: 4,
             6: 14, 25: 13, 7: 10, 26: 11, 1: 5, 2: 18, 15: 8, 10: 19,
             11: 20, 13: 21, 14: 9, 16: 16, 9: 22}
    states = {}
    for code in range(28):
        duration, target, caster, resist = read(0x46a000 + code * 16, '<4i')
        states[str(code)] = dict(名称=names.get(code, str(code)), 基础时长=duration,
            目标五外=target, 施者五外=caster, 抗性=resist,
            对抗=read(0x46a668 + code * 8, '<i')[0], 图标=icons.get(code))
    bad = list(range(12)) + [13]
    item_branches = {0x4216e8: [0], 0x421721: [1], 0x42175a: [2],
        0x421793: [11], 0x4217cc: [3], 0x421805: [0], 0x42183e: [21], 0x421877: bad}
    cures = {}
    for offset in range(101):
        branch = read(0x421990 + offset, 'B')[0]
        address = read(0x42196c + branch * 4, '<I')[0]
        if address in item_branches:
            codes = item_branches[address]
            if offset + 0x108 == 0x11b:
                codes = [i for i in codes if i not in (2, 13)]
            cures[f'{offset + 0x108:X}'] = codes
    def pack(va, size):
        raw = read(va, f'{size}s')[0].split(b'\0')[0].decode('ascii')
        return raw.replace('\\', '/').split('/')[-1].removesuffix('.SF2')
    fields = {}
    for index in range(9):
        code, slot = read(0x46bc48 + index * 8, '<2i')
        fields[f'{code:X}'] = dict(编号=slot, 动画=pack(0x46bb94 + slot * 20, 20))
    visuals = {}
    for index, code in enumerate([9, 14, 0, 21, 15, 10, 1, 2, 11, 13, 19]):
        visuals[str(code)] = dict(前层=pack(0x469ab4 + index * 30, 30),
                                 后层=pack(0x469c00 + index * 30, 30))
    # 0x41cd79..0x41d114按固定14格写图；同格按分支顺序取首个，不压缩空格。
    icon_slots = [[0, 21], [5, 24], [3, 22], [4, 23], [6, 25], [7, 26], [1],
                  [2], [15, 10], [11], [13], [14], [16], [9]]
    return dict(来源哈希=digest, 场方效果=fields, 状态演出=visuals, 状态=states, 诸态状态格=icon_slots, 药物清除=cures,
        绝学清除={code: bad for code in ('195', '196', '1C1', '1D3')},
        驱散={'1BF': [14, 15, 21, 22, 23, 24, 25, 26]},
        时轮={'1C5': 'halve', '1C6': 'reset', '1C7': 'half', '1C8': 'ready'})
