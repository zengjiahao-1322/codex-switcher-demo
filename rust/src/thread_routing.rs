//! Only official RPC changes conversation settings. SQLite is read-only and
//! cold thread/read verifies persistence; visible chat/tool records stay intact.
use crate::{editors::text, official_session::Session, server::App};
use serde_json::{Value, json};
use std::{
    collections::VecDeque,
    fs,
    io::{self, Read, Seek, SeekFrom},
    path::Path,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
};
pub fn service_tier(path: &Path) -> io::Result<Option<Value>> {
    let mut file = fs::File::open(path)?;
    let mut position = file.metadata()?.len();
    let mut remainder = vec![];
    fn setting(line: &[u8]) -> io::Result<Option<Value>> {
        if !line.windows(23).any(|w| w == b"thread_settings_applied") {
            return Ok(None);
        }
        let record: Value = serde_json::from_slice(line).map_err(io::Error::other)?;
        Ok(
            if record["type"] == "event_msg"
                && record["payload"]["type"] == "thread_settings_applied"
            {
                record["payload"]["thread_settings"]
                    .get("service_tier")
                    .map(|v| json!({"tier":v}))
            } else {
                None
            },
        )
    }
    while position > 0 {
        let size = position.min(65536) as usize;
        position -= size as u64;
        file.seek(SeekFrom::Start(position))?;
        let mut block = vec![0; size];
        file.read_exact(&mut block)?;
        block.extend(remainder);
        let mut end = block.len();
        while let Some(start) = block[..end].iter().rposition(|b| *b == b'\n') {
            if let Some(v) = setting(&block[start + 1..end])? {
                return Ok(Some(v));
            }
            end = start;
        }
        remainder = block[..end].to_vec();
    }
    setting(&remainder)
}
fn pending(home: &Path) -> io::Result<Vec<Value>> {
    let file = fs::read_dir(home)?
        .filter_map(Result::ok)
        .filter_map(|e| {
            let name = e.file_name().to_string_lossy().to_string();
            name.strip_prefix("state_")
                .and_then(|s| s.strip_suffix(".sqlite"))
                .and_then(|s| s.parse::<u32>().ok())
                .map(|n| (n, e.path()))
        })
        .max_by_key(|(n, _)| *n);
    let Some((_, file)) = file else {
        return Ok(vec![]);
    };
    let db = crate::sqlite::Database::open(&file)?;
    db.query("SELECT id, model_provider, model, rollout_path FROM threads WHERE archived=0 AND source NOT LIKE '%\"subagent\"%' ORDER BY id",&[])
}
async fn initialize(session: &Session) -> io::Result<()> {
    session.rpc("initialize",json!({"clientInfo":{"name":"codex-switcher-routing","version":"1"},"capabilities":{"experimentalApi":true}})).await.map_err(|e|io::Error::other(e.message))?;
    Ok(())
}

