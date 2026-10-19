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
const fs = require('fs');
const cp = require('child_process');
try {
  const running = JSON.parse(fs.readFileSync(process.argv[2]));
  const command = cp.execFileSync('/bin/ps', ['-p', String(running.pid), '-o', 'command='], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  if (command.includes('/Codex Switcher.app/Contents/Resources/main.cjs')) {
    process.kill(running.pid, 'SIGTERM');
  }
} catch {
  // 旧服务已退出或运行记录失效时，继续安装。
}
JS
fi
/usr/bin/ditto "$SOURCE" "$TARGET"
echo "Installed to $TARGET. Account data stays in $DATA."
# 无界面安装用于 CI 实际执行安装流程，日常双击仍会自动打开应用。
if [ "${1:-}" != '--no-open' ]; then
  /usr/bin/open "$TARGET"
fi
