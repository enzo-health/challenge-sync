//! The weekly lottery: who posted something of their own in one week, for the admin's prize draw
//! (`GET /api/admin/lottery`). One entry per person, however many posts they made.
//!
//! **What a week is.** Nothing else in the app has calendar weeks (scoring counts 7-day buckets
//! from a challenge's start; the stats and reports use whole days in a fixed UTC offset), so the
//! lottery defines its own: Friday 00:00 to the next Friday 00:00 in America/Denver (Thursday is
//! the last day in it), following daylight saving time. The draw happens on a Friday call, so the
//! default is the week that ended at midnight before it. A week that crosses a change is 167 or
//! 169 hours long.
//!
//! **A custom range.** Instead of a week the admin may ask for any run of whole Denver days,
//! `from` to `to` inclusive (at most [`MAX_RANGE_DAYS`]), with the same rule for who is in. A
//! range has no previous or next week. Asking for a week and a range at once is refused.
//!
//! **Daylight saving time by rule, not by tz database.** Denver follows the US rule — daylight time
//! from the second Sunday of March at 02:00 to the first Sunday of November at 02:00, MST -07:00
//! and MDT -06:00 — which is ten lines here ([`denver_offset`]) and keeps the dependency list as
//! short as the rest of the crate keeps it (see `util.rs`). A tz crate would also have to bundle its
//! database, since the server runs on Vercel and cannot count on `/usr/share/zoneinfo`. Should the
//! US rule change, this function and its tests are the one place to update.
//!
//! **Who is in.** Every member who is not deleted, with at least one original post (not a
//! reshare) whose LinkedIn creation time falls in the period. A post stored without a creation
//! time (0) is not dated to any period. Everyone else who had an account by the period's end and
//! is not deleted is the period's `audience`.
//!
//! **Who is left out.** An admin can exclude a member from the draw (`Member::lottery_excluded`,
//! set with `PUT /api/admin/lottery/exclusions/{memberId}`), e.g. the organisers. Someone excluded
//! who posted in the period is not an entrant: they are in the audience with `excluded` set, so the
//! page can say openly who is not in the draw. Someone excluded who did not post is ordinary
//! audience. The flag is read as it is now, not as it was then.

use std::collections::HashMap;

use serde::Serialize;
use toasty::Db;
use utoipa::ToSchema;

use crate::avatar::{Avatar, member_avatar};
use crate::models::{Member, Post};
use crate::reports::{fmt_local, parse_report_date};
use crate::util::{civil_from_days, days_from_civil, fmt_date};
use crate::web::ApiResult;

pub const TIMEZONE: &str = "America/Denver";
pub(crate) const DAY: i64 = 86_400;
pub(crate) const HOUR: i64 = 3_600;
/// Mountain Standard Time, seconds east of UTC.
const MST: i64 = -7 * HOUR;
/// Mountain Daylight Time, seconds east of UTC.
const MDT: i64 = -6 * HOUR;
const WEEKDAYS: [&str; 7] = [
    "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday",
];

/// Day of the week of a unix day number, 0 = Monday … 6 = Sunday (1970-01-01 was a Thursday).
pub(crate) fn weekday(day: i64) -> i64 {
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
pub(crate) fn local_midnight(day: i64) -> i64 {
    let standard = day * DAY - MST;
    if denver_offset(standard) == MST { standard } else { day * DAY - MDT }
}

/// The Denver date (as a unix day number) an instant falls on.
pub(crate) fn local_day(unix: i64) -> i64 {
    (unix + denver_offset(unix)).div_euclid(DAY)
}

/// The first day of a lottery week, as [`weekday`] numbers it.
pub(crate) const FRIDAY: i64 = 4;

/// The longest custom range, in days, that can be asked for.
pub const MAX_RANGE_DAYS: i64 = 62;

/// A run of whole Denver days: the first one's midnight to the midnight after the last one.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct LotteryPeriod {
    /// The first day, as a unix day number (days since 1970-01-01).
    pub first_day: i64,
    /// The day after the last one (exclusive), as a unix day number.
    pub end_day: i64,
    /// First instant included, unix seconds.
    pub starts_at: i64,
    /// First instant after the period, unix seconds. Exclusive.
    pub ends_at: i64,
}

