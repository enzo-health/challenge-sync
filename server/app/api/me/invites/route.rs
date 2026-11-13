//! Pending challenge invitations addressed to the signed-in account.

use axum::{Extension, Json};
use http::HeaderMap;
use linkedin_challenge_server::dto::{challenges_by_ids, require_challenge_user};
use std::collections::HashMap;
use linkedin_challenge_server::models::{Competition, Invite, Member};
use linkedin_challenge_server::web::ApiError;
use serde::{Deserialize, Serialize};
use toasty::Db;
use utoipa::ToSchema;

#[derive(Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct PendingChallengeInvite {
    pub code: String,
    pub challenge_id: i64,
    pub challenge_name: String,
    pub invited_by: String,
    pub start_at: i64,
    pub end_at: i64,
}

#[derive(Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct MyInvitesResponse { pub invites: Vec<PendingChallengeInvite> }

#[nextrs::api(operation_id = "getMyInvites")]
pub async fn get(
    Extension(mut db): Extension<Db>,
    headers: HeaderMap,
) -> Result<Json<MyInvitesResponse>, ApiError> {
    let member = require_challenge_user(&mut db, &headers).await?;
    let email = member.email.as_deref().unwrap_or_default().to_lowercase();
    let invites: Vec<Invite> = Invite::all().exec(&mut db).await?.into_iter()
        .filter(|invite| !invite.redeemed && invite.email.as_deref() == Some(email.as_str()))
        .collect();
    // Resolve the challenges and their creators in two batched reads, not two per invite.
    let challenges = challenges_by_ids(&mut db, invites.iter().map(|i| i.challenge_id).collect()).await?;
    let creator_ids: Vec<i64> = challenges.iter().map(|c| c.creator_id).collect();
    let creators: HashMap<i64, String> = if creator_ids.is_empty() {
        HashMap::new()
    } else {
        Member::filter(Member::fields().id().in_list(creator_ids)).exec(&mut db).await?
            .into_iter().map(|m| (m.id, m.display_name)).collect()
    };
    let challenges: HashMap<i64, Competition> = challenges.into_iter().map(|c| (c.id, c)).collect();
    let mut rows = Vec::new();
    for invite in invites {
        let Some(challenge) = challenges.get(&invite.challenge_id) else { continue };
        rows.push(PendingChallengeInvite {
            code: invite.code,
            challenge_id: challenge.id,
            challenge_name: challenge.name.clone(),
            invited_by: creators.get(&challenge.creator_id).cloned()
                .unwrap_or_else(|| "Challenge organizer".to_string()),
            start_at: challenge.start_at,
            end_at: challenge.end_at,
        });
    }
    rows.sort_by(|a, b| b.start_at.cmp(&a.start_at));
    Ok(Json(MyInvitesResponse { invites: rows }))
}
