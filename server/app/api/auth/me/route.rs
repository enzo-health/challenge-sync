//! `GET /api/auth/me` — who, if anyone, is signed in. The sidebar shell reads this for navigation,
//! the impersonation banner, and the "Chrome paused Challenge Sync" banner.

use axum::{Extension, Json};
use http::HeaderMap;
use linkedin_challenge_server::auth::current_session;
use linkedin_challenge_server::reads::{self, MeResponse};
use linkedin_challenge_server::web::ApiError;
use toasty::Db;

#[nextrs::api(operation_id = "getMe")]
pub async fn get(
    Extension(mut db): Extension<Db>,
    timing: nextrs::Timing,
    headers: HeaderMap,
) -> Result<Json<MeResponse>, ApiError> {
    let session = timing.span("session", current_session(&mut db, &headers)).await;
    Ok(Json(reads::me(&mut db, &timing, session.as_ref()).await?))
}
