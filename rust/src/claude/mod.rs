//! Claude Code actions and provider lifecycle integration.
pub(crate) mod access;
pub(crate) mod adapter;
mod probe;
pub(crate) mod settings;
mod state;
mod streaming;
use crate::{config_ops, config_store, server::App};
use access::Access;
use serde_json::{Value, json};
use settings::*;
pub use state::{is_current, state};
use std::{fs, io, path::Path};

pub(super) fn provider(bridge: &Path, id: &Value) -> io::Result<Value> {
    config_store::load(bridge)?["providers"]
        .as_array()
        .and_then(|rows| rows.iter().find(|p| p["id"] == *id))
        .cloned()
        .ok_or_else(|| io::Error::other("配置不存在，请刷新"))
}
fn usable(provider: &Value) -> io::Result<Access> {
    match access::local(provider) {
        Access::Unavailable(_) => Err(io::Error::other("请先在 API 配置中填写密钥")),
        access => Ok(access),
    }
}
pub async fn apply(app: &App, input: &Value) -> io::Result<Value> {
    let provider = provider(&app.bridge, &input["id"])?;
    if usable(&provider)? == Access::Adapter {
        crate::adapter::local_provider(app, &provider).await?;
    }
    apply_at(app, input, &config_dir())
}
fn apply_at(app: &App, input: &Value, dir: &Path) -> io::Result<Value> {
    let _operation = config_ops::operation(&app.bridge)?;
    write_apply(app, input, dir)
}
fn write_apply(app: &App, input: &Value, dir: &Path) -> io::Result<Value> {
    let id = input["id"].as_str().unwrap_or("");
    let model = input["model"]
        .as_str()
        .filter(|s| !s.trim().is_empty())
        .ok_or_else(|| io::Error::other("请选择 Claude Code 模型"))?;
    let fast_model = input["fastModel"].as_str().filter(|s| !s.trim().is_empty());
    let provider = provider(&app.bridge, &input["id"])?;
    let access = usable(&provider)?;
    let adapter = access == Access::Adapter;
    let settings = if adapter {
        Some(crate::adapter::settings(app)?)
    } else {
        None
    };
    let base = if let Some(settings) = &settings {
        format!("http://127.0.0.1:{}", settings["port"])
    } else {
        normalized_base(provider["baseUrl"].as_str().unwrap_or(""))
    };
    let token = settings
        .as_ref()
        .map(|s| s["token"].clone())
        .unwrap_or_else(|| provider["apiKey"].clone());
    let file = dir.join("settings.json");
    let original_text = read(&file)?;
    let snapshot = read(&original_file(&app.bridge))?;
    let (next, snapshot_text) = transform_apply(
        original_text.as_deref(),
        snapshot.as_deref(),
        &base,
        token,
        model,
        fast_model,
    )?;
    backup(&app.bridge, original_text.as_deref().unwrap_or("{}"))?;
    fs::create_dir_all(dir)?;
    if snapshot.is_none() {
        atomic(&original_file(&app.bridge), &snapshot_text, None)?;
    }
    atomic(&file, &next, original_text.as_deref())?;
    let current = json!({"providerId":id,"model":model,"fastModel":fast_model,"access":access.name(),"label":provider["name"]});
    config_ops::atomic(&current_file(&app.bridge), &pretty(&current)?, None)?;
    remember_model(&app.bridge, id, model, fast_model)?;
    crate::usage::record(app, "claude", "api", id, provider["name"].as_str().unwrap_or(""), Some(model))?;
    Ok(
        json!({"message":format!("已让 Claude Code 使用{}（{}）。{}新开的 Claude Code 会话生效（CLI、VS Code、桌面版 Code），已打开的会话需重开。官方登录凭据未改动。", provider["name"].as_str().unwrap_or("配置"), model, if adapter {"经本机转换，需保持切换器运行。"} else {""}),"needsAutostart":adapter && !crate::integration::startup_file().exists()}),
    )
}
pub fn restore(app: &App) -> io::Result<Value> {
    restore_at(app, &config_dir())
}
fn restore_at(app: &App, dir: &Path) -> io::Result<Value> {
    let _operation = config_ops::operation(&app.bridge)?;
    let original = read(&original_file(&app.bridge))?
        .ok_or_else(|| io::Error::other("没有可恢复的 Claude Code 原始配置"))?;
    let destination = state::original(&parse(Some(&original))?)?;
    let file = dir.join("settings.json");
    let current_text = read(&file)?;
    let next = transform_restore(current_text.as_deref(), &original)?;
    atomic(&file, &next, current_text.as_deref())?;
    fs::remove_file(original_file(&app.bridge))?;
    if current_file(&app.bridge).exists() {
        fs::remove_file(current_file(&app.bridge))?;
    }
    let message = if destination["kind"] == "official" {
        "已恢复官方登录。".to_owned()
    } else {
        format!(
            "已恢复接管前的配置（{}）。",
            destination["host"].as_str().unwrap_or("")
        )
    };
    crate::usage::record(app, "claude", if destination["kind"] == "official" { "official" } else { "api" }, if destination["kind"] == "official" { "claude" } else { "external" }, if destination["kind"] == "official" { "Claude 官方登录" } else { "接管前的配置" }, None)?;
    Ok(json!({"message":format!("{message}登录凭据未改动。"),"restoredTo":destination["kind"]}))
}
pub fn on_provider_changed(app: &App, id: &str) -> io::Result<Option<String>> {
    let current = config_store::read_json(&current_file(&app.bridge))?;
    if current["providerId"] != id {
        return Ok(None);
    }
    let provider = provider(&app.bridge, &json!(id))?;
    let remembered = models(&app.bridge)?;
    let model = remembered[id]["model"]
        .as_str()
        .or(provider["model"].as_str())
        .unwrap_or("");
    let input = json!({"id":id,"model":model,"fastModel":remembered[id]["fastModel"]});
    Ok(Some(match write_apply(app, &input, &config_dir()) {
        Ok(_) => "已同步到 Claude Code。".to_owned(),
        Err(error) => format!(
            "未能同步到 Claude Code：{}，请到 Claude Code 页重新应用。",
            error
        ),
    }))
}
pub fn on_provider_removed(bridge: &Path, id: &str) -> io::Result<()> {
    forget_model(bridge, id)
}
pub const ACTIONS: &[&str] = &["claudeApply", "claudeRestore", "claudeState", "claudeProbe"];
pub async fn action(app: &App, action: &str, input: &Value) -> io::Result<Value> {
    match action {
        "claudeApply" => apply(app, input).await,
        "claudeRestore" => restore(app),
        "claudeState" => state(&app.bridge),
        "claudeProbe" => probe::probe(app, input).await,
        _ => Err(io::Error::other("Unknown Claude Code action")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        collections::HashMap,
        env,
        path::PathBuf,
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
