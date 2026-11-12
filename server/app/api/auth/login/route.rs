//! `POST /api/auth/login` — email + password, exchanged for a session cookie.

use axum::{Extension, Json};
use http::{HeaderMap, HeaderValue, header::SET_COOKIE};
use linkedin_challenge_server::auth::{establish_session, member_by_email, verify_password};
use linkedin_challenge_server::enroll::enroll_in_running_challenges;
use linkedin_challenge_server::web::{ApiError, ApiResult};
use serde::{Deserialize, Serialize};
use toasty::Db;
use utoipa::ToSchema;

#[derive(Deserialize, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct LoginRequest {
    pub email: String,
    pub password: String,
}

#[derive(Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct SessionResponse {
    pub ok: bool,
    pub display_name: String,
    pub org_slug: String,
}

#[nextrs::api(
    operation_id = "login",
    responses(
        (status = 200, description = "Signed in; session cookie set", body = SessionResponse),
        (status = 401, description = "Wrong email or password", body = ApiError),
    ),
)]
pub async fn post(
    Extension(mut db): Extension<Db>,
    Json(req): Json<LoginRequest>,
) -> ApiResult<(HeaderMap, Json<SessionResponse>)> {
    if req.password.chars().count() > 128 {
        return Err(ApiError::unauthorized("invalid email or password"));
    }
    // Email is the login identifier for everyone — participants and admins alike.
    // A deleted account gets the same answer as a wrong password, so the response does not say
    // which accounts exist or what state they are in.
    let Some(member) = member_by_email(&mut db, &req.email).await?.filter(|m| !m.is_deleted()) else {
        return Err(ApiError::unauthorized("invalid email or password"));
    };
    let ok = member
        .password_hash
        .as_deref()
        .is_some_and(|hash| verify_password(&req.password, hash));
    if !ok {
        return Err(ApiError::unauthorized("invalid email or password"));
    }

    // Accounts created before a challenge started join it the next time they sign in.
    enroll_in_running_challenges(&mut db, member.id).await?;

    let org_slug = linkedin_challenge_server::dto::org_slug(&mut db, member.org_id).await?;
    let cookie = establish_session(&mut db, member.id).await?;

    let mut headers = HeaderMap::new();
    if let Ok(value) = HeaderValue::from_str(&cookie) {
        headers.insert(SET_COOKIE, value);
    }

    Ok((
        headers,
        Json(SessionResponse {
            ok: true,
            display_name: member.display_name,
            org_slug,
        }),
    ))
}
