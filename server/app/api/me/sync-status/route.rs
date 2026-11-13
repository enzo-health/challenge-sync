//! `GET /api/me/sync-status` — what the server knows about this account's sync, for the extension
//! popup. Bearer-authenticated so it works from any linked device.
//!
//! The popup used to show counts from its own local storage, so a second device always read
//! "0 posts, never synced" even while the first one had been syncing for weeks. The server is the
//! one place that sees every device, so it answers.

use axum::{Extension, Json};
use http::HeaderMap;
use linkedin_challenge_server::auth::bearer_member;
use linkedin_challenge_server::dto::last_sync_at;
use linkedin_challenge_server::models::Post;
use linkedin_challenge_server::web::ApiError;
use serde::{Deserialize, Serialize};
use toasty::Db;
use utoipa::ToSchema;

#[derive(Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct SyncStatusResponse {
    pub display_name: String,
    /// True once a LinkedIn identity is bound to the account.
    pub linked: bool,
    /// Posts on file across every device that has ever synced this account.
    pub posts_count: usize,
    /// Unix seconds of the most recent sync from any device, or null if none yet.
    #[schema(required)]
    pub last_sync_at: Option<i64>,
}

#[nextrs::api(
    operation_id = "getSyncStatus",
    responses(
        (status = 200, description = "Account-wide sync status", body = SyncStatusResponse),
        (status = 401, description = "Invalid or missing sync token", body = ApiError),
    ),
)]
pub async fn get(
    Extension(mut db): Extension<Db>,
    headers: HeaderMap,
) -> Result<Json<SyncStatusResponse>, ApiError> {
    let member = bearer_member(&mut db, &headers).await?;

    let posts_count = Post::filter(Post::fields().member_id().eq(member.id))
        .exec(&mut db)
        .await?
        .len();
    // Every sync writes exactly one profile snapshot, so its latest capture is the last sync time.
    let last_sync_at = last_sync_at(&mut db, member.id).await?;

    Ok(Json(SyncStatusResponse {
        display_name: member.display_name,
        linked: !member.linkedin_urn.starts_with("pending:"),
        posts_count,
        last_sync_at,
    }))
}
