//! Release checks, staged verified downloads, and a separate rollback worker.
use crate::{config_store, diagnostics, instance, server::App};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeSet,
    env, fs, io,
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
use tokio::io::{AsyncBufReadExt, BufReader};

const RELEASE_URL: &str =
    "https://github.com/zengjiahao-1322/codex-switcher-demo/releases/latest/download/";

#[derive(Default)]
pub struct Runtime {
    inner: Mutex<Option<State>>,
    checking: tokio::sync::Mutex<()>,
}
struct State {
    value: Value,
    metadata: Option<Value>,
    checked: Option<Instant>,
    task: bool,
    install_error: Option<String>,
}

fn asset_name() -> String {
    if cfg!(windows) {
        "codex-switcher-windows-x64.zip".into()
    } else {
        format!(
            "codex-switcher-macos-{}.zip",
            if cfg!(target_arch = "aarch64") {
                "arm64"
            } else {
                "x64"
            }
        )
    }
}

fn initial(app: &App) -> State {
    let build = instance::runtime();
    let dev = instance::project_root().join(".git").exists();
    let previous =
        config_store::read_json(&app.bridge.join("updates/result.json")).unwrap_or(Value::Null);
    let install_error = previous["error"].as_str().map(str::to_owned).or_else(|| {
        previous
            .is_null()
            .then(|| {
                diagnostics::recent(&app.bridge, 2000)
                    .ok()
                    .and_then(|rows| {
                        rows.into_iter()
                            .rev()
                            .find(|row| {
                                ["update.install", "update.rollback"]
                                    .contains(&row["event"].as_str().unwrap_or(""))
                            })
                            .and_then(|row| row["error"].as_str().map(str::to_owned))
                    })
            })
            .flatten()
    });
    let mut value = json!({"current":{"version":build["version"],"build":build["id"],"sequence":if dev{Value::Null}else{build["sequence"].clone()}},"dev":dev,"latest":null,"checkedAt":null,"status":if install_error.is_some(){"error"}else{"idle"}});
    if let Some(error) = &install_error {
        value["error"] = json!(error);
    }
    value["installationFailed"] = json!(install_error.is_some());
    State {
        value,
        metadata: None,
        checked: None,
        task: false,
        install_error,
    }
}
fn with_state<T>(app: &App, action: impl FnOnce(&mut State) -> T) -> T {
    let mut inner = app.updates.inner.lock().unwrap();
    action(inner.get_or_insert_with(|| initial(app)))
}
pub fn snapshot(app: &App) -> Value {
    with_state(app, |s| s.value.clone())
}

// An explicit loopback origin is used by the isolated downloaded-package black
// boxes. User supplied HTTP action parameters can never set an update URL.
fn url(name: &str) -> io::Result<String> {
    let base = match env::var("SWITCHER_TEST_UPDATE_ORIGIN") {
        Ok(origin) => {
            let parsed = reqwest::Url::parse(&origin).map_err(io::Error::other)?;
            if parsed.scheme() != "http" || parsed.host_str() != Some("127.0.0.1") {
                return Err(io::Error::other("Update fixture must use loopback"));
            }
            format!("{}/", origin.trim_end_matches('/'))
        }
        Err(_) => RELEASE_URL.to_owned(),
    };
    Ok(format!("{base}{name}"))
}
pub fn hidden(command: &mut Command) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    #[cfg(not(windows))]
    {
        let _ = command;
    }
}
pub fn detached(command: &mut Command) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000200);
    }
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }
}

struct TransportError {
    message: String,
    curl: Option<Value>,
}
impl From<io::Error> for TransportError {
    fn from(e: io::Error) -> Self {
        Self {
            message: e.to_string(),
            curl: None,
        }
    }
}

async fn request(app: &App, name: &str, output: Option<&Path>) -> Result<Vec<u8>, TransportError> {
    let quick = output.is_none();
    let mut command = Command::new(if cfg!(windows) {
        "curl.exe"
    } else {
        "/usr/bin/curl"
    });
    command
        .args(curl_arguments(cfg!(windows), quick, output, &url(name)?))
        .envs(crate::platform::codex_env(&app.codex_home()));
    hidden(&mut command);
    let result = tokio::time::timeout(
        Duration::from_secs(250),
        tokio::process::Command::from(command)
            .kill_on_drop(true)
            .output(),
    )
    .await;
    let output = match result {
        Ok(value) => value?,
        Err(_) => {
            return Err(TransportError {
                message: "连接 GitHub 超时，请检查网络或代理后重试。".into(),
                curl: Some(json!({"code":null,"detail":"timeout"})),
            });
        }
    };
    if output.status.success() {
        return Ok(output.stdout);
    }
    Err(curl_error(output.status.code(), &output.stderr))
}