fn rpc_error(error: crate::official_session::Failure) -> io::Error {
    io::Error::other(error.message)
}
fn progress(app: &App, completed: usize, total: usize, phase: &str) -> io::Result<()> {
    let file = app.bridge.join("account-switch.json");
    let mut job = crate::accounts::read(&file, Value::Null)?;
    if job["status"] == "switching"
        && job["steps"].as_array().is_some_and(|steps| {
            steps
                .iter()
                .any(|step| step["id"] == "threads" && step["status"] == "running")
        })
    {
        let label = if phase == "verify" {
            "正在核对旧对话持久结果"
        } else {
            "正在同步旧对话来源"
        };
        job["message"] = json!(format!("{label}（{completed}/{total}）…"));
        crate::instance::write_json(&file, &job)?;
    }
    Ok(())
}
async fn apply_row(session: &Session, provider: &str, row: &mut Value) -> io::Result<()> {
    let speed = service_tier(Path::new(text(&row["rollout_path"])))?;
    let mut params = json!({"threadId":row["id"],"modelProvider":provider,"model":row["nextModel"],"excludeTurns":true});
    if let Some(speed) = &speed {
        params["serviceTier"] = speed["tier"].as_str().map_or(json!(""), |v| json!(v));
    }
    let result = session
        .rpc("thread/resume", params)
        .await
        .map_err(rpc_error)?;
    if result["modelProvider"] != provider || result["model"] != row["nextModel"] {
        return Err(io::Error::other(format!(
            "旧对话 {} 未采用目标来源或模型。",
            text(&row["id"])
        )));
    }
    if speed
        .as_ref()
        .is_some_and(|v| result["serviceTier"] != v["tier"])
    {
        return Err(io::Error::other("旧对话原有速度设置未保留。"));
    }
    row["speed"] = json!(speed);
    row["applied"] = json!(true);
    session
        .rpc("thread/unsubscribe", json!({"threadId":row["id"]}))
        .await
        .map_err(rpc_error)?;
    Ok(())
}
async fn verify_row(session: &Session, provider: &str, row: &Value) -> io::Result<()> {
    let result = session
        .rpc(
            "thread/read",
            json!({"threadId":row["id"],"includeTurns":false}),
        )
        .await
        .map_err(rpc_error)?;
    if result["thread"]["modelProvider"] != provider
        || result["thread"]["model"] != row["nextModel"]
    {
        return Err(io::Error::other("旧对话来源或模型未能持久保存。"));
    }
    if row["speed"].is_object()
        && service_tier(Path::new(text(&row["rollout_path"])))?.unwrap_or(Value::Null)["tier"]
            != row["speed"]["tier"]
    {
        return Err(io::Error::other("旧对话速度设置未能持久保留。"));
    }
    Ok(())
}
pub async fn synchronize(
    app: &App,
    mode: &str,
    previous: Option<&str>,
) -> Result<Value, (io::Error, Value)> {
    let mut counts = json!({"updated":0,"skipped":0,"failed":0});
    if mode == "off" {
        return Ok(counts);
    }
    let home = app.codex_home();
    let has_database = fs::read_dir(&home)
        .map_err(|e| (e, counts.clone()))?
        .filter_map(Result::ok)
        .any(|e| {
            let name = e.file_name().to_string_lossy().to_string();
            name.strip_prefix("state_")
                .and_then(|s| s.strip_suffix(".sqlite"))
                .is_some_and(|s| s.parse::<u32>().is_ok())
        });
    if !has_database {
        return Ok(counts);
    }
    let config: Value = serde_json::to_value(
        toml::from_str::<toml::Value>(
            &fs::read_to_string(home.join("config.toml")).map_err(|e| (e, counts.clone()))?,
        )
        .map_err(|e| (io::Error::other(e), counts.clone()))?,
    )
    .unwrap();
    let provider = config["model_provider"].as_str().unwrap_or("openai");
    let mut sessions = vec![];
    let mut total = 0usize;
    let result = async {
        let first = Session::threads(&app.bridge, &home, &config).map_err(rpc_error)?;
        sessions.push(first.clone());
        initialize(&first).await?;
        let mut rows = pending(&home)?;
        rows.retain(|row| {
            let keep = mode != "matching" || row["model_provider"].as_str() == previous;
            if !keep {
                counts["skipped"] = json!(counts["skipped"].as_u64().unwrap() + 1);
            }
            keep
        });
        total = rows.len();
        if total == 0 {
            return Ok(());
        }
        let mut model = config["model"].as_str().map(str::to_owned);
        let mut models = vec![];
        if let Some(catalog) = config["model_catalog_json"].as_str() {
            let catalog = crate::accounts::read(&home.join(catalog), Value::Null)?;
            models = catalog["models"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(|v| v["slug"].as_str().map(str::to_owned))
                .collect();
        }
        if models.is_empty() || model.is_none() {
            let response = first
                .rpc("model/list", json!({}))
                .await
                .map_err(rpc_error)?;
            let list = response["data"]
                .as_array()
                .ok_or_else(|| io::Error::other("未找到目标来源的默认模型，旧对话未更新。"))?;
            if models.is_empty() {
                models = list
                    .iter()
                    .filter_map(|v| v["model"].as_str().map(str::to_owned))
                    .collect();
            }
            if model.is_none() {
                model = list
                    .iter()
                    .find(|v| v["isDefault"] == true)
                    .or(list.first())
                    .and_then(|v| v["model"].as_str().map(str::to_owned));
            }
        }
        let model =
            model.ok_or_else(|| io::Error::other("未找到目标来源的默认模型，旧对话未更新。"))?;
        rows.retain_mut(|row| {
            let target = if models.iter().any(|v| row["model"] == v.as_str()) {
                row["model"].clone()
            } else {
                json!(model)
            };
            row["nextModel"] = target.clone();
            let keep = row["model_provider"] != provider || row["model"] != target;
            if !keep {
                counts["skipped"] = json!(counts["skipped"].as_u64().unwrap() + 1);
            }
            keep
        });
        total = rows.len();
        if total == 0 {
            return Ok(());
        }
        if total > 4 {
            let second = Session::threads(&app.bridge, &home, &config).map_err(rpc_error)?;
            sessions.push(second.clone());
            initialize(&second).await?;
        }
        let queue = Arc::new(Mutex::new(VecDeque::from(rows)));
        let failed = Arc::new(AtomicBool::new(false));
        let mut tasks = vec![];
        let (send, mut receive) = tokio::sync::mpsc::unbounded_channel();
        progress(app, 0, total, "sync")?;
        for worker in 0..total.min(4) {
            let session = sessions[worker % sessions.len()].clone();
            let queue = queue.clone();
            let failed = failed.clone();
            let provider = provider.to_owned();
            let send = send.clone();
            tasks.push(tokio::spawn(async move {
                while !failed.load(Ordering::Relaxed) {
                    let row = queue.lock().unwrap().pop_front();
                    let Some(mut row) = row else {
                        break;
                    };
                    let result = apply_row(&session, &provider, &mut row).await;
                    if result.is_err() {
                        failed.store(true, Ordering::Relaxed);
                    }
                    let _ = send.send((row, result));
                }
            }));
        }
        drop(send);
        let mut applied = vec![];
        let mut failure = None;
        let mut completed = 0usize;
        while let Some((row, result)) = receive.recv().await {
            if row["applied"] == true {
                applied.push(row);
            }
            match result {
                Ok(()) => {
                    completed += 1;
                    if let Err(error) = progress(app, completed, total, "sync") {
                        failed.store(true, Ordering::Relaxed);
                        failure.get_or_insert(error);
                    }
                }
                Err(error) => {
                    failure.get_or_insert(error);
                }
            }
        }
        for task in tasks {
            task.await.map_err(io::Error::other)?;
        }
        for session in &sessions {
            session.close().await;
        }
        sessions.clear();
        let cold = Session::threads(&app.bridge, &home, &config).map_err(rpc_error)?;
        sessions.push(cold.clone());
        initialize(&cold).await?;
        progress(app, 0, applied.len(), "verify")?;
        for (index, row) in applied.iter().enumerate() {
            match verify_row(&cold, provider, row).await {
                Ok(()) => {
                    counts["updated"] = json!(counts["updated"].as_u64().unwrap() + 1);
                    progress(app, index + 1, applied.len(), "verify")?;
                }
                Err(error) => {
                    failure.get_or_insert(error);
                }
            }
        }
        if let Some(error) = failure {
            Err(error)
        } else {
            Ok::<_, io::Error>(())
        }
    }
    .await;
    for session in sessions {
        session.close().await;
    }
    match result {
        Ok(()) => Ok(counts),
        Err(error) => {
            counts["failed"] =
                json!(total.saturating_sub(counts["updated"].as_u64().unwrap_or(0) as usize));
            Err((error, counts))
        }
    }
}
