//! `POST /api/plaza/pass` — a short-lived signed pass that admits the caller to the plaza's live
//! room (`../plaza/`), which checks it with the public key alone. The pass always names the member
//! the session acts as (the impersonated member during "View as", like every `/api/me` route); the
//! request carries no member id, and any body or query is ignored. Open to every signed-in member.
//! Signed with `PLAZA_PASS_PRIVATE_KEY`; without it the server refuses with a 503 saying so.

use axum::Extension;
use axum::Json;
use axum::response::{IntoResponse, Response};
use http::HeaderMap;
use linkedin_challenge_server::dto::require_member;
use linkedin_challenge_server::plaza::{PlazaPass, issue_pass};
use linkedin_challenge_server::util::now_unix;
use linkedin_challenge_server::web::ApiError;
use toasty::Db;

#[nextrs::api(
    operation_id = "createPlazaPass",
    responses(
        (status = 200, description = "A pass for the caller, valid for a minute", body = PlazaPass),
        (status = 401, description = "Not signed in", body = ApiError),
        (status = 503, description = "PLAZA_PASS_PRIVATE_KEY is missing (plaza_key_missing) or invalid (plaza_key_invalid)", body = ApiError),
    ),
)]
pub async fn post(
    Extension(mut db): Extension<Db>,
    timing: nextrs::Timing,
    headers: HeaderMap,
) -> Result<Response, ApiError> {
    let member = timing.span("session", require_member(&mut db, &headers)).await?;
    let pass = issue_pass(member.id, now_unix())?;
    // A bearer credential for the room: never kept by a cache.
    Ok(([(http::header::CACHE_CONTROL, "no-store")], Json(pass)).into_response())
}
