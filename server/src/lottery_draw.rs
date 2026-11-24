//! The official weekly lottery draw: public, provably fair, the same for everyone. Shown at
//! `/lottery` (`GET /api/lottery`), kept forever (`GET /api/lottery/results`), and redrawn only by
//! an admin with a reason (`POST /api/admin/lottery/draws/{week}/redraw`).
//!
//! **The day.** The draw for a Friday-to-Thursday week (`lottery.rs`) is held on the Friday after
//! it ends. Times are Denver time (constants below):
//!
//! | until 09:30       | party: everyone dances; who is in the coming draw so far gets a star |
//! | 09:30 – 09:35     | the list is frozen: who is in, the list's hash, a countdown to the seed |
//! | 09:35 – 12:00     | the wheel: every Spin, in every browser, lands on the stored winner    |
//! | from 12:00        | party again for the week in progress; the result is in the past results |
//!
//! **Freeze (09:30).** The entrants are frozen with the lottery's own rule
//! ([`crate::lottery::lottery_entrants`]: not deleted, not excluded, an original post in the week)
//! as a snapshot (id, name, post count, avatar), written as [`canonical_text`] and hashed with
//! SHA-256. Nobody has to press anything: a Vercel cron calls `GET /api/lottery/freeze`, which
//! freezes when one is due and is harmless otherwise; and any request for the draw from 09:30 on
//! does the same (the safety net). Either way only on the draw's Friday itself, from 09:30 to
//! midnight: a week nobody froze that day has no official draw, rather than one frozen days late.
//! One row per week (a unique index), so two freezes at once leave one; the loser reads it back.
//!
//! **Seed (09:35).** The first drand quicknet round published at or after 09:35:00
//! ([`crate::beacon`]) is fixed in the record at the freeze, before it exists. It is fetched when
//! its time has come, by whichever request gets there first, checked, and stored. If it cannot be
//! fetched the page says what failed and the next request tries again. Never local randomness.
//!
//! **Winner.** [`pick_index`]: `SHA-256("<list hash>:<randomness>:<sequence>")` as a big-endian
//! 256-bit number, modulo the number of eligible entrants, is the winner's position among them in
//! list order. Sequence 1 is the first draw; each redraw adds one. Eligible = the frozen list minus
//! everyone who already won that week. Nobody in the list: no winner. One: they win, the same way.
//!
//! **Redraw.** An admin (`dto::require_challenge_user`) gives a reason; the redraw is seeded by the
//! first round published [`REDRAW_SEED_DELAY`] seconds or more after the request, so whoever presses
//! it cannot know the outcome. Picks are append-only: no API edits or deletes any of this.

use std::collections::HashSet;

use serde::{Deserialize, Serialize};
use toasty::Db;
use utoipa::ToSchema;

use crate::avatar::{self, Avatar};
use crate::beacon::{self, round_at_or_after, round_time};
use crate::lottery::{
    HOUR, LotterySelection, LotteryWeek, TIMEZONE, denver_offset, local_day, local_midnight, lottery_entrants,
    week_start,
};
use crate::models::{LotteryDraw, LotteryResult, Member};
use crate::reports::fmt_local;
use crate::util::{fmt_date, sha256_hex};
use crate::web::{ApiError, ApiResult};

const MINUTE: i64 = 60;
/// The list is frozen at 09:30 on the draw's Friday, Denver time (seconds after local midnight).
pub const FREEZE_AFTER_MIDNIGHT: i64 = 9 * HOUR + 30 * MINUTE;
/// The seed is the first drand round published at or after 09:35:00; the wheel opens then.
pub const SEED_AFTER_MIDNIGHT: i64 = 9 * HOUR + 35 * MINUTE;
/// The wheel stays up until 12:00; after that the page is back to the party.
pub const CLOSE_AFTER_MIDNIGHT: i64 = 12 * HOUR;
/// A redraw's round is the first published at least this many seconds after the request.
pub const REDRAW_SEED_DELAY: i64 = 6;
/// The longest redraw reason, in characters.
pub const REASON_MAX_CHARS: usize = 500;
/// How many past draws `GET /api/lottery/results` lists, newest first.
pub const PAST_LIMIT: usize = 52;
/// The first line of every canonical list; the version changes if the format ever does.
pub const LIST_HEADER: &str = "Challenge Sync weekly lottery, entrant list v1";

/// The winner formula, as the page shows it.
pub const FORMULA: &str = "index = SHA-256(\"<list hash>:<randomness>:<sequence>\") read as a big-endian 256-bit number, \
modulo the number of eligible entrants; the winner is the entrant at that index (counting from 0) among the eligible, in \
list order. Sequence is 1 for the first draw and one more for each redraw; eligible is the frozen list minus everyone who \
already won that week.";

/// How the canonical list is written, as the page shows it.
pub const LIST_FORMAT: &str = "UTF-8 text, every line ending in a line feed: the line \"Challenge Sync weekly lottery, \
entrant list v1\"; \"week <first day> to <last day> America/Denver\"; \"entrants <count>\"; then one line per entrant \
in increasing member id order: \"<member id> <post count> <display name>\", any control character in a name written as \
a space. The list hash is the SHA-256 of exactly that text, in lowercase hex.";

// --- the day's timetable ------------------------------------------------------------------------

/// A draw day: the Friday (unix day number) a week's draw is held on, seven days after the week
/// began.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DrawDay {
    pub friday: i64,
}

impl DrawDay {
    /// The draw for this week, held on the Friday after it.
    pub fn for_week(week: &LotteryWeek) -> Self {
        Self { friday: week.friday + 7 }
    }

