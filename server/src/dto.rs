//! Wire shapes shared by the `app/**/route.rs` adapters, plus the reads that build them.
//!
//! OpenAPI schema names are global, so these live in one place rather than being redeclared per
//! route. The queries stay here too: the leaderboard, the admin overview, and a member's own
//! standing are the same data viewed three ways, and duplicating the read per screen is how the
//! three drift apart.

use serde::{Deserialize, Serialize};
use toasty::Db;
use utoipa::ToSchema;

use crate::models::{ChallengeMembership, Competition, Invite, Member, Org, Post};
use crate::scoring::{
    Dataset, Engagement, Ledger, ScoringConfig, Standing, WEEK_SECONDS, active_competition,
    current_week, ledger_for, standings_from,
};
use crate::util::now_unix;
use crate::web::{ApiError, ApiResult};

// --- summaries -------------------------------------------------------------------------------

#[derive(Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct CompetitionInfo {
    pub id: i64,
    pub name: String,
    pub start_at: i64,
    pub end_at: i64,
    pub is_active: bool,
    pub is_favorite: bool,
    pub is_owner: bool,
    /// The scoring rules in force — this is what the "how the challenge is configured" screen reads.
    pub config: ScoringConfig,
}

impl CompetitionInfo {
    pub fn new(c: &Competition) -> Self {
        Self {
            id: c.id,
            name: c.name.clone(),
            start_at: c.start_at,
            end_at: c.end_at,
            is_active: c.is_active,
            is_favorite: false,
            is_owner: false,
            config: ScoringConfig::from_competition(c),
        }
    }
}

#[derive(Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct StandingRow {
    pub followers_unknown: bool,
    pub rank: usize,
    pub member_id: i64,
    pub display_name: String,
    pub profile_url: Option<String>,
    pub follower_count: i64,
    /// Followers gained across the window so far.
    pub follower_growth: i64,
    /// "Show up": points for posting, up to the weekly cap.
    pub show_up_points: f64,
    /// "Keep showing up": active-week points plus the streak bonus.
    pub consistency_points: f64,
    /// Engagement points after the cap and follower scaling.
    pub engagement_points: f64,
    /// `show_up + engagement` — everything the posts themselves earned.
    pub post_points: f64,
    pub profile_points: f64,
    pub total: f64,
    /// Points earned in the current scoring week.
    pub week_points: f64,
    pub graded_posts: usize,
    pub total_posts: usize,
    pub active_weeks: u32,
    /// Consecutive active weeks running up to now.
    pub streak_weeks: u32,
    pub best_streak_weeks: u32,
}

impl StandingRow {
    fn new(rank: usize, s: Standing) -> Self {
        Self {
            rank,
            member_id: s.member_id,
            display_name: s.display_name,
            profile_url: s.profile_url,
            followers_unknown: s.followers_unknown,
            follower_count: s.follower_count,
            follower_growth: s.follower_growth,
            show_up_points: s.show_up_points,
            consistency_points: s.consistency_points,
            engagement_points: s.engagement_points,
            post_points: s.post_points,
            profile_points: s.profile_points,
            total: s.total,
            week_points: s.week_points,
            graded_posts: s.graded_posts,
            total_posts: s.total_posts,
            active_weeks: s.active_weeks,
            streak_weeks: s.streak_weeks,
            best_streak_weeks: s.best_streak_weeks,
        }
    }
}

/// Where the challenge is in its calendar.
#[derive(Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct Season {
    /// 1-based scoring week that today falls in (clamped to the window).
    pub week: i64,
    pub weeks: i64,
    /// 0–1 share of the window elapsed.
    pub progress: f64,
    /// When the server computed this board (unix seconds).
    pub as_of: i64,
}

/// How the whole company is doing — the "as a company so far" strip. Visible to every member.
#[derive(Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct CompanyStats {
    /// Members of the challenge.
    pub members: usize,
    /// Members with at least one post inside the window.
    pub members_posting: usize,
    /// Comments other people left on in-window posts.
    pub comments_sparked: i64,
    /// Sum of every scoring member's latest follower count.
    pub follower_reach: i64,
}

/// One of the week's standout posts.
#[derive(Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct TopPost {
    pub post_id: i64,
    pub member_id: i64,
    pub display_name: String,
    pub permalink: String,
    pub text_preview: Option<String>,
    pub posted_at: i64,
    pub comments: i64,
    pub reactions: i64,
    /// Engagement points before follower scaling — what makes it a top post.
    pub points: f64,
}

/// The org's challenges, newest first, with the one the app shows by default.
#[derive(Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ChallengeList {
    /// The challenge the app lands on: active-and-in-window first, else the most recent.
    pub current: Option<CompetitionInfo>,
    pub challenges: Vec<CompetitionInfo>,
}

