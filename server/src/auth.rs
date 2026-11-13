//! Auth as plain functions over a `Db` handle and the request headers.
//!
//! **Everyone signs in.** Users are `Member` rows with an email and an Argon2 password hash;
//! challenge roles live on memberships and product operators use `is_system_admin`. A session is
//! a random token whose SHA-256 we store, handed back as an `HttpOnly` cookie.
//!
//! The extension is the one exception: it authenticates with a bearer sync token instead of the
//! cookie, because it acts on the member's behalf from a different origin.
//!
//! Topcoat supplied cookie sessions; on nextrs we mint the token ourselves and store only its
//! hash, which is the same trust model with one fewer framework dependency.

use argon2::password_hash::{PasswordHash, SaltString, rand_core::OsRng};
use argon2::{Argon2, PasswordHasher, PasswordVerifier};
use http::HeaderMap;
use toasty::Db;

use crate::models::{AdminSession, ApiKey, DeviceToken, JoinLink, Member};
use crate::util::{API_KEY_PREFIX, hash_bearer_token, new_api_key, new_bearer_token, now_unix};

/// Session lifetime (30 days), applied to both the cookie and the stored row.
pub const SESSION_SECS: i64 = 30 * 86400;

pub const SESSION_COOKIE: &str = "session";

// --- passwords -------------------------------------------------------------------------------

pub fn hash_password(pw: &str) -> String {
    let salt = SaltString::generate(&mut OsRng);
    Argon2::default()
        .hash_password(pw.as_bytes(), &salt)
        .map(|h| h.to_string())
        .unwrap_or_default()
}

pub fn verify_password(pw: &str, hash: &str) -> bool {
    match PasswordHash::new(hash) {
        Ok(parsed) => Argon2::default()
            .verify_password(pw.as_bytes(), &parsed)
            .is_ok(),
        Err(_) => false,
    }
}

/// The only email domain allowed to create an account right now. The platform is internal to
/// Enzo for the moment; anyone else gets a deliberately uninformative rejection.
pub const ALLOWED_EMAIL_DOMAIN: &str = "enzo.health";

/// Rejection shown for an email outside [`ALLOWED_EMAIL_DOMAIN`]. Intentionally does not say why.
pub const EMAIL_DOMAIN_REJECTION: &str =
    "Your email is not valid. Please contact Drew or Jason if they fail to sign up.";

/// Whether a new account may be created for this email (see [`ALLOWED_EMAIL_DOMAIN`]).
/// Existing accounts on other domains are unaffected: this gates creation, not login.
pub fn signup_email_allowed(email: &str) -> bool {
    email
        .trim()
        .rsplit_once('@')
        .is_some_and(|(_, domain)| domain.eq_ignore_ascii_case(ALLOWED_EMAIL_DOMAIN))
}

/// Shared shape validation for direct signup and invite redemption. Browser constraints are only
/// a UX aid; the API remains the authority because it is callable without our form. The domain
/// gate ([`signup_email_allowed`]) is separate: it applies to account *creation*, and invite
/// redemption by an existing account is not creation.
pub fn account_validation_error(name: &str, email: &str, password: &str) -> Option<&'static str> {
    let name_len = name.trim().chars().count();
    if !(1..=100).contains(&name_len) {
        return Some("name must be between 1 and 100 characters");
    }
    let email = email.trim();
    let email_valid = email.len() <= 254
        && !email.chars().any(char::is_whitespace)
        && email.split_once('@').is_some_and(|(local, domain)| {
            !local.is_empty() && !domain.is_empty() && domain.contains('.')
        });
    if !email_valid {
        return Some("enter a valid email address");
    }
    let password_len = password.chars().count();
    if password_len < 8 {
        return Some("password must be at least 8 characters");
    }
    if password_len > 128 {
        return Some("password must be at most 128 characters");
    }
    None
}

// --- cookies ---------------------------------------------------------------------------------

/// Read one cookie value out of the `Cookie` header.
pub fn cookie(headers: &HeaderMap, name: &str) -> Option<String> {
    let raw = headers.get(http::header::COOKIE)?.to_str().ok()?;
    raw.split(';')
        .filter_map(|part| part.trim().split_once('='))
        .find(|(k, _)| *k == name)
        .map(|(_, v)| v.to_string())
}

