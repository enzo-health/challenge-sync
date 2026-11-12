//! The admin post report: everyone's posts from a period, filtered by impressions and text, with a
//! per-person summary. One query serves both the website's Reports page and the API that an
//! admin's AI agent calls with an API key (`GET /api/v1/posts`), so the two cannot disagree.
//!
//! The period is exact. `since` and `until` are each either a calendar day or an instant with an
//! offset; both ends are included. Days are read in a fixed UTC offset (`timezone`, UTC by
//! default), because the challenge's weeks run Friday to Thursday in Mountain time and a UTC day
//! would move a Thursday-evening post into the next week. There is deliberately no time zone
//! database: the caller picks the offset, -07:00 for Mountain standard time and -06:00 for summer.
//! The default "past 7 days" is today and the six days before it in that offset, so running it on
//! the same weekday each week gives back-to-back weeks that neither overlap nor leave a gap.

use std::collections::HashMap;

use serde::{Deserialize, Serialize};
use toasty::Db;
use utoipa::ToSchema;

use crate::dto::{post_text_contains, profile_readings};
use crate::models::{Member, Post, PostSnapshot};
use crate::scoring::Dataset;
use crate::util::{fmt_date, fmt_iso8601, parse_date, parse_iso8601};

const DAY: i64 = 86_400;
/// Days in the default window, today included.
pub const DEFAULT_DAYS: i64 = 7;
/// Longest window one request may ask for. Every snapshot of every post in the window is read to
/// find the latest one, so an unbounded window would read most of `post_snapshots`.
pub const MAX_DAYS: i64 = 366;
/// Widest real-world UTC offset is +14:00; anything beyond is a typo.
const MAX_OFFSET: i64 = 14 * 3600;

/// The raw request, before resolving. Blank strings count as absent.
#[derive(Debug, Default, Clone, Copy)]
pub struct ReportParams<'a> {
    pub since: Option<&'a str>,
    pub until: Option<&'a str>,
    pub timezone: Option<&'a str>,
    pub min_impressions: Option<i64>,
    pub min_out_of_network_impressions: Option<i64>,
    pub member_id: Option<i64>,
    pub contains: Option<&'a str>,
    pub include_reposts: bool,
}

/// The resolved inputs of one report.
#[derive(Debug, Clone, PartialEq)]
pub struct ReportFilter {
    /// First instant included, unix seconds.
    pub start: i64,
    /// One second after the last instant included, unix seconds. Exclusive.
    pub end: i64,
    /// The UTC offset dates were read in and local times are shown in, in seconds east of UTC.
    pub offset: i64,
    pub min_impressions: Option<i64>,
    pub min_out_of_network_impressions: Option<i64>,
    pub member_id: Option<i64>,
    /// Lowercased text to look for in the post, or None for any post.
    pub contains: Option<String>,
    /// False (the default): original posts only. True: reshares too.
    pub include_reposts: bool,
}

/// A query value with surrounding blanks removed; None when nothing is left.
fn present(value: Option<&str>) -> Option<&str> {
    value.map(str::trim).filter(|value| !value.is_empty())
}

/// A `YYYY-MM-DD` date at 00:00 UTC, refusing anything else (including impossible days such as
/// 2026-02-30, which plain arithmetic would quietly roll into March).
pub fn parse_report_date(value: &str) -> Option<i64> {
    let value = value.trim();
    let bytes = value.as_bytes();
    if bytes.len() != 10 || bytes[4] != b'-' || bytes[7] != b'-' {
        return None;
    }
    let unix = parse_date(value)?;
    (fmt_date(unix) == value).then_some(unix)
}

/// A fixed UTC offset — `Z`, `+00:00`, `-07:00` — as seconds east of UTC.
///
/// A `+` typed into a URL without encoding arrives as a space and is trimmed away, so an unsigned
/// `07:00` is read as `+07:00` rather than refused: that is the only way it can arrive unsigned.
pub fn parse_offset(value: &str) -> Option<i64> {
    let value = value.trim();
    if value.eq_ignore_ascii_case("z") {
        return Some(0);
    }
    let (sign, rest) = match value.as_bytes().first()? {
        b'+' => (1, &value[1..]),
        b'-' => (-1, &value[1..]),
        b'0'..=b'9' => (1, value),
        _ => return None,
    };
    let bytes = rest.as_bytes();
    if bytes.len() != 5 || bytes[2] != b':' || !rest.chars().all(|c| c.is_ascii_digit() || c == ':') {
        return None;
    }
    let hours: i64 = rest[..2].parse().ok()?;
    let minutes: i64 = rest[3..].parse().ok()?;
    let seconds = hours * 3600 + minutes * 60;
    (minutes < 60 && seconds <= MAX_OFFSET).then_some(sign * seconds)
}

