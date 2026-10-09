#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
幽城幻剑录（DynastyReforge）自动打包上传脚本
- 步骤1: 在 game/ 下执行 npm run build 生成 dist
- 步骤2: 将 dist 内容按相对路径打包为固定名 zip（dist_ychjl.zip，压缩前删除旧包）
- 步骤3: 上传 zip 到 FTP（hk.anlinxi.top / ychjl）
- 步骤4: 打印完成摘要

注意：本脚本含明文 FTP 凭据，已加入 .gitignore，禁止提交 git。
"""
import ftplib
import os
import subprocess
import sys
import time
import zipfile
from datetime import datetime

# 实时刷新输出，避免重定向/后台运行时日志被缓冲吞掉
sys.stdout.reconfigure(line_buffering=True)
sys.stderr.reconfigure(line_buffering=True)

REPO_ROOT = os.path.dirname(os.path.abspath(__file__))
GAME_DIR = os.path.join(REPO_ROOT, "game")
DIST_DIR = os.path.join(GAME_DIR, "dist")

# ---- FTP 配置（明文，勿提交 git）----
FTP_HOST = "hk.anlinxi.top"
FTP_PORT = 21
FTP_USER = "ychjl"
FTP_PASS = "CP7hsBXJrxb7"
FTP_REMOTE_DIR = "ychjl"  # 预留：如 FTP 账号未 chroot，可在此指定目标子目录
PUBLIC_URL = "https://hk.anlinxi.top/ychjl/"

# ---- 产物配置（固定名，每次压缩前删除旧包）----
ZIP_DIR = os.path.join(GAME_DIR, "dist_zip")
ZIP_NAME = "dist_ychjl.zip"
ZIP_PATH = os.path.join(ZIP_DIR, ZIP_NAME)

# ---- 实测基准（用于预估，可随环境调整）----
BUILD_EST_SEC = 90          # build 实测约 1m30s
ZIP_PER_FILE_SEC = 0.010    # 打包每文件实测约 10ms（25320 文件约 4-5 分钟）
UPLOAD_SPEED_MBPS = 1.45    # 上传实测约 1.45 MB/s（约 1.7GB -> 20 分钟）


def now():
    return datetime.now().strftime("%H:%M:%S")


def human(n):
    if n >= 1024 ** 3:
        return "%.2f GB" % (n / 1024 ** 3)
    if n >= 1024 ** 2:
        return "%.1f MB" % (n / 1024 ** 2)
    if n >= 1024:
        return "%.1f KB" % (n / 1024)
    return "%d B" % n


def est(seconds):
    seconds = max(0, int(seconds))
    if seconds < 60:
        return "约 %d 秒" % seconds
    return "约 %d 分 %d 秒" % (seconds // 60, seconds % 60)


def count_files():
    return sum(len(files) for _, _, files in os.walk(DIST_DIR))


def run_build():
    print("[%s] [1/4] npm run build 开始，预估耗时 %s ..." % (now(), est(BUILD_EST_SEC)), flush=True)
    t0 = time.time()
    subprocess.run(["npm", "run", "build"], cwd=GAME_DIR, check=True)
    print("[%s] [1/4] build 完成，实际耗时 %s" % (now(), est(time.time() - t0)), flush=True)


def make_zip():
    if not os.path.isdir(DIST_DIR):
        sys.exit("dist 目录不存在: " + DIST_DIR)
    total = count_files()
    est_sec = total * ZIP_PER_FILE_SEC
    print("[%s] [2/4] 打包 dist -> %s" % (now(), ZIP_PATH), flush=True)
    print("[%s] [2/4] 待打包文件数: %d，预估耗时 %s" % (now(), total, est(est_sec)), flush=True)
    if os.path.exists(ZIP_PATH):
        print("[%s] [2/4] 删除旧包: %s" % (now(), ZIP_PATH), flush=True)
        os.remove(ZIP_PATH)  # 固定名，压缩前删除旧包
    os.makedirs(ZIP_DIR, exist_ok=True)
    t0 = time.time()
    done = 0
    with zipfile.ZipFile(ZIP_PATH, "w", zipfile.ZIP_STORED) as zf:
        for root, _, files in os.walk(DIST_DIR):
            for name in files:
                full = os.path.join(root, name)
                arc = os.path.relpath(full, DIST_DIR)  # 相对路径，不含 dist 前缀
                zf.write(full, arc)
                done += 1
                if done % 1000 == 0:
                    pct = done * 100.0 / total
                    remain = (time.time() - t0) / done * (total - done)
                    print("[%s] [2/4] 已打包 %d/%d (%.0f%%)，剩余 %s，当前: %s"
                          % (now(), done, total, pct, est(remain), arc), flush=True)
    size = os.path.getsize(ZIP_PATH)
    print("[%s] [2/4] 打包完成: %d 个文件，%s，实际耗时 %s"
          % (now(), done, human(size), est(time.time() - t0)), flush=True)


def upload():
    total = os.path.getsize(ZIP_PATH)
    est_sec = total / 1024 / 1024 / UPLOAD_SPEED_MBPS
    print("[%s] [3/4] 上传 FTP 开始: %s (%s)，预估耗时 %s（按 %.2f MB/s 估算）..."
          % (now(), ZIP_NAME, human(total), est(est_sec), UPLOAD_SPEED_MBPS), flush=True)
    ftp = ftplib.FTP()
    ftp.connect(FTP_HOST, FTP_PORT, timeout=120)
    ftp.login(FTP_USER, FTP_PASS)
    # 实测：FTP 账号 ychjl 已 chroot 到 /ychjl（对应外网 https://hk.anlinxi.top/ychjl/），
    # 登录后当前目录即目标目录，无需 cwd。若账号未 chroot，放开下行切换目录即可。
    # ftp.cwd(FTP_REMOTE_DIR)
    t0 = time.time()
    sent = [0]
    last_report = [0]

    def cb(block):
        sent[0] += len(block)
        # 每约 100MB 或最后一块打印进度
        if sent[0] - last_report[0] >= 100 * 1024 * 1024 or sent[0] >= total:
            last_report[0] = sent[0]
            pct = sent[0] * 100.0 / total
            speed = sent[0] / 1024 / 1024 / max(time.time() - t0, 0.1)
            remain = (total - sent[0]) / 1024 / 1024 / max(speed, 0.01)
            print("[%s] [3/4] 已上传 %s/%s (%.0f%%)，速度 %.2f MB/s，剩余 %s"
                  % (now(), human(sent[0]), human(total), pct, speed, est(remain)), flush=True)

    with open(ZIP_PATH, "rb") as f:
        ftp.storbinary("STOR " + ZIP_NAME, f, blocksize=65536, callback=cb)
    ftp.quit()
    print("[%s] [3/4] 上传完成: %s，实际耗时 %s"
          % (now(), PUBLIC_URL + ZIP_NAME, est(time.time() - t0)), flush=True)


if __name__ == "__main__":
    t_start = time.time()
    try:
        run_build()
        make_zip()
        upload()
        print("[%s] [4/4] 全部完成，总耗时 %s。" % (now(), est(time.time() - t_start)), flush=True)
        print("[%s] [4/4] 提示: zip 内为相对路径结构（index.html 在根），解压到服务器 /www/wwwroot/ychjl/ 即可通过 %s 访问"
              % (now(), PUBLIC_URL), flush=True)
    except Exception:
        import traceback
        print("[%s] [4/4] 执行失败，异常堆栈如下：" % now(), flush=True)
        traceback.print_exc()
        sys.exit(1)
