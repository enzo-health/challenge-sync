//! `GET /api/system/api-keys` — the reporting API keys, without the keys themselves.
//! `POST /api/system/api-keys` — make a new one; the response is the only time the key is shown.
//!
//! A key lets a program read everyone's post report at `/api/v1/posts`, so only admins manage
//! them. See `docs/reporting-api.md`.

use axum::{Extension, Json};
use http::HeaderMap;
use linkedin_challenge_server::auth::create_api_key;
use linkedin_challenge_server::dto::require_system_admin;
use linkedin_challenge_server::reads::{self, ApiKeyList};
use linkedin_challenge_server::web::ApiError;
use serde::{Deserialize, Serialize};
use toasty::Db;
use utoipa::ToSchema;

#[derive(Deserialize, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct CreateApiKeyRequest {
    pub name: String,
}

#[derive(Deserialize, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct CreatedApiKey {
    pub id: i64,
    pub name: String,
    /// The key. It is not stored and cannot be shown again.
    pub key: String,
    pub created_at: i64,
}

#[nextrs::api(
    operation_id = "listApiKeys",
    responses(
        (status = 200, description = "Every API key, newest first, without the keys", body = ApiKeyList),
        (status = 401, description = "Not an admin", body = ApiError),
    ),
)]
pub async fn get(
    Extension(mut db): Extension<Db>,
    headers: HeaderMap,
) -> Result<Json<ApiKeyList>, ApiError> {
    require_system_admin(&mut db, &headers).await?;
    Ok(Json(reads::api_keys(&mut db).await?))
}

#[nextrs::api(
    operation_id = "createApiKey",
    responses(
        (status = 200, description = "The new key, shown this once", body = CreatedApiKey),
        (status = 400, description = "The name is missing or too long", body = ApiError),
        (status = 401, description = "Not an admin", body = ApiError),
    ),
)]
pub async fn post(
    Extension(mut db): Extension<Db>,
    headers: HeaderMap,
    Json(req): Json<CreateApiKeyRequest>,
) -> Result<Json<CreatedApiKey>, ApiError> {
    let operator = require_system_admin(&mut db, &headers).await?;
    let name = req.name.trim();
    if !(1..=100).contains(&name.chars().count()) {
        return Err(ApiError::bad_request("name must be between 1 and 100 characters"));
    }
    let (row, key) = create_api_key(&mut db, name, operator.id).await?;
    Ok(Json(CreatedApiKey {
        id: row.id,
        name: row.name,
        key,
        created_at: row.created_at,
    }))
}
