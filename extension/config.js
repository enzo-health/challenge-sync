// The challenge server this build talks to. Deliberately a build-time constant with no UI to
// change it: the extension reads the site's session cookie, which requires a matching entry in
// `host_permissions` in manifest.json, and that cannot be edited at runtime either.
//
// The release builder derives this constant, the manifest's `host_permissions`, and its
// `homepage_url` from one deployed origin.
export const SERVER_URL = "http://localhost:3312";

/// Name of the session cookie the website sets — see `SESSION_COOKIE` in server/src/auth.rs.
export const SESSION_COOKIE = "session";

/// Name of the cookie the site's `/join/<code>` page sets with the company join code.
export const JOIN_COOKIE = "join_code";

// How often the worker CHECKS whether a sync is due, in minutes. This is deliberately frequent:
// a laptop that is only open now and then never lands on a 12-hour clock mark, so the question
// "has it been long enough?" is asked often and answered by MIN_SYNC_INTERVAL_MINUTES below.
export const SYNC_CHECK_MINUTES = 15;

// Floor between two AUTOMATIC syncs — the real cadence, twice a day. LinkedIn etiquette: keep
// this low. Enforced against the last sync time rather than left to the alarm, so frequent
// checks, wake-from-sleep, and worker restarts can't turn "twice a day" into more. Manual syncs
// bypass it — they're attended and deliberate. Slightly under 12h so a run that drifts a few
// minutes late doesn't push the next one past its slot.
export const MIN_SYNC_INTERVAL_MINUTES = 11 * 60 + 30;

// Random jitter (minutes) added to the floor per install so many laptops don't sync in lockstep.
export const SYNC_JITTER_MINUTES = 45;

// Max posts to pull per sync (most recent first). Competitions only grade a few/week anyway.
export const MAX_POSTS = 30;

// Posts older than this (by creation time, at sync time) stop being refreshed once recorded. A
// post's numbers settle within a couple of weeks, and every refresh costs one or two more
// requests to LinkedIn, so re-reading the same old post twice a day forever buys nothing. The
// last reading taken before the cutoff stays on the server as the post's numbers.
export const REFRESH_WINDOW_DAYS = 28;

// Polite delay between sequential LinkedIn requests (ms).
export const REQUEST_DELAY_MS = 1200;

export const LINKEDIN_ORIGIN = "https://www.linkedin.com";
