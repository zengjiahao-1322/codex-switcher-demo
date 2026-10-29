# Shared by installation and the packaged application's first launch. ASCII for Windows PowerShell 5.1.
param(
  [Parameter(Mandatory=$true)][string]$InstallDir,
  [string]$DiscoveryDir = (Join-Path $env:USERPROFILE '.codex-api-switcher'),
  [switch]$RegisterOnly,
  [switch]$RemoveRegistration
)
$ErrorActionPreference = 'Stop'
$InstallDir = [IO.Path]::GetFullPath($InstallDir)
$registry = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\CodexSwitcher'
if ($env:SWITCHER_TEST_SHELL_ROOT) { $registry = Join-Path $env:SWITCHER_TEST_SHELL_ROOT 'registration.json' }
if ($RemoveRegistration) { Remove-Item -LiteralPath $registry -Recurse -Force -ErrorAction SilentlyContinue; return }
$package = Get-Content -LiteralPath (Join-Path $InstallDir 'package.json') -Raw | ConvertFrom-Json
$native = Join-Path $InstallDir 'codex-switcher.exe'
$icon = if (Test-Path -LiteralPath $native) { $native } else { Join-Path $InstallDir 'runtime\node.exe' }
$sequence = (Get-Content -LiteralPath (Join-Path $InstallDir 'src\platform\release-info.json') -Raw | ConvertFrom-Json).sequence
$markerFile = Join-Path $DiscoveryDir 'shortcut.json'
$marker = if (Test-Path -LiteralPath $markerFile) { Get-Content -LiteralPath $markerFile -Raw | ConvertFrom-Json } else { $null }
if ($marker -and [long]$marker.sequence -gt [long]$sequence) { Write-Output '{"shortcutChanged":false}'; return }
$desktop = [Environment]::GetFolderPath('Desktop')
if ($env:SWITCHER_TEST_SHELL_ROOT) { $desktop = Join-Path $env:SWITCHER_TEST_SHELL_ROOT 'Desktop'; New-Item -ItemType Directory -Path $desktop -Force | Out-Null }
$linkFile = Join-Path $desktop 'Codex API Switcher.lnk'
$shell = New-Object -ComObject WScript.Shell
$exists = Test-Path -LiteralPath $linkFile
$changed = $false
if (-not $RegisterOnly -and ($exists -or -not $marker.created)) {
  $link = $shell.CreateShortcut($linkFile)
  $oldSequence = 0
  if ($exists -and $link.WorkingDirectory) {
    $oldInfo = Join-Path $link.WorkingDirectory 'src\platform\release-info.json'
    if (Test-Path -LiteralPath $oldInfo) { $oldSequence = [long](Get-Content -LiteralPath $oldInfo -Raw | ConvertFrom-Json).sequence }
  }
  if (-not $exists -or [long]$sequence -gt $oldSequence -or $link.WorkingDirectory -eq $InstallDir) {
    $link.TargetPath = Join-Path $env:SystemRoot 'System32\wscript.exe'
    $link.Arguments = '"' + (Join-Path $InstallDir 'launch-hidden.vbs') + '" open'
    $link.WorkingDirectory = $InstallDir
    $link.IconLocation = $icon + ',0'
    $link.Description = 'Codex API Switcher'
    $link.Save()
    $changed = $true
  } elseif ($oldSequence -gt [long]$sequence) { Write-Output '{"shortcutChanged":false}'; return }
}
$values = @{
  DisplayName = 'Codex API Switcher'
  DisplayVersion = $package.version
  Publisher = 'Codex Switcher'
  InstallLocation = $InstallDir
  UninstallString = 'powershell -NoProfile -ExecutionPolicy Bypass -File "' + (Join-Path $InstallDir 'uninstall.ps1') + '" -KeepData'
  DisplayIcon = $icon + ',0'
}
if ($env:SWITCHER_TEST_SHELL_ROOT) {
  [IO.File]::WriteAllText($registry, ($values | ConvertTo-Json), (New-Object Text.UTF8Encoding($false)))
} else {
  New-Item -Path $registry -Force | Out-Null
  foreach ($name in $values.Keys) { New-ItemProperty -Path $registry -Name $name -Value $values[$name] -PropertyType String -Force | Out-Null }
  foreach ($name in @('NoModify', 'NoRepair')) { New-ItemProperty -Path $registry -Name $name -Value 1 -PropertyType DWord -Force | Out-Null }
}
if (-not $RegisterOnly) {
  New-Item -ItemType Directory -Path $DiscoveryDir -Force | Out-Null
  $markerText = @{created=$true;target=$InstallDir;sequence=$sequence} | ConvertTo-Json -Compress
  [IO.File]::WriteAllText($markerFile, $markerText, (New-Object Text.UTF8Encoding($false)))
}
Write-Output ([pscustomobject]@{ shortcutChanged=$changed } | ConvertTo-Json -Compress)