impl LotteryPeriod {
    /// The days `first_day` up to, not including, `end_day`.
    fn days(first_day: i64, end_day: i64) -> Self {
        Self {
            first_day,
            end_day,
            starts_at: local_midnight(first_day),
            ends_at: local_midnight(end_day),
        }
    }

    /// The first day as `YYYY-MM-DD`.
    pub fn first_date(&self) -> String {
        fmt_date(self.first_day * DAY)
    }

    /// The last day included as `YYYY-MM-DD`.
    pub fn last_date(&self) -> String {
        fmt_date((self.end_day - 1) * DAY)
    }

    pub fn hours(&self) -> i64 {
        (self.ends_at - self.starts_at) / HOUR
    }
}

/// One lottery week: Friday 00:00 to the next Friday 00:00, Denver time (Friday to Thursday).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct LotteryWeek {
    /// The Friday, as a unix day number (days since 1970-01-01).
    pub friday: i64,
    /// First instant included, unix seconds.
    pub starts_at: i64,
    /// First instant of the next week, unix seconds. Exclusive.
    pub ends_at: i64,
}

impl LotteryWeek {
    /// The week starting on this Friday (unix day number).
    pub(crate) fn starting(friday: i64) -> Self {
        let period = LotteryPeriod::days(friday, friday + 7);
        Self { friday, starts_at: period.starts_at, ends_at: period.ends_at }
    }

    /// The week an instant falls in.
    pub fn containing(unix: i64) -> Self {
        Self::starting(week_start(local_day(unix)))
    }

    pub fn previous(&self) -> Self {
        Self::starting(self.friday - 7)
    }

    pub fn next(&self) -> Self {
        Self::starting(self.friday + 7)
    }

    /// The week's seven days, Friday to Thursday.
    pub fn period(&self) -> LotteryPeriod {
        LotteryPeriod::days(self.friday, self.friday + 7)
    }

    /// The Friday as `YYYY-MM-DD`.
    pub fn start_date(&self) -> String {
        fmt_date(self.friday * DAY)
    }

    /// The next Friday as `YYYY-MM-DD` (the end is exclusive).
    pub fn end_date(&self) -> String {
        fmt_date((self.friday + 7) * DAY)
    }

    pub fn hours(&self) -> i64 {
        (self.ends_at - self.starts_at) / HOUR
    }
}

/// The Friday on or before a day (unix day numbers).
pub(crate) fn week_start(day: i64) -> i64 {
    day - (weekday(day) - FRIDAY).rem_euclid(7)
}

/// The week the request asks for, or the most recent complete week when it names none.
///
/// `week` must be a Friday no later than this week's: the week in progress may be asked for (and
/// is reported as incomplete), a week that has not started may not.
pub fn resolve_week(week: Option<&str>, now: i64) -> Result<LotteryWeek, String> {
    let current = LotteryWeek::containing(now);
    let Some(value) = present(week) else {
        return Ok(current.previous());
    };
    let day = parse_report_date(value)
        .ok_or_else(|| format!("week must be a date like 2026-11-13, got {value:?}"))?
        / DAY;
    if weekday(day) != FRIDAY {
        return Err(format!(
            "week must be the Friday a week starts on, got {value} (a {}); that week starts on {}",
            WEEKDAYS[weekday(day) as usize],
            fmt_date(week_start(day) * DAY),
        ));
    }
    if day > current.friday {
        return Err(format!(
            "week {value} has not started yet; the latest week is the one starting {}",
            current.start_date(),
        ));
    }
    Ok(LotteryWeek::starting(day))
}

/// What the draw is over: a Friday-to-Thursday week, or a custom range of days.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LotterySelection {
    Week(LotteryWeek),
    Range(LotteryPeriod),
}

impl LotterySelection {
    pub fn period(&self) -> LotteryPeriod {
        match self {
            Self::Week(week) => week.period(),
            Self::Range(range) => *range,
        }
    }
}

/// A query value that was given and is not blank.
fn present(value: Option<&str>) -> Option<&str> {
    value.map(str::trim).filter(|value| !value.is_empty())
}

