//! Keep the desktop sidebar shared; remove this module and its callers to retire it.
use crate::{config_ops, config_store, diagnostics::log, instance::write_json, server::App};
use serde_json::{Map, Value, json};
use std::{collections::BTreeSet, fs, io};

const KEY: &str = "electron-account-renderer-state-v1";
const ATOMS: &str = "electron-persisted-atom-state";
const PROJECTS: &str = "local-projects";

fn shape(value: &Value) -> bool {
    value.is_object()
        && value
            .get("owner")
            .is_some_and(|v| v.is_null() || v.is_string())
        && value["inactive"].as_object().is_some_and(|rows| {
            rows.values()
                .all(|row| row["atoms"].is_object() && row["globals"].is_object())
        })
}

fn count(value: &Value) -> usize {
    match value {
        Value::Object(rows) => rows.len(),
        Value::Array(rows) => rows.len(),
        _ => 0,
    }
}

fn merge(saved: &Value, current: &Value) -> Value {
    let mut value = saved.clone();
    value["owner"] = current["owner"].clone();
    value["inactive"]
        .as_object_mut()
        .unwrap()
        .extend(current["inactive"].as_object().unwrap().clone());
    value
}

fn desktop_running(app: &App, snapshot: &Value) -> io::Result<bool> {
    let home = crate::platform::display_path(&app.codex_home());
    // A desktop whose home is unknown may be ours; count it, and check both its pids.
    let pids = snapshot["clients"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|c| {
            c["kind"] == "desktop"
                && c["home"]
                    .as_str()
                    .is_none_or(|p| crate::editors::same(p, &home))
        })
        .flat_map(|c| [c["pid"].as_u64(), c["desktopPid"].as_u64()])
        .flatten()
        .map(|pid| pid as u32)
        .collect::<BTreeSet<_>>();
    for pid in pids {
        if crate::platform::running(pid)? {
            return Ok(true);
        }
    }
    Ok(false)
}

fn skipped(app: &App, reason: &str) -> io::Result<Value> {
    let result = json!({"skipped":reason});
    log(&app.bridge, "desktop.sidebar", result.clone())?;
    Ok(result)
}

fn pending(app: &App, value: bool) -> io::Result<()> {
    let file = app.bridge.join("settings.json");
    let mut settings = config_store::read_json(&file)?;
    if settings.is_null() {
        settings = json!({});
    }
    settings["desktopSidebarPending"] = json!(value);
    write_json(&file, &settings)
}

fn state(app: &App) -> io::Result<Option<(String, Value)>> {
    let file = app.codex_home().join(".codex-global-state.json");
    config_ops::read(&file)?
        .map(|text| {
            let value = serde_json::from_str(&text).map_err(io::Error::other)?;
            Ok((text, value))
        })
        .transpose()
}

fn write_state(app: &App, previous: Option<&str>, value: &Value) -> io::Result<()> {
    let file = app.codex_home().join(".codex-global-state.json");
    let next = serde_json::to_string_pretty(value).map_err(io::Error::other)?;
    config_ops::atomic(&file, &next, Some(previous))?;
    let backup = app.codex_home().join(".codex-global-state.json.bak");
    let old_backup = config_ops::read(&backup)?;
    config_ops::atomic(&backup, &next, Some(old_backup.as_deref()))
}

/// Use the pre-release snapshot, but check its desktop PIDs after release.
pub fn share(app: &App, latest: &Value) -> io::Result<Value> {
    if config_store::read_json(&app.bridge.join("settings.json"))?["desktopSharedSidebar"] == false
    {
        return restore_snapshot(app, latest);
    }
    if desktop_running(app, latest)? {
        return skipped(app, "desktop_running");
    }
    let Some((text, mut current)) = state(app)? else {
        return Ok(json!({}));
    };
    let Some(key) = current.get(KEY) else {
        return Ok(json!({}));
    };
    if !shape(key) {
        return skipped(app, "unknown_shape");
    }
    let archive = app.bridge.join("desktop-sidebar.json");
    let saved = config_store::read_json(&archive)?;
    if !saved.is_null() && !shape(&saved) {
        return skipped(app, "unknown_shape");
    }
    let stored = if saved.is_null() {
        key.clone()
    } else {
        merge(&saved, key)
    };
    let mut selected = 0;
    if count(&current[PROJECTS]) == 0 {
        let best = stored["inactive"]
            .as_object()
            .unwrap()
            .values()
            .max_by_key(|row| count(&row["globals"][PROJECTS]));
        if let Some(best) = best.filter(|row| count(&row["globals"][PROJECTS]) > 0) {
            selected = count(&best["globals"][PROJECTS]);
            for (name, value) in best["globals"].as_object().unwrap() {
                current[name] = value.clone();
            }
            let mut atoms = best["atoms"].as_object().unwrap().clone();
            if let Some(top) = current[ATOMS].as_object() {
                atoms.extend(top.clone());
            }
            current[ATOMS] = Value::Object(atoms);
        }
    }
    write_json(&archive, &stored)?;
    current.as_object_mut().unwrap().remove(KEY);
    write_state(app, Some(&text), &current)?;
    let result = json!({"ownerNull":stored["owner"].is_null(),"selectedProjects":selected,
        "inactiveCount":stored["inactive"].as_object().unwrap().len()});
    log(&app.bridge, "desktop.sidebar", result.clone())?;
    Ok(result)
}

