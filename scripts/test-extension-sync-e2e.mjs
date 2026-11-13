#!/usr/bin/env node
// The extension's own server code against a real local server, with no browser and no LinkedIn.
//
// Imports the extension's sync.js / api.js (and so the generated nextrs client it ships) under
// plain node, with a small in-memory stand-in for `chrome.storage` and `chrome.cookies`, and drives
// the calls a sync makes, in order, against a throwaway debug server on a temporary database:
//
//   1. the join code the site leaves in its cookie is read back under the name the extension uses;
//   2. joining with a LinkedIn identity creates the account (a wrong code asks for an invite);
//   3. the device token becomes a website session cookie, which the site accepts;
//   4. a snapshot shaped exactly like runSync's payload (background.js) is accepted and stored;
//   5. a second snapshot with the posts past the refresh window left out (the extension's real
//      planRefresh) is accepted, uploads fewer posts, and the server keeps and deletes nothing;
//   6. a rejected sync token is recovered once from the website session, as pushSnapshot does;
//   7. a request the host blocks (Vercel's bot challenge: 403, text/html, `x-vercel-mitigated`,
//      simulated here by answering in the server's place) is a temporary error everywhere: join
//      is not "invite refused", a sync is not "token rejected", nothing is stored or replaced, and
//      the extension backs off without touching the network, while the server's own JSON 403 for a
//      wrong code is still "invite refused" and a removed account's 403 is neither.
//
// This is the server side of what scripts/test-join-flow-e2e.mjs does in a real browser. That
// test still covers what only a browser can: the /join page setting its cookie, the get-started
// page and bridge.js handshake, and real LinkedIn data. Requires `cargo build` in server/.
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import assert from "node:assert/strict";

const ROOT = resolve(new URL("..", import.meta.url).pathname);
const SERVER_BIN = resolve(ROOT, "server/target/debug/linkedin-challenge-server");
const JOIN_CODE = "extension-sync-e2e-code";
if (!existsSync(SERVER_BIN)) throw new Error(`no server binary at ${SERVER_BIN} — run \`cargo build\` in server/ first`);

let passed = 0;
const check = (name, condition) => {
  assert.ok(condition, name);
  passed += 1;
  console.log("PASS:", name);
};

// --- the names the extension and the site must agree on, read from both sides ---------------
const { JOIN_COOKIE, SESSION_COOKIE, SERVER_URL } = await import("../extension/config.js");
const joinPage = readFileSync(resolve(ROOT, "server/app/join/[code]/page.tsx"), "utf8");
const authRs = readFileSync(resolve(ROOT, "server/src/auth.rs"), "utf8");
check("the /join page stores the code under the cookie name the extension reads",
  joinPage.includes(`document.cookie = \`${JOIN_COOKIE}=`));
check("the server's session cookie has the name the extension reads and writes",
  authRs.includes(`pub const SESSION_COOKIE: &str = "${SESSION_COOKIE}";`));
// The payload below is built the way runSync builds it; fail if background.js grows a field.
const background = readFileSync(resolve(ROOT, "extension/background.js"), "utf8");
const payloadBlock = background.match(/const payload = \{([\s\S]*?)\};/)?.[1] ?? "";
const runSyncKeys = [...payloadBlock.matchAll(/^\s*(\w+):/gm)].map((m) => m[1]).sort();
const PAYLOAD_KEYS = ["capturedAt", "completePostFeedUrns", "excludedPostUrns", "postFeedComplete", "posts", "profile"];
check("this test sends the same payload fields as runSync", JSON.stringify(runSyncKeys) === JSON.stringify(PAYLOAD_KEYS));

// --- a throwaway server ------------------------------------------------------------------------
const dbDir = mkdtempSync(resolve(tmpdir(), "extension-sync-e2e-"));
const env = { ...process.env, DATABASE_URL: `turso:${dbDir}/test.db`, PORT: "0", JOIN_CODE };
delete env.DATABASE_URL_UNPOOLED;
const server = spawn(SERVER_BIN, [], { cwd: resolve(ROOT, "server"), env, stdio: ["ignore", "pipe", "pipe"] });
let serverLog = "";
const base = await new Promise((res, rej) => {
  const onData = (d) => {
    serverLog += d;
    const port = serverLog.match(/listening on http:\/\/[^:]+:(\d+)/)?.[1];
    if (port) res(`http://127.0.0.1:${port}`);
  };
  server.stdout.on("data", onData);
  server.stderr.on("data", onData);
  server.on("exit", () => rej(new Error(`server exited:\n${serverLog}`)));
});
const stop = () => {
  if (server.exitCode === null) server.kill("SIGTERM");
  rmSync(dbDir, { recursive: true, force: true });
};
process.on("exit", stop);