/// The leaderboard payload: standings, the challenge, and the rules behind the numbers.
#[derive(Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct Leaderboard {
    pub competition: Option<CompetitionInfo>,
    /// The org's other challenges, for the board's switcher.
    pub challenges: Vec<CompetitionInfo>,
    pub standings: Vec<StandingRow>,
    /// The viewer's own row, when they are scoring.
    pub viewer: Option<StandingRow>,
    /// The full accounting behind the viewer's row — every post and every rule applied.
    pub viewer_ledger: Option<Ledger>,
    pub viewer_member_id: i64,
    pub viewer_name: String,
    pub season: Option<Season>,
    pub company: Option<CompanyStats>,
    /// The current week's three most-engaged posts.
    pub top_posts: Vec<TopPost>,
    /// Always None here — see `aggregate_for`, which an admin-only endpoint serves separately so
    /// the board itself stays the same for every reader.
    pub aggregate: Option<Aggregate>,
}

// --- member detail ---------------------------------------------------------------------------

#[derive(Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct PostStat {
    pub id: i64,
    pub urn: String,
    pub permalink: String,
    /// Post creation time, or the first snapshot's time when LinkedIn didn't give us one.
    pub posted_at: i64,
    pub text_preview: Option<String>,
    pub image_urls: Vec<String>,
    pub is_repost: bool,
    pub impressions: i64,
    pub reactions: i64,
    /// LinkedIn's total comment count.
    pub comments: i64,
    /// Comments by people other than the author — what actually scores. Equals `comments` until
    /// we have read the comment list for this post.
    pub comments_by_others: i64,
    pub reposts: i64,
    pub sends: i64,
    pub saves: i64,
    pub impressions_in_network: i64,
    pub impressions_out_of_network: i64,
    pub members_reached: i64,
    pub profile_viewers_from_post: i64,
    pub followers_from_post: i64,
    /// False when the post falls outside the competition window.
    pub in_window: bool,
}

/// Posts bucketed by the same weekly buckets the scoring uses, so the grouping matches how
/// points were actually earned.
#[derive(Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct WeekGroup {
    /// 0-based week index from the competition start.
    pub week: i64,
    pub start_at: i64,
    pub end_at: i64,
    pub posts: Vec<PostStat>,
}

#[derive(Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct MemberDetail {
    pub follower_count: Option<i64>,
    pub competition: Option<CompetitionInfo>,
    pub member_id: i64,
    pub display_name: String,
    pub profile_url: Option<String>,
    /// This member's row in the standings, when they have collected data.
    pub standing: Option<StandingRow>,
    pub weeks: Vec<WeekGroup>,
    /// Posts we hold that fall outside the competition window.
    pub outside_window: Vec<PostStat>,
    /// Server-filtered, server-sorted page used by the post explorer.
    pub posts: Vec<PostStat>,
    pub post_count: usize,
    pub post_page: usize,
    pub post_page_count: usize,
}

#[derive(Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct PostPage {
    pub follower_count: Option<i64>,
    pub posts: Vec<PostStat>,
    pub total: usize,
    pub page: usize,
    pub page_count: usize,
}

// --- admin -----------------------------------------------------------------------------------

#[derive(Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct InviteRow {
    pub code: String,
    pub email: Option<String>,
    pub role: String,
    pub redeemed: bool,
    pub created_at: i64,
}

/// Org-wide totals — the aggregate view, which the ranked list alone doesn't give you.
#[derive(Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct Aggregate {
    pub participants: usize,
    pub scoring_participants: usize,
    pub total_posts: usize,
    pub graded_posts: usize,
    pub total_impressions: i64,
    pub total_reactions: i64,
    pub total_comments: i64,
    pub total_reposts: i64,
    pub total_followers: i64,
    pub total_points: f64,
    pub invites_open: usize,
    pub invites_redeemed: usize,
}

#[derive(Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct AdminOverview {
    pub admin_name: String,
    pub competitions: Vec<CompetitionInfo>,
    pub current: Option<CompetitionInfo>,
    pub standings: Vec<StandingRow>,
    pub invites: Vec<InviteRow>,
    pub aggregate: Aggregate,
    /// Sensible defaults for the "new competition" form.
    pub defaults: ScoringConfig,
}

// --- reads -----------------------------------------------------------------------------------

/// The signed-in member. Routes are scoped to the session's own org, so there is no slug to check
/// against — the session *is* the scope.
pub async fn require_member(db: &mut Db, headers: &http::HeaderMap) -> ApiResult<Member> {
    crate::auth::current_member(db, headers)
        .await
        .ok_or_else(|| ApiError::unauthorized("sign-in required"))
}

/// The signed-in member, if challenges are open to them (see `auth::can_use_challenges`). Every
/// challenge API checks this instead of `require_member`. Refused with a 401, as the system
/// routes refuse a non-admin.
pub async fn require_challenge_user(db: &mut Db, headers: &http::HeaderMap) -> ApiResult<Member> {
    let member = require_member(db, headers).await?;
    if !crate::auth::can_use_challenges(&member) {
        return Err(ApiError::unauthorized("challenges are open to admins only for now"));
    }
    Ok(member)
}

/// Whether this user has management rights for one challenge.
pub async fn is_challenge_owner(db: &mut Db, member_id: i64, challenge_id: i64) -> ApiResult<bool> {
    Ok(ChallengeMembership::filter(
        ChallengeMembership::fields()
            .challenge_id()
            .eq(challenge_id),
    )
    .exec(&mut *db)
    .await?
    .into_iter()
    .any(|membership| membership.member_id == member_id && membership.role == "owner"))
}

