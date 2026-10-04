#!/usr/bin/env python3
"""一键提取：从官方原作安装目录生成可玩的 `game/public`（开源发布 P2，见 docs/专题/开源发布.md）。

    python3 tools/extract.py --castle <原作 Castle 目录> --chs <简体补丁 chs 目录> --out <新目录>
        [--hd-esrgan <realesrgan-ncnn-vulkan 可执行文件> | --hd-pack <高清素材包.zip>]

1. **核对原作**：`multimedia/` 逐文件比对 `tools/extract_inputs.json`（已验证的台湾第三版指纹）；
   缺文件、内容不同或多出文件（如装了 MOD）一律报错停下；`--ignore-fingerprint` 可跳过比对（结果不保证）。
   `exe/RPG.exe` 不比整文件，只核对实际读取的数据表（`exe_tables.py`），免CD 等补丁改的代码不影响。
2. **按依赖顺序跑全部导出**（`--list` 看步骤）。每步输出记在 `<新目录>/.extract-work/logs/`。
3. **可选的高清素材**（最后一步）：`--hd-esrgan` 用 Real-ESRGAN 生成，或 `--hd-pack` 装入别人生成好的包
   （`tools/hd_pack.py make` 打包）；完成后按高清清单核对齐全。不给这两个参数就只有原图（游戏照样能开高清渲染）。
4. **完整性检查**：对照 `tools/extract_expected.json`（基础素材的文件清单），缺文件则失败。
5. 写 `<新目录>/extract-manifest.json`：输入指纹、代码版本、每步耗时。

中途失败或中断，再跑同一条命令从断点续跑（`<新目录>/.extract-state.json`）；`--force` 全部重跑，
`--only 步骤,步骤` 只跑指定步骤。需要 Python 3 + Pillow + numpy，影片一步需要 ffmpeg。

维护（原作或导出器变了之后，由开发者在已验证的环境里重写两份参照表）：
    python3 tools/extract.py --castle <Castle> --write-reference [--expected-from game/public]
"""
from __future__ import annotations

import argparse
import os
import hashlib
import json
import shutil
import subprocess
import sys
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Callable

ROOT = Path(__file__).resolve().parent.parent
TOOLS = ROOT / "tools"
sys.path.insert(0, str(TOOLS))
from export_map import restore_big5_name  # noqa: E402
from battle_rules import KNOWN_EXE_SHA256  # noqa: E402
import exe_tables  # noqa: E402
from pe_image import load as load_pe  # noqa: E402
INPUTS_REF = TOOLS / "extract_inputs.json"
EXPECTED_REF = TOOLS / "extract_expected.json"
STATE_NAME = ".extract-state.json"
MANIFEST_NAME = "extract-manifest.json"
WORK_NAME = ".extract-work"

#: Music.DAT 的 BGM 与音效：1–32 号全导（25–30 号只有 WAV；32 号 WAV 是散装补丁 Music/32.wav）。
MUSIC_NUMBERS = ",".join(str(i) for i in range(1, 33))
#: 八页菜单每个元素的屏幕坐标（随代码发布，2026-10-04 用户定）。原是反汇编 RPG.exe 找「建元素」调用点得来
#: （tools/extract_layout.py，需要 objdump，Windows 默认没有）；台湾第三版三款免CD 结果相同，便直接带上。
#: 维护：extract_layout.py <RPG.exe> -o <目录> --pattern 'Menus\\[A-Za-z0-9_\-]+\.[A-Za-z0-9]{2,4}' 重算后替换此文件
#: （只取 Menus\ 下的资源名，默认模式会混进地图资源、簇号整体错位）。
MENU_LAYOUT = TOOLS / "menu_layout.json"
#: 魂石旋转图像，官方 fight/Other/stone001..005.SF2。
STONES = [f"stone{i:03d}.SF2" for i in range(1, 6)]
#: 不算原作输入的文件：玩家自己的存档（只收 NewGame.TSF）与系统杂项。
IGNORED_NAMES = {".DS_Store", "Thumbs.db", "desktop.ini"}
#: 不算提取产物的文件：开发用测试存档、本工具自己的状态与报告。
DEV_ONLY_PREFIXES = ("assets/data/saves/",)
#: 高清素材另有自己的清单核对（tools/hd_pack.py check），不算进基础素材的完整性
HD_PREFIX = "assets-hd/"
#: 高清生成的批次（模型与存储倍数在 hd_upscale.py 里）：战斗背景、立绘、人物形象、繁体界面；有简体补丁时加简体界面
HD_MENUS = ("MEN0002", "MEN8007")
HD_PACKS = ("ITF0051", "ITF0002")
OWN_FILES = (STATE_NAME, MANIFEST_NAME, WORK_NAME)


