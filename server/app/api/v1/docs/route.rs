//! `GET /api/v1/docs` — the reporting API's documentation as Markdown, signed out.
//!
//! A member gives their AI agent this URL (from their API keys page) instead of a file. The body
//! is `docs/reporting-api.md` itself, compiled in (`reports::REPORTING_API_DOC`), so the served
//! copy and the file in the repository are always the same. It holds no data, only how to call the
//! API, which is why it is on the root middleware's public list.

use axum::response::{IntoResponse, Response};
use linkedin_challenge_server::reports::REPORTING_API_DOC;

#[nextrs::api(
    operation_id = "getReportingApiDocs",
    responses(
        (status = 200, description = "docs/reporting-api.md", content_type = "text/markdown", body = String),
    ),
)]
pub async fn get() -> Response {
    (
        [
            (http::header::CONTENT_TYPE, "text/markdown; charset=utf-8"),
            // Short, so a deploy that changes the doc reaches agents within minutes.
            (http::header::CACHE_CONTROL, "public, max-age=300"),
        ],
        REPORTING_API_DOC,
    )
        .into_response()
}
