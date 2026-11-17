//! `GET /api/plaza/roster` — everyone the plaza shows: each member who is not deleted, their
//! avatar, and whether they posted an original this lottery week; plus the caller's id and where
//! the live room is. Open to every signed-in member (not only those who may use challenges); during
//! "View as" `me` is the impersonated member. The rules live in `src/plaza.rs`.

use axum::{Extension, Json};
use http::HeaderMap;
use linkedin_challenge_server::dto::require_member;
use linkedin_challenge_server::plaza::{PlazaRoster, roster};
use linkedin_challenge_server::util::now_unix;
use linkedin_challenge_server::web::ApiError;
use toasty::Db;

#[nextrs::api(
    operation_id = "getPlazaRoster",
    responses(
        (status = 200, description = "Every member, their avatar and star, and the room's URL", body = PlazaRoster),
        (status = 401, description = "Not signed in", body = ApiError),
    ),
)]
pub async fn get(
    Extension(mut db): Extension<Db>,
    timing: nextrs::Timing,
    headers: HeaderMap,
) -> Result<Json<PlazaRoster>, ApiError> {
    let member = timing.span("session", require_member(&mut db, &headers)).await?;
    let roster = timing.span("db", roster(&mut db, &member, now_unix())).await?;
    Ok(Json(roster))
}
