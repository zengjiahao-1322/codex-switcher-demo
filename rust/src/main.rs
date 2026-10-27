mod accounts;
mod adapter;
mod config;
mod diagnostics;
mod editors;
mod instance;
mod integration;
mod lifecycle;
mod mcp;
mod packaging;
mod platform;
mod server;
mod sqlite;
mod switching;

#[tokio::main(flavor = "current_thread")]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    instance::run().await
}