/// `Set-Cookie` value that establishes the session. `HttpOnly` keeps it away from page scripts;
/// `SameSite=Lax` is enough: every mutation goes through fetch with a JSON content type.
fn set_cookie(token: &str) -> String {
    let secure = if std::env::var_os("VERCEL").is_some() {
        "; Secure"
    } else {
        ""
    };
    format!(
        "{SESSION_COOKIE}={token}; Path=/; HttpOnly; SameSite=Lax; Max-Age={SESSION_SECS}{secure}"
    )
}

/// `Set-Cookie` value that clears the session.
pub fn clear_cookie() -> String {
    format!("{SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0")
}

/// Find a member by login email, case-insensitively (emails are stored lowercased).
///
/// Login used to look up a synthetic `admin:<email>` URN, which only admins had — participants
/// could never sign in. Email is the login identifier for everyone, so it is also the uniqueness
/// check at signup and join: two different URN prefixes let the same address register twice.
/// It therefore also finds deleted accounts; callers that sign someone in must check
/// [`Member::is_deleted`].
pub async fn member_by_email(db: &mut Db, email: &str) -> toasty::Result<Option<Member>> {
    let email = email.trim().to_lowercase();
    Ok(
        Member::filter(Member::fields().email().eq(Some(email.clone())))
            .first()
            .exec(&mut *db)
            .await?,
    )
}

// --- sessions --------------------------------------------------------------------------

/// A resolved session: who the request acts as, and — under impersonation — who is really driving.
pub struct SessionInfo {
    /// The member every read and write is scoped to. Under impersonation this is the target, so
    /// the rest of the app needs no impersonation awareness at all.
    pub member: Member,
    /// The system admin actually behind the requests, when this session is an impersonation.
    pub impersonator: Option<Member>,
}

/// Resolve a raw session token to its member, honouring expiry.
///
/// Split out from `current_member` because the extension holds the session token itself (read from
/// the cookie jar with `chrome.cookies`) rather than sending a `Cookie` header — `fetch` cannot set
/// one cross-origin, and allowing credentialed cross-origin requests would mean reflecting origins
/// and opening a CSRF surface on every cookie-authed route.
pub async fn member_from_session_token(db: &mut Db, token: &str) -> Option<Member> {
    Some(session_from_token(db, token).await?.member)
}

/// Full resolution of a session token, including the impersonation edge.
///
/// Every cookie-authed route comes through here, so this is where a deleted account is turned
/// away: its session (and any session it was driving as an impersonator) reads as signed out.
/// Deleting also removes those session rows; this check covers anything that slipped past that.
pub async fn session_from_token(db: &mut Db, token: &str) -> Option<SessionInfo> {
    let key = hash_bearer_token(token);
    let sess = AdminSession::filter_by_token_hash(&key)
        .first()
        .exec(&mut *db)
        .await
        .ok()??;
    if sess.expires_at <= now_unix() {
        return None;
    }
    let member = Member::filter_by_id(sess.admin_id)
        .first()
        .exec(&mut *db)
        .await
        .ok()
        .flatten()
        .filter(|member| !member.is_deleted())?;
    let impersonator = match sess.impersonator_id {
        Some(id) => {
            let real = Member::filter_by_id(id)
                .first()
                .exec(&mut *db)
                .await
                .ok()
                .flatten();
            // The impersonator must still BE a system admin: were the flag revoked mid-session,
            // the borrowed session dies with it rather than outliving the privilege.
            match real {
                Some(real) if real.is_system_admin && !real.is_deleted() => Some(real),
                _ => return None,
            }
        }
        None => None,
    };
    Some(SessionInfo {
        member,
        impersonator,
    })
}

/// The full session for this request — member plus any impersonator — or None.
pub async fn current_session(db: &mut Db, headers: &HeaderMap) -> Option<SessionInfo> {
    let token = cookie(headers, SESSION_COOKIE)?;
    session_from_token(db, &token).await
}

/// The signed-in member for this request, or None. Challenge permissions are checked separately
/// against that member's challenge membership.
pub async fn current_member(db: &mut Db, headers: &HeaderMap) -> Option<Member> {
    let token = cookie(headers, SESSION_COOKIE)?;
    member_from_session_token(db, &token).await
}

