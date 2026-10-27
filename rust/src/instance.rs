//! Startup, authenticated instance reuse and verified process handover.
use std::{env,fs,io,path::PathBuf,sync::Arc,time::{Instant,Duration}};
use hyper::{server::conn::http1,service::service_fn};
use hyper_util::rt::TokioIo;
use serde_json::{json,Value};
use tokio::net::{TcpListener,TcpStream};
use http_body_util::{BodyExt,Full};
use hyper::{Request,body::Bytes};
use crate::{platform,server::{App,serve}};
pub fn runtime()->Value {
    use sha2::{Digest,Sha256};
    let root=project_root();
    let metadata:Value=fs::read(root.join("src/platform/release-info.json")).ok().and_then(|bytes|serde_json::from_slice(&bytes).ok()).unwrap_or(Value::Null);
    let package:Value=serde_json::from_str(include_str!("../../package.json")).unwrap();
    let id=format!("{:x}",Sha256::digest(format!("{}:{}",env!("SWITCHER_BUILD_ID"),metadata["sequence"])));
    json!({"version":package["version"],"id":&id[..12],"sequence":metadata["sequence"],"pid":std::process::id(),"entry":env::current_exe().map(|p|platform::display_path(&p)).unwrap_or_default(),"runtime":"rust"})
}
pub fn project_root()->PathBuf {env::var_os("SWITCHER_WEB_ROOT").map(PathBuf::from).and_then(|p|p.parent().map(PathBuf::from)).unwrap_or_else(||env::current_exe().unwrap().parent().unwrap().to_path_buf())}
pub fn other_action(old:u64,current:u64)->&'static str {if old>=current{"deferred"}else{"stopped"}}
fn same_path(a:&std::path::Path,b:&std::path::Path)->bool {
    match(fs::canonicalize(a),fs::canonicalize(b)){(Ok(a),Ok(b))=>if cfg!(windows){platform::display_path(&a).eq_ignore_ascii_case(&platform::display_path(&b))}else{a==b},_=>false}
}
fn owner_install(pid:u32)->Option<PathBuf>{
    let image=platform::image(pid).ok()?;
    if image.file_name()?.to_string_lossy().eq_ignore_ascii_case(if cfg!(windows){"node.exe"}else{"node"}){
        let command=platform::command(pid).ok()?;
        let expression=regex::Regex::new(r#"(?i)(?:^|[\\/])node(?:\.exe)?"?\s+"?(.+?[\\/]main\.cjs)"?(?:\s|$)"#).unwrap();
        let entry=expression.captures(&command)?.get(1)?.as_str();PathBuf::from(entry).parent().map(PathBuf::from)
    }else{image.parent().map(PathBuf::from)}
}
fn verified(pid:u32,old:&Value)->bool {
    let Some(entry)=old["entry"].as_str()else{return false};
    if old["pid"].as_u64()!=Some(pid as u64){return false}
    let Ok(image)=platform::image(pid)else{return false};
    same_path(&image,&PathBuf::from(entry)) || (entry.ends_with("main.cjs")&&platform::command(pid).is_ok_and(|command|command.contains(&format!("\"{entry}\""))||command.split_whitespace().any(|part|part==entry)))
}
fn open_url(url:&str)->io::Result<()> {if !env::args().any(|s|s=="--no-open"){platform::open_url(url)?;}Ok(())}
async fn reclaimed_listener(port:u16)->io::Result<TcpListener>{
    let deadline=Instant::now()+Duration::from_secs(1);
    loop{match TcpListener::bind(("127.0.0.1",port)).await{
        Ok(listener)=>return Ok(listener),
        Err(error) if error.kind()==io::ErrorKind::AddrInUse&&Instant::now()<deadline=>tokio::time::sleep(Duration::from_millis(25)).await,
        Err(error)=>return Err(error),
    }}
}
async fn local_runtime(url:&str)->io::Result<Value>{
    let (base,token)=url.split_once("/#").ok_or_else(||io::Error::other("Invalid local connection URL"))?;
    let address=base.strip_prefix("http://127.0.0.1:").ok_or_else(||io::Error::other("Connection must use loopback"))?;
    let port=address.parse::<u16>().map_err(io::Error::other)?;
    let request=async {
        let stream=TcpStream::connect(("127.0.0.1",port)).await?;
        let (mut sender,connection)=hyper::client::conn::http1::handshake(TokioIo::new(stream)).await.map_err(io::Error::other)?;
        tokio::spawn(async move {let _=connection.await;});
        let response=sender.send_request(Request::builder().uri("/api/runtime").header("Host",format!("127.0.0.1:{port}")).header("Authorization",format!("Bearer {token}")).body(Full::new(Bytes::new())).unwrap()).await.map_err(io::Error::other)?;
        if !response.status().is_success(){return Err(io::Error::other("Existing runtime authentication failed"))}
        let bytes=response.into_body().collect().await.map_err(io::Error::other)?.to_bytes();
        serde_json::from_slice(&bytes).map_err(io::Error::other)
    };
    tokio::time::timeout(Duration::from_secs(3),request).await.map_err(io::Error::other)?
}
pub fn write_json(file:&std::path::Path,value:&Value)->io::Result<()> {
    if let Some(parent)=file.parent(){fs::create_dir_all(parent)?;}
    let temporary=file.with_extension(format!("{}.tmp",std::process::id()));
    fs::write(&temporary,serde_json::to_vec_pretty(value).map_err(io::Error::other)?)?;
    fs::rename(&temporary,file)
}
pub async fn run()->Result<(),Box<dyn std::error::Error>>{
    if env::args().nth(1).as_deref()==Some("--algorithm-fixture") {
        crate::diagnostics::algorithm(&env::args().skip(2).collect::<Vec<_>>())?;return Ok(())
    }
    if env::args().nth(1).as_deref()==Some("--probe"){
        let port=env::args().nth(2).unwrap_or("47831".into()).parse()?;
        let started=Instant::now(); let pid=platform::port_pid(port)?; let port_ms=started.elapsed().as_secs_f64()*1000.0;
        let started=Instant::now();let procs=platform::processes()?;let process_ms=started.elapsed().as_secs_f64()*1000.0;
        println!("{}",json!({"pid":pid,"portMs":port_ms,"processMs":process_ms,"processes":procs}));return Ok(())
    }
    let started=Instant::now();
    let explicit_bridge=env::var_os("BRIDGE_HOME");
    let bridge=explicit_bridge.clone().map(PathBuf::from).unwrap_or_else(||if cfg!(windows){project_root().join("private")}else{platform::user_home().join("Library/Application Support/CodexApiSwitcher")});
    let settings:Value=fs::read(bridge.join("settings.json")).ok().and_then(|bytes|serde_json::from_slice(&bytes).ok()).unwrap_or(Value::Null);
    let home=env::var_os("BRIDGE_CODEX_HOME").map(PathBuf::from).or_else(||settings["codexHome"].as_str().map(PathBuf::from)).or_else(||env::var_os("CODEX_HOME").map(PathBuf::from)).unwrap_or_else(||platform::user_home().join(".codex"));
    fs::create_dir_all(&home)?;fs::create_dir_all(&bridge)?;
    let running_path=bridge.join("running.json");
    let discovery=env::var_os("BRIDGE_DISCOVERY_DIR").map(PathBuf::from).or_else(||explicit_bridge.is_none().then(||platform::user_home().join(".codex-api-switcher")));
    let existing_started=Instant::now();let mut other_install=Value::Null;
    let local=fs::read(&running_path).ok();
    let discovered=if local.is_none(){discovery.as_ref().and_then(|d|fs::read(d.join("connection.json")).ok())}else{None};
    if let Some(bytes)=local.as_ref().or(discovered.as_ref()){
        let previous:Value=serde_json::from_slice(&bytes)?;
        if let Some(url)=previous["url"].as_str(){
            if let Ok(old)=local_runtime(url).await {
                let same_build=old["id"]==runtime()["id"];
                let old_sequence=previous["build"]["sequence"].as_u64().or(old["sequence"].as_u64()).unwrap_or(0);
                let pid=previous["pid"].as_u64().ok_or("Missing old runtime PID")? as u32;
                if !verified(pid,&old){return Err("无法确认旧切换器后台归属，请先关闭旧切换器再启动新版；配置尚未修改。".into())}
                let action=other_action(old_sequence,runtime()["sequence"].as_u64().unwrap_or(0));
                if discovered.is_some(){other_install=json!({"pid":pid,"sequence":old_sequence,"action":action});}
                if (discovered.is_none()&&same_build)||(discovered.is_some()&&action=="deferred"){
                    if let Some(directory)=&discovery{write_json(&directory.join("connection.json"),&previous)?;}
                    crate::diagnostics::log(&bridge,"startup",json!({"otherInstall":other_install}))?;
                    open_url(url)?;println!("BRIDGE_ALREADY_RUNNING {}",url.split('#').next().unwrap_or(url));return Ok(())
                }
                platform::stop(pid).await?;
            }
        }
    }
    let existing_ms=existing_started.elapsed().as_millis();
    let web=env::var_os("SWITCHER_WEB_ROOT").map(PathBuf::from).unwrap_or_else(||project_root().join("web"));
    let random=platform::random_bytes()?;
    let token=env::var("SWITCHER_TEST_TOKEN").unwrap_or_else(|_|random.iter().map(|b|format!("{b:02x}")).collect::<String>());
    let desired_port=env::var("BRIDGE_PORT").unwrap_or("47831".into()).parse::<u16>()?;
    let protection_started=Instant::now();
    platform::protect_data(&bridge)?;
    if let Some(directory)=&discovery{platform::protect_data(directory)?;}
    let protect_ms=protection_started.elapsed().as_millis();
    let service_started=Instant::now();
    let mut app=App{home,bridge,web,token,port:desired_port,protection_ok:true,first_request:std::sync::atomic::AtomicBool::new(false),ready_at:Instant::now(),downloads:std::sync::Mutex::new(std::collections::HashMap::new())};
    let service_ms=service_started.elapsed().as_millis();
    let mut handover=json!({});let listen_started=Instant::now();
    let listener=match TcpListener::bind(("127.0.0.1",desired_port)).await {
        Ok(listener)=>listener,
        Err(error) if [io::ErrorKind::AddrInUse,io::ErrorKind::PermissionDenied].contains(&error.kind())=>{
            let owner=platform::port_pid(desired_port)?;
            let install=owner.and_then(owner_install);
            let same_install=owner.and_then(|pid|platform::image(pid).ok()).is_some_and(|path|same_path(&path,&env::current_exe().unwrap()))||install.as_ref().is_some_and(|path|same_path(path,&project_root()));
            let older_install=install.and_then(|root|{
                let package:Value=serde_json::from_slice(&fs::read(root.join("package.json")).ok()?).ok()?;
                let release:Value=serde_json::from_slice(&fs::read(root.join("src/platform/release-info.json")).ok()?).ok()?;
                (package["name"]=="codex-api-switcher").then(||release["sequence"].as_u64()).flatten()
            }).filter(|old|*old<runtime()["sequence"].as_u64().unwrap_or(0));
            if same_install||older_install.is_some() {
                if let Some(sequence)=older_install{other_install=json!({"pid":owner,"sequence":sequence,"action":"stopped"});}
                platform::stop(owner.unwrap()).await?;
                handover["reclaimed"]=json!({"pid":owner});
                reclaimed_listener(desired_port).await?
            }else{
                handover["portFallback"]=json!({"port":desired_port,"ownerPid":owner,"reason":if error.kind()==io::ErrorKind::PermissionDenied{"EACCES"}else if owner.is_some(){"different_process"}else{"port_in_use"}});
                TcpListener::bind(("127.0.0.1",0)).await?
            }
        },
        Err(error)=>return Err(error.into()),
    };
    app.port=listener.local_addr()?.port();
    let connection=json!({"pid":std::process::id(),"url":format!("http://127.0.0.1:{}/#{}",app.port,app.token),"build":runtime()});
    write_json(&running_path,&connection)?;
    if let Some(directory)=&discovery{write_json(&directory.join("connection.json"),&connection)?;}
    app.ready_at=Instant::now();
    let mut startup=json!({"readyMs":started.elapsed().as_millis(),"port":app.port,"otherInstall":other_install,"phases":{"existing":existing_ms,"protectDataDirs":protect_ms,"createService":service_ms,"listen":listen_started.elapsed().as_millis()}});
    startup.as_object_mut().unwrap().extend(handover.as_object().unwrap().clone());
    crate::diagnostics::log(&app.bridge,"startup",startup)?;
    println!("{}",json!({"event":"ready","listenMs":started.elapsed().as_secs_f64()*1000.0,"port":app.port,"url":format!("http://127.0.0.1:{}/#{}",app.port,app.token)}));
    open_url(connection["url"].as_str().unwrap())?;
    if let (Some(directory),Some(sequence))=(&discovery,runtime()["sequence"].as_u64().filter(|n|*n>0)) {
        let marker:Value=fs::read(directory.join("shortcut.json")).ok().and_then(|bytes|serde_json::from_slice(&bytes).ok()).unwrap_or(Value::Null);
        if !(marker["created"]==true&&marker["sequence"].as_u64().unwrap_or(0)>=sequence){
            if let Err(error)=crate::integration::desktop(directory,sequence){crate::diagnostics::log(&app.bridge,"app.shortcuts",json!({"error":error.to_string()}))?;}
        }
    }
    let app=Arc::new(app);
    loop{let(stream,_)=listener.accept().await?;let app=app.clone();tokio::spawn(async move{if let Err(error)=http1::Builder::new().serve_connection(TokioIo::new(stream),service_fn(move|req|serve(req,app.clone()))).await{eprintln!("HTTP connection failed: {error}");}});}
}
