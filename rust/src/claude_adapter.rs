//! Buffered Anthropic Messages to OpenAI adapter for Claude Code.
use crate::{
    adapter_convert::{self, Failure},
    server::{App, Body, response},
};
use http_body_util::{BodyExt, Full};
use hyper::{
    Request, Response,
    body::{Bytes, Frame, Incoming},
};
use serde_json::{Value, json};
use std::{
    convert::Infallible,
    future::Future,
    pin::Pin,
    sync::Arc,
    task::{Context, Poll},
    time::Duration,
};
use tokio::sync::mpsc;

fn error(status: u16, message: &str) -> Response<Body> {
    response(status, "application/json", serde_json::to_vec(&json!({"type":"error","error":{"type":match status {400=>"invalid_request_error",401=>"authentication_error",404=>"not_found_error",429=>"rate_limit_error",_=>"api_error"},"message":message}})).unwrap())
}
pub fn reject(status: u16, message: &str) -> Response<Body> {
    error(status, message)
}
fn log_failure(app: &App, failure: &Failure) {
    if failure.upstream {
        crate::adapter::log(
            app,
            &Failure {
                status: failure.status,
                message: format!("上游 HTTP {}", failure.status),
                upstream: true,
            },
        );
    } else {
        crate::adapter::log(app, failure);
    }
}
fn text(value: &Value) -> &str {
    value.as_str().unwrap_or("")
}
fn block_text(value: &Value) -> String {
    if let Some(s) = value.as_str() {
        return s.to_owned();
    }
    value
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|v| v["text"].as_str())
        .collect::<Vec<_>>()
        .join("\n")
}
fn to_responses(body: &Value) -> Result<Value, Failure> {
    let mut input = Vec::new();
    for msg in body["messages"]
        .as_array()
        .ok_or_else(|| Failure::bad("messages must be an array"))?
    {
        let role = text(&msg["role"]);
        if !["user", "assistant"].contains(&role) {
            return Err(Failure::bad("Invalid message role"));
        }
        let blocks = if let Some(s) = msg["content"].as_str() {
            vec![json!({"type":"text","text":s})]
        } else {
            msg["content"]
                .as_array()
                .cloned()
                .ok_or_else(|| Failure::bad("Invalid message content"))?
        };
        let mut parts = Vec::new();
        for block in blocks {
            match text(&block["type"]) {
                "text" => parts.push(json!({"type":if role=="assistant"{"output_text"}else{"input_text"},"text":block["text"]})),
                "image" => {
                    let source=&block["source"];
                    let url=if source["type"]=="base64" {format!("data:{};base64,{}",text(&source["media_type"]),text(&source["data"]))} else {text(&source["url"]).to_owned()};
                    parts.push(json!({"type":"input_image","image_url":url}));
                }
                "tool_use" | "tool_result" => {
                    if !parts.is_empty() { input.push(json!({"type":"message","role":role,"content":std::mem::take(&mut parts)})); }
                    if block["type"]=="tool_use" {
                        input.push(json!({"type":"function_call","call_id":block["id"],"name":block["name"],"arguments":block["input"].to_string()}));
                    } else {
                        let result=block_text(&block["content"]);
                        input.push(json!({"type":"function_call_output","call_id":block["tool_use_id"],"output":if block["is_error"]==true{format!("[error] {result}")}else{result}}));
                    }
                }
                "thinking" | "redacted_thinking" => {}
                _ => {}
            }
        }
        if !parts.is_empty() {
            input.push(json!({"type":"message","role":role,"content":parts}));
        }
    }
    let mut out = json!({"model":body["model"],"input":input,"store":false,"stream":false});
    let system = block_text(&body["system"]);
    if !system.is_empty() {
        out["instructions"] = json!(system);
    }
    if let Some(max) = body.get("max_tokens") {
        out["max_output_tokens"] = max.clone();
    }
    let tools=body["tools"].as_array().into_iter().flatten().filter(|t|t["name"].is_string() && (t["type"].is_null() || t["type"]=="custom")).map(|t|json!({"type":"function","name":t["name"],"description":t["description"],"parameters":t["input_schema"]})).collect::<Vec<_>>();
    if !tools.is_empty() {
        out["tools"] = json!(tools);
    }
    if let Some(choice) = body.get("tool_choice") {
        out["tool_choice"] = match text(&choice["type"]) {
            "any" => json!("required"),
            "none" => json!("none"),
            "tool" => json!({"type":"function","name":choice["name"]}),
            _ => json!("auto"),
        };
    }
    Ok(out)
}
fn to_anthropic(reply: &Value, model: &str, id: &str) -> Result<Value, Failure> {
    let mut content = Vec::new();
    for item in reply["output"]
        .as_array()
        .ok_or_else(Failure::unsupported)?
    {
        if item["type"] == "message" {
            for block in item["content"].as_array().into_iter().flatten() {
                if block["type"] == "output_text" {
                    content.push(json!({"type":"text","text":block["text"]}));
                }
            }
        } else if item["type"] == "function_call" {
            let args = serde_json::from_str::<Value>(text(&item["arguments"]))
                .map_err(|_| Failure::unsupported())?;
            if !args.is_object() {
                return Err(Failure::unsupported());
            }
            content.push(
                json!({"type":"tool_use","id":item["call_id"],"name":item["name"],"input":args}),
            );
        }
    }
    let stop = if content.iter().any(|v| v["type"] == "tool_use") {
        "tool_use"
    } else if reply["status"] == "incomplete" {
        "max_tokens"
    } else {
        "end_turn"
    };
    Ok(
        json!({"id":id,"type":"message","role":"assistant","model":model,"content":content,"stop_reason":stop,"stop_sequence":null,"usage":{"input_tokens":reply["usage"]["input_tokens"].as_u64().unwrap_or(0),"output_tokens":reply["usage"]["output_tokens"].as_u64().unwrap_or(0)}}),
    )
}
fn events(message: &Value) -> Vec<Value> {
    let mut result = vec![
        json!({"type":"message_start","message":{"id":message["id"],"type":"message","role":"assistant","model":message["model"],"content":[],"stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":message["usage"]["input_tokens"],"output_tokens":0}}}),
    ];
    for (index, block) in message["content"]
        .as_array()
        .into_iter()
        .flatten()
        .enumerate()
    {
        if block["type"] == "text" {
            result.push(json!({"type":"content_block_start","index":index,"content_block":{"type":"text","text":""}}));
            result.push(json!({"type":"content_block_delta","index":index,"delta":{"type":"text_delta","text":block["text"]}}));
        } else {
            result.push(json!({"type":"content_block_start","index":index,"content_block":{"type":"tool_use","id":block["id"],"name":block["name"],"input":{}}}));
            result.push(json!({"type":"content_block_delta","index":index,"delta":{"type":"input_json_delta","partial_json":block["input"].to_string()}}));
        }
        result.push(json!({"type":"content_block_stop","index":index}));
    }
    result.push(json!({"type":"message_delta","delta":{"stop_reason":message["stop_reason"],"stop_sequence":null},"usage":{"input_tokens":message["usage"]["input_tokens"],"output_tokens":message["usage"]["output_tokens"]}}));
    result.push(json!({"type":"message_stop"}));
    result
}
fn encode(value: &Value) -> Bytes {
    Bytes::from(format!(
        "event: {}\ndata: {}\n\n",
        text(&value["type"]),
        value
    ))
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
fn sse(body: Body) -> Response<Body> {
    Response::builder()
        .status(200)
        .header("content-type", "text/event-stream; charset=utf-8")
        .header("cache-control", "no-cache")
        .body(body)
        .unwrap()
}
type Upstream = Pin<Box<dyn Future<Output = Result<Value, Failure>> + Send>>;
fn upstream_error(status: u16, body: &str) -> String {
    let parsed = serde_json::from_str::<Value>(body).ok();
    let detail = parsed
        .as_ref()
        .and_then(|v| v["error"]["message"].as_str())
        .map(str::to_owned)
        .unwrap_or_else(|| body.chars().take(300).collect());
    format!("上游 HTTP {status}：{detail}")
}
async fn request(provider: Value, payload: Value) -> Result<Value, Failure> {
    let mode = text(&provider["apiMode"]);
    let suffix = if mode == "responses" {
        "/responses"
    } else {
        "/chat/completions"
    };
    let base = text(&provider["baseUrl"]).trim_end_matches('/');
    let response = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .no_proxy()
        .build()
        .map_err(|_| Failure::unsupported())?
        .post(format!("{base}{suffix}"))
        .bearer_auth(text(&provider["apiKey"]))
        .json(&payload)
        .send()
        .await
        .map_err(|_| Failure::unsupported())?;
    let status = response.status().as_u16();
    if !(200..300).contains(&status) {
        let body = response.text().await.unwrap_or_default();
        return Err(Failure {
            status: if status >= 400 { status } else { 502 },
            message: upstream_error(status, &body),
            upstream: true,
        });
    }
    response.json().await.map_err(|_| Failure::unsupported())
}
pub async fn handle(req: Request<Incoming>, app: Arc<App>, _settings: Value) -> Response<Body> {
    let current = crate::config_store::read_json(&app.bridge.join("claude-current.json"))
        .unwrap_or(Value::Null);
    let provider = crate::config_store::load(&app.bridge).ok().and_then(|s| {
        s["providers"]
            .as_array()
            .and_then(|p| p.iter().find(|p| p["id"] == current["providerId"]).cloned())
    });
    let Some(provider) = provider else {
        return error(503, "No Claude Code adapter target configured");
    };
    let mut bytes = Vec::new();
    let mut body = req.into_body();
    while let Some(frame) = body.frame().await {
        match frame {
            Ok(f) => {
                if let Some(data) = f.data_ref() {
                    if bytes.len() + data.len() > 64 * 1024 * 1024 {
                        return error(413, "Request too large");
                    };
                    bytes.extend_from_slice(data)
                }
            }
            Err(_) => return error(400, "Invalid request body"),
        }
    }
    let source = match serde_json::from_slice::<Value>(&bytes) {
        Ok(v) => v,
        Err(_) => return error(400, "Malformed JSON"),
    };
    if !source["model"].is_string() || text(&source["model"]).is_empty() {
        return error(400, "model 为必填项");
    }
    let model = text(&source["model"]).to_owned();
    let message_id = format!("msg_{}", crate::editors::uuid().unwrap());
    let start = json!({"type":"message_start","message":{"id":message_id,"type":"message","role":"assistant","model":model,"content":[],"stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":0,"output_tokens":0}}});
    let stream = source["stream"] == true;
    let response_input = match to_responses(&source) {
        Ok(v) => v,
        Err(e) => return error(e.status, &e.message),
    };
    let is_chat = provider["apiMode"] == "chat_completions";
    let prepared = if is_chat {
        match adapter_convert::prepare(&response_input, &provider, &model) {
            Ok(p) => Some(p),
            Err(e) => return error(e.status, &e.message),
        }
    } else {
        None
    };
    let payload = prepared
        .as_ref()
        .map(|p| p.payload.clone())
        .unwrap_or(response_input);
    let timeout = provider["timeoutMs"]
        .as_u64()
        .filter(|n| *n > 0)
        .unwrap_or(600000);
    let mut future: Upstream = Box::pin(async move {
        let reply =
            tokio::time::timeout(Duration::from_millis(timeout), request(provider, payload))
                .await
                .map_err(|_| Failure::unsupported())??;
        let normalized = if let Some(p) = prepared {
            adapter_convert::complete(reply, &p)?
        } else {
            reply
        };
        to_anthropic(&normalized, &model, &message_id)
    });
    if !stream {
        return match future.await {
            Ok(v) => response(200, "application/json", serde_json::to_vec(&v).unwrap()),
            Err(e) => {
                log_failure(&app, &e);
                error(e.status, &e.message)
            }
        };
    }
    tokio::select! {
        result = &mut future => match result {
            Ok(v) => sse(Full::new(Bytes::from(events(&v).iter().flat_map(|v| encode(v).to_vec()).collect::<Vec<_>>())).boxed_unsync()),
            Err(e) => { log_failure(&app, &e); error(e.status, &e.message) }
        },
        _ = tokio::time::sleep(Duration::from_secs(5)) => {
            let (sender, receiver) = mpsc::channel(2);
            let task = tokio::spawn(async move {
                if sender.send(encode(&start)).await.is_err() { return; }
                let mut ping = tokio::time::interval_at(tokio::time::Instant::now() + Duration::from_secs(10), Duration::from_secs(10));
                loop {
                    tokio::select! {
                        _ = sender.closed() => return,
                        _ = ping.tick() => if sender.send(encode(&json!({"type":"ping"}))).await.is_err() { return; },
                        result = &mut future => {
                            let values = match result {
                                Ok(v) => events(&v).into_iter().skip(1).collect(),
                                Err(e) => { log_failure(&app, &e); vec![json!({"type":"error","error":{"type":"api_error","message":e.message}})] }
                            };
                            for value in values { if sender.send(encode(&value)).await.is_err() { return; } }
                            return;
                        }
                    }
                }
            });
            sse(StreamingBody { receiver, task: task.abort_handle() }.boxed_unsync())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sampling_parameters_are_omitted() {
        let value = to_responses(&json!({"model":"m","messages":[],"temperature":0.5,"top_p":0.8}))
            .unwrap();
        assert!(value.get("temperature").is_none() && value.get("top_p").is_none());
        let chat =
            adapter_convert::prepare(&value, &json!({"apiMode":"chat_completions"}), "m").unwrap();
        assert!(chat.payload.get("temperature").is_none() && chat.payload.get("top_p").is_none());
    }

    #[test]
    fn upstream_error_reports_message_or_truncated_body() {
        assert_eq!(
            upstream_error(400, r#"{"error":{"message":"余额不足"}}"#),
            "上游 HTTP 400：余额不足"
        );
        assert_eq!(
            upstream_error(503, &"错".repeat(301)),
            format!("上游 HTTP 503：{}", "错".repeat(300))
        );
    }

    #[test]
    fn messages_with_image_and_tool_round_trip_map_to_openai_chat() {
        let input = json!({"model":"fixture","max_tokens":100,"system":[{"type":"text","text":"system"}],"messages":[
            {"role":"user","content":[{"type":"text","text":"look"},{"type":"image","source":{"type":"base64","media_type":"image/png","data":"YWJj"}}]},
            {"role":"assistant","content":[{"type":"tool_use","id":"call1","name":"Read","input":{"file_path":"/tmp/a"}}]},
            {"role":"user","content":[{"type":"tool_result","tool_use_id":"call1","is_error":true,"content":[{"type":"text","text":"failed"}]}]}
        ],"tools":[{"name":"Read","input_schema":{"type":"object","properties":{}}},{"type":"web_search_20250305","name":"web_search"}],"tool_choice":{"type":"auto"}});
        let normalized = to_responses(&input).unwrap();
        let prepared = adapter_convert::prepare(
            &normalized,
            &json!({"apiMode":"chat_completions"}),
            "fixture",
        )
        .unwrap();
        assert_eq!(
            prepared.payload["messages"][1]["content"][1]["image_url"]["url"],
            "data:image/png;base64,YWJj"
        );
        assert_eq!(
            prepared.payload["messages"][2]["tool_calls"][0]["id"],
            "call1"
        );
        assert_eq!(prepared.payload["messages"][3]["content"], "[error] failed");
        assert_eq!(prepared.payload["tools"].as_array().unwrap().len(), 1);
        assert_eq!(prepared.payload["max_completion_tokens"], 100);
    }

    #[test]
    fn tool_call_response_and_stream_events_have_anthropic_shape() {
        let reply = json!({"status":"completed","output":[{"type":"message","content":[{"type":"output_text","text":"hello"}]},{"type":"function_call","call_id":"call1","name":"Read","arguments":"{\"path\":\"x\"}"}],"usage":{"input_tokens":7,"output_tokens":4}});
        let message = to_anthropic(&reply, "fixture", "msg_fixture").unwrap();
        assert_eq!(message["stop_reason"], "tool_use");
        assert_eq!(message["content"][1]["input"]["path"], "x");
        assert_eq!(message["usage"]["input_tokens"], 7);
        let rows = events(&message);
        let names = rows.iter().map(|v| text(&v["type"])).collect::<Vec<_>>();
        assert_eq!(
            names,
            [
                "message_start",
                "content_block_start",
                "content_block_delta",
                "content_block_stop",
                "content_block_start",
                "content_block_delta",
                "content_block_stop",
                "message_delta",
                "message_stop"
            ]
        );
        assert_eq!(rows[5]["delta"]["type"], "input_json_delta");
    }
}
