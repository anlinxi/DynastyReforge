#!/usr/bin/env python3
"""极简 PE32 解析：只做「文件偏移 ↔ 虚拟地址」互转，够在代码段里找字符串引用。

不依赖 pefile / lief —— 本机都没装，而我们只需要节区表这一点信息。
只支持 PE32（`magic == 0x10b`），幽城的 exe 是 2000 年前后的 32 位程序。
"""
from __future__ import annotations

import struct
from dataclasses import dataclass
from pathlib import Path

#: PE 签名在 DOS 头里的偏移。
PE_OFFSET_FIELD = 0x3C
#: 可选头里 ImageBase 相对可选头起点的偏移（PE32）。
IMAGE_BASE_FIELD = 28
#: 节区表每项 40 字节。
SECTION_ENTRY_SIZE = 40
PE32_MAGIC = 0x10B


class PEError(ValueError):
    """不是能处理的 PE32 文件。"""


@dataclass(frozen=True)
class Section:
    name: str
    vaddr: int
    vsize: int
    rawptr: int
    rawsize: int

    def contains_offset(self, off: int) -> bool:
        return self.rawptr <= off < self.rawptr + self.rawsize

    def contains_rva(self, rva: int) -> bool:
        return self.vaddr <= rva < self.vaddr + max(self.vsize, self.rawsize)


@dataclass(frozen=True)
class PEImage:
    data: bytes
    image_base: int
    sections: tuple[Section, ...]

    def offset_to_va(self, off: int) -> int | None:
        for s in self.sections:
            if s.contains_offset(off):
                return self.image_base + s.vaddr + (off - s.rawptr)
        return None

    def va_to_offset(self, va: int) -> int | None:
        rva = va - self.image_base
        for s in self.sections:
            if s.contains_rva(rva):
                off = s.rawptr + (rva - s.vaddr)
                return off if off < len(self.data) else None
        return None

    def section(self, name: str) -> Section:
        for s in self.sections:
            if s.name == name:
                return s
        raise PEError(f"没有名为 {name} 的节区")


def load(path: Path | str) -> PEImage:
    data = Path(path).read_bytes()
    if len(data) < PE_OFFSET_FIELD + 4:
        raise PEError("文件太小，不是 PE")

    pe_off = struct.unpack_from("<I", data, PE_OFFSET_FIELD)[0]
    if data[pe_off:pe_off + 4] != b"PE\0\0":
        raise PEError("缺少 PE 签名")

    coff = pe_off + 4
    section_count = struct.unpack_from("<H", data, coff + 2)[0]
    opt_size = struct.unpack_from("<H", data, coff + 16)[0]
    opt = coff + 20

    if struct.unpack_from("<H", data, opt)[0] != PE32_MAGIC:
        raise PEError("不是 PE32（只支持 32 位）")

    image_base = struct.unpack_from("<I", data, opt + IMAGE_BASE_FIELD)[0]
    table = opt + opt_size
    sections = []
    for i in range(section_count):
        base = table + i * SECTION_ENTRY_SIZE
        name = data[base:base + 8].rstrip(b"\0").decode("ascii", "replace")
        vsize, vaddr, rawsize, rawptr = struct.unpack_from("<IIII", data, base + 8)
        sections.append(Section(name, vaddr, vsize, rawptr, rawsize))

    return PEImage(data=data, image_base=image_base, sections=tuple(sections))
