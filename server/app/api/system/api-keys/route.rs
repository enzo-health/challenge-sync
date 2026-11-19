//! `GET /api/system/api-keys` — every reporting API key, admins' and members' own, without the
//! keys themselves, so an admin has one place to see and revoke all access.
//! `POST /api/system/api-keys` — make a new admin key; the response is the only time it is shown.
//!
//! An admin key works only while its creator is an admin; members make their own keys at
//! `/api/me/api-keys`. Both read the same read-only `/api/v1/*` routes. See
//! `docs/reporting-api.md`.

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
        (status = 200, description = "Every API key (admin and personal), newest first, without the keys", body = ApiKeyList),
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
    let (row, key) = create_api_key(&mut db, name, operator.id, false).await?;
    Ok(Json(CreatedApiKey {
        id: row.id,
        name: row.name,
        key,
        created_at: row.created_at,
    }))
}
