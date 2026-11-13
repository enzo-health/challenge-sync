//! The company stats overview: how many original posts went up, how many people posted, and how
//! many impressions the company's posts gained, over the past 7, 30 or 90 days, each next to the
//! period of the same length before it, plus one person's share of the same numbers. One function
//! serves the website's landing page (`GET /api/stats/overview`, the viewer is "you") and the
//! reporting API (`GET /api/v1/stats`, "you" is an optional `memberId`), so the two cannot disagree.
//!
//! It is built on the post report's pieces rather than beside them: the period is resolved by
//! [`ReportFilter`] (same `timezone` offset, same "end of today"), posts are loaded by
//! [`Dataset::load_posted_between`], reshares are left out as the report leaves them out, and
//! deleted authors' posts still count, as they do in the report.
//!
//! **Impressions gained.** A post's number on LinkedIn is a running total, so "impressions in the
//! past week" means how much those totals grew during the week, whichever week the post went up
//! in. For each post: the last known value read before the period ended, minus the last known
//! value read before it started (0 when nothing was known yet), and never below 0. Readings are
//! stored only when a number changes, so "last known before T" is the primitive, not "the reading
//! on day T". The same rule gives out-of-network impressions and engagement (reactions plus
//! comments, each counted on its own). For the charts, each post's gain is credited to the time of
//! the reading that showed it (see [`gains_by_reading`]), so the bars add up to the headline.

use std::collections::{HashMap, HashSet};

use serde::{Deserialize, Serialize};
use toasty::Db;
use utoipa::ToSchema;

use crate::dto::profile_readings;
use crate::models::{Member, PostSnapshot};
use crate::reports::{ReportFilter, ReportParams, fmt_local, fmt_offset};
use crate::scoring::Dataset;
use crate::util::fmt_iso8601;
use crate::web::{ApiError, ApiResult};

const DAY: i64 = 86_400;
/// The periods the page offers. Anything else is refused rather than guessed at.
pub const PERIOD_DAYS: [i64; 3] = [7, 30, 90];
pub const DEFAULT_PERIOD_DAYS: i64 = 7;
/// Periods longer than this are charted by week, so 90 bars do not turn into a smear.
const DAILY_UP_TO_DAYS: i64 = 31;
/// The extension stops re-reading a post this many days after it was published
/// (`REFRESH_WINDOW_DAYS` in `extension/config.js`). We rely on that: a post published more than
/// this long before a period began cannot gain anything during it, so neither it nor its readings
/// are loaded. It also keeps a new member's first sync, which may read an old post for the first
/// time, from counting that post's whole lifetime as gained this week.
pub const REFRESH_WINDOW_DAYS: i64 = 45;
/// The newest sync across the company older than this means the numbers have stopped moving.
pub const STALE_AFTER: i64 = 2 * DAY;
/// Rows in each of the two "top" lists.
const TOP_ROWS: usize = 10;
/// What a deleted account is called in the lists. Their posts still count in the totals, so past
/// numbers do not change when someone leaves, but they are no longer named.
pub const FORMER_MEMBER: &str = "Former member";

/// The resolved period: whole days in a fixed UTC offset, ending with today.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct StatsPeriod {
    /// First instant included, unix seconds (local midnight).
    pub start: i64,
    /// One second after the last instant included (the end of today, local). Exclusive.
    pub end: i64,
    /// Seconds east of UTC.
    pub offset: i64,
    pub days: i64,
    /// 1 for daily buckets, 7 for weekly.
    pub bucket_days: i64,
}

impl StatsPeriod {
    /// The past `days` days in `timezone`, today included. The offset and "the end of today" come
    /// from the post report's own resolver, so both pages agree on what a day is.
    pub fn new(days: Option<i64>, timezone: Option<&str>, now: i64) -> Result<Self, String> {
        let days = days.unwrap_or(DEFAULT_PERIOD_DAYS);
        if !PERIOD_DAYS.contains(&days) {
            return Err(format!("days must be 7, 30 or 90, got {days}"));
        }
        let today = ReportFilter::new(ReportParams { timezone, ..Default::default() }, now)?;
        Ok(Self {
            start: today.end - days * DAY,
            end: today.end,
            offset: today.offset,
            days,
            bucket_days: if days > DAILY_UP_TO_DAYS { 7 } else { 1 },
        })
    }