fn restore_snapshot(app: &App, snapshot: &Value) -> io::Result<Value> {
    let archive = app.bridge.join("desktop-sidebar.json");
    if !archive.exists() {
        return Ok(json!({}));
    }
    if desktop_running(app, snapshot)? {
        pending(app, true)?;
        let result = json!({"pending":true,"message":"Codex 桌面端还在运行，下次切换来源时自动生效"});
        log(
            &app.bridge,
            "desktop.sidebar",
            json!({"skipped":"desktop_running","pending":true}),
        )?;
        return Ok(result);
    }
    let saved = config_store::read_json(&archive)?;
    if !shape(&saved) {
        return skipped(app, "unknown_shape");
    }
    let loaded = state(app)?;
    let (previous, mut current) = match loaded {
        Some((text, value)) => (Some(text), value),
        None => (None, json!({})),
    };
    if !current.is_object() || current.get(KEY).is_some_and(|key| !shape(key)) {
        return skipped(app, "unknown_shape");
    }
    let mut restored = current
        .get(KEY)
        .map_or_else(|| saved.clone(), |key| merge(&saved, key));
    if restored["owner"].is_null() && count(&current[PROJECTS]) > 0 {
        let names = restored["inactive"]
            .as_object()
            .unwrap()
            .values()
            .flat_map(|row| row["globals"].as_object().unwrap().keys().cloned())
            .collect::<BTreeSet<_>>();
        if names.is_empty() {
            log(
                &app.bridge,
                "desktop.sidebar",
                json!({"skipped":"shared_backup_keys_unavailable"}),
            )?;
        } else {
            let globals = names
                .into_iter()
                .filter_map(|name| current.get(&name).map(|value| (name, value.clone())))
                .collect::<Map<_, _>>();
            restored["inactive"]["codex-switcher-shared"] = json!({
                "atoms":current[ATOMS].as_object().cloned().unwrap_or_default(),"globals":globals});
        }
    }
    current[KEY] = restored;
    write_state(app, previous.as_deref(), &current)?;
    fs::remove_file(&archive)
        .map_err(|e| crate::instance::file_error(e, "删除", &archive, None))?;
    pending(app, false)?;
    log(
        &app.bridge,
        "desktop.sidebar",
        json!({"restored":true,"ownerNull":current[KEY]["owner"].is_null()}),
    )?;
    Ok(json!({"pending":false,"message":"已恢复桌面端原有的账号侧边栏规则"}))
}

