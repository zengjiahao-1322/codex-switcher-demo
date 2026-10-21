# Compatibility entry for local scripts and the existing online installer URL.
param(
  [string]$InstallDir,
  [string]$Repo,
  [string]$Ref,
  [switch]$NoShortcuts,
  [switch]$NoLaunch
)
$ErrorActionPreference = 'Stop'
$localScript = if ($PSScriptRoot) { Join-Path $PSScriptRoot 'platform\windows\install.ps1' } else { $null }
if ($localScript -and (Test-Path -LiteralPath $localScript)) {
  & $localScript @PSBoundParameters
} else {
  $sourceRepo = if ($Repo) { $Repo } else { 'zengjiahao-1322/codex-switcher-demo' }
  $sourceRef = if ($Ref) { $Ref } else { 'main' }
  $url = "https://raw.githubusercontent.com/$sourceRepo/$sourceRef/platform/windows/install.ps1"
  $source = (Invoke-WebRequest -UseBasicParsing -Uri $url).Content
  & ([scriptblock]::Create($source)) @PSBoundParameters
}
