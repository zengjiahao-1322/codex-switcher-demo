//! Startup, authenticated instance reuse and verified process handover.
use crate::{
    platform,
    server::{App, serve},
};
use http_body_util::{BodyExt, Full};
use hyper::{Request, body::Bytes};
use hyper::{server::conn::http1, service::service_fn};
use hyper_util::rt::TokioIo;
use serde_json::{Value, json};
use std::{
    env, fs, io,
    path::PathBuf,
    sync::Arc,
    time::{Duration, Instant},
};
use tokio::net::{TcpListener, TcpStream};
pub fn runtime() -> Value {
    use sha2::{Digest, Sha256};
    let root = project_root();
    let metadata: Value = fs::read(root.join("src/platform/release-info.json"))
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .unwrap_or(Value::Null);
    let package: Value = serde_json::from_str(include_str!("../../package.json")).unwrap();
    let id = format!(
        "{:x}",
        Sha256::digest(format!(
            "{}:{}",
            env!("SWITCHER_BUILD_ID"),
            metadata["sequence"]
        ))
    );
    json!({
        "version":package["version"],
        "id":&id[..12],
        "sequence":metadata["sequence"],
        "pid":std::process::id(),
        "entry":env::current_exe().map(|p|platform::display_path(&p)).unwrap_or_default(),
        "runtime":"rust"
    })
}
pub fn project_root() -> PathBuf {
    env::var_os("SWITCHER_WEB_ROOT")
        .map(PathBuf::from)
        .and_then(|p| p.parent().map(PathBuf::from))
        .unwrap_or_else(|| env::current_exe().unwrap().parent().unwrap().to_path_buf())
}
pub fn other_action(old: u64, current: u64) -> &'static str {
    if old >= current {
        "deferred"
    } else {
        "stopped"
    }
}
fn same_path(a: &std::path::Path, b: &std::path::Path) -> bool {
    match (fs::canonicalize(a), fs::canonicalize(b)) {
        (Ok(a), Ok(b)) => {
            if cfg!(windows) {
                platform::display_path(&a).eq_ignore_ascii_case(&platform::display_path(&b))
            } else {
                a == b
            }
        }
        _ => false,
    }
}
fn owner_install(pid: u32) -> Option<PathBuf> {
    let image = platform::image(pid).ok()?;
    if image
        .file_name()?
        .to_string_lossy()
        .eq_ignore_ascii_case(if cfg!(windows) { "node.exe" } else { "node" })
    {
        let command = platform::command(pid).ok()?;
        let expression = regex::Regex::new(
            r#"(?i)(?:^|[\\/])node(?:\.exe)?"?\s+"?(.+?[\\/]main\.cjs)"?(?:\s|$)"#,
        )
        .unwrap();
        let entry = expression.captures(&command)?.get(1)?.as_str();
        PathBuf::from(entry).parent().map(PathBuf::from)
    } else {
        image.parent().map(PathBuf::from)
    }
}
fn verified(pid: u32, old: &Value) -> bool {
    let Some(entry) = old["entry"].as_str() else {
        return false;
    };
    if old["pid"].as_u64() != Some(pid as u64) {
        return false;
    }
    let Ok(image) = platform::image(pid) else {
        return false;
    };
    let node_process = image.file_name().is_some_and(|name| {
        name.to_string_lossy()
            .eq_ignore_ascii_case(if cfg!(windows) { "node.exe" } else { "node" })
    });
    same_path(&image, &PathBuf::from(entry))
        || (entry.ends_with("main.cjs")
            && node_process
            && owner_install(pid).is_some_and(|root| {
                PathBuf::from(entry)
                    .parent()
                    .is_some_and(|parent| same_path(&root, parent))
            }))
}
fn open_url(url: &str) -> io::Result<()> {
    if !env::args().any(|s| s == "--no-open") {
        platform::open_url(url)?;
    }
    Ok(())
}
async fn reclaimed_listener(port: u16) -> io::Result<TcpListener> {
    let deadline = Instant::now() + Duration::from_secs(1);
    loop {
        match TcpListener::bind(("127.0.0.1", port)).await {
            Ok(listener) => return Ok(listener),
            Err(error) if error.kind() == io::ErrorKind::AddrInUse && Instant::now() < deadline => {
                tokio::time::sleep(Duration::from_millis(25)).await
            }
            Err(error) => return Err(error),
        }
    }
}
async fn local_response(url: &str, route: &str) -> io::Result<(hyper::StatusCode, Bytes)> {
    let (base, token) = url
        .split_once("/#")
        .ok_or_else(|| io::Error::other("Invalid local connection URL"))?;
    let address = base
        .strip_prefix("http://127.0.0.1:")
        .ok_or_else(|| io::Error::other("Connection must use loopback"))?;
    let port = address.parse::<u16>().map_err(io::Error::other)?;
    let request = async {
        let stream = TcpStream::connect(("127.0.0.1", port)).await?;
        let (mut sender, connection) = hyper::client::conn::http1::handshake(TokioIo::new(stream))
            .await
            .map_err(io::Error::other)?;
        tokio::spawn(async move {
            let _ = connection.await;
        });
        let response = sender
            .send_request(
                Request::builder()
                    .method(if route == "/api/accounts" {
                        "POST"
                    } else {
                        "GET"
                    })
                    .uri(route)
                    .header("Host", format!("127.0.0.1:{port}"))
                    .header("Authorization", format!("Bearer {token}"))
                    .header("Content-Type", "application/json")
                    .body(Full::new(Bytes::from_static(if route == "/api/accounts" {
                        b"{}"
                    } else {
                        b""
                    })))
                    .unwrap(),
            )
            .await
            .map_err(io::Error::other)?;
        let status = response.status();
        let bytes = response
            .into_body()
            .collect()
            .await
            .map_err(io::Error::other)?
            .to_bytes();
        Ok((status, bytes))
    };
    tokio::time::timeout(Duration::from_secs(3), request)
        .await
        .map_err(io::Error::other)?
}
pub fn write_json(file: &std::path::Path, value: &Value) -> io::Result<()> {
    if let Some(parent) = file.parent() {
        fs::create_dir_all(parent)?;
    }
    let temporary = file.with_extension(format!("{}.tmp", std::process::id()));
    use std::io::Write;
    let mut options = fs::OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut output = options.open(&temporary)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        output.set_permissions(fs::Permissions::from_mode(0o600))?;
    }
    output.write_all(&serde_json::to_vec_pretty(value).map_err(io::Error::other)?)?;
    fs::rename(&temporary, file)
}
pub async fn run() -> Result<(), Box<dyn std::error::Error>> {
    if env::args().nth(1).as_deref() == Some("--algorithm-fixture") {
        crate::diagnostics::algorithm(&env::args().skip(2).collect::<Vec<_>>())?;
        return Ok(());
    }
    if env::args().nth(1).as_deref() == Some("--probe") {
        let port = env::args().nth(2).unwrap_or("47831".into()).parse()?;
        let started = Instant::now();
        let pid = platform::port_pid(port)?;
        let port_ms = started.elapsed().as_secs_f64() * 1000.0;
        let started = Instant::now();
        let procs = platform::processes()?;
        let process_ms = started.elapsed().as_secs_f64() * 1000.0;
        println!(
            "{}",
            json!({"pid":pid,"portMs":port_ms,"processMs":process_ms,"processes":procs})
        );
        return Ok(());
    }
    let started = Instant::now();
    let explicit_bridge = env::var_os("BRIDGE_HOME");
    let bridge = explicit_bridge
        .clone()
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            if cfg!(windows) {
                project_root().join("private")
            } else {
                platform::user_home().join("Library/Application Support/CodexApiSwitcher")
            }
        });
    let settings: Value = fs::read(bridge.join("settings.json"))
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .unwrap_or(Value::Null);
    let home = env::var_os("BRIDGE_CODEX_HOME")
        .map(PathBuf::from)
        .or_else(|| settings["codexHome"].as_str().map(PathBuf::from))
        .or_else(|| env::var_os("CODEX_HOME").map(PathBuf::from))
        .unwrap_or_else(|| platform::user_home().join(".codex"));
    fs::create_dir_all(&home)?;
    fs::create_dir_all(&bridge)?;
    let running_path = bridge.join("running.json");
    let discovery = env::var_os("BRIDGE_DISCOVERY_DIR")
        .map(PathBuf::from)
        .or_else(|| {
            explicit_bridge
                .is_none()
                .then(|| platform::user_home().join(".codex-api-switcher"))
        });
    let existing_started = Instant::now();
    let mut other_install = Value::Null;
    let local = fs::read(&running_path).ok();
    let discovered = if local.is_none() {
        discovery
            .as_ref()
            .and_then(|d| fs::read(d.join("connection.json")).ok())
    } else {
        None
    };
    if let Some(bytes) = local.as_ref().or(discovered.as_ref()) {
        let previous: Value = serde_json::from_slice(bytes)?;
        if let Some(url) = previous["url"].as_str()
            && let Ok((status, body)) = local_response(url, "/api/runtime").await
        {
            let pid = previous["pid"].as_u64().ok_or("Missing old runtime PID")? as u32;
            let (old, legacy_verified) = if status.is_success() {
                (serde_json::from_slice::<Value>(&body)?, false)
            } else {
                let (status, body) = local_response(url, "/api/accounts").await?;
                let accounts: Value = serde_json::from_slice(&body)?;
                let node_process = platform::image(pid)
                    .ok()
                    .and_then(|file| {
                        file.file_name()
                            .map(|name| name.to_string_lossy().to_string())
                    })
                    .is_some_and(|name| {
                        name.eq_ignore_ascii_case(if cfg!(windows) { "node.exe" } else { "node" })
                    });
                if !status.is_success()
                    || !accounts["items"].is_array()
                    || !accounts
                        .as_object()
                        .is_some_and(|object| object.contains_key("switchJob"))
                    || !node_process
                    || owner_install(pid).is_none()
                {
                    return Err(
                        "无法确认旧切换器后台归属，请先关闭旧切换器再启动新版；配置尚未修改。"
                            .into(),
                    );
                }
                (json!({}), true)
            };
            let same_build = old["id"] == runtime()["id"];
            let old_sequence = previous["build"]["sequence"]
                .as_u64()
                .or(old["sequence"].as_u64())
                .unwrap_or(0);
            if !legacy_verified && !verified(pid, &old) {
                return Err(
                    "无法确认旧切换器后台归属，请先关闭旧切换器再启动新版；配置尚未修改。".into(),
                );
            }
            let action = other_action(old_sequence, runtime()["sequence"].as_u64().unwrap_or(0));
            if discovered.is_some() {
                other_install = json!({"pid":pid,"sequence":old_sequence,"action":action});
            }
            if (discovered.is_none() && same_build)
                || (discovered.is_some() && action == "deferred")
            {
                if let Some(directory) = &discovery {
                    write_json(&directory.join("connection.json"), &previous)?;
                }
                crate::diagnostics::log(&bridge, "startup", json!({"otherInstall":other_install}))?;
                open_url(url)?;
                println!(
                    "BRIDGE_ALREADY_RUNNING {}",
                    url.split('#').next().unwrap_or(url)
                );
                return Ok(());
            }
            platform::stop(pid).await?;
        }
    }
    let existing_ms = existing_started.elapsed().as_millis();
    let web = env::var_os("SWITCHER_WEB_ROOT")
        .map(PathBuf::from)
        .unwrap_or_else(|| project_root().join("web"));
    let random = platform::random_bytes()?;
    let token = env::var("SWITCHER_TEST_TOKEN").unwrap_or_else(|_| {
        random
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect::<String>()
    });
    let desired_port = env::var("BRIDGE_PORT")
        .unwrap_or("47831".into())
        .parse::<u16>()?;
    let protection_started = Instant::now();
    let mut directories = vec![bridge.as_path()];
    if let Some(directory) = &discovery {
        directories.push(directory.as_path());
    }
    let protection = platform::protect_data_dirs(&directories);
    let protect_ms = protection_started.elapsed().as_millis();
    let service_started = Instant::now();
    let mut app = App {
        home,
        bridge,
        web,
        token,
        port: desired_port,
        protection,
        first_request: std::sync::atomic::AtomicBool::new(false),
        ready_at: Instant::now(),
        downloads: std::sync::Mutex::new(std::collections::HashMap::new()),
    };
    let service_ms = service_started.elapsed().as_millis();
    let mut handover = json!({});
    let listen_started = Instant::now();
    let listener = match TcpListener::bind(("127.0.0.1", desired_port)).await {
        Ok(listener) => listener,
        Err(error)
            if [io::ErrorKind::AddrInUse, io::ErrorKind::PermissionDenied]
                .contains(&error.kind()) =>
        {
            let owner = platform::port_pid(desired_port)?;
            let install = owner.and_then(owner_install);
            let same_install = owner
                .and_then(|pid| platform::image(pid).ok())
                .is_some_and(|path| same_path(&path, &env::current_exe().unwrap()))
                || install
                    .as_ref()
                    .is_some_and(|path| same_path(path, &project_root()));
            let older_install = install
                .and_then(|root| {
                    let package: Value =
                        serde_json::from_slice(&fs::read(root.join("package.json")).ok()?).ok()?;
                    let release: Value = serde_json::from_slice(
                        &fs::read(root.join("src/platform/release-info.json")).ok()?,
                    )
                    .ok()?;
                    (package["name"] == "codex-api-switcher")
                        .then(|| release["sequence"].as_u64())
                        .flatten()
                })
                .filter(|old| *old < runtime()["sequence"].as_u64().unwrap_or(0));
            if same_install || older_install.is_some() {
                if let Some(sequence) = older_install {
                    other_install = json!({"pid":owner,"sequence":sequence,"action":"stopped"});
                }
                platform::stop(owner.unwrap()).await?;
                handover["reclaimed"] = json!({"pid":owner});
                reclaimed_listener(desired_port).await?
            } else {
                handover["portFallback"] = json!({
                    "port":desired_port,
                    "ownerPid":owner,
                    "reason":if error.kind()==io::ErrorKind::PermissionDenied{
                        "EACCES"
                    }else if owner.is_some(){
                        "different_process"
                    }else{
                        "port_in_use"
                    }
                });
                TcpListener::bind(("127.0.0.1", 0)).await?
            }
        }
        Err(error) => return Err(error.into()),
    };
    app.port = listener.local_addr()?.port();
    let connection = json!({"pid":std::process::id(),"url":format!("http://127.0.0.1:{}/#{}",app.port,app.token),"build":runtime()});
    write_json(&running_path, &connection)?;
    if let Some(directory) = &discovery {
        write_json(&directory.join("connection.json"), &connection)?;
    }
    app.ready_at = Instant::now();
    let mut startup = json!({
        "readyMs":started.elapsed().as_millis(),
        "port":app.port,
        "otherInstall":other_install,
        "phases":{
            "existing":existing_ms,
            "protectDataDirs":protect_ms,
            "createService":service_ms,
            "listen":listen_started.elapsed().as_millis()
        }
    });
    startup
        .as_object_mut()
        .unwrap()
        .extend(handover.as_object().unwrap().clone());
    crate::diagnostics::log(&app.bridge, "startup", startup)?;
    println!(
        "{}",
        json!({"event":"ready","listenMs":started.elapsed().as_secs_f64()*1000.0,"port":app.port,"url":format!("http://127.0.0.1:{}/#{}",app.port,app.token)})
    );
    open_url(connection["url"].as_str().unwrap())?;
    let app = Arc::new(app);
    if let (Some(directory), Some(sequence)) =
        (discovery, runtime()["sequence"].as_u64().filter(|n| *n > 0))
    {
        let bridge = app.bridge.clone();
        // The task is first polled when accept yields. COM runs on the blocking
        // pool, so neither initialization nor shortcut I/O stalls HTTP requests.
        tokio::spawn(async move {
            let result = tokio::task::spawn_blocking(move || {
                let marker: Value = fs::read(directory.join("shortcut.json"))
                    .ok()
                    .and_then(|bytes| serde_json::from_slice(&bytes).ok())
                    .unwrap_or(Value::Null);
                if marker["created"] == true && marker["sequence"].as_u64().unwrap_or(0) >= sequence
                {
                    return Ok(());
                }
                crate::integration::desktop(&directory, sequence)
            })
            .await;
            let error = match result {
                Ok(Ok(())) => None,
                Ok(Err(error)) => Some(error.to_string()),
                Err(error) => Some(error.to_string()),
            };
            if let Some(error) = error
                && let Err(log_error) =
                    crate::diagnostics::log(&bridge, "app.shortcuts", json!({"error":error}))
            {
                eprintln!("Desktop integration log failed: {log_error}");
            }
        });
    }
    loop {
        let (stream, _) = listener.accept().await?;
        let app = app.clone();
        tokio::spawn(async move {
            if let Err(error) = http1::Builder::new()
                .serve_connection(
                    TokioIo::new(stream),
                    service_fn(move |req| serve(req, app.clone())),
                )
                .await
            {
                eprintln!("HTTP connection failed: {error}");
            }
        });
    }
}