/// The signed-in member, but only if they operate the product itself.
///
/// Deliberately checks the member the session acts as, not the impersonator: an impersonating
/// system admin sees exactly what the target sees, system panel excluded. They stop impersonating
/// first — one honest view at a time.
pub async fn current_system_admin(db: &mut Db, headers: &HeaderMap) -> Option<Member> {
    current_member(db, headers)
        .await
        .filter(|m| m.is_system_admin)
}

/// Whether this member may see challenges at all: boards, challenge pages, creating and managing
/// challenges, and challenge invitations.
///
/// For now that is system admins only. Regular members see their own posts and the company stats
/// overview, nothing about challenges. This is the one rule: the challenge page guards
/// (`app/{challenges,admin,members,rules}/middleware.rs`) and `dto::require_challenge_user`, which
/// every challenge API goes through, both ask it. Memberships, invites and auto-enrolment on join
/// are left exactly as they were, so letting members back in later is a change here and nothing
/// is lost in between.
pub fn can_use_challenges(member: &Member) -> bool {
    member.is_system_admin
}

/// Start a session for a member: persist the hash, return the `Set-Cookie` value for the response.
pub async fn establish_session(db: &mut Db, member_id: i64) -> toasty::Result<String> {
    establish_session_as(db, member_id, None).await
}

/// Start a session, optionally marked as an impersonation by a system admin.
pub async fn establish_session_as(
    db: &mut Db,
    member_id: i64,
    impersonator_id: Option<i64>,
) -> toasty::Result<String> {
    let secret = new_session_token(db, member_id, impersonator_id).await?;
    Ok(set_cookie(&secret))
}

/// Persist a new session and return its raw token.
///
/// The website gets this wrapped in `Set-Cookie`. The extension gets it bare, because it places
/// the cookie in the browser's jar itself (see `/api/auth/device/web-session`).
pub async fn new_session_token(
    db: &mut Db,
    member_id: i64,
    impersonator_id: Option<i64>,
) -> toasty::Result<String> {
    let (secret, hash) = new_bearer_token();
    toasty::create!(AdminSession {
        token_hash: hash,
        admin_id: member_id,
        expires_at: now_unix() + SESSION_SECS,
        impersonator_id,
    })
    .exec(&mut *db)
    .await?;
    Ok(secret)
}

// --- company join link -----------------------------------------------------------------------

/// Whether `code` is the company's join code.
///
/// One reusable link for everyone, no email. The code is generated by an admin in the app and
/// stored as a `JoinLink` row; generating a new one makes the old link stop working. The
/// `JOIN_CODE` environment variable, when set, is an extra fixed code that also works, so tests
/// and a brand new deployment (before any admin has generated a link) can still let people in.
/// With neither present nobody can join, which is the safe default.
pub async fn join_code_matches(db: &mut Db, code: &str) -> toasty::Result<bool> {
    let stored = active_join_code(db).await?.unwrap_or_default();
    let fixed = fixed_join_code().unwrap_or_default();
    // Check both every time, so the time taken does not hint at which one a guess was close to.
    let stored_ok = join_code_matches_expected(code, &stored);
    let fixed_ok = join_code_matches_expected(code, &fixed);
    Ok(stored_ok | fixed_ok)
}

/// The code an admin generated most recently, or None if nobody has generated one yet.
pub async fn active_join_code(db: &mut Db) -> toasty::Result<Option<String>> {
    // The table holds one row in normal use; taking the newest also covers the moment two admins
    // regenerate at once and both rows briefly exist.
    Ok(JoinLink::all()
        .exec(&mut *db)
        .await?
        .into_iter()
        .max_by_key(|link| link.id)
        .map(|link| link.code))
}

/// The optional fixed code from the `JOIN_CODE` environment variable; None when unset or blank.
pub fn fixed_join_code() -> Option<String> {
    std::env::var("JOIN_CODE")
        .ok()
        .map(|code| code.trim().to_string())
        .filter(|code| !code.is_empty())
}

/// Make a fresh join code, store it, and retire every older one. Returns the new code.
pub async fn regenerate_join_code(db: &mut Db, created_by: i64) -> toasty::Result<String> {
    // A sync-token's worth of randomness, cut to 24 URL-safe characters (144 bits): it goes in a
    // link people paste around, and guessing it is the only other way in.
    let (secret, _) = new_bearer_token();
    let code: String = secret.trim_start_matches("st_").chars().take(24).collect();
    let link = toasty::create!(JoinLink {
        code: &code,
        created_by,
        created_at: now_unix(),
    })
    .exec(&mut *db)
    .await?;
    // Insert first, then delete everything older: if two admins regenerate at once, the later
    // row survives rather than both being deleted.
    JoinLink::filter(JoinLink::fields().id().lt(link.id))
        .delete()
        .exec(&mut *db)
        .await?;
    Ok(code)
}

