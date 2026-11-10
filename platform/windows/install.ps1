# Codex API Switcher - one-step installer for Windows 10/11.
# Local:   double-click install.cmd in a downloaded copy.
# Installs the native release to %LOCALAPPDATA%\CodexApiSwitcher,
# creates a Desktop shortcut and starts the tool.
# Re-running upgrades in place and keeps your saved configs (the private folder).
# Keep this file ASCII-only: Windows PowerShell 5.1 reads scripts without a BOM using the ANSI code page.
param(
  [string]$InstallDir = (Join-Path $env:LOCALAPPDATA 'CodexApiSwitcher'),
  [switch]$NoShortcuts,
  [switch]$NoLaunch
)
$ErrorActionPreference = 'Stop'

function Step($msg) { Write-Host "==> $msg" -ForegroundColor Cyan }
if ($env:OS -ne 'Windows_NT') { throw 'Codex API Switcher currently supports Windows only.' }
$src = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))

$AppFiles = (Get-Content -LiteralPath (Join-Path $src 'release-files.json') -Raw | ConvertFrom-Json)
$AppFiles += 'release-files.json'

# 1. Stop a running instance before overwriting its files.
$customData = $env:BRIDGE_HOME -and [IO.Path]::GetFullPath($env:BRIDGE_HOME).TrimEnd('\') -ine [IO.Path]::GetFullPath((Join-Path $InstallDir 'private')).TrimEnd('\')
$dataDir = if ($customData) { $env:BRIDGE_HOME } else { Join-Path $env:LOCALAPPDATA 'CodexSwitcher' }
$running = Join-Path $dataDir 'running.json'
if (-not (Test-Path -LiteralPath $running)) { $running = Join-Path $InstallDir 'private\running.json' }
if (Test-Path $running) {
  $old = Get-Content $running -Raw | ConvertFrom-Json
  $oldProcess = Get-CimInstance Win32_Process -Filter "ProcessId = $($old.pid)"
  if ($oldProcess) {
    $ownsNative = $oldProcess.ExecutablePath -eq (Join-Path $InstallDir 'codex-switcher.exe')
    # 0.1.3-0.1.5 (Node) start with Windows, so the old backend is usually running during a manual install.
    $ownsNode = $oldProcess.ExecutablePath -eq (Join-Path $InstallDir 'runtime\node.exe') -and $oldProcess.CommandLine.Contains((Join-Path $InstallDir 'main.cjs'))
    if ($ownsNative -or $ownsNode) { Stop-Process -Id $old.pid -Force -ErrorAction Stop; Start-Sleep -Milliseconds 800; Step 'Stopped the running instance' }
  }
}

# 2. Copy application files.
Step "Installing to $InstallDir"
New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
if ((Resolve-Path $src).Path -ne (Resolve-Path $InstallDir).Path) {
  foreach ($f in $AppFiles) { $p = Join-Path $src $f; if (Test-Path $p) { $destination = Join-Path $InstallDir $f; New-Item -ItemType Directory -Force -Path (Split-Path -Parent $destination) | Out-Null; Copy-Item -LiteralPath $p -Destination $destination -Force } else { throw "Missing file in package: $f" } }
}

# Offline release archives already include runtime and dependencies.
if ((Resolve-Path $src).Path -ne (Resolve-Path $InstallDir).Path) {
  foreach ($folder in @('runtime','node_modules','bin')) {
    $bundled = Join-Path $src $folder
    if (Test-Path -LiteralPath $bundled) { Copy-Item -LiteralPath $bundled -Destination $InstallDir -Recurse -Force }
  }
}

# 3. Share the first-launch shortcut marker and installed-app registration.
& (Join-Path $InstallDir 'platform\windows\desktop-integration.ps1') -InstallDir $InstallDir -RegisterOnly:$NoShortcuts

# 4. Codex check (informational).
$codexBin = Join-Path $env:LOCALAPPDATA 'OpenAI\Codex\bin'
if (-not (Test-Path $codexBin)) { Write-Warning 'Codex desktop was not found. Install and open Codex once, or set CODEX_EXE to a codex.exe.' }

Write-Host ''
Write-Host "Installed Codex API Switcher to $InstallDir" -ForegroundColor Green
if (-not $NoLaunch) { Start-Process -WindowStyle Hidden -FilePath (Join-Path $env:SystemRoot 'System32\wscript.exe') -ArgumentList ('"' + (Join-Path $InstallDir 'launch-hidden.vbs') + '"'), 'open' }
