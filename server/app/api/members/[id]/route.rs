//! `GET /api/members/{id}` — one member's posts and analytics for a challenge window.
//! The drill-in from a leaderboard row ("My posts" reads `/api/me/posts` instead), so it is a
//! challenge API and open only to those challenges are open to (`auth::can_use_challenges`).
//! Another user's data is visible only through a challenge both users joined.

use axum::extract::{Path, Query};
use axum::{Extension, Json};
use http::HeaderMap;
use linkedin_challenge_server::dto::{MemberDetail, member_detail, require_challenge_user};
use linkedin_challenge_server::web::ApiError;
use serde::{Deserialize, Serialize};
use toasty::Db;
use utoipa::IntoParams;

#[derive(Serialize, Deserialize, IntoParams)]
#[serde(rename_all = "camelCase")]
pub struct MemberDetailQuery {
    /// Challenge granting access and defining the scoring window; omit only for your own data.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub challenge_id: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub filter: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sort: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub page: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub page_size: Option<usize>,
}

#[nextrs::api(operation_id = "getMemberDetail")]
pub async fn get(
    Extension(mut db): Extension<Db>,
    headers: HeaderMap,
    Path(id): Path<i64>,
    Query(q): Query<MemberDetailQuery>,
) -> Result<Json<MemberDetail>, ApiError> {
    let member = require_challenge_user(&mut db, &headers).await?;
    let sort = q.sort.as_deref().unwrap_or("newest");
    if !["newest", "oldest", "impressions", "reactions", "comments", "reposts", "sends", "saves"]
        .contains(&sort)
    {
        return Err(ApiError::bad_request("invalid post sort"));
    }
    let page_size = q.page_size.unwrap_or(50).clamp(1, 100);
    Ok(Json(member_detail(
        &mut db,
        &member,
        q.challenge_id,
        id,
        q.filter.as_deref(),
        sort,
        q.page.unwrap_or(1).max(1),
        page_size,
    ).await?))
}
