//! Exit/uninstall hooks and the uninstaller's status/restore/cleanup CLI.
use crate::{config_ops, config_store, config_text, instance, server::App};
use serde_json::{Value, json};
#[cfg(not(windows))]
use std::process::Stdio;
use std::{env, fs, io, path::PathBuf, sync::Arc, time::Duration};

#[cfg(windows)]
fn windows_uninstaller(
    app: &App,
    root: &std::path::Path,
    ready: &std::path::Path,
    keep: bool,
) -> io::Result<()> {
    use std::ffi::c_void;
    #[repr(C)]
    struct StartupInfo {
        size: u32,
        reserved: *mut u16,
        desktop: *mut u16,
        title: *mut u16,
        x: u32,
        y: u32,
        width: u32,
        height: u32,
        columns: u32,
        rows: u32,
        fill: u32,
        flags: u32,
        show: u16,
        reserved_size: u16,
        reserved_bytes: *mut u8,
        input: *mut c_void,
        output: *mut c_void,
        error: *mut c_void,
    }
    #[repr(C)]
    struct ProcessInfo {
        process: *mut c_void,
        thread: *mut c_void,
        pid: u32,
        thread_id: u32,
    }
    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn CreateProcessW(
            application: *const u16,
            command: *mut u16,
            process_security: *mut c_void,
            thread_security: *mut c_void,
            inherit: i32,
            flags: u32,
            environment: *mut c_void,
            directory: *const u16,
            startup: *const StartupInfo,
            process: *mut ProcessInfo,
        ) -> i32;
        fn CloseHandle(handle: *mut c_void) -> i32;
    }
    let quoted = |value: &std::path::Path| {
        format!(
            "'{}'",
            crate::platform::display_path(value).replace('\'', "''")
        )
    };
    let command = format!(
        "$env:BRIDGE_HOME={};$env:BRIDGE_CODEX_HOME={};$env:BRIDGE_UNINSTALL_PID='{}';$env:BRIDGE_UNINSTALL_READY={}; $a=@('-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',([string][char]34 + {} + [char]34),'-KeepCodexConfig'{}); Start-Process -FilePath (Join-Path $PSHOME 'powershell.exe') -WindowStyle Hidden -ArgumentList $a",
        quoted(&app.bridge),
        quoted(&app.codex_home()),
        std::process::id(),
        quoted(ready),
        quoted(&root.join("uninstall.ps1")),
        if keep { ",'-KeepData'" } else { "" }
    );
    let wide = |s: &str| s.encode_utf16().chain(Some(0)).collect::<Vec<_>>();
    let file = wide(&crate::platform::display_path(
        &PathBuf::from(env::var_os("SystemRoot").unwrap_or_else(|| "C:\\Windows".into()))
            .join("System32/WindowsPowerShell/v1.0/powershell.exe"),
    ));
    let mut parameters = wide(&format!(
        "powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command \"{command}\""
    ));
    let directory = wide(&crate::platform::display_path(&env::temp_dir()));
    let mut startup: StartupInfo = unsafe { std::mem::zeroed() };
    startup.size = std::mem::size_of::<StartupInfo>() as u32;
    startup.flags = 1;
    startup.show = 0;
    let mut process: ProcessInfo = unsafe { std::mem::zeroed() };
    // Start-Process uses a hidden independent shell for the actual uninstaller.
    let ok = unsafe {
        CreateProcessW(
            file.as_ptr(),
            parameters.as_mut_ptr(),
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            0,
            0x10,
            std::ptr::null_mut(),
            directory.as_ptr(),
            &startup,
            &mut process,
        )
    };
    if ok == 0 {
        return Err(io::Error::last_os_error());
    }
    unsafe {
        CloseHandle(process.thread);
        CloseHandle(process.process);
    }
    Ok(())
}

pub fn paths() -> (PathBuf, PathBuf) {
    let bridge = crate::migration::data_home();
    let settings = config_store::read_json(&bridge.join("settings.json")).unwrap_or(Value::Null);
    let home = env::var_os("BRIDGE_CODEX_HOME")
        .map(PathBuf::from)
        .or_else(|| settings["codexHome"].as_str().map(PathBuf::from))
        .or_else(|| env::var_os("CODEX_HOME").map(PathBuf::from))
        .unwrap_or_else(|| crate::platform::user_home().join(".codex"));
    (home, bridge)
}

