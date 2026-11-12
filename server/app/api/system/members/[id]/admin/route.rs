//! `PUT /api/system/members/{id}/admin` — make someone an admin, or take it away.
//!
//! "Admin" is the system-admin flag: it unlocks this panel, impersonation, and the join link.
//! Only an existing admin can grant it, so the first one is still set by hand in the database.

use axum::extract::Path;
use axum::{Extension, Json};
use http::HeaderMap;
use linkedin_challenge_server::dto::require_system_admin;
use linkedin_challenge_server::models::Member;
use linkedin_challenge_server::web::ApiError;
use serde::{Deserialize, Serialize};
use toasty::Db;
use utoipa::ToSchema;

#[derive(Deserialize, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct SetAdminRequest {
    pub is_admin: bool,
}

#[derive(Deserialize, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct SetAdminResponse {
    pub ok: bool,
    pub is_admin: bool,
}

#[nextrs::api(
    operation_id = "setMemberAdmin",
    responses(
        (status = 200, description = "Admin flag updated", body = SetAdminResponse),
        (status = 400, description = "An admin cannot remove their own access", body = ApiError),
        (status = 401, description = "Not an admin", body = ApiError),
        (status = 404, description = "No such member", body = ApiError),
    ),
)]
pub async fn put(
    Extension(mut db): Extension<Db>,
    headers: HeaderMap,
    Path(id): Path<i64>,
    Json(req): Json<SetAdminRequest>,
) -> Result<Json<SetAdminResponse>, ApiError> {
    let operator = require_system_admin(&mut db, &headers).await?;
    let target = Member::filter_by_id(id)
        .first()
        .exec(&mut db)
        .await?
        .ok_or_else(|| ApiError::not_found("no such member"))?;
    // Removing your own flag could leave nobody able to grant it back.
    if target.id == operator.id && !req.is_admin {
        return Err(ApiError::bad_request("you cannot remove your own admin access"));
    }
    toasty::update!(Member::filter_by_id(target.id) { is_system_admin: req.is_admin })
        .exec(&mut db)
        .await?;
    Ok(Json(SetAdminResponse {
        ok: true,
        is_admin: req.is_admin,
    }))
}
