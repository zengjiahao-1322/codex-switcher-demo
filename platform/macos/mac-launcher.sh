#!/bin/bash
set -e
RESOURCES="$(cd "$(dirname "$0")/../.." && pwd)"
# 只运行当前支持的 macOS 架构。
case "$(uname -m)" in
  arm64) ARCH=arm64 ;;
  x86_64) ARCH=x64 ;;
  *) echo 'Unsupported Mac architecture'; exit 1 ;;
esac
DATA="$HOME/Library/Application Support/CodexApiSwitcher"
mkdir -p "$DATA"
export BRIDGE_HOME="$DATA"
export BRIDGE_DISCOVERY_DIR="$HOME/.codex-api-switcher"
if [ -f "$DATA/runtime.env" ]; then
  source "$DATA/runtime.env"
fi
# 保留命令行参数，便于在精简环境中验证同一个应用入口。
nohup "$RESOURCES/codex-switcher" "$@" >>"$DATA/service.log" 2>>"$DATA/service-error.log" </dev/null &
exit 0