fn curl_error(code: Option<i32>, stderr: &[u8]) -> TransportError {
    let stderr = String::from_utf8_lossy(stderr);
    let detail = regex::Regex::new(r"[\x20-\x7e]{5,}")
        .unwrap()
        .find_iter(&stderr)
        .map(|m| m.as_str())
        .filter(|s| {
            regex::Regex::new(
                r"(?i)curl:|schannel|CRYPT_|SSL|TLS|certificate|connect|resolve|timed out",
            )
            .unwrap()
            .is_match(s)
        })
        .collect::<Vec<_>>()
        .join(" ")
        .chars()
        .take(800)
        .collect::<String>();
    let message = if detail.contains("CRYPT_E_REVOCATION_OFFLINE") {
        "连接 GitHub 失败：证书吊销检查无法完成（网络无法访问吊销服务器）。".into()
    } else if code == Some(28) {
        "连接 GitHub 超时，请检查网络或代理后重试。".into()
    } else if code == Some(60) {
        "连接 GitHub 失败：服务器证书验证未通过。".into()
    } else {
        format!(
            "连接 GitHub 失败（curl 退出码 {}），请检查网络或代理。",
            code.map_or("null".into(), |n| n.to_string())
        )
    };
    TransportError {
        message,
        curl: Some(json!({"code":code,"detail":detail})),
    }
}

fn curl_arguments(windows: bool, quick: bool, output: Option<&Path>, url: &str) -> Vec<String> {
    let mut args = vec![
        "--fail",
        "--location",
        "--silent",
        "--show-error",
        "--connect-timeout",
        if quick { "10" } else { "15" },
        "--max-time",
        if quick { "20" } else { "240" },
    ]
    .into_iter()
    .map(str::to_owned)
    .collect::<Vec<_>>();
    if !quick {
        args.extend(["--speed-limit", "1", "--speed-time", "20"].map(str::to_owned));
    }
    if windows {
        args.push("--ssl-revoke-best-effort".into());
    }
    if let Some(file) = output {
        args.push("--output".into());
        args.push(file.to_string_lossy().to_string());
    }
    args.push(url.into());
    args
}

pub fn transport_fixture(input: &Value) -> Value {
    use base64::Engine;
    let windows = input["platform"] == "win32";
    let quick = input["quick"] == true;
    let output = (!quick).then(|| Path::new("fixture-output.zip"));
    let args = curl_arguments(
        windows,
        quick,
        output,
        "https://github.com/fixture/package.zip",
    );
    let stderr = base64::engine::general_purpose::STANDARD
        .decode(input["stderr"].as_str().unwrap_or(""))
        .unwrap();
    let error = curl_error(input["code"].as_i64().map(|n| n as i32), &stderr);
    json!({"exe":if windows{"curl.exe"}else{"/usr/bin/curl"},"args":args,"message":error.message,"curl":error.curl})
}

