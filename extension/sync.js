// Talks to OUR server through the generated nextrs client (see api.js). Bearer-token auth; no
// cookies involved.
//
// The request and response shapes come from the Rust routes via OpenAPI, so a field rename on the
// server surfaces here as a type error in an editor rather than as a silent runtime failure. What
// stays hand-written is the part that is genuinely ours: turning status codes into messages a
// person can act on.
import { getState, setState } from "./storage.js";
import { JOIN_COOKIE, SERVER_URL, SESSION_COOKIE } from "./config.js";
import { bearer, getSyncStatus, installApiBaseUrl, linkIdentity, pushSync, signInDeviceWithSession } from "./api.js";

installApiBaseUrl();

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

  const res = await signInDeviceWithSession({ sessionToken });
  if (res.status === 401) return null; // stale or expired cookie — same remedy as having none
  if (res.status !== 200) throw new Error(res.data?.error || `Server error (${res.status}).`);
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
  return { status: res.status, data };
}

/** The company join code remembered by the site's `/join/<code>` page, or null. */
export async function readJoinCode() {
  const cookie = await chrome.cookies.get({ url: SERVER_URL, name: JOIN_COOKIE });
  return cookie?.value ? decodeURIComponent(cookie.value) : null;
}

// Sign in from the LinkedIn identity alone: creates the account on first use, signs in to the
// existing one afterwards. Returns `{ needsInvite: true }` when the server wants a join code
// this browser does not have (or has wrong).
export async function joinWithLinkedIn(member, joinCode) {
  const res = await postJson("/api/auth/extension/join", { joinCode, member });
  if (res.status === 403) return { needsInvite: true };
  if (res.status !== 200) throw new Error(res.data?.error || `Server error (${res.status}).`);
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
let lastForcedAt = 0;
export async function ensureWebSession({ force = false } = {}) {
  if (await readSessionCookie()) {
    if (!force || Date.now() - lastForcedAt < 15_000) return true;
    lastForcedAt = Date.now();
  }
  const { syncToken } = await getState();
  if (!syncToken) return false;
  const res = await postJson("/api/auth/device/web-session", undefined, bearer(syncToken));
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
  const res = await linkIdentity({ member }, bearer(token));

  if (res.status === 401) throw new Error("That sync token wasn't recognized.");
  if (res.status === 409) {
    throw new Error("This LinkedIn account is already linked to someone else.");
  }
  if (res.status !== 200) throw new Error(res.data?.error || `Server error (${res.status}).`);

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
export async function pushSnapshot(payload) {
  const { syncToken } = await getState();
  if (!syncToken) throw new Error("Not linked yet.");

  let res = await pushSync(payload, bearer(syncToken));

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
    res = await pushSync(payload, bearer(account.syncToken)); // once only — no retry loop
    if (res.status === 401) {
      throw new Error("Signed in, but the server rejected the new token. Press Connect.");
    }
  }

  if (res.status !== 200) throw new Error(res.data?.error || `Server error (${res.status}).`);
  return res.data;
}

// What the server knows about this account across every device. Null when this device is not
// linked or the token is no longer accepted; callers fall back to local state.
export async function fetchSyncStatus() {
  const { syncToken } = await getState();
  if (!syncToken) return null;
  const res = await getSyncStatus(bearer(syncToken));
  if (res.status !== 200) return null;
  return res.data;
}