def find_ci(base: Path, rel: str) -> Path:
    """按不区分大小写逐级找路径（原作目录大小写不统一，Linux 上要靠这个）。找不到返回原样拼接。"""
    here = base
    for part in Path(rel).parts:
        exact = here / part
        if exact.exists():
            here = exact
            continue
        match = next((c for c in here.iterdir() if c.name.lower() == part.lower()), None) \
            if here.is_dir() else None
        if match is None:
            return base / rel
        here = match
    return here


@dataclass(frozen=True)
class Paths:
    castle: Path
    chs: Path | None
    names: Path
    out: Path
    hd_esrgan: Path | None = None   # 有就生成高清素材（realesrgan-ncnn-vulkan 可执行文件）
    hd_pack: Path | None = None     # 有就直接装入现成的高清素材包（zip 或文件夹），不生成

    def mm(self, rel: str = "") -> Path:
        return find_ci(self.castle / "multimedia", rel) if rel else self.castle / "multimedia"

    @property
    def exe(self) -> Path:
        return find_ci(self.castle, "exe/RPG.exe")

    @property
    def assets(self) -> Path:
        return self.out / "assets"

    @property
    def work(self) -> Path:
        return self.out / WORK_NAME

    def chs_file(self, rel: str) -> Path:
        assert self.chs is not None
        return find_ci(self.chs, rel)


