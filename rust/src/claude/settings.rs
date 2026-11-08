//! Claude Code settings transforms and isolated file storage.
use crate::{config_ops, config_store};
use serde_json::{Map, Value, json};
use std::{
    env, fs, io,
    path::{Path, PathBuf},
};

pub(super) const KEYS: [&str; 7] = [
    "ANTHROPIC_BASE_URL",
    "ANTHROPIC_AUTH_TOKEN",
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_MODEL",
    "ANTHROPIC_DEFAULT_SONNET_MODEL",
    "ANTHROPIC_DEFAULT_OPUS_MODEL",
    "ANTHROPIC_DEFAULT_HAIKU_MODEL",
];

pub(super) fn config_dir() -> PathBuf {
    env::var_os("CLAUDE_CONFIG_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| crate::platform::user_home().join(".claude"))
}
pub(super) fn settings_file() -> PathBuf {
    config_dir().join("settings.json")
}
pub(super) fn current_file(bridge: &Path) -> PathBuf {
    bridge.join("claude-current.json")
}
pub(super) fn original_file(bridge: &Path) -> PathBuf {
    bridge.join("claude-original.json")
}
pub(super) fn models(bridge: &Path) -> io::Result<Value> {
    let value = config_store::read_json(&bridge.join("claude-models.json"))?;
    Ok(if value.is_null() { json!({}) } else { value })
}
pub(super) fn remember_model(
    bridge: &Path,
    id: &str,
    model: &str,
    fast_model: Option<&str>,
) -> io::Result<()> {
    let mut value = models(bridge)?;
    value[id] = json!({"model":model,"fastModel":fast_model});
    config_ops::atomic(&bridge.join("claude-models.json"), &pretty(&value)?, None)
}
pub(super) fn forget_model(bridge: &Path, id: &str) -> io::Result<()> {
    let file = bridge.join("claude-models.json");
    if file.exists() {
        let mut value = models(bridge)?;
        value.as_object_mut().unwrap().remove(id);
        config_ops::atomic(&file, &pretty(&value)?, None)?;
    }
    Ok(())
}

pub(super) fn read(path: &Path) -> io::Result<Option<String>> {
    match fs::read_to_string(path) {
        Ok(value) => Ok(Some(value)),
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e),
    }
}
pub(super) fn parse(text: Option<&str>) -> io::Result<Value> {
    serde_json::from_str(text.unwrap_or("{}"))
        .map_err(|_| io::Error::other("Claude Code settings.json 无法解析"))
}
pub(super) fn pretty(value: &Value) -> io::Result<String> {
    serde_json::to_string_pretty(value).map_err(io::Error::other)
}
pub(super) fn atomic(file: &Path, value: &str, expected: Option<&str>) -> io::Result<()> {
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
pub(super) fn backup(bridge: &Path, text: &str) -> io::Result<()> {
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
    json!({"values":out,"envPresent":env.is_some(),"envOrder":env.map(|e| e.keys().cloned().collect::<Vec<_>>()).unwrap_or_default()})
}
pub(super) fn normalized_base(value: &str) -> String {
    let mut value = value.trim_end_matches('/').to_owned();
    if value.ends_with("/v1") {
        value.truncate(value.len() - 3);
    }
    value.trim_end_matches('/').to_owned()
}
pub(crate) fn transform_apply(
    text: Option<&str>,
    snapshot: Option<&str>,
    base: &str,
    token: Value,
    model: &str,
    fast_model: Option<&str>,
) -> io::Result<(String, String)> {
    let mut root = parse(text)?;
    if !root.is_object() || root.get("env").is_some_and(|env| !env.is_object()) {
        return Err(io::Error::other("Claude Code settings.json 格式无效"));
    }
    let snapshot = match snapshot {
        Some(value) => value.to_owned(),
        None => pretty(&original_snapshot(root["env"].as_object()))?,
    };
    let env = env_object(&mut root)?;
    env.insert("ANTHROPIC_BASE_URL".into(), json!(normalized_base(base)));
    env.insert("ANTHROPIC_AUTH_TOKEN".into(), token);
    env.shift_remove("ANTHROPIC_API_KEY");
    for key in [
        "ANTHROPIC_MODEL",
        "ANTHROPIC_DEFAULT_SONNET_MODEL",
        "ANTHROPIC_DEFAULT_OPUS_MODEL",
    ] {
        env.insert(key.into(), json!(model));
    }
    env.insert(
        "ANTHROPIC_DEFAULT_HAIKU_MODEL".into(),
        json!(fast_model.unwrap_or(model)),
    );
    Ok((pretty(&root)?, snapshot))
}
pub(crate) fn transform_restore(text: Option<&str>, snapshot: &str) -> io::Result<String> {
    let original = parse(Some(snapshot))?;
    let mut root = parse(text)?;
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
    if env.is_empty() && original["envPresent"] != true {
        root.as_object_mut().unwrap().shift_remove("env");
    }
    pretty(&root)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn restore_keeps_an_originally_empty_env_object() {
        let original = r#"{"env":{},"other":true}"#;
        let (changed, snapshot) = transform_apply(
            Some(original),
            None,
            "https://fixture.invalid",
            json!("fake"),
            "model",
            None,
        )
        .unwrap();
        let restored = transform_restore(Some(&changed), &snapshot).unwrap();
        assert_eq!(
            serde_json::from_str::<Value>(&restored).unwrap(),
            serde_json::from_str::<Value>(original).unwrap()
        );
    }

    #[test]
    fn fast_model_only_changes_haiku_and_defaults_to_main() {
        for fast in [Some("fast"), None] {
            let (text, _) = transform_apply(
                None,
                None,
                "https://fixture.invalid/v1",
                json!("fixture-key"),
                "main",
                fast,
            )
            .unwrap();
            let value = parse(Some(&text)).unwrap();
            for key in [
                "ANTHROPIC_MODEL",
                "ANTHROPIC_DEFAULT_SONNET_MODEL",
                "ANTHROPIC_DEFAULT_OPUS_MODEL",
            ] {
                assert_eq!(value["env"][key], "main");
            }
            assert_eq!(
                value["env"]["ANTHROPIC_DEFAULT_HAIKU_MODEL"],
                fast.unwrap_or("main")
            );
        }
    }
}
