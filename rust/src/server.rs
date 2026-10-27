//! HTTP framework. Later migration batches expose explicit 501 action errors.
use http_body_util::{BodyExt, Full};
use hyper::{
    Request, Response,
    body::{Bytes, Incoming},
};
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    convert::Infallible,
    fs, io,
    path::PathBuf,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    time::{Duration, Instant},
};
type Download = (Instant, String, Vec<u8>);
pub(crate) struct App {
    pub home: PathBuf,
    pub bridge: PathBuf,
    pub web: PathBuf,
    pub token: String,
    pub port: u16,
    pub protection: crate::platform::DataProtection,
    pub first_request: AtomicBool,
    pub ready_at: Instant,
    pub downloads: Mutex<HashMap<String, Download>>,
}
fn companion_archive(app: &App) -> io::Result<Vec<u8>> {
    let source = app.web.parent().unwrap().join("vscode-companion");
    let mut bytes = Vec::new();
    let mut directory = Vec::new();
    let mut count = 0u16;
    for file in [
        "package.json",
        "extension.cjs",
        "extension.vsixmanifest",
        "content-types.xml",
    ] {
        let name = match file {
            "extension.vsixmanifest" => file.to_string(),
            "content-types.xml" => "[Content_Types].xml".into(),
            _ => format!("extension/{file}"),
        };
        let data = fs::read(source.join(file))?;
        let mut crc = !0u32;
        for byte in &data {
            crc ^= u32::from(*byte);
            for _ in 0..8 {
                crc = (crc >> 1) ^ if crc & 1 == 1 { 0xedb88320 } else { 0 };
            }
        }
        crc = !crc;
        let offset = bytes.len() as u32;
        let length = data.len() as u32;
        bytes.extend_from_slice(&0x04034b50u32.to_le_bytes());
        for value in [20u16, 0, 0, 0, 0] {
            bytes.extend_from_slice(&value.to_le_bytes());
        }
        for value in [crc, length, length] {
            bytes.extend_from_slice(&value.to_le_bytes());
        }
        for value in [name.len() as u16, 0] {
            bytes.extend_from_slice(&value.to_le_bytes());
        }
        bytes.extend_from_slice(name.as_bytes());
        bytes.extend(data);
        directory.extend_from_slice(&0x02014b50u32.to_le_bytes());
        for value in [20u16, 20, 0, 0, 0, 0] {
            directory.extend_from_slice(&value.to_le_bytes());
        }
        for value in [crc, length, length] {
            directory.extend_from_slice(&value.to_le_bytes());
        }
        for value in [name.len() as u16, 0, 0, 0, 0] {
            directory.extend_from_slice(&value.to_le_bytes());
        }
        directory.extend_from_slice(&0u32.to_le_bytes());
        directory.extend_from_slice(&offset.to_le_bytes());
        directory.extend_from_slice(name.as_bytes());
        count += 1;
    }
    let offset = bytes.len() as u32;
    let length = directory.len() as u32;
    bytes.extend(directory);
    bytes.extend_from_slice(&0x06054b50u32.to_le_bytes());
    for value in [0u16, 0, count, count] {
        bytes.extend_from_slice(&value.to_le_bytes());
    }
    bytes.extend_from_slice(&length.to_le_bytes());
    bytes.extend_from_slice(&offset.to_le_bytes());
    bytes.extend_from_slice(&0u16.to_le_bytes());
    Ok(bytes)
}
const ACTIONS: &[&str] = &[
    "quit",
    "uninstall",
    "backups",
    "restoreBackup",
    "checkUpdate",
    "installUpdate",
    "updateCompanions",
    "resumeThreadSync",
    "clients",
    "setEnvironment",
    "clientHeartbeat",
    "installRemoteAgent",
    "remoteSwitch",
    "reloadClients",
    "companionPackage",
    "remoteAgentPackage",
    "companionInstall",
    "threads",
    "diagnose",
    "exportContext",
    "exportDiagnostics",
    "desktopSwitch",
    "accounts",
    "accountQuota",
    "accountLogin",
    "accountLoginCancel",
    "accountRename",
    "accountRemove",
    "accountSwitch",
    "models",
    "probe",
    "switch",
    "restore",
    "autostart",
    "providerAdd",
    "providerUpdate",
    "providerRemove",
    "importHermes",
    "integrate",
];
fn same_secret(left: &str, right: &str) -> bool {
    left.len() == right.len()
        && left
            .bytes()
            .zip(right.bytes())
            .fold(0u8, |difference, (a, b)| difference | (a ^ b))
            == 0
}
fn response(status: u16, content_type: &str, bytes: Vec<u8>) -> Response<Full<Bytes>> {
    Response::builder()
        .status(status)
        .header("Content-Type", content_type)
        .header("Cache-Control", "no-store")
        .header("X-Content-Type-Options", "nosniff")
        .header("Referrer-Policy", "no-referrer")
        .body(Full::new(Bytes::from(bytes)))
        .unwrap()
}
fn error(status: u16, message: &str) -> Response<Full<Bytes>> {
    response(
        status,
        "application/json; charset=utf-8",
        serde_json::to_vec(&json!({"error":message})).unwrap(),
    )
}
pub(crate) async fn serve(
    req: Request<Incoming>,
    app: Arc<App>,
) -> Result<Response<Full<Bytes>>, Infallible> {
    let host = req
        .headers()
        .get("host")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    if host != format!("127.0.0.1:{}", app.port) && host != format!("localhost:{}", app.port) {
        return Ok(error(403, "Host rejected"));
    }
    if let Some(origin) = req.headers().get("origin")
        && origin.to_str().ok() != Some(format!("http://{host}").as_str())
    {
        return Ok(error(403, "Origin rejected"));
    }
    let route = req.uri().path().to_owned();
    if req.method() == "GET" && route.starts_with("/download/") {
        let item = app.downloads.lock().unwrap().remove(&route[10..]);
        if let Some((at, name, bytes)) = item
            && at.elapsed() < Duration::from_secs(300)
        {
            let mut res = response(200, "application/octet-stream", bytes);
            res.headers_mut().insert(
                "content-disposition",
                format!("attachment; filename=\"{name}\"").parse().unwrap(),
            );
            return Ok(res);
        }
        return Ok(error(404, "Download expired"));
    }
    if let Some(action) = route.strip_prefix("/api/") {
        if !app.first_request.swap(true, Ordering::Relaxed)
            && let Err(error_value) = crate::diagnostics::log(
                &app.bridge,
                "startup.firstRequest",
                json!({"sinceReadyMs":app.ready_at.elapsed().as_millis(),"route":route}),
            )
        {
            return Ok(error(500, &error_value.to_string()));
        }
        let bearer = same_secret(
            req.headers()
                .get("authorization")
                .and_then(|v| v.to_str().ok())
                .unwrap_or(""),
            &format!("Bearer {}", app.token),
        );
        let cookie_name = format!("codex_switcher_{}=", app.port);
        let cookie = req
            .headers()
            .get("cookie")
            .and_then(|v| v.to_str().ok())
            .unwrap_or("")
            .split(';')
            .map(str::trim)
            .find_map(|p| p.strip_prefix(&cookie_name))
            .is_some_and(|token| same_secret(token, &app.token));
        if route == "/api/session" {
            if req.method() != "POST" {
                return Ok(error(405, "POST required"));
            }
            if !bearer {
                return Ok(error(401, "请从桌面快捷方式重新打开切换器。"));
            }
            let mut res = response(204, "application/json", Vec::new());
            res.headers_mut().insert(
                "set-cookie",
                format!(
                    "{cookie_name}{}; HttpOnly; SameSite=Strict; Path=/api/",
                    app.token
                )
                .parse()
                .unwrap(),
            );
            return Ok(res);
        }
        if !bearer && !cookie {
            return Ok(error(
                401,
                "本机会话已过期，请从桌面快捷方式重新打开切换器。",
            ));
        }
        let value = match (req.method().as_str(), route.as_str()) {
            ("GET", "/api/runtime") => Ok(crate::instance::runtime()),
            ("GET", "/api/state") => app.state(),
            _ => {
                if req.method() != "POST" {
                    return Ok(error(405, "Method not allowed"));
                }
                if !ACTIONS.contains(&action) {
                    return Ok(error(404, "Unknown action"));
                }
                if !req
                    .headers()
                    .get("content-type")
                    .and_then(|v| v.to_str().ok())
                    .is_some_and(|value| value.starts_with("application/json"))
                {
                    return Ok(error(415, "JSON required"));
                }
                let limit = if action == "clientHeartbeat" {
                    1024 * 1024
                } else {
                    16384
                };
                let mut body = req.into_body();
                let mut bytes = Vec::new();
                while let Some(frame) = body.frame().await {
                    match frame {
                        Ok(frame) => {
                            if let Some(data) = frame.data_ref() {
                                if bytes.len() + data.len() > limit {
                                    return Ok(error(413, "Payload too large"));
                                }
                                bytes.extend_from_slice(data);
                            }
                        }
                        Err(_) => return Ok(error(400, "Request body unavailable")),
                    }
                }
                let input = if bytes.is_empty() {
                    Ok(json!({}))
                } else {
                    serde_json::from_slice::<Value>(&bytes)
                };
                if input.is_err() {
                    return Ok(error(400, "Invalid JSON"));
                }
                if action == "companionPackage" {
                    let bytes = match companion_archive(&app) {
                        Ok(bytes) => bytes,
                        Err(value) => return Ok(error(400, &value.to_string())),
                    };
                    let key = match crate::platform::random_bytes() {
                        Ok(bytes) => bytes[..24]
                            .iter()
                            .map(|byte| format!("{byte:02x}"))
                            .collect::<String>(),
                        Err(value) => return Ok(error(500, &value.to_string())),
                    };
                    let mut downloads = app.downloads.lock().unwrap();
                    downloads.retain(|_, (at, _, _)| at.elapsed() < Duration::from_secs(300));
                    downloads.insert(
                        key.clone(),
                        (
                            Instant::now(),
                            "codex-switcher-companion.vsix".into(),
                            bytes,
                        ),
                    );
                    return Ok(response(200,"application/json; charset=utf-8",serde_json::to_vec(&json!({"filename":"codex-switcher-companion.vsix","url":format!("/download/{key}")})).unwrap()));
                }
                let result = match action {
                    "exportDiagnostics" => Some(crate::diagnostics::export(&app)),
                    "threads" => Some(Ok(crate::diagnostics::threads(
                        &app.codex_home(),
                        &input.unwrap(),
                    ))),
                    "diagnose" => Some(crate::diagnostics::diagnose(&app, &input.unwrap())),
                    "exportContext" => Some(crate::diagnostics::export_context(
                        &app,
                        input.unwrap()["id"].as_str().unwrap_or(""),
                    )),
                    "clients" => Some(crate::platform::client_status(&app.codex_home()).map(
                        |mut value| {
                            value["runtime"] = json!(
                                crate::platform::codex_path(&app.bridge)
                                    .ok()
                                    .map(|path| crate::platform::display_path(&path))
                            );
                            value
                        },
                    )),
                    "setEnvironment" => {
                        Some(crate::platform::set_environment(&app, &input.unwrap()))
                    }
                    "providerAdd" => Some(app.provider_add(&input.unwrap())),
                    "providerUpdate" => Some(app.provider_update(&input.unwrap())),
                    "providerRemove" => Some(app.provider_remove(&input.unwrap())),
                    "backups" => Some(app.backups()),
                    "restoreBackup" => Some(app.restore_backup(&input.unwrap())),
                    "models" => Some(app.models(&input.unwrap())),
                    "importHermes" => Some(app.import_hermes()),
                    "autostart" => Some(crate::integration::autostart(
                        input.unwrap()["enabled"].as_bool().unwrap_or(false),
                        &app.bridge,
                    )),
                    _ => None,
                };
                if let Some(result) = result {
                    return Ok(match result {
                        Ok(value) => response(
                            200,
                            "application/json; charset=utf-8",
                            serde_json::to_vec(&value).unwrap(),
                        ),
                        Err(error_value) => {
                            let message = error_value.to_string();
                            if action == "setEnvironment"
                                && message == "该程序不在自动识别的安装目录中，请确认后再使用。"
                            {
                                response(
                                    400,
                                    "application/json; charset=utf-8",
                                    serde_json::to_vec(
                                        &json!({"error":message,"code":"untrusted_codex"}),
                                    )
                                    .unwrap(),
                                )
                            } else {
                                error(400, &message)
                            }
                        }
                    });
                }
                return Ok(error(501, "Action pending Rust migration"));
            }
        };
        return Ok(match value {
            Ok(v) => response(
                200,
                "application/json; charset=utf-8",
                serde_json::to_vec(&v).unwrap(),
            ),
            Err(_) => error(500, "Fixture read failed"),
        });
    }
    if req.method() != "GET" {
        return Ok(error(404, "Not found"));
    }
    let relative = if route == "/" {
        "index.html"
    } else {
        route.trim_start_matches('/')
    };
    if relative.contains("..") || relative.contains(['\\', ':', '%']) {
        return Ok(error(404, "Not found"));
    }
    let mime = if route == "/" {
        "text/html; charset=utf-8"
    } else if relative.ends_with(".js") {
        "text/javascript; charset=utf-8"
    } else if relative.ends_with(".css") {
        "text/css; charset=utf-8"
    } else {
        return Ok(error(404, "Not found"));
    };
    Ok(match fs::read(app.web.join(relative)) {
        Ok(bytes) => {
            let mut res = response(200, mime, bytes);
            res.headers_mut().insert("content-security-policy","default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'".parse().unwrap());
            res
        }
        Err(_) => error(500, "Static file unavailable"),
    })
}
