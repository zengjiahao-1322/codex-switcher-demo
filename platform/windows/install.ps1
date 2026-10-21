# Codex API Switcher - one-step installer for Windows 10/11.
# Online: powershell -NoProfile -ExecutionPolicy Bypass -Command "irm https://raw.githubusercontent.com/__REPO__/main/platform/windows/install.ps1 | iex"
# Local:   double-click install.cmd in a downloaded copy.
# Installs to %LOCALAPPDATA%\CodexApiSwitcher, downloads the official Node.js runtime (SHA-256 verified) and two
# small dependencies (sha512 verified), creates Desktop / Start Menu shortcuts and starts the tool.
# Re-running upgrades in place and keeps your saved configs (the private folder).
# Keep this file ASCII-only: Windows PowerShell 5.1 reads scripts without a BOM using the ANSI code page.
param(
  [string]$InstallDir = (Join-Path $env:LOCALAPPDATA 'CodexApiSwitcher'),
  [string]$Repo = 'zengjiahao-1322/codex-switcher-demo',
  [string]$Ref = 'main',
  [switch]$NoShortcuts,
  [switch]$NoLaunch
)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$NodeVersion = 'v22.22.0'
$NodeSha256 = 'c97fa376d2becdc8863fcd3ca2dd9a83a9f3468ee7ccf7a6d076ec66a645c77a'
$AppFiles = @()

