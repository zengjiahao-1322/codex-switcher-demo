//! Configuration: read-only prototype state; editing/providers/backups pending batch 2.
use std::{fs,io,path::PathBuf};
use serde_json::{json,Value};
use crate::{server::App,accounts::claims};
fn json_file(path: PathBuf) -> io::Result<Value> {
    match fs::read(path) {
        Ok(bytes) => serde_json::from_slice(&bytes).map_err(io::Error::other),
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(Value::Null),
        Err(e) => Err(e),
    }
}

impl App {
    pub(crate) fn state(&self)->io::Result<Value> {
        let text=fs::read_to_string(self.home.join("config.toml"))?;
        let config:toml::Value=toml::from_str(&text).map_err(io::Error::other)?;
        let auth=json_file(self.home.join("auth.json"))?;
        let id=claims(auth["tokens"]["id_token"].as_str().unwrap_or(""));
        let access=claims(auth["tokens"]["access_token"].as_str().unwrap_or(""));
        let email=id["email"].as_str().or(access["https://api.openai.com/profile"]["email"].as_str()).unwrap_or("");
        let provider=config.get("model_provider").and_then(|v|v.as_str()).unwrap_or("openai");
        let index=json_file(self.bridge.join("accounts").join("index.json"))?;
        let count=index.as_array().map_or(0,Vec::len);
        let official=provider=="openai";
        let name=if official {if email.is_empty(){"Codex 官方（ChatGPT 登录）".to_string()} else {format!("官方 · {email}")}} else {format!("其他供应商 {provider}")};
        let plan=access["https://api.openai.com/auth"]["chatgpt_plan_type"].as_str().unwrap_or("unknown");
        Ok(json!({"current":{"official":official,"viaAdapter":false,"model":config.get("model").and_then(|v|v.as_str()),"name":name}, "accountCount":count,"account":{"email":email,"plan":plan}}))
    }
}
