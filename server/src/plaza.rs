//! The plaza: a page where members' avatars walk around together live.
//!
//! Two apps that never call each other. This one knows who people are and serves
//! `GET /api/plaza/roster` (everyone, their avatar and whether they posted this week) and
//! `POST /api/plaza/pass` (a short-lived signed pass for the caller). A separate Cloudflare Durable
//! Object (`../plaza/`) relays positions over WebSocket and admits a browser on that pass, which it
//! checks with the public key alone; the pass format is the shared crate `../plaza-protocol`.
//!
//! Both are open to every signed-in member who is not deleted (`dto::require_member`), not only to
//! those who may use challenges. Under "View as" they act as the impersonated member, like every
//! `/api/me` route.
//!
//! **The star.** `postedThisWeek` is the lottery's rule for the week in progress, decided by
//! [`lottery::original_post_counts`]: at least one original post (not a reshare) whose LinkedIn
//! creation time falls in the current Friday-to-Thursday Denver week. The lottery's exclusion flag is
//! about the prize draw, not about posting, so an excluded member who posted still has the star.

use http::StatusCode;
use serde::Serialize;
use toasty::Db;
use utoipa::ToSchema;

use crate::avatar::{Avatar, member_avatar};
use crate::lottery::{self, LotteryWeek, TIMEZONE, by_name, denver_offset};
use crate::models::Member;
use crate::reports::fmt_local;
use crate::web::{ApiError, ApiResult};

/// Where the browser finds the room, when `PLAZA_ROOM_URL` is unset in a debug build: the room's
/// `wrangler dev` default.
pub const DEV_ROOM_URL: &str = "ws://127.0.0.1:8787/room";

/// The `code` values the plaza's refusals carry (alongside `web::codes`).
pub mod codes {
    /// `PLAZA_PASS_PRIVATE_KEY` is not set on the server, so no pass can be signed.
    pub const PLAZA_KEY_MISSING: &str = "plaza_key_missing";
    /// `PLAZA_PASS_PRIVATE_KEY` is set but is not a base64 32-byte Ed25519 seed.
    pub const PLAZA_KEY_INVALID: &str = "plaza_key_invalid";
}

#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct PlazaWeek {
    /// The Friday the current lottery week starts on, local date, e.g. `2026-11-13`.
    pub week_start: String,
    /// The Friday after (exclusive), local date; the week's last day is the Thursday before it.
    pub week_end: String,
    /// The week's first instant with its offset, e.g. `2026-11-13T00:00:00-07:00`.
    pub starts_at: String,
    /// The next week's first instant with its offset (exclusive).
    pub ends_at: String,
    /// Always `America/Denver`.
    pub timezone: String,
}

#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct PlazaMember {
    pub id: i64,
    /// Display name, as the lottery shows it.
    pub name: String,
    /// Their saved avatar, or null for the look generated from their id.
    #[schema(required = true)]
    pub avatar: Option<Avatar>,
    /// At least one original post (not a reshare) in the current lottery week.
    pub posted_this_week: bool,
}

#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct PlazaRoster {
    /// The caller's member id (the impersonated member during "View as").
    pub me: i64,
    /// The room's WebSocket URL, or null when this server has none configured (live mode off).
    #[schema(required = true)]
    pub room_url: Option<String>,
    /// The current lottery week, which `postedThisWeek` is about.
    pub week: PlazaWeek,
    /// Every member who is not deleted, sorted by name (case-insensitive), then id.
    pub members: Vec<PlazaMember>,
}

#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct PlazaPass {
    /// The signed pass to present to the room.
    pub pass: String,
    /// When the pass stops being accepted, unix seconds.
    pub expires_at: i64,
}

/// The room URL: `PLAZA_ROOM_URL` when set (and not blank), else the dev default in a debug build,
/// else none.
pub fn room_url() -> Option<String> {
    room_url_from(std::env::var("PLAZA_ROOM_URL").ok(), cfg!(debug_assertions))
}

fn room_url_from(configured: Option<String>, debug: bool) -> Option<String> {
    match configured.map(|value| value.trim().to_string()) {
        Some(value) if !value.is_empty() => Some(value),
        _ => debug.then(|| DEV_ROOM_URL.to_string()),
    }
}

/// The roster for `me` at `now`. Two queries: all members, then the week's original posts.
pub async fn roster(db: &mut Db, me: &Member, now: i64) -> ApiResult<PlazaRoster> {
    let week = LotteryWeek::containing(now);
    let members = Member::all().exec(&mut *db).await?;
    let counts = lottery::original_post_counts(db, week.period()).await?;
    let mut members: Vec<PlazaMember> = members
        .into_iter()
        .filter(|member| !member.is_deleted())
        .map(|member| PlazaMember {
            avatar: member_avatar(&member),
            posted_this_week: counts.contains_key(&member.id),
            id: member.id,
            name: member.display_name,
        })
        .collect();
    members.sort_by(|a, b| by_name((&a.name, a.id), (&b.name, b.id)));
    Ok(PlazaRoster {
        me: me.id,
        room_url: room_url(),
        week: plaza_week(week),
        members,
    })
}

