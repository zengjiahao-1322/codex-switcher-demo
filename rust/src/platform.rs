//! Windows and macOS process, path, permissions and proxy interfaces.
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
    fn GetCurrentProcess()->Handle;
    fn LocalFree(memory:Handle)->Handle;
    fn OpenProcess(access:u32,inherit:i32,pid:u32)->Handle;
    fn QueryFullProcessImageNameW(process:Handle,flags:u32,path:*mut u16,length:*mut u32)->i32;
    fn TerminateProcess(process:Handle,code:u32)->i32;
    fn GetExitCodeProcess(process:Handle,code:*mut u32)->i32;
    fn ReadProcessMemory(process:Handle,address:*const std::ffi::c_void,buffer:Handle,count:usize,read:*mut usize)->i32;
    fn IsWow64Process(process:Handle,wow:*mut i32)->i32;
}
#[link(name="shell32")]
unsafe extern "system" {fn CommandLineToArgvW(command:*const u16,count:*mut i32)->*mut *mut u16;}
fn read_memory(handle:Handle,address:usize,count:usize)->io::Result<Vec<u8>> {
    let mut bytes=vec![0u8;count];let mut read=0;
    unsafe{ReadProcessMemory(handle,address as *const _,bytes.as_mut_ptr().cast(),count,&mut read);}
    if read==0{return Err(io::Error::other("process_memory_unavailable"))}bytes.truncate(read);Ok(bytes)
}
fn pointer(handle:Handle,address:usize)->io::Result<usize>{
    let bytes=read_memory(handle,address,8)?;
    Ok(u64::from_le_bytes(bytes.try_into().map_err(|_|io::Error::other("process_pointer_unavailable"))?) as usize)
}
fn unicode(handle:Handle,address:usize)->io::Result<String>{
    let bytes=read_memory(handle,address,16)?;
    if bytes.len()<16{return Err(io::Error::other("process_unicode_unavailable"))}
    let length=u16::from_le_bytes([bytes[0],bytes[1]]) as usize;
    if length==0{return Ok(String::new())}
    let address=u64::from_le_bytes(bytes[8..16].try_into().unwrap()) as usize;
    let bytes=read_memory(handle,address,length)?;
    Ok(String::from_utf16_lossy(&bytes.chunks_exact(2).map(|pair|u16::from_le_bytes([pair[0],pair[1]])).collect::<Vec<_>>()))
}
pub fn context(pid:u32)->Value{
    let handle=unsafe{OpenProcess(0x410,0,pid)};if handle.is_null(){return json!({"ok":false,"error":"process_access_denied_or_exited"})}
    let result=(||->io::Result<Value>{
        let mut wow=0;if unsafe{IsWow64Process(handle,&mut wow)}==0||wow!=0{return Err(io::Error::other("unsupported_process_architecture"))}
        let mut info=[0usize;6];let mut used=0;
        if unsafe{NtQueryInformationProcess(handle,0,info.as_mut_ptr().cast(),48,&mut used)}!=0{return Err(io::Error::other("process_query_failed"))}
        let parameters=pointer(handle,info[1]+0x20)?;
        let environment=pointer(handle,parameters+0x80)?;
        let cwd=unicode(handle,parameters+0x38)?;let command=unicode(handle,parameters+0x70)?;
        let mut bytes=Vec::new();let mut complete=false;
        while bytes.len()<262144&&!complete{
            let chunk=read_memory(handle,environment+bytes.len(),4096)?;
            bytes.extend(chunk);
            complete=bytes.chunks_exact(2).map(|b|u16::from_le_bytes([b[0],b[1]])).collect::<Vec<_>>().windows(2).any(|pair|pair==[0,0]);
        }
        if !complete{return Err(io::Error::other("environment_incomplete"))}
        let words=bytes.chunks_exact(2).map(|b|u16::from_le_bytes([b[0],b[1]])).collect::<Vec<_>>();
        let text=String::from_utf16_lossy(&words);let mut selected=serde_json::Map::new();
        for entry in text.split('\0'){
            if let Some((key,value))=entry.split_once('='){
                let upper=key.to_uppercase();if ["CODEX_HOME","USERPROFILE","HOME","VSCODE_IPC_HOOK_CLI"].contains(&upper.as_str()){selected.insert(upper,json!(value));}
            }
        }
        let source=if selected.get("CODEX_HOME").and_then(|v|v.as_str()).is_some_and(|v|!v.is_empty()){"CODEX_HOME"}else{"default"};
        let home=if source=="CODEX_HOME"{selected["CODEX_HOME"].as_str().map(std::path::PathBuf::from)}else{selected.get("USERPROFILE").and_then(|v|v.as_str()).map(|v|std::path::PathBuf::from(v).join(".codex"))};
        let home=home.map(|home|if home.is_absolute(){home}else{std::path::PathBuf::from(&cwd).join(home)});
        let wide=command.encode_utf16().chain(Some(0)).collect::<Vec<_>>();let mut count=0;
        let args=unsafe{CommandLineToArgvW(wide.as_ptr(),&mut count)};
        let mut values=Vec::new();
        if !args.is_null(){for i in 0..count as usize{let p=unsafe{*args.add(i)};let mut n=0;while unsafe{*p.add(n)}!=0{n+=1;}values.push(String::from_utf16_lossy(unsafe{std::slice::from_raw_parts(p,n)}));}unsafe{LocalFree(args.cast());}}
        let mut result=crate::platform::context_arguments(&values);
        result["ok"]=json!(home.is_some());result["home"]=json!(home.map(|p|crate::platform::display_path(&p)));result["homeSource"]=json!(source);result["cwd"]=json!(cwd);result["windowKey"]=selected.get("VSCODE_IPC_HOOK_CLI").cloned().unwrap_or(Value::Null);Ok(result)
    })();
    unsafe{CloseHandle(handle);}
    result.unwrap_or_else(|error|json!({"ok":false,"error":error.to_string()}))
}
pub fn scan()->io::Result<Value>{
    let snapshot=unsafe{CreateToolhelp32Snapshot(2,0)};if snapshot==(-1isize as Handle){return Err(io::Error::last_os_error())}
    let mut row:ProcessEntry=unsafe{mem::zeroed()};row.size=mem::size_of::<ProcessEntry>() as u32;
    let mut ancestry=Vec::new();let mut processes=Vec::new();let mut ok=unsafe{Process32FirstW(snapshot,&mut row)};
    while ok!=0{
        let end=row.exe.iter().position(|value|*value==0).unwrap_or(row.exe.len());let name=String::from_utf16_lossy(&row.exe[..end]);
        let lower=name.to_lowercase();let target=lower=="codex.exe"||lower=="chatgpt.exe";
        let image=if target||lower.contains("code")||lower.contains("cursor")||lower.contains("windsurf"){image(row.pid).ok().map(|path|crate::platform::display_path(&path))}else{None};
        ancestry.push(json!({"pid":row.pid,"parentPid":row.parent,"name":name,"exe":image}));
        if target{processes.push(json!({"pid":row.pid,"parentPid":row.parent,"name":name,"exe":image,"context":context(row.pid)}));}
        ok=unsafe{Process32NextW(snapshot,&mut row)};
    }
    unsafe{CloseHandle(snapshot);}Ok(json!({"ancestry":ancestry,"processes":processes}))
}
#[link(name="ntdll")]
unsafe extern "system" {fn NtQueryInformationProcess(process:Handle,class:u32,buffer:Handle,length:u32,needed:*mut u32)->i32;}
pub fn image(pid:u32)->io::Result<std::path::PathBuf> {
    let handle=unsafe{OpenProcess(0x1000,0,pid)};if handle.is_null(){return Err(io::Error::last_os_error())}
    let mut bytes=vec![0u16;32768];let mut length=bytes.len() as u32;
    let ok=unsafe{QueryFullProcessImageNameW(handle,0,bytes.as_mut_ptr(),&mut length)};
    let error=io::Error::last_os_error();unsafe{CloseHandle(handle);}
    if ok==0{return Err(error)}Ok(std::path::PathBuf::from(String::from_utf16_lossy(&bytes[..length as usize])))
}
pub fn command(pid:u32)->io::Result<String> {
    #[repr(C)]struct Unicode{length:u16,maximum:u16,pointer:*const u16}
    let handle=unsafe{OpenProcess(0x1000,0,pid)};if handle.is_null(){return Err(io::Error::last_os_error())}
    let mut length=0;unsafe{NtQueryInformationProcess(handle,60,std::ptr::null_mut(),0,&mut length)};
    let mut bytes=vec![0u64;(length as usize).div_ceil(8)];
    let status=unsafe{NtQueryInformationProcess(handle,60,bytes.as_mut_ptr().cast(),length,&mut length)};unsafe{CloseHandle(handle);}
    if status<0{return Err(io::Error::other(format!("Process command query failed {status}")))}
    let value=unsafe{&*bytes.as_ptr().cast::<Unicode>()};
    Ok(String::from_utf16_lossy(unsafe{std::slice::from_raw_parts(value.pointer,value.length as usize/2)}))
}
pub fn alive(pid:u32)->bool {
    let handle=unsafe{OpenProcess(0x1000,0,pid)};if handle.is_null(){return false}
    let mut code=0;let ok=unsafe{GetExitCodeProcess(handle,&mut code)};unsafe{CloseHandle(handle);}
    ok!=0&&code==259
}
pub fn terminate(pid:u32)->io::Result<()> {
    let handle=unsafe{OpenProcess(1,0,pid)};if handle.is_null(){return Err(io::Error::last_os_error())}
    let ok=unsafe{TerminateProcess(handle,0)};let error=io::Error::last_os_error();unsafe{CloseHandle(handle);}
    if ok==0{return Err(error)}Ok(())
}
#[link(name="advapi32")]
unsafe extern "system" {
    fn OpenProcessToken(process:Handle,access:u32,token:*mut Handle)->i32;
    fn GetTokenInformation(token:Handle,class:u32,buffer:Handle,length:u32,needed:*mut u32)->i32;
    fn ConvertSidToStringSidW(sid:Handle,text:*mut *mut u16)->i32;
    fn ConvertStringSecurityDescriptorToSecurityDescriptorW(text:*const u16,revision:u32,descriptor:*mut Handle,length:*mut u32)->i32;
    fn SetFileSecurityW(file:*const u16,information:u32,descriptor:Handle)->i32;
}
pub fn protect_directory(path:&std::path::Path)->io::Result<()> {
    let mut token=std::ptr::null_mut();
    if unsafe{OpenProcessToken(GetCurrentProcess(),8,&mut token)}==0{return Err(io::Error::last_os_error())}
    let mut length=0;unsafe{GetTokenInformation(token,1,std::ptr::null_mut(),0,&mut length)};
    let mut buffer=vec![0u64;(length as usize).div_ceil(8)];
    if unsafe{GetTokenInformation(token,1,buffer.as_mut_ptr().cast(),length,&mut length)}==0{unsafe{CloseHandle(token)};return Err(io::Error::last_os_error())}
    let sid=unsafe{*(buffer.as_ptr().cast::<Handle>())};let mut text=std::ptr::null_mut();
    if unsafe{ConvertSidToStringSidW(sid,&mut text)}==0{unsafe{CloseHandle(token)};return Err(io::Error::last_os_error())}
    let mut count=0;while unsafe{*text.add(count)}!=0{count+=1;}
    let sid=String::from_utf16_lossy(unsafe{std::slice::from_raw_parts(text,count)});
    unsafe{LocalFree(text.cast());CloseHandle(token);}
    let sddl=format!("O:{sid}D:P(A;OICI;FA;;;{sid})(A;OICI;FA;;;SY)").encode_utf16().chain(Some(0)).collect::<Vec<_>>();
    let mut descriptor=std::ptr::null_mut();
    if unsafe{ConvertStringSecurityDescriptorToSecurityDescriptorW(sddl.as_ptr(),1,&mut descriptor,std::ptr::null_mut())}==0{return Err(io::Error::last_os_error())}
    fn apply(path:&std::path::Path,descriptor:Handle)->io::Result<()> {
        let metadata=std::fs::symlink_metadata(path)?;
        if metadata.file_type().is_symlink(){return Ok(())}
        let file=path.as_os_str().to_string_lossy().encode_utf16().chain(Some(0)).collect::<Vec<_>>();
        if unsafe{SetFileSecurityW(file.as_ptr(),0x80000005,descriptor)}==0{return Err(io::Error::last_os_error())}
        if metadata.is_dir(){for entry in std::fs::read_dir(path)?{apply(&entry?.path(),descriptor)?;}}
        Ok(())
    }
    let result=apply(path,descriptor);unsafe{LocalFree(descriptor);}result
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
    Ok(rows.iter().find(|r| r.state==2&&r.address==u32::from_ne_bytes([127,0,0,1])&&u16::from_be(r.port as u16)==port).map(|r|r.pid))
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
#[cfg(windows)] pub use windows::{image,command,alive,terminate};
#[cfg(windows)] pub use windows::scan;
pub fn context_arguments(args:&[String])->serde_json::Value {
    let mut result=serde_json::json!({"overrides":{}});let mut i=1;
    while i<args.len(){
        let arg=&args[i];
        let (flag,value)=if let Some((flag,value))=arg.split_once('='){(flag,value.to_owned())}else if ["--profile","-p","--model","-m","--config","-c"].contains(&arg.as_str())&&i+1<args.len(){i+=1;(arg.as_str(),args[i].clone())}else{i+=1;continue;};
        if flag=="--profile"||flag=="-p"{result["profile"]=serde_json::json!(value);}
        else if flag=="--model"||flag=="-m"{result["overrides"]["model"]=serde_json::json!(value);}
        else if let Some((key,value))=value.split_once('='){if ["model","model_provider","model_catalog_json"].contains(&key){result["overrides"][key]=serde_json::json!(value);}}
        i+=1;
    }
    result
}
pub fn client_status(home:&std::path::Path)->std::io::Result<serde_json::Value>{
    use serde_json::json;
    let inventory=scan()?;
    let mut clients=Vec::new();
    if let Some(processes)=inventory["processes"].as_array(){for process in processes{
        let context=&process["context"];
        let shared=context["home"].as_str().is_some_and(|value|match(std::fs::canonicalize(value),std::fs::canonicalize(home)){(Ok(a),Ok(b))=>a==b,_=>false});
        let mut chain=Vec::new();let mut pid=process["pid"].as_u64();
        while let Some(current)=pid{if chain.len()>=8{break;}let Some(row)=inventory["ancestry"].as_array().and_then(|rows|rows.iter().find(|row|row["pid"].as_u64()==Some(current)))else{break};chain.push(format!("{}:{}",current,row["name"].as_str().unwrap_or("")));pid=row["parentPid"].as_u64();}
        clients.push(json!({"id":format!("process-{}",process["pid"]),"pid":process["pid"],"parentPid":process["parentPid"],"exe":process["exe"],"chain":chain,"kind":"cli","name":"Codex CLI","home":context["home"],"homeSource":context["homeSource"],"confirmed":context["ok"]==true,"shared":shared,"cwd":context["cwd"],"canReload":false,"stale":false,"layers":[],"overrides":context["overrides"]}));
    }}
    Ok(json!({"home":home,"other":clients.len(),"clients":clients,"auxiliary":[],"desktop":false,"ide":0,"connectedEditors":0,"checkedAt":crate::diagnostics::now(),"remotes":[],"editors":[]}))
}
#[cfg(unix)]
pub fn image(pid:u32)->std::io::Result<std::path::PathBuf>{
    let output=std::process::Command::new("/bin/ps").args(["-ww","-p",&pid.to_string(),"-o","comm="]).output()?;
    if !output.status.success(){return Err(std::io::Error::new(std::io::ErrorKind::NotFound,"Process exited"))}Ok(std::path::PathBuf::from(String::from_utf8_lossy(&output.stdout).trim()))
}
#[cfg(unix)]
pub fn command(pid:u32)->std::io::Result<String>{
    let output=std::process::Command::new("/bin/ps").args(["-ww","-p",&pid.to_string(),"-o","command="]).output()?;
    if !output.status.success(){return Err(std::io::Error::new(std::io::ErrorKind::NotFound,"Process exited"))}Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}
#[cfg(unix)]
pub fn alive(pid:u32)->bool{
    unsafe extern "C"{fn kill(pid:i32,signal:i32)->i32;}
    if unsafe{kill(pid as i32,0)}!=0{return false}
    std::process::Command::new("/bin/ps").args(["-o","state=","-p",&pid.to_string()]).output().is_ok_and(|output|output.status.success()&&!String::from_utf8_lossy(&output.stdout).trim().starts_with('Z'))
}
#[cfg(unix)]
pub fn terminate(pid:u32)->std::io::Result<()>{
    unsafe extern "C"{fn kill(pid:i32,signal:i32)->i32;}
    if unsafe{kill(pid as i32,15)}!=0{return Err(std::io::Error::last_os_error())}Ok(())
}
#[cfg(unix)]
pub fn context(pid:u32)->serde_json::Value {
    use serde_json::json;
    unsafe extern "C" {
        fn sysctl(name:*mut i32,count:u32,output:*mut std::ffi::c_void,length:*mut usize,input:*mut std::ffi::c_void,input_length:usize)->i32;
        fn switcher_process_cwd(pid:i32,output:*mut u8,capacity:i32)->i32;
    }
    let read=(||->std::io::Result<serde_json::Value>{
        let mut max=0i32;let mut max_size=4usize;let mut max_mib=[1,8];
        if unsafe{sysctl(max_mib.as_mut_ptr(),2,(&mut max as *mut i32).cast(),&mut max_size,std::ptr::null_mut(),0)}!=0||max<=0{return Err(std::io::Error::last_os_error())}
        let mut bytes=vec![0u8;max as usize];let mut length=bytes.len();let mut mib=[1,49,pid as i32];
        if unsafe{sysctl(mib.as_mut_ptr(),3,bytes.as_mut_ptr().cast(),&mut length,std::ptr::null_mut(),0)}!=0{return Err(std::io::Error::last_os_error())}
        bytes.truncate(length);
        if length<4{return Err(std::io::Error::other("process_arguments_unavailable"))}
        let argc=i32::from_ne_bytes(bytes[..4].try_into().unwrap());
        if argc<1||argc>max/8{return Err(std::io::Error::other("process_arguments_invalid"))}
        let mut position=4;
        while position<length&&bytes[position]!=0{position+=1;}
        while position<length&&bytes[position]==0{position+=1;}
        let mut args=Vec::new();
        for _ in 0..argc{
            let start=position;while position<length&&bytes[position]!=0{position+=1;}
            args.push(String::from_utf8_lossy(&bytes[start..position]).to_string());position=(position+1).min(length);
        }
        let mut selected=std::collections::HashMap::new();
        for value in String::from_utf8_lossy(&bytes[position..]).split('\0'){
            if let Some((key,value))=value.split_once('='){if ["CODEX_HOME","HOME","VSCODE_IPC_HOOK_CLI"].contains(&key){selected.insert(key.to_owned(),value.to_owned());}}
        }
        let mut cwd=vec![0u8;4096];let length=unsafe{switcher_process_cwd(pid as i32,cwd.as_mut_ptr(),4096)}.max(0) as usize;
        let cwd=String::from_utf8_lossy(&cwd[..length]).to_string();
        let explicit=selected.get("CODEX_HOME").filter(|value|!value.is_empty());
        let home=explicit.map(std::path::PathBuf::from).or_else(||selected.get("HOME").map(|home|std::path::PathBuf::from(home).join(".codex"))).map(|path|if path.is_absolute(){path}else{std::path::PathBuf::from(&cwd).join(path)});
        let mut result=context_arguments(&args);result["ok"]=json!(home.is_some());result["home"]=json!(home);result["homeSource"]=json!(if explicit.is_some(){"CODEX_HOME"}else{"default"});result["cwd"]=json!(cwd);result["windowKey"]=json!(selected.get("VSCODE_IPC_HOOK_CLI"));Ok(result)
    })();
    read.unwrap_or_else(|error|json!({"ok":false,"error":error.to_string()}))
}
#[cfg(unix)]
pub fn scan()->std::io::Result<serde_json::Value>{
    use serde_json::json;
    let output=std::process::Command::new("/bin/ps").args(["-axo","pid=,ppid=,etime=,comm="]).output()?;
    if !output.status.success(){return Err(std::io::Error::other("Process scan failed"))}
    let expression=regex::Regex::new(r"^\s*(\d+)\s+(\d+)\s+([\d:-]+)\s+(.+)$").unwrap();
    let mut ancestry=Vec::new();let mut processes=Vec::new();
    for line in String::from_utf8_lossy(&output.stdout).lines(){
        if let Some(parts)=expression.captures(line){
            let pid=parts[1].parse::<u32>().map_err(std::io::Error::other)?;
            let name=std::path::Path::new(&parts[4]).file_name().unwrap_or_default().to_string_lossy().to_string();
            let row=json!({"pid":pid,"parentPid":parts[2].parse::<u32>().map_err(std::io::Error::other)?,"elapsed":&parts[3],"exe":&parts[4],"name":name});
            if name=="codex"||name.starts_with("codex-aarch64")||name.starts_with("codex-x86_64")||(parts[4].contains("/Codex.app/Contents/MacOS/")&&(name=="Codex"||name=="ChatGPT")){
                let mut row=row.clone();row["context"]=context(pid);processes.push(row);
            }
            ancestry.push(row);
        }
    }
    Ok(json!({"ancestry":ancestry,"processes":processes}))
}
#[cfg(windows)] pub use windows::protect_directory;
#[cfg(unix)]
pub fn protect_directory(path:&std::path::Path)->std::io::Result<()> {
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(path,std::fs::Permissions::from_mode(0o700))
}
pub fn protect_data(bridge:&std::path::Path)->std::io::Result<()> {
    std::fs::create_dir_all(bridge)?;
    let marker=bridge.join("acl-protected.json");
    let path=display_path(&std::fs::canonicalize(bridge)?);
    if marker.exists(){let value:serde_json::Value=serde_json::from_slice(&std::fs::read(&marker)?).map_err(std::io::Error::other)?;if value["path"].as_str()==Some(path.as_str()){return Ok(())}}
    protect_directory(bridge)?;
    crate::instance::write_json(&marker,&serde_json::json!({"path":path}))
}

pub fn user_home()->std::path::PathBuf {
    std::env::var_os(if cfg!(windows){"USERPROFILE"}else{"HOME"}).map(std::path::PathBuf::from).unwrap_or_default()
}
pub fn display_path(path:&std::path::Path)->String {path.to_string_lossy().trim_start_matches(r"\\?\").to_string()}
pub fn trusted_codex(file:&std::path::Path)->bool {
    let Ok(file)=std::fs::canonicalize(file)else{return false};
    if file.file_name().and_then(|n|n.to_str()).map(str::to_lowercase)!=Some(if cfg!(windows){"codex.exe"}else{"codex"}.into()){return false;}
    let home=user_home();
    for editor in [".vscode",".vscode-insiders",".cursor",".windsurf"]{
        let root=home.join(editor).join("extensions");
        if let Ok(root)=std::fs::canonicalize(root){
            if let Ok(relative)=file.strip_prefix(root){
                let parts:Vec<_>=relative.components().map(|v|v.as_os_str().to_string_lossy().to_string()).collect();
                if parts.len()>2&&(parts[0].to_lowercase().starts_with("openai.chatgpt-")||parts[0].to_lowercase().starts_with("openai.codex-"))&&parts[1]=="bin"{return true;}
            }
        }
    }
    if cfg!(windows){
        if let Some(local)=std::env::var_os("LOCALAPPDATA"){
            if let Ok(root)=std::fs::canonicalize(std::path::PathBuf::from(local).join("OpenAI/Codex/bin")){return file.starts_with(root);}
        }
    }else{
        let mut roots=vec![std::path::PathBuf::from("/Applications/Codex.app/Contents/Resources"),home.join("Applications/Codex.app/Contents/Resources"),std::path::PathBuf::from("/opt/homebrew"),std::path::PathBuf::from("/usr/local"),home.join(".local/bin"),home.join(".npm-global")];
        if let Some(app)=std::env::var_os("CODEX_DESKTOP_APP"){roots.insert(0,std::path::PathBuf::from(app).join("Contents/Resources"));}
        for root in roots{
            if let Ok(root)=std::fs::canonicalize(root){if file.starts_with(root){return true;}}
        }
    }
    false
}
pub fn codex_path(bridge:&std::path::Path)->std::io::Result<std::path::PathBuf>{
    use std::{fs,path::PathBuf};
    let name=if cfg!(windows){"codex.exe"}else{"codex"};
    if let Some(explicit)=std::env::var_os("CODEX_EXE").filter(|v|!v.is_empty()){return fs::canonicalize(explicit);}
    let settings:serde_json::Value=if bridge.join("settings.json").exists(){serde_json::from_slice(&fs::read(bridge.join("settings.json"))?).map_err(std::io::Error::other)?}else{serde_json::Value::Null};
    if let Some(path)=settings["codexExe"].as_str(){
        let path=fs::canonicalize(path)?;
        if !trusted_codex(&path)&&settings["approvedCodexPath"].as_str()!=Some(display_path(&path).as_str()){return Err(std::io::Error::other("此 Codex 程序需要重新确认后才能使用。"));}
        return Ok(path)
    }
    let mut candidates=Vec::new();
    let clients=bridge.join("clients");
    if clients.is_dir(){for entry in fs::read_dir(clients)?{
        let file=entry?.path();if file.extension().is_none_or(|e|e!="json"){continue;}
        let value:serde_json::Value=serde_json::from_slice(&fs::read(file)?).map_err(std::io::Error::other)?;
        if value["remote"]==true||value["wsl"]==true{continue;}
        if let Some(exe)=value["codexExe"].as_str(){candidates.push(PathBuf::from(exe));}
        if let Some(extension)=value["extensionPath"].as_str(){candidates.extend(extension_paths(std::path::Path::new(extension)));}
    }}
    let mut extensions_candidates=Vec::new();
    for editor in [".vscode",".vscode-insiders",".cursor",".windsurf"]{
        let extensions=user_home().join(editor).join("extensions");
        if !extensions.exists(){continue;}
        let mut dirs=fs::read_dir(extensions)?.collect::<Result<Vec<_>,_>>()?;dirs.sort_by(|a,b|natural(&b.file_name().to_string_lossy(),&a.file_name().to_string_lossy()));
        for dir in dirs {
            let id=dir.file_name().to_string_lossy().to_lowercase();
            if !id.starts_with("openai.chatgpt-")&&!id.starts_with("openai.codex-"){continue;}
            extensions_candidates.extend(extension_paths(&dir.path()));
        }
    }
    if cfg!(windows){
        if let Some(local)=std::env::var_os("LOCALAPPDATA"){
            let base=PathBuf::from(local).join("OpenAI/Codex/bin");
            if base.exists(){let mut dirs=fs::read_dir(base)?.collect::<Result<Vec<_>,_>>()?;dirs.sort_by_key(|e|std::cmp::Reverse(e.metadata().ok().and_then(|m|m.modified().ok())));for dir in dirs{candidates.push(dir.path().join(name));}}
        }
    }else{
        let mut apps=vec![PathBuf::from("/Applications/Codex.app"),user_home().join("Applications/Codex.app")];
        if let Some(app)=std::env::var_os("CODEX_DESKTOP_APP"){apps.insert(0,PathBuf::from(app));}
        for app in apps{for relative in ["codex","bin/codex","resources/codex"]{candidates.push(app.join("Contents/Resources").join(relative));}}
    }
    candidates.extend(extensions_candidates);
    if !cfg!(windows){candidates.extend([PathBuf::from("/opt/homebrew/bin/codex"),PathBuf::from("/usr/local/bin/codex"),user_home().join(".local/bin/codex"),user_home().join(".npm-global/bin/codex")]);}
    if let Some(paths)=std::env::var_os("PATH"){for directory in std::env::split_paths(&paths){candidates.push(directory.join(name));}}
    candidates.into_iter().find(|p|trusted_codex(p)).map(fs::canonicalize).unwrap_or_else(||Err(std::io::Error::new(std::io::ErrorKind::NotFound,"未找到 Codex 运行程序。请安装 Codex 官方扩展或桌面版；已有安装可在“编辑器与诊断”填写程序路径。")))
}
fn natural(a:&str,b:&str)->std::cmp::Ordering {
    let expression=regex::Regex::new(r"\d+|\D+").unwrap();
    let left=expression.find_iter(a).map(|m|m.as_str()).collect::<Vec<_>>();let right=expression.find_iter(b).map(|m|m.as_str()).collect::<Vec<_>>();
    for (a,b) in left.iter().zip(&right){let order=match (a.parse::<u64>(),b.parse::<u64>()){(Ok(a),Ok(b))=>a.cmp(&b),_=>a.cmp(b)};if !order.is_eq(){return order;}}
    left.len().cmp(&right.len())
}
fn extension_paths(dir:&std::path::Path)->Vec<std::path::PathBuf>{
    let cpu=if cfg!(target_arch="aarch64"){"aarch64"}else{"x86_64"};let arch=if cfg!(target_arch="aarch64"){"arm64"}else{"x64"};
    let aliases=if cfg!(windows){vec![format!("windows-{cpu}"),format!("win32-{arch}")]}else{vec![format!("macos-{cpu}"),format!("darwin-{arch}"),format!("{cpu}-apple-darwin")]};
    aliases.into_iter().map(|s|dir.join("bin").join(s).join(if cfg!(windows){"codex.exe"}else{"codex"})).collect()
}
pub fn codex_version(bridge:&std::path::Path)->std::io::Result<String>{
    let mut command=std::process::Command::new(codex_path(bridge)?);command.arg("--version");
    let home=std::env::var_os("CODEX_HOME").map(std::path::PathBuf::from).unwrap_or_else(||user_home().join(".codex"));command.envs(codex_env(&home));
    #[cfg(windows)] {use std::os::windows::process::CommandExt;command.creation_flags(0x08000000);}
    command.stdout(std::process::Stdio::piped()).stderr(std::process::Stdio::piped());
    let mut child=command.spawn()?;let deadline=std::time::Instant::now()+std::time::Duration::from_secs(10);
    loop{
        if child.try_wait()?.is_some(){break;}
        if std::time::Instant::now()>=deadline{child.kill()?;child.wait()?;return Err(std::io::Error::new(std::io::ErrorKind::TimedOut,"Codex version query timed out"))}
        std::thread::sleep(std::time::Duration::from_millis(10));
    }
    let output=child.wait_with_output()?;
    if !output.status.success(){return Err(std::io::Error::other("Codex version query failed"));}
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}
pub fn proxy_source()->&'static str {
    if explicit_proxy(){"env"}else if !system_proxy_env().is_empty(){"system"}else{"none"}
}
fn explicit_proxy()->bool {["HTTPS_PROXY","https_proxy","ALL_PROXY","all_proxy","HTTP_PROXY","http_proxy"].iter().any(|key|std::env::var(key).is_ok_and(|v|!v.is_empty()))}
pub fn windows_proxy_env(settings:&serde_json::Value)->std::collections::BTreeMap<String,String>{
    let mut env=std::collections::BTreeMap::new();if settings["enabled"]!=1{return env}
    let mut entries=std::collections::HashMap::new();
    for entry in settings["server"].as_str().unwrap_or("").split(';'){let(key,value)=entry.split_once('=').unwrap_or(("all",entry));entries.insert(key.trim(),value.trim());}
    for(key,name)in[("http","HTTP_PROXY"),("https","HTTPS_PROXY")]{if let Some(value)=entries.get(key).or(entries.get("all")).filter(|s|!s.is_empty()){env.insert(name.into(),if value.contains("://"){value.to_string()}else{format!("http://{value}")});}}
    if let Some(value)=entries.get("socks").filter(|s|!s.is_empty()){env.insert("ALL_PROXY".into(),format!("socks5h://{value}"));}env
}
fn system_proxy_env()->std::collections::BTreeMap<String,String>{
    use std::{sync::Mutex,time::{Instant,Duration},collections::BTreeMap};
    static CACHE:std::sync::OnceLock<Mutex<Option<(Instant,BTreeMap<String,String>)>>>=std::sync::OnceLock::new();
    let mut cache=CACHE.get_or_init(||Mutex::new(None)).lock().unwrap();
    if let Some((at,value))=&*cache{if at.elapsed()<Duration::from_secs(60){return value.clone()}}
    #[cfg(windows)] let result={
        use std::ffi::c_void;
        #[link(name="advapi32")]unsafe extern "system"{fn RegGetValueW(key:*mut c_void,path:*const u16,name:*const u16,flags:u32,kind:*mut u32,data:*mut c_void,length:*mut u32)->i32;}
        let wide=|s:&str|s.encode_utf16().chain(Some(0)).collect::<Vec<_>>();
        let key=0x80000001u32 as i32 as isize as *mut c_void;let path=wide(r"Software\Microsoft\Windows\CurrentVersion\Internet Settings");
        let mut enabled=0u32;let mut size=4;
        let status=unsafe{RegGetValueW(key,path.as_ptr(),wide("ProxyEnable").as_ptr(),0x10,std::ptr::null_mut(),(&mut enabled as *mut u32).cast(),&mut size)};
        let mut server=vec![0u16;32768];let mut size=(server.len()*2)as u32;
        let server_status=unsafe{RegGetValueW(key,path.as_ptr(),wide("ProxyServer").as_ptr(),2,std::ptr::null_mut(),server.as_mut_ptr().cast(),&mut size)};
        if status==0&&server_status==0{let length=server.iter().position(|v|*v==0).unwrap_or(server.len());windows_proxy_env(&serde_json::json!({"enabled":enabled,"server":String::from_utf16_lossy(&server[..length])}))}else{BTreeMap::new()}
    };
    #[cfg(not(windows))]let result={
        let output=std::process::Command::new("/usr/sbin/scutil").arg("--proxy").output();let mut result=BTreeMap::new();
        if let Ok(output)=output{
            let text=String::from_utf8_lossy(&output.stdout);let entries=text.lines().filter_map(|line|line.split_once(':').map(|(k,v)|(k.trim(),v.trim()))).collect::<std::collections::HashMap<_,_>>();
            for(prefix,name,scheme)in[("HTTPS","HTTPS_PROXY","http"),("HTTP","HTTP_PROXY","http"),("SOCKS","ALL_PROXY","socks5h")]{
                if entries.get(format!("{prefix}Enable").as_str())==Some(&"1"){
                    if let (Some(host),Some(port))=(entries.get(format!("{prefix}Proxy").as_str()),entries.get(format!("{prefix}Port").as_str())){result.insert(name.into(),format!("{scheme}://{host}:{port}"));}
                }
            }
            if result.contains_key("HTTPS_PROXY"){result.remove("ALL_PROXY");}
        }result
    };
    *cache=Some((Instant::now(),result.clone()));result
}
pub fn codex_env(home:&std::path::Path)->std::collections::BTreeMap<String,String>{
    let mut env=std::env::vars().collect::<std::collections::BTreeMap<_,_>>();env.insert("CODEX_HOME".into(),display_path(home));
    if !explicit_proxy(){env.extend(system_proxy_env());if cfg!(windows)&&["HTTP_PROXY","HTTPS_PROXY","ALL_PROXY"].iter().any(|key|env.contains_key(*key))&&!env.contains_key("NO_PROXY")&&!env.contains_key("no_proxy"){env.insert("NO_PROXY".into(),"localhost,127.0.0.1,::1".into());}}
    env
}
pub async fn stop(pid:u32)->std::io::Result<()> {
    use std::time::{Instant,Duration};
    if !alive(pid){return Ok(())}terminate(pid)?;
    let until=Instant::now()+Duration::from_millis(1500);
    while alive(pid)&&Instant::now()<until{tokio::time::sleep(Duration::from_millis(25)).await;}
    #[cfg(unix)] if alive(pid){unsafe extern "C"{fn kill(pid:i32,signal:i32)->i32;}if unsafe{kill(pid as i32,9)}!=0{return Err(std::io::Error::last_os_error())}}
    let until=Instant::now()+Duration::from_millis(1000);
    while alive(pid)&&Instant::now()<until{tokio::time::sleep(Duration::from_millis(25)).await;}
    if alive(pid){return Err(std::io::Error::other("旧 Codex 进程尚未退出，未继续同步对话或重载客户端。"))}Ok(())
}
pub fn open_url(url:&str)->std::io::Result<()> {
    let mut command=std::process::Command::new(if cfg!(windows){"explorer.exe"}else{"/usr/bin/open"});
    command.arg(url);
    #[cfg(windows)] {use std::os::windows::process::CommandExt;command.creation_flags(0x08000000);}
    command.spawn()?;Ok(())
}
pub fn set_environment(app:&crate::server::App,input:&serde_json::Value)->std::io::Result<serde_json::Value>{
    use std::{fs,path::PathBuf,io};use serde_json::json;
    let value=input["home"].as_str().filter(|s|!s.is_empty()).map(str::to_owned).unwrap_or_else(||display_path(&app.codex_home()));
    let home=if value=="~"{user_home()}else if value.starts_with("~/")||value.starts_with("~\\"){user_home().join(&value[2..])}else{PathBuf::from(value)};
    let home=if home.is_absolute(){home}else{std::env::current_dir()?.join(home)};
    if !home.is_dir(){return Err(io::Error::other("配置目录不存在，请选择 Codex 实际使用的目录。"))}
    let exe=input["codexExe"].as_str().unwrap_or("").trim();
    if !exe.is_empty()&&!PathBuf::from(exe).is_file(){return Err(io::Error::other("Codex 程序路径不存在。"))}
    let trusted=exe.is_empty()||trusted_codex(&PathBuf::from(exe));
    if !trusted&&input["allowUntrusted"]!=true{return Err(io::Error::other("该程序不在自动识别的安装目录中，请确认后再使用。"))}
    let file=app.bridge.join("settings.json");let mut settings:serde_json::Value=if file.exists(){serde_json::from_slice(&fs::read(&file)?).map_err(io::Error::other)?}else{json!({})};
    settings["codexHome"]=json!(display_path(&home));
    let object=settings.as_object_mut().unwrap();object.remove("codexExe");object.remove("approvedCodexPath");
    if !exe.is_empty(){object.insert("codexExe".into(),json!(exe));if !trusted{object.insert("approvedCodexPath".into(),json!(display_path(&fs::canonicalize(exe)?)));}}
    crate::instance::write_json(&file,&settings)?;
    Ok(json!({"message":format!("已改为读取 {}，后续切换只应用到此目录。",display_path(&home))}))
}
pub fn os_version()->String {
    #[cfg(windows)]{
        #[repr(C)]struct Version{size:u32,major:u32,minor:u32,build:u32,platform:u32,service:[u16;128]}
        #[link(name="ntdll")]unsafe extern "system"{fn RtlGetVersion(info:*mut Version)->i32;}
        let mut version:Version=unsafe{std::mem::zeroed()};version.size=std::mem::size_of::<Version>()as u32;
        if unsafe{RtlGetVersion(&mut version)}==0{return format!("{}.{}.{}",version.major,version.minor,version.build)}String::new()
    }
    #[cfg(not(windows))]{std::process::Command::new("/usr/bin/uname").arg("-r").output().map(|v|String::from_utf8_lossy(&v.stdout).trim().to_string()).unwrap_or_default()}
}
#[cfg(not(windows))]
pub fn port_pid(port:u16)->io::Result<Option<u32>>{
    let output=std::process::Command::new("/usr/sbin/lsof").args(["-nP",&format!("-iTCP:{port}"),"-sTCP:LISTEN","-t"]).output()?;
    if output.status.code()==Some(1){return Ok(None)}
    if !output.status.success(){return Err(io::Error::other("Port lookup failed"))}
    Ok(String::from_utf8_lossy(&output.stdout).lines().next().and_then(|line|line.parse().ok()))
}
#[cfg(not(windows))]
pub fn processes()->io::Result<Value>{let inventory=scan()?;let rows=inventory["ancestry"].as_array().unwrap();Ok(serde_json::json!({"total":rows.len(),"codex":inventory["processes"].as_array().unwrap().len(),"code":rows.iter().filter(|r|r["name"].as_str().is_some_and(|name|name.contains("Code"))).count()}))}
#[cfg(not(windows))]
pub fn random_bytes()->io::Result<[u8;32]>{
 use std::io::Read;
 let mut bytes=[0u8;32];std::fs::File::open("/dev/urandom")?.read_exact(&mut bytes)?;Ok(bytes)
}
