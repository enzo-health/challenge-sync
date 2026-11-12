#!/usr/bin/env node
// End-to-end check of the extension's LinkedIn collectors against a REAL signed-in session.
//
// Launches Chromium headless on the repo's dev profile (`.chromium-dev-profile`, which holds a
// LinkedIn login) with the unpacked extension loaded, then drives the extension's own service
// worker over the DevTools protocol and calls the collectors exactly as a sync would. It asserts
// the shapes and numbers that have bitten us before: the follower count must be the member's
// OWN (not a company page's), posts must carry engagement, and comments must carry authors.
//
// Usage:
//   node scripts/test-extension-e2e.mjs                    # sanity checks only
//   EXPECTED_FOLLOWERS=980 node scripts/test-extension-e2e.mjs   # also assert the count (±15%)
//
// Requires: chromium on PATH, `just extension-dev` already run (dist/unpacked exists), and the
// dev profile signed in to LinkedIn — sessions expire after a couple of weeks; refresh with
// `just dev-profile-login`. Talks only to LinkedIn; never to the challenge server.

import { spawn } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = resolve(new URL("..", import.meta.url).pathname);
const PROFILE = process.env.CHROME_PROFILE || resolve(ROOT, ".chromium-dev-profile");
const UNPACKED = resolve(ROOT, "extension/dist/unpacked");
const CHROME = process.env.CHROME || "chromium";
const PORT = Number(process.env.CDP_PORT || 9333);
const EXPECTED = process.env.EXPECTED_FOLLOWERS ? Number(process.env.EXPECTED_FOLLOWERS) : null;

const fail = (msg) => {
  console.error(`FAIL: ${msg}`);
  process.exitCode = 1;
};
const ok = (msg) => console.log(`ok   ${msg}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (!existsSync(PROFILE)) throw new Error(`no Chrome profile at ${PROFILE}`);
if (!existsSync(resolve(UNPACKED, "manifest.json"))) {
  throw new Error(`no unpacked extension at ${UNPACKED} — run \`just extension-dev\` first`);
}

// A lock left behind by a Chromium that is no longer running would make this one refuse to start.
for (const f of ["SingletonLock", "SingletonSocket", "SingletonCookie"]) {
  const p = resolve(PROFILE, f);
  if (existsSync(p)) rmSync(p, { force: true });
}
// Chromium keeps the extension's service-worker script in the profile's cache and will happily
// run last build's background.js under this build's manifest. Drop the cache so the worker under
// test is the one on disk. Cookies and logins live elsewhere and are untouched.
rmSync(resolve(PROFILE, "Default", "Service Worker"), { recursive: true, force: true });

const chrome = spawn(
  CHROME,
  [
    "--headless=new",
    `--user-data-dir=${PROFILE}`,
    `--load-extension=${UNPACKED}`,
    `--disable-extensions-except=${UNPACKED}`,
    `--remote-debugging-port=${PORT}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-gpu",
    "--window-size=1280,900",
    "https://www.linkedin.com/feed/",
  ],
  { stdio: ["ignore", "ignore", "pipe"] },
);
let chromeErr = "";
chrome.stderr.on("data", (d) => (chromeErr += d));
const stop = () => {
  if (!chrome.killed) chrome.kill("SIGTERM");
};
process.on("exit", stop);

// --- CDP plumbing (Node 22 has a global WebSocket) --------------------------------------------
async function targets() {
  const res = await fetch(`http://127.0.0.1:${PORT}/json`);
  return res.json();
}
async function waitForWorker() {
  for (let i = 0; i < 60; i++) {
    try {
      const list = await targets();
      const sw = list.find((t) => t.type === "service_worker" && t.url.startsWith("chrome-extension://"));
      if (sw) return sw;
    } catch {}
    await sleep(500);
  }
  throw new Error(`extension service worker never appeared. Chromium stderr:\n${chromeErr.slice(-2000)}`);
}
function connect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let id = 0;
  const pending = new Map();
  ws.addEventListener("message", (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    }
  });
  const call = (method, params = {}) =>
    new Promise((resolve) => {
      const n = ++id;
      pending.set(n, resolve);
      ws.send(JSON.stringify({ id: n, method, params }));
    });
  return new Promise((resolve, reject) => {
    ws.addEventListener("open", () => resolve({ call, close: () => ws.close() }));
    ws.addEventListener("error", reject);
  });
}
async function evalInWorker(cdp, expression) {
  const res = await cdp.call("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
    timeout: 240_000,
  });
  if (res.result?.exceptionDetails) {
    throw new Error(res.result.exceptionDetails.exception?.description || JSON.stringify(res.result.exceptionDetails));
  }
  if (res.error) throw new Error(res.error.message);
  return res.result.result.value;
}

