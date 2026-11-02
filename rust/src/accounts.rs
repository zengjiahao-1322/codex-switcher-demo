//! Official account library. Credentials remain on disk and never enter HTTP summaries.
use crate::{instance::write_json, official_session::Session, server::App};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{fs, io, path::Path, sync::Arc};
use tokio::sync::{Mutex, Semaphore, watch};

type QuotaResult = Option<Result<Value, String>>;
pub struct Runtime {
    pub(crate) mutation: Mutex<()>,
    login: Mutex<Option<Arc<Login>>>,
    quotas: Mutex<std::collections::HashMap<String, watch::Receiver<QuotaResult>>>,
    slots: Semaphore,
    credentials: std::sync::Mutex<Credentials>,
}
#[derive(Default)]
struct Credentials {
    mode: bool,
    required: bool,
    auth: Value,
    checked: Option<std::time::Instant>,
    notice: Value,
}
impl Default for Runtime {
    fn default() -> Self {
        Self {
            mutation: Mutex::new(()),
            login: Mutex::new(None),
            quotas: Mutex::new(std::collections::HashMap::new()),
            slots: Semaphore::new(2),
            credentials: std::sync::Mutex::new(Credentials::default()),
        }
    }
}
struct Login {
    value: std::sync::Mutex<Value>,
    session: Option<Arc<Session>>,
}
pub const ACTIONS: &[&str] = &[
    "accounts",
    "accountRename",
    "accountRemove",
    "accountLogin",
    "accountLoginCancel",
    "accountQuota",
    "accountRenew",
];
pub fn read(file: &Path, fallback: Value) -> io::Result<Value> {
    match fs::read(file) {
        Ok(bytes) => serde_json::from_slice(&bytes).map_err(io::Error::other),
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(fallback),
        Err(e) => Err(e),
    }
}
fn now() -> String {
    time::OffsetDateTime::now_utc()
        .format(&time::format_description::well_known::Rfc3339)
        .unwrap()
}
fn timestamp(value: &Value) -> i128 {
    value
        .as_str()
        .and_then(|s| {
            time::OffsetDateTime::parse(s, &time::format_description::well_known::Rfc3339).ok()
        })
        .map(|t| t.unix_timestamp_nanos())
        .unwrap_or(0)
}
fn text(value: &Value) -> &str {
    value.as_str().unwrap_or("")
}
pub fn identity(auth: &Value) -> Option<Value> {
    let tokens = &auth["tokens"];
    if text(&tokens["access_token"]).is_empty() || text(&tokens["account_id"]).is_empty() {
        return None;
    }
    let access = claims(text(&tokens["access_token"]));
    let id = claims(text(&tokens["id_token"]));
    let subscription = &id["https://api.openai.com/auth"];
    let a = access
        .get("https://api.openai.com/auth")
        .unwrap_or(subscription);
    let user = [
        &a["chatgpt_user_id"],
        &a["user_id"],
        &access["sub"],
        &id["sub"],
    ]
    .into_iter()
    .find(|v| !text(v).is_empty())
    .map(text)
    .unwrap_or("");
    let hash = format!(
        "{:x}",
        Sha256::digest(format!("{}\0{user}", text(&tokens["account_id"])))
    );
    let email = id
        .get("email")
        .unwrap_or(&access["https://api.openai.com/profile"]["email"]);
    Some(
        json!({"id":&hash[..20],"accountId":tokens["account_id"],"email":email.as_str().unwrap_or(""),"plan":a["chatgpt_plan_type"].as_str().unwrap_or("unknown"),"subscriptionUntil":subscription["chatgpt_subscription_active_until"],"subscriptionCheckedAt":subscription["chatgpt_subscription_last_checked"]}),
    )
}
fn rows(app: &App) -> io::Result<Vec<Value>> {
    Ok(read(&app.bridge.join("accounts/index.json"), json!([]))?
        .as_array()
        .cloned()
        .unwrap_or_default())
}
fn auth(app: &App, id: &str) -> io::Result<Value> {
    read(
        &app.bridge.join("accounts").join(id).join("auth.json"),
        Value::Null,
    )
}
pub fn saved_auth(bridge: &std::path::Path, id: &str) -> io::Result<Value> {
    if !known(bridge, id)? {
        return Err(io::Error::other("账号不存在，请重新选择"));
    }
    read(
        &bridge.join("accounts").join(id).join("auth.json"),
        Value::Null,
    )
}
fn remember(app: &App, value: &Value, pending: bool) -> io::Result<Value> {
    let mut info =
        identity(value).ok_or_else(|| io::Error::other("登录成功但未读到官方账号，请重试"))?;
    let id = text(&info["id"]).to_owned();
    let mut items = rows(app)?;
    let old = items.iter().find(|r| r["id"] == id);
    let saved = auth(app, &id)?;
    if let Some(old) = old
        && timestamp(&saved["last_refresh"]) > timestamp(&value["last_refresh"])
    {
        return Ok(old.clone());
    }
    let label = old
        .map(|r| text(&r["label"]))
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| {
            if text(&info["email"]).is_empty() {
                "ChatGPT 账号"
            } else {
                text(&info["email"])
            }
        })
        .to_owned();
    info["label"] = json!(label);
    info["savedAt"] = json!(now());
    info["pendingLogin"] = json!(pending);
    if let Some(row) = items.iter_mut().find(|r| r["id"] == id) {
        *row = info.clone();
    } else {
        items.push(info.clone());
    }
    write_json(
        &app.bridge.join("accounts").join(&id).join("auth.json"),
        value,
    )?;
    write_json(&app.bridge.join("accounts/index.json"), &json!(items))?;
    Ok(info)
}
pub fn known(bridge: &Path, id: &str) -> io::Result<bool> {
    Ok(read(&bridge.join("accounts/index.json"), json!([]))?
        .as_array()
        .into_iter()
        .flatten()
        .any(|v| v["id"] == id))
}
pub async fn apply_saved(
    app: &App,
    id: &str,
    model: Option<&str>,
    catalog: Option<&str>,
) -> io::Result<Value> {
    let _guard = app.accounts.mutation.lock().await;
    capture(app)?;
    let auth = saved_auth(&app.bridge, id)?;
    if identity(&auth).is_none_or(|v| v["id"] != id) {
        return Err(io::Error::other("官方账号登录记录不完整"));
    }
    let file = app.codex_home().join("config.toml");
    let original = crate::config_ops::read(&file)?;
    let next = crate::config_text::official(
        original.as_deref().unwrap_or(""),
        model,
        catalog,
        Some("file"),
    )?;
    crate::config_ops::save_backup(&app.codex_home(), &app.bridge, "official")?;
    crate::config_ops::atomic(&file, &next, Some(original.as_deref()))?;
    write_json(&app.codex_home().join("auth.json"), &auth)?;
    {
        let mut credentials = app.accounts.credentials.lock().unwrap();
        credentials.mode = false;
        credentials.required = false;
        credentials.auth = Value::Null;
        credentials.notice = Value::Null;
    }
    let row = remember(app, &auth, false)?;
    match fs::remove_file(app.bridge.join("current.json")) {
        Ok(()) => {}
        Err(e) if e.kind() == io::ErrorKind::NotFound => {}
        Err(e) => return Err(e),
    }
    Ok(json!({"id":id,"email":row["email"],"label":row["label"]}))
}
pub async fn login_active(app: &App) -> bool {
    app.accounts.login.lock().await.as_ref().is_some_and(|a| {
        matches!(
            text(&a.value.lock().unwrap()["status"]),
            "starting" | "waiting"
        )
    })
}
fn current(app: &App) -> io::Result<Value> {
    let credentials = app.accounts.credentials.lock().unwrap();
    if credentials.mode && (!credentials.auth.is_null() || credentials.required) {
        return Ok(credentials.auth.clone());
    }
    read(&app.codex_home().join("auth.json"), Value::Null)
}
fn owner_id(app: &App) -> io::Result<Value> {
    if app.bridge.join("current.json").exists() {
        return Ok(Value::Null);
    }
    Ok(identity(&current(app)?).unwrap_or(Value::Null)["id"].clone())
}
pub async fn sync_current(app: &App, force: bool) -> io::Result<()> {
    if !cfg!(target_os = "macos") {
        return Ok(());
    }
    let home = app.codex_home();
    let mode = fs::read_to_string(home.join("config.toml"))
        .ok()
        .and_then(|s| toml::from_str::<toml::Value>(&s).ok())
        .and_then(|c| {
            c.get("cli_auth_credentials_store")
                .and_then(|v| v.as_str())
                .map(str::to_owned)
        });
    {
        let mut credentials = app.accounts.credentials.lock().unwrap();
        credentials.required = mode.as_deref() == Some("keyring");
        credentials.mode = credentials.required || mode.as_deref() == Some("auto");
        if !credentials.mode {
            credentials.notice = Value::Null;
            return Ok(());
        }
        if !force
            && credentials
                .checked
                .is_some_and(|at| at.elapsed() < std::time::Duration::from_secs(30))
        {
            return Ok(());
        }
    }
    let home = fs::canonicalize(&home).unwrap_or(home);
    let hash = format!("{:x}", Sha256::digest(home.to_string_lossy().as_bytes()));
    let output = tokio::time::timeout(
        std::time::Duration::from_secs(10),
        tokio::process::Command::new("/usr/bin/security")
            .args([
                "find-generic-password",
                "-s",
                "Codex Auth",
                "-a",
                &format!("cli|{}", &hash[..16]),
                "-w",
            ])
            .kill_on_drop(true)
            .output(),
    )
    .await;
    let value = match output {
        Ok(Ok(out)) if out.status.success() => {
            serde_json::from_slice(&out.stdout).unwrap_or(Value::Null)
        }
        _ => Value::Null,
    };
    let mut credentials = app.accounts.credentials.lock().unwrap();
    credentials.auth = value;
    credentials.checked = Some(std::time::Instant::now());
    credentials.notice = if credentials.required && credentials.auth.is_null() {
        json!(
            "此目录使用系统钥匙串，但未能读取登录。请允许钥匙串访问，或用“添加账号”完成官方登录。"
        )
    } else {
        Value::Null
    };
    Ok(())
}
pub fn capture(app: &App) -> io::Result<()> {
    let value = current(app)?;
    let Some(info) = identity(&value) else {
        return Ok(());
    };
    let id = text(&info["id"]);
    if rows(app)?
        .iter()
        .any(|r| r["id"] == id && r["pendingLogin"] == true)
    {
        return Ok(());
    }
    if auth(app, id)? == value {
        return Ok(());
    }
    remember(app, &value, false)?;
    Ok(())
}
async fn status(app: &App) -> io::Result<Value> {
    capture(app)?;
    let current_id = identity(&current(app)?).unwrap_or(Value::Null)["id"].clone();
    let owner = owner_id(app)?;
    let used = crate::remote::server_accounts(&app.bridge)?;
    let mut items = rows(app)?;
    for row in &mut items {
        let id = text(&row["id"]);
        let auth = auth(app, id)?;
        let latest = identity(&auth).unwrap_or(Value::Null);
        let quota = read(
            &app.bridge.join("accounts").join(id).join("quota.json"),
            Value::Null,
        )?;
        row["plan"] = latest.get("plan").cloned().unwrap_or(json!("unknown"));
        for field in ["subscriptionUntil", "subscriptionCheckedAt"] {
            row[field] = quota
                .get(field)
                .filter(|v| !v.is_null())
                .unwrap_or(&latest[field])
                .clone();
        }
        row["refreshedAt"] = auth["last_refresh"].clone();
        row["current"] = json!(row["id"] == current_id);
        row["quota"] = quota;
        row["renewal"] = renewal(app, row, &owner, &used)?;
    }
    let login = app
        .accounts
        .login
        .lock()
        .await
        .as_ref()
        .map(|v| v.value.lock().unwrap().clone());
    let mut job = read(&app.bridge.join("account-switch.json"), Value::Null)?;
    if job["editorReload"]["targets"].is_array() {
        job["editorReload"]["results"] =
            crate::editors::reload_results(&app.bridge, &job["editorReload"]["targets"])?;
    }
    Ok(
        json!({"items":items,"credentialsNotice":app.accounts.credentials.lock().unwrap().notice.clone(),"login":login,"switchJob":job}),
    )
}
fn sanitize(reason: &str) -> String {
    let urls = regex::Regex::new(r"(?i)https?://\S+")
        .unwrap()
        .replace_all(reason, "[登录地址已隐藏]");
    let tokens = regex::Regex::new(r"eyJ[A-Za-z0-9_.-]+")
        .unwrap()
        .replace_all(&urls, "[凭证已隐藏]");
    regex::Regex::new(r"(?i)((?:code|state|token|secret)\s*[=:]\s*)[^\s,}]+")
        .unwrap()
        .replace_all(&tokens, "${1}[已隐藏]")
        .chars()
        .take(240)
        .collect()
}
async fn finish(
    app: &App,
    login: &Arc<Login>,
    value: Value,
    error: Option<crate::official_session::Failure>,
) {
    {
        let active = app.accounts.login.lock().await;
        if !active.as_ref().is_some_and(|a| Arc::ptr_eq(a, login)) {
            return;
        }
        let mut public = login.value.lock().unwrap();
        if !matches!(text(&public["status"]), "starting" | "waiting") {
            return;
        }
        for (key, value) in value.as_object().unwrap() {
            public[key] = value.clone();
        }
    }
    if value["status"] == "error" {
        let target = login.value.lock().unwrap()["targetId"].clone();
        let account = rows(app)
            .unwrap_or_default()
            .into_iter()
            .find(|r| r["id"] == target)
            .unwrap_or(Value::Null)["email"]
            .clone();
        let _ = crate::diagnostics::log(
            &app.bridge,
            "official.error",
            json!({"op":"login","account":account,"kind":error.as_ref().map_or("service_error",|e|e.kind),"code":error.as_ref().map(|e|e.code.clone()),"message":value["message"]}),
        );
    }
    if let Some(session) = &login.session {
        session.close().await;
    }
}
async fn start_login(app: Arc<App>, input: &Value) -> io::Result<Value> {
    if let Some(login) = app.accounts.login.lock().await.as_ref()
        && matches!(
            text(&login.value.lock().unwrap()["status"]),
            "starting" | "waiting"
        )
    {
        return Err(io::Error::other("请先完成或取消当前登录"));
    }
    let id = text(&input["id"]).to_owned();
    let target = rows(&app)?.into_iter().find(|r| r["id"] == id);
    if !id.is_empty() && target.is_none() {
        return Err(io::Error::other("账号不存在"));
    }
    let random = crate::platform::random_bytes()?;
    let unique = random[..16]
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect::<String>();
    let home = app.bridge.join("accounts/login").join(unique);
    let (session, mut notifications) = match Session::open(&app.bridge, &home) {
        Ok(session) => session,
        Err(e) => {
            let _ = crate::diagnostics::log(
                &app.bridge,
                "official.error",
                json!({"op":"login","account":target.as_ref().unwrap_or(&Value::Null)["email"],"kind":e.kind,"code":e.code,"message":e.message}),
            );
            *app.accounts.login.lock().await = Some(Arc::new(Login {
                value: std::sync::Mutex::new(
                    json!({"status":"error","targetId":input["id"],"message":e.message}),
                ),
                session: None,
            }));
            return Err(io::Error::other(e.message));
        }
    };
    let login = Arc::new(Login {
        value: std::sync::Mutex::new(
            json!({"status":"starting","targetId":if id.is_empty(){Value::Null}else{json!(id)}}),
        ),
        session: Some(session.clone()),
    });
    *app.accounts.login.lock().await = Some(login.clone());
    let result = async {
        session.ready().await?;
        session
            .rpc(
                "account/login/start",
                json!({"type":"chatgpt","appBrand":"chatgpt"}),
            )
            .await
    }
    .await;
    let result = match result {
        Ok(v) => v,
        Err(e) => {
            finish(
                &app,
                &login,
                json!({"status":"error","message":e.message}),
                Some(e.clone()),
            )
            .await;
            return Err(io::Error::other(e.message));
        }
    };
    {
        let mut value = login.value.lock().unwrap();
        value["status"] = json!("waiting");
        value["loginId"] = result["loginId"].clone();
        value["authUrl"] = result["authUrl"].clone();
        value["message"] = json!(if id.is_empty() {
            "请在官方页面登录要添加的账号，完成后会自动加入列表。".to_owned()
        } else {
            format!(
                "请在官方页面重新登录 {}，完成后会更新原账号。",
                text(&target.unwrap()["label"])
            )
        });
    }
    let response = login.value.lock().unwrap().clone();
    tokio::spawn(async move {
        while let Some(message) = notifications.recv().await {
            let method = text(&message["method"]);
            if method == "process/exit" {
                finish(&app,&login,json!({"status":"error","message":"登录进程已结束，未收到本次登录成功通知；请重试。"}),None).await;
                break;
            }
            if method != "account/login/completed"
                || message["params"]["loginId"] != login.value.lock().unwrap()["loginId"]
            {
                continue;
            }
            let _guard = app.accounts.mutation.lock().await;
            if !matches!(
                text(&login.value.lock().unwrap()["status"]),
                "starting" | "waiting"
            ) {
                break;
            }
            let completion = if message["params"]["success"] != true {
                json!({"status":"error","message":format!("官方登录未完成：{}。若网页已成功，请保留登录目录以便恢复。",sanitize(message["params"]["error"].as_str().unwrap_or("官方未返回具体原因")))})
            } else {
                let save = (|| -> io::Result<Value> {
                    let value = read(&home.join("auth.json"), Value::Null)?;
                    let info = identity(&value)
                        .ok_or_else(|| io::Error::other("登录成功但未读到官方账号，请重试"))?;
                    if !id.is_empty() && info["id"] != id {
                        return Err(io::Error::other(
                            "登录的是其他账号或工作区，原账号未替换，请重新选择正确账号",
                        ));
                    }
                    let pending = identity(&current(&app)?).is_some_and(|v| v["id"] == info["id"]);
                    let row = remember(&app, &value, pending)?;
                    fs::remove_file(home.join("auth.json"))?;
                    match fs::remove_file(
                        app.bridge
                            .join("accounts")
                            .join(text(&row["id"]))
                            .join("quota.json"),
                    ) {
                        Ok(()) => {}
                        Err(error) if error.kind() == io::ErrorKind::NotFound => {}
                        Err(error) => return Err(error),
                    }
                    Ok(
                        json!({"status":"done","accountId":row["id"],"message":format!("已{} {}；在上方选择此账号并应用后使用。",if id.is_empty(){"添加"}else{"更新"},text(&row["label"]))}),
                    )
                })();
                match save {
                    Ok(v) => v,
                    Err(e) => json!({"status":"error","message":e.to_string()}),
                }
            };
            finish(&app, &login, completion, None).await;
            break;
        }
    });
    Ok(response)
}
pub async fn action(app: Arc<App>, action: &str, input: &Value) -> io::Result<Value> {
    if action == "accountQuota" {
        return quota_action(app, input).await;
    }
    if action == "accountRenew" {
        return renew_action(app, input).await;
    }
    let _operation = if action == "accounts" {
        None
    } else {
        Some(crate::config_ops::operation(&app.bridge)?)
    };
    let _guard = app.accounts.mutation.lock().await;
    match action {
        "accounts" => {
            sync_current(&app, false).await?;
            status(&app).await
        }
        "accountLogin" => {
            let _ = fs::remove_file(app.bridge.join("account-switch.json"));
            start_login(app.clone(), input).await
        }
        "accountLoginCancel" => {
            let login = app.accounts.login.lock().await.clone();
            if let Some(login) = login {
                let id = {
                    let mut value = login.value.lock().unwrap();
                    let id = if matches!(text(&value["status"]), "starting" | "waiting") {
                        value["loginId"].clone()
                    } else {
                        Value::Null
                    };
                    value["status"] = json!("cancelled");
                    value["message"] = json!("已取消登录");
                    id
                };
                let result = if id.is_null() {
                    Ok(Value::Null)
                } else {
                    login
                        .session
                        .as_ref()
                        .unwrap()
                        .rpc("account/login/cancel", json!({"loginId":id}))
                        .await
                };
                if let Some(session) = &login.session {
                    session.close().await;
                }
                result.map_err(|e| io::Error::other(e.message))?;
            }
            Ok(json!({"message":"已取消登录。"}))
        }
        "accountRename" | "accountRemove" => {
            let id = text(&input["id"]);
            let mut rows = rows(&app)?;
            if action == "accountRename" {
                let row = rows
                    .iter_mut()
                    .find(|r| r["id"] == id)
                    .ok_or_else(|| io::Error::other("账号不存在"))?;
                let label = text(&input["label"]).trim();
                row["label"] = json!(if !label.is_empty() {
                    label
                } else if !text(&row["email"]).is_empty() {
                    text(&row["email"])
                } else {
                    "ChatGPT 账号"
                });
            } else {
                // Only indexed account paths are ever used for filesystem operations.
                if rows.iter().any(|r| r["id"] == id) {
                    let file = app.bridge.join("accounts").join(id).join("auth.json");
                    match fs::remove_file(file) {
                        Ok(()) => {}
                        Err(e) if e.kind() == io::ErrorKind::NotFound => {}
                        Err(e) => return Err(e),
                    }
                }
                rows.retain(|r| r["id"] != id);
            }
            write_json(&app.bridge.join("accounts/index.json"), &json!(rows))?;
            Ok(
                json!({"message":if action=="accountRename"{"已修改账号名称。"}else{"已移除保存的账号。"}}),
            )
        }
        _ => unreachable!(),
    }
}