/// Resolve a challenge only when the signed-in user is one of its owners.
pub async fn require_challenge_owner(
    db: &mut Db,
    headers: &http::HeaderMap,
    challenge_id: i64,
) -> ApiResult<(Member, Competition)> {
    let member = require_challenge_user(db, headers).await?;
    if !is_challenge_owner(db, member.id, challenge_id).await? {
        return Err(ApiError::not_found("challenge not found"));
    }
    let challenge = Competition::filter_by_id(challenge_id)
        .first()
        .exec(&mut *db)
        .await?
        .ok_or_else(|| ApiError::not_found("challenge not found"))?;
    Ok((member, challenge))
}

/// The signed-in member, but only if they operate the product itself.
pub async fn require_system_admin(db: &mut Db, headers: &http::HeaderMap) -> ApiResult<Member> {
    crate::auth::current_system_admin(db, headers)
        .await
        .ok_or_else(|| ApiError::unauthorized("system admin session required"))
}

pub async fn org_of(db: &mut Db, member: &Member) -> ApiResult<Org> {
    Org::filter_by_id(member.org_id)
        .first()
        .exec(&mut *db)
        .await?
        .ok_or_else(|| ApiError::not_found("organization not found"))
}

/// The org's public slug — kept for the auth surfaces that still report it.
pub async fn org_slug(db: &mut Db, org_id: i64) -> ApiResult<String> {
    Ok(Org::filter_by_id(org_id)
        .first()
        .exec(&mut *db)
        .await?
        .map(|o| o.slug)
        .unwrap_or_default())
}

/// A challenge of this member's org, by id — the wrong org's id reads as absent.
pub async fn org_challenge(db: &mut Db, org_id: i64, id: i64) -> ApiResult<Competition> {
    Competition::filter_by_id(id)
        .first()
        .exec(&mut *db)
        .await?
        .filter(|c| c.org_id == org_id)
        .ok_or_else(|| ApiError::not_found("challenge not found"))
}

/// All of an org's challenges, newest first.
pub async fn org_challenges(db: &mut Db, org_id: i64) -> ApiResult<Vec<Competition>> {
    let mut comps = Competition::filter(Competition::fields().org_id().eq(org_id))
        .exec(&mut *db)
        .await?;
    comps.sort_by(|a, b| b.start_at.cmp(&a.start_at));
    Ok(comps)
}

pub async fn current_competition(db: &mut Db, org_id: i64) -> ApiResult<Option<Competition>> {
    let comps = Competition::filter(Competition::fields().org_id().eq(org_id))
        .exec(&mut *db)
        .await?;
    Ok(active_competition(comps, now_unix()))
}

fn rank(standings: Vec<Standing>) -> Vec<StandingRow> {
    standings
        .into_iter()
        .enumerate()
        .map(|(i, s)| StandingRow::new(i + 1, s))
        .collect()
}

pub async fn member_challenges(db: &mut Db, member_id: i64) -> ApiResult<Vec<Competition>> {
    let memberships =
        ChallengeMembership::filter(ChallengeMembership::fields().member_id().eq(member_id))
            .exec(&mut *db)
            .await?;
    let mut challenges = challenges_by_ids(
        db,
        memberships.iter().map(|m| m.challenge_id).collect(),
    )
    .await?;
    challenges.sort_by(|a, b| b.start_at.cmp(&a.start_at));
    Ok(challenges)
}

/// The challenges with these ids, in one query (none when the list is empty).
pub async fn challenges_by_ids(db: &mut Db, mut ids: Vec<i64>) -> ApiResult<Vec<Competition>> {
    ids.sort_unstable();
    ids.dedup();
    if ids.is_empty() {
        return Ok(Vec::new());
    }
    Ok(Competition::filter(Competition::fields().id().in_list(ids))
        .exec(&mut *db)
        .await?)
}

pub async fn member_challenge(db: &mut Db, member_id: i64, id: i64) -> ApiResult<Competition> {
    let membership =
        ChallengeMembership::filter(ChallengeMembership::fields().member_id().eq(member_id))
            .exec(&mut *db)
            .await?
            .into_iter()
            .any(|membership| membership.challenge_id == id);
    if !membership {
        return Err(ApiError::not_found("challenge not found"));
    }
    Competition::filter_by_id(id)
        .first()
        .exec(&mut *db)
        .await?
        .ok_or_else(|| ApiError::not_found("challenge not found"))
}