fn hex(value: &Value, size: usize) -> bool {
    value.as_str().is_some_and(|s| {
        s.len() == size
            && s.bytes()
                .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
    })
}
fn valid(value: &Value) -> bool {
    value["version"].is_string()
        && value["sequence"]
            .as_u64()
            .is_some_and(|n| n > 0 && n <= 9_007_199_254_740_991)
        && hex(&value["build"], 12)
        && hex(&value["commit"], 40)
        && hex(&value["assets"][asset_name()], 64)
        && value["publishedAt"].as_str().is_some_and(|s| {
            time::OffsetDateTime::parse(s, &time::format_description::well_known::Rfc3339).is_ok()
        })
        && value["notes"].is_string()
}
fn newer(state: &State) -> bool {
    state.value["dev"] == false
        && state.value["current"]["sequence"]
            .as_u64()
            .is_some_and(|current| {
                current > 0
                    && state
                        .metadata
                        .as_ref()
                        .is_some_and(|m| m["sequence"].as_u64().is_some_and(|next| next > current))
            })
}
fn proxy(app: &App) -> Value {
    let environment = crate::platform::codex_env(&app.codex_home());
    let value = ["https_proxy", "HTTPS_PROXY", "all_proxy", "ALL_PROXY"]
        .iter()
        .find_map(|key| environment.get(*key).filter(|s| !s.is_empty()));
    if let Some(value) = value {
        let text = if value.contains("://") {
            value.clone()
        } else {
            format!("http://{value}")
        };
        let endpoint = reqwest::Url::parse(&text).ok().map(|url| {
            format!(
                "{}://{}{}",
                url.scheme(),
                url.host_str().unwrap_or(""),
                url.port().map(|p| format!(":{p}")).unwrap_or_default()
            )
        });
        json!({"type":"manual","value":endpoint.unwrap_or("unknown".into())})
    } else {
        json!({"type":"none"})
    }
}
fn failure(error: &TransportError, proxy: &Value) -> String {
    if proxy["type"] != "manual" {
        return error.message.clone();
    }
    let address = proxy["value"].as_str().unwrap_or("");
    if error.curl.as_ref().is_some_and(|v| v["code"] == 7) {
        format!("连不上系统代理 {address}，请确认代理软件在运行。")
    } else {
        format!("{}（经系统代理 {address}）", error.message)
    }
}
fn log_failure(
    app: &App,
    event: &str,
    build: &Value,
    started: Instant,
    error: &TransportError,
) -> io::Result<String> {
    let proxy = proxy(app);
    let message = failure(error, &proxy);
    let mut row = json!({"build":build,"durationMs":started.elapsed().as_millis(),"error":message,"proxy":proxy});
    if let Some(curl) = &error.curl {
        row["curl"] = curl.clone();
    }
    diagnostics::log(&app.bridge, event, row)?;
    Ok(message)
}
pub async fn check(app: &App) -> io::Result<Value> {
    let _checking = app.updates.checking.lock().await;
    if with_state(app, |s| {
        s.task
            || s.checked
                .is_some_and(|at| at.elapsed() < Duration::from_secs(6 * 60 * 60))
    }) {
        return Ok(snapshot(app));
    }
    let started = Instant::now();
    with_state(app, |s| s.value["status"] = json!("checking"));
    let result = match request(app, "release.json", None).await {
        Ok(bytes) => serde_json::from_slice::<Value>(&bytes)
            .map_err(|e| TransportError::from(io::Error::other(e))),
        Err(error) => Err(error),
    };
    match result {
        Ok(latest) if valid(&latest) => {
            with_state(app, |s| {
                s.value["latest"] = json!({"version":latest["version"],"build":latest["build"],"sequence":latest["sequence"],"publishedAt":latest["publishedAt"],"notes":latest["notes"]});
                s.metadata = Some(latest.clone());
                s.checked = Some(Instant::now());
                s.value["checkedAt"] = json!(diagnostics::now());
                s.value["status"] = json!(if s.install_error.is_some() {
                    "error"
                } else if newer(s) {
                    "available"
                } else {
                    "idle"
                });
                if let Some(error) = &s.install_error {
                    s.value["error"] = json!(error);
                } else {
                    s.value.as_object_mut().unwrap().remove("error");
                }
            });
            diagnostics::log(
                &app.bridge,
                "update.check",
                json!({"build":latest["build"],"durationMs":started.elapsed().as_millis(),"status":snapshot(app)["status"],"proxy":proxy(app)}),
            )?;
        }
        result => {
            let error = result.err().unwrap_or(TransportError {
                message: "发布元数据不完整，请稍后检查。".into(),
                curl: None,
            });
            let message = log_failure(
                app,
                "update.check",
                &instance::runtime()["id"],
                started,
                &error,
            )?;
            with_state(app, |s| {
                s.value["status"] = json!("error");
                s.value["error"] = json!(message);
            });
        }
    }
    Ok(snapshot(app))
}

