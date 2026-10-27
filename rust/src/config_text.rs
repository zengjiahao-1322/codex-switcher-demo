//! Lossless selection editing: tokenize complete statements and retain every
//! unmanaged statement verbatim, including its comments and newline convention.
use serde_json::{Value, json};
use std::io;

fn parse(text: &str) -> io::Result<toml::Value> {
    toml::from_str(text)
        .map_err(|_| io::Error::other("Invalid TOML configuration (details redacted)"))
}
fn statements(text: &str) -> Vec<&str> {
    let bytes = text.as_bytes();
    let (mut start, mut i, mut quote, mut multi, mut depth, mut comment) =
        (0, 0, 0u8, false, 0i32, false);
    let mut result = Vec::new();
    while i < bytes.len() {
        let c = bytes[i];
        if comment {
            if c != b'\n' {
                i += 1;
                continue;
            }
            comment = false;
        } else if quote != 0 {
            if quote == b'"' && c == b'\\' {
                i += 2;
                continue;
            }
            if multi {
                if bytes.get(i..i + 3) == Some(&[quote, quote, quote]) {
                    quote = 0;
                    multi = false;
                    i += 2;
                }
            } else if c == quote {
                quote = 0;
            }
            i += 1;
            continue;
        } else if c == b'"' || c == b'\'' {
            quote = c;
            multi = bytes.get(i..i + 3) == Some(&[c, c, c]);
            if multi {
                i += 2;
            }
            i += 1;
            continue;
        } else if c == b'#' {
            comment = true;
            i += 1;
            continue;
        } else if c == b'[' || c == b'{' {
            depth += 1;
        } else if c == b']' || c == b'}' {
            depth -= 1;
        }
        if c == b'\n' && depth == 0 && quote == 0 {
            result.push(&text[start..i + 1]);
            start = i + 1;
        }
        i += 1;
    }
    if start < text.len() {
        result.push(&text[start..]);
    }
    result
}
fn header(statement: &str) -> io::Result<Option<Vec<String>>> {
    if !statement.trim_start().starts_with('[') {
        return Ok(None);
    }
    let value = parse(statement)?;
    let mut current = &value;
    let mut keys = Vec::new();
    while let Some(table) = current.as_table().filter(|table| table.len() == 1) {
        let (key, value) = table.iter().next().unwrap();
        keys.push(key.clone());
        current = value;
    }
    Ok(Some(keys))
}
fn scalar(value: &Value) -> io::Result<String> {
    match value {
        Value::String(s) => Ok(serde_json::to_string(s).unwrap()),
        Value::Bool(_) | Value::Number(_) => Ok(value.to_string()),
        _ => Err(io::Error::other("Unsupported selection value")),
    }
}
pub fn edit(text: &str, selection: &Value, bridge: &Value) -> io::Result<String> {
    parse(text)?;
    let nl = if text.contains("\r\n") { "\r\n" } else { "\n" };
    let managed = regex::Regex::new(r#"^\s*(?:model|model_provider|model_catalog_json|"model"|"model_provider"|"model_catalog_json"|'model'|'model_provider'|'model_catalog_json')\s*="#).unwrap();
    let credentials = regex::Regex::new(r#"^\s*(?:cli_auth_credentials_store|"cli_auth_credentials_store"|'cli_auth_credentials_store')\s*="#).unwrap();
    let mut section = Vec::new();
    let mut body = String::new();
    for statement in statements(text) {
        if let Some(path) = header(statement)? {
            section = path;
        }
        if section.first().is_some_and(|s| s == "model_providers")
            && section.get(1).is_some_and(|s| s == "hermes_bridge")
        {
            continue;
        }
        if section.is_empty()
            && (managed.is_match(statement)
                || (selection.get("cli_auth_credentials_store").is_some()
                    && credentials.is_match(statement)))
        {
            continue;
        }
        body.push_str(statement);
    }
    let mut result = String::new();
    for key in [
        "model",
        "model_provider",
        "model_catalog_json",
        "cli_auth_credentials_store",
    ] {
        if let Some(value) = selection.get(key).filter(|v| !v.is_null()) {
            result.push_str(&format!("{key} = {}{nl}", scalar(value)?));
        }
    }
    result.push_str(&body);
    if bridge.is_object() {
        if !result.is_empty() && !result.ends_with('\n') {
            result.push_str(nl);
        }
        let section = toml::to_string(&json!({"model_providers":{"hermes_bridge":bridge}}))
            .map_err(io::Error::other)?;
        result.push_str(&section.replace('\n', nl));
    }
    parse(&result)?;
    Ok(result)
}
pub fn prepare(
    text: &str,
    provider: &Value,
    model: &str,
    catalog: Option<&str>,
) -> io::Result<String> {
    parse(text)?;
    if model.trim().is_empty()
        || provider["apiKey"]
            .as_str()
            .is_none_or(|s| s.trim().is_empty())
    {
        return Err(io::Error::other("Provider key and model are required"));
    }
    let url = reqwest::Url::parse(provider["baseUrl"].as_str().unwrap_or(""))
        .map_err(|_| io::Error::other("Invalid provider URL"))?;
    if !matches!(url.scheme(), "http" | "https")
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return Err(io::Error::other(
            "Provider URL must be HTTP(S) without userinfo",
        ));
    }
    edit(
        text,
        &json!({"model":model,"model_provider":"hermes_bridge","model_catalog_json":catalog}),
        &json!({"name":provider["name"].as_str().or(provider["id"].as_str()).unwrap_or(""),"base_url":provider["baseUrl"],"wire_api":"responses","experimental_bearer_token":provider["apiKey"],"requires_openai_auth":false}),
    )
}
pub fn official(
    text: &str,
    model: Option<&str>,
    catalog: Option<&str>,
    credentials: Option<&str>,
) -> io::Result<String> {
    if model.is_some_and(|s| s.len() > 200 || s.contains(['\r', '\n', '"'])) {
        return Err(io::Error::other("官方模型名称无效"));
    }
    let config = serde_json::to_value(parse(text)?).map_err(io::Error::other)?;
    let mut selection =
        json!({"model":model.filter(|s|!s.trim().is_empty()),"model_catalog_json":catalog});
    if let Some(store) = credentials {
        selection["cli_auth_credentials_store"] = json!(store);
    }
    edit(
        text,
        &selection,
        &config["model_providers"]["hermes_bridge"],
    )
}
pub fn fixture(input: &Value) -> io::Result<Value> {
    let text = input["text"].as_str().unwrap_or("");
    if input["method"] == "cleanup" {
        return Ok(match cleanup(text, input["catalog"].as_str()) {
            Ok(value) => value,
            Err(error) => json!({"error":error.to_string()}),
        });
    }
    let result = match input["method"].as_str().unwrap_or("prepare") {
        "prepare" => prepare(
            text,
            &input["provider"],
            input["model"].as_str().unwrap_or(""),
            input["catalog"].as_str(),
        ),
        "official" => official(
            text,
            input["model"].as_str(),
            input["catalog"].as_str(),
            input["credentials"].as_str(),
        ),
        _ => Err(io::Error::other("Unknown TOML fixture operation")),
    };
    Ok(match result {
        Ok(text) => json!({"text":text}),
        Err(error) => json!({"error":error.to_string()}),
    })
}
pub fn cleanup(text: &str, catalog: Option<&str>) -> io::Result<Value> {
    let config = serde_json::to_value(parse(text)?).map_err(io::Error::other)?;
    if config["model_provider"] == "hermes_bridge" {
        return Err(io::Error::other(
            "Codex 仍在使用本工具的配置，请先切回官方登录",
        ));
    }
    let own = catalog.is_some() && config["model_catalog_json"].as_str() == catalog;
    if config["model_providers"]["hermes_bridge"].is_null() && !own {
        return Ok(json!({"changed":false,"text":text}));
    }
    let next = edit(
        text,
        &json!({"model":config["model"],"model_provider":config["model_provider"],"model_catalog_json":if own {Value::Null}else{config["model_catalog_json"].clone()}}),
        &Value::Null,
    )?;
    Ok(json!({"changed":true,"text":next}))
}
