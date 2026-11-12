//! `GET /api/system/api-keys` — the reporting API keys, without the keys themselves.
//! `POST /api/system/api-keys` — make a new one; the response is the only time the key is shown.
//!
//! A key lets a program read everyone's post report at `/api/v1/posts`, so only admins manage
//! them. See `docs/reporting-api.md`.

use axum::{Extension, Json};
use http::HeaderMap;
use linkedin_challenge_server::auth::create_api_key;
use linkedin_challenge_server::dto::require_system_admin;
use linkedin_challenge_server::models::{ApiKey, Member};
use linkedin_challenge_server::web::ApiError;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use toasty::Db;
use utoipa::ToSchema;

#[derive(Deserialize, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ApiKeyRow {
    pub id: i64,
    pub name: String,
    /// Name of the admin who created it, when they still exist.
    #[schema(required)]
    pub created_by_name: Option<String>,
    pub created_at: i64,
    /// Unix seconds of the last request made with it, or null if it has never been used.
    #[schema(required)]
    pub last_used_at: Option<i64>,
}

#[derive(Deserialize, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ApiKeyList {
    pub keys: Vec<ApiKeyRow>,
}

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
    let mut keys = ApiKey::all().exec(&mut db).await?;
    keys.sort_by(|a, b| b.id.cmp(&a.id));
    let mut creator_ids: Vec<i64> = keys.iter().map(|key| key.created_by).collect();
    creator_ids.sort_unstable();
    creator_ids.dedup();
    let names: HashMap<i64, String> = if creator_ids.is_empty() {
        HashMap::new()
    } else {
        Member::filter(Member::fields().id().in_list(creator_ids))
            .exec(&mut db)
            .await?
            .into_iter()
            .map(|member| (member.id, member.display_name))
            .collect()
    };
    Ok(Json(ApiKeyList {
        keys: keys
            .into_iter()
            .map(|key| ApiKeyRow {
                id: key.id,
                created_by_name: names.get(&key.created_by).cloned(),
                name: key.name,
                created_at: key.created_at,
                last_used_at: key.last_used_at,
            })
            .collect(),
    }))
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
