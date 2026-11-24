//! `POST /api/admin/lottery/draws/{week}/redraw` — draw the week's winner again, for a reason
//! everyone will see. Admin-only, gated like `GET /api/admin/lottery` and judged on the member the
//! session acts as. The new pick is seeded by a drand round published a few seconds after the
//! request, among the frozen list minus everyone who already won; nothing earlier changes. Rules
//! and every refusal: `lottery_draw::redraw`.

use axum::extract::Path;
use axum::{Extension, Json};
use http::HeaderMap;
use linkedin_challenge_server::dto::require_challenge_user;
use linkedin_challenge_server::lottery_draw::{AdminDraw, redraw};
use linkedin_challenge_server::util::now_unix;
use linkedin_challenge_server::web::ApiError;
use serde::{Deserialize, Serialize};
use toasty::Db;
use utoipa::ToSchema;

#[derive(Deserialize, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct RedrawRequest {
    /// Why the winner is being drawn again (required, at most 500 characters). Public.
    pub reason: String,
}

#[nextrs::api(
    operation_id = "redrawLottery",
    responses(
        (status = 200, description = "The redraw is recorded; its seed follows within seconds", body = AdminDraw),
        (status = 400, description = "No reason, or a reason too long", body = ApiError),
        (status = 401, description = "Not signed in, or not an admin", body = ApiError),
        (status = 404, description = "No official draw for that week", body = ApiError),
        (status = 409, description = "Nobody was in the draw, the current pick has no winner yet, everyone has won, or another redraw just happened", body = ApiError),
    ),
)]
pub async fn post(
    Extension(mut db): Extension<Db>,
    headers: HeaderMap,
    Path(week): Path<String>,
    Json(req): Json<RedrawRequest>,
) -> Result<Json<AdminDraw>, ApiError> {
    let admin = require_challenge_user(&mut db, &headers).await?;
    Ok(Json(redraw(&mut db, &week, &admin, &req.reason, now_unix()).await?))
}
