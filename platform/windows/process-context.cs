using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.RegularExpressions;
using System.Web.Script.Serialization;

// Windows 进程扫描助手：用 Toolhelp32 和 QueryFullProcessImageNameW
// 代替每次扫描都启动 PowerShell/WMI。目标字段与旧扫描器保持一致，
// 只读取进程归属所需的环境变量，不把完整环境返回给 Node。
public static class SwitcherProcessContext
{
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr OpenProcess(uint access, bool inherit, int pid);

    [DllImport("kernel32.dll")]
    private static extern bool CloseHandle(IntPtr handle);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool ReadProcessMemory(IntPtr handle, IntPtr address, byte[] buffer, int count, out IntPtr read);

    [DllImport("kernel32.dll")]
    private static extern bool IsWow64Process(IntPtr handle, out bool wow);

    [DllImport("ntdll.dll")]
    private static extern int NtQueryInformationProcess(IntPtr handle, int kind, IntPtr[] info, int size, out int used);

    [DllImport("shell32.dll", CharSet = CharSet.Unicode)]
    private static extern IntPtr CommandLineToArgvW(string command, out int count);

    [DllImport("kernel32.dll")]
    private static extern IntPtr LocalFree(IntPtr pointer);

    private static byte[] Read(IntPtr handle, long address, int count)
    {
        var buffer = new byte[count];
        IntPtr read;
        // 跨到不可读页时 Windows 允许返回部分数据；保留实际读到的字节。
        ReadProcessMemory(handle, new IntPtr(address), buffer, count, out read);
        if (read.ToInt64() == 0)
            throw new InvalidOperationException("process_memory_unavailable");
        Array.Resize(ref buffer, (int)read.ToInt64());
        return buffer;
    }

    private static long Pointer(IntPtr handle, long address)
    {
        return BitConverter.ToInt64(Read(handle, address, 8), 0);
    }

    private static string Unicode(IntPtr handle, long address)
    {
        var descriptor = Read(handle, address, 16);
        var length = BitConverter.ToUInt16(descriptor, 0);
        return length == 0 ? "" : Encoding.Unicode.GetString(Read(handle, BitConverter.ToInt64(descriptor, 8), length));
    }

    // 读取单个目标进程的 CODEX_HOME、工作目录、窗口标识和启动覆盖项。
    public static Dictionary<string, object> ReadContext(int pid)
    {
        var result = new Dictionary<string, object>();
        IntPtr handle = OpenProcess(0x410, false, pid);
        if (handle == IntPtr.Zero)
        {
            result["error"] = "process_access_denied_or_exited";
            return result;
        }
        try
        {
            bool wow;
            if (!IsWow64Process(handle, out wow) || wow || IntPtr.Size != 8)
                throw new InvalidOperationException("unsupported_process_architecture");
            var info = new IntPtr[6];
            int used;
            if (NtQueryInformationProcess(handle, 0, info, 48, out used) != 0)
                throw new InvalidOperationException("process_query_failed");
            var parameters = Pointer(handle, info[1].ToInt64() + 0x20);
            var environment = Pointer(handle, parameters + 0x80);
            var cwd = Unicode(handle, parameters + 0x38);
            var command = Unicode(handle, parameters + 0x70);
            var bytes = new List<byte>();
            var complete = false;
            for (var offset = 0; offset < 262144 && !complete;)
            {
                var chunk = Read(handle, environment + offset, 4096);
                bytes.AddRange(chunk);
                offset += chunk.Length;
                for (var i = Math.Max(0, bytes.Count - chunk.Length - 2); i + 3 < bytes.Count; i += 2)
                    if (bytes[i] == 0 && bytes[i + 1] == 0 && bytes[i + 2] == 0 && bytes[i + 3] == 0)
                    {
                        complete = true;
                        break;
                    }
            }
            if (!complete) throw new InvalidOperationException("environment_incomplete");
            var environmentValues = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
            foreach (var pair in Encoding.Unicode.GetString(bytes.ToArray()).Split('\0'))
            {
                var equals = pair.IndexOf('=');
                if (equals <= 0) continue;
                var key = pair.Substring(0, equals);
                if (key == "CODEX_HOME" || key == "USERPROFILE" || key == "HOME" || key == "VSCODE_IPC_HOOK_CLI")
                    environmentValues[key] = pair.Substring(equals + 1);
            }
            string home = null;
            var homeSource = "default";
            if (environmentValues.ContainsKey("CODEX_HOME") && !String.IsNullOrWhiteSpace(environmentValues["CODEX_HOME"]))
            {
                home = environmentValues["CODEX_HOME"];
                homeSource = "CODEX_HOME";
            }
            else if (environmentValues.ContainsKey("USERPROFILE"))
                home = System.IO.Path.Combine(environmentValues["USERPROFILE"], ".codex");
            if (home != null)
            {
                if (!System.IO.Path.IsPathRooted(home)) home = System.IO.Path.Combine(cwd, home);
                home = System.IO.Path.GetFullPath(home);
            }
            result["home"] = home;
            result["homeSource"] = homeSource;
            result["cwd"] = cwd;
            result["windowKey"] = environmentValues.ContainsKey("VSCODE_IPC_HOOK_CLI") ? environmentValues["VSCODE_IPC_HOOK_CLI"] : null;
            var overrides = new Dictionary<string, string>();
            int argumentCount;
            var arguments = CommandLineToArgvW(command, out argumentCount);
            try
            {
                for (var i = 1; i < argumentCount; i++)
                {
                    var argument = Marshal.PtrToStringUni(Marshal.ReadIntPtr(arguments, i * IntPtr.Size));
                    if ((argument == "--profile" || argument == "-p") && i + 1 < argumentCount)
                        result["profile"] = Marshal.PtrToStringUni(Marshal.ReadIntPtr(arguments, ++i * IntPtr.Size));
                    else if (argument.StartsWith("--profile=")) result["profile"] = argument.Substring(10);
                    else if ((argument == "--model" || argument == "-m") && i + 1 < argumentCount)
                        overrides["model"] = Marshal.PtrToStringUni(Marshal.ReadIntPtr(arguments, ++i * IntPtr.Size));
                    else if (argument.StartsWith("--model=")) overrides["model"] = argument.Substring(8);
                    else if (((argument == "--config" || argument == "-c") && i + 1 < argumentCount) || argument.StartsWith("--config="))
                    {
                        var value = argument.StartsWith("--config=") ? argument.Substring(9) : Marshal.PtrToStringUni(Marshal.ReadIntPtr(arguments, ++i * IntPtr.Size));
                        var equals = value.IndexOf('=');
                        if (equals > 0)
                        {
                            var key = value.Substring(0, equals);
                            if (key == "model" || key == "model_provider" || key == "model_catalog_json")
                                overrides[key] = value.Substring(equals + 1);
                        }
                    }
                }
            }
            finally
            {
                if (arguments != IntPtr.Zero) LocalFree(arguments);
            }
            result["overrides"] = overrides;
            result["ok"] = home != null;
        }
        catch (Exception error)
        {
            result["error"] = error.Message;
        }
        finally
        {
            CloseHandle(handle);
        }
        return result;
    }
}

