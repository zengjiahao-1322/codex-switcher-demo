$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
public class SwitcherProcessContext {
 [DllImport("kernel32.dll",SetLastError=true)] static extern IntPtr OpenProcess(uint access,bool inherit,int pid);
 [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool ReadProcessMemory(IntPtr h,IntPtr p,byte[] b,int n,out IntPtr read);
 [DllImport("kernel32.dll")] static extern bool IsWow64Process(IntPtr h,out bool wow);
 [DllImport("ntdll.dll")] static extern int NtQueryInformationProcess(IntPtr h,int kind,IntPtr[] info,int size,out int used);
 [DllImport("shell32.dll",CharSet=CharSet.Unicode)] static extern IntPtr CommandLineToArgvW(string command,out int count);
 [DllImport("kernel32.dll")] static extern IntPtr LocalFree(IntPtr p);
 static byte[] Read(IntPtr h,long at,int count){var b=new byte[count];IntPtr used;ReadProcessMemory(h,new IntPtr(at),b,count,out used);if(used.ToInt64()==0)throw new IOException("process_memory_unavailable");Array.Resize(ref b,(int)used);return b;}
 static long Pointer(IntPtr h,long at){return BitConverter.ToInt64(Read(h,at,8),0);}
 static string Unicode(IntPtr h,long at){var b=Read(h,at,16);int n=BitConverter.ToUInt16(b,0);return n==0?"":Encoding.Unicode.GetString(Read(h,BitConverter.ToInt64(b,8),n));}
 public static Dictionary<string,object> ReadContext(int pid){
  var result=new Dictionary<string,object>();IntPtr h=OpenProcess(0x410,false,pid);
  if(h==IntPtr.Zero){result["error"]="process_access_denied_or_exited";return result;}
  try{
   bool wow;IsWow64Process(h,out wow);if(wow||IntPtr.Size!=8)throw new IOException("unsupported_process_architecture");
   var info=new IntPtr[6];int used;if(NtQueryInformationProcess(h,0,info,48,out used)!=0)throw new IOException("process_query_failed");
   long parameters=Pointer(h,info[1].ToInt64()+0x20),envAt=Pointer(h,parameters+0x80);
   string cwd=Unicode(h,parameters+0x38),command=Unicode(h,parameters+0x70);var bytes=new List<byte>();bool complete=false;
   for(int offset=0;offset<262144&&!complete;){var b=Read(h,envAt+offset,4096);bytes.AddRange(b);offset+=b.Length;for(int i=Math.Max(0,bytes.Count-b.Length-2);i+3<bytes.Count;i+=2)if(bytes[i]==0&&bytes[i+1]==0&&bytes[i+2]==0&&bytes[i+3]==0){complete=true;break;}}
   if(!complete)throw new IOException("environment_incomplete");
   var env=new Dictionary<string,string>(StringComparer.OrdinalIgnoreCase);
   foreach(string pair in Encoding.Unicode.GetString(bytes.ToArray()).Split('\0')){int eq=pair.IndexOf('=');if(eq>0){string key=pair.Substring(0,eq);if(key=="CODEX_HOME"||key=="USERPROFILE"||key=="HOME"||key=="VSCODE_IPC_HOOK_CLI")env[key]=pair.Substring(eq+1);}}
   string home=null,source="default";if(env.ContainsKey("CODEX_HOME")&&!String.IsNullOrWhiteSpace(env["CODEX_HOME"])){home=env["CODEX_HOME"];source="CODEX_HOME";}else if(env.ContainsKey("USERPROFILE"))home=Path.Combine(env["USERPROFILE"],".codex");
   if(home!=null){if(!Path.IsPathRooted(home))home=Path.Combine(cwd,home);home=Path.GetFullPath(home);}
   result["home"]=home;result["homeSource"]=source;result["cwd"]=cwd;result["windowKey"]=env.ContainsKey("VSCODE_IPC_HOOK_CLI")?env["VSCODE_IPC_HOOK_CLI"]:null;
   var overrides=new Dictionary<string,string>();int count;IntPtr args=CommandLineToArgvW(command,out count);
   try{for(int i=1;i<count;i++){string arg=Marshal.PtrToStringUni(Marshal.ReadIntPtr(args,i*IntPtr.Size));if((arg=="--profile"||arg=="-p")&&i+1<count)result["profile"]=Marshal.PtrToStringUni(Marshal.ReadIntPtr(args,++i*IntPtr.Size));else if(arg.StartsWith("--profile="))result["profile"]=arg.Substring(10);else if((arg=="--model"||arg=="-m")&&i+1<count)overrides["model"]=Marshal.PtrToStringUni(Marshal.ReadIntPtr(args,++i*IntPtr.Size));else if(arg.StartsWith("--model="))overrides["model"]=arg.Substring(8);else if(((arg=="--config"||arg=="-c")&&i+1<count)||arg.StartsWith("--config=")){string value=arg.StartsWith("--config=")?arg.Substring(9):Marshal.PtrToStringUni(Marshal.ReadIntPtr(args,++i*IntPtr.Size));int eq=value.IndexOf('=');if(eq>0){string key=value.Substring(0,eq);if(key=="model"||key=="model_provider"||key=="model_catalog_json")overrides[key]=value.Substring(eq+1);}}}}finally{if(args!=IntPtr.Zero)LocalFree(args);}
   result["overrides"]=overrides;result["ok"]=home!=null;
  }catch(Exception e){result["error"]=e.Message;}finally{CloseHandle(h);}return result;
 }
}
'@
$all = @(Get-CimInstance Win32_Process | Select-Object Name,ProcessId,ParentProcessId,ExecutablePath,CreationDate)
$targets = @($all | Where-Object {
 $candidate = $_
 # 空闲桌面也要参与切换；同路径的渲染子进程由主进程统一关闭。
 $desktopShell = ($candidate.Name -ieq 'ChatGPT.exe' -or $candidate.Name -ieq 'Codex.exe') -and
   $candidate.ExecutablePath -match 'OpenAI[.\\/]Codex[^\\/]*[\\/]app[\\/]'
 $nativeBackend = $candidate.Name -ieq 'codex.exe' -and -not $desktopShell
 $sameExecutableParent = @($all | Where-Object {
   $_.ProcessId -eq $candidate.ParentProcessId -and $_.ExecutablePath -eq $candidate.ExecutablePath
 }).Count -gt 0
 $nativeBackend -or ($desktopShell -and -not $sameExecutableParent)
} | ForEach-Object {
 $context = [SwitcherProcessContext]::ReadContext([int]$_.ProcessId)
 @{ pid=[int]$_.ProcessId; parentPid=[int]$_.ParentProcessId; exe=$_.ExecutablePath; startedAt=$_.CreationDate.ToUniversalTime().ToString('o'); context=$context }
})
@{ processes=$targets; ancestry=@($all | ForEach-Object { @{pid=[int]$_.ProcessId; parentPid=[int]$_.ParentProcessId; name=$_.Name; exe=$_.ExecutablePath} }) } | ConvertTo-Json -Depth 8 -Compress
