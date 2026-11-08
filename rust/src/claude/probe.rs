//! Probe the selected provider through the same path Claude Code uses.
use super::{
    access::{self, Access},
    adapter, provider,
    settings::normalized_base,
};
use crate::{adapter_convert::Failure, server::App};
use serde_json::{Value, json};
use std::{
    io,
    time::{Duration, Instant},
};

async fn direct(provider: &Value, payload: &Value) -> Result<(), Failure> {
    let response = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .no_proxy()
        .timeout(Duration::from_secs(30))
        .build()
        .map_err(|_| Failure::unsupported())?
        .post(format!(
            "{}/v1/messages",
            normalized_base(provider["baseUrl"].as_str().unwrap_or(""))
        ))
        .bearer_auth(provider["apiKey"].as_str().unwrap_or(""))
        .header("anthropic-version", "2023-06-01")
        .json(payload)
        .send()
        .await
        .map_err(|_| Failure::unsupported())?;
    let status = response.status().as_u16();
    if !(200..300).contains(&status) {
        return Err(Failure {
            status,
            message: String::new(),
            upstream: true,
        });
    }
    Ok(())
}
pub(super) async fn probe(app: &App, input: &Value) -> io::Result<Value> {
    let provider = provider(&app.bridge, &input["id"])?;
    let model = input["model"]
        .as_str()
        .filter(|model| !model.trim().is_empty())
        .ok_or_else(|| io::Error::other("请选择 Claude Code 模型"))?;
    let access = access::local(&provider);
    if let Access::Unavailable(reason) = access {
        return Ok(json!({"ok":false,"latencyMs":0,"message":reason}));
    }
    let payload =
        json!({"model":model,"max_tokens":1,"messages":[{"role":"user","content":"ping"}]});
    let started = Instant::now();
    let result = tokio::time::timeout(Duration::from_secs(30), async {
        if access == Access::Direct {
            direct(&provider, &payload).await
        } else {
            adapter::exchange(provider, &payload, "msg_probe".into())?
                .await
                .map(|_| ())
        }
    })
    .await
    .unwrap_or_else(|_| Err(Failure::unsupported()));
    let message = match &result {
        Ok(()) => "连接正常".to_owned(),
        Err(error) => {
            let kind = match error.status {
                400 => "invalid_request_error",
                401 => "authentication_error",
                403 => "permission_error",
                404 => "not_found_error",
                429 => "rate_limit_error",
                _ => "api_error",
            };
            format!("上游 HTTP {}（{kind}）", error.status)
        }
    };
    Ok(json!({"ok":result.is_ok(),"latencyMs":started.elapsed().as_millis(),"message":message}))
}
