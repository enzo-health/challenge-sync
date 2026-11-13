// MV3 service worker: schedules periodic scrapes, runs them, and answers popup messages.
import { SYNC_CHECK_MINUTES, SYNC_JITTER_MINUTES, MIN_SYNC_INTERVAL_MINUTES } from "./config.js";
import { getState, setState, isLinked } from "./storage.js";
import { collectSnapshot, getMe, getPostFeed, getPostComments, getFollowerCount, diagnose, isLinkedInSignedIn } from "./linkedin.js";
import {
  assertServerReachable,
  ensureWebSession,
  fetchSyncStatus,
  joinWithLinkedIn,
  linkIdentityToAccount,
  pushSnapshot,
  readJoinCode,
  signInFromSession,
} from "./sync.js";
import { SERVER_URL, LINKEDIN_ORIGIN } from "./config.js";
import { LinkedInError, SERVER_CODES, ServerError, describeError } from "./errors.js";

const errorReply = (err) => {
  const { code, message } = describeError(err);
  return { error: message, errorCode: code };
};

const ALARM = "challenge-sync";
// After a page or popup visit started an automatic sync, how long before another visit may start
// one. Only matters when syncs keep failing (a success moves the 12-hour floor instead), and keeps
// a member browsing the site from asking LinkedIn on every page.
const KICK_RETRY_MINUTES = 15;

// Convenience for the *service worker* console (chrome://extensions -> "service worker"), where
// `chrome.runtime` exists but module bindings don't: `await diagnose()`.
globalThis.diagnose = diagnose;
// The collectors, for the e2e check (scripts/test-extension-e2e.mjs), which drives this worker
// over DevTools — a service worker can't dynamic-import, so they must be reachable by name.
globalThis.collectors = { getMe, getPostFeed, getPostComments, getFollowerCount, collectSnapshot };
// The sync cycle, for the join-flow e2e check (scripts/test-join-flow-e2e.mjs), which runs a
// second sync from this worker's own context, where it can't message itself with SYNC_NOW.
globalThis.runSync = runSync;

// Arm the check alarm. It fires every SYNC_CHECK_MINUTES; runSync() decides whether enough time
// has passed. The first check comes a minute after install or browser start, so a laptop that
// has been closed for two days syncs as soon as it is back rather than at the next clock mark.
async function scheduleSync() {
  await chrome.alarms.clear(ALARM);
  chrome.alarms.create(ALARM, { delayInMinutes: 1, periodInMinutes: SYNC_CHECK_MINUTES });
}

chrome.runtime.onInstalled.addListener(scheduleSync);
chrome.runtime.onStartup.addListener(scheduleSync);

// And on every start of this worker, without replacing an alarm that is already armed. Install and
// browser start are not the only ways in: an update Chrome held back for a permission change, then
// re-enabled by its owner, gives no guarantee that onInstalled runs at that point, and nothing else
// would arm the alarm until the next browser restart. (Re-enabling is not observable without the
// "management" permission, which would be a new permission prompt for everyone; this needs none.)
export async function ensureAlarm() {
  if (await chrome.alarms.get(ALARM)) return false;
  chrome.alarms.create(ALARM, { delayInMinutes: 1, periodInMinutes: SYNC_CHECK_MINUTES });
  return true;
}
const alarmChecked = ensureAlarm().catch(() => false);
globalThis.alarmChecked = alarmChecked; // for scripts/test-extension-worker.mjs

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM) {
    ensureLinked()
      // The alarm's own sync reports its failure in lastError; a missing website session is not
      // worth one (the next page visit makes it).
      .then(() => ensureWebSession().catch(() => false))
      .then(() => runSyncOnce())
      .catch(() => {});
  }
});