pub async fn restore(app: &App) -> io::Result<Value> {
    if !app.bridge.join("desktop-sidebar.json").exists() {
        return Ok(json!({}));
    }
    let snapshot = crate::editors::status(app).await?;
    restore_snapshot(app, &snapshot)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        collections::HashMap,
        sync::{Mutex, atomic::AtomicBool},
        time::Instant,
    };

    struct Fixture {
        app: App,
        root: std::path::PathBuf,
    }
    impl Fixture {
        fn new() -> Self {
            let root = std::env::temp_dir().join(format!(
                "desktop-sidebar-{}",
                crate::editors::uuid().unwrap()
            ));
            let home = root.join("home");
            let bridge = root.join("bridge");
            fs::create_dir_all(&home).unwrap();
            fs::create_dir_all(&bridge).unwrap();
            Self {
                app: App {
                    home,
                    bridge: bridge.clone(),
                    web: root.join("web"),
                    token: String::new(),
                    port: 0,
                    protection: crate::platform::DataProtection {
                        ok: true,
                        path: bridge,
                        error: None,
                    },
                    first_request: AtomicBool::new(false),
                    ready_at: Instant::now(),
                    downloads: Mutex::new(HashMap::new()),
                    accounts: crate::accounts::Runtime::default(),
                    editors: crate::editors::Runtime::default(),
                    updates: crate::update::Runtime::default(),
                },
                root,
            }
        }
        fn put(&self, value: &Value) {
            write_json(&self.app.home.join(".codex-global-state.json"), value).unwrap();
        }
        fn read(&self) -> Value {
            config_store::read_json(&self.app.home.join(".codex-global-state.json")).unwrap()
        }
        fn same_backup(&self) {
            assert_eq!(
                fs::read(self.app.home.join(".codex-global-state.json")).unwrap(),
                fs::read(self.app.home.join(".codex-global-state.json.bak")).unwrap()
            );
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            fs::remove_dir_all(&self.root).unwrap();
        }
    }
    fn bank(n: usize) -> Value {
        json!({"atoms":{"a":"archived","b":"archived"},"globals":{PROJECTS:(0..n).map(|i| json!({"id":i})).collect::<Vec<_>>(),"project-order":[1,2]}})
    }
    fn key() -> Value {
        json!({"owner":null,"inactive":{"a":bank(2),"b":bank(14)}})
    }

    #[test]
    fn nonempty_top_stays_and_live_desktop_skips() {
        let f = Fixture::new();
        let value = json!({KEY:key(),PROJECTS:{"project":{"id":1}},ATOMS:{"a":"top"},"other":1});
        f.put(&value);
        let snapshot = json!({"clients":[{"kind":"desktop","home":crate::platform::display_path(&f.app.home),"desktopPid":std::process::id()}]});
        assert_eq!(
            share(&f.app, &snapshot).unwrap()["skipped"],
            "desktop_running"
        );
        assert_eq!(f.read(), value);
        share(&f.app, &json!({})).unwrap();
        assert_eq!(
            config_store::read_json(&f.app.bridge.join("desktop-sidebar.json")).unwrap(),
            key()
        );
        let mut expected = value;
        expected.as_object_mut().unwrap().remove(KEY);
        assert_eq!(f.read(), expected);
        f.same_backup();
    }
    #[test]
    fn empty_top_uses_merged_largest_and_top_atoms_win() {
        let f = Fixture::new();
        write_json(&f.app.bridge.join("desktop-sidebar.json"), &key()).unwrap();
        f.put(&json!({KEY:{"owner":"current","inactive":{"a":bank(3)}},PROJECTS:[],ATOMS:{"a":"top"}}));
        let result = share(&f.app, &json!({})).unwrap();
        assert_eq!(result["selectedProjects"], 14);
        let current = f.read();
        assert_eq!(count(&current[PROJECTS]), 14);
        assert_eq!(current[ATOMS]["a"], "top");
        assert_eq!(current[ATOMS]["b"], "archived");
        let archive = config_store::read_json(&f.app.bridge.join("desktop-sidebar.json")).unwrap();
        assert_eq!(archive["owner"], "current");
        assert_eq!(count(&archive["inactive"]["a"]["globals"][PROJECTS]), 3);
        f.same_backup();
    }
    #[test]
    fn unknown_shape_keeps_all_bytes() {
        let f = Fixture::new();
        let file = f.app.home.join(".codex-global-state.json");
        let bytes=b"{\n \"electron-account-renderer-state-v1\": {\"owner\":null,\"inactive\":{\"a\":{\"atoms\":{}}}}\n}";
        fs::write(&file, bytes).unwrap();
        assert_eq!(
            share(&f.app, &json!({})).unwrap()["skipped"],
            "unknown_shape"
        );
        assert_eq!(fs::read(file).unwrap(), bytes);
        assert!(!f.app.bridge.join("desktop-sidebar.json").exists());
    }
    #[test]
    fn restore_null_owner_backs_up_shared_and_removes_archive() {
        let f = Fixture::new();
        write_json(&f.app.bridge.join("desktop-sidebar.json"), &key()).unwrap();
        f.put(&json!({PROJECTS:{"p":{}},ATOMS:{"a":"top"},"project-order":["p"],"unrelated":true}));
        let snapshot = json!({"clients":[{"kind":"desktop","home":crate::platform::display_path(&f.app.home),"desktopPid":std::process::id()}]});
        assert_eq!(
            restore_snapshot(&f.app, &snapshot).unwrap()["pending"],
            true
        );
        assert!(f.app.bridge.join("desktop-sidebar.json").exists());
        restore_snapshot(&f.app, &json!({})).unwrap();
        let current = f.read();
        assert!(current[KEY]["owner"].is_null());
        let shared = &current[KEY]["inactive"]["codex-switcher-shared"];
        assert_eq!(shared["atoms"], current[ATOMS]);
        assert_eq!(shared["globals"][PROJECTS], current[PROJECTS]);
        assert!(shared["globals"].get("unrelated").is_none());
        assert!(!f.app.bridge.join("desktop-sidebar.json").exists());
        assert_eq!(
            config_store::read_json(&f.app.bridge.join("settings.json")).unwrap()["desktopSidebarPending"],
            false
        );
        f.same_backup();
    }
}
