//! Seeds My posts (`/me`) with what it asks for on first render: the sidebar shell's
//! `/api/auth/me` (and `/api/challenges` for a system admin), which the page also reads, and
//! `PersonalPosts`' `useGetMyPosts({ filter, sort, page, pageSize: 50 })` (components/member-results.tsx),
//! whose `filter`, `sort` and `page` are URL state read with nuqs: an empty filter is left out,
//! an unknown sort is `newest`, a page that is not a number is 1. How the entries are built:
//! `src/seeds.rs`.

use linkedin_challenge_server::reads::POST_SORTS;
use linkedin_challenge_server::seeds::{PageSeeds, collect};

/// `PAGE_SIZE` in components/member-results.tsx.
const PAGE_SIZE: usize = 50;

pub async fn prefetch(req: http::Request<axum::body::Body>) -> nextrs::QuerySeed {
    let Some(seeds) = PageSeeds::resolve(req).await else {
        return nextrs::QuerySeed::new();
    };
    let filter = seeds.param("filter").filter(|filter| !filter.is_empty());
    let sort = seeds.param("sort").filter(|sort| POST_SORTS.contains(sort)).unwrap_or("newest");
    // nuqs' parseAsInteger takes any integer; the API's `page` is unsigned, so a negative page
    // is a 400 there and not seeded here.
    let page = match seeds.param("page") {
        None => Some(1),
        Some(raw) => match raw.parse::<i64>() {
            Ok(page) => usize::try_from(page).ok(),
            Err(_) => Some(1),
        },
    };
    let posts = async {
        match page {
            Some(page) => seeds.my_posts(filter, sort, page, PAGE_SIZE).await,
            None => None,
        }
    };
    let (me, challenges, posts) = tokio::join!(seeds.me(), seeds.challenges(), posts);
    collect([me, challenges, posts]).await
}
