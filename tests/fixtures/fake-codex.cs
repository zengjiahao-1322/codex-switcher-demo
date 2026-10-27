using System;
using System.IO;
using System.Collections.Generic;
using System.Web.Script.Serialization;
public static class FixtureCodex {
  public static void Main(string[] args) {
    if (Array.IndexOf(args, "--version") >= 0) {Console.WriteLine("codex-fixture 0.1.0");return;}
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