fn check(app: &App) -> io::Result<()> {
    let file = app.bridge.join("account-switch.json");
    let mut job = config_store::read_json(&file)?;
    if matches!(
        job["status"].as_str(),
        Some("queued" | "preparing" | "switching" | "reopening")
    ) {
        if job["pid"]
            .as_u64()
            .is_some_and(|pid| crate::platform::alive(pid as u32))
        {
            return Err(io::Error::other(
                "切换任务正在进行，请等它完成后再退出或卸载。",
            ));
        }
        job["status"] = json!("error");
        job["message"] = json!("上次账号切换已中断，可以重新选择来源并切换。");
        instance::write_json(&file, &job)?;
    }
    Ok(())
}

pub fn clean_records(app: &App) -> io::Result<()> {
    let discovery = env::var_os("BRIDGE_DISCOVERY_DIR")
        .filter(|p| !p.is_empty())
        .map(PathBuf::from)
        .or_else(|| {
            crate::migration::configured_home()
                .is_none()
                .then(|| crate::platform::user_home().join(".codex-api-switcher"))
        });
    let legacy = env::var_os("BRIDGE_HOME")
        .filter(|p| !p.is_empty())
        .map(PathBuf::from)
        .filter(|p| {
            p.file_name()
                .is_some_and(|name| name.to_string_lossy().eq_ignore_ascii_case("private"))
                && crate::migration::configured_home().is_none()
        })
        .map(|p| p.join("running.json"));
    for file in [
        Some(app.bridge.join("running.json")),
        discovery.map(|p| p.join("connection.json")),
        legacy,
    ]
    .into_iter()
    .flatten()
    {
        if config_store::read_json(&file)?["pid"] == std::process::id() {
            fs::remove_file(file)?;
        }
    }
    Ok(())
}

#[cfg(unix)]
pub fn stop_signal() -> io::Result<impl std::future::Future<Output = ()>> {
    use tokio::signal::unix::{SignalKind, signal};
    let mut terminate = signal(SignalKind::terminate())?;
    let mut interrupt = signal(SignalKind::interrupt())?;
    Ok(async move {
        tokio::select! {
            _ = terminate.recv() => {},
            _ = interrupt.recv() => {},
        }
    })
}

#[cfg(windows)]
pub fn stop_signal() -> io::Result<impl std::future::Future<Output = ()>> {
    Ok(std::future::pending())
}

pub fn quit(app: Arc<App>) -> io::Result<Value> {
    check(&app)?;
    crate::diagnostics::log(&app.bridge, "app.quit", json!({}))?;
    tokio::spawn(async move {
        tokio::time::sleep(Duration::from_millis(200)).await;
        match clean_records(&app) {
            Ok(()) => std::process::exit(0),
            Err(error) => eprintln!("Quit failed: {error}"),
        }
    });
    Ok(json!({"message":"切换器已退出"}))
}

