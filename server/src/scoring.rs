//! Scoring is fully derived from snapshots at read time — nothing is precomputed or stored.
//!
//! Per member, per competition window, three buckets (the "three ways to score"):
//!  * **Show up**: `per_post` points for each in-window post, at most `max_posts_per_week` a week.
//!  * **Keep showing up**: `per_active_week` for every week with at least one post, plus one streak
//!    bonus — `streak_long_bonus` once the best run of consecutive active weeks reaches
//!    `streak_long_weeks`, otherwise `streak_short_bonus` at `streak_short_weeks`.
//!  * **Engagement**: each post's reactions/comments/reposts/... are priced by the `per_*` rates.
//!    A post counts fully up to `engagement_cap` and then keeps earning at
//!    `engagement_over_cap_rate`, so a post that goes big still counts for more. Only the best
//!    `max_posts_per_week` posts a week count, and the sum is optionally scaled by
//!    `follower_baseline / follower_count` so audience size doesn't decide the board.
//!
//! Profile points (followers gained, profile views) remain available for challenges that price
//! them; the LinkedIn Cup rules leave those rates at zero.

use std::collections::HashMap;

use serde::{Deserialize, Serialize};
use toasty::Db;

use crate::models::{
    ChallengeMembership, Competition, Member, Post, PostComment, PostSnapshot, ProfileSnapshot,
};
use crate::util::now_unix;

pub const WEEK_SECONDS: i64 = 7 * 86400;

/// Per-competition scoring parameters, stored as typed columns on the `Competition` row.
#[derive(Debug, Clone, Serialize, Deserialize, utoipa::ToSchema)]
#[serde(default, rename_all = "camelCase")]
pub struct ScoringConfig {
    /// Posts beyond this many per week don't score (only the highest-scoring ones count).
    #[schema(required)]
    pub max_posts_per_week: u32,
    /// "Show up": points for each post, up to `max_posts_per_week` a week.
    #[schema(required)]
    pub per_post: f64,
    /// "Keep showing up": points for every week with at least one post.
    #[schema(required)]
    pub per_active_week: f64,
    #[schema(required)]
    pub streak_short_weeks: u32,
    #[schema(required)]
    pub streak_short_bonus: f64,
    #[schema(required)]
    pub streak_long_weeks: u32,
    #[schema(required)]
    pub streak_long_bonus: f64,
    #[schema(required)]
    pub per_reaction: f64,
    #[schema(required)]
    pub per_comment: f64,
    #[schema(required)]
    pub per_repost: f64,
    /// A "send" is a private share — high intent, so usually worth more than a public repost.
    #[schema(required)]
    pub per_send: f64,
    #[schema(required)]
    pub per_save: f64,
    #[schema(required)]
    pub per_impression: f64,
    /// A post's engagement counts fully up to this many points; 0 means no cap.
    #[schema(required)]
    pub engagement_cap: f64,
    /// Rate at which engagement beyond the cap keeps earning (0.5 = half rate).
    #[schema(required)]
    pub engagement_over_cap_rate: f64,
    #[schema(required)]
    pub per_follower_gained: f64,
    #[schema(required)]
    pub per_profile_view: f64,
    /// If true, engagement points are scaled by `follower_baseline / follower_count`.
    #[schema(required)]
    pub normalize_by_followers: bool,
    #[schema(required)]
    pub follower_baseline: i64,
    /// Prize money, in whole dollars; 0 hides the prize.
    #[schema(required)]
    pub prize_first: i64,
    #[schema(required)]
    pub prize_second: i64,
    #[schema(required)]
    pub prize_third: i64,
    /// Guaranteed to everyone who posts `participation_posts` times or more in the window.
    #[schema(required)]
    pub prize_participation: i64,
    #[schema(required)]
    pub participation_posts: i64,
}

impl Default for ScoringConfig {
    /// The LinkedIn Cup rules: show up, keep showing up, earn engagement.
    fn default() -> Self {
        Self {
            max_posts_per_week: 3,
            per_post: 10.0,
            per_active_week: 20.0,
            streak_short_weeks: 4,
            streak_short_bonus: 25.0,
            streak_long_weeks: 8,
            streak_long_bonus: 75.0,
            per_reaction: 0.2,
            per_comment: 5.0,
            per_repost: 0.0,
            per_send: 0.0,
            per_save: 0.0,
            per_impression: 0.0,
            engagement_cap: 150.0,
            engagement_over_cap_rate: 0.5,
            per_follower_gained: 0.0,
            per_profile_view: 0.0,
            normalize_by_followers: true,
            follower_baseline: 1000,
            prize_first: 2500,
            prize_second: 1500,
            prize_third: 1000,
            prize_participation: 250,
            participation_posts: 20,
        }
    }
}

