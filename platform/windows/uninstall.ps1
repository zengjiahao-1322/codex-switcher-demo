# Codex API Switcher - uninstaller. Run from the install folder:
#   powershell -NoProfile -ExecutionPolicy Bypass -File "%LOCALAPPDATA%\CodexApiSwitcher\platform\windows\uninstall.ps1"
# Switches Codex back to its official login (unless -KeepCodexConfig), removes the switcher's provider definition
# from Codex config, the autostart entry, the shortcuts and the install folder. -KeepData keeps your saved configs.
# Keep this file ASCII-only (Windows PowerShell 5.1 reads scripts with the ANSI code page).
param([switch]$KeepData, [switch]$KeepCodexConfig)
$ErrorActionPreference = 'Stop'
[Environment]::CurrentDirectory = [IO.Path]::GetTempPath()
$InstallDir = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
if (-not (Test-Path -LiteralPath (Join-Path $InstallDir 'main.cjs')) -or -not (Test-Path -LiteralPath (Join-Path $InstallDir 'package.json'))) { throw 'Run uninstall.ps1 from the complete installed app folder.' }
$packageInfo = Get-Content -LiteralPath (Join-Path $InstallDir 'package.json') -Raw | ConvertFrom-Json
if ($packageInfo.name -ne 'codex-api-switcher') { throw 'Unexpected uninstall folder.' }
$node = Join-Path $InstallDir 'runtime\node.exe'
$cli = Join-Path $InstallDir 'scripts/cli.cjs'
$native = Join-Path $InstallDir 'codex-switcher.exe'
$cliExe = if (Test-Path -LiteralPath $native) { $native } else { $node }
[string[]]$cliPrefix = if (Test-Path -LiteralPath $native) { @('--cli') } else { @($cli) }
function Step($msg) { Write-Host "==> $msg" -ForegroundColor Cyan }
if ($env:BRIDGE_UNINSTALL_READY) { [IO.File]::WriteAllText($env:BRIDGE_UNINSTALL_READY, 'ready') }
if ($env:BRIDGE_UNINSTALL_PID) {
  while (Get-Process -Id ([int]$env:BRIDGE_UNINSTALL_PID) -ErrorAction SilentlyContinue) { Start-Sleep -Milliseconds 200 }
}

$customData = $env:BRIDGE_HOME -and [IO.Path]::GetFullPath($env:BRIDGE_HOME).TrimEnd('\') -ine [IO.Path]::GetFullPath((Join-Path $InstallDir 'private')).TrimEnd('\')
$DataDir = if ($customData) { [IO.Path]::GetFullPath($env:BRIDGE_HOME) } else { Join-Path $env:LOCALAPPDATA 'CodexSwitcher' }
$running = Join-Path $DataDir 'running.json'
if (Test-Path -LiteralPath $running) {
  $record = Get-Content -LiteralPath $running -Raw | ConvertFrom-Json
  $servicePid = [int]$record.pid
  $serviceProcess = Get-CimInstance Win32_Process -Filter "ProcessId = $servicePid"
  if ($serviceProcess) {
    $ownsNode = $serviceProcess.ExecutablePath -eq $node -and $serviceProcess.CommandLine.Contains((Join-Path $InstallDir 'main.cjs'))
    $ownsNative = $serviceProcess.ExecutablePath -eq $native
    if ($ownsNode -or $ownsNative) {
      Stop-Process -Id $servicePid -Force -ErrorAction Stop
      Step 'Stopped the running service'
    }
  }
}

if ((Test-Path $cliExe) -and ((Test-Path $native) -or (Test-Path $cli))) {
  if (-not $KeepCodexConfig -and (& $cliExe @cliPrefix status --no-open) -eq 'BRIDGED') {
    Step 'Switching Codex back to its official login'
    & $cliExe @cliPrefix restore --no-open; if ($LASTEXITCODE -ne 0) { throw 'Could not restore the official Codex config; nothing was removed.' }
    Step 'Cleaning the switcher entries from Codex config'
    & $cliExe @cliPrefix cleanup --no-open; if ($LASTEXITCODE -ne 0) { throw 'Could not clean Codex config; nothing was removed.' }
  } elseif ((& $cliExe @cliPrefix status --no-open) -eq 'BRIDGED') {
    Write-Warning 'Codex still uses a config from this tool and will stop working once the tool is removed.'
  }
}

Step 'Removing shortcuts'
foreach ($dir in @([Environment]::GetFolderPath('Desktop'), [Environment]::GetFolderPath('Programs'))) {
  Remove-Item (Join-Path $dir 'Codex API Switcher.lnk') -Force -ErrorAction SilentlyContinue
}
& (Join-Path $InstallDir 'platform\windows\desktop-integration.ps1') -InstallDir $InstallDir -RemoveRegistration
# Autostart shortcut (normally removed by "cli.cjs cleanup"): any Startup shortcut pointing at this install's launcher.
$startup = [Environment]::GetFolderPath('Startup'); $shell = New-Object -ComObject WScript.Shell
Get-ChildItem $startup -Filter '*.lnk' -ErrorAction SilentlyContinue | ForEach-Object { if ($shell.CreateShortcut($_.FullName).Arguments -like "*$InstallDir*launch-hidden.vbs*") { Remove-Item $_.FullName -Force } }

Step "Removing $InstallDir"
Get-ChildItem -LiteralPath $InstallDir -Force | Where-Object { -not ($KeepData -and $_.Name -eq 'private') } | ForEach-Object { $targetPath = [IO.Path]::GetFullPath($_.FullName); if ([IO.Path]::GetDirectoryName($targetPath) -ne $InstallDir) { throw 'Uninstall target outside app folder' }; Remove-Item -LiteralPath $targetPath -Recurse -Force -ErrorAction SilentlyContinue }
if (-not $KeepData) { Remove-Item -LiteralPath $InstallDir -Recurse -Force -ErrorAction SilentlyContinue }
if (-not $KeepData -and (Test-Path -LiteralPath $DataDir)) {
  $resolvedData = [IO.Path]::GetFullPath($DataDir).TrimEnd('\')
  if ($resolvedData -eq [IO.Path]::GetPathRoot($resolvedData).TrimEnd('\') -or $resolvedData -eq [IO.Path]::GetFullPath($env:USERPROFILE).TrimEnd('\')) { throw 'Refusing to remove a user or drive root.' }
  Remove-Item -LiteralPath $resolvedData -Recurse -Force
}
Write-Host 'Codex API Switcher has been uninstalled.' -ForegroundColor Green
if ($KeepData) { Write-Host "Saved configs were kept in $DataDir." }