/// The period the request asks for: `week` (a Friday, see [`resolve_week`]), or `from` and `to`
/// (both inclusive Denver dates), or with none of them the most recent complete week. Blank values
/// count as absent. A week and a range together are refused, as is half a range.
///
/// A range must start no later than today (Denver) and run at most [`MAX_RANGE_DAYS`] days; it
/// may end today or later, and is then reported as incomplete.
pub fn resolve_selection(
    week: Option<&str>,
    from: Option<&str>,
    to: Option<&str>,
    now: i64,
) -> Result<LotterySelection, String> {
    let (from, to) = (present(from), present(to));
    if present(week).is_some() && (from.is_some() || to.is_some()) {
        return Err("give either week or from and to, not both: week picks a Friday-to-Thursday week, \
                    from and to a custom range"
            .to_string());
    }
    let (from, to) = match (from, to) {
        (None, None) => return resolve_week(week, now).map(LotterySelection::Week),
        (Some(_), None) => {
            return Err("a range needs both from and to; to (the last day included) is missing".to_string());
        }
        (None, Some(_)) => {
            return Err("a range needs both from and to; from (the first day) is missing".to_string());
        }
        (Some(from), Some(to)) => (from, to),
    };
    let first = parse_report_date(from)
        .ok_or_else(|| format!("from must be a date like 2026-11-13, got {from:?}"))?
        / DAY;
    let last = parse_report_date(to)
        .ok_or_else(|| format!("to must be a date like 2026-11-19, got {to:?}"))?
        / DAY;
    if first > last {
        return Err(format!(
            "from {from} is after to {to}; to is the last day included, so it cannot be before from"
        ));
    }
    let today = local_day(now);
    if first > today {
        return Err(format!(
            "from {from} is in the future; today in {TIMEZONE} is {}",
            fmt_date(today * DAY),
        ));
    }
    let days = last - first + 1;
    if days > MAX_RANGE_DAYS {
        return Err(format!(
            "the range {from} to {to} is {days} days long; the longest allowed is {MAX_RANGE_DAYS} days"
        ));
    }
    Ok(LotterySelection::Range(LotteryPeriod::days(first, last + 1)))
}

#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct LotteryEntrant {
    pub member_id: i64,
    pub display_name: String,
    /// Original posts (reshares not counted) this person published during the period.
    pub post_count: usize,
    /// Their saved avatar, or null for the look generated from their id.
    #[schema(required = true)]
    pub avatar: Option<Avatar>,
}

#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct LotteryAudienceMember {
    pub member_id: i64,
    pub display_name: String,
    /// True for someone who posted an original in the period but is excluded from the draw by an
    /// admin; false for everyone who simply did not post.
    pub excluded: bool,
    /// Their saved avatar, or null for the look generated from their id.
    #[schema(required = true)]
    pub avatar: Option<Avatar>,
}

#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct LotteryPeriodEntrants {
    /// The first day included, local date: for a week its Friday, e.g. `2026-11-13`.
    pub first_day: String,
    /// The last day included, local date: for a week its Thursday, e.g. `2026-11-19`.
    pub last_day: String,
    /// The first instant with its offset, e.g. `2026-11-13T00:00:00-07:00`.
    pub starts_at: String,
    /// The first instant after the period with its offset (exclusive), e.g.
    /// `2026-11-20T00:00:00-07:00`.
    pub ends_at: String,
    /// Always `America/Denver`.
    pub timezone: String,
    /// False while the period is still in progress: more people may yet qualify.
    pub is_complete: bool,
    /// True for a custom `from`/`to` range, false for a Friday-to-Thursday week.
    pub is_custom_range: bool,
    /// The Friday of the week before, or null for a custom range.
    #[schema(required = true)]
    pub previous_week: Option<String>,
    /// The Friday of the week after, or null when that week has not started yet or for a custom
    /// range.
    #[schema(required = true)]
    pub next_week: Option<String>,
    /// One entry per person, sorted by name (case-insensitive), then id.
    pub entrants: Vec<LotteryEntrant>,
    /// Everyone else in the period: not deleted, with an account by its end, and either no
    /// original post in it (someone who only reshared is here) or excluded from the draw
    /// (`excluded`). Sorted like `entrants`.
    pub audience: Vec<LotteryAudienceMember>,
}

