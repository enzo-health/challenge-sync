//! Removing what we hold for a person: one post at a time when it leaves their LinkedIn feed, and
//! closing the account of someone who has left the company.
//!
//! The database has no foreign keys or cascades, so the tables that point at a post are cleared
//! here by hand. Closing an account removes nothing the person recorded; it marks the account
//! deleted and removes only what lets them in.

use toasty::Db;

use crate::models::{
    AdminSession, ApiKey, ChallengeMembership, Competition, DeviceToken, Member, Post, PostComment,
    PostSnapshot,
};
use crate::util::{new_bearer_token, now_unix};
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

/// Mark an account deleted and cut off every way it gets in. Nothing recorded for the person is
/// removed: posts, snapshots, comments, profile readings and challenge memberships all stay, so
/// past reports keep their numbers and [`restore_member`] can bring the account back.
///
/// The mark goes first: from then on every sign-in route refuses the account (see
/// `auth::session_from_token` and `auth::member_from_bearer`), even if a later step fails. The
/// rest removes what would otherwise sit around holding access, and is safe to run again, so an
/// admin can simply repeat a delete that stopped part-way. Running it on an account that is
/// already deleted keeps the original date.
pub async fn mark_member_deleted(db: &mut Db, member: &Member) -> ApiResult<()> {
    let id = member.id;
    let deleted_at = member.deleted_at.unwrap_or_else(now_unix);
    // Installs linked before device tokens existed sign in with this hash; replacing it with one
    // nobody holds means a restore does not quietly revive them either.
    let (_unused, fresh_hash) = new_bearer_token();
    toasty::update!(Member::filter_by_id(id) {
        deleted_at: Some(deleted_at),
        is_system_admin: false,
        api_token_hash: fresh_hash,
    })
    .exec(&mut *db)
    .await?;

    // Extension tokens, website sessions (theirs, and any where they were viewing as someone
    // else), and the reporting API keys that carried their admin access.
    DeviceToken::filter(DeviceToken::fields().member_id().eq(id))
        .delete()
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
    Ok(())
}

/// Clear the deleted mark. Access is not given back: the person signs in again the usual way
/// (the company link, or their password), and admin access has to be granted again.
pub async fn restore_member(db: &mut Db, id: i64) -> ApiResult<()> {
    toasty::update!(Member::filter_by_id(id) { deleted_at: None })
        .exec(&mut *db)
        .await?;
    Ok(())
}
