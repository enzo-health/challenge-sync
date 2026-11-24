//! Domain layer. The `app/` convention files are thin adapters over these modules —
//! see `app/api/sync/route.rs` for the shape.

pub mod accounts;
pub mod auth;
pub mod avatar;
pub mod beacon;
pub mod db_timing;
pub mod dto;
pub mod enroll;
pub mod lottery;
pub mod lottery_draw;
pub mod models;
pub mod plaza;
pub mod reads;
pub mod reports;
pub mod scoring;
pub mod seed;
pub mod seeds;
pub mod stats;
pub mod util;
pub mod web;

/// Install the `tracing` subscriber both entry points share. `RUST_LOG` picks what is shown and
/// replaces the default entirely. Without it: warnings (such as a slow database operation from
/// [`db_timing`]), plus nextrs's `nextrs::preload` info events, which only exist when
/// `NEXTRS_PRELOAD_STATS=1` mounts the browser's preload report sink (off by default).
/// Useful overrides: `RUST_LOG=app::db=debug` for every query's duration,
/// `RUST_LOG=nextrs::telemetry=info` for nextrs's per-request summary. No ANSI colours, so the
/// lines read cleanly in Vercel's function logs.
pub fn init_tracing() {
    let filter = tracing_subscriber::EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("warn,nextrs::preload=info"));
    let _ = tracing_subscriber::fmt().with_env_filter(filter).with_ansi(false).try_init();
}
