//! The bodies of the GET endpoints the busiest pages read on first render, shared by their
//! `app/api/**/route.rs` handlers and the pages' `prefetch.rs` seeds (see [`crate::seeds`]).
//!
//! Each function starts after the caller has decided who is asking, with the same decision
//! functions on both sides (`dto::member_required` and friends), and returns exactly what the
//! handler answers. The handler wraps the `Ok` value in `Json`; a seed serialises the same value,
//! so a seeded cache entry cannot drift from the endpoint the page later refetches.

use std::collections::HashMap;

use serde::{Deserialize, Serialize};
use toasty::Db;
use utoipa::ToSchema;

use crate::auth::SessionInfo;
use crate::dto::{PostPage, last_sync_at, sync_is_stale, user_posts};
use crate::models::{ApiKey, Member};
use crate::reports::{PostReport, ReportFilter, ReportParams, post_report};
use crate::stats::{StatsOverview, StatsPeriod, stats_overview};
use crate::util::now_unix;
use crate::web::{ApiError, ApiResult};

// --- GET /api/auth/me ------------------------------------------------------------------------

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

/// `GET /api/auth/me` for a session already resolved with `auth::current_session` (None: signed
/// out, which is an answer, not an error).
pub async fn me(db: &mut Db, timing: &nextrs::Timing, session: Option<&SessionInfo>) -> ApiResult<MeResponse> {
    let Some(session) = session else {
        return Ok(signed_out());
    };
    let member = &session.member;
    let last_sync_at = timing.span("db", last_sync_at(db, member.id)).await?;

    Ok(MeResponse {
        signed_in: true,
        display_name: Some(member.display_name.clone()),
        is_system_admin: member.is_system_admin,
        member_id: Some(member.id),
        impersonated_by: session.impersonator.as_ref().map(|m| m.display_name.clone()),
        last_sync_at,
        sync_stale: sync_is_stale(last_sync_at, now_unix()),
    })
}

// --- GET /api/stats/overview -----------------------------------------------------------------

/// `GET /api/stats/overview` for a viewer who passed `dto::member_required`.
pub async fn stats(
    db: &mut Db,
    timing: &nextrs::Timing,
    viewer: &Member,
    days: Option<i64>,
    timezone: Option<&str>,
) -> ApiResult<StatsOverview> {
    let now = now_unix();
    let period = StatsPeriod::new(days, timezone, now).map_err(ApiError::bad_request)?;
    stats_overview(db, timing, &period, Some(viewer.id), now).await
}

// --- GET /api/me/posts -----------------------------------------------------------------------

/// The sorts `GET /api/me/posts` accepts (the My posts page offers the same list).
pub const POST_SORTS: [&str; 8] =
    ["newest", "oldest", "impressions", "reactions", "comments", "reposts", "sends", "saves"];

/// `GET /api/me/posts` for a user who passed `dto::member_required`.
pub async fn my_posts(
    db: &mut Db,
    timing: &nextrs::Timing,
    user: &Member,
    filter: Option<&str>,
    sort: Option<&str>,
    page: Option<usize>,
    page_size: Option<usize>,
) -> ApiResult<PostPage> {
    let sort = sort.unwrap_or("newest");
    if !POST_SORTS.contains(&sort) {
        return Err(ApiError::bad_request("invalid post sort"));
    }
    let posts = user_posts(
        db,
        user.id,
        filter,
        sort,
        page.unwrap_or(1).max(1),
        page_size.unwrap_or(50).clamp(1, 100),
    );
    timing.span("db", posts).await
}

// --- GET /api/system/api-keys and /api/me/api-keys -------------------------------------------

#[derive(Deserialize, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ApiKeyRow {
    pub id: i64,
    pub name: String,
    /// Name of whoever created (owns) it, when their account still exists.
    #[schema(required)]
    pub created_by_name: Option<String>,
    /// True for a member's own key, made on their API keys page; false for a key an admin made on
    /// the Reports page, which works only while its creator is an admin.
    pub personal: bool,
    pub created_at: i64,
    /// Unix seconds of the last request made with it, or null if it has never been used.
    #[schema(required)]
    pub last_used_at: Option<i64>,
}

