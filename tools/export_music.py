#!/usr/bin/env python3
"""从 `Music/Music.DAT` 取出地图 BGM。

在此之前 BGM 是手工从素材目录拷过来的一首战斗曲，没有工具，也没接
「哪张图放哪首」（见 docs/判据/数据链路.md §2.8）。这个脚本补上前半段。

## 曲目编号从哪来

每张地图的 `MPMP<图号>.SCI` 在 **0x331** 记着本图的 BGM 编号，
`tools/export_map.py` 已把它写进 `map.json` 的 `bgm` 字段。实测：

    MP0212 兰州城 = 4     MP0207 药铺 = 3
    MP0202 客栈   = 3     MP3001 大地图 = 1

药铺与客栈同为城内店铺共用一曲。旁证：同一条记录的 0x380（能否存档）
只有大地图为 1，0x37c（随机敌群）只有兰州城非 0，都合语义。

## 归档里有什么

编号 1~32，每个编号都有 `<n>.WAV`（7KB~1MB 的短件），**2~24 另有
`<n>.MP3`（1~5MB 的完整曲子）**。1、25~30 只有 WAV。
所以取曲时优先 MP3，没有才退回 WAV。

用法:
    python3 export_music.py <Music.DAT> <输出目录> --tracks 1,3,4
"""
from __future__ import annotations

import argparse
import subprocess
import sys
from pathlib import Path

import dat_unpack

#: 优先级：完整曲子在 MP3 里，WAV 只是短件
SUFFIX_ORDER = (".MP3", ".WAV")

#: **归档外的第二套曲库** —— `fight/Audio/Mp3/`。
#:
#: ⚠️ 原作的音乐**不止 `Music/Music.DAT` 一处**。`fight/Audio/Mp3/` 下另有
#: 七首 `MusicNNN.mp3`（000/010/020/030/031/032/033），与 `Music.DAT` 里的
#: 编号毫无关系。一度把「32 号是全库唯一 20 秒的曲子」当判据，就是因为
#: 只扫了 `Music.DAT` 那一半。
#:
#: 键是产物文件名（不带扩展名），值是源文件名。
#:
#: ⚠️ **`Music000` 是标题曲，不是战斗曲**（用户听辨确认）。这条一度推翻了
#: 「`Music0<档次><变体>` → 档次 0 用 `Music000`」那个想当然的映射 ——
#: 照那么接，普通遭遇会放标题画面的曲子。
FIGHT_TRACKS = {
    # 标题画面（「又稱還家路」那一屏）。24.0 秒，编号 000，日期 2001-10-29。
    # 用户听辨确认。
    "title": "Music000.mp3",
    # ── 战斗曲：**档次 Y → `Music03Y`** ─────────────────────────
    #
    # 档次来自遇敌群 `Layoutgr.enc +136`（0/1/2/3）。**三条独立判据一致**：
    #
    # 1. **档次字段本身**：值 3 恰好只落在「最終決戰 A1/A2/B1/B2/C」五条上，
    #    一条不多一条不少（回归 `encounter.test.js` 钉着）。
    # 2. **用户听辨**（2026-09-17）：`Music020` 是**战斗胜利**、
    #    `Music030` 是**普通战斗**、`Music031/032/033` 是**特殊战斗**。
    # 3. **命名**：`Music03<档次>` —— 030/031/032/033 正好四首，
    #    与档次 0/1/2/3 一一对应；而档次 0 有 207 个遇敌群（普通遭遇），
    #    正对用户说的「普通战斗」。
    #
    # ⚠️ 另外三首**不是战斗曲**，别再按命名规律往里凑（2026-09-17 栽过一次）：
    #     Music000 = 标题画面     Music010 = **店铺曲**（== Music.DAT/3.MP3）
    #     Music020 = **战斗胜利**（战后流程用，见 `docs/专题/战斗.md` 战后与音频）
    "battle0": "Music030.mp3",   # 档次0 普通遭遇（207 群）      139.1 s
    "battle1": "Music031.mp3",   # 档次1 剧情战（21 群）         267.4 s
    "battle2": "Music032.mp3",   # 档次2 强敌（17 群）           197.9 s
    "battle3": "Music033.mp3",   # 档次3 最終決戰（5 群）        209.3 s
    "victory": "Music020.mp3",   # 战斗胜利（用户听辨确认）        34.8 s
}


