//! `GET /api/admin/aggregate` — org-wide totals for one challenge, admin-only.
//! Kept off the leaderboard payload so the board stays identical for every reader.

use axum::extract::Query;
use axum::{Extension, Json};
use http::HeaderMap;
use linkedin_challenge_server::dto::{Aggregate, competition_aggregate, require_challenge_user};
use linkedin_challenge_server::web::ApiError;
use serde::{Deserialize, Serialize};
use toasty::Db;
use utoipa::IntoParams;

#[derive(Serialize, Deserialize, IntoParams)]
#[serde(rename_all = "camelCase")]
pub struct AggregateQuery {
    pub challenge_id: i64,
}

#[nextrs::api(operation_id = "getChallengeAggregate")]
pub async fn get(
    Extension(mut db): Extension<Db>,
    headers: HeaderMap,
    Query(q): Query<AggregateQuery>,
) -> Result<Json<Aggregate>, ApiError> {
    let admin = require_challenge_user(&mut db, &headers).await?;
    Ok(Json(
        competition_aggregate(&mut db, &admin, q.challenge_id).await?,
    ))
}
