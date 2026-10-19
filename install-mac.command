#!/bin/bash
set -e

# macOS 自带 Bash 3.2，不在命令替换中嵌套 case。
case "$(uname -m)" in
  arm64) ARCH=arm64 ;;
  x86_64) ARCH=x64 ;;
  *) echo 'Unsupported Mac architecture'; exit 1 ;;
esac

SOURCE="$(cd "$(dirname "$0")" && pwd)/Codex Switcher.app"
TARGET="$HOME/Applications/Codex Switcher.app"
mkdir -p "$HOME/Applications"
if [ ! -d "$SOURCE" ]; then echo 'Missing Codex Switcher.app beside installer'; exit 1; fi
DATA="$HOME/Library/Application Support/CodexApiSwitcher"
if [ -f "$DATA/running.json" ]; then
 NODE="$SOURCE/Contents/Resources/runtime/$ARCH/node"
 "$NODE" - "$DATA/running.json" <<'JS'
const fs=require('fs'),cp=require('child_process');try{const r=JSON.parse(fs.readFileSync(process.argv[2]));const command=cp.execFileSync('/bin/ps',['-p',String(r.pid),'-o','command='],{encoding:'utf8'});if(command.includes('/Codex Switcher.app/Contents/Resources/main.cjs'))process.kill(r.pid,'SIGTERM')}catch{}
JS
fi
/usr/bin/ditto "$SOURCE" "$TARGET"
echo "Installed to $TARGET. Account data stays in $DATA."
# 无界面安装用于 CI 实际执行安装流程，日常双击仍会自动打开应用。
if [ "${1:-}" != '--no-open' ]; then
  /usr/bin/open "$TARGET"
fi