    /// The week this draw is about.
    pub fn week(&self) -> LotteryWeek {
        LotteryWeek::starting(self.friday - 7)
    }

    /// Fridays never have a clock change (that is on Sundays), so local times are plain offsets.
    fn at(&self, after_midnight: i64) -> i64 {
        local_midnight(self.friday) + after_midnight
    }

    pub fn freeze_at(&self) -> i64 {
        self.at(FREEZE_AFTER_MIDNIGHT)
    }

    pub fn seed_at(&self) -> i64 {
        self.at(SEED_AFTER_MIDNIGHT)
    }

    pub fn closes_at(&self) -> i64 {
        self.at(CLOSE_AFTER_MIDNIGHT)
    }

    /// The drand round that seeds the first draw: the first published at or after 09:35:00.
    pub fn first_round(&self) -> i64 {
        round_at_or_after(self.seed_at())
    }

    /// The Friday as `YYYY-MM-DD`.
    pub fn date(&self) -> String {
        fmt_date(self.friday * 86_400)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Phase {
    /// Everyone dancing; the stars mark who is in the coming draw so far.
    Party,
    /// 09:30 – 09:35: the frozen list and its hash, waiting for the seed.
    Frozen,
    /// 09:35 – 12:00: the wheel.
    Spin,
}

impl Phase {
    pub fn as_str(&self) -> &'static str {
        match self {
            Phase::Party => "party",
            Phase::Frozen => "frozen",
            Phase::Spin => "spin",
        }
    }
}

/// Where an instant falls in the weekly cycle.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Moment {
    pub phase: Phase,
    /// The draw the page is about: today's from Friday 00:00 until 12:00, the next one after that.
    /// Its week is the one the party's stars are for.
    pub draw: DrawDay,
    /// Today's draw, when a freeze may happen now: the draw's Friday from 09:30 to midnight.
    pub freeze_window: Option<DrawDay>,
}

pub fn moment(now: i64) -> Moment {
    let today = local_day(now);
    let this = DrawDay { friday: week_start(today) };
    let freeze_window = (today == this.friday && now >= this.freeze_at()).then_some(this);
    let (phase, draw) = if now < this.freeze_at() {
        (Phase::Party, this)
    } else if now < this.seed_at() {
        (Phase::Frozen, this)
    } else if now < this.closes_at() {
        (Phase::Spin, this)
    } else {
        (Phase::Party, DrawDay { friday: this.friday + 7 })
    };
    Moment { phase, draw, freeze_window }
}

// --- the list and the pick ----------------------------------------------------------------------

/// A frozen entrant as stored in `LotteryDraw::entrants_json`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Snapshot {
    member_id: i64,
    display_name: String,
    post_count: i64,
    /// The avatar as it was at the freeze (null = the look generated from the id).
    avatar: Option<serde_json::Value>,
}

/// A name as it is written in the list: control characters (line breaks, tabs) become spaces, so
/// one entrant is always one line.
fn list_name(name: &str) -> String {
    name.chars().map(|c| if c.is_control() { ' ' } else { c }).collect()
}

/// The canonical list (see [`LIST_FORMAT`]): `entrants` as (member id, post count, name), in any
/// order; they are written in increasing member id order.
pub fn canonical_text(first_day: &str, last_day: &str, entrants: &[(i64, i64, &str)]) -> String {
    let mut sorted: Vec<&(i64, i64, &str)> = entrants.iter().collect();
    sorted.sort_by_key(|(id, _, _)| *id);
    let mut text = format!("{LIST_HEADER}\nweek {first_day} to {last_day} {TIMEZONE}\nentrants {}\n", sorted.len());
    for (id, posts, name) in sorted {
        text.push_str(&format!("{id} {posts} {}\n", list_name(name)));
    }
    text
}

/// What the pick hashes: `<list hash>:<randomness>:<sequence>`.
pub fn pick_input(list_hash: &str, randomness: &str, sequence: i64) -> String {
    format!("{list_hash}:{randomness}:{sequence}")
}

/// The winner's position among `eligible` entrants (see [`FORMULA`]) and the SHA-256 (hex) it came
/// from. `eligible` must be at least 1.
pub fn pick_index(list_hash: &str, randomness: &str, sequence: i64, eligible: usize) -> (String, usize) {
    assert!(eligible > 0, "a pick needs someone to pick");
    let digest = crate::util::sha256(pick_input(list_hash, randomness, sequence).as_bytes());
    let n = eligible as u128;
    let index = digest.iter().fold(0u128, |acc, &byte| (acc * 256 + byte as u128) % n);
    let hex: String = digest.iter().map(|b| format!("{b:02x}")).collect();
    (hex, index as usize)
}

// --- what the API returns -------------------------------------------------------------------------

#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct DrawSchedule {
    /// The Friday the draw is held, `YYYY-MM-DD`.
    pub draw_day: String,
    /// The week it covers: its Friday and Thursday, local dates.
    pub first_day: String,
    pub last_day: String,
    /// 09:30, 09:35 and 12:00 that Friday, with the offset, e.g. `2026-11-20T09:30:00-07:00`.
    pub freeze_at: String,
    pub seed_at: String,
    pub closes_at: String,
    pub freeze_at_unix: i64,
    pub seed_at_unix: i64,
    pub closes_at_unix: i64,
    /// Always `America/Denver`.
    pub timezone: String,
}

