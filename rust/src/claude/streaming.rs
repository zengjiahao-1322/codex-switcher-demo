use super::adapter::{
    StreamingBody, encode, error, log_failure, request_headers, sse, text, to_responses,
};
use crate::{
    adapter_convert::{self, Failure},
    server::{App, Body},
};
use http_body_util::BodyExt;
use hyper::{Response, body::Bytes};
use serde_json::{Value, json};
use std::{collections::BTreeMap, sync::Arc, time::Duration};
use tokio::sync::mpsc;

fn stream_failure(message: &str) -> Failure {
    Failure {
        status: 502,
        message: message.to_owned(),
        upstream: false,
    }
}
struct Translator {
    active: Option<(String, bool)>,
    next: u64,
    thinking: bool,
    tools: BTreeMap<u64, Value>,
    used_tool: bool,
    reason: String,
    usage: Value,
    done: bool,
}
impl Translator {
    fn new(thinking: bool) -> Self {
        Self {
            active: None,
            next: 0,
            thinking,
            tools: BTreeMap::new(),
            used_tool: false,
            reason: "end_turn".into(),
            usage: json!({"input_tokens":0,"output_tokens":0,"cache_read_input_tokens":0}),
            done: false,
        }
    }
    fn close(&mut self, out: &mut Vec<Value>) {
        if let Some((_, thinking)) = self.active.take() {
            if thinking {
                out.push(json!({"type":"content_block_delta","index":self.next-1,"delta":{"type":"signature_delta","signature":"codex-switcher"}}));
            }
            out.push(json!({"type":"content_block_stop","index":self.next-1}));
        }
    }
    fn delta(&mut self, key: String, value: &str, thinking: bool, out: &mut Vec<Value>) {
        if value.is_empty() || (thinking && !self.thinking) {
            return;
        }
        if self.active.as_ref().is_none_or(|(k, _)| *k != key) {
            self.close(out);
            out.push(json!({"type":"content_block_start","index":self.next,"content_block":if thinking {json!({"type":"thinking","thinking":""})}else{json!({"type":"text","text":""})}}));
            self.next += 1;
            self.active = Some((key, thinking));
        }
        out.push(json!({"type":"content_block_delta","index":self.next-1,"delta":if thinking {json!({"type":"thinking_delta","thinking":value})}else{json!({"type":"text_delta","text":value})}}));
    }
    fn tool(&mut self, tool: &Value, out: &mut Vec<Value>) -> Result<(), Failure> {
        let args = text(&tool["arguments"]);
        if !serde_json::from_str::<Value>(args).is_ok_and(|v| v.is_object())
            || text(&tool["id"]).is_empty()
            || text(&tool["name"]).is_empty()
        {
            return Err(Failure::unsupported());
        }
        self.close(out);
        self.used_tool = true;
        out.push(json!({"type":"content_block_start","index":self.next,"content_block":{"type":"tool_use","id":tool["id"],"name":tool["name"],"input":{}}}));
        out.push(json!({"type":"content_block_delta","index":self.next,"delta":{"type":"input_json_delta","partial_json":args}}));
        out.push(json!({"type":"content_block_stop","index":self.next}));
        self.next += 1;
        Ok(())
    }
    fn finish(&mut self, out: &mut Vec<Value>) {
        self.close(out);
        out.push(json!({"type":"message_delta","delta":{"stop_reason":if self.used_tool {"tool_use"}else{&self.reason},"stop_sequence":null},"usage":self.usage}));
        out.push(json!({"type":"message_stop"}));
        self.done = true;
    }
    fn consume(&mut self, event: &Value, chat: bool) -> Result<Vec<Value>, Failure> {
        let mut out = vec![];
        if event["type"] == "response.failed" {
            return Err(stream_failure(text(&event["response"]["error"]["message"])));
        }
        if !event["error"].is_null() || event["type"] == "error" {
            let message = if event["type"] == "error" {
                event["message"]
                    .as_str()
                    .or(event["error"]["message"].as_str())
            } else {
                event["error"]["message"].as_str()
            };
            return Err(stream_failure(message.ok_or_else(Failure::unsupported)?));
        }
        if chat {
            if let Some(u) = event.get("usage").filter(|v| v.is_object()) {
                self.usage = json!({"input_tokens":u["prompt_tokens"].as_u64().unwrap_or(0),"output_tokens":u["completion_tokens"].as_u64().unwrap_or(0),"cache_read_input_tokens":u["prompt_tokens_details"]["cached_tokens"].as_u64().unwrap_or(0)});
            }
            let choice = &event["choices"][0];
            let delta = &choice["delta"];
            self.delta(
                "thinking".into(),
                text(&delta["reasoning_content"]),
                true,
                &mut out,
            );
            self.delta("text".into(), text(&delta["content"]), false, &mut out);
            for call in delta["tool_calls"].as_array().into_iter().flatten() {
                let index = call["index"].as_u64().ok_or_else(Failure::unsupported)?;
                let tool = self
                    .tools
                    .entry(index)
                    .or_insert_with(|| json!({"id":"","name":"","arguments":""}));
                for (key, value) in [
                    ("id", &call["id"]),
                    ("name", &call["function"]["name"]),
                    ("arguments", &call["function"]["arguments"]),
                ] {
                    if let Some(s) = value.as_str() {
                        tool[key] = json!(format!("{}{s}", text(&tool[key])));
                    }
                }
            }
            if let Some(reason) = choice["finish_reason"].as_str() {
                if reason == "length" {
                    self.reason = "max_tokens".into();
                }
                for (_, tool) in std::mem::take(&mut self.tools) {
                    self.tool(&tool, &mut out)?;
                }
                self.close(&mut out);
            }
        } else {
            let index = event["output_index"].as_u64().unwrap_or(0);
            match text(&event["type"]) {
                "response.output_text.delta" => self.delta(
                    format!("text:{index}"),
                    text(&event["delta"]),
                    false,
                    &mut out,
                ),
                "response.reasoning_summary_text.delta" => self.delta(
                    format!("thinking:{index}"),
                    text(&event["delta"]),
                    true,
                    &mut out,
                ),
                "response.output_item.done" => {
                    if event["item"]["type"] == "function_call" {
                        let item = &event["item"];
                        let tool = json!({"id":item["call_id"],"name":item["name"],"arguments":item["arguments"]});
                        self.tool(&tool, &mut out)?;
                    } else {
                        self.close(&mut out);
                    }
                }
                "response.completed" | "response.incomplete" => {
                    let reply = &event["response"];
                    if reply["status"] == "incomplete" || event["type"] == "response.incomplete" {
                        self.reason = "max_tokens".into();
                    }
                    self.usage = json!({"input_tokens":reply["usage"]["input_tokens"].as_u64().unwrap_or(0),"output_tokens":reply["usage"]["output_tokens"].as_u64().unwrap_or(0),"cache_read_input_tokens":reply["usage"]["input_tokens_details"]["cached_tokens"].as_u64().unwrap_or(0)});
                    self.finish(&mut out);
                }
                _ => {}
            }
        }
        Ok(out)
    }
}
async fn send(sender: &mpsc::Sender<Bytes>, values: Vec<Value>) -> Result<(), Failure> {
    for value in values {
        sender
            .send(encode(&value))
            .await
            .map_err(|_| Failure::unsupported())?;
    }
    Ok(())
}
async fn pump(
    mut upstream: reqwest::Response,
    sender: &mpsc::Sender<Bytes>,
    chat: bool,
    thinking: bool,
) -> Result<(), Failure> {
    let mut state = Translator::new(thinking);
    let mut buffer = Vec::new();
    let mut data = String::new();
    let mut finished = false;
    let mut idle = Box::pin(tokio::time::sleep(Duration::from_secs(10)));
    'read: loop {
        tokio::select! {
            _ = sender.closed() => return Ok(()),
            _ = &mut idle => {
                send(sender, vec![json!({"type":"ping"})]).await?;
                idle.as_mut().reset(tokio::time::Instant::now() + Duration::from_secs(10));
            },
            chunk = upstream.chunk() => {
                let Some(chunk) = chunk.map_err(|_| stream_failure("上游连接中断"))? else {
                    break;
                };
                idle.as_mut().reset(tokio::time::Instant::now() + Duration::from_secs(10));
                buffer.extend_from_slice(&chunk);
                while let Some(pos) = buffer.iter().position(|b| *b == b'\n') {
                    let bytes = buffer.drain(..=pos).collect::<Vec<_>>();
                    let line = std::str::from_utf8(&bytes)
                        .map_err(|_| Failure::unsupported())?
                        .trim_end_matches(['\r', '\n']);
                    if line.is_empty() {
                        if data.is_empty() {
                            continue;
                        }
                        if data.trim() == "[DONE]" {
                            break 'read;
                        }
                        let event: Value = serde_json::from_str(&data)
                            .map_err(|_| Failure::unsupported())?;
                        data.clear();
                        if chat && event["choices"][0]["finish_reason"].is_string() {
                            finished = true;
                        }
                        let values = state.consume(&event, chat)?;
                        send(sender, values).await?;
                        if state.done {
                            return Ok(());
                        }
                    } else if let Some(value) = line.strip_prefix("data:") {
                        if !data.is_empty() {
                            data.push('\n');
                        }
                        data.push_str(value.trim_start());
                    }
                }
            }
        }
    }
    if chat && finished {
        let mut values = vec![];
        state.finish(&mut values);
        send(sender, values).await?;
        Ok(())
    } else {
        Err(stream_failure("上游连接中断"))
    }
}
pub(super) async fn handle(
    provider: Value,
    source: Value,
    id: String,
    app: Arc<App>,
) -> Response<Body> {
    let chat = provider["apiMode"] == "chat_completions";
    let model = text(&source["model"]);
    let payload = (|| {
        let input = to_responses(&source)?;
        let mut p = if chat {
            adapter_convert::prepare(&input, &provider, model)?.payload
        } else {
            input
        };
        p["stream"] = json!(true);
        if chat {
            p["stream_options"] = json!({"include_usage":true});
        }
        Ok::<_, Failure>(p)
    })();
    let payload = match payload {
        Ok(p) => p,
        Err(e) => return error(e.status, &e.message),
    };
    let timeout = provider["timeoutMs"]
        .as_u64()
        .filter(|n| *n > 0)
        .unwrap_or(600000);
    let deadline = tokio::time::Instant::now() + Duration::from_millis(timeout);
    let upstream =
        match tokio::time::timeout_at(deadline, request_headers(&provider, &payload)).await {
            Ok(Ok(r)) => r,
            Ok(Err(e)) => {
                log_failure(&app, &e);
                return error(e.status, &e.message);
            }
            Err(_) => return error(504, "Upstream request timed out"),
        };
    let start = json!({"type":"message_start","message":{"id":id,"type":"message","role":"assistant","model":model,"content":[],"stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":0,"output_tokens":0}}});
    let thinking = source["thinking"]["type"]
        .as_str()
        .is_some_and(|v| v != "disabled");
    let (sender, receiver) = mpsc::channel(2);
    let task = tokio::spawn(async move {
        if send(&sender, vec![start]).await.is_err() {
            return;
        }
        let result =
            tokio::time::timeout_at(deadline, pump(upstream, &sender, chat, thinking)).await;
        let failure = match result {
            Ok(Ok(())) => return,
            Ok(Err(e)) => e,
            Err(_) => Failure {
                status: 504,
                message: "Upstream request timed out".into(),
                upstream: false,
            },
        };
        log_failure(&app, &failure);
        let _ = send(
            &sender,
            vec![json!({"type":"error","error":{"type":"api_error","message":failure.message}})],
        )
        .await;
    });
    sse(StreamingBody {
        receiver,
        task: task.abort_handle(),
    }
    .boxed_unsync())
}
