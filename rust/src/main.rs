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

#[tokio::main(flavor = "current_thread")]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    instance::run().await
}
