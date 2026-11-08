//! Claude Code state, model memory and managed-key drift detection.
use super::{
    access::{self, Access},
    settings::*,
};
use crate::config_store;
use serde_json::{Value, json};
use std::{io, path::Path};

pub fn is_current(bridge: &Path, id: &str) -> io::Result<bool> {
    Ok(state(bridge)?["current"]["providerId"] == id)
}
pub(super) fn original(snapshot: &Value) -> io::Result<Value> {
    match snapshot["values"].get("ANTHROPIC_BASE_URL") {
        None => Ok(json!({"kind":"official","host":null})),
        Some(base) => {
            let raw = base.as_str().unwrap_or("").trim();
            let host = reqwest::Url::parse(raw)
                .ok()
                .and_then(|url| url.host_str().map(str::to_owned))
                .unwrap_or_else(|| raw.to_owned());
            Ok(json!({"kind":"custom","host":host}))
        }
    }
}
fn drift(actual: &Value, expected: &Value) -> bool {
    KEYS.iter()
        .any(|key| actual["env"].get(*key) != expected["env"].get(*key))
}
fn expected(provider: &Value, current: &Value, adapter: &Value) -> io::Result<Value> {
    let (base, token) = if access::local(provider) == Access::Adapter {
        (
            format!("http://127.0.0.1:{}", adapter["port"]),
            adapter["token"].clone(),
        )
    } else {
        (
            normalized_base(provider["baseUrl"].as_str().unwrap_or("")),
            provider["apiKey"].clone(),
        )
    };
    let (text, _) = transform_apply(
        None,
        None,
        &base,
        token,
        current["model"].as_str().unwrap_or(""),
        current["fastModel"].as_str(),
    )?;
    parse(Some(&text))
}
pub fn state(bridge: &Path) -> io::Result<Value> {
    let store = config_store::load(bridge)?;
    let rows = store["providers"].as_array().unwrap();
    let remembered = models(bridge)?;
    let providers = rows.iter().map(|p| {
        let id = p["id"].as_str().unwrap_or("");
        let local = access::local(p);
        let remote = access::remote(p);
        json!({"id":id,"access":local.name(),"reason":local.reason(),"remote":remote.name(),"remoteReason":remote.reason(),"model":remembered[id]["model"].as_str().or(p["model"].as_str()),"fastModel":remembered[id]["fastModel"]})
    }).collect::<Vec<_>>();
    let mut current =
        read(&current_file(bridge))?.and_then(|s| serde_json::from_str::<Value>(&s).ok());
    let mut original_state = Value::Null;
    let mut changed = false;
    let mut drift_message = None;
    if let Some(saved) = &mut current {
        if let Some(snapshot) = read(&original_file(bridge))? {
            original_state = original(&parse(Some(&snapshot))?)?;
        }
        if let Some(provider) = rows.iter().find(|p| p["id"] == saved["providerId"]) {
            let access = access::local(provider);
            saved["access"] = json!(access.name());
            let adapter = config_store::read_json(&bridge.join("adapter.json"))?;
            match parse(read(&settings_file())?.as_deref()) {
                Ok(root) => {
                    changed = matches!(access, Access::Unavailable(_))
                        || drift(&root, &expected(provider, saved, &adapter)?);
                }
                Err(_) => {
                    changed = true;
                    drift_message = Some("Claude Code 配置文件无法解析，请检查后重新选择。");
                }
            }
        } else {
            changed = true;
        }
    }
    Ok(
        json!({"configDir":config_dir(),"current":if changed {None} else {current},"original":original_state,"drift":if changed {Some(drift_message.unwrap_or("Claude Code 配置已被外部修改，请重新选择。"))} else {None},"autostart":crate::integration::startup_file().exists(),"providers":providers}),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn every_managed_key_detects_external_edits() {
        let provider = json!({"apiMode":"anthropic_messages","baseUrl":"https://fixture.invalid/v1","apiKey":"fixture-key"});
        let current = json!({"model":"main","fastModel":"fast"});
        let expected = expected(&provider, &current, &Value::Null).unwrap();
        assert!(!drift(&expected, &expected));
        for key in KEYS {
            let mut actual = expected.clone();
            actual["env"][key] = json!("external-edit");
            assert!(drift(&actual, &expected), "{key}");
        }
    }
    #[test]
    fn original_distinguishes_official_login_and_custom_host() {
        assert_eq!(
            original(&json!({"values":{}})).unwrap(),
            json!({"kind":"official","host":null})
        );
        assert_eq!(
            original(&json!({"values":{"ANTHROPIC_BASE_URL":"https://original.invalid/claude"}}))
                .unwrap(),
            json!({"kind":"custom","host":"original.invalid"})
        );
        assert_eq!(
            original(&json!({"values":{"ANTHROPIC_BASE_URL":"api.example.com/claude"}})).unwrap(),
            json!({"kind":"custom","host":"api.example.com/claude"})
        );
    }
}
