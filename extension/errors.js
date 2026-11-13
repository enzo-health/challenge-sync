// Every failure the extension can report, sorted by what the evidence says went wrong.
//
// A person (and whoever they send a screenshot to) needs to know WHICH thing failed: their
// network, our host's firewall, our server, a refusal the server explained, LinkedIn, or the
// extension itself. So nothing here falls back to "Error" or "Something went wrong", and nothing
// says "invite" unless the server answered with the code that means exactly that.
//
// `describeError(err)` returns `{ code, message }`: a short stable code for small print, and the
// sentence to show. The site's pages and the popup show both. The table is mirrored in
// docs/extension-first-auth.md.

/** Our server's own refusal codes (server/src/web.rs `codes`). Matched on; never on its text. */
export const SERVER_CODES = {
  JOIN_CODE_REQUIRED: "join_code_required",
  JOIN_CODE_INVALID: "join_code_invalid",
  ACCOUNT_DELETED: "account_deleted",
  SYNC_TOKEN_REJECTED: "sync_token_rejected",
  SESSION_EXPIRED: "session_expired",
  IDENTITY_REQUIRED: "identity_required",
  LINKEDIN_TAKEN: "linkedin_taken",
  ADMIN_USE_PASSWORD: "admin_use_password",
  ALREADY_LINKED: "already_linked",
  IMPERSONATION_SESSION: "impersonation_session",
};

/** What the server's refusal codes mean to a person. */
const REFUSALS = {
  join_code_required: "Open your company's invite link in this browser first.",
  join_code_invalid:
    "This invite link isn't valid, or it has been replaced by a newer one. Ask whoever runs Challenge Sync at your company for the current link.",
  account_deleted: "This Challenge Sync account has been removed. Ask an admin to restore it.",
  sync_token_rejected: "The server no longer accepts this browser's link to your account. Open the Challenge Sync site to sign in again.",
  session_expired: "Your Challenge Sync sign-in has expired. Open the Challenge Sync site to sign in again.",
  identity_required: "The server didn't accept the LinkedIn profile this browser reported.",
  linkedin_taken: "This LinkedIn account is already linked to someone else.",
  admin_use_password:
    "Admins sign in with their email and password on the Challenge Sync site (/auth/password). Once you have, Challenge Sync connects from that sign-in by itself.",
  already_linked: "This Challenge Sync account is already linked to a different LinkedIn account.",
  impersonation_session:
    "You're viewing the Challenge Sync site as someone else (\u201cView as\u201d). Stop viewing as them, and Challenge Sync connects as you.",
};

export const UNREACHABLE_MESSAGE = "Can't reach the Challenge Sync server. Check your connection; we'll keep trying.";
export const TIMEOUT_MESSAGE = "The Challenge Sync server didn't answer in time. We'll keep trying.";
/** What the extension says while our host (Vercel's firewall) is blocking it. */
export const BLOCKED_MESSAGE =
  "Challenge Sync's host blocked this request for a moment (a security check on your network). We'll try again shortly.";

/** The request never got an answer: offline, DNS, connection refused, or no answer in time. */
export class ServerUnreachableError extends Error {
  constructor({ timeout = false, cause } = {}) {
    super(timeout ? TIMEOUT_MESSAGE : UNREACHABLE_MESSAGE);
    this.name = "ServerUnreachableError";
    this.unreachable = true;
    this.timeout = timeout;
    this.cause = cause;
  }
}

/** Thrown in place of a server answer when the host stopped the request (see api.js isBlocked). */
export class BlockedError extends Error {
  constructor() {
    super(BLOCKED_MESSAGE);
    this.name = "BlockedError";
    this.blocked = true;
  }
}

/**
 * An answer from our server that the caller had no special meaning for. Carries everything known
 * about it: the status, the server's refusal code if it gave one, the content type, its text.
 */
export class ServerError extends Error {
  constructor({ status, code = null, contentType = null, serverMessage = null }) {
    super(serverMessage || `Server answered ${status}.`);
    this.name = "ServerError";
    this.status = status;
    this.code = typeof code === "string" && code ? code : null;
    this.contentType = contentType;
    this.serverMessage = serverMessage;
  }
}

/**
 * LinkedIn, not our server: `kind` is "signed-out" (no session, or LinkedIn said 401/403),
 * "http" (another status, in `status`), "unreachable" (fetch threw), or "profile" (answered, but
 * without the member's own profile). The message stays the old string ("NOT_LOGGED_IN",
 * "VOYAGER_500") so logs and the live tests read the same.
 */
export class LinkedInError extends Error {
  constructor(kind, { status = null, message } = {}) {
    super(message || (kind === "signed-out" ? "NOT_LOGGED_IN" : kind === "http" ? `LINKEDIN_${status}` : `LINKEDIN_${kind.toUpperCase()}`));
    this.name = "LinkedInError";
    this.linkedin = kind;
    this.status = status;
  }
}

/** A state the extension is in, rather than a failure of anything it asked: e.g. not linked yet. */
export class ExtensionStateError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ExtensionStateError";
    this.stateCode = code;
  }
}

/** `{ code, message }` for any failure; see the table at the top and in the docs. */
export function describeError(err) {
  if (err?.blocked) return { code: "blocked", message: BLOCKED_MESSAGE };
  if (err?.unreachable) return err.timeout
    ? { code: "timeout", message: TIMEOUT_MESSAGE }
    : { code: "unreachable", message: UNREACHABLE_MESSAGE };
  if (err instanceof ServerError || err?.name === "ServerError") {
    if (err.code && REFUSALS[err.code]) return { code: err.code, message: REFUSALS[err.code] };
    if (err.status >= 500) {
      return { code: `server-${err.status}`, message: `Challenge Sync's server had a problem (${err.status}). We'll try again shortly.` };
    }
    // The server's own words are left out on purpose: without a code they are not evidence of
    // anything, and an old message ("open your company's invite link first") would read as an
    // invite problem. The status, content type and any unknown code are what we know.
    const known = [`status ${err.status}`, err.contentType, err.code && `code ${err.code}`].filter(Boolean).join(", ");
    return { code: `unexpected-${err.status}`, message: `Unexpected response from the server (${known}).` };
  }
  if (err?.linkedin) {
    switch (err.linkedin) {
      case "signed-out":
        return { code: "linkedin-signed-out", message: "You're not logged in to LinkedIn in this browser. Log in to LinkedIn, then try again." };
      case "unreachable":
        return { code: "linkedin-unreachable", message: "Can't reach LinkedIn. Check your connection; we'll keep trying." };
      case "profile":
        return { code: "linkedin-profile", message: "LinkedIn answered, but without your profile. Open LinkedIn, make sure you're logged in, then try again." };
      default:
        return { code: `linkedin-${err.status ?? "error"}`, message: `Couldn't read your LinkedIn data (LinkedIn answered ${err.status ?? "with an error"}). We'll try again later.` };
    }
  }
  if (err?.stateCode) return { code: err.stateCode, message: err.message };
  const detail = String(err?.message || err || "unknown");
  return { code: "extension-error", message: `Challenge Sync hit an internal error: ${detail}` };
}
