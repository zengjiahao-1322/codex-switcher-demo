//! Startup: prototype isolated listener only; instance takeover/ACL/integration pending batch 1.
use std::{env,path::PathBuf,sync::Arc,time::Instant};
use hyper::{server::conn::http1,service::service_fn};
use hyper_util::rt::TokioIo;
use serde_json::json;
use tokio::net::TcpListener;
use crate::{platform,server::{App,serve}};
pub async fn run()->Result<(),Box<dyn std::error::Error>>{
    if env::args().nth(1).as_deref()==Some("--probe"){
        let port=env::args().nth(2).unwrap_or("47831".into()).parse()?;
        let started=Instant::now(); let pid=platform::port_pid(port)?; let port_ms=started.elapsed().as_secs_f64()*1000.0;
        let started=Instant::now();let procs=platform::processes()?;let process_ms=started.elapsed().as_secs_f64()*1000.0;
        println!("{}",json!({"pid":pid,"portMs":port_ms,"processMs":process_ms,"processes":procs}));return Ok(())
    }
    let started=Instant::now();
    let home=PathBuf::from(env::var("CODEX_HOME")?);let bridge=PathBuf::from(env::var("BRIDGE_HOME")?);
    let web=PathBuf::from(env::var("SWITCHER_WEB_ROOT")?);
    let random=platform::random_bytes()?;
    let token=env::var("SWITCHER_TEST_TOKEN").unwrap_or_else(|_|random.iter().map(|b|format!("{b:02x}")).collect::<String>());
    let desired_port=env::var("BRIDGE_PORT").unwrap_or("0".into()).parse::<u16>()?;
    let mut app=App{home,bridge,web,token,port:desired_port};
    app.state()?;
    let listener=TcpListener::bind(("127.0.0.1",desired_port)).await?;
    app.port=listener.local_addr()?.port();
    println!("{}",json!({"event":"ready","listenMs":started.elapsed().as_secs_f64()*1000.0,"port":app.port,"url":format!("http://127.0.0.1:{}/#{}",app.port,app.token)}));
    let app=Arc::new(app);
    loop{let(stream,_)=listener.accept().await?;let app=app.clone();tokio::spawn(async move{if let Err(error)=http1::Builder::new().serve_connection(TokioIo::new(stream),service_fn(move|req|serve(req,app.clone()))).await{eprintln!("HTTP connection failed: {error}");}});}
}