    /// Start of the period of the same length just before this one.
    pub fn previous_start(&self) -> i64 {
        self.start - (self.end - self.start)
    }

    pub fn bucket_count(&self) -> usize {
        ((self.days + self.bucket_days - 1) / self.bucket_days) as usize
    }

    /// The bucket an instant falls in, or None outside the period. Buckets start at the period's
    /// first local midnight, so a daily bucket is exactly one local day. Weeks run from the first
    /// day of the period; the last one is short when the period is not a whole number of weeks.
    pub fn bucket_of(&self, at: i64) -> Option<usize> {
        (at >= self.start && at < self.end)
            .then(|| ((at - self.start) / (self.bucket_days * DAY)) as usize)
    }

    /// `[start, end)` of one bucket.
    pub fn bucket_bounds(&self, index: usize) -> (i64, i64) {
        let start = self.start + index as i64 * self.bucket_days * DAY;
        (start, (start + self.bucket_days * DAY).min(self.end))
    }
}

/// Spread one post's gain over the readings that showed it.
///
/// `base` is the last known value before the period (0 when none); `readings` are the
/// `(captured_at, value)` pairs read during the period, oldest first, skipping readings that
/// missed this number. The total credited is `max(0, last − base)` — the headline definition —
/// and each reading is credited with how far it raised the running high, capped at that total, so
/// every share is non-negative and the shares add up to the total exactly. When a number only ever
/// grows (as impressions do) each reading is simply credited with its own increase.
pub fn gains_by_reading(base: i64, readings: &[(i64, i64)]) -> Vec<(i64, i64)> {
    let Some(&(_, last)) = readings.last() else { return Vec::new() };
    let total = (last - base).max(0);
    let mut credited = 0;
    let mut out = Vec::new();
    for &(at, value) in readings {
        let level = (value - base).clamp(credited, total);
        if level > credited {
            out.push((at, level - credited));
            credited = level;
        }
    }
    out
}

/// One number's gains for one post over `[from, to)`, as [`gains_by_reading`] credits them.
fn post_gains(
    data: &Dataset,
    post_id: i64,
    from: i64,
    to: i64,
    field: fn(&PostSnapshot) -> Option<i64>,
) -> Vec<(i64, i64)> {
    let base = data.latest_known_before(post_id, from, field).unwrap_or(0);
    let readings: Vec<(i64, i64)> = data
        .snapshots(post_id)
        .iter()
        .filter(|s| s.captured_at >= from && s.captured_at < to)
        .filter_map(|s| field(s).map(|value| (s.captured_at, value)))
        .collect();
    gains_by_reading(base, &readings)
}

/// `(current − previous) / previous`, or None when there is nothing to compare against.
pub fn change(current: i64, previous: i64) -> Option<f64> {
    (previous > 0).then(|| (current - previous) as f64 / previous as f64)
}

/// `part / whole`, or None when the whole is 0.
pub fn share(part: i64, whole: i64) -> Option<f64> {
    (whole > 0).then(|| part as f64 / whole as f64)
}

/// The first non-blank line of a post, shortened for a list row.
fn first_line(text: Option<&str>) -> Option<String> {
    let line = text?.lines().map(str::trim).find(|line| !line.is_empty())?;
    const MAX: usize = 140;
    if line.chars().count() <= MAX {
        return Some(line.to_string());
    }
    let cut: String = line.chars().take(MAX - 1).collect();
    Some(format!("{}…", cut.trim_end()))
}

// --- response ---------------------------------------------------------------------------------

/// One headline number for the period, next to the period of the same length before it.
#[derive(Serialize, Deserialize, ToSchema, Debug, Clone, Copy, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct StatsMetric {
    pub value: i64,
    /// The same number for the previous period of the same length.
    pub previous: i64,
    /// `(value − previous) / previous`, e.g. 0.12 for +12%. Null when `previous` is 0, since
    /// there is nothing to compare against.
    #[schema(required)]
    pub change: Option<f64>,
}

impl StatsMetric {
    fn new(value: i64, previous: i64) -> Self {
        Self { value, previous, change: change(value, previous) }
    }
}

