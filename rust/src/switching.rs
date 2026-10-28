//! A queued switch holds the cross-process operation lock from preparation
//! through client release, configuration commit, conversation sync and reopen.
use crate::{
    accounts, config_ops,
    diagnostics::{log, now},
    editors::{self, text},
    instance::write_json,
    server::App,
};
use serde_json::{Value, json};
use std::{
    fs, io,
    path::Path,
    sync::Arc,
    time::{Duration, Instant},
};

fn config(home: &Path) -> io::Result<Value> {
    let text = config_ops::read(&home.join("config.toml"))?.unwrap_or_default();
    serde_json::to_value(toml::from_str::<toml::Value>(&text).map_err(io::Error::other)?)
        .map_err(io::Error::other)
}
pub fn mode(input: &Value) -> io::Result<&str> {
    let value = input["threadFollow"].as_str().unwrap_or("all");
    if ["all", "matching", "off"].contains(&value) {
        Ok(value)
    } else {
        Err(io::Error::other("旧对话跟随模式无效。"))
    }
}
async fn selected_desktop(snapshot: &Value) -> io::Result<Option<String>> {
    let clients = snapshot["clients"].as_array().unwrap();
    if clients
        .iter()
        .any(|c| c["kind"] == "desktop" && c["confirmed"] != true)
    {
        return Err(io::Error::other(
            "尚未读到桌面端的配置目录，请先在客户端列表核对进程读取错误。",
        ));
    }
    if let Some(c) = clients
        .iter()
        .find(|c| c["kind"] == "desktop" && c["shared"] == true)
    {
        return Ok(Some(text(&c["desktopExecutable"]).into()));
    }
    // Running independent desktops and confirmed editor-only sessions are
    // deliberately left alone. Do not open a second desktop for them.
    if clients.iter().any(|c| {
        c["kind"] == "desktop"
            || (["ide", "editor"].contains(&text(&c["kind"]))
                && c["confirmed"] == true
                && c["shared"] == true)
    }) {
        return Ok(None);
    }
    #[cfg(unix)]
    for dir in [
        std::path::PathBuf::from("/Applications"),
        crate::platform::user_home().join("Applications"),
    ] {
        for name in ["Codex", "ChatGPT"] {
            let file = dir.join("Codex.app/Contents/MacOS").join(name);
            if file.is_file() {
                return Ok(Some(crate::platform::display_path(&file)));
            }
        }
    }
    #[cfg(windows)]
    {
        let output = tokio::process::Command::new("powershell.exe")
            .args(["-NoProfile", "-NonInteractive", "-Command", "$ErrorActionPreference='Stop'; $pkg=Get-AppxPackage -Name OpenAI.Codex | Select-Object -First 1; if($pkg){[Console]::Write((Join-Path $pkg.InstallLocation 'app\\ChatGPT.exe'))}"])
            .creation_flags(0x08000000).output().await?;
        if !output.status.success() {
            return Err(io::Error::other("无法读取 Codex 桌面应用的安装位置。"));
        }
        let path = String::from_utf8(output.stdout).map_err(io::Error::other)?;
        if !path.trim().is_empty() {
            return Ok(Some(path.trim().to_owned()));
        }
    }
    Ok(None)
}
fn check_editors(snapshot: &Value) -> io::Result<()> {
    let clients = snapshot["clients"].as_array().unwrap();
    if clients.iter().any(|c| {
        c["kind"] == "ide" && c["confirmed"] != true && (c["home"].is_null() || c["shared"] == true)
    }) {
        return Err(io::Error::other(
            "无法确认部分 Codex 插件后端的配置目录，尚未切换。请展开“编辑器与诊断”查看进程读取错误。",
        ));
    }
    let missing = clients
        .iter()
        .filter(|c| {
            c["kind"] == "ide"
                && c["confirmed"] == true
                && c["shared"] == true
                && c["editorId"].is_null()
        })
        .collect::<Vec<_>>();
    if !missing.is_empty() {
        return Err(io::Error::other(format!(
            "检测到 {} 个共用配置的 Codex 后端未关联到编辑器窗口（PID {}）。请在“编辑器与诊断”核对连接与进程归属；配置尚未修改，客户端未关闭。",
            missing.len(),
            missing
                .iter()
                .map(|c| c["pid"].to_string())
                .collect::<Vec<_>>()
                .join(", ")
        )));
    }
    Ok(())
}
pub async fn schedule(app: Arc<App>, action: &str, input: &Value) -> io::Result<Value> {
    crate::remote::source(input)?;
    mode(input)?;
    if accounts::login_active(&app).await {
        return Err(io::Error::other("请先完成或取消当前登录"));
    }
    let operation = config_ops::operation(&app.bridge)?;
    let mut job = json!({"id":input["id"],"model":input["model"],"autostart":input["autostart"],"reloadEditors":input["reloadEditors"]});
    job["source"] = json!(crate::remote::source(input)?);
    job["threadFollow"] = json!(mode(input)?);
    job["codexHome"] = json!(app.codex_home());
    job["bridgeHome"] = json!(app.bridge);
    job["projectDir"] = json!(crate::instance::project_root());
    job["pid"] = json!(std::process::id());
    match action {
        "accountSwitch" => {
            let id = text(&input["id"]);
            let auth = accounts::saved_auth(&app.bridge, id)?;
            job["target"] = accounts::identity(&auth).unwrap_or(Value::Null)["email"].clone();
            job["kind"] = json!("official");
            let c = config(&app.codex_home())?;
            let original = if c["model_provider"] == "hermes_bridge" {
                config_ops::read(&app.bridge.join("original-config.toml"))?
                    .and_then(|s| toml::from_str::<toml::Value>(&s).ok())
                    .map(|v| serde_json::to_value(v).unwrap())
                    .unwrap_or(Value::Null)
            } else {
                c
            };
            job["model"] = original["model"].clone();
            if job["model"].is_null() {
                job["model"] = accounts::read(
                    &app.codex_home().join("models_cache.json"),
                    Value::Null,
                )?["models"]
                    .as_array()
                    .and_then(|a| a.iter().find(|v| v["visibility"] != "hide"))
                    .unwrap_or(&Value::Null)["slug"]
                    .clone();
            }
            job["catalog"] = original["model_catalog_json"].clone();
        }
        "desktopSwitch" => {
            let store = crate::config_store::load(&app.bridge)?;
            let p = store["providers"]
                .as_array()
                .unwrap()
                .iter()
                .find(|p| p["id"] == input["id"])
                .ok_or_else(|| io::Error::other("配置不存在"))?;
            job["target"] = p["name"].clone();
            job["kind"] = json!("api");
        }
        "restoreBackup" => {
            config_ops::backup(&app.bridge, text(&input["id"]))?;
            job["threadFollow"] = json!("all");
            job["backupId"] = input["id"].clone();
            job["id"] = json!("config-restore");
            job["kind"] = json!("restore");
        }
        "resumeThreadSync" => {
            let previous = accounts::read(&app.bridge.join("account-switch.json"), Value::Null)?;
            if previous["threads"]["failed"].as_u64().unwrap_or(0) == 0 {
                return Err(io::Error::other("没有待继续的旧对话同步任务。"));
            }
            job["id"] = json!("thread-sync");
            job["resumeThreads"] = json!(true);
            job["kind"] = json!("resume");
            job["threadFollow"] = previous["threadFollow"].clone();
            job["previousProvider"] = previous["previousProvider"].clone();
        }
        _ => unreachable!(),
    }
    let snapshot = editors::status(&app).await?;
    job["desktopExe"] = json!(selected_desktop(&snapshot).await?);
    let file = app.bridge.join("account-switch-job.json");
    write_json(&file, &job)?;
    let mut command = tokio::process::Command::new(std::env::current_exe()?);
    command
        .arg("--switch-job")
        .arg(&file)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null());
    #[cfg(windows)]
    command.creation_flags(0x08000000 | 0x00000200);
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.as_std_mut().process_group(0);
    }
    let mut child = command.spawn()?;
    let pid = child
        .id()
        .ok_or_else(|| io::Error::other("切换进程未启动。"))?;
    job["pid"] = json!(pid);
    write_json(&file, &job)?;
    operation.handoff(pid)?;
    // The worker cannot start until the lock owner and queued state are saved.
    write_json(
        &app.bridge.join("account-switch.json"),
        &json!({"id":job["id"],"pid":pid,"status":"queued","message":"正在准备切换；完成后重载共用此目录的客户端。"}),
    )?;
    use tokio::io::AsyncWriteExt;
    let mut start = child.stdin.take().unwrap();
    start.write_all(b"start\n").await?;
    drop(start);
    tokio::spawn(async move {
        if let Err(error) = child.wait().await {
            eprintln!("Switch worker exit query failed: {error}");
        }
    });
    Ok(json!({"message":"正在准备切换；完成后重载共用此目录的客户端。"}))
}
pub async fn worker(file: &Path) -> io::Result<()> {
    let mut start = String::new();
    std::io::stdin().read_line(&mut start)?;
    if start.trim() != "start" {
        return Err(io::Error::other("切换进程未收到开始确认。"));
    }
    let job = accounts::read(file, Value::Null)?;
    let bridge = std::path::PathBuf::from(text(&job["bridgeHome"]));
    let _operation = config_ops::adopt_operation(&bridge)?;
    let app = Arc::new(App {
        home: std::path::PathBuf::from(text(&job["codexHome"])),
        bridge: bridge.clone(),
        web: std::path::PathBuf::from(text(&job["projectDir"])).join("web"),
        port: 0,
        token: String::new(),
        protection: crate::platform::DataProtection {
            ok: true,
            path: bridge,
            error: None,
        },
        first_request: std::sync::atomic::AtomicBool::new(false),
        ready_at: Instant::now(),
        downloads: std::sync::Mutex::new(std::collections::HashMap::new()),
        accounts: accounts::Runtime::default(),
        editors: editors::Runtime::default(),
        updates: crate::update::Runtime::default(),
    });
    run(app, job).await
}
struct Run {
    app: Arc<App>,
    job: Value,
    status: &'static str,
    steps: Vec<Value>,
    started: Instant,
    started_at: String,
    applied: bool,
    threads: Value,
    reload: Value,
    desktop_started: Value,
}
impl Run {
    fn report(&self, status: &str, message: &str) -> io::Result<()> {
        write_json(
            &self.app.bridge.join("account-switch.json"),
            &json!({"id":self.job["id"],"pid":std::process::id(),"status":status,"message":message,"startedAt":self.started_at,"elapsedMs":self.started.elapsed().as_millis(),"steps":self.steps,"configurationApplied":self.applied,"threadFollow":self.job["threadFollow"],"previousProvider":self.job["previousProvider"],"threads":self.threads,"editorReload":self.reload,"desktopStarted":self.desktop_started,"desktopRequested":self.job["desktopExe"].is_string(),"finishedAt":if ["done","error"].contains(&status){json!(now())}else{Value::Null}}),
        )
    }
    fn begin(&mut self, id: &str, label: &str) -> io::Result<Instant> {
        self.steps
            .push(json!({"id":id,"label":label,"status":"running"}));
        self.report(self.status, label)?;
        Ok(Instant::now())
    }
    fn end(&mut self, id: &str, at: Instant, error: Option<&str>) -> io::Result<()> {
        let step = self.steps.iter_mut().find(|v| v["id"] == id).unwrap();
        step["status"] = json!(if error.is_some() { "error" } else { "done" });
        step["durationMs"] = json!(at.elapsed().as_millis());
        log(
            &self.app.bridge,
            "switch.step",
            json!({"job":self.job["id"],"source":self.job["source"],"id":id,"status":step["status"],"durationMs":at.elapsed().as_millis(),"error":error.map(|e|json!({"message":e,"code":null,"kind":null}))}),
        )
    }
    fn effect(&self, status: &str, message: &str) -> io::Result<()> {
        let text = fs::read(self.app.codex_home().join("config.toml"))?;
        use sha2::{Digest, Sha256};
        write_json(
            &self.app.bridge.join("effect.json"),
            &json!({"status":status,"message":message,"configHash":format!("{:x}",Sha256::digest(text)),"at":now()}),
        )
    }
}
async fn stop_set(ids: Vec<u32>) -> io::Result<()> {
    let mut tasks = vec![];
    for pid in ids {
        tasks.push(tokio::spawn(
            async move { crate::platform::stop(pid).await },
        ));
    }
    let mut failure = None;
    for task in tasks {
        if let Err(e) = task.await.map_err(io::Error::other).and_then(|v| v) {
            failure.get_or_insert(e);
        }
    }
    if let Some(e) = failure {
        Err(e)
    } else {
        Ok(())
    }
}
async fn reopen(app: &App, exe: &str) -> io::Result<Value> {
    #[cfg(windows)]
    {
        let output = tokio::process::Command::new("powershell.exe")
            .args(["-NoProfile", "-NonInteractive", "-Command", "$ErrorActionPreference='Stop'; $pkg=Get-AppxPackage -Name OpenAI.Codex | Select-Object -First 1; if(-not $pkg){throw 'Codex desktop package missing'}; Start-Process explorer.exe -ArgumentList ('shell:AppsFolder\\'+$pkg.PackageFamilyName+'!App')"])
            .creation_flags(0x08000000).output().await?;
        if !output.status.success() {
            return Err(io::Error::other("未能重新打开 Codex 桌面应用。"));
        }
    }
    #[cfg(unix)]
    {
        let mut cmd = tokio::process::Command::new(exe);
        cmd.envs(crate::platform::codex_env(&app.codex_home()))
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null());
        cmd.spawn()?;
    }
    let until = Instant::now() + Duration::from_secs(20);
    while Instant::now() < until {
        let snapshot = editors::status(app).await?;
        if let Some(c) = snapshot["clients"].as_array().unwrap().iter().find(|c| {
            editors::same(text(&c["executable"]), exe)
                && c["confirmed"] == true
                && c["shared"] == true
        }) {
            return Ok(json!({"pid":c["pid"],"startedAt":c["startedAt"]}));
        }
        tokio::time::sleep(Duration::from_millis(500)).await;
    }
    Err(io::Error::other(
        "未检测到 Codex 桌面主进程重新启动，请查看系统是否阻止打开应用。",
    ))
}
async fn run(app: Arc<App>, job: Value) -> io::Result<()> {
    let mut state = Run {
        app: app.clone(),
        applied: job["resumeThreads"] == true,
        job,
        status: "preparing",
        steps: vec![],
        started: Instant::now(),
        started_at: now(),
        threads: Value::Null,
        reload: Value::Null,
        desktop_started: Value::Null,
    };
    let mut stopped = vec![];
    log(
        &app.bridge,
        "switch.start",
        json!({"job":state.job["id"],"source":state.job["source"],"kind":state.job["kind"],"target":state.job["target"],"threadFollow":state.job["threadFollow"],"reloadEditors":state.job["reloadEditors"]!=false,"desktop":state.job["desktopExe"].is_string()}),
    )?;
    let work = async {
        let at = state.begin("prepare", "检查目标配置与客户端")?;
        if state.job["resumeThreads"] != true {
            state.job["previousProvider"] = config(&app.codex_home())?["model_provider"].as_str().map_or(json!("openai"), |v| json!(v));
        }
        let prepare = async {
            if state.job["kind"] != "restore" {
                accounts::sync_current(&app, true).await?;
            }
            match text(&state.job["kind"]) {
                "api" => config_ops::prepare_api(&app, &state.job).await.map(Some),
                "restore" => config_ops::prepare_backup(&app, text(&state.job["backupId"])).await.map(Some),
                "resume" => Ok(None),
                _ => {
                    accounts::prepare(&app, text(&state.job["id"]))
                        .await.map_err(|e| io::Error::other(e.message))?;
                    Ok(None)
                }
            }
        };
        let check = async {
            if state.job["reloadEditors"] == false { return Ok(()); }
            let snapshot = editors::status(&app).await?;
            log(&app.bridge, "switch.clients", json!({
                "job":state.job["id"], "source":state.job["source"], "phase":"check", "clients":snapshot["clients"]
            }))?;
            check_editors(&snapshot)
        };
        // Wait for both checks even on error: the operation lock remains held
        // until the other preparation has stopped writing account copies.
        let (prepared, checked) = tokio::join!(prepare, check);
        let error = prepared.as_ref().err().or(checked.as_ref().err()).map(ToString::to_string);
        state.end("prepare", at, error.as_deref())?;
        let prepared = prepared?;
        checked?;
        let latest = editors::status(&app).await?;
        log(&app.bridge, "switch.clients", json!({
            "job":state.job["id"], "source":state.job["source"], "phase":"recheck", "clients":latest["clients"]
        }))?;
        if state.job["reloadEditors"] != false { check_editors(&latest)?; }
        let clients = latest["clients"].as_array().unwrap();
        let shared = state.job["reloadEditors"] != false && clients.iter().any(|c|
            c["kind"] == "ide" && c["confirmed"] == true && c["shared"] == true
        );
        let editor_ids = if shared {
            clients.iter().filter(|c| c["kind"] == "ide" && c["confirmed"] == true && c["shared"] == true)
                .filter_map(|c| c["pid"].as_u64().map(|v| v as u32)).collect()
        } else { vec![] };
        let editors = if shared {
            clients.iter().filter(|c| c["kind"] == "editor" && c["canReload"] == true).cloned().collect::<Vec<_>>()
        } else { vec![] };
        let desktop_ids = clients.iter().filter(|c|
            state.job["desktopExe"].is_string() && c["kind"] == "desktop" && c["confirmed"] == true && c["shared"] == true
                && editors::same(text(&c["desktopExecutable"]), text(&state.job["desktopExe"]))
        ).flat_map(|c| [c["pid"].as_u64(), c["desktopPid"].as_u64()]).flatten()
            .map(|id| id as u32).collect::<std::collections::HashSet<_>>().into_iter().collect();
        state.status = "switching";
        let at = state.begin("release", "释放目标客户端")?;
        let (desktop_result, editor_result) = tokio::join!(crate::platform::stop_desktop(desktop_ids), stop_set(editor_ids));
        if editor_result.is_ok() { stopped = editors; }
        let error = desktop_result.as_ref().err().or(editor_result.as_ref().err()).map(ToString::to_string);
        state.end("release", at, error.as_deref())?;
        desktop_result?;
        editor_result?;
        let at = state.begin("apply", "保存并应用目标配置")?;
        let applied = async {
            if state.job["resumeThreads"] == true { return Ok(json!({"label":"当前来源"})); }
            if state.job["kind"] != "restore" {
                accounts::sync_current(&app, true).await?;
            }
            accounts::capture(&app)?;
            if let Some(prepared) = prepared {
                prepared.apply(&app)
            } else {
                accounts::apply_saved(&app, text(&state.job["id"]), state.job["model"].as_str(), state.job["catalog"].as_str()).await
            }
        }.await;
        state.end("apply", at, applied.as_ref().err().map(ToString::to_string).as_deref())?;
        let applied = applied?;
        state.applied = true;
        state.effect("thread_sync_pending", "配置已写入，正在同步旧对话，尚未完成切换。")?;
        let at = state.begin("threads", "同步并核对旧对话")?;
        match crate::thread_routing::synchronize(&app, text(&state.job["threadFollow"]), state.job["previousProvider"].as_str()).await {
            Ok(counts) => state.threads = counts,
            Err((error, counts)) => {
                state.threads = counts;
                state.end("threads", at, Some(&error.to_string()))?;
                return Err(error);
            }
        }
        state.end("threads", at, None)?;
        state.effect("restart_required", "配置已应用，客户端尚未重新打开。")?;
        if let Some(exe) = state.job["desktopExe"].as_str() {
            let exe = exe.to_owned();
            state.status = "reopening";
            let at = state.begin("reopen", "重新打开并确认桌面主进程")?;
            let opened = reopen(&app, &exe).await;
            state.end("reopen", at, opened.as_ref().err().map(ToString::to_string).as_deref())?;
            state.desktop_started = opened?;
        }
        if shared {
            let at = state.begin("reload", "发送编辑器重载请求")?;
            let result = editors::reload(&app, &json!({}), &stopped, false);
            state.end("reload", at, result.as_ref().err().map(ToString::to_string).as_deref())?;
            state.reload = result?;
        }
        state.effect("reopen_requested", "配置已应用，已请求客户端重新加载；CLI请重新启动。")?;
        Ok::<_, io::Error>(applied)
    }.await;
    match work {
        Ok(applied) => state.report(
            "done",
            &format!(
                "已应用 {}；旧对话同步完成，客户端重载结果请查看各窗口。",
                text(&applied["label"])
            ),
        )?,
        Err(e) => {
            let mut recovery = String::new();
            if !stopped.is_empty() && state.reload.is_null() {
                let at = state.begin("recoverEditors", "恢复已停止的编辑器插件")?;
                let result = editors::reload(&app, &json!({}), &stopped, true);
                state.end(
                    "recoverEditors",
                    at,
                    result.as_ref().err().map(ToString::to_string).as_deref(),
                )?;
                match result {
                    Ok(value) => state.reload = value,
                    Err(error) => recovery = format!(" 插件恢复请求未发送：{error}"),
                }
            }
            if state.applied {
                state.effect("switch_incomplete", &format!("切换未完成：{e}{recovery}"))?;
            }
            state.report(
                "error",
                &format!(
                    "{}：{e}{recovery}",
                    if state.applied {
                        "配置已应用，但旧对话同步或客户端重新加载未完成"
                    } else {
                        "切换未完成"
                    }
                ),
            )?;
        }
    }
    let status = accounts::read(&app.bridge.join("account-switch.json"), Value::Null)?;
    log(
        &app.bridge,
        "switch.end",
        json!({"job":state.job["id"],"source":state.job["source"],"status":status["status"],"elapsedMs":state.started.elapsed().as_millis(),"configurationApplied":state.applied,"threads":state.threads,"reload":editors::reload_results(&app.bridge,&state.reload["targets"])?}),
    )?;
    if state.job["kind"] == "restore" {
        log(
            &app.bridge,
            "config.restore",
            json!({"id":state.job["backupId"],"source":state.job["source"],"status":if status["status"]=="done"{"restored"}else{"failed"}}),
        )?;
    }
    Ok(())
}
