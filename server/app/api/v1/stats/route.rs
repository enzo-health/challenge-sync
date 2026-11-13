//! `GET /api/v1/stats` — the company stats overview, for an admin's AI agent.
//!
//! The same numbers as the landing page (`/api/stats/overview`), authenticated like
//! `/api/v1/posts`: an API key, or an admin's website session. There is no viewer here, so `you`
//! is null unless `memberId` asks for one person's share. On the root middleware's public list
//! for the same reason as the other v1 routes. See `docs/reporting-api.md`.

use axum::extract::Query;
use axum::extract::rejection::QueryRejection;
use axum::{Extension, Json};
use http::HeaderMap;
use linkedin_challenge_server::reports::require_report_access;
use linkedin_challenge_server::stats::{StatsOverview, StatsPeriod, stats_overview};
use linkedin_challenge_server::util::now_unix;
use linkedin_challenge_server::web::ApiError;
use serde::{Deserialize, Serialize};
use toasty::Db;
use utoipa::IntoParams;

#[derive(Serialize, Deserialize, IntoParams)]
#[serde(rename_all = "camelCase")]
#[into_params(parameter_in = Query)]
pub struct StatsReportQuery {
    /// 7 (default), 30 or 90: the past that many days, today included.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub days: Option<i64>,
    /// Fixed UTC offset the days are read in: `-07:00`, `+00:00` or `Z`. Default UTC.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub timezone: Option<String>,
    /// Also return this member's share of each number as `you`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub member_id: Option<i64>,
}

#[nextrs::api(
    operation_id = "getStatsReport",
    params(StatsReportQuery),
    responses(
        (status = 200, description = "Company numbers for the period", body = StatsOverview),
        (status = 400, description = "A parameter is not valid", body = ApiError),
        (status = 401, description = "Missing or wrong API key, or not an admin", body = ApiError),
        (status = 404, description = "No member with that memberId", body = ApiError),
    ),
)]
pub async fn get(
    Extension(mut db): Extension<Db>,
    headers: HeaderMap,
    query: Result<Query<StatsReportQuery>, QueryRejection>,
) -> Result<Json<StatsOverview>, ApiError> {
    require_report_access(&mut db, &headers).await?;
    let Query(q) = query.map_err(|rejection| ApiError::bad_request(rejection.body_text()))?;
    let now = now_unix();
    let period = StatsPeriod::new(q.days, q.timezone.as_deref(), now).map_err(ApiError::bad_request)?;
    Ok(Json(stats_overview(&mut db, &period, q.member_id, now).await?))
}
