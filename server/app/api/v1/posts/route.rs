//! `GET /api/v1/posts` — the post report, for an admin's AI agent and for the Reports page.
//!
//! An agent authenticates with `Authorization: Bearer csk_...` (an API key an admin created on
//! the Reports page). The page itself sends the admin's website session instead. This path is on
//! the root middleware's public list, so this handler is the only thing checking who is asking.
//! See `docs/reporting-api.md` for the contract.

use axum::extract::Query;
use axum::extract::rejection::QueryRejection;
use axum::response::{IntoResponse, Response};
use axum::{Extension, Json};
use http::HeaderMap;
use linkedin_challenge_server::reports::{
    PostReport, ReportFilter, ReportParams, csv_filename, post_report, report_csv,
    require_report_access,
};
use linkedin_challenge_server::util::now_unix;
use linkedin_challenge_server::web::ApiError;
use serde::{Deserialize, Serialize};
use toasty::Db;
use utoipa::IntoParams;

#[derive(Serialize, Deserialize, IntoParams)]
#[serde(rename_all = "camelCase")]
#[into_params(parameter_in = Query)]
pub struct PostReportQuery {
    /// Start of the period, included: a day (`YYYY-MM-DD`, from its first second in `timezone`)
    /// or an exact time with an offset (`2026-11-06T00:00:00-07:00`). Default: the start of the
    /// day six days before `until`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub since: Option<String>,
    /// End of the period, included: a day (to its last second in `timezone`) or an exact time
    /// with an offset. Default: the end of today in `timezone`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub until: Option<String>,
    /// Fixed UTC offset that dates are read in and local times are shown in: `-07:00`,
    /// `+00:00` or `Z`. Default UTC. Not a zone name: Mountain time is -07:00 in winter and
    /// -06:00 in summer.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub timezone: Option<String>,
    /// Only posts with at least this many impressions.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub min_impressions: Option<i64>,
    /// Only posts with at least this many out-of-network impressions. Posts whose
    /// out-of-network number is unknown never match.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub min_out_of_network_impressions: Option<i64>,
    /// Only posts whose text contains this, ignoring case ("enzo" finds "Enzo" and
    /// "enzo.health"). Posts with no stored text never match.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub contains: Option<String>,
    /// Include reshares (flagged `isRepost`). Default false: original posts only.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub include_reposts: Option<bool>,
    /// Only this member's posts.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub member_id: Option<i64>,
    /// `json` (default) or `csv`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub format: Option<String>,
}

#[nextrs::api(
    operation_id = "getPostReport",
    params(PostReportQuery),
    responses(
        (status = 200, description = "Matching posts and who posted (CSV when format=csv)", body = PostReport),
        (status = 400, description = "A parameter is not valid", body = ApiError),
        (status = 401, description = "Missing or wrong API key, or not an admin", body = ApiError),
    ),
)]
pub async fn get(
    Extension(mut db): Extension<Db>,
    headers: HeaderMap,
    query: Result<Query<PostReportQuery>, QueryRejection>,
) -> Result<Response, ApiError> {
    require_report_access(&mut db, &headers).await?;

    // Axum's own rejection is plain text; an agent is better served by the JSON error shape.
    let Query(q) = query.map_err(|rejection| ApiError::bad_request(rejection.body_text()))?;
    let csv = match q.format.as_deref().map(str::trim).unwrap_or("json") {
        "" | "json" => false,
        "csv" => true,
        _ => return Err(ApiError::bad_request("format must be json or csv")),
    };
    let filter = ReportFilter::new(
        ReportParams {
            since: q.since.as_deref(),
            until: q.until.as_deref(),
            timezone: q.timezone.as_deref(),
            min_impressions: q.min_impressions,
            min_out_of_network_impressions: q.min_out_of_network_impressions,
            member_id: q.member_id,
            contains: q.contains.as_deref(),
            include_reposts: q.include_reposts.unwrap_or(false),
        },
        now_unix(),
    )
    .map_err(ApiError::bad_request)?;
    let report = post_report(&mut db, &filter).await?;

    if !csv {
        return Ok(Json(report).into_response());
    }
    let disposition = format!("attachment; filename=\"{}\"", csv_filename(&filter));
    Ok((
        [
            (http::header::CONTENT_TYPE, "text/csv; charset=utf-8".to_string()),
            (http::header::CONTENT_DISPOSITION, disposition),
            (http::header::CACHE_CONTROL, "no-store".to_string()),
        ],
        report_csv(&report),
    )
        .into_response())
}
