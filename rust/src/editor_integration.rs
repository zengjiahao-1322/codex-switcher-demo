//! VSIX resources stay JavaScript; installation invokes the discovered editor CLI.
use crate::{editors::text, server::App};
use serde_json::{Value, json};
use std::{fs, io, path::PathBuf, time::Duration};

pub fn editors() -> io::Result<Vec<Value>> {
    let brands = [
        (
            "VS Code",
            "Visual Studio Code.app",
            "code",
            "Microsoft VS Code",
            "bin",
        ),
        (
            "VS Code Insiders",
            "Visual Studio Code - Insiders.app",
            "code-insiders",
            "Microsoft VS Code Insiders",
            "bin",
        ),
        (
            "Cursor",
            "Cursor.app",
            "cursor",
            "cursor",
            "resources/app/bin",
        ),
        ("Windsurf", "Windsurf.app", "windsurf", "Windsurf", "bin"),
    ];
    let mut candidates = vec![];
    if cfg!(windows) {
        for root in [
            PathBuf::from(std::env::var_os("LOCALAPPDATA").unwrap_or_default()).join("Programs"),
            PathBuf::from(
                std::env::var_os("ProgramFiles").unwrap_or_else(|| "C:/Program Files".into()),
            ),
        ] {
            for (name, _, cli, folder, bin) in brands {
                candidates.push((name, root.join(folder).join(bin).join(format!("{cli}.cmd"))));
            }
        }
    } else {
        let mut apps = vec![];
        for root in [
            PathBuf::from("/Applications"),
            crate::platform::user_home().join("Applications"),
        ] {
            for (_, app, _, _, _) in brands {
                apps.push(root.join(app));
            }
        }
        for p in crate::platform::scan()?["ancestry"]
            .as_array()
            .into_iter()
            .flatten()
        {
            if let Some((prefix, _)) = text(&p["exe"]).split_once(".app/Contents/") {
                apps.push(PathBuf::from(format!("{prefix}.app")));
            }
        }
        for app in apps {
            for (name, _, cli, _, _) in brands {
                candidates.push((name, app.join("Contents/Resources/app/bin").join(cli)));
            }
        }
    }
    let mut found = vec![];
    let mut seen = std::collections::HashSet::new();
    for (name, file) in candidates {
        if file.is_file() && seen.insert(file.clone()) {
            found.push(json!({"id":found.len(),"name":name,"file":file}));
        }
    }
    Ok(found)
}
pub async fn install(app: &App, input: &Value) -> io::Result<Value> {
    let id = input["id"]
        .as_u64()
        .or_else(|| text(&input["id"]).parse().ok());
    let editor = editors()?
        .into_iter()
        .find(|e| e["id"].as_u64() == id)
        .ok_or_else(|| {
            io::Error::other("未检测到该编辑器。可下载 VSIX 后在编辑器中选择“从 VSIX 安装”。")
        })?;
    let shim = PathBuf::from(text(&editor["file"]));
    let (exe, cli) = if cfg!(windows) {
        let script = fs::read_to_string(&shim)?;
        let pattern =
            regex::Regex::new(r#"(?i)"([^"\r\n]+\.exe)"\s+"([^"\r\n]+cli\.(?:js|mjs))"#).unwrap();
        let c = pattern.captures(&script).ok_or_else(|| {
            io::Error::other("无法识别编辑器的官方 CLI 入口。请下载 VSIX 手动安装。")
        })?;
        let resolve = |value: &str| {
            shim.parent().unwrap().join(
                regex::Regex::new(r"(?i)^%~dp0")
                    .unwrap()
                    .replace(value, "")
                    .as_ref(),
            )
        };
        (resolve(&c[1]), resolve(&c[2]))
    } else {
        let root = shim.parent().unwrap().parent().unwrap();
        let contents = root.parent().unwrap().parent().unwrap();
        let output = tokio::process::Command::new("/usr/libexec/PlistBuddy")
            .args(["-c", "Print :CFBundleExecutable"])
            .arg(contents.join("Info.plist"))
            .output()
            .await?;
        if !output.status.success() {
            return Err(io::Error::other("无法识别编辑器 CLI 入口"));
        }
        let name = String::from_utf8(output.stdout).map_err(io::Error::other)?;
        (
            contents.join("MacOS").join(name.trim()),
            root.join("out/cli.js"),
        )
    };
    if !exe.is_file() || !cli.is_file() {
        return Err(io::Error::other("无法识别编辑器 CLI 入口"));
    }
    let file = app.bridge.join("codex-switcher-companion.vsix");
    fs::write(&file, crate::server::extension_archive(app, false)?)?;
    let mut command = tokio::process::Command::new(exe);
    command
        .arg(cli)
        .arg("--install-extension")
        .arg(file)
        .arg("--force")
        .env("ELECTRON_RUN_AS_NODE", "1")
        .kill_on_drop(true);
    #[cfg(windows)]
    command.creation_flags(0x08000000);
    let result = tokio::time::timeout(Duration::from_secs(60), command.output()).await;
    if !matches!(result, Ok(Ok(output)) if output.status.success()) {
        return Err(io::Error::other("扩展安装失败，请下载 VSIX 手动安装。"));
    }
    Ok(
        json!({"message":format!("已为 {} 安装伴随扩展。已有窗口可能需要先执行一次“重载窗口”才能启用新版本；打开 Codex 后，状态栏显示“Codex Switcher · 已接入”才表示后端已关联，可自动重载。",text(&editor["name"]))}),
    )
}
