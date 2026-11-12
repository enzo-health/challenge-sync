//! The Toasty data model. Timestamps are unix seconds (`i64`) to avoid a datetime dependency.
//! Scores are never stored — they are derived from snapshots at read time (see `scoring.rs`).

use toasty::Db;

/// Connect, creating the schema on a fresh database.
///
/// Toasty's `push_schema()` issues plain `CREATE TABLE` — there is no create-if-missing, and the
/// only other option (`reset_db()`) drops everything. Calling it unconditionally therefore makes
/// the server startable exactly once per database file, so we probe first and only push when the
/// tables aren't there.
///
/// It still does NOT alter existing tables: after changing a model, delete the DB file (or point
/// `DATABASE_URL` at a fresh one) to recreate.
///
/// The handle is installed as an Axum `Extension`; handlers extract it with `Extension(db)`.
/// Cloning `Db` is cheap (an Arc'd pool handle); Toasty statements need `&mut Db`.
pub async fn connect() -> Db {
    let url = std::env::var("DATABASE_URL").unwrap_or_else(|_| "turso:linkedin.db".to_string());

    let mut db = Db::builder()
        .models(toasty::models!(crate::*))
        .connect(&url)
        .await
        .expect("failed to connect to the database");

    // Cheapest possible read against a table every schema version has. Success means the schema is
    // already present; failure means an empty database (or one we cannot use anyway).
    if Org::all().first().exec(&mut db).await.is_err() {
        db.push_schema()
            .await
            .expect("failed to create database schema");
    }

    // Toasty creates fresh schemas but does not yet evolve existing ones. Keep the tiny additive
    // migrations here so a development database and a deployed PostgreSQL database retain their
    // accounts and sync history as optional analytics fields are introduced.
    add_column(
        &mut db,
        "ALTER TABLE posts ADD COLUMN is_repost BOOLEAN NOT NULL DEFAULT FALSE",
    )
    .await;
    add_column(&mut db, "ALTER TABLE posts ADD COLUMN image_urls_json TEXT").await;
    add_column(
        &mut db,
        "ALTER TABLE members ADD COLUMN is_system_admin BOOLEAN NOT NULL DEFAULT FALSE",
    )
    .await;
    add_column(
        &mut db,
        "ALTER TABLE admin_sessions ADD COLUMN impersonator_id BIGINT",
    )
    .await;
    add_column(
        &mut db,
        "ALTER TABLE competitions ADD COLUMN per_send DOUBLE PRECISION NOT NULL DEFAULT 0",
    )
    .await;
    add_column(
        &mut db,
        "ALTER TABLE competitions ADD COLUMN per_save DOUBLE PRECISION NOT NULL DEFAULT 0",
    )
    .await;
    add_column(
        &mut db,
        "ALTER TABLE post_snapshots ADD COLUMN sends BIGINT",
    )
    .await;
    add_column(
        &mut db,
        "ALTER TABLE post_snapshots ADD COLUMN saves BIGINT",
    )
    .await;
    add_column(
        &mut db,
        "ALTER TABLE post_snapshots ADD COLUMN impressions_in_network BIGINT",
    )
    .await;
    add_column(
        &mut db,
        "ALTER TABLE post_snapshots ADD COLUMN impressions_out_of_network BIGINT",
    )
    .await;
    add_column(
        &mut db,
        "ALTER TABLE post_snapshots ADD COLUMN members_reached BIGINT",
    )
    .await;
    add_column(
        &mut db,
        "ALTER TABLE post_snapshots ADD COLUMN profile_viewers_from_post BIGINT",
    )
    .await;
    add_column(
        &mut db,
        "ALTER TABLE post_snapshots ADD COLUMN followers_from_post BIGINT",
    )
    .await;
    add_column(
        &mut db,
        "ALTER TABLE competitions ADD COLUMN creator_id BIGINT NOT NULL DEFAULT 0",
    )
    .await;
    add_column(
        &mut db,
        "ALTER TABLE invites ADD COLUMN challenge_id BIGINT NOT NULL DEFAULT 0",
    )
    .await;
    add_column(&mut db, "ALTER TABLE invites ADD COLUMN email TEXT").await;
    // Email is the login identifier for everyone, so the database enforces uniqueness too — the
    // signup-time check alone cannot rule out two concurrent registrations of one address.
    // NULL (extension-only members) is exempt from the constraint on both engines.
    execute_migration(
        &mut db,
        "CREATE UNIQUE INDEX IF NOT EXISTS members_email ON members (email)",
    )
    .await;
    let membership_table = if url.starts_with("postgres:") || url.starts_with("postgresql:") {
        "CREATE TABLE IF NOT EXISTS challenge_memberships (id BIGSERIAL PRIMARY KEY, challenge_id BIGINT NOT NULL, member_id BIGINT NOT NULL, joined_at BIGINT NOT NULL)"
    } else {
        "CREATE TABLE IF NOT EXISTS challenge_memberships (id INTEGER PRIMARY KEY AUTOINCREMENT, challenge_id BIGINT NOT NULL, member_id BIGINT NOT NULL, joined_at BIGINT NOT NULL)"
    };
    execute_migration(&mut db, membership_table).await;
    execute_migration(
        &mut db,
        "CREATE UNIQUE INDEX IF NOT EXISTS challenge_memberships_challenge_member ON challenge_memberships (challenge_id, member_id)",
    )
    .await;
    let post_comments_table = if url.starts_with("postgres:") || url.starts_with("postgresql:") {
        "CREATE TABLE IF NOT EXISTS post_comments (id BIGSERIAL PRIMARY KEY, post_id BIGINT NOT NULL, urn TEXT NOT NULL, commenter_urn TEXT NOT NULL, commenter_name TEXT, is_self BOOLEAN NOT NULL, created_at BIGINT NOT NULL, captured_at BIGINT NOT NULL)"
    } else {
        "CREATE TABLE IF NOT EXISTS post_comments (id INTEGER PRIMARY KEY AUTOINCREMENT, post_id BIGINT NOT NULL, urn TEXT NOT NULL, commenter_urn TEXT NOT NULL, commenter_name TEXT, is_self BOOLEAN NOT NULL, created_at BIGINT NOT NULL, captured_at BIGINT NOT NULL)"
    };
    execute_migration(&mut db, post_comments_table).await;
    execute_migration(
        &mut db,
        "CREATE UNIQUE INDEX IF NOT EXISTS post_comments_urn ON post_comments (urn)",
    )
    .await;
    execute_migration(
        &mut db,
        "CREATE INDEX IF NOT EXISTS post_comments_post_id ON post_comments (post_id)",
    )
    .await;
    // Same statement on both databases: the key is the token hash, so there is no serial column.
    execute_migration(
        &mut db,
        "CREATE TABLE IF NOT EXISTS device_tokens (token_hash TEXT PRIMARY KEY, member_id BIGINT NOT NULL, created_at BIGINT NOT NULL, last_used_at BIGINT NOT NULL)",
    )
    .await;
    execute_migration(
        &mut db,
        "CREATE INDEX IF NOT EXISTS device_tokens_member_id ON device_tokens (member_id)",
    )
    .await;
    // The company join link moved from an environment variable into the database so an admin can
    // create and replace it in the app. These statements copy what `push_schema` makes for
    // `JoinLink` on each engine, index name included, so a fresh database does not get a second
    // copy of the unique index.
    let join_links_table = if url.starts_with("postgres:") || url.starts_with("postgresql:") {
        "CREATE TABLE IF NOT EXISTS join_links (id BIGINT NOT NULL GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY, code TEXT NOT NULL, created_by BIGINT NOT NULL, created_at BIGINT NOT NULL)"
    } else {
        "CREATE TABLE IF NOT EXISTS join_links (id INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT, code TEXT NOT NULL, created_by BIGINT NOT NULL, created_at BIGINT NOT NULL)"
    };
    execute_migration(&mut db, join_links_table).await;
    execute_migration(
        &mut db,
        "CREATE UNIQUE INDEX IF NOT EXISTS index_join_links_by_code ON join_links (code)",
    )
    .await;
    // API keys for the reporting API, added after the database existed. Same approach as
    // `join_links`: copy what `push_schema` makes for `ApiKey` on each engine, index name included.
    let api_keys_table = if url.starts_with("postgres:") || url.starts_with("postgresql:") {
        "CREATE TABLE IF NOT EXISTS api_keys (id BIGINT NOT NULL GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY, name TEXT NOT NULL, key_hash TEXT NOT NULL, created_by BIGINT NOT NULL, created_at BIGINT NOT NULL, last_used_at BIGINT)"
    } else {
        "CREATE TABLE IF NOT EXISTS api_keys (id INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, key_hash TEXT NOT NULL, created_by BIGINT NOT NULL, created_at BIGINT NOT NULL, last_used_at BIGINT)"
    };
    execute_migration(&mut db, api_keys_table).await;
    execute_migration(
        &mut db,
        "CREATE UNIQUE INDEX IF NOT EXISTS index_api_keys_by_key_hash ON api_keys (key_hash)",
    )
    .await;
    add_column(
        &mut db,
        "ALTER TABLE challenge_memberships ADD COLUMN is_favorite BOOLEAN NOT NULL DEFAULT FALSE",
    )
    .await;
    add_column(
        &mut db,
        "ALTER TABLE challenge_memberships ADD COLUMN role TEXT NOT NULL DEFAULT 'participant'",
    )
    .await;
    // Only rows predating challenge ownership have creator_id = 0. Backfill their former org
    // participants once; future challenges use explicit memberships and are never touched here.
    execute_migration(
        &mut db,
        "INSERT INTO challenge_memberships (challenge_id, member_id, joined_at) SELECT competitions.id, members.id, competitions.created_at FROM competitions JOIN members ON members.org_id = competitions.org_id WHERE competitions.creator_id = 0 AND NOT EXISTS (SELECT 1 FROM challenge_memberships existing WHERE existing.challenge_id = competitions.id AND existing.member_id = members.id)",
    )
    .await;
    execute_migration(
        &mut db,
        "UPDATE competitions SET creator_id = COALESCE((SELECT MIN(id) FROM members WHERE members.org_id = competitions.org_id AND members.is_admin = TRUE), 0) WHERE creator_id = 0",
    )
    .await;
    execute_migration(
        &mut db,
        "UPDATE challenge_memberships SET role = 'owner' WHERE member_id = (SELECT creator_id FROM competitions WHERE competitions.id = challenge_memberships.challenge_id)",
    )
    .await;
    execute_migration(
        &mut db,
        "UPDATE invites SET role = 'owner' WHERE role = 'admin'",
    )
    .await;

    // Scoring rules that arrived with the LinkedIn Cup: show-up points, weekly consistency and
    // streak bonuses, the engagement cap, and prize money. Zero defaults keep every existing
    // challenge scoring exactly as it did before these columns existed.
    for sql in [
        "ALTER TABLE competitions ADD COLUMN per_post DOUBLE PRECISION NOT NULL DEFAULT 0",
        "ALTER TABLE competitions ADD COLUMN per_active_week DOUBLE PRECISION NOT NULL DEFAULT 0",
        "ALTER TABLE competitions ADD COLUMN streak_short_weeks BIGINT NOT NULL DEFAULT 4",
        "ALTER TABLE competitions ADD COLUMN streak_short_bonus DOUBLE PRECISION NOT NULL DEFAULT 0",
        "ALTER TABLE competitions ADD COLUMN streak_long_weeks BIGINT NOT NULL DEFAULT 8",
        "ALTER TABLE competitions ADD COLUMN streak_long_bonus DOUBLE PRECISION NOT NULL DEFAULT 0",
        "ALTER TABLE competitions ADD COLUMN engagement_cap DOUBLE PRECISION NOT NULL DEFAULT 0",
        "ALTER TABLE competitions ADD COLUMN engagement_over_cap_rate DOUBLE PRECISION NOT NULL DEFAULT 0.5",
        "ALTER TABLE competitions ADD COLUMN prize_first BIGINT NOT NULL DEFAULT 0",
        "ALTER TABLE competitions ADD COLUMN prize_second BIGINT NOT NULL DEFAULT 0",
        "ALTER TABLE competitions ADD COLUMN prize_third BIGINT NOT NULL DEFAULT 0",
        "ALTER TABLE competitions ADD COLUMN prize_participation BIGINT NOT NULL DEFAULT 0",
        "ALTER TABLE competitions ADD COLUMN participation_posts BIGINT NOT NULL DEFAULT 0",
        "ALTER TABLE post_comments ADD COLUMN is_reply BOOLEAN NOT NULL DEFAULT FALSE",
    ] {
        add_column(&mut db, sql).await;
    }
    // Challenges that predate these columns have every new rate at zero, which is not a rule set
    // anyone chose — it is the absence of one. Give them the LinkedIn Cup rules once; a challenge
    // whose owner has saved settings has at least one non-zero value and is never touched.
    execute_migration(
        &mut db,
        "UPDATE competitions SET per_post = 10, per_active_week = 20, streak_short_weeks = 4, \
         streak_short_bonus = 25, streak_long_weeks = 8, streak_long_bonus = 75, \
         per_reaction = 0.2, per_comment = 5, per_repost = 0, per_send = 0, per_save = 0, \
         per_impression = 0, engagement_cap = 150, engagement_over_cap_rate = 0.5, \
         per_follower_gained = 0, per_profile_view = 0, normalize_by_followers = TRUE, \
         follower_baseline = 1000, prize_first = 2500, prize_second = 1500, prize_third = 1000, \
         prize_participation = 250, participation_posts = 20 \
         WHERE per_post = 0 AND per_active_week = 0 AND streak_short_bonus = 0 \
         AND streak_long_bonus = 0 AND engagement_cap = 0 AND prize_first = 0 \
         AND prize_participation = 0",
    )
    .await;

    db
}

