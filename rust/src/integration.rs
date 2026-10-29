//! OS integration. Tests supply a temporary Startup directory; desktop/registry
//! registration is only invoked for a packaged positive release sequence.
use std::{
    env, fs, io,
    path::{Path, PathBuf},
};
#[cfg(windows)]
mod windows {
    use super::*;
    use std::ffi::c_void;
    type Handle = *mut c_void;
    #[repr(C)]
    struct Guid {
        a: u32,
        b: u16,
        c: u16,
        d: [u8; 8],
    }
    #[repr(C)]
    struct Object {
        table: *const *const c_void,
    }
    #[link(name = "ole32")]
    unsafe extern "system" {
        fn CoInitializeEx(reserved: Handle, mode: u32) -> i32;
        fn CoUninitialize();
        fn CoCreateInstance(
            class: *const Guid,
            outer: Handle,
            context: u32,
            iid: *const Guid,
            object: *mut *mut Object,
        ) -> i32;
    }
    #[link(name = "advapi32")]
    unsafe extern "system" {
        fn RegCreateKeyExW(
            root: Handle,
            key: *const u16,
            reserved: u32,
            class: *mut u16,
            options: u32,
            access: u32,
            security: Handle,
            result: *mut Handle,
            disposition: *mut u32,
        ) -> i32;
        fn RegSetValueExW(
            key: Handle,
            name: *const u16,
            reserved: u32,
            kind: u32,
            data: *const u8,
            length: u32,
        ) -> i32;
        fn RegCloseKey(key: Handle) -> i32;
    }
    fn wide(text: &str) -> Vec<u16> {
        text.encode_utf16().chain(Some(0)).collect()
    }
    unsafe fn release(object: *mut Object) {
        let function: unsafe extern "system" fn(*mut Object) -> u32 =
            unsafe { std::mem::transmute(*(*object).table.add(2)) };
        unsafe {
            function(object);
        }
    }
    fn check(code: i32) -> io::Result<()> {
        if code < 0 {
            Err(io::Error::other(format!("COM failed {code:#x}")))
        } else {
            Ok(())
        }
    }
    pub fn shortcut(file: &Path, exe: &Path, arguments: &str) -> io::Result<()> {
        let initialized = unsafe { CoInitializeEx(std::ptr::null_mut(), 2) };
        check(initialized)?;
        let class = Guid {
            a: 0x21401,
            b: 0,
            c: 0,
            d: [0xc0, 0, 0, 0, 0, 0, 0, 0x46],
        };
        let iid = Guid {
            a: 0x214f9,
            b: 0,
            c: 0,
            d: [0xc0, 0, 0, 0, 0, 0, 0, 0x46],
        };
        let persist_iid = Guid {
            a: 0x10b,
            b: 0,
            c: 0,
            d: [0xc0, 0, 0, 0, 0, 0, 0, 0x46],
        };
        let mut object = std::ptr::null_mut();
        if let Err(error) =
            check(unsafe { CoCreateInstance(&class, std::ptr::null_mut(), 1, &iid, &mut object) })
        {
            unsafe {
                CoUninitialize();
            }
            return Err(error);
        }
        let result = (|| -> io::Result<()> {
            for (index, text) in [
                (20, crate::platform::display_path(exe)),
                (11, arguments.into()),
                (9, exe.parent().unwrap().to_string_lossy().to_string()),
                (7, "Codex API Switcher".into()),
            ] {
                let function: unsafe extern "system" fn(*mut Object, *const u16) -> i32 =
                    unsafe { std::mem::transmute(*(*object).table.add(index)) };
                check(unsafe { function(object, wide(&text).as_ptr()) })?;
            }
            let mut persist = std::ptr::null_mut();
            let query: unsafe extern "system" fn(
                *mut Object,
                *const Guid,
                *mut *mut Object,
            ) -> i32 = unsafe { std::mem::transmute(*(*object).table) };
            check(unsafe { query(object, &persist_iid, &mut persist) })?;
            let save: unsafe extern "system" fn(*mut Object, *const u16, i32) -> i32 =
                unsafe { std::mem::transmute(*(*persist).table.add(6)) };
            let result = check(unsafe { save(persist, wide(&file.to_string_lossy()).as_ptr(), 1) });
            unsafe {
                release(persist);
            }
            result
        })();
        unsafe {
            release(object);
            CoUninitialize();
        }
        result
    }
    pub fn register(exe: &Path) -> io::Result<()> {
        if let Some(root) = env::var_os("SWITCHER_TEST_SHELL_ROOT") {
            let root = PathBuf::from(root);
            fs::create_dir_all(&root)?;
            return crate::instance::write_json(
                &root.join("registration.json"),
                &serde_json::json!({
                    "InstallLocation": exe.parent(), "DisplayIcon":format!("{},0",crate::platform::display_path(exe)),
                    "UninstallString":format!("powershell -NoProfile -ExecutionPolicy Bypass -File \"{}\" -KeepData",crate::platform::display_path(&exe.parent().unwrap().join("uninstall.ps1")))
                }),
            );
        }
        let mut key = std::ptr::null_mut();
        let root = 0x80000001u32 as i32 as isize as Handle;
        let path = wide(r"Software\Microsoft\Windows\CurrentVersion\Uninstall\CodexSwitcher");
        let status = unsafe {
            RegCreateKeyExW(
                root,
                path.as_ptr(),
                0,
                std::ptr::null_mut(),
                0,
                2,
                std::ptr::null_mut(),
                &mut key,
                std::ptr::null_mut(),
            )
        };
        if status != 0 {
            return Err(io::Error::from_raw_os_error(status));
        }
        let mut result = Ok(());
        for (name, value) in [
            ("DisplayName", "Codex API Switcher".to_string()),
            (
                "DisplayVersion",
                crate::instance::runtime()["version"]
                    .as_str()
                    .unwrap()
                    .into(),
            ),
            ("Publisher", "Codex Switcher".into()),
            (
                "InstallLocation",
                exe.parent().unwrap().to_string_lossy().to_string(),
            ),
            (
                "UninstallString",
                format!(
                    "powershell -NoProfile -ExecutionPolicy Bypass -File \"{}\" -KeepData",
                    crate::platform::display_path(&exe.parent().unwrap().join("uninstall.ps1"))
                ),
            ),
            (
                "DisplayIcon",
                format!("{},0", crate::platform::display_path(exe)),
            ),
        ] {
            let value = wide(&value);
            let status = unsafe {
                RegSetValueExW(
                    key,
                    wide(name).as_ptr(),
                    0,
                    1,
                    value.as_ptr().cast(),
                    (value.len() * 2) as u32,
                )
            };
            if status != 0 {
                result = Err(io::Error::from_raw_os_error(status));
                break;
            }
        }
        if result.is_ok() {
            for name in ["NoModify", "NoRepair"] {
                let value = 1u32;
                let status = unsafe {
                    RegSetValueExW(
                        key,
                        wide(name).as_ptr(),
                        0,
                        4,
                        (&value as *const u32).cast(),
                        4,
                    )
                };
                if status != 0 {
                    result = Err(io::Error::from_raw_os_error(status));
                    break;
                }
            }
        }
        unsafe {
            RegCloseKey(key);
        }
        result
    }
    pub fn shortcut_directory(file: &Path) -> io::Result<PathBuf> {
        let initialized = unsafe { CoInitializeEx(std::ptr::null_mut(), 2) };
        check(initialized)?;
        let class = Guid {
            a: 0x21401,
            b: 0,
            c: 0,
            d: [0xc0, 0, 0, 0, 0, 0, 0, 0x46],
        };
        let iid = Guid {
            a: 0x214f9,
            b: 0,
            c: 0,
            d: [0xc0, 0, 0, 0, 0, 0, 0, 0x46],
        };
        let persist_iid = Guid {
            a: 0x10b,
            b: 0,
            c: 0,
            d: [0xc0, 0, 0, 0, 0, 0, 0, 0x46],
        };
        let mut object = std::ptr::null_mut();
        if let Err(error) =
            check(unsafe { CoCreateInstance(&class, std::ptr::null_mut(), 1, &iid, &mut object) })
        {
            unsafe {
                CoUninitialize();
            }
            return Err(error);
        }
        let result = (|| -> io::Result<PathBuf> {
            let mut persist = std::ptr::null_mut();
            let query: unsafe extern "system" fn(
                *mut Object,
                *const Guid,
                *mut *mut Object,
            ) -> i32 = unsafe { std::mem::transmute(*(*object).table) };
            check(unsafe { query(object, &persist_iid, &mut persist) })?;
            let load: unsafe extern "system" fn(*mut Object, *const u16, u32) -> i32 =
                unsafe { std::mem::transmute(*(*persist).table.add(5)) };
            let loaded = check(unsafe { load(persist, wide(&file.to_string_lossy()).as_ptr(), 0) });
            unsafe {
                release(persist);
            }
            loaded?;
            let get: unsafe extern "system" fn(*mut Object, *mut u16, i32) -> i32 =
                unsafe { std::mem::transmute(*(*object).table.add(8)) };
            let mut value = vec![0u16; 32768];
            check(unsafe { get(object, value.as_mut_ptr(), value.len() as i32) })?;
            let length = value.iter().position(|v| *v == 0).unwrap_or(value.len());
            Ok(PathBuf::from(String::from_utf16_lossy(&value[..length])))
        })();
        unsafe {
            release(object);
            CoUninitialize();
        }
        result
    }
}
pub fn startup_file() -> PathBuf {
    let directory = env::var_os("BRIDGE_STARTUP_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            if cfg!(windows) {
                env::var_os("APPDATA")
                    .map(PathBuf::from)
                    .unwrap_or_else(|| crate::platform::user_home().join("AppData/Roaming"))
                    .join("Microsoft/Windows/Start Menu/Programs/Startup")
            } else {
                crate::platform::user_home().join("Library/LaunchAgents")
            }
        });
    if cfg!(windows) {
        let legacy = directory.join("Codex API 切换器服务.lnk");
        if legacy.exists() {
            legacy
        } else {
            directory.join("Codex API Switcher Service.lnk")
        }
    } else {
        directory.join("com.codex-switcher.demo.plist")
    }
}
pub fn autostart(enabled: bool, bridge: &Path) -> io::Result<serde_json::Value> {
    let file = startup_file();
    if enabled {
        fs::create_dir_all(file.parent().unwrap())?;
        let exe = env::current_exe()?;
        #[cfg(windows)]
        windows::shortcut(&file, &exe, "--no-open")?;
        #[cfg(not(windows))]
        {
            let escape = |text: &str| {
                text.replace('&', "&amp;")
                    .replace('<', "&lt;")
                    .replace('>', "&gt;")
                    .replace('"', "&quot;")
            };
            fs::write(
                &file,
                format!(
                    "<?xml version=\"1.0\" encoding=\"UTF-8\"?><plist version=\"1.0\"><dict><key>Label</key><string>com.codex-switcher.demo</string><key>ProgramArguments</key><array><string>{}</string><string>--no-open</string></array><key>RunAtLoad</key><true/><key>StandardOutPath</key><string>{}</string><key>StandardErrorPath</key><string>{}</string></dict></plist>",
                    escape(&exe.to_string_lossy()),
                    escape(&bridge.join("service.log").to_string_lossy()),
                    escape(&bridge.join("service-error.log").to_string_lossy())
                ),
            )?;
        }
    } else if file.exists() {
        fs::remove_file(file)?;
    }
    let adapter_file = bridge.join("adapter.json");
    let mut adapter: serde_json::Value = if adapter_file.exists() {
        serde_json::from_slice(&fs::read(&adapter_file)?).map_err(io::Error::other)?
    } else {
        serde_json::json!({})
    };
    adapter["autostartDecided"] = serde_json::json!(true);
    crate::instance::write_json(&adapter_file, &adapter)?;
    Ok(
        serde_json::json!({"message":if enabled{"已开启：登录 Windows 后自动在后台启动转换服务。"}else{"已关闭开机自启。"}}),
    )
}
pub fn desktop(discovery: &Path, sequence: u64) -> io::Result<()> {
    #[cfg(windows)]
    {
        let marker = discovery.join("shortcut.json");
        let prior: serde_json::Value = if marker.exists() {
            serde_json::from_slice(&fs::read(&marker)?).map_err(io::Error::other)?
        } else {
            serde_json::Value::Null
        };
        if prior["sequence"].as_u64().unwrap_or(0) > sequence {
            return Ok(());
        }
        let exe = env::current_exe()?;
        // Desktop resolution is performed by the shell known-folder API.
        #[repr(C)]
        struct Guid {
            a: u32,
            b: u16,
            c: u16,
            d: [u8; 8],
        }
        #[link(name = "shell32")]
        unsafe extern "system" {
            fn SHGetKnownFolderPath(
                id: *const Guid,
                flags: u32,
                token: *mut std::ffi::c_void,
                path: *mut *mut u16,
            ) -> i32;
        }
        #[link(name = "ole32")]
        unsafe extern "system" {
            fn CoTaskMemFree(memory: *mut std::ffi::c_void);
        }
        let id = Guid {
            a: 0xb4bfcc3a,
            b: 0xdb2c,
            c: 0x424c,
            d: [0xb0, 0x29, 0x7f, 0xe9, 0x9a, 0x87, 0xc6, 0x41],
        };
        let directory_path = if let Some(root) = env::var_os("SWITCHER_TEST_SHELL_ROOT") {
            let path = PathBuf::from(root).join("Desktop");
            fs::create_dir_all(&path)?;
            path
        } else {
            let mut directory = std::ptr::null_mut();
            let status =
                unsafe { SHGetKnownFolderPath(&id, 0, std::ptr::null_mut(), &mut directory) };
            if status < 0 {
                return Err(io::Error::other("Desktop folder unavailable"));
            }
            let mut length = 0;
            while unsafe { *directory.add(length) } != 0 {
                length += 1;
            }
            let directory_path = PathBuf::from(String::from_utf16_lossy(unsafe {
                std::slice::from_raw_parts(directory, length)
            }));
            unsafe {
                CoTaskMemFree(directory.cast());
            }
            directory_path
        };
        let link = directory_path.join("Codex API Switcher.lnk");
        if link.exists() {
            let old = windows::shortcut_directory(&link)?;
            let release: serde_json::Value = fs::read(old.join("src/platform/release-info.json"))
                .ok()
                .and_then(|bytes| serde_json::from_slice(&bytes).ok())
                .unwrap_or(serde_json::Value::Null);
            if release["sequence"].as_u64().unwrap_or(0) > sequence {
                return Ok(());
            }
        }
        if link.exists() || prior["created"] != true {
            windows::shortcut(&link, &exe, "")?;
        }
        windows::register(&exe)?;
        crate::instance::write_json(
            &marker,
            &serde_json::json!({"created":true,"target":exe.parent(),"sequence":sequence}),
        )?;
    }
    #[cfg(not(windows))]
    let _ = (discovery, sequence);
    Ok(())
}