impl ScoringConfig {
    /// Read the rules off a competition row. The columns are the storage; this struct is the wire
    /// and compute shape.
    pub fn from_competition(c: &Competition) -> Self {
        Self {
            max_posts_per_week: c.max_posts_per_week.clamp(0, u32::MAX as i64) as u32,
            per_post: c.per_post,
            per_active_week: c.per_active_week,
            streak_short_weeks: c.streak_short_weeks.clamp(0, u32::MAX as i64) as u32,
            streak_short_bonus: c.streak_short_bonus,
            streak_long_weeks: c.streak_long_weeks.clamp(0, u32::MAX as i64) as u32,
            streak_long_bonus: c.streak_long_bonus,
            per_reaction: c.per_reaction,
            per_comment: c.per_comment,
            per_repost: c.per_repost,
            per_send: c.per_send,
            per_save: c.per_save,
            per_impression: c.per_impression,
            engagement_cap: c.engagement_cap,
            engagement_over_cap_rate: c.engagement_over_cap_rate,
            per_follower_gained: c.per_follower_gained,
            per_profile_view: c.per_profile_view,
            normalize_by_followers: c.normalize_by_followers,
            follower_baseline: c.follower_baseline,
            prize_first: c.prize_first,
            prize_second: c.prize_second,
            prize_third: c.prize_third,
            prize_participation: c.prize_participation,
            participation_posts: c.participation_posts,
        }
    }

    /// Raw engagement points for one post, before the cap and before follower scaling.
    pub fn raw_engagement(&self, e: &Engagement) -> f64 {
        e.reactions as f64 * self.per_reaction
            + e.comments as f64 * self.per_comment
            + e.reposts as f64 * self.per_repost
            + e.sends as f64 * self.per_send
            + e.saves as f64 * self.per_save
            + e.impressions as f64 * self.per_impression
    }

    /// Engagement points for one post after the cap: full value up to `engagement_cap`, then the
    /// remainder at `engagement_over_cap_rate`.
    pub fn post_engagement(&self, e: &Engagement) -> f64 {
        let raw = self.raw_engagement(e);
        if self.engagement_cap <= 0.0 || raw <= self.engagement_cap {
            raw
        } else {
            self.engagement_cap + (raw - self.engagement_cap) * self.engagement_over_cap_rate
        }
    }

    /// The streak bonus earned by a best run of `best_streak` consecutive active weeks.
    pub fn streak_bonus(&self, best_streak: u32) -> f64 {
        if self.streak_long_weeks > 0 && best_streak >= self.streak_long_weeks {
            self.streak_long_bonus
        } else if self.streak_short_weeks > 0 && best_streak >= self.streak_short_weeks {
            self.streak_short_bonus
        } else {
            0.0
        }
    }

    /// The multiplier applied to engagement points for an account with this many followers.
    pub fn follower_factor(&self, followers: i64) -> f64 {
        if self.normalize_by_followers && followers > 0 && self.follower_baseline > 0 {
            self.follower_baseline as f64 / followers as f64
        } else {
            1.0
        }
    }

    /// Number of scoring weeks in a window (the last, partial week counts).
    pub fn weeks_in(start_at: i64, end_at: i64) -> i64 {
        ((end_at - start_at).max(0) / WEEK_SECONDS) + 1
    }
}

/// The engagement counts scoring prices, taken from a post's latest snapshot with comments
/// replaced by the ones other people wrote whenever we have read them.
#[derive(Debug, Clone, Copy, Default)]
pub struct Engagement {
    pub reactions: i64,
    pub comments: i64,
    pub reposts: i64,
    pub sends: i64,
    pub saves: i64,
    pub impressions: i64,
}

/// Choose the competition to display: prefer an active one whose window contains `now`, then any
/// active one, then the most recent overall; latest `start_at` breaks ties. Consumes the vec so we
/// don't require `Clone` on the model (Toasty models hold non-Clone `Deferred` fields).
pub fn active_competition(comps: Vec<Competition>, now: i64) -> Option<Competition> {
    let mut best: Option<(u8, i64, Competition)> = None;
    for c in comps {
        let priority = if c.is_active && c.start_at <= now && now <= c.end_at {
            2
        } else if c.is_active {
            1
        } else {
            0
        };
        let key = (priority, c.start_at);
        let replace = match &best {
            Some((bp, bs, _)) => key >= (*bp, *bs),
            None => true,
        };
        if replace {
            best = Some((priority, c.start_at, c));
        }
    }
    best.map(|(_, _, c)| c)
}

