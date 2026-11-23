//! Requests that never reach a rollout, read from Codex's own log database:
//! automatic retries, HTTP failures and background calls such as memories.
use super::Source;
use crate::sqlite::Database;
use serde_json::{Value, json};
use std::{collections::HashMap, fs, io, path::Path};

const SELECT: &str = "SELECT id,ts,ts_nanos,target,thread_id,feedback_log_body AS body FROM logs WHERE id>? AND (target='codex_core::responses_retry' OR (target='codex_http_client::client' AND feedback_log_body LIKE '%Request completed method=POST url=%/responses status=%') OR (target='feedback_tags' AND thread_id IS NULL AND feedback_log_body LIKE 'model_client.stream_responses_api{model=%')) ORDER BY id";

// A span value such as `model=gpt-6.1-sol`; `cwd=` may contain spaces and ends at the span's `}`.
fn field<'a>(body: &'a str, key: &str) -> Option<&'a str> {
    let start = body.find(&format!("{key}="))? + key.len() + 1;
    let rest = &body[start..];
    let end = if key == "cwd" {
        rest.find('}')
    } else {
        rest.find([' ', '}'])
    };
    Some(&rest[..end.unwrap_or(rest.len())]).filter(|s| !s.is_empty())
}

// `status=500 Internal Server Error headers={...}` -> (500, "HTTP 500 Internal Server Error").
// None when the line carries no status, e.g. a background call whose HTTP line was pruned.
fn status(body: &str) -> Option<(u16, String)> {
    let rest = &body[body.find("status=")? + 7..];
    let rest = &rest[..rest.find(" headers=").unwrap_or(rest.len())];
    Some((
        rest.split(' ').next()?.parse().ok()?,
        format!("HTTP {}", rest.trim()),
    ))
}

pub fn scan(codex_home: &Path, db: &Database, sources: &[Source]) -> io::Result<()> {
    let Some(file) = latest(codex_home)? else {
        return Ok(());
    };
    let name = file.file_name().unwrap().to_string_lossy().to_string();
    let key = crate::platform::display_path(&file);
    let last = db.query("SELECT last FROM logs WHERE path=?", &[json!(key)])?;
    let last = last.first().map_or(0, |r| r["last"].as_i64().unwrap_or(0));
    let log = Database::open(&file)?;
    let rows = log.query(SELECT, &[json!(last)])?;
    // turn -> time of its latest HTTP failure; a retry warning right after it is the same failure.
    let mut failed_at = HashMap::<String, i64>::new();
    let mut newest = last;
    for row in &rows {
        let id = row["id"].as_i64().unwrap();
        newest = id;
        let body = row["body"].as_str().unwrap_or("");
        let t = row["ts"].as_i64().unwrap() * 1000 + row["ts_nanos"].as_i64().unwrap_or(0) / 1_000_000;
        let turn = field(body, "turn_id").or(field(body, "turn.id")).unwrap_or("");
        let insert = |kind: &str, ok: bool, error: Option<String>, attempt: Option<&str>| {
            let tokens = if kind == "background" { Value::Null } else { json!(0) };
            let source = sources
                .iter()
                .rev()
                .find(|s| s.client == "codex" && s.time() <= t)
                .map(Source::key)
                .unwrap_or_else(|| "untracked".into());
            db.query(
                "INSERT OR IGNORE INTO requests(client,t,source_key,model,effort,tier,input,cached_input,cache_write_5m,cache_write_1h,output,reasoning,ok,error,duration_ms,project,file,uid,kind,attempt) VALUES('codex',?,?,?,?,'',?,?,?,?,?,?,?,?,-1,?,?,?,?,?)",
                &[
                    json!(t),
                    json!(source),
                    json!(field(body, "model").unwrap_or("")),
                    json!(field(body, "codex.turn.reasoning_effort").unwrap_or("")),
                    tokens.clone(),
                    tokens.clone(),
                    tokens.clone(),
                    tokens.clone(),
                    tokens.clone(),
                    tokens,
                    json!(i64::from(ok)),
                    json!(error.unwrap_or_default().chars().take(120).collect::<String>()),
                    json!(field(body, "cwd").unwrap_or("")),
                    json!(key),
                    json!(format!("log:{name}:{id}")),
                    json!(kind),
                    json!(attempt),
                ],
            )
        };
        match row["target"].as_str().unwrap_or("") {
            "codex_core::responses_retry" => {
                let duplicate = failed_at.get(turn).is_some_and(|at| (0..=1000).contains(&(t - at)));
                if !duplicate {
                    let attempt = body
                        .split("retrying sampling request (")
                        .nth(1)
                        .and_then(|s| s.split(' ').next());
                    let error = body.split("sampling_error=").nth(1).map(str::to_owned);
                    insert("retry", false, error, attempt)?;
                }
            }
            "codex_http_client::client" => {
                if let Some((code, error)) = status(body)
                    && !(200..300).contains(&code)
                {
                    failed_at.insert(turn.to_owned(), t);
                    insert("http", false, Some(error), None)?;
                }
            }
            _ => {
                // The background request's result is normally the HTTP line written just before it;
                // when that line is gone the request still counts, with its result unknown (ok).
                let http = log.query(
                    "SELECT feedback_log_body AS body FROM logs WHERE id=?",
                    &[json!(id - 1)],
                )?;
                let failed = http
                    .first()
                    .and_then(|r| status(r["body"].as_str().unwrap_or("")))
                    .filter(|(code, _)| !(200..300).contains(code));
                insert("background", failed.is_none(), failed.map(|(_, e)| e), None)?;
            }
        }
    }
    db.query(
        "INSERT OR REPLACE INTO logs VALUES(?,?)",
        &[json!(key), json!(newest)],
    )?;
    Ok(())
}

