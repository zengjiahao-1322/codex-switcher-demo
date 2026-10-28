//! Window registration and association use actual process context. Remote
//! commands and their results stay in memory; only public metadata is persisted.
use crate::{
    accounts::read,
    diagnostics::{log, now},
    instance::write_json,
    server::App,
};
use notify::Watcher;
use serde_json::{Value, json};
use std::{
    collections::{HashMap, HashSet},
    fs, io,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tokio::sync::{broadcast, oneshot};
pub fn millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_millis() as u64
}
pub fn text(value: &Value) -> &str {
    value.as_str().unwrap_or("")
}
pub fn uuid() -> io::Result<String> {
    Ok(crate::platform::random_bytes()?[..16]
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect())
}
pub fn same(a: &str, b: &str) -> bool {
    if a.is_empty() || b.is_empty() {
        return false;
    }
    let canonical = |s: &str| {
        let p = fs::canonicalize(s).unwrap_or(PathBuf::from(s));
        let value = crate::platform::display_path(&p)
            .trim_end_matches(['\\', '/'])
            .to_owned();
        if cfg!(windows) {
            value.to_lowercase()
        } else {
            value
        }
    };
    canonical(a) == canonical(b)
}
pub struct Pending {
    pub command: Value,
    pub sender: oneshot::Sender<Result<Value, String>>,
}
#[derive(Default)]
pub struct Runtime {
    pub pending: Mutex<HashMap<String, Pending>>,
    pub reloads: Mutex<HashMap<String, Value>>,
    pub syncs: Mutex<HashSet<String>>,
    write: Mutex<()>,
    connection: Mutex<HashMap<String, (String, Instant, Value)>>,
    states: Mutex<HashMap<String, Value>>,
    pub remote_states: Mutex<HashMap<String, Value>>,
    watching: Mutex<Option<Watch>>,
}
struct Watch {
    _native: notify::RecommendedWatcher,
    tx: broadcast::Sender<Result<(), String>>,
    users: usize,
}
struct Lease {
    app: Arc<App>,
    file: PathBuf,
    until: u64,
}
impl Drop for Lease {
    fn drop(&mut self) {
        let _guard = self.app.editors.write.lock().unwrap();
        let result = (|| -> io::Result<()> {
            let mut row = read(&self.file, Value::Null)?;
            if row["waitUntil"].as_u64() == Some(self.until) {
                row.as_object_mut().unwrap().remove("waitUntil");
                write_json(&self.file, &row)?;
            }
            Ok(())
        })();
        if let Err(e) = result {
            eprintln!("Heartbeat lease cleanup failed: {e}");
        }
        let mut watch = self.app.editors.watching.lock().unwrap();
        if let Some(w) = watch.as_mut() {
            w.users -= 1;
            if w.users == 0 {
                *watch = None;
            }
        }
    }
}
pub fn records(bridge: &Path) -> io::Result<Vec<Value>> {
    let entries = match fs::read_dir(bridge.join("clients")) {
        Ok(v) => v,
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(vec![]),
        Err(e) => return Err(e),
    };
    let mut rows = Vec::new();
    for entry in entries {
        let file = entry?.path();
        if file.extension().and_then(|s| s.to_str()) != Some("json") {
            continue;
        }
        let row = read(&file, Value::Null)?;
        let at = millis();
        if row["seenAt"]
            .as_u64()
            .is_some_and(|v| at.saturating_sub(v) < 15000)
            || row["waitUntil"].as_u64().is_some_and(|v| v > at)
        {
            rows.push(row);
        }
    }
    Ok(rows)
}
fn desktop(exe: &str) -> bool {
    regex::Regex::new(r"(?i)([\\/]OpenAI\.Codex_[^\\/]+[\\/]app[\\/](Codex|ChatGPT)\.exe$|[\\/]Codex\.app[\\/]Contents[\\/]MacOS[\\/](Codex|ChatGPT)$)").unwrap().is_match(exe)
}
fn editor(name: &str) -> bool {
    regex::Regex::new(r"(?i)^(Code|Code - Insiders|Cursor|Windsurf)(\.exe| Helper( \(Plugin\))?)?$")
        .unwrap()
        .is_match(name)
}
fn layers(home: &str, cwd: &str, profile: &Value, overrides: &Value) -> Vec<Value> {
    fn add(out: &mut Vec<Value>, file: PathBuf, source: &str) {
        if !file.is_file()
            || out
                .iter()
                .any(|v| same(text(&v["file"]), &crate::platform::display_path(&file)))
        {
            return;
        }
        let record = match fs::read_to_string(&file)
            .ok()
            .and_then(|s| toml::from_str::<toml::Value>(&s).ok())
            .and_then(|v| serde_json::to_value(v).ok())
        {
            Some(c) => json!({"file":file,"source":source,"values":select(&c)}),
            None => json!({"file":file,"source":source,"error":"配置无法解析"}),
        };
        out.push(record);
    }
    fn select(value: &Value) -> Value {
        let mut out = json!({});
        for key in ["model", "model_provider", "model_catalog_json"] {
            if let Some(v) = value.get(key) {
                out[key] = v.clone();
            }
        }
        out
    }
    let mut out = vec![];
    if !home.is_empty() {
        let file = Path::new(home).join("config.toml");
        add(&mut out, file.clone(), "用户配置");
        if let Ok(s) = fs::read_to_string(file)
            && let Ok(c) = toml::from_str::<toml::Value>(&s)
            && let Some(v) = c.get("profiles").and_then(|p| p.get(text(profile)))
        {
            out.push(json!({"file":Path::new(home).join("config.toml"),"source":"启动配置档","values":select(&serde_json::to_value(v).unwrap())}));
        }
    }
    if !cwd.is_empty() {
        let mut dirs = Path::new(cwd).ancestors().take(30).collect::<Vec<_>>();
        dirs.reverse();
        for dir in dirs {
            add(
                &mut out,
                dir.join(".codex/config.toml"),
                "项目配置（是否加载取决于信任与客户端）",
            );
        }
    }
    if overrides.as_object().is_some_and(|o| !o.is_empty()) {
        out.push(json!({"source":"启动参数","values":overrides}));
    }
    out
}
pub fn snapshot(home: &Path, bridge: &Path, inventory: &Value) -> io::Result<Value> {
    let all = inventory["ancestry"]
        .as_array()
        .cloned()
        .unwrap_or_default();
    let windows = records(bridge)?
        .into_iter()
        .filter(|w| w["remote"].is_string() || all.iter().any(|p| p["pid"] == w["pid"]))
        .collect::<Vec<_>>();
    let effect = read(&bridge.join("effect.json"), Value::Null)?;
    let mut clients = vec![];
    let tool_pattern = regex::Regex::new(
        r"(?i)codex-bridge-validate-|[\\/]accounts[\\/](login|[a-f0-9]{20})([\\/]|$)",
    )
    .unwrap();
    let auxiliary_pattern = regex::Regex::new(r"(?i)^node_repl(\.exe)?$").unwrap();
    for p in inventory["processes"].as_array().into_iter().flatten() {
        let mut ancestors = vec![];
        let mut id = p["parentPid"].as_u64();
        let mut seen = HashSet::new();
        while let Some(pid) = id {
            if !seen.insert(pid) {
                break;
            }
            let Some(parent) = all.iter().find(|a| a["pid"].as_u64() == Some(pid)) else {
                break;
            };
            ancestors.push(parent);
            id = parent["parentPid"].as_u64();
        }
        let context = &p["context"];
        let exe = text(&p["exe"]);
        let cwd = text(&context["cwd"]);
        let tool = tool_pattern.is_match(cwd);
        if tool {
            continue;
        }
        let auxiliary = ancestors.iter().any(|a| {
            auxiliary_pattern.is_match(text(&a["name"]))
                || text(&a["exe"]).contains("/runtimes/cua_node/")
        });
        let host = std::iter::once(p)
            .chain(ancestors.iter().copied())
            .find(|a| {
                desktop(text(&a["exe"]))
                    || editor(text(&a["name"]))
                    || windows.iter().any(|w| w["pid"] == a["pid"])
            });
        let shell = host
            .filter(|a| !exe.to_lowercase().contains("openai.chatgpt") && desktop(text(&a["exe"])));
        let kind = if auxiliary {
            "auxiliary"
        } else if shell.is_some() {
            "desktop"
        } else if host.is_some() || exe.to_lowercase().contains("openai.chatgpt") {
            "ide"
        } else {
            "cli"
        };
        let by_process = windows
            .iter()
            .find(|w| w["pid"] == p["parentPid"] || ancestors.iter().any(|a| a["pid"] == w["pid"]));
        let hook = windows
            .iter()
            .filter(|w| w["windowKey"].is_string() && w["windowKey"] == context["windowKey"])
            .collect::<Vec<_>>();
        let by_home = windows
            .iter()
            .filter(|w| {
                w["companionHost"] == "remote" && same(text(&w["home"]), text(&context["home"]))
            })
            .collect::<Vec<_>>();
        let companion = by_process.or_else(|| {
            if hook.len() == 1 {
                Some(hook[0])
            } else if by_home.len() == 1 {
                Some(by_home[0])
            } else {
                None
            }
        });
        let shared = same(text(&context["home"]), &crate::platform::display_path(home));
        let ls = layers(
            text(&context["home"]),
            cwd,
            &context["profile"],
            &context["overrides"],
        );
        let stale = shared
            && timestamp(&p["startedAt"]) < timestamp(&effect["at"])
            && timestamp(&p["startedAt"]) > 0;
        let chain = std::iter::once(p)
            .chain(ancestors.iter().copied())
            .take(8)
            .map(|row| format!("{}:{}", row["pid"], text(&row["name"])))
            .collect::<Vec<_>>();
        clients.push(json!({"id":format!("process-{}",p["pid"]),"pid":p["pid"],"parentPid":p["parentPid"],"chain":chain,"kind":kind,"exe":p["exe"],"executable":p["exe"],"desktopExecutable":shell.map(|v|v["exe"].clone()),"desktopPid":shell.map(|v|v["pid"].clone()),"name":if kind=="desktop"{"Codex 桌面端"}else if kind=="ide"{"编辑器 · Codex"}else{"Codex CLI / app-server"},"home":context["home"],"homeSource":context["homeSource"],"confirmed":context["ok"]==true,"shared":shared,"startedAt":p["startedAt"],"stale":stale,"cwd":context["cwd"],"profile":context["profile"],"layers":ls,"overridden":ls.iter().any(|v|matches!(text(&v["source"]),"启动配置档"|"启动参数")&&v["values"].as_object().is_some_and(|o|!o.is_empty())),"overrides":context["overrides"],"editorId":companion.map(|w|w["id"].clone()),"error":context["error"]}));
    }
    let shells = clients
        .iter()
        .filter(|c| c["kind"] == "desktop" && c["pid"] != c["desktopPid"])
        .map(|c| c["desktopPid"].clone())
        .collect::<Vec<_>>();
    clients.retain(|c| {
        !(c["kind"] == "desktop" && c["pid"] == c["desktopPid"] && shells.contains(&c["pid"]))
    });
    for w in &windows {
        let matched = clients
            .iter()
            .filter(|c| c["editorId"] == w["id"])
            .collect::<Vec<_>>();
        let confirmed = matched
            .iter()
            .filter(|c| c["confirmed"] == true)
            .collect::<Vec<_>>();
        let shared = confirmed.iter().any(|c| c["shared"] == true);
        let mut row = w.clone();
        row["id"] = json!(format!("editor-{}", text(&w["id"])));
        row["editorId"] = w["id"].clone();
        row["kind"] = json!("editor");
        row["home"] = confirmed
            .first()
            .map(|c| c["home"].clone())
            .unwrap_or(w["home"].clone());
        row["confirmed"] = json!(!confirmed.is_empty());
        row["shared"] = json!(shared);
        row["canReload"] = json!(shared);
        row["stale"] = json!(matched.iter().any(|c| c["stale"] == true));
        row["commandPending"] = json!(w["command"].is_object());
        row["heartbeatAgeSec"] =
            json!(millis().saturating_sub(w["seenAt"].as_u64().unwrap_or(0)) / 1000);
        row["layers"] = matched
            .first()
            .map(|c| c["layers"].clone())
            .unwrap_or(json!([]));
        clients.push(row);
    }
    let auxiliary = clients
        .iter()
        .filter(|v| v["kind"] == "auxiliary")
        .cloned()
        .collect::<Vec<_>>();
    clients.retain(|v| v["kind"] != "auxiliary");
    Ok(
        json!({"home":home,"desktop":clients.iter().any(|c|c["kind"]=="desktop"),"ide":clients.iter().filter(|c|c["kind"]=="ide").count(),"other":clients.iter().filter(|c|c["kind"]=="cli").count(),"connectedEditors":windows.len(),"clients":clients,"auxiliary":auxiliary,"checkedAt":now()}),
    )
}
fn timestamp(value: &Value) -> i128 {
    text(value).parse::<i128>().ok().unwrap_or_else(|| {
        time::OffsetDateTime::parse(text(value), &time::format_description::well_known::Rfc3339)
            .map(|t| t.unix_timestamp_nanos())
            .unwrap_or(0)
    })
}
pub async fn status(app: &App) -> io::Result<Value> {
    let inventory = tokio::task::spawn_blocking(crate::platform::scan)
        .await
        .map_err(io::Error::other)??;
    snapshot(&app.codex_home(), &app.bridge, &inventory)
}
pub fn agent_status(input: &Value) -> io::Result<Value> {
    if input.is_null() {
        return Ok(Value::Null);
    }
    let strings = |object: &Value, fields: &[&str], optional: bool| -> io::Result<()> {
        for field in fields {
            if !object[*field].is_string() && !(optional && object[*field].is_null()) {
                return Err(io::Error::other("远端代理状态字段无效"));
            }
        }
        Ok(())
    };
    strings(
        input,
        &["agentVersion", "host", "platform", "arch", "codexHome"],
        false,
    )?;
    strings(input, &["startedAt"], true)?;
    if !input["current"].is_null() {
        strings(
            &input["current"],
            &["model", "modelProvider", "baseUrl"],
            true,
        )?;
    }
    if !input["account"].is_null() {
        strings(&input["account"], &["id", "email", "plan"], false)?;
        strings(&input["account"], &["lastRefresh"], true)?;
    }
    let platform = text(&input["platform"]);
    let home = text(&input["codexHome"]);
    let absolute = if platform == "win32" {
        home.starts_with("\\\\")
            || (home.as_bytes().get(1) == Some(&b':')
                && home.as_bytes().get(2).is_some_and(|v| b"/\\".contains(v)))
    } else {
        home.starts_with('/')
    };
    if !absolute {
        return Err(io::Error::other("远端 Codex 目录必须为绝对路径"));
    }
    let mut current = Value::Null;
    if input["current"].is_object() {
        let mut base = Value::Null;
        if let Some(url) = input["current"]["baseUrl"].as_str() {
            let url = reqwest::Url::parse(url).map_err(io::Error::other)?;
            base = json!(format!(
                "{}{}",
                url.origin().ascii_serialization(),
                url.path()
            ));
        }
        current = json!({"model":input["current"]["model"],"modelProvider":input["current"]["modelProvider"],"baseUrl":base});
    }
    let account = if input["account"].is_object() {
        json!({"id":input["account"]["id"],"email":input["account"]["email"],"plan":input["account"]["plan"],"lastRefresh":input["account"]["lastRefresh"]})
    } else {
        Value::Null
    };
    Ok(
        json!({"agentVersion":input["agentVersion"],"startedAt":input["startedAt"],"protocol":input["protocol"].as_u64().unwrap_or(0),"host":input["host"],"platform":platform,"arch":input["arch"],"codexHome":home,"configExists":input["configExists"]==true,"current":current,"account":account}),
    )
}
fn registry(app: &App, input: &Value, confirm: bool) -> io::Result<Value> {
    let id = text(&input["id"]);
    if !regex::Regex::new(r"^[A-Za-z0-9_-]{8,80}$")
        .unwrap()
        .is_match(id)
    {
        return Err(io::Error::other("客户端编号无效"));
    }
    let _guard = app.editors.write.lock().unwrap();
    let file = app.bridge.join("clients").join(format!("{id}.json"));
    let prior = read(&file, json!({}))?;
    let mut row = json!({"id":id,"pid":input["pid"].as_u64().unwrap_or(0),"name":input["name"].as_str().unwrap_or("VS Code"),"workspace":input["workspace"].as_str().unwrap_or(""),"seenAt":millis(),"command":prior["command"],"lastAck":prior["lastAck"],"remoteAgent":agent_status(&input["remoteAgent"])?});
    for field in [
        "home",
        "windowKey",
        "extensionId",
        "extensionName",
        "editorKind",
        "remote",
        "remoteType",
        "authority",
        "companionVersion",
        "remoteAgentState",
    ] {
        row[field] = input[field].clone();
    }
    for field in ["reloadProtocol", "remoteProtocol"] {
        row[field] = json!(input[field].as_u64().unwrap_or(0));
    }
    row["wsl"] = json!(input["wsl"] == true);
    row["companionHost"] = json!(if input["companionHost"] == "remote" {
        "remote"
    } else {
        "local"
    });
    let reported = text(&input["codexExe"]);
    row["codexExe"] = if crate::platform::trusted_codex(Path::new(reported)) {
        json!(reported)
    } else {
        Value::Null
    };
    row["extensionPath"] = Value::Null;
    if let Some(path) = input["extensionPath"].as_str() {
        let target = if cfg!(windows) {
            "bin/windows-x86_64/codex.exe"
        } else if cfg!(target_arch = "aarch64") {
            "bin/macos-aarch64/codex"
        } else {
            "bin/macos-x86_64/codex"
        };
        if crate::platform::trusted_codex(&Path::new(path).join(target)) {
            row["extensionPath"] = json!(path);
        }
    }
    let mut pending = app.editors.pending.lock().unwrap();
    let mut response = None;
    if let Some(p) = pending.get(id)
        && p.command["id"] == input["ack"]
    {
        if !matches!(text(&input["ackStatus"]), "completed" | "failed") {
            return Err(io::Error::other("远程命令回执状态无效"));
        }
        let p = pending.remove(id).unwrap();
        let failed = input["ackStatus"] == "failed";
        row["lastAck"] = json!({"id":input["ack"],"remote":true,"status":if failed{"failed"}else if p.command["reload"]==true{"reload_requested"}else{"completed"},"error":if failed{json!("远程命令执行失败，请查看编辑器提示")}else{Value::Null},"at":millis()});
        response = Some((
            p.sender,
            if failed {
                Err(input["ackError"]
                    .as_str()
                    .unwrap_or("远程命令执行失败")
                    .to_owned())
            } else {
                Ok(input["ackResult"].clone())
            },
        ));
    } else if input["ack"].is_string()
        && (prior["command"]["id"] == input["ack"]
            || (prior["lastAck"]["id"] == input["ack"] && prior["lastAck"]["remote"] != true))
    {
        row["lastAck"] = json!({"id":input["ack"],"status":input["ackStatus"].as_str().unwrap_or("accepted"),"error":input["ackError"],"at":millis()});
        row["command"] = Value::Null;
    }
    let mut confirmed = false;
    if confirm && input["completedReload"].is_object() {
        let done = &input["completedReload"];
        let old_id = text(&done["clientId"]);
        if regex::Regex::new(r"^[A-Za-z0-9_-]{8,80}$")
            .unwrap()
            .is_match(old_id)
        {
            let old_file = app.bridge.join("clients").join(format!("{old_id}.json"));
            let mut old = read(&old_file, Value::Null)?;
            if old["lastAck"]["id"] == done["commandId"]
                && matches!(
                    text(&old["lastAck"]["status"]),
                    "reload_requested" | "reloaded"
                )
            {
                old["lastAck"]["status"] = json!("reloaded");
                old["lastAck"]["at"] = json!(millis());
                row["lastAck"] = old["lastAck"].clone();
                confirmed = true;
                if old["remoteAgent"].is_object() {
                    old["seenAt"] = json!(0);
                }
                write_json(&old_file, &old)?;
            }
        }
    }
    let command = pending
        .get(id)
        .map(|p| p.command.clone())
        .unwrap_or(row["command"].clone());
    drop(pending);
    let wait = input["wait"].as_u64().unwrap_or(0).min(25000);
    if wait > 0
        && !input["ack"].is_string()
        && !input["completedReload"].is_object()
        && command.is_null()
    {
        row["waitUntil"] = json!(millis() + wait);
    }
    let mut before = prior.clone();
    before.as_object_mut().unwrap().remove("seenAt");
    let mut fields = row.clone();
    fields.as_object_mut().unwrap().remove("seenAt");
    if millis().saturating_sub(prior["seenAt"].as_u64().unwrap_or(0)) >= 5000 || before != fields {
        write_json(&file, &row)?;
    }
    if let Some((sender, result)) = response {
        let _ = sender.send(result);
    }
    let mut result = json!({"command":command});
    if confirm || confirmed {
        result["reloadConfirmed"] = json!(confirmed);
    }
    Ok(result)
}
async fn connection(app: &App, input: &Value) -> io::Result<Value> {
    if input["remote"].is_string() && input["companionHost"] != "remote" {
        return Ok(json!({"state":"remote","home":null,"backendPids":[]}));
    }
    let identity = serde_json::to_string(&json!([
        input["pid"],
        input["home"],
        input["windowKey"],
        input["extensionPath"],
        input["codexExe"],
        input["wsl"],
        input["remote"],
        input["companionHost"]
    ]))
    .unwrap();
    let id = text(&input["id"]);
    {
        let cache = app.editors.connection.lock().unwrap();
        if let Some((key, at, value)) = cache.get(id)
            && key == &identity
            && !input["completedReload"].is_object()
            && (value["state"] == "ready"
                || at.elapsed()
                    < Duration::from_secs(if value["state"] == "unmatched" { 5 } else { 30 }))
        {
            return Ok(value.clone());
        }
    }
    let snapshot = status(app).await?;
    let rows = snapshot["clients"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|c| c["kind"] == "ide" && c["editorId"] == id)
        .collect::<Vec<_>>();
    let state = if rows
        .iter()
        .any(|c| c["confirmed"] == true && c["shared"] == true)
    {
        "ready"
    } else if rows.iter().any(|c| c["confirmed"] == true) {
        "separate"
    } else {
        "unmatched"
    };
    let value = json!({"state":state,"home":app.codex_home(),"backendPids":rows.iter().map(|c|c["pid"].clone()).collect::<Vec<_>>()});
    app.editors
        .connection
        .lock()
        .unwrap()
        .insert(id.to_owned(), (identity, Instant::now(), value.clone()));
    let mut states = app.editors.states.lock().unwrap();
    if input["remoteType"] != "ssh-remote" && states.get(id) != Some(&json!(state)) {
        log(
            &app.bridge,
            "companion.state",
            json!({"editor":id,"editorPid":input["pid"],"from":states.get(id),"to":state,"backendPids":value["backendPids"],"remote":input["remote"],"companionVersion":input["companionVersion"]}),
        )?;
        states.insert(id.into(), json!(state));
    }
    Ok(value)
}
pub fn wake(app: &App) {
    if let Some(w) = app.editors.watching.lock().unwrap().as_ref() {
        let _ = w.tx.send(Ok(()));
    }
}
fn subscribe(
    app: Arc<App>,
    id: &str,
) -> io::Result<(Lease, broadcast::Receiver<Result<(), String>>)> {
    let directory = app.bridge.join("clients");
    fs::create_dir_all(&directory)?;
    let mut state = app.editors.watching.lock().unwrap();
    if state.is_none() {
        let (tx, _) = broadcast::channel(32);
        let sender = tx.clone();
        let mut native =
            notify::recommended_watcher(move |event: Result<notify::Event, notify::Error>| {
                let _ = sender.send(event.map(|_| ()).map_err(|e| e.to_string()));
            })
            .map_err(io::Error::other)?;
        // FSEvents delayed external commands beyond 500ms in macOS CI. Kqueue
        // watches the registry entries directly, including in-place writes.
        let mode = if cfg!(target_os = "macos") {
            notify::RecursiveMode::Recursive
        } else {
            notify::RecursiveMode::NonRecursive
        };
        native.watch(&directory, mode).map_err(io::Error::other)?;
        *state = Some(Watch {
            _native: native,
            tx,
            users: 0,
        });
    }
    let watch = state.as_mut().unwrap();
    watch.users += 1;
    let receiver = watch.tx.subscribe();
    let file = directory.join(format!("{id}.json"));
    let until = read(&file, Value::Null)?["waitUntil"].as_u64().unwrap_or(0);
    drop(state);
    Ok((Lease { app, file, until }, receiver))
}
pub async fn heartbeat(app: Arc<App>, input: &Value) -> io::Result<Value> {
    let mut result = registry(&app, input, false)?;
    let mut conn = connection(&app, input).await?;
    let remote_confirmed = if input["remoteType"] == "ssh-remote" {
        crate::remote::confirm(&app, input)?
    } else {
        false
    };
    if input["completedReload"].is_object() && (conn["state"] == "ready" || remote_confirmed) {
        result = registry(&app, input, true)?;
    }
    if remote_confirmed {
        let file = app
            .bridge
            .join("clients")
            .join(format!("{}.json", text(&input["id"])));
        let mut row = read(&file, Value::Null)?;
        if row["lastAck"].is_object() {
            row["lastAck"]["status"] = json!("reloaded");
            write_json(&file, &row)?;
        }
        result["reloadConfirmed"] = json!(true);
    }
    if input["remoteType"] == "ssh-remote" {
        crate::remote::observe(app.clone(), input)?;
    }
    let wait = input["wait"].as_u64().unwrap_or(0).min(25000);
    if wait > 0
        && !input["ack"].is_string()
        && !input["completedReload"].is_object()
        && result["command"].is_null()
    {
        let (_lease, mut events) = subscribe(app.clone(), text(&input["id"]))?;
        let deadline = tokio::time::Instant::now() + Duration::from_millis(wait);
        loop {
            let command = app
                .editors
                .pending
                .lock()
                .unwrap()
                .get(text(&input["id"]))
                .map(|p| p.command.clone())
                .unwrap_or(read(&_lease.file, Value::Null)?["command"].clone());
            if command.is_object() {
                result["command"] = command;
                break;
            }
            match tokio::time::timeout_at(deadline, events.recv()).await {
                Err(_) => break,
                Ok(Ok(Ok(()))) | Ok(Err(broadcast::error::RecvError::Lagged(_))) => {}
                Ok(Ok(Err(e))) => return Err(io::Error::other(e)),
                Ok(Err(e)) => return Err(io::Error::other(e)),
            }
        }
        conn = connection(&app, input).await?;
    }
    result["connection"] = conn;
    result["longPoll"] = json!(true);
    Ok(result)
}
pub fn reload(app: &App, input: &Value, stopped: &[Value], only: bool) -> io::Result<Value> {
    let status = if only {
        json!({"clients":[],"ide":0,"connectedEditors":records(&app.bridge)?.len()})
    } else {
        snapshot(&app.codex_home(), &app.bridge, &crate::platform::scan()?)?
    };
    let id = input["id"].as_str();
    let mut targets = status["clients"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|c| {
            c["kind"] == "editor"
                && c["canReload"] == true
                && id.is_none_or(|id| c["editorId"] == id)
        })
        .cloned()
        .collect::<Vec<_>>();
    for c in stopped {
        if id.is_none_or(|id| c["editorId"] == id)
            && !targets.iter().any(|v| v["editorId"] == c["editorId"])
        {
            targets.push(c.clone());
        }
    }
    if id.is_some() && targets.is_empty() {
        return Err(io::Error::other(
            "该窗口未连接伴随扩展，或未确认共用当前配置目录。",
        ));
    }
    let _guard = app.editors.write.lock().unwrap();
    let mut output = vec![];
    for c in targets {
        let file = app
            .bridge
            .join("clients")
            .join(format!("{}.json", text(&c["editorId"])));
        let mut row = read(&file, Value::Null)?;
        let command = uuid()?;
        row["command"] = json!({"id":command,"type":"reload","at":millis()});
        write_json(&file, &row)?;
        output.push(json!({"id":c["editorId"],"name":c["name"],"workspace":c["workspace"],"commandId":command}));
    }
    wake(app);
    Ok(
        json!({"count":output.len(),"detectedEditors":status["ide"],"connectedEditors":status["connectedEditors"],"targets":output,"message":if output.is_empty(){"未向任何编辑器窗口发送重载：请先接入伴随扩展，并在客户端列表确认配置目录。".into()}else{format!("已向 {} 个已接入的编辑器窗口发送重载请求，等待窗口执行。",output.len())}}),
    )
}
pub fn reload_results(bridge: &Path, targets: &Value) -> io::Result<Value> {
    let mut results = vec![];
    for target in targets.as_array().into_iter().flatten() {
        let row = read(
            &bridge
                .join("clients")
                .join(format!("{}.json", text(&target["id"]))),
            Value::Null,
        )?;
        let ack = if row["lastAck"]["id"] == target["commandId"] {
            row["lastAck"].clone()
        } else {
            Value::Null
        };
        let mut next = target.clone();
        next["status"] = json!(match text(&ack["status"]) {
            "reloaded" => "reloaded",
            "reload_failed" => "failed",
            "reload_requested" => "received",
            _ if row["command"]["id"] == target["commandId"] => "pending",
            _ => "unconfirmed",
        });
        next["error"] = ack["error"].clone();
        results.push(next);
    }
    Ok(json!(results))
}
