//! `GET /api/leaderboard` — a board the viewer may read through challenge membership.

use axum::extract::Query;
use axum::{Extension, Json};
use http::HeaderMap;
use linkedin_challenge_server::dto::{Leaderboard, leaderboard, require_challenge_user};
use linkedin_challenge_server::web::ApiError;
use serde::{Deserialize, Serialize};
use toasty::Db;
use utoipa::IntoParams;

#[derive(Serialize, Deserialize, IntoParams)]
#[serde(rename_all = "camelCase")]
pub struct LeaderboardQuery {
    /// A specific joined challenge to rank; omitted means the viewer's current one.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub challenge_id: Option<i64>,
}

#[nextrs::api(operation_id = "getLeaderboard")]
pub async fn get(
    Extension(mut db): Extension<Db>,
    headers: HeaderMap,
    Query(q): Query<LeaderboardQuery>,
) -> Result<Json<Leaderboard>, ApiError> {
    let member = require_challenge_user(&mut db, &headers).await?;
    Ok(Json(leaderboard(&mut db, &member, q.challenge_id).await?))
}
