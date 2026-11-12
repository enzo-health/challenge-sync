//! `POST /api/sync` — ingest a snapshot batch from the extension. Bearer-authenticated.
//! Server stamps its own capture time (clients can be skewed). See `docs/sync-protocol.md`.

use axum::{Extension, Json};
use http::HeaderMap;
use linkedin_challenge_server::accounts::delete_posts;
use linkedin_challenge_server::auth::member_from_bearer;
use linkedin_challenge_server::models::{Member, Post, PostComment, PostSnapshot, ProfileSnapshot};
use linkedin_challenge_server::util::{now_unix, parse_iso8601};
use linkedin_challenge_server::web::ApiError;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use toasty::Db;
use utoipa::ToSchema;

const NEXT_SYNC_SECONDS: i64 = 6 * 3600;
const MAX_POST_TEXT_CHARS: usize = 10_000;

fn bounded_post_text(text: Option<&str>) -> Option<String> {
    text.map(|value| value.chars().take(MAX_POST_TEXT_CHARS).collect())
}

fn bounded_image_urls(urls: &[String]) -> Vec<String> {
    urls.iter()
        .filter(|url| url.starts_with("https://media.licdn.com/") && url.chars().count() <= 2_048)
        .take(10)
        .cloned()
        .collect()
}

/// LinkedIn spells one member several ways (`fs_miniProfile`, `fsd_profile`, `member`, and the
/// rendered page only exposes a public identifier); the id after the last colon is the stable
/// part, so "is this my own comment?" compares that against both the member's URN and their
/// public identifier.
fn same_person(commenter_urn: &str, member: &Member) -> bool {
    let tail = |urn: &str| urn.rsplit(':').next().unwrap_or("").trim_matches(|c| c == '(' || c == ')').to_string();
    let t = tail(commenter_urn);
    if t.is_empty() {
        return false;
    }
    t == tail(&member.linkedin_urn) || (!member.public_identifier.is_empty() && t == member.public_identifier)
}

#[derive(Deserialize, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct SyncRequest {
    pub captured_at: Option<String>,
    pub profile: ProfilePayload,
    pub posts: Vec<PostPayload>,
    /// Nested originals included in normalized reshare responses, but not authored by this member.
    #[serde(default)]
    pub excluded_post_urns: Vec<String>,
    /// True only when LinkedIn returned fewer than the requested page size, making absence from
    /// `posts` evidence of deletion rather than pagination.
    #[serde(default)]
    pub post_feed_complete: bool,
    /// Every post URN on an under-full feed page, including posts left out of `posts` because they
    /// are past the refresh window and already recorded. Present only when the page is complete;
    /// reconciliation then keeps everything named here. It is a separate field because
    /// `post_feed_complete` must stay false whenever posts were left out: a server that predates
    /// this field would otherwise delete them.
    #[serde(default)]
    pub complete_post_feed_urns: Option<Vec<String>>,
}

#[derive(Deserialize, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ProfilePayload {
    pub follower_count: Option<i64>,
    pub profile_views: Option<i64>,
}

#[derive(Deserialize, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct PostPayload {
    pub urn: String,
    pub permalink: String,
    pub created_at: Option<String>,
    pub text_preview: Option<String>,
    #[serde(default)]
    pub image_urls: Vec<String>,
    #[serde(default)]
    pub is_repost: bool,
    pub metrics: Metrics,
    /// Comments the extension could read, with their authors. Absent or empty simply means we
    /// didn't read any this time — it is not a claim that the post has none.
    #[serde(default)]
    pub comments: Vec<CommentPayload>,
}

#[derive(Deserialize, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct CommentPayload {
    pub urn: String,
    pub commenter_urn: String,
    pub commenter_name: Option<String>,
    pub created_at: Option<String>,
    /// True for a reply inside a thread rather than a top-level comment.
    #[serde(default)]
    pub is_reply: bool,
}

#[derive(Default, Deserialize, Serialize, ToSchema)]
#[serde(rename_all = "camelCase", default)]
pub struct Metrics {
    pub impressions: Option<i64>,
    pub reactions: Option<i64>,
    pub comments: Option<i64>,
    pub reposts: Option<i64>,
    pub sends: Option<i64>,
    pub saves: Option<i64>,
    pub impressions_in_network: Option<i64>,
    pub impressions_out_of_network: Option<i64>,
    pub members_reached: Option<i64>,
    pub profile_viewers_from_post: Option<i64>,
    pub followers_from_post: Option<i64>,
}

#[derive(Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct SyncResponse {
    pub ok: bool,
    pub posts_ingested: usize,
    pub next_sync_after_seconds: i64,
}