/// One member's standing in a competition.
#[derive(Debug, Clone)]
pub struct Standing {
    pub followers_unknown: bool,
    pub member_id: i64,
    pub display_name: String,
    pub profile_url: Option<String>,
    pub follower_count: i64,
    /// Followers gained across the window (latest in-window reading minus the first).
    pub follower_growth: i64,
    pub show_up_points: f64,
    pub consistency_points: f64,
    pub engagement_points: f64,
    /// `show_up + engagement` — the post-derived part of the score.
    pub post_points: f64,
    pub profile_points: f64,
    pub total: f64,
    /// Points earned in the current scoring week (show up + active week + engagement of this
    /// week's posts). Streak bonuses are excluded because they belong to the whole run.
    pub week_points: f64,
    pub graded_posts: usize,
    pub total_posts: usize,
    pub active_weeks: u32,
    /// Consecutive active weeks ending at the current (or, if it is quiet so far, previous) week.
    pub streak_weeks: u32,
    pub best_streak_weeks: u32,
}

/// Everything scoring reads, fetched in a fixed handful of queries and indexed in memory.
///
/// The naive shape — one query per member, then several per post — costs a round trip each,
/// which is nothing against a local file and 20–40 seconds against a remote Postgres. Loading
/// each table once for the members in question keeps a board at six queries regardless of size.
#[derive(Default)]
pub struct Dataset {
    pub members: HashMap<i64, Member>,
    pub posts_by_member: HashMap<i64, Vec<Post>>,
    /// Sorted by `captured_at` ascending.
    pub snapshots_by_post: HashMap<i64, Vec<PostSnapshot>>,
    pub comments_by_post: HashMap<i64, Vec<PostComment>>,
    /// Sorted by `captured_at` ascending.
    pub profile_by_member: HashMap<i64, Vec<ProfileSnapshot>>,
}

impl Dataset {
    /// Load the members with these ids and all of their posts, snapshots, comments, and profile
    /// readings. Five queries, or none when `member_ids` is empty.
    ///
    /// Deleted accounts are left out, with all their data, so boards, standings, member counts
    /// and company totals drop them while their challenge memberships stay for a restore.
    pub async fn load(db: &mut Db, member_ids: &[i64]) -> toasty::Result<Self> {
        let mut data = Self::default();
        if member_ids.is_empty() {
            return Ok(data);
        }

        for member in Member::filter(Member::fields().id().in_list(member_ids.to_vec()))
            .exec(&mut *db)
            .await?
        {
            if !member.is_deleted() {
                data.members.insert(member.id, member);
            }
        }
        let ids: Vec<i64> = data.members.keys().copied().collect();
        if ids.is_empty() {
            return Ok(data);
        }

        let posts = Post::filter(Post::fields().member_id().in_list(ids.clone()))
            .exec(&mut *db)
            .await?;
        let post_ids: Vec<i64> = posts.iter().map(|p| p.id).collect();
        for post in posts {
            data.posts_by_member.entry(post.member_id).or_default().push(post);
        }

        if !post_ids.is_empty() {
            data.load_snapshots(db, post_ids.clone()).await?;
            for comment in
                PostComment::filter(PostComment::fields().post_id().in_list(post_ids))
                    .exec(&mut *db)
                    .await?
            {
                data.comments_by_post.entry(comment.post_id).or_default().push(comment);
            }
        }

        let mut profiles =
            ProfileSnapshot::filter(ProfileSnapshot::fields().member_id().in_list(ids))
                .exec(&mut *db)
                .await?;
        // Multiple syncs can land in the same second; insertion order breaks ties.
        profiles.sort_by_key(|p| (p.captured_at, p.id));
        for profile in profiles {
            data.profile_by_member.entry(profile.member_id).or_default().push(profile);
        }
        Ok(data)
    }

    /// Load the posts published in `[start, end)` (optionally one member's), only those posts'
    /// snapshots, and their authors — for reports across everyone, where loading every member's
    /// whole history (as [`Dataset::load`] does) would read most of `post_snapshots`. Comments and
    /// profile readings are not loaded. Three queries.
    ///
    /// Unlike [`Dataset::load`], deleted authors are kept: a report on a past week must not change
    /// because someone left afterwards.
    ///
    /// A post stored without a creation time (0) is dated by its first snapshot, as
    /// [`Dataset::posted_at`] does everywhere else, so those are fetched too and then dropped
    /// unless that first snapshot falls in the period.
    pub async fn load_posted_between(
        db: &mut Db,
        start: i64,
        end: i64,
        member_id: Option<i64>,
    ) -> toasty::Result<Self> {
        let mut data = Self::default();
        let created = Post::fields().created_at();
        let mut condition = created
            .clone()
            .ge(start)
            .and(created.clone().lt(end))
            .or(created.eq(0));
        if let Some(member_id) = member_id {
            condition = Post::fields().member_id().eq(member_id).and(condition);
        }
        let posts = Post::filter(condition).exec(&mut *db).await?;
        if posts.is_empty() {
            return Ok(data);
        }
        data.load_snapshots(db, posts.iter().map(|p| p.id).collect()).await?;

        let mut member_ids = Vec::new();
        for post in posts {
            let in_period = data.posted_at(&post).is_some_and(|at| at >= start && at < end);
            if !in_period {
                data.snapshots_by_post.remove(&post.id);
                continue;
            }
            member_ids.push(post.member_id);
            data.posts_by_member.entry(post.member_id).or_default().push(post);
        }
        member_ids.sort_unstable();
        member_ids.dedup();
        if !member_ids.is_empty() {
            for member in Member::filter(Member::fields().id().in_list(member_ids))
                .exec(&mut *db)
                .await?
            {
                data.members.insert(member.id, member);
            }
        }
        Ok(data)
    }

