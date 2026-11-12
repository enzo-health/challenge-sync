//! `POST /api/system/join-link` — generate the company join link, or replace it.
//!
//! The new code is stored and returned; the previous one stops working at once. People who have
//! already joined are unaffected: they sign in with their device token, not the link.

use axum::{Extension, Json};
use http::HeaderMap;
use linkedin_challenge_server::auth::regenerate_join_code;
use linkedin_challenge_server::dto::require_system_admin;
use linkedin_challenge_server::web::ApiError;
use serde::{Deserialize, Serialize};
use toasty::Db;
use utoipa::ToSchema;

#[derive(Deserialize, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct JoinLinkResponse {
    /// The new join code; the link is `/join/<code>`.
    pub join_code: String,
}

#[nextrs::api(
    operation_id = "regenerateJoinLink",
    responses(
        (status = 200, description = "A new join code; the old one no longer works", body = JoinLinkResponse),
        (status = 401, description = "Not an admin", body = ApiError),
    ),
)]
pub async fn post(
    Extension(mut db): Extension<Db>,
    headers: HeaderMap,
) -> Result<Json<JoinLinkResponse>, ApiError> {
    let operator = require_system_admin(&mut db, &headers).await?;
    let join_code = regenerate_join_code(&mut db, operator.id).await?;
    Ok(Json(JoinLinkResponse { join_code }))
}
