//! The admin post report: everyone's posts from a period, filtered by impressions and text, with a
//! per-person summary. One query serves both the website's Reports page and the API that an
//! admin's AI agent calls with an API key (`GET /api/v1/posts`), so the two cannot disagree.
//!
//! Dates are calendar days in UTC. `since` and `until` are both included, so the default
//! "past 7 days" is today and the six days before it, and running it on the same weekday each week
//! gives back-to-back weeks that neither overlap nor leave a gap.

use std::collections::HashMap;

use serde::{Deserialize, Serialize};
use toasty::Db;
use utoipa::ToSchema;

use crate::dto::post_text_contains;
use crate::models::PostSnapshot;
use crate::scoring::Dataset;
use crate::util::{fmt_date, fmt_iso8601, parse_date};

const DAY: i64 = 86_400;
/// Days in the default window, today included.
pub const DEFAULT_DAYS: i64 = 7;
/// Longest window one request may ask for. Every snapshot of every post in the window is read to
/// find the latest one, so an unbounded window would read most of `post_snapshots`.
pub const MAX_DAYS: i64 = 366;

/// The resolved inputs of one report.
#[derive(Debug, Clone, PartialEq)]
pub struct ReportFilter {
    /// First day included, `YYYY-MM-DD`.
    pub since: String,
    /// Last day included, `YYYY-MM-DD`.
    pub until: String,
    /// `since` at 00:00 UTC, unix seconds.
    pub start: i64,
    /// The day after `until` at 00:00 UTC, unix seconds. Exclusive.
    pub end: i64,
    pub min_impressions: Option<i64>,
    pub min_out_of_network_impressions: Option<i64>,
    pub member_id: Option<i64>,
    /// Lowercased text to look for in the post, or None for any post.
    pub contains: Option<String>,
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

impl ReportFilter {
    /// Resolve the request's dates against `now`. A missing `until` is today (UTC); a missing
    /// `since` is six days before `until`, so the default is seven calendar days.
    pub fn new(
        since: Option<&str>,
        until: Option<&str>,
        min_impressions: Option<i64>,
        min_out_of_network_impressions: Option<i64>,
        member_id: Option<i64>,
        contains: Option<&str>,
        now: i64,
    ) -> Result<Self, String> {
        let until_day = match present(until) {
            Some(value) => parse_report_date(value)
                .ok_or_else(|| format!("until must be a date like 2026-11-12, got {value:?}"))?,
            None => now.div_euclid(DAY) * DAY,
        };
        let since_day = match present(since) {
            Some(value) => parse_report_date(value)
                .ok_or_else(|| format!("since must be a date like 2026-11-06, got {value:?}"))?,
            None => until_day - (DEFAULT_DAYS - 1) * DAY,
        };
        if since_day > until_day {
            return Err("since must be on or before until".to_string());
        }
        if (until_day - since_day) / DAY + 1 > MAX_DAYS {
            return Err(format!("the period can be at most {MAX_DAYS} days"));
        }
        for (name, value) in [
            ("minImpressions", min_impressions),
            ("minOutOfNetworkImpressions", min_out_of_network_impressions),
        ] {
            if value.is_some_and(|value| value < 0) {
                return Err(format!("{name} cannot be negative"));
            }
        }
        Ok(Self {
            since: fmt_date(since_day),
            until: fmt_date(until_day),
            start: since_day,
            end: until_day + DAY,
            min_impressions,
            min_out_of_network_impressions,
            member_id,
            contains: present(contains).map(str::to_lowercase),
        })
    }
}

#[derive(Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ReportFilters {
    /// First day included (UTC), `YYYY-MM-DD`.
    pub since: String,
    /// Last day included (UTC), `YYYY-MM-DD`.
    pub until: String,
    #[schema(required)]
    pub min_impressions: Option<i64>,
    #[schema(required)]
    pub min_out_of_network_impressions: Option<i64>,
    #[schema(required)]
    pub member_id: Option<i64>,
    /// Text the posts were searched for (lowercased), or null.
    #[schema(required)]
    pub contains: Option<String>,
}

/// One post in the report. Numbers come from the post's latest snapshot; null means LinkedIn's
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
    /// Link to the post on LinkedIn.
    pub post_url: String,
    /// When the post was published, `YYYY-MM-DDTHH:MM:SSZ` (UTC).
    pub posted_at: String,
    /// The same moment as unix seconds.
    pub posted_at_unix: i64,
    /// The post's full text as stored (LinkedIn posts are at most 3,000 characters; the server
    /// keeps up to 10,000), or null when the extension could not read it.
    #[schema(required)]
    pub text: Option<String>,
    /// True when this is the member resharing someone else's post. Reposts are listed and
    /// counted like the challenge's own scoring does, and flagged so they can be told apart.
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
    /// When the numbers were read (`YYYY-MM-DDTHH:MM:SSZ`), or null if they never were.
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
    /// Every post they published in the period, whatever its numbers.
    pub posts_in_period: i64,
    /// How many of those passed the filters (equal to `postsInPeriod` with none).
    pub matching_posts: i64,
}