fn schedule(day: DrawDay) -> DrawSchedule {
    let period = day.week().period();
    let local = |t: i64| fmt_local(t, denver_offset(t));
    DrawSchedule {
        draw_day: day.date(),
        first_day: period.first_date(),
        last_day: period.last_date(),
        freeze_at: local(day.freeze_at()),
        seed_at: local(day.seed_at()),
        closes_at: local(day.closes_at()),
        freeze_at_unix: day.freeze_at(),
        seed_at_unix: day.seed_at(),
        closes_at_unix: day.closes_at(),
        timezone: TIMEZONE.to_string(),
    }
}

#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct DrawEntrant {
    pub member_id: i64,
    pub display_name: String,
    pub post_count: i64,
    /// Their avatar as it was at the freeze, or null for the look generated from their id.
    #[schema(required = true)]
    pub avatar: Option<Avatar>,
}

#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct DrawWinner {
    pub member_id: i64,
    /// As it was in the frozen list.
    pub display_name: String,
    pub post_count: i64,
}

#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct DrawRedraw {
    /// The admin who asked for it, by name as it was then.
    pub by_name: String,
    pub reason: String,
    /// The pick it replaced.
    pub replaces_sequence: i64,
}

#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct DrawResult {
    pub sequence: i64,
    /// When this pick was asked for (the freeze for the first, the admin's request for a redraw).
    pub requested_at: String,
    pub round: i64,
    /// When the round is published, local time with offset, and as unix seconds.
    pub round_at: String,
    pub round_at_unix: i64,
    /// `waiting` (the round's time has not come), `unavailable` (its time has come but it has not
    /// been fetched: see the draw's `seedProblem`), `drawn`, or `empty` (nobody to draw from).
    pub status: String,
    #[schema(required = true)]
    pub randomness: Option<String>,
    #[schema(required = true)]
    pub signature: Option<String>,
    /// The member ids eligible for this pick, in list order: the wheel's slices.
    pub eligible: Vec<i64>,
    /// The text hashed for the pick and its SHA-256, once drawn.
    #[schema(required = true)]
    pub pick_input: Option<String>,
    #[schema(required = true)]
    pub pick_digest: Option<String>,
    #[schema(required = true)]
    pub winner_index: Option<i64>,
    #[schema(required = true)]
    pub winner: Option<DrawWinner>,
    /// Null for the first draw.
    #[schema(required = true)]
    pub redraw: Option<DrawRedraw>,
}

#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct BeaconInfo {
    pub chain_hash: String,
    /// The chain's public parameters (key, genesis, period), to check a round independently.
    pub info_url: String,
    /// A public relay URL for this draw's current round.
    pub round_url: String,
    /// Always true: the server checks every round's BLS signature against the chain's key.
    pub signature_verified: bool,
}

#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct OfficialDraw {
    pub schedule: DrawSchedule,
    pub frozen_at: String,
    pub frozen_at_unix: i64,
    /// `cron`, `freeze-endpoint` or `safety-net` (see `LotteryDraw::frozen_by`).
    pub frozen_by: String,
    /// True when the list was frozen after its first round was published: then the seed was public
    /// before the list was fixed.
    pub frozen_late: bool,
    pub list_text: String,
    pub list_hash: String,
    pub list_format: String,
    pub formula: String,
    /// The frozen list, in list order.
    pub entrants: Vec<DrawEntrant>,
    /// Every pick, first draw first; the last one stands.
    pub results: Vec<DrawResult>,
    /// What failed the last time a due round was fetched, or null.
    #[schema(required = true)]
    pub seed_problem: Option<String>,
    pub beacon: BeaconInfo,
}

#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct PartyMember {
    pub member_id: i64,
    pub display_name: String,
    /// Original posts in the week so far; more than 0 means in the coming draw (a star). An
    /// organiser left out of the draw shows 0.
    pub post_count: i64,
    #[schema(required = true)]
    pub avatar: Option<Avatar>,
}

#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct PublicLottery {
    /// The server's clock, unix seconds (the page counts down from it, not from the viewer's).
    pub now_unix: i64,
    /// `party`, `frozen` or `spin`.
    pub phase: String,
    /// The draw the page is about now (today's until 12:00 on a Friday, the next one after).
    pub schedule: DrawSchedule,
    /// In the party: everyone (not deleted), sorted by name. Empty otherwise.
    pub party: Vec<PartyMember>,
    /// While the list is frozen and in the spin window: the draw.
    #[schema(required = true)]
    pub draw: Option<OfficialDraw>,
}

#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct PastDraws {
    /// Draws whose spin window is over, newest first (at most 52).
    pub draws: Vec<OfficialDraw>,
}

#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct FreezeOutcome {
    /// `frozen` (this call froze the list), `already-frozen`, or `not-due` (no freeze is due now).
    pub action: String,
    /// The draw's Friday, when one is due.
    #[schema(required = true)]
    pub draw_day: Option<String>,
    /// The first draw's seed: `waiting`, `unavailable` (with `seedProblem`), `drawn` or `empty`.
    #[schema(required = true)]
    pub seed: Option<String>,
    #[schema(required = true)]
    pub seed_problem: Option<String>,
    /// The next 09:30 freeze, local time with offset.
    pub next_freeze_at: String,
}

#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct RedrawAuthor {
    pub sequence: i64,
    pub member_id: i64,
}

#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct AdminDraw {
    #[serde(flatten)]
    pub draw: OfficialDraw,
    /// Who asked for each redraw, by member id (the public view has their name only).
    pub redrawn_by: Vec<RedrawAuthor>,
}

#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct AdminDraws {
    /// Every official draw, newest first.
    pub draws: Vec<AdminDraw>,
    /// The draw the public page is about now and its phase.
    pub phase: String,
    pub schedule: DrawSchedule,
}