// Linking needs no password. Being logged in to LinkedIn is the identity; the company's join
// link (remembered by the site in a cookie) is the permission. It happens by itself on install,
// at each alarm, whenever the popup opens, and whenever the site's get-started page asks.
// Nothing is stored until the server has accepted the identity, so a failure here leaves the
// install exactly as unlinked as before and the next attempt starts clean.
//
// A browser that is already signed in on the site (a password account) links through that
// session instead, exactly as before.
//
// Returns `{ ok: true }`, or `{ ok: false }` with exactly one reason the popup and the site show:
//   needsLinkedIn   not logged in to LinkedIn in this browser;
//   needsInvite     no join code: the invite link was never opened in this browser (or the
//                   server said `join_code_required`);
//   inviteRefused   our server refused the join code with `join_code_invalid`;
//   error           anything else, with `errorCode` and a message from errors.js: "blocked",
//                   "unreachable", "timeout", "server-<status>", a server refusal code such as
//                   "account_deleted", "linkedin-*", "unexpected-<status>", or "extension-error".
// Only the server's coded refusal is `inviteRefused`, so a firewall challenge, an outage or an
// unexplained 403 can never be shown as an invite problem.
let linking = null;
// A join code the server has already refused. LinkedIn is asked who you are before each join
// attempt, so retrying a known-bad code on every poll would be needless traffic to LinkedIn.
// Set only from `inviteRefused`, never from a failure to reach the server.
let refusedJoinCode = null;
// When the server last said this LinkedIn identity is an admin's (`admin_use_password`). Admins
// sign in with a password and link through that session (checked first, with no LinkedIn read),
// so until then a join attempt would only ask LinkedIn again for the same refusal.
let adminRefusedAt = 0;
const ADMIN_RETRY_MS = 10 * 60_000;
async function ensureLinked() {
  if (await isLinked()) return { ok: true };
  if (linking) return linking; // popup and alarm may both ask at once; link once
  linking = (async () => {
    try {
      if (!(await isLinkedInSignedIn())) return { ok: false, needsLinkedIn: true };
      const account = await signInFromSession();
      const joinCode = account ? null : await readJoinCode();
      if (!account && !joinCode) return { ok: false, needsInvite: true };
      if (!account && joinCode === refusedJoinCode) return { ok: false, inviteRefused: true };
      if (!account && Date.now() - adminRefusedAt < ADMIN_RETRY_MS) {
        return { ok: false, ...errorReply(new ServerError({ status: 403, code: SERVER_CODES.ADMIN_USE_PASSWORD })) };
      }
      // Backing off from a host block: don't ask LinkedIn who you are for a join that can't land.
      assertServerReachable();
      const me = await getMe();
      if (!me.memberUrn) throw new LinkedInError("profile");
      const identity = {
        memberUrn: me.memberUrn,
        publicIdentifier: me.publicIdentifier,
        firstName: me.firstName,
        lastName: me.lastName,
        profileUrl: me.profileUrl,
      };
      let data;
      if (account) {
        data = await linkIdentityToAccount(account.syncToken, identity);
      } else {
        data = await joinWithLinkedIn(identity, joinCode);
        if (data.inviteRefused) {
          refusedJoinCode = joinCode;
          return { ok: false, inviteRefused: true };
        }
        if (data.needsInvite) return { ok: false, needsInvite: true };
      }
      await scheduleSync();
      // Kick off a first sync right away so the user sees data immediately.
      runSyncOnce({ manual: true }).catch(() => {});
      return { ok: true, data, justLinked: true };
    } catch (err) {
      if (err?.code === SERVER_CODES.ADMIN_USE_PASSWORD) adminRefusedAt = Date.now();
      const { code, message } = describeError(err);
      await setState({ lastError: message, lastErrorCode: code });
      return { ok: false, error: message, errorCode: code };
    } finally {
      linking = null;
    }
  })();
  return linking;
}

/** Milliseconds until the next AUTOMATIC sync is due; 0 when it's due now. */
export async function msUntilSyncAllowed() {
  const { lastSyncAt, syncJitterMinutes } = await getState();
  if (!lastSyncAt) return 0;
  // A per-install offset, fixed at first sync, so a fleet of laptops spreads its syncs out.
  const jitter = typeof syncJitterMinutes === "number" ? syncJitterMinutes : 0;
  const elapsed = Date.now() - new Date(lastSyncAt).getTime();
  return Math.max(0, (MIN_SYNC_INTERVAL_MINUTES + jitter) * 60_000 - elapsed);
}