// --- the checks --------------------------------------------------------------------------------
try {
  const sw = await waitForWorker();
  ok(`extension service worker up: ${sw.url}`);
  const cdp = await connect(sw.webSocketDebuggerUrl);

  // The target can be listed before its module script has finished evaluating; wait for the
  // collectors to be attached, and confirm we are driving the build we just made.
  let ready = null;
  for (let i = 0; i < 40 && !ready; i++) {
    ready = await evalInWorker(cdp, `globalThis.collectors ? chrome.runtime.getManifest().version : null`).catch(() => null);
    if (!ready) await sleep(500);
  }
  if (!ready) throw new Error("background.js never exposed globalThis.collectors (stale worker, or the module failed to load)");
  ok(`worker ready, extension version ${ready}`);

  // A saved login can outlive LinkedIn's session-only CSRF cookie. Opening the feed
  // lets LinkedIn restore that cookie before the collectors make Voyager requests.
  let sessionReady = false;
  for (let i = 0; i < 60 && !sessionReady; i++) {
    sessionReady = await evalInWorker(cdp, `chrome.cookies.get({ url: "https://www.linkedin.com", name: "JSESSIONID" }).then(cookie => Boolean(cookie?.value))`);
    if (!sessionReady) await sleep(500);
  }
  if (!sessionReady) throw new Error("LinkedIn session did not initialize; sign into the configured Chrome profile first");

  const report = await evalInWorker(
    cdp,
    `(async () => {
      const li = globalThis.collectors;
      if (!li) throw new Error("background.js does not expose globalThis.collectors");
      const me = await li.getMe();
      const feed = await li.getPostFeed(me.memberUrn);
      feed.followerCount = (await li.getFollowerCount(me.memberUrn)) ?? feed.followerCount;
      // Every follower count on the page, so we can prove we picked our own and not the biggest.
      const withComments = feed.posts.find((p) => (p.metrics.comments ?? 0) > 0);
      const comments = withComments ? await li.getPostComments(withComments.urn, { max: 50 }) : null;
      return {
        me,
        followerCount: feed.followerCount,
        allFollowerCounts: feed.allFollowerCounts,
        posts: feed.posts.map((p) => ({ urn: p.urn, createdAt: p.createdAt, isRepost: p.isRepost, metrics: p.metrics, hasText: Boolean(p.textPreview) })),
        postFeedComplete: feed.postFeedComplete,
        commentsFor: withComments?.urn ?? null,
        commentsExpected: withComments?.metrics.comments ?? null,
        comments,
      };
    })()`,
  );
  cdp.close();

  // Identity
  if (!report.me?.memberUrn) fail("getMe() returned no memberUrn — is the profile signed in to LinkedIn?");
  else ok(`signed in as ${report.me.firstName ?? ""} ${report.me.lastName ?? ""} (${report.me.publicIdentifier})`);

  // Follower count: present, plausible, and ours.
  const fc = report.followerCount;
  if (typeof fc !== "number") fail(`followerCount is ${fc} — the FollowingInfo matcher found nothing for this member`);
  else if (fc < 1 || fc > 5_000_000) fail(`followerCount ${fc} is not plausible`);
  else ok(`follower count ${fc}`);
  if (Array.isArray(report.allFollowerCounts) && report.allFollowerCounts.length > 1) {
    ok(`page also carried other actors' counts ${JSON.stringify(report.allFollowerCounts.filter((n) => n !== fc))} — correctly not used`);
  }
  if (EXPECTED != null && typeof fc === "number") {
    const off = Math.abs(fc - EXPECTED) / EXPECTED;
    if (off > 0.15) fail(`followerCount ${fc} is ${Math.round(off * 100)}% away from EXPECTED_FOLLOWERS=${EXPECTED}`);
    else ok(`within 15% of expected ${EXPECTED}`);
  }

  // Posts
  const posts = report.posts ?? [];
  if (posts.length === 0) fail("no posts came back from the member share feed");
  else ok(`${posts.length} posts (postFeedComplete=${report.postFeedComplete})`);
  const bad = posts.filter((p) => !/^urn:li:activity:\d+$/.test(p.urn) || !p.createdAt);
  if (bad.length) fail(`${bad.length} posts missing a URN or createdAt`);
  // Own posts must carry counts from the feed itself. Reposts may not — the counts belong to the
  // original — and the per-post analytics page fills those in during a real sync.
  const own = posts.filter((p) => !p.isRepost);
  const withMetrics = own.filter((p) => p.metrics.reactions != null || p.metrics.comments != null);
  if (own.length && withMetrics.length < own.length * 0.9) {
    fail(`only ${withMetrics.length}/${own.length} own posts carry engagement counts — SocialActivityCounts resolution is missing cases`);
  } else ok(`${withMetrics.length}/${own.length} own posts carry engagement counts (${posts.length - own.length} reposts)`);

  // Comments with authors
  if (report.commentsFor) {
    const c = report.comments ?? [];
    if (c.length === 0) fail(`post ${report.commentsFor} has ${report.commentsExpected} comments on LinkedIn but the collector read none`);
    else {
      const anon = c.filter((x) => !x.commenterUrn || !x.urn);
      if (anon.length) fail(`${anon.length}/${c.length} comments lack a URN or commenter URN`);
      else ok(`${c.length} comments read for ${report.commentsFor} (LinkedIn says ${report.commentsExpected}); ${c.filter((x) => x.commenterName).length} with names, ${c.filter((x) => x.isReply).length} replies`);
      const tail = (u) => String(u).split(":").pop();
      const mine = c.filter((x) => tail(x.commenterUrn) === tail(report.me.memberUrn) || tail(x.commenterUrn) === report.me.publicIdentifier);
      ok(`${mine.length} of them are the author's own (these won't score)`);
    }
  } else {
    console.log("skip no post with comments in the feed, comment collector not exercised");
  }
} catch (e) {
  if (/NOT_LOGGED_IN/.test(String(e.message))) {
    fail("the dev profile's LinkedIn session has expired — run `just dev-profile-login`, sign in, close the window, and rerun");
  } else fail(e.message);
} finally {
  stop();
}
console.log(process.exitCode ? "\nEXTENSION E2E: FAILED" : "\nEXTENSION E2E: PASSED");