// --- freezing -----------------------------------------------------------------------------------

/// What froze a list (`LotteryDraw::frozen_by`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Trigger {
    Cron,
    FreezeEndpoint,
    SafetyNet,
}

impl Trigger {
    pub fn as_str(&self) -> &'static str {
        match self {
            Trigger::Cron => "cron",
            Trigger::FreezeEndpoint => "freeze-endpoint",
            Trigger::SafetyNet => "safety-net",
        }
    }

    /// Who is calling the freeze URL: Vercel's cron when `CRON_SECRET` is set and the request
    /// carries it as a bearer token (as Vercel sends it), or, with no secret configured, when the
    /// user agent is Vercel's cron's. Anyone else is `freeze-endpoint`. This only labels the record.
    pub fn of_freeze_request(headers: &http::HeaderMap) -> Self {
        let header = |name: http::header::HeaderName| headers.get(name).and_then(|v| v.to_str().ok()).unwrap_or("");
        let is_cron = match std::env::var("CRON_SECRET").ok().filter(|s| !s.is_empty()) {
            Some(secret) => header(http::header::AUTHORIZATION) == format!("Bearer {secret}"),
            None => header(http::header::USER_AGENT).starts_with("vercel-cron/"),
        };
        if is_cron { Trigger::Cron } else { Trigger::FreezeEndpoint }
    }
}

async fn draw_for(db: &mut Db, week: &str) -> ApiResult<Option<LotteryDraw>> {
    Ok(LotteryDraw::filter_by_week(week).first().exec(&mut *db).await?)
}

async fn results_of(db: &mut Db, draw_id: i64) -> ApiResult<Vec<LotteryResult>> {
    let mut results = LotteryResult::filter_by_draw_id(draw_id).exec(&mut *db).await?;
    results.sort_by_key(|r| r.sequence);
    Ok(results)
}

/// The draw for `day`, frozen now if it was not yet (with its first pick), and whether this call
/// froze it. Safe to call any number of times at once.
pub async fn ensure_frozen(db: &mut Db, day: DrawDay, now: i64, trigger: Trigger) -> ApiResult<(LotteryDraw, bool)> {
    let week = day.week();
    let key = week.start_date();
    let mut created = false;
    let draw = match draw_for(db, &key).await? {
        Some(draw) => draw,
        None => {
            let period = lottery_entrants(db, LotterySelection::Week(week), now).await?;
            let mut snapshot: Vec<Snapshot> = period
                .entrants
                .into_iter()
                .map(|e| Snapshot {
                    member_id: e.member_id,
                    display_name: e.display_name,
                    post_count: e.post_count as i64,
                    avatar: e.avatar.as_ref().map(|a| serde_json::to_value(a).expect("an Avatar always serializes")),
                })
                .collect();
            snapshot.sort_by_key(|e| e.member_id);
            let lines: Vec<(i64, i64, &str)> =
                snapshot.iter().map(|e| (e.member_id, e.post_count, e.display_name.as_str())).collect();
            let text = canonical_text(&period.first_day, &period.last_day, &lines);
            let hash = sha256_hex(text.as_bytes());
            let insert = toasty::create!(LotteryDraw {
                week: &key,
                frozen_at: now,
                frozen_by: trigger.as_str(),
                list_text: &text,
                list_hash: &hash,
                entrants_json: serde_json::to_string(&snapshot).expect("a snapshot always serializes"),
            })
            .exec(&mut *db)
            .await;
            match insert {
                Ok(draw) => {
                    created = true;
                    draw
                }
                // Most likely another request froze it a moment ago (the unique index on week):
                // use that one. If there is still none, the insert failed for another reason.
                Err(error) => match draw_for(db, &key).await? {
                    Some(draw) => draw,
                    None => return Err(error.into()),
                },
            }
        }
    };
    // The first pick is written right after the draw; a crash in between is repaired here.
    if results_of(db, draw.id).await?.is_empty() {
        let round = day.first_round();
        let insert = toasty::create!(LotteryResult {
            draw_id: draw.id,
            sequence: 1,
            requested_at: draw.frozen_at,
            round,
            round_at: round_time(round),
            randomness: None,
            signature: None,
            seeded_at: None,
            eligible_count: None,
            winner_index: None,
            winner_member_id: None,
            winner_name: None,
            winner_post_count: None,
            redrawn_by_id: None,
            redrawn_by_name: None,
            reason: None,
        })
        .exec(&mut *db)
        .await;
        if let Err(error) = insert
            && results_of(db, draw.id).await?.is_empty()
        {
            return Err(error.into());
        }
    }
    Ok((draw, created))
}

fn snapshot_of(draw: &LotteryDraw) -> ApiResult<Vec<Snapshot>> {
    serde_json::from_str(&draw.entrants_json).map_err(|error| {
        tracing::error!(week = %draw.week, %error, "a frozen lottery list does not parse");
        ApiError::new(http::StatusCode::INTERNAL_SERVER_ERROR, format!("the frozen list for week {} is unreadable", draw.week))
    })
}

/// The entrants eligible for pick `sequence`: the list minus the winners of the earlier picks.
fn eligible_for(snapshot: &[Snapshot], results: &[LotteryResult], sequence: i64) -> Vec<i64> {
    let won: HashSet<i64> =
        results.iter().filter(|r| r.sequence < sequence).filter_map(|r| r.winner_member_id).collect();
    snapshot.iter().map(|e| e.member_id).filter(|id| !won.contains(id)).collect()
}

