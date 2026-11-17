//! What the pages' `prefetch.rs` files seed into the React Query cache.
//!
//! The API handlers take `HeaderMap` to resolve the session, which makes them ineligible for the
//! typed seed companions `#[nextrs::api]` generates. So the entries are built by hand here, from
//! the same [`crate::reads`] functions the handlers call and after the same decision functions
//! (`dto::member_required` and friends), so each entry is exactly the endpoint's 200 body and only
//! exists where the endpoint would have answered 200. Anything the endpoint would refuse (signed
//! out, not an admin, a bad parameter, a database error) seeds nothing, and the page fetches it as
//! it would without a seed.
//!
//! A seed is only read if its key is the one the page's generated hook asks for on first render:
//! `[url]`, or `[url, params]` with exactly the params the hook sends (absent ones left out, never
//! `null`). Each page's `prefetch.rs` says which hooks it mirrors.
//!
//! The session is looked up once per prefetch ([`PageSeeds::resolve`]) and shared by every entry.
//! The entries then run concurrently, each timed as its own `seed-*` segment in `Server-Timing`.

use axum::body::Body;
use nextrs::{SeedEntry, seed_key};
use serde::Serialize;
use serde_json::{Value, json};
use toasty::Db;

use crate::auth::{SessionInfo, cookie, current_session, has_bearer};
use crate::dto::{challenge_list, challenge_user_required, member_required, system_admin_required};
use crate::models::Member;
use crate::reads;
use crate::reports::{ReportFilter, ReportParams, fmt_local, parse_offset, report_session_access};
use crate::util::now_unix;
use crate::web::ApiResult;

/// The cookie the app shell writes with the browser's current UTC offset (`-07:00`), so a page
/// whose hook sends the viewer's time zone can be seeded under the same key. See
/// `components/timezone.ts`. Without it (the very first visit) those entries are not seeded.
pub const TIMEZONE_COOKIE: &str = "tz";

/// One page request, resolved once for all of its seed entries.
pub struct PageSeeds {
    db: Db,
    timing: nextrs::Timing,
    session: Option<SessionInfo>,
    /// The request presented `Authorization: Bearer ...` (see [`PageSeeds::report`]).
    bearer: bool,
    /// The page URL's query string, in order, as the browser's `URLSearchParams` sees it.
    query: Vec<(String, String)>,
    /// The [`TIMEZONE_COOKIE`] offset, when it is one the shell could have written.
    timezone: Option<String>,
}

/// The entry for one endpoint's `Ok` body, or nothing when the endpoint would have refused.
pub fn entry<T: Serialize>(url: &str, params: Option<Value>, body: ApiResult<T>) -> Option<SeedEntry> {
    let body = body.ok()?;
    match serde_json::to_value(&body) {
        Ok(data) => Some(SeedEntry { key: seed_key(url, params), data }),
        Err(error) => {
            eprintln!("prefetch: serialising the {url} seed failed: {error}");
            None
        }
    }
}

/// Exactly the `+HH:MM` / `-HH:MM` shape the shell writes (`offsetNow()` in app/page.tsx), and a
/// real offset. Anything else would key an entry the page never asks for.
fn shell_offset(value: &str) -> bool {
    let bytes = value.as_bytes();
    bytes.len() == 6
        && matches!(bytes[0], b'+' | b'-')
        && bytes[1..3].iter().all(u8::is_ascii_digit)
        && bytes[3] == b':'
        && bytes[4..].iter().all(u8::is_ascii_digit)
        && parse_offset(value).is_some()
}

impl PageSeeds {
    /// Look the session up once (timed as `seed-session`) and read what the entries need from
    /// the request. None only when the request carries no database handle, a wiring bug.
    pub async fn resolve(req: http::Request<Body>) -> Option<Self> {
        // Only the head is needed; the body type is not `Sync`, so it must not be held across
        // the lookup's await.
        let (req, _) = req.into_parts();
        let Some(db) = req.extensions.get::<Db>().cloned() else {
            eprintln!(
                "prefetch {}: no database handle in the request extensions; seeding nothing",
                req.uri.path()
            );
            return None;
        };
        let timing = nextrs::Timing::from_extensions(&req.extensions);
        // `search_params` reads a request's query; a body-less one carries the same URI.
        let query = http::Request::builder()
            .uri(req.uri.clone())
            .body(())
            .ok()
            .and_then(|uri_only| nextrs::search_params::<Vec<(String, String)>, _>(&uri_only))
            .unwrap_or_default();
        let mut lookup = db.clone();
        let session = timing.span("seed-session", current_session(&mut lookup, &req.headers)).await;
        Some(Self {
            db,
            timing,
            session,
            bearer: has_bearer(&req.headers),
            query,
            timezone: cookie(&req.headers, TIMEZONE_COOKIE).filter(|tz| shell_offset(tz)),
        })
    }

    /// The member the session acts as (the target, under "View as"), as every handler sees it.
    pub fn member(&self) -> Option<&Member> {
        self.session.as_ref().map(|session| &session.member)
    }

    /// The first value of a query parameter, as `URLSearchParams.get` (and so nuqs) reads it.
    pub fn param(&self, name: &str) -> Option<&str> {
        self.query.iter().find(|(key, _)| key == name).map(|(_, value)| value.as_str())
    }

