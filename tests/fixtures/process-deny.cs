using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.Principal;
using System.Security.AccessControl;
using System.Text;
public class ProcessDeny {
  [DllImport("kernel32.dll",SetLastError=true)] static extern IntPtr OpenProcess(uint access,bool inherit,int pid);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool QueryFullProcessImageName(IntPtr handle,uint flags,StringBuilder name,ref uint size);
  [DllImport("advapi32.dll",SetLastError=true)] static extern bool GetKernelObjectSecurity(IntPtr handle,uint info,byte[] data,uint size,out uint needed);
  [DllImport("advapi32.dll",SetLastError=true)] static extern bool SetKernelObjectSecurity(IntPtr handle,uint info,byte[] data);
  public static void Main(string[] args) {
    string expected=Path.GetFullPath(args[1]);
    if(!expected.StartsWith(Path.GetFullPath(Path.GetTempPath()),StringComparison.OrdinalIgnoreCase)||expected.IndexOf("switcher-blackbox-",StringComparison.OrdinalIgnoreCase)<0)throw new Exception("Only a TEMP blackbox fixture may be protected");
    IntPtr handle=OpenProcess(0x1f0fff,false,Int32.Parse(args[0]));
    if(handle==IntPtr.Zero)throw new System.ComponentModel.Win32Exception();
    byte[] previous=null;
    try {
      var image=new StringBuilder(32768);uint length=(uint)image.Capacity;
      if(!QueryFullProcessImageName(handle,0,image,ref length)||!String.Equals(Path.GetFullPath(image.ToString()),expected,StringComparison.OrdinalIgnoreCase))throw new Exception("Fixture image mismatch");
      uint needed;GetKernelObjectSecurity(handle,4,null,0,out needed);previous=new byte[needed];
      if(!GetKernelObjectSecurity(handle,4,previous,needed,out needed))throw new System.ComponentModel.Win32Exception();
      string user=WindowsIdentity.GetCurrent().User.Value;
      var descriptor=new RawSecurityDescriptor("D:(D;;0x"+args[2]+";;;"+user+")(A;;GA;;;"+user+")");
      byte[] bytes=new byte[descriptor.BinaryLength];descriptor.GetBinaryForm(bytes,0);
      if(!SetKernelObjectSecurity(handle,4,bytes))throw new System.ComponentModel.Win32Exception();
      Console.WriteLine("ready");Console.Out.Flush();Console.ReadLine();
    } finally {
      if(previous!=null&&!SetKernelObjectSecurity(handle,4,previous))throw new System.ComponentModel.Win32Exception();
      CloseHandle(handle);
    }
  }
}