/// Fetch and store the seed of every pick whose round's time has come, in order, and work out its
/// winner. Returns what failed, if a fetch did (the rest wait for the next request).
pub async fn ensure_seeds(db: &mut Db, draw: &LotteryDraw, results: &mut [LotteryResult], now: i64) -> ApiResult<Option<String>> {
    let snapshot = snapshot_of(draw)?;
    for i in 0..results.len() {
        if results[i].randomness.is_some() || results[i].round_at > now {
            continue;
        }
        // Nobody in the list: there is nothing to seed.
        if snapshot.is_empty() {
            continue;
        }
        // An earlier pick without a winner yet: this one has to wait for it.
        if results[..i].iter().any(|r| r.winner_member_id.is_none()) {
            break;
        }
        let round = results[i].round;
        let beacon = match beacon::fetch(round).await {
            Ok(beacon) => beacon,
            Err(why) => return Ok(Some(format!("fetching drand round {round} failed: {why}"))),
        };
        let eligible = eligible_for(&snapshot, results, results[i].sequence);
        let (index, winner) = if eligible.is_empty() {
            (None, None)
        } else {
            let (_, index) = pick_index(&draw.list_hash, &beacon.randomness, results[i].sequence, eligible.len());
            let id = eligible[index];
            (Some(index as i64), snapshot.iter().find(|e| e.member_id == id))
        };
        let result = &mut results[i];
        toasty::update!(LotteryResult::filter_by_id(result.id) {
            randomness: Some(beacon.randomness.clone()),
            signature: Some(beacon.signature.clone()),
            seeded_at: Some(now),
            eligible_count: Some(eligible.len() as i64),
            winner_index: index,
            winner_member_id: winner.map(|w| w.member_id),
            winner_name: winner.map(|w| w.display_name.clone()),
            winner_post_count: winner.map(|w| w.post_count),
        })
        .exec(&mut *db)
        .await?;
        result.randomness = Some(beacon.randomness);
        result.signature = Some(beacon.signature);
        result.seeded_at = Some(now);
        result.eligible_count = Some(eligible.len() as i64);
        result.winner_index = index;
        result.winner_member_id = winner.map(|w| w.member_id);
        result.winner_name = winner.map(|w| w.display_name.clone());
        result.winner_post_count = winner.map(|w| w.post_count);
    }
    Ok(None)
}

// --- views ----------------------------------------------------------------------------------------

fn local(t: i64) -> String {
    fmt_local(t, denver_offset(t))
}

fn result_view(draw: &LotteryDraw, snapshot: &[Snapshot], results: &[LotteryResult], r: &LotteryResult, now: i64) -> DrawResult {
    let eligible = eligible_for(snapshot, results, r.sequence);
    let status = if snapshot.is_empty() {
        "empty"
    } else if r.randomness.is_some() {
        "drawn"
    } else if r.round_at > now {
        "waiting"
    } else {
        "unavailable"
    };
    let pick = r.randomness.as_deref().filter(|_| !eligible.is_empty()).map(|randomness| {
        let input = pick_input(&draw.list_hash, randomness, r.sequence);
        let (digest, _) = pick_index(&draw.list_hash, randomness, r.sequence, eligible.len());
        (input, digest)
    });
    DrawResult {
        sequence: r.sequence,
        requested_at: local(r.requested_at),
        round: r.round,
        round_at: local(r.round_at),
        round_at_unix: r.round_at,
        status: status.to_string(),
        randomness: r.randomness.clone(),
        signature: r.signature.clone(),
        eligible,
        pick_input: pick.as_ref().map(|(input, _)| input.clone()),
        pick_digest: pick.map(|(_, digest)| digest),
        winner_index: r.winner_index,
        winner: match (r.winner_member_id, &r.winner_name) {
            (Some(member_id), Some(name)) => Some(DrawWinner {
                member_id,
                display_name: name.clone(),
                post_count: r.winner_post_count.unwrap_or(0),
            }),
            _ => None,
        },
        redraw: (r.sequence > 1).then(|| DrawRedraw {
            by_name: r.redrawn_by_name.clone().unwrap_or_default(),
            reason: r.reason.clone().unwrap_or_default(),
            replaces_sequence: r.sequence - 1,
        }),
    }
}

fn draw_view(draw: &LotteryDraw, results: &[LotteryResult], seed_problem: Option<String>, now: i64) -> ApiResult<OfficialDraw> {
    let snapshot = snapshot_of(draw)?;
    let day = DrawDay::for_week(&LotteryWeek::starting(
        crate::util::parse_date(&draw.week).map(|t| t / 86_400).unwrap_or_default(),
    ));
    let first_round_at = results.first().map(|r| r.round_at).unwrap_or(round_time(day.first_round()));
    let current_round = results.last().map(|r| r.round).unwrap_or(day.first_round());
    Ok(OfficialDraw {
        schedule: schedule(day),
        frozen_at: local(draw.frozen_at),
        frozen_at_unix: draw.frozen_at,
        frozen_by: draw.frozen_by.clone(),
        frozen_late: draw.frozen_at >= first_round_at,
        list_text: draw.list_text.clone(),
        list_hash: draw.list_hash.clone(),
        list_format: LIST_FORMAT.to_string(),
        formula: FORMULA.to_string(),
        entrants: snapshot
            .iter()
            .map(|e| DrawEntrant {
                member_id: e.member_id,
                display_name: e.display_name.clone(),
                post_count: e.post_count,
                // Checked again on the way out, like a member's own saved avatar.
                avatar: e.avatar.as_ref().and_then(|value| avatar::validate(value).ok()),
            })
            .collect(),
        results: results.iter().map(|r| result_view(draw, &snapshot, results, r, now)).collect(),
        seed_problem,
        beacon: BeaconInfo {
            chain_hash: beacon::CHAIN_HASH.to_string(),
            info_url: beacon::INFO_URL.to_string(),
            round_url: format!("{}/{}/public/{current_round}", beacon::DEFAULT_RELAYS[0], beacon::CHAIN_HASH),
            signature_verified: true,
        },
    })
}

