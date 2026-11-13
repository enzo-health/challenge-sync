//! `PUT /api/challenges/{id}/favorite` — control whether a joined challenge appears in the sidebar.

use axum::extract::Path;
use axum::{Extension, Json};
use http::HeaderMap;
use linkedin_challenge_server::dto::require_challenge_user;
use linkedin_challenge_server::models::ChallengeMembership;
use linkedin_challenge_server::web::ApiError;
use serde::{Deserialize, Serialize};
use toasty::Db;
use utoipa::ToSchema;

#[derive(Deserialize, Serialize, ToSchema)]
pub struct FavoriteChallengeRequest { pub favorite: bool }

#[derive(Deserialize, Serialize, ToSchema)]
pub struct FavoriteChallengeResponse { pub ok: bool }

#[nextrs::api(operation_id = "setChallengeFavorite")]
pub async fn put(
    Extension(mut db): Extension<Db>,
    headers: HeaderMap,
    Path(id): Path<i64>,
    Json(req): Json<FavoriteChallengeRequest>,
) -> Result<Json<FavoriteChallengeResponse>, ApiError> {
    let user = require_challenge_user(&mut db, &headers).await?;
    let membership = ChallengeMembership::filter(
        ChallengeMembership::fields().member_id().eq(user.id),
    ).exec(&mut db).await?.into_iter()
        .find(|membership| membership.challenge_id == id)
        .ok_or_else(|| ApiError::not_found("challenge not found"))?;
    toasty::update!(ChallengeMembership::filter_by_id(membership.id) {
        is_favorite: req.favorite,
    }).exec(&mut db).await?;
    Ok(Json(FavoriteChallengeResponse { ok: true }))
}
