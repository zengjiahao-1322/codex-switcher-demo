# Writes platform/windows/app.ico into a Windows executable. The GNU toolchain has no resource compiler here.
param(
  [Parameter(Mandatory = $true)][string]$Exe,
  [Parameter(Mandatory = $true)][string]$Icon
)
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class PeResource {
  [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
  public static extern IntPtr BeginUpdateResource(string file, bool deleteExisting);
  [DllImport("kernel32.dll", SetLastError = true)]
  public static extern bool UpdateResource(IntPtr handle, IntPtr type, IntPtr name, ushort language, byte[] data, uint size);
  [DllImport("kernel32.dll", SetLastError = true)]
  public static extern bool EndUpdateResource(IntPtr handle, bool discard);
}
'@
$bytes = [IO.File]::ReadAllBytes($Icon)
$count = [BitConverter]::ToUInt16($bytes, 4)
$handle = [PeResource]::BeginUpdateResource($Exe, $false)
if ($handle -eq [IntPtr]::Zero) { throw "BeginUpdateResource failed: $([Runtime.InteropServices.Marshal]::GetLastWin32Error())" }
# RT_GROUP_ICON repeats the ICONDIR entries with a 2-byte resource id in place of the 4-byte file offset.
$group = New-Object IO.MemoryStream
$group.Write($bytes, 0, 6)
for ($i = 0; $i -lt $count; $i++) {
  $entry = 6 + 16 * $i
  $size = [BitConverter]::ToInt32($bytes, $entry + 8)
  $offset = [BitConverter]::ToInt32($bytes, $entry + 12)
  $image = New-Object byte[] $size
  [Array]::Copy($bytes, $offset, $image, 0, $size)
  $id = $i + 1
  if (-not [PeResource]::UpdateResource($handle, [IntPtr]3, [IntPtr]$id, 0, $image, [uint32]$size)) { throw "UpdateResource failed: $([Runtime.InteropServices.Marshal]::GetLastWin32Error())" }
  $group.Write($bytes, $entry, 12)
  $group.Write([BitConverter]::GetBytes([uint16]$id), 0, 2)
}
$data = $group.ToArray()
if (-not [PeResource]::UpdateResource($handle, [IntPtr]14, [IntPtr]1, 0, $data, [uint32]$data.Length)) { throw "UpdateResource failed: $([Runtime.InteropServices.Marshal]::GetLastWin32Error())" }
if (-not [PeResource]::EndUpdateResource($handle, $false)) { throw "EndUpdateResource failed: $([Runtime.InteropServices.Marshal]::GetLastWin32Error())" }