fn plaza_week(week: LotteryWeek) -> PlazaWeek {
    PlazaWeek {
        week_start: week.start_date(),
        week_end: week.end_date(),
        starts_at: fmt_local(week.starts_at, denver_offset(week.starts_at)),
        ends_at: fmt_local(week.ends_at, denver_offset(week.ends_at)),
        timezone: TIMEZONE.to_string(),
    }
}

/// A pass for `member_id`, valid for `PASS_TTL_SECS` from `now`, signed with
/// `PLAZA_PASS_PRIVATE_KEY`.
pub fn issue_pass(member_id: i64, now: i64) -> ApiResult<PlazaPass> {
    issue_pass_with(std::env::var("PLAZA_PASS_PRIVATE_KEY").ok().as_deref(), member_id, now)
}

fn issue_pass_with(private_key: Option<&str>, member_id: i64, now: i64) -> ApiResult<PlazaPass> {
    let seed = signing_seed(private_key)?;
    let expires_at = now + plaza_protocol::pass::PASS_TTL_SECS;
    Ok(PlazaPass {
        pass: plaza_protocol::pass::sign(&seed, member_id, expires_at),
        expires_at,
    })
}

/// The signing seed from the variable's value. Both refusals are 503: the server is not set up to
/// issue passes, which no retry by the caller can fix. The key itself is never echoed.
fn signing_seed(value: Option<&str>) -> ApiResult<[u8; 32]> {
    let value = value.map(str::trim).filter(|value| !value.is_empty()).ok_or_else(|| {
        ApiError::new(
            StatusCode::SERVICE_UNAVAILABLE,
            "the plaza is not configured: PLAZA_PASS_PRIVATE_KEY is not set on the server",
        )
        .with_code(codes::PLAZA_KEY_MISSING)
    })?;
    plaza_protocol::pass::decode_key(value).map_err(|reason| {
        ApiError::new(
            StatusCode::SERVICE_UNAVAILABLE,
            format!(
                "the plaza is misconfigured: PLAZA_PASS_PRIVATE_KEY is not a base64 32-byte Ed25519 seed ({reason})"
            ),
        )
        .with_code(codes::PLAZA_KEY_INVALID)
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn room_url_prefers_the_variable_then_the_debug_default() {
        assert_eq!(room_url_from(Some("wss://room.example/room".into()), false).as_deref(), Some("wss://room.example/room"));
        assert_eq!(room_url_from(Some("wss://room.example/room".into()), true).as_deref(), Some("wss://room.example/room"));
        assert_eq!(room_url_from(None, true).as_deref(), Some(DEV_ROOM_URL));
        assert_eq!(room_url_from(Some("  ".into()), true).as_deref(), Some(DEV_ROOM_URL));
        assert_eq!(room_url_from(None, false), None);
        assert_eq!(room_url_from(Some(String::new()), false), None);
    }

    #[test]
    fn a_missing_key_is_a_503_saying_so() {
        for value in [None, Some(""), Some("   ")] {
            let error = issue_pass_with(value, 7, 1_000).unwrap_err();
            assert_eq!(error.status, StatusCode::SERVICE_UNAVAILABLE);
            assert_eq!(error.code.as_deref(), Some(codes::PLAZA_KEY_MISSING));
            assert!(error.error.contains("PLAZA_PASS_PRIVATE_KEY is not set"), "{}", error.error);
        }
    }

    #[test]
    fn an_invalid_key_is_refused_without_echoing_it() {
        let short = plaza_protocol::pass::encode_key(&[9u8; 32]);
        let short = &short[..short.len() - 8];
        for value in ["not base64 at all!", short] {
            let error = issue_pass_with(Some(value), 7, 1_000).unwrap_err();
            assert_eq!(error.status, StatusCode::SERVICE_UNAVAILABLE);
            assert_eq!(error.code.as_deref(), Some(codes::PLAZA_KEY_INVALID));
            assert!(!error.error.contains(value), "{}", error.error);
        }
    }

    #[test]
    fn a_pass_verifies_for_the_member_and_expires_after_the_ttl() {
        let seed = [42u8; 32];
        let public = plaza_protocol::pass::public_key_of(&seed);
        let key = plaza_protocol::pass::encode_key(&seed);
        let pass = issue_pass_with(Some(&key), 7, 1_000).unwrap();
        assert_eq!(pass.expires_at, 1_000 + plaza_protocol::pass::PASS_TTL_SECS);
        let claims = plaza_protocol::pass::verify(&public, &pass.pass, 1_000).unwrap();
        assert_eq!((claims.member_id, claims.expires_at), (7, pass.expires_at));
        assert!(plaza_protocol::pass::verify(&public, &pass.pass, pass.expires_at + 1).is_err());
    }
}