/// An offset as `+HH:MM` / `-HH:MM` (`+00:00` for UTC).
pub fn fmt_offset(offset: i64) -> String {
    let sign = if offset < 0 { '-' } else { '+' };
    let abs = offset.abs();
    format!("{sign}{:02}:{:02}", abs / 3600, abs % 3600 / 60)
}

/// Unix seconds as local time in `offset`, e.g. `2026-11-12T23:59:59-07:00`.
pub fn fmt_local(unix: i64, offset: i64) -> String {
    let local = fmt_iso8601(unix + offset);
    format!("{}{}", &local[..19], fmt_offset(offset))
}

/// An exact instant: `YYYY-MM-DDTHH:MM:SS`, optional fraction, then `Z` or an offset. A timestamp
/// with no offset is refused, since it would silently mean UTC to us and local time to the caller.
pub fn parse_instant(value: &str) -> Option<i64> {
    let value = value.trim();
    if value.len() < 20 || !value.is_char_boundary(19) {
        return None;
    }
    let (clock, mut rest) = value.split_at(19);
    let wall = parse_iso8601(clock)?;
    // Reject 2026-02-30T..., 25:00 and the like, which the arithmetic would roll over.
    if fmt_iso8601(wall)[..19] != clock.replace(' ', "T") {
        return None;
    }
    if let Some(fraction) = rest.strip_prefix('.') {
        let digits = fraction.chars().take_while(char::is_ascii_digit).count();
        if digits == 0 {
            return None;
        }
        rest = &fraction[digits..];
    }
    // An unencoded `+` in a URL arrives as a space.
    let offset = match rest.strip_prefix(' ') {
        Some(unsigned) => parse_offset(&format!("+{unsigned}"))?,
        None => parse_offset(rest)?,
    };
    Some(wall - offset)
}

/// Either form of a period end. Returns the instant and whether it was a whole day.
enum Bound {
    Day(i64),
    Instant(i64),
}

fn parse_bound(name: &str, value: &str) -> Result<Bound, String> {
    if let Some(day) = parse_report_date(value) {
        return Ok(Bound::Day(day));
    }
    parse_instant(value).map(Bound::Instant).ok_or_else(|| {
        format!(
            "{name} must be a date like 2026-11-13 or a time with an offset like \
             2026-11-13T00:00:00-07:00, got {value:?}"
        )
    })
}

impl ReportFilter {
    /// Resolve the request against `now`.
    ///
    /// A date means the whole of that day in `timezone`; a timestamp means exactly that instant.
    /// Both ends are included. A missing `until` is the end of today in `timezone`; a missing
    /// `since` is the start of the day six days before the day `until` falls on, so the default
    /// is seven calendar days.
    pub fn new(params: ReportParams<'_>, now: i64) -> Result<Self, String> {
        let offset = match present(params.timezone) {
            Some(value) => parse_offset(value).ok_or_else(|| {
                format!("timezone must be an offset like -07:00, +00:00 or Z, got {value:?}")
            })?,
            None => 0,
        };
        // Midnight at the start of the local day containing `unix`.
        let day_start = |unix: i64| (unix + offset).div_euclid(DAY) * DAY - offset;
        let end = match present(params.until) {
            Some(value) => match parse_bound("until", value)? {
                Bound::Day(day) => day + DAY - offset,
                Bound::Instant(at) => at + 1,
            },
            None => day_start(now) + DAY,
        };
        let start = match present(params.since) {
            Some(value) => match parse_bound("since", value)? {
                Bound::Day(day) => day - offset,
                Bound::Instant(at) => at,
            },
            None => day_start(end - 1) - (DEFAULT_DAYS - 1) * DAY,
        };
        if start >= end {
            return Err("since must be on or before until".to_string());
        }
        if end - start > MAX_DAYS * DAY {
            return Err(format!("the period can be at most {MAX_DAYS} days"));
        }
        for (name, value) in [
            ("minImpressions", params.min_impressions),
            ("minOutOfNetworkImpressions", params.min_out_of_network_impressions),
        ] {
            if value.is_some_and(|value| value < 0) {
                return Err(format!("{name} cannot be negative"));
            }
        }
        Ok(Self {
            start,
            end,
            offset,
            min_impressions: params.min_impressions,
            min_out_of_network_impressions: params.min_out_of_network_impressions,
            member_id: params.member_id,
            contains: present(params.contains).map(str::to_lowercase),
            include_reposts: params.include_reposts,
        })
    }