pub async fn uninstall(app: Arc<App>, input: &Value) -> io::Result<Value> {
    check(&app)?;
    let root = instance::project_root();
    if root.join(".git").exists() {
        return Err(io::Error::other("开发目录请保留源码，不能从这里卸载。"));
    }
    let text = config_ops::read(&app.codex_home().join("config.toml"))?.unwrap_or_default();
    let config: toml::Value = toml::from_str(&text).map_err(io::Error::other)?;
    let selected = config
        .get("model_provider")
        .and_then(|v| v.as_str())
        .unwrap_or("");
    let port = config_store::read_json(&app.bridge.join("adapter.json"))?["port"].as_u64();
    let restored = port.is_some_and(|port| {
        config
            .get("model_providers")
            .and_then(|v| v.get(selected))
            .and_then(|v| v.get("base_url"))
            .and_then(|v| v.as_str())
            == Some(format!("http://127.0.0.1:{port}/v1").as_str())
    });
    if restored {
        config_ops::official(&app, &json!({"threadFollow":"off"}), true).await?;
    }
    let keep = input["keepData"].as_bool().unwrap_or(true);
    crate::diagnostics::log(
        &app.bridge,
        "app.uninstall",
        json!({"keepData":keep,"restoredOfficial":restored}),
    )?;
    tokio::spawn(async move {
        tokio::time::sleep(Duration::from_millis(200)).await;
        let result = async {
            let ready = app
                .bridge
                .join(format!("uninstall-ready-{}", std::process::id()));
            if ready.exists() {
                fs::remove_file(&ready)?;
            }
            #[cfg(not(windows))]
            let mut child = {
                let mut c = std::process::Command::new("/bin/bash");
                c.arg(root.join("platform/macos/uninstall-mac.sh"))
                    .arg(&root)
                    .arg(&app.bridge)
                    .arg(keep.to_string())
                    .arg(std::process::id().to_string());
                crate::update::detached(&mut c);
                c.env("BRIDGE_HOME", &app.bridge)
                    .env("BRIDGE_CODEX_HOME", app.codex_home())
                    .env("BRIDGE_UNINSTALL_PID", std::process::id().to_string())
                    .env("BRIDGE_UNINSTALL_READY", &ready)
                    .stdin(Stdio::null())
                    .stdout(Stdio::null())
                    .stderr(Stdio::null())
                    .spawn()?
            };
            #[cfg(windows)]
            windows_uninstaller(&app, &root, &ready, keep)?;
            let deadline = std::time::Instant::now() + Duration::from_secs(10);
            loop {
                if ready.exists() {
                    fs::remove_file(&ready)?;
                    clean_records(&app)?;
                    return Ok::<(), io::Error>(());
                }
                #[cfg(not(windows))]
                if let Some(status) = child.try_wait()? {
                    return Err(io::Error::other(format!(
                        "卸载进程提前退出：{}",
                        status.code().unwrap_or(-1)
                    )));
                }
                if std::time::Instant::now() >= deadline {
                    #[cfg(not(windows))]
                    child.kill()?;
                    return Err(io::Error::other("卸载进程未能启动。"));
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        }
        .await;
        match result {
            Ok(()) => std::process::exit(0),
            Err(error) => {
                eprintln!("Uninstall launch failed: {error}");
                if let Err(log_error) = crate::diagnostics::log(
                    &app.bridge,
                    "app.uninstall",
                    json!({"error":error.to_string()}),
                ) {
                    eprintln!("Uninstall log failed: {log_error}");
                }
            }
        }
    });
    Ok(json!({"message":"正在卸载，完成后可关闭本页。"}))
}

pub async fn cli(app: &App, action: &str) -> io::Result<String> {
    let file = app.codex_home().join("config.toml");
    let text = config_ops::read(&file)?.unwrap_or_default();
    if action == "status" {
        let bridged = toml::from_str::<toml::Value>(&text).ok().is_some_and(|c| {
            c.get("model_provider").and_then(|v| v.as_str()) == Some("hermes_bridge")
        });
        return Ok(if bridged { "BRIDGED" } else { "OFFICIAL" }.into());
    }
    if !["restore", "cleanup"].contains(&action) {
        return Err(io::Error::other(
            "usage: node cli.cjs status|restore|cleanup",
        ));
    }
    check(app).map_err(|_| io::Error::other("账号切换正在进行，请稍后"))?;
    let _operation = config_ops::operation(&app.bridge)?;
    match action {
        "restore" => {
            let c: toml::Value = toml::from_str(&text).map_err(io::Error::other)?;
            let bridged = c.get("model_provider").and_then(|v| v.as_str()) == Some("hermes_bridge");
            if !bridged {
                if app.bridge.join("current.json").exists() {
                    fs::remove_file(app.bridge.join("current.json"))?;
                }
                return Ok("Codex already uses its official login.".into());
            }
            config_ops::official(app, &json!({"threadFollow":"off"}), true).await?;
            let mut effect = config_store::read_json(&app.bridge.join("effect.json"))?;
            effect["message"] =
                json!("配置已应用。请完整退出并重新打开桌面端，以载入账号与模型列表。");
            instance::write_json(&app.bridge.join("effect.json"), &effect)?;
            let restored: toml::Value =
                toml::from_str(&fs::read_to_string(file)?).map_err(io::Error::other)?;
            let model = restored
                .get("model")
                .and_then(|v| v.as_str())
                .unwrap_or("undefined");
            Ok(format!("Restored Codex official login (model {model})."))
        }
        "cleanup" => {
            let result =
                config_text::cleanup(&text, app.bridge.join("model-catalog.json").to_str())?;
            if result["changed"] == true {
                config_ops::atomic(&file, result["text"].as_str().unwrap(), Some(Some(&text)))?;
            }
            let startup = crate::integration::startup_file();
            if startup.exists() {
                fs::remove_file(startup)?;
            }
            Ok(if result["changed"] == true {
                "Removed the switcher provider definition from Codex config."
            } else {
                "Codex config had nothing to clean."
            }
            .into())
        }
        _ => unreachable!(),
    }
}
