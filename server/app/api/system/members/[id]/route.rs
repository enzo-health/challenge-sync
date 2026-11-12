//! `DELETE /api/system/members/{id}` — delete the account of someone who has left the company.
//!
//! Removes the person and everything recorded for them; see `accounts::delete_member` for what
//! that covers and in what order. It cannot be undone. If they join again later through the
//! company invite link, they start over with a new, empty account.

use axum::extract::Path;
use axum::{Extension, Json};
use http::HeaderMap;
use linkedin_challenge_server::accounts::{challenge_ownership_refusal, delete_member};
use linkedin_challenge_server::dto::require_system_admin;
use linkedin_challenge_server::models::Member;
use linkedin_challenge_server::web::ApiError;
use serde::{Deserialize, Serialize};
use toasty::Db;
use utoipa::ToSchema;

#[derive(Deserialize, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct DeleteMemberResponse {
    pub ok: bool,
}

#[nextrs::api(
    operation_id = "deleteMember",
    responses(
        (status = 200, description = "The account and everything recorded for it were deleted", body = DeleteMemberResponse),
        (status = 400, description = "An admin cannot delete their own account", body = ApiError),
        (status = 401, description = "Not an admin", body = ApiError),
        (status = 404, description = "No such member", body = ApiError),
        (status = 409, description = "The account owns a challenge", body = ApiError),
    ),
)]
pub async fn delete(
    Extension(mut db): Extension<Db>,
    headers: HeaderMap,
    Path(id): Path<i64>,
) -> Result<Json<DeleteMemberResponse>, ApiError> {
    let operator = require_system_admin(&mut db, &headers).await?;
    let target = Member::filter_by_id(id)
        .first()
        .exec(&mut db)
        .await?
        .ok_or_else(|| ApiError::not_found("no such member"))?;
    // Deleting yourself would sign you out mid-request and could leave nobody able to run the panel.
    if target.id == operator.id {
        return Err(ApiError::bad_request("you cannot delete your own account"));
    }
    // Challenge transfer does not exist yet, so an owner's challenge would be left unmanageable.
    if let Some(message) = challenge_ownership_refusal(&mut db, target.id).await? {
        return Err(ApiError::conflict(message));
    }
    delete_member(&mut db, &target).await?;
    Ok(Json(DeleteMemberResponse { ok: true }))
}