// One sync at a time, whoever asks (alarm, popup, page, first link): a second caller while one
// runs gets that sync's result instead of starting another scrape of LinkedIn.
let syncInFlight = null;
function runSyncOnce(options) {
  syncInFlight ??= runSync(options).finally(() => {
    syncInFlight = null;
  });
  return syncInFlight;
}

/**
 * Start an AUTOMATIC sync if one is due, because someone just visited the site or opened the popup.
 * Unattended, so the 12-hour floor and the politeness delays hold; after a failed one, another
 * visit waits KICK_RETRY_MINUTES. Returns what happened:
 *   "running"      a sync is under way (just started, or already was);
 *   "not-due"      the last successful sync is recent enough;
 *   "recently-tried"  a visit started one a few minutes ago and it did not succeed;
 *   "not-linked"   nothing to sync for.
 */
export async function startDueSync() {
  if (syncInFlight) return "running";
  if (!(await isLinked())) return "not-linked";
  if ((await msUntilSyncAllowed()) > 0) return "not-due";
  const { lastKickedSyncAt } = await getState();
  if (lastKickedSyncAt && Date.now() - new Date(lastKickedSyncAt).getTime() < KICK_RETRY_MINUTES * 60_000) {
    return "recently-tried";
  }
  if (syncInFlight) return "running"; // another hello got here during the awaits above
  syncInFlight = runSync().finally(() => {
    syncInFlight = null;
  });
  // Recorded after claiming the slot, so two hellos racing here still start one sync.
  await setState({ lastKickedSyncAt: new Date().toISOString() });
  return "running";
}
globalThis.startDueSync = startDueSync;

// The core scrape+upload cycle. Records status/errors for the popup either way.
//
// `manual` skips the twice-a-day floor. That floor exists to keep *background* traffic polite —
// unattended alarm firings are what could hammer LinkedIn. A person clicking "Sync now" is
// deliberate, attended, and self-limiting, so refusing them serves nobody.
async function runSync({ manual = false } = {}) {
  if (!(await isLinked())) return { ok: false, error: "Not linked." };

  if (!manual) {
    const wait = await msUntilSyncAllowed();
    if (wait > 0) return { ok: false, tooSoon: true, retryInMs: wait };
  }

  try {
    // Backing off from a host block: don't read LinkedIn for an upload that can't land.
    assertServerReachable();
    const snap = await collectSnapshot({ recordedPosts: (await getState()).recordedPosts });
    const payload = {
      capturedAt: new Date().toISOString(),
      profile: snap.profile,
      posts: snap.posts,
      excludedPostUrns: snap.excludedPostUrns,
      postFeedComplete: snap.postFeedComplete,
      completePostFeedUrns: snap.completePostFeedUrns,
    };
    const result = await pushSnapshot(payload);
    const { syncJitterMinutes } = await getState();
    await setState({
      // Only after the server accepted the batch: a post counts as recorded once it has landed.
      recordedPosts: {
        memberUrn: snap.me.memberUrn,
        urns: [...snap.posts.map((post) => post.urn), ...snap.unrefreshedPostUrns],
      },
      lastSyncAt: new Date().toISOString(),
      lastError: null,
      lastErrorCode: null,
      lastPostsIngested: result.postsIngested ?? snap.posts.length,
      syncJitterMinutes:
        typeof syncJitterMinutes === "number"
          ? syncJitterMinutes
          : Math.round(Math.random() * SYNC_JITTER_MINUTES),
    });
    return { ok: true, postsIngested: result.postsIngested ?? snap.posts.length };
  } catch (err) {
    const { code, message } = describeError(err);
    await setState({ lastError: message, lastErrorCode: code });
    return { ok: false, error: message, errorCode: code };
  }
}

// What a failure says, and its short code for small print: see errors.js.
const friendlyError = (err) => describeError(err).message;
const errorCode = (err) => describeError(err).code;

