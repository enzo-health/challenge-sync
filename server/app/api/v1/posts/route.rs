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
use linkedin_challenge_server::auth::{api_key_from_bearer, current_system_admin, has_bearer};
use linkedin_challenge_server::reports::{PostReport, ReportFilter, csv_filename, post_report, report_csv};
use linkedin_challenge_server::util::now_unix;
use linkedin_challenge_server::web::ApiError;
use serde::{Deserialize, Serialize};
use toasty::Db;
use utoipa::IntoParams;

#[derive(Serialize, Deserialize, IntoParams)]
#[serde(rename_all = "camelCase")]
#[into_params(parameter_in = Query)]
pub struct PostReportQuery {
    /// First day included, `YYYY-MM-DD` (UTC). Default: six days before `until`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub since: Option<String>,
    /// Last day included, `YYYY-MM-DD` (UTC). Default: today.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub until: Option<String>,
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
    // A request that presents a key is judged by the key alone, so a wrong key fails even from a
    // browser that also holds a session. Without one, only an admin's website session will do.
    if has_bearer(&headers) {
        if api_key_from_bearer(&mut db, &headers).await.is_none() {
            return Err(ApiError::unauthorized("invalid or revoked API key"));
        }
    } else if current_system_admin(&mut db, &headers).await.is_none() {
        return Err(ApiError::unauthorized(
            "send an API key as `Authorization: Bearer csk_...`",
        ));
    }

    // Axum's own rejection is plain text; an agent is better served by the JSON error shape.
    let Query(q) = query.map_err(|rejection| ApiError::bad_request(rejection.body_text()))?;
    let csv = match q.format.as_deref().map(str::trim).unwrap_or("json") {
        "" | "json" => false,
        "csv" => true,
        _ => return Err(ApiError::bad_request("format must be json or csv")),
    };
    let filter = ReportFilter::new(
        q.since.as_deref(),
        q.until.as_deref(),
        q.min_impressions,
        q.min_out_of_network_impressions,
        q.member_id,
        q.contains.as_deref(),
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
