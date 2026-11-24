//! `GET /api/admin/lottery/draws` — every official weekly draw in full, newest first, with who
//! redrew (by member id too). Admin-only, gated like `GET /api/admin/lottery`. Rules:
//! `src/lottery_draw.rs`.

use axum::{Extension, Json};
use http::HeaderMap;
use linkedin_challenge_server::dto::require_challenge_user;
use linkedin_challenge_server::lottery_draw::{AdminDraws, admin_draws};
use linkedin_challenge_server::util::now_unix;
use linkedin_challenge_server::web::ApiError;
use toasty::Db;

#[nextrs::api(
    operation_id = "getAdminLotteryDraws",
    responses(
        (status = 200, description = "Every official draw, newest first", body = AdminDraws),
        (status = 401, description = "Not signed in, or not an admin", body = ApiError),
    ),
)]
pub async fn get(Extension(mut db): Extension<Db>, headers: HeaderMap) -> Result<Json<AdminDraws>, ApiError> {
    require_challenge_user(&mut db, &headers).await?;
    Ok(Json(admin_draws(&mut db, now_unix()).await?))
}
