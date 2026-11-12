//! Removing what we hold for a person: one post at a time when it leaves their LinkedIn feed, or
//! the whole account when an admin deletes someone who has left the company.
//!
//! The database has no foreign keys or cascades, so every table that points at a member or a post
//! is cleared here by hand. Anything missed is orphaned, so keep this in step with `models.rs`.

use toasty::Db;

use crate::models::{
    AdminSession, ApiKey, ChallengeMembership, Competition, DeviceToken, Invite, Member, Post,
    PostComment, PostSnapshot, ProfileSnapshot,
};
use crate::util::new_bearer_token;
use crate::web::ApiResult;

/// Delete these posts with their snapshots and comments. Children go first, so a failure part-way
/// leaves the post itself in place to be found and deleted again.
pub async fn delete_posts(db: &mut Db, post_ids: Vec<i64>) -> toasty::Result<()> {
    if post_ids.is_empty() {
        return Ok(());
    }
    PostComment::filter(PostComment::fields().post_id().in_list(post_ids.clone()))
        .delete()
        .exec(&mut *db)
        .await?;
    PostSnapshot::filter(PostSnapshot::fields().post_id().in_list(post_ids.clone()))
        .delete()
        .exec(&mut *db)
        .await?;
    Post::filter(Post::fields().id().in_list(post_ids))
        .delete()
        .exec(&mut *db)
        .await?;
    Ok(())
}

/// Why this account cannot be deleted yet, if it owns a challenge: a challenge with no owner
/// would have nobody able to manage it. The message names the challenges so the admin knows
/// which ones to hand over or remove.
pub async fn challenge_ownership_refusal(db: &mut Db, member_id: i64) -> ApiResult<Option<String>> {
    let owned_ids: Vec<i64> =
        ChallengeMembership::filter(ChallengeMembership::fields().member_id().eq(member_id))
            .exec(&mut *db)
            .await?
            .into_iter()
            .filter(|membership| membership.role == "owner")
            .map(|membership| membership.challenge_id)
            .collect();
    let mut names: Vec<String> = Competition::all()
        .exec(&mut *db)
        .await?
        .into_iter()
        .filter(|challenge| challenge.creator_id == member_id || owned_ids.contains(&challenge.id))
        .map(|challenge| challenge.name)
        .collect();
    // An owner membership whose challenge row is already gone owns nothing anyone can manage.
    if names.is_empty() {
        return Ok(None);
    }
    names.sort();
    names.dedup();
    Ok(Some(format!(
        "this account owns {} ({}); hand it to someone else or remove it before deleting the account",
        if names.len() == 1 { "a challenge" } else { "challenges" },
        names.join(", ")
    )))
}

/// Delete a member and everything recorded for them.
///
/// Order matters because there is no transaction across these statements. Access goes first, so
/// the person is signed out and their extension refused even if a later step fails. The member row
/// goes last, so a failure part-way leaves the account listed and the admin can simply delete it
/// again; every step is a filtered delete, so repeating one that already ran does nothing.
///
/// Kept on purpose: the company join link they may have generated (`JoinLink.created_by` is only
/// a note of who made it, and the link must keep working for everyone else), and comments they
/// left on other people's posts (those belong to the other person's post and its score).
pub async fn delete_member(db: &mut Db, member: &Member) -> ApiResult<()> {
    let id = member.id;

    // 1. Access: extension tokens, website sessions (theirs, and any where they were viewing as
    // someone else), and the reporting API keys that carried their admin access.
    DeviceToken::filter(DeviceToken::fields().member_id().eq(id))
        .delete()
        .exec(&mut *db)
        .await?;
    // Installs linked before device tokens existed sign in with this hash; replacing it with one
    // nobody holds shuts them out now rather than when the row goes.
    let (_unused, fresh_hash) = new_bearer_token();
    toasty::update!(Member::filter_by_id(id) { api_token_hash: fresh_hash })
        .exec(&mut *db)
        .await?;
    AdminSession::filter(AdminSession::fields().admin_id().eq(id))
        .delete()
        .exec(&mut *db)
        .await?;
    AdminSession::filter(AdminSession::fields().impersonator_id().eq(Some(id)))
        .delete()
        .exec(&mut *db)
        .await?;
    ApiKey::filter(ApiKey::fields().created_by().eq(id))
        .delete()
        .exec(&mut *db)
        .await?;

    // 2. What they recorded: posts (with snapshots and comments), profile readings, challenge
    // memberships, and invitations addressed to their email.
    let post_ids: Vec<i64> = Post::filter(Post::fields().member_id().eq(id))
        .exec(&mut *db)
        .await?
        .into_iter()
        .map(|post| post.id)
        .collect();
    delete_posts(db, post_ids).await?;
    ProfileSnapshot::filter(ProfileSnapshot::fields().member_id().eq(id))
        .delete()
        .exec(&mut *db)
        .await?;
    ChallengeMembership::filter(ChallengeMembership::fields().member_id().eq(id))
        .delete()
        .exec(&mut *db)
        .await?;
    if let Some(email) = &member.email {
        Invite::filter(Invite::fields().email().eq(Some(email.clone())))
            .delete()
            .exec(&mut *db)
            .await?;
    }

    // 3. The account itself, last.
    Member::filter_by_id(id).delete().exec(&mut *db).await?;
    Ok(())
}
