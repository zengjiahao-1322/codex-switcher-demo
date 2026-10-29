//! Configuration state assembled from compatible provider storage and disk files.
use crate::{accounts::claims, server::App};
use serde_json::{Value, json};
use std::{
    fs, io,
    path::{Path, PathBuf},
    sync::{Mutex, OnceLock},
    time::{Duration, Instant},
};
struct Version {
    exe: PathBuf,
    at: Instant,
    value: Option<String>,
}
fn codex_version(bridge: &Path, exe: PathBuf) -> Option<String> {
    static VERSION: OnceLock<Mutex<Option<Version>>> = OnceLock::new();
    let mut cache = VERSION.get_or_init(|| Mutex::new(None)).lock().unwrap();
    if let Some(previous) = cache.as_ref()
        && previous.exe == exe
        && previous.at.elapsed() < Duration::from_secs(60)
    {
        return previous.value.clone();
    }
    let at = Instant::now();
    let value = crate::platform::codex_version(bridge).ok();
    *cache = Some(Version {
        exe,
        at,
        value: value.clone(),
    });
    value
}
fn json_file(path: PathBuf) -> io::Result<Value> {
    match fs::read(path) {
        Ok(bytes) => serde_json::from_slice(&bytes).map_err(io::Error::other),
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(Value::Null),
        Err(e) => Err(e),
    }
}

