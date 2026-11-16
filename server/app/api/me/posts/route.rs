//! `GET /api/me/posts` — the signed-in user's own LinkedIn posts.
//! Challenge membership is deliberately irrelevant: users own this data.

use axum::extract::Query;
use axum::{Extension, Json};
use http::HeaderMap;
use linkedin_challenge_server::dto::{PostPage, require_member, user_posts};
use linkedin_challenge_server::web::ApiError;
use serde::{Deserialize, Serialize};
use toasty::Db;
use utoipa::IntoParams;

#[derive(Serialize, Deserialize, IntoParams)]
#[serde(rename_all = "camelCase")]
pub struct MyPostsQuery {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub filter: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sort: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub page: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub page_size: Option<usize>,
}

#[nextrs::api(operation_id = "getMyPosts")]
pub async fn get(
    Extension(mut db): Extension<Db>,
    timing: nextrs::Timing,
    headers: HeaderMap,
    Query(q): Query<MyPostsQuery>,
) -> Result<Json<PostPage>, ApiError> {
    let user = timing.span("session", require_member(&mut db, &headers)).await?;
    let sort = q.sort.as_deref().unwrap_or("newest");
    if !["newest", "oldest", "impressions", "reactions", "comments", "reposts", "sends", "saves"]
        .contains(&sort)
    {
        return Err(ApiError::bad_request("invalid post sort"));
    }
    let posts = user_posts(
        &mut db,
        user.id,
        q.filter.as_deref(),
        sort,
        q.page.unwrap_or(1).max(1),
        q.page_size.unwrap_or(50).clamp(1, 100),
    );
    Ok(Json(timing.span("db", posts).await?))
}