/// A draw with its picks, the due seeds fetched.
async fn load_view(db: &mut Db, draw: &LotteryDraw, now: i64) -> ApiResult<OfficialDraw> {
    let mut results = results_of(db, draw.id).await?;
    let problem = ensure_seeds(db, draw, &mut results, now).await?;
    draw_view(draw, &results, problem, now)
}

// --- the operations the routes call -----------------------------------------------------------

/// `GET /api/lottery`: the page's whole state now. Freezes today's list if it is due (the safety
/// net) and fetches a due seed.
pub async fn public_lottery(db: &mut Db, now: i64) -> ApiResult<PublicLottery> {
    let m = moment(now);
    if let Some(day) = m.freeze_window {
        ensure_frozen(db, day, now, Trigger::SafetyNet).await?;
    }
    let (party, draw) = match m.phase {
        Phase::Party => (party(db, m.draw, now).await?, None),
        Phase::Frozen | Phase::Spin => {
            let key = m.draw.week().start_date();
            let draw = draw_for(db, &key).await?.ok_or_else(|| {
                ApiError::new(http::StatusCode::INTERNAL_SERVER_ERROR, format!("the draw for week {key} was not frozen"))
            })?;
            (Vec::new(), Some(load_view(db, &draw, now).await?))
        }
    };
    Ok(PublicLottery { now_unix: now, phase: m.phase.as_str().to_string(), schedule: schedule(m.draw), party, draw })
}

/// Everyone not deleted, sorted by name, with their original posts so far in the week `draw`
/// covers when they are in it.
async fn party(db: &mut Db, draw: DrawDay, now: i64) -> ApiResult<Vec<PartyMember>> {
    let period = lottery_entrants(db, LotterySelection::Week(draw.week()), now).await?;
    let mut people: Vec<PartyMember> = period
        .entrants
        .into_iter()
        .map(|e| PartyMember { member_id: e.member_id, display_name: e.display_name, post_count: e.post_count as i64, avatar: e.avatar })
        .chain(period.audience.into_iter().map(|a| PartyMember {
            member_id: a.member_id,
            display_name: a.display_name,
            post_count: 0,
            avatar: a.avatar,
        }))
        .collect();
    // People who joined after the week began are still at the party.
    let listed: HashSet<i64> = people.iter().map(|p| p.member_id).collect();
    for member in Member::all().exec(&mut *db).await? {
        if !member.is_deleted() && !listed.contains(&member.id) {
            people.push(PartyMember {
                avatar: avatar::member_avatar(&member),
                member_id: member.id,
                display_name: member.display_name,
                post_count: 0,
            });
        }
    }
    people.sort_by(|a, b| crate::lottery::by_name((&a.display_name, a.member_id), (&b.display_name, b.member_id)));
    Ok(people)
}

/// `GET /api/lottery/results`: draws whose spin window is over, newest first.
pub async fn past_draws(db: &mut Db, now: i64) -> ApiResult<PastDraws> {
    if let Some(day) = moment(now).freeze_window {
        ensure_frozen(db, day, now, Trigger::SafetyNet).await?;
    }
    let mut draws: Vec<LotteryDraw> = LotteryDraw::all()
        .exec(&mut *db)
        .await?
        .into_iter()
        .filter(|d| draw_day_of(d).is_some_and(|day| day.closes_at() <= now))
        .collect();
    draws.sort_by(|a, b| b.week.cmp(&a.week));
    draws.truncate(PAST_LIMIT);
    let mut out = Vec::with_capacity(draws.len());
    for draw in &draws {
        out.push(load_view(db, draw, now).await?);
    }
    Ok(PastDraws { draws: out })
}

fn draw_day_of(draw: &LotteryDraw) -> Option<DrawDay> {
    crate::util::parse_date(&draw.week).map(|t| DrawDay { friday: t / 86_400 + 7 })
}

/// `GET /api/lottery/freeze`: freeze today's list if it is due, and fetch its seed if that is due.
/// Takes no input; calling it at any other time changes nothing.
pub async fn freeze_if_due(db: &mut Db, now: i64, trigger: Trigger) -> ApiResult<FreezeOutcome> {
    let m = moment(now);
    let next = if now < m.draw.freeze_at() { m.draw } else { DrawDay { friday: m.draw.friday + 7 } };
    let next_freeze_at = local(next.freeze_at());
    let Some(day) = m.freeze_window else {
        return Ok(FreezeOutcome { action: "not-due".into(), draw_day: None, seed: None, seed_problem: None, next_freeze_at });
    };
    let (draw, created) = ensure_frozen(db, day, now, trigger).await?;
    let view = load_view(db, &draw, now).await?;
    Ok(FreezeOutcome {
        action: if created { "frozen" } else { "already-frozen" }.into(),
        draw_day: Some(day.date()),
        seed: view.results.first().map(|r| r.status.clone()),
        seed_problem: view.seed_problem,
        next_freeze_at,
    })
}

