//! Seeds the Overview (`/`) with what it asks for on first render: the sidebar shell's
//! `/api/auth/me` (and `/api/challenges` for a system admin), and the page's
//! `useGetStatsOverview({ days, timezone })`. `days` is URL state (`?days=30`, default 7, read
//! with nuqs' `parseAsNumberLiteral([7, 30, 90])`); `timezone` is the browser's UTC offset, which
//! the server only knows from the `tz` cookie the shell writes, so a first-ever visit has no
//! stats seed. How the entries are built: `src/seeds.rs`.

use linkedin_challenge_server::seeds::{PageSeeds, collect};

pub async fn prefetch(req: http::Request<axum::body::Body>) -> nextrs::QuerySeed {
    let Some(seeds) = PageSeeds::resolve(req).await else {
        return nextrs::QuerySeed::new();
    };
    let days = match seeds.param("days") {
        Some("30") => 30,
        Some("90") => 90,
        _ => 7,
    };
    let (me, challenges, stats) = tokio::join!(seeds.me(), seeds.challenges(), seeds.stats(days));
    collect([me, challenges, stats]).await
}
