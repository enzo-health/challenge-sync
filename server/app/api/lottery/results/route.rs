//! `GET /api/lottery/results` — past official draws (their spin window is over), newest first, with
//! everything needed to check each one. Public, like `GET /api/lottery`.

use axum::{Extension, Json};
use linkedin_challenge_server::lottery_draw::{PastDraws, past_draws};
use linkedin_challenge_server::util::now_unix;
use linkedin_challenge_server::web::ApiError;
use toasty::Db;

#[nextrs::api(
    operation_id = "getLotteryResults",
    responses(
        (status = 200, description = "Past draws, newest first", body = PastDraws),
        (status = 500, description = "The database failed", body = ApiError),
    ),
)]
pub async fn get(Extension(mut db): Extension<Db>) -> Result<Json<PastDraws>, ApiError> {
    Ok(Json(past_draws(&mut db, now_unix()).await?))
}