#[derive(Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct StatsPeriodInfo {
    /// 7, 30 or 90.
    pub days: i64,
    /// "day" for 7 and 30 days, "week" for 90.
    pub bucket: String,
    /// First instant included, e.g. `2026-11-06T00:00:00-07:00`.
    pub since: String,
    /// Last instant included, e.g. `2026-11-12T23:59:59-07:00`.
    pub until: String,
    /// The UTC offset the days are in, e.g. `-07:00`.
    pub timezone: String,
    pub start_unix: i64,
    /// Exclusive.
    pub end_unix: i64,
    /// Start of the previous period used for the comparisons (it ends at `startUnix`).
    pub previous_start_unix: i64,
}

#[derive(Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct StatsCompany {
    /// Original posts published in the period (reshares excluded).
    pub posts: StatsMetric,
    /// Distinct authors of those posts.
    pub people: StatsMetric,
    /// Accounts that are not deleted, the "out of" for `people`.
    pub active_members: i64,
    /// Impressions gained during the period across all original posts, whenever published.
    pub impressions: StatsMetric,
    /// Out-of-network impressions gained, same definition.
    pub out_of_network_impressions: StatsMetric,
    /// Reactions gained plus comments gained, same definition.
    pub engagement: StatsMetric,
}

/// One person's part of the company numbers, with the same definitions.
#[derive(Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct StatsYou {
    pub member_id: i64,
    pub display_name: String,
    /// They published at least one original post in the period.
    pub posted: bool,
    /// The extension has synced for them at least once.
    pub has_synced: bool,
    pub posts: StatsMetric,
    pub impressions: StatsMetric,
    pub out_of_network_impressions: StatsMetric,
    pub engagement: StatsMetric,
    /// Their part of the company's number this period, 0 to 1; null when the company's is 0.
    #[schema(required)]
    pub share_of_posts: Option<f64>,
    #[schema(required)]
    pub share_of_impressions: Option<f64>,
    #[schema(required)]
    pub share_of_out_of_network_impressions: Option<f64>,
    #[schema(required)]
    pub share_of_engagement: Option<f64>,
    /// Their place among everyone who posted, ordered as `topPosters`; null if they did not post.
    #[schema(required)]
    pub rank: Option<i64>,
    /// How many people posted (what `rank` is out of).
    pub poster_count: i64,
}

/// Counts for one bucket of the series.
#[derive(Serialize, Deserialize, ToSchema, Debug, Default, Clone, Copy, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct StatsCounts {
    /// Original posts published in the bucket.
    pub posts: i64,
    /// Impressions gained, counted on the day of the reading that showed them.
    pub impressions: i64,
    pub out_of_network_impressions: i64,
    pub engagement: i64,
}

impl StatsCounts {
    fn add(&mut self, other: &StatsCounts) {
        self.posts += other.posts;
        self.impressions += other.impressions;
        self.out_of_network_impressions += other.out_of_network_impressions;
        self.engagement += other.engagement;
    }
}

#[derive(Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct StatsBucket {
    /// First instant of the bucket in the period's offset, e.g. `2026-11-06T00:00:00-07:00`.
    pub start: String,
    pub start_unix: i64,
    /// Days the bucket covers: 1, or 7 (the last week of 90 days covers 6).
    pub days: i64,
    pub company: StatsCounts,
    /// The `you` member's part of `company`; null when there is no `you`.
    #[schema(required)]
    pub you: Option<StatsCounts>,
}

#[derive(Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct StatsTopPoster {
    pub rank: i64,
    /// Null for a deleted account.
    #[schema(required)]
    pub member_id: Option<i64>,
    /// "Former member" for a deleted account.
    pub display_name: String,
    pub former_member: bool,
    /// This row is the `you` member.
    pub is_you: bool,
    pub posts: i64,
    /// Impressions their posts gained in the period (all their eligible posts, not only new ones).
    pub impressions_gained: i64,
}

#[derive(Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct StatsTopPost {
    pub post_id: i64,
    /// Null for a deleted account.
    #[schema(required)]
    pub member_id: Option<i64>,
    /// "Former member" for a deleted account.
    pub author_name: String,
    pub former_member: bool,
    pub is_you: bool,
    /// Link to the post on LinkedIn.
    pub post_url: String,
    /// The first line of the post, shortened; null when the text was not read.
    #[schema(required)]
    pub first_line: Option<String>,
    /// `YYYY-MM-DDTHH:MM:SSZ` (UTC).
    pub posted_at: String,
    pub posted_at_unix: i64,
    /// Impressions this post gained during the period.
    pub impressions_gained: i64,
    /// Its latest known total, or null if never read.
    #[schema(required)]
    pub impressions: Option<i64>,
}

