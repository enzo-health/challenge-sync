// Talks to OUR server through the generated nextrs client (see api.js). Bearer-token auth; no
// cookies involved.
//
// The request and response shapes come from the Rust routes via OpenAPI, so a field rename on the
// server surfaces here as a type error in an editor rather than as a silent runtime failure. What
// stays hand-written is the part that is genuinely ours: turning status codes into messages a
// person can act on.
//
// A status code only means something if our server sent it. Vercel sits in front of the server
// and, when its automatic DDoS mitigation decides an IP looks like a bot, answers in our place
// with a browser challenge (403, an HTML page, `x-vercel-mitigated: challenge`) that a service
// worker cannot solve. Every call below goes through `reach()`, which turns such a response into
// a `BlockedError` ("Couldn't reach Challenge Sync just now"), so a challenge is never read as
// "wrong join code" or "token rejected", and then backs off: for a while after a block, calls
// fail straight away without touching the network, so the extension does not add to the traffic
// that got it challenged.
import { getState, setState } from "./storage.js";
import { JOIN_COOKIE, SERVER_URL, SESSION_COOKIE } from "./config.js";
import {
  BlockedError,
  bearer,
  getSyncStatus,
  installApiBaseUrl,
  isBlocked,
  linkIdentity,
  pushSync,
  signInDeviceWithSession,
} from "./api.js";

installApiBaseUrl();

// ---- backing off from a host block -------------------------------------------------------------
//
// In memory: a restarted service worker starts over, which costs at most one more request.
//
// Not tried: `credentials: "include"`, so the browser's challenge-clearance cookie would ride
// along once the person has passed the challenge in a tab. Whether Vercel accepts that cookie
// on an extension's fetch (different origin, no page) is undocumented and can't be reproduced
// locally, and it would put the site's HttpOnly session cookie on every extension request. The
// bearer routes ignore cookies today, so that is not a hole yet, but it would make one easy to
// add; and the CORS layer (`allow_origin(Any)`, no credentials) only lets it through because
// Chrome skips CORS for an extension's own host permissions. A challenge lifts within minutes,
// which the back-off below waits out.
const BLOCK_BACKOFF_MIN_MS = 30_000;
const BLOCK_BACKOFF_MAX_MS = 10 * 60_000;
let blockedUntil = 0;
let blockBackoffMs = 0;

/** Throws a BlockedError, without a request, while backing off from a block. */
export function assertServerReachable() {
  if (Date.now() < blockedUntil) throw new BlockedError();
}

/** Forget any block, so the next call goes out. For tests. */
export function clearServerBackoff() {
  blockedUntil = 0;
  blockBackoffMs = 0;
}

// An answer from our server that the caller has no special meaning for. Carries the status, so
// the popup and the site can show which failure it was.
function serverError(res) {
  const err = new Error(res.data?.error || `Server error (${res.status}).`);
  err.status = res.status;
  return err;
}

// Make one request to our server. A response that never reached it throws BlockedError and starts
// (or doubles) the back-off; any response from the server itself ends it.
async function reach(request) {
  assertServerReachable();
  const res = await request();
  if (isBlocked(res)) {
    blockBackoffMs = Math.min(BLOCK_BACKOFF_MAX_MS, blockBackoffMs ? blockBackoffMs * 2 : BLOCK_BACKOFF_MIN_MS);
    blockedUntil = Date.now() + blockBackoffMs;
    throw new BlockedError();
  }
  clearServerBackoff();
  return res;
}

/** Whether the browser holds a challenge-app session for the configured server. */
export async function isAppSignedIn() {
  return Boolean(await readSessionCookie());
}

/** The website session cookie for our server, or null when the user isn't signed in there. */
export async function readSessionCookie() {
  const cookie = await chrome.cookies.get({ url: SERVER_URL, name: SESSION_COOKIE });
  return cookie?.value || null;
}

// Exchange the website session for this device's sync token — no second sign-in.
//
// Tokens are per device: issuing one here leaves every other browser linked, so a laptop and a
// desktop can both sync the same account.
//
// Returns null when there is no usable session, so callers can send the user to the site to sign
// in rather than surfacing an error.
export async function signInFromSession() {
  const sessionToken = await readSessionCookie();
  if (!sessionToken) return null;

  const res = await reach(() => signInDeviceWithSession({ sessionToken }));
  if (res.status === 401) return null; // stale or expired cookie — same remedy as having none
  if (res.status !== 200) throw serverError(res);
  return res.data;
}

// ---- no-password sign-in ---------------------------------------------------------------------
//
// These two endpoints are called with plain `fetch` rather than the generated client: they were
// added after the client in `generated/` was last produced. `installApiBaseUrl` still resolves
// the `/api/` path against SERVER_URL and normalizes non-JSON error bodies.

