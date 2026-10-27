//! Compatible provider storage and read-only Hermes YAML discovery.
use crate::instance::write_json;
use serde_json::{Value, json};
use std::{fs, io, path::Path};

pub fn load(bridge: &Path) -> io::Result<Value> {
    let mut value = match fs::read(bridge.join("providers.json")) {
        Ok(bytes) => serde_json::from_slice::<Value>(&bytes)
            .map_err(|_| io::Error::other("providers.json 已损坏，请检查或删除后重试"))?,
        Err(e) if e.kind() == io::ErrorKind::NotFound => json!({}),
        Err(e) => return Err(e),
    };
    let mut providers = value["providers"]
        .as_array()
        .cloned()
        .unwrap_or_else(|| value["custom"].as_array().cloned().unwrap_or_default());
    if !value["providers"].is_array() {
        for p in &mut providers {
            p["origin"] = json!("custom");
        }
    }
    let skipped = value
        .get_mut("hiddenHermes")
        .map(Value::take)
        .unwrap_or_else(|| value["skippedHermes"].clone());
    Ok(
        json!({"providers":providers,"hermesImported":value["hermesImported"]==true,"skippedHermes":skipped.as_array().cloned().unwrap_or_default()}),
    )
}
pub fn save(bridge: &Path, value: &Value) -> io::Result<()> {
    write_json(&bridge.join("providers.json"), value)
}
fn string(value: &Value) -> String {
    match value {
        Value::String(s) => s.clone(),
        Value::Null => String::new(),
        _ => value.to_string(),
    }
}
pub fn clean(input: &Value, previous: &Value, allow_empty: bool) -> io::Result<Value> {
    let field = |key: &str| {
        input
            .get(key)
            .filter(|v| !v.is_null())
            .unwrap_or(&previous[key])
    };
    let name = string(field("name")).trim().to_string();
    if name.is_empty() || name.chars().count() > 60 {
        return Err(io::Error::other("名称必填，最多 60 个字符"));
    }
    let base = string(field("baseUrl"))
        .trim()
        .trim_end_matches('/')
        .to_string();
    let url = reqwest::Url::parse(&base).map_err(|_| io::Error::other("API 地址无效"))?;
    if !matches!(url.scheme(), "http" | "https")
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err(io::Error::other(
            "API 地址须为 http(s)，且不含用户名、密码、查询参数",
        ));
    }
    let mode = string(field("apiMode"));
    if !["responses", "chat_completions", "anthropic_messages"].contains(&mode.as_str()) {
        return Err(io::Error::other("协议类型无效"));
    }
    let model_values = field("models");
    let mut models = Vec::<String>::new();
    let candidates = if let Some(array) = model_values.as_array() {
        array.iter().map(string).collect()
    } else {
        regex::Regex::new(r"[,，\s]+")
            .unwrap()
            .split(&string(model_values))
            .map(str::to_owned)
            .collect::<Vec<_>>()
    };
    for item in candidates {
        let value = item.trim().to_string();
        if !value.is_empty() && !models.contains(&value) {
            models.push(value);
        }
    }
    let model = input
        .get("model")
        .or(previous.get("model"))
        .map(string)
        .unwrap_or_else(|| models.first().cloned().unwrap_or_default())
        .trim()
        .to_string();
    if model.is_empty() || model.chars().count() > 200 {
        return Err(io::Error::other("默认模型必填"));
    }
    if !models.contains(&model) {
        models.insert(0, model.clone());
    }
    if models.len() > 100 {
        return Err(io::Error::other("模型最多 100 个"));
    }
    let key = if input["apiKey"].as_str().is_none_or(|s| s.is_empty()) {
        string(&previous["apiKey"])
    } else {
        string(&input["apiKey"]).trim().to_string()
    };
    if (key.is_empty() && !allow_empty) || key.len() > 4096 || key.chars().any(char::is_whitespace)
    {
        return Err(io::Error::other("API 密钥必填，且不能含空白字符"));
    }
    Ok(
        json!({"name":name,"baseUrl":base,"apiMode":mode,"model":model,"models":models,"apiKey":key}),
    )
}
fn unique(state: &Value, name: &Value, except: &Value) -> io::Result<()> {
    if state["providers"]
        .as_array()
        .unwrap()
        .iter()
        .any(|p| p["id"] != *except && p["name"] == *name)
    {
        Err(io::Error::other("已有同名配置"))
    } else {
        Ok(())
    }
}
pub fn add(bridge: &Path, input: &Value) -> io::Result<Value> {
    let mut state = load(bridge)?;
    let mut p = clean(input, &Value::Null, false)?;
    unique(&state, &p["name"], &Value::Null)?;
    let random = crate::platform::random_bytes()?;
    let hex = random[..16]
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect::<String>();
    let id = format!(
        "bridge:{}-{}-{}-{}-{}",
        &hex[..8],
        &hex[8..12],
        &hex[12..16],
        &hex[16..20],
        &hex[20..]
    );
    p["id"] = json!(id);
    p["origin"] = json!("custom");
    p["createdAt"] = json!(crate::diagnostics::now());
    state["providers"].as_array_mut().unwrap().push(p);
    save(bridge, &state)?;
    Ok(json!({"id":id,"message":"已新增配置。可检测后应用到 Codex。"}))
}
pub fn update(bridge: &Path, input: &Value) -> io::Result<Value> {
    if input["id"] == "official" {
        return Err(io::Error::other("官方登录配置不能编辑"));
    }
    let mut state = load(bridge)?;
    let index = state["providers"]
        .as_array()
        .unwrap()
        .iter()
        .position(|p| p["id"] == input["id"])
        .ok_or_else(|| io::Error::other("配置不存在，请刷新页面"))?;
    let mut p = state["providers"][index].clone();
    let next = clean(input, &p, p["apiKey"].as_str().is_none_or(str::is_empty))?;
    unique(&state, &next["name"], &input["id"])?;
    p.as_object_mut()
        .unwrap()
        .extend(next.as_object().unwrap().clone());
    p["updatedAt"] = json!(crate::diagnostics::now());
    state["providers"][index] = p;
    save(bridge, &state)?;
    Ok(json!({"message":"已保存。"}))
}
pub fn remove(bridge: &Path, home: &Path, id: &Value) -> io::Result<Value> {
    if id == "official" {
        return Err(io::Error::other("官方登录配置不能删除"));
    }
    let mut state = load(bridge)?;
    let p = state["providers"]
        .as_array()
        .unwrap()
        .iter()
        .find(|p| p["id"] == *id)
        .cloned()
        .ok_or_else(|| io::Error::other("配置不存在，请刷新页面"))?;
    let config: toml::Value =
        toml::from_str(&fs::read_to_string(home.join("config.toml")).unwrap_or_default())
            .map_err(io::Error::other)?;
    let current: Value = read_json(&bridge.join("current.json"))?;
    if config.get("model_provider").and_then(|v| v.as_str()) == Some("hermes_bridge")
        && current["providerId"] == *id
    {
        return Err(io::Error::other(
            "该配置正在被 Codex 使用。请先切换到其他配置或官方登录，再删除。",
        ));
    }
    state["providers"]
        .as_array_mut()
        .unwrap()
        .retain(|p| p["id"] != *id);
    if p["origin"] == "hermes" && !state["skippedHermes"].as_array().unwrap().contains(id) {
        state["skippedHermes"]
            .as_array_mut()
            .unwrap()
            .push(id.clone());
    }
    save(bridge, &state)?;
    let mut adapter = read_json(&bridge.join("adapter.json"))?;
    let targeted = adapter["target"]["providerId"] == *id;
    if targeted {
        adapter["target"] = Value::Null;
        write_json(&bridge.join("adapter.json"), &adapter)?;
    }
    Ok(
        json!({"message":format!("已删除配置。{}",if targeted{"之前经它转换建立的 Codex 对话将无法继续。"}else{""})}),
    )
}
pub fn read_json(file: &Path) -> io::Result<Value> {
    match fs::read(file) {
        Ok(bytes) => serde_json::from_slice(&bytes).map_err(io::Error::other),
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(Value::Null),
        Err(e) => Err(e),
    }
}
pub fn discover(home: &Path) -> io::Result<Vec<Value>> {
    let source = fs::read_to_string(home.join("config.yaml"))?;
    let config: Value = serde_yaml::from_str(&source)
        .map_err(|_| io::Error::other("Invalid Hermes YAML configuration (details redacted)"))?;
    let env_text = match fs::read_to_string(home.join(".env")) {
        Ok(s) => s,
        Err(e) if e.kind() == io::ErrorKind::NotFound => String::new(),
        Err(e) => return Err(e),
    };
    let env_regex = regex::Regex::new(r"^\s*(?:export\s+)?(\w+)\s*=\s*(.*?)\s*$").unwrap();
    let var_regex = regex::Regex::new(r"\$\{(\w+)\}").unwrap();
    let comment = regex::Regex::new(r"\s+#.*$").unwrap();
    let mut env = std::collections::HashMap::new();
    for line in env_text.lines() {
        if let Some(c) = env_regex.captures(line) {
            let mut v = c[2].to_string();
            if (v.starts_with('"') && v.ends_with('"'))
                || (v.starts_with('\'') && v.ends_with('\''))
            {
                v = v[1..v.len() - 1].into();
            } else {
                v = comment.replace(&v, "").into_owned();
            }
            env.insert(c[1].to_string(), v);
        }
    }
    let resolve = |v: &Value| {
        var_regex
            .replace_all(&string(v), |c: &regex::Captures| {
                env.get(&c[1]).cloned().unwrap_or_default()
            })
            .into_owned()
    };
    let current = &config["model"];
    let mut entries = config["providers"].as_object().cloned().unwrap_or_default();
    if let Some(id) = current["provider"]
        .as_str()
        .filter(|id| !entries.contains_key(*id))
        && current["base_url"].is_string()
    {
        entries.insert(id.into(), current.clone());
    }
    let mut providers = Vec::new();
    for (id, p) in &entries {
        let active = current["provider"] == id.as_str();
        let model = if active && current["default"].is_string() {
            current["default"].clone()
        } else {
            p.get("model")
                .or(p.get("default"))
                .cloned()
                .unwrap_or(json!(""))
        };
        let mut models = p["models"].as_array().cloned().unwrap_or_else(|| {
            p["models"]
                .as_object()
                .map(|o| o.keys().map(|s| json!(s)).collect())
                .unwrap_or_default()
        });
        if model.as_str().is_some_and(|s| !s.is_empty()) && !models.contains(&model) {
            models.push(model.clone());
        }
        let fallback = if active { current } else { &Value::Null };
        providers.push(json!({
            "id":id, "name":p["name"].as_str().unwrap_or(id), "active":active,
            "baseUrl":resolve(p.get("base_url").unwrap_or(&fallback["base_url"])),
            "apiKey":resolve(p.get("api_key").unwrap_or(&fallback["api_key"])),
            "model":model, "models":models,
            "apiMode":p["api_mode"].as_str().or(fallback["api_mode"].as_str()).unwrap_or("responses")
        }));
    }
    Ok(providers)
}
pub fn import(bridge: &Path, home: &Path, auto: bool) -> io::Result<Value> {
    let mut state = load(bridge)?;
    if auto && state["hermesImported"] == true {
        return Ok(json!({"added":[],"failed":0}));
    }
    let mut added = Vec::new();
    let mut failed = 0;
    for p in discover(home)? {
        if state["providers"]
            .as_array()
            .unwrap()
            .iter()
            .any(|v| v["id"] == p["id"])
            || (auto
                && state["skippedHermes"]
                    .as_array()
                    .unwrap()
                    .contains(&p["id"]))
        {
            continue;
        }
        let Ok(mut next) = clean(&p, &Value::Null, true) else {
            failed += 1;
            continue;
        };
        let name = next["name"].as_str().unwrap().to_string();
        let mut suffix = 2;
        while state["providers"]
            .as_array()
            .unwrap()
            .iter()
            .any(|v| v["name"] == next["name"])
        {
            next["name"] = json!(format!("{name} ({suffix})"));
            suffix += 1;
        }
        next["id"] = p["id"].clone();
        next["origin"] = json!("hermes");
        next["createdAt"] = json!(crate::diagnostics::now());
        added.push(next["name"].clone());
        state["providers"].as_array_mut().unwrap().push(next);
    }
    let ids = state["providers"]
        .as_array()
        .unwrap()
        .iter()
        .map(|p| p["id"].clone())
        .collect::<Vec<_>>();
    state["skippedHermes"]
        .as_array_mut()
        .unwrap()
        .retain(|v| !ids.contains(v));
    state["hermesImported"] = json!(true);
    save(bridge, &state)?;
    Ok(json!({"added":added,"failed":failed}))
}
