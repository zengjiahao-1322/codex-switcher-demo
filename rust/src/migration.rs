//! One-time, read-only import from old Windows installations.
use crate::server::App;
use serde_json::{Value, json};
use std::{
    env, io,
    path::{Path, PathBuf},
    sync::Arc,
};

pub fn configured_home() -> Option<PathBuf> {
    let configured = env::var_os("BRIDGE_HOME")
        .filter(|p| !p.is_empty())
        .map(PathBuf::from)?;
    if cfg!(windows) && legacy_home(&configured, &crate::instance::project_root()) {
        None
    } else {
        Some(configured)
    }
}
pub fn legacy_home(home: &Path, install: &Path) -> bool {
    let normal = |p: &Path| {
        let mut normalized = PathBuf::new();
        for part in std::path::absolute(p).unwrap().components() {
            match part {
                std::path::Component::ParentDir => {
                    normalized.pop();
                }
                std::path::Component::CurDir => {}
                _ => normalized.push(part),
            }
        }
        normalized
            .to_string_lossy()
            .replace('\\', "/")
            .trim_end_matches('/')
            .to_lowercase()
    };
    normal(home) == normal(&install.join("private"))
}
pub fn data_home() -> PathBuf {
    configured_home().unwrap_or_else(|| {
        if cfg!(windows) {
            env::var_os("LOCALAPPDATA")
                .map(PathBuf::from)
                .unwrap_or_else(|| crate::platform::user_home().join("AppData/Local"))
                .join("CodexSwitcher")
        } else {
            crate::platform::user_home().join("Library/Application Support/CodexApiSwitcher")
        }
    })
}
pub fn summary(bridge: &Path) -> io::Result<Value> {
    let value = crate::accounts::read(&bridge.join("migrated.json"), Value::Null)?;
    Ok(if value.is_null() {
        Value::Null
    } else {
        json!({"folders":value["folders"],"accounts":value["accounts"],"apis":value["apis"],"at":value["at"]})
    })
}
pub fn prepare(install: &Path, bridge: &Path) -> io::Result<bool> {
    #[cfg(windows)]
    {
        windows::prepare(install, bridge)
    }
    #[cfg(not(windows))]
    {
        let _ = (install, bridge);
        Ok(false)
    }
}
pub fn start(app: Arc<App>, copied: bool) {
    #[cfg(windows)]
    windows::start(app, copied);
    #[cfg(not(windows))]
    let _ = (app, copied);
}
pub async fn scan_fixture(install: &Path, bridge: &Path) -> io::Result<Value> {
    #[cfg(windows)]
    {
        let install = install.to_path_buf();
        let bridge = bridge.to_path_buf();
        let started = std::time::Instant::now();
        let scan = tokio::task::spawn_blocking(move || windows::background_scan(&install, &bridge))
            .await
            .map_err(io::Error::other)??;
        Ok(crate::diagnostics::redact(
            &json!({"durationMs":started.elapsed().as_secs_f64()*1000.0,"cpuMs":scan.cpu_ms,"skipped":scan.skipped,"sources":scan.sources,"readOnly":true}),
        ))
    }
    #[cfg(not(windows))]
    {
        let _ = (install, bridge);
        Err(io::Error::new(
            io::ErrorKind::Unsupported,
            "Windows migration only",
        ))
    }
}
#[cfg(windows)]
mod windows {
    use super::*;
    use crate::{accounts::read, instance::write_json};
    use sha2::{Digest, Sha256};
    use std::os::windows::fs::MetadataExt;
    use std::{collections::HashSet, fs, time::Instant};
    type Handle = *mut std::ffi::c_void;
    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn GetLogicalDrives() -> u32;
        fn GetDriveTypeW(path: *const u16) -> u32;
        fn GetCurrentThread() -> Handle;
        fn GetThreadPriority(thread: Handle) -> i32;
        fn SetThreadPriority(thread: Handle, priority: i32) -> i32;
        fn GetThreadTimes(
            thread: Handle,
            created: *mut u64,
            exited: *mut u64,
            kernel: *mut u64,
            user: *mut u64,
        ) -> i32;
    }
    fn enabled() -> bool {
        configured_home().is_none()
    }
    fn cpu_ms() -> io::Result<f64> {
        let (mut created, mut exited, mut kernel, mut user) = (0, 0, 0, 0);
        if unsafe {
            GetThreadTimes(
                GetCurrentThread(),
                &mut created,
                &mut exited,
                &mut kernel,
                &mut user,
            )
        } == 0
        {
            return Err(io::Error::last_os_error());
        }
        Ok((kernel + user) as f64 / 10000.0)
    }
    fn copy_tree(source: &Path, target: &Path) -> io::Result<()> {
        let info = fs::symlink_metadata(source)?;
        if info.file_attributes() & 0x400 != 0 {
            return Err(io::Error::other("旧数据目录包含链接，未迁移"));
        }
        if info.is_dir() {
            fs::create_dir_all(target)?;
            for entry in fs::read_dir(source)? {
                let entry = entry?;
                copy_tree(&entry.path(), &target.join(entry.file_name()))?;
            }
        } else {
            if let Some(parent) = target.parent() {
                fs::create_dir_all(parent)?;
            }
            fs::copy(source, target)?;
        }
        Ok(())
    }
    pub fn prepare(install: &Path, bridge: &Path) -> io::Result<bool> {
        if !enabled() || bridge.join("migrated.json").exists() {
            return Ok(false);
        }
        let source = install.join("private");
        let empty = !bridge.exists() || fs::read_dir(bridge)?.next().is_none();
        if empty && source.exists() {
            copy_tree(&source, bridge)?;
            return Ok(true);
        }
        Ok(false)
    }
    fn rows(source: &Path) -> io::Result<Vec<Value>> {
        read(&source.join("accounts/index.json"), json!([]))?
            .as_array()
            .cloned()
            .ok_or_else(|| io::Error::other("旧账号索引无效"))
    }
    fn refreshed(row: &Value, auth: &Value) -> i128 {
        row["lastRefresh"]
            .as_str()
            .or(auth["last_refresh"].as_str())
            .and_then(|s| {
                time::OffsetDateTime::parse(s, &time::format_description::well_known::Rfc3339).ok()
            })
            .map(|t| t.unix_timestamp_nanos())
            .unwrap_or(0)
    }
    fn merge(source: &Path, bridge: &Path, ids: &mut HashSet<String>) -> io::Result<Value> {
        let mut current = rows(bridge)?;
        let mut accounts = 0;
        for row in rows(source)? {
            let id = row["id"]
                .as_str()
                .ok_or_else(|| io::Error::other("旧副本中的账号 ID 无效"))?;
            if id.is_empty()
                || !id
                    .bytes()
                    .all(|c| c.is_ascii_alphanumeric() || c == b'_' || c == b'-')
            {
                return Err(io::Error::other("旧副本中的账号 ID 无效"));
            }
            let from = source.join("accounts").join(id);
            let to = bridge.join("accounts").join(id);
            let auth = read(&from.join("auth.json"), Value::Null)?;
            let previous = read(&to.join("auth.json"), Value::Null)?;
            let old = current.iter().position(|r| r["id"] == id);
            if old.is_some_and(|i| refreshed(&row, &auth) <= refreshed(&current[i], &previous)) {
                continue;
            }
            copy_tree(&from, &to)?;
            ids.insert(id.to_owned());
            if let Some(i) = old {
                current[i] = row;
            } else {
                current.push(row);
            }
            accounts += 1;
        }
        if accounts > 0 {
            write_json(&bridge.join("accounts/index.json"), &json!(current))?;
        }
        let mut store = crate::config_store::load(bridge)?;
        let mut apis = 0;
        for mut provider in crate::config_store::load(source)?["providers"]
            .as_array()
            .unwrap()
            .clone()
        {
            let list = store["providers"].as_array_mut().unwrap();
            if let Some(previous) = list.iter().find(|p| p["id"] == provider["id"]) {
                if *previous == provider {
                    continue;
                }
                let hash = format!(
                    "{:x}",
                    Sha256::digest(format!(
                        "{}\0{}",
                        source.display(),
                        provider["id"].as_str().unwrap()
                    ))
                );
                provider["id"] = json!(&hash[..20]);
                provider["name"] = json!(format!(
                    "{}（来自旧副本）",
                    provider["name"].as_str().unwrap()
                ));
                if list.iter().any(|p| p["id"] == provider["id"]) {
                    continue;
                }
            }
            list.push(provider);
            apis += 1;
        }
        if apis > 0 {
            crate::config_store::save(bridge, &store)?;
        }
        Ok(json!({"path":source,"accounts":accounts,"apis":apis}))
    }
    fn roots() -> io::Result<Vec<PathBuf>> {
        if let Ok(value) = env::var("SWITCHER_TEST_MIGRATION_ROOTS") {
            return serde_json::from_str(&value).map_err(io::Error::other);
        }
        let drives = unsafe { GetLogicalDrives() };
        if drives == 0 {
            return Err(io::Error::last_os_error());
        }
        let mut roots = Vec::new();
        for letter in 0..26 {
            if drives & (1 << letter) == 0 {
                continue;
            }
            let root = format!("{}:\\", char::from(b'A' + letter));
            let wide = root.encode_utf16().chain(Some(0)).collect::<Vec<_>>();
            if unsafe { GetDriveTypeW(wide.as_ptr()) } == 3 {
                roots.push(PathBuf::from(root));
            }
        }
        Ok(roots)
    }
    pub(super) struct Scan {
        pub sources: Vec<PathBuf>,
        pub skipped: u64,
        pub cpu_ms: f64,
    }
    fn scan(install: &Path, bridge: &Path) -> io::Result<Scan> {
        let mut stack = roots()?.into_iter().map(|p| (p, 0)).collect::<Vec<_>>();
        let mut sources = Vec::new();
        let mut skipped = 0;
        let cpu = cpu_ms()?;
        while let Some((directory, depth)) = stack.pop() {
            if directory == bridge {
                continue;
            }
            let entries = match fs::read_dir(&directory) {
                Ok(rows) => rows,
                Err(error)
                    if [io::ErrorKind::NotFound, io::ErrorKind::PermissionDenied]
                        .contains(&error.kind()) =>
                {
                    skipped += 1;
                    continue;
                }
                Err(error) => return Err(error),
            };
            if directory != install
                && directory.join("private/accounts/index.json").is_file()
                && directory.join("package.json").is_file()
                && read(&directory.join("package.json"), Value::Null)?["name"]
                    == "codex-api-switcher"
            {
                sources.push(directory.join("private"));
                continue;
            }
            if depth >= 9 {
                continue;
            }
            let mut entries = entries.collect::<io::Result<Vec<_>>>()?;
            entries.sort_by_key(|e| e.file_name());
            for entry in entries {
                let kind = entry.file_type()?;
                if !kind.is_dir() || entry.metadata()?.file_attributes() & 0x400 != 0 {
                    continue;
                }
                let child = entry.path();
                let name = entry.file_name().to_string_lossy().to_lowercase();
                let normal = child.to_string_lossy().replace('\\', "/").to_lowercase();
                if [
                    "windows",
                    "programdata",
                    "$recycle.bin",
                    "node_modules",
                    ".git",
                ]
                .contains(&name.as_str())
                    || name.starts_with("program files")
                    || normal.ends_with("/appdata/local/temp")
                {
                    skipped += 1;
                    continue;
                }
                stack.push((child, depth + 1));
            }
        }
        Ok(Scan {
            sources,
            skipped,
            cpu_ms: cpu_ms()? - cpu,
        })
    }
    pub(super) fn background_scan(install: &Path, bridge: &Path) -> io::Result<Scan> {
        let thread = unsafe { GetCurrentThread() };
        let previous = unsafe { GetThreadPriority(thread) };
        if unsafe { SetThreadPriority(thread, -1) } == 0 {
            return Err(io::Error::last_os_error());
        }
        let result = scan(install, bridge);
        if unsafe { SetThreadPriority(thread, previous) } == 0 {
            return Err(io::Error::last_os_error());
        }
        result
    }
    async fn run(app: Arc<App>, copied: bool) -> io::Result<()> {
        let started = Instant::now();
        let install = crate::instance::project_root();
        let from = install.clone();
        let bridge = app.bridge.clone();
        let scan = tokio::task::spawn_blocking(move || background_scan(&from, &bridge))
            .await
            .map_err(io::Error::other)??;
        let mut sources = Vec::new();
        let mut ids = HashSet::new();
        let mut cpu = scan.cpu_ms;
        if copied {
            let local = install.join("private");
            let rows = rows(&local)?;
            for row in &rows {
                if let Some(id) = row["id"].as_str() {
                    ids.insert(id.to_owned());
                }
            }
            sources.push(json!({"path":local,"accounts":rows.len(),"apis":crate::config_store::load(&local)?["providers"].as_array().unwrap().len()}));
        }
        for source in scan.sources {
            let _guard = app.accounts.mutation.lock().await;
            let before = cpu_ms()?;
            let result = match merge(&source, &app.bridge, &mut ids) {
                Ok(result) => result,
                Err(error) => crate::diagnostics::redact(
                    &json!({"path":source,"failed":true,"error":error.to_string(),"accounts":0,"apis":0}),
                ),
            };
            sources.push(result);
            cpu += cpu_ms()? - before;
            drop(_guard);
            tokio::task::yield_now().await;
        }
        let apis = sources
            .iter()
            .map(|s| s["apis"].as_u64().unwrap())
            .sum::<u64>();
        let folders = sources
            .iter()
            .filter(|source| source["failed"] != true)
            .count();
        let result = json!({"completed":true,"at":crate::diagnostics::now(),"copiedLocal":copied,"folders":folders,"accounts":ids.len(),"apis":apis,"durationMs":started.elapsed().as_secs_f64()*1000.0,"cpuMs":cpu,"skipped":scan.skipped,"sources":sources});
        write_json(&app.bridge.join("migrated.json"), &result)?;
        crate::diagnostics::log(&app.bridge, "data.migrate", result)
    }
    pub fn start(app: Arc<App>, copied: bool) {
        if !enabled() || app.bridge.join("migrated.json").exists() {
            return;
        }
        tokio::spawn(async move {
            if let Err(error) = run(app.clone(), copied).await
                && let Err(log_error) = crate::diagnostics::log(
                    &app.bridge,
                    "data.migrate",
                    json!({"error":error.to_string()}),
                )
            {
                eprintln!("Migration log failed: {log_error}");
            }
        });
    }
}