#[derive(Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct StatsSync {
    /// The most recent sync by anyone with an account, or null if nobody ever synced.
    #[schema(required)]
    pub last_sync_at: Option<String>,
    #[schema(required)]
    pub last_sync_at_unix: Option<i64>,
    /// True when that is more than two days ago (or never): the numbers have stopped moving.
    pub stale: bool,
}

#[derive(Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct StatsOverview {
    pub period: StatsPeriodInfo,
    pub company: StatsCompany,
    /// The viewer (website) or `memberId` (API) — null when there is neither.
    #[schema(required)]
    pub you: Option<StatsYou>,
    /// One entry per day (7 and 30 days) or per week (90 days), oldest first. Each column of
    /// `company` adds up to the headline number for the period; `you` likewise.
    pub series: Vec<StatsBucket>,
    /// Who posted most in the period, up to 10, most posts first (then most impressions gained).
    pub top_posters: Vec<StatsTopPoster>,
    /// The posts that gained the most impressions in the period, up to 10.
    pub top_posts: Vec<StatsTopPost>,
    pub sync: StatsSync,
}

// --- computing ---------------------------------------------------------------------------------

#[derive(Default, Clone, Copy)]
struct Tally {
    current: StatsCounts,
    previous: StatsCounts,
}

/// Build the overview for `period`, with `you` as the member whose share to show.
///
/// Queries: the posts that could have gained anything in this period or the previous one and
/// only their snapshots (via [`Dataset::load_posted_between`], from the previous period's start
/// minus the refresh window), the accounts table, and the profile readings for the last sync.
pub async fn stats_overview(
    db: &mut Db,
    period: &StatsPeriod,
    you: Option<i64>,
    now: i64,
) -> ApiResult<StatsOverview> {
    let previous_start = period.previous_start();
    let load_from = previous_start - REFRESH_WINDOW_DAYS * DAY;
    let data = Dataset::load_posted_between(db, load_from, period.end, None).await?;

    let accounts: HashMap<i64, Member> =
        Member::all().exec(&mut *db).await?.into_iter().map(|m| (m.id, m)).collect();
    let you_member = match you {
        Some(id) => Some(accounts.get(&id).ok_or_else(|| ApiError::not_found("member not found"))?),
        None => None,
    };
    let active_members = accounts.values().filter(|m| !m.is_deleted()).count() as i64;

    let buckets = period.bucket_count();
    let mut company = Tally::default();
    let mut mine = Tally::default();
    let mut series = vec![(StatsCounts::default(), StatsCounts::default()); buckets];
    let mut posters: HashSet<i64> = HashSet::new();
    let mut previous_posters: HashSet<i64> = HashSet::new();
    // member -> (posts this period, impressions gained this period)
    let mut by_member: HashMap<i64, (i64, i64)> = HashMap::new();
    // (post, impressions gained this period)
    let mut post_gains_now: Vec<(&crate::models::Post, i64, i64)> = Vec::new();

    let numbers: [(fn(&PostSnapshot) -> Option<i64>, fn(&mut StatsCounts) -> &mut i64); 4] = [
        (|s| s.impressions, |c| &mut c.impressions),
        (|s| s.impressions_out_of_network, |c| &mut c.out_of_network_impressions),
        // Engagement is reactions plus comments, each gained on its own, so a dip in one cannot
        // cancel growth in the other.
        (|s| s.reactions, |c| &mut c.engagement),
        (|s| s.comments, |c| &mut c.engagement),
    ];

    for (member_id, posts) in &data.posts_by_member {
        let is_you = you == Some(*member_id);
        for post in posts {
            // Original posts only, as in the post report.
            if post.is_repost {
                continue;
            }
            let Some(posted_at) = data.posted_at(post) else { continue };

            // The previous period: only its headline numbers are needed.
            let mut previous = StatsCounts::default();
            if posted_at >= previous_start && posted_at < period.start {
                previous.posts = 1;
                previous_posters.insert(*member_id);
            }
            if posted_at >= previous_start - REFRESH_WINDOW_DAYS * DAY && posted_at < period.start {
                for (field, slot) in numbers {
                    let gained: i64 = post_gains(&data, post.id, previous_start, period.start, field)
                        .iter()
                        .map(|(_, gain)| gain)
                        .sum();
                    *slot(&mut previous) += gained;
                }
            }

            // This period, bucket by bucket.
            let mut current = StatsCounts::default();
            if let Some(bucket) = period.bucket_of(posted_at) {
                current.posts = 1;
                series[bucket].0.posts += 1;
                if is_you {
                    series[bucket].1.posts += 1;
                }
                posters.insert(*member_id);
            }
            if posted_at >= period.start - REFRESH_WINDOW_DAYS * DAY {
                for (field, slot) in numbers {
                    for (at, gain) in post_gains(&data, post.id, period.start, period.end, field) {
                        *slot(&mut current) += gain;
                        if let Some(bucket) = period.bucket_of(at) {
                            *slot(&mut series[bucket].0) += gain;
                            if is_you {
                                *slot(&mut series[bucket].1) += gain;
                            }
                        }
                    }
                }
            }

            company.current.add(&current);
            company.previous.add(&previous);
            if is_you {
                mine.current.add(&current);
                mine.previous.add(&previous);
            }
            if current.posts > 0 || current.impressions > 0 {
                let entry = by_member.entry(*member_id).or_default();
                entry.0 += current.posts;
                entry.1 += current.impressions;
            }
            if current.impressions > 0 {
                post_gains_now.push((post, posted_at, current.impressions));
            }
        }
    }

    // A deleted account keeps its numbers but loses its name; `data.members` holds every author.
    let author = |member_id: i64| -> (Option<i64>, String, bool) {
        match data.members.get(&member_id).or_else(|| accounts.get(&member_id)) {
            Some(member) if !member.is_deleted() => (Some(member_id), member.display_name.clone(), false),
            _ => (None, FORMER_MEMBER.to_string(), true),
        }
    };

    // Everyone who posted, ranked; the list shows the top and `you.rank` comes from the whole.
    let mut ranked: Vec<(i64, i64, i64, String)> = by_member
        .iter()
        .filter(|(_, (posts, _))| *posts > 0)
        .map(|(id, (posts, impressions))| (*id, *posts, *impressions, author(*id).1))
        .collect();
    ranked.sort_by(|a, b| {
        b.1.cmp(&a.1).then(b.2.cmp(&a.2)).then_with(|| a.3.cmp(&b.3)).then(a.0.cmp(&b.0))
    });
    let you_rank = you.and_then(|id| ranked.iter().position(|row| row.0 == id)).map(|i| i as i64 + 1);
    let top_posters = ranked
        .iter()
        .take(TOP_ROWS)
        .enumerate()
        .map(|(index, (id, posts, impressions, _))| {
            let (member_id, display_name, former_member) = author(*id);
            StatsTopPoster {
                rank: index as i64 + 1,
                member_id,
                display_name,
                former_member,
                is_you: you == Some(*id),
                posts: *posts,
                impressions_gained: *impressions,
            }
        })
        .collect();

    post_gains_now.sort_by(|a, b| b.2.cmp(&a.2).then(b.1.cmp(&a.1)).then(a.0.id.cmp(&b.0.id)));
    let top_posts = post_gains_now
        .iter()
        .take(TOP_ROWS)
        .map(|(post, posted_at, gained)| {
            let (member_id, author_name, former_member) = author(post.member_id);
            StatsTopPost {
                post_id: post.id,
                member_id,
                author_name,
                former_member,
                is_you: you == Some(post.member_id),
                post_url: post.permalink.clone(),
                first_line: first_line(post.text_preview.as_deref()),
                posted_at: fmt_iso8601(*posted_at),
                posted_at_unix: *posted_at,
                impressions_gained: *gained,
                impressions: data.latest_known(post.id, |s| s.impressions),
            }
        })
        .collect();

    // "Last synced" is the newest profile reading, which every successful sync writes (the same
    // reading the members report uses). Deleted accounts cannot sync, so they are left out.
    let readings = profile_readings(db).await?;
    let last_sync = readings
        .last_synced
        .iter()
        .filter(|(id, _)| accounts.get(id).is_some_and(|m| !m.is_deleted()))
        .map(|(_, at)| *at)
        .max();

    let metric = |pick: fn(&StatsCounts) -> i64, tally: &Tally| {
        StatsMetric::new(pick(&tally.current), pick(&tally.previous))
    };
    let you = you_member.map(|member| StatsYou {
        member_id: member.id,
        display_name: member.display_name.clone(),
        posted: mine.current.posts > 0,
        has_synced: readings.last_synced.contains_key(&member.id),
        posts: metric(|c| c.posts, &mine),
        impressions: metric(|c| c.impressions, &mine),
        out_of_network_impressions: metric(|c| c.out_of_network_impressions, &mine),
        engagement: metric(|c| c.engagement, &mine),
        share_of_posts: share(mine.current.posts, company.current.posts),
        share_of_impressions: share(mine.current.impressions, company.current.impressions),
        share_of_out_of_network_impressions: share(
            mine.current.out_of_network_impressions,
            company.current.out_of_network_impressions,
        ),
        share_of_engagement: share(mine.current.engagement, company.current.engagement),
        rank: you_rank,
        poster_count: ranked.len() as i64,
    });

    Ok(StatsOverview {
        period: StatsPeriodInfo {
            days: period.days,
            bucket: if period.bucket_days == 1 { "day" } else { "week" }.to_string(),
            since: fmt_local(period.start, period.offset),
            until: fmt_local(period.end - 1, period.offset),
            timezone: fmt_offset(period.offset),
            start_unix: period.start,
            end_unix: period.end,
            previous_start_unix: previous_start,
        },
        company: StatsCompany {
            posts: metric(|c| c.posts, &company),
            people: StatsMetric::new(posters.len() as i64, previous_posters.len() as i64),
            active_members,
            impressions: metric(|c| c.impressions, &company),
            out_of_network_impressions: metric(|c| c.out_of_network_impressions, &company),
            engagement: metric(|c| c.engagement, &company),
        },
        series: series
            .into_iter()
            .enumerate()
            .map(|(index, (company_counts, you_counts))| {
                let (start, end) = period.bucket_bounds(index);
                StatsBucket {
                    start: fmt_local(start, period.offset),
                    start_unix: start,
                    days: (end - start) / DAY,
                    company: company_counts,
                    you: you.as_ref().map(|_| you_counts),
                }
            })
            .collect(),
        you,
        top_posters,
        top_posts,
        sync: StatsSync {
            last_sync_at: last_sync.map(fmt_iso8601),
            last_sync_at_unix: last_sync,
            stale: last_sync.is_none_or(|at| now - at > STALE_AFTER),
        },
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    const NOW: i64 = 1_794_494_400; // 2026-11-12T14:40:00Z

    #[test]
    fn a_gain_is_last_known_minus_the_baseline_and_never_negative() {
        // Readings only ever grow: each is credited with its own increase.
        assert_eq!(gains_by_reading(100, &[(1, 150), (2, 180)]), vec![(1, 50), (2, 30)]);
        // First read during the period: counted from 0.
        assert_eq!(gains_by_reading(0, &[(5, 40)]), vec![(5, 40)]);
        // Nothing read during the period: nothing gained.
        assert!(gains_by_reading(100, &[]).is_empty());
        // A lower number than before the period: 0, not negative.
        assert!(gains_by_reading(100, &[(1, 90)]).is_empty());
        // A dip and a recovery is not counted twice; the total is last − base.
        let gains = gains_by_reading(100, &[(1, 150), (2, 120), (3, 160)]);
        assert_eq!(gains, vec![(1, 50), (3, 10)]);
        assert_eq!(gains.iter().map(|g| g.1).sum::<i64>(), 60);
        // Ending lower than a high in the middle: the shares are capped at the total, last − base.
        let gains = gains_by_reading(100, &[(1, 200), (2, 130)]);
        assert_eq!(gains.iter().map(|g| g.1).sum::<i64>(), 30);
        assert!(gains.iter().all(|g| g.1 > 0));
    }

    #[test]
    fn shares_always_add_up_to_the_headline_definition() {
        let cases: [(i64, &[(i64, i64)]); 5] = [
            (0, &[(1, 10), (2, 5), (3, 30), (4, 20)]),
            (50, &[(1, 10), (2, 70), (3, 60)]),
            (50, &[(1, 40)]),
            (7, &[(1, 7), (2, 7)]),
            (0, &[(1, 3), (2, 9), (3, 1), (4, 12), (5, 11)]),
        ];
        for (base, readings) in cases {
            let gains = gains_by_reading(base, readings);
            let expected = (readings.last().unwrap().1 - base).max(0);
            assert_eq!(gains.iter().map(|g| g.1).sum::<i64>(), expected, "{base} {readings:?}");
            assert!(gains.iter().all(|g| g.1 > 0));
        }
    }

    #[test]
    fn last_known_before_skips_missing_numbers_and_later_readings() {
        let snap = |captured_at: i64, impressions: Option<i64>| PostSnapshot {
            id: captured_at, post_id: 7, post: Default::default(), captured_at, impressions,
            reactions: None, comments: None, reposts: None, sends: None, saves: None,
            impressions_in_network: None, impressions_out_of_network: None, members_reached: None,
            profile_viewers_from_post: None, followers_from_post: None,
        };
        let mut data = Dataset::default();
        data.snapshots_by_post.insert(7, vec![snap(10, Some(5)), snap(20, None), snap(30, Some(9))]);
        let pick = |s: &PostSnapshot| s.impressions;
        assert_eq!(data.latest_known_before(7, 10, pick), None);
        assert_eq!(data.latest_known_before(7, 11, pick), Some(5));
        // The reading at 20 missed the number, so the one before it stands.
        assert_eq!(data.latest_known_before(7, 25, pick), Some(5));
        assert_eq!(data.latest_known_before(7, 31, pick), Some(9));
        // A post with a reading only inside the window gains its whole number.
        assert_eq!(post_gains(&data, 7, 25, 40, pick), vec![(30, 4)]);
        assert_eq!(post_gains(&data, 7, 0, 40, pick), vec![(10, 5), (30, 4)]);
    }

    #[test]
    fn periods_are_whole_local_days_ending_today() {
        let week = StatsPeriod::new(None, Some("-07:00"), NOW).unwrap();
        assert_eq!(fmt_local(week.start, week.offset), "2026-11-06T00:00:00-07:00");
        assert_eq!(fmt_local(week.end - 1, week.offset), "2026-11-12T23:59:59-07:00");
        assert_eq!(week.bucket_count(), 7);
        assert_eq!(week.previous_start(), week.start - 7 * DAY);
        let month = StatsPeriod::new(Some(30), None, NOW).unwrap();
        assert_eq!((month.bucket_days, month.bucket_count()), (1, 30));
        assert!(StatsPeriod::new(Some(14), None, NOW).is_err());
        assert!(StatsPeriod::new(None, Some("Mountain"), NOW).is_err());
    }

    #[test]
    fn ninety_days_are_charted_by_week_with_a_short_last_week() {
        let period = StatsPeriod::new(Some(90), Some("+00:00"), NOW).unwrap();
        assert_eq!((period.bucket_days, period.bucket_count()), (7, 13));
        assert_eq!(period.bucket_bounds(0), (period.start, period.start + 7 * DAY));
        let (last_start, last_end) = period.bucket_bounds(12);
        assert_eq!((last_end - last_start) / DAY, 6);
        assert_eq!(last_end, period.end);
        assert_eq!(period.bucket_of(period.start), Some(0));
        assert_eq!(period.bucket_of(period.end - 1), Some(12));
        assert_eq!(period.bucket_of(period.end), None);
        assert_eq!(period.bucket_of(period.start - 1), None);
    }

    #[test]
    fn a_late_evening_post_lands_on_its_local_day() {
        // 2026-11-11T22:30:00-07:00 is 05:30 UTC on the 12th.
        let at = crate::reports::parse_instant("2026-11-11T22:30:00-07:00").unwrap();
        let mountain = StatsPeriod::new(None, Some("-07:00"), NOW).unwrap();
        let utc = StatsPeriod::new(None, None, NOW).unwrap();
        assert_eq!(mountain.bucket_of(at), Some(5)); // the 11th
        assert_eq!(utc.bucket_of(at), Some(6)); // the 12th
    }

    #[test]
    fn comparisons_and_shares_never_divide_by_zero() {
        assert_eq!(change(12, 10), Some(0.2));
        assert_eq!(change(0, 10), Some(-1.0));
        assert_eq!(change(5, 0), None);
        assert_eq!(change(0, 0), None);
        assert_eq!(share(1, 4), Some(0.25));
        assert_eq!(share(0, 0), None);
    }

    #[test]
    fn first_lines_are_trimmed_and_shortened() {
        assert_eq!(first_line(Some("\n  Hello team  \nmore")), Some("Hello team".to_string()));
        assert_eq!(first_line(Some("   ")), None);
        assert_eq!(first_line(None), None);
        let long = "é".repeat(200);
        let line = first_line(Some(&long)).unwrap();
        assert_eq!(line.chars().count(), 140);
        assert!(line.ends_with('…'));
    }
}
