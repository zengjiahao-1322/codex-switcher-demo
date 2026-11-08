//! Claude Code state and current-provider checks.
use super::settings::*;
use crate::config_store;
use serde_json::{Value, json};
use std::{io, path::Path};

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