    pub fn timezone(&self) -> Option<&str> {
        self.timezone.as_deref()
    }

    /// Time one entry as segment `name`. The reads inside get a no-op timer: several entries run
    /// at once, and their inner `db` spans would collide in the header.
    async fn timed<F: Future<Output = Option<SeedEntry>>>(&self, name: &'static str, entry: F) -> Option<SeedEntry> {
        self.timing.span(name, entry).await
    }

    /// `GET /api/auth/me`, read by the sidebar shell on every page (`useGetMe()`). Signed out is a
    /// 200 too, and seeded as such.
    pub async fn me(&self) -> Option<SeedEntry> {
        let mut db = self.db.clone();
        self.timed("seed-me", async {
            entry("/api/auth/me", None, reads::me(&mut db, &nextrs::Timing::noop(), self.session.as_ref()).await)
        })
        .await
    }

    /// `GET /api/challenges`, which the sidebar asks for (`useGetChallenges()`) once `me` says the
    /// viewer is a system admin; the Challenges page asks for the same key.
    pub async fn challenges(&self) -> Option<SeedEntry> {
        let member = challenge_user_required(self.member()).ok()?;
        let mut db = self.db.clone();
        self.timed("seed-challenges", async {
            entry("/api/challenges", None, challenge_list(&mut db, member).await)
        })
        .await
    }

    /// `GET /api/stats/overview` with `{days, timezone}`, the home page's
    /// `useGetStatsOverview({ days, timezone })`. Needs the timezone cookie.
    pub async fn stats(&self, days: i64) -> Option<SeedEntry> {
        let viewer = member_required(self.member()).ok()?;
        let timezone = self.timezone()?;
        let mut db = self.db.clone();
        self.timed("seed-stats", async {
            let body = reads::stats(&mut db, &nextrs::Timing::noop(), viewer, Some(days), Some(timezone)).await;
            entry("/api/stats/overview", Some(json!({ "days": days, "timezone": timezone })), body)
        })
        .await
    }

    /// `GET /api/me/posts` with the My posts page's `useGetMyPosts({ filter, sort, page, pageSize })`
    /// params (`filter` left out when empty, as the page does).
    pub async fn my_posts(&self, filter: Option<&str>, sort: &str, page: usize, page_size: usize) -> Option<SeedEntry> {
        let user = member_required(self.member()).ok()?;
        let mut db = self.db.clone();
        self.timed("seed-posts", async {
            let body = reads::my_posts(
                &mut db,
                &nextrs::Timing::noop(),
                user,
                filter,
                Some(sort),
                Some(page),
                Some(page_size),
            )
            .await;
            let mut params = json!({ "sort": sort, "page": page, "pageSize": page_size });
            if let Some(filter) = filter {
                params["filter"] = json!(filter);
            }
            entry("/api/me/posts", Some(params), body)
        })
        .await
    }

    /// `GET /api/v1/posts` with the Reports page's first-render params: the last seven days in
    /// the viewer's time zone, `{since, until, timezone}`. Needs the timezone cookie, and assumes
    /// the offset seven days ago was today's; across a daylight-saving change the page asks for
    /// a different `since`, finds no seed and fetches.
    pub async fn report(&self) -> Option<SeedEntry> {
        // A bearer token is judged by the key alone at this endpoint; the page's own request
        // carries none, so it is not answered here.
        if self.bearer {
            return None;
        }
        report_session_access(self.member()).ok()?;
        let timezone = self.timezone()?;
        let week = ReportFilter::new(ReportParams { timezone: Some(timezone), ..Default::default() }, now_unix()).ok()?;
        let since = fmt_local(week.start, week.offset);
        let until = fmt_local(week.end - 1, week.offset);
        let mut db = self.db.clone();
        self.timed("seed-report", async {
            let params = ReportParams {
                since: Some(&since),
                until: Some(&until),
                timezone: Some(timezone),
                ..Default::default()
            };
            let body = match reads::report_filter(params) {
                Ok(filter) => reads::report(&mut db, &nextrs::Timing::noop(), &filter).await,
                Err(error) => Err(error),
            };
            entry("/api/v1/posts", Some(json!({ "since": since, "until": until, "timezone": timezone })), body)
        })
        .await
    }

    /// `GET /api/system/api-keys`, the Reports page's `useListApiKeys()`.
    pub async fn api_keys(&self) -> Option<SeedEntry> {
        system_admin_required(self.member()).ok()?;
        let mut db = self.db.clone();
        self.timed("seed-api-keys", async { entry("/api/system/api-keys", None, reads::api_keys(&mut db).await) })
            .await
    }
}

/// Add the entries in order (`QuerySeed::seed` takes a future; these are already resolved).
pub async fn collect(entries: impl IntoIterator<Item = Option<SeedEntry>>) -> nextrs::QuerySeed {
    let mut seed = nextrs::QuerySeed::new();
    for entry in entries {
        seed = seed.seed(std::future::ready(entry)).await;
    }
    seed
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_the_shells_offset_shape_is_used() {
        assert!(shell_offset("-07:00"));
        assert!(shell_offset("+05:30"));
        assert!(shell_offset("+00:00"));
        for bad in ["Z", "07:00", "-7:00", "+15:00", "-07:60", "-07:00;", " -07:00", ""] {
            assert!(!shell_offset(bad), "{bad:?}");
        }
    }
}
