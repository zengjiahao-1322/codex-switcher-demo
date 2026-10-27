//! HTTP framework from the read-only prototype. Missing actions remain 404.
use std::{convert::Infallible,fs,path::PathBuf,sync::Arc};
use hyper::{body::{Bytes,Incoming},Request,Response};
use http_body_util::Full;
use serde_json::json;
pub(crate) struct App { pub home:PathBuf, pub bridge:PathBuf, pub web:PathBuf, pub token:String, pub port:u16 }
fn response(status:u16, content_type:&str, bytes:Vec<u8>)->Response<Full<Bytes>> {
    Response::builder().status(status).header("Content-Type",content_type).header("Cache-Control","no-store").header("X-Content-Type-Options","nosniff").header("Referrer-Policy","no-referrer").body(Full::new(Bytes::from(bytes))).unwrap()
}
fn error(status:u16,message:&str)->Response<Full<Bytes>>{response(status,"application/json; charset=utf-8",serde_json::to_vec(&json!({"error":message})).unwrap())}
pub(crate) async fn serve(req:Request<Incoming>,app:Arc<App>)->Result<Response<Full<Bytes>>,Infallible>{
    let host=req.headers().get("host").and_then(|v|v.to_str().ok()).unwrap_or("");
    if host!=format!("127.0.0.1:{}",app.port)&&host!=format!("localhost:{}",app.port){return Ok(error(403,"Host rejected"))}
    if let Some(origin)=req.headers().get("origin") {if origin.to_str().ok()!=Some(format!("http://{host}").as_str()){return Ok(error(403,"Origin rejected"))}}
    let route=req.uri().path();
    if route.starts_with("/api/"){
        let bearer=req.headers().get("authorization").and_then(|v|v.to_str().ok())==Some(format!("Bearer {}",app.token).as_str());
        let cookie_name=format!("codex_switcher_{}=",app.port);
        let cookie=req.headers().get("cookie").and_then(|v|v.to_str().ok()).unwrap_or("").split(';').map(str::trim).find_map(|p|p.strip_prefix(&cookie_name))==Some(app.token.as_str());
        if route=="/api/session"&&req.method()=="POST"{
            if !bearer{return Ok(error(401,"Authentication required"))}
            let mut res=response(204,"application/json",Vec::new());
            res.headers_mut().insert("set-cookie",format!("{cookie_name}{}; HttpOnly; SameSite=Strict; Path=/api/",app.token).parse().unwrap());return Ok(res)
        }
        if !bearer&&!cookie{return Ok(error(401,"Authentication required"))}
        let value=match (req.method().as_str(),route){
            ("GET","/api/runtime")=>Ok(json!({"version":"0.0.1-prototype","pid":std::process::id(),"runtime":"rust"})),
            ("POST","/api/state")=>app.state(),
            _=>return Ok(error(404,"Unknown prototype route")),
        };
        return Ok(match value {Ok(v)=>response(200,"application/json; charset=utf-8",serde_json::to_vec(&v).unwrap()),Err(_)=>error(500,"Fixture read failed")})
    }
    if req.method()!="GET"{return Ok(error(405,"GET required"))}
    let relative=if route=="/"{"index.html"}else{route.trim_start_matches('/')};
    if relative.contains("..")||relative.contains(['\\',':','%']){return Ok(error(404,"Not found"))}
    let mime=if relative.ends_with(".html"){"text/html; charset=utf-8"}else if relative.ends_with(".js"){"text/javascript; charset=utf-8"}else if relative.ends_with(".css"){"text/css; charset=utf-8"}else{return Ok(error(404,"Not found"))};
    Ok(match fs::read(app.web.join(relative)){Ok(bytes)=>response(200,mime,bytes),Err(_)=>error(404,"Not found")})
}