fn join_code_matches_expected(code: &str, expected: &str) -> bool {
    let (code, expected) = (code.trim(), expected.trim());
    if expected.is_empty() || code.len() != expected.len() {
        return false;
    }
    // Compare every byte so the time taken does not reveal how much of a guess was right.
    code.bytes()
        .zip(expected.bytes())
        .fold(0u8, |diff, (a, b)| diff | (a ^ b))
        == 0
}

/// End the current session (server record + cookie). Returns the clearing `Set-Cookie` value.
pub async fn end_session(db: &mut Db, headers: &HeaderMap) -> String {
    if let Some(token) = cookie(headers, SESSION_COOKIE) {
        let key = hash_bearer_token(&token);
        let _ = AdminSession::delete_by_token_hash(&mut *db, key).await;
    }
    clear_cookie()
}

// --- extension bearer token ------------------------------------------------------------------

fn bearer_token(headers: &HeaderMap) -> Option<&str> {
    headers
        .get(http::header::AUTHORIZATION)?
        .to_str()
        .ok()?
        .strip_prefix("Bearer ")
}

/// The member whose sync token authenticates this request, or None.
///
/// Per-device tokens are checked first; the single legacy hash on the member row is still
/// honoured so extensions linked before device tokens existed keep syncing without relinking.
/// A deleted account's token is refused, like an unknown one.
pub async fn member_from_bearer(db: &mut Db, headers: &HeaderMap) -> Option<Member> {
    let member = token_member(db, headers).await?;
    (!member.is_deleted()).then_some(member)
}

/// The member a device token or legacy member token names, or the coded refusal: an account an
/// admin deleted says so (`account_deleted`), anything else is `sync_token_rejected`. Both are
/// 401, as the bearer routes always answered, so older extensions recover the same way.
pub async fn bearer_member(db: &mut Db, headers: &HeaderMap) -> Result<Member, crate::web::ApiError> {
    use crate::web::{ApiError, codes};
    match token_member(db, headers).await {
        Some(member) if !member.is_deleted() => Ok(member),
        Some(_) => Err(ApiError::unauthorized("this account has been removed; ask an admin to restore it")
            .with_code(codes::ACCOUNT_DELETED)),
        None => Err(ApiError::unauthorized("invalid or missing sync token").with_code(codes::SYNC_TOKEN_REJECTED)),
    }
}

async fn token_member(db: &mut Db, headers: &HeaderMap) -> Option<Member> {
    let raw = bearer_token(headers)?;
    let hash = hash_bearer_token(raw);
    if let Ok(Some(device)) = DeviceToken::filter_by_token_hash(&hash).first().exec(&mut *db).await {
        // Best effort: a failed bookkeeping write must not fail the sync itself.
        let _ = toasty::update!(DeviceToken::filter_by_token_hash(&hash) { last_used_at: now_unix() })
            .exec(&mut *db)
            .await;
        return Member::filter_by_id(device.member_id)
            .first()
            .exec(&mut *db)
            .await
            .ok()
            .flatten();
    }
    Member::filter_by_api_token_hash(&hash)
        .first()
        .exec(&mut *db)
        .await
        .ok()
        .flatten()
}

// --- reporting API keys ----------------------------------------------------------------------

/// Whether the request carries an `Authorization: Bearer ...` header at all.
pub fn has_bearer(headers: &HeaderMap) -> bool {
    bearer_token(headers).is_some()
}