    /// Fetch the snapshots of these posts in one query, oldest first per post.
    async fn load_snapshots(&mut self, db: &mut Db, post_ids: Vec<i64>) -> toasty::Result<()> {
        let mut snapshots = PostSnapshot::filter(PostSnapshot::fields().post_id().in_list(post_ids))
            .exec(&mut *db)
            .await?;
        snapshots.sort_by_key(|s| s.captured_at);
        for snapshot in snapshots {
            self.snapshots_by_post.entry(snapshot.post_id).or_default().push(snapshot);
        }
        Ok(())
    }

    /// Load everyone who joined `comp`, plus their data. Six queries.
    pub async fn load_for_competition(db: &mut Db, comp: &Competition) -> toasty::Result<Self> {
        let memberships =
            ChallengeMembership::filter(ChallengeMembership::fields().challenge_id().eq(comp.id))
                .exec(&mut *db)
                .await?;
        let ids: Vec<i64> = memberships.iter().map(|m| m.member_id).collect();
        Self::load(db, &ids).await
    }

    pub fn posts(&self, member_id: i64) -> &[Post] {
        self.posts_by_member.get(&member_id).map(Vec::as_slice).unwrap_or(&[])
    }
    pub fn snapshots(&self, post_id: i64) -> &[PostSnapshot] {
        self.snapshots_by_post.get(&post_id).map(Vec::as_slice).unwrap_or(&[])
    }
    pub fn comments(&self, post_id: i64) -> &[PostComment] {
        self.comments_by_post.get(&post_id).map(Vec::as_slice).unwrap_or(&[])
    }
    pub fn profile(&self, member_id: i64) -> &[ProfileSnapshot] {
        self.profile_by_member.get(&member_id).map(Vec::as_slice).unwrap_or(&[])
    }

    /// The post's own creation time, or its first snapshot when LinkedIn didn't give us one.
    pub fn posted_at(&self, post: &Post) -> Option<i64> {
        if post.created_at > 0 {
            Some(post.created_at)
        } else {
            self.snapshots(post.id).first().map(|s| s.captured_at)
        }
    }
    /// The most recent value of one number across a post's readings, skipping readings that
    /// missed it. Unlike `snapshots().last()`, one failed read does not blank the number.
    pub fn latest_known(&self, post_id: i64, field: impl Fn(&PostSnapshot) -> Option<i64>) -> Option<i64> {
        self.snapshots(post_id).iter().rev().find_map(field)
    }
    /// [`Dataset::latest_known`] as it stood just before `before`: the newest value of one number
    /// among readings taken strictly earlier. Unchanged readings are not stored, so this is the
    /// way to ask "what was it at time T" — there need not be a reading on any given day.
    pub fn latest_known_before(
        &self,
        post_id: i64,
        before: i64,
        field: impl Fn(&PostSnapshot) -> Option<i64>,
    ) -> Option<i64> {
        self.snapshots(post_id).iter().rev().filter(|s| s.captured_at < before).find_map(field)
    }
    pub fn latest_snapshot_before(&self, post_id: i64, before: i64) -> Option<&PostSnapshot> {
        self.snapshots(post_id).iter().rev().find(|s| s.captured_at <= before)
    }
    /// Comments that score for a post: LinkedIn's own total minus the author's comments we have
    /// seen. The extension reads the rendered post page, which shows only the first several
    /// comments, so the rows are a sample — never a count. When we have read none at all the
    /// total stands as is.
    pub fn scored_comments(&self, post_id: i64, linkedin_total: i64) -> i64 {
        let rows = self.comments(post_id);
        let self_seen = rows.iter().filter(|c| c.is_self).count() as i64;
        let others_seen = rows.len() as i64 - self_seen;
        (linkedin_total - self_seen).max(others_seen).max(0)
    }
}

/// One post's line in a member's accounting.
#[derive(Debug, Clone, Serialize, Deserialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct LedgerPost {
    pub post_id: i64,
    pub permalink: String,
    pub text_preview: Option<String>,
    pub posted_at: i64,
    pub is_repost: bool,
    pub reactions: i64,
    /// Comments by other people — what is priced. LinkedIn's total is `comments_total`.
    pub comments: i64,
    pub comments_total: i64,
    pub reposts: i64,
    pub sends: i64,
    pub saves: i64,
    pub impressions: i64,
    /// Engagement before the cap.
    pub raw_engagement: f64,
    /// Engagement after the cap, before follower scaling.
    pub capped_engagement: f64,
    /// Engagement after follower scaling — what lands in the total when counted.
    pub scaled_engagement: f64,
    /// Show-up points for this post when counted.
    pub show_up_points: f64,
    /// False when the post fell outside the best `max_posts_per_week` for its week.
    pub counted: bool,
    /// True when no snapshot has been captured for it yet.
    pub no_data: bool,
}