#[derive(Deserialize, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ApiKeyList {
    pub keys: Vec<ApiKeyRow>,
}

/// Rows for these keys, newest first, each with its owner's name.
async fn api_key_rows(db: &mut Db, mut keys: Vec<ApiKey>) -> ApiResult<Vec<ApiKeyRow>> {
    keys.sort_by(|a, b| b.id.cmp(&a.id));
    let mut creator_ids: Vec<i64> = keys.iter().map(|key| key.created_by).collect();
    creator_ids.sort_unstable();
    creator_ids.dedup();
    let names: HashMap<i64, String> = if creator_ids.is_empty() {
        HashMap::new()
    } else {
        Member::filter(Member::fields().id().in_list(creator_ids))
            .exec(&mut *db)
            .await?
            .into_iter()
            .map(|member| (member.id, member.display_name))
            .collect()
    };
    Ok(keys
        .into_iter()
        .map(|key| ApiKeyRow {
            id: key.id,
            created_by_name: names.get(&key.created_by).cloned(),
            name: key.name,
            personal: key.personal,
            created_at: key.created_at,
            last_used_at: key.last_used_at,
        })
        .collect())
}

/// `GET /api/system/api-keys` for a caller who passed `dto::system_admin_required`: every key,
/// admins' and members' own.
pub async fn api_keys(db: &mut Db) -> ApiResult<ApiKeyList> {
    let keys = ApiKey::all().exec(&mut *db).await?;
    Ok(ApiKeyList { keys: api_key_rows(db, keys).await? })
}

/// How many keys of their own one member may hold at once.
pub const MAX_PERSONAL_KEYS: usize = 5;

#[derive(Deserialize, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct MyApiKeyList {
    /// The member's own keys, newest first.
    pub keys: Vec<ApiKeyRow>,
    /// How many they may hold at once; creating another is refused at this many.
    pub max_keys: usize,
    /// Requests each key may make per minute (`auth::API_KEY_REQUESTS_PER_MINUTE`).
    pub requests_per_minute: i64,
}

/// A member's own (personal) keys. Keys they made as an admin on the Reports page are not listed
/// here: those are managed there.
pub async fn personal_api_keys(db: &mut Db, member_id: i64) -> toasty::Result<Vec<ApiKey>> {
    Ok(ApiKey::filter(ApiKey::fields().created_by().eq(member_id))
        .exec(&mut *db)
        .await?
        .into_iter()
        .filter(|key| key.personal)
        .collect())
}

/// `GET /api/me/api-keys` for a member who passed `dto::member_required`.
pub async fn my_api_keys(db: &mut Db, member: &Member) -> ApiResult<MyApiKeyList> {
    let keys = personal_api_keys(db, member.id).await?;
    Ok(MyApiKeyList { keys: api_key_rows(db, keys).await?, max_keys: MAX_PERSONAL_KEYS,
        requests_per_minute: crate::auth::API_KEY_REQUESTS_PER_MINUTE,
    })
}

// --- GET /api/v1/posts (JSON) ----------------------------------------------------------------

/// The report's period and filters for `GET /api/v1/posts`, resolved against now; an invalid
/// parameter is the endpoint's 400.
pub fn report_filter(params: ReportParams<'_>) -> ApiResult<ReportFilter> {
    ReportFilter::new(params, now_unix()).map_err(ApiError::bad_request)
}

/// The post report of `GET /api/v1/posts` (its JSON body), for a caller who passed
/// `reports::require_report_access` (or, from a website session, `reports::report_session_access`).
pub async fn report(db: &mut Db, timing: &nextrs::Timing, filter: &ReportFilter) -> ApiResult<PostReport> {
    Ok(timing.span("db", post_report(db, filter)).await?)
}
