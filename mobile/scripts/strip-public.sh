#!/bin/sh
# cap copy/sync 之后的瘦身（capacitor:copy:after 钩子）：手机固定原版画质，删掉 AI 高清图 assets-hd、
# 开发用测试存档与战斗素材来源表。Capacitor 运行钩子时用 CAPACITOR_PLATFORM_NAME 告知当前平台。
set -e
case "$CAPACITOR_PLATFORM_NAME" in
  ios) PUBLIC=ios/App/App/public ;;
  android) PUBLIC=android/app/src/main/assets/public ;;
  *) echo "strip-public: 未知平台 '$CAPACITOR_PLATFORM_NAME'" >&2; exit 1 ;;
esac
rm -rf "$PUBLIC/assets-hd" "$PUBLIC/assets/data/saves" "$PUBLIC/assets/data/battle_sources.json"
find "$PUBLIC" -name .DS_Store -delete
