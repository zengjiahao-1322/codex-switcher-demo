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
    pub accounts: crate::accounts::Runtime,
    pub editors: crate::editors::Runtime,
}
pub fn extension_archive(app: &App, remote: bool) -> io::Result<Vec<u8>> {
    let source = app.web.parent().unwrap().join(if remote {
        "vscode-remote-agent"
    } else {
        "vscode-companion"
    });
    let mut files = vec![];
    for file in ["package.json", "extension.cjs"] {
        files.push((format!("extension/{file}"), fs::read(source.join(file))?));
    }
    let companion = app.web.parent().unwrap().join("vscode-companion");
    files.push((
        "[Content_Types].xml".to_owned(),
        fs::read(companion.join("content-types.xml"))?,
    ));
    let manifest = if remote {
        let package: Value = serde_json::from_slice(&fs::read(source.join("package.json"))?)
            .map_err(io::Error::other)?;
        format!(r#"<?xml version="1.0" encoding="utf-8"?>
<PackageManifest Version="2.0.0" xmlns="http://schemas.microsoft.com/developer/vsx-schema/2011">
 <Metadata><Identity Language="en-US" Id="codex-switcher-remote" Version="{}" Publisher="codex-switcher-demo"/><DisplayName>Codex Switcher Remote Agent</DisplayName><Description xml:space="preserve">Apply a selected API to this Remote-SSH server.</Description><Properties><Property Id="Microsoft.VisualStudio.Code.Engine" Value="^1.85.0"/></Properties></Metadata>
 <Installation><InstallationTarget Id="Microsoft.VisualStudio.Code"/></Installation><Dependencies/>
 <Assets><Asset Type="Microsoft.VisualStudio.Code.Manifest" Path="extension/package.json" Addressable="true"/></Assets>
</PackageManifest>"#, package["version"].as_str().unwrap()).into_bytes()
    } else {
        fs::read(companion.join("extension.vsixmanifest"))?
    };
    files.push(("extension.vsixmanifest".to_owned(), manifest));
    let mut bytes = Vec::new();
    let mut directory = Vec::new();
    let mut count = 0u16;
    for (name, data) in files {
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
                if ["companionPackage", "remoteAgentPackage"].contains(&action) {
                    let remote = action == "remoteAgentPackage";
                    let filename = if remote {
                        "codex-switcher-remote.vsix"
                    } else {
                        "codex-switcher-companion.vsix"
                    };
                    let bytes = match extension_archive(&app, remote) {
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
                    downloads.insert(key.clone(), (Instant::now(), filename.into(), bytes));
                    return Ok(response(
                        200,
                        "application/json; charset=utf-8",
                        serde_json::to_vec(
                            &json!({"filename":filename,"url":format!("/download/{key}")}),
                        )
                        .unwrap(),
                    ));
                }
                if [
                    "clientHeartbeat",
                    "clients",
                    "reloadClients",
                    "remoteSwitch",
                    "installRemoteAgent",
                    "companionInstall",
                    "desktopSwitch",
                    "accountSwitch",
                    "resumeThreadSync",
                    "restoreBackup",
                ]
                .contains(&action)
                {
                    let input = input.unwrap();
                    let result = match action {
                        "clientHeartbeat" => crate::editors::heartbeat(app.clone(), &input).await,
                        "clients" => crate::editors::status(&app).await.map(|mut v| {
                            v["remotes"] =
                                json!(crate::remote::groups(&app.bridge).unwrap_or_default());
                            v["runtime"] = json!(
                                crate::platform::codex_path(&app.bridge)
                                    .ok()
                                    .map(|p| crate::platform::display_path(&p))
                            );
                            v["editors"] = json!(
                                crate::editor_integration::editors()
                                    .unwrap_or_default()
                                    .into_iter()
                                    .map(|mut e| {
                                        e.as_object_mut().unwrap().remove("file");
                                        e
                                    })
                                    .collect::<Vec<_>>()
                            );
                            v
                        }),
                        "reloadClients" => crate::editors::reload(&app, &input, &[], false),
                        "remoteSwitch" => crate::remote::apply(app.clone(), &input).await,
                        "installRemoteAgent" => crate::remote::install(app.clone(), &input).await,
                        "companionInstall" => {
                            crate::editor_integration::install(&app, &input).await
                        }
                        _ => crate::switching::schedule(app.clone(), action, &input).await,
                    };
                    return Ok(match result {
                        Ok(v) => response(
                            200,
                            "application/json; charset=utf-8",
                            serde_json::to_vec(&v).unwrap(),
                        ),
                        Err(e) => error(400, &e.to_string()),
                    });
                }
                if crate::accounts::ACTIONS.contains(&action) {
                    return Ok(
                        match crate::accounts::action(app.clone(), action, &input.unwrap()).await {
                            Ok(value) => response(
                                200,
                                "application/json; charset=utf-8",
                                serde_json::to_vec(&value).unwrap(),
                            ),
                            Err(value) => error(400, &value.to_string()),
                        },
                    );
                }
                if crate::config_ops::ACTIONS.contains(&action) {
                    let result = crate::config_ops::action(&app, action, &input.unwrap()).await;
                    return Ok(match result {
                        Ok(value) => response(
                            200,
                            "application/json; charset=utf-8",
                            serde_json::to_vec(&value).unwrap(),
                        ),
                        Err(error_value) => error(400, &error_value.to_string()),
                    });
                }
                let result = match action {
                    "exportDiagnostics" => Some(crate::diagnostics::export(&app)),
                    "threads" => Some(Ok(crate::diagnostics::threads(
                        &app.codex_home(),
                        &input.unwrap(),
                    ))),
                    "diagnose" => Some(crate::diagnostics::diagnose(&app, &input.unwrap()).await),
                    "exportContext" => Some(crate::diagnostics::export_context(
                        &app,
                        input.unwrap()["id"].as_str().unwrap_or(""),
                    )),
                    "setEnvironment" => {
                        Some(crate::platform::set_environment(&app, &input.unwrap()))
                    }
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
