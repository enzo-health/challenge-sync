//! Seeds Post reports (`/reports`, admins only; middleware.rs guards it): the sidebar shell's
//! `/api/auth/me` and `/api/challenges`, the page's first `useGetPostReport({ since, until,
//! timezone })` (the last seven days in the viewer's time zone, which the server only knows from
//! the `tz` cookie the shell writes), and `useListApiKeys()`, which renders once the report has.
//! How the entries are built: `src/seeds.rs`.

use linkedin_challenge_server::seeds::{PageSeeds, collect};

pub async fn prefetch(req: http::Request<axum::body::Body>) -> nextrs::QuerySeed {
    let Some(seeds) = PageSeeds::resolve(req).await else {
        return nextrs::QuerySeed::new();
    };
    let (me, challenges, report, keys) =
        tokio::join!(seeds.me(), seeds.challenges(), seeds.report(), seeds.api_keys());
    collect([me, challenges, report, keys]).await
}