/// Everyone who published an original post during the selected period, with how many, and
/// everyone else who had an account by its end (the audience). Not limited to the viewer's org:
/// `org_id` is a legacy column, not a boundary, and the stats and reports count everyone too.
///
/// Two queries: all members, then the period's original posts (filtered by time in the
/// database). Deleted members are in neither list.
pub async fn lottery_entrants(
    db: &mut Db,
    selection: LotterySelection,
    now: i64,
) -> ApiResult<LotteryPeriodEntrants> {
    let members: Vec<Person> = Member::all()
        .exec(&mut *db)
        .await?
        .into_iter()
        .filter(|member| !member.is_deleted())
        .map(|member| Person {
            avatar: member_avatar(&member),
            id: member.id,
            display_name: member.display_name,
            created_at: member.created_at,
            excluded: member.lottery_excluded,
        })
        .collect();

    let period = selection.period();
    let counts = original_post_counts(db, period).await?;

    let (entrants, audience) = split_draw(members, &counts, period);

    let (previous_week, next_week) = match selection {
        LotterySelection::Week(week) => {
            let current = LotteryWeek::containing(now);
            let next = week.next();
            (
                Some(week.previous().start_date()),
                (next.friday <= current.friday).then(|| next.start_date()),
            )
        }
        LotterySelection::Range(_) => (None, None),
    };
    Ok(LotteryPeriodEntrants {
        first_day: period.first_date(),
        last_day: period.last_date(),
        starts_at: fmt_local(period.starts_at, denver_offset(period.starts_at)),
        ends_at: fmt_local(period.ends_at, denver_offset(period.ends_at)),
        timezone: TIMEZONE.to_string(),
        is_complete: now >= period.ends_at,
        is_custom_range: matches!(selection, LotterySelection::Range(_)),
        previous_week,
        next_week,
        entrants,
        audience,
    })
}

/// How many original posts (not reshares) each member published during `period`, by member id: the
/// one place that decides who "posted that week". A member with none is absent. One query, filtered
/// by time in the database; a post stored without a creation time (0) is in no real period. Deleted
/// members are not filtered out here: callers list members themselves and leave the deleted out.
/// Used by the draw ([`lottery_entrants`]) and the plaza's star (`plaza::roster`).
pub async fn original_post_counts(
    db: &mut Db,
    period: LotteryPeriod,
) -> ApiResult<HashMap<i64, usize>> {
    let created = Post::fields().created_at();
    let posts = Post::filter(
        created
            .clone()
            .ge(period.starts_at)
            .and(created.lt(period.ends_at))
            .and(Post::fields().is_repost().eq(false)),
    )
    .exec(&mut *db)
    .await?;
    let mut counts: HashMap<i64, usize> = HashMap::new();
    for post in &posts {
        *counts.entry(post.member_id).or_default() += 1;
    }
    Ok(counts)
}

/// What the draw needs to know about a (not deleted) member.
struct Person {
    id: i64,
    display_name: String,
    created_at: i64,
    /// `Member::lottery_excluded`.
    excluded: bool,
    /// Their saved avatar (`Member::avatar_json`, validated), if any.
    avatar: Option<Avatar>,
}

/// Split the period's members into entrants and audience (see the module docs), each sorted by
/// name. `counts` is original posts in the period per member id.
fn split_draw(
    members: Vec<Person>,
    counts: &HashMap<i64, usize>,
    period: LotteryPeriod,
) -> (Vec<LotteryEntrant>, Vec<LotteryAudienceMember>) {
    let mut entrants = Vec::new();
    let mut audience = Vec::new();
    for member in members {
        match counts.get(&member.id) {
            Some(_) if member.excluded => audience.push(LotteryAudienceMember {
                member_id: member.id,
                display_name: member.display_name,
                excluded: true,
                avatar: member.avatar,
            }),
            Some(&post_count) => entrants.push(LotteryEntrant {
                member_id: member.id,
                display_name: member.display_name,
                post_count,
                avatar: member.avatar,
            }),
            // Someone whose account did not exist yet by the period's end was not in its audience.
            None if member.created_at < period.ends_at => audience.push(LotteryAudienceMember {
                member_id: member.id,
                display_name: member.display_name,
                excluded: false,
                avatar: member.avatar,
            }),
            None => {}
        }
    }
    entrants.sort_by(|a, b| by_name((&a.display_name, a.member_id), (&b.display_name, b.member_id)));
    audience.sort_by(|a, b| by_name((&a.display_name, a.member_id), (&b.display_name, b.member_id)));
    (entrants, audience)
}

