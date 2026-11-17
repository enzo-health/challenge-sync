//! The weekly lottery: who posted something of their own in one week, for the admin's prize draw
//! (`GET /api/admin/lottery`). One entry per person, however many posts they made.
//!
//! **What a week is.** Nothing else in the app has calendar weeks (scoring counts 7-day buckets
//! from a challenge's start; the stats and reports use whole days in a fixed UTC offset), so the
//! lottery defines its own: Monday 00:00 to the next Monday 00:00 in America/Denver, following
//! daylight saving time. A week that crosses a change is 167 or 169 hours long.
//!
//! **Daylight saving time by rule, not by tz database.** Denver follows the US rule — daylight time
//! from the second Sunday of March at 02:00 to the first Sunday of November at 02:00, MST -07:00
//! and MDT -06:00 — which is ten lines here ([`denver_offset`]) and keeps the dependency list as
//! short as the rest of the crate keeps it (see `util.rs`). A tz crate would also have to bundle its
//! database, since the server runs on Vercel and cannot count on `/usr/share/zoneinfo`. Should the
//! US rule change, this function and its tests are the one place to update.
//!
//! **Who is in.** Every member who is not deleted, with at least one original post (not a
//! reshare) whose LinkedIn creation time falls in the week. A post stored without a creation time
//! (0) is not dated to any week. Everyone else who had an account by the week's end and
//! is not deleted is the week's `audience`.

use std::collections::HashMap;

use serde::Serialize;
use toasty::Db;
use utoipa::ToSchema;

use crate::models::{Member, Post};
use crate::reports::{fmt_local, parse_report_date};
use crate::util::{civil_from_days, days_from_civil, fmt_date};
use crate::web::ApiResult;

pub const TIMEZONE: &str = "America/Denver";
const DAY: i64 = 86_400;
const HOUR: i64 = 3_600;
/// Mountain Standard Time, seconds east of UTC.
const MST: i64 = -7 * HOUR;
/// Mountain Daylight Time, seconds east of UTC.
const MDT: i64 = -6 * HOUR;
const WEEKDAYS: [&str; 7] = [
    "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday",
];

/// Day of the week of a unix day number, 0 = Monday … 6 = Sunday (1970-01-01 was a Thursday).
fn weekday(day: i64) -> i64 {
    (day + 3).rem_euclid(7)
}

/// The unix day of the `nth` (1-based) Sunday of a month.
fn nth_sunday(year: i64, month: i64, nth: i64) -> i64 {
    let first = days_from_civil(year, month, 1);
    let first_sunday = first + (6 - weekday(first));
    first_sunday + (nth - 1) * 7
}

/// Denver's offset from UTC (seconds east) at an instant.
///
/// Daylight time starts at 02:00 MST on the second Sunday of March (09:00 UTC) and ends at 02:00
/// MDT on the first Sunday of November (08:00 UTC).
pub fn denver_offset(unix: i64) -> i64 {
    // The year in Denver; MST is close enough here, since no change happens near New Year.
    let (year, _, _) = civil_from_days((unix + MST).div_euclid(DAY));
    let dst_start = nth_sunday(year, 3, 2) * DAY + 2 * HOUR - MST;
    let dst_end = nth_sunday(year, 11, 1) * DAY + 2 * HOUR - MDT;
    if (dst_start..dst_end).contains(&unix) { MDT } else { MST }
}

/// The instant a local Denver date begins. Midnight is never skipped or repeated, because the
/// clocks change at 02:00.
fn local_midnight(day: i64) -> i64 {
    let standard = day * DAY - MST;
    if denver_offset(standard) == MST { standard } else { day * DAY - MDT }
}

/// The Denver date (as a unix day number) an instant falls on.
fn local_day(unix: i64) -> i64 {
    (unix + denver_offset(unix)).div_euclid(DAY)
}

/// One lottery week: Monday 00:00 to the next Monday 00:00, Denver time.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct LotteryWeek {
    /// The Monday, as a unix day number (days since 1970-01-01).
    pub monday: i64,
    /// First instant included, unix seconds.
    pub starts_at: i64,
    /// First instant of the next week, unix seconds. Exclusive.
    pub ends_at: i64,
}