/// The org's challenge list plus the default one to display.
pub async fn challenge_list(db: &mut Db, member: &Member) -> ApiResult<ChallengeList> {
    let comps = member_challenges(db, member.id).await?;
    let memberships =
        ChallengeMembership::filter(ChallengeMembership::fields().member_id().eq(member.id))
            .exec(&mut *db)
            .await?;
    let infos: Vec<CompetitionInfo> = comps
        .iter()
        .map(|challenge| {
            let mut info = CompetitionInfo::new(challenge);
            info.is_owner = memberships.iter().any(|membership| {
                membership.challenge_id == challenge.id && membership.role == "owner"
            });
            info.is_favorite = memberships.iter().any(|membership| {
                membership.challenge_id == challenge.id && membership.is_favorite
            });
            info
        })
        .collect();
    let current = active_competition(comps, now_unix());
    Ok(ChallengeList {
        current: current.as_ref().map(|challenge| {
            let mut info = CompetitionInfo::new(challenge);
            info.is_owner = memberships.iter().any(|membership| {
                membership.challenge_id == challenge.id && membership.role == "owner"
            });
            info.is_favorite = memberships.iter().any(|membership| {
                membership.challenge_id == challenge.id && membership.is_favorite
            });
            info
        }),
        challenges: infos,
    })
}

/// The leaderboard for the viewer's org: a specific challenge when `challenge_id` names one,
/// otherwise whichever `active_competition` chooses.
pub async fn leaderboard(
    db: &mut Db,
    member: &Member,
    challenge_id: Option<i64>,
) -> ApiResult<Leaderboard> {
    let comps = member_challenges(db, member.id).await?;
    let memberships =
        ChallengeMembership::filter(ChallengeMembership::fields().member_id().eq(member.id))
            .exec(&mut *db)
            .await?;
    let challenges: Vec<CompetitionInfo> = comps
        .iter()
        .map(|challenge| {
            let mut info = CompetitionInfo::new(challenge);
            info.is_owner = memberships.iter().any(|membership| {
                membership.challenge_id == challenge.id && membership.role == "owner"
            });
            info.is_favorite = memberships.iter().any(|membership| {
                membership.challenge_id == challenge.id && membership.is_favorite
            });
            info
        })
        .collect();

    let comp = match challenge_id {
        Some(id) => Some(member_challenge(db, member.id, id).await?),
        None => active_competition(comps, now_unix()),
    };

    let now = now_unix();
    // One batched load serves the standings, the company strip, and the top posts.
    let data = match &comp {
        Some(c) => Some(Dataset::load_for_competition(db, c).await?),
        None => None,
    };
    let standings = match (&comp, &data) {
        (Some(c), Some(data)) => rank(standings_from(c, data, now)),
        _ => Vec::new(),
    };
    let viewer = standings.iter().find(|s| s.member_id == member.id).map(clone_row);
    let viewer_ledger = match (&comp, &data) {
        (Some(c), Some(data)) => ledger_for(c, data, member.id, now),
        _ => None,
    };

    let season = comp.as_ref().map(|c| Season {
        week: current_week(c, now) + 1,
        weeks: ScoringConfig::weeks_in(c.start_at, c.end_at),
        progress: ((now - c.start_at) as f64 / (c.end_at - c.start_at).max(1) as f64).clamp(0.0, 1.0),
        as_of: now,
    });
    let (company, top_posts) = match (&comp, &data) {
        (Some(c), Some(data)) => {
            let (company, top) = company_stats(c, data, &standings, now);
            (Some(company), top)
        }
        _ => (None, Vec::new()),
    };

    Ok(Leaderboard {
        viewer,
        viewer_ledger,
        viewer_member_id: member.id,
        viewer_name: member.display_name.clone(),
        season,
        company,
        top_posts,
        competition: comp.as_ref().map(|challenge| {
            let mut info = CompetitionInfo::new(challenge);
            info.is_owner = memberships.iter().any(|membership| {
                membership.challenge_id == challenge.id && membership.role == "owner"
            });
            info.is_favorite = memberships.iter().any(|membership| {
                membership.challenge_id == challenge.id && membership.is_favorite
            });
            info
        }),
        challenges,
        standings,
        aggregate: None,
    })
}

fn clone_row(s: &StandingRow) -> StandingRow {
    StandingRow {
        rank: s.rank,
        member_id: s.member_id,
        display_name: s.display_name.clone(),
        profile_url: s.profile_url.clone(),
        followers_unknown: s.followers_unknown,
        follower_count: s.follower_count,
        follower_growth: s.follower_growth,
        show_up_points: s.show_up_points,
        consistency_points: s.consistency_points,
        engagement_points: s.engagement_points,
        post_points: s.post_points,
        profile_points: s.profile_points,
        total: s.total,
        week_points: s.week_points,
        graded_posts: s.graded_posts,
        total_posts: s.total_posts,
        active_weeks: s.active_weeks,
        streak_weeks: s.streak_weeks,
        best_streak_weeks: s.best_streak_weeks,
    }
}

