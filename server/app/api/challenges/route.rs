//! `GET /api/challenges` — challenges the viewer joined, newest first, plus the default one.
//! Backs the Challenges page and the sidebar's challenge switcher.

use axum::{Extension, Json};
use http::HeaderMap;
use linkedin_challenge_server::dto::{ChallengeList, challenge_list, require_challenge_user};
use linkedin_challenge_server::enroll::enroll_everyone;
use linkedin_challenge_server::models::{ChallengeMembership, Competition};
use linkedin_challenge_server::scoring::ScoringConfig;
use linkedin_challenge_server::util::{now_unix, parse_date};
use linkedin_challenge_server::web::ApiError;
use serde::{Deserialize, Serialize};
use toasty::Db;
use utoipa::ToSchema;

#[nextrs::api(operation_id = "getChallenges")]
pub async fn get(
    Extension(mut db): Extension<Db>,
    headers: HeaderMap,
) -> Result<Json<ChallengeList>, ApiError> {
    let member = require_challenge_user(&mut db, &headers).await?;
    Ok(Json(challenge_list(&mut db, &member).await?))
}

#[derive(Deserialize, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct CreateChallengeRequest {
    pub name: String,
    pub start: String,
    pub end: String,
    pub config: ScoringConfig,
}

#[derive(Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct CreateChallengeResponse {
    pub id: i64,
}

#[nextrs::api(operation_id = "createChallenge")]
pub async fn post(
    Extension(mut db): Extension<Db>,
    headers: HeaderMap,
    Json(req): Json<CreateChallengeRequest>,
) -> Result<Json<CreateChallengeResponse>, ApiError> {
    let creator = require_challenge_user(&mut db, &headers).await?;
    let name = req.name.trim();
    if name.is_empty() {
        return Err(ApiError::bad_request("challenge name is required"));
    }
    let start = parse_date(&req.start).unwrap_or_else(now_unix);
    let end = parse_date(&req.end).map(|value| value + 86_399)
        .unwrap_or_else(|| now_unix() + 90 * 86400);
    if end <= start {
        return Err(ApiError::bad_request("end date must be after the start"));
    }
    let challenge = toasty::create!(Competition {
        org_id: creator.org_id,
        creator_id: creator.id,
        name,
        start_at: start,
        end_at: end,
        max_posts_per_week: req.config.max_posts_per_week as i64,
        per_post: req.config.per_post,
        per_active_week: req.config.per_active_week,
        streak_short_weeks: req.config.streak_short_weeks as i64,
        streak_short_bonus: req.config.streak_short_bonus,
        streak_long_weeks: req.config.streak_long_weeks as i64,
        streak_long_bonus: req.config.streak_long_bonus,
        per_reaction: req.config.per_reaction,
        per_comment: req.config.per_comment,
        per_repost: req.config.per_repost,
        per_send: req.config.per_send,
        per_save: req.config.per_save,
        per_impression: req.config.per_impression,
        engagement_cap: req.config.engagement_cap,
        engagement_over_cap_rate: req.config.engagement_over_cap_rate,
        per_follower_gained: req.config.per_follower_gained,
        per_profile_view: req.config.per_profile_view,
        normalize_by_followers: req.config.normalize_by_followers,
        follower_baseline: req.config.follower_baseline,
        prize_first: req.config.prize_first,
        prize_second: req.config.prize_second,
        prize_third: req.config.prize_third,
        prize_participation: req.config.prize_participation,
        participation_posts: req.config.participation_posts,
        is_active: true,
        created_at: now_unix(),
    }).exec(&mut db).await?;
    toasty::create!(ChallengeMembership {
        challenge_id: challenge.id,
        member_id: creator.id,
        role: "owner",
        is_favorite: true,
        joined_at: now_unix(),
    }).exec(&mut db).await?;
    // A challenge that is already running takes everyone on board right away.
    if start <= now_unix() {
        enroll_everyone(&mut db).await?;
    }
    Ok(Json(CreateChallengeResponse { id: challenge.id }))
}