// --- chrome.* stand-ins, and the build's server URL pointed at the throwaway server -----------
const storage = new Map();
const cookies = new Map(); // name -> { value, ...attributes }, all for SERVER_URL
globalThis.chrome = {
  storage: {
    local: {
      async get(keys) {
        const list = keys == null ? [...storage.keys()] : Array.isArray(keys) ? keys : [keys];
        return Object.fromEntries(list.filter((k) => storage.has(k)).map((k) => [k, structuredClone(storage.get(k))]));
      },
      async set(patch) {
        for (const [k, v] of Object.entries(patch)) storage.set(k, structuredClone(v));
      },
    },
  },
  cookies: {
    async get({ url, name }) {
      assert.equal(url, SERVER_URL, "the extension only reads cookies for its own server here");
      return cookies.has(name) ? { name, ...cookies.get(name) } : null;
    },
    async set({ url, name, ...rest }) {
      assert.equal(url, SERVER_URL);
      cookies.set(name, rest);
    },
  },
};
const nativeFetch = globalThis.fetch;
// Paths answered by the "host" instead of the server, and every server path the extension asked.
const hostBlocks = new Map(); // path -> () => Response
const asked = [];
const challengePage = () =>
  new Response("<!doctype html><title>Vercel Security Checkpoint</title><p>We're verifying your browser.</p>", {
    status: 403,
    headers: { "content-type": "text/html; charset=utf-8", "x-vercel-mitigated": "challenge" },
  });
globalThis.fetch = async (input, init) => {
  if (typeof input !== "string" || !input.startsWith(SERVER_URL)) return nativeFetch(input, init);
  const path = input.slice(SERVER_URL.length);
  asked.push(path);
  if (hostBlocks.has(path)) return hostBlocks.get(path)();
  return nativeFetch(base + path, init);
};

const sync = await import("../extension/sync.js");
const { getState, setState } = await import("../extension/storage.js");
const { planRefresh, recordedUrnsFor } = await import("../extension/refresh.js");

// The website, signed in with whatever session cookie the extension placed.
const site = (path) =>
  nativeFetch(base + path, { headers: { cookie: `${SESSION_COOKIE}=${cookies.get(SESSION_COOKIE)?.value ?? ""}` } }).then((r) => r.json());