fn safe(relative: &str) -> bool {
    !Path::new(relative).is_absolute()
        && !relative.split(['/', '\\']).any(|part| part == "..")
        && !relative
            .split(['/', '\\'])
            .next()
            .is_some_and(|p| p.eq_ignore_ascii_case("private") || p.eq_ignore_ascii_case(".git"))
}
fn manifest(root: &Path) -> io::Result<Vec<String>> {
    serde_json::from_slice(&fs::read(root.join("release-files.json"))?).map_err(io::Error::other)
}
fn validate(root: &Path) -> io::Result<Vec<String>> {
    let files = manifest(root)?;
    for file in &files {
        if !safe(file) {
            return Err(io::Error::other("更新包包含无效文件路径。"));
        }
        if !root.join(file).is_file() {
            return Err(io::Error::other(format!("更新包缺少文件：{file}")));
        }
    }
    for dir in ["runtime", "bin", "node_modules"] {
        if !root.join(dir).is_dir() {
            return Err(io::Error::other(format!("更新包缺少目录：{dir}")));
        }
    }
    Ok(files)
}
fn package_root(extracted: &Path) -> PathBuf {
    extracted.join(if cfg!(windows) {
        "Codex Switcher"
    } else {
        "Codex Switcher.app/Contents/Resources"
    })
}
fn executable(root: &Path) -> PathBuf {
    root.join(if cfg!(windows) {
        "codex-switcher.exe"
    } else {
        "codex-switcher"
    })
}
async fn extract(archive: &Path, destination: &Path) -> io::Result<()> {
    fs::create_dir_all(destination)?;
    let mut command = Command::new(if cfg!(windows) {
        "tar.exe"
    } else {
        "/usr/bin/ditto"
    });
    if cfg!(windows) {
        command.arg("-xf").arg(archive).arg("-C").arg(destination);
    } else {
        command.args(["-x", "-k"]).arg(archive).arg(destination);
    }
    hidden(&mut command);
    let output = tokio::time::timeout(
        Duration::from_secs(120),
        tokio::process::Command::from(command)
            .kill_on_drop(true)
            .output(),
    )
    .await
    .map_err(io::Error::other)??;
    if output.status.success() {
        Ok(())
    } else {
        Err(io::Error::other("更新包解压失败。"))
    }
}
pub async fn install(app: Arc<App>, input: &Value) -> io::Result<Value> {
    if input.as_object().is_some_and(|o| !o.is_empty()) {
        return Err(io::Error::other("升级不接受地址或其他参数。"));
    }
    let root = instance::project_root();
    if root.join(".git").exists() {
        return Err(io::Error::other("开发目录请用 git 更新。"));
    }
    #[cfg(target_os = "macos")]
    {
        let bundle = root
            .parent()
            .and_then(Path::parent)
            .ok_or_else(|| io::Error::other("当前应用位置无法直接更新，请手动下载安装。"))?;
        if bundle.extension().is_none_or(|e| e != "app")
            || bundle.to_string_lossy().contains("/AppTranslocation/")
        {
            return Err(io::Error::other(
                "当前应用位置无法直接更新，请手动下载安装。",
            ));
        }
        use std::{ffi::CString, os::unix::ffi::OsStrExt};
        unsafe extern "C" {
            fn access(path: *const std::ffi::c_char, mode: i32) -> i32;
        }
        let path = CString::new(bundle.parent().unwrap().as_os_str().as_bytes())
            .map_err(io::Error::other)?;
        if unsafe { access(path.as_ptr(), 2) } != 0 {
            return Err(io::Error::other("当前应用位置只读，请手动下载安装。"));
        }
    }
    if with_state(&app, |s| s.task) {
        return Ok(json!({"message":"更新正在进行。"}));
    }
    if with_state(&app, |s| s.metadata.is_none()) {
        check(&app).await?;
    }
    let metadata = with_state(&app, |s| -> io::Result<Value> {
        if s.metadata.is_none() {
            return Err(io::Error::other(
                s.value["error"].as_str().unwrap_or("尚未取得更新信息。"),
            ));
        }
        if !newer(s) {
            return Err(io::Error::other("不会安装相同或更旧的版本。"));
        }
        s.task = true;
        s.install_error = None;
        s.value["installationFailed"] = json!(false);
        s.value["status"] = json!("downloading");
        s.value["progress"] = json!(0);
        s.value.as_object_mut().unwrap().remove("error");
        Ok(s.metadata.clone().unwrap())
    })?;
    tokio::spawn(async move {
        tokio::task::yield_now().await;
        let started = Instant::now();
        let result = download_package(&app, &metadata, started).await;
        if let Err(error) = result {
            let event = if snapshot(&app)["status"] == "downloading" {
                "update.download"
            } else {
                "update.install"
            };
            match log_failure(&app, event, &metadata["build"], started, &error) {
                Ok(message) => with_state(&app, |s| {
                    s.value["status"] = json!("error");
                    s.value["error"] = json!(message);
                }),
                Err(error) => eprintln!("Update failure log failed: {error}"),
            }
        }
        with_state(&app, |s| s.task = false);
    });
    Ok(json!({"message":"正在下载并校验更新，安装完成后会自动打开新页面。"}))
}