#[derive(Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct PostReport {
    pub filters: ReportFilters,
    /// Always "UTC": the days in `since` and `until` are UTC calendar days.
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
            let Some(posted_at) = data.posted_at(post) else { continue };
            // The latest reading, as the post pages show it (`dto::post_stats`).
            let latest = data.snapshots(post.id).last();
            let pick = |field: fn(&PostSnapshot) -> Option<i64>| latest.and_then(field);
            let row = ReportPost {
                post_id: post.id,
                member_id: member.id,
                author_name: member.display_name.clone(),
                author_profile_url: member.profile_url.clone().filter(|url| !url.is_empty()),
                author_public_identifier: Some(member.public_identifier.clone())
                    .filter(|id| !id.is_empty()),
                post_url: post.permalink.clone(),
                posted_at: fmt_iso8601(posted_at),
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
            since: filter.since.clone(),
            until: filter.until.clone(),
            min_impressions: filter.min_impressions,
            min_out_of_network_impressions: filter.min_out_of_network_impressions,
            member_id: filter.member_id,
            contains: filter.contains.clone(),
        },
        timezone: "UTC".to_string(),
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

// --- CSV -------------------------------------------------------------------------------------

/// Download name for a report, e.g. `posts-2026-11-06-to-2026-11-12.csv`.
pub fn csv_filename(filter: &ReportFilter) -> String {
    format!("posts-{}-to-{}.csv", filter.since, filter.until)
}

/// The report's posts as CSV: one header row, then one row per post, CRLF line ends (RFC 4180).
/// Starts with a UTF-8 byte order mark, without which Excel reads names and post text with
/// accents or emoji as the wrong characters; Google Sheets ignores it.
pub fn report_csv(report: &PostReport) -> String {
    let mut out = String::from("\u{feff}");
    out.push_str(
        "posted_date,posted_at_utc,author_name,author_member_id,author_profile_url,post_url,\
         impressions,impressions_in_network,impressions_out_of_network,reactions,comments,\
         reposts,sends,saves,is_repost,text\r\n",
    );
    let number = |value: Option<i64>| value.map(|value| value.to_string()).unwrap_or_default();
    for post in &report.posts {
        let fields = [
            post.posted_at[..10].to_string(),
            post.posted_at.clone(),
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

    #[test]
    fn the_default_window_is_today_and_the_six_days_before_in_utc() {
        let filter = ReportFilter::new(None, None, None, None, None, None, NOW).unwrap();
        assert_eq!(filter.since, "2026-11-06");
        assert_eq!(filter.until, "2026-11-12");
        assert_eq!(filter.start, parse_report_date("2026-11-06").unwrap());
        assert_eq!(filter.end, parse_report_date("2026-11-13").unwrap());
        // Empty strings (an empty form field) mean "use the default", not an error.
        assert_eq!(ReportFilter::new(Some(""), Some(" "), None, None, None, None, NOW).unwrap(), filter);
    }

    #[test]
    fn one_given_date_anchors_the_other() {
        let filter = ReportFilter::new(None, Some("2026-10-31"), None, None, None, None, NOW).unwrap();
        assert_eq!((filter.since.as_str(), filter.until.as_str()), ("2026-10-25", "2026-10-31"));
        let filter = ReportFilter::new(Some("2026-11-01"), None, None, None, None, None, NOW).unwrap();
        assert_eq!((filter.since.as_str(), filter.until.as_str()), ("2026-11-01", "2026-11-12"));
        let single = ReportFilter::new(Some("2026-11-01"), Some("2026-11-01"), None, None, None, None, NOW)
            .unwrap();
        assert_eq!(single.end - single.start, DAY);
    }

    #[test]
    fn bad_windows_and_negative_minimums_are_refused() {
        assert!(ReportFilter::new(Some("2026-11-12"), Some("2026-11-01"), None, None, None, None, NOW).is_err());
        assert!(ReportFilter::new(Some("2026-13-01"), None, None, None, None, None, NOW).is_err());
        assert!(ReportFilter::new(Some("2024-01-01"), Some("2026-01-01"), None, None, None, None, NOW).is_err());
        assert!(ReportFilter::new(Some("2025-01-01"), Some("2025-12-31"), None, None, None, None, NOW).is_ok());
        assert!(ReportFilter::new(None, None, Some(-1), None, None, None, NOW).is_err());
        assert!(ReportFilter::new(None, None, None, Some(-1), None, None, NOW).is_err());
    }

    #[test]
    fn the_text_filter_is_trimmed_lowercased_and_optional() {
        let filter = ReportFilter::new(None, None, None, None, None, Some(" Enzo "), NOW).unwrap();
        assert_eq!(filter.contains.as_deref(), Some("enzo"));
        assert_eq!(ReportFilter::new(None, None, None, None, None, Some("  "), NOW).unwrap().contains, None);
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
