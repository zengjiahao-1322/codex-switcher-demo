//! Local diagnostic records. Redaction is applied once at the disk boundary.
use regex::{Regex, RegexBuilder};
use serde_json::{Value, json};
use std::{
    env, fs, io,
    io::Write,
    path::{Path, PathBuf},
    sync::OnceLock,
};

pub fn now() -> String {
    time::OffsetDateTime::now_utc()
        .format(&time::format_description::well_known::Rfc3339)
        .unwrap()
}
fn expressions() -> &'static Vec<Regex> {
    static EXPRESSIONS: OnceLock<Vec<Regex>> = OnceLock::new();
    EXPRESSIONS.get_or_init(|| {
        [
            r"(?i)token|secret|password|api[-_]?key|authorization|cookie|credential",
            r"\beyJ[A-Za-z0-9_.-]+",
            r"\bsk-[A-Za-z0-9_-]+",
            r#"(?i)\bBearer\s+[^\s\"'<>]+"#,
            r#"(?i)([?&](?:code|state|[a-z_-]*token)=)[^&#\s\"'<>]*"#,
            r"(?i)\b([a-z0-9._%+-]{1,64})@([a-z0-9.-]+\.[a-z]{2,})\b",
        ]
        .into_iter()
        .map(|s| Regex::new(s).unwrap())
        .collect()
    })
}
pub fn redact(value: &Value) -> Value {
    let rules = expressions();
    match value {
        Value::Array(values) => Value::Array(values.iter().map(redact).collect()),
        Value::Object(values) => Value::Object(
            values
                .iter()
                .map(|(key, value)| {
                    (
                        key.clone(),
                        if rules[0].is_match(key) {
                            json!("[已隐藏]")
                        } else {
                            redact(value)
                        },
                    )
                })
                .collect(),
        ),
        Value::String(value) => {
            let text = rules[1].replace_all(value, "[已隐藏]");
            let text = rules[2].replace_all(&text, "[已隐藏]");
            let text = rules[3].replace_all(&text, "Bearer [已隐藏]");
            let text = rules[4].replace_all(&text, "${1}[已隐藏]");
            let mut text = rules[5]
                .replace_all(&text, |captures: &regex::Captures| {
                    format!(
                        "{}***@{}",
                        captures[1].chars().take(2).collect::<String>(),
                        &captures[2]
                    )
                })
                .to_string();
            if let Some(home) = env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" }) {
                let home = home.to_string_lossy();
                for path in [home.to_string(), home.replace('\\', "/")] {
                    if !path.is_empty() {
                        text = RegexBuilder::new(&regex::escape(&path))
                            .case_insensitive(cfg!(windows))
                            .build()
                            .unwrap()
                            .replace_all(&text, "~")
                            .to_string();
                    }
                }
            }
            json!(text)
        }
        _ => value.clone(),
    }
}
pub fn log(bridge: &Path, event: &str, fields: Value) -> io::Result<()> {
    let dir = bridge.join("logs");
    fs::create_dir_all(&dir)?;
    let file = dir.join("switcher.log");
    if fs::metadata(&file)
        .map(|m| m.len() > 2 * 1024 * 1024)
        .unwrap_or(false)
    {
        let second = dir.join("switcher.log.2");
        if second.exists() {
            fs::remove_file(second)?;
        }
        let first = dir.join("switcher.log.1");
        if first.exists() {
            fs::rename(&first, dir.join("switcher.log.2"))?;
        }
        fs::rename(&file, first)?;
    }
    let mut row = json!({"t":now(),"pid":std::process::id(),"event":event});
    if let Value::Object(fields) = fields {
        row.as_object_mut().unwrap().extend(fields);
    }
    let mut options = fs::OpenOptions::new();
    options.append(true).create(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    writeln!(options.open(file)?, "{}", redact(&row))
}
pub fn recent(bridge: &Path, limit: usize) -> io::Result<Vec<Value>> {
    let mut rows = Vec::new();
    for name in ["switcher.log.2", "switcher.log.1", "switcher.log"] {
        let file = bridge.join("logs").join(name);
        if !file.exists() {
            continue;
        }
        for line in fs::read_to_string(file)?
            .lines()
            .filter(|line| !line.is_empty())
        {
            rows.push(serde_json::from_str::<Value>(line).map_err(io::Error::other)?);
        }
    }
    rows.sort_by(|a, b| a["t"].as_str().cmp(&b["t"].as_str()));
    if rows.len() > limit {
        rows.drain(..rows.len() - limit);
    }
    Ok(rows)
}
pub fn export(app: &crate::server::App) -> io::Result<Value> {
    let (path, trusted) = crate::platform::codex_path(&app.bridge)
        .map(|path| {
            let trusted = crate::platform::trusted_codex(&path);
            (json!(path), trusted)
        })
        .unwrap_or((Value::Null, false));
    let clients = crate::platform::client_status(&app.codex_home())?;
    let header = redact(&json!({
        "build":crate::instance::runtime(),
        "platform":if cfg!(windows){
            "win32"
        }else{
            "darwin"
        },
        "arch":if cfg!(target_arch="aarch64"){
            "arm64"
        }else{
            "x64"
        },
        "osVersion":crate::platform::os_version(),
        "codexVersion":crate::platform::codex_version(&app.bridge).ok(),
        "runtime":{
            "path":path,
            "trusted":trusted
        },
        "proxySource":crate::platform::proxy_source(),
        "codexHome":app.codex_home(),
        "dataDirProtection":{
            "ok":app.protection.ok
        },
        "current":app.state()?["current"],
        "clients":clients["clients"],
        "remotes":remote_snapshot(&app.bridge)?
    }));
    let lines = recent(&app.bridge, 2000)?
        .iter()
        .map(|row| row.to_string())
        .collect::<Vec<_>>()
        .join("\n");
    let stamp = time::OffsetDateTime::now_utc()
        .format(
            &time::format_description::parse_borrowed::<2>(
                "[year][month][day]-[hour][minute][second]",
            )
            .unwrap(),
        )
        .unwrap();
    Ok(
        json!({"filename":format!("codex-switcher-diagnostics-{stamp}.txt"),"text":format!("{header}\n---\n{lines}\n")}),
    )
}
fn remote_snapshot(bridge: &Path) -> io::Result<Vec<Value>> {
    let directory = bridge.join("clients");
    if !directory.is_dir() {
        return Ok(Vec::new());
    }
    let known = json_optional(&bridge.join("accounts/index.json"));
    let now = time::OffsetDateTime::now_utc().unix_timestamp_nanos() / 1_000_000;
    let mut groups = Vec::<Value>::new();
    for entry in fs::read_dir(directory)? {
        let file = entry?.path();
        if file.extension().is_none_or(|s| s != "json") {
            continue;
        }
        let row = json_optional(&file);
        if now - row["seenAt"].as_i64().unwrap_or(0) as i128 >= 15000
            && row["waitUntil"].as_i64().unwrap_or(0) as i128 <= now
        {
            continue;
        }
        let Some(authority) = row["authority"].as_str().filter(|s| !s.is_empty()) else {
            continue;
        };
        let agent = &row["remoteAgent"];
        let key = json!([authority, agent["codexHome"]]);
        if let Some(group) = groups.iter_mut().find(|g| g["_key"] == key) {
            let version = row["companionVersion"].as_str().unwrap_or("");
            let versions = group["companionVersion"]
                .as_str()
                .unwrap_or("")
                .split(", ")
                .collect::<Vec<_>>();
            if !versions.contains(&version) {
                group["companionVersion"] = json!(format!("{}, {version}", versions.join(", ")));
            }
            continue;
        }
        let account = if agent["account"].is_object() {
            let a = &agent["account"];
            let id = if known
                .as_array()
                .is_some_and(|rows| rows.iter().any(|r| r["id"] == a["id"]))
            {
                a["id"].clone()
            } else {
                Value::Null
            };
            json!({"id":id,"email":a["email"],"plan":a["plan"],"lastRefresh":a["lastRefresh"]})
        } else {
            Value::Null
        };
        let current = if agent["current"].is_object() {
            json!({"modelProvider":agent["current"]["modelProvider"],"model":agent["current"]["model"]})
        } else {
            Value::Null
        };
        groups.push(json!({
            "_key":key,
            "host":agent["host"].as_str().unwrap_or(authority.trim_start_matches("ssh-remote+")),
            "platform":agent["platform"],
            "arch":agent["arch"],
            "codexHome":agent["codexHome"],
            "agentVersion":agent["agentVersion"],
            "agentProtocol":agent["protocol"].as_u64().unwrap_or(0),
            "companionVersion":row["companionVersion"].as_str().unwrap_or(""),
            "account":account,
            "current":current
        }));
    }
    for group in &mut groups {
        group.as_object_mut().unwrap().remove("_key");
    }
    Ok(groups)
}
pub fn algorithm(args: &[String]) -> io::Result<()> {
    let input: Value = serde_json::from_slice(&fs::read(&args[0])?).map_err(io::Error::other)?;
    let output = match input["op"].as_str() {
        Some("otherInstallAction") => json!(crate::instance::other_action(
            input["old"].as_u64().unwrap_or(0),
            input["current"].as_u64().unwrap_or(0)
        )),
        Some("windowsProxyEnv") => json!(crate::platform::windows_proxy_env(&input["value"])),
        Some("tomlPreserve") => {
            crate::config::toml_fixture(&input["text"], &input["selection"], &input["bridge"])
        }
        Some("redact") => redact(&input["value"]),
        Some("log") => {
            let bridge = PathBuf::from(input["bridge"].as_str().unwrap());
            log(
                &bridge,
                input["event"].as_str().unwrap(),
                input["fields"].clone(),
            )?;
            json!(recent(&bridge, 2000)?)
        }
        _ => return Err(io::Error::other("Unknown algorithm fixture")),
    };
    fs::write(
        &args[1],
        serde_json::to_vec(&output).map_err(io::Error::other)?,
    )
}

fn database(home: &Path, prefix: &str) -> io::Result<Option<crate::sqlite::Database>> {
    let expression = Regex::new(&format!(r"^{prefix}(?:_(\d+))?\.sqlite$")).unwrap();
    let mut files = Vec::new();
    for entry in fs::read_dir(home)? {
        let entry = entry?;
        if let Some(captures) = expression.captures(&entry.file_name().to_string_lossy()) {
            files.push((
                captures
                    .get(1)
                    .and_then(|m| m.as_str().parse::<u64>().ok())
                    .unwrap_or(0),
                entry.path(),
            ));
        }
    }
    files.sort_by_key(|(version, _)| std::cmp::Reverse(*version));
    files
        .into_iter()
        .next()
        .map(|(_, file)| crate::sqlite::Database::open(&file))
        .transpose()
}
fn columns(db: &crate::sqlite::Database, table: &str) -> io::Result<Vec<String>> {
    Ok(db
        .query(&format!("PRAGMA table_info({table})"), &[])?
        .iter()
        .filter_map(|row| row["name"].as_str().map(str::to_owned))
        .collect())
}
fn thread_row(home: &Path, id: &str) -> io::Result<Value> {
    database(home, "state")?
        .ok_or_else(|| io::Error::other("本机索引中没有该会话。"))?
        .query("SELECT * FROM threads WHERE id=?", &[json!(id)])?
        .into_iter()
        .next()
        .ok_or_else(|| io::Error::other("本机索引中没有该会话。"))
}
pub fn threads(home: &Path, input: &Value) -> Value {
    let query = (|| -> io::Result<Value> {
        let Some(db) = database(home, "state")? else {
            return Ok(
                json!({"items":[],"error":"未找到本机 Codex 会话索引；云端聊天需在官方账号中打开。"}),
            );
        };
        let available = columns(&db, "threads")?;
        let selected = [
            "id",
            "title",
            "updated_at",
            "model",
            "model_provider",
            "archived",
            "source",
        ]
        .into_iter()
        .filter(|key| available.iter().any(|s| s == key))
        .collect::<Vec<_>>()
        .join(",");
        let query = input["query"]
            .as_str()
            .unwrap_or("")
            .chars()
            .take(200)
            .collect::<String>();
        let pattern = format!("%{query}%");
        let limit = input["limit"]
            .as_i64()
            .filter(|n| *n != 0)
            .unwrap_or(80)
            .min(200);
        let items=db.query(&format!("SELECT {selected} FROM threads WHERE id LIKE ? OR title LIKE ? ORDER BY updated_at DESC LIMIT ?"),&[json!(pattern),json!(pattern),json!(limit)])?;
        Ok(json!({"items":items,"source":"本机 Codex 会话索引"}))
    })();
    query.unwrap_or_else(
        |_| json!({"items":[],"error":"无法读取本机会话索引，请确认当前配置目录和 Codex 版本。"}),
    )
}
pub fn classify(text: &str) -> Option<&'static str> {
    let patterns = [
        (
            "encrypted",
            r"invalid_encrypted_content|encrypted (content|reasoning).*(invalid|decrypt)|failed to decrypt",
        ),
        (
            "model",
            r"model_not_found|model.*(not found|not supported|does not exist|not available)|unsupported.*model",
        ),
        (
            "provider",
            r"unknown model provider|provider.*(not found|not defined)|model_provider.*(unknown|missing)",
        ),
        (
            "work_auth",
            r"Work browser access requires an authenticated account",
        ),
        (
            "auth",
            r"\b401\b|token.*(expired|invalid)|unauthorized|not authenticated",
        ),
        ("forbidden", r"\b403\b|permission.denied|not authorized"),
        (
            "quota",
            r"\b429\b|insufficient_quota|rate.limit|quota.*exceed",
        ),
        (
            "network",
            r"connection.*(refused|reset|failed)|timed out|timeout|tls.*(error|failed)|dns error",
        ),
    ];
    patterns.into_iter().find_map(|(code, pattern)| {
        RegexBuilder::new(pattern)
            .case_insensitive(true)
            .build()
            .unwrap()
            .is_match(text)
            .then_some(code)
    })
}
fn rollout(file: &Path) -> io::Result<Value> {
    use std::io::{Read, Seek, SeekFrom};
    if !file.exists() {
        return Ok(json!({"exists":false}));
    }
    let mut handle = fs::File::open(file)?;
    let size = handle.metadata()?.len();
    let mut head = vec![0u8; size.min(131072) as usize];
    handle.read_exact(&mut head)?;
    handle.seek(SeekFrom::Start(size.saturating_sub(2097152)))?;
    let mut tail = Vec::new();
    handle.read_to_end(&mut tail)?;
    let encrypted = Regex::new(r#""encrypted_content"\s*:\s*"[^"\s]"#)
        .unwrap()
        .is_match(&String::from_utf8_lossy(&tail));
    let mut result =
        json!({"exists":true,"encrypted":encrypted,"model":null,"provider":null,"errors":[]});
    for bytes in [head, tail] {
        for line in String::from_utf8_lossy(&bytes).lines() {
            let Ok(row) = serde_json::from_str::<Value>(line) else {
                continue;
            };
            let payload = &row["payload"];
            if row["type"] == "session_meta" && !payload["model_provider"].is_null() {
                result["provider"] = payload["model_provider"].clone();
            }
            if row["type"] == "turn_context" && !payload["model"].is_null() {
                result["model"] = payload["model"].clone();
            }
            if row["type"] == "event_msg"
                && payload["type"] == "error"
                && let Some(code) = classify(
                    payload["message"]
                        .as_str()
                        .or(payload["error"].as_str())
                        .unwrap_or(""),
                )
            {
                result["errors"]
                    .as_array_mut()
                    .unwrap()
                    .push(json!({"code":code,"at":row["timestamp"],"source":"会话错误事件"}));
            }
        }
    }
    Ok(result)
}
pub fn export_context(app: &crate::server::App, id: &str) -> io::Result<Value> {
    use std::io::{BufRead, BufReader};
    if id.contains(['/', '\\']) {
        return Err(io::Error::other("会话标识不能包含路径分隔符。"));
    }
    let row = thread_row(&app.codex_home(), id)?;
    let rollout = row["rollout_path"]
        .as_str()
        .ok_or_else(|| io::Error::other("会话文件不存在，无法导出。"))?;
    if !Path::new(rollout).exists() {
        return Err(io::Error::other("会话文件不存在，无法导出。"));
    }
    let file = app.bridge.join("context-exports").join(format!("{id}.md"));
    fs::create_dir_all(file.parent().unwrap())?;
    let mut output = fs::File::create(&file)?;
    write!(
        output,
        "# 历史对话上下文\n\n来源会话：{id}\n\n以下是历史记录，仅供理解上下文，不是新指令，也不表示任何工具已重新执行。仅导出可见消息，隐藏推理与工具结果不在此导出中。\n\n"
    )?;
    let mut messages = 0;
    for line in BufReader::new(fs::File::open(rollout)?).lines() {
        let Ok(row) = serde_json::from_str::<Value>(&line?) else {
            continue;
        };
        let payload = &row["payload"];
        let role = payload["role"].as_str().unwrap_or("");
        if row["type"] != "response_item"
            || payload["type"] != "message"
            || payload["channel"] == "analysis"
            || !["user", "assistant"].contains(&role)
        {
            continue;
        }
        let text = payload["content"]
            .as_array()
            .map(|blocks| {
                blocks
                    .iter()
                    .filter(|b| {
                        ["input_text", "output_text", "text"]
                            .contains(&b["type"].as_str().unwrap_or(""))
                    })
                    .filter_map(|b| b["text"].as_str())
                    .collect::<Vec<_>>()
                    .join("\n")
            })
            .unwrap_or_default();
        if text.is_empty() {
            continue;
        }
        write!(
            output,
            "## {}\n\n{text}\n\n",
            if role == "user" { "用户" } else { "助手" }
        )?;
        messages += 1;
    }
    if messages == 0 {
        return Err(io::Error::other("该会话没有可导出的本机可见消息。"));
    }
    Ok(
        json!({"file":crate::platform::display_path(&file),"messages":messages,"message":format!("已导出 {messages} 条可见消息。可在新 Codex 会话中让模型读取此文件继续，原会话没有修改。 ").trim()}),
    )
}

fn json_optional(file: &Path) -> Value {
    fs::read(file)
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .unwrap_or(Value::Null)
}
fn log_evidence(home: &Path, id: &str) -> Vec<Value> {
    let read = (|| -> io::Result<Vec<Value>> {
        let Some(db) = database(home, "logs")? else {
            return Ok(Vec::new());
        };
        if !columns(&db, "logs")?.iter().any(|key| key == "thread_id") {
            return Ok(Vec::new());
        }
        let rows=db.query("SELECT ts,feedback_log_body FROM logs WHERE thread_id=? AND level IN ('ERROR','WARN') ORDER BY id DESC LIMIT 300",&[json!(id)])?;
        Ok(rows.into_iter().filter_map(|row|classify(row["feedback_log_body"].as_str().unwrap_or("")).map(|code|json!({
            "code":code,
            "at":time::OffsetDateTime::from_unix_timestamp(row["ts"].as_i64().unwrap_or(0)).ok().and_then(|t|t.format(&time::format_description::well_known::Rfc3339).ok()),
            "source":"关联会话的 Codex 日志"
        }))).collect())
    })();
    read.unwrap_or_default()
}
fn label(code: &str) -> (&str, &str) {
    match code {
        "encrypted" => (
            "后端拒绝了历史加密内容",
            "此会话记录了加密内容错误，跨后端续聊无法靠换模型名称修复。可切回原来源，或导出可见对话作为新会话上下文。",
        ),
        "model" => (
            "模型被后端拒绝",
            "关联错误显示模型不存在、不可用或不受支持。重新获取目标来源的模型，选择可用模型后应用。",
        ),
        "provider" => (
            "供应商定义缺失",
            "关联错误显示供应商配置不可解析。请恢复该会话使用的供应商，或导出可见对话后新建会话。",
        ),
        "work_auth" => (
            "聊天 / Work 缺少官方身份",
            "错误明确要求官方身份，请切到官方账号后重新打开。",
        ),
        "auth" => (
            "登录或 API 鉴权失败",
            "关联错误显示凭据无效或过期。官方账号可重新登录；API 请检查密钥后重新检测。",
        ),
        "forbidden" => (
            "访问被拒绝",
            "后端拒绝了请求。核对账号工作区、模型权限或供应商访问限制。",
        ),
        "quota" => (
            "额度或频率限制",
            "后端显示额度或频率限制。查看来源额度，稍后重试或切换可用来源。",
        ),
        _ => (
            "连接失败",
            "关联错误显示超时或网络连接失败。检查本机转换服务、网络和 API 地址。",
        ),
    }
}
fn finding(findings: &mut Vec<Value>, level: &str, title: &str, detail: &str) {
    findings.push(json!({"level":level,"title":title,"detail":detail}));
}
pub fn diagnose(app: &crate::server::App, input: &Value) -> io::Result<Value> {
    let text = fs::read_to_string(app.codex_home().join("config.toml")).unwrap_or_default();
    let Ok(config) = toml::from_str::<toml::Value>(&text) else {
        return Ok(
            json!({"findings":[{"level":"error","title":"当前配置无法解析","detail":"请修复 config.toml 后重新诊断。"}],"actions":[]}),
        );
    };
    let config: Value = serde_json::to_value(config).map_err(io::Error::other)?;
    let provider = config["model_provider"].as_str().unwrap_or("openai");
    let official = provider == "openai";
    let auth = json_optional(&app.codex_home().join("auth.json"));
    let access = crate::accounts::claims(auth["tokens"]["access_token"].as_str().unwrap_or(""));
    let active = !auth["tokens"]["access_token"]
        .as_str()
        .unwrap_or("")
        .is_empty()
        && !auth["tokens"]["account_id"]
            .as_str()
            .unwrap_or("")
            .is_empty();
    let mut findings = Vec::new();
    let mut actions = Vec::new();
    let clients = crate::platform::client_status(&app.codex_home())?;
    if clients["clients"].as_array().is_some_and(|rows| {
        rows.iter().any(|row| {
            row["shared"] == true && row["overrides"].as_object().is_some_and(|o| !o.is_empty())
        })
    }) {
        finding(
            &mut findings,
            "warn",
            "有客户端使用配置档或启动参数覆盖",
            "它共用当前目录，但启动时另外指定了模型或供应商。请在客户端列表展开配置层，调整该配置档或启动参数；只改全局默认配置不能覆盖这些值。",
        );
    }
    let effect = json_optional(&app.bridge.join("effect.json"));
    use sha2::{Digest, Sha256};
    if effect["status"] == "restart_required"
        && effect["configHash"].as_str()
            == Some(format!("{:x}", Sha256::digest(text.as_bytes())).as_str())
    {
        finding(
            &mut findings,
            "warn",
            "配置已写入，尚需重启",
            "上次切换尚未完成重新打开。",
        );
        actions.push(json!({"type":"reapply","label":"重新应用当前来源并重启"}));
    }
    if official && !active {
        finding(
            &mut findings,
            "error",
            "未检测到可用的官方文件登录",
            "当前官方模式没有完整的 auth.json 登录记录。请添加或重新登录官方账号。",
        );
        actions.push(json!({"type":"accounts","label":"管理官方账号"}));
    } else if official
        && access["exp"]
            .as_i64()
            .is_some_and(|exp| exp < time::OffsetDateTime::now_utc().unix_timestamp())
    {
        finding(
            &mut findings,
            "info",
            "官方访问令牌已到期",
            "仅凭本地 access token 的过期时间无法判断登录失效；请通过额度刷新或应用账号进行官方验证。",
        );
    }
    if let Some(path) = config["model_catalog_json"].as_str() {
        let path = app.codex_home().join(path);
        let catalog = json_optional(&path);
        if let Some(models) = catalog["models"].as_array() {
            if models.iter().any(|model| model["slug"] == config["model"]) {
                finding(
                    &mut findings,
                    "ok",
                    "模型目录包含当前模型",
                    &format!(
                        "{} 在指定目录中；这只确认列表，不代表后端权限。",
                        config["model"].as_str().unwrap_or("")
                    ),
                );
            } else {
                finding(
                    &mut findings,
                    "warn",
                    "当前模型不在指定目录",
                    &format!(
                        "目录有 {} 个模型，但没有 {}。重新获取模型后应用。",
                        models.len(),
                        config["model"].as_str().unwrap_or("")
                    ),
                );
            }
        } else {
            finding(
                &mut findings,
                "error",
                "模型目录无法读取",
                &format!(
                    "配置指定的模型目录不存在或格式无效：{}",
                    crate::platform::display_path(&path)
                ),
            );
        }
    }
    let mut thread = Value::Null;
    if let Some(id) = input["id"].as_str().filter(|id| !id.is_empty()) {
        let row = thread_row(&app.codex_home(), id)?;
        let info = rollout(Path::new(row["rollout_path"].as_str().unwrap_or("")))?;
        let target_provider = row["model_provider"]
            .as_str()
            .or(info["provider"].as_str())
            .unwrap_or("openai");
        let model = row["model"].as_str().or(info["model"].as_str());
        thread = json!({
            "id":row["id"],
            "title":row["title"],
            "provider":target_provider,
            "model":model,
            "cwd":row["cwd"],
            "archived":row["archived"].as_i64().unwrap_or(0)!=0,
            "hasEncryptedContent":info["encrypted"].as_bool().unwrap_or(false)
        });
        if info["exists"] != true {
            finding(
                &mut findings,
                "error",
                "会话文件缺失",
                "索引存在，但对应会话文件不在本机。恢复原文件或在官方账号查看云端记录。",
            );
        }
        let defined = ["openai", "ollama", "lmstudio", "oss"].contains(&target_provider)
            || !config["model_providers"][target_provider].is_null();
        if !defined {
            finding(
                &mut findings,
                "error",
                "此旧会话的供应商没有定义",
                &format!(
                    "会话绑定 {target_provider}，当前配置中没有该供应商；切换全局默认模型不会补齐这个定义。"
                ),
            );
        } else if target_provider != provider {
            finding(
                &mut findings,
                "warn",
                "旧会话尚未同步当前来源",
                &format!(
                    "旧会话保存的是 {target_provider}，当前选择是 {provider}。重新应用当前来源会自动同步未归档旧对话，无需逐条处理。"
                ),
            );
            actions.push(json!({"type":"reapply","label":"重新应用当前来源并同步旧对话"}));
        }
        let catalog = if target_provider == "openai" {
            Some(app.codex_home().join("models_cache.json"))
        } else if target_provider == provider {
            config["model_catalog_json"]
                .as_str()
                .map(|path| app.codex_home().join(path))
        } else {
            None
        };
        if let (Some(model), Some(path)) = (model, catalog)
            && let Some(models) = json_optional(&path)["models"].as_array()
            && !models.iter().any(|entry| entry["slug"] == model)
        {
            finding(
                &mut findings,
                "warn",
                "旧会话模型不在本机对应目录",
                &format!(
                    "{model} 不在当前缓存的模型目录中。这不能证明服务端下线；可在旧会话内选择可用模型，打不开时导出可见对话供新会话继续。"
                ),
            );
        }
        if active
            && row["creator_account_id"]
                .as_str()
                .is_some_and(|id| Some(id) != auth["tokens"]["account_id"].as_str())
        {
            finding(
                &mut findings,
                "warn",
                "会话创建账号与当前文件登录不同",
                "这是会话元数据的账号差异，是否导致访问失败还需关联错误确认。",
            );
            let accounts = json_optional(&app.bridge.join("accounts/index.json"));
            let creator_hash = format!(
                "{:x}",
                Sha256::digest(format!(
                    "{}\0{}",
                    row["creator_account_id"].as_str().unwrap_or(""),
                    row["creator_user_id"].as_str().unwrap_or("")
                ))
            );
            if let Some(account) = accounts.as_array().and_then(|accounts| {
                accounts.iter().find(|a| {
                    a["accountId"] == row["creator_account_id"]
                        && (row["creator_user_id"].as_str().is_none_or(|s| s.is_empty())
                            || a["id"] == creator_hash[..20])
                })
            }) {
                actions.push(
                    json!({"type":"account","id":account["id"],"label":"切换到会话创建账号"}),
                );
            }
        }
        let mut evidence = info["errors"].as_array().cloned().unwrap_or_default();
        evidence.extend(log_evidence(&app.codex_home(), id));
        evidence.sort_by(|a, b| b["at"].as_str().cmp(&a["at"].as_str()));
        let mut seen = std::collections::HashSet::new();
        for item in &evidence {
            let code = item["code"].as_str().unwrap_or("");
            if !seen.insert(code) {
                continue;
            }
            let (title, detail) = label(code);
            finding(
                &mut findings,
                "error",
                &format!("关联错误记录：{title}"),
                &format!(
                    "{detail} 证据：{}，{}。这是历史记录，当前是否仍失败可通过新会话或实时检测确认。",
                    item["source"].as_str().unwrap_or(""),
                    item["at"].as_str().unwrap_or("")
                ),
            );
        }
        if evidence.is_empty() {
            finding(
                &mut findings,
                "info",
                "没有找到关联的明确错误",
                "已检查会话错误事件和本机日志；缺少后端拒绝证据时，不把猜测当作根因。",
            );
        }
        if info["encrypted"] == true && !seen.contains("encrypted") {
            finding(
                &mut findings,
                "info",
                "历史包含加密推理内容",
                "仅发现加密内容不能证明不兼容；如果换后端后才失败，可切回原来源，或导出可见对话另开会话。",
            );
        }
        if target_provider == "hermes_bridge" && model.is_some() {
            finding(
                &mut findings,
                "info",
                "旧 API 名称无法从共享供应商标记还原",
                "该会话只记录 hermes_bridge；历史未保存具体 API 地址，工具不会猜测原供应商。",
            );
            actions.push(json!({"type":"api","model":model,"label":"选择 API 与会话模型"}));
        }
        actions.push(json!({"type":"export","id":id,"label":"导出可见对话，供新会话继续"}));
    }
    if !official {
        actions.push(json!({"type":"probe","label":"检测当前 API 与模型"}));
    }
    if findings.is_empty() {
        finding(
            &mut findings,
            "ok",
            "未发现本地配置错误",
            "可选一个具体旧会话继续检查，或用新会话验证服务端实际可用性。",
        );
    }
    Ok(json!({"thread":thread,"findings":findings,"actions":actions,"checkedAt":now()}))
}