/// One scoring week in a member's accounting.
#[derive(Debug, Clone, Serialize, Deserialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct LedgerWeek {
    /// 1-based.
    pub week: i64,
    pub start_at: i64,
    pub end_at: i64,
    pub active: bool,
    pub posts: Vec<LedgerPost>,
    pub show_up_points: f64,
    pub active_week_points: f64,
    pub engagement_points: f64,
    pub total: f64,
}

/// A member's full accounting for one challenge: every post, every week, every rule applied.
#[derive(Debug, Clone, Serialize, Deserialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct Ledger {
    pub weeks: Vec<LedgerWeek>,
    pub follower_count: i64,
    /// True when no follower reading exists, so engagement is not scaled at all.
    pub followers_unknown: bool,
    /// The multiplier applied to engagement (`follower_baseline / follower_count`).
    pub follower_factor: f64,
    pub show_up_points: f64,
    pub active_weeks: u32,
    pub active_week_points: f64,
    pub best_streak_weeks: u32,
    pub streak_bonus: f64,
    pub consistency_points: f64,
    pub engagement_points: f64,
    /// Engagement before follower scaling, for the "what scaling cost you" line.
    pub unscaled_engagement_points: f64,
    pub profile_points: f64,
    pub total: f64,
}

/// The full accounting behind one member's standing, or None when they have no data.
pub fn ledger_for(comp: &Competition, data: &Dataset, member_id: i64, now: i64) -> Option<Ledger> {
    let member = data.members.get(&member_id)?;
    let cfg = ScoringConfig::from_competition(comp);
    score_member_full(member, comp, &cfg, data, now).map(|(_, ledger)| ledger)
}

/// Compute the full leaderboard for a competition, sorted by total score descending.
///
/// Ranks only users who explicitly joined this challenge. Membership is the user's grant for the
/// challenge to read and score their post data.
pub async fn compute_standings(db: &mut Db, comp: &Competition) -> toasty::Result<Vec<Standing>> {
    let data = Dataset::load_for_competition(db, comp).await?;
    Ok(standings_from(comp, &data, now_unix()))
}

/// The leaderboard over already-loaded data; no queries.
pub fn standings_from(comp: &Competition, data: &Dataset, now: i64) -> Vec<Standing> {
    let cfg = ScoringConfig::from_competition(comp);
    let mut standings: Vec<Standing> = data
        .members
        .values()
        .filter_map(|member| score_member(member, comp, &cfg, data, now))
        .collect();
    standings.sort_by(|a, b| {
        b.total
            .partial_cmp(&a.total)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| a.display_name.cmp(&b.display_name))
    });
    standings
}

/// The 0-based scoring week that `now` falls in, clamped to the window.
pub fn current_week(comp: &Competition, now: i64) -> i64 {
    let last = (comp.end_at - comp.start_at).max(0) / WEEK_SECONDS;
    ((now - comp.start_at) / WEEK_SECONDS).clamp(0, last)
}

/// Length of the run of consecutive active weeks that ends at `through` (or the week before it
/// when `through` itself is quiet so far).
pub fn current_streak(active: &[bool], through: i64) -> u32 {
    if active.is_empty() || through < 0 {
        return 0;
    }
    let mut week = through.min(active.len() as i64 - 1);
    if !active[week as usize] {
        week -= 1;
    }
    let mut streak = 0;
    while week >= 0 && active[week as usize] {
        streak += 1;
        week -= 1;
    }
    streak
}

/// Longest run of consecutive active weeks anywhere in the window.
pub fn best_streak(active: &[bool]) -> u32 {
    let mut best = 0;
    let mut run = 0;
    for &week in active {
        run = if week { run + 1 } else { 0 };
        best = best.max(run);
    }
    best
}

fn score_member(
    member: &Member,
    comp: &Competition,
    cfg: &ScoringConfig,
    data: &Dataset,
    now: i64,
) -> Option<Standing> {
    score_member_full(member, comp, cfg, data, now).map(|(standing, _)| standing)
}

