//! `POST /api/system/members/{id}/restore` — undo deleting an account.
//!
//! Clears the deleted mark, so the person can sign in and sync again and is back on the boards
//! with everything they had. Nothing that deleting removed comes back: they sign in again the
//! usual way, and admin access has to be granted again. Restoring an account that is not deleted
//! changes nothing.

use axum::extract::Path;
use axum::{Extension, Json};
use http::HeaderMap;
use linkedin_challenge_server::accounts::restore_member;
use linkedin_challenge_server::dto::require_system_admin;
use linkedin_challenge_server::models::Member;
use linkedin_challenge_server::web::ApiError;
use serde::{Deserialize, Serialize};
use toasty::Db;
use utoipa::ToSchema;

#[derive(Deserialize, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct RestoreMemberResponse {
    pub ok: bool,
}

#[nextrs::api(
    operation_id = "restoreMember",
    responses(
        (status = 200, description = "The account is no longer deleted (also when it was not)", body = RestoreMemberResponse),
        (status = 401, description = "Not an admin", body = ApiError),
        (status = 404, description = "No such member", body = ApiError),
    ),
)]
pub async fn post(
    Extension(mut db): Extension<Db>,
    headers: HeaderMap,
    Path(id): Path<i64>,
) -> Result<Json<RestoreMemberResponse>, ApiError> {
    require_system_admin(&mut db, &headers).await?;
    let target = Member::filter_by_id(id)
        .first()
        .exec(&mut db)
        .await?
        .ok_or_else(|| ApiError::not_found("no such member"))?;
    if target.is_deleted() {
        restore_member(&mut db, target.id).await?;
    }
    Ok(Json(RestoreMemberResponse { ok: true }))
}
