//! `GET /api/lottery` — the official weekly draw as the public page at `/lottery` shows it: the
//! phase (party, frozen list, wheel), the day's timetable, and the party's people or the draw.
//! Open to anyone, signed in or not (see `app/middleware.rs`): it carries only display names,
//! avatars, post counts, dates and draw data. Rules: `src/lottery_draw.rs`. From 09:30 on a draw
//! Friday it also freezes the list if nothing has yet (the safety net), and fetches a due seed.

use axum::{Extension, Json};
use linkedin_challenge_server::lottery_draw::{PublicLottery, public_lottery};
use linkedin_challenge_server::util::now_unix;
use linkedin_challenge_server::web::ApiError;
use toasty::Db;

#[nextrs::api(
    operation_id = "getLottery",
    responses(
        (status = 200, description = "The official draw's state now", body = PublicLottery),
        (status = 500, description = "The database failed", body = ApiError),
    ),
)]
pub async fn get(Extension(mut db): Extension<Db>) -> Result<Json<PublicLottery>, ApiError> {
    Ok(Json(public_lottery(&mut db, now_unix()).await?))
}