def find_track(entries, number: int):
    """某个编号对应的归档条目，优先 MP3。找不到返回 None。

    ⚠️ **MP3 比同号 WAV 还小的，不是完整曲子。**
    31 号的 `31.MP3` 只有 **14 KB / 1.0 秒**，而 `31.WAV` 有 172 KB ——
    照「优先 MP3」取出来，13 张图（`MP0106`/`MP0209`/`MP0607B`…）
    与 10 处剧情切曲全都变成了一声一秒的响动。

    判据来自数据本身，不是阈值：**完整曲子不可能比短件还小**。
    其余 23 个有 MP3 的编号，MP3 都是 WAV 的几倍到几百倍。
    """
    by_name = {e.name.upper(): e for e in entries}
    mp3 = by_name.get(f"{number}.MP3")
    wav = by_name.get(f"{number}.WAV")
    if mp3 is not None and wav is not None and mp3.size < wav.size:
        print(f"  ⚠ {number}.MP3 只有 {mp3.size:,} 字节、比 {number}.WAV "
              f"（{wav.size:,}）还小 —— 不是完整曲子，改用 WAV")
        return wav, ".wav"
    if mp3 is not None:
        return mp3, ".mp3"
    if wav is not None:
        return wav, ".wav"
    return None, None


#: WAV 头里的编码标记，1 = 未压缩 PCM。
WAVE_FORMAT_PCM = 1


def wav_format(path: Path) -> int | None:
    """读 WAV 的 `wFormatTag`。不是 RIFF/WAVE 就返回 None。"""
    data = path.read_bytes()
    if len(data) < 24 or data[:4] != b"RIFF" or data[8:12] != b"WAVE":
        return None
    pos = 12
    while pos + 8 <= len(data):
        cid = data[pos:pos + 4]
        size = int.from_bytes(data[pos + 4:pos + 8], "little")
        if cid == b"fmt " and pos + 10 <= len(data):
            return int.from_bytes(data[pos + 8:pos + 10], "little")
        pos += 8 + size + (size & 1)
    return None


def find_loose(archive: Path, number: int) -> Path | None:
    """归档里没有时，去**散装文件**里找 `<n>.wav`。

    `Music.DAT` 旁边与 `Map/Music/` 下各躺着一个 `32.wav`（两份字节相同，
    1.1MB、2001-11-15，比归档晚）—— 归档里的 WAV 只到 31，
    而剧情里 `play_audio kind=1 track=32` 用了 3 处（`MP2409B`/`MP2409C1`）。

    与地图那边「归档 + 散装补丁」（`export_map.load_patch`）是同一个模式：
    **官方后来补的东西放在归档外面。**
    """
    roots = [archive.parent, archive.parent.parent / "Map" / "Music"]
    for root in roots:
        for name in (f"{number}.wav", f"{number}.WAV"):
            hit = root / name
            if hit.is_file():
                return hit
    return None


