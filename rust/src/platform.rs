//! Platform interfaces; native Windows prototype, Mac migration pending.
#[cfg(not(windows))] use std::io;
#[cfg(not(windows))] use serde_json::Value;
#[cfg(windows)]
mod windows {
use std::{io,mem};
use serde_json::{json,Value};
type Handle = *mut std::ffi::c_void;
#[repr(C)]
struct ProcessEntry { size:u32, usage:u32, pid:u32, heap:usize, module:u32, threads:u32, parent:u32, priority:i32, flags:u32, exe:[u16;260] }
#[repr(C)]
struct TcpRow { state:u32, address:u32, port:u32, remote_address:u32, remote_port:u32, pid:u32 }
#[link(name="kernel32")]
unsafe extern "system" {
    fn CreateToolhelp32Snapshot(flags:u32,pid:u32)->Handle;
    fn Process32FirstW(snapshot:Handle,entry:*mut ProcessEntry)->i32;
    fn Process32NextW(snapshot:Handle,entry:*mut ProcessEntry)->i32;
    fn CloseHandle(handle:Handle)->i32;
}
#[link(name="iphlpapi")]
unsafe extern "system" { fn GetExtendedTcpTable(table:*mut std::ffi::c_void,len:*mut u32,sort:i32,family:u32,class:i32,reserved:u32)->u32; }
#[link(name="bcrypt")]
unsafe extern "system" { fn BCryptGenRandom(algorithm:Handle,buffer:*mut u8,len:u32,flags:u32)->i32; }

pub fn port_pid(port: u16) -> io::Result<Option<u32>> {
    let mut len=0;
    unsafe { GetExtendedTcpTable(std::ptr::null_mut(), &mut len, 0, 2, 3, 0); }
    let mut buffer=vec![0u64; (len as usize).div_ceil(8)];
    let status=unsafe{GetExtendedTcpTable(buffer.as_mut_ptr().cast(), &mut len, 0, 2, 3, 0)};
    if status!=0{return Err(io::Error::from_raw_os_error(status as i32))}
    let count=unsafe{*(buffer.as_ptr() as *const u32)};
    let rows=unsafe{std::slice::from_raw_parts(buffer.as_ptr().cast::<u8>().add(4).cast::<TcpRow>(),count as usize)};
    Ok(rows.iter().find(|r| u16::from_be(r.port as u16)==port).map(|r|r.pid))
}
pub fn processes() -> io::Result<Value> {
    let snapshot=unsafe{CreateToolhelp32Snapshot(2,0)};
    if snapshot==(-1isize as Handle){return Err(io::Error::last_os_error())}
    let mut row:ProcessEntry=unsafe{mem::zeroed()}; row.size=mem::size_of::<ProcessEntry>() as u32;
    let mut codex=0;let mut code=0;let mut total=0;
    let mut ok=unsafe{Process32FirstW(snapshot,&mut row)};
    while ok!=0 {
        total+=1;
        let end=row.exe.iter().position(|x|*x==0).unwrap_or(row.exe.len());
        let name=String::from_utf16_lossy(&row.exe[..end]);
        if name.eq_ignore_ascii_case("codex.exe"){codex+=1}
        if name.eq_ignore_ascii_case("Code.exe"){code+=1}
        ok=unsafe{Process32NextW(snapshot,&mut row)};
    }
    unsafe{CloseHandle(snapshot)};
    Ok(json!({"codex":codex,"code":code,"total":total}))
}

pub fn random_bytes()->io::Result<[u8;32]>{
 let mut random=[0u8;32];
 let code=unsafe{BCryptGenRandom(std::ptr::null_mut(),random.as_mut_ptr(),32,2)};
 if code<0{return Err(io::Error::other(format!("BCryptGenRandom failed {code}")))}
 Ok(random)
}
}
#[cfg(windows)] pub use windows::{port_pid,processes,random_bytes};
#[cfg(not(windows))]
pub fn port_pid(_port:u16)->io::Result<Option<u32>>{Err(io::Error::new(io::ErrorKind::Unsupported,"Mac port lookup pending batch 1"))}
#[cfg(not(windows))]
pub fn processes()->io::Result<Value>{Err(io::Error::new(io::ErrorKind::Unsupported,"Mac process scan pending batch 1"))}
#[cfg(not(windows))]
pub fn random_bytes()->io::Result<[u8;32]>{
 use std::io::Read;
 let mut bytes=[0u8;32];std::fs::File::open("/dev/urandom")?.read_exact(&mut bytes)?;Ok(bytes)
}