pub async fn prepare(app: &App, id: &str) -> Result<Value, crate::official_session::Failure> {
    use crate::official_session::Failure;
    let io_failure = |e: io::Error| Failure {
        message: e.to_string(),
        kind: "service_error",
        code: Value::Null,
    };
    let (row, value) = {
        let _guard = app.accounts.mutation.lock().await;
        capture(app).map_err(io_failure)?;
        let row = rows(app)
            .map_err(io_failure)?
            .into_iter()
            .find(|r| r["id"] == id)
            .ok_or_else(|| io_failure(io::Error::other("账号不存在，请重新选择")))?;
        let value = auth(app, id).map_err(io_failure)?;
        if identity(&value).is_none() {
            return Err(io_failure(io::Error::other("登录记录不完整，请重新登录")));
        }
        if row["pendingLogin"] != true
            && claims(text(&value["tokens"]["access_token"]))["exp"]
                .as_i64()
                .is_none_or(|exp| exp > time::OffsetDateTime::now_utc().unix_timestamp())
        {
            return Ok(row);
        }
        (row, value)
    };
    let mut session = None;
    let result = async {
        let (opened, _) = Session::open(&app.bridge, &app.bridge.join("accounts").join(id))?;
        session = Some(opened.clone());
        opened.ready().await?;
        let account = opened
            .rpc("account/read", json!({"refreshToken":true}))
            .await?;
        if account["account"]["type"] != "chatgpt" {
            return Err(Failure {
                message: "未读到 ChatGPT 登录".into(),
                kind: "auth_invalid",
                code: json!("AUTH_REQUIRED"),
            });
        }
        let refreshed = auth(app, id).map_err(io_failure)?;
        if identity(&refreshed).is_none_or(|v| v["id"] != id) {
            return Err(io_failure(io::Error::other("返回的账号与所选账号不一致")));
        }
        let _guard = app.accounts.mutation.lock().await;
        remember(app, &refreshed, row["pendingLogin"] == true).map_err(io_failure)
    }
    .await;
    if let Some(session) = &session {
        session.close().await;
    }
    let refresh_error = session
        .as_ref()
        .and_then(|session| session.refresh_failure());
    let result = result.map_err(|mut failure| {
        if failure.kind == "auth_invalid"
            && crate::official_session::Session::retryable(refresh_error.as_deref())
        {
            failure.kind = "network_error";
        }
        failure
    });
    if let Err(e) = &result {
        let _ = crate::diagnostics::log(
            &app.bridge,
            "official.error",
            json!({"op":"prepare","account":identity(&value).unwrap_or(Value::Null)["email"],"kind":e.kind,"code":e.code,"message":e.message,"refreshError":refresh_error}),
        );
    }
    result.map_err(|mut e| {
        e.message = match e.kind {
            "auth_invalid" => format!(
                "{} 的官方登录已失效，请点“重新登录”；本次未关闭桌面端。",
                text(&row["label"])
            ),
            "network_error" => format!(
                "无法准备 {} 的官方登录，请检查网络后重试；尚未确认登录失效，本次未关闭桌面端。",
                text(&row["label"])
            ),
            "runtime_error" => format!("官方登录校验程序不可用：{}；本次未关闭桌面端。", e.message),
            _ => "官方登录校验未完成；尚未确认登录失效，本次未关闭桌面端。".into(),
        };
        e
    })
}