// Codex numbers the log database (logs_2.sqlite); a newer schema starts a new file.
fn latest(codex_home: &Path) -> io::Result<Option<std::path::PathBuf>> {
    if !codex_home.exists() {
        return Ok(None);
    }
    let mut best = None;
    for entry in fs::read_dir(codex_home)? {
        let path = entry?.path();
        let name = path.file_name().unwrap().to_string_lossy().to_string();
        if let Some(n) = name
            .strip_prefix("logs_")
            .and_then(|s| s.strip_suffix(".sqlite"))
            .and_then(|s| s.parse::<u32>().ok())
            && best.as_ref().is_none_or(|(m, _)| n > *m)
        {
            best = Some((n, path));
        }
    }
    Ok(best.map(|(_, p)| p))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_retries_failures_and_background_calls_from_a_wal_log() {
        let root = std::env::temp_dir().join(format!("usage-logs-{}", crate::editors::uuid().unwrap()));
        fs::create_dir_all(root.join("home")).unwrap();
        let file = root.join("home").join("logs_2.sqlite");
        let log = Database::writable(&file).unwrap();
        log.query("PRAGMA journal_mode=WAL", &[]).unwrap();
        log.query("PRAGMA wal_autocheckpoint=0", &[]).unwrap();
        log.query("CREATE TABLE logs(id INTEGER PRIMARY KEY AUTOINCREMENT,ts INTEGER NOT NULL,ts_nanos INTEGER NOT NULL,level TEXT NOT NULL,target TEXT NOT NULL,feedback_log_body TEXT,thread_id TEXT)", &[]).unwrap();
        let turn = "turn{otel.name=\"session_task.turn\" thread.id=t1 turn.id=u1 model=gpt-6.1-sol codex.turn.reasoning_effort=high}:run_sampling_request{turn_id=u1 model=gpt-6.1-sol cwd=C:\\Users\\me\\My Project}";
        let add = |ts: i64, nanos: i64, target: &str, thread: Option<&str>, body: String| {
            log.query(
                "INSERT INTO logs(ts,ts_nanos,level,target,feedback_log_body,thread_id) VALUES(?,?,'INFO',?,?,?)",
                &[json!(ts), json!(nanos), json!(target), json!(body), json!(thread)],
            )
            .unwrap();
        };
        let http = |code: &str| format!("{turn}: Request completed method=POST url=http://127.0.0.1:8317/v1/responses status={code} headers={{\"a\": \"b\"}}");
        add(100, 0, "codex_http_client::client", Some("t1"), http("200 OK"));
        add(101, 0, "codex_http_client::client", Some("t1"), http("429 Too Many Requests"));
        add(101, 0, "codex_core::responses_retry", Some("t1"), format!("{turn}: stream disconnected - retrying sampling request (1/5 in 30s)... turn_id=u1 retries=1 max_retries=5 sampling_error=exceeded retry limit"));
        add(200, 0, "codex_core::responses_retry", Some("t1"), format!("{turn}: stream disconnected - retrying sampling request (2/5 in 300s)... turn_id=u1 retries=2 max_retries=5 sampling_error=Selected model is at capacity. Please try a different model."));
        let bg = "model_client.stream_responses_api{model=gpt-6-luna wire_api=responses}:responses.stream_request{}";
        add(300, 0, "codex_http_client::client", None, format!("{bg}: Request completed method=POST url=http://127.0.0.1:8317/v1/responses status=200 OK headers={{}}"));
        add(300, 5_000_000, "feedback_tags", None, format!("{bg}: endpoint=\"/responses\""));

        fs::create_dir_all(root.join("usage")).unwrap();
        let usage = Database::writable(&root.join("usage").join("usage.sqlite")).unwrap();
        usage.query("CREATE TABLE requests(client TEXT,t INTEGER,source_key TEXT,model TEXT,effort TEXT,tier TEXT,input INTEGER,cached_input INTEGER,cache_write_5m INTEGER,cache_write_1h INTEGER,output INTEGER,reasoning INTEGER,ok INTEGER,error TEXT,duration_ms INTEGER,project TEXT,file TEXT,uid TEXT,UNIQUE(client,uid))", &[]).unwrap();
        usage.query("INSERT INTO requests(client,t,uid,ok) VALUES('codex',1,'old',1)", &[]).unwrap();
        drop(usage);
        let usage = crate::usage::scan::database(&root).unwrap();
        // The schema upgrade keeps rows indexed by an older version.
        assert_eq!(usage.query("SELECT kind FROM requests WHERE uid='old'", &[]).unwrap()[0]["kind"], "turn");

        scan(&root.join("home"), &usage, &[]).unwrap();
        // Uncheckpointed WAL rows are read while the writer still holds the database open.
        let rows = usage.query("SELECT kind,ok,model,effort,error,attempt,input,project,t FROM requests WHERE uid<>'old' ORDER BY t", &[]).unwrap();
        assert_eq!(rows.len(), 3, "{rows:?}");
        assert_eq!(rows[0]["kind"], "http");
        assert_eq!(rows[0]["error"], "HTTP 429 Too Many Requests");
        assert_eq!(rows[0]["model"], "gpt-6.1-sol");
        assert_eq!(rows[0]["effort"], "high");
        assert_eq!(rows[0]["project"], "C:\\Users\\me\\My Project");
        assert_eq!(rows[1]["kind"], "retry");
        assert_eq!(rows[1]["attempt"], "2/5");
        assert_eq!(rows[1]["error"], "Selected model is at capacity. Please try a different model.");
        assert_eq!(rows[2]["kind"], "background");
        assert_eq!(rows[2]["ok"], 1);
        assert_eq!(rows[2]["model"], "gpt-6-luna");
        assert!(rows[2]["input"].is_null());
        assert_eq!(rows[2]["t"], 300_005);

        add(400, 0, "codex_core::responses_retry", Some("t1"), format!("{turn}: stream disconnected - retrying sampling request (3/5 in 300s)... turn_id=u1 retries=3 max_retries=5 sampling_error=again"));
        scan(&root.join("home"), &usage, &[]).unwrap();
        assert_eq!(usage.query("SELECT COUNT(*) AS n FROM requests WHERE uid<>'old'", &[]).unwrap()[0]["n"], 4);
        drop(log);
        drop(usage);
        fs::remove_dir_all(&root).unwrap();
    }
}