/// `GET /api/admin/lottery/draws`: every official draw, newest first, with who redrew.
pub async fn admin_draws(db: &mut Db, now: i64) -> ApiResult<AdminDraws> {
    let m = moment(now);
    if let Some(day) = m.freeze_window {
        ensure_frozen(db, day, now, Trigger::SafetyNet).await?;
    }
    let mut draws = LotteryDraw::all().exec(&mut *db).await?;
    draws.sort_by(|a, b| b.week.cmp(&a.week));
    let mut out = Vec::with_capacity(draws.len());
    for draw in &draws {
        out.push(admin_view(db, draw, now).await?);
    }
    Ok(AdminDraws { draws: out, phase: m.phase.as_str().to_string(), schedule: schedule(m.draw) })
}

async fn admin_view(db: &mut Db, draw: &LotteryDraw, now: i64) -> ApiResult<AdminDraw> {
    let mut results = results_of(db, draw.id).await?;
    let problem = ensure_seeds(db, draw, &mut results, now).await?;
    let redrawn_by = results
        .iter()
        .filter_map(|r| r.redrawn_by_id.map(|member_id| RedrawAuthor { sequence: r.sequence, member_id }))
        .collect();
    Ok(AdminDraw { draw: draw_view(draw, &results, problem, now)?, redrawn_by })
}