impl LotteryWeek {
    /// The week starting on this Monday (unix day number).
    fn starting(monday: i64) -> Self {
        Self {
            monday,
            starts_at: local_midnight(monday),
            ends_at: local_midnight(monday + 7),
        }
    }

    /// The week an instant falls in.
    pub fn containing(unix: i64) -> Self {
        let day = local_day(unix);
        Self::starting(day - weekday(day))
    }

    pub fn previous(&self) -> Self {
        Self::starting(self.monday - 7)
    }

    pub fn next(&self) -> Self {
        Self::starting(self.monday + 7)
    }

    /// The Monday as `YYYY-MM-DD`.
    pub fn start_date(&self) -> String {
        fmt_date(self.monday * DAY)
    }

    /// The next Monday as `YYYY-MM-DD` (the end is exclusive).
    pub fn end_date(&self) -> String {
        fmt_date((self.monday + 7) * DAY)
    }

    pub fn hours(&self) -> i64 {
        (self.ends_at - self.starts_at) / HOUR
    }
}

/// The week the request asks for, or the most recent complete week when it names none.
///
/// `week` must be a Monday no later than this week's: the week in progress may be asked for (and
/// is reported as incomplete), a week that has not started may not.
pub fn resolve_week(week: Option<&str>, now: i64) -> Result<LotteryWeek, String> {
    let current = LotteryWeek::containing(now);
    let Some(value) = week.map(str::trim).filter(|value| !value.is_empty()) else {
        return Ok(current.previous());
    };
    let day = parse_report_date(value)
        .ok_or_else(|| format!("week must be a date like 2026-11-09, got {value:?}"))?
        / DAY;
    if weekday(day) != 0 {
        return Err(format!(
            "week must be the Monday a week starts on, got {value} (a {}); that week starts on {}",
            WEEKDAYS[weekday(day) as usize],
            fmt_date((day - weekday(day)) * DAY),
        ));
    }
    if day > current.monday {
        return Err(format!(
            "week {value} has not started yet; the latest week is the one starting {}",
            current.start_date(),
        ));
    }
    Ok(LotteryWeek::starting(day))
}

#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct LotteryEntrant {
    pub member_id: i64,
    pub display_name: String,
    /// Original posts (reshares not counted) this person published during the week.
    pub post_count: usize,
}

#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct LotteryAudienceMember {
    pub member_id: i64,
    pub display_name: String,
}

#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct LotteryWeekEntrants {
    /// The Monday the week starts on, local date, e.g. `2026-11-09`.
    pub week_start: String,
    /// The Monday after (exclusive), local date.
    pub week_end: String,
    /// The week's first instant with its offset, e.g. `2026-11-09T00:00:00-07:00`.
    pub starts_at: String,
    /// The next week's first instant with its offset (exclusive).
    pub ends_at: String,
    /// Always `America/Denver`.
    pub timezone: String,
    /// False while the week is still in progress: more people may yet qualify.
    pub is_complete: bool,
    /// The Monday of the week before.
    pub previous_week: String,
    /// The Monday of the week after, or null when that week has not started yet.
    #[schema(required = true)]
    pub next_week: Option<String>,
    /// One entry per person, sorted by name (case-insensitive), then id.
    pub entrants: Vec<LotteryEntrant>,
    /// Everyone else that week: not deleted, with an account by the week's end, and no
    /// original post in it (someone who only reshared is here). Sorted like `entrants`.
    pub audience: Vec<LotteryAudienceMember>,
}

