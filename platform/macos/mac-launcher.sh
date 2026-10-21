#!/bin/bash
set -e
RESOURCES="$(cd "$(dirname "$0")/../.." && pwd)"
# Finder 不继承终端环境，根据当前架构选用随包运行时。
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
nohup "$RESOURCES/runtime/$ARCH/node" "$RESOURCES/main.cjs" "$@" \
  >>"$DATA/service.log" 2>>"$DATA/service-error.log" </dev/null &
exit 0