async fn execute_migration(db: &mut Db, sql: &str) {
    toasty::sql::statement(sql)
        .exec(db)
        .await
        .unwrap_or_else(|error| panic!("failed to apply database migration `{sql}`: {error}"));
}

async fn add_column(db: &mut Db, sql: &str) {
    if let Err(error) = toasty::sql::statement(sql).exec(db).await {
        let message = error.to_string().to_ascii_lowercase();
        if !message.contains("duplicate column") && !message.contains("already exists") {
            panic!("failed to apply database migration `{sql}`: {error}");
        }
    }
}

/// A company running challenges.
#[derive(Debug, toasty::Model)]
pub struct Org {
    #[key]
    #[auto]
    pub id: i64,
    #[unique]
    pub slug: String,
    pub name: String,
    pub created_at: i64,

    #[has_many]
    pub members: toasty::Deferred<Vec<Member>>,
    #[has_many]
    pub invites: toasty::Deferred<Vec<Invite>>,
    #[has_many]
    pub competitions: toasty::Deferred<Vec<Competition>>,
}

/// A product user. Challenge permissions live on `ChallengeMembership`; the org foreign key is
/// retained temporarily for compatibility with existing databases and is not an auth boundary.
#[derive(Debug, toasty::Model)]
pub struct Member {
    #[key]
    #[auto]
    pub id: i64,
    #[index]
    pub org_id: i64,
    #[belongs_to(key = org_id, references = id)]
    pub org: toasty::Deferred<Org>,

