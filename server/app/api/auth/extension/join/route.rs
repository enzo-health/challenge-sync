//! `POST /api/auth/extension/join` — the extension signs a person in from their LinkedIn identity.
//!
//! This is the no-password front door. The extension reads who the person is on LinkedIn and
//! presents the company's join code (picked up from the `/join/<code>` page). If no account has
//! that LinkedIn identity yet, one is created; either way this device gets a sync token.
//!
//! **Trust model.** The server cannot verify the LinkedIn identity: it is whatever the extension
//! says. Sending LinkedIn's own cookies here to check would mean holding everyone's LinkedIn
//! keys, so that is ruled out. The join code is therefore the real gate: holding it is what lets
//! a browser claim an identity, which is the same trust the sync endpoint already places in the
//! extension for every number it scores.

use axum::{Extension, Json};
use http::StatusCode;
use linkedin_challenge_server::auth::{issue_device_token, join_code_matches};
use linkedin_challenge_server::enroll::enroll_in_running_challenges;
use linkedin_challenge_server::models::{Member, Org};
use linkedin_challenge_server::util::{new_bearer_token, now_unix};
use linkedin_challenge_server::web::ApiError;
use serde::{Deserialize, Serialize};
use toasty::Db;
use utoipa::ToSchema;

#[derive(Deserialize, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ExtensionJoinRequest {
    /// The company join code, from the `join_code` cookie the join page sets.
    pub join_code: Option<String>,
    pub member: ExtensionIdentity,
}

#[derive(Deserialize, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ExtensionIdentity {
    pub member_urn: String,
    pub public_identifier: Option<String>,
    pub first_name: Option<String>,
    pub last_name: Option<String>,
    pub profile_url: Option<String>,
}

#[derive(Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ExtensionJoinResponse {
    pub sync_token: String,
    pub display_name: String,
    pub member_id: i64,
    /// True when this call created the account; false when it signed in to an existing one.
    pub created: bool,
}

#[nextrs::api(
    operation_id = "joinWithExtension",
    responses(
        (status = 200, description = "Signed in; sync token issued for this device", body = ExtensionJoinResponse),
        (status = 400, description = "Missing or malformed LinkedIn identity", body = ApiError),
        (status = 403, description = "Missing or wrong join code", body = ApiError),
    ),
)]
pub async fn post(
    Extension(mut db): Extension<Db>,
    Json(req): Json<ExtensionJoinRequest>,
) -> Result<Json<ExtensionJoinResponse>, ApiError> {
    let urn = req.member.member_urn.trim();
    // `pending:` is the placeholder prefix for accounts with no identity yet; accepting it here
    // would let a caller sign in as one of those.
    if urn.is_empty() || urn.len() > 200 || urn.starts_with("pending:") {
        return Err(ApiError::bad_request("a LinkedIn identity is required"));
    }
    let join_code = req.join_code.as_deref().unwrap_or("");
    if !join_code_matches(&mut db, join_code).await? {
        return Err(ApiError::new(
            StatusCode::FORBIDDEN,
            "open your company's invite link first",
        ));
    }

    let existing = Member::filter_by_linkedin_urn(urn).first().exec(&mut db).await?;
    let (member, created) = match existing {
        Some(member) => (member, false),
        None => {
            // `org_id` is a required legacy column, not an ownership boundary; every independent
            // account shares this inert row (see signup).
            let org = match Org::filter_by_slug("users").first().exec(&mut db).await? {
                Some(org) => org,
                None => toasty::create!(Org { slug: "users", name: "Users", created_at: now_unix() })
                    .exec(&mut db)
                    .await?,
            };
            // A unique placeholder that is never handed out, so the unique column stays unique.
            let (_unused, token_hash) = new_bearer_token();
            let name = display_name(&req.member);
            let created = toasty::create!(Member {
                org_id: org.id,
                display_name: &name,
                linkedin_urn: urn,
                public_identifier: req.member.public_identifier.as_deref().unwrap_or(""),
                profile_url: req.member.profile_url.clone(),
                is_admin: false,
                is_system_admin: false,
                email: None,
                password_hash: None,
                api_token_hash: token_hash,
                created_at: now_unix(),
            })
            .exec(&mut db)
            .await;
            match created {
                Ok(member) => (member, true),
                // Two installs of one person racing each other: the unique URN lets one win, and
                // the loser signs in to the account the winner just made.
                Err(error) if error.to_string().to_ascii_lowercase().contains("unique") => {
                    let member = Member::filter_by_linkedin_urn(urn)
                        .first()
                        .exec(&mut db)
                        .await?
                        .ok_or_else(|| ApiError::conflict("that LinkedIn account is being set up; try again"))?;
                    (member, false)
                }
                Err(error) => return Err(error.into()),
            }
        }
    };

    // Everyone competes in whatever is running, so a new or returning person is on the board.
    enroll_in_running_challenges(&mut db, member.id).await?;
    let sync_token = issue_device_token(&mut db, member.id).await?;

    Ok(Json(ExtensionJoinResponse {
        sync_token,
        display_name: member.display_name,
        member_id: member.id,
        created,
    }))
}

/// The LinkedIn name, then the public identifier, then a neutral fallback.
fn display_name(m: &ExtensionIdentity) -> String {
    let full = format!(
        "{} {}",
        m.first_name.as_deref().unwrap_or(""),
        m.last_name.as_deref().unwrap_or("")
    )
    .trim()
    .to_string();
    if !full.is_empty() {
        return full.chars().take(100).collect();
    }
    m.public_identifier
        .clone()
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "New member".to_string())
}