async fn renewed(app: &App, id: &str) -> io::Result<Value> {
    let refreshed = auth(app, id)?;
    if identity(&refreshed).is_none_or(|v| v["id"] != id) {
        return Err(io::Error::other("返回的账号与所选账号不一致"));
    }
    let _guard = app.accounts.mutation.lock().await;
    remember(app, &refreshed, false)?;
    sync_local_auth(app, &refreshed)?;
    Ok(refreshed)
}
pub fn merge_auth(app: &App, value: &Value) -> io::Result<bool> {
    let info = identity(value).ok_or_else(|| io::Error::other("登录记录不完整"))?;
    let id = text(&info["id"]);
    if !rows(app)?.iter().any(|r| r["id"] == id) {
        return Err(io::Error::other("账号不存在，请重新选择"));
    }
    let saved = auth(app, id)?;
    if timestamp(&value["last_refresh"]) <= timestamp(&saved["last_refresh"]) {
        return Ok(false);
    }
    remember(app, value, false)?;
    Ok(true)
}
pub fn sync_local_auth(app: &App, value: &Value) -> io::Result<bool> {
    {
        let credentials = app.accounts.credentials.lock().unwrap();
        if credentials.mode && !credentials.auth.is_null() {
            return Ok(false);
        }
    }
    let live = current(app)?;
    if identity(&live).map(|v| v["id"].clone()) != identity(value).map(|v| v["id"].clone()) {
        return Ok(false);
    }
    let text = match fs::read_to_string(app.codex_home().join("config.toml")) {
        Ok(v) => v,
        Err(e) if e.kind() == io::ErrorKind::NotFound => String::new(),
        Err(e) => return Err(e),
    };
    let config = toml::from_str::<toml::Value>(&text)
        .map_err(|_| io::Error::other("本机配置无法解析，未同步登录"))?;
    if matches!(
        config
            .get("cli_auth_credentials_store")
            .and_then(|v| v.as_str()),
        Some("keyring" | "ephemeral")
    ) {
        return Ok(false);
    }
    if timestamp(&value["last_refresh"]) <= timestamp(&live["last_refresh"]) {
        return Ok(false);
    }
    write_json(&app.codex_home().join("auth.json"), value)?;
    Ok(true)
}
pub async fn fixture(input: &Value) -> io::Result<Value> {
    let home = std::path::PathBuf::from(text(&input["home"]));
    let bridge = std::path::PathBuf::from(text(&input["bridge"]));
    let app = std::sync::Arc::new(App {
        home,
        bridge: bridge.clone(),
        web: std::path::PathBuf::new(),
        token: String::new(),
        port: 0,
        protection: crate::platform::DataProtection {
            ok: true,
            path: bridge,
            error: None,
        },
        first_request: std::sync::atomic::AtomicBool::new(false),
        ready_at: std::time::Instant::now(),
        downloads: std::sync::Mutex::new(std::collections::HashMap::new()),
        accounts: Runtime::default(),
        editors: crate::editors::Runtime::default(),
        updates: crate::update::Runtime::default(),
    });
    capture(&app)?;
    match text(&input["method"]) {
        "prepare" => match prepare(&app, text(&input["id"])).await {
            Ok(row) => Ok(json!({"id":row["id"]})),
            Err(e) => Ok(json!({"error":e.message,"kind":e.kind})),
        },
        "merge" => Ok(json!({"changed":merge_auth(&app,&input["auth"])?})),
        "syncLocal" => Ok(json!({"changed":sync_local_auth(&app,&input["auth"])?})),
        "renewDue" => {
            renew_due(&app).await?;
            Ok(json!({"ok":true}))
        }
        "cleanAccounts" => {
            clean_accounts(&app).await?;
            Ok(json!({"ok":true}))
        }
        _ => Err(io::Error::other("Unknown account fixture method")),
    }
}
async fn subscription(app: &App, value: &Value) -> Option<Value> {
    read_subscription(
        &app.bridge,
        value,
        "https://chatgpt.com/backend-api/accounts/check/v4-2023-04-27",
        None,
    )
    .await
}
pub async fn read_subscription(
    bridge: &Path,
    value: &Value,
    endpoint: &str,
    ca: Option<&Path>,
) -> Option<Value> {
    let mut builder = reqwest::Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(std::time::Duration::from_secs(10))
        .timeout(std::time::Duration::from_secs(20));
    let id = identity(value).unwrap_or(Value::Null)["id"]
        .as_str()
        .unwrap_or("")
        .to_owned();
    let environment = crate::platform::codex_env(&bridge.join("accounts").join(id));
    let selected = |lower: &str, upper: &str| {
        environment
            .get(lower)
            .filter(|v| !v.is_empty())
            .or_else(|| environment.get(upper).filter(|v| !v.is_empty()))
    };
    let bypass = selected("no_proxy", "NO_PROXY").and_then(|v| reqwest::NoProxy::from_string(v));
    for (scheme, lower, upper) in [
        ("http", "http_proxy", "HTTP_PROXY"),
        ("https", "https_proxy", "HTTPS_PROXY"),
    ] {
        if let Some(url) = selected(lower, upper).or_else(|| selected("all_proxy", "ALL_PROXY")) {
            let proxy = if scheme == "http" {
                reqwest::Proxy::http(url)
            } else {
                reqwest::Proxy::https(url)
            }
            .ok()?;
            builder = builder.proxy(proxy.no_proxy(bypass.clone()));
        }
    }
    if let Some(ca) = ca {
        let certificate = fs::read(ca)
            .ok()
            .and_then(|bytes| reqwest::Certificate::from_pem(&bytes).ok())?;
        builder = builder.add_root_certificate(certificate);
    }
    let client = builder.build();
    let response = match client {
        Ok(client) => {
            client
                .get(endpoint)
                .bearer_auth(text(&value["tokens"]["access_token"]))
                .header("ChatGPT-Account-Id", text(&value["tokens"]["account_id"]))
                .header("originator", "codex_cli_rs")
                .header("Accept", "application/json")
                .send()
                .await
        }
        Err(e) => Err(e),
    };
    let (code, body) = match response {
        Ok(r) => {
            let code = r.status().as_u16();
            (Some(code), r.json::<Value>().await.ok())
        }
        Err(_) => (None, None),
    };
    let account =
        &body.as_ref().unwrap_or(&Value::Null)["accounts"][text(&value["tokens"]["account_id"])];
    let will_renew = account["last_active_subscription"]["will_renew"] == true;
    let expires_at = account["entitlement"]
        .get("expires_at")
        .filter(|v| !v.is_null());
    let renews_at = account["entitlement"]
        .get("renews_at")
        .filter(|v| !v.is_null());
    let date = if will_renew {
        renews_at.or(expires_at)
    } else {
        expires_at.or(renews_at)
    };
    let result = if code.is_some_and(|c| (200..300).contains(&c))
        && date.is_some_and(|value| timestamp(value) != 0)
    {
        Some(
            json!({"until":date,"checkedAt":now(),"willRenew":account["last_active_subscription"]["will_renew"],"status":membership_status(account)}),
        )
    } else {
        None
    };
    let _ = crate::diagnostics::log(
        bridge,
        "official.subscription",
        json!({
            "account":identity(value).unwrap_or(Value::Null)["email"],
            "status":if code.is_some_and(|c|(200..300).contains(&c))&&body.is_some(){"ok"}else{"failed"},
            "httpCode":code,
            "hasDate":result.is_some(),
            "expiresAt":account["entitlement"]["expires_at"],
            "renewsAt":account["entitlement"]["renews_at"],
            "willRenew":account["last_active_subscription"]["will_renew"],
            "plan":account["entitlement"]["subscription_plan"],
            "accountKeys":object_keys(account),
            "entitlementKeys":object_keys(&account["entitlement"]),
            "subscriptionKeys":object_keys(&account["last_active_subscription"]),
            "offerFields":offer_fields(account),
        }),
    );
    result
}
// Follows the official billing status order: payment problems and scheduled plan
// changes win, and discount dates only count while the plan renews.
fn membership_status(account: &Value) -> Value {
    let entitlement = &account["entitlement"];
    let present = |name: &str| entitlement.get(name).filter(|value| !value.is_null());
    let renews_at = present("renews_at");
    let expires_at = present("expires_at");
    let cancels_at = present("cancels_at");
    if entitlement["is_delinquent"] == true {
        return json!({"kind":"delinquent"});
    }
    let change = &entitlement["scheduled_plan_change"];
    if change.is_object() {
        return json!({"kind":"planChange","plan":change["plan_type"],"date":change["changes_at"]});
    }
    if account["last_active_subscription"]["will_renew"] == true {
        let discount = &entitlement["discount"];
        let trial = &entitlement["trial"];
        let waiting = discount["discount_start_in_num_periods"]
            .as_u64()
            .unwrap_or(0);
        if waiting > 0 {
            return json!({"kind":"renewal","date":renews_at,"discountAfter":waiting});
        }
        if timestamp(&discount["discount_expires_at"]) != 0 {
            let free = discount["discount_type"] == "percentage"
                && discount["amount"].as_f64() == Some(100.0);
            return json!({"kind":if free{"free"}else{"discounted"},"date":discount["discount_expires_at"],"nextBill":renews_at});
        }
        if trial["is_trialing"] == true && timestamp(&trial["trial_ends_at"]) != 0 {
            return json!({"kind":"trial","date":trial["trial_ends_at"],"nextBill":renews_at});
        }
        return json!({"kind":"renewal","date":renews_at});
    }
    if renews_at.is_some() || (expires_at.is_none() && cancels_at.is_some()) {
        return json!({"kind":"canceled","date":renews_at.or(cancels_at)});
    }
    json!({"kind":"expires","date":expires_at})
}
fn object_keys(value: &Value) -> Value {
    json!(
        value
            .as_object()
            .map(|o| o.keys().collect::<Vec<_>>())
            .unwrap_or_default()
    )
}
fn offer_fields(account: &Value) -> Value {
    let mut fields = serde_json::Map::new();
    for section in ["entitlement", "last_active_subscription"] {
        for (key, value) in account[section].as_object().into_iter().flatten() {
            let name = key.to_ascii_lowercase();
            if ["discount", "promo", "trial", "coupon", "offer"]
                .iter()
                .any(|word| name.contains(word))
            {
                fields.insert(format!("{section}.{key}"), value.clone());
            }
        }
    }
    Value::Object(fields)
}
fn buckets(result: &Value) -> Vec<Value> {
    let all = result["rateLimitsByLimitId"]
        .as_object()
        .filter(|v| !v.is_empty())
        .map(|v| {
            v.iter()
                .map(|(k, v)| (k.clone(), v.clone()))
                .collect::<Vec<_>>()
        })
        .unwrap_or_else(|| {
            if result["rateLimits"].is_object() {
                vec![("codex".into(), result["rateLimits"].clone())]
            } else {
                vec![]
            }
        });
    let mut output = Vec::new();
    for (id, bucket) in all {
        let mut windows = Vec::new();
        for key in ["primary", "secondary"] {
            let window = &bucket[key];
            if !window.is_object() {
                continue;
            }
            let used = window["usedPercent"].as_f64().map(|v| v.clamp(0., 100.));
            windows.push(json!({
                "key":key,
                "usedPercent":used,
                "remainingPercent":used.map(|v|100.-v),
                "minutes":window["windowDurationMins"],
                "resetsAt":window["resetsAt"]
            }));
        }
        let limit = bucket["limitId"].as_str().unwrap_or(&id);
        let credits = if bucket["credits"].is_object() {
            json!({"unlimited":bucket["credits"]["unlimited"]==true,"balance":bucket["credits"]["balance"]})
        } else {
            Value::Null
        };
        output.push(json!({
            "id":limit,"name":bucket["limitName"].as_str().unwrap_or(limit),
            "plan":bucket["planType"],"windows":windows,"credits":credits
        }));
    }
    output
}
async fn read_quota(app: &App, id: &str, renew: bool) -> io::Result<Value> {
    let (value, previous, selected, current_id) = {
        let _guard = app.accounts.mutation.lock().await;
        capture(app)?;
        let selected = rows(app)?
            .into_iter()
            .find(|r| r["id"] == id)
            .ok_or_else(|| io::Error::other("账号不存在，请重新选择"))?;
        (
            auth(app, id)?,
            read(
                &app.bridge.join("accounts").join(id).join("quota.json"),
                json!({}),
            )?,
            selected,
            identity(&current(app)?).unwrap_or(Value::Null)["id"].clone(),
        )
    };
    let file = app.bridge.join("accounts").join(id).join("quota.json");
    let exp = claims(text(&value["tokens"]["access_token"]))["exp"].as_i64();
    let now_seconds = time::OffsetDateTime::now_utc().unix_timestamp();
    if !renew
        && current_id == id
        && (exp.is_some_and(|v| v <= now_seconds + 300)
            || (exp.is_none()
                && timestamp(&value["last_refresh"])
                    <= i128::from(now_seconds - 8 * 86400) * 1_000_000_000))
    {
        let mut result = json!({"status":"deferred","reason":"token_refresh_pending","message":"当前账号的登录即将由 Codex 自己续期，为避免顶掉正在使用的登录暂不查询；Codex 刷新后会自动恢复。"});
        if previous["checkedAt"].is_string() {
            result["checkedAt"] = previous["checkedAt"].clone();
        }
        write_json(&file, &result)?;
        result["id"] = json!(id);
        return Ok(result);
    }
    let mut session = None;
    let query = async {
        let (opened, _notifications) = Session::open(&app.bridge, file.parent().unwrap())?;
        session = Some(opened.clone());
        opened.ready().await?;
        let account = opened
            .rpc("account/read", json!({"refreshToken":renew}))
            .await?;
        if account["account"]["type"] != "chatgpt" {
            return Err(crate::official_session::Failure {
                message: "未读到此账号的官方登录，请重新登录此账号。".into(),
                kind: "auth_invalid",
                code: json!("AUTH_REQUIRED"),
            });
        }
        let subscription_value = if renew {
            renewed(app, id)
                .await
                .map_err(|error| crate::official_session::Failure {
                    message: error.to_string(),
                    kind: "service_error",
                    code: Value::Null,
                })?
        } else {
            value.clone()
        };
        let (limits, subscription) = tokio::join!(
            opened.rpc("account/rateLimits/read", json!({})),
            subscription(app, &subscription_value)
        );
        let buckets = buckets(&limits?);
        if buckets.is_empty() {
            return Err(crate::official_session::Failure {
                message: "官方服务未返回额度".into(),
                kind: "service_error",
                code: Value::Null,
            });
        }
        let mut result = json!({"status":"ok","checkedAt":now(),"buckets":buckets});
        if let Some(subscription) = subscription {
            result["subscriptionUntil"] = subscription["until"].clone();
            result["subscriptionCheckedAt"] = subscription["checkedAt"].clone();
            result["subscriptionWillRenew"] = subscription["willRenew"].clone();
            result["subscriptionStatus"] = subscription["status"].clone();
        }
        Ok(result)
    }
    .await;
    if let Some(session) = &session {
        session.close().await;
    }
    let refresh_error = session
        .as_ref()
        .and_then(|session| session.refresh_failure());
    let query = query.map_err(|mut failure| {
        if failure.kind == "auth_invalid"
            && crate::official_session::Session::retryable(refresh_error.as_deref())
        {
            failure.kind = "network_error";
        }
        failure
    });
    let mut result = match query {
        Ok(v) => v,
        Err(e) => {
            let (kind, message) = match e.kind {
                "auth_invalid" => (
                    "auth_invalid",
                    "此账号登录已失效，请点此账号的“重新登录”。".to_owned(),
                ),
                "network_error" => (
                    "network_error",
                    "无法连接官方额度服务，请检查网络或代理后重试。".to_owned(),
                ),
                "runtime_error" if e.code == -32601 => (
                    "runtime_error",
                    "当前 Codex 版本不支持额度查询，请更新官方扩展或桌面版。".to_owned(),
                ),
                "runtime_error" => ("runtime_error", e.message.clone()),
                _ => (
                    "quota_error",
                    format!(
                        "额度查询失败{}，请稍后重试；尚未确认此账号登录失效。",
                        if e.code.is_null() {
                            String::new()
                        } else {
                            format!("（{}）", e.code)
                        }
                    ),
                ),
            };
            crate::diagnostics::log(
                &app.bridge,
                "official.error",
                json!({"op":"quota","account":selected["email"],"kind":kind,"code":e.code,"message":e.message,"refreshError":refresh_error}),
            )?;
            let mut v = previous;
            v["status"] = json!("error");
            v["attemptedAt"] = json!(now());
            v["errorKind"] = json!(kind);
            v["error"] = json!(message);
            v
        }
    };
    let renewed = renew
        && result["status"] == "ok"
        && timestamp(&auth(app, id)?["last_refresh"]) > timestamp(&value["last_refresh"]);
    if renew {
        crate::diagnostics::log(
            &app.bridge,
            "official.renew",
            json!({"account":selected["email"],"status":if renewed {"ok"} else {"failed"},"refreshError":refresh_error}),
        )?;
    }
    write_json(&file, &result)?;
    result["id"] = json!(id);
    if renew {
        result["renewed"] = json!(renewed);
    }
    Ok(result)
}
async fn quota_action(app: Arc<App>, input: &Value) -> io::Result<Value> {
    let ids = {
        let _guard = app.accounts.mutation.lock().await;
        capture(&app)?;
        if input["id"].is_string() {
            vec![text(&input["id"]).to_owned()]
        } else {
            rows(&app)?
                .into_iter()
                .map(|r| text(&r["id"]).to_owned())
                .collect()
        }
    };
    let mut jobs = Vec::new();
    for id in ids {
        let app = app.clone();
        jobs.push(tokio::spawn(async move { quota(app, id, false).await }));
    }
    let mut items = Vec::new();
    for job in jobs {
        items.push(job.await.map_err(io::Error::other)??);
    }
    Ok(json!({"items":items}))
}
fn renewal(app: &App, row: &Value, owner: &Value, used: &[Value]) -> io::Result<Value> {
    if row["pendingLogin"] == true {
        return Ok(json!({"state":"pending"}));
    }
    if row["id"] == *owner {
        return Ok(json!({"state":"codex"}));
    }
    if used.contains(&row["id"]) {
        return Ok(json!({"state":"remote"}));
    }
    let id = text(&row["id"]);
    let quota = read(
        &app.bridge.join("accounts").join(id).join("quota.json"),
        json!({}),
    )?;
    if quota["errorKind"] == "auth_invalid" {
        return Ok(json!({"state":"relogin"}));
    }
    let value = auth(app, id)?;
    let Some(exp) = claims(text(&value["tokens"]["access_token"]))["exp"].as_i64() else {
        return Ok(json!({"state":"unknown"}));
    };
    let at = exp - 2 * 86400;
    let due = at <= time::OffsetDateTime::now_utc().unix_timestamp();
    let date = time::OffsetDateTime::from_unix_timestamp(at)
        .map_err(io::Error::other)?
        .format(&time::format_description::well_known::Rfc3339)
        .map_err(io::Error::other)?;
    Ok(
        json!({"state":if due && quota["status"] == "error" {"retry"} else {"auto"},"at":date,"due":due}),
    )
}

