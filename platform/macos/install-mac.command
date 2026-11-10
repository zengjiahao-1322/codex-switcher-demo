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
  "$SOURCE/Contents/Resources/codex-switcher" --stop-installed "$DATA/running.json" "$TARGET/Contents/Resources"
fi
# 0.1.3-0.1.5 (Node) backends keep running from the old app bundle.
/usr/bin/pkill -f "$TARGET/Contents/Resources/main.cjs" || true
/usr/bin/ditto "$SOURCE" "$TARGET"
# ditto can preserve the quarantine flag and make the installed app run from
# AppTranslocation. The attribute may not exist, so do not fail the install.
/usr/bin/xattr -dr com.apple.quarantine "$TARGET" 2>/dev/null || true
echo "Installed to $TARGET. Account data stays in $DATA."
# 无界面安装用于 CI 实际执行安装流程，日常双击仍会自动打开应用。
if [ "${1:-}" != '--no-open' ]; then
  /usr/bin/open "$TARGET"
fi