/// Name order, case-insensitive, then id so equal names keep a stable order.
pub(crate) fn by_name(a: (&str, i64), b: (&str, i64)) -> std::cmp::Ordering {
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

    fn week(friday: &str) -> LotteryWeek {
        resolve_week(Some(friday), utc("2028-01-01T00:00:00Z")).expect("valid week")
    }

    /// Fri 2026-11-20, 09:00 in Denver: the morning of a Friday draw.
    const NOW: &str = "2026-11-20T16:00:00Z";

    fn local(unix: i64) -> String {
        fmt_local(unix, denver_offset(unix))
    }

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
        // Fri 30 Oct to Thu 5 Nov 2026; the clocks fall back on Sun 1 Nov.
        let w = week("2026-10-30");
        assert_eq!(w.end_date(), "2026-11-06");
        assert_eq!(w.period().last_date(), "2026-11-05");
        assert_eq!(w.hours(), 169);
        assert_eq!(local(w.starts_at), "2026-10-30T00:00:00-06:00");
        assert_eq!(local(w.ends_at), "2026-11-06T00:00:00-07:00");
    }

    #[test]
    fn the_week_that_springs_forward_is_167_hours() {
        // Fri 6 Mar to Thu 12 Mar 2026; the clocks spring forward on Sun 8 Mar.
        let w = week("2026-03-06");
        assert_eq!(w.end_date(), "2026-03-13");
        assert_eq!(w.hours(), 167);
        assert_eq!(local(w.starts_at), "2026-03-06T00:00:00-07:00");
        assert_eq!(local(w.ends_at), "2026-03-13T00:00:00-06:00");
        // 2027's changes too: 14 March and 7 November.
        assert_eq!(week("2027-03-12").hours(), 167);
        assert_eq!(week("2027-11-05").hours(), 169);
    }

    #[test]
    fn a_normal_week_is_friday_to_thursday_and_168_hours() {
        let w = week("2026-11-13");
        assert_eq!(w.hours(), 168);
        assert_eq!(w.starts_at, utc("2026-11-13T07:00:00Z"));
        assert_eq!(w.ends_at, utc("2026-11-20T07:00:00Z"));
        assert_eq!((w.period().first_date(), w.period().last_date()), ("2026-11-13".into(), "2026-11-19".into()));
        assert_eq!(week("2026-07-10").hours(), 168);
        assert_eq!(w.previous().start_date(), "2026-11-06");
        assert_eq!(w.next().start_date(), "2026-11-20");
    }

    #[test]
    fn thursday_night_and_friday_midnight_fall_in_different_weeks() {
        let w = week("2026-11-13");
        // Thu 2026-11-19 23:59:59 MST and Fri 2026-11-20 00:00:00 MST.
        let last = utc("2026-11-20T06:59:59Z");
        let first_of_next = utc("2026-11-20T07:00:00Z");
        assert!((w.starts_at..w.ends_at).contains(&last));
        assert!(!(w.starts_at..w.ends_at).contains(&first_of_next));
        assert_eq!(LotteryWeek::containing(last), w);
        assert_eq!(LotteryWeek::containing(first_of_next), w.next());
        // Every day of the week lands in it: Friday 00:00 through Thursday 23:59:59.
        for day in 0..7 {
            assert_eq!(LotteryWeek::containing(w.starts_at + day * DAY + 12 * HOUR), w, "day {day}");
        }
        // The same across the fall-back week, which starts in daylight time and ends in standard.
        let fall = week("2026-10-30");
        assert_eq!(LotteryWeek::containing(utc("2026-10-30T06:00:00Z")), fall);
        assert_eq!(LotteryWeek::containing(utc("2026-10-30T05:59:59Z")), fall.previous());
        assert_eq!(LotteryWeek::containing(utc("2026-11-06T06:59:59Z")), fall);
        assert_eq!(LotteryWeek::containing(utc("2026-11-06T07:00:00Z")), fall.next());
        // And the spring-forward week, which starts in standard time and ends in daylight.
        let spring = week("2026-03-06");
        assert_eq!(LotteryWeek::containing(utc("2026-03-06T07:00:00Z")), spring);
        assert_eq!(LotteryWeek::containing(utc("2026-03-06T06:59:59Z")), spring.previous());
        assert_eq!(LotteryWeek::containing(utc("2026-03-13T05:59:59Z")), spring);
        assert_eq!(LotteryWeek::containing(utc("2026-03-13T06:00:00Z")), spring.next());
    }

    #[test]
    fn the_default_is_the_last_complete_friday_to_thursday_week() {
        // Friday morning, the day of the draw: the week that ended at midnight, Fri 13 - Thu 19 Nov.
        let w = resolve_week(None, utc(NOW)).unwrap();
        assert_eq!(w.start_date(), "2026-11-13");
        assert_eq!(resolve_week(Some("  "), utc(NOW)).unwrap(), w);
        // At Friday 00:00 the week before has just completed.
        let w = resolve_week(None, utc("2026-11-20T07:00:00Z")).unwrap();
        assert_eq!(w.start_date(), "2026-11-13");
        // One second earlier (Thursday 23:59:59) it was still in progress.
        let w = resolve_week(None, utc("2026-11-20T06:59:59Z")).unwrap();
        assert_eq!(w.start_date(), "2026-11-06");
        // Thursday morning, and late on the following Thursday.
        assert_eq!(resolve_week(None, utc("2026-11-19T17:00:00Z")).unwrap().start_date(), "2026-11-06");
        assert_eq!(resolve_week(None, utc("2026-11-27T06:59:59Z")).unwrap().start_date(), "2026-11-13");
        // Monday of the next week.
        assert_eq!(resolve_week(None, utc("2026-11-23T17:00:00Z")).unwrap().start_date(), "2026-11-13");
        // The selection with nothing asked is that week.
        assert_eq!(resolve_selection(None, None, None, utc(NOW)).unwrap(), LotterySelection::Week(week("2026-11-13")));
    }

    #[test]
    fn the_current_week_is_allowed_and_a_future_one_is_not() {
        let now = utc(NOW);
        assert_eq!(resolve_week(Some("2026-11-20"), now).unwrap().start_date(), "2026-11-20");
        let error = resolve_week(Some("2026-11-27"), now).unwrap_err();
        assert_eq!(error, "week 2026-11-27 has not started yet; the latest week is the one starting 2026-11-20");
    }

    #[test]
    fn an_excluded_poster_is_in_the_audience_marked_excluded() {
        let w = week("2026-11-13").period();
        let person = |id: i64, name: &str, excluded: bool| Person {
            id,
            display_name: name.to_string(),
            created_at: w.starts_at - DAY,
            excluded,
            avatar: None,
        };
        let members = vec![
            person(1, "Ann Posts", false),
            person(2, "Org Organiser", true),
            person(3, "Quiet Organiser", true),
            person(4, "Bob Quiet", false),
        ];
        let counts = HashMap::from([(1, 2), (2, 3)]);
        let (entrants, audience) = split_draw(members, &counts, w);
        assert_eq!(entrants.iter().map(|e| e.member_id).collect::<Vec<_>>(), vec![1]);
        assert_eq!(entrants[0].post_count, 2);
        let audience: Vec<(i64, bool)> = audience.iter().map(|a| (a.member_id, a.excluded)).collect();
        // Sorted by name; only someone excluded who posted is marked.
        assert_eq!(audience, vec![(4, false), (2, true), (3, false)]);
    }

    #[test]
    fn a_week_must_be_a_friday_written_as_a_date() {
        let now = utc(NOW);
        assert_eq!(
            resolve_week(Some("2026-11-16"), now).unwrap_err(),
            "week must be the Friday a week starts on, got 2026-11-16 (a Monday); that week starts on 2026-11-13"
        );
        assert_eq!(
            resolve_week(Some("2026-11-19"), now).unwrap_err(),
            "week must be the Friday a week starts on, got 2026-11-19 (a Thursday); that week starts on 2026-11-13"
        );
        assert_eq!(
            resolve_week(Some("2026-11-14"), now).unwrap_err(),
            "week must be the Friday a week starts on, got 2026-11-14 (a Saturday); that week starts on 2026-11-13"
        );
        for bad in ["2026-11-31", "next week", "2026/11/13", "2026-11-9"] {
            let error = resolve_week(Some(bad), now).unwrap_err();
            assert!(error.starts_with("week must be a date like 2026-11-13"), "{bad}: {error}");
        }
    }

    fn range(from: &str, to: &str) -> Result<LotterySelection, String> {
        resolve_selection(None, Some(from), Some(to), utc(NOW))
    }

    #[test]
    fn a_range_is_whole_denver_days_from_and_to_inclusive() {
        let LotterySelection::Range(r) = range("2026-11-16", "2026-11-18").unwrap() else { panic!("not a range") };
        assert_eq!((r.first_date(), r.last_date()), ("2026-11-16".into(), "2026-11-18".into()));
        assert_eq!(r.starts_at, utc("2026-11-16T07:00:00Z"));
        assert_eq!(r.ends_at, utc("2026-11-19T07:00:00Z"));
        // One day; today; and a range across the fall-back change (one hour longer).
        let LotterySelection::Range(r) = range("2026-11-20", "2026-11-20").unwrap() else { panic!() };
        assert_eq!(r.hours(), 24);
        assert!(r.ends_at > utc(NOW), "a range ending today is still in progress");
        let LotterySelection::Range(r) = range("2026-10-31", "2026-11-01").unwrap() else { panic!() };
        assert_eq!(r.hours(), 49);
        assert_eq!(local(r.starts_at), "2026-10-31T00:00:00-06:00");
        assert_eq!(local(r.ends_at), "2026-11-02T00:00:00-07:00");
        // A range may end in the future; the longest allowed is 62 days.
        assert!(range("2026-11-16", "2026-12-31").is_ok());
        assert!(range("2026-09-20", "2026-11-20").is_ok());
        // Blank values are absent.
        assert_eq!(resolve_selection(Some(""), Some(" "), Some(""), utc(NOW)).unwrap(), LotterySelection::Week(week("2026-11-13")));
        assert!(matches!(resolve_selection(Some(""), Some("2026-11-16"), Some("2026-11-18"), utc(NOW)), Ok(LotterySelection::Range(_))));
    }

    #[test]
    fn a_bad_range_says_what_is_wrong() {
        let now = utc(NOW);
        assert_eq!(
            resolve_selection(Some("2026-11-13"), Some("2026-11-16"), Some("2026-11-18"), now).unwrap_err(),
            "give either week or from and to, not both: week picks a Friday-to-Thursday week, from and to a custom range"
        );
        assert_eq!(
            resolve_selection(Some("2026-11-13"), None, Some("2026-11-18"), now).unwrap_err(),
            resolve_selection(Some("2026-11-13"), Some("2026-11-16"), Some("2026-11-18"), now).unwrap_err(),
        );
        assert_eq!(
            resolve_selection(None, Some("2026-11-16"), None, now).unwrap_err(),
            "a range needs both from and to; to (the last day included) is missing"
        );
        assert_eq!(
            resolve_selection(None, None, Some("2026-11-18"), now).unwrap_err(),
            "a range needs both from and to; from (the first day) is missing"
        );
        assert_eq!(range("16 Nov", "2026-11-18").unwrap_err(), "from must be a date like 2026-11-13, got \"16 Nov\"");
        assert_eq!(range("2026-11-16", "2026-11-31").unwrap_err(), "to must be a date like 2026-11-19, got \"2026-11-31\"");
        assert_eq!(
            range("2026-11-18", "2026-11-16").unwrap_err(),
            "from 2026-11-18 is after to 2026-11-16; to is the last day included, so it cannot be before from"
        );
        assert_eq!(
            range("2026-11-21", "2026-11-22").unwrap_err(),
            "from 2026-11-21 is in the future; today in America/Denver is 2026-11-20"
        );
        assert_eq!(
            range("2026-09-19", "2026-11-20").unwrap_err(),
            "the range 2026-09-19 to 2026-11-20 is 63 days long; the longest allowed is 62 days"
        );
    }
}
