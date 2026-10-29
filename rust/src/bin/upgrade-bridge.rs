//! The seq136 updater launches runtime/node with main.cjs. This short-lived
//! entry point hands that invocation to the native service, without a Node VM.
use std::{
    env,
    io::{self, Write},
    path::PathBuf,
    process::Command,
};

fn ready() -> io::Result<()> {
    let fd: i32 = env::var("NODE_CHANNEL_FD")
        .map_err(io::Error::other)?
        .parse()
        .map_err(io::Error::other)?;
    #[cfg(windows)]
    let mut pipe = {
        use std::os::windows::io::FromRawHandle;
        unsafe extern "C" {
            fn _get_osfhandle(fd: i32) -> isize;
        }
        let handle = unsafe { _get_osfhandle(fd) };
        if handle == -1 {
            return Err(io::Error::last_os_error());
        }
        unsafe { std::fs::File::from_raw_handle(handle as *mut std::ffi::c_void) }
    };
    #[cfg(unix)]
    let mut pipe = {
        use std::os::fd::FromRawFd;
        unsafe { std::fs::File::from_raw_fd(fd) }
    };
    let message = b"{\"ready\":true}\n";
    #[cfg(windows)]
    {
        // libuv's Windows IPC pipe wraps JSON bytes in a 16-byte data frame.
        let mut header = [0u8; 16];
        header[..4].copy_from_slice(&1u32.to_le_bytes());
        header[8..12].copy_from_slice(&(message.len() as u32).to_le_bytes());
        pipe.write_all(&header)?;
    }
    pipe.write_all(message)?;
    pipe.flush()
}

fn main() -> io::Result<()> {
    let exe = env::current_exe()?;
    let root: PathBuf = if cfg!(windows) {
        exe.parent().unwrap().parent().unwrap().into()
    } else {
        exe.parent()
            .unwrap()
            .parent()
            .unwrap()
            .parent()
            .unwrap()
            .into()
    };
    let mut args = env::args_os().skip(1);
    let entry = args
        .next()
        .ok_or_else(|| io::Error::other("Legacy launch entry required"))?;
    if std::path::Path::new(&entry)
        .file_name()
        .is_some_and(|name| name == "update-worker.cjs")
    {
        use std::io::BufRead;
        let job = args
            .next()
            .ok_or_else(|| io::Error::other("Update job required"))?;
        let mut child = Command::new(root.join(if cfg!(windows) {
            "codex-switcher.exe"
        } else {
            "codex-switcher"
        }))
        .arg("--update-worker")
        .arg(job)
        .stdout(std::process::Stdio::piped())
        .spawn()?;
        let mut line = String::new();
        io::BufReader::new(child.stdout.take().unwrap()).read_line(&mut line)?;
        if line.trim() != "READY" {
            return Err(io::Error::other("Native update worker did not start"));
        }
        ready()?;
        let status = child.wait()?;
        std::process::exit(status.code().unwrap_or(1));
    }
    if std::path::Path::new(&entry)
        .file_name()
        .is_none_or(|name| name != "main.cjs")
    {
        return Err(io::Error::other(
            "Only the legacy main.cjs launch is supported",
        ));
    }
    let mut command = Command::new(root.join(if cfg!(windows) {
        "codex-switcher.exe"
    } else {
        "codex-switcher"
    }));
    command.args(args);
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        Err(command.exec())
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
        // The legacy updater owns this PID until its health check finishes.
        // Keep the handle open while the actual native service is running.
        let status = command.status()?;
        std::process::exit(status.code().unwrap_or(1));
    }
}
