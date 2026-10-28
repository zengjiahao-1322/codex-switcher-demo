//! Configuration transactions, snapshots, operation locks and HTTP actions.
use crate::{config_store as store, config_text as text, instance::write_json, server::App};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    fs,
    io::{self, Write},
    path::{Path, PathBuf},
};
const EFFECT: &str = "配置已应用。请完整退出并重新打开客户端，以载入新旧对话的来源与模型。";
pub fn read(file: &Path) -> io::Result<Option<String>> {
    match fs::read_to_string(file) {
        Ok(s) => Ok(Some(s)),
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e),
    }
}
pub fn private_file(file: &Path) -> io::Result<()> {
    #[cfg(windows)]
    {
        crate::platform::protect_directory(file)
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(file, fs::Permissions::from_mode(0o600))
    }
}
pub fn atomic(file: &Path, value: &str, expected: Option<Option<&str>>) -> io::Result<()> {
    let random = crate::platform::random_bytes()?;
    let name = random[..8]
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect::<String>();
    let temporary = file.with_file_name(format!(
        "{}.{name}.tmp",
        file.file_name().unwrap().to_string_lossy()
    ));
    let operation = (|| -> io::Result<()> {
        let mut options = fs::OpenOptions::new();
        options.create_new(true).write(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut output = options.open(&temporary)?;
        private_file(&temporary)?;
        output.write_all(value.as_bytes())?;
        output.sync_all()?;
        drop(output);
        if let Some(previous) = expected
            && read(file)?.as_deref() != previous
        {
            return Err(io::Error::other(
                "Concurrent config modification detected; retry after review",
            ));
        }
        fs::rename(&temporary, file)?;
        if read(file)?.as_deref() != Some(value) {
            return Err(io::Error::other(
                "Concurrent config modification after replacement",
            ));
        }
        Ok(())
    })();
    if temporary.exists() {
        fs::remove_file(temporary)?;
    }
    operation
}
pub struct Lock {
    file: PathBuf,
    owned: bool,
}
impl Drop for Lock {
    fn drop(&mut self) {
        if self.owned
            && let Err(error) = fs::remove_file(&self.file)
        {
            eprintln!("Configuration lock cleanup failed: {error}");
        }
    }
}
impl Lock {
    pub fn handoff(mut self, pid: u32) -> io::Result<()> {
        write_json(&self.file, &json!({"pid":pid}))?;
        self.owned = false;
        Ok(())
    }
}
pub fn adopt_operation(bridge: &Path) -> io::Result<Lock> {
    let file = bridge.join("operation.lock");
    let owner = store::read_json(&file)?;
    if owner["pid"] != std::process::id() {
        return Err(io::Error::other("切换任务尚未取得配置锁。"));
    }
    Ok(Lock { file, owned: true })
}
fn lock(file: PathBuf, operation: bool) -> io::Result<Lock> {
    if operation && file.exists() {
        let owner = store::read_json(&file)?;
        if owner["pid"]
            .as_u64()
            .is_some_and(|p| !crate::platform::alive(p as u32))
        {
            fs::remove_file(&file)?;
        }
    }
    let mut options = fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut output = options.open(&file).map_err(|e| {
        if e.kind() == io::ErrorKind::AlreadyExists {
            io::Error::other(if operation {
                "另一项配置操作或账号切换正在进行，请稍后"
            } else {
                "Bridge config is locked; review stale lock before retrying"
            })
        } else {
            e
        }
    })?;
    write!(output, "{}", json!({"pid":std::process::id()}))?;
    Ok(Lock { file, owned: true })
}
pub fn operation(bridge: &Path) -> io::Result<Lock> {
    lock(bridge.join("operation.lock"), true)
}
fn parsed(value: &str) -> io::Result<Value> {
    let value = toml::from_str::<toml::Value>(value)
        .map_err(|_| io::Error::other("Invalid TOML configuration (details redacted)"))?;
    serde_json::to_value(value).map_err(io::Error::other)
}
fn pattern() -> regex::Regex {
    regex::Regex::new(r"^(\d{4}-\d\d-\d\dT\d\d-\d\d-\d\d-\d{3}Z)-(switch|official|restore)\.toml$")
        .unwrap()
}
fn files(bridge: &Path) -> io::Result<Vec<String>> {
    let dir = bridge.join("backups/codex-config");
    if !dir.exists() {
        return Ok(Vec::new());
    }
    let pattern = pattern();
    let mut names = fs::read_dir(dir)?
        .map(|e| e.map(|e| e.file_name().to_string_lossy().to_string()))
        .collect::<Result<Vec<_>, _>>()?;
    names.retain(|s| pattern.is_match(s));
    names.sort_by(|a, b| b.cmp(a));
    Ok(names)
}
fn stamp_time(stamp: &str) -> String {
    format!(
        "{}T{}:{}:{}.{}Z",
        &stamp[..10],
        &stamp[11..13],
        &stamp[14..16],
        &stamp[17..19],
        &stamp[20..23]
    )
}
fn summary(config: &Value) -> String {
    let provider = config["model_provider"].as_str().unwrap_or("openai");
    let name = if provider == "openai" {
        "官方"
    } else {
        config["model_providers"][provider]["name"]
            .as_str()
            .unwrap_or(provider)
    };
    format!(
        "{name} · {}",
        config["model"].as_str().unwrap_or("默认模型")
    )
}
pub fn backups(bridge: &Path) -> io::Result<Value> {
    let mut items = Vec::new();
    for id in files(bridge)? {
        let p = pattern();
        let c = p.captures(&id).unwrap();
        items.push(json!({"id":id,"at":stamp_time(&c[1]),"reason":&c[2],"summary":summary(&parsed(&fs::read_to_string(bridge.join("backups/codex-config").join(&id))?)?)}));
    }
    Ok(json!({"items":items}))
}
pub fn save_backup(home: &Path, bridge: &Path, reason: &str) -> io::Result<()> {
    let Some(value) = read(&home.join("config.toml"))? else {
        return Ok(());
    };
    let previous = files(bridge)?;
    let dir = bridge.join("backups/codex-config");
    if let Some(first) = previous.first()
        && fs::read_to_string(dir.join(first))? == value
    {
        return Ok(());
    }
    fs::create_dir_all(&dir)?;
    crate::platform::protect_directory(&dir)?;
    let now = time::OffsetDateTime::now_utc();
    let last = previous
        .first()
        .and_then(|s| pattern().captures(s).map(|c| stamp_time(&c[1])))
        .and_then(|s| {
            time::OffsetDateTime::parse(&s, &time::format_description::well_known::Rfc3339).ok()
        });
    let at = last.map_or(now, |last| now.max(last + time::Duration::milliseconds(1)));
    let stamp = at
        .format(
            &time::format_description::parse_borrowed::<2>(
                "[year]-[month]-[day]T[hour]-[minute]-[second]-[subsecond digits:3]Z",
            )
            .unwrap(),
        )
        .unwrap();
    atomic(&dir.join(format!("{stamp}-{reason}.toml")), &value, None)?;
    for name in previous.iter().skip(9) {
        fs::remove_file(dir.join(name))?;
    }
    crate::diagnostics::log(
        bridge,
        "config.backup",
        json!({"reason":reason,"kept":(previous.len()+1).min(10)}),
    )
}
pub fn backup(bridge: &Path, id: &str) -> io::Result<String> {
    if !files(bridge)?.iter().any(|name| name == id) {
        return Err(io::Error::other("配置备份不存在，请刷新列表。"));
    }
    fs::read_to_string(bridge.join("backups/codex-config").join(id))
}
fn effect(home: &Path, bridge: &Path) -> io::Result<()> {
    let value = fs::read(home.join("config.toml"))?;
    write_json(
        &bridge.join("effect.json"),
        &json!({"status":"restart_required","message":EFFECT,"configHash":format!("{:x}",Sha256::digest(value)),"at":crate::diagnostics::now()}),
    )
}
fn remove_optional(file: &Path) -> io::Result<()> {
    match fs::remove_file(file) {
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(()),
        other => other,
    }
}
fn provider(bridge: &Path, id: &str) -> io::Result<Value> {
    store::load(bridge)?["providers"]
        .as_array()
        .unwrap()
        .iter()
        .find(|p| p["id"] == id)
        .cloned()
        .ok_or_else(|| io::Error::other("配置不存在，请刷新"))
}
async fn validate(app: &App, next: &str) -> io::Result<()> {
    use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
    let config = parsed(next)?;
    let root = std::env::temp_dir().join(format!(
        "codex-bridge-validate-{}-{}",
        std::process::id(),
        crate::diagnostics::now().replace([':', '.', '+'], "")
    ));
    fs::create_dir_all(&root)?;
    // Validation receives a copy with placeholder credentials and a loopback URL.
    let mut copy = config.clone();
    if let Some(providers) = copy
        .get_mut("model_providers")
        .and_then(Value::as_object_mut)
    {
        for p in providers.values_mut() {
            if let Some(p) = p.as_object_mut() {
                for key in ["env_key", "http_headers", "env_http_headers"] {
                    p.remove(key);
                }
                p.insert(
                    "experimental_bearer_token".into(),
                    json!("validation-not-a-real-key"),
                );
                p.insert("base_url".into(), json!("http://127.0.0.1:1/v1"));
            }
        }
    }
    let text = toml::to_string(&copy).map_err(io::Error::other)?;
    fs::write(root.join("config.toml"), text)?;
    let mut command = tokio::process::Command::new(crate::platform::codex_path(&app.bridge)?);
    command
        .args(["--strict-config", "app-server"])
        .current_dir(&root)
        .envs(crate::platform::codex_env(&root))
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .kill_on_drop(true);
    #[cfg(windows)]
    command.creation_flags(0x08000000);
    let result = async {
        let mut child = command.spawn()?;
        let checked = tokio::time::timeout(std::time::Duration::from_secs(20), async {
            let stdin = child.stdin.as_mut().unwrap();
            stdin.write_all(b"{\"id\":1,\"method\":\"initialize\",\"params\":{\"clientInfo\":{\"name\":\"bridge-config-check\",\"version\":\"1\"}}}\n").await?;
            let mut lines = BufReader::new(child.stdout.take().unwrap()).lines();
            while let Some(line) = lines.next_line().await? {
                let Ok(value) = serde_json::from_str::<Value>(&line) else { continue; };
                if value["id"] == 1 {
                    if !value["result"].is_object() || value.get("error").is_some() { break; }
                    if config["model_catalog_json"].is_string() {
                        stdin.write_all(b"{\"id\":2,\"method\":\"model/list\",\"params\":{}}\n").await?;
                    } else { return Ok(()); }
                } else if value["id"] == 2 {
                    if value["result"]["data"].as_array().is_some_and(|rows| rows.iter().any(|r| r["model"] == config["model"])) { return Ok(()); }
                    break;
                }
            }
            Err(io::Error::other("当前 Codex 拒绝供应商配置；未修改原配置。"))
        }).await.unwrap_or_else(|_| Err(io::Error::other("当前 Codex 拒绝供应商配置；未修改原配置。")));
        if child.try_wait()?.is_none() { child.kill().await?; }
        child.wait().await?;
        checked
    }.await;
    fs::remove_dir_all(root)?;
    result
}

struct StagedCatalog {
    path: PathBuf,
}
impl Drop for StagedCatalog {
    fn drop(&mut self) {
        if let Err(error) = remove_optional(&self.path) {
            eprintln!("Catalog cleanup failed: {error}");
        }
    }
}
async fn catalog(app: &App, p: &Value, model: &str) -> io::Result<Option<StagedCatalog>> {
    let Some(value) = crate::config_catalog::build(&app.codex_home(), p, model).await? else {
        return Ok(None);
    };
    let name = format!(
        "model-catalog-{}.prepared",
        crate::diagnostics::now().replace([':', '.', '+'], "")
    );
    let path = app.bridge.join(name);
    atomic(&path, &serde_json::to_string_pretty(&value).unwrap(), None)?;
    Ok(Some(StagedCatalog { path }))
}
pub struct Prepared {
    original: Option<String>,
    next: String,
    staged: Option<StagedCatalog>,
    current: Value,
    pub label: String,
    reason: &'static str,
    snapshot: bool,
}
impl Prepared {
    pub fn apply(self, app: &App) -> io::Result<Value> {
        let home = app.codex_home();
        let file = home.join("config.toml");
        let _lock = lock(home.join(".hermes-bridge.lock"), false)?;
        if read(&file)? != self.original {
            return Err(io::Error::other(
                "Concurrent config modification detected; retry after review",
            ));
        }
        if self.snapshot {
            atomic(
                &app.bridge.join("original-config.toml"),
                self.original.as_deref().unwrap_or(""),
                None,
            )?;
        }
        save_backup(&home, &app.bridge, self.reason)?;
        let count = if let Some(staged) = &self.staged {
            let count = store::read_json(&staged.path)?["models"]
                .as_array()
                .map_or(0, Vec::len);
            fs::rename(&staged.path, app.bridge.join("model-catalog.json"))?;
            count
        } else {
            0
        };
        atomic(&file, &self.next, Some(self.original.as_deref()))?;
        if self.current.is_null() {
            remove_optional(&app.bridge.join("current.json"))?;
        } else {
            write_json(&app.bridge.join("current.json"), &self.current)?;
        }
        effect(&home, &app.bridge)?;
        Ok(json!({"label":self.label,"mode":"direct","catalogCount":count}))
    }
}
pub async fn prepare_api(app: &App, input: &Value) -> io::Result<Prepared> {
    let id = input["id"].as_str().unwrap_or("");
    let p = provider(&app.bridge, id)?;
    let model = input["model"]
        .as_str()
        .filter(|s| !s.trim().is_empty())
        .ok_or_else(|| io::Error::other("请选择或填写模型"))?;
    let mode = access(&app.bridge, &p)?;
    if !["direct", "adapter"].contains(&mode.as_str()) {
        let checked = crate::config_network::probe(&p, model).await?;
        probe_record(&app.bridge, &p, model, &checked)?;
        if checked["ok"] != true {
            return Err(io::Error::other(format!(
                "检测未通过，未切换：{}",
                checked["message"].as_str().unwrap_or("")
            )));
        }
    }
    if mode == "adapter" || access(&app.bridge, &p)? == "adapter" {
        return Err(io::Error::other("本机转换服务尚未迁移，未修改配置。"));
    }
    let original = read(&app.codex_home().join("config.toml"))?;
    let mut staged = catalog(app, &p, model).await?;
    let candidate = text::prepare(
        original.as_deref().unwrap_or(""),
        &p,
        model,
        staged.as_ref().and_then(|s| s.path.to_str()),
    )?;
    if let Err(e) = validate(app, &candidate).await {
        if staged.is_none() {
            return Err(e);
        }
        staged = None;
        validate(
            app,
            &text::prepare(original.as_deref().unwrap_or(""), &p, model, None)?,
        )
        .await?;
    }
    let next = text::prepare(
        original.as_deref().unwrap_or(""),
        &p,
        model,
        staged
            .as_ref()
            .map(|_| app.bridge.join("model-catalog.json"))
            .as_ref()
            .and_then(|p| p.to_str()),
    )?;
    let snapshot = !app.bridge.join("original-config.toml").exists()
        || parsed(original.as_deref().unwrap_or(""))?["model_provider"] != "hermes_bridge";
    Ok(Prepared {
        original,
        next,
        staged,
        current: json!({"providerId":id,"model":model,"mode":"direct","at":crate::diagnostics::now()}),
        label: p["name"].as_str().unwrap_or("").into(),
        reason: "switch",
        snapshot,
    })
}
pub async fn prepare_backup(app: &App, id: &str) -> io::Result<Prepared> {
    let value = backup(&app.bridge, id)?;
    let config = parsed(&value)?;
    let target = &config["model_providers"]["hermes_bridge"];
    let adapter = store::read_json(&app.bridge.join("adapter.json"))?;
    if config["model_provider"] == "hermes_bridge"
        && adapter["port"]
            .as_u64()
            .is_some_and(|port| target["base_url"] == format!("http://127.0.0.1:{port}/v1"))
    {
        return Err(io::Error::other("本机转换服务尚未迁移，未修改配置。"));
    }
    let saved = store::load(&app.bridge)?["providers"]
        .as_array()
        .unwrap()
        .iter()
        .find(|p| {
            p["baseUrl"] == target["base_url"] && p["apiKey"] == target["experimental_bearer_token"]
        })
        .cloned();
    let catalog_path = app.bridge.join("model-catalog.json");
    let managed = config["model_provider"] == "hermes_bridge"
        && config["model_catalog_json"].as_str() == catalog_path.to_str();
    let fallback = json!({"name":target["name"],"baseUrl":target["base_url"],"apiKey":target["experimental_bearer_token"],"model":config["model"],"apiMode":"responses"});
    let staged = if managed {
        catalog(
            app,
            saved.as_ref().unwrap_or(&fallback),
            config["model"].as_str().unwrap_or(""),
        )
        .await?
    } else {
        None
    };
    let selection = |catalog: Option<&str>| json!({"model":config["model"],"model_provider":config["model_provider"],"model_catalog_json":catalog});
    let candidate = if managed {
        text::edit(
            &value,
            &selection(staged.as_ref().and_then(|s| s.path.to_str())),
            target,
        )?
    } else {
        value.clone()
    };
    validate(app, &candidate).await?;
    let next = if managed {
        text::edit(
            &value,
            &selection(staged.as_ref().and_then(|_| catalog_path.to_str())),
            target,
        )?
    } else {
        value
    };
    let original = read(&app.codex_home().join("config.toml"))?;
    let current=saved.map(|p|json!({"providerId":p["id"],"model":config["model"],"mode":"direct","at":crate::diagnostics::now()})).unwrap_or(Value::Null);
    Ok(Prepared {
        original,
        next,
        staged,
        current,
        label: summary(&config),
        reason: "restore",
        snapshot: false,
    })
}
fn follow(input: &Value) -> io::Result<()> {
    if input["threadFollow"]
        .as_str()
        .is_some_and(|s| !["off", "matching", "all"].contains(&s))
    {
        Err(io::Error::other("旧对话跟随模式无效。"))
    } else {
        Ok(())
    }
}
fn source(input: &Value) -> io::Result<&str> {
    let source = input["source"].as_str().unwrap_or("web");
    if ["web", "vscode-local", "vscode-ssh"].contains(&source) {
        Ok(source)
    } else {
        Err(io::Error::other("切换来源无效"))
    }
}
pub fn access(bridge: &Path, p: &Value) -> io::Result<String> {
    let records = store::read_json(&bridge.join("probe-results.json"))?;
    let sig = format!(
        "{:x}",
        Sha256::digest(
            serde_json::to_vec(&json!([p["baseUrl"], p["apiMode"], p["apiKey"]])).unwrap()
        )
    );
    let record = &records[p["id"].as_str().unwrap_or("")];
    Ok(if record["sig"] == sig[..16] {
        record["mode"].as_str().unwrap_or("unknown").to_owned()
    } else {
        "unknown".to_owned()
    })
}
fn probe_record(bridge: &Path, p: &Value, model: &str, result: &Value) -> io::Result<()> {
    let mut records = store::read_json(&bridge.join("probe-results.json"))?;
    if !records.is_object() {
        records = json!({});
    }
    let id = p["id"].as_str().unwrap();
    let sig = format!(
        "{:x}",
        Sha256::digest(
            serde_json::to_vec(&json!([p["baseUrl"], p["apiMode"], p["apiKey"]])).unwrap()
        )
    );
    if result["ok"] != true
        && result["transient"] == true
        && records[id]["sig"] == sig[..16]
        && matches!(records[id]["mode"].as_str(), Some("direct" | "adapter"))
    {
        return Ok(());
    }
    records[id] = json!({"model":model,"mode":if result["ok"]==true{result["mode"].as_str().unwrap()}else{"failed"},"message":result["message"],"at":crate::diagnostics::now(),"sig":&sig[..16]});
    write_json(&bridge.join("probe-results.json"), &records)
}

pub const ACTIONS: &[&str] = &[
    "providerAdd",
    "providerUpdate",
    "providerRemove",
    "importHermes",
    "backups",
    "models",
    "probe",
    "switch",
    "restore",
];
pub async fn action(app: &std::sync::Arc<App>, action: &str, input: &Value) -> io::Result<Value> {
    let home = app.codex_home();
    let exclusive = !["models", "backups"].contains(&action);
    let _operation = if exclusive {
        let mut job = store::read_json(&app.bridge.join("account-switch.json"))?;
        if matches!(
            job["status"].as_str(),
            Some("preparing" | "switching" | "reopening" | "queued")
        ) {
            if job["pid"]
                .as_u64()
                .is_some_and(|p| crate::platform::alive(p as u32))
            {
                return Err(io::Error::other("账号切换正在进行，请稍后"));
            }
            job["status"] = json!("error");
            job["message"] = json!("上次账号切换已中断，可以重新选择来源并切换。");
            write_json(&app.bridge.join("account-switch.json"), &job)?;
        }
        Some(lock(app.bridge.join("operation.lock"), true)?)
    } else {
        None
    };
    match action {
        "providerAdd" => store::add(&app.bridge, input),
        "providerUpdate" => store::update(&app.bridge, input),
        "providerRemove" => store::remove(&app.bridge, &home, &input["id"]),
        "backups" => backups(&app.bridge),
        "importHermes" => {
            let path = std::env::var_os("BRIDGE_HERMES_HOME")
                .map(PathBuf::from)
                .filter(|p| p.join("config.yaml").is_file())
                .ok_or_else(|| io::Error::other("未找到 Hermes 配置"))?;
            let result = store::import(&app.bridge, &path, false)?;
            let names = result["added"]
                .as_array()
                .unwrap()
                .iter()
                .filter_map(Value::as_str)
                .collect::<Vec<_>>();
            Ok(
                json!({"message":if names.is_empty(){"没有需要导入的新配置。".to_string()}else{format!("已导入 {} 个：{}{}",names.len(),names.join("、"),if result["failed"].as_u64().unwrap_or(0)>0{format!("；{} 个因信息不完整跳过",result["failed"])}else{String::new()})}}),
            )
        }
        "models" => {
            if input["id"] == "official" {
                let cache = store::read_json(&home.join("models_cache.json"))?;
                let models = cache["models"]
                    .as_array()
                    .map(|a| {
                        a.iter()
                            .filter(|v| v["visibility"] != "hide")
                            .filter_map(|v| v["slug"].as_str())
                            .collect::<Vec<_>>()
                    })
                    .unwrap_or_default();
                if models.is_empty() {
                    return Err(io::Error::other(
                        "未找到 Codex 官方模型缓存，请先打开一次 Codex",
                    ));
                }
                return Ok(
                    json!({"models":models,"message":format!("Codex 官方共 {} 个模型。",models.len())}),
                );
            }
            let mut p = if let Some(id) = input["id"].as_str() {
                provider(&app.bridge, id)?
            } else {
                json!({})
            };
            for key in ["baseUrl", "apiMode", "apiKey"] {
                if let Some(v) = input[key].as_str().filter(|s| !s.is_empty()) {
                    p[key] = json!(v.trim());
                }
            }
            if p["baseUrl"].as_str().is_none_or(str::is_empty) {
                return Err(io::Error::other("请先填写 API 地址"));
            }
            if !matches!(
                p["apiMode"].as_str(),
                Some("responses" | "chat_completions" | "anthropic_messages")
            ) {
                return Err(io::Error::other("协议类型无效"));
            }
            let models = crate::config_network::models(&p).await?;
            if models.is_empty() {
                return Err(io::Error::other("供应商返回了空的模型列表，请手动填写模型"));
            }
            Ok(json!({"models":models,"message":format!("获取到 {} 个模型。",models.len())}))
        }
        "probe" => {
            if input["id"] == "official" {
                return Ok(
                    json!({"ok":true,"mode":"official","message":"官方登录使用 Codex 自己的 ChatGPT 登录，无需检测，可直接应用。"}),
                );
            }
            let p = provider(&app.bridge, input["id"].as_str().unwrap_or(""))?;
            let model = input["model"].as_str().unwrap_or("");
            let mut result = crate::config_network::probe(&p, model).await?;
            probe_record(&app.bridge, &p, model, &result)?;
            if result["ok"] != true && result["transient"] == true {
                result["message"] = json!(format!(
                    "{}（这通常是临时的：额度、限流或服务端故障，不代表配置不兼容）",
                    result["message"].as_str().unwrap()
                ));
            }
            Ok(result)
        }
        "switch" => {
            follow(input)?;
            let _source = source(input)?;
            let previous_provider = parsed(
                read(&home.join("config.toml"))?.as_deref().unwrap_or(""),
            )?["model_provider"]
                .as_str()
                .unwrap_or("openai")
                .to_owned();
            let id = input["id"].as_str().unwrap_or("");
            if id == "official" {
                return official(app, input, false).await;
            }
            let p = provider(&app.bridge, id)?;
            let model = input["model"]
                .as_str()
                .filter(|s| !s.trim().is_empty())
                .ok_or_else(|| io::Error::other("请选择或填写模型"))?;
            let checked = crate::config_network::probe(&p, model).await?;
            probe_record(&app.bridge, &p, model, &checked)?;
            if checked["ok"] != true {
                return Err(io::Error::other(format!(
                    "检测未通过，未切换：{}",
                    checked["message"].as_str().unwrap_or("")
                )));
            }
            if checked["mode"] != "direct" {
                return Err(io::Error::other("本机转换服务尚未迁移，未修改配置。"));
            }
            let file = home.join("config.toml");
            let original = read(&file)?;
            let mut staged = catalog(app, &p, model).await?;
            let candidate = text::prepare(
                original.as_deref().unwrap_or(""),
                &p,
                model,
                staged.as_ref().map(|s| s.path.to_str().unwrap()),
            )?;
            if let Err(error) = validate(app, &candidate).await {
                if staged.is_none() {
                    return Err(error);
                }
                staged = None;
                validate(
                    app,
                    &text::prepare(original.as_deref().unwrap_or(""), &p, model, None)?,
                )
                .await?;
            }
            let catalog_path = app.bridge.join("model-catalog.json");
            let next = text::prepare(
                original.as_deref().unwrap_or(""),
                &p,
                model,
                staged.as_ref().map(|_| catalog_path.to_str().unwrap()),
            )?;
            let _lock = lock(home.join(".hermes-bridge.lock"), false)?;
            let before = parsed(original.as_deref().unwrap_or(""))?;
            let snapshot = app.bridge.join("original-config.toml");
            if !snapshot.exists() || before["model_provider"] != "hermes_bridge" {
                atomic(&snapshot, original.as_deref().unwrap_or(""), None)?;
            }
            save_backup(&home, &app.bridge, "switch")?;
            if let Some(staged) = &staged {
                fs::rename(&staged.path, &catalog_path)?;
            }
            atomic(&file, &next, Some(original.as_deref()))?;
            write_json(
                &app.bridge.join("current.json"),
                &json!({"providerId":id,"model":model,"mode":"direct","at":crate::diagnostics::now()}),
            )?;
            effect(&home, &app.bridge)?;
            drop(_lock);
            let threads = crate::thread_routing::synchronize(
                app,
                crate::switching::mode(input)?,
                Some(&previous_provider),
            )
            .await
            .map_err(|(e, _)| e)?;
            Ok(
                json!({"mode":"direct","catalogCount":staged.as_ref().map_or(0, |_| store::read_json(&catalog_path).ok().and_then(|v|v["models"].as_array().map(Vec::len)).unwrap_or(0)),"threads":threads,"message":format!("已切换到「{}」（直连，模型 {model}）。{EFFECT}",p["name"].as_str().unwrap())}),
            )
        }
        "restore" => {
            follow(input)?;
            source(input)?;
            official(app, input, true).await
        }
        _ => Err(io::Error::other("Unknown configuration action")),
    }
}
pub async fn official(app: &App, input: &Value, restore: bool) -> io::Result<Value> {
    let home = app.codex_home();
    let file = home.join("config.toml");
    let current = read(&file)?;
    let config = parsed(current.as_deref().unwrap_or(""))?;
    if restore && config["model_provider"] != "hermes_bridge" {
        let threads = crate::thread_routing::synchronize(
            app,
            crate::switching::mode(input)?,
            config["model_provider"].as_str().or(Some("openai")),
        )
        .await
        .map_err(|(e, _)| e)?;
        return Ok(json!({"threads":threads,"message":"Codex 当前已是官方登录。"}));
    }
    let snapshot = read(&app.bridge.join("original-config.toml"))?;
    let original = if config["model_provider"] == "hermes_bridge" {
        snapshot.as_deref().ok_or_else(|| {
            io::Error::other(
                "没有找到切换前的配置快照，无法自动恢复；请在 Codex 设置中手动选择模型",
            )
        })?
    } else {
        current.as_deref().unwrap_or("")
    };
    let original_config = parsed(original)?;
    let next = if restore {
        text::edit(
            current.as_deref().unwrap_or(""),
            &json!({"model":original_config["model"],"model_provider":original_config["model_provider"],"model_catalog_json":original_config["model_catalog_json"]}),
            &config["model_providers"]["hermes_bridge"],
        )?
    } else {
        text::official(
            current.as_deref().unwrap_or(""),
            input["model"]
                .as_str()
                .or(original_config["model"].as_str()),
            original_config["model_catalog_json"].as_str(),
            None,
        )?
    };
    let _lock = lock(home.join(".hermes-bridge.lock"), false)?;
    save_backup(&home, &app.bridge, "official")?;
    atomic(&file, &next, Some(current.as_deref()))?;
    remove_optional(&app.bridge.join("current.json"))?;
    effect(&home, &app.bridge)?;
    drop(_lock);
    let threads = crate::thread_routing::synchronize(
        app,
        crate::switching::mode(input)?,
        config["model_provider"].as_str().or(Some("openai")),
    )
    .await
    .map_err(|(e, _)| e)?;
    Ok(
        json!({"mode":"official","threads":threads,"message":format!("已切回 Codex 官方登录。{EFFECT}")}),
    )
}