/// Company-wide totals every member may see, plus this week's top three posts. One pass over
/// every member's in-window posts serves both; no queries.
fn company_stats(
    comp: &Competition,
    data: &Dataset,
    standings: &[StandingRow],
    now: i64,
) -> (CompanyStats, Vec<TopPost>) {
    let cfg = ScoringConfig::from_competition(comp);
    let week = current_week(comp, now);
    let week_start = comp.start_at + week * WEEK_SECONDS;
    let week_end = (week_start + WEEK_SECONDS - 1).min(comp.end_at);

    let mut members_posting = 0usize;
    let mut comments_sparked = 0i64;
    let mut top: Vec<TopPost> = Vec::new();
    for member in data.members.values() {
        let mut posted = false;
        for post in data.posts(member.id) {
            let (stat, posted_at) = post_stats(data, post);
            if posted_at < comp.start_at || posted_at > comp.end_at {
                continue;
            }
            posted = true;
            comments_sparked += stat.comments_by_others;
            if posted_at >= week_start && posted_at <= week_end {
                let points = cfg.post_engagement(&Engagement {
                    reactions: stat.reactions,
                    comments: stat.comments_by_others,
                    reposts: stat.reposts,
                    sends: stat.sends,
                    saves: stat.saves,
                    impressions: stat.impressions,
                });
                top.push(TopPost {
                    post_id: post.id,
                    member_id: member.id,
                    display_name: member.display_name.clone(),
                    permalink: post.permalink.clone(),
                    text_preview: stat.text_preview.clone(),
                    posted_at,
                    comments: stat.comments_by_others,
                    reactions: stat.reactions,
                    points,
                });
            }
        }
        if posted {
            members_posting += 1;
        }
    }
    top.sort_by(|a, b| {
        b.points
            .partial_cmp(&a.points)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| b.posted_at.cmp(&a.posted_at))
    });
    top.truncate(3);

    (
        CompanyStats {
            members: data.members.len(),
            members_posting,
            comments_sparked,
            follower_reach: standings.iter().map(|s| s.follower_count).sum(),
        },
        top,
    )
}

/// Standings plus totals for one challenge — the admin view of a board.
pub async fn competition_aggregate(
    db: &mut Db,
    admin: &Member,
    challenge_id: i64,
) -> ApiResult<Aggregate> {
    if !is_challenge_owner(db, admin.id, challenge_id).await? {
        return Err(ApiError::not_found("challenge not found"));
    }
    let comp = Competition::filter_by_id(challenge_id)
        .first()
        .exec(&mut *db)
        .await?
        .ok_or_else(|| ApiError::not_found("challenge not found"))?;
    let data = Dataset::load_for_competition(db, &comp).await?;
    let standings = rank(standings_from(&comp, &data, now_unix()));
    aggregate_for(db, &comp, &data, &standings).await
}

/// Totals across the org for one challenge window.
pub async fn aggregate_for(
    db: &mut Db,
    comp: &Competition,
    data: &Dataset,
    standings: &[StandingRow],
) -> ApiResult<Aggregate> {
    let mut totals = (0i64, 0i64, 0i64, 0i64);
    let mut total_posts = 0usize;
    for member in data.members.values() {
        for post in data.posts(member.id) {
            let (stat, posted_at) = post_stats(data, post);
            if posted_at >= comp.start_at && posted_at <= comp.end_at {
                total_posts += 1;
                totals.0 += stat.impressions;
                totals.1 += stat.reactions;
                totals.2 += stat.comments_by_others;
                totals.3 += stat.reposts;
            }
        }
    }

    let invites = Invite::filter(Invite::fields().challenge_id().eq(comp.id))
        .exec(&mut *db)
        .await?;

    Ok(Aggregate {
        participants: data.members.len(),
        scoring_participants: standings.len(),
        total_posts,
        graded_posts: standings.iter().map(|s| s.graded_posts).sum(),
        total_impressions: totals.0,
        total_reactions: totals.1,
        total_comments: totals.2,
        total_reposts: totals.3,
        total_followers: standings.iter().map(|s| s.follower_count).sum(),
        total_points: standings.iter().map(|s| s.total).sum(),
        invites_open: invites.iter().filter(|i| !i.redeemed).count(),
        invites_redeemed: invites.iter().filter(|i| i.redeemed).count(),
    })
}

/// Latest snapshot per post, plus the effective "posted at" (creation time, else first capture).
fn post_stats(data: &Dataset, post: &Post) -> (PostStat, i64) {
    let snaps = data.snapshots(post.id);
    let latest = snaps.last();
    let total = latest.and_then(|s| s.comments).unwrap_or(0);
    let posted_at = data.posted_at(post).unwrap_or(0);

    (
        PostStat {
            id: post.id,
            urn: post.urn.clone(),
            permalink: post.permalink.clone(),
            posted_at,
            text_preview: post.text_preview.clone(),
            image_urls: post
                .image_urls_json
                .as_deref()
                .and_then(|value| serde_json::from_str(value).ok())
                .unwrap_or_default(),
            is_repost: post.is_repost,
            impressions: latest.and_then(|s| s.impressions).unwrap_or(0),
            reactions: latest.and_then(|s| s.reactions).unwrap_or(0),
            comments: latest.and_then(|s| s.comments).unwrap_or(0),
            comments_by_others: data.scored_comments(post.id, total),
            reposts: latest.and_then(|s| s.reposts).unwrap_or(0),
            sends: latest.and_then(|s| s.sends).unwrap_or(0),
            saves: latest.and_then(|s| s.saves).unwrap_or(0),
            impressions_in_network: latest.and_then(|s| s.impressions_in_network).unwrap_or(0),
            impressions_out_of_network: latest
                .and_then(|s| s.impressions_out_of_network)
                .unwrap_or(0),
            members_reached: latest.and_then(|s| s.members_reached).unwrap_or(0),
            profile_viewers_from_post: latest
                .and_then(|s| s.profile_viewers_from_post)
                .unwrap_or(0),
            followers_from_post: latest.and_then(|s| s.followers_from_post).unwrap_or(0),
            in_window: false,
        },
        posted_at,
    )
}