/// The scoring pass proper. Returns the standing and the ledger that explains it, computed
/// together so the two can never disagree.
fn score_member_full(
    member: &Member,
    comp: &Competition,
    cfg: &ScoringConfig,
    data: &Dataset,
    now: i64,
) -> Option<(Standing, Ledger)> {
    let posts = data.posts(member.id);
    let profile_snaps = data.profile(member.id);

    // Skip members with no collected data at all (e.g. an admin who never linked the extension).
    if posts.is_empty() && profile_snaps.is_empty() {
        return None;
    }

    // --- Per-post engagement, bucketed by scoring week --------------------------------------
    let weeks = ScoringConfig::weeks_in(comp.start_at, comp.end_at) as usize;
    let mut by_week: Vec<Vec<LedgerPost>> = vec![Vec::new(); weeks];
    let mut total_posts_in_window = 0usize;

    for post in posts {
        let Some(effective) = data.posted_at(post) else { continue };
        if effective < comp.start_at || effective > comp.end_at {
            continue;
        }
        total_posts_in_window += 1;
        let week = ((effective - comp.start_at) / WEEK_SECONDS) as usize;

        // A post with no snapshot yet still "shows up"; it just has no engagement to price.
        let snap = data.latest_snapshot_before(post.id, comp.end_at);
        // Comments score from the rows we actually read, excluding the author's own — replying
        // to your own thread shouldn't earn points. When we have no rows at all (nothing read
        // yet), fall back to LinkedIn's total rather than scoring the post as if it had none.
        let comments_total = snap.and_then(|s| s.comments).unwrap_or(0);
        let comments = data.scored_comments(post.id, comments_total);
        let e = Engagement {
            reactions: snap.and_then(|s| s.reactions).unwrap_or(0),
            comments,
            reposts: snap.and_then(|s| s.reposts).unwrap_or(0),
            sends: snap.and_then(|s| s.sends).unwrap_or(0),
            saves: snap.and_then(|s| s.saves).unwrap_or(0),
            impressions: snap.and_then(|s| s.impressions).unwrap_or(0),
        };
        by_week[week.min(weeks - 1)].push(LedgerPost {
            post_id: post.id,
            permalink: post.permalink.clone(),
            text_preview: post.text_preview.clone(),
            posted_at: effective,
            is_repost: post.is_repost,
            reactions: e.reactions,
            comments: e.comments,
            comments_total,
            reposts: e.reposts,
            sends: e.sends,
            saves: e.saves,
            impressions: e.impressions,
            raw_engagement: cfg.raw_engagement(&e),
            capped_engagement: cfg.post_engagement(&e),
            scaled_engagement: 0.0,
            show_up_points: 0.0,
            counted: false,
            no_data: snap.is_none(),
        });
    }

    // --- Follower count + normalization -----------------------------------------------------
    let in_window: Vec<&ProfileSnapshot> = profile_snaps
        .iter()
        .filter(|p| p.captured_at >= comp.start_at && p.captured_at <= comp.end_at)
        .collect();

    let known_followers = in_window
        .iter()
        .rev()
        .find_map(|p| p.follower_count)
        .or_else(|| profile_snaps.iter().rev().find_map(|p| p.follower_count));
    let latest_followers = known_followers.unwrap_or(0);
    let factor = cfg.follower_factor(latest_followers);

    // --- Show up + engagement: only the best `max_posts_per_week` posts a week count ---------
    let max = cfg.max_posts_per_week as usize;
    let mut show_up = 0.0;
    let mut engagement = 0.0;
    let mut graded_posts = 0usize;
    let mut active: Vec<bool> = vec![false; weeks];
    let mut unscaled_engagement = 0.0;
    let mut week_show_up = vec![0.0; weeks];
    let mut week_engagement = vec![0.0; weeks];
    for (week, posts) in by_week.iter_mut().enumerate() {
        if posts.is_empty() {
            continue;
        }
        active[week] = true;
        // Best posts first, so the ones that count are the top of the list.
        posts.sort_by(|a, b| {
            b.capped_engagement
                .partial_cmp(&a.capped_engagement)
                .unwrap_or(std::cmp::Ordering::Equal)
                .then_with(|| a.posted_at.cmp(&b.posted_at))
        });
        let take = max.min(posts.len());
        for (i, post) in posts.iter_mut().enumerate() {
            post.counted = i < take;
            if post.counted {
                post.show_up_points = cfg.per_post;
                post.scaled_engagement = post.capped_engagement * factor;
                unscaled_engagement += post.capped_engagement;
            }
        }
        week_show_up[week] = take as f64 * cfg.per_post;
        week_engagement[week] = posts.iter().map(|p| p.scaled_engagement).sum();
        show_up += week_show_up[week];
        engagement += week_engagement[week];
        graded_posts += take;
    }

    // --- Keep showing up: active weeks and the streak bonus ---------------------------------
    let this_week = current_week(comp, now);
    let active_weeks = active.iter().filter(|w| **w).count() as u32;
    let streak = current_streak(&active, this_week);
    let best = best_streak(&active);
    let streak_bonus = cfg.streak_bonus(best);
    let consistency = active_weeks as f64 * cfg.per_active_week + streak_bonus;

    let week_index = this_week as usize;
    let week_points = week_show_up[week_index]
        + week_engagement[week_index]
        + if active[week_index] { cfg.per_active_week } else { 0.0 };

    // --- Profile points: followers gained + profile views accrued in-window ------------------
    let follower_growth = window_delta(&in_window, |p| p.follower_count);
    let profile_views_gained = window_delta(&in_window, |p| p.profile_views);
    let profile_points = follower_growth.max(0) as f64 * cfg.per_follower_gained
        + profile_views_gained.max(0) as f64 * cfg.per_profile_view;

    let post_points = show_up + engagement;
    let total = post_points + consistency + profile_points;

    let ledger = Ledger {
        weeks: by_week
            .into_iter()
            .enumerate()
            .map(|(i, posts)| {
                let start_at = comp.start_at + i as i64 * WEEK_SECONDS;
                let active_week_points = if active[i] { cfg.per_active_week } else { 0.0 };
                LedgerWeek {
                    week: i as i64 + 1,
                    start_at,
                    end_at: (start_at + WEEK_SECONDS - 1).min(comp.end_at),
                    active: active[i],
                    posts,
                    show_up_points: week_show_up[i],
                    active_week_points,
                    engagement_points: week_engagement[i],
                    total: week_show_up[i] + active_week_points + week_engagement[i],
                }
            })
            .collect(),
        follower_count: latest_followers,
        followers_unknown: known_followers.is_none(),
        follower_factor: factor,
        show_up_points: show_up,
        active_weeks,
        active_week_points: active_weeks as f64 * cfg.per_active_week,
        best_streak_weeks: best,
        streak_bonus,
        consistency_points: consistency,
        engagement_points: engagement,
        unscaled_engagement_points: unscaled_engagement,
        profile_points,
        total,
    };

    let standing = Standing {
        followers_unknown: known_followers.is_none(),
        member_id: member.id,
        display_name: member.display_name.clone(),
        profile_url: member.profile_url.clone(),
        follower_count: latest_followers,
        follower_growth,
        show_up_points: show_up,
        consistency_points: consistency,
        engagement_points: engagement,
        post_points,
        profile_points,
        total,
        week_points,
        graded_posts,
        total_posts: total_posts_in_window,
        active_weeks,
        streak_weeks: streak,
        best_streak_weeks: best,
    };
    Some((standing, ledger))
}

