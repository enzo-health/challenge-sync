//! Guard for `/admin/**` — a challenge organiser's overview. Open only to those challenges are
//! open to (`auth::can_use_challenges`); anyone else goes to `/`. API handlers still check that
//! changes target challenges the user owns.

use axum::response::{IntoResponse, Redirect};
use linkedin_challenge_server::auth::{can_use_challenges, current_member};
use nextrs::conventions::MiddlewareResult;
use toasty::Db;

pub async fn handle(req: http::Request<axum::body::Body>) -> MiddlewareResult {
    let Some(db) = req.extensions().get::<Db>().cloned() else {
        return MiddlewareResult::response(
            (http::StatusCode::INTERNAL_SERVER_ERROR, "no database").into_response(),
        );
    };

    let mut db = db;
    if !current_member(&mut db, req.headers()).await.is_some_and(|member| can_use_challenges(&member)) {
        return MiddlewareResult::response(Redirect::to("/").into_response());
    }
    MiddlewareResult::next(req)
}
