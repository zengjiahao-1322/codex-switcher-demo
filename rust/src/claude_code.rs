//! Isolated custom Anthropic API settings for Claude Code.
use crate::{config_ops, config_store, server::App};
use serde_json::{Map, Value, json};
use std::{
    env, fs, io,
    path::{Path, PathBuf},
};

const KEYS: [&str; 7] = [
    "ANTHROPIC_BASE_URL",
    "ANTHROPIC_AUTH_TOKEN",
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_MODEL",
    "ANTHROPIC_DEFAULT_SONNET_MODEL",
    "ANTHROPIC_DEFAULT_OPUS_MODEL",
    "ANTHROPIC_DEFAULT_HAIKU_MODEL",
];

fn config_dir() -> PathBuf {
    env::var_os("CLAUDE_CONFIG_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| crate::platform::user_home().join(".claude"))
}
fn settings_file() -> PathBuf {
    config_dir().join("settings.json")
}
fn current_file(bridge: &Path) -> PathBuf {
    bridge.join("claude-current.json")
}
fn original_file(bridge: &Path) -> PathBuf {
    bridge.join("claude-original.json")
}

fn read(path: &Path) -> io::Result<Option<String>> {
    match fs::read_to_string(path) {
        Ok(value) => Ok(Some(value)),
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e),
    }
}
fn parse(text: Option<&str>) -> io::Result<Value> {
    serde_json::from_str(text.unwrap_or("{}"))
        .map_err(|_| io::Error::other("Claude Code settings.json 无法解析"))
}
fn pretty(value: &Value) -> io::Result<String> {
    serde_json::to_string_pretty(value).map_err(io::Error::other)
}
fn atomic(file: &Path, value: &str, expected: Option<&str>) -> io::Result<()> {
    config_ops::atomic(file, value, Some(expected))
}
fn env_object(value: &mut Value) -> io::Result<&mut Map<String, Value>> {
    let object = value
        .as_object_mut()
        .ok_or_else(|| io::Error::other("Claude Code settings.json 顶层必须是对象"))?;
    if !object.contains_key("env") {
        object.insert("env".into(), Value::Object(Map::new()));
    }
    object
        .get_mut("env")
        .and_then(Value::as_object_mut)
        .ok_or_else(|| io::Error::other("Claude Code settings.json 的 env 必须是对象"))
}
fn backup(bridge: &Path, text: &str) -> io::Result<()> {
    let dir = bridge.join("backups/claude-settings");
    fs::create_dir_all(&dir)?;
    let stamp = crate::diagnostics::now().replace([':', '.', '+'], "");
    let random = crate::platform::random_bytes()?;
    let suffix = random[..4]
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect::<String>();
    config_ops::atomic(&dir.join(format!("{stamp}-{suffix}.json")), text, None)?;
    let mut entries = fs::read_dir(&dir)?
        .filter_map(Result::ok)
        .collect::<Vec<_>>();
    entries.sort_by_key(|e| e.file_name());
    while entries.len() > 10 {
        fs::remove_file(entries.remove(0).path())?;
    }
    Ok(())
}
fn original_snapshot(env: Option<&Map<String, Value>>) -> Value {
    let mut out = Map::new();
    for key in KEYS {
        if let Some(value) = env.and_then(|e| e.get(key)) {
            out.insert(key.into(), value.clone());
        }
    }
    json!({"values":out,"envOrder":env.map(|e| e.keys().cloned().collect::<Vec<_>>()).unwrap_or_default()})
}
fn normalized_base(value: &str) -> String {
    let mut value = value.trim_end_matches('/').to_owned();
    if value.ends_with("/v1") {
        value.truncate(value.len() - 3);
    }
    value.trim_end_matches('/').to_owned()
}
pub fn is_current(bridge: &Path, id: &str) -> io::Result<bool> {
    Ok(state(bridge)?["current"]["providerId"] == id)
}
pub fn state(bridge: &Path) -> io::Result<Value> {
    let dir = config_dir();
    let current = read(&current_file(bridge))?.and_then(|s| serde_json::from_str::<Value>(&s).ok());
    if current.is_none() {
        return Ok(json!({"configDir":dir,"current":null,"notice":null}));
    }
    let settings = read(&settings_file())?;
    let root = parse(settings.as_deref())?;
    let providers = config_store::load(bridge)?;
    let changed = current.as_ref().is_some_and(|v| {
        let expected = providers["providers"]
            .as_array()
            .and_then(|rows| rows.iter().find(|p| p["id"] == v["providerId"]))
            .and_then(|p| {
                if p["apiMode"] == "anthropic_messages" {
                    p["baseUrl"].as_str().map(normalized_base)
                } else {
                    config_store::read_json(&bridge.join("adapter.json"))
                        .ok()
                        .and_then(|s| s["port"].as_u64())
                        .map(|port| format!("http://127.0.0.1:{port}"))
                }
            });
        !root["env"]["ANTHROPIC_BASE_URL"]
            .as_str()
            .zip(expected)
            .is_some_and(|(actual, expected)| normalized_base(actual) == expected)
    });
    Ok(
        json!({"configDir":dir,"current":if changed { None } else { current },"notice":if changed { Some("Claude Code 配置已被外部修改，请重新选择。") } else { None }}),
    )
}
pub async fn apply(app: &App, input: &Value) -> io::Result<Value> {
    let store = config_store::load(&app.bridge)?;
    let provider = store["providers"]
        .as_array()
        .and_then(|rows| rows.iter().find(|p| p["id"] == input["id"]))
        .ok_or_else(|| io::Error::other("配置不存在，请刷新"))?;
    if provider["apiMode"] != "anthropic_messages" {
        crate::adapter::local_provider(app, provider).await?;
    }
    apply_at(app, input, &config_dir())
}
fn apply_at(app: &App, input: &Value, dir: &Path) -> io::Result<Value> {
    let _operation = config_ops::operation(&app.bridge)?;
    let id = input["id"].as_str().unwrap_or("");
    let model = input["model"]
        .as_str()
        .filter(|s| !s.trim().is_empty())
        .ok_or_else(|| io::Error::other("请选择 Claude Code 模型"))?;
    let provider = config_store::load(&app.bridge)?["providers"]
        .as_array()
        .and_then(|rows| rows.iter().find(|p| p["id"] == id))
        .cloned()
        .ok_or_else(|| io::Error::other("配置不存在，请刷新"))?;
    let adapter = provider["apiMode"] != "anthropic_messages";
    let settings = if adapter {
        Some(crate::adapter::settings(app)?)
    } else {
        None
    };
    let file = dir.join("settings.json");
    let original_text = read(&file)?;
    let mut root = parse(original_text.as_deref())?;
    if !root.is_object() || root.get("env").is_some_and(|env| !env.is_object()) {
        return Err(io::Error::other("Claude Code settings.json 格式无效"));
    }
    let old_env = root["env"].as_object();
    let snapshot_text = if original_file(&app.bridge).exists() {
        None
    } else {
        Some(pretty(&original_snapshot(old_env))?)
    };
    backup(&app.bridge, original_text.as_deref().unwrap_or("{}"))?;
    let env = env_object(&mut root)?;
    env.insert(
        "ANTHROPIC_BASE_URL".into(),
        if let Some(settings) = &settings {
            json!(format!("http://127.0.0.1:{}", settings["port"]))
        } else {
            json!(normalized_base(provider["baseUrl"].as_str().unwrap_or("")))
        },
    );
    env.insert(
        "ANTHROPIC_AUTH_TOKEN".into(),
        settings
            .as_ref()
            .map(|s| s["token"].clone())
            .unwrap_or_else(|| provider["apiKey"].clone()),
    );
    env.shift_remove("ANTHROPIC_API_KEY");
    env.insert("ANTHROPIC_MODEL".into(), json!(model));
    for key in [
        "ANTHROPIC_DEFAULT_SONNET_MODEL",
        "ANTHROPIC_DEFAULT_OPUS_MODEL",
        "ANTHROPIC_DEFAULT_HAIKU_MODEL",
    ] {
        env.insert(key.into(), json!(model));
    }
    let next = pretty(&root)?;
    fs::create_dir_all(dir)?;
    if let Some(snapshot) = &snapshot_text {
        atomic(&original_file(&app.bridge), snapshot, None)?;
    }
    atomic(&file, &next, original_text.as_deref())?;
    let current = json!({"providerId":id,"model":model,"label":provider["name"]});
    config_ops::atomic(&current_file(&app.bridge), &pretty(&current)?, None)?;
    let mut note = "";
    if let Some(settings) = &settings {
        if input["autostart"] != false
            && settings["autostartDecided"] != true
            && !crate::integration::startup_file().exists()
        {
            crate::integration::autostart(true, &app.bridge)?;
            note = "已开启开机自启转换服务。";
        } else if !crate::integration::startup_file().exists() {
            note = "注意：未开启开机自启，重启后需先打开切换器。";
        }
    }
    Ok(
        json!({"message":format!("已让 Claude Code 使用{}（{}）。{}{}新开的 Claude Code 会话生效（CLI、VS Code、桌面版 Code），已打开的会话需重开。官方登录凭据未改动。", provider["name"].as_str().unwrap_or("配置"), model, if adapter {"经本机转换，需保持切换器运行。"} else {""}, note)}),
    )
}
pub fn restore(app: &App) -> io::Result<Value> {
    restore_at(app, &config_dir())
}
fn restore_at(app: &App, dir: &Path) -> io::Result<Value> {
    let _operation = config_ops::operation(&app.bridge)?;
    if !original_file(&app.bridge).exists() {
        return Err(io::Error::other("没有可恢复的 Claude Code 原始配置"));
    }
    let original = parse(read(&original_file(&app.bridge))?.as_deref())?;
    let file = dir.join("settings.json");
    let current_text = read(&file)?;
    let mut root = parse(current_text.as_deref())?;
    let env = env_object(&mut root)?;
    for key in KEYS {
        env.shift_remove(key);
    }
    let mut ordered = Map::new();
    if let Some(order) = original["envOrder"].as_array() {
        for key in order.iter().filter_map(Value::as_str) {
            if KEYS.contains(&key) {
                if let Some(value) = original["values"].get(key) {
                    ordered.insert(key.into(), value.clone());
                }
            } else if let Some(value) = env.shift_remove(key) {
                ordered.insert(key.into(), value);
            }
        }
    }
    ordered.extend(std::mem::take(env));
    *env = ordered;
    if env.is_empty() {
        root.as_object_mut().unwrap().shift_remove("env");
    }
    atomic(&file, &pretty(&root)?, current_text.as_deref())?;
    if original_file(&app.bridge).exists() {
        fs::remove_file(original_file(&app.bridge))?;
    }
    if current_file(&app.bridge).exists() {
        fs::remove_file(current_file(&app.bridge))?;
    }
    Ok(json!({"message":"已恢复官方。官方登录凭据未改动。"}))
}
pub const ACTIONS: &[&str] = &["claudeApply", "claudeRestore", "claudeState"];
pub async fn action(app: &App, action: &str, input: &Value) -> io::Result<Value> {
    match action {
        "claudeApply" => apply(app, input).await,
        "claudeRestore" => restore(app),
        "claudeState" => state(&app.bridge),
        _ => Err(io::Error::other("Unknown Claude Code action")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        collections::HashMap,
        sync::{Mutex, atomic::AtomicBool},
        time::Instant,
    };

    fn fixture() -> (App, PathBuf) {
        let random = crate::platform::random_bytes().unwrap();
        let suffix = random[..8]
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect::<String>();
        let root = env::temp_dir().join(format!(
            "claude-switch-test-{}-{suffix}",
            std::process::id()
        ));
        let bridge = root.join("bridge");
        fs::create_dir_all(&bridge).unwrap();
        let app = App {
            home: root.clone(),
            bridge: bridge.clone(),
            web: root.clone(),
            token: String::new(),
            port: 0,
            protection: crate::platform::DataProtection {
                ok: true,
                path: bridge,
                error: None,
            },
            first_request: AtomicBool::new(false),
            ready_at: Instant::now(),
            downloads: Mutex::new(HashMap::new()),
            accounts: crate::accounts::Runtime::default(),
            editors: crate::editors::Runtime::default(),
            updates: crate::update::Runtime::default(),
        };
        (app, root)
    }
    #[test]
    fn apply_twice_then_restore_preserves_other_fields_and_original_order() {
        let (app, root) = fixture();
        let dir = root.join("claude");
        fs::create_dir_all(&dir).unwrap();
        let initial = json!({"before":true,"env":{"OTHER_A":"keep","ANTHROPIC_API_KEY":"old-key","OTHER_B":"keep","ANTHROPIC_MODEL":"old-model"},"after":2});
        fs::write(dir.join("settings.json"), pretty(&initial).unwrap()).unwrap();
        config_store::save(&app.bridge, &json!({"providers":[
            {"id":"one","name":"One","baseUrl":"https://one.invalid/v1/","apiMode":"anthropic_messages","apiKey":"fake-one"},
            {"id":"two","name":"Two","baseUrl":"https://two.invalid/v1","apiMode":"anthropic_messages","apiKey":"fake-two"}
        ]})).unwrap();
        apply_at(&app, &json!({"id":"one","model":"m1"}), &dir).unwrap();
        let first: Value =
            serde_json::from_str(&fs::read_to_string(dir.join("settings.json")).unwrap()).unwrap();
        assert_eq!(first["env"]["ANTHROPIC_BASE_URL"], "https://one.invalid");
        assert_eq!(first["env"]["ANTHROPIC_AUTH_TOKEN"], "fake-one");
        assert!(first["env"].get("ANTHROPIC_API_KEY").is_none());
        for key in [
            "ANTHROPIC_MODEL",
            "ANTHROPIC_DEFAULT_SONNET_MODEL",
            "ANTHROPIC_DEFAULT_OPUS_MODEL",
            "ANTHROPIC_DEFAULT_HAIKU_MODEL",
        ] {
            assert_eq!(first["env"][key], "m1");
        }
        assert_eq!(first["env"]["OTHER_A"], "keep");
        assert_eq!(first["env"]["OTHER_B"], "keep");
        apply_at(&app, &json!({"id":"two","model":"m2"}), &dir).unwrap();
        restore_at(&app, &dir).unwrap();
        let restored: Value =
            serde_json::from_str(&fs::read_to_string(dir.join("settings.json")).unwrap()).unwrap();
        assert_eq!(restored, initial);
        assert_eq!(
            restored.as_object().unwrap().keys().collect::<Vec<_>>(),
            initial.as_object().unwrap().keys().collect::<Vec<_>>()
        );
        assert_eq!(
            restored["env"]
                .as_object()
                .unwrap()
                .keys()
                .collect::<Vec<_>>(),
            initial["env"]
                .as_object()
                .unwrap()
                .keys()
                .collect::<Vec<_>>()
        );
        assert!(!current_file(&app.bridge).exists());
        assert!(!original_file(&app.bridge).exists());
        fs::remove_dir_all(root).unwrap();
    }
}
