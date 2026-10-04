"""RPG.exe 里我们实际读取的数据表：只核对这些字节，exe 其余部分（免CD、随时存档、最大成长等补丁改的代码）一律不管。

游戏逻辑已全部写进自己的代码；从 exe 取的只有下面这些**数据表**（素材文件里没有）。
任何一版 RPG.exe（原版、各种免CD）只要这些表与已核对版本逐字节相同，导出结果就相同；
表不同说明是别的程序版本，地址可能也变了，读出来是错的也不会报错，所以直接停下并指出是哪张表。

2026-10-04 用台湾第三版随附的 2in1/3in1/5in1 免CD 实测：三者这些表逐字节相同，导出结果一致。
（菜单界面坐标是反汇编整段代码找调用点得来的，不在这里；见 extract.py 的菜单布局检查。）
"""
import hashlib

#: (名字, 虚拟地址, 字节数, 读它的地方)
TABLES = (
    ('状态表', 0x46a000, 28 * 16, 'battle_rules：基础时长/目标五外/施者五外/抗性'),
    ('状态对抗表', 0x46a668, 28 * 8, 'battle_rules'),
    ('药物清除分支索引', 0x421990, 101, 'battle_rules'),
    ('药物清除分支跳转表', 0x42196c, 9 * 4, 'battle_rules：索引最大 8'),
    ('场方效果表', 0x46bc48, 9 * 8, 'battle_rules'),
    ('场方动画名', 0x46bb94, 9 * 20, 'battle_rules：编号最大 8'),
    ('状态演出前层', 0x469ab4, 11 * 30, 'battle_rules'),
    ('状态演出后层', 0x469c00, 11 * 30, 'battle_rules'),
    ('五外成长档次表', 0x46c1b0, 0x14 + 35 * 4, 'export_gamedata：最小值/跨度 + 角色档次索引'),
    ('魂石修正表', 0x468f60, 16 * 40, 'export_refining'),
)

#: 上面各表的 SHA-256（台湾第三版 RPG.exe，三款免CD 相同）。
REFERENCE = {
    '状态表': '1e0ee9b9414ed0474987fb16d25553e718d9d5d09f33f76ddc1dd7cbc0506d37',
    '状态对抗表': '091041edd88b92c28a7d298f1a1c08d91f3f5ee6969e4e4f9eeddb4c27496801',
    '药物清除分支索引': '6fd8c524fa784fbde0623ca29c693f90eb82688ac00f806a361272abd5cda7c3',
    '药物清除分支跳转表': '5fd9df53672e60eb614a36680ec21877426661a98fd7c1af59516e4d8285371e',
    '场方效果表': '9ab0c0450b7b786618c61df91d102866e9a339ea8959f2f369dc8b0238ec8372',
    '场方动画名': '79e9e06ce1f6a42eff84490c74aef1f0d4a8488d7618ab0c8ec40d97c544c09e',
    '状态演出前层': '4d16795bf336facadc05e41c3ab857f83b14d9f6896c82bf85eedf177653da61',
    '状态演出后层': '7cb164d7fc2752628d7faeacca3f6ff1a8639e2e8b79fc6ed589490b6fa9d600',
    '五外成长档次表': '34067ed5ffbf7024e690163e771f770ef5aec7c8e3ee17e8e59dbc235051ca4a',
    '魂石修正表': '175a023c404f9d5a70fead47cc039048687feb8ef506999e8c0e4deeff11a40f',
}


def table_digests(pe) -> dict:
    """按 TABLES 取字节算指纹。地址不在任何节里也算不同（返回 None）。"""
    out = {}
    for name, va, size, _ in TABLES:
        offset = pe.va_to_offset(va)
        out[name] = None if offset is None else hashlib.sha256(pe.data[offset:offset + size]).hexdigest()
    return out


def check(pe) -> None:
    """有任何一张表与已核对版本不同就报错，并列出是哪几张。"""
    actual = table_digests(pe)
    bad = [name for name, digest in actual.items() if digest != REFERENCE[name]]
    if bad:
        raise ValueError('RPG.exe 的数据表与已核对版本不同（' + '、'.join(bad) + '）：'
                         '这不是台湾第三版的程序，数据地址可能不同，不能用来导出。')
