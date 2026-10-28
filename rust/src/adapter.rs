//! Buffered Responses adapter: one upstream request, no polling. The downstream
//! body owns the task after the first heartbeat, so disconnect aborts upstream.
use crate::{
    adapter_convert::{self, Failure, Prepared},
    server::{App, Body, response},
};
use http_body_util::BodyExt;
use hyper::{
    Request, Response,
    body::{Bytes, Frame, Incoming},
};
use serde_json::{Value, json};
use std::{
    convert::Infallible,
    fs,
    future::Future,
    io::{self, Write},
    pin::Pin,
    sync::Arc,
    task::{Context, Poll},
    time::Duration,
};
use tokio::sync::mpsc;
type Upstream = Pin<Box<dyn Future<Output = Result<Value, Failure>> + Send>>;

pub fn settings(app: &App) -> io::Result<Value> {
    let path = app.bridge.join("adapter.json");
    let value = crate::accounts::read(&path, Value::Null)?;
    if !value.is_null() {
        return Ok(value);
    }
    let bytes = crate::platform::random_bytes()?;
    let token = bytes.iter().map(|b| format!("{b:02x}")).collect::<String>();
    let port = std::env::var("BRIDGE_PORT")
        .ok()
        .and_then(|s| s.parse::<u16>().ok())
        .unwrap_or(47831);
    let value = json!({"port":port,"token":token,"target":null});
    crate::instance::write_json(&path, &value)?;
    Ok(value)
}
pub async fn local_provider(app: &App, provider: &Value) -> io::Result<Value> {
    let settings = settings(app)?;
    let port = settings["port"].as_u64().unwrap();
    if u64::from(app.port) != port {
        let ready = reqwest::Client::builder()
            .no_proxy()
            .build()
            .map_err(io::Error::other)?
            .get(format!("http://127.0.0.1:{port}/"))
            .timeout(Duration::from_secs(2))
            .send()
            .await
            .is_ok_and(|r| r.status().is_success());
        if !ready {
            return Err(io::Error::other(format!(
                "本机转换服务未运行（端口 {port}），无法使用转换模式。请先打开切换器。"
            )));
        }
    }
    let mut target = provider.clone();
    target["name"] = json!(format!(
        "{}（经本机转换）",
        provider["name"].as_str().unwrap_or("")
    ));
    target["baseUrl"] = json!(format!("http://127.0.0.1:{port}/v1"));
    target["apiKey"] = settings["token"].clone();
    Ok(target)
}
pub fn target(provider: &Value, model: &str) -> Value {
    json!({"providerId":provider["id"],"model":model,"apiMode":if provider["apiMode"]=="anthropic_messages"{"anthropic_messages"}else{"chat_completions"}})
}
fn failure(error: Failure, initial: Option<&Value>, started: bool) -> Value {
    if started {
        let mut value = initial.unwrap().clone();
        value["status"] = json!("failed");
        value["error"] = json!({"code":if error.status==429{"rate_limit_exceeded"}else{"server_error"},"message":error.message});
        json!({"type":"response.failed","response":value})
    } else {
        json!({"error":{"message":error.message,"type":if error.status==400&&!error.upstream{"invalid_request_error"}else{"api_error"}}})
    }
}
fn json_response(status: u16, value: Value) -> Response<Body> {
    response(
        status,
        "application/json",
        serde_json::to_vec(&value).unwrap(),
    )
}
fn log(app: &App, error: &Failure) {
    let result = (|| -> io::Result<()> {
        let file = app.bridge.join("adapter.log");
        if fs::metadata(&file).is_ok_and(|m| m.len() > 1024 * 1024) {
            fs::rename(&file, app.bridge.join("adapter.log.1"))?;
        }
        let mut options = fs::OpenOptions::new();
        options.append(true).create(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut output = options.open(&file)?;
        writeln!(output, "{} {}", crate::diagnostics::now(), error.message)?;
        Ok(())
    })();
    if let Err(e) = result {
        eprintln!("Adapter error log failed: {e}");
    }
}
async fn upstream(provider: Value, payload: Value, anthropic: bool) -> Result<Value, Failure> {
    let base = provider["baseUrl"]
        .as_str()
        .unwrap_or("")
        .trim_end_matches('/');
    let url = format!(
        "{base}{}",
        if anthropic {
            if base.ends_with("/v1") {
                "/messages"
            } else {
                "/v1/messages"
            }
        } else {
            "/chat/completions"
        }
    );
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .no_proxy()
        .build()
        .map_err(|_| Failure::unsupported())?;
    let mut request = client.post(url).json(&payload);
    let key = provider["apiKey"].as_str().unwrap_or("");
    if anthropic {
        request = request
            .header("x-api-key", key)
            .header("anthropic-version", "2023-06-01");
    } else {
        request = request.bearer_auth(key);
    }
    let response = request.send().await.map_err(|_| Failure::unsupported())?;
    let status = response.status().as_u16();
    if !(200..300).contains(&status) {
        return Err(if status >= 400 {
            Failure {
                status,
                message: format!("Upstream HTTP {status}"),
                upstream: true,
            }
        } else {
            Failure::unsupported()
        });
    }
    response.json().await.map_err(|_| Failure::unsupported())
}
struct Events {
    sequence: u64,
}
impl Events {
    fn encode(&mut self, mut event: Value) -> Bytes {
        event["sequence_number"] = json!(self.sequence);
        self.sequence += 1;
        Bytes::from(format!(
            "event: {}\ndata: {event}\n\n",
            event["type"].as_str().unwrap()
        ))
    }
}
struct StreamingBody {
    receiver: mpsc::Receiver<Bytes>,
    task: tokio::task::AbortHandle,
}
impl Drop for StreamingBody {
    fn drop(&mut self) {
        self.task.abort();
    }
}
impl hyper::body::Body for StreamingBody {
    type Data = Bytes;
    type Error = Infallible;
    fn poll_frame(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
    ) -> Poll<Option<Result<Frame<Bytes>, Infallible>>> {
        self.receiver
            .poll_recv(cx)
            .map(|v| v.map(|b| Ok(Frame::data(b))))
    }
}
fn sse(body: Body, dropped: &[String]) -> Response<Body> {
    let mut response = Response::builder()
        .status(200)
        .header("content-type", "text/event-stream; charset=utf-8")
        .header("cache-control", "no-cache")
        .header("x-bridge-streaming", "buffered")
        .header("x-content-type-options", "nosniff")
        .header("referrer-policy", "no-referrer")
        .body(body)
        .unwrap();
    if !dropped.is_empty() {
        response.headers_mut().insert(
            "x-bridge-dropped-tools",
            dropped
                .join(",")
                .chars()
                .take(500)
                .collect::<String>()
                .parse()
                .unwrap(),
        );
    }
    response
}
fn finished(app: &App, prepared: &Prepared, result: Result<Value, Failure>) -> Response<Body> {
    match result.and_then(|value| adapter_convert::complete(value, prepared)) {
        Ok(value) => {
            if !prepared.stream {
                let mut response = json_response(200, value);
                if !prepared.dropped.is_empty() {
                    response.headers_mut().insert(
                        "x-bridge-dropped-tools",
                        prepared
                            .dropped
                            .join(",")
                            .chars()
                            .take(500)
                            .collect::<String>()
                            .parse()
                            .unwrap(),
                    );
                }
                return response;
            }
            let mut writer = Events { sequence: 0 };
            let mut bytes = vec![];
            for event in [
                json!({"type":"response.created","response":prepared.initial}),
                json!({"type":"response.in_progress","response":prepared.initial}),
            ]
            .into_iter()
            .chain(adapter_convert::events(&value))
            {
                bytes.extend_from_slice(&writer.encode(event));
            }
            sse(
                http_body_util::Full::new(Bytes::from(bytes)).boxed_unsync(),
                &prepared.dropped,
            )
        }
        Err(error) => {
            log(app, &error);
            json_response(error.status, failure(error, None, false))
        }
    }
}
async fn send_events(
    sender: &mpsc::Sender<Bytes>,
    writer: &mut Events,
    events: Vec<Value>,
) -> bool {
    for event in events {
        if sender.send(writer.encode(event)).await.is_err() {
            return false;
        }
    }
    true
}
async fn stream_result(
    app: Arc<App>,
    prepared: Prepared,
    mut request: Upstream,
    sender: mpsc::Sender<Bytes>,
) {
    let mut writer = Events { sequence: 0 };
    let initial = vec![
        json!({"type":"response.created","response":prepared.initial}),
        json!({"type":"response.in_progress","response":prepared.initial}),
    ];
    if !send_events(&sender, &mut writer, initial).await {
        return;
    }
    let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
    let mut heartbeat = tokio::time::interval_at(deadline, Duration::from_secs(10));
    loop {
        tokio::select! {
            _ = sender.closed() => return,
            _ = heartbeat.tick() => {
                let event = json!({"type":"response.in_progress","response":prepared.initial});
                if !send_events(&sender, &mut writer, vec![event]).await { return; }
            }
            result = &mut request => {
                let events = match result.and_then(|value| adapter_convert::complete(value, &prepared)) {
                    Ok(value) => adapter_convert::events(&value),
                    Err(error) => {
                        log(&app, &error);
                        vec![failure(error, Some(&prepared.initial), true)]
                    }
                };
                send_events(&sender, &mut writer, events).await;
                return;
            }
        }
    }
}
fn streaming(app: Arc<App>, prepared: Prepared, request: Upstream) -> Response<Body> {
    let (sender, receiver) = mpsc::channel(2);
    let dropped = prepared.dropped.clone();
    let task = tokio::spawn(stream_result(app, prepared, request, sender));
    let body = StreamingBody {
        receiver,
        task: task.abort_handle(),
    };
    sse(body.boxed_unsync(), &dropped)
}
pub async fn handle(req: Request<Incoming>, app: Arc<App>, settings: Value) -> Response<Body> {
    let target = &settings["target"];
    if target.is_null() {
        return json_response(
            503,
            json!({"error":{"message":"No adapter target configured","type":"api_error"}}),
        );
    }
    let provider = crate::config_store::load(&app.bridge).ok().and_then(|s| {
        s["providers"].as_array().and_then(|rows| {
            rows.iter()
                .find(|p| p["id"] == target["providerId"])
                .cloned()
        })
    });
    let Some(mut provider) = provider else {
        return json_response(
            503,
            json!({"error":{"message":"Adapter provider was deleted","type":"api_error"}}),
        );
    };
    if target["apiMode"].is_string() {
        provider["apiMode"] = target["apiMode"].clone();
    }
    let model = target["model"]
        .as_str()
        .or(provider["model"].as_str())
        .unwrap_or("")
        .to_owned();
    let timeout = provider["timeoutMs"]
        .as_u64()
        .filter(|n| *n > 0)
        .unwrap_or(600000);
    let mut body = req.into_body();
    let mut bytes = vec![];
    while let Some(frame) = body.frame().await {
        match frame {
            Ok(frame) => {
                if let Some(data) = frame.data_ref() {
                    if bytes.len() + data.len() > 64 * 1024 * 1024 {
                        return json_response(
                            413,
                            failure(
                                Failure {
                                    status: 413,
                                    message: "Upstream request failed or returned unsupported data"
                                        .into(),
                                    upstream: false,
                                },
                                None,
                                false,
                            ),
                        );
                    }
                    bytes.extend_from_slice(data);
                }
            }
            Err(_) => return json_response(502, failure(Failure::unsupported(), None, false)),
        }
    }
    let prepared = match serde_json::from_slice::<Value>(&bytes)
        .map_err(|_| Failure::bad("Malformed JSON"))
        .and_then(|b| adapter_convert::prepare(&b, &provider, &model))
    {
        Ok(p) => p,
        Err(e) => return json_response(e.status, failure(e, None, false)),
    };
    let payload = prepared.payload.clone();
    let anthropic = prepared.anthropic;
    let mut request: Upstream = Box::pin(async move {
        match tokio::time::timeout(
            Duration::from_millis(timeout),
            upstream(provider, payload, anthropic),
        )
        .await
        {
            Ok(result) => result,
            Err(_) => Err(Failure {
                status: 504,
                message: "Upstream request timed out".into(),
                upstream: false,
            }),
        }
    });
    if !prepared.stream {
        return finished(&app, &prepared, request.await);
    }
    tokio::select! {
        result = &mut request => finished(&app, &prepared, result),
        _ = tokio::time::sleep(Duration::from_secs(5)) => streaming(app, prepared, request),
    }
}
