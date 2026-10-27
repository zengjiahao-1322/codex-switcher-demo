mod server;
mod instance;
mod platform;
mod diagnostics;
mod config;
mod accounts;
mod switching;
mod editors;
mod adapter;
mod lifecycle;
mod mcp;
mod packaging;

#[tokio::main(flavor="current_thread")]
async fn main()->Result<(),Box<dyn std::error::Error>>{instance::run().await}
