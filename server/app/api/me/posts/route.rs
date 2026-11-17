//! `GET /api/me/posts` — the signed-in user's own LinkedIn posts.
//! Challenge membership is deliberately irrelevant: users own this data.

use axum::extract::Query;
use axum::{Extension, Json};
use http::HeaderMap;
use linkedin_challenge_server::dto::{PostPage, require_member};
use linkedin_challenge_server::reads;
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
    let posts = reads::my_posts(
        &mut db,
        &timing,
        &user,
        q.filter.as_deref(),
        q.sort.as_deref(),
        q.page,
        q.page_size,
    );
    Ok(Json(posts.await?))
}
