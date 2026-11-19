//! `GET /api/me/api-keys` — the signed-in member's own reporting API keys, without the keys.
//! `POST /api/me/api-keys` — make one; the response is the only time the key is shown.
//!
//! Any signed-in member may hold up to `reads::MAX_PERSONAL_KEYS` keys of their own, so their AI
//! agent can read the reporting API (`/api/v1/*`: everyone's posts, members and stats, read-only).
//! A personal key works while its owner's account exists; it does not depend on being an admin
//! (see `auth::key_still_valid`). There is no member id in the request: these act on the member
//! the session resolves to, so nobody can see or make keys for someone else. Admins see and
//! revoke every key at `/api/system/api-keys`. See `docs/reporting-api.md`.

use axum::{Extension, Json};
use http::{HeaderMap, StatusCode};
use linkedin_challenge_server::auth::{create_api_key, current_session};
use linkedin_challenge_server::dto::member_required;
use linkedin_challenge_server::reads::{self, MAX_PERSONAL_KEYS, MyApiKeyList};
use linkedin_challenge_server::web::{ApiError, codes};
use serde::{Deserialize, Serialize};
use toasty::Db;
use utoipa::ToSchema;

#[derive(Deserialize, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct CreateMyApiKeyRequest {
    pub name: String,
}

#[derive(Deserialize, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct CreatedMyApiKey {
    pub id: i64,
    pub name: String,
    /// The key. It is not stored and cannot be shown again.
    pub key: String,
    pub created_at: i64,
}

#[nextrs::api(
    operation_id = "listMyApiKeys",
    responses(
        (status = 200, description = "The member's own keys, newest first, without the keys", body = MyApiKeyList),
        (status = 401, description = "Not signed in", body = ApiError),
    ),
)]
pub async fn get(
    Extension(mut db): Extension<Db>,
    timing: nextrs::Timing,
    headers: HeaderMap,
) -> Result<Json<MyApiKeyList>, ApiError> {
    let session = timing.span("session", current_session(&mut db, &headers)).await;
    let member = member_required(session.map(|session| session.member))?;
    Ok(Json(timing.span("db", reads::my_api_keys(&mut db, &member)).await?))
}

#[nextrs::api(
    operation_id = "createMyApiKey",
    responses(
        (status = 200, description = "The new key, shown this once", body = CreatedMyApiKey),
        (status = 400, description = "The name is missing or too long", body = ApiError),
        (status = 401, description = "Not signed in", body = ApiError),
        (status = 403, description = "A \"View as\" session cannot make a key for the member it views", body = ApiError),
        (status = 409, description = "The member already holds as many keys as they may", body = ApiError),
    ),
)]
pub async fn post(
    Extension(mut db): Extension<Db>,
    timing: nextrs::Timing,
    headers: HeaderMap,
    Json(req): Json<CreateMyApiKeyRequest>,
) -> Result<Json<CreatedMyApiKey>, ApiError> {
    let session = timing.span("session", current_session(&mut db, &headers)).await;
    let session = session.ok_or_else(|| ApiError::unauthorized("sign-in required"))?;
    // An admin viewing as someone must not walk away holding a key in that person's name.
    if session.impersonator.is_some() {
        return Err(ApiError::new(
            StatusCode::FORBIDDEN,
            "you are viewing as another member; stop viewing as them to make a key of your own",
        )
        .with_code(codes::IMPERSONATION_SESSION));
    }
    let member = &session.member;
    let name = req.name.trim();
    if !(1..=100).contains(&name.chars().count()) {
        return Err(ApiError::bad_request("name must be between 1 and 100 characters"));
    }
    let held = timing.span("db", reads::personal_api_keys(&mut db, member.id)).await?.len();
    if held >= MAX_PERSONAL_KEYS {
        return Err(ApiError::conflict(format!(
            "you already have {held} API keys, the most one person may hold; revoke one to make another"
        ))
        .with_code(codes::API_KEY_LIMIT));
    }
    let (row, key) = create_api_key(&mut db, name, member.id, true).await?;
    Ok(Json(CreatedMyApiKey {
        id: row.id,
        name: row.name,
        key,
        created_at: row.created_at,
    }))
}
