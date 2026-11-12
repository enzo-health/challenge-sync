//! `DELETE /api/system/api-keys/{id}` — revoke an API key. It stops working at once.

use axum::extract::Path;
use axum::{Extension, Json};
use http::HeaderMap;
use linkedin_challenge_server::dto::require_system_admin;
use linkedin_challenge_server::models::ApiKey;
use linkedin_challenge_server::web::ApiError;
use serde::{Deserialize, Serialize};
use toasty::Db;
use utoipa::ToSchema;

#[derive(Deserialize, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct RevokeApiKeyResponse {
    pub ok: bool,
}

#[nextrs::api(
    operation_id = "revokeApiKey",
    responses(
        (status = 200, description = "The key was deleted", body = RevokeApiKeyResponse),
        (status = 401, description = "Not an admin", body = ApiError),
        (status = 404, description = "No such key", body = ApiError),
    ),
)]
pub async fn delete(
    Extension(mut db): Extension<Db>,
    headers: HeaderMap,
    Path(id): Path<i64>,
) -> Result<Json<RevokeApiKeyResponse>, ApiError> {
    require_system_admin(&mut db, &headers).await?;
    ApiKey::filter_by_id(id)
        .first()
        .exec(&mut db)
        .await?
        .ok_or_else(|| ApiError::not_found("no such API key"))?;
    ApiKey::filter_by_id(id).delete().exec(&mut db).await?;
    Ok(Json(RevokeApiKeyResponse { ok: true }))
}
