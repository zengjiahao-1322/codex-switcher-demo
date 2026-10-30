//! stdio MCP server. Its wire messages and tool descriptions match the Node
//! server byte-for-byte; secrets remain in providers.json and never enter a
//! response.
use crate::{config_ops, instance};
use serde_json::{Value, json};
use std::io::{self, BufRead, Write};
use std::sync::Arc;

const OFFICIAL: &str = "official";

fn write_registration(app: &crate::server::App, enabled: bool, replace: bool) -> io::Result<()> {
    let _operation = crate::config_ops::operation(&app.bridge)?;
    let file = app.codex_home().join("config.toml");
    let text = crate::config_ops::read(&file)?.unwrap_or_default();
    let mut document = text
        .parse::<toml_edit::DocumentMut>()
        .map_err(io::Error::other)?;
    if enabled {
        if document.get("mcp_servers").is_none() {
            document["mcp_servers"] = toml_edit::Item::Table(toml_edit::Table::new());
        }
        if replace || document["mcp_servers"].get("api_switcher").is_none() {
            document["mcp_servers"]["api_switcher"] =
                toml_edit::Item::Table(toml_edit::Table::new());
        }
        document["mcp_servers"]["api_switcher"]["command"] =
            toml_edit::value(crate::platform::display_path(&std::env::current_exe()?));
        let mut arguments = toml_edit::Array::new();
        arguments.push("--mcp");
        document["mcp_servers"]["api_switcher"]["args"] = toml_edit::value(arguments);
    } else if let Some(table) = document
        .get_mut("mcp_servers")
        .and_then(toml_edit::Item::as_table_like_mut)
    {
        table.remove("api_switcher");
    }
    crate::config_ops::atomic(&file, &document.to_string(), Some(Some(&text)))
}

pub fn integrate(app: &crate::server::App, input: &Value) -> io::Result<Value> {
    let enabled = input["enabled"] == true;
    write_registration(app, enabled, true)?;
    Ok(
        json!({"message":if enabled{"已集成到 Codex：重启 Codex 后，在对话里说“列出我的 API 配置”“切换到 xxx”“切回官方”即可。"}else{"已从 Codex 移除集成。"}}),
    )
}

pub fn migrate(app: &crate::server::App) -> io::Result<()> {
    let Some(text) = crate::config_ops::read(&app.codex_home().join("config.toml"))? else {
        return Ok(());
    };
    let document = text.parse::<toml::Value>().map_err(io::Error::other)?;
    let registration = document
        .get("mcp_servers")
        .and_then(|v| v.get("api_switcher"));
    let Some(registration) = registration else {
        return Ok(());
    };
    let command = registration
        .get("command")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .rsplit(['/', '\\'])
        .next()
        .unwrap_or("");
    let old = matches!(command.to_ascii_lowercase().as_str(), "node" | "node.exe")
        && registration
            .get("args")
            .and_then(|v| v.as_array())
            .is_some_and(|a| {
                a.iter().any(|arg| {
                    arg.as_str()
                        .is_some_and(|s| s.rsplit(['/', '\\']).next() == Some("mcp-server.cjs"))
                })
            });
    if old {
        write_registration(app, true, false)?;
    }
    Ok(())
}

fn string_schema() -> Value {
    json!({"type":"string"})
}

fn thread_follow_schema() -> Value {
    json!({
        "type":"string",
        "enum":["off","matching","all"],
        "description":"可选的旧对话跟随范围：off 保留原设置，matching 按原 provider 标识筛选，all 全部未归档用户对话；未指定时为 all。"
    })
}

