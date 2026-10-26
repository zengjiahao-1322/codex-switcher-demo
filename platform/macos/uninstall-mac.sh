#!/bin/bash
set -euo pipefail
resources="$1"
data="$2"
keep="$3"
pid="$4"
app="$(cd "$resources/../.." && pwd)"
case "$app" in *.app) ;; *) echo 'Unexpected application path' >&2; exit 1 ;; esac
while kill -0 "$pid" 2>/dev/null; do sleep 0.2; done
rm -f "$HOME/Library/LaunchAgents/com.codex-switcher.demo.plist"
if [ "$keep" != 'true' ] && [ -e "$data" ]; then
  expected="$HOME/Library/Application Support/CodexApiSwitcher"
  data_abs="$(cd "$data" && pwd)"
  if [ "$data_abs" != "$expected" ]; then echo 'Unexpected data directory' >&2; exit 1; fi
  if [ ! -d "$data/accounts" ] && [ ! -f "$data/running.json" ]; then echo 'Data directory marker missing' >&2; exit 1; fi
  rm -rf -- "$data"
fi
rm -rf "$app"
