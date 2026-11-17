//! `GET /api/admin/lottery` — who posted in one week (Monday to Monday, Denver time), for the
//! weekly prize draw, and who did not. Admin-only, like the other admin APIs; the
//! week rules live in `lottery.rs`.

use axum::extract::Query;
use axum::extract::rejection::QueryRejection;
use axum::{Extension, Json};
use http::HeaderMap;
use linkedin_challenge_server::dto::require_challenge_user;
use linkedin_challenge_server::lottery::{LotteryWeekEntrants, lottery_entrants, resolve_week};
use linkedin_challenge_server::util::now_unix;
use linkedin_challenge_server::web::ApiError;
use serde::{Deserialize, Serialize};
use toasty::Db;
use utoipa::IntoParams;

#[derive(Serialize, Deserialize, IntoParams)]
#[serde(rename_all = "camelCase")]
#[into_params(parameter_in = Query)]
pub struct LotteryQuery {
    /// The Monday the week starts on, e.g. `2026-11-09`. Default: the most recent complete week.
    /// The week in progress is allowed; a week that has not started is refused.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub week: Option<String>,
}

#[nextrs::api(
    operation_id = "getAdminLottery",
    params(LotteryQuery),
    responses(
        (status = 200, description = "The week's entrants and everyone else", body = LotteryWeekEntrants),
        (status = 400, description = "week is not a Monday, or has not started", body = ApiError),
        (status = 401, description = "Not signed in, or not an admin", body = ApiError),
    ),
)]
pub async fn get(
    Extension(mut db): Extension<Db>,
    headers: HeaderMap,
    query: Result<Query<LotteryQuery>, QueryRejection>,
) -> Result<Json<LotteryWeekEntrants>, ApiError> {
    require_challenge_user(&mut db, &headers).await?;
    let Query(q) = query.map_err(|rejection| ApiError::bad_request(rejection.body_text()))?;
    let now = now_unix();
    let week = resolve_week(q.week.as_deref(), now).map_err(ApiError::bad_request)?;
    Ok(Json(lottery_entrants(&mut db, week, now).await?))
}
