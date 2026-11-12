//! Challenge Sync server — a nextrs (Axum) + Toasty (libsql/Turso) app.
//!
//! Run with `cargo dev`. Env:
//!   DATABASE_URL  connection string (default `turso:linkedin.db` — a local libsql file)
//!   SEED_LOCAL=1  seed one empty local account (no challenges or fake LinkedIn data)
//!   SEED_DEMO=1   seed a populated "Demo Corp" leaderboard on first run
//!   PORT          bind port (default 3312)

use linkedin_challenge_server::{models, seed};

include!(concat!(env!("OUT_DIR"), "/nextrs_routes.rs"));

use axum::Extension;
use tower_http::cors::{Any, CorsLayer};

#[tokio::main]
async fn main() {
    dotenvy::dotenv().ok();

    let db = models::connect().await;

    // Everyone competes in whatever is running. Backfill accounts that predate auto-enrollment.
    {
        let mut enroll_db = db.clone();
        match linkedin_challenge_server::enroll::enroll_everyone(&mut enroll_db).await {
            Ok(0) => {}
            Ok(added) => println!("auto-enrolled {added} membership(s) in running challenges"),
            Err(error) => eprintln!("auto-enrollment failed: {error}"),
        }
    }

    // Development should always have one known way in, whether started through `just dev`,
    // `cargo dev`, or `cargo run`. Release builds never seed it unless explicitly requested.
    if cfg!(debug_assertions) || std::env::var("SEED_LOCAL").is_ok() {
        let mut seed_db = db.clone();
        seed::seed_local_account(&mut seed_db)
            .await
            .expect("failed to seed local account");
        println!(
            "local account ready: {} / {}",
            seed::LOCAL_EMAIL,
            seed::LOCAL_PASSWORD
        );
    }

    if std::env::var("SEED_DEMO").is_ok() {
        let mut seed_db = db.clone();
        seed::seed_demo(&mut seed_db)
            .await
            .expect("failed to seed demo data");
    }

    let public_dir = std::env::var("NEXTRS_PUBLIC_DIR")
        .unwrap_or_else(|_| concat!(env!("CARGO_MANIFEST_DIR"), "/public").to_string());

    // The Chrome extension posts to /api/link and /api/sync from a different origin and needs to
    // read the responses. Bearer-token auth, never cookies, so a permissive origin is safe here.
    let cors = CorsLayer::new()
        .allow_origin(Any)
        .allow_methods(Any)
        .allow_headers(Any);

    let app = nextrs::router::build_router_with_public(generated_registry(), &public_dir)
        .merge(nextrs::openapi::spec_router(generated_openapi()))
        .layer(cors)
        .layer(Extension(db));

    #[cfg(debug_assertions)]
    let app = app.layer(tower_livereload::LiveReloadLayer::new());

    // Fixed port, no silent fallback. The extension is built against one hard-coded server URL,
    // so a server that quietly moved to the next free port would just look broken to it.
    let port: u16 = std::env::var("PORT")
        .ok()
        .and_then(|p| p.parse().ok())
        .unwrap_or(3312);
    let listener = bind(port).await;
    let local = listener.local_addr().expect("listener has a local addr");
    println!("listening on http://{local}");

    axum::serve(listener, app)
        .with_graceful_shutdown(shutdown_signal())
        .await
        .unwrap();
}

/// Bind `0.0.0.0:port`, or fail loudly. Moving to another port would break the extension.
async fn bind(port: u16) -> tokio::net::TcpListener {
    match tokio::net::TcpListener::bind(("0.0.0.0", port)).await {
        Ok(listener) => listener,
        Err(e) if e.kind() == std::io::ErrorKind::AddrInUse => {
            eprintln!(
                "Port {port} is already in use. Stop whatever is on it, or set PORT — but note the \
                 extension is built against a fixed server URL, so change extension/config.js too."
            );
            std::process::exit(1);
        }
        Err(e) => {
            eprintln!("Failed to bind 0.0.0.0:{port}: {e}");
            std::process::exit(1);
        }
    }
}

async fn shutdown_signal() {
    let ctrl_c = async {
        tokio::signal::ctrl_c()
            .await
            .expect("install Ctrl-C handler");
    };

    #[cfg(unix)]
    let terminate = async {
        tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
            .expect("install SIGTERM handler")
            .recv()
            .await;
    };

    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();

    tokio::select! {
        _ = ctrl_c => {}
        _ = terminate => {}
    }
}