    pub display_name: String,
    /// LinkedIn member URN. Globally unique for MVP (a person joins one org's challenge).
    #[unique]
    pub linkedin_urn: String,
    pub public_identifier: String,
    pub profile_url: Option<String>,

    /// Legacy organization role. Do not use for authorization; challenge roles are memberships.
    pub is_admin: bool,
    /// Operator of the product itself, across every org — unlocks the system panel and
    /// impersonation. Granted by seed or by hand, never through any API.
    pub is_system_admin: bool,
    /// Login email (None for legacy extension-only members). Unique: checked at signup and
    /// backed by the `members_email` index applied in [`connect`].
    pub email: Option<String>,
    /// Argon2 password hash for admins (None for participants).
    pub password_hash: Option<String>,

    /// SHA-256 (hex) of the extension's sync bearer token (None until linked).
    #[unique]
    pub api_token_hash: String,

    pub created_at: i64,

    #[has_many]
    pub posts: toasty::Deferred<Vec<Post>>,
    #[has_many]
    pub profile_snapshots: toasty::Deferred<Vec<ProfileSnapshot>>,
}

/// A single-use invite code that binds an extension install to a new `Member`.
#[derive(Debug, toasty::Model)]
pub struct Invite {
    #[key]
    #[auto]
    pub id: i64,
    #[index]
    pub org_id: i64,
    #[belongs_to(key = org_id, references = id)]
    pub org: toasty::Deferred<Org>,

