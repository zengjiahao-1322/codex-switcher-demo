//! Usage is indexed on API calls; neither prompts nor responses are deserialized.
mod calendar;
mod prices;
mod scan;
use crate::{config_store, server::App};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    collections::BTreeMap,
    fs,
    io::{self, Write},
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
};
static INDEX: Mutex<()> = Mutex::new(());
fn text(v: &Value) -> &str {
    v.as_str().unwrap_or("")
}
fn number(v: &Value) -> i64 {
    v.as_i64().unwrap_or(0).max(0)
}
fn now_ms() -> i64 {
    (time::OffsetDateTime::now_utc().unix_timestamp_nanos() / 1_000_000) as i64
}
fn claude_home() -> PathBuf {
    std::env::var_os("CLAUDE_CONFIG_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| crate::platform::user_home().join(".claude"))
}
#[derive(Serialize, Deserialize, Clone)]
pub struct Source {
    t: String,
    client: String,
    kind: String,
    id: String,
    name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    model: Option<String>,
}
impl Source {
    fn time(&self) -> i64 {
        scan::millis(&self.t).unwrap_or(0)
    }
    fn key(&self) -> String {
        format!("{}:{}", self.kind, self.id)
    }
}
fn sources(bridge: &Path) -> io::Result<Vec<Source>> {
    let file = bridge.join("usage/sources.jsonl");
    if !file.exists() {
        return Ok(vec![]);
    }
    let mut result = fs::read_to_string(file)?
        .lines()
        .map(|s| serde_json::from_str(s).map_err(io::Error::other))
        .collect::<io::Result<Vec<Source>>>()?;
    result.sort_by_key(Source::time);
    Ok(result)
}
fn append(bridge: &Path, source: Source) -> io::Result<()> {
    let dir = bridge.join("usage");
    fs::create_dir_all(&dir)?;
    let mut file = fs::OpenOptions::new()
        .append(true)
        .create(true)
        .open(dir.join("sources.jsonl"))?;
    writeln!(
        file,
        "{}",
        serde_json::to_string(&source).map_err(io::Error::other)?
    )?;
    Ok(())
}
pub fn record(
    app: &App,
    client: &str,
    kind: &str,
    id: &str,
    name: &str,
    model: Option<&str>,
) -> io::Result<()> {
    let _guard = INDEX.lock().unwrap();
    append(
        &app.bridge,
        Source {
            t: crate::diagnostics::now(),
            client: client.into(),
            kind: kind.into(),
            id: id.into(),
            name: name.into(),
            model: model.map(str::to_owned),
        },
    )
}
fn current(app: &App, client: &str) -> io::Result<Source> {
    let (selected, config, model) = if client == "codex" {
        let cfg =
            crate::config_ops::read(&app.codex_home().join("config.toml"))?.unwrap_or_default();
        let cfg = toml::from_str::<toml::Value>(&cfg).map_err(io::Error::other)?;
        let v = serde_json::to_value(cfg).map_err(io::Error::other)?;
        let m = v["model"].as_str().map(str::to_owned);
        (
            config_store::read_json(&app.bridge.join("current.json"))?,
            v,
            m,
        )
    } else {
        let selected = config_store::read_json(&app.bridge.join("claude-current.json"))?;
        let cfg = config_store::read_json(&claude_home().join("settings.json"))?;
        let model = cfg["env"]["ANTHROPIC_MODEL"].as_str().map(str::to_owned);
        (selected, cfg, model)
    };
    let id = text(&selected["providerId"]);
    let store = config_store::load(&app.bridge)?;
    let provider = store["providers"]
        .as_array()
        .into_iter()
        .flatten()
        .find(|v| v["id"] == id);
    if let Some(p) = provider {
        return Ok(Source {
            t: crate::diagnostics::now(),
            client: client.into(),
            kind: "api".into(),
            id: id.into(),
            name: text(&p["name"]).into(),
            model,
        });
    }
    if client == "codex" && config["model_provider"].as_str().unwrap_or("openai") == "openai" {
        let auth = config_store::read_json(&app.codex_home().join("auth.json"))?;
        let identity = crate::accounts::identity(&auth).unwrap_or(Value::Null);
        let id = identity["id"].as_str().unwrap_or("default");
        let index = crate::accounts::read(&app.bridge.join("accounts/index.json"), json!([]))?;
        let saved = index
            .as_array()
            .into_iter()
            .flatten()
            .find(|v| v["id"] == id);
        let name = saved
            .and_then(|v| v["label"].as_str().or(v["email"].as_str()))
            .unwrap_or("Codex官方");
        return Ok(Source {
            t: crate::diagnostics::now(),
            client: client.into(),
            kind: "official".into(),
            id: id.into(),
            name: name.into(),
            model,
        });
    }
    let official = client == "claude" && !config["env"]["ANTHROPIC_BASE_URL"].is_string();
    Ok(Source {
        t: crate::diagnostics::now(),
        client: client.into(),
        kind: if official { "official" } else { "api" }.into(),
        id: if official {
            "claude".into()
        } else {
            config["model_provider"]
                .as_str()
                .unwrap_or("external")
                .into()
        },
        name: if official {
            "Claude 官方登录"
        } else {
            "外部配置"
        }
        .into(),
        model,
    })
}
pub fn initialize(app: &App) -> io::Result<()> {
    let _guard = INDEX.lock().unwrap();
    if !app.bridge.join("usage/sources.jsonl").exists() {
        append(&app.bridge, current(app, "codex")?)?;
        append(&app.bridge, current(app, "claude")?)?;
    }
    Ok(())
}
pub fn record_current(app: &App, client: &str) -> io::Result<()> {
    let _guard = INDEX.lock().unwrap();
    append(&app.bridge, current(app, client)?)
}
fn source_at(sources: &[Source], client: &str, t: i64) -> Value {
    sources.iter().rev().find(|s|s.client==client&&s.time()<=t).map(|s|json!({"key":s.key(),"kind":s.kind,"id":s.id,"name":s.name,"subscription":s.kind=="official"})).unwrap_or_else(||json!({"key":"untracked","kind":"untracked","id":null,"name":"切换记录开始之前","subscription":false}))
}
fn validate(input: &Value) -> io::Result<(&str, &str)> {
    let client = input["client"]
        .as_str()
        .ok_or_else(|| io::Error::other("client必填"))?;
    if !["codex", "claude"].contains(&client) {
        return Err(io::Error::other("client须为codex或claude"));
    }
    let range = input["range"]
        .as_str()
        .ok_or_else(|| io::Error::other("range必填"))?;
    if !["today", "7d", "30d"].contains(&range) {
        return Err(io::Error::other("range须为today、7d或30d"));
    }
    Ok((client, range))
}
fn indexed(app: &App, input: &Value, requests: bool) -> io::Result<Value> {
    let (client, range) = validate(input)?;
    let now = time::OffsetDateTime::now_utc();
    let (from, buckets) = calendar::window(range, now)?;
    let sources = sources(&app.bridge)?;
    let db = scan::database(&app.bridge)?;
    scan::scan(app, &db, &sources, client)?;
    let mut filter = "client=? AND t>=? AND t<=?".to_owned();
    let mut parameters = vec![
        json!(client),
        json!(from.unix_timestamp() * 1000),
        json!(now_ms()),
    ];
    for (name, column) in [("model", "model"), ("source", "source_key")] {
        if let Some(value) = input[name].as_str() {
            filter.push_str(&format!(" AND {column}=?"));
            parameters.push(json!(value));
        }
    }
    if let Some(result) = input["result"].as_str() {
        if !["ok", "failed"].contains(&result) {
            return Err(io::Error::other("result须为ok或failed"));
        }
        filter.push_str(" AND ok=?");
        parameters.push(json!(i64::from(result == "ok")));
    }
    let select = format!("SELECT * FROM requests WHERE {filter} ORDER BY t DESC,uid");
    let book = prices::load(app)?;
    let overrides = prices::overrides(app)?;
    let store = config_store::load(&app.bridge)?;
    let detail = |r: &Value| -> io::Result<Value> {
        let source = source_at(&sources, client, r["t"].as_i64().unwrap());
        let provider = store["providers"]
            .as_array()
            .into_iter()
            .flatten()
            .find(|p| p["id"] == source["id"])
            .unwrap_or(&Value::Null);
        let (cost, currency) = if r["ok"] == 1 {
            let (cost, currency) = prices::bill(r, &source, provider, &book, &overrides);
            (cost, Some(currency))
        } else {
            (None, None)
        };
        let t = time::OffsetDateTime::from_unix_timestamp_nanos(
            r["t"].as_i64().unwrap() as i128 * 1_000_000,
        )
        .map_err(io::Error::other)?;
        Ok(
            json!({"t":calendar::format(calendar::local(t)?),"client":client,"source":source,"model":r["model"],"effort":if text(&r["effort"]).is_empty(){Value::Null}else{r["effort"].clone()},"tier":if text(&r["tier"]).is_empty(){Value::Null}else{r["tier"].clone()},"input":if client=="codex"{json!((number(&r["input"])-number(&r["cached_input"])).max(0))}else{r["input"].clone()},"cachedInput":r["cached_input"],"cacheWrite":number(&r["cache_write_5m"])+number(&r["cache_write_1h"]),"output":r["output"],"reasoning":r["reasoning"],"cost":cost,"currency":currency,"ok":r["ok"]==1,"error":if text(&r["error"]).is_empty(){Value::Null}else{r["error"].clone()},"durationMs":if r["duration_ms"].as_i64()==Some(-1){Value::Null}else{r["duration_ms"].clone()},"project":r["project"]}),
        )
    };
    if requests {
        let total = db.query(
            &format!("SELECT COUNT(*) AS n FROM requests WHERE {filter}"),
            &parameters,
        )?[0]["n"]
            .clone();
        parameters.push(json!(input["limit"].as_u64().unwrap_or(100).min(500)));
        parameters.push(json!(input["offset"].as_u64().unwrap_or(0)));
        let mut rows = vec![];
        db.query_each(
            &(select.clone() + " LIMIT ? OFFSET ?"),
            &parameters,
            |row| {
                rows.push(detail(&row)?);
                Ok(())
            },
        )?;
        return Ok(json!({"total":total,"rows":rows}));
    }
    let mut totals = aggregate();
    let mut untracked = aggregate();
    let mut groups = BTreeMap::<String, Value>::new();
    let mut models = BTreeMap::<String, Value>::new();
    let mut series = buckets
        .iter()
        .map(|t| {
            let mut v = aggregate();
            v["at"] = json!(calendar::format(*t));
            v
        })
        .collect::<Vec<_>>();
    db.query_each(&select, &parameters, |raw| {
        let row = detail(&raw)?;
        accumulate(&mut totals, &row);
        if row["source"]["key"] == "untracked" {
            accumulate(&mut untracked, &row);
        } else {
            let key = text(&row["source"]["key"]).to_owned();
            let g = groups.entry(key).or_insert_with(|| {
                let mut v = aggregate();
                v.as_object_mut()
                    .unwrap()
                    .extend(row["source"].as_object().unwrap().clone());
                let provider = store["providers"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .find(|p| p["id"] == row["source"]["id"]);
                v["usageUrl"] = provider
                    .map(|p| p["usageUrl"].clone())
                    .unwrap_or(Value::Null);
                v
            });
            accumulate(g, &row);
        }
        if let Some(model) = row["model"].as_str().filter(|s| !s.is_empty()) {
            let g = models.entry(model.to_owned()).or_insert_with(|| {
                let mut v = aggregate();
                v["model"] = json!(model);
                v
            });
            accumulate(g, &row);
            g["priced"] =
                json!(number(&g["unpriced"]) == 0 && number(&g["requests"]) > number(&g["failed"]));
        }
        let t = scan::millis(text(&row["t"])).unwrap();
        if let Some(i) = buckets.iter().rposition(|b| b.unix_timestamp() * 1000 <= t) {
            accumulate(&mut series[i], &row);
        }
        Ok(())
    })?;
    let sort = |groups: BTreeMap<String, Value>| {
        let mut v = groups.into_values().collect::<Vec<_>>();
        v.sort_by_key(|v| {
            std::cmp::Reverse(
                number(&v["input"])
                    + number(&v["cachedInput"])
                    + number(&v["cacheWrite"])
                    + number(&v["output"]),
            )
        });
        v
    };
    Ok(
        json!({"client":client,"range":range,"from":calendar::format(from),"to":calendar::format(calendar::local(now)?),"trackedSince":sources.iter().find(|s|s.client==client).map(|s|s.t.clone()),"priceBook":prices::metadata(&book),"totals":totals,"sources":sort(groups),"models":sort(models),"untracked":untracked,"series":series}),
    )
}
fn aggregate() -> Value {
    json!({"input":0,"cachedInput":0,"cacheWrite":0,"output":0,"reasoning":0,"requests":0,"failed":0,"cost":{},"priced":0,"unpriced":0})
}
fn accumulate(v: &mut Value, row: &Value) {
    for key in ["input", "cachedInput", "cacheWrite", "output", "reasoning"] {
        v[key] = json!(number(&v[key]) + number(&row[key]));
    }
    v["requests"] = json!(number(&v["requests"]) + 1);
    v["failed"] = json!(number(&v["failed"]) + i64::from(row["ok"] != true));
    if row["ok"] != true {
        return;
    }
    let key = if row["cost"].is_number() {
        let currency = text(&row["currency"]).to_owned();
        v["cost"][&currency] =
            json!(v["cost"][&currency].as_f64().unwrap_or(0.0) + row["cost"].as_f64().unwrap());
        "priced"
    } else {
        "unpriced"
    };
    v[key] = json!(number(&v[key]) + 1);
}
pub async fn action(app: Arc<App>, name: &str, input: Value) -> io::Result<Value> {
    if name == "usagePrices" {
        return prices::refresh(&app).await;
    }
    let book = prices::load(&app)?;
    prices::background(app.clone(), &book);
    let details = name == "usageRequests";
    tokio::task::spawn_blocking(move || {
        let _guard = INDEX.lock().unwrap();
        indexed(&app, &input, details)
    })
    .await
    .map_err(io::Error::other)?
}