def sha256(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as fh:
        for block in iter(lambda: fh.read(1 << 20), b""):
            h.update(block)
    return h.hexdigest()


def input_files(castle: Path) -> dict[str, Path]:
    """原作输入：`exe/RPG.exe` 与 `multimedia/` 下全部文件；存档目录只收 NewGame.TSF。"""
    files = {"exe/RPG.exe": find_ci(castle, "exe/RPG.exe")}
    mm = castle / "multimedia"
    for path in sorted(mm.rglob("*")):
        if not path.is_file() or path.name in IGNORED_NAMES:
            continue
        # 中文文件名按 Big5 读法记：解压工具可能把它解成乱码（见 export_map.restore_big5_name）
        rel = "/".join(restore_big5_name(part) for part in path.relative_to(castle).parts)
        parts = rel.lower().split("/")
        if parts[1] == "save" and parts[-1] != "newgame.tsf":
            continue
        files[rel] = path
    return files


def check_inputs(p: Paths, ignore_fingerprint: bool) -> dict[str, str]:
    """比对原作指纹，返回 {相对路径: sha256}（写进 manifest）。不符则退出。"""
    if not (p.castle / "multimedia").is_dir() or not p.exe.is_file():
        sys.exit(f"✘ {p.castle} 不是原作的 Castle 目录（要有 exe/RPG.exe 与 multimedia/）")
    print("核对原作文件指纹（约 3 GB，十几秒）…", flush=True)
    actual = {rel: sha256(path) for rel, path in input_files(p.castle).items()}
    reference = json.loads(INPUTS_REF.read_text(encoding="utf-8"))["文件"]
    # RPG.exe 不比整文件：只核对我们实际读取的数据表（exe_tables），其余字节（免CD 等补丁）不管
    is_exe = lambda rel: rel.lower() == "exe/rpg.exe"
    exe_digest = next((d for rel, d in actual.items() if is_exe(rel)), None)
    try:
        exe_tables.check(load_pe(p.exe))
    except ValueError as err:
        sys.exit(f"✘ {err}")
    print(f"  RPG.exe：{KNOWN_EXE_SHA256.get(exe_digest, '未见过的版本，所读数据表与已核对版本一致')}")
    reference = {rel: d for rel, d in reference.items() if not is_exe(rel)}
    actual = {rel: d for rel, d in actual.items() if not is_exe(rel)} | {"exe/RPG.exe": exe_digest}
    lower = {k.lower(): v for k, v in actual.items() if not is_exe(k)}
    missing = [rel for rel in reference if rel.lower() not in lower]
    changed = [rel for rel, digest in reference.items() if lower.get(rel.lower(), digest) != digest]
    known = {rel.lower() for rel in reference}
    extra = [rel for rel in actual if rel.lower() not in known and not is_exe(rel)]
    if missing or changed or extra:
        for title, rows in (("缺少原作文件", missing), ("内容与已验证的官方版不同", changed),
                            ("多出的文件（MOD 或其他补丁？）", extra)):
            if rows:
                print(f"  {title} {len(rows)} 个：{'、'.join(rows[:8])}{' …' if len(rows) > 8 else ''}")
        if not ignore_fingerprint:
            sys.exit("✘ 原作目录与已验证的官方版不一致。只支持同一版本的官方安装；"
                     "确认要继续请加 --ignore-fingerprint（结果不保证）。")
        print("⚠ 已按 --ignore-fingerprint 继续")
    else:
        print(f"✔ 原作 {len(actual)} 个文件与已验证的官方版一致")
    return actual


def check_tools(p: Paths) -> None:
    missing = [m for m in ("PIL", "numpy") if not _importable(m)]
    if missing:
        sys.exit(f"✘ 当前 Python（{sys.executable}）缺少 {', '.join(missing)}：pip install pillow numpy")
    if shutil.which("ffmpeg") is None:
        print("⚠ 找不到 ffmpeg：影片一步会失败（装上后再跑同一条命令即可续上）")
    if p.chs is None:
        print("⚠ 没给 --chs：跳过简体字库与简体界面，简体模式不可用")
    elif not p.chs.is_dir():
        sys.exit(f"✘ 简体补丁目录不在：{p.chs}")


def _importable(name: str) -> bool:
    try:
        __import__(name)
        return True
    except ImportError:
        return False


# ---------------------------------------------------------------- 步骤

def tool(name: str, *args: object) -> list[str]:
    return [sys.executable, str(TOOLS / name), *map(str, args)]


def steps(p: Paths) -> list[tuple[str, str, Callable[[Paths, "Runner"], None]]]:
    """(名字, 说明, 执行)。顺序即依赖顺序：数值 → 地图 → 依赖地图的表 → 界面/音画 → 战斗包。"""
    a, mm = p.assets, p.mm
    data = a / "data"

    def run(*cmds: list[str]) -> Callable[[Paths, Runner], None]:
        return lambda _p, r: [r.call(c) for c in cmds]

    def newgame(_p: Paths, _r: Runner) -> None:
        data.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(mm("save/NewGame.TSF"), data / "NewGame.TSF")

    def maps(_p: Paths, r: Runner) -> None:
        archives = sorted(f for f in mm("Map").iterdir() if f.suffix.upper() == ".DAT")
        done = set(r.state.setdefault("maps", []))
        for i, dat in enumerate(archives, 1):
            if dat.name in done:
                continue
            print(f"\r  地图 {i}/{len(archives)} {dat.stem}      ", end="", flush=True)
            r.call(tool("export_map.py", dat, a / "maps", "--sprite-dir", a / "sprites",
                        "--sys", mm("Sys/Sys.dat")))
            r.state["maps"].append(dat.name)
            r.save()
        print()

    def menus(_p: Paths, r: Runner) -> None:
        r.call(tool("export_menu_ui.py", MENU_LAYOUT, mm("MenusDir.DAT"), "-o", a / "menus"))

    def fonts(_p: Paths, r: Runner) -> None:
        r.call(tool("export_font.py", mm("Font/font24.fnt"), a / "font", "--name", "yc24"))
        if p.chs:
            r.call(tool("export_font.py", p.chs_file("Font24.fnt"), a / "font", "--name", "yc24s"))

    def locale_ui(_p: Paths, r: Runner) -> None:
        if p.chs:
            r.call(tool("export_locale_ui.py", "--official", mm(), "--chs", p.chs, "--out", a))

    return [
        ("gamedata", "数值：角色/物品/绝学/敌人/遇敌（public/*.enc、RPG.exe；简体名表）",
         run(tool("export_gamedata.py", "-o", data, "--multimedia", mm(), "--names-dir", p.names))),
        ("tsf-layout", "存档字段布局表", run(tool("tsf_parse.py", "--layout", "--layout-out", data / "tsf_layout.json"))),
        ("newgame", "新游戏底档 NewGame.TSF", newgame),
        ("mapnames", "地名表", run(tool("export_map_names.py", mm("Map"), "-o", data / "mapnames.json"))),
        ("speakers", "说话人姓名表", run(tool("export_speakers.py", mm("Sys/Sys.dat"), data / "speakers.json"))),
        ("encounters", "行走遇敌表", run(tool("export_encounters.py", mm("Map"), data / "encounters.json"))),
        ("maps", "全部地图（地面、通行/遮挡、脚本、多层）与场景精灵图集", maps),
        ("script-sources", "过场图借用事件表", run(tool("export_script_sources.py", a / "maps", data / "script_sources.json"))),
        ("party", "主角队友行走形象与形象表", run(tool("export_party.py", mm("Sys"), a / "sprites", "--data", data))),
        ("portraits", "立绘", run(tool("export_portrait.py", mm("Sys/Sys.dat"), a / "portraits", "--all"))),
        ("ui", "对话框界面", run(tool("export_ui.py", mm("Sys/Sys.dat"), a / "ui"))),
        ("menus", "八页菜单（坐标表 tools/menu_layout.json 随代码）", menus),
        ("title", "标题画面与天书翻页动画", run(tool("export_title.py", mm("MenusDir.DAT"), a / "menus"))),
        ("cursors", "鼠标光标", run(tool("export_cursors.py", p.castle, a / "cursors"))),
        ("fonts", "繁体字库；有简体补丁时加简体字库", fonts),
        ("locale-ui", "简体界面美术（需简体补丁）", locale_ui),
        ("music", "背景音乐、剧情音效、战斗曲、升级音效",
         run(tool("export_music.py", mm("Music/Music.DAT"), p.out / "audio", "--tracks", MUSIC_NUMBERS,
                  "--sfx", MUSIC_NUMBERS, "--fight-audio", mm("fight/Audio/Mp3"),
                  "--level-up", mm("fight/Audio/wav0000.wav")))),
        ("movies", "影片（ffmpeg 转码）",
         run(tool("export_movies.py", "--src", mm("Mov"), "-o", a / "movies", "--movies", "all"),
             tool("export_movies.py", "--refining", "--src", mm("Mov"), "-o", a / "movies", "--crf", "20"))),
        # 先从原作扫出来源清单（battle_sources.json，登记 11 个原作缺源包），再导：
        # 没有这份清单时，已知缺口会被当成新缺失而判失败（2026-09-28 完整提取实测）。
        ("battle-art", "战斗动画包：人物/敌人/特效/背景/战斗界面（图集）",
         run(tool("export_battle_art.py", mm("fight"), a, "--gamedata", data / "gamedata.json",
                  "--maps-dir", a / "maps", "--scan-sources", data / "battle_sources.json"),
             tool("export_battle_art.py", mm("fight"), a, "--gamedata", data / "gamedata.json",
                  "--maps-dir", a / "maps"))),
        ("stones", "魂石旋转图像", run(tool("export_pack.py", a, *[mm(f"fight/Other/{s}") for s in STONES]))),
        ("refining", "客栈炼化表与魂石配置",
         run(tool("export_refining.py", "--public", mm("public"), "--exe", p.exe, "--out", data / "refining.json"))),
        ("transition", "进战斗玻璃破碎表与音效", run(tool("export_battle_transition.py", "--multimedia", mm(), "--out", p.out))),
    ] + hd_steps(p)


def hd_steps(p: Paths) -> list:
    """可选的最后一步：装入现成的高清素材包，或用 Real-ESRGAN 生成；装完/生成完按清单核对齐全。"""
    if p.hd_pack:
        return [("hd", "装入高清素材包", lambda _p, r: (
            r.call(tool("hd_pack.py", "install", p.hd_pack, p.out)), r.call(tool("hd_pack.py", "check", p.out))))]
    if p.hd_esrgan:
        batches = ["--floors", "all", "--portraits", "all", "--menus", *HD_MENUS, "--packs", *HD_PACKS, "--ui"]
        if p.chs:
            batches += ["--ui-locale", "chs"]
        return [("hd", "生成高清素材（Real-ESRGAN：战斗背景、立绘、人物形象、界面）", lambda _p, r: (
            r.call(tool("hd_upscale.py", "--esrgan", p.hd_esrgan, "--public", p.out, *batches)),
            r.call(tool("hd_pack.py", "check", p.out))))]
    return []


class Runner:
    """执行一条条子命令，输出进日志；记住做完的步骤，断了能续。"""

    def __init__(self, p: Paths, force: bool):
        self.p = p
        self.path = p.out / STATE_NAME
        self.state = {} if force or not self.path.exists() else json.loads(self.path.read_text("utf-8"))
        self.state.setdefault("done", [])
        self.log = None

    def save(self) -> None:
        self.path.write_text(json.dumps(self.state, ensure_ascii=False, indent=1), encoding="utf-8")

    def call(self, cmd: list[str]) -> None:
        self.log.write(f"$ {' '.join(cmd)}\n")
        self.log.flush()
        # 子工具一律 UTF-8 模式：中文 Windows 默认按 GBK 读写文本，中文 JSON 会读错或写坏
        env = {**os.environ, "PYTHONUTF8": "1", "PYTHONIOENCODING": "utf-8"}
        result = subprocess.run(cmd, cwd=ROOT, stdout=self.log, stderr=subprocess.STDOUT, env=env)
        if result.returncode:
            raise StepFailed(f"{Path(cmd[1]).name} 退出码 {result.returncode}")

    def run(self, name: str, action: Callable[[Paths, "Runner"], None]) -> float:
        logs = self.p.work / "logs"
        logs.mkdir(parents=True, exist_ok=True)
        start = time.time()
        with (logs / f"{name}.log").open("a", encoding="utf-8") as self.log:
            action(self.p, self)
        self.state["done"].append(name)
        self.save()
        return time.time() - start


class StepFailed(Exception):
    pass


# ---------------------------------------------------------------- 完整性与参照表

def output_files(public: Path) -> list[str]:
    rows = []
    for path in public.rglob("*"):
        rel = path.relative_to(public).as_posix()
        if not path.is_file() or path.name in IGNORED_NAMES or rel.startswith(OWN_FILES) \
                or rel.startswith(DEV_ONLY_PREFIXES) or rel.startswith(HD_PREFIX):
            continue
        rows.append(rel)
    return sorted(rows)


def grouped(paths: list[str]) -> dict[str, list[str]]:
    out: dict[str, list[str]] = {}
    for rel in paths:
        folder, _, name = rel.rpartition("/")
        out.setdefault(folder, []).append(name)
    return out


def verify_outputs(p: Paths) -> dict:
    expected = {f"{d}/{n}" if d else n
                for d, names in json.loads(EXPECTED_REF.read_text("utf-8"))["目录"].items() for n in names}
    actual = set(output_files(p.out))
    missing, extra = sorted(expected - actual), sorted(actual - expected)
    if not p.chs:        # 没给简体补丁时简体产物本来就没有
        missing = [m for m in missing if not (m.startswith("assets/locales/") or "/yc24s" in m)]
    report = {"应有": len(expected), "实有": len(actual), "缺少": missing, "多出": extra}
    (p.work / "report.json").write_text(json.dumps(report, ensure_ascii=False, indent=1), encoding="utf-8")
    return report


def write_reference(castle: Path, expected_from: Path | None) -> None:
    rows = {rel: sha256(path) for rel, path in input_files(castle).items()}
    INPUTS_REF.write_text(json.dumps({"说明": "已验证的官方原作文件指纹（tools/extract.py 核对用）",
                                      "文件": rows}, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    print(f"-> {INPUTS_REF}（{len(rows)} 个文件）")
    if expected_from:
        files = output_files(expected_from)
        EXPECTED_REF.write_text(json.dumps({"说明": "提取产物应有的文件清单（tools/extract.py 完整性检查用）；"
                                                    "由一次完整提取比对通过后的素材生成",
                                            "文件数": len(files), "目录": grouped(files)},
                                           ensure_ascii=False, separators=(",", ":")) + "\n", encoding="utf-8")
        print(f"-> {EXPECTED_REF}（{len(files)} 个文件）")


def code_version() -> str:
    try:
        return subprocess.run(["git", "describe", "--always", "--dirty"], cwd=ROOT, capture_output=True,
                              text=True, check=True).stdout.strip()
    except (OSError, subprocess.CalledProcessError):
        return "未知（不在 git 仓库里）"


# ---------------------------------------------------------------- 入口

def utf8_console() -> None:
    """中文 Windows 的命令行默认 GBK，打印 ✔ ✘ ▶ 会直接报错退出；改成 UTF-8、无法显示的字符替换掉。"""
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8", errors="replace")


def main(argv: list[str]) -> int:
    utf8_console()
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--castle", type=Path, required=True, help="原作安装的 Castle 目录（含 exe/ 与 multimedia/）")
    bundled_chs = ROOT / "patches" / "chs"   # 开源仓库随代码带的简体补丁
    ap.add_argument("--chs", type=Path, default=bundled_chs if bundled_chs.is_dir() else None,
                    help="简体补丁的 chs 目录（Font24.fnt、ItfDir.DAT、MenusDir.DAT…）；仓库带了 patches/chs 时默认用它")
    ap.add_argument("--names", type=Path, default=ROOT / "data", help="简体名表目录（items/equipment/skills.json）")
    ap.add_argument("--out", type=Path, help="输出目录（即新的 game/public）")
    ap.add_argument("--only", default="", help="只跑这些步骤，逗号分隔")
    ap.add_argument("--force", action="store_true", help="忽略断点，全部重跑")
    ap.add_argument("--list", action="store_true", help="列出步骤后退出")
    ap.add_argument("--ignore-fingerprint", action="store_true", help="原作指纹不符也继续（结果不保证）")
    ap.add_argument("--write-reference", action="store_true", help="维护：按 --castle 重写原作指纹参照表")
    ap.add_argument("--expected-from", type=Path, default=None, help="维护：同时按这个 public 目录重写产物清单")
    hd = ap.add_mutually_exclusive_group()
    hd.add_argument("--hd-esrgan", type=Path, default=None,
                    help="生成高清素材：realesrgan-ncnn-vulkan 可执行文件路径（解压官方发布包即得，含模型）")
    hd.add_argument("--hd-pack", type=Path, default=None, help="不生成，直接装入现成的高清素材包（tools/hd_pack.py make 打的 zip）")
    args = ap.parse_args(argv)

    if args.write_reference:
        write_reference(args.castle.expanduser(), args.expected_from)
        return 0
    if args.out is None:
        ap.error("要给 --out")
    resolve = lambda path: path.expanduser().resolve() if path else None
    p = Paths(resolve(args.castle), resolve(args.chs), resolve(args.names), resolve(args.out),
              hd_esrgan=resolve(args.hd_esrgan), hd_pack=resolve(args.hd_pack))
    if p.hd_esrgan and not p.hd_esrgan.is_file():
        ap.error(f"找不到 Real-ESRGAN 可执行文件：{p.hd_esrgan}")
    if p.hd_pack and not p.hd_pack.exists():
        ap.error(f"找不到高清素材包：{p.hd_pack}")
    plan = steps(p)
    if args.list:
        for i, (name, desc, _) in enumerate(plan, 1):
            print(f"{i:2}. {name:15} {desc}")
        return 0
    only = [s.strip() for s in args.only.split(",") if s.strip()]
    unknown = set(only) - {name for name, _, _ in plan}
    if unknown:
        ap.error(f"没有这些步骤：{', '.join(sorted(unknown))}（--list 查看）")

    check_tools(p)
    fingerprints = check_inputs(p, args.ignore_fingerprint)
    p.out.mkdir(parents=True, exist_ok=True)
    runner = Runner(p, args.force)
    timings = dict(runner.state.get("seconds", {}))
    for name, desc, action in plan:
        if only and name not in only:
            continue
        if name in runner.state["done"] and not only:
            print(f"  ✔ {name}（已完成，跳过）")
            continue
        if only and name in runner.state["done"]:
            runner.state["done"].remove(name)
            if name == "maps":
                runner.state["maps"] = []
        print(f"▶ {name}：{desc}", flush=True)
        try:
            timings[name] = round(runner.run(name, action), 1)
        except (StepFailed, OSError) as err:
            log = p.work / "logs" / f"{name}.log"
            tail = log.read_text("utf-8", errors="replace").splitlines()[-15:] if log.exists() else []
            print("\n".join(f"    {line}" for line in tail))
            print(f"✘ {name} 失败：{err}\n  完整日志：{log}\n  修好后再跑同一条命令，从这一步续上。")
            return 1
        runner.state["seconds"] = timings
        runner.save()
        print(f"  ✔ {name}  {timings[name]} 秒")

    report = verify_outputs(p)
    manifest = {
        "生成自": "tools/extract.py", "代码版本": code_version(),
        "时间": time.strftime("%Y-%m-%d %H:%M:%S"),
        "原作目录": str(p.castle), "简体补丁": str(p.chs) if p.chs else None,
        "原作指纹": fingerprints,
        "简体补丁指纹": {f.relative_to(p.chs).as_posix(): sha256(f) for f in sorted(p.chs.rglob("*"))
                    if f.is_file() and f.name not in IGNORED_NAMES} if p.chs else None,
        "简体名表": {f.name: sha256(f) for f in sorted(p.names.glob("*.json"))},
        "每步秒数": timings, "完整性": {k: (v if isinstance(v, int) else len(v)) for k, v in report.items()},
    }
    (p.out / MANIFEST_NAME).write_text(json.dumps(manifest, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"完整性：应有 {report['应有']}，实有 {report['实有']}，缺 {len(report['缺少'])}，多 {len(report['多出'])}"
          f"（明细 {p.work / 'report.json'}）")
    if report["缺少"]:
        print("✘ 产物不完整：" + "、".join(report["缺少"][:8]))
        return 1
    print(f"✔ 完成 → {p.out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