/// `POST /api/admin/lottery/draws/{week}/redraw`: a new pick for the week, by `admin`, for
/// `reason`. See the module docs for the rules; every refusal says which one.
pub async fn redraw(db: &mut Db, week: &str, admin: &Member, reason: &str, now: i64) -> ApiResult<AdminDraw> {
    let reason = reason.trim();
    if reason.is_empty() {
        return Err(ApiError::bad_request("a reason is required for a redraw; it is shown publicly with the result"));
    }
    let length = reason.chars().count();
    if length > REASON_MAX_CHARS {
        return Err(ApiError::bad_request(format!(
            "the reason is {length} characters long; the longest allowed is {REASON_MAX_CHARS}"
        )));
    }
    let draw = draw_for(db, week).await?.ok_or_else(|| {
        ApiError::not_found(format!(
            "there is no official draw for the week starting {week}; a week's list is frozen at 09:30 on the Friday after it"
        ))
    })?;
    let mut results = results_of(db, draw.id).await?;
    let problem = ensure_seeds(db, &draw, &mut results, now).await?;
    let snapshot = snapshot_of(&draw)?;
    if snapshot.is_empty() {
        return Err(ApiError::conflict("nobody was in this week's draw, so there is no winner to redraw"));
    }
    let Some(last) = results.last() else {
        return Err(ApiError::conflict("this week's draw has no first pick yet; reload and try again"));
    };
    if last.winner_member_id.is_none() {
        let why = match problem {
            Some(problem) => format!("its seed could not be fetched: {problem}"),
            None if last.round_at > now => format!("its seed, drand round {}, is published at {}", last.round, local(last.round_at)),
            None => format!("its seed, drand round {}, has not been fetched yet", last.round),
        };
        return Err(ApiError::conflict(format!(
            "pick {} of this week has no winner yet ({why}); a redraw can only replace a drawn winner",
            last.sequence
        )));
    }
    let won = results.iter().filter(|r| r.winner_member_id.is_some()).count();
    if won >= snapshot.len() {
        return Err(ApiError::conflict(format!(
            "every entrant in this draw has already won ({won} of {}); there is nobody left to draw",
            snapshot.len()
        )));
    }
    let sequence = last.sequence + 1;
    let round = round_at_or_after(now + REDRAW_SEED_DELAY);
    let insert = toasty::create!(LotteryResult {
        draw_id: draw.id,
        sequence,
        requested_at: now,
        round,
        round_at: round_time(round),
        randomness: None,
        signature: None,
        seeded_at: None,
        eligible_count: None,
        winner_index: None,
        winner_member_id: None,
        winner_name: None,
        winner_post_count: None,
        redrawn_by_id: Some(admin.id),
        redrawn_by_name: Some(admin.display_name.clone()),
        reason: Some(reason.to_string()),
    })
    .exec(&mut *db)
    .await;
    if let Err(error) = insert {
        // The unique (draw, sequence) index: someone else's redraw got this number first.
        if results_of(db, draw.id).await?.iter().any(|r| r.sequence == sequence) {
            return Err(ApiError::conflict(format!(
                "another redraw of this week was just recorded as pick {sequence}; reload to see it before redrawing again"
            )));
        }
        return Err(error.into());
    }
    admin_view(db, &draw, now).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::util::parse_iso8601;

    fn utc(value: &str) -> i64 {
        parse_iso8601(value).expect("valid test timestamp")
    }

    fn at(value: &str) -> Moment {
        moment(utc(value))
    }

    #[test]
    fn the_phases_change_at_930_935_and_noon_denver_time() {
        // Friday 2026-11-20 (MST, -07:00): 09:30 = 16:30Z, 09:35 = 16:35Z, 12:00 = 19:00Z.
        let today = DrawDay { friday: utc("2026-11-20T00:00:00Z") / 86_400 };
        let next = DrawDay { friday: today.friday + 7 };
        assert_eq!(today.week().start_date(), "2026-11-13");
        let cases = [
            ("2026-11-20T06:59:59Z", Phase::Party, today), // Thursday 23:59:59: tomorrow's draw, this week's stars
            ("2026-11-20T07:00:00Z", Phase::Party, today), // Friday 00:00: today's draw, last week's stars
            ("2026-11-20T16:29:59Z", Phase::Party, today),
            ("2026-11-20T16:30:00Z", Phase::Frozen, today),
            ("2026-11-20T16:34:59Z", Phase::Frozen, today),
            ("2026-11-20T16:35:00Z", Phase::Spin, today),
            ("2026-11-20T18:59:59Z", Phase::Spin, today),
            ("2026-11-20T19:00:00Z", Phase::Party, next), // noon: the week in progress
            ("2026-11-24T12:00:00Z", Phase::Party, next),
        ];
        for (when, phase, draw) in cases {
            let m = at(when);
            assert_eq!((m.phase, m.draw), (phase, draw), "{when}");
        }
        assert_eq!(next.week().start_date(), "2026-11-20");
        // A freeze may happen on the Friday from 09:30 to midnight, and only then.
        assert_eq!(at("2026-11-20T16:29:59Z").freeze_window, None);
        assert_eq!(at("2026-11-20T16:30:00Z").freeze_window, Some(today));
        assert_eq!(at("2026-11-21T06:59:59Z").freeze_window, Some(today));
        assert_eq!(at("2026-11-21T07:00:00Z").freeze_window, None);
    }

    #[test]
    fn the_times_follow_daylight_saving_time() {
        // Friday 2026-03-13, the day after the spring-forward week (MDT, -06:00): 09:30 = 15:30Z.
        assert_eq!(at("2026-03-13T15:29:59Z").phase, Phase::Party);
        assert_eq!(at("2026-03-13T15:30:00Z").phase, Phase::Frozen);
        assert_eq!(at("2026-03-13T15:35:00Z").phase, Phase::Spin);
        assert_eq!(at("2026-03-13T17:59:59Z").phase, Phase::Spin);
        assert_eq!(at("2026-03-13T18:00:00Z").phase, Phase::Party);
        let day = at("2026-03-13T15:30:00Z").draw;
        assert_eq!(day.week().start_date(), "2026-03-06");
        assert_eq!(day.week().hours(), 167);
        assert_eq!(schedule(day).freeze_at, "2026-03-13T09:30:00-06:00");
        // Friday 2026-11-06, after the fall-back week (MST, -07:00): 09:30 = 16:30Z.
        assert_eq!(at("2026-11-06T16:29:59Z").phase, Phase::Party);
        assert_eq!(at("2026-11-06T16:30:00Z").phase, Phase::Frozen);
        let day = at("2026-11-06T16:30:00Z").draw;
        assert_eq!(day.week().hours(), 169);
        assert_eq!(schedule(day).seed_at, "2026-11-06T09:35:00-07:00");
        assert_eq!(schedule(day).closes_at, "2026-11-06T12:00:00-07:00");
        // The seed round is the first at or after 09:35:00.
        assert!(round_time(day.first_round()) >= day.seed_at());
        assert!(round_time(day.first_round()) < day.seed_at() + beacon::PERIOD);
        assert!(round_time(day.first_round() - 1) < day.seed_at());
    }

    #[test]
    fn the_canonical_list_is_fixed_text_in_member_id_order() {
        let text = canonical_text(
            "2026-11-13",
            "2026-11-19",
            &[(42, 1, "Zoë Line\nBreak"), (7, 3, "Ada Lovelace"), (19, 2, "bob\tTab")],
        );
        assert_eq!(
            text,
            "Challenge Sync weekly lottery, entrant list v1\n\
             week 2026-11-13 to 2026-11-19 America/Denver\n\
             entrants 3\n\
             7 3 Ada Lovelace\n\
             19 2 bob Tab\n\
             42 1 Zoë Line Break\n"
        );
        // Computed independently (Python's hashlib) from the same text.
        assert_eq!(sha256_hex(text.as_bytes()), "edbde4483ba8c06833ca673470cf943933f1105cba740c94dc507ce1eb9d7ad2");
        let empty = canonical_text("2026-10-16", "2026-10-22", &[]);
        assert_eq!(empty, "Challenge Sync weekly lottery, entrant list v1\nweek 2026-10-16 to 2026-10-22 America/Denver\nentrants 0\n");
    }

    #[test]
    fn sha256_matches_the_standard_test_vectors() {
        assert_eq!(sha256_hex(b""), "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
        assert_eq!(sha256_hex(b"abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    }

    #[test]
    fn the_winner_formula_gives_fixed_answers() {
        let hash = "edbde4483ba8c06833ca673470cf943933f1105cba740c94dc507ce1eb9d7ad2";
        let randomness = "fe290beca10872ef2fb164d2aa4442de4566183ec51c56ff3cd603d930e54fdd";
        assert_eq!(pick_input(hash, randomness, 1), format!("{hash}:{randomness}:1"));
        // Vectors computed independently with Python: int(sha256(input).hexdigest(), 16) % n.
        let (digest, index) = pick_index(hash, randomness, 1, 3);
        assert_eq!(digest, "882bed1b4097b3bebc702fdd4459c39da304ae62e50b3f60e7751b75a10a58ff");
        assert_eq!(index, 0);
        assert_eq!(pick_index(hash, randomness, 1, 7).1, 1);
        assert_eq!(pick_index(hash, randomness, 1, 40).1, 23);
        assert_eq!(pick_index(hash, randomness, 1, 1_000_003).1, 385_692);
        let (digest, index) = pick_index(hash, randomness, 2, 5);
        assert_eq!(digest, "20ed8e03609f2facafbc9b98e593713187d63e63246320fc82145b275a7e763c");
        assert_eq!(index, 4);
        assert_eq!(pick_index(hash, randomness, 3, 40).1, 12);
        assert_eq!(pick_index(hash, randomness, 1, 1).1, 0, "one entrant always wins");
    }
}
