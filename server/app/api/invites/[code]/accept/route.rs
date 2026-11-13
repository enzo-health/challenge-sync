//! Accept an email-addressed challenge invitation as the signed-in account.

use axum::extract::Path;
use axum::{Extension, Json};
use http::HeaderMap;
use linkedin_challenge_server::dto::require_challenge_user;
use linkedin_challenge_server::models::{ChallengeMembership, Competition, Invite};
use linkedin_challenge_server::util::now_unix;
use linkedin_challenge_server::web::ApiError;
use serde::{Deserialize, Serialize};
use toasty::Db;
use utoipa::ToSchema;

#[derive(Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct AcceptInviteResponse { pub challenge_id: i64 }

#[nextrs::api(operation_id = "acceptChallengeInvite")]
pub async fn post(
    Extension(mut db): Extension<Db>,
    headers: HeaderMap,
    Path(code): Path<String>,
) -> Result<Json<AcceptInviteResponse>, ApiError> {
    let member = require_challenge_user(&mut db, &headers).await?;
    let email = member.email.as_deref().unwrap_or_default().to_lowercase();
    let invite = Invite::filter_by_code(code.trim()).first().exec(&mut db).await?
        .filter(|invite| !invite.redeemed && invite.email.as_deref() == Some(email.as_str()))
        .ok_or_else(|| ApiError::not_found("invitation not found"))?;
    Competition::filter_by_id(invite.challenge_id).first().exec(&mut db).await?
        .ok_or_else(|| ApiError::not_found("challenge not found"))?;

    let membership_role = if invite.role == "owner" || invite.role == "admin" {
        "owner"
    } else {
        "participant"
    };
    let existing = ChallengeMembership::filter(
        ChallengeMembership::fields().challenge_id().eq(invite.challenge_id),
    ).exec(&mut db).await?.into_iter().find(|membership| membership.member_id == member.id);
    if let Some(membership) = existing {
        if membership_role == "owner" && membership.role != "owner" {
            toasty::update!(ChallengeMembership::filter_by_id(membership.id) { role: "owner" })
                .exec(&mut db).await?;
        }
    } else {
        toasty::create!(ChallengeMembership {
            challenge_id: invite.challenge_id,
            member_id: member.id,
            role: membership_role,
            is_favorite: false,
            joined_at: now_unix(),
        }).exec(&mut db).await?;
    }
    toasty::update!(Invite::filter_by_id(invite.id) { redeemed: true }).exec(&mut db).await?;
    Ok(Json(AcceptInviteResponse { challenge_id: invite.challenge_id }))
}
