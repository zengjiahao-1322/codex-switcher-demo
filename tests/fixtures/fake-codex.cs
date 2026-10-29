using System;
using System.IO;
using System.Collections.Generic;
using System.Web.Script.Serialization;
public static class FixtureCodex {
  public static void Main(string[] args) {
    Console.InputEncoding=new System.Text.UTF8Encoding(false);Console.OutputEncoding=new System.Text.UTF8Encoding(false);
    if (Array.IndexOf(args, "--version") >= 0) {
      var log=Environment.GetEnvironmentVariable("SWITCHER_FAKE_CODEX_VERSION_LOG");
      if(!String.IsNullOrEmpty(log))File.AppendAllText(log,DateTime.UtcNow.ToString("o")+"\n");
      Console.WriteLine("codex-fixture 0.1.0");return;
    }
    if (!String.IsNullOrEmpty(Environment.GetEnvironmentVariable("SWITCHER_FAKE_CODEX_SCENARIO"))) {
      var start = new System.Diagnostics.ProcessStartInfo(Environment.GetEnvironmentVariable("SWITCHER_FIXTURE_NODE"), "\""+Environment.GetEnvironmentVariable("SWITCHER_FIXTURE_SCRIPT")+"\"");
      start.UseShellExecute=false; start.CreateNoWindow=true;
      start.RedirectStandardInput=true;start.RedirectStandardOutput=true;start.RedirectStandardError=true;
      start.StandardOutputEncoding=new System.Text.UTF8Encoding(false);start.StandardErrorEncoding=new System.Text.UTF8Encoding(false);
      using(var child=System.Diagnostics.Process.Start(start)) {
        var incoming=new System.Threading.Thread(()=>{try{string request;while((request=Console.ReadLine())!=null){child.StandardInput.WriteLine(request);child.StandardInput.Flush();}child.StandardInput.Close();}catch(IOException){}});
        incoming.IsBackground=true;incoming.Start();
        var errors=new System.Threading.Thread(()=>{string error;while((error=child.StandardError.ReadLine())!=null){File.AppendAllText(Environment.GetEnvironmentVariable("SWITCHER_FAKE_CODEX_SCENARIO")+".errors."+System.Diagnostics.Process.GetCurrentProcess().Id,error+"\n");Console.Error.WriteLine(error);}});errors.IsBackground=true;errors.Start();
        string response;while((response=child.StandardOutput.ReadLine())!=null){Console.WriteLine(response);Console.Out.Flush();}
        child.WaitForExit();Environment.Exit(child.ExitCode);
      }
      return;
    }
    var json = new JavaScriptSerializer();
    var values = json.Deserialize<Dictionary<string,object>>(File.ReadAllText(Environment.GetEnvironmentVariable("SWITCHER_FAKE_CODEX_RESPONSES")));
    string line;
    while ((line = Console.ReadLine()) != null) {
      var request = json.Deserialize<Dictionary<string,object>>(line);
      if (!request.ContainsKey("id")) continue;
      object result;
      var response = new Dictionary<string,object> {{"id",request["id"]}};
      if (values.TryGetValue((string)request["method"],out result)) response["result"] = result;
      else response["error"] = new Dictionary<string,object>{{"code",-32601},{"message","Fixture method unavailable"}};
      Console.WriteLine(json.Serialize(response));
    }
  }
}