fn tools() -> Vec<Value> {
    vec![
        json!({
            "name":"list_api_configs",
            "description":"列出 Codex API 切换器中的全部 API 配置（含 Codex 官方登录），标明当前正在使用的配置、接入方式（直连/经本机转换）和默认模型。",
            "inputSchema":{"type":"object","properties":{},"additionalProperties":false},
            "annotations":{"readOnlyHint":true}
        }),
        json!({
            "name":"current_api_config",
            "description":"查看 Codex 当前使用的 API 配置与模型。",
            "inputSchema":{"type":"object","properties":{},"additionalProperties":false},
            "annotations":{"readOnlyHint":true}
        }),
        json!({
            "name":"list_models",
            "description":"获取某个配置可用的模型列表（只读，不调用模型）。config 为配置名称或 id；“官方”表示 Codex 官方登录。",
            "inputSchema":{"type":"object","properties":{"config":string_schema()},"required":["config"],"additionalProperties":false},
            "annotations":{"readOnlyHint":true}
        }),
        json!({
            "name":"test_api_config",
            "description":"检测某个配置与模型能否用于 Codex（会向该供应商发一次很小的请求，可能计费），返回直连或经本机转换。",
            "inputSchema":{"type":"object","properties":{"config":string_schema(),"model":{"type":"string","description":"可选，默认用该配置的默认模型"}},"required":["config"],"additionalProperties":false}
        }),
        json!({
            "name":"switch_api_config",
            "description":"把 Codex 切换到指定 API 配置与模型（未检测过会先检测）。可选 threadFollow 指定旧对话跟随范围，未指定时全部跟随。配置写入后请完整重启客户端。config 为“官方”时切回官方登录。",
            "inputSchema":{"type":"object","properties":{"config":string_schema(),"model":{"type":"string","description":"可选，默认用该配置的默认模型"},"threadFollow":thread_follow_schema()},"required":["config"],"additionalProperties":false}
        }),
        json!({
            "name":"switch_to_official",
            "description":"切回 Codex 官方登录（ChatGPT 账号）。可指定官方模型和旧对话跟随范围，未指定时全部跟随。配置写入后请完整重启桌面端。",
            "inputSchema":{"type":"object","properties":{"model":{"type":"string"},"threadFollow":thread_follow_schema()},"additionalProperties":false}
        }),
        json!({
            "name":"delete_api_config",
            "description":"删除一个 API 配置（含其保存的密钥，不可撤销）。官方登录与 Codex 正在使用的配置不能删除。仅在用户明确要求删除时调用。",
            "inputSchema":{"type":"object","properties":{"config":string_schema()},"required":["config"],"additionalProperties":false},
            "annotations":{"destructiveHint":true}
        }),
        json!({
            "name":"open_api_manager",
            "description":"在浏览器中打开 Codex API 切换器管理页面，用于新增配置、填写或修改 API 密钥（密钥不要在对话中传递）。",
            "inputSchema":{"type":"object","properties":{},"additionalProperties":false}
        }),
    ]
}

fn available(state: &Value) -> String {
    state["providers"]
        .as_array()
        .map(|rows| {
            rows.iter()
                .filter(|p| p["id"] != OFFICIAL)
                .filter_map(|p| p["name"].as_str())
                .collect::<Vec<_>>()
                .join("、")
        })
        .unwrap_or_default()
}

fn find(state: &Value, key: &str) -> Result<Value, String> {
    if key == OFFICIAL
        || key.to_ascii_lowercase().starts_with("official")
        || key.starts_with("官方")
    {
        return Ok(state["providers"]
            .as_array()
            .unwrap()
            .iter()
            .find(|p| p["id"] == OFFICIAL)
            .unwrap()
            .clone());
    }
    let key_lower = key.to_lowercase();
    state["providers"]
        .as_array()
        .and_then(|rows| {
            rows.iter()
                .find(|p| {
                    p["id"] == key
                        || p["name"] == key
                        || p["name"].as_str().unwrap_or("").to_lowercase() == key_lower
                })
                .cloned()
        })
        .ok_or_else(|| format!("没有名为“{key}”的配置。可用：官方、{}", available(state)))
}

fn access_text(mode: &str) -> &'static str {
    match mode {
        "direct" => "直连",
        "adapter" => "经本机转换",
        "failed" => "上次检测未通过",
        "official" => "官方登录",
        _ => "未检测",
    }
}

fn describe(provider: &Value) -> String {
    let name = provider["name"].as_str().unwrap_or("");
    let model = provider["model"].as_str().unwrap_or("（无）");
    let mode = access_text(provider["access"]["mode"].as_str().unwrap_or("unknown"));
    let local = if provider["local"] == true {
        "｜本机代理"
    } else {
        ""
    };
    let id = if provider["id"] == OFFICIAL {
        String::new()
    } else {
        format!("｜id {}", provider["id"].as_str().unwrap_or(""))
    };
    format!(
        "{}{}｜{}｜默认模型 {}{}{}",
        if provider["inUse"] == true {
            "▶ "
        } else {
            "  "
        },
        name,
        mode,
        model,
        local,
        id
    )
}