async fn renew_due(app: &Arc<App>) -> io::Result<()> {
    if login_active(app).await {
        return Ok(());
    }
    let Ok(_operation) = crate::config_ops::operation(&app.bridge) else {
        return Ok(());
    };
    let used = crate::remote::server_accounts(&app.bridge)?;
    let ids = {
        let _guard = app.accounts.mutation.lock().await;
        capture(app)?;
        let owner = owner_id(app)?;
        let mut ids = vec![];
        for row in rows(app)? {
            if renewal(app, &row, &owner, &used)?["due"] == true {
                ids.push(text(&row["id"]).to_owned());
            }
        }
        ids
    };
    for id in ids {
        quota(app.clone(), id, true).await?;
    }
    Ok(())
}

async fn renew_action(app: Arc<App>, input: &Value) -> io::Result<Value> {
    if login_active(&app).await {
        return Err(io::Error::other("请先完成或取消当前登录"));
    }
    let _operation = crate::config_ops::operation(&app.bridge)?;
    let id = text(&input["id"]).to_owned();
    let used = crate::remote::server_accounts(&app.bridge)?;
    let state = {
        let _guard = app.accounts.mutation.lock().await;
        capture(&app)?;
        let row = rows(&app)?
            .into_iter()
            .find(|r| r["id"] == id)
            .ok_or_else(|| io::Error::other("账号不存在"))?;
        renewal(&app, &row, &owner_id(&app)?, &used)?
    };
    let refused = match text(&state["state"]) {
        "auto" | "retry" => None,
        "codex" => Some("此账号正在使用，由 Codex 自己续期。"),
        "remote" => Some("SSH 服务器正在使用此账号，未续期。"),
        "relogin" => Some("此账号登录已失效，请重新登录。"),
        "pending" => Some("请先应用新登录。"),
        _ => Some("此账号的登录记录无法续期。"),
    };
    if let Some(message) = refused {
        return Err(io::Error::other(message));
    }
    let item = quota(app.clone(), id, true).await?;
    if item["renewed"] != true {
        return Err(io::Error::other("续期失败，稍后会自动重试。"));
    }
    Ok(json!({"items":[item]}))
}