    /// First instant included, in the requested offset.
    pub fn since(&self) -> String {
        fmt_local(self.start, self.offset)
    }

    /// Last instant included (one second before the exclusive end), in the requested offset.
    pub fn until(&self) -> String {
        fmt_local(self.end - 1, self.offset)
    }
}

#[derive(Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ReportFilters {
    /// First instant included, e.g. `2026-11-06T00:00:00-07:00`.
    pub since: String,
    /// Last instant included, e.g. `2026-11-12T23:59:59-07:00`.
    pub until: String,
    /// The UTC offset dates were read in, e.g. `-07:00`; `+00:00` by default.
    pub timezone: String,
    #[schema(required)]
    pub min_impressions: Option<i64>,
    #[schema(required)]
    pub min_out_of_network_impressions: Option<i64>,
    #[schema(required)]
    pub member_id: Option<i64>,
    /// Text the posts were searched for (lowercased), or null.
    #[schema(required)]
    pub contains: Option<String>,
    pub include_reposts: bool,
}

/// One post in the report. Each number is the most recent value read for it; null means LinkedIn's
/// number was never read for this post.
#[derive(Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ReportPost {
    pub post_id: i64,
    pub member_id: i64,
    pub author_name: String,
    #[schema(required)]
    pub author_profile_url: Option<String>,
    #[schema(required)]
    pub author_public_identifier: Option<String>,
    /// True when an admin has since deleted the author's account. Their posts stay in the
    /// period they were published in, so a past week's report does not change when someone leaves.
    pub author_deleted: bool,
    /// Link to the post on LinkedIn.
    pub post_url: String,
    /// When the post was published, `YYYY-MM-DDTHH:MM:SSZ` (UTC).
    pub posted_at: String,
    /// The same moment in the requested `timezone`, e.g. `2026-11-12T21:30:00-07:00`.
    pub posted_at_local: String,
    /// The same moment as unix seconds.
    pub posted_at_unix: i64,
    /// The post's full text as stored (LinkedIn posts are at most 3,000 characters; the server
    /// keeps up to 10,000), or null when the extension could not read it.
    #[schema(required)]
    pub text: Option<String>,
    /// True when this is the member resharing someone else's post. Only present with
    /// `includeReposts=true`; by default the report covers original posts only.
    pub is_repost: bool,
    #[schema(required)]
    pub impressions: Option<i64>,
    #[schema(required)]
    pub impressions_in_network: Option<i64>,
    #[schema(required)]
    pub impressions_out_of_network: Option<i64>,
    #[schema(required)]
    pub reactions: Option<i64>,
    #[schema(required)]
    pub comments: Option<i64>,
    #[schema(required)]
    pub reposts: Option<i64>,
    #[schema(required)]
    pub sends: Option<i64>,
    #[schema(required)]
    pub saves: Option<i64>,
    /// When the post was last read (`YYYY-MM-DDTHH:MM:SSZ`), or null if it never was. A number
    /// that reading missed falls back to the previous reading that had it.
    #[schema(required)]
    pub metrics_captured_at: Option<String>,
}

/// One person who posted in the period.
#[derive(Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ReportAuthor {
    pub member_id: i64,
    pub display_name: String,
    #[schema(required)]
    pub profile_url: Option<String>,
    #[schema(required)]
    pub public_identifier: Option<String>,
    /// True when an admin has since deleted this account (see `ReportPost::author_deleted`).
    pub deleted: bool,
    /// Every post they published in the period, whatever its numbers.
    pub posts_in_period: i64,
    /// How many of those passed the filters (equal to `postsInPeriod` with none).
    pub matching_posts: i64,
}

#[derive(Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct PostReport {
    pub filters: ReportFilters,
    /// The UTC offset the period and `postedAtLocal` are in, e.g. `-07:00` (same as
    /// `filters.timezone`).
    pub timezone: String,
    /// "impressionsOutOfNetwork" when that filter is set, otherwise "impressions"; highest first.
    pub sorted_by: String,
    /// Number of entries in `posts`.
    pub post_count: usize,
    pub posts: Vec<ReportPost>,
    /// Everyone who posted in the period, most matching posts first.
    pub authors: Vec<ReportAuthor>,
}

