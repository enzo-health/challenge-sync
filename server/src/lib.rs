//! Domain layer. The `app/` convention files are thin adapters over these modules —
//! see `app/api/sync/route.rs` for the shape.

pub mod accounts;
pub mod auth;
pub mod db_timing;
pub mod dto;
pub mod enroll;
pub mod lottery;
pub mod models;
pub mod reports;
pub mod scoring;
pub mod seed;
pub mod stats;
pub mod util;
pub mod web;

/// Install the `tracing` subscriber both entry points share. `RUST_LOG` picks what is shown;
/// without it only warnings (such as a slow database operation from [`db_timing`]) are printed.
/// Useful overrides: `RUST_LOG=app::db=debug` for every query's duration,
/// `RUST_LOG=nextrs::telemetry=info` for nextrs's per-request summary. No ANSI colours, so the
/// lines read cleanly in Vercel's function logs.
pub fn init_tracing() {
    let filter = tracing_subscriber::EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("warn"));
    let _ = tracing_subscriber::fmt().with_env_filter(filter).with_ansi(false).try_init();
}
