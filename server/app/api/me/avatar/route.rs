//! `GET/PUT/DELETE /api/me/avatar` — the signed-in member's own lottery-wheel avatar.
//!
//! There is no member id anywhere in the request: each call acts on the member the session
//! resolves to (the impersonated member during "View as", like every other `/api/me` route), so
//! nobody can read or change someone else's avatar here. The rules for a valid avatar are in
//! `src/avatar.rs` and `components/lottery/avatar-options.json`.

use axum::body::Bytes;
use axum::{Extension, Json};
use http::HeaderMap;
use linkedin_challenge_server::avatar::{self, Avatar, MyAvatar};
use linkedin_challenge_server::dto::require_member;
use linkedin_challenge_server::models::Member;
use linkedin_challenge_server::web::ApiError;
use toasty::Db;

#[nextrs::api(operation_id = "getMyAvatar")]
pub async fn get(
    Extension(mut db): Extension<Db>,
    timing: nextrs::Timing,
    headers: HeaderMap,
) -> Result<Json<MyAvatar>, ApiError> {
    let member = timing.span("session", require_member(&mut db, &headers)).await?;
    Ok(Json(MyAvatar { avatar: avatar::member_avatar(&member) }))
}

// The body is read as raw bytes and validated here, rather than through `Json<Avatar>`, so that
// every refusal is a JSON `{ "error" }` naming exactly what was wrong; the OpenAPI document still
// declares it as an `Avatar`. (A plain comment: a doc comment would become the operation summary.)
#[nextrs::api(operation_id = "saveMyAvatar", request_body = Avatar)]
pub async fn put(
    Extension(mut db): Extension<Db>,
    timing: nextrs::Timing,
    headers: HeaderMap,
    body: Bytes,
) -> Result<Json<MyAvatar>, ApiError> {
    let member = timing.span("session", require_member(&mut db, &headers)).await?;
    let value: serde_json::Value = serde_json::from_slice(&body)
        .map_err(|e| ApiError::bad_request(format!("the request body is not valid JSON: {e}")))?;
    let avatar = avatar::validate(&value).map_err(ApiError::bad_request)?;
    let stored = avatar::to_stored(&avatar);
    timing
        .span("db", async {
            toasty::update!(Member::filter_by_id(member.id) { avatar_json: Some(stored) })
                .exec(&mut db)
                .await
        })
        .await?;
    Ok(Json(MyAvatar { avatar: Some(avatar) }))
}

#[nextrs::api(operation_id = "resetMyAvatar")]
pub async fn delete(
    Extension(mut db): Extension<Db>,
    timing: nextrs::Timing,
    headers: HeaderMap,
) -> Result<Json<MyAvatar>, ApiError> {
    let member = timing.span("session", require_member(&mut db, &headers)).await?;
    timing
        .span("db", async {
            toasty::update!(Member::filter_by_id(member.id) { avatar_json: None })
                .exec(&mut db)
                .await
        })
        .await?;
    Ok(Json(MyAvatar { avatar: None }))
}