pub async fn member_detail(
    db: &mut Db,
    viewer: &Member,
    challenge_id: Option<i64>,
    member_id: i64,
    post_filter: Option<&str>,
    post_sort: &str,
    post_page: usize,
    post_page_size: usize,
) -> ApiResult<MemberDetail> {
    let member = Member::filter_by_id(member_id)
        .first()
        .exec(&mut *db)
        .await?
        .ok_or_else(|| ApiError::not_found("user not found"))?;
    // A deleted account is off every board, so its detail page goes with it. (Its own session
    // is refused before reaching here, so the viewer is never the deleted account.)
    if member.is_deleted() && member.id != viewer.id {
        return Err(ApiError::not_found("user not found"));
    }

    // The challenge the caller asked about, defaulting to whichever the org is showing — so a
    // leaderboard row and the detail behind it always describe the same window.
    let comp = match challenge_id {
        Some(id) => {
            let challenge = member_challenge(db, viewer.id, id).await?;
            // A challenge may read another user's posts only after that user joined it.
            member_challenge(db, member.id, id).await?;
            Some(challenge)
        }
        None if viewer.id == member.id => None,
        None => return Err(ApiError::not_found("user not found")),
    };

    // This member's row, taken from the same ranked standings the leaderboard shows, so the rank
    // on a detail page always agrees with the rank on the board. The board's dataset already
    // holds this member's posts, so it doubles as the detail's data source.
    let (standing, data) = match &comp {
        Some(c) => {
            let data = Dataset::load_for_competition(db, c).await?;
            let standing = rank(standings_from(c, &data, now_unix()))
                .into_iter()
                .find(|s| s.member_id == member_id);
            (standing, data)
        }
        None => (None, Dataset::load(db, &[member.id]).await?),
    };

    let posts = data.posts(member.id);

    let mut in_window: Vec<(i64, PostStat)> = Vec::new();
    let mut outside: Vec<PostStat> = Vec::new();
    let mut all_posts: Vec<PostStat> = Vec::new();

    for post in posts {
        let (mut stat, posted_at) = post_stats(&data, post);
        all_posts.push(clone_stat(&stat));
        match &comp {
            Some(c) if posted_at >= c.start_at && posted_at <= c.end_at => {
                stat.in_window = true;
                in_window.push(((posted_at - c.start_at) / WEEK_SECONDS, stat));
            }
            _ => outside.push(stat),
        }
    }

    let needle = post_filter
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_lowercase);
    if let Some(needle) = needle {
        all_posts.retain(|post| {
            post.text_preview
                .as_deref()
                .unwrap_or_default()
                .to_lowercase()
                .contains(&needle)
        });
    }
    all_posts.sort_by(|a, b| {
        let order = match post_sort {
            "oldest" => a.posted_at.cmp(&b.posted_at),
            "impressions" => b.impressions.cmp(&a.impressions),
            "reactions" => b.reactions.cmp(&a.reactions),
            "comments" => b.comments.cmp(&a.comments),
            "reposts" => b.reposts.cmp(&a.reposts),
            "sends" => b.sends.cmp(&a.sends),
            "saves" => b.saves.cmp(&a.saves),
            _ => b.posted_at.cmp(&a.posted_at),
        };
        order.then_with(|| b.posted_at.cmp(&a.posted_at))
    });
    let post_count = all_posts.len();
    let post_page_count = post_count.div_ceil(post_page_size).max(1);
    let post_page = post_page.clamp(1, post_page_count);
    let start = (post_page - 1) * post_page_size;
    let posts_page = all_posts
        .into_iter()
        .skip(start)
        .take(post_page_size)
        .collect();

    outside.sort_by(|a, b| b.posted_at.cmp(&a.posted_at));

    // Bucket into weeks, newest week first, newest post first inside each week.
    let mut weeks: Vec<WeekGroup> = Vec::new();
    if let Some(c) = &comp {
        let mut indexes: Vec<i64> = in_window.iter().map(|(w, _)| *w).collect();
        indexes.sort_unstable();
        indexes.dedup();
        for w in indexes.into_iter().rev() {
            let mut posts: Vec<PostStat> = in_window
                .iter()
                .filter(|(i, _)| *i == w)
                .map(|(_, s)| clone_stat(s))
                .collect();
            posts.sort_by(|a, b| b.posted_at.cmp(&a.posted_at));
            weeks.push(WeekGroup {
                week: w,
                start_at: c.start_at + w * WEEK_SECONDS,
                end_at: (c.start_at + (w + 1) * WEEK_SECONDS - 1).min(c.end_at),
                posts,
            });
        }
    }

    Ok(MemberDetail {
        follower_count: data.profile(member.id).iter().rev().find_map(|p| p.follower_count),
        competition: comp.as_ref().map(CompetitionInfo::new),
        member_id: member.id,
        display_name: member.display_name,
        profile_url: member.profile_url,
        standing,
        weeks,
        outside_window: outside,
        posts: posts_page,
        post_count,
        post_page,
        post_page_count,
    })
}