// --- popup message API -----------------------------------------------------
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    try {
      switch (msg.type) {
        case "GET_STATE":
          sendResponse({ ok: true, state: await getState() });
          break;
        case "LINK":
          // Kept for the popup's retry path; the same flow runs unattended in ensureLinked().
          sendResponse(await ensureLinked());
          break;
        case "STATUS": {
          // Everything the popup renders, in one round trip. Links first if it can, then prefers
          // the server's account-wide numbers over this device's local ones: a second device
          // otherwise reads "0 posts, never synced" while the first has been syncing for weeks.
          const link = await ensureLinked();
          // Opening the popup is a visit: a due automatic sync starts now rather than at the alarm.
          let sync = null;
          if (link.ok) {
            ensureWebSession().catch(() => {});
            sync = await startDueSync();
          }
          const state = await getState();
          let remote = null;
          let remoteError = null;
          if (state.syncToken) {
            remote = await fetchSyncStatus().catch((err) => {
              remoteError = describeError(err);
              return null;
            });
          }
          sendResponse({ ok: true, link, state, remote, remoteError, sync, dueInMs: await msUntilSyncAllowed() });
          break;
        }
        case "PREFLIGHT": {
          // Both sessions are required, and they fail for different reasons with different fixes,
          // so report them separately rather than as one "not ready".
          const [joinCode, linkedIn] = await Promise.all([readJoinCode(), isLinkedInSignedIn()]);
          sendResponse({ ok: true, hasInvite: Boolean(joinCode), linkedInSignedIn: linkedIn, serverUrl: SERVER_URL });
          break;
        }
        case "PAGE_HELLO": {
          // A page of the site, relayed by bridge.js: the signed-out get-started page, or (since
          // 0.1.4 of the site) the signed-in "hasn't synced" banner, which says `signedIn`. A
          // signed-out page means a session cookie that is still present is stale, so it gets
          // replaced; a signed-in page has a working one, so it is left alone.
          const link = await ensureLinked();
          let error = link.error || null;
          let code = link.errorCode || null;
          let sync = null;
          if (link.ok) {
            // A failed web-session request is said out loud rather than read as "signed out".
            await ensureWebSession({ force: !msg.signedIn }).catch((err) => {
              error = friendlyError(err);
              code = errorCode(err);
            });
            // A visit to the site by someone already linked starts a due automatic sync. Just
            // linked, the first sync is already running (ensureLinked started it).
            sync = await startDueSync();
          }
          const state = await getState();
          sendResponse({
            ok: true,
            linkedInSignedIn: await isLinkedInSignedIn(),
            linked: Boolean(link.ok),
            needsInvite: Boolean(link.needsInvite),
            inviteRefused: Boolean(link.inviteRefused),
            error,
            errorCode: code,
            // Since 0.1.4, for the signed-in banner: what this visit did about syncing, when this
            // browser last synced, and why the last attempt failed, if it did.
            sync,
            lastSyncAt: state.lastSyncAt,
            syncError: state.lastError,
            syncErrorCode: state.lastErrorCode,
          });
          break;
        }
        case "OPEN_LINKEDIN":
          await chrome.tabs.create({ url: LINKEDIN_ORIGIN });
          sendResponse({ ok: true });
          break;
        case "SYNC_DUE_IN":
          sendResponse({ ok: true, ms: await msUntilSyncAllowed() });
          break;
        case "DIAGNOSE": {
          // Structure only — safe to share. See linkedin.js `diagnose()`.
          const report = await diagnose();
          console.log("[challenge-sync] voyager shape:", JSON.stringify(report, null, 2));
          sendResponse({ ok: true, report });
          break;
        }
        case "OPEN_SIGN_IN":
          await chrome.tabs.create({ url: `${SERVER_URL}/auth/login` });
          sendResponse({ ok: true });
          break;
        case "OPEN_DASHBOARD":
          // Sign the site in first, so the tab opens on the results rather than on get-started.
          await ensureWebSession().catch(() => false);
          await chrome.tabs.create({ url: `${SERVER_URL}/me` });
          sendResponse({ ok: true });
          break;
        case "SYNC_NOW":
          sendResponse(await runSyncOnce({ manual: true }));
          break;
        default:
          sendResponse({ ok: false, error: "Unknown message." });
      }
    } catch (err) {
      sendResponse({ ok: false, error: friendlyError(err), errorCode: errorCode(err) });
    }
  })();
  return true; // async response
});