function Step($msg) { Write-Host "==> $msg" -ForegroundColor Cyan }
if ($env:OS -ne 'Windows_NT') { throw 'Codex API Switcher currently supports Windows only.' }
$tmp = Join-Path ([IO.Path]::GetTempPath()) ('codex-api-switcher-' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Force -Path $tmp | Out-Null
try {
  # 1. Source files: the folder this script lives in (local install) or a GitHub archive (online install).
  $src = $null
  $localRoot = if ($PSScriptRoot) { [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..')) } else { $null }
  if ($localRoot -and (Test-Path (Join-Path $localRoot 'main.cjs'))) { $src = $localRoot }
  else {
    if ($Repo -like '*__REPO__*') { throw 'Repository is not set; pass -Repo owner/name.' }
    Step "Downloading $Repo ($Ref)"
    $zip = Join-Path $tmp 'src.zip'
    Invoke-WebRequest -UseBasicParsing -Uri "https://codeload.github.com/$Repo/zip/refs/heads/$Ref" -OutFile $zip
    Expand-Archive -Path $zip -DestinationPath (Join-Path $tmp 'src') -Force
    $src = (Get-ChildItem (Join-Path $tmp 'src') -Directory | Select-Object -First 1).FullName
  }

  $AppFiles = (Get-Content -LiteralPath (Join-Path $src 'release-files.json') -Raw | ConvertFrom-Json)
  $AppFiles += 'release-files.json'

  # 2. Stop a running instance before overwriting its files.
  $running = Join-Path $InstallDir 'private\running.json'
  if (Test-Path $running) {
    try { $old = Get-Content $running -Raw | ConvertFrom-Json; $oldProcess = Get-CimInstance Win32_Process -Filter "ProcessId = $($old.pid)"; if ($oldProcess.ExecutablePath -ne (Join-Path $InstallDir 'runtime\node.exe') -or -not $oldProcess.CommandLine.Contains((Join-Path $InstallDir 'main.cjs'))) { throw 'Unexpected running process' }; Stop-Process -Id $old.pid -Force -ErrorAction Stop; Start-Sleep -Milliseconds 800; Step 'Stopped the running instance' } catch {}
  }

  # 3. Copy application files.
  Step "Installing to $InstallDir"
  New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
  if ((Resolve-Path $src).Path -ne (Resolve-Path $InstallDir).Path) {
    foreach ($f in $AppFiles) { $p = Join-Path $src $f; if (Test-Path $p) { $destination = Join-Path $InstallDir $f; New-Item -ItemType Directory -Force -Path (Split-Path -Parent $destination) | Out-Null; Copy-Item -LiteralPath $p -Destination $destination -Force } else { throw "Missing file in package: $f" } }
  }

  # Offline release archives already include runtime and dependencies.
  if ((Resolve-Path $src).Path -ne (Resolve-Path $InstallDir).Path) {
    foreach ($folder in @('runtime','node_modules')) {
      $bundled = Join-Path $src $folder
      if (Test-Path -LiteralPath $bundled) { Copy-Item -LiteralPath $bundled -Destination $InstallDir -Recurse -Force }
    }
  }

  # 4. Node.js runtime (only node.exe is needed).
  $nodeExe = Join-Path $InstallDir 'runtime\node.exe'
  $haveVersion = $null
  if (Test-Path $nodeExe) { try { $haveVersion = (& $nodeExe --version).Trim() } catch {} }
  if ($haveVersion -ne $NodeVersion) {
    Step "Downloading Node.js $NodeVersion"
    $nodeZip = Join-Path $tmp 'node.zip'
    Invoke-WebRequest -UseBasicParsing -Uri "https://nodejs.org/dist/$NodeVersion/node-$NodeVersion-win-x64.zip" -OutFile $nodeZip
    $hash = (Get-FileHash $nodeZip -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($hash -ne $NodeSha256) { throw "Node.js download failed verification (SHA-256 $hash)" }
    Expand-Archive -Path $nodeZip -DestinationPath (Join-Path $tmp 'node') -Force
    New-Item -ItemType Directory -Force -Path (Join-Path $InstallDir 'runtime') | Out-Null
    Copy-Item (Join-Path $tmp "node\node-$NodeVersion-win-x64\node.exe") $nodeExe -Force
    Copy-Item (Join-Path $tmp "node\node-$NodeVersion-win-x64\LICENSE") (Join-Path $InstallDir 'runtime\NODE-LICENSE') -Force
  } else { Step "Node.js $NodeVersion already present" }

  # 5. Dependencies.
  Step 'Installing dependencies'
  & $nodeExe (Join-Path $InstallDir 'scripts/install-deps.cjs')
  if ($LASTEXITCODE -ne 0) { throw 'Dependency installation failed.' }

  # 6. Shortcuts: Desktop + Start Menu, launching the hidden service and opening the UI.
  if (-not $NoShortcuts) {
    Step 'Creating shortcuts'
    $shell = New-Object -ComObject WScript.Shell
    $targets = @([Environment]::GetFolderPath('Desktop'), [Environment]::GetFolderPath('Programs'))
    foreach ($dir in $targets) {
      $lnk = $shell.CreateShortcut((Join-Path $dir 'Codex API Switcher.lnk'))
      $lnk.TargetPath = Join-Path $env:SystemRoot 'System32\wscript.exe'
      $lnk.Arguments = '"' + (Join-Path $InstallDir 'launch-hidden.vbs') + '" open'
      $lnk.WorkingDirectory = $InstallDir
      $lnk.IconLocation = "$nodeExe,0"
      $lnk.Description = 'Codex API Switcher'
      $lnk.Save()
    }
  }

  # 7. Codex check (informational).
  $codexBin = Join-Path $env:LOCALAPPDATA 'OpenAI\Codex\bin'
  if (-not (Test-Path $codexBin)) { Write-Warning 'Codex desktop was not found. Install and open Codex once, or set CODEX_EXE to a codex.exe.' }

  Write-Host ''
  Write-Host "Installed Codex API Switcher to $InstallDir" -ForegroundColor Green
  if (-not $NoLaunch) { Start-Process -WindowStyle Hidden -FilePath (Join-Path $env:SystemRoot 'System32\wscript.exe') -ArgumentList ('"' + (Join-Path $InstallDir 'launch-hidden.vbs') + '"'), 'open' }
}
finally { if ([IO.Path]::GetDirectoryName([IO.Path]::GetFullPath($tmp)).TrimEnd('\') -ne [IO.Path]::GetTempPath().TrimEnd('\')) { throw 'Unexpected temporary directory' }; Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue }
