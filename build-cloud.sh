#!/bin/bash
# build-cloud.sh — 云端/CI 一键构建打包（自动提交 + 推送 GitHub）。
#
# 用法:
#   ./build-cloud.sh                 # typecheck+test+build+package，然后 commit+push
#   ./build-cloud.sh --no-push       # 只构建打包，不 commit/push
#   ./build-cloud.sh --message "..." # 自定义提交信息（默认自动生成）
#
# 设计给: GitHub Actions / 远程终端。含完整校验，失败即非零退出。
# 注意: 本脚本会 git add -A && push origin；本地日常构建请用 build-local.sh。

set -euo pipefail
cd "$(dirname "$0")"

NO_PUSH=0
MSG=""
for arg in "$@"; do
  case "$arg" in
    --no-push) NO_PUSH=1 ;;
    --message) MSG="${2:-}"; shift 2 ;;
    *) echo "未知参数: $arg" >&2; exit 2 ;;
  esac
done

echo "▶ [1/5] typecheck..."
npm run typecheck
echo "▶ [2/5] test..."
npm test
echo "▶ [3/5] build..."
npm run build
echo "▶ [4/5] package..."
npm run package

PKG=$(ls -t dist/*.toolpkg | head -1)
echo "✔ 构建产物: $PKG ($(du -h "$PKG" | cut -f1))"

if [ "$NO_PUSH" = "1" ]; then
  echo "✔ 构建完成（--no-push，未提交）"
  exit 0
fi

echo "▶ [5/5] commit + push..."
if [ -z "$MSG" ]; then
  VER=$(grep '"version"' package.json | head -1 | sed -E 's/.*"([0-9.]+)".*/\1/')
  MSG="build: v$VER 构建产物（自动）"
fi
git add -A
if git diff --cached --quiet; then
  echo "✔ 无变更需提交"
else
  git commit -m "$MSG"
fi
git push origin "$(git branch --show-current)"
echo "✔ 已推送 $(git rev-parse --short HEAD)"