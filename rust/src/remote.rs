//! Remote commands use companion HTTP heartbeats. No remote configuration or
//! credential body is stored in the window registry, job files, or logs.
use crate::{
    accounts,
    diagnostics::log,
    editors::{self, Pending, millis, text},
    server::App,
};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{io, path::Path, sync::Arc, time::Duration};
use tokio::sync::oneshot;
fn digest(text: &str) -> String {
    format!("{:x}", Sha256::digest(text.as_bytes()))
}
struct Dispatch {
    app: Arc<App>,
    id: String,
    command: Value,
}
impl Drop for Dispatch {
    fn drop(&mut self) {
        let mut pending = self.app.editors.pending.lock().unwrap();
        if pending
            .get(&self.id)
            .is_some_and(|p| p.command["id"] == self.command["id"])
        {
            pending.remove(&self.id);
        }
    }
}
pub async fn dispatch(
    app: Arc<App>,
    id: &str,
    mut fields: Value,
    timeout: u64,
) -> io::Result<Value> {
    fields["id"] = json!(editors::uuid()?);
    let (sender, receiver) = oneshot::channel();
    {
        let mut pending = app.editors.pending.lock().unwrap();
        if pending.contains_key(id) {
            return Err(io::Error::other("该窗口正在执行另一项远程命令"));
        }
        pending.insert(
            id.into(),
            Pending {
                command: fields.clone(),
                sender,
            },
        );
    }
    let _guard = Dispatch {
        app: app.clone(),
        id: id.into(),
        command: fields,
    };
    editors::wake(&app);
    tokio::time::timeout(Duration::from_secs(timeout), receiver)
        .await
        .map_err(|_| io::Error::other("等待远端窗口确认命令超时"))?
        .map_err(io::Error::other)?
        .map_err(io::Error::other)
}
pub fn groups(bridge: &Path) -> io::Result<Vec<Value>> {
    let saved = accounts::read(&bridge.join("accounts/index.json"), json!([]))?;
    let known = saved
        .as_array()
        .into_iter()
        .flatten()
        .map(|v| v["id"].clone())
        .collect::<Vec<_>>();
    let mut found = Vec::<Value>::new();
    for row in editors::records(bridge)? {
        if !row["authority"].is_string() {
            continue;
        }
        let agent = &row["remoteAgent"];
        let index = found.iter().position(|g| {
            g["authority"] == row["authority"] && g["codexHome"] == agent["codexHome"]
        });
        let index = match index {
            Some(v) => v,
            None => {
                let mut account = agent["account"].clone();
                if account.is_object() && !known.contains(&account["id"]) {
                    account["id"] = Value::Null;
                }
                found.push(json!({"authority":row["authority"],"codexHome":agent["codexHome"],"host":agent["host"].as_str().unwrap_or(text(&row["authority"]).trim_start_matches("ssh-remote+")),"platform":agent["platform"],"arch":agent["arch"],"agentVersion":agent["agentVersion"],"agentProtocol":agent["protocol"].as_u64().unwrap_or(0),"current":agent["current"],"account":account,"windows":[]}));
                found.len() - 1
            }
        };
        found[index]["windows"].as_array_mut().unwrap().push(json!({"id":row["id"],"name":row["name"],"workspace":row["workspace"],"agentVersion":agent["agentVersion"],"agentProtocol":agent["protocol"].as_u64().unwrap_or(0),"companionVersion":row["companionVersion"],"remoteAgentState":row["remoteAgentState"],"installStatus":row["lastAck"]["installStatus"]}));
    }
    Ok(found)
}
fn window(bridge: &Path, group: &Value) -> io::Result<Option<Value>> {
    Ok(editors::records(bridge)?.into_iter().find(|r| {
        r["authority"] == group["authority"]
            && r["remoteType"] == "ssh-remote"
            && r["remoteAgent"]["codexHome"] == group["codexHome"]
            && r["remoteAgent"]["agentVersion"] == r["companionVersion"]
            && r["remoteAgent"]["protocol"].as_u64().unwrap_or(0) >= 3
    }))
}
fn path(group: &Value, name: &str) -> String {
    format!(
        "{}{}{}",
        text(&group["codexHome"]).trim_end_matches(['\\', '/']),
        if group["platform"] == "win32" {
            '\\'
        } else {
            '/'
        },
        name
    )
}
pub fn source(input: &Value) -> io::Result<&str> {
    let value = input["source"].as_str().unwrap_or("web");
    if ["web", "vscode-local", "vscode-ssh"].contains(&value) {
        Ok(value)
    } else {
        Err(io::Error::other("切换来源无效"))
    }
}
fn redact(error: &str, secrets: &[String]) -> String {
    let mut reason = error.to_owned();
    for secret in secrets {
        if !secret.is_empty() {
            reason = reason.replace(secret, "[已隐藏]");
        }
    }
    crate::diagnostics::redact(&json!(reason))
        .as_str()
        .unwrap()
        .to_owned()
}
fn auth_secrets(auth: &Value) -> Vec<String> {
    auth["tokens"]
        .as_object()
        .into_iter()
        .flat_map(|o| o.values())
        .filter_map(|v| v.as_str().map(str::to_owned))
        .collect()
}
async fn read_auth(app: Arc<App>, id: &str) -> io::Result<Value> {
    let value = dispatch(app, id, json!({"type":"remoteApply","step":"readAuth"}), 30).await?;
    let Some(body) = value["text"].as_str() else {
        return Err(io::Error::other("远端登录读取结果或校验值无效"));
    };
    if value["sha256"] != digest(body) {
        return Err(io::Error::other("远端登录读取结果或校验值无效"));
    }
    let auth = if body.is_empty() {
        Value::Null
    } else {
        serde_json::from_str(body)
            .map_err(|_| io::Error::other("远端auth.json无法解析，未修改登录"))?
    };
    Ok(json!({"text":body,"sha256":value["sha256"],"auth":auth}))
}
fn install_status(app: &App, id: &str, status: &str) -> io::Result<()> {
    let file = app.bridge.join("clients").join(format!("{id}.json"));
    let mut row = accounts::read(&file, Value::Null)?;
    if row["lastAck"].is_object() {
        row["lastAck"]["installStatus"] = json!(status);
        crate::instance::write_json(&file, &row)?;
    }
    Ok(())
}
pub fn mark_reload(app: Arc<App>, id: &str, mut target: Value) -> io::Result<()> {
    target["clientId"] = json!(id);
    let id = id.to_owned();
    if target["kind"] == "install" {
        install_status(&app, &id, "installed")?;
    }
    app.editors
        .reloads
        .lock()
        .unwrap()
        .insert(id.clone(), target.clone());
    tokio::spawn(async move {
        tokio::time::sleep(Duration::from_secs(120)).await;
        let pending = {
            let mut reloads = app.editors.reloads.lock().unwrap();
            if reloads.get(&id) == Some(&target) {
                reloads.remove(&id)
            } else {
                None
            }
        };
        if let Some(target) = pending
            && let Err(e) = record_reload(&app, &target, false, "120秒内未确认重载")
        {
            eprintln!("Remote reload timeout log failed: {e}");
        }
    });
    Ok(())
}
fn record_reload(app: &App, target: &Value, confirmed: bool, reason: &str) -> io::Result<()> {
    let install = target["kind"] == "install";
    if install {
        install_status(
            app,
            text(&target["clientId"]),
            if confirmed { "active" } else { "notActive" },
        )?;
    }
    log(
        &app.bridge,
        if install {
            "remote.install"
        } else {
            "remote.reload"
        },
        json!({"host":target["host"],"codexHome":target["codexHome"],"source":target["source"].as_str().unwrap_or("web"),"status":if install{if confirmed{"active"}else{"notActive"}}else if confirmed{"confirmed"}else{"failed"},"from":target["from"],"to":target["to"],"method":target["method"],"reason":if reason.is_empty(){target["reason"].clone()}else{json!(reason)},"elapsedMs":millis().saturating_sub(target["requestedAt"].as_u64().unwrap_or(millis()))}),
    )
}
pub fn confirm(app: &App, input: &Value) -> io::Result<bool> {
    let completed = &input["completedReload"];
    let old = completed["clientId"].as_str().unwrap_or(text(&input["id"]));
    let target = app.editors.reloads.lock().unwrap().get(old).cloned();
    let Some(target) = target else {
        return Ok(false);
    };
    let matched = input["authority"] == target["authority"]
        && (target["codexHome"].is_null()
            || input["remoteAgent"]["codexHome"] == target["codexHome"])
        && input["remoteAgent"]["agentVersion"] == input["companionVersion"]
        && input["remoteAgent"]["protocol"].as_u64().unwrap_or(0) >= 3;
    let restarted = target["method"] == "remoteHostExit"
        && time::OffsetDateTime::parse(
            text(&input["remoteAgent"]["startedAt"]),
            &time::format_description::well_known::Rfc3339,
        )
        .ok()
        .is_some_and(|v| {
            v.unix_timestamp_nanos() / 1_000_000
                > i128::from(target["requestedAt"].as_u64().unwrap_or(u64::MAX))
        });
    if matched && (completed.is_object() || restarted) {
        app.editors.reloads.lock().unwrap().remove(old);
        record_reload(app, &target, true, "")?;
        return Ok(true);
    }
    if input["ackStatus"] == "reload_failed" {
        app.editors.reloads.lock().unwrap().remove(old);
        record_reload(app, &target, false, text(&input["ackError"]))?;
    }
    Ok(false)
}
pub async fn apply(app: Arc<App>, input: &Value) -> io::Result<Value> {
    let origin = source(input)?;
    let authority = text(&input["authority"]);
    if !regex::Regex::new(r"^ssh-remote\+[^\s/\\?#]{1,240}$")
        .unwrap()
        .is_match(authority)
    {
        return Err(io::Error::other("请选择已连接的 Remote-SSH 服务器"));
    }
    let account = input["accountId"].as_str();
    let provider = input["providerId"].as_str();
    if account.is_some() == provider.is_some() {
        return Err(io::Error::other("请选择一个官方账号或自定义 API"));
    }
    let (auth, p, catalog) = if let Some(id) = account {
        let auth = accounts::saved_auth(&app.bridge, id)?;
        if accounts::identity(&auth).is_none_or(|v| v["id"] != id) {
            return Err(io::Error::other("官方账号登录记录不完整"));
        }
        (auth, Value::Null, None)
    } else {
        let id = provider.unwrap();
        if id == "official" {
            return Err(io::Error::other("请选择一个已保存的官方账号"));
        }
        let store = crate::config_store::load(&app.bridge)?;
        let p = store["providers"]
            .as_array()
            .unwrap()
            .iter()
            .find(|p| p["id"] == id)
            .cloned()
            .ok_or_else(|| io::Error::other("配置不存在"))?;
        if crate::config_ops::access(&app.bridge, &p)? != "direct" || text(&p["apiKey"]).is_empty()
        {
            return Err(io::Error::other("请选择已确认可直连且有密钥的自定义 API"));
        }
        let model = text(&input["model"]);
        if model.trim().is_empty() || model.len() > 200 {
            return Err(io::Error::other("请选择或填写模型"));
        }
        let catalog = crate::config_catalog::build(&app.codex_home(), &p, model)
            .await?
            .map(|v| serde_json::to_string_pretty(&v).unwrap());
        (Value::Null, p, catalog)
    };
    let groups = groups(&app.bridge)?
        .into_iter()
        .filter(|g| g["authority"] == authority)
        .collect::<Vec<_>>();
    if groups.is_empty() {
        return Err(io::Error::other("这台服务器当前没有已连接的窗口"));
    }
    let mut jobs = vec![];
    for group in groups {
        let app = app.clone();
        let auth = auth.clone();
        let p = p.clone();
        let catalog = catalog.clone();
        let model = input["model"].clone();
        let origin = origin.to_owned();
        jobs.push(tokio::spawn(async move {
            apply_group(app, group, auth, p, catalog, model, &origin).await
        }));
    }
    let mut results = vec![];
    for job in jobs {
        results.push(job.await.map_err(io::Error::other)??);
    }
    if let Some(id) = account {
        observe_id(app, id);
    }
    Ok(json!({"results":results}))
}
pub async fn install(app: Arc<App>, input: &Value) -> io::Result<Value> {
    use base64::{Engine, engine::general_purpose::STANDARD};
    let id = text(&input["id"]);
    let row = editors::records(&app.bridge)?
        .into_iter()
        .find(|r| r["id"] == id && r["remoteType"] == "ssh-remote")
        .ok_or_else(|| io::Error::other("请选择已连接的 Remote-SSH 窗口"))?;
    if row["remoteProtocol"] != 1 {
        return Err(io::Error::other("请先更新本机伴随扩展并重载这个窗口"));
    }
    let host = row["remoteAgent"]["host"]
        .as_str()
        .unwrap_or(text(&row["authority"]));
    let version = crate::instance::runtime()["version"].clone();
    let result = async {
        let archive = crate::server::extension_archive(&app, true)?;
        let result = dispatch(app.clone(), id, json!({"type":"installRemoteAgent","base64":STANDARD.encode(archive),"reload":true}),60).await?;
        if result["installed"] != true { return Err(io::Error::other("编辑器未确认远端代理安装成功")); }
        mark_reload(app.clone(),id,json!({"kind":"install","host":host,"authority":row["authority"],"codexHome":row["remoteAgent"]["codexHome"],"from":row["remoteAgent"]["agentVersion"],"to":version,"companionVersion":version,"requestedAt":millis(),"method":result["reload"]["method"].as_str().unwrap_or("remoteHostExit"),"reason":result["reload"]["reason"]}))?;
        Ok::<_,io::Error>(result)
    }.await;
    log(
        &app.bridge,
        "remote.install",
        json!({"host":host,"from":row["remoteAgent"]["agentVersion"],"to":version,"status":if result.is_ok(){"installed"}else{"failed"},"reason":result.as_ref().err().map(|e|redact(&e.to_string(),&[]))}),
    )?;
    result
}
async fn apply_group(
    app: Arc<App>,
    group: Value,
    auth: Value,
    p: Value,
    catalog: Option<String>,
    model: Value,
    origin: &str,
) -> io::Result<Value> {
    let started = std::time::Instant::now();
    let mut result = json!({"codexHome":group["codexHome"],"status":"skipped"});
    let skip = if group["agentVersion"].is_null() {
        Some("尚未接入远端代理")
    } else if window(&app.bridge, &group)?.is_none() {
        Some("请更新远端代理，使其版本与伴随扩展一致")
    } else {
        None
    };
    if let Some(reason) = skip {
        result["reason"] = json!(reason);
        log(
            &app.bridge,
            "remote.sync",
            json!({"source":origin,"host":group["host"],"codexHome":group["codexHome"],"status":"skipped","reason":reason}),
        )?;
        return Ok(result);
    }
    let w = window(&app.bridge, &group)?.unwrap();
    let id = text(&w["id"]);
    let mut original = String::new();
    let mut secrets = auth_secrets(&auth);
    secrets.push(text(&p["apiKey"]).into());
    let mut step = "read";
    let operation=async {
        let read=dispatch(app.clone(),id,json!({"type":"remoteApply","step":"read"}),30).await?;original=read["text"].as_str().ok_or_else(||io::Error::other("远端配置读取结果或校验值无效"))?.to_owned();if read["sha256"]!=digest(&original){return Err(io::Error::other("远端配置读取结果或校验值无效"));}
        let mut previous=Value::Null;let next=if auth.is_object(){let config=toml::from_str::<toml::Value>(&original).map_err(|_|io::Error::other("服务器配置无法解析，未写入官方登录"))?;let config=serde_json::to_value(config).unwrap();let mode=text(&config["cli_auth_credentials_store"]);if ["keyring","ephemeral"].contains(&mode){return Err(io::Error::other(format!("服务器使用{mode}凭证存储，写入auth.json不会生效；未修改配置或登录")));}step="readAuth";previous=read_auth(app.clone(),id).await?;secrets.extend(auth_secrets(&previous["auth"]));secrets.push(text(&previous["text"]).into());let selected=model.as_str().or_else(||if config["model_provider"].is_null()||config["model_provider"]=="openai"{config["model"].as_str()}else{None});let own=path(&group,"switcher-model-catalog.json");let catalog=config["model_catalog_json"].as_str().filter(|v|*v!=own);crate::config_text::official(&original,selected,catalog,Some("file"))?}else{crate::config_text::prepare(&original,&p,text(&model),catalog.as_ref().map(|_|path(&group,"switcher-model-catalog.json")).as_deref())?};
        let mut write=json!({"type":"remoteApply","step":"write","text":next,"expectedSha256":read["sha256"],"catalog":catalog,"reload":true});let auth_text=if auth.is_object(){Some(serde_json::to_string_pretty(&auth).unwrap())}else{None};if let Some(body)=&auth_text{write["auth"]=json!({"text":body,"expectedSha256":previous["sha256"]});}step="write";let requested=millis();let written=dispatch(app.clone(),id,write,30).await?;if written["ok"]!=true||written["sha256"]!=digest(&next){return Err(io::Error::other("远端未确认写入目标配置"));}
if auth_text.is_some_and(|body|written["authSha256"]!=digest(&body)){return Err(io::Error::other("远端未确认写入目标登录"));}
        mark_reload(app.clone(),id,json!({"host":group["host"],"authority":group["authority"],"codexHome":group["codexHome"],"requestedAt":requested,"source":origin,"method":written["reload"]["method"].as_str().unwrap_or("remoteHostExit"),"reason":written["reload"]["reason"]}))?;
        for other in group["windows"].as_array().unwrap().iter().filter(|v|v["id"]!=id){let requested=millis();let out=dispatch(app.clone(),text(&other["id"]),json!({"type":"remoteReload","reload":true}),30).await?;mark_reload(app.clone(),text(&other["id"]),json!({"host":group["host"],"authority":group["authority"],"codexHome":group["codexHome"],"requestedAt":requested,"source":origin,"method":out["reload"]["method"],"reason":out["reload"]["reason"]}))?;}
        Ok::<_,io::Error>(written)
    }.await;
    match operation {
        Ok(written) => {
            result["status"] = json!("synced");
            log(
                &app.bridge,
                "remote.sync",
                json!({"provider":p["name"],"account":accounts::identity(&auth).unwrap_or(Value::Null)["email"],"model":model,"source":origin,"host":group["host"],"codexHome":group["codexHome"],"step":step,"sha256":text(&written["sha256"]).chars().take(8).collect::<String>(),"status":"synced","elapsedMs":started.elapsed().as_millis()}),
            )?;
        }
        Err(e) => {
            secrets.push(original);
            let reason = redact(&e.to_string(), &secrets);
            result["status"] = json!("failed");
            result["reason"] = json!(reason);
            log(
                &app.bridge,
                "remote.sync",
                json!({"source":origin,"host":group["host"],"codexHome":group["codexHome"],"step":step,"status":"failed","reason":reason}),
            )?;
        }
    }
    Ok(result)
}
pub fn observe(app: Arc<App>, input: &Value) -> io::Result<()> {
    let agent = editors::agent_status(&input["remoteAgent"])?;
    let status = if input["remoteAgentState"] == "checking"
        || (agent.is_null() && input["remoteAgentState"].is_null())
    {
        "checking"
    } else if input["remoteAgentState"] == "unreachable" {
        "unreachable"
    } else if agent.is_null() {
        "missing"
    } else if agent["protocol"].as_u64().unwrap_or(0) < 3
        || agent["agentVersion"] != input["companionVersion"]
    {
        "needsUpdate"
    } else {
        "connected"
    };
    let detail = json!({"authority":input["authority"],"codexHome":agent["codexHome"],"state":status,"agentVersion":agent["agentVersion"],"protocol":agent["protocol"],"companionVersion":input["companionVersion"],"account":agent["account"]["email"],"error":input["remoteAgentError"].as_str().map(|v|v.chars().take(300).collect::<String>())});
    let key = format!(
        "remote:{}:{}",
        text(&input["authority"]),
        text(&agent["codexHome"])
    );
    {
        let mut states = app.editors.remote_states.lock().unwrap();
        if states.get(&key) != Some(&detail) {
            log(&app.bridge, "remote.agent", detail.clone())?;
            states.insert(key, detail);
        }
    }
    if let Some(id) = agent["account"]["id"].as_str() {
        observe_id(app, id);
    }
    Ok(())
}
fn observe_id(app: Arc<App>, id: &str) {
    let id = id.to_owned();
    if !app.editors.syncs.lock().unwrap().insert(id.clone()) {
        return;
    }
    tokio::spawn(async move {
        if let Err(e) = synchronize(app.clone(), &id).await {
            eprintln!("官方登录互通失败：{e}");
        }
        app.editors.syncs.lock().unwrap().remove(&id);
    });
}
async fn synchronize(app: Arc<App>, id: &str) -> io::Result<()> {
    if !accounts::known(&app.bridge, id)? {
        return Ok(());
    }
    let mut latest = accounts::saved_auth(&app.bridge, id)?;
    let mut snapshots = vec![];
    let mut secrets = auth_secrets(&latest);
    let operation=async{
        let groups=groups(&app.bridge)?.into_iter().filter(|g|g["account"]["id"]==id).collect::<Vec<_>>();if groups.iter().any(|g|g["account"]["lastRefresh"]!=latest["last_refresh"]){for group in groups{let Some(w)=window(&app.bridge,&group)?else{continue};let config=dispatch(app.clone(),text(&w["id"]),json!({"type":"remoteApply","step":"read"}),30).await?;let config=toml::from_str::<toml::Value>(text(&config["text"])).map_err(|_|io::Error::other("服务器配置无法解析，未同步登录"))?;if matches!(config.get("cli_auth_credentials_store").and_then(|v|v.as_str()),Some("keyring"|"ephemeral")){continue;}let saved=read_auth(app.clone(),text(&w["id"])).await?;if accounts::identity(&saved["auth"]).is_none_or(|v|v["id"]!=id){continue;}secrets.extend(auth_secrets(&saved["auth"]));snapshots.push((group,w,saved));}}
        {let _guard=app.accounts.mutation.lock().await;for (group,_,saved) in &snapshots{if accounts::merge_auth(&app,&saved["auth"])?{log(&app.bridge,"official.sync",json!({"account":accounts::identity(&latest).unwrap()["email"],"direction":"remote→saved","target":format!("{}:{}",text(&group["authority"]),text(&group["codexHome"])),"status":"saved"}))?;}}accounts::capture(&app)?;latest=accounts::saved_auth(&app.bridge,id)?;if accounts::sync_local_auth(&app,&latest)?{log(&app.bridge,"official.sync",json!({"account":accounts::identity(&latest).unwrap()["email"],"direction":"saved→local","target":"本机当前登录","status":"synced"}))?;}}
        let body=serde_json::to_string_pretty(&latest).unwrap();for (group,w,saved) in &snapshots{if text(&saved["auth"]["last_refresh"])>=text(&latest["last_refresh"]){continue;}let out=dispatch(app.clone(),text(&w["id"]),json!({"type":"remoteApply","step":"write","text":null,"expectedSha256":null,"catalog":null,"auth":{"text":body,"expectedSha256":saved["sha256"]},"reload":false}),30).await?;if out["ok"]!=true||out["authSha256"]!=digest(&body){return Err(io::Error::other("服务器未确认写入最新登录"));}log(&app.bridge,"official.sync",json!({"account":accounts::identity(&latest).unwrap()["email"],"direction":"saved→remote","target":format!("{}:{}",text(&group["authority"]),text(&group["codexHome"])),"status":"synced"}))?;}Ok::<_,io::Error>(())
    }.await;
    operation.map_err(|e|{let reason=redact(&e.to_string(),&secrets);if let Err(error)=log(&app.bridge,"official.sync",json!({"account":accounts::identity(&latest).unwrap_or(Value::Null)["email"],"status":"failed","reason":reason})){eprintln!("Sync failure log failed: {error}");}io::Error::other(reason)})
}