fn clone_stat(s: &PostStat) -> PostStat {
    PostStat {
        id: s.id,
        urn: s.urn.clone(),
        permalink: s.permalink.clone(),
        posted_at: s.posted_at,
        text_preview: s.text_preview.clone(),
        image_urls: s.image_urls.clone(),
        is_repost: s.is_repost,
        impressions: s.impressions,
        reactions: s.reactions,
        comments: s.comments,
        comments_by_others: s.comments_by_others,
        reposts: s.reposts,
        sends: s.sends,
        saves: s.saves,
        impressions_in_network: s.impressions_in_network,
        impressions_out_of_network: s.impressions_out_of_network,
        members_reached: s.members_reached,
        profile_viewers_from_post: s.profile_viewers_from_post,
        followers_from_post: s.followers_from_post,
        in_window: s.in_window,
    }
}

/// Case-insensitive search of a post's text; `needle` must already be lowercase. A post with no
/// stored text never matches. Shared by the post explorer and the admin report.
pub fn post_text_contains(text: Option<&str>, needle: &str) -> bool {
    text.is_some_and(|text| text.to_lowercase().contains(needle))
}

pub async fn user_posts(
    db: &mut Db,
    member_id: i64,
    post_filter: Option<&str>,
    post_sort: &str,
    post_page: usize,
    post_page_size: usize,
) -> ApiResult<PostPage> {
    let data = Dataset::load(db, &[member_id]).await?;
    let mut posts: Vec<PostStat> = data
        .posts(member_id)
        .iter()
        .map(|post| post_stats(&data, post).0)
        .collect();
    let needle = post_filter
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_lowercase);
    if let Some(needle) = needle {
        posts.retain(|post| post_text_contains(post.text_preview.as_deref(), &needle));
    }
    posts.sort_by(|a, b| {
        let order = match post_sort {
            "oldest" => a.posted_at.cmp(&b.posted_at),
            "impressions" => b.impressions.cmp(&a.impressions),
            "reactions" => b.reactions.cmp(&a.reactions),
            "comments" => b.comments.cmp(&a.comments),
            "reposts" => b.reposts.cmp(&a.reposts),
            "sends" => b.sends.cmp(&a.sends),
            "saves" => b.saves.cmp(&a.saves),
            _ => b.posted_at.cmp(&a.posted_at),
        };
        order.then_with(|| b.posted_at.cmp(&a.posted_at))
    });
    let total = posts.len();
    let page_count = total.div_ceil(post_page_size).max(1);
    let page = post_page.clamp(1, page_count);
    let start = (page - 1) * post_page_size;
    Ok(PostPage {
        follower_count: data.profile(member_id).iter().rev().find_map(|p| p.follower_count),
        posts: posts.into_iter().skip(start).take(post_page_size).collect(),
        total,
        page,
        page_count,
    })
}

pub async fn admin_overview(db: &mut Db, admin: &Member) -> ApiResult<AdminOverview> {
    let owned: Vec<i64> =
        ChallengeMembership::filter(ChallengeMembership::fields().member_id().eq(admin.id))
            .exec(&mut *db)
            .await?
            .into_iter()
            .filter(|membership| membership.role == "owner")
            .map(|membership| membership.challenge_id)
            .collect();
    let mut comps = challenges_by_ids(db, owned).await?;
    comps.sort_by(|a, b| b.start_at.cmp(&a.start_at));
    let competitions: Vec<CompetitionInfo> = comps.iter().map(CompetitionInfo::new).collect();

    let current = active_competition(comps, now_unix());
    let data = match &current {
        Some(c) => Dataset::load_for_competition(db, c).await?,
        None => Dataset::default(),
    };
    let standings = match &current {
        Some(c) => rank(standings_from(c, &data, now_unix())),
        None => Vec::new(),
    };

    let mut invites = match &current {
        Some(challenge) => {
            Invite::filter(Invite::fields().challenge_id().eq(challenge.id))
                .exec(&mut *db)
                .await?
        }
        None => Vec::new(),
    };
    invites.sort_by(|a, b| b.created_at.cmp(&a.created_at));

    // Engagement totals come from the latest snapshot of every in-window post, which is the same
    // basis the scoring uses — so the aggregate and the leaderboard can't disagree.
    let mut totals = (0i64, 0i64, 0i64, 0i64);
    let mut total_posts = 0usize;
    for m in data.members.values() {
        for post in data.posts(m.id) {
            let (stat, posted_at) = post_stats(&data, post);
            let counted = match &current {
                Some(c) => posted_at >= c.start_at && posted_at <= c.end_at,
                None => false,
            };
            if counted {
                total_posts += 1;
                totals.0 += stat.impressions;
                totals.1 += stat.reactions;
                totals.2 += stat.comments;
                totals.3 += stat.reposts;
            }
        }
    }

    let aggregate = Aggregate {
        participants: data.members.len(),
        scoring_participants: standings.len(),
        total_posts,
        graded_posts: standings.iter().map(|s| s.graded_posts).sum(),
        total_impressions: totals.0,
        total_reactions: totals.1,
        total_comments: totals.2,
        total_reposts: totals.3,
        total_followers: standings.iter().map(|s| s.follower_count).sum(),
        total_points: standings.iter().map(|s| s.total).sum(),
        invites_open: invites.iter().filter(|i| !i.redeemed).count(),
        invites_redeemed: invites.iter().filter(|i| i.redeemed).count(),
    };

    Ok(AdminOverview {
        admin_name: admin.display_name.clone(),
        current: current.as_ref().map(CompetitionInfo::new),
        competitions,
        standings,
        invites: invites
            .into_iter()
            .map(|i| InviteRow {
                code: i.code,
                email: i.email,
                role: i.role,
                redeemed: i.redeemed,
                created_at: i.created_at,
            })
            .collect(),
        aggregate,
        defaults: ScoringConfig::default(),
    })
}

