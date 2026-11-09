//! Price books, model resolution and query-time billing.
use super::{number, text};
use crate::server::App;
use serde_json::{Value, json};
use std::{
    collections::HashSet,
    fs, io,
    sync::{Mutex, OnceLock},
};
fn public_path(app: &App) -> std::path::PathBuf {
    app.web.parent().unwrap().join("data")
}
pub fn load(app: &App) -> io::Result<Value> {
    let file = app.bridge.join("usage/prices.json");
    if file.exists() {
        crate::config_store::read_json(&file)
    } else {
        crate::config_store::read_json(&public_path(app).join("price-snapshot.json"))
    }
}
pub fn metadata(book: &Value) -> Value {
    json!({"source":book["source"],"fetchedAt":book["fetchedAt"],"version":book["version"],"error":book["error"],"errorAt":book["errorAt"]})
}
pub fn stale(book: &Value) -> bool {
    super::scan::millis(text(&book["fetchedAt"])).is_none_or(|t| super::now_ms() - t > 86400000)
}
fn normalize(model: &str) -> String {
    static DATE: OnceLock<regex::Regex> = OnceLock::new();
    let stripped = DATE
        .get_or_init(|| regex::Regex::new(r"[-_]\d{4}-?\d{2}-?\d{2}$").unwrap())
        .replace(model, "");
    stripped.to_lowercase().replace('.', "-")
}
fn find(book: &Value, model: &str, overrides: &Value) -> Option<(String, Value)> {
    let canonical = normalize(model);
    let models = book["models"].as_array()?;
    let matched = models.iter().find(|m| {
        normalize(text(&m["id"])) == canonical
            || normalize(text(&m["id"]))
                .split_once('/')
                .is_some_and(|(_, suffix)| suffix == canonical)
    });
    let matched = matched.or_else(|| {
        overrides["aliases"][model]["id"]
            .as_str()
            .and_then(|id| models.iter().find(|m| m["id"] == id))
    });
    if let Some(m) = matched {
        let id = text(&m["id"]);
        let price = overrides["prices"].get(id).unwrap_or(&m["pricing"]).clone();
        return Some((id.to_owned(), price));
    }
    overrides["prices"]
        .get(model)
        .map(|p| (model.to_owned(), p.clone()))
}
fn rate(price: &Value, key: &str) -> Option<f64> {
    price[key]
        .as_str()
        .and_then(|s| s.parse().ok())
        .or(price[key].as_f64())
}
pub fn bill(
    row: &Value,
    source: &Value,
    provider: &Value,
    book: &Value,
    overrides: &Value,
) -> (Option<f64>, String) {
    let pricing = &provider["pricing"];
    let currency = if pricing["mode"] == "multiplier" {
        pricing["currency"].as_str().unwrap_or("USD")
    } else {
        "USD"
    }
    .to_owned();
    if pricing["mode"] == "free" {
        return (Some(0.0), currency);
    }
    let Some((id, mut price)) = find(book, text(&row["model"]), overrides) else {
        return (None, currency);
    };
    let input = number(&row["input"]);
    let cached = number(&row["cached_input"]);
    let w5 = number(&row["cache_write_5m"]);
    let w1 = number(&row["cache_write_1h"]);
    let output = number(&row["output"]);
    let context_input = if row["client"] == "claude" {
        input + cached + w5 + w1
    } else {
        input
    };
    for group in [
        price["overrides"].clone(),
        overrides["longContext"][&id].clone(),
    ] {
        if let Some(list) = group.as_array() {
            let selected = list
                .iter()
                .filter(|v| {
                    v["min_prompt_tokens"]
                        .as_i64()
                        .is_some_and(|n| context_input >= n)
                })
                .max_by_key(|v| v["min_prompt_tokens"].as_i64());
            if let Some(p) = selected {
                let updates = p.as_object().cloned().unwrap_or_default();
                price.as_object_mut().unwrap().extend(updates);
            }
        }
    }
    let terms = if row["client"] == "codex" {
        vec![
            (input.saturating_sub(cached), "prompt"),
            (cached, "input_cache_read"),
            (output, "completion"),
        ]
    } else {
        vec![
            (input, "prompt"),
            (cached, "input_cache_read"),
            (w5, "input_cache_write"),
            (w1, "input_cache_write_1h"),
            (output, "completion"),
        ]
    };
    let mut sum = 0.0;
    for (n, key) in terms {
        if n > 0 {
            let Some(r) = rate(&price, key) else {
                return (None, currency);
            };
            sum += n as f64 * r;
        }
    }
    let vendor = id.split_once('/').map(|v| v.0).unwrap_or("");
    let factor = overrides["tiers"][vendor][text(&row["tier"])]
        .as_f64()
        .unwrap_or(1.0);
    sum *= factor;
    if source["kind"] == "api" && pricing["mode"] == "multiplier" {
        sum *= pricing["multiplier"].as_f64().unwrap_or(1.0);
    }
    (Some(sum), currency)
}
pub async fn refresh(app: &App) -> io::Result<Value> {
    let mut book = load(app)?;
    let url = match std::env::var("SWITCHER_TEST_PRICE_ORIGIN") {
        Ok(v) => {
            let u = reqwest::Url::parse(&v).map_err(io::Error::other)?;
            if u.scheme() != "http" || u.host_str() != Some("127.0.0.1") {
                return Err(io::Error::other("Price fixture must use loopback"));
            }
            v
        }
        Err(_) => "https://openrouter.ai/api/v1/models".into(),
    };
    let result = crate::update::public_json(app, &url)
        .await
        .and_then(|value| {
            let rows = value["data"]
                .as_array()
                .ok_or_else(|| io::Error::other("模型价格响应缺少data"))?;
            let vendors = [
                "openai",
                "anthropic",
                "google",
                "deepseek",
                "x-ai",
                "qwen",
                "moonshotai",
                "z-ai",
            ];
            let models = rows
                .iter()
                .filter(|model| {
                    text(&model["id"])
                        .split_once('/')
                        .is_some_and(|(vendor, _)| vendors.contains(&vendor))
                        && !text(&model["id"]).contains(':')
                })
                .map(|model| json!({"id": model["id"], "pricing": model["pricing"]}))
                .collect::<Vec<_>>();
            if models.is_empty() {
                return Err(io::Error::other("价格响应不含支持的模型"));
            }
            Ok(json!({
                "source": "openrouter",
                "fetchedAt": crate::diagnostics::now(),
                "version": book["version"].as_u64().unwrap_or(0) + 1,
                "models": models,
                "error": null,
                "errorAt": null
            }))
        });
    match result {
        Ok(next) => book = next,
        Err(e) => {
            book["error"] = json!(e.to_string());
            book["errorAt"] = json!(crate::diagnostics::now());
        }
    }
    fs::create_dir_all(app.bridge.join("usage"))?;
    crate::instance::write_json(&app.bridge.join("usage/prices.json"), &book)?;
    Ok(metadata(&book))
}
pub fn background(app: std::sync::Arc<App>, book: &Value) {
    if !stale(book) {
        return;
    }
    static ACTIVE: OnceLock<Mutex<HashSet<std::path::PathBuf>>> = OnceLock::new();
    let active = ACTIVE.get_or_init(|| Mutex::new(HashSet::new()));
    if !active.lock().unwrap().insert(app.bridge.clone()) {
        return;
    }
    tokio::spawn(async move {
        let _ = refresh(&app).await;
        active.lock().unwrap().remove(&app.bridge);
    });
}
pub fn overrides(app: &App) -> io::Result<Value> {
    crate::config_store::read_json(&public_path(app).join("prices-overrides.json"))
}
