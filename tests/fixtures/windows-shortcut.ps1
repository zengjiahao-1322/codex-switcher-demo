param([string]$Action, [string]$Link, [string]$Executable, [int]$TargetProcessId)
$ErrorActionPreference = 'Stop'
Add-Type @'
using System;
using System.Text;
using System.Runtime.InteropServices;
using System.Collections.Generic;
public static class ShortcutProbe {
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
  public struct Launch {
    public int size; public uint mask; public IntPtr window;
    public string verb, file, parameters, directory; public int show;
    public IntPtr instance, idList; public string className;
    public IntPtr classKey; public uint hotKey; public IntPtr icon, process;
  }
  [DllImport("shell32.dll",CharSet=CharSet.Unicode,SetLastError=true)]
  public static extern bool ShellExecuteEx(ref Launch value);
  [DllImport("kernel32.dll")] public static extern bool CloseHandle(IntPtr value);
  public delegate bool Callback(IntPtr window,IntPtr parameter);
  [DllImport("user32.dll")] static extern bool EnumWindows(Callback callback,IntPtr parameter);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr window);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr window,out uint pid);
  public static uint[] VisibleOwners() {
    var result=new List<uint>();
    EnumWindows((window,parameter)=>{uint pid;GetWindowThreadProcessId(window,out pid);
      if(IsWindowVisible(window))result.Add(pid);return true;},IntPtr.Zero);
    return result.ToArray();
  }
}
'@
if ($Action -eq 'launch') {
  $shortcut = (New-Object -ComObject WScript.Shell).CreateShortcut($Link)
  $shortcut.TargetPath = $Executable
  $shortcut.Arguments = '--no-open'
  $shortcut.WorkingDirectory = Split-Path -Parent $Executable
  $shortcut.Save()
  $launch = New-Object ShortcutProbe+Launch
  $launch.size = [Runtime.InteropServices.Marshal]::SizeOf($launch)
  $launch.mask = 0x540
  $launch.file = $Link
  $launch.show = 1
  if (-not [ShortcutProbe]::ShellExecuteEx([ref]$launch)) {
    throw (New-Object ComponentModel.Win32Exception([Runtime.InteropServices.Marshal]::GetLastWin32Error()))
  }
  if ($launch.process -ne [IntPtr]::Zero) { [void][ShortcutProbe]::CloseHandle($launch.process) }
} else {
  $processes = @(Get-CimInstance Win32_Process)
  $owned = New-Object 'System.Collections.Generic.HashSet[uint32]'
  [void]$owned.Add([uint32]$TargetProcessId)
  do {
    $changed = $false
    foreach ($item in $processes) {
      if ($owned.Contains([uint32]$item.ParentProcessId) -and $owned.Add([uint32]$item.ProcessId)) { $changed = $true }
    }
  } while ($changed)
  $visible = @([ShortcutProbe]::VisibleOwners() | Where-Object { $owned.Contains($_) })
  $hosts = @($processes | Where-Object { $owned.Contains([uint32]$_.ProcessId) -and $_.Name -match '^(conhost|OpenConsole|WindowsTerminal)\.exe$' } | Select-Object -ExpandProperty ProcessId)
  @{ visibleWindows = $visible; consoleHosts = $hosts } | ConvertTo-Json -Compress
}
