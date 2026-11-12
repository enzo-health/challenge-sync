//! Automatic enrollment: everyone is a participant in whatever challenge is currently running.
//!
//! Invitations still exist for owners and for challenges that haven't started, but the common
//! case — a teammate signs up while the Cup is on — should put them on the board with no one
//! having to do anything. Enrollment happens on signup, on login (so accounts created before the
//! challenge pick it up the next time they sign in), and once at server start for everyone.

use toasty::Db;

use crate::models::{ChallengeMembership, Competition, Member};
use crate::util::now_unix;

/// Challenges that are active and whose window contains `now`.
pub async fn running_challenges(db: &mut Db, now: i64) -> toasty::Result<Vec<Competition>> {
    let mut comps = Competition::all().exec(&mut *db).await?;
    comps.retain(|c| c.is_active && c.start_at <= now && now <= c.end_at);
    Ok(comps)
}

/// Make `member_id` a participant in every running challenge it hasn't joined yet.
/// Returns the ids of the challenges it was added to.
pub async fn enroll_in_running_challenges(db: &mut Db, member_id: i64) -> toasty::Result<Vec<i64>> {
    let now = now_unix();
    let running = running_challenges(db, now).await?;
    if running.is_empty() {
        return Ok(Vec::new());
    }
    let joined: Vec<i64> =
        ChallengeMembership::filter(ChallengeMembership::fields().member_id().eq(member_id))
            .exec(&mut *db)
            .await?
            .into_iter()
            .map(|m| m.challenge_id)
            .collect();

    let mut added = Vec::new();
    for challenge in running {
        if joined.contains(&challenge.id) {
            continue;
        }
        toasty::create!(ChallengeMembership {
            challenge_id: challenge.id,
            member_id,
            role: "participant",
            is_favorite: false,
            joined_at: now,
        })
        .exec(&mut *db)
        .await?;
        added.push(challenge.id);
    }
    Ok(added)
}

/// Enroll every existing account in every running challenge. Idempotent; run at startup so a
/// deploy that introduces auto-enrollment backfills the people who signed up before it.
/// Deleted accounts are skipped; one that is restored joins at its next sign-in.
///
/// Three reads and then only the inserts that are actually missing — on a quiet start, no writes.
pub async fn enroll_everyone(db: &mut Db) -> toasty::Result<usize> {
    let now = now_unix();
    let running = running_challenges(db, now).await?;
    if running.is_empty() {
        return Ok(0);
    }
    let mut members = Member::all().exec(&mut *db).await?;
    members.retain(|member| !member.is_deleted());
    let existing: std::collections::HashSet<(i64, i64)> = ChallengeMembership::all()
        .exec(&mut *db)
        .await?
        .into_iter()
        .map(|m| (m.challenge_id, m.member_id))
        .collect();
    let mut added = 0;
    for challenge in &running {
        for member in &members {
            if existing.contains(&(challenge.id, member.id)) {
                continue;
            }
            toasty::create!(ChallengeMembership {
                challenge_id: challenge.id,
                member_id: member.id,
                role: "participant",
                is_favorite: false,
                joined_at: now,
            })
            .exec(&mut *db)
            .await?;
            added += 1;
        }
    }
    Ok(added)
}