/// Build the report. Three queries (see [`Dataset::load_posted_between`]): the posts in the
/// period, the snapshots of only those posts, and their authors. `post_snapshots` is by far the
/// largest table, so it is never read whole.
pub async fn post_report(db: &mut Db, filter: &ReportFilter) -> toasty::Result<PostReport> {
    let data = Dataset::load_posted_between(db, filter.start, filter.end, filter.member_id).await?;

    let mut authors: HashMap<i64, ReportAuthor> = HashMap::new();
    let mut rows = Vec::new();
    for (member_id, posts) in &data.posts_by_member {
        let Some(member) = data.members.get(member_id) else { continue };
        for post in posts {
            // Jason's draw counts original posts only, so reshares are left out of the counts too
            // unless asked for. (Scoring elsewhere is unchanged.)
            if post.is_repost && !filter.include_reposts {
                continue;
            }
            let Some(posted_at) = data.posted_at(post) else { continue };
            let latest = data.snapshots(post.id).last();
            // The most recent value read for each number, not just the newest reading's: the
            // analytics read is best effort, and a post that passed 3,000 out-of-network
            // impressions must not drop out of the report because one later read failed.
            let pick = |field: fn(&PostSnapshot) -> Option<i64>| data.latest_known(post.id, field);
            let row = ReportPost {
                post_id: post.id,
                member_id: member.id,
                author_name: member.display_name.clone(),
                author_profile_url: member.profile_url.clone().filter(|url| !url.is_empty()),
                author_public_identifier: Some(member.public_identifier.clone())
                    .filter(|id| !id.is_empty()),
                author_deleted: member.is_deleted(),
                post_url: post.permalink.clone(),
                posted_at: fmt_iso8601(posted_at),
                posted_at_local: fmt_local(posted_at, filter.offset),
                posted_at_unix: posted_at,
                text: post.text_preview.clone(),
                is_repost: post.is_repost,
                impressions: pick(|s| s.impressions),
                impressions_in_network: pick(|s| s.impressions_in_network),
                impressions_out_of_network: pick(|s| s.impressions_out_of_network),
                reactions: pick(|s| s.reactions),
                comments: pick(|s| s.comments),
                reposts: pick(|s| s.reposts),
                sends: pick(|s| s.sends),
                saves: pick(|s| s.saves),
                metrics_captured_at: latest.map(|s| fmt_iso8601(s.captured_at)),
            };
            let matches = passes(row.impressions, filter.min_impressions)
                && passes(row.impressions_out_of_network, filter.min_out_of_network_impressions)
                && filter
                    .contains
                    .as_deref()
                    .is_none_or(|needle| post_text_contains(row.text.as_deref(), needle));
            let author = authors.entry(member.id).or_insert_with(|| ReportAuthor {
                member_id: member.id,
                display_name: member.display_name.clone(),
                profile_url: row.author_profile_url.clone(),
                public_identifier: row.author_public_identifier.clone(),
                deleted: row.author_deleted,
                posts_in_period: 0,
                matching_posts: 0,
            });
            author.posts_in_period += 1;
            if matches {
                author.matching_posts += 1;
                rows.push(row);
            }
        }
    }

    let by_out_of_network = filter.min_out_of_network_impressions.is_some();
    let sort_value = |row: &ReportPost| {
        if by_out_of_network {
            row.impressions_out_of_network
        } else {
            row.impressions
        }
    };
    // Highest first; unknown numbers (None) sort last because None < Some in Rust's ordering.
    rows.sort_by(|a, b| {
        sort_value(b)
            .cmp(&sort_value(a))
            .then_with(|| b.posted_at_unix.cmp(&a.posted_at_unix))
            .then_with(|| a.post_id.cmp(&b.post_id))
    });
    let mut authors: Vec<ReportAuthor> = authors.into_values().collect();
    authors.sort_by(|a, b| {
        b.matching_posts
            .cmp(&a.matching_posts)
            .then_with(|| b.posts_in_period.cmp(&a.posts_in_period))
            .then_with(|| a.display_name.cmp(&b.display_name))
            .then_with(|| a.member_id.cmp(&b.member_id))
    });

    Ok(PostReport {
        filters: ReportFilters {
            since: filter.since(),
            until: filter.until(),
            timezone: fmt_offset(filter.offset),
            min_impressions: filter.min_impressions,
            min_out_of_network_impressions: filter.min_out_of_network_impressions,
            member_id: filter.member_id,
            contains: filter.contains.clone(),
            include_reposts: filter.include_reposts,
        },
        timezone: fmt_offset(filter.offset),
        sorted_by: if by_out_of_network { "impressionsOutOfNetwork" } else { "impressions" }
            .to_string(),
        post_count: rows.len(),
        posts: rows,
        authors,
    })
}

/// Whether a number meets a minimum. An unknown number never meets one: a post whose
/// out-of-network impressions were never read is not evidence of reaching 3,000.
fn passes(value: Option<i64>, minimum: Option<i64>) -> bool {
    match minimum {
        None => true,
        Some(minimum) => value.is_some_and(|value| value >= minimum),
    }
}

