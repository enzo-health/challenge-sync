//! `GET /api/lottery/freeze` — "freeze if due", for the Vercel cron (`crons` in `vercel.json`, at
//! both UTC times 09:30 Denver can be). Takes no input and is harmless to call by anyone at any
//! time: on a draw Friday from 09:30 to midnight Denver time it freezes the week's list if nothing
//! has yet and fetches the seed if its round is out; otherwise it changes nothing. A GET because
//! that is what Vercel's cron sends. Who called only labels the record (`Trigger::of_freeze_request`).

use axum::{Extension, Json};
use http::HeaderMap;
use linkedin_challenge_server::lottery_draw::{FreezeOutcome, Trigger, freeze_if_due};
use linkedin_challenge_server::util::now_unix;
use linkedin_challenge_server::web::ApiError;
use toasty::Db;

#[nextrs::api(
    operation_id = "freezeLottery",
    responses(
        (status = 200, description = "What happened: frozen, already frozen, or not due", body = FreezeOutcome),
        (status = 500, description = "The database failed", body = ApiError),
    ),
)]
pub async fn get(Extension(mut db): Extension<Db>, headers: HeaderMap) -> Result<Json<FreezeOutcome>, ApiError> {
    Ok(Json(freeze_if_due(&mut db, now_unix(), Trigger::of_freeze_request(&headers)).await?))
}
