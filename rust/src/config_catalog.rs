//! Model catalogs retain official technical metadata and label provider models.
use crate::config_store::read_json;
use serde_json::{Value, json};
use std::{io, path::Path};

pub struct Built {
    pub value: Value,
    pub source: &'static str,
    pub truncated: bool,
}
pub async fn build(home: &Path, provider: &Value, model: &str) -> io::Result<Option<Built>> {
    let cache = read_json(&home.join("models_cache.json"))?;
    let official = cache["models"]
        .as_array()
        .map(|a| {
            a.iter()
                .filter(|v| v["slug"].as_str().is_some_and(|s| !s.is_empty()))
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    let Some(base) = official
        .iter()
        .filter(|v| v["visibility"] != "hide")
        .min_by_key(|v| v["priority"].as_i64().unwrap_or(99))
        .or(official.first())
        .copied()
    else {
        return Ok(None);
    };
    let mut slugs = vec![model.to_string()];
    let configured = provider["models"].as_array().cloned().unwrap_or_default();
    let extras = configured
        .iter()
        .filter_map(Value::as_str)
        .filter(|s| !s.is_empty() && Some(*s) != provider["model"].as_str())
        .collect::<Vec<_>>();
    let mut candidates = vec![provider["model"].as_str().unwrap_or("").to_string()];
    candidates.extend(extras.iter().map(|s| s.to_string()));
    let mut source = "configured";
    let mut truncated = false;
    if extras.is_empty() {
        match crate::config_network::models(provider).await {
            Ok(fetched) if !fetched.is_empty() && fetched.len() <= 80 => {
                source = "provider";
                let non_chat = regex::Regex::new(r"(?i)(^|[-_/.])(image|dall-e|tts|whisper|transcribe|audio|realtime|embedding|embed|moderation|rerank)|auto-review").unwrap();
                candidates = fetched
                    .into_iter()
                    .filter(|s| !non_chat.is_match(s))
                    .collect();
            }
            Ok(fetched) => {
                truncated = fetched.len() > 80;
            }
            Err(error) => {
                eprintln!("Provider model list unavailable; using configured models: {error}")
            }
        }
    }
    for candidate in candidates {
        if !candidate.is_empty() && !slugs.contains(&candidate) {
            slugs.push(candidate);
        }
    }
    let models = slugs
        .iter()
        .enumerate()
        .map(|(i, slug)| {
            let mut value = official
                .iter()
                .find(|m| m["slug"] == *slug)
                .copied()
                .unwrap_or(base)
                .clone();
            for (key, field) in [
                ("slug", json!(slug)),
                ("display_name", json!(slug)),
                (
                    "description",
                    json!(format!(
                        "{} · {slug}",
                        provider["name"].as_str().unwrap_or("")
                    )),
                ),
                ("priority", json!(i)),
                ("visibility", json!("list")),
                ("upgrade", Value::Null),
                ("availability_nux", Value::Null),
            ] {
                value[key] = field;
            }
            value
        })
        .collect::<Vec<_>>();
    Ok(Some(Built {
        value: json!({"models":models}),
        source,
        truncated,
    }))
}
