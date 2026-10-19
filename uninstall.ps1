# Codex API Switcher - uninstaller. Run from the install folder:
#   powershell -NoProfile -ExecutionPolicy Bypass -File "%LOCALAPPDATA%\CodexApiSwitcher\uninstall.ps1"
# Switches Codex back to its official login (unless -KeepCodexConfig), removes the switcher's provider definition
# from Codex config, the autostart entry, the shortcuts and the install folder. -KeepData keeps your saved configs.
# Keep this file ASCII-only (Windows PowerShell 5.1 reads scripts with the ANSI code page).
param([switch]$KeepData, [switch]$KeepCodexConfig)
$ErrorActionPreference = 'Stop'
$InstallDir = [IO.Path]::GetFullPath($PSScriptRoot)
if (-not (Test-Path -LiteralPath (Join-Path $InstallDir 'main.cjs')) -or -not (Test-Path -LiteralPath (Join-Path $InstallDir 'package.json'))) { throw 'Run uninstall.ps1 from the complete installed app folder.' }
$packageInfo = Get-Content -LiteralPath (Join-Path $InstallDir 'package.json') -Raw | ConvertFrom-Json
if ($packageInfo.name -ne 'codex-api-switcher') { throw 'Unexpected uninstall folder.' }
$node = Join-Path $InstallDir 'runtime\node.exe'
$cli = Join-Path $InstallDir 'cli.cjs'
function Step($msg) { Write-Host "==> $msg" -ForegroundColor Cyan }

$running = Join-Path $InstallDir 'private\running.json'
if (Test-Path $running) { try { $r = Get-Content $running -Raw | ConvertFrom-Json; $serviceProcess = Get-CimInstance Win32_Process -Filter "ProcessId = $($r.pid)"; if ($serviceProcess.ExecutablePath -ne $node -or -not $serviceProcess.CommandLine.Contains((Join-Path $InstallDir 'main.cjs'))) { throw 'Unexpected process' }; Stop-Process -Id $r.pid -Force -ErrorAction Stop; Step 'Stopped the running service' } catch {} }

if ((Test-Path $node) -and (Test-Path $cli)) {
  if (-not $KeepCodexConfig) {
    Step 'Switching Codex back to its official login'
    & $node $cli restore; if ($LASTEXITCODE -ne 0) { throw 'Could not restore the official Codex config; nothing was removed.' }
    Step 'Cleaning the switcher entries from Codex config'
    & $node $cli cleanup; if ($LASTEXITCODE -ne 0) { throw 'Could not clean Codex config; nothing was removed.' }
  } elseif ((& $node $cli status) -eq 'BRIDGED') {
    Write-Warning 'Codex still uses a config from this tool and will stop working once the tool is removed.'
  }
}

Step 'Removing shortcuts'
foreach ($dir in @([Environment]::GetFolderPath('Desktop'), [Environment]::GetFolderPath('Programs'))) {
  Remove-Item (Join-Path $dir 'Codex API Switcher.lnk') -Force -ErrorAction SilentlyContinue
}
# Autostart shortcut (normally removed by "cli.cjs cleanup"): any Startup shortcut pointing at this install's launcher.
$startup = [Environment]::GetFolderPath('Startup'); $shell = New-Object -ComObject WScript.Shell
Get-ChildItem $startup -Filter '*.lnk' -ErrorAction SilentlyContinue | ForEach-Object { if ($shell.CreateShortcut($_.FullName).Arguments -like "*$InstallDir*launch-hidden.vbs*") { Remove-Item $_.FullName -Force } }

Step "Removing $InstallDir"
Get-ChildItem -LiteralPath $InstallDir -Force | Where-Object { -not ($KeepData -and $_.Name -eq 'private') } | ForEach-Object { $targetPath = [IO.Path]::GetFullPath($_.FullName); if ([IO.Path]::GetDirectoryName($targetPath) -ne $InstallDir) { throw 'Uninstall target outside app folder' }; Remove-Item -LiteralPath $targetPath -Recurse -Force -ErrorAction SilentlyContinue }
if (-not $KeepData) { Remove-Item -LiteralPath $InstallDir -Recurse -Force -ErrorAction SilentlyContinue }
Write-Host 'Codex API Switcher has been uninstalled.' -ForegroundColor Green
if ($KeepData) { Write-Host "Saved configs were kept in $(Join-Path $InstallDir 'private')." }