try {
  const member = {
    memberUrn: "urn:li:fsd_profile:EXTSYNC1",
    publicIdentifier: "ext-sync",
    firstName: "Ext",
    lastName: "Sync",
    profileUrl: "https://www.linkedin.com/in/ext-sync",
  };

  // 1-2. Join with the code the /join page left behind.
  check("no join code before the join link is opened", (await sync.readJoinCode()) === null);
  cookies.set(JOIN_COOKIE, { value: encodeURIComponent("wrong code") });
  check("a wrong join code is refused by the server and stores nothing",
    (await sync.joinWithLinkedIn(member, await sync.readJoinCode())).inviteRefused === true && !(await getState()).syncToken);
  check("no join code at all is the server's join_code_required, read as 'needs an invite'",
    (await sync.joinWithLinkedIn(member, "")).needsInvite === true && !(await getState()).syncToken);
  cookies.set(JOIN_COOKIE, { value: encodeURIComponent(JOIN_CODE) });
  check("the join code is read back from the site's cookie", (await sync.readJoinCode()) === JOIN_CODE);
  const joined = await sync.joinWithLinkedIn(member, JOIN_CODE);
  const state = await getState();
  check("joining creates the account and stores a sync token",
    joined.created === true && state.syncToken === joined.syncToken && state.memberUrn === member.memberUrn);

  // 3. A website session from the device token.
  check("there is no website session before the extension makes one", !(await sync.isAppSignedIn()));
  check("the device token becomes a website session cookie", (await sync.ensureWebSession()) === true);
  const session = cookies.get(SESSION_COOKIE);
  check("the cookie is HttpOnly, Lax, and not Secure on http", session.httpOnly && session.sameSite === "lax" && !session.secure);
  const me = await site("/api/auth/me");
  check("the site accepts that session as the member", me.signedIn === true && me.displayName === "Ext Sync");
  const device = await sync.signInFromSession();
  check("a second device signs in from the website session", typeof device?.syncToken === "string" && device.syncToken !== state.syncToken);

  // 4. A first sync: every post on an under-full page, shaped like the collectors' output.
  const daysAgo = (d) => new Date(Date.now() - d * 86_400_000).toISOString();
  const post = (id, days, extra = {}) => ({
    urn: `urn:li:activity:${id}`,
    permalink: `https://www.linkedin.com/feed/update/urn:li:activity:${id}/`,
    createdAt: days == null ? null : daysAgo(days),
    textPreview: `post ${id}`,
    imageUrls: [`https://media.licdn.com/${id}.jpg`],
    isRepost: false,
    metrics: {
      impressions: 1000 + id, reactions: 10, comments: 1, reposts: 0, sends: 1, saves: 2,
      impressionsInNetwork: 600, impressionsOutOfNetwork: 400 + id, membersReached: 800,
      profileViewersFromPost: 3, followersFromPost: 1,
    },
    comments: [{
      urn: `urn:li:comment:(urn:li:activity:${id},${id}0)`,
      commenterUrn: "urn:li:publicIdentifier:someone-else",
      commenterName: "Someone Else",
      createdAt: null,
      isReply: false,
    }],
    ...extra,
  });
  const feed = { posts: [post(1, 2), post(2, 20), post(3, 60), post(4, 90), post(5, null)], postFeedComplete: true };
  const payloadFor = (plan) => ({
    capturedAt: new Date().toISOString(),
    profile: { followerCount: 1234, profileViews: 56 },
    posts: plan.posts,
    excludedPostUrns: [],
    postFeedComplete: plan.postFeedComplete,
    completePostFeedUrns: plan.completePostFeedUrns,
  });
  const firstPlan = planRefresh(feed, recordedUrnsFor((await getState()).recordedPosts, member.memberUrn));
  const first = await sync.pushSnapshot(payloadFor(firstPlan));
  check("the first sync is accepted with every post", first.ok === true && first.postsIngested === 5);
  await setState({ recordedPosts: { memberUrn: member.memberUrn, urns: [...firstPlan.posts, ...firstPlan.unrefreshedPostUrns].map((p) => p.urn ?? p) } });
  const status = await sync.fetchSyncStatus();
  check("sync-status reports the account linked with all five posts", status.linked === true && status.postsCount === 5);
  const stored = await site("/api/me/posts?sort=newest&pageSize=100");
  const byUrn = Object.fromEntries(stored.posts.map((p) => [p.urn, p]));
  check("the website lists the five posts with their numbers",
    stored.total === 5 && byUrn["urn:li:activity:1"].impressions === 1001 && byUrn["urn:li:activity:3"].impressionsOutOfNetwork === 403);

  // 5. A second sync: the extension's own planRefresh leaves out the two delivered old posts.
  const secondPlan = planRefresh(feed, recordedUrnsFor((await getState()).recordedPosts, member.memberUrn));
  check("planRefresh leaves out the two delivered posts past the window",
    JSON.stringify(secondPlan.unrefreshedPostUrns) === JSON.stringify(["urn:li:activity:3", "urn:li:activity:4"]));
  const second = await sync.pushSnapshot(payloadFor(secondPlan));
  check("the second sync is accepted and uploads only the three refreshed posts", second.ok === true && second.postsIngested === 3);
  const after = await site("/api/me/posts?sort=newest&pageSize=100");
  check("the server still stores all five posts, the left-out ones with their numbers",
    after.total === 5 && after.posts.find((p) => p.urn === "urn:li:activity:4")?.impressions === 1004);

  // 6. A token the server no longer knows is recovered once from the website session.
  await setState({ syncToken: "not-a-real-token" });
  const recovered = await sync.pushSnapshot(payloadFor(secondPlan));
  check("a rejected sync token is replaced from the website session and the sync goes through",
    recovered.ok === true && (await getState()).syncToken !== "not-a-real-token");

  // 7. Requests the host blocks before they reach the server.
  const { BLOCKED_MESSAGE } = await import("../extension/api.js");
  const blockedError = async (call) => {
    try {
      const value = await call();
      return { value };
    } catch (err) {
      return { blocked: err.blocked === true && err.message === BLOCKED_MESSAGE, err };
    }
  };
  const before = await getState();
  const plainJoin = await blockedError(() => sync.joinWithLinkedIn(member, JOIN_CODE));
  hostBlocks.set("/api/auth/extension/join", challengePage);
  const challengedJoin = await blockedError(() => sync.joinWithLinkedIn(member, JOIN_CODE));
  check("sanity: the unblocked join above went through", plainJoin.value?.syncToken);
  check("a challenged join is a temporary error, not an invite refusal",
    challengedJoin.blocked && challengedJoin.value === undefined);
  const afterJoin = await getState();
  await setState({ syncToken: before.syncToken });

  let count = asked.length;
  const backedOff = await blockedError(() => sync.joinWithLinkedIn(member, JOIN_CODE));
  check("while backing off, the extension doesn't touch the network", backedOff.blocked && asked.length === count);
  check("so the background never asks LinkedIn either", (() => { try { sync.assertServerReachable(); return false; } catch (e) { return e.blocked; } })());
  sync.clearServerBackoff();
  hostBlocks.delete("/api/auth/extension/join");
  check("after a challenged join, a wrong code is still refused by the server",
    (await sync.joinWithLinkedIn(member, "still wrong")).inviteRefused === true);
  check("a challenged join stored nothing", afterJoin.syncToken === plainJoin.value.syncToken);

  // Not every 403 is an invite refusal, and not every block says so in a header.
  hostBlocks.set("/api/auth/extension/join", () => new Response("Forbidden", { status: 403, headers: { "content-type": "text/plain" } }));
  check("a 403 with a non-JSON body is a host block too", (await blockedError(() => sync.joinWithLinkedIn(member, JOIN_CODE))).blocked);
  sync.clearServerBackoff();
  hostBlocks.set("/api/auth/extension/join", () => Response.json({ error: "slow down" }, { status: 429 }));
  check("a 429 is a host block", (await blockedError(() => sync.joinWithLinkedIn(member, JOIN_CODE))).blocked);
  sync.clearServerBackoff();
  // Invite messages need the server's code; everything else says what it was (extension/errors.js).
  const { describeError } = await import("../extension/errors.js");
  const joinAnswer = async (respond) => {
    hostBlocks.set("/api/auth/extension/join", respond);
    const outcome = await blockedError(() => sync.joinWithLinkedIn(member, JOIN_CODE));
    sync.clearServerBackoff();
    hostBlocks.delete("/api/auth/extension/join");
    return { ...outcome, described: outcome.err ? describeError(outcome.err) : null };
  };
  const notInvite = (o) => o.value === undefined && !/invite/i.test(o.described?.message ?? "invite");
  let o = await joinAnswer(() => Response.json({ error: "anything at all", code: "join_code_invalid" }, { status: 403 }));
  check("a JSON 403 with join_code_invalid is an invite refusal, whatever its text", o.value?.inviteRefused === true);
  o = await joinAnswer(() => Response.json({ error: "open your company's invite link first" }, { status: 403 }));
  check("a JSON 403 with the old invite text but no code is NOT an invite refusal",
    notInvite(o) && o.described.code === "unexpected-403", JSON.stringify(o.described));
  o = await joinAnswer(() => Response.json({ error: "something new", code: "some_future_code" }, { status: 403 }));
  check("a JSON 403 with an unknown code is NOT an invite refusal, and says its status and code",
    notInvite(o) && o.described.code === "unexpected-403" && /some_future_code/.test(o.described.message), JSON.stringify(o.described));
  o = await joinAnswer(() => Response.json({ error: "this account has been removed; ask an admin to restore it", code: "account_deleted" }, { status: 403 }));
  check("a removed account says so, not an invite refusal", notInvite(o) && o.described.code === "account_deleted" && o.err.status === 403);
  o = await joinAnswer(() => Response.json({ error: "database error" }, { status: 500 }));
  check("a 500 from the server is 'the server had a problem (500)'", notInvite(o) && o.described.code === "server-500" && /\(500\)/.test(o.described.message));
  o = await joinAnswer(() => new Response("<html>Bad gateway</html>", { status: 502, headers: { "content-type": "text/html" } }));
  check("an HTML 502 is a server problem too, not a block and not an invite",
    notInvite(o) && !o.blocked && o.described.code === "server-502", JSON.stringify(o.described));
  o = await joinAnswer(() => { throw new TypeError("fetch failed"); });
  check("no answer at all (fetch threw) is 'can't reach the server'",
    notInvite(o) && o.described.code === "unreachable" && /Can't reach the Challenge Sync server/.test(o.described.message), JSON.stringify(o.described));
  o = await joinAnswer(challengePage);
  check("a host challenge is 'blocked', worded as a block, not an invite", notInvite(o) && o.blocked && o.described.code === "blocked");

  // A challenged sync keeps the token and does not try to re-link.
  const token = (await getState()).syncToken;
  hostBlocks.set("/api/sync", challengePage);
  count = asked.length;
  const challengedSync = await blockedError(() => sync.pushSnapshot(payloadFor(secondPlan)));
  check("a challenged sync is a temporary error", challengedSync.blocked);
  check("a challenged sync is not read as a rejected token: no re-link, the token is kept",
    asked.slice(count).every((path) => path === "/api/sync") && (await getState()).syncToken === token);
  sync.clearServerBackoff();
  hostBlocks.delete("/api/sync");

  // A challenged web-session mint says so and leaves the cookie jar alone.
  cookies.delete(SESSION_COOKIE);
  hostBlocks.set("/api/auth/device/web-session", challengePage);
  check("a challenged web-session request is a temporary error", (await blockedError(() => sync.ensureWebSession())).blocked);
  check("and sets no session cookie and keeps the token", !cookies.has(SESSION_COOKIE) && (await getState()).syncToken === token);
  sync.clearServerBackoff();
  hostBlocks.delete("/api/auth/device/web-session");
  check("unblocked, the web session is made again", (await sync.ensureWebSession()) === true);
  // The server's refusal of the token says so, rather than reading as "no session".
  cookies.delete(SESSION_COOKIE);
  await setState({ syncToken: "revoked-token" });
  const rejected = await blockedError(() => sync.ensureWebSession());
  check("a refused token is the server's sync_token_rejected, not 'signed out'",
    rejected.err && describeError(rejected.err).code === "sync_token_rejected", JSON.stringify(rejected.err && describeError(rejected.err)));
  await setState({ syncToken: token });
  check("and with the token back the session is made", (await sync.ensureWebSession()) === true);

  // A challenged session exchange is not "no session" (null) and not a server error.
  hostBlocks.set("/api/auth/device/session", challengePage);
  check("a challenged session exchange is a temporary error", (await blockedError(() => sync.signInFromSession())).blocked);
  sync.clearServerBackoff();
  hostBlocks.delete("/api/auth/device/session");

  hostBlocks.set("/api/me/sync-status", challengePage);
  check("a challenged sync-status is a temporary error", (await blockedError(() => sync.fetchSyncStatus())).blocked);
  sync.clearServerBackoff();
  hostBlocks.delete("/api/me/sync-status");
  check("unblocked, everything works again with the same token",
    (await sync.fetchSyncStatus()).linked === true && (await sync.pushSnapshot(payloadFor(secondPlan))).ok === true &&
      (await getState()).syncToken === token);

  // The background's own reading of these answers (no browser here, so read from the source).
  check("only the server's refusal sets refusedJoinCode",
    /if \(data\.inviteRefused\) \{\s*refusedJoinCode = joinCode;/.test(background) &&
      (background.match(/refusedJoinCode = (?!null)/g) || []).length === 1);
} catch (err) {
  console.error(`FAIL: ${err.message}\nserver log tail:\n${serverLog.slice(-1500)}`);
  process.exitCode = 1;
} finally {
  stop();
}
if (!process.exitCode) console.log(JSON.stringify({ result: "PASS", checks: passed }));
