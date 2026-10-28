//! Stateless Responses conversion. These structures never contain credentials.
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::collections::HashMap;

#[derive(Debug)]
pub struct Failure {
    pub status: u16,
    pub message: String,
    pub upstream: bool,
}
impl Failure {
    pub fn bad(message: impl Into<String>) -> Self {
        Self {
            status: 400,
            message: message.into(),
            upstream: false,
        }
    }
    pub fn unsupported() -> Self {
        Self {
            status: 502,
            message: "Upstream request failed or returned unsupported data".into(),
            upstream: false,
        }
    }
}
type Result<T> = std::result::Result<T, Failure>;
pub struct Prepared {
    pub payload: Value,
    pub initial: Value,
    pub dropped: Vec<String>,
    pub stream: bool,
    pub anthropic: bool,
    back: HashMap<String, Value>,
}
fn text(v: &Value) -> &str {
    v.as_str().unwrap_or("")
}
fn object(v: &Value) -> bool {
    v.is_object()
}
fn present(v: &Value) -> bool {
    !v.is_null() && v != false && v != "" && v != 0
}
fn id(prefix: &str) -> String {
    format!("{prefix}_{}", crate::editors::uuid().unwrap())
}
fn alias(name: &str) -> String {
    if !name.is_empty()
        && name.len() <= 64
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
    {
        return name.into();
    }
    let start = name
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '_' || c == '-' {
                c
            } else {
                '_'
            }
        })
        .take(55)
        .collect::<String>();
    format!(
        "{start}_{}",
        &format!("{:x}", Sha256::digest(name.as_bytes()))[..8]
    )
}
fn flat(name: &str, namespace: Option<&str>) -> String {
    alias(
        &namespace
            .filter(|s| !s.is_empty())
            .map_or_else(|| name.into(), |ns| format!("{ns}__{name}")),
    )
}
fn arguments(value: &str) -> Result<Value> {
    serde_json::from_str::<Value>(value)
        .ok()
        .filter(object)
        .ok_or_else(|| Failure::bad("Function arguments must encode a JSON object"))
}
struct Tools {
    functions: Vec<Value>,
    back: HashMap<String, Value>,
    dropped: Vec<String>,
}
fn tools(body: &Value) -> Result<Tools> {
    let mut functions = vec![];
    let mut back = HashMap::new();
    let mut dropped = vec![];
    let mut add = |tool: &Value, namespace: Option<&str>| -> Result<()> {
        let kind = text(&tool["type"]);
        let name = text(&tool["name"]);
        let key = flat(name, namespace);
        if ["function", "custom"].contains(&kind) && back.contains_key(&key) {
            return Err(Failure::bad(format!(
                "Duplicate tool name after adaptation: {key}"
            )));
        }
        if kind == "function" {
            if tool.get("parameters").is_some_and(|v| !object(v)) {
                return Err(Failure::bad("Function parameters must be an object schema"));
            }
            functions.push(json!({"name":key,"description":tool["description"].as_str().unwrap_or(""),"parameters":tool.get("parameters").cloned().unwrap_or(json!({"type":"object","properties":{}})),"strict":tool["strict"]==true}));
        } else if kind == "custom" {
            let mut description = text(&tool["description"]).to_owned();
            if tool["format"]["type"] == "grammar" && tool["format"]["definition"].is_string() {
                description.push_str(&format!("\n\nThe `input` argument is raw text that must follow this {} grammar exactly:\n{}",text(&tool["format"]["syntax"]),text(&tool["format"]["definition"])));
            }
            functions.push(json!({"name":key,"description":description,"parameters":{"type":"object","properties":{"input":{"type":"string","description":"Raw tool input text"}},"required":["input"],"additionalProperties":false},"strict":false}));
        } else {
            dropped.push(format!(
                "{kind}{}",
                if name.is_empty() {
                    String::new()
                } else {
                    format!(":{name}")
                }
            ));
            return Ok(());
        }
        back.insert(key, json!({"kind":kind,"name":name,"namespace":namespace}));
        Ok(())
    };
    for tool in body["tools"].as_array().into_iter().flatten() {
        if !object(tool) || !tool["type"].is_string() {
            return Err(Failure::bad("Invalid tool"));
        }
        if tool["type"] == "namespace" {
            if !tool["name"].is_string() || !tool["tools"].is_array() {
                return Err(Failure::bad("Invalid namespace tool"));
            }
            for inner in tool["tools"].as_array().unwrap() {
                if !object(inner) {
                    return Err(Failure::bad("Invalid namespace tool"));
                }
                add(inner, tool["name"].as_str())?;
            }
        } else {
            if matches!(text(&tool["type"]), "function" | "custom") && !tool["name"].is_string() {
                return Err(Failure::bad("Tool name required"));
            }
            add(tool, None)?;
        }
    }
    Ok(Tools {
        functions,
        back,
        dropped,
    })
}
fn output_text(v: &Value) -> Result<String> {
    if let Some(s) = v.as_str() {
        return Ok(s.into());
    }
    if let Some(parts) = v.as_array() {
        return Ok(parts
            .iter()
            .map(|p| {
                p["text"].as_str().unwrap_or(if p["type"] == "input_image" {
                    "[image omitted by bridge]"
                } else {
                    ""
                })
            })
            .collect::<Vec<_>>()
            .join("\n"));
    }
    v["content"]
        .as_str()
        .map(str::to_owned)
        .ok_or_else(|| Failure::bad("Unsupported tool output"))
}
fn parts(content: &Value) -> Result<Vec<Value>> {
    if let Some(s) = content.as_str() {
        return Ok(vec![json!({"type":"text","text":s})]);
    }
    let source = content
        .as_array()
        .ok_or_else(|| Failure::bad("Message content must be text or parts"))?;
    source
        .iter()
        .map(|p| {
            if !object(p) {
                return Err(Failure::bad("Invalid content part"));
            }
            if matches!(text(&p["type"]), "input_text" | "output_text") && p["text"].is_string() {
                return Ok(json!({"type":"text","text":p["text"]}));
            }
            if p["type"] == "refusal" && p["refusal"].is_string() {
                return Ok(json!({"type":"text","text":p["refusal"]}));
            }
            if p["type"] == "input_image" {
                let url = p["image_url"]
                    .as_str()
                    .or(p["image_url"]["url"].as_str())
                    .filter(|s| !s.is_empty())
                    .ok_or_else(|| Failure::bad("Image part needs image_url"))?;
                return Ok(json!({"type":"image","url":url}));
            }
            Err(Failure::bad(format!(
                "Unsupported content part: {}",
                text(&p["type"])
            )))
        })
        .collect()
}
fn conversation(body: &Value) -> Result<Vec<Value>> {
    let mut out: Vec<Value> = vec![];
    if let Some(s) = body["instructions"].as_str().filter(|s| !s.is_empty()) {
        out.push(json!({"role":"system","parts":[{"type":"text","text":s}]}));
    }
    let source = body["input"]
        .as_array()
        .cloned()
        .unwrap_or_else(|| vec![json!({"role":"user","content":body["input"]})]);
    for item in source {
        if !object(&item) {
            return Err(Failure::bad("Invalid input item"));
        }
        let kind = item["type"].as_str().unwrap_or("message");
        if [
            "reasoning",
            "web_search_call",
            "image_generation_call",
            "compaction",
            "context_compaction",
            "compaction_trigger",
            "configuration_update",
            "tool_search_call",
            "tool_search_output",
            "additional_tools",
            "other",
        ]
        .contains(&kind)
        {
            continue;
        }
        match kind {
            "function_call" | "custom_tool_call" => {
                if item["call_id"].as_str().is_none_or(str::is_empty) || !item["name"].is_string() {
                    return Err(Failure::bad("Invalid tool call"));
                }
                let args = if kind == "function_call" {
                    let s = item["arguments"]
                        .as_str()
                        .ok_or_else(|| Failure::bad("Invalid function call"))?;
                    arguments(s)?;
                    s.to_owned()
                } else {
                    let input = item["input"]
                        .as_str()
                        .ok_or_else(|| Failure::bad("Invalid custom tool call"))?;
                    json!({"input":input}).to_string()
                };
                let call = json!({"id":item["call_id"],"name":flat(text(&item["name"]),item["namespace"].as_str()),"arguments":args});
                if let Some(last) = out.last_mut().filter(|v| v["calls"].is_array()) {
                    last["calls"].as_array_mut().unwrap().push(call);
                } else {
                    out.push(json!({"role":"assistant","calls":[call]}));
                }
            }
            "function_call_output" | "custom_tool_call_output" => {
                if item["call_id"].as_str().is_none_or(str::is_empty) {
                    return Err(Failure::bad("Tool output needs call_id"));
                }
                out.push(json!({"role":"tool","callId":item["call_id"],"text":output_text(&item["output"])?}));
            }
            "message" => {
                let role = text(&item["role"]);
                if !["user", "assistant", "system", "developer"].contains(&role) {
                    return Err(Failure::bad("Unsupported message role"));
                }
                out.push(json!({"role":if role=="developer"{"system"}else{role},"parts":parts(&item["content"])?}));
            }
            _ => return Err(Failure::bad(format!("Unsupported input item type: {kind}"))),
        }
    }
    Ok(out)
}
fn chat_messages(conv: &[Value]) -> Vec<Value> {
    conv.iter().map(|m|{
        if let Some(calls)=m["calls"].as_array(){return json!({"role":"assistant","content":null,"tool_calls":calls.iter().map(|c|json!({"id":c["id"],"type":"function","function":{"name":c["name"],"arguments":c["arguments"]}})).collect::<Vec<_>>()});}
        if m["role"]=="tool"{return json!({"role":"tool","tool_call_id":m["callId"],"content":m["text"]});}
        let parts=m["parts"].as_array().unwrap();
        let content=if m["role"]=="user"&&parts.iter().any(|p|p["type"]=="image"){
            json!(parts.iter().map(|p|if p["type"]=="text"{json!({"type":"text","text":p["text"]})}else{json!({"type":"image_url","image_url":{"url":p["url"]}})}).collect::<Vec<_>>())
        }else{json!(parts.iter().map(|p|if p["type"]=="text"{text(&p["text"])}else{"[image omitted by bridge]"}).collect::<Vec<_>>().join("\n"))};
        json!({"role":m["role"],"content":content})
    }).collect()
}
fn anthropic_payload(conv: &[Value]) -> Value {
    let system = conv
        .iter()
        .filter(|m| m["role"] == "system")
        .map(|m| {
            m["parts"]
                .as_array()
                .unwrap()
                .iter()
                .map(|p| text(&p["text"]))
                .collect::<Vec<_>>()
                .join("\n")
        })
        .collect::<Vec<_>>()
        .join("\n\n");
    let mut messages: Vec<Value> = vec![];
    for m in conv.iter().filter(|m| m["role"] != "system") {
        let (role, content) = if let Some(calls) = m["calls"].as_array() {
            ("assistant",calls.iter().map(|c|json!({"type":"tool_use","id":c["id"],"name":c["name"],"input":serde_json::from_str::<Value>(text(&c["arguments"])).unwrap()})).collect::<Vec<_>>())
        } else if m["role"] == "tool" {
            (
                "user",
                vec![json!({"type":"tool_result","tool_use_id":m["callId"],"content":m["text"]})],
            )
        } else {
            (text(&m["role"]),m["parts"].as_array().unwrap().iter().filter_map(|p|{
            if p["type"]=="text"{return (!text(&p["text"]).is_empty()).then(||json!({"type":"text","text":p["text"]}));}
            let url=text(&p["url"]);
            if let Some(rest)=url.strip_prefix("data:")&&let Some((media,data))=rest.split_once(";base64,")&& !media.contains([',',';']){Some(json!({"type":"image","source":{"type":"base64","media_type":media,"data":data}}))}
            else{Some(json!({"type":"image","source":{"type":"url","url":url}}))}
        }).collect::<Vec<_>>())
        };
        if content.is_empty() {
            continue;
        }
        if let Some(last) = messages.last_mut().filter(|v| v["role"] == role) {
            last["content"].as_array_mut().unwrap().extend(content);
        } else {
            messages.push(json!({"role":role,"content":content}));
        }
    }
    let mut result = json!({"messages":messages});
    if !system.is_empty() {
        result["system"] = json!(system);
    }
    result
}
pub fn prepare(body: &Value, provider: &Value, model: &str) -> Result<Prepared> {
    if !object(body) {
        return Err(Failure::bad("Body must be a JSON object"));
    }
    if !body["instructions"].is_null() && !body["instructions"].is_string() {
        return Err(Failure::bad("instructions must be text"));
    }
    if !body["input"].is_string() && !body["input"].is_array() {
        return Err(Failure::bad("input must be text or an array"));
    }
    if present(&body["previous_response_id"])
        || present(&body["conversation"])
        || body["background"] == true
        || body["store"] == true
    {
        return Err(Failure::bad(
            "Stateful/background/stored responses are unsupported",
        ));
    }
    if present(&body["text"]["format"]) && body["text"]["format"]["type"] != "text" {
        return Err(Failure::bad("Structured output is unsupported"));
    }
    if body.get("stream").is_some_and(|v| !v.is_boolean()) {
        return Err(Failure::bad("stream must be boolean"));
    }
    if !body["max_output_tokens"].is_null()
        && body["max_output_tokens"].as_u64().is_none_or(|n| n < 1)
    {
        return Err(Failure::bad("max_output_tokens must be a positive integer"));
    }
    if body.get("tools").is_some_and(|v| !v.is_array()) {
        return Err(Failure::bad("tools must be an array"));
    }
    if let Some(choice) = body.get("tool_choice")
        && !["auto", "none", "required"].contains(&text(choice))
        && !(object(choice) && choice["type"] == "function" && choice["name"].is_string())
    {
        return Err(Failure::bad("Unsupported tool_choice"));
    }
    if !["chat_completions", "anthropic_messages"].contains(&text(&provider["apiMode"])) {
        return Err(Failure::bad("Unsupported provider apiMode"));
    }
    let Tools {
        functions,
        back,
        dropped,
    } = tools(body)?;
    let conv = conversation(body)?;
    if body["tool_choice"].is_object()
        && !back.contains_key(&alias(text(&body["tool_choice"]["name"])))
    {
        return Err(Failure::bad("Selected tool is not defined"));
    }
    let anthropic = provider["apiMode"] == "anthropic_messages";
    let tier = if body["service_tier"] == "fast" {
        json!("priority")
    } else {
        body["service_tier"].clone()
    };
    if anthropic && present(&tier) && !["default", "auto"].contains(&text(&tier)) {
        return Err(Failure::bad(
            "Anthropic Messages conversion does not support Codex Fast",
        ));
    }
    let mut payload = if anthropic {
        let mut p = anthropic_payload(&conv);
        p["max_tokens"] = body["max_output_tokens"]
            .as_u64()
            .or(provider["maxTokens"].as_u64())
            .map_or(json!(32000), |n| json!(n));
        p
    } else {
        let mut p = json!({"messages":chat_messages(&conv)});
        if present(&tier) {
            p["service_tier"] = tier;
        }
        if present(&body["max_output_tokens"]) {
            p["max_completion_tokens"] = body["max_output_tokens"].clone();
        }
        p
    };
    payload["model"] = json!(model);
    payload["stream"] = json!(false);
    if !functions.is_empty() && !(anthropic && body["tool_choice"] == "none") {
        payload["tools"]=json!(functions.iter().map(|f|if anthropic {json!({"name":f["name"],"description":f["description"],"input_schema":f["parameters"]})}else{let mut function=f.clone();if f["strict"]!=true{function.as_object_mut().unwrap().remove("strict");}json!({"type":"function","function":function})}).collect::<Vec<_>>());
        if let Some(choice) = body.get("tool_choice") {
            if anthropic {
                if choice == "required" {
                    payload["tool_choice"] = json!({"type":"any"});
                } else if choice.is_object() {
                    payload["tool_choice"] =
                        json!({"type":"tool","name":alias(text(&choice["name"]))});
                }
            } else {
                payload["tool_choice"] = if choice.is_string() {
                    choice.clone()
                } else {
                    json!({"type":"function","function":{"name":alias(text(&choice["name"]))}})
                };
            }
        }
    }
    Ok(Prepared {
        payload,
        initial: json!({"id":id("resp"),"object":"response","created_at":time::OffsetDateTime::now_utc().unix_timestamp(),"status":"in_progress","error":null,"model":model,"output":[],"usage":null}),
        dropped,
        stream: body["stream"] == true,
        anthropic,
        back,
    })
}
pub fn complete(mut upstream: Value, prepared: &Prepared) -> Result<Value> {
    let reason = if prepared.anthropic {
        upstream["stop_reason"].clone()
    } else {
        upstream["choices"][0]["finish_reason"].clone()
    };
    let incomplete = ["length", "max_tokens", "content_filter"].contains(&text(&reason));
    if prepared.anthropic {
        let content = upstream["content"]
            .as_array()
            .ok_or_else(Failure::unsupported)?;
        if content.iter().any(|c| {
            !["text", "tool_use", "thinking", "redacted_thinking"].contains(&text(&c["type"]))
        }) {
            return Err(Failure::unsupported());
        }
        let message = content
            .iter()
            .filter(|c| c["type"] == "text")
            .map(|c| text(&c["text"]))
            .collect::<String>();
        let calls=content.iter().filter(|c|c["type"]=="tool_use").map(|c|json!({"id":c["id"],"function":{"name":c["name"],"arguments":c.get("input").filter(|v|!v.is_null()).unwrap_or(&json!({})).to_string()}})).collect::<Vec<_>>();
        let input = upstream["usage"]["input_tokens"].as_u64().unwrap_or(0);
        let output = upstream["usage"]["output_tokens"].as_u64().unwrap_or(0);
        upstream = json!({"choices":[{"message":{"content":if message.is_empty(){Value::Null}else{json!(message)},"tool_calls":calls}}],"usage":{"prompt_tokens":input,"completion_tokens":output,"total_tokens":input+output}});
    }
    let message = &upstream["choices"][0]["message"];
    if !message.is_object()
        || (!message["content"].is_null() && !message["content"].is_string())
        || present(&message["function_call"])
        || present(&message["audio"])
    {
        return Err(Failure::unsupported());
    }
    let mut output = vec![];
    if let Some(s) = message["content"].as_str().filter(|s| !s.is_empty()) {
        output.push(json!({"id":id("msg"),"type":"message","role":"assistant","status":"completed","content":[{"type":"output_text","text":s,"annotations":[]}]}));
    }
    if message
        .get("tool_calls")
        .is_some_and(|v| !v.is_null() && !v.is_array())
    {
        return Err(Failure::unsupported());
    }
    for tool in message["tool_calls"].as_array().into_iter().flatten() {
        if tool["id"].as_str().is_none_or(str::is_empty)
            || !tool["function"]["name"].is_string()
            || !tool["function"]["arguments"].is_string()
        {
            return Err(Failure::unsupported());
        }
        let raw = text(&tool["function"]["arguments"]);
        let raw = if raw.is_empty() { "{}" } else { raw };
        let args = arguments(raw).map_err(|_| Failure::unsupported())?;
        let fallback = json!({"kind":"function","name":tool["function"]["name"],"namespace":null});
        let target = prepared
            .back
            .get(text(&tool["function"]["name"]))
            .unwrap_or(&fallback);
        let mut item = if target["kind"] == "custom" {
            let input = args["input"].as_str().ok_or_else(Failure::unsupported)?;
            json!({"id":id("ctc"),"type":"custom_tool_call","status":"completed","call_id":tool["id"],"name":target["name"],"input":input})
        } else {
            json!({"id":id("fc"),"type":"function_call","status":"completed","call_id":tool["id"],"name":target["name"],"arguments":raw})
        };
        if target["kind"] != "custom" && present(&target["namespace"]) {
            item["namespace"] = target["namespace"].clone();
        }
        output.push(item);
    }
    let mut response = prepared.initial.clone();
    response["status"] = json!(if incomplete {
        "incomplete"
    } else {
        "completed"
    });
    response["incomplete_details"] = if incomplete {
        json!({"reason":if reason=="content_filter"{"content_filter"}else{"max_output_tokens"}})
    } else {
        Value::Null
    };
    response["output"] = json!(output);
    if upstream["service_tier"].is_string() {
        response["service_tier"] = upstream["service_tier"].clone();
    }
    let input = upstream["usage"]["prompt_tokens"].as_u64().unwrap_or(0);
    let output = upstream["usage"]["completion_tokens"].as_u64().unwrap_or(0);
    response["usage"] = json!({"input_tokens":input,"output_tokens":output,"total_tokens":upstream["usage"]["total_tokens"].as_u64().filter(|n|*n>0).unwrap_or(input+output)});
    Ok(response)
}
pub fn events(response: &Value) -> Vec<Value> {
    let mut events = vec![];
    for (index, item) in response["output"].as_array().unwrap().iter().enumerate() {
        let common = json!({"item_id":item["id"],"output_index":index});
        let mut added = item.clone();
        added["status"] = json!("in_progress");
        let kind = text(&item["type"]);
        added[if kind == "message" {
            "content"
        } else if kind == "function_call" {
            "arguments"
        } else {
            "input"
        }] = if kind == "message" {
            json!([])
        } else {
            json!("")
        };
        events.push(json!({"type":"response.output_item.added","output_index":index,"item":added}));
        if kind == "message" {
            for (part_index, part) in item["content"].as_array().unwrap().iter().enumerate() {
                let mut at = common.clone();
                at["content_index"] = json!(part_index);
                let mut empty = part.clone();
                empty["text"] = json!("");
                for (name, fields) in [
                    ("response.content_part.added", json!({"part":empty})),
                    ("response.output_text.delta", json!({"delta":part["text"]})),
                    ("response.output_text.done", json!({"text":part["text"]})),
                    ("response.content_part.done", json!({"part":part})),
                ] {
                    let mut event = at.clone();
                    event["type"] = json!(name);
                    event
                        .as_object_mut()
                        .unwrap()
                        .extend(fields.as_object().unwrap().clone());
                    events.push(event);
                }
            }
        } else {
            let (name, field) = if kind == "function_call" {
                ("function_call_arguments", "arguments")
            } else {
                ("custom_tool_call_input", "input")
            };
            for suffix in ["delta", "done"] {
                let mut e = common.clone();
                e["type"] = json!(format!("response.{name}.{suffix}"));
                e[if suffix == "delta" { "delta" } else { field }] = item[field].clone();
                events.push(e);
            }
        }
        events.push(json!({"type":"response.output_item.done","output_index":index,"item":item}));
    }
    events
        .push(json!({"type":format!("response.{}",text(&response["status"])),"response":response}));
    events
}
