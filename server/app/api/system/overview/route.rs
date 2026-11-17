//! `GET /api/system/overview` — every user, for the product operator's panel.

use axum::{Extension, Json};
use http::HeaderMap;
use linkedin_challenge_server::dto::{SystemOverview, require_system_admin, system_overview};
use linkedin_challenge_server::web::ApiError;
use toasty::Db;

#[nextrs::api(operation_id = "getSystemOverview")]
pub async fn get(
    Extension(mut db): Extension<Db>,
    timing: nextrs::Timing,
    headers: HeaderMap,
) -> Result<Json<SystemOverview>, ApiError> {
    timing.span("session", require_system_admin(&mut db, &headers)).await?;
    Ok(Json(timing.span("db", system_overview(&mut db)).await?))
}
