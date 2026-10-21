# Compatibility entry for existing uninstall commands.
param([switch]$KeepData, [switch]$KeepCodexConfig)
$ErrorActionPreference = 'Stop'
& (Join-Path $PSScriptRoot 'platform\windows\uninstall.ps1') @PSBoundParameters