// --- members and sync health ------------------------------------------------------------------

/// One account, as the reporting API shows it. No email: this goes to an outside agent.
#[derive(Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ReportMember {
    pub member_id: i64,
    pub display_name: String,
    #[schema(required)]
    pub profile_url: Option<String>,
    #[schema(required)]
    pub public_identifier: Option<String>,
    /// A LinkedIn identity is bound to the account (the extension has signed in at least once).
    pub linked: bool,
    /// Last successful sync, `YYYY-MM-DDTHH:MM:SSZ`, or null if the extension never synced.
    #[schema(required)]
    pub last_synced_at: Option<String>,
    #[schema(required)]
    pub last_synced_at_unix: Option<i64>,
    /// Original posts on file (reshares not counted).
    pub post_count: i64,
    /// Publication time of their newest original post, or null if none.
    #[schema(required)]
    pub newest_post_at: Option<String>,
    pub created_at: String,
}

#[derive(Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct SyncSummary {
    /// The most recent sync by anyone. Hours old on a weekday means syncing has stalled.
    #[schema(required)]
    pub newest_sync_at: Option<String>,
    pub members_synced_last_24h: usize,
    pub members_synced_last_7d: usize,
    /// Accounts with a LinkedIn identity that have never synced.
    pub linked_members_never_synced: usize,
    pub total_members: usize,
}

#[derive(Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct MemberReport {
    pub members: Vec<ReportMember>,
    pub sync: SyncSummary,
}

/// Every account with when it last synced, for spotting people who post but are not syncing and
/// a stall across everyone. "Last synced" is the newest profile snapshot, which every successful
/// sync writes whether or not any post changed (see `dto::profile_readings`).
///
/// Deleted accounts are left out, from the list and from the sync summary: they can no longer
/// sync, so counting them would read as a stall.
pub async fn member_report(db: &mut Db, now: i64) -> crate::web::ApiResult<MemberReport> {
    let mut accounts = Member::all().exec(&mut *db).await?;
    accounts.retain(|member| !member.is_deleted());
    accounts.sort_by(|a, b| a.display_name.cmp(&b.display_name).then(a.id.cmp(&b.id)));
    let mut readings = profile_readings(db).await?;
    let active: std::collections::HashSet<i64> = accounts.iter().map(|member| member.id).collect();
    readings.last_synced.retain(|id, _| active.contains(id));
    // A whole-table read of `posts`, original posts only. That table is a small fraction of
    // `post_snapshots` (one row per post rather than one per reading), and one query beats one
    // per member against a remote database.
    let mut posts: HashMap<i64, (i64, Option<i64>)> = HashMap::new();
    for post in Post::filter(Post::fields().is_repost().eq(false)).exec(&mut *db).await? {
        let entry = posts.entry(post.member_id).or_insert((0, None));
        entry.0 += 1;
        // A post stored without a creation time (0) has no date to offer here.
        if post.created_at > 0 {
            entry.1 = entry.1.max(Some(post.created_at));
        }
    }

    let synced_since = |seconds: i64| {
        readings.last_synced.values().filter(|at| **at >= now - seconds).count()
    };
    let mut never_synced = 0;
    let members: Vec<ReportMember> = accounts
        .into_iter()
        .map(|member| {
            let linked = !member.linkedin_urn.starts_with("pending:");
            let last_synced = readings.last_synced.get(&member.id).copied();
            if linked && last_synced.is_none() {
                never_synced += 1;
            }
            let (post_count, newest_post) = posts.get(&member.id).copied().unwrap_or((0, None));
            ReportMember {
                member_id: member.id,
                public_identifier: Some(member.public_identifier).filter(|id| !id.is_empty()),
                profile_url: member.profile_url.filter(|url| !url.is_empty()),
                display_name: member.display_name,
                linked,
                last_synced_at: last_synced.map(fmt_iso8601),
                last_synced_at_unix: last_synced,
                post_count,
                newest_post_at: newest_post.map(fmt_iso8601),
                created_at: fmt_iso8601(member.created_at),
            }
        })
        .collect();
    Ok(MemberReport {
        sync: SyncSummary {
            newest_sync_at: readings.last_synced.values().max().copied().map(fmt_iso8601),
            members_synced_last_24h: synced_since(DAY),
            members_synced_last_7d: synced_since(7 * DAY),
            linked_members_never_synced: never_synced,
            total_members: members.len(),
        },
        members,
    })
}

