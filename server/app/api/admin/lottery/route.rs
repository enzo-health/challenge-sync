//! `GET /api/admin/lottery` — who posted in one week (Friday to Thursday, Denver time) or in a
//! custom range of days, for the weekly prize draw, and who did not. Admin-only, like the other
//! admin APIs; the week and range rules live in `lottery.rs`.

use axum::extract::Query;
use axum::extract::rejection::QueryRejection;
use axum::{Extension, Json};
use http::HeaderMap;
use linkedin_challenge_server::dto::require_challenge_user;
use linkedin_challenge_server::lottery::{LotteryPeriodEntrants, lottery_entrants, resolve_selection};
use linkedin_challenge_server::util::now_unix;
use linkedin_challenge_server::web::ApiError;
use serde::{Deserialize, Serialize};
use toasty::Db;
use utoipa::IntoParams;

#[derive(Serialize, Deserialize, IntoParams)]
#[serde(rename_all = "camelCase")]
#[into_params(parameter_in = Query)]
pub struct LotteryQuery {
    /// The Friday the week starts on, e.g. `2026-11-13` (the week runs to Thursday 2026-11-19).
    /// Default: the most recent complete week. The week in progress is allowed; a week that has not
    /// started is refused. Not allowed together with `from`/`to`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub week: Option<String>,
    /// A custom range's first day, e.g. `2026-11-16`; needs `to`. No later than today in Denver.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub from: Option<String>,
    /// A custom range's last day, included, e.g. `2026-11-20`; needs `from`. At most 62 days
    /// after `from` counting both; today or later makes the range incomplete.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub to: Option<String>,
}

#[nextrs::api(
    operation_id = "getAdminLottery",
    params(LotteryQuery),
    responses(
        (status = 200, description = "The period's entrants and everyone else", body = LotteryPeriodEntrants),
        (status = 400, description = "week is not a Friday or has not started; or the range is incomplete, invalid, in the future or too long; or both were given", body = ApiError),
        (status = 401, description = "Not signed in, or not an admin", body = ApiError),
    ),
)]
pub async fn get(
    Extension(mut db): Extension<Db>,
    headers: HeaderMap,
    query: Result<Query<LotteryQuery>, QueryRejection>,
) -> Result<Json<LotteryPeriodEntrants>, ApiError> {
    require_challenge_user(&mut db, &headers).await?;
    let Query(q) = query.map_err(|rejection| ApiError::bad_request(rejection.body_text()))?;
    let now = now_unix();
    let selection = resolve_selection(q.week.as_deref(), q.from.as_deref(), q.to.as_deref(), now)
        .map_err(ApiError::bad_request)?;
    Ok(Json(lottery_entrants(&mut db, selection, now).await?))
}