def to_pcm(path: Path) -> str:
    """**非 PCM 的 WAV 转成 PCM** —— 浏览器只认 PCM。

    ⚠️ `17.WAV` 是 **IMA ADPCM（4 bit）**，`decodeAudioData` 直接报
    `Unable to decode audio data`，那一声就永远不响。归档里 30 个音效
    只有它一个是压缩的，但不转就是个静默的坑。
    """
    tag = wav_format(path)
    if tag is None or tag == WAVE_FORMAT_PCM:
        return ""
    tmp = path.with_suffix(".pcm.wav")
    cmd = ["ffmpeg", "-v", "error", "-y", "-i", str(path),
           "-acodec", "pcm_s16le", str(tmp)]
    try:
        subprocess.run(cmd, check=True)
    except (OSError, subprocess.CalledProcessError) as err:
        print(f"  ⚠ {path.name} 是压缩 WAV（格式 {tag}）但转不了：{err}",
              file=sys.stderr)
        return "  ⚠ 浏览器可能放不出来"
    tmp.replace(path)
    return f"  （格式 {tag} → PCM）"


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("archive", help="Music/Music.DAT")
    parser.add_argument("out_dir", help="输出目录，通常是 game/public/audio")
    parser.add_argument("--tracks", default="",
                        help="要导的 BGM 曲目编号，逗号分隔，如 1,3,4")
    parser.add_argument("--sfx", default="",
                        help="要导的音效编号，逗号分隔。**只取 WAV**，"
                             "出成 sfx<n>.wav（剧情的 play_audio kind=1 用）")
    parser.add_argument("--fight-audio", default="",
                        help="`fight/Audio/Mp3` 目录。给了就把 FIGHT_TRACKS "
                             "里列的曲子一并导出（标题画面 BGM 在那边）")
    parser.add_argument("--level-up", default="", help="原作 fight/Audio/wav0000.wav：升级音效（0x413055）")
    args = parser.parse_args(argv)

    archive = Path(args.archive)
    if not archive.is_file():
        print(f"找不到归档: {archive}", file=sys.stderr)
        return 1

    def parse(spec: str, flag: str) -> list[int] | None:
        try:
            return sorted({int(t) for t in spec.split(",") if t.strip()})
        except ValueError:
            print(f"{flag} 只接受逗号分隔的数字: {spec!r}", file=sys.stderr)
            return None

    numbers = parse(args.tracks, "--tracks")
    sfx_numbers = parse(args.sfx, "--sfx")
    if numbers is None or sfx_numbers is None:
        return 1
    if not numbers and not sfx_numbers and not args.fight_audio and not args.level_up:
        print("--tracks / --sfx / --fight-audio 至少要给一个", file=sys.stderr)
        return 1

    out_dir = Path(args.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)

    with archive.open("rb") as fh:
        entries = dat_unpack.read_entries(fh, archive.stat().st_size)

        missing = []
        for number in numbers:
            entry, suffix = find_track(entries, number)
            if entry is None:
                missing.append(number)
                print(f"⚠ 曲目 {number} 不在归档里", file=sys.stderr)
                continue
            fh.seek(entry.offset)
            target = out_dir / f"bgm{number}{suffix}"
            target.write_bytes(fh.read(entry.size))
            print(f"曲目 {number} -> {target.name}（{entry.size / 1024:.0f} KB，"
                  f"来自 {entry.name}）")

        # 音效走另一套命名：BGM 优先 MP3，音效**只有 WAV**。
        # ⚠️ 此前没有这一路，于是剧情里 19 处 `play_audio{kind:1}` 全部
        # 静默跳过（前端拿 `cache.audio.exists()` 兜底，不报错也不提示）。
        for number in sfx_numbers:
            entry = next((e for e in entries
                          if e.name.upper() == f"{number}.WAV"), None)
            target = out_dir / f"sfx{number}.wav"
            if entry is not None:
                fh.seek(entry.offset)
                target.write_bytes(fh.read(entry.size))
                src = f"归档 {entry.name}"
                size = entry.size
            else:
                # ⚠️ **归档之外还有散装文件。** `Music.DAT` 里的 WAV 只到 31，
                # 而 `play_audio kind=1 track=32`（樓蘭那三处）要的 `32.wav`
                # **散在 `Music/` 与 `Map/Music/` 目录下**（1.1MB，2001-11-15，
                # 比归档晚）—— 与地图那边「归档 + 散装补丁」是同一个模式。
                # 只报「不在归档里」就会把它判成"原作没有"，那正是判据表
                # 「说这个数据没有之前先查四处」踩过的坑。
                loose = find_loose(archive, number)
                if loose is None:
                    missing.append(number)
                    print(f"⚠ 音效 {number} 归档与散装目录里都没有", file=sys.stderr)
                    continue
                target.write_bytes(loose.read_bytes())
                src = f"散装 {loose}"
                size = loose.stat().st_size
            note = to_pcm(target)
            print(f"音效 {number} -> {target.name}（{size / 1024:.0f} KB，来自 {src}）{note}")

    if args.fight_audio:
        src_dir = Path(args.fight_audio)
        for name, filename in FIGHT_TRACKS.items():
            src = src_dir / filename
            if not src.is_file():
                missing.append(name)
                print(f"⚠ {filename} 不在 {src_dir}", file=sys.stderr)
                continue
            target = out_dir / f"{name}.mp3"
            target.write_bytes(src.read_bytes())
            print(f"{name} -> {target.name}（{src.stat().st_size / 1024:.0f} KB，"
                  f"来自 {filename}）")

    if args.level_up:
        source = Path(args.level_up)
        target = out_dir / "level-up.wav"
        target.write_bytes(source.read_bytes())
        print(f"升级音效 {source} -> {target}{to_pcm(target)}")

    return 1 if missing else 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
