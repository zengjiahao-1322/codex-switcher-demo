//! Incremental extraction; serde ignores conversation fields instead of materializing them.
use super::{Source, text};
use crate::{server::App, sqlite::Database};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    collections::HashSet,
    fs,
    io::{self, BufRead, BufReader, Seek, SeekFrom},
    path::{Path, PathBuf},
    time::UNIX_EPOCH,
};

#[derive(Default, Deserialize)]
struct Envelope {
    #[serde(default)]
    timestamp: String,
    #[serde(default, rename = "type")]
    kind: String,
    #[serde(default)]
    payload: Payload,
    #[serde(default)]
    message: Message,
    #[serde(default)]
    cwd: String,
    #[serde(default, rename = "isApiErrorMessage")]
    api_error: bool,
    #[serde(default)]
    error: Option<String>,
    #[serde(default, rename = "apiErrorStatus")]
    error_status: Option<u16>,
}
#[derive(Default, Deserialize)]
struct Message {
    #[serde(default)]
    id: String,
    #[serde(default)]
    model: String,
    #[serde(default)]
    usage: Value,
}
#[derive(Default, Deserialize)]
struct Payload {
    #[serde(default, rename = "type")]
    kind: String,
    #[serde(default)]
    id: String,
    #[serde(default)]
    thread_id: String,
    #[serde(default)]
    response_id: String,
    #[serde(default)]
    cwd: String,
    #[serde(default)]
    model: String,
    #[serde(default)]
    effort: Option<String>,
    #[serde(default)]
    reasoning_effort: Option<String>,
    #[serde(default)]
    service_tier: Option<String>,
    #[serde(default)]
    thread_settings: Value,
    #[serde(default)]
    info: Value,
    #[serde(default)]
    usage: Value,
    #[serde(default)]
    error: Value,
    #[serde(default)]
    role: String,
}
#[derive(Default, Serialize, Deserialize)]
struct State {
    #[serde(default)]
    modern: bool,
    #[serde(default)]
    total: Value,
    #[serde(default)]
    thread: String,
    #[serde(default)]
    project: String,
    #[serde(default)]
    model: String,
    #[serde(default)]
    effort: Option<String>,
    #[serde(default)]
    tier: Option<String>,
    #[serde(default)]
    last: Option<i64>,
    #[serde(default)]
    user: Option<i64>,
}
pub fn millis(t: &str) -> Option<i64> {
    time::OffsetDateTime::parse(t, &time::format_description::well_known::Rfc3339)
        .ok()
        .map(|v| (v.unix_timestamp_nanos() / 1_000_000) as i64)
}
fn count(v: &Value, name: &str) -> i64 {
    v[name].as_i64().unwrap_or(0).max(0)
}
fn walk(root: &Path, files: &mut Vec<PathBuf>) -> io::Result<()> {
    if !root.exists() {
        return Ok(());
    }
    for entry in fs::read_dir(root)? {
        let entry = entry?;
        let path = entry.path();
        if entry.file_type()?.is_dir() {
            walk(&path, files)?;
        } else if path.extension().is_some_and(|v| v == "jsonl")
            || path.to_string_lossy().ends_with(".jsonl.zst")
        {
            files.push(path);
        }
    }
    Ok(())
}
pub fn database(bridge: &Path) -> io::Result<Database> {
    let dir = bridge.join("usage");
    fs::create_dir_all(&dir)?;
    let db = Database::writable(&dir.join("usage.sqlite"))?;
    db.query("CREATE TABLE IF NOT EXISTS files(path TEXT PRIMARY KEY,size INTEGER,mtime TEXT,offset INTEGER,state TEXT)",&[])?;
    db.query("CREATE TABLE IF NOT EXISTS requests(client TEXT,t INTEGER,source_key TEXT,model TEXT,effort TEXT,tier TEXT,input INTEGER,cached_input INTEGER,cache_write_5m INTEGER,cache_write_1h INTEGER,output INTEGER,reasoning INTEGER,ok INTEGER,error TEXT,duration_ms INTEGER,project TEXT,file TEXT,uid TEXT,UNIQUE(client,uid))",&[])?;
    db.query(
        "CREATE INDEX IF NOT EXISTS requests_time ON requests(t)",
        &[],
    )?;
    Ok(db)
}
fn insert(
    context: (&Database, &[Source], &str, &str),
    uid: &str,
    e: &Envelope,
    state: &mut State,
    usage: &Value,
    outcome: (bool, Option<String>),
) -> io::Result<()> {
    let (db, sources, client, file) = context;
    let (ok, error) = outcome;
    let Some(t) = millis(&e.timestamp) else {
        return Ok(());
    };
    let source = sources
        .iter()
        .rev()
        .find(|s| s.client == client && s.time() <= t)
        .map(Source::key)
        .unwrap_or_else(|| "untracked".into());
    let previous = if client == "claude" {
        state.user
    } else {
        state.last
    };
    let duration = previous.map(|p| t.saturating_sub(p).max(0));
    let cached = if client == "codex" {
        count(usage, "cached_input_tokens")
    } else {
        count(usage, "cache_read_input_tokens")
    };
    let write5 = if client == "codex" {
        count(usage, "cache_write_input_tokens")
    } else {
        count(&usage["cache_creation"], "ephemeral_5m_input_tokens")
    };
    let write1 = if client == "claude" {
        count(&usage["cache_creation"], "ephemeral_1h_input_tokens")
    } else {
        0
    };
    db.query(
        "INSERT OR IGNORE INTO requests VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
        &[
            json!(client),
            json!(t),
            json!(source),
            if client == "claude" && !ok {
                Value::Null
            } else {
                json!(state.model)
            },
            json!(state.effort.clone().unwrap_or_default()),
            json!(state.tier.clone().unwrap_or_default()),
            json!(count(usage, "input_tokens")),
            json!(cached),
            json!(write5),
            json!(write1),
            json!(count(usage, "output_tokens")),
            json!(if client == "codex" {
                count(usage, "reasoning_output_tokens")
            } else {
                0
            }),
            json!(i64::from(ok)),
            json!(
                error
                    .unwrap_or_default()
                    .chars()
                    .take(120)
                    .collect::<String>()
            ),
            json!(duration.unwrap_or(-1)),
            json!(state.project),
            json!(file),
            json!(uid),
        ],
    )?;
    state.last = Some(t);
    Ok(())
}
fn process(
    db: &Database,
    sources: &[Source],
    client: &str,
    file: &str,
    offset: u64,
    e: Envelope,
    state: &mut State,
) -> io::Result<()> {
    let p = &e.payload;
    if client == "claude" {
        if e.kind == "user" {
            state.user = millis(&e.timestamp);
            return Ok(());
        }
        if e.kind != "assistant" {
            return Ok(());
        }
        state.project = e.cwd.clone();
        state.model = if e.api_error {
            String::new()
        } else {
            e.message.model.clone()
        };
        let uid = if e.message.id.is_empty() {
            format!("{file}:{offset}")
        } else {
            e.message.id.clone()
        };
        let reason = e
            .error
            .clone()
            .or(e.error_status.map(|v| format!("HTTP {v}")));
        insert(
            (db, sources, client, file),
            &uid,
            &e,
            state,
            &e.message.usage,
            (!e.api_error, reason),
        )?;
        return Ok(());
    }
    match e.kind.as_str() {
        "session_meta" => {
            state.thread = p.id.clone();
            state.project = p.cwd.clone();
        }
        "turn_context" => {
            state.model = p.model.clone();
            state.effort = p.effort.clone().or(p.reasoning_effort.clone());
            state.tier = p.service_tier.clone();
        }
        "response_item" if p.role == "user" => state.last = millis(&e.timestamp),
        "token_usage_record" => {
            if !state.modern {
                db.query("DELETE FROM requests WHERE file=?", &[json!(file)])?;
                state.modern = true;
            }
            let thread = if p.thread_id.is_empty() {
                &state.thread
            } else {
                &p.thread_id
            };
            let uid = format!("{thread}:{}", p.response_id);
            insert(
                (db, sources, client, file),
                &uid,
                &e,
                state,
                &p.usage,
                (true, None),
            )?;
        }
        "event_msg" => match p.kind.as_str() {
            "user_message" => state.last = millis(&e.timestamp),
            "thread_settings_applied" => {
                let s = &p.thread_settings;
                if let Some(m) = s["model"].as_str() {
                    state.model = m.into();
                }
                if let Some(v) = s["reasoning_effort"].as_str() {
                    state.effort = Some(v.into());
                }
                if s.get("service_tier").is_some() {
                    state.tier = s["service_tier"].as_str().map(str::to_owned);
                }
            }
            "token_count" if !state.modern && !p.info.is_null() => {
                let total = &p.info["total_token_usage"];
                if count(total, "total_tokens") > count(&state.total, "total_tokens") {
                    let mut delta = json!({});
                    for key in [
                        "input_tokens",
                        "cached_input_tokens",
                        "cache_write_input_tokens",
                        "output_tokens",
                        "reasoning_output_tokens",
                    ] {
                        delta[key] = json!((count(total, key) - count(&state.total, key)).max(0));
                    }
                    let uid = format!("{}:legacy:{offset}", state.thread);
                    insert(
                        (db, sources, client, file),
                        &uid,
                        &e,
                        state,
                        &delta,
                        (true, None),
                    )?;
                }
                state.total = total.clone();
            }
            "task_complete" if !p.error.is_null() => {
                let reason = if let Some(v) = p.error.as_str() {
                    v.to_owned()
                } else {
                    format!(
                        "{}: {}",
                        p.error["codex_error_info"]
                            .as_str()
                            .or(p.error["type"].as_str())
                            .unwrap_or("unknown"),
                        text(&p.error["message"])
                    )
                };
                let uid = format!("{}:error:{}", state.thread, e.timestamp);
                insert(
                    (db, sources, client, file),
                    &uid,
                    &e,
                    state,
                    &json!({}),
                    (false, Some(reason)),
                )?;
            }
            _ => {}
        },
        _ => {}
    }
    Ok(())
}
pub fn scan(app: &App, db: &Database, sources: &[Source], client: &str) -> io::Result<()> {
    let mut files = vec![];
    if client == "codex" {
        for dir in ["sessions", "archived_sessions"] {
            walk(&app.codex_home().join(dir), &mut files)?;
        }
    } else {
        walk(&super::claude_home().join("projects"), &mut files)?;
    }
    files.sort();
    let mut logical = HashSet::new();
    db.query("BEGIN IMMEDIATE", &[])?;
    let result = (|| {
        for file in files {
            let physical = crate::platform::display_path(&file);
            let compressed = physical.ends_with(".zst");
            let key = physical
                .strip_suffix(".zst")
                .unwrap_or(&physical)
                .to_owned();
            if !logical.insert(key.clone()) {
                continue;
            }
            let meta = fs::metadata(&file)?;
            let size = meta.len();
            let mtime = format!(
                "{}:{}:{}",
                physical,
                meta.modified()?
                    .duration_since(UNIX_EPOCH)
                    .map_err(io::Error::other)?
                    .as_nanos(),
                identity(&meta)
            );
            let old = db
                .query("SELECT * FROM files WHERE path=?", &[json!(key)])?
                .pop();
            if old
                .as_ref()
                .is_some_and(|v| v["size"] == size && v["mtime"] == mtime)
            {
                continue;
            }
            let append = !compressed
                && old.as_ref().is_some_and(|v| {
                    v["size"].as_u64().is_some_and(|n| n < size)
                        && text(&v["mtime"]).rsplit(':').next() == mtime.rsplit(':').next()
                });
            let mut state: State = if append {
                serde_json::from_str(text(&old.as_ref().unwrap()["state"]))
                    .map_err(io::Error::other)?
            } else {
                db.query("DELETE FROM requests WHERE file=?", &[json!(key)])?;
                State::default()
            };
            let offset = if append {
                old.as_ref().unwrap()["offset"].as_u64().unwrap_or(0)
            } else {
                0
            };
            let mut input = fs::File::open(&file)?;
            let mut reader: Box<dyn BufRead> = if compressed {
                Box::new(BufReader::new(
                    ruzstd::decoding::StreamingDecoder::new(input).map_err(io::Error::other)?,
                ))
            } else {
                input.seek(SeekFrom::Start(offset))?;
                Box::new(BufReader::new(input))
            };
            let mut position = offset;
            let mut line = vec![];
            loop {
                line.clear();
                let read = reader.read_until(b'\n', &mut line)?;
                if read == 0 {
                    break;
                }
                if !line.ends_with(b"\n") {
                    break;
                }
                let e: Envelope = serde_json::from_slice(&line).map_err(io::Error::other)?;
                process(db, sources, client, &key, position, e, &mut state)?;
                position += read as u64;
            }
            db.query(
                "INSERT OR REPLACE INTO files VALUES(?,?,?,?,?)",
                &[
                    json!(key),
                    json!(size),
                    json!(mtime),
                    json!(position),
                    json!(serde_json::to_string(&state).map_err(io::Error::other)?),
                ],
            )?;
        }
        Ok::<_, io::Error>(())
    })();
    if result.is_ok() {
        db.query("COMMIT", &[])?;
    } else {
        db.query("ROLLBACK", &[])?;
    }
    result
}
#[cfg(windows)]
fn identity(m: &fs::Metadata) -> u64 {
    use std::os::windows::fs::MetadataExt;
    m.creation_time()
}
#[cfg(unix)]
fn identity(m: &fs::Metadata) -> u64 {
    use std::os::unix::fs::MetadataExt;
    m.ino()
}
