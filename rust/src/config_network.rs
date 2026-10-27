//! Provider verification performs real requests; upstream bodies never enter errors.
use serde_json::{Value, json};
use std::{io, time::Duration};

fn client() -> io::Result<reqwest::Client> {
    reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .no_proxy()
        .build()
        .map_err(io::Error::other)
}
fn url(provider: &Value, kind: &str) -> io::Result<reqwest::Url> {
    let base = provider["baseUrl"]
        .as_str()
        .unwrap_or("")
        .trim_end_matches('/');
    let anthropic = provider["apiMode"] == "anthropic_messages";
    let suffix = match kind {
        "models" if anthropic && !base.ends_with("/v1") => "/v1/models",
        "native" if anthropic && !base.ends_with("/v1") => "/v1/messages",
        "native" if anthropic => "/messages",
        "native" => "/chat/completions",
        "models" => "/models",
        _ => "/responses",
    };
    let url = reqwest::Url::parse(&format!("{base}{suffix}"))
        .map_err(|_| io::Error::other("无效 API 地址"))?;
    if !matches!(url.scheme(), "http" | "https")
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return Err(io::Error::other("无效 API 地址"));
    }
    Ok(url)
}
fn headers(
    request: reqwest::RequestBuilder,
    provider: &Value,
    native: bool,
) -> reqwest::RequestBuilder {
    let key = provider["apiKey"].as_str().unwrap_or("");
    if native && provider["apiMode"] == "anthropic_messages" {
        request
            .header("x-api-key", key)
            .header("anthropic-version", "2023-06-01")
    } else if key.is_empty() {
        request
    } else {
        request.bearer_auth(key)
    }
}
pub async fn test(provider: &Value, model: &str, native: bool) -> io::Result<Value> {
    let prompt =
        "Compatibility check only. Call bridge_ping with ok true. Do not perform any other action.";
    let schema = json!({"type":"object","properties":{"ok":{"type":"boolean"}},"required":["ok"]});
    let anthropic = provider["apiMode"] == "anthropic_messages";
    let payload = if !native {
        json!({"model":model,"input":[{"role":"user","content":prompt}],"tools":[{"type":"function","name":"bridge_ping","description":"Connectivity test; no side effects.","parameters":{"type":"object","properties":{"ok":{"type":"boolean"}},"required":["ok"],"additionalProperties":false},"strict":true}],"tool_choice":"auto","max_output_tokens":1024,"store":false,"stream":false})
    } else if anthropic {
        json!({"model":model,"max_tokens":1024,"messages":[{"role":"user","content":prompt}],"tools":[{"name":"bridge_ping","description":"Connectivity test; no side effects.","input_schema":schema}],"tool_choice":{"type":"auto"}})
    } else {
        json!({"model":model,"messages":[{"role":"user","content":prompt}],"tools":[{"type":"function","function":{"name":"bridge_ping","description":"Connectivity test; no side effects.","parameters":schema}}],"tool_choice":"auto","max_tokens":1024,"stream":false})
    };
    let request = headers(
        client()?.post(url(provider, if native { "native" } else { "responses" })?),
        provider,
        native,
    )
    .timeout(Duration::from_secs(45))
    .json(&payload);
    let result = async {
        let response = request.send().await?;
        let status = response.status().as_u16();
        if !(200..300).contains(&status) {
            let hint = if native {
                ""
            } else {
                match status {
                    401 => "密钥无效或已过期",
                    403 => "密钥无权访问该模型或接口",
                    404 => "该地址不提供 /responses 接口（可能只支持 Chat Completions）",
                    405 => "该地址不接受 Responses 请求",
                    429 => "额度已用尽或请求过于频繁，请稍后再试或换一个供应商",
                    500..=599 => "供应商服务端出错，请稍后再试",
                    _ => "",
                }
            };
            let protocol = if native { "原生协议" } else { "Responses " };
            let separator = if hint.is_empty() { "" } else { "：" };
            return Ok::<Value, reqwest::Error>(json!({
                "ok": false, "status": status,
                "message": format!("{protocol}请求失败，HTTP {status}{separator}{hint}")
            }));
        }
        let value: Value = response.json().await?;
        let valid = if !native {
            value["object"] == "response"
                && value["status"] == "completed"
                && value["output"].as_array().is_some_and(|items| {
                    items.iter().any(|item| {
                        item["type"] == "function_call" && item["name"] == "bridge_ping"
                    })
                })
        } else if anthropic {
            value["content"].as_array().is_some_and(|items| {
                items
                    .iter()
                    .any(|item| item["type"] == "tool_use" && item["name"] == "bridge_ping")
            })
        } else {
            value["choices"][0]["message"]["tool_calls"]
                .as_array()
                .is_some_and(|items| {
                    items
                        .iter()
                        .any(|item| item["function"]["name"] == "bridge_ping")
                })
        };
        let message = match (native, valid) {
            (true, true) => "原生协议函数调用通过",
            (true, false) => "原生协议未返回函数调用",
            (false, true) => "Responses 和函数调用通过；流式输出仍需 Codex 实测。",
            (false, false) => "未返回完整 Responses 函数调用，未通过兼容性检测。",
        };
        let mut result = json!({"ok":valid,"status":status,"message":message});
        if !native {
            result["toolCall"] = json!(valid);
        }
        Ok(result)
    }
    .await;
    Ok(result.unwrap_or_else(|error| {
        let message = if error.is_timeout() {
            "连接超时"
        } else if native {
            "连接失败或响应无法解析"
        } else {
            "连接失败或返回了无法解析的响应；未显示远端错误正文以避免泄露密钥。"
        };
        json!({"ok":false,"message":message})
    }))
}
pub async fn probe(provider: &Value, model: &str) -> io::Result<Value> {
    let direct = test(provider, model, false).await?;
    if direct["ok"] == true {
        return Ok(
            json!({"ok":true,"mode":"direct","message":"可直连：Responses 和函数调用通过。"}),
        );
    }
    let mut p = provider.clone();
    if !matches!(
        p["apiMode"].as_str(),
        Some("chat_completions" | "anthropic_messages")
    ) {
        p["apiMode"] = json!("chat_completions");
    }
    let native = test(&p, model, true).await?;
    if native["ok"] == true {
        return Ok(
            json!({"ok":true,"mode":"adapter","message":format!("不支持 Responses 直连（{}），但原生协议可用：将经本机转换服务接入（转换服务须保持运行；不支持 Codex 内置网页搜索）。",direct["message"].as_str().unwrap_or(""))}),
        );
    }
    let transient = |v: &Value| {
        v["status"] == 429
            || v["status"].as_u64().is_some_and(|s| s >= 500)
            || v["message"].as_str().is_some_and(|s| s.contains("超时"))
    };
    Ok(
        json!({"ok":false,"transient":transient(&direct)&&transient(&native),"message":format!("未通过：{}；{}",direct["message"].as_str().unwrap_or(""),native["message"].as_str().unwrap_or(""))}),
    )
}
pub async fn models(provider: &Value) -> io::Result<Vec<String>> {
    let anthropic = provider["apiMode"] == "anthropic_messages";
    let base = url(provider, "models")?;
    let client = client()?;
    let mut ids = std::collections::BTreeSet::new();
    let mut after: Option<String> = None;
    for _ in 0..20 {
        let mut url = base.clone();
        if anthropic {
            url.query_pairs_mut().append_pair("limit", "1000");
            if let Some(value) = &after {
                url.query_pairs_mut().append_pair("after_id", value);
            }
        }
        let response = headers(client.get(url), provider, anthropic)
            .timeout(Duration::from_secs(20))
            .send()
            .await
            .map_err(|e| {
                io::Error::other(if e.is_timeout() {
                    "获取模型列表超时"
                } else {
                    "连接失败，请检查 API 地址"
                })
            })?;
        let status = response.status().as_u16();
        if (300..400).contains(&status) {
            return Err(io::Error::other("连接失败，请检查 API 地址"));
        }
        if !response.status().is_success() {
            let hint = match status {
                401 => "：密钥无效或已过期",
                403 => "：密钥无权访问",
                404 => "：该地址不提供模型列表接口，请手动填写模型",
                429 => "：请求过于频繁或额度用尽",
                _ => "",
            };
            return Err(io::Error::other(format!(
                "获取模型列表失败，HTTP {status}{hint}"
            )));
        }
        let value: Value = response
            .json()
            .await
            .map_err(|_| io::Error::other("模型列表格式无法识别，请手动填写模型"))?;
        let items = value
            .as_array()
            .or(value["data"].as_array())
            .or(value["models"].as_array())
            .ok_or_else(|| io::Error::other("模型列表格式无法识别，请手动填写模型"))?;
        for item in items {
            if let Some(id) = item
                .as_str()
                .or(item["id"].as_str())
                .or(item["name"].as_str())
                .filter(|s| !s.trim().is_empty() && s.chars().count() <= 200)
            {
                ids.insert(id.trim().trim_start_matches("models/").to_string());
            }
        }
        if !(anthropic && value["has_more"] == true && value["last_id"].is_string()) {
            break;
        }
        after = value["last_id"].as_str().map(str::to_owned);
    }
    Ok(ids.into_iter().take(1000).collect())
}
