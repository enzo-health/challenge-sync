//! `PUT /api/admin/lottery/exclusions/{id}` — leave a member out of the weekly lottery draw, or
//! put them back (e.g. the organisers, who post but should not win). Set from the member's page.
//!
//! Gated exactly like `GET /api/admin/lottery`: `require_challenge_user`, which today means a
//! system admin (`auth::can_use_challenges`), judged on the member the session acts as, so an admin
//! viewing as someone else is refused like that person. Anyone the lottery lists (every member who
//! is not deleted, across orgs) can be excluded, the caller included; the flag is read live by
//! `lottery::lottery_entrants`.

use axum::extract::Path;
use axum::{Extension, Json};
use http::HeaderMap;
use linkedin_challenge_server::dto::require_challenge_user;
use linkedin_challenge_server::models::Member;
use linkedin_challenge_server::web::ApiError;
use serde::{Deserialize, Serialize};
use toasty::Db;
use utoipa::ToSchema;

#[derive(Deserialize, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct SetLotteryExclusionRequest {
    /// True leaves the member out of the draw; false puts them back in.
    pub excluded: bool,
}

#[derive(Deserialize, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct SetLotteryExclusionResponse {
    pub member_id: i64,
    pub excluded: bool,
}

#[nextrs::api(
    operation_id = "setLotteryExclusion",
    responses(
        (status = 200, description = "Exclusion updated", body = SetLotteryExclusionResponse),
        (status = 400, description = "The account has been deleted", body = ApiError),
        (status = 401, description = "Not signed in, or not an admin", body = ApiError),
        (status = 404, description = "No such member", body = ApiError),
    ),
)]
pub async fn put(
    Extension(mut db): Extension<Db>,
    headers: HeaderMap,
    Path(id): Path<i64>,
    Json(req): Json<SetLotteryExclusionRequest>,
) -> Result<Json<SetLotteryExclusionResponse>, ApiError> {
    require_challenge_user(&mut db, &headers).await?;
    let target = Member::filter_by_id(id)
        .first()
        .exec(&mut db)
        .await?
        .ok_or_else(|| ApiError::not_found("no such member"))?;
    // The lottery leaves deleted accounts out entirely, so it does not list them either way.
    if target.is_deleted() {
        return Err(ApiError::bad_request("this account has been deleted; restore it first"));
    }
    toasty::update!(Member::filter_by_id(target.id) { lottery_excluded: req.excluded })
        .exec(&mut db)
        .await?;
    Ok(Json(SetLotteryExclusionResponse {
        member_id: target.id,
        excluded: req.excluded,
    }))
}