async fn quota(app: Arc<App>, id: String, renew: bool) -> io::Result<Value> {
    let mut tasks = app.accounts.quotas.lock().await;
    let mut receiver = if let Some(receiver) = tasks.get(&id) {
        receiver.clone()
    } else {
        let (tx, rx) = watch::channel(None);
        tasks.insert(id.clone(), rx.clone());
        let owned = app.clone();
        tokio::spawn(async move {
            let result = {
                let _slot = owned.accounts.slots.acquire().await.unwrap();
                read_quota(&owned, &id, renew)
                    .await
                    .map_err(|e| e.to_string())
            };
            let mut tasks = owned.accounts.quotas.lock().await;
            let _ = tx.send(Some(result));
            tasks.remove(&id);
        });
        rx
    };
    drop(tasks);
    loop {
        if let Some(result) = receiver.borrow().clone() {
            return result.map_err(io::Error::other);
        }
        receiver.changed().await.map_err(io::Error::other)?;
    }
}

pub async fn keep_alive(app: Arc<App>) {
    tokio::time::sleep(std::time::Duration::from_secs(60)).await;
    if !login_active(&app).await
        && let Ok(_operation) = crate::config_ops::operation(&app.bridge)
        && let Err(error) = clean_accounts(&app).await
    {
        let _ = crate::diagnostics::log(
            &app.bridge,
            "data.cleanup",
            json!({"kind":"accounts","status":"failed","reason":error.to_string()}),
        );
    }
    loop {
        if let Err(error) = renew_due(&app).await
            && let Err(log_error) = crate::diagnostics::log(
                &app.bridge,
                "official.renew",
                json!({"status":"failed","reason":error.to_string()}),
            )
        {
            eprintln!("Renew failure log failed: {log_error}");
        }
        tokio::time::sleep(std::time::Duration::from_secs(3600)).await;
    }
}

