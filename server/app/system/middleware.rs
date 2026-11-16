//! System-admin guard for `/system/**` — the product operator's panel.

use axum::response::{IntoResponse, Redirect};
use linkedin_challenge_server::auth::current_system_admin;
use nextrs::conventions::MiddlewareResult;
use toasty::Db;

pub async fn handle(req: http::Request<axum::body::Body>) -> MiddlewareResult {
    let Some(db) = req.extensions().get::<Db>().cloned() else {
        return MiddlewareResult::response(
            (http::StatusCode::INTERNAL_SERVER_ERROR, "no database").into_response(),
        );
    };

    let mut db = db;
    let timing = nextrs::Timing::from_extensions(req.extensions());
    if timing.span("session", current_system_admin(&mut db, req.headers())).await.is_none() {
        return MiddlewareResult::response(Redirect::to("/").into_response());
    }
    MiddlewareResult::next(req)
}