/// Everyone who published an original post during `week`, with how many, and everyone else who
/// had an account by the week's end (the audience). Not limited to the viewer's org: `org_id` is a
/// legacy column, not a boundary, and the stats and reports count everyone too.
///
/// Two queries: all members, then the week's original posts (filtered by time in the
/// database). Deleted members are in neither list.
pub async fn lottery_entrants(
    db: &mut Db,
    week: LotteryWeek,
    now: i64,
) -> ApiResult<LotteryWeekEntrants> {
    let members: Vec<Member> = Member::all()
        .exec(&mut *db)
        .await?
        .into_iter()
        .filter(|member| !member.is_deleted())
        .collect();

    let created = Post::fields().created_at();
    let posts = Post::filter(
        created
            .clone()
            .ge(week.starts_at)
            .and(created.lt(week.ends_at))
            .and(Post::fields().is_repost().eq(false)),
    )
    .exec(&mut *db)
    .await?;
    let mut counts: HashMap<i64, usize> = HashMap::new();
    for post in &posts {
        *counts.entry(post.member_id).or_default() += 1;
    }

    let mut entrants = Vec::new();
    let mut audience = Vec::new();
    for member in members {
        match counts.get(&member.id) {
            Some(&post_count) => entrants.push(LotteryEntrant {
                member_id: member.id,
                display_name: member.display_name,
                post_count,
            }),
            // Someone whose account did not exist yet that week was not in its audience.
            None if member.created_at < week.ends_at => audience.push(LotteryAudienceMember {
                member_id: member.id,
                display_name: member.display_name,
            }),
            None => {}
        }
    }
    entrants.sort_by(|a, b| by_name((&a.display_name, a.member_id), (&b.display_name, b.member_id)));
    audience.sort_by(|a, b| by_name((&a.display_name, a.member_id), (&b.display_name, b.member_id)));

    let current = LotteryWeek::containing(now);
    let next = week.next();
    Ok(LotteryWeekEntrants {
        week_start: week.start_date(),
        week_end: week.end_date(),
        starts_at: fmt_local(week.starts_at, denver_offset(week.starts_at)),
        ends_at: fmt_local(week.ends_at, denver_offset(week.ends_at)),
        timezone: TIMEZONE.to_string(),
        is_complete: now >= week.ends_at,
        previous_week: week.previous().start_date(),
        next_week: (next.monday <= current.monday).then(|| next.start_date()),
        entrants,
        audience,
    })
}