public class ProcessContextEntry
{
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct ProcessEntry
    {
        public uint size, usage, pid;
        public IntPtr heap;
        public uint module, threads, parent;
        public int priority;
        public uint flags;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)] public string name;
    }

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr CreateToolhelp32Snapshot(uint flags, uint pid);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool Process32FirstW(IntPtr snapshot, ref ProcessEntry entry);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool Process32NextW(IntPtr snapshot, ref ProcessEntry entry);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr OpenProcess(uint access, bool inherit, int pid);

    [DllImport("kernel32.dll")]
    private static extern bool CloseHandle(IntPtr handle);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool QueryFullProcessImageNameW(IntPtr handle, uint flags, StringBuilder path, ref int size);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GetProcessTimes(IntPtr handle, out long created, out long exited, out long kernel, out long user);

    private sealed class Row
    {
        public int pid, parent;
        public string name, exe;
    }

    private static string Image(int pid)
    {
        var handle = OpenProcess(0x1000, false, pid);
        if (handle == IntPtr.Zero) return null;
        try
        {
            var size = 32768;
            var path = new StringBuilder(size);
            return QueryFullProcessImageNameW(handle, 0, path, ref size) ? path.ToString() : null;
        }
        finally { CloseHandle(handle); }
    }

    private static string Started(int pid)
    {
        var handle = OpenProcess(0x1000, false, pid);
        if (handle == IntPtr.Zero) return null;
        try
        {
            long created, exited, kernel, user;
            return GetProcessTimes(handle, out created, out exited, out kernel, out user)
                ? DateTime.FromFileTimeUtc(created).ToString("o")
                : null;
        }
        finally { CloseHandle(handle); }
    }

    public static int Main()
    {
        try
        {
            Console.OutputEncoding = new UTF8Encoding(false);
            var all = new List<Row>();
            var byId = new Dictionary<int, Row>();
            var snapshot = CreateToolhelp32Snapshot(2, 0);
            if (snapshot == new IntPtr(-1)) throw new Win32Exception();
            try
            {
                var entry = new ProcessEntry { size = (uint)Marshal.SizeOf(typeof(ProcessEntry)) };
                var more = Process32FirstW(snapshot, ref entry);
                while (more)
                {
                    var row = new Row { pid = (int)entry.pid, parent = (int)entry.parent, name = entry.name, exe = Image((int)entry.pid) };
                    all.Add(row);
                    byId[row.pid] = row;
                    more = Process32NextW(snapshot, ref entry);
                }
                var error = Marshal.GetLastWin32Error();
                if (error != 18) throw new Win32Exception(error);
            }
            finally { CloseHandle(snapshot); }
            var ancestry = new List<object>();
            var targets = new List<object>();
            foreach (var row in all)
            {
                ancestry.Add(new { pid = row.pid, parentPid = row.parent, name = row.name, exe = row.exe });
                var codex = String.Equals(row.name, "codex.exe", StringComparison.OrdinalIgnoreCase);
                var shell = (codex || String.Equals(row.name, "ChatGPT.exe", StringComparison.OrdinalIgnoreCase)) &&
                    row.exe != null && Regex.IsMatch(row.exe, @"OpenAI[.\\/]Codex[^\\/]*[\\/]app[\\/]", RegexOptions.IgnoreCase);
                Row parent;
                var sameExecutableParent = byId.TryGetValue(row.parent, out parent) && String.Equals(parent.exe, row.exe, StringComparison.OrdinalIgnoreCase);
                if ((codex && !shell) || (shell && !sameExecutableParent))
                    targets.Add(new { pid = row.pid, parentPid = row.parent, exe = row.exe, startedAt = Started(row.pid), context = SwitcherProcessContext.ReadContext(row.pid) });
            }
            Console.WriteLine(new JavaScriptSerializer().Serialize(new { processes = targets, ancestry = ancestry }));
            return 0;
        }
        catch (Exception error)
        {
            Console.Error.WriteLine(error.Message);
            return 1;
        }
    }
}