/// Latest value minus earliest value across the window snapshots, for a chosen metric.
fn window_delta(snaps: &[&ProfileSnapshot], pick: impl Fn(&ProfileSnapshot) -> Option<i64>) -> i64 {
    let first = snaps.iter().find_map(|p| pick(p));
    let last = snaps.iter().rev().find_map(|p| pick(p));
    match (first, last) {
        (Some(a), Some(b)) => b - a,
        _ => 0,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn engagement_counts_fully_to_the_cap_then_at_half_rate() {
        let cfg = ScoringConfig::default();
        // 20 comments × 5 + 100 reactions × 0.2 = 120 → under the cap, counts fully.
        let small = Engagement { comments: 20, reactions: 100, ..Default::default() };
        assert!((cfg.post_engagement(&small) - 120.0).abs() < 1e-9);
        // 40 comments × 5 + 250 reactions × 0.2 = 250 → 150 + 100 × 0.5 = 200.
        let big = Engagement { comments: 40, reactions: 250, ..Default::default() };
        assert!((cfg.post_engagement(&big) - 200.0).abs() < 1e-9);
    }

    #[test]
    fn streak_bonus_is_the_larger_of_the_two_not_their_sum() {
        let cfg = ScoringConfig::default();
        assert_eq!(cfg.streak_bonus(3), 0.0);
        assert_eq!(cfg.streak_bonus(4), 25.0);
        assert_eq!(cfg.streak_bonus(7), 25.0);
        assert_eq!(cfg.streak_bonus(8), 75.0);
    }

    #[test]
    fn streaks_count_consecutive_active_weeks() {
        let active = [true, true, false, true, true, true, false, false];
        assert_eq!(best_streak(&active), 3);
        // Through week 5 (active): the run is weeks 3–5.
        assert_eq!(current_streak(&active, 5), 3);
        // Through week 6 (quiet so far): still the run ending at week 5.
        assert_eq!(current_streak(&active, 6), 3);
        // Through week 7: week 6 was quiet too, so the streak is broken.
        assert_eq!(current_streak(&active, 7), 0);
    }

    #[test]
    fn scored_comments_is_linkedin_total_minus_the_authors_own() {
        use crate::models::PostComment;
        let mut data = Dataset::default();
        let row = |urn: &str, is_self: bool| PostComment {
            id: 0, post_id: 7, urn: urn.into(), commenter_urn: "urn:li:publicIdentifier:x".into(),
            commenter_name: None, is_self, is_reply: false, created_at: 0, captured_at: 0,
            post: Default::default(),
        };
        // Nothing read: the total stands.
        assert_eq!(data.scored_comments(7, 12), 12);
        // Page showed 3 of 12 comments, one by the author: 12 − 1.
        data.comments_by_post.insert(7, vec![row("a", false), row("b", true), row("c", false)]);
        assert_eq!(data.scored_comments(7, 12), 11);
        // A stale total below what we saw never under-counts what we saw.
        assert_eq!(data.scored_comments(7, 1), 2);
    }

    /// Sync skips a reading identical to the post's latest one, and
    /// `scripts/dedupe-post-snapshots.sql` deletes rows identical to the one just before them.
    /// Scoring and the post views read snapshots only through `latest_snapshot_before`,
    /// `posted_at` and the last row, so both rules must leave every one of those answers alone
    /// for every possible challenge end, including ends between two identical readings.
    #[test]
    fn skipping_repeated_readings_changes_no_answer_scoring_reads() {
        let snap = |id: i64, captured_at: i64, reactions: Option<i64>, impressions: Option<i64>| PostSnapshot {
            id, post_id: 7, post: Default::default(), captured_at, impressions, reactions,
            comments: Some(2), reposts: None, sends: None, saves: None,
            impressions_in_network: None, impressions_out_of_network: None, members_reached: None,
            profile_viewers_from_post: None, followers_from_post: None,
        };
        // Every sync as it would be stored without the dedupe, in (captured_at, id) order: runs of
        // repeats, a repeat in the same second, a NULL that later appears, and a value that goes
        // back to an earlier one (not a repeat of the row just before it, so it is kept).
        let readings = |base: i64| vec![
            snap(1, base + 10, Some(5), None),
            snap(2, base + 20, Some(5), None),
            snap(3, base + 20, Some(5), None),
            snap(4, base + 30, Some(5), Some(100)),
            snap(5, base + 40, Some(9), Some(100)),
            snap(6, base + 50, Some(9), Some(100)),
            snap(7, base + 60, Some(9), Some(100)),
            snap(8, base + 70, Some(5), Some(100)),
            snap(9, base + 80, Some(5), Some(100)),
        ];
        // What sync stores: compare each reading with the latest one kept so far.
        let ingested = |all: Vec<PostSnapshot>| {
            let mut kept: Vec<PostSnapshot> = Vec::new();
            for reading in all {
                let unchanged = kept
                    .last()
                    .is_some_and(|last| reading.captured_at >= last.captured_at && last.same_reading(&reading));
                if !unchanged {
                    kept.push(reading);
                }
            }
            kept
        };
        // What the cleanup script keeps: every row unlike the row immediately before it.
        let cleaned = |all: Vec<PostSnapshot>| {
            let keep: Vec<bool> = (0..all.len()).map(|i| i == 0 || !all[i - 1].same_reading(&all[i])).collect();
            all.into_iter().zip(keep).filter_map(|(row, keep)| keep.then_some(row)).collect::<Vec<_>>()
        };
        let dataset = |rows: Vec<PostSnapshot>| {
            let mut data = Dataset::default();
            data.snapshots_by_post.insert(7, rows);
            data
        };
        let post = |created_at: i64| Post {
            id: 7, member_id: 1, member: Default::default(), urn: "urn:li:activity:7".into(),
            permalink: String::new(), created_at, text_preview: None, image_urls_json: None,
            is_repost: false, snapshots: Default::default(), comments_seen: Default::default(),
        };
        let base = 1_000;
        let full = dataset(readings(base));
        assert_eq!(ingested(readings(base)).len(), 4);
        assert_eq!(cleaned(readings(base)).len(), 4);
        for deduped in [dataset(ingested(readings(base))), dataset(cleaned(readings(base)))] {
            for end in base..=base + 90 {
                let (a, b) = (full.latest_snapshot_before(7, end), deduped.latest_snapshot_before(7, end));
                assert_eq!(a.is_some(), b.is_some(), "end {end}");
                if let (Some(a), Some(b)) = (a, b) {
                    assert!(a.same_reading(b), "end {end}");
                }
            }
            // A post with no creation time is dated by its first reading, which both rules keep.
            assert_eq!(full.posted_at(&post(0)), deduped.posted_at(&post(0)));
            assert!(full.snapshots(7).last().unwrap().same_reading(deduped.snapshots(7).last().unwrap()));
        }
    }

    #[test]
    fn weeks_in_window_include_the_partial_last_week() {
        // Jul 13 → Sep 30 is 79 days: eleven full weeks and a partial twelfth.
        let start = crate::util::parse_date("2026-07-13").unwrap();
        let end = crate::util::parse_date("2026-09-30").unwrap() + 86_399;
        assert_eq!(ScoringConfig::weeks_in(start, end), 12);
    }
}