#[nextrs::api(
    operation_id = "pushSync",
    responses(
        (status = 200, description = "Snapshot batch ingested", body = SyncResponse),
        (status = 401, description = "Invalid or missing sync token", body = ApiError),
    ),
)]
pub async fn post(
    Extension(mut db): Extension<Db>,
    headers: HeaderMap,
    Json(req): Json<SyncRequest>,
) -> Result<Json<SyncResponse>, ApiError> {
    let Some(member) = member_from_bearer(&mut db, &headers).await else {
        return Err(ApiError::unauthorized("invalid or missing sync token"));
    };

    let captured_at = now_unix(); // server clock is authoritative for windowing

    // One profile snapshot per sync.
    toasty::create!(ProfileSnapshot {
        member_id: member.id,
        captured_at,
        follower_count: req.profile.follower_count,
        profile_views: req.profile.profile_views,
    })
    .exec(&mut db)
    .await?;

    // This member's stored posts, read once: the reconciliation below and the upsert loop both
    // key off URN, and a lookup per post would be a round trip per post against a remote database.
    let mut stored: HashMap<String, Post> = Post::filter(Post::fields().member_id().eq(member.id))
        .exec(&mut db)
        .await?
        .into_iter()
        .map(|post| (post.urn.clone(), post))
        .collect();

    // Older extension builds treated normalized entities nested under a reshare as separate posts.
    // Reconcile only explicit nested URNs; a URN stored under another member is simply not ours.
    let mut doomed: Vec<i64> = req
        .excluded_post_urns
        .iter()
        .filter_map(|urn| stored.remove(urn).map(|post| post.id))
        .collect();

    // A deleted-and-reposted LinkedIn post has a new activity URN. When the feed page is known to
    // be complete, remove stored URNs LinkedIn no longer returns so the deleted original does not
    // live forever beside its replacement. Never reconcile a full page: missing rows may be on the
    // next page rather than deleted. Posts past the refresh window are on the page but not in
    // `posts`; `complete_post_feed_urns` names them so they are not mistaken for deleted.
    let current_urns: Option<HashSet<&str>> = match &req.complete_post_feed_urns {
        Some(urns) => Some(
            urns.iter()
                .map(String::as_str)
                .chain(req.posts.iter().map(|post| post.urn.as_str()))
                .collect(),
        ),
        None if req.post_feed_complete => Some(req.posts.iter().map(|post| post.urn.as_str()).collect()),
        None => None,
    };
    if let Some(current_urns) = current_urns {
        let gone: Vec<String> = stored
            .keys()
            .filter(|urn| !current_urns.contains(urn.as_str()))
            .cloned()
            .collect();
        for urn in gone {
            if let Some(post) = stored.remove(&urn) {
                doomed.push(post.id);
            }
        }
    }
    delete_posts(&mut db, doomed).await?;

    // URNs in this batch that already belong to someone else. One batched check keeps the old
    // guarantee — a post is never reassigned between members — without a lookup per post.
    let batch_urns: Vec<String> = req.posts.iter().map(|post| post.urn.clone()).collect();
    let foreign: HashSet<String> = if batch_urns.is_empty() {
        HashSet::new()
    } else {
        Post::filter(Post::fields().urn().in_list(batch_urns))
            .exec(&mut db)
            .await?
            .into_iter()
            .filter(|post| post.member_id != member.id)
            .map(|post| post.urn)
            .collect()
    };

    // Comment URNs already on file, looked up GLOBALLY by the URNs in this batch. A repost shows
    // the original's comments under the reposter's feed too, so the same comment URN arrives from
    // two members; scoping this to the current member's posts is how a second member's sync used
    // to die on the unique index every time.
    let batch_comment_urns: Vec<String> = req
        .posts
        .iter()
        .filter(|post| !post.is_repost)
        .flat_map(|post| post.comments.iter().map(|comment| comment.urn.clone()))
        .collect();
    let mut known_comments: HashSet<String> = if batch_comment_urns.is_empty() {
        HashSet::new()
    } else {
        PostComment::filter(PostComment::fields().urn().in_list(batch_comment_urns))
            .exec(&mut db)
            .await?
            .into_iter()
            .map(|comment| comment.urn)
            .collect()
    };

    // The latest stored reading of each already-known post in this batch, so an unchanged reading
    // can be skipped. Toasty cannot ask for "latest per post" in SQL, so this loads those posts'
    // readings in one query and keeps the newest of each; skipping repeats keeps that history short.
    let known_post_ids: Vec<i64> = req
        .posts
        .iter()
        .filter(|post| !foreign.contains(&post.urn))
        .filter_map(|post| stored.get(&post.urn).map(|stored| stored.id))
        .collect();
    let mut latest: HashMap<i64, PostSnapshot> = HashMap::new();
    if !known_post_ids.is_empty() {
        for snapshot in PostSnapshot::filter(PostSnapshot::fields().post_id().in_list(known_post_ids))
            .exec(&mut db)
            .await?
        {
            let newer = latest
                .get(&snapshot.post_id)
                .is_none_or(|current| (snapshot.captured_at, snapshot.id) > (current.captured_at, current.id));
            if newer {
                latest.insert(snapshot.post_id, snapshot);
            }
        }
    }

    // Upsert each post by URN, then append a metric snapshot unless nothing changed.
    let mut ingested = 0usize;
    for p in &req.posts {
        if foreign.contains(&p.urn) {
            continue;
        }
        let text_preview = bounded_post_text(p.text_preview.as_deref());
        let image_urls_json = serde_json::to_string(&bounded_image_urls(&p.image_urls)).ok();
        let post_id = match stored.get(&p.urn) {
            Some(post) => {
                // Backfill a creation time we didn't have before. Posts ingested while the
                // extension couldn't determine one are stored with 0 and fall back to "first
                // snapshot", which reads as "posted today"; a later sync repairs them in place.
                let created_at = if post.created_at == 0 {
                    p.created_at
                        .as_deref()
                        .and_then(parse_iso8601)
                        .filter(|created_at| *created_at > 0)
                        .unwrap_or(post.created_at)
                } else {
                    post.created_at
                };
                toasty::update!(Post::filter_by_id(post.id) {
                    created_at,
                    permalink: &p.permalink,
                    text_preview: text_preview.clone(),
                    image_urls_json: image_urls_json.clone(),
                    is_repost: p.is_repost,
                })
                .exec(&mut db)
                .await?;
                post.id
            }
            None => {
                let created_at = p.created_at.as_deref().and_then(parse_iso8601).unwrap_or(0);
                let post = toasty::create!(Post {
                    member_id: member.id,
                    urn: &p.urn,
                    permalink: &p.permalink,
                    created_at,
                    text_preview,
                    image_urls_json,
                    is_repost: p.is_repost,
                })
                .exec(&mut db)
                .await?;
                post.id
            }
        };

        let mut reading = PostSnapshot {
            id: 0,
            post_id,
            post: Default::default(),
            captured_at,
            impressions: p.metrics.impressions,
            reactions: p.metrics.reactions,
            comments: p.metrics.comments,
            reposts: p.metrics.reposts,
            sends: p.metrics.sends,
            saves: p.metrics.saves,
            impressions_in_network: p.metrics.impressions_in_network,
            impressions_out_of_network: p.metrics.impressions_out_of_network,
            members_reached: p.metrics.members_reached,
            profile_viewers_from_post: p.metrics.profile_viewers_from_post,
            followers_from_post: p.metrics.followers_from_post,
        };
        // The author-only analytics request is best-effort; when it fails the reading arrives
        // without those numbers. A number we have recorded for this post never goes back to
        // unknown, so a missing one keeps the post's latest stored value.
        if let Some(last) = latest.get(&post_id) {
            reading.carry_forward_from(last);
        }
        // A reading identical to the latest one is not stored. Scoring takes the latest reading at
        // or before a challenge's end, and the earlier identical row answers that with the same
        // numbers, so no score moves. The earlier row is never re-stamped either: moving it past a
        // challenge's end would leave the post with no reading inside that window. The time check
        // only matters if the clock ever stepped back; then the reading is stored as before.
        let unchanged = latest
            .get(&post_id)
            .is_some_and(|last| captured_at >= last.captured_at && last.same_reading(&reading));
        if !unchanged {
            let created = toasty::create!(PostSnapshot {
                post_id,
                captured_at,
                impressions: reading.impressions,
                reactions: reading.reactions,
                comments: reading.comments,
                reposts: reading.reposts,
                sends: reading.sends,
                saves: reading.saves,
                impressions_in_network: reading.impressions_in_network,
                impressions_out_of_network: reading.impressions_out_of_network,
                members_reached: reading.members_reached,
                profile_viewers_from_post: reading.profile_viewers_from_post,
                followers_from_post: reading.followers_from_post,
            })
            .exec(&mut db)
            .await?;
            // A post named twice in one upload compares its second reading against its first.
            latest.insert(post_id, created);
        }

        // Comments are facts, not readings: upsert by URN so a re-sync doesn't duplicate them.
        // `is_self` is decided here, against the member who owns the post, so scoring never has to
        // re-derive it from a URN comparison that could drift. Comments on a repost belong to the
        // original author's post, so none are stored under the reposter's; scoring then uses
        // LinkedIn's own total for that post, as it does for any post with no rows read.
        let comments: &[CommentPayload] = if p.is_repost { &[] } else { &p.comments };
        for c in comments {
            if !known_comments.insert(c.urn.clone()) {
                continue;
            }
            toasty::create!(PostComment {
                post_id,
                urn: &c.urn,
                commenter_urn: &c.commenter_urn,
                commenter_name: c.commenter_name.clone(),
                is_self: same_person(&c.commenter_urn, &member),
                is_reply: c.is_reply,
                created_at: c.created_at.as_deref().and_then(parse_iso8601).unwrap_or(0),
                captured_at,
            })
            .exec(&mut db)
            .await?;
        }

        ingested += 1;
    }

    Ok(Json(SyncResponse {
        ok: true,
        posts_ingested: ingested,
        next_sync_after_seconds: NEXT_SYNC_SECONDS,
    }))
}
