//! `GET /api/v1/members` — every account and when it last synced, for an admin's AI agent.
//!
//! Answers "who is installed and syncing" (someone who posted but is not syncing needs the
//! extension) and "has syncing stalled" (the newest sync across everyone). Authenticated exactly
//! like `/api/v1/posts`, and on the root middleware's public list for the same reason. No emails:
//! this goes to an outside agent. See `docs/reporting-api.md`.

use axum::extract::Query;
use axum::extract::rejection::QueryRejection;
use axum::response::{IntoResponse, Response};
use axum::{Extension, Json};
use http::HeaderMap;
use linkedin_challenge_server::reports::{MemberReport, member_report, members_csv, require_report_access};
use linkedin_challenge_server::util::{fmt_date, now_unix};
use linkedin_challenge_server::web::ApiError;
use serde::{Deserialize, Serialize};
use toasty::Db;
use utoipa::IntoParams;

#[derive(Serialize, Deserialize, IntoParams)]
#[serde(rename_all = "camelCase")]
#[into_params(parameter_in = Query)]
pub struct MemberReportQuery {
    /// `json` (default) or `csv`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub format: Option<String>,
}

#[nextrs::api(
    operation_id = "getMemberReport",
    params(MemberReportQuery),
    responses(
        (status = 200, description = "Every account with its last sync (CSV when format=csv)", body = MemberReport),
        (status = 400, description = "A parameter is not valid", body = ApiError),
        (status = 401, description = "Missing or wrong API key, or not an admin", body = ApiError),
    ),
)]
pub async fn get(
    Extension(mut db): Extension<Db>,
    headers: HeaderMap,
    query: Result<Query<MemberReportQuery>, QueryRejection>,
) -> Result<Response, ApiError> {
    require_report_access(&mut db, &headers).await?;
    let Query(q) = query.map_err(|rejection| ApiError::bad_request(rejection.body_text()))?;
    let csv = match q.format.as_deref().map(str::trim).unwrap_or("json") {
        "" | "json" => false,
        "csv" => true,
        _ => return Err(ApiError::bad_request("format must be json or csv")),
    };
    let now = now_unix();
    let report = member_report(&mut db, now).await?;
    if !csv {
        return Ok(Json(report).into_response());
    }
    let disposition = format!("attachment; filename=\"members-{}.csv\"", fmt_date(now));
    Ok((
        [
            (http::header::CONTENT_TYPE, "text/csv; charset=utf-8".to_string()),
            (http::header::CONTENT_DISPOSITION, disposition),
            (http::header::CACHE_CONTROL, "no-store".to_string()),
        ],
        members_csv(&report),
    )
        .into_response())
}