impl App {
    pub(crate) fn codex_home(&self) -> PathBuf {
        json_file(self.bridge.join("settings.json"))
            .ok()
            .and_then(|v| v["codexHome"].as_str().map(PathBuf::from))
            .unwrap_or_else(|| self.home.clone())
    }
    pub(crate) fn state(&self) -> io::Result<Value> {
        if let Some(home) = std::env::var_os("BRIDGE_HERMES_HOME")
            .map(PathBuf::from)
            .filter(|p| p.join("config.yaml").is_file())
        {
            crate::config_store::import(&self.bridge, &home, true)?;
        }
        let home = self.codex_home();
        let text = match fs::read_to_string(home.join("config.toml")) {
            Ok(text) => text,
            Err(error) if error.kind() == io::ErrorKind::NotFound => String::new(),
            Err(error) => return Err(error),
        };
        let config: toml::Value = toml::from_str(&text).map_err(io::Error::other)?;
        let auth = json_file(home.join("auth.json"))?;
        let id = claims(auth["tokens"]["id_token"].as_str().unwrap_or(""));
        let access = claims(auth["tokens"]["access_token"].as_str().unwrap_or(""));
        let email = id["email"]
            .as_str()
            .or(access["https://api.openai.com/profile"]["email"].as_str())
            .unwrap_or("");
        let provider = config
            .get("model_provider")
            .and_then(|v| v.as_str())
            .unwrap_or("openai");
        let index = json_file(self.bridge.join("accounts").join("index.json"))?;
        let count = index.as_array().map_or(0, Vec::len);
        let official = provider == "openai";
        let store = crate::config_store::load(&self.bridge)?;
        let saved = store["providers"]
            .as_array()
            .or(store["custom"].as_array())
            .cloned()
            .unwrap_or_default();
        let selected = json_file(self.bridge.join("current.json"))?;
        let name = if official {
            if email.is_empty() {
                "Codex 官方（ChatGPT 登录）".to_string()
            } else {
                format!("官方 · {email}")
            }
        } else if provider == "hermes_bridge" {
            saved
                .iter()
                .find(|p| p["id"] == selected["providerId"])
                .and_then(|p| p["name"].as_str())
                .or(config
                    .get("model_providers")
                    .and_then(|p| p.get("hermes_bridge"))
                    .and_then(|p| p.get("name"))
                    .and_then(|p| p.as_str()))
                .unwrap_or("切换器配置")
                .to_string()
        } else {
            format!("其他供应商 {provider}")
        };
        let plan = access["https://api.openai.com/auth"]["chatgpt_plan_type"]
            .as_str()
            .unwrap_or("unknown");
        let model = config.get("model").and_then(|v| v.as_str());
        let cache = json_file(home.join("models_cache.json"))?;
        let mut models = cache["models"]
            .as_array()
            .map(|rows| {
                rows.iter()
                    .filter(|p| p["visibility"] != "hide")
                    .filter_map(|p| p["slug"].as_str().map(str::to_owned))
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        let official_model = if official {
            model.map(str::to_owned)
        } else {
            let original = fs::read_to_string(self.bridge.join("original-config.toml"))
                .ok()
                .and_then(|s| toml::from_str::<toml::Value>(&s).ok());
            original.and_then(|v| v.get("model").and_then(|m| m.as_str()).map(str::to_owned))
        }
        .or_else(|| models.first().cloned());
        if let Some(model) = &official_model {
            models.retain(|v| v != model);
            models.insert(0, model.clone());
        }
        let login = if auth.is_null() {
            Value::Null
        } else if auth["auth_mode"] == "chatgpt" || auth["tokens"].is_object() {
            json!("chatgpt")
        } else if auth["OPENAI_API_KEY"]
            .as_str()
            .is_some_and(|s| !s.is_empty())
        {
            json!("apikey")
        } else {
            Value::Null
        };
        let mut providers = vec![json!({
            "id":"official",
            "name":if official{&name}else{
                "Codex 官方（ChatGPT 登录）"
            },
            "source":"official",
            "baseUrl":format!("Codex 官方服务 · {}",match login.as_str(){Some("chatgpt")=>"已用 ChatGPT 账号登录",Some("apikey")=>"使用 OpenAI API Key",_=>"未检测到登录，请在 Codex 中登录"}),
            "apiMode":"responses",
            "model":official_model,
            "models":models,
            "login":login,
            "inUse":official,
            "access":{
                "mode":"official"
            },
            "local":false
        })];
        use sha2::{Digest, Sha256};
        let probes = json_file(self.bridge.join("probe-results.json"))?;
        for p in &saved {
            let mut public = p.clone();
            let object = public
                .as_object_mut()
                .ok_or_else(|| io::Error::other("providers.json 已损坏，请检查或删除后重试"))?;
            object.insert(
                "source".into(),
                json!(if p["origin"] == "hermes" {
                    "hermes"
                } else {
                    "custom"
                }),
            );
            for key in ["apiKey", "createdAt", "updatedAt", "origin"] {
                object.remove(key);
            }
            let probe = &probes[p["id"].as_str().unwrap_or("")];
            let signature = format!(
                "{:x}",
                Sha256::digest(
                    serde_json::to_vec(&json!([p["baseUrl"], p["apiMode"], p["apiKey"]])).unwrap()
                )
            );
            let access = if probe["sig"] == signature[..16] {
                json!({"mode":probe["mode"],"model":probe["model"],"at":probe["at"],"message":probe["message"]})
            } else {
                json!({"mode":"unknown"})
            };
            object.insert(
                "hasKey".into(),
                json!(p["apiKey"].as_str().is_some_and(|s| !s.is_empty())),
            );
            object.insert(
                "inUse".into(),
                json!(provider == "hermes_bridge" && p["id"] == selected["providerId"]),
            );
            object.insert("access".into(), access);
            let base = p["baseUrl"].as_str().unwrap_or("");
            let host = base
                .split("://")
                .nth(1)
                .unwrap_or("")
                .split('/')
                .next()
                .unwrap_or("");
            object.insert(
                "local".into(),
                json!(
                    host == "localhost"
                        || host.starts_with("localhost:")
                        || host == "127.0.0.1"
                        || host.starts_with("127.0.0.1:")
                        || host.starts_with("[::1]")
                ),
            );
            providers.push(public);
        }
        let catalog_file = config.get("model_catalog_json").and_then(|v| v.as_str());
        let catalog = catalog_file
            .map(|s| json_file(home.join(s)))
            .transpose()?
            .unwrap_or(Value::Null);
        let catalog_models = catalog["models"].as_array();
        let adapter = json_file(self.bridge.join("adapter.json"))?;
        let via_adapter = provider == "hermes_bridge"
            && config
                .get("model_providers")
                .and_then(|p| p.get("hermes_bridge"))
                .and_then(|p| p.get("base_url"))
                .and_then(|p| p.as_str())
                .is_some_and(|s| s.starts_with(&format!("http://127.0.0.1:{}/", adapter["port"])));
        let runtime = crate::platform::codex_path(&self.bridge);
        let environment = match &runtime {
            Ok(path) => json!({"codexTrusted":crate::platform::trusted_codex(path)}),
            Err(error) => json!({"codexTrusted":false,"error":error.to_string()}),
        };
        let version = runtime
            .ok()
            .and_then(|exe| codex_version(&self.bridge, exe));
        let effect = json_file(self.bridge.join("effect.json"))?;
        let effect = if effect["configHash"].as_str()
            == Some(format!("{:x}", Sha256::digest(text.as_bytes())).as_str())
        {
            effect
        } else {
            Value::Null
        };
        let build = crate::instance::runtime();
        Ok(json!({
            "build":build,
            "update":crate::update::snapshot(self),
            "dataDirProtection":self.protection,
            "migrated":crate::migration::summary(&self.bridge)?,
            "environment":environment,
            "current":{
                "official":official,
                "viaAdapter":via_adapter,
                "model":model,
                "name":name
            },
            "providers":providers,
            "catalog":{
                "selected":catalog_file.is_some(),
                "readable":catalog_models.is_some(),
                "count":catalog_models.map_or(0,Vec::len),
                "containsCurrent":catalog_models.is_some_and(|rows|rows.iter().any(|m|m["slug"].as_str()==model))
            },
            "usage":{
                "mode":if official{
                    "official"
                }else{
                    "custom_api"
                },
                "notice":if official{
                    ""
                }else{
                    "当前为 API 模式，适用于 Codex。聊天 / Work 或部分官方旧会话无法加载时，请选择官方账号并切换。"
                }
            },
            "adapter":{
                "port":adapter["port"].as_u64().unwrap_or(self.port as u64),
                "ready":false,
                "autostart":crate::integration::startup_file().exists()
            },
            "mcp":{
                "installed":config.get("mcp_servers").and_then(|p|p.get("api_switcher")).is_some()
            },
            "hermesAvailable":std::env::var_os("BRIDGE_HERMES_HOME").is_some_and(|p|std::path::PathBuf::from(p).join("config.yaml").exists()),
            "notice":null,
            "effect":effect,
            "codexVersion":version,
            "codexFound":version.is_some(),
            "accountCount":count,
            "account":{
                "email":email,
                "plan":plan
            }
        }))
    }
}