async function postJson(path, body, init = {}) {
  const res = await fetch(path, {
    method: "POST",
    ...init,
    headers: { "content-type": "application/json", ...(init.headers || {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let data = null;
  try {
    data = await res.json();
  } catch {
    // An empty body is a valid answer for some failures; the status carries the meaning.
  }
  return { status: res.status, data, headers: res.headers };
}

/** The company join code remembered by the site's `/join/<code>` page, or null. */
export async function readJoinCode() {
  const cookie = await chrome.cookies.get({ url: SERVER_URL, name: JOIN_COOKIE });
  return cookie?.value ? decodeURIComponent(cookie.value) : null;
}

// Sign in from the LinkedIn identity alone: creates the account on first use, signs in to the
// existing one afterwards.
//
// Returns `{ inviteRefused: true }` only when our server itself refused the join code: its JSON
// 403 saying to open the invite link (see app/api/auth/extension/join/route.rs). Everything else
// throws: a 403 from the host's bot challenge (BlockedError; the code was never even checked), the
// server's other 403 (a removed account, whose message says so), and any other status.
export const INVITE_REFUSED_ERROR = "open your company's invite link first";
export async function joinWithLinkedIn(member, joinCode) {
  const res = await reach(() => postJson("/api/auth/extension/join", { joinCode, member }));
  if (res.status === 403 && res.data?.error === INVITE_REFUSED_ERROR) return { inviteRefused: true };
  if (res.status !== 200) throw serverError(res);
  await setState({
    syncToken: res.data.syncToken,
    orgName: "Challenge Sync",
    displayName: res.data.displayName,
    memberUrn: member.memberUrn,
    publicIdentifier: member.publicIdentifier,
    lastError: null,
  });
  return res.data;
}

// Make the website open already signed in: mint a session from this device's sync token and put
// it in the cookie jar. Does nothing when a session cookie is already there, so an impersonation
// or a password login is never overwritten. Returns whether a session is present afterwards.
//
// `force` replaces a cookie that is present but that the site has just reported as not signed in
// (expired, or left over from another database). It is throttled so a page polling for sign-in
// cannot mint a session every few seconds.
//
// Throws BlockedError when the host blocks the request, so the site can say so; any other failure
// is "no session" (false).
let lastForcedAt = 0;
export async function ensureWebSession({ force = false } = {}) {
  if (await readSessionCookie()) {
    if (!force || Date.now() - lastForcedAt < 15_000) return true;
    lastForcedAt = Date.now();
  }
  const { syncToken } = await getState();
  if (!syncToken) return false;
  const res = await reach(() => postJson("/api/auth/device/web-session", undefined, bearer(syncToken)));
  if (res.status !== 200) return false;
  await chrome.cookies.set({
    url: SERVER_URL,
    name: SESSION_COOKIE,
    value: res.data.sessionToken,
    path: "/",
    httpOnly: true,
    secure: SERVER_URL.startsWith("https://"),
    sameSite: "lax",
    expirationDate: Math.floor(Date.now() / 1000) + res.data.maxAge,
  });
  return true;
}

// Bind this browser's LinkedIn identity to the account the sync token belongs to.
export async function linkIdentityToAccount(syncToken, member) {
  const token = syncToken.trim();
  const res = await reach(() => linkIdentity({ member }, bearer(token)));

  if (res.status === 401) throw new Error("That sync token wasn't recognized.");
  if (res.status === 409) {
    throw new Error("This LinkedIn account is already linked to someone else.");
  }
  if (res.status !== 200) throw serverError(res);

  await setState({
    syncToken: token,
    orgName: res.data.orgName,
    displayName: res.data.displayName,
    memberUrn: member.memberUrn,
    publicIdentifier: member.publicIdentifier,
    lastError: null,
  });
  return res.data;
}

// Upload a snapshot batch. Returns the server's response.
//
// A 401 here is routine rather than exceptional: an old install may hold a legacy token that a
// later link rotated away, and in development the server's database gets rebuilt out from under
// it. So we re-exchange the website session once and retry, and only surface an error if that
// fails too.
// Telling a user to "re-link" for something we can fix silently is just making them do our work.
//
// A host block is not a 401 and replaces nothing: it throws BlockedError with the token untouched.
export async function pushSnapshot(payload) {
  const { syncToken } = await getState();
  if (!syncToken) throw new Error("Not linked yet.");

  let res = await reach(() => pushSync(payload, bearer(syncToken)));

  if (res.status === 401) {
    const account = await signInFromSession();
    if (!account) {
      throw new Error(
        "Your link expired. Open the challenge site, sign in, then press Connect.",
      );
    }
    await setState({
      syncToken: account.syncToken,
      orgName: account.orgName,
      displayName: account.displayName,
    });
    res = await reach(() => pushSync(payload, bearer(account.syncToken))); // once only — no retry loop
    if (res.status === 401) {
      throw new Error("Signed in, but the server rejected the new token. Press Connect.");
    }
  }

  if (res.status !== 200) throw serverError(res);
  return res.data;
}

// What the server knows about this account across every device. Null when this device is not
// linked or the token is no longer accepted; callers fall back to local state. Throws
// BlockedError when the host blocks the request (the token says nothing about that).
export async function fetchSyncStatus() {
  const { syncToken } = await getState();
  if (!syncToken) return null;
  const res = await reach(() => getSyncStatus(bearer(syncToken)));
  if (res.status !== 200) return null;
  return res.data;
}