async fn call(app: &Arc<crate::server::App>, name: &str, args: Value) -> Result<String, String> {
    let mut state = app.state().map_err(|e| e.to_string())?;
    if name == "list_api_configs" {
        let port = state["adapter"]["port"].as_u64().unwrap_or(0);
        let client = reqwest::Client::builder()
            .no_proxy()
            .timeout(std::time::Duration::from_secs(2))
            .build()
            .map_err(|e| e.to_string())?;
        state["adapter"]["ready"] = json!(
            client
                .get(format!("http://127.0.0.1:{port}/"))
                .send()
                .await
                .is_ok_and(|response| response.status().is_success())
        );
    }
    match name {
        "list_api_configs" => {
            let rows = state["providers"].as_array().cloned().unwrap_or_default();
            let mut text = format!(
                "共 {} 个配置（▶ 为 Codex 当前配置）：\n{}",
                rows.len(),
                rows.iter().map(describe).collect::<Vec<_>>().join("\n")
            );
            let has_adapter_provider = rows
                .iter()
                .any(|provider| provider["access"]["mode"].as_str() == Some("adapter"));
            if has_adapter_provider && state["adapter"]["ready"] != true {
                text.push_str(
                    "\n\n提示：本机转换服务未运行，“经本机转换”的配置切换时会自动启动它。",
                )
            }
            Ok(text)
        }
        "current_api_config" => Ok(format!(
            "Codex 当前配置：{}，模型 {}{}。",
            state["current"]["name"].as_str().unwrap_or("未知"),
            state["current"]["model"].as_str().unwrap_or("（默认）"),
            if state["current"]["viaAdapter"] == true {
                "（经本机转换服务）"
            } else {
                ""
            }
        )),
        "list_models" => {
            let provider = find(&state, args["config"].as_str().unwrap_or(""))?;
            let result = config_ops::action(app, "models", &json!({"id":provider["id"]}))
                .await
                .map_err(|e| e.to_string())?;
            Ok(format!(
                "「{}」{}\n{}",
                provider["name"].as_str().unwrap_or(""),
                result["message"].as_str().unwrap_or(""),
                result["models"]
                    .as_array()
                    .map(|rows| rows
                        .iter()
                        .filter_map(Value::as_str)
                        .collect::<Vec<_>>()
                        .join("\n"))
                    .unwrap_or_default()
            ))
        }
        "test_api_config" => {
            let provider = find(&state, args["config"].as_str().unwrap_or(""))?;
            let model = args["model"]
                .as_str()
                .or(provider["model"].as_str())
                .unwrap_or("");
            let result =
                config_ops::action(app, "probe", &json!({"id":provider["id"],"model":model}))
                    .await
                    .map_err(|e| e.to_string())?;
            Ok(format!(
                "「{}」模型 {}：{}",
                provider["name"].as_str().unwrap_or(""),
                model,
                result["message"].as_str().unwrap_or("")
            ))
        }
        "switch_api_config" => {
            let provider = find(&state, args["config"].as_str().unwrap_or(""))?;
            let model = args["model"].as_str().or(provider["model"].as_str());
            let result = config_ops::action(app, "switch", &json!({"id":provider["id"],"model":model,"threadFollow":args["threadFollow"].as_str().unwrap_or("all")}))
                .await
                .map_err(|e| e.to_string())?;
            if provider["id"] == OFFICIAL {
                Ok(official_message(&state, model))
            } else {
                Ok(result["message"].as_str().unwrap_or("已切换").to_owned())
            }
        }
        "switch_to_official" => {
            let result = config_ops::action(app, "switch", &json!({"id":"official","model":args["model"],"threadFollow":args["threadFollow"].as_str().unwrap_or("all")}))
                .await
                .map_err(|e| e.to_string())?;
            let _ = result;
            let model = args["model"]
                .as_str()
                .or_else(|| state["providers"].as_array().unwrap()[0]["model"].as_str());
            Ok(official_message(&state, model))
        }
        "delete_api_config" => {
            let provider = find(&state, args["config"].as_str().unwrap_or(""))?;
            let result = config_ops::action(app, "providerRemove", &json!({"id":provider["id"]}))
                .await
                .map_err(|e| e.to_string())?;
            Ok(format!(
                "「{}」{}",
                provider["name"].as_str().unwrap_or(""),
                result["message"].as_str().unwrap_or("已删除")
            ))
        }
        "open_api_manager" => {
            let mut command =
                std::process::Command::new(std::env::current_exe().map_err(|e| e.to_string())?);
            command
                .stdin(std::process::Stdio::null())
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null());
            crate::update::detached(&mut command);
            command.spawn().map_err(|e| e.to_string())?;
            Ok(
                "已在浏览器中打开 Codex API 切换器。请在页面的「API 配置」中新增或修改配置与密钥。"
                    .into(),
            )
        }
        _ => Err(format!("Unknown tool: {name}")),
    }
}

