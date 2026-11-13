//! `POST /api/auth/signup` — create an independent user account, then sign them in.

use axum::{Extension, Json};
use http::{HeaderMap, HeaderValue, header::SET_COOKIE};
use linkedin_challenge_server::auth::{
    EMAIL_DOMAIN_REJECTION, account_validation_error, establish_session, hash_password,
    member_by_email, signup_email_allowed,
};
use linkedin_challenge_server::enroll::enroll_in_running_challenges;
use linkedin_challenge_server::models::{Member, Org};
use linkedin_challenge_server::util::{new_bearer_token, now_unix};
use linkedin_challenge_server::web::{ApiError, ApiResult};
use serde::{Deserialize, Serialize};
use toasty::Db;
use utoipa::ToSchema;

#[derive(Deserialize, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct SignupRequest {
    pub name: String,
    pub email: String,
    pub password: String,
}

#[derive(Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct SignupResponse {
    pub ok: bool,
    pub org_slug: String,
}

#[nextrs::api(
    operation_id = "signup",
    responses(
        (status = 200, description = "Organization created; session cookie set", body = SignupResponse),
        (status = 400, description = "Password too short", body = ApiError),
        (status = 409, description = "Email already registered", body = ApiError),
    ),
)]
pub async fn post(
    Extension(mut db): Extension<Db>,
    Json(req): Json<SignupRequest>,
) -> ApiResult<(HeaderMap, Json<SignupResponse>)> {
    // The signup page is gone and the company join link is the only way in; this API stays for the
    // e2e tests, which run the debug build. In a release build (production) it would let anyone on
    // the internet make an account with an invented enzo.health address, skipping the join link.
    if !linkedin_challenge_server::auth::password_signup_allowed() {
        return Err(ApiError::not_found("not found"));
    }
    if let Some(error) = account_validation_error(&req.name, &req.email, &req.password) {
        return Err(ApiError::bad_request(error));
    }
    // The platform is internal for now: only company addresses may create an account. The
    // message is deliberately uninformative so the gate itself is not advertised.
    if !signup_email_allowed(&req.email) {
        return Err(ApiError::bad_request(EMAIL_DOMAIN_REJECTION));
    }

    let email = req.email.trim().to_lowercase();
    // Placeholder for the unique LinkedIn URN column until the extension pairs a real identity;
    // the same shape join uses, so one prefix covers every un-linked member.
    let urn = format!("pending:{email}");

    // Includes deleted accounts: their address stays taken so that an admin can restore them.
    if member_by_email(&mut db, &email).await?.is_some() {
        return Err(ApiError::conflict(
            "an account with that email already exists",
        ));
    }

    // `org_id` remains a required legacy storage column during the migration, but it is no longer
    // an ownership or authorization boundary. Every new independent account uses this inert row.
    let org = match Org::filter_by_slug("users").first().exec(&mut db).await? {
        Some(org) => org,
        None => toasty::create!(Org { slug: "users", name: "Users", created_at: now_unix() })
            .exec(&mut db)
            .await?,
    };

    // Admins get a unique placeholder api_token_hash (never handed out) so the column stays unique.
    let (_unused, token_hash) = new_bearer_token();
    let member = toasty::create!(Member {
        org_id: org.id,
        display_name: req.name.trim(),
        linkedin_urn: &urn,
        public_identifier: "",
        profile_url: None,
        is_admin: false,
        is_system_admin: false,
        email: Some(email),
        password_hash: Some(hash_password(&req.password)),
        api_token_hash: token_hash,
        created_at: now_unix(),
    })
    .exec(&mut db)
    .await
    .map_err(|error| {
        // Two concurrent signups for one address slip past the lookup above; the unique index
        // on `members.email` (and the derived URN placeholder) catches the second one here.
        if error.to_string().to_ascii_lowercase().contains("unique") {
            ApiError::conflict("an account with that email already exists")
        } else {
            error.into()
        }
    })?;

    // Everyone competes in whatever is running: a new account lands on the board immediately.
    enroll_in_running_challenges(&mut db, member.id).await?;

    let cookie = establish_session(&mut db, member.id).await?;
    let mut headers = HeaderMap::new();
    if let Ok(value) = HeaderValue::from_str(&cookie) {
        headers.insert(SET_COOKIE, value);
    }

    Ok((
        headers,
        Json(SignupResponse {
            ok: true,
            org_slug: String::new(),
        }),
    ))
}
