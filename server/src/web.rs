//! Shared HTTP plumbing for the `app/**/route.rs` adapters.

use axum::Json;
use axum::response::{IntoResponse, Response};
use http::StatusCode;
use serde::Serialize;
use utoipa::ToSchema;

/// A JSON error body. Every API route returns this shape on failure, so the generated client
/// and the extension can rely on `{ "error": "..." }` regardless of status.
///
/// `code` is set on the refusals a client acts on (see [`codes`]). Clients decide on the code,
/// never on the English `error` text, and treat a failure without a code as unexplained.
#[derive(Debug, Serialize, ToSchema)]
pub struct ApiError {
    pub error: String,
    /// A machine-readable reason, on the refusals a client must tell apart (see `web::codes`).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub code: Option<String>,
    #[serde(skip)]
    pub status: StatusCode,
}

/// The `code` values an `ApiError` can carry. The extension (extension/errors.js) and the site
/// match on these strings, so they never change meaning; add new ones instead.
pub mod codes {
    /// `/api/auth/extension/join` got no join code: the invite link was never opened here.
    pub const JOIN_CODE_REQUIRED: &str = "join_code_required";
    /// `/api/auth/extension/join` got a join code that is wrong or has been replaced.
    pub const JOIN_CODE_INVALID: &str = "join_code_invalid";
    /// The LinkedIn identity or token belongs to an account an admin deleted.
    pub const ACCOUNT_DELETED: &str = "account_deleted";
    /// A device sync token that is missing, unknown or revoked.
    pub const SYNC_TOKEN_REJECTED: &str = "sync_token_rejected";
    /// A website session token that is missing, unknown or expired.
    pub const SESSION_EXPIRED: &str = "session_expired";
    /// The request named no usable LinkedIn identity.
    pub const IDENTITY_REQUIRED: &str = "identity_required";
    /// The LinkedIn identity is already bound to a different account.
    pub const LINKEDIN_TAKEN: &str = "linkedin_taken";
    /// The account is already bound to a different LinkedIn identity (`/api/link`).
    pub const ALREADY_LINKED: &str = "already_linked";
    /// The LinkedIn identity belongs to an admin, who must sign in with email and password.
    pub const ADMIN_USE_PASSWORD: &str = "admin_use_password";
    /// A "View as" session, which must not become a device token for its target.
    pub const IMPERSONATION_SESSION: &str = "impersonation_session";
}

impl ApiError {
    pub fn new(status: StatusCode, message: impl Into<String>) -> Self {
        Self {
            error: message.into(),
            code: None,
            status,
        }
    }

    /// The same error, carrying one of [`codes`].
    pub fn with_code(mut self, code: &str) -> Self {
        self.code = Some(code.to_string());
        self
    }

    pub fn bad_request(message: impl Into<String>) -> Self {
        Self::new(StatusCode::BAD_REQUEST, message)
    }

    pub fn unauthorized(message: impl Into<String>) -> Self {
        Self::new(StatusCode::UNAUTHORIZED, message)
    }

    pub fn not_found(message: impl Into<String>) -> Self {
        Self::new(StatusCode::NOT_FOUND, message)
    }

    pub fn conflict(message: impl Into<String>) -> Self {
        Self::new(StatusCode::CONFLICT, message)
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        let status = self.status;
        (status, Json(self)).into_response()
    }
}

/// Toasty failures are our bug, not the caller's — surface them as 500 without leaking detail.
impl From<toasty::Error> for ApiError {
    fn from(e: toasty::Error) -> Self {
        eprintln!("database error: {e}");
        Self::new(StatusCode::INTERNAL_SERVER_ERROR, "database error")
    }
}

pub type ApiResult<T> = Result<T, ApiError>;

/// A 404 page for a route that matched but whose *value* doesn't exist — an unknown org slug, a
/// competition id from another org.
///
/// `not-found.tsx` handles URLs that match no route; this handles bad values inside routes that
/// do, and it has to be plain HTML because middleware runs before any React bundle is chosen. Kept
/// deliberately spare, and it loads the same stylesheet so it doesn't look like a different site.
pub fn not_found_response(detail: &str) -> Response {
    let html = format!(
        r#"<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Not found</title>
<link rel="stylesheet" href="/style.css">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
</head>
<body>
<main>
<h1>Not found</h1>
<p class="lede">{detail}</p>
<p><a class="btn" href="/">Back to the overview</a></p>
</main>
</body>
</html>"#
    );
    (
        StatusCode::NOT_FOUND,
        [(http::header::CONTENT_TYPE, "text/html; charset=utf-8")],
        html,
    )
        .into_response()
}
