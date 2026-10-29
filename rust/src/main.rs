mod accounts;
mod adapter;
mod adapter_convert;
mod config;
mod config_catalog;
mod config_network;
mod config_ops;
mod config_store;
mod config_text;
mod diagnostics;
mod editor_integration;
mod editors;
mod instance;
mod integration;
mod lifecycle;
mod mcp;
mod official_session;
mod packaging;
mod platform;
mod remote;
mod server;
mod sqlite;
mod switching;
mod thread_routing;
mod update;

#[tokio::main(flavor = "current_thread")]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    if std::env::args().nth(1).as_deref() == Some("--stop-installed") {
        let record = std::env::args().nth(2).ok_or("Running record required")?;
        let target = std::env::args()
            .nth(3)
            .ok_or("Installed directory required")?;
        instance::stop_installed(std::path::Path::new(&record), std::path::Path::new(&target))
            .await?;
        return Ok(());
    }
    if std::env::args().nth(1).as_deref() == Some("--mcp") {
        return mcp::run().await;
    }
    if std::env::args().nth(1).as_deref() == Some("--update-worker") {
        let path = std::env::args().nth(2).ok_or("Update job path required")?;
        update::worker(std::path::Path::new(&path)).await?;
        return Ok(());
    }
    if std::env::args().nth(1).as_deref() == Some("--build-info") {
        let mut build = instance::runtime();
        for field in ["pid", "entry", "runtime"] {
            build.as_object_mut().unwrap().remove(field);
        }
        println!("{build}");
        return Ok(());
    }
    if std::env::args().nth(1).as_deref() == Some("--cli") {
        let app = instance::fixture_app()?;
        let action = std::env::args().nth(2).unwrap_or_default();
        if !["status", "restore", "cleanup"].contains(&action.as_str()) {
            println!("usage: node cli.cjs status|restore|cleanup");
            std::process::exit(2);
        }
        match lifecycle::cli(&app, &action).await {
            Ok(output) => println!("{output}"),
            Err(error) => {
                eprintln!("ERROR: {error}");
                std::process::exit(1);
            }
        }
        return Ok(());
    }
    instance::run().await
}
