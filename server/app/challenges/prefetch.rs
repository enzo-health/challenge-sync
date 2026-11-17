//! Seeds the Challenges list (`/challenges`): the sidebar shell's `/api/auth/me`, and
//! `/api/challenges`, which both the page and the sidebar ask for. The guard in middleware.rs
//! has already turned away anyone challenges are not open to. How the entries are built:
//! `src/seeds.rs`.

use linkedin_challenge_server::seeds::{PageSeeds, collect};

pub async fn prefetch(req: http::Request<axum::body::Body>) -> nextrs::QuerySeed {
    let Some(seeds) = PageSeeds::resolve(req).await else {
        return nextrs::QuerySeed::new();
    };
    let (me, challenges) = tokio::join!(seeds.me(), seeds.challenges());
    collect([me, challenges]).await
}
