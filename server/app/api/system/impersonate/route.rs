//! `POST /api/system/impersonate` — start acting as another member.
//!
//! Swaps the operator's cookie for a session whose member is the target and whose
//! `impersonator_id` records who is really driving. The operator's own session row stays valid
//! server-side; "stop" simply mints them a fresh cookie, so nothing needs restoring.

use axum::{Extension, Json};
use http::{HeaderMap, HeaderValue, header::SET_COOKIE};
use linkedin_challenge_server::auth::establish_session_as;
use linkedin_challenge_server::dto::require_system_admin;
use linkedin_challenge_server::models::Member;
use linkedin_challenge_server::web::{ApiError, ApiResult};
use serde::{Deserialize, Serialize};
use toasty::Db;
use utoipa::ToSchema;

#[derive(Deserialize, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ImpersonateRequest {
    pub member_id: i64,
}

#[derive(Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ImpersonateResponse {
    pub ok: bool,
    pub display_name: String,
}

#[nextrs::api(
    operation_id = "impersonate",
    responses(
        (status = 200, description = "Now acting as the target; session cookie replaced", body = ImpersonateResponse),
        (status = 401, description = "Not a system admin", body = ApiError),
        (status = 400, description = "The account is your own or was deleted", body = ApiError),
        (status = 404, description = "No such member", body = ApiError),
    ),
)]
pub async fn post(
    Extension(mut db): Extension<Db>,
    headers: HeaderMap,
    Json(req): Json<ImpersonateRequest>,
) -> ApiResult<(HeaderMap, Json<ImpersonateResponse>)> {
    let operator = require_system_admin(&mut db, &headers).await?;

    let target = Member::filter_by_id(req.member_id)
        .first()
        .exec(&mut db)
        .await?
        .ok_or_else(|| ApiError::not_found("no such member"))?;
    if target.id == operator.id {
        return Err(ApiError::bad_request("already signed in as this member"));
    }
    // The session would read as signed out anyway (see `auth::session_from_token`); saying so
    // here is clearer than a "View as" that silently lands on the login page.
    if target.is_deleted() {
        return Err(ApiError::bad_request("this account has been deleted"));
    }

    let cookie = establish_session_as(&mut db, target.id, Some(operator.id)).await?;
    let mut out = HeaderMap::new();
    if let Ok(value) = HeaderValue::from_str(&cookie) {
        out.insert(SET_COOKIE, value);
    }

    Ok((
        out,
        Json(ImpersonateResponse {
            ok: true,
            display_name: target.display_name,
        }),
    ))
}