fn directory_size(path: &Path) -> io::Result<u64> {
    if path.is_file() {
        return Ok(fs::metadata(path)?.len());
    }
    let mut total = 0;
    for entry in fs::read_dir(path)? {
        total += directory_size(&entry?.path())?;
    }
    Ok(total)
}

fn indexed_ids(app: &App) -> io::Result<Vec<Value>> {
    Ok(rows(app)?
        .into_iter()
        .map(|row| row["id"].clone())
        .collect())
}

pub async fn clean_accounts(app: &App) -> io::Result<()> {
    let _guard = app.accounts.mutation.lock().await;
    let root = app.bridge.join("accounts");
    let login = root.join("login");
    let indexed = indexed_ids(app)?;
    let mut deleted_entries = 0u64;
    let mut freed_bytes = 0u64;
    let mut remove = |path: &Path| -> io::Result<()> {
        let size = directory_size(path).unwrap_or(0);
        if path.is_dir() {
            fs::remove_dir_all(path)?;
        } else {
            fs::remove_file(path)?;
        }
        deleted_entries += 1;
        freed_bytes += size;
        Ok(())
    };
    if login.is_dir() {
        let mut preserve_top = false;
        for entry in fs::read_dir(&login)? {
            let path = entry?.path();
            if path.is_dir() {
                let value = read(&path.join("auth.json"), Value::Null)?;
                let preserve = identity(&value)
                    .map(|info| !indexed.contains(&info["id"]))
                    .unwrap_or(false);
                if !preserve {
                    remove(&path)?;
                }
            } else if path.file_name().and_then(|v| v.to_str()) == Some("auth.json") {
                let value = read(&path, Value::Null)?;
                preserve_top = identity(&value)
                    .map(|info| !indexed.contains(&info["id"]))
                    .unwrap_or(false);
            }
        }
        if !preserve_top {
            for entry in fs::read_dir(&login)? {
                let path = entry?.path();
                if path.is_file() {
                    remove(&path)?;
                }
            }
        }
    }
    if root.is_dir() {
        for entry in fs::read_dir(&root)? {
            let path = entry?.path();
            if path.file_name().and_then(|v| v.to_str()) == Some("login") || !path.is_dir() {
                continue;
            }
            let name = path.file_name().and_then(|v| v.to_str()).unwrap_or("");
            if indexed.iter().any(|id| text(id) == name) || path.join("auth.json").exists() {
                continue;
            }
            remove(&path)?;
        }
    }
    if deleted_entries > 0 {
        crate::diagnostics::log(
            &app.bridge,
            "data.cleanup",
            json!({"kind":"accounts","deletedEntries":deleted_entries,"freedBytes":freed_bytes}),
        )?;
    }
    Ok(())
}
pub fn claims(token: &str) -> Value {
    let Some(payload) = token.split('.').nth(1) else {
        return Value::Null;
    };
    let mut acc: u32 = 0;
    let mut bits = 0;
    let mut out = Vec::new();
    for c in payload.bytes() {
        let n = match c {
            b'A'..=b'Z' => c - b'A',
            b'a'..=b'z' => c - b'a' + 26,
            b'0'..=b'9' => c - b'0' + 52,
            b'-' | b'+' => 62,
            b'_' | b'/' => 63,
            _ => return Value::Null,
        };
        acc = (acc << 6) | u32::from(n);
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((acc >> bits) as u8);
        }
    }
    serde_json::from_slice(&out).unwrap_or(Value::Null)
}