/// The members list as CSV, with the same conventions as [`report_csv`].
pub fn members_csv(report: &MemberReport) -> String {
    let mut out = String::from("\u{feff}");
    out.push_str(
        "member_id,display_name,public_identifier,profile_url,linked,last_synced_at_utc,\
         post_count,newest_post_at_utc,created_at_utc\r\n",
    );
    for member in &report.members {
        let fields = [
            member.member_id.to_string(),
            csv_text(&member.display_name),
            csv_text(member.public_identifier.as_deref().unwrap_or("")),
            csv_text(member.profile_url.as_deref().unwrap_or("")),
            member.linked.to_string(),
            member.last_synced_at.clone().unwrap_or_default(),
            member.post_count.to_string(),
            member.newest_post_at.clone().unwrap_or_default(),
            member.created_at.clone(),
        ];
        let line: Vec<String> = fields.iter().map(|field| csv_field(field)).collect();
        out.push_str(&line.join(","));
        out.push_str("\r\n");
    }
    out
}

// --- access ----------------------------------------------------------------------------------

/// Who may read the reporting API: a request presenting an API key is judged by the key alone,
/// so a wrong key fails even from a browser that also holds a session. Without one, only an
/// admin's website session will do.
pub async fn require_report_access(
    db: &mut Db,
    headers: &http::HeaderMap,
) -> crate::web::ApiResult<()> {
    if crate::auth::has_bearer(headers) {
        if crate::auth::api_key_from_bearer(db, headers).await.is_none() {
            return Err(crate::web::ApiError::unauthorized("invalid or revoked API key"));
        }
    } else if crate::auth::current_system_admin(db, headers).await.is_none() {
        return Err(crate::web::ApiError::unauthorized(
            "send an API key as `Authorization: Bearer csk_...`",
        ));
    }
    Ok(())
}

// --- CSV -------------------------------------------------------------------------------------

/// Download name for a report, e.g. `posts-2026-11-06-to-2026-11-12.csv`, using the first and
/// last day of the period in the requested offset.
pub fn csv_filename(filter: &ReportFilter) -> String {
    format!("posts-{}-to-{}.csv", &filter.since()[..10], &filter.until()[..10])
}

/// The report's posts as CSV: one header row, then one row per post, CRLF line ends (RFC 4180).
/// Starts with a UTF-8 byte order mark, without which Excel reads names and post text with
/// accents or emoji as the wrong characters; Google Sheets ignores it.
pub fn report_csv(report: &PostReport) -> String {
    let mut out = String::from("\u{feff}");
    out.push_str(
        "posted_date,posted_at_utc,posted_at_local,author_name,author_member_id,author_profile_url,post_url,\
         impressions,impressions_in_network,impressions_out_of_network,reactions,comments,\
         reposts,sends,saves,is_repost,text,author_deleted\r\n",
    );
    let number = |value: Option<i64>| value.map(|value| value.to_string()).unwrap_or_default();
    for post in &report.posts {
        let fields = [
            // The day in the requested offset, so it agrees with the period asked for.
            post.posted_at_local[..10].to_string(),
            post.posted_at.clone(),
            post.posted_at_local.clone(),
            csv_text(&post.author_name),
            post.member_id.to_string(),
            csv_text(post.author_profile_url.as_deref().unwrap_or("")),
            csv_text(&post.post_url),
            number(post.impressions),
            number(post.impressions_in_network),
            number(post.impressions_out_of_network),
            number(post.reactions),
            number(post.comments),
            number(post.reposts),
            number(post.sends),
            number(post.saves),
            post.is_repost.to_string(),
            csv_text(post.text.as_deref().unwrap_or("")),
            post.author_deleted.to_string(),
        ];
        let line: Vec<String> = fields.iter().map(|field| csv_field(field)).collect();
        out.push_str(&line.join(","));
        out.push_str("\r\n");
    }
    out
}

/// Quote a field when it holds a comma, a quote or a line break, doubling any quotes inside.
pub fn csv_field(value: &str) -> String {
    if value.contains([',', '"', '\n', '\r']) {
        format!("\"{}\"", value.replace('"', "\"\""))
    } else {
        value.to_string()
    }
}