    /// Challenge this invitation grants access to. `org_id` is retained only while old databases
    /// transition away from organization ownership.
    #[index]
    pub challenge_id: i64,

    #[unique]
    pub code: String,
    /// Intended recipient. Legacy generic codes have no recipient and remain redeemable.
    pub email: Option<String>,
    /// "participant" or "admin".
    pub role: String,
    pub redeemed: bool,
    pub created_at: i64,
}

/// A scored contest window with a JSON scoring config (see `scoring::ScoringConfig`).
#[derive(Debug, toasty::Model)]
pub struct Competition {
    #[key]
    #[auto]
    pub id: i64,
    #[index]
    pub org_id: i64,
    #[belongs_to(key = org_id, references = id)]
    pub org: toasty::Deferred<Org>,

    /// User who created and manages this challenge.
    #[index]
    pub creator_id: i64,

    pub name: String,
    pub start_at: i64,
    pub end_at: i64,

    // Scoring rules as first-class columns. These were once a single `config_json` blob; typed
    // columns mean the database can be queried and aggregated on them, and a malformed value is a
    // load error rather than a silent fall back to defaults. Mirrored by `scoring::ScoringConfig`,
    // which is the API shape.
    /// Posts beyond this many per week don't score (only the highest-scoring ones count).
    pub max_posts_per_week: i64,
    /// "Show up": points per post, up to `max_posts_per_week` a week.
    pub per_post: f64,
    /// "Keep showing up": points for every week with at least one post, plus a streak bonus.
    pub per_active_week: f64,
    pub streak_short_weeks: i64,
    pub streak_short_bonus: f64,
    pub streak_long_weeks: i64,
    pub streak_long_bonus: f64,
    pub per_reaction: f64,
    pub per_comment: f64,
    pub per_repost: f64,
    pub per_send: f64,
    pub per_save: f64,
    pub per_impression: f64,
    /// A post's engagement counts fully up to this many points (0 = uncapped), then at
    /// `engagement_over_cap_rate`.
    pub engagement_cap: f64,
    pub engagement_over_cap_rate: f64,
    pub per_follower_gained: f64,
    pub per_profile_view: f64,
    /// If true, engagement points are scaled by `follower_baseline / follower_count`.
    pub normalize_by_followers: bool,
    pub follower_baseline: i64,
    /// Prize money in whole dollars; 0 means no prize.
    pub prize_first: i64,
    pub prize_second: i64,
    pub prize_third: i64,
    /// Paid to everyone with at least `participation_posts` posts in the window.
    pub prize_participation: i64,
    pub participation_posts: i64,

