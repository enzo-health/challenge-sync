//! Vercel serverless entry point.
//!
//! Must mirror `src/main.rs`'s wiring, not just its router: without the `Db` extension every
//! data route 500s, and without CORS the Chrome extension cannot read a response. Deployed
//! builds are the least-tested path, so anything main.rs layers on belongs here too.

use axum::Extension;
use linkedin_challenge_server::models;
use nextrs::vercel::StreamingVercelLayer;
use tower::ServiceBuilder;
use tower_http::cors::{Any, CorsLayer};

include!(concat!(env!("OUT_DIR"), "/nextrs_routes.rs"));

#[tokio::main]
async fn main() -> Result<(), vercel_runtime::Error> {
    linkedin_challenge_server::init_tracing();
    let db = models::connect().await;

    // Bearer-authenticated, never cookie-authenticated — see the CORS note in main.rs.
    let cors = CorsLayer::new()
        .allow_origin(Any)
        .allow_methods(Any)
        .allow_headers(Any);

    let router = nextrs::router::build_router(generated_registry())
        .merge(nextrs::openapi::spec_router(generated_openapi()))
        .layer(cors)
        .layer(Extension(db));

    let app = ServiceBuilder::new()
        .layer(StreamingVercelLayer::new())
        .service(router);

    vercel_runtime::run(app).await
}