/// The API key this request presents, or None when it is missing, unknown, or revoked.
///
/// Only `api_keys` is consulted, so a sync token is never accepted here; and `member_from_bearer`
/// never looks at `api_keys`, so a key cannot sync. A key also stops working when the admin who
/// created it is no longer an admin, or their account was deleted: it carries their access, not
/// its own.
pub async fn api_key_from_bearer(db: &mut Db, headers: &HeaderMap) -> Option<ApiKey> {
    let raw = bearer_token(headers)?.trim();
    if !raw.starts_with(API_KEY_PREFIX) {
        return None;
    }
    let hash = hash_bearer_token(raw);
    let key = ApiKey::filter_by_key_hash(&hash)
        .first()
        .exec(&mut *db)
        .await
        .ok()??;
    let creator = Member::filter_by_id(key.created_by)
        .first()
        .exec(&mut *db)
        .await
        .ok()??;
    if !creator.is_system_admin || creator.is_deleted() {
        return None;
    }
    // Best effort: a failed bookkeeping write must not fail the read itself.
    let _ = toasty::update!(ApiKey::filter_by_id(key.id) { last_used_at: Some(now_unix()) })
        .exec(&mut *db)
        .await;
    Some(key)
}

/// Make a new API key and store its hash. Returns the stored row and the key, which is never
/// retrievable again.
pub async fn create_api_key(
    db: &mut Db,
    name: &str,
    created_by: i64,
) -> toasty::Result<(ApiKey, String)> {
    let (secret, key_hash) = new_api_key();
    let key = toasty::create!(ApiKey {
        name,
        key_hash,
        created_by,
        created_at: now_unix(),
        last_used_at: None,
    })
    .exec(&mut *db)
    .await?;
    Ok((key, secret))
}

/// Mint a sync token for one more device of `member_id`, leaving every existing device linked.
pub async fn issue_device_token(db: &mut Db, member_id: i64) -> toasty::Result<String> {
    let (secret, token_hash) = new_bearer_token();
    let now = now_unix();
    toasty::create!(DeviceToken {
        token_hash,
        member_id,
        created_at: now,
        last_used_at: now,
    })
    .exec(db)
    .await?;
    Ok(secret)
}

#[cfg(test)]
mod tests {
    use super::{
        account_validation_error, hash_password, join_code_matches_expected, signup_email_allowed,
        verify_password,
    };

    #[test]
    fn join_code_must_match_exactly_and_be_configured() {
        assert!(join_code_matches_expected("enzo-2026", "enzo-2026"));
        assert!(join_code_matches_expected(" enzo-2026 ", "enzo-2026"));
        assert!(!join_code_matches_expected("enzo-2027", "enzo-2026"));
        assert!(!join_code_matches_expected("enzo", "enzo-2026"));
        // An unset variable must not turn the empty string into a valid code.
        assert!(!join_code_matches_expected("", ""));
        assert!(!join_code_matches_expected("anything", ""));
    }

    #[test]
    fn api_keys_are_recognisable_and_stored_only_as_a_hash() {
        let (key, hash) = crate::util::new_api_key();
        assert!(key.starts_with("csk_") && key.len() > 40);
        assert_eq!(hash, crate::util::hash_bearer_token(&key));
        assert_ne!(hash, key);
        let (sync_token, _) = crate::util::new_bearer_token();
        assert!(!sync_token.starts_with(crate::util::API_KEY_PREFIX));
    }

    #[test]
    fn password_hash_verifies_only_the_original_password() {
        let hash = hash_password("correct horse battery staple");
        assert!(!hash.is_empty());
        assert!(verify_password("correct horse battery staple", &hash));
        assert!(!verify_password("wrong password", &hash));
    }

    #[test]
    fn account_fields_are_bounded_and_validated() {
        assert_eq!(
            account_validation_error("Ada", "ada@enzo.health", "password1"),
            None
        );
        assert!(account_validation_error("", "ada@enzo.health", "password1").is_some());
        assert!(account_validation_error("Ada", "not-an-email", "password1").is_some());
        assert!(account_validation_error("Ada", "ada@enzo.health", "short").is_some());
        assert!(account_validation_error("Ada", "ada@enzo.health", &"x".repeat(129)).is_some());
    }

    #[test]
    fn signup_is_restricted_to_the_allowed_domain() {
        assert!(signup_email_allowed("ada@enzo.health"));
        assert!(signup_email_allowed("  Ada@Enzo.Health  "));
        assert!(!signup_email_allowed("ada@gmail.com"));
        assert!(!signup_email_allowed("ada@enzo.health.evil.com"));
        assert!(!signup_email_allowed("ada@notenzo.health"));
        // Shape validation stays domain-agnostic; callers gate creation separately.
        assert_eq!(account_validation_error("Ada", "ada@example.com", "password1"), None);
    }
}
