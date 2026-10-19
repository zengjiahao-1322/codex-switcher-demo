#!/bin/bash
set -e
RESOURCES="$(cd "$(dirname "$0")/../Resources" && pwd)"
case "$(uname -m)" in arm64) ARCH=arm64 ;; x86_64) ARCH=x64 ;; *) echo 'Unsupported Mac architecture'; exit 1 ;; esac
DATA="$HOME/Library/Application Support/CodexApiSwitcher"
mkdir -p "$DATA"
export BRIDGE_HOME="$DATA"
export BRIDGE_DISCOVERY_DIR="$HOME/.codex-api-switcher"
if [ -f "$DATA/runtime.env" ]; then source "$DATA/runtime.env"; fi
nohup "$RESOURCES/runtime/$ARCH/node" "$RESOURCES/main.cjs" >>"$DATA/service.log" 2>>"$DATA/service-error.log" </dev/null &
exit 0