    pub is_active: bool,
    pub created_at: i64,
}

/// A user's explicit agreement to let one challenge read and score their post data.
#[derive(Debug, toasty::Model)]
pub struct ChallengeMembership {
    #[key]
    #[auto]
    pub id: i64,
    #[index]
    pub challenge_id: i64,
    #[index]
    pub member_id: i64,
    /// `owner` may manage this challenge and its invites; `participant` may view and compete.
    pub role: String,
    pub is_favorite: bool,
    pub joined_at: i64,
}

/// A post authored by a member. Deduped by LinkedIn URN.
#[derive(Debug, toasty::Model)]
pub struct Post {
    #[key]
    #[auto]
    pub id: i64,
    #[index]
    pub member_id: i64,
    #[belongs_to(key = member_id, references = id)]
    pub member: toasty::Deferred<Member>,

    #[unique]
    pub urn: String,
    pub permalink: String,
    /// LinkedIn post creation time (unix secs); 0 when unknown — bucket by first snapshot then.
    pub created_at: i64,
    pub text_preview: Option<String>,
    /// JSON array of public LinkedIn CDN image URLs. JSON stays portable across our local SQLite
    /// and production PostgreSQL drivers, where native array types differ.
    pub image_urls_json: Option<String>,
    pub is_repost: bool,

    #[has_many]
    pub snapshots: toasty::Deferred<Vec<PostSnapshot>>,
    #[has_many]
    pub comments_seen: toasty::Deferred<Vec<PostComment>>,
}

/// A time-series metric reading for a post. Append-only; latest-in-window wins when scoring.
#[derive(Debug, toasty::Model)]
pub struct PostSnapshot {
    #[key]
    #[auto]
    pub id: i64,
    #[index]
    pub post_id: i64,
    #[belongs_to(key = post_id, references = id)]
    pub post: toasty::Deferred<Post>,

    pub captured_at: i64,
    pub impressions: Option<i64>,
    pub reactions: Option<i64>,
    /// LinkedIn's own comment total. `PostComment` rows are what we actually read, and scoring
    /// uses those so a member's own comments can be excluded.
    pub comments: Option<i64>,
    pub reposts: Option<i64>,
    /// Shares sent privately (LinkedIn's "sends").
    pub sends: Option<i64>,
    pub saves: Option<i64>,

    // Impression breakdown and downstream effects, from the author-only post analytics page.
    // All optional: a sync that couldn't read them stores None rather than a misleading zero.
    pub impressions_in_network: Option<i64>,
    pub impressions_out_of_network: Option<i64>,
    pub members_reached: Option<i64>,
    pub profile_viewers_from_post: Option<i64>,
    pub followers_from_post: Option<i64>,
}

