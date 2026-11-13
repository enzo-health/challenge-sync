//! `POST /api/auth/device/web-session` — turn a device sync token into a website session.
//!
//! The mirror image of `/api/auth/device/session`. That one lets the extension borrow a website
//! login; this one lets the website borrow the extension's, so nobody types a password. The
//! extension holds an explicit host permission for this server, so it writes the returned token
//! into the browser's cookie jar itself and the site opens already signed in.

use axum::{Extension, Json};
use http::HeaderMap;
use linkedin_challenge_server::auth::{SESSION_SECS, bearer_member, new_session_token};
use linkedin_challenge_server::enroll::enroll_in_running_challenges;
use linkedin_challenge_server::web::ApiError;
use serde::{Deserialize, Serialize};
use toasty::Db;
use utoipa::ToSchema;

#[derive(Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct WebSessionResponse {
    /// Value for the `session` cookie on this server.
    pub session_token: String,
    /// Seconds the session stays valid; use it as the cookie lifetime.
    pub max_age: i64,
}

#[nextrs::api(
    operation_id = "startWebSessionFromDevice",
    responses(
        (status = 200, description = "Website session created", body = WebSessionResponse),
        (status = 401, description = "Invalid or missing sync token", body = ApiError),
    ),
)]
pub async fn post(
    Extension(mut db): Extension<Db>,
    headers: HeaderMap,
) -> Result<Json<WebSessionResponse>, ApiError> {
    let member = bearer_member(&mut db, &headers).await?;
    // The same catch-up a password login does: accounts that predate the running challenge join it.
    enroll_in_running_challenges(&mut db, member.id).await?;
    let session_token = new_session_token(&mut db, member.id, None).await?;
    Ok(Json(WebSessionResponse {
        session_token,
        max_age: SESSION_SECS,
    }))
}