/// Text written by other people (post text, names) that a spreadsheet would run as a formula if it
/// began with `=`, `+`, `-` or `@`. A leading apostrophe makes Excel and Sheets show it as text.
fn csv_text(value: &str) -> String {
    if value.starts_with(['=', '+', '-', '@', '\t', '\r']) {
        format!("'{value}")
    } else {
        value.to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const NOW: i64 = 1_794_494_400; // 2026-11-12T14:40:00Z

    #[test]
    fn timestamps_format_as_utc_iso8601() {
        assert_eq!(fmt_iso8601(NOW), "2026-11-12T14:40:00Z");
        assert_eq!(fmt_iso8601(1_794_441_600), "2026-11-12T00:00:00Z");
    }

    #[test]
    fn dates_must_be_real_calendar_days() {
        assert_eq!(parse_report_date("2026-11-12"), Some(1_794_441_600));
        assert_eq!(parse_report_date(" 2026-11-12 "), Some(1_794_441_600));
        assert_eq!(parse_report_date("2026-02-30"), None);
        assert_eq!(parse_report_date("2026-1-5"), None);
        assert_eq!(parse_report_date("2026-11-12T00:00:00Z"), None);
        assert_eq!(parse_report_date("12/11/2026"), None);
        assert_eq!(parse_report_date(""), None);
    }

    fn resolve(since: Option<&str>, until: Option<&str>, timezone: Option<&str>) -> Result<ReportFilter, String> {
        ReportFilter::new(ReportParams { since, until, timezone, ..Default::default() }, NOW)
    }

    #[test]
    fn the_default_window_is_today_and_the_six_days_before_in_utc() {
        let filter = resolve(None, None, None).unwrap();
        assert_eq!(filter.since(), "2026-11-06T00:00:00+00:00");
        assert_eq!(filter.until(), "2026-11-12T23:59:59+00:00");
        assert_eq!(filter.start, parse_report_date("2026-11-06").unwrap());
        assert_eq!(filter.end, parse_report_date("2026-11-13").unwrap());
        assert!(!filter.include_reposts);
        // Empty strings (an empty form field) mean "use the default", not an error.
        assert_eq!(resolve(Some(""), Some(" "), Some("")).unwrap(), filter);
    }

    #[test]
    fn the_default_window_follows_the_offset() {
        // 14:40 UTC on the 12th is 07:40 on the 12th in Mountain standard time...
        let filter = resolve(None, None, Some("-07:00")).unwrap();
        assert_eq!(filter.since(), "2026-11-06T00:00:00-07:00");
        assert_eq!(filter.until(), "2026-11-12T23:59:59-07:00");
        // ...and already the 13th at +10:00.
        let filter = resolve(None, None, Some("+10:00")).unwrap();
        assert_eq!(filter.until(), "2026-11-13T23:59:59+10:00");
    }

    #[test]
    fn dates_are_whole_days_in_the_offset() {
        // Jason's week: Friday through Thursday, Mountain standard time.
        let filter = resolve(Some("2026-11-06"), Some("2026-11-12"), Some("-07:00")).unwrap();
        assert_eq!(filter.start, parse_instant("2026-11-06T07:00:00Z").unwrap());
        assert_eq!(filter.end, parse_instant("2026-11-13T07:00:00Z").unwrap());
        assert_eq!(filter.until(), "2026-11-12T23:59:59-07:00");
        let utc = resolve(Some("2026-11-06"), Some("2026-11-12"), None).unwrap();
        assert_eq!(utc.end - utc.start, 7 * DAY);
        let open_ended = resolve(Some("2026-11-01"), None, None).unwrap();
        assert_eq!(open_ended.until(), "2026-11-12T23:59:59+00:00");
        let one_day = resolve(Some("2026-11-01"), Some("2026-11-01"), Some("-07:00")).unwrap();
        assert_eq!(one_day.end - one_day.start, DAY);
    }

    #[test]
    fn timestamps_are_exact_and_both_ends_included() {
        let filter = resolve(Some("2026-11-06T00:00:00-07:00"), Some("2026-11-12T23:59:59-07:00"), None)
            .unwrap();
        assert_eq!(filter, resolve(Some("2026-11-06"), Some("2026-11-12"), Some("-07:00")).unwrap().with_offset(0));
        // A timestamp and a date can be mixed; a lone timestamp `until` anchors the default `since`.
        let filter = resolve(None, Some("2026-11-12T10:00:00Z"), None).unwrap();
        assert_eq!(filter.start, parse_report_date("2026-11-06").unwrap());
        assert_eq!(filter.end, parse_instant("2026-11-12T10:00:01Z").unwrap());
    }

    impl ReportFilter {
        fn with_offset(mut self, offset: i64) -> Self {
            self.offset = offset;
            self
        }
    }

    #[test]
    fn instants_need_an_offset_and_a_real_time() {
        assert_eq!(parse_instant("2026-11-13T00:00:00-07:00"), Some(1_794_553_200));
        assert_eq!(parse_instant("2026-11-13T07:00:00Z"), Some(1_794_553_200));
        assert_eq!(parse_instant("2026-11-13T07:00:00.250Z"), Some(1_794_553_200));
        assert_eq!(parse_instant("2026-11-13T08:00:00+01:00"), Some(1_794_553_200));
        // An unencoded `+` in a query string arrives as a space.
        assert_eq!(parse_instant("2026-11-13T08:00:00 01:00"), Some(1_794_553_200));
        assert_eq!(parse_instant("2026-11-13T00:00:00"), None);
        assert_eq!(parse_instant("2026-02-30T00:00:00Z"), None);
        assert_eq!(parse_instant("2026-11-13T24:00:00Z"), None);
        assert_eq!(parse_instant("2026-11-13T00:00:00-7"), None);
        assert_eq!(parse_instant("2026-11-13"), None);
    }

    #[test]
    fn offsets_are_fixed_and_bounded() {
        assert_eq!(parse_offset("Z"), Some(0));
        assert_eq!(parse_offset("+00:00"), Some(0));
        assert_eq!(parse_offset("-07:00"), Some(-25_200));
        assert_eq!(parse_offset("+05:30"), Some(19_800));
        assert_eq!(parse_offset("07:00"), Some(25_200));
        assert_eq!(parse_offset("America/Denver"), None);
        assert_eq!(parse_offset("MST"), None);
        assert_eq!(parse_offset("-7"), None);
        assert_eq!(parse_offset("+15:00"), None);
        assert_eq!(parse_offset("+05:60"), None);
        assert_eq!(fmt_offset(-25_200), "-07:00");
        assert_eq!(fmt_offset(0), "+00:00");
        assert_eq!(fmt_local(1_794_553_199, -25_200), "2026-11-12T23:59:59-07:00");
    }

    #[test]
    fn bad_windows_and_negative_minimums_are_refused() {
        assert!(resolve(Some("2026-11-12"), Some("2026-11-01"), None).is_err());
        assert!(resolve(Some("2026-13-01"), None, None).is_err());
        assert!(resolve(Some("2024-01-01"), Some("2026-01-01"), None).is_err());
        assert!(resolve(Some("2025-01-01"), Some("2025-12-31"), None).is_ok());
        assert!(resolve(None, None, Some("Mountain")).is_err());
        assert!(resolve(Some("2026-11-06T00:00:00"), None, None).is_err());
        let negative = |min_impressions, min_out_of_network_impressions| {
            ReportFilter::new(
                ReportParams { min_impressions, min_out_of_network_impressions, ..Default::default() },
                NOW,
            )
        };
        assert!(negative(Some(-1), None).is_err());
        assert!(negative(None, Some(-1)).is_err());
    }

    #[test]
    fn the_text_filter_is_trimmed_lowercased_and_optional() {
        let contains = |contains| {
            ReportFilter::new(ReportParams { contains, ..Default::default() }, NOW).unwrap().contains
        };
        assert_eq!(contains(Some(" Enzo ")).as_deref(), Some("enzo"));
        assert_eq!(contains(Some("  ")), None);
        assert!(post_text_contains(Some("Proud of the ENZO team"), "enzo"));
        assert!(post_text_contains(Some("see enzo.health"), "enzo"));
        assert!(!post_text_contains(Some("nothing here"), "enzo"));
        assert!(!post_text_contains(None, "enzo"));
    }

    #[test]
    fn an_unknown_number_never_meets_a_minimum() {
        assert!(passes(None, None));
        assert!(passes(Some(0), None));
        assert!(!passes(None, Some(0)));
        assert!(!passes(Some(2_999), Some(3_000)));
        assert!(passes(Some(3_000), Some(3_000)));
    }

    #[test]
    fn csv_fields_are_quoted_only_when_needed() {
        assert_eq!(csv_field("plain"), "plain");
        assert_eq!(csv_field("a, b"), "\"a, b\"");
        assert_eq!(csv_field("say \"hi\""), "\"say \"\"hi\"\"\"");
        assert_eq!(csv_field("line one\nline two"), "\"line one\nline two\"");
        assert_eq!(csv_field("windows\r\nbreak"), "\"windows\r\nbreak\"");
        assert_eq!(csv_field(""), "");
    }

    #[test]
    fn csv_text_cannot_start_a_formula() {
        assert_eq!(csv_text("=HYPERLINK(\"x\")"), "'=HYPERLINK(\"x\")");
        assert_eq!(csv_text("- a bullet"), "'- a bullet");
        assert_eq!(csv_text("@someone"), "'@someone");
        assert_eq!(csv_text("Normal text"), "Normal text");
    }
}