async fn download_package(
    app: &App,
    metadata: &Value,
    started: Instant,
) -> Result<(), TransportError> {
    let staging_root = app.bridge.join("updates/staging");
    fs::create_dir_all(&staging_root)?;
    let random = crate::platform::random_bytes()?;
    let staging = staging_root.join(format!(
        "package-{}",
        random[..8]
            .iter()
            .map(|n| format!("{n:02x}"))
            .collect::<String>()
    ));
    fs::create_dir(&staging)?;
    let name = asset_name();
    let archive = staging.join(&name);
    request(app, &name, Some(&archive)).await?;
    let hash = format!("{:x}", Sha256::digest(fs::read(&archive)?));
    if metadata["assets"][&name] != hash {
        return Err(io::Error::other("更新校验和不匹配，未修改安装文件。").into());
    }
    diagnostics::log(
        &app.bridge,
        "update.download",
        json!({"build":metadata["build"],"durationMs":started.elapsed().as_millis(),"status":"verified","proxy":proxy(app)}),
    )?;
    with_state(app, |s| s.value["progress"] = json!(50));
    let extracted = staging.join("extracted");
    extract(&archive, &extracted).await?;
    let source = package_root(&extracted);
    validate(&source)?;
    let mut command = Command::new(executable(&source));
    command
        .arg("--build-info")
        .env("SWITCHER_WEB_ROOT", source.join("web"));
    hidden(&mut command);
    let packaged = tokio::time::timeout(
        Duration::from_secs(10),
        tokio::process::Command::from(command)
            .kill_on_drop(true)
            .output(),
    )
    .await
    .map_err(io::Error::other)??;
    let packaged: Value = serde_json::from_slice(&packaged.stdout).map_err(io::Error::other)?;
    if packaged["id"] != metadata["build"] {
        return Err(io::Error::other("更新包构建号与发布信息不一致。").into());
    }
    if packaged["sequence"] != metadata["sequence"] {
        return Err(io::Error::other("更新包发行序号与发布信息不一致。").into());
    }
    with_state(app, |s| {
        s.value["status"] = json!("installing");
        s.value["progress"] = json!(75);
    });
    let job = Job {
        pid: std::process::id(),
        source,
        staging: staging.clone(),
        target: instance::project_root(),
        bridge_home: app.bridge.clone(),
        codex_home: app.codex_home(),
        discovery_dir: env::var_os("BRIDGE_DISCOVERY_DIR")
            .filter(|s| !s.is_empty())
            .map(PathBuf::from),
        build: metadata["build"].as_str().unwrap().into(),
        no_open: env::args().any(|arg| arg == "--no-open"),
    };
    let file = staging.join("job.json");
    instance::write_json(
        &file,
        &serde_json::to_value(&job).map_err(io::Error::other)?,
    )?;
    let worker = staging.join(executable(Path::new("")).file_name().unwrap());
    copy_file(&env::current_exe()?, &worker)?;
    let mut command = Command::new(worker);
    command
        .arg("--update-worker")
        .arg(file)
        .current_dir(staging)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    detached(&mut command);
    let mut child = tokio::process::Command::from(command).spawn()?;
    let mut line = String::new();
    let ready = tokio::time::timeout(
        Duration::from_secs(10),
        BufReader::new(child.stdout.take().unwrap()).read_line(&mut line),
    )
    .await;
    if !matches!(ready, Ok(Ok(_))) || line.trim() != "READY" {
        child.kill().await?;
        return Err(io::Error::other("升级进程未能启动。").into());
    }
    std::process::exit(0)
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Job {
    pid: u32,
    source: PathBuf,
    staging: PathBuf,
    target: PathBuf,
    bridge_home: PathBuf,
    codex_home: PathBuf,
    discovery_dir: Option<PathBuf>,
    build: String,
    #[serde(default)]
    no_open: bool,
}

fn copy_file(source: &Path, target: &Path) -> io::Result<()> {
    fs::create_dir_all(target.parent().unwrap())?;
    fs::copy(source, target)?;
    fs::set_permissions(target, fs::metadata(source)?.permissions())
}
fn copy_tree(source: &Path, target: &Path) -> io::Result<()> {
    fs::create_dir_all(target)?;
    for entry in fs::read_dir(source)? {
        let entry = entry?;
        if old_file(&entry.file_name().to_string_lossy()) {
            continue;
        }
        let destination = target.join(entry.file_name());
        if entry.file_type()?.is_dir() {
            copy_tree(&entry.path(), &destination)?;
        } else {
            copy_file(&entry.path(), &destination)?;
        }
    }
    Ok(())
}
fn remove_tree(path: &Path) -> io::Result<()> {
    match fs::remove_dir_all(path) {
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(()),
        other => other,
    }
}
fn old_file(name: &str) -> bool {
    name.rsplit_once(".old-").is_some_and(|(_, suffix)| {
        suffix.split_once('-').is_some_and(|(time, id)| {
            !time.is_empty()
                && time.bytes().all(|c| c.is_ascii_digit())
                && !id.is_empty()
                && id.bytes().all(|c| c.is_ascii_hexdigit())
        })
    })
}
fn remove_old(path: &Path) -> io::Result<()> {
    match fs::remove_file(path) {
        Err(error)
            if error.kind() == io::ErrorKind::NotFound
                || error.kind() == io::ErrorKind::PermissionDenied
                || error.raw_os_error() == Some(32) =>
        {
            Ok(())
        }
        other => other,
    }
}
fn retire(path: &Path) -> io::Result<()> {
    if !path.exists() {
        return Ok(());
    }
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis();
    let nonce = crate::platform::random_bytes()?[..4]
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    let old = path.with_file_name(format!(
        "{}.old-{stamp}-{nonce}",
        path.file_name().unwrap().to_string_lossy()
    ));
    fs::rename(path, &old)?;
    remove_old(&old)
}
fn replace_file(source: &Path, target: &Path) -> io::Result<()> {
    match copy_file(source, target) {
        Err(error)
            if error.kind() == io::ErrorKind::PermissionDenied
                || error.raw_os_error() == Some(32) =>
        {
            retire(target)?;
            copy_file(source, target)
        }
        result => result,
    }
}
fn remove_installed(path: &Path) -> io::Result<()> {
    if !path.exists() {
        return Ok(());
    }
    if path.is_dir() {
        for entry in fs::read_dir(path)? {
            remove_installed(&entry?.path())?;
        }
        if fs::read_dir(path)?.next().is_none() {
            fs::remove_dir(path)?;
        }
    } else if !old_file(&path.file_name().unwrap().to_string_lossy()) {
        match fs::remove_file(path) {
            Err(error)
                if error.kind() == io::ErrorKind::PermissionDenied
                    || error.raw_os_error() == Some(32) =>
            {
                retire(path)?
            }
            result => result?,
        }
    }
    Ok(())
}
fn replace_tree(source: &Path, target: &Path) -> io::Result<()> {
    fs::create_dir_all(target)?;
    for entry in fs::read_dir(target)? {
        let entry = entry?;
        if !old_file(&entry.file_name().to_string_lossy())
            && !source.join(entry.file_name()).exists()
        {
            remove_installed(&entry.path())?;
        }
    }
    for entry in fs::read_dir(source)? {
        let entry = entry?;
        if old_file(&entry.file_name().to_string_lossy()) {
            continue;
        }
        let destination = target.join(entry.file_name());
        if entry.file_type()?.is_dir() {
            replace_tree(&entry.path(), &destination)?;
        } else {
            replace_file(&entry.path(), &destination)?;
        }
    }
    Ok(())
}
pub fn cleanup_old(target: &Path) -> io::Result<()> {
    if !cfg!(windows) {
        return Ok(());
    }
    fn walk(path: &Path, recurse: bool) -> io::Result<()> {
        if !path.exists() {
            return Ok(());
        }
        for entry in fs::read_dir(path)? {
            let entry = entry?;
            if entry.file_type()?.is_dir() {
                if recurse {
                    walk(&entry.path(), true)?;
                }
            } else if old_file(&entry.file_name().to_string_lossy()) {
                remove_old(&entry.path())?;
            }
        }
        Ok(())
    }
    walk(target, false)?;
    for dir in ["runtime", "bin"] {
        walk(&target.join(dir), true)?;
    }
    Ok(())
}

enum Replacement {
    Windows {
        source: PathBuf,
        target: PathBuf,
        previous: PathBuf,
        files: Vec<String>,
        touched: BTreeSet<String>,
    },
    Mac {
        app: PathBuf,
        old: PathBuf,
        incoming: PathBuf,
        outgoing: PathBuf,
    },
}
impl Replacement {
    fn prepare(job: &Job, previous: &Path) -> io::Result<Self> {
        if cfg!(windows) {
            let files = validate(&job.source)?;
            let old = manifest(&job.target)?;
            let touched = old
                .into_iter()
                .chain(files.iter().cloned())
                .collect::<BTreeSet<_>>();
            for relative in &touched {
                if !safe(relative) {
                    return Err(io::Error::other("旧发行清单包含无效文件路径。"));
                }
                let file = job.target.join(relative);
                if file.exists() {
                    copy_file(&file, &previous.join(relative))?;
                }
            }
            for dir in ["runtime", "bin", "node_modules"] {
                copy_tree(&job.target.join(dir), &previous.join(dir))?;
            }
            Ok(Self::Windows {
                source: job.source.clone(),
                target: job.target.clone(),
                previous: previous.into(),
                files,
                touched,
            })
        } else {
            let app = job
                .target
                .parent()
                .and_then(Path::parent)
                .ok_or_else(|| io::Error::other("当前应用位置不允许直接升级。"))?
                .to_path_buf();
            if app.extension().is_none_or(|s| s != "app")
                || app.to_string_lossy().contains("/AppTranslocation/")
            {
                return Err(io::Error::other("当前应用位置不允许直接升级。"));
            }
            let source = job.source.parent().and_then(Path::parent).unwrap();
            let old = previous.join("Codex Switcher.app");
            let incoming = app.with_extension("app.update");
            let outgoing = app.with_extension("app.previous");
            ditto(&app, &old)?;
            remove_tree(&incoming)?;
            remove_tree(&outgoing)?;
            ditto(source, &incoming)?;
            Ok(Self::Mac {
                app,
                old,
                incoming,
                outgoing,
            })
        }
    }
    fn apply(&self) -> io::Result<()> {
        match self {
            Self::Windows {
                source,
                target,
                files,
                touched,
                ..
            } => {
                for file in touched {
                    if !files.contains(file) {
                        remove_installed(&target.join(file))?;
                    }
                }
                for file in files {
                    replace_file(&source.join(file), &target.join(file))?;
                }
                for dir in ["runtime", "bin", "node_modules"] {
                    replace_tree(&source.join(dir), &target.join(dir))?;
                }
                Ok(())
            }
            Self::Mac {
                app,
                incoming,
                outgoing,
                ..
            } => {
                fs::rename(app, outgoing)?;
                fs::rename(incoming, app)
            }
        }
    }
    fn restore(&self) -> io::Result<()> {
        match self {
            Self::Windows {
                target,
                previous,
                touched,
                ..
            } => {
                for file in touched {
                    let old = previous.join(file);
                    if old.exists() {
                        replace_file(&old, &target.join(file))?;
                    } else {
                        remove_installed(&target.join(file))?;
                    }
                }
                for dir in ["runtime", "bin", "node_modules"] {
                    replace_tree(&previous.join(dir), &target.join(dir))?;
                }
                Ok(())
            }
            Self::Mac {
                app, old, outgoing, ..
            } => {
                remove_tree(app)?;
                if outgoing.exists() {
                    fs::rename(outgoing, app)
                } else {
                    ditto(old, app)
                }
            }
        }
    }
    fn complete(&self) -> io::Result<()> {
        if let Self::Mac { outgoing, .. } = self {
            remove_tree(outgoing)?;
        }
        Ok(())
    }
}
fn ditto(from: &Path, to: &Path) -> io::Result<()> {
    let status = Command::new("/usr/bin/ditto").arg(from).arg(to).status()?;
    if status.success() {
        Ok(())
    } else {
        Err(io::Error::other("ditto copy failed"))
    }
}
async fn wait_exit(pid: u32, timeout: Duration) -> io::Result<()> {
    let deadline = Instant::now() + timeout;
    while crate::platform::alive(pid) {
        if Instant::now() >= deadline {
            return Err(io::Error::other("旧切换器后台未退出，安装文件尚未替换。"));
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    Ok(())
}
async fn launch(job: &Job, adapter_port: Option<u16>) -> io::Result<u32> {
    let native = executable(&job.target);
    let mut command = if native.exists() {
        Command::new(native)
    } else {
        let node = if cfg!(windows) {
            job.target.join("runtime/node.exe")
        } else {
            job.target.join(format!(
                "runtime/{}/node",
                if cfg!(target_arch = "aarch64") {
                    "arm64"
                } else {
                    "x64"
                }
            ))
        };
        let mut command = Command::new(node);
        command.arg(job.target.join("main.cjs"));
        command
    };
    command
        .current_dir(&job.target)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    if job.no_open {
        command.arg("--no-open");
    }
    command
        .env("BRIDGE_HOME", &job.bridge_home)
        .env("BRIDGE_CODEX_HOME", &job.codex_home)
        .env("SWITCHER_WEB_ROOT", job.target.join("web"));
    if let Some(port) = adapter_port {
        command.env("BRIDGE_PORT", port.to_string());
    }
    if let Some(directory) = &job.discovery_dir {
        command.env("BRIDGE_DISCOVERY_DIR", directory);
    } else {
        command.env_remove("BRIDGE_DISCOVERY_DIR");
    }
    detached(&mut command);
    Ok(command.spawn()?.id())
}
async fn stop_adapter(job: &Job) -> io::Result<Option<u16>> {
    if !cfg!(windows) {
        return Ok(None);
    }
    let adapter = config_store::read_json(&job.bridge_home.join("adapter.json"))?;
    let Some(port) = adapter["port"]
        .as_u64()
        .filter(|p| *p > 0 && *p <= 65535)
        .map(|p| p as u16)
    else {
        return Ok(None);
    };
    let Some(pid) = crate::platform::port_pid(port)? else {
        return Ok(None);
    };
    if pid == job.pid {
        return Ok(None);
    }
    let image = crate::platform::image(pid)?;
    let same = |a: &Path, b: &Path| -> bool {
        match (fs::canonicalize(a), fs::canonicalize(b)) {
            (Ok(a), Ok(b)) => crate::platform::display_path(&a)
                .eq_ignore_ascii_case(&crate::platform::display_path(&b)),
            _ => false,
        }
    };
    let owned = same(&image, &job.target.join("codex-switcher.exe"))
        || (same(&image, &job.target.join("runtime/node.exe"))
            && crate::platform::command(pid)?
                .to_lowercase()
                .contains(&job.target.join("main.cjs").to_string_lossy().to_lowercase()));
    if !owned {
        return Ok(None);
    }
    crate::platform::stop(pid).await?;
    diagnostics::log(
        &job.bridge_home,
        "update.adapter",
        json!({"pid":pid,"port":port,"verified":true,"status":"stopped"}),
    )?;
    Ok(Some(port))
}
async fn healthy(job: &Job) -> io::Result<()> {
    let deadline = Instant::now() + Duration::from_secs(30);
    let mut detail = "未收到新后台的运行记录".to_owned();
    let client = reqwest::Client::builder()
        .no_proxy()
        .timeout(Duration::from_secs(1))
        .build()
        .map_err(io::Error::other)?;
    while Instant::now() < deadline {
        let data = if cfg!(windows) && crate::migration::legacy_home(&job.bridge_home, &job.target)
        {
            env::var_os("LOCALAPPDATA")
                .map(PathBuf::from)
                .unwrap_or_else(|| crate::platform::user_home().join("AppData/Local"))
                .join("CodexSwitcher")
        } else {
            job.bridge_home.clone()
        };
        let running = config_store::read_json(&data.join("running.json"))?;
        if running["build"]["id"] == job.build
            && let Some((base, token)) = running["url"].as_str().and_then(|s| s.split_once("/#"))
        {
            let result = client
                .get(format!("{base}/api/runtime"))
                .bearer_auth(token)
                .send()
                .await;
            match result {
                Ok(response) if response.status().is_success() => {
                    if response.json::<Value>().await.map_err(io::Error::other)?["id"] == job.build
                    {
                        return Ok(());
                    }
                    detail = "新后台构建号未通过检查".into();
                }
                Ok(_) => detail = "新后台构建号未通过检查".into(),
                Err(error) => detail = error.to_string(),
            }
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    Err(io::Error::other(format!(
        "新后台在30秒内未通过健康检查：{detail}"
    )))
}
pub async fn worker(file: &Path) -> io::Result<()> {
    let job: Job = serde_json::from_slice(&fs::read(file)?).map_err(io::Error::other)?;
    use std::io::Write;
    println!("READY");
    io::stdout().flush()?;
    let result = perform(&job).await;
    if let Err(error) = &result {
        let message = format!("升级未完成：{error}");
        instance::write_json(
            &job.bridge_home.join("updates/result.json"),
            &json!({"error":message,"build":job.build}),
        )?;
        diagnostics::log(
            &job.bridge_home,
            "update.rollback",
            json!({"build":job.build,"error":message,"status":"error"}),
        )?;
    }
    result
}
async fn perform(job: &Job) -> io::Result<()> {
    wait_exit(job.pid, Duration::from_secs(30)).await?;
    let started = Instant::now();
    let previous = job.bridge_home.join("updates/previous");
    let result = job.bridge_home.join("updates/result.json");
    let mut replacement = None;
    let mut new_pid = None;
    let mut adapter_port = None;
    let apply = async {
        adapter_port = stop_adapter(job).await?;
        remove_tree(&previous)?;
        fs::create_dir_all(&previous)?;
        replacement = Some(Replacement::prepare(job, &previous)?);
        diagnostics::log(
            &job.bridge_home,
            "update.install",
            json!({"build":job.build,"status":"started","durationMs":0}),
        )?;
        replacement.as_ref().unwrap().apply()?;
        instance::write_json(&result, &json!({"build":job.build,"status":"installing"}))?;
        new_pid = Some(launch(job, adapter_port).await?);
        healthy(job).await?;
        instance::write_json(&result, &json!({"build":job.build,"status":"done"}))?;
        replacement.as_ref().unwrap().complete()?;
        diagnostics::log(
            &job.bridge_home,
            "update.install",
            json!({"build":job.build,"status":"done","durationMs":started.elapsed().as_millis()}),
        )
    }
    .await;
    if let Err(error) = apply {
        diagnostics::log(
            &job.bridge_home,
            "update.install",
            json!({"build":job.build,"error":error.to_string(),"durationMs":started.elapsed().as_millis()}),
        )?;
        let rollback=async {
            if let Some(pid)=new_pid{crate::platform::stop(pid).await?;}
            if let Some(replacement)=&replacement{replacement.restore()?;}
            let message=format!("{}{}",if replacement.is_some(){"更新失败，已恢复上一版："}else{"更新未完成，原版本未改动："},error);
            instance::write_json(&result,&json!({"build":job.build,"error":message}))?;launch(job,adapter_port).await?;
            diagnostics::log(&job.bridge_home,"update.rollback",json!({"build":job.build,"status":"done","error":message,"durationMs":started.elapsed().as_millis()}))
        }.await;
        if let Err(rollback_error) = rollback {
            return Err(io::Error::other(format!(
                "更新失败：{error}；恢复未完成：{rollback_error}"
            )));
        }
    }
    Ok(())
}