/// Name order, case-insensitive, then id so equal names keep a stable order.
fn by_name(a: (&str, i64), b: (&str, i64)) -> std::cmp::Ordering {
    a.0.to_lowercase().cmp(&b.0.to_lowercase()).then(a.1.cmp(&b.1))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::util::parse_iso8601;

    /// A UTC timestamp written out, for readable tests.
    fn utc(value: &str) -> i64 {
        parse_iso8601(value).expect("valid test timestamp")
    }

    fn week(monday: &str) -> LotteryWeek {
        resolve_week(Some(monday), utc("2027-01-01T00:00:00Z")).expect("valid week")
    }

    /// Mon 2026-11-16, 10:00 in Denver.
    const NOW: &str = "2026-11-16T17:00:00Z";

    #[test]
    fn offsets_change_at_two_in_the_morning() {
        // 2026: daylight time from Sun 8 March 02:00 MST to Sun 1 November 02:00 MDT.
        assert_eq!(denver_offset(utc("2026-03-08T08:59:59Z")), MST);
        assert_eq!(denver_offset(utc("2026-03-08T09:00:00Z")), MDT);
        assert_eq!(denver_offset(utc("2026-11-01T07:59:59Z")), MDT);
        assert_eq!(denver_offset(utc("2026-11-01T08:00:00Z")), MST);
        assert_eq!(denver_offset(utc("2026-07-01T12:00:00Z")), MDT);
        assert_eq!(denver_offset(utc("2026-01-01T12:00:00Z")), MST);
        // 2027: 14 March and 7 November.
        assert_eq!(denver_offset(utc("2027-03-14T08:59:59Z")), MST);
        assert_eq!(denver_offset(utc("2027-03-14T09:00:00Z")), MDT);
        assert_eq!(denver_offset(utc("2027-11-07T07:59:59Z")), MDT);
        assert_eq!(denver_offset(utc("2027-11-07T08:00:00Z")), MST);
    }

    #[test]
    fn the_week_that_falls_back_is_169_hours() {
        let w = week("2026-10-26");
        assert_eq!(w.end_date(), "2026-11-02");
        assert_eq!(w.hours(), 169);
        assert_eq!(fmt_local(w.starts_at, denver_offset(w.starts_at)), "2026-10-26T00:00:00-06:00");
        assert_eq!(fmt_local(w.ends_at, denver_offset(w.ends_at)), "2026-11-02T00:00:00-07:00");
    }

    #[test]
    fn the_week_that_springs_forward_is_167_hours() {
        let w = week("2026-03-02");
        assert_eq!(w.end_date(), "2026-03-09");
        assert_eq!(w.hours(), 167);
    }

    #[test]
    fn a_normal_week_is_168_hours() {
        let w = week("2026-11-09");
        assert_eq!(w.hours(), 168);
        assert_eq!(w.starts_at, utc("2026-11-09T07:00:00Z"));
        assert_eq!(w.ends_at, utc("2026-11-16T07:00:00Z"));
        assert_eq!(week("2026-07-06").hours(), 168);
    }

    #[test]
    fn sunday_night_and_monday_midnight_fall_in_different_weeks() {
        let w = week("2026-11-09");
        // Sun 2026-11-15 23:59:59 MST and Mon 2026-11-16 00:00:00 MST.
        let last = utc("2026-11-16T06:59:59Z");
        let first_of_next = utc("2026-11-16T07:00:00Z");
        assert!((w.starts_at..w.ends_at).contains(&last));
        assert!(!(w.starts_at..w.ends_at).contains(&first_of_next));
        assert_eq!(LotteryWeek::containing(last), w);
        assert_eq!(LotteryWeek::containing(first_of_next), w.next());
        // The same across the fall-back week's end, in daylight time at its start.
        let fall = week("2026-10-26");
        assert_eq!(LotteryWeek::containing(utc("2026-10-26T06:00:00Z")), fall);
        assert_eq!(LotteryWeek::containing(utc("2026-10-26T05:59:59Z")), fall.previous());
        assert_eq!(LotteryWeek::containing(utc("2026-11-02T06:59:59Z")), fall);
        assert_eq!(LotteryWeek::containing(utc("2026-11-02T07:00:00Z")), fall.next());
    }

    #[test]
    fn the_default_is_the_last_complete_week() {
        let w = resolve_week(None, utc(NOW)).unwrap();
        assert_eq!(w.start_date(), "2026-11-09");
        assert_eq!(resolve_week(Some("  "), utc(NOW)).unwrap(), w);
        // At Monday 00:00 the week before has just completed.
        let w = resolve_week(None, utc("2026-11-16T07:00:00Z")).unwrap();
        assert_eq!(w.start_date(), "2026-11-09");
        // One second earlier it was still in progress.
        let w = resolve_week(None, utc("2026-11-16T06:59:59Z")).unwrap();
        assert_eq!(w.start_date(), "2026-11-02");
    }

    #[test]
    fn the_current_week_is_allowed_and_a_future_one_is_not() {
        let now = utc(NOW);
        assert_eq!(resolve_week(Some("2026-11-16"), now).unwrap().start_date(), "2026-11-16");
        let error = resolve_week(Some("2026-11-23"), now).unwrap_err();
        assert!(error.contains("has not started yet"), "{error}");
        assert!(error.contains("2026-11-16"), "{error}");
    }

    #[test]
    fn a_week_must_be_a_monday_written_as_a_date() {
        let now = utc(NOW);
        let error = resolve_week(Some("2026-11-10"), now).unwrap_err();
        assert_eq!(
            error,
            "week must be the Monday a week starts on, got 2026-11-10 (a Tuesday); that week starts on 2026-11-09"
        );
        for bad in ["2026-11-31", "next week", "2026/11/09", "2026-11-9"] {
            let error = resolve_week(Some(bad), now).unwrap_err();
            assert!(error.starts_with("week must be a date like 2026-11-09"), "{bad}: {error}");
        }
    }
}
