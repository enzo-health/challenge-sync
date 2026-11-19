//! `DELETE /api/me/api-keys/{id}` — revoke one of the signed-in member's own API keys. It stops
//! working at once.
//!
//! Only a personal key the member owns can be revoked here. Anyone else's key, and an admin key
//! they made on the Reports page, answers 404 exactly like a key that does not exist, so the
//! route says nothing about other people's keys.

use axum::extract::Path;
use axum::{Extension, Json};
use http::HeaderMap;
use linkedin_challenge_server::dto::require_member;
use linkedin_challenge_server::models::ApiKey;
use linkedin_challenge_server::web::ApiError;
use serde::{Deserialize, Serialize};
use toasty::Db;
use utoipa::ToSchema;

#[derive(Deserialize, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct RevokeMyApiKeyResponse {
    pub ok: bool,
}

#[nextrs::api(
    operation_id = "revokeMyApiKey",
    responses(
        (status = 200, description = "The key was deleted", body = RevokeMyApiKeyResponse),
        (status = 401, description = "Not signed in", body = ApiError),
        (status = 404, description = "No such key among the member's own", body = ApiError),
    ),
)]
pub async fn delete(
    Extension(mut db): Extension<Db>,
    timing: nextrs::Timing,
    headers: HeaderMap,
    Path(id): Path<i64>,
) -> Result<Json<RevokeMyApiKeyResponse>, ApiError> {
    let member = timing.span("session", require_member(&mut db, &headers)).await?;
    let owned = ApiKey::filter_by_id(id)
        .first()
        .exec(&mut db)
        .await?
        .is_some_and(|key| key.personal && key.created_by == member.id);
    if !owned {
        return Err(ApiError::not_found("no such API key among yours"));
    }
    ApiKey::filter_by_id(id).delete().exec(&mut db).await?;
    Ok(Json(RevokeMyApiKeyResponse { ok: true }))
}
