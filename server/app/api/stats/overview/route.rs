//! `GET /api/stats/overview` — the company stats on the landing page, with the viewer's own share.
//!
//! Every signed-in member may read it: it shows company totals and the names already visible on
//! the boards, never emails. The same numbers reach an admin's agent at `/api/v1/stats`.

use axum::extract::Query;
use axum::extract::rejection::QueryRejection;
use axum::{Extension, Json};
use http::HeaderMap;
use linkedin_challenge_server::dto::require_member;
use linkedin_challenge_server::stats::{StatsOverview, StatsPeriod, stats_overview};
use linkedin_challenge_server::util::now_unix;
use linkedin_challenge_server::web::ApiError;
use serde::{Deserialize, Serialize};
use toasty::Db;
use utoipa::IntoParams;

#[derive(Serialize, Deserialize, IntoParams)]
#[serde(rename_all = "camelCase")]
#[into_params(parameter_in = Query)]
pub struct StatsOverviewQuery {
    /// 7 (default), 30 or 90: the past that many days, today included.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub days: Option<i64>,
    /// The viewer's UTC offset, e.g. `-07:00`, so days start at their midnight. Default UTC.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub timezone: Option<String>,
}

#[nextrs::api(
    operation_id = "getStatsOverview",
    params(StatsOverviewQuery),
    responses(
        (status = 200, description = "Company numbers for the period and the viewer's share", body = StatsOverview),
        (status = 400, description = "A parameter is not valid", body = ApiError),
        (status = 401, description = "Not signed in", body = ApiError),
    ),
)]
pub async fn get(
    Extension(mut db): Extension<Db>,
    headers: HeaderMap,
    query: Result<Query<StatsOverviewQuery>, QueryRejection>,
) -> Result<Json<StatsOverview>, ApiError> {
    let viewer = require_member(&mut db, &headers).await?;
    let Query(q) = query.map_err(|rejection| ApiError::bad_request(rejection.body_text()))?;
    let now = now_unix();
    let period = StatsPeriod::new(q.days, q.timezone.as_deref(), now).map_err(ApiError::bad_request)?;
    Ok(Json(stats_overview(&mut db, &period, Some(viewer.id), now).await?))
}