pub(crate) async fn ensure_service(app: &crate::server::App) -> io::Result<()> {
    let port = crate::adapter::settings(app)?["port"]
        .as_u64()
        .unwrap_or(47831);
    let client = reqwest::Client::builder()
        .no_proxy()
        .timeout(std::time::Duration::from_secs(2))
        .build()
        .map_err(io::Error::other)?;
    let ready = || async {
        client
            .get(format!("http://127.0.0.1:{port}/"))
            .send()
            .await
            .is_ok_and(|r| r.status().is_success())
    };
    if ready().await {
        return Ok(());
    }
    let mut command = std::process::Command::new(std::env::current_exe()?);
    command
        .arg("--no-open")
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null());
    crate::update::detached(&mut command);
    command.spawn()?;
    for _ in 0..20 {
        if ready().await {
            return Ok(());
        }
        tokio::time::sleep(std::time::Duration::from_millis(500)).await;
    }
    Err(io::Error::other(format!(
        "本机转换服务未运行（端口 {port}），无法使用转换模式。请先打开切换器。"
    )))
}

fn official_message(state: &Value, model: Option<&str>) -> String {
    let model = model
        .filter(|s| !s.is_empty())
        .map(|s| format!("模型 {s}"))
        .unwrap_or("由 Codex 选择默认模型".into());
    format!(
        "已切换到 Codex 官方登录（{model}）。配置已应用。请完整退出并重新打开客户端，以载入新旧对话的来源与模型。{}",
        if state["current"]["official"] == true {
            ""
        } else {
            "如刚从自定义 API 切回，请从托盘完整退出后重新打开 ChatGPT 桌面端，再使用“聊天 / Work”或原官方旧会话。"
        }
    )
}

fn send(value: Value) {
    println!("{}", value);
    let _ = io::stdout().flush();
}

async fn handle(app: Arc<crate::server::App>, message: Value) {
    if message["jsonrpc"] != "2.0" || !message["method"].is_string() {
        return;
    }
    let method = message["method"].as_str().unwrap();
    if method.starts_with("notifications/") || message.get("id").is_none() {
        return;
    }
    let id = message["id"].clone();
    match method {
        "initialize" => send(json!({"jsonrpc":"2.0","id":id,"result":{
            "protocolVersion":message["params"]["protocolVersion"].as_str().filter(|s|!s.is_empty()).unwrap_or("2025-06-18"),
            "capabilities":{"tools":{"listChanged":false}},
            "serverInfo":{"name":"codex-api-switcher","title":"Codex API 切换器","version":"1.0.0"},
            "instructions":"管理并切换 Codex 使用的 API 配置。切换会写入本机配置；桌面端需要完整重启以载入账号和模型列表。不要在对话中索取或传递 API 密钥；需要新增或修改密钥时调用 open_api_manager。"
        }})),
        "ping" => send(json!({"jsonrpc":"2.0","id":id,"result":{}})),
        "tools/list" => send(json!({"jsonrpc":"2.0","id":id,"result":{"tools":tools()}})),
        "tools/call" => {
            let name = message["params"]["name"].as_str().unwrap_or("");
            if !tools().iter().any(|tool| tool["name"] == name) {
                send(
                    json!({"jsonrpc":"2.0","id":id,"error":{"code":-32602,"message":format!("Unknown tool: {name}")}}),
                );
                return;
            }
            match call(&app, name, message["params"]["arguments"].clone()).await {
                Ok(text) => send(
                    json!({"jsonrpc":"2.0","id":id,"result":{"content":[{"type":"text","text":text}]}}),
                ),
                Err(error) => send(
                    json!({"jsonrpc":"2.0","id":id,"result":{"content":[{"type":"text","text":format!("失败：{}",error.chars().take(500).collect::<String>())}],"isError":true}}),
                ),
            }
        }
        _ => send(
            json!({"jsonrpc":"2.0","id":id,"error":{"code":-32601,"message":format!("Method not found: {method}")}}),
        ),
    }
}

pub async fn run() -> Result<(), Box<dyn std::error::Error>> {
    let app = Arc::new(instance::fixture_app()?);
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
    // Blocking stdin stays off the current-thread HTTP/RPC executor.
    std::thread::spawn(move || {
        for line in io::stdin().lock().lines() {
            if tx.send(line).is_err() {
                break;
            }
        }
    });
    while let Some(line) = rx.recv().await {
        let line = line?;
        if line.trim().is_empty() {
            continue;
        }
        match serde_json::from_str(&line) {
            Ok(message) => {
                tokio::spawn(handle(app.clone(), message));
            }
            Err(_) => send(
                json!({"jsonrpc":"2.0","id":null,"error":{"code":-32700,"message":"Parse error"}}),
            ),
        }
    }
    Ok(())
}
