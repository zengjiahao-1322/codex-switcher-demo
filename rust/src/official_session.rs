//! Each official RPC session owns one isolated app-server and its pipes.
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    fs,
    path::Path,
    process::Stdio,
    sync::{
        Arc, Mutex,
        atomic::{AtomicU64, Ordering},
    },
    time::Duration,
};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    process::{Child, ChildStdin, Command},
    sync::{Mutex as AsyncMutex, mpsc, oneshot},
};

#[derive(Clone, Debug)]
pub struct Failure {
    pub message: String,
    pub kind: &'static str,
    pub code: Value,
}
impl Failure {
    fn runtime() -> Self {
        Self {
            message: "无法启动或连接 Codex 程序，请检查程序路径与执行权限。".into(),
            kind: "runtime_error",
            code: Value::Null,
        }
    }
    fn rpc(error: &Value) -> Self {
        let raw = error["message"].as_str().unwrap_or("").to_lowercase();
        let network =
            regex::Regex::new(r"network|connect|dns|timed? ?out|proxy|transport|send.*request")
                .unwrap()
                .is_match(&raw);
        let auth = regex::Regex::new(r"401|unauthoriz|invalid.grant|token.{0,80}(?:expired|invalid|revoked|reused|already been used)|not authenticated|login required").unwrap().is_match(&raw);
        let code = error["code"].clone();
        let kind = if code == 401 {
            "auth_invalid"
        } else if code == -32601 {
            "runtime_error"
        } else if network {
            "network_error"
        } else if auth {
            "auth_invalid"
        } else {
            "service_error"
        };
        Self {
            message: if raw.contains("active writer") {
                "旧对话仍被客户端占用，请关闭该客户端后继续同步。".into()
            } else {
                format!("官方服务请求失败（{}）。", code)
            },
            kind,
            code,
        }
    }
}
type Pending = Arc<Mutex<HashMap<u64, oneshot::Sender<Result<Value, Failure>>>>>;
pub struct Session {
    child: AsyncMutex<Child>,
    input: AsyncMutex<Option<ChildStdin>>,
    pending: Pending,
    sequence: AtomicU64,
}
impl Session {
    pub fn open(
        bridge: &Path,
        home: &Path,
    ) -> Result<(Arc<Self>, mpsc::UnboundedReceiver<Value>), Failure> {
        fs::create_dir_all(home).map_err(|_| Failure::runtime())?;
        fs::write(home.join("config.toml"), "cli_auth_credentials_store = \"file\"\n[features]\nplugins = false\nremote_plugin = false\n[analytics]\nenabled = false\n").map_err(|_| Failure::runtime())?;
        Self::spawn(bridge, home, &[])
    }
    pub fn threads(bridge: &Path, home: &Path, config: &Value) -> Result<Arc<Self>, Failure> {
        let mut args = vec![];
        for value in [
            "notify=[]",
            "analytics.enabled=false",
            "features.plugins=false",
            "features.remote_plugin=false",
            "features.codex_hooks=false",
        ] {
            args.extend(["-c".to_owned(), value.to_owned()]);
        }
        if let Some(servers) = config["mcp_servers"].as_object() {
            let name_pattern = regex::Regex::new(r"^[A-Za-z0-9_-]+$").unwrap();
            for name in servers.keys() {
                if !name_pattern.is_match(name) {
                    return Err(Failure {
                        message: format!("暂不支持此 MCP 配置名称：{name}"),
                        kind: "runtime_error",
                        code: Value::Null,
                    });
                }
                args.extend(["-c".into(), format!("mcp_servers.{name}.enabled=false")]);
            }
        }
        Ok(Self::spawn(bridge, home, &args)?.0)
    }
    fn spawn(
        bridge: &Path,
        home: &Path,
        args: &[String],
    ) -> Result<(Arc<Self>, mpsc::UnboundedReceiver<Value>), Failure> {
        let exe = crate::platform::codex_path(bridge).map_err(|_| Failure {
            code: json!("CODEX_NOT_FOUND"),
            ..Failure::runtime()
        })?;
        let env = crate::platform::codex_env(home)
            .into_iter()
            .filter(|(k, _)| !k.starts_with("CODEX_") || k == "CODEX_HOME");
        let mut command = Command::new(exe);
        command
            .args(args)
            .arg("app-server")
            .current_dir(home)
            .env_clear()
            .envs(env)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .kill_on_drop(true);
        #[cfg(windows)]
        command.creation_flags(0x08000000);
        let mut child = command.spawn().map_err(|e| Failure {
            code: json!(if e.kind() == std::io::ErrorKind::PermissionDenied {
                "EACCES"
            } else {
                "ENOENT"
            }),
            ..Failure::runtime()
        })?;
        let input = child.stdin.take();
        let stdout = child.stdout.take().unwrap();
        let pending: Pending = Arc::new(Mutex::new(HashMap::new()));
        let requests = pending.clone();
        let (tx, rx) = mpsc::unbounded_channel();
        tokio::spawn(async move {
            let mut lines = BufReader::new(stdout).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                let Ok(message) = serde_json::from_str::<Value>(&line) else {
                    continue;
                };
                let request = message["id"]
                    .as_u64()
                    .and_then(|id| requests.lock().unwrap().remove(&id));
                if let Some(request) = request {
                    let _ = request.send(if message.get("error").is_some() {
                        Err(Failure::rpc(&message["error"]))
                    } else {
                        Ok(message["result"].clone())
                    });
                } else if message["method"].is_string() {
                    let _ = tx.send(message);
                }
            }
            for (_, request) in requests.lock().unwrap().drain() {
                let _ = request.send(Err(Failure::runtime()));
            }
            let _ = tx.send(json!({"method":"process/exit"}));
        });
        Ok((
            Arc::new(Self {
                child: AsyncMutex::new(child),
                input: AsyncMutex::new(input),
                pending,
                sequence: AtomicU64::new(0),
            }),
            rx,
        ))
    }
    async fn write(&self, value: Value) -> Result<(), Failure> {
        let mut input = self.input.lock().await;
        let input = input.as_mut().ok_or_else(Failure::runtime)?;
        let mut bytes = serde_json::to_vec(&value).unwrap();
        bytes.push(b'\n');
        input
            .write_all(&bytes)
            .await
            .map_err(|_| Failure::runtime())?;
        input.flush().await.map_err(|_| Failure::runtime())
    }
    pub async fn rpc(&self, method: &str, params: Value) -> Result<Value, Failure> {
        let id = self.sequence.fetch_add(1, Ordering::Relaxed) + 1;
        let (tx, rx) = oneshot::channel();
        self.pending.lock().unwrap().insert(id, tx);
        if let Err(e) = self
            .write(json!({"id":id,"method":method,"params":params}))
            .await
        {
            self.pending.lock().unwrap().remove(&id);
            return Err(e);
        }
        let result = tokio::time::timeout(
            Duration::from_secs(if method == "initialize" { 10 } else { 30 }),
            rx,
        )
        .await;
        self.pending.lock().unwrap().remove(&id);
        match result {
            Ok(Ok(result)) => result,
            Ok(Err(_)) => Err(Failure::runtime()),
            Err(_) => Err(Failure {
                message: "Codex 服务响应超时，请检查网络后重试。".into(),
                kind: "network_error",
                code: json!("TIMEOUT"),
            }),
        }
    }
    pub async fn ready(&self) -> Result<(), Failure> {
        self.rpc("initialize", json!({"clientInfo":{"name":"codex-api-switcher","title":"Codex API 切换器","version":"1.0.0"}})).await?;
        self.write(json!({"method":"initialized"})).await
    }
    pub async fn close(&self) {
        self.input.lock().await.take();
        let mut child = self.child.lock().await;
        if child.try_wait().ok().flatten().is_none() {
            let _ = child.start_kill();
        }
        let _ = child.wait().await;
    }
}
