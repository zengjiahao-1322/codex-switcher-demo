#!/bin/bash
set -e
SOURCE="$(cd "$(dirname "$0")" && pwd)/Codex Switcher.app"
TARGET="$HOME/Applications/Codex Switcher.app"
mkdir -p "$HOME/Applications"
if [ ! -d "$SOURCE" ]; then echo 'Missing Codex Switcher.app beside installer'; exit 1; fi
DATA="$HOME/Library/Application Support/CodexApiSwitcher"
if [ -f "$DATA/running.json" ]; then
 NODE="$SOURCE/Contents/Resources/runtime/$(case "$(uname -m)" in arm64) echo arm64 ;; *) echo x64 ;; esac)/node"
 "$NODE" - "$DATA/running.json" <<'JS'
const fs=require('fs'),cp=require('child_process');try{const r=JSON.parse(fs.readFileSync(process.argv[2]));const command=cp.execFileSync('/bin/ps',['-p',String(r.pid),'-o','command='],{encoding:'utf8'});if(command.includes('/Codex Switcher.app/Contents/Resources/main.cjs'))process.kill(r.pid,'SIGTERM')}catch{}
JS
fi
/usr/bin/ditto "$SOURCE" "$TARGET"
/usr/bin/open "$TARGET"
echo "Installed to $TARGET. Account data stays in $DATA."