/// One comment on a post, with its author — so a member's own comments can be excluded from
/// scoring, and so reciprocal-comment rings stay visible later.
///
/// Not a snapshot: a comment is a fact that happened once, so rows are upserted by `urn` rather
/// than appended per sync. `PostSnapshot.comments` keeps LinkedIn's own total; these rows are what
/// we actually saw, and the two can differ when a sync only reads the first page.
#[derive(Debug, toasty::Model)]
pub struct PostComment {
    #[key]
    #[auto]
    pub id: i64,
    #[index]
    pub post_id: i64,
    #[belongs_to(key = post_id, references = id)]
    pub post: toasty::Deferred<Post>,

    /// LinkedIn's comment URN. Unique, so a re-sync updates rather than duplicates.
    #[unique]
    pub urn: String,
    /// LinkedIn member URN of whoever wrote it.
    pub commenter_urn: String,
    pub commenter_name: Option<String>,
    /// True when the commenter is the post's own author — these don't score.
    pub is_self: bool,
    /// True when this is a reply inside a thread rather than a top-level comment.
    pub is_reply: bool,
    /// Comment creation time (unix secs), 0 when unknown.
    pub created_at: i64,
    /// When we first recorded it.
    pub captured_at: i64,
}

/// A time-series reading of a member's profile-level metrics.
#[derive(Debug, toasty::Model)]
pub struct ProfileSnapshot {
    #[key]
    #[auto]
    pub id: i64,
    #[index]
    pub member_id: i64,
    #[belongs_to(key = member_id, references = id)]
    pub member: toasty::Deferred<Member>,

    pub captured_at: i64,
    pub follower_count: Option<i64>,
    pub profile_views: Option<i64>,
}

/// A web session: hex(token_hash) -> member id + expiry (unix secs).
///
/// ("Admin" in the name is historical — everyone signs in now; renaming the model would orphan
/// existing session tables for no behavioral gain.)
#[derive(Debug, toasty::Model)]
pub struct AdminSession {
    #[key]
    pub token_hash: String,
    pub admin_id: i64,
    pub expires_at: i64,
    /// When set, this session was started by a system admin impersonating `admin_id`; the value is
    /// the system admin's own member id. Lets the UI show who is really acting, and lets "stop
    /// impersonating" return to the operator's own account.
    pub impersonator_id: Option<i64>,
}

/// One extension install's sync credential. A member may have several — a laptop and a desktop
/// both syncing the same account — so issuing a new one must never revoke the others. The
/// legacy single `Member.api_token_hash` is still honoured for installs linked before this table
/// existed; new links land here.
#[derive(Debug, toasty::Model)]
pub struct DeviceToken {
    #[key]
    pub token_hash: String,
    #[index]
    pub member_id: i64,
    pub created_at: i64,
    pub last_used_at: i64,
}

/// The company join link's code: whoever opens `/join/<code>` with the extension installed can
/// join. Admins create and replace it from the All users page. Replacing it inserts a new row and
/// deletes the older ones, so the newest row is the only code that works (plus the optional fixed
/// `JOIN_CODE`, see `auth::join_code_matches`).
#[derive(Debug, toasty::Model)]
pub struct JoinLink {
    #[key]
    #[auto]
    pub id: i64,
    #[unique]
    pub code: String,
    /// Member id of the admin who generated it.
    pub created_by: i64,
    pub created_at: i64,
}

/// A key an admin hands to a program (Jason's AI agent) so it can read the post report at
/// `/api/v1/posts` without a website session. Only the SHA-256 of the key is stored; the key
/// itself is shown once, when it is created. Keys start with `csk_` so they cannot be mistaken
/// for sync tokens (`st_`), and the two are checked against different tables, so neither works in
/// the other's place.
#[derive(Debug, toasty::Model)]
pub struct ApiKey {
    #[key]
    #[auto]
    pub id: i64,
    /// What the admin called it, e.g. "Jason's agent", so they know which one to revoke.
    pub name: String,
    #[unique]
    pub key_hash: String,
    /// Member id of the admin who created it. The key stops working if they stop being an admin.
    pub created_by: i64,
    pub created_at: i64,
    /// Updated on use, best effort. None until the key is first used.
    pub last_used_at: Option<i64>,
}