// --- system admin ----------------------------------------------------------------------------

/// One member as the system panel sees them — enough to pick an impersonation target.
#[derive(Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct SystemMemberRow {
    pub follower_count: Option<i64>,
    pub id: i64,
    pub display_name: String,
    pub email: Option<String>,
    pub owns_challenge: bool,
    pub is_system_admin: bool,
    /// Unix seconds of the newest profile snapshot — a proxy for "is the extension syncing".
    pub last_synced_at: Option<i64>,
    pub created_at: i64,
    /// When an admin deleted the account (unix seconds), or null. The page hides these rows
    /// unless asked to show them.
    #[schema(required)]
    pub deleted_at: Option<i64>,
}

#[derive(Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct SystemOverview {
    pub members: Vec<SystemMemberRow>,
    /// The company join code an admin generated (or the fixed `JOIN_CODE` if none has been
    /// generated yet), or null when joining is switched off.
    #[schema(required)]
    pub join_code: Option<String>,
}

/// Per member: when they last synced, and their newest known follower count.
pub struct ProfileReadings {
    /// Newest `ProfileSnapshot.captured_at`. The sync endpoint writes a profile snapshot on every
    /// successful sync, changed posts or not, so this is "last synced".
    pub last_synced: std::collections::HashMap<i64, i64>,
    pub followers: std::collections::HashMap<i64, i64>,
}

/// One whole-table read of `profile_snapshots`, shared by the system panel and the reporting API.
pub async fn profile_readings(db: &mut Db) -> ApiResult<ProfileReadings> {
    let mut last_synced: std::collections::HashMap<i64, i64> = std::collections::HashMap::new();
    let mut followers = std::collections::HashMap::new();
    for snapshot in crate::models::ProfileSnapshot::all().exec(&mut *db).await? {
        if let Some(count) = snapshot.follower_count {
            let entry = followers.entry(snapshot.member_id).or_insert(((snapshot.captured_at, snapshot.id), count));
            if (snapshot.captured_at, snapshot.id) > entry.0 {
                *entry = ((snapshot.captured_at, snapshot.id), count);
            }
        }
        let entry = last_synced.entry(snapshot.member_id).or_insert(snapshot.captured_at);
        *entry = (*entry).max(snapshot.captured_at);
    }
    Ok(ProfileReadings {
        last_synced,
        followers: followers.into_iter().map(|(id, (_, count))| (id, count)).collect(),
    })
}

/// Every account, for the hand-operated product support panel. Deleted accounts are included
/// with `deleted_at` set, so the page can offer to restore them.
pub async fn system_overview(db: &mut Db) -> ApiResult<SystemOverview> {
    // Three whole-table reads rather than two queries per account: this panel lists everyone,
    // so per-row lookups would grow with the user base against a remote database.
    let mut users = Member::all().exec(&mut *db).await?;
    users.sort_by(|a, b| a.display_name.cmp(&b.display_name));
    let owners: std::collections::HashSet<i64> = ChallengeMembership::all()
        .exec(&mut *db)
        .await?
        .into_iter()
        .filter(|membership| membership.role == "owner")
        .map(|membership| membership.member_id)
        .collect();
    let ProfileReadings { last_synced, followers } = profile_readings(db).await?;
    let members = users
        .into_iter()
        .map(|user| SystemMemberRow {
            follower_count: followers.get(&user.id).copied(),
            id: user.id,
            owns_challenge: owners.contains(&user.id),
            last_synced_at: last_synced.get(&user.id).copied(),
            display_name: user.display_name,
            email: user.email,
            is_system_admin: user.is_system_admin,
            created_at: user.created_at,
            deleted_at: user.deleted_at,
        })
        .collect();
    // The generated code is the one to share; the fixed `JOIN_CODE` is shown only until an admin
    // generates one.
    let join_code = match crate::auth::active_join_code(db).await? {
        Some(code) => Some(code),
        None => crate::auth::fixed_join_code(),
    };
    Ok(SystemOverview { members, join_code })
}
