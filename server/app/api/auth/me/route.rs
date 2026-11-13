//! `GET /api/auth/me` — who, if anyone, is signed in. The sidebar shell reads this for navigation,
//! the impersonation banner, and the "Chrome paused Challenge Sync" banner.

use axum::{Extension, Json};
use http::HeaderMap;
use linkedin_challenge_server::auth::current_session;
use linkedin_challenge_server::dto::{last_sync_at, sync_is_stale};
use linkedin_challenge_server::util::now_unix;
use linkedin_challenge_server::web::ApiError;
use serde::{Deserialize, Serialize};
use toasty::Db;
use utoipa::ToSchema;

#[derive(Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct MeResponse {
    pub signed_in: bool,
    pub display_name: Option<String>,
    /// Whether this member operates the product — unlocks the System panel.
    pub is_system_admin: bool,
    pub member_id: Option<i64>,
    /// The system admin really driving this session, when it is an impersonation.
    pub impersonated_by: Option<String>,
    /// Unix seconds of this member's most recent sync from any device (newest profile snapshot),
    /// or null if they have never synced or nobody is signed in.
    #[schema(required)]
    pub last_sync_at: Option<i64>,
    /// True when a signed-in member has never synced or last synced more than two days ago — most
    /// likely Chrome has switched the extension off. Always false when signed out.
    pub sync_stale: bool,
}

fn signed_out() -> MeResponse {
    MeResponse {
        signed_in: false,
        display_name: None,
        is_system_admin: false,
        member_id: None,
        impersonated_by: None,
        last_sync_at: None,
        sync_stale: false,
    }
}

#[nextrs::api(operation_id = "getMe")]
pub async fn get(
    Extension(mut db): Extension<Db>,
    headers: HeaderMap,
) -> Result<Json<MeResponse>, ApiError> {
    let Some(session) = current_session(&mut db, &headers).await else {
        return Ok(Json(signed_out()));
    };
    let member = session.member;
    let last_sync_at = last_sync_at(&mut db, member.id).await?;

    Ok(Json(MeResponse {
        signed_in: true,
        display_name: Some(member.display_name),
        is_system_admin: member.is_system_admin,
        member_id: Some(member.id),
        impersonated_by: session.impersonator.map(|m| m.display_name),
        last_sync_at,
        sync_stale: sync_is_stale(last_sync_at, now_unix()),
    }))
}
