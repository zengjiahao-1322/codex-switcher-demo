//! Companion heartbeat, remote command transport and independent remote switch.
use crate::{accounts, config_store, config_text, instance::write_json, server::App};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    fs, io,
    path::Path,
    sync::{Mutex, OnceLock},
    time::Duration,
};
use tokio::sync::oneshot;

struct Pending {
    command: Value,
    sender: oneshot::Sender<Result<Value, String>>,
}
static COMMANDS: OnceLock<Mutex<HashMap<String, Pending>>> = OnceLock::new();
fn commands() -> &'static Mutex<HashMap<String, Pending>> {
    COMMANDS.get_or_init(|| Mutex::new(HashMap::new()))
}
fn key(bridge: &Path, id: &str) -> String {
    format!("{}\0{id}", bridge.to_string_lossy())
}
fn digest(text: &str) -> String {
    format!("{:x}", Sha256::digest(text.as_bytes()))
}
fn write_command(bridge: &Path, id: &str, command: Option<Value>) -> io::Result<()> {
    let file = bridge.join("clients").join(format!("{id}.json"));
    let mut row = match fs::read(&file) {
        Ok(bytes) => serde_json::from_slice::<Value>(&bytes).unwrap_or(json!({})),
        Err(_) => json!({}),
    };
    row["command"] = command.unwrap_or(Value::Null);
    write_json(&file, &row)
}
fn request_id(bridge: &Path) -> String {
    let bytes = crate::platform::random_bytes().unwrap_or([0; 32]);
    format!(
        "remote-{}-{:x}",
        std::process::id(),
        Sha256::digest([bridge.to_string_lossy().as_bytes(), &bytes].concat())
    )[..40]
        .to_owned()
}
pub fn command(bridge: &Path, id: &str) -> Option<Value> {
    commands()
        .lock()
        .unwrap()
        .get(&key(bridge, id))
        .map(|p| p.command.clone())
}
pub fn acknowledge(bridge: &Path, input: &Value) -> Option<Value> {
    let id = input["id"].as_str()?;
    let ack = input["ack"].as_str()?;
    let k = key(bridge, id);
    let pending = commands().lock().unwrap().remove(&k)?;
    if pending.command["id"] != ack {
        return None;
    }
    let failed = input["ackStatus"] != "completed";
    let result = if failed {
        Err(input["ackError"]
            .as_str()
            .unwrap_or("远端命令执行失败")
            .to_owned())
    } else {
        Ok(input["ackResult"].clone())
    };
    let _ = write_command(bridge, id, None);
    if let Ok(file) = fs::read(bridge.join("clients").join(format!("{id}.json")))
        && let Ok(mut row) = serde_json::from_slice::<Value>(&file)
    {
        row["lastAck"] = json!({"id":ack,"status":if failed{"failed"}else{"completed"},"error":if failed{input["ackError"].clone()}else{Value::Null}});
        let _ = write_json(&bridge.join("clients").join(format!("{id}.json")), &row);
    }
    let _ = pending.sender.send(result);
    Some(json!({"id":ack,"status":if failed{"failed"}else{"completed"},"remote":true}))
}
async fn dispatch(bridge: &Path, id: &str, mut fields: Value) -> Result<Value, String> {
    fields["id"] = json!(request_id(bridge));
    let (sender, receiver) = oneshot::channel();
    let command = fields.clone();
    commands().lock().unwrap().insert(
        key(bridge, id),
        Pending {
            command: fields,
            sender,
        },
    );
    let _ = write_command(bridge, id, Some(command));
    match tokio::time::timeout(Duration::from_secs(30), receiver).await {
        Ok(Ok(v)) => v,
        Ok(Err(_)) => Err("远端命令已取消".into()),
        Err(_) => {
            commands().lock().unwrap().remove(&key(bridge, id));
            let _ = write_command(bridge, id, None);
            Err("等待远端窗口确认命令超时".into())
        }
    }
}
fn records(bridge: &Path) -> Vec<Value> {
    let Ok(entries) = fs::read_dir(bridge.join("clients")) else {
        return vec![];
    };
    entries
        .flatten()
        .filter_map(|e| {
            fs::read(e.path())
                .ok()
                .and_then(|b| serde_json::from_slice(&b).ok())
        })
        .collect()
}
fn source_provider(bridge: &Path, id: &str) -> io::Result<Value> {
    let value = config_store::load(bridge)?;
    value["providers"]
        .as_array()
        .or(value["custom"].as_array())
        .and_then(|a| a.iter().find(|p| p["id"] == id).cloned())
        .ok_or_else(|| io::Error::other("请选择已保存的自定义 API"))
}
fn authority(input: &Value) -> io::Result<&str> {
    let value = input["authority"].as_str().unwrap_or("");
    if regex::Regex::new(r"^ssh-remote\+[^\s/\\?#]{1,240}$")
        .unwrap()
        .is_match(value)
    {
        Ok(value)
    } else {
        Err(io::Error::other("请选择已连接的 Remote-SSH 服务器"))
    }
}
pub async fn remote_switch(app: std::sync::Arc<App>, input: &Value) -> io::Result<Value> {
    let authority = authority(input)?;
    let provider_id = input["providerId"].as_str();
    let account_id = input["accountId"].as_str();
    if provider_id.is_some() == account_id.is_some() {
        return Err(io::Error::other("请选择一个官方账号或自定义 API"));
    }
    let provider = provider_id
        .map(|id| source_provider(&app.bridge, id))
        .transpose()?;
    if let Some(p) = &provider
        && p["apiKey"].as_str().unwrap_or("").is_empty()
    {
        return Err(io::Error::other("请选择已确认可直连且有密钥的自定义 API"));
    }
    let model = input["model"].as_str().unwrap_or("");
    if provider.is_some() && model.trim().is_empty() {
        return Err(io::Error::other("请选择或填写模型"));
    }
    let targets = records(&app.bridge)
        .into_iter()
        .filter(|r| {
            r["remoteType"] == "ssh-remote"
                && r["authority"] == authority
                && r["remoteAgent"]["protocol"].as_u64().unwrap_or(0) >= 3
                && r["remoteAgent"]["agentVersion"] == r["companionVersion"]
        })
        .collect::<Vec<_>>();
    if targets.is_empty() {
        return Ok(json!({"results":[]}));
    }
    let mut result = Vec::new();
    let mut homes = std::collections::HashSet::new();
    for row in targets {
        let id = row["id"].as_str().unwrap();
        let home = row["remoteAgent"]["codexHome"].as_str().unwrap_or("");
        if !homes.insert(home.to_owned()) {
            continue;
        }
        let read = dispatch(&app.bridge, id, json!({"type":"remoteApply","step":"read"}))
            .await
            .map_err(io::Error::other)?;
        let text = read["text"]
            .as_str()
            .ok_or_else(|| io::Error::other("远端配置读取结果无效"))?;
        if read["sha256"] != digest(text) {
            return Err(io::Error::other("远端配置读取结果或校验值无效"));
        }
        let next = if let Some(p) = &provider {
            config_text::prepare(text, p, model, None).map_err(io::Error::other)?
        } else {
            let _auth =
                accounts::saved_auth(&app.bridge, account_id.unwrap()).map_err(io::Error::other)?;
            config_text::official(text, None, None, Some("file")).map_err(io::Error::other)?
        };
        let written=dispatch(&app.bridge,id,json!({"type":"remoteApply","step":"write","text":next,"expectedSha256":digest(text),"reload":true})).await.map_err(io::Error::other)?;
        if written["ok"] != true || written["sha256"] != digest(&next) {
            return Err(io::Error::other("远端未确认写入目标配置"));
        }
        result.push(json!({"codexHome":home,"status":"synced"}));
    }
    Ok(json!({"results":result}))
}
pub async fn action(app: std::sync::Arc<App>, action: &str, input: &Value) -> io::Result<Value> {
    match action {
        "desktopSwitch" => crate::config_ops::action(&app, "switch", input).await,
        "resumeThreadSync" => Err(io::Error::other("没有待继续的旧对话同步任务。")),
        "reloadClients" => {
            let id = input["id"].as_str();
            let mut count = 0;
            for entry in fs::read_dir(app.bridge.join("clients"))?.flatten() {
                if let Ok(bytes) = fs::read(entry.path())
                    && let Ok(mut row) = serde_json::from_slice::<Value>(&bytes)
                    && (id.is_none() || row["id"].as_str() == id)
                {
                    row["command"] = json!({"id":request_id(&app.bridge),"type":"reload","at":crate::diagnostics::now()});
                    write_json(&entry.path(), &row)?;
                    count += 1;
                }
            }
            Ok(
                json!({"count":count,"message":format!("已向 {count} 个已接入的编辑器窗口发送重载请求。")}),
            )
        }
        "remoteSwitch" => remote_switch(app, input).await,
        _ => Err(io::Error::other("Unsupported switching action")),
    }
}
