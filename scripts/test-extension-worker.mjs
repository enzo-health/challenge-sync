#!/usr/bin/env node
// The extension's service worker (extension/background.js) under plain node, with stand-ins for
// the chrome.* APIs it touches and for the network. No browser, no server, no LinkedIn; well under
// a second.
//
// What it checks:
//
//   1. a worker start with no sync alarm creates one, and a start that finds one leaves it alone
//      (the alarm used to be armed only in onInstalled/onStartup; see docs/extension-first-auth.md);
//   2. hellos from the site to an already-linked extension whose automatic sync is due start
//      exactly one UNATTENDED sync between them, however many arrive at once; a hello while it
//      runs, or soon after one failed, starts no other; a sync that is not due is not started;
//   3. the popup's STATUS does the same;
//   4. every failure category in extension/errors.js has its own code and message, and none but
//      the server's coded invite refusal mentions invites.
import assert from "node:assert/strict";

let passed = 0;
const check = (name, condition, detail = "") => {
  assert.ok(condition, `${name}${detail ? ` (${detail})` : ""}`);
  passed += 1;
  console.log("PASS:", name, detail ? `(${detail})` : "");
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- chrome.* stand-ins ----------------------------------------------------------------------
const storage = new Map();
const alarms = new Map();
const alarmCalls = { create: 0, clear: 0 };
const listeners = { message: [], installed: [], startup: [], alarm: [] };
const event = (list) => ({ addListener: (fn) => list.push(fn) });
const cookieJar = new Map(); // `${url} ${name}` -> value
globalThis.chrome = {
  runtime: { onMessage: event(listeners.message), onInstalled: event(listeners.installed), onStartup: event(listeners.startup) },
  alarms: {
    async get(name) {
      return alarms.get(name);
    },
    create(name, info) {
      alarmCalls.create += 1;
      alarms.set(name, { name, ...info });
    },
    async clear(name) {
      alarmCalls.clear += 1;
      return alarms.delete(name);
    },
    onAlarm: event(listeners.alarm),
  },
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
      const value = cookieJar.get(`${new URL(url).origin} ${name}`);
      return value ? { name, value } : null;
    },
    async set({ url, name, value }) {
      cookieJar.set(`${new URL(url).origin} ${name}`, value);
    },
  },
  tabs: { async create() {} },
};

// --- the network: LinkedIn answers slowly with a 500 (so a sync runs for a moment, then fails);
// our server answers 500 to anything (only the popup's account-wide numbers ask it here).
const linkedInRequests = [];
const serverRequests = [];
globalThis.fetch = async (input) => {
  const url = typeof input === "string" ? input : input.url;
  if (url.startsWith("https://www.linkedin.com/")) {
    linkedInRequests.push(new URL(url).pathname);
    await sleep(80);
    return new Response("{}", { status: 500, headers: { "content-type": "application/json" } });
  }
  serverRequests.push(url);
  return new Response(JSON.stringify({ error: "not expected in this test" }), { status: 500 });
};
const meRequests = () => linkedInRequests.filter((p) => p.endsWith("/voyager/api/me")).length;

const { SERVER_URL, SESSION_COOKIE } = await import("../extension/config.js");
const send = (msg) =>
  new Promise((resolve) => {
    for (const fn of listeners.message) fn(msg, {}, resolve);
  });

try {
  // 1. The alarm, on a worker start.
  const worker = await import("../extension/background.js?start=1");
  await globalThis.alarmChecked;
  check("a worker start with no alarm creates the sync alarm",
    alarms.has("challenge-sync") && alarmCalls.create === 1 && alarms.get("challenge-sync").periodInMinutes > 0);
  const armed = alarms.get("challenge-sync");
  listeners.message.length = 0; // the second start below registers its own
  await import("../extension/background.js?start=2");
  await globalThis.alarmChecked;
  check("a worker start that finds the alarm leaves it alone",
    alarmCalls.create === 1 && alarmCalls.clear === 0 && alarms.get("challenge-sync") === armed);
  check("ensureAlarm reports no change when the alarm exists", (await worker.ensureAlarm()) === false);

  // 2. A linked extension, never synced (so an automatic sync is due), signed in to LinkedIn and
  // to the site (so a hello needs no request to our server).
  storage.set("syncToken", "device-token");
  cookieJar.set("https://www.linkedin.com JSESSIONID", '"ajax:1"');
  cookieJar.set(`${new URL(SERVER_URL).origin} ${SESSION_COOKIE}`, "site-session");
  const replies = await Promise.all([1, 2, 3, 4, 5].map(() => send({ type: "PAGE_HELLO", signedIn: true })));
  check("five hellos at once all report a sync running", replies.every((r) => r.sync === "running" && r.linked), JSON.stringify(replies.map((r) => r.sync)));
  await sleep(20);
  check("and exactly one sync started between them", meRequests() === 1, `${meRequests()} LinkedIn /me reads`);
  check("a signed-in page's hello asks our server nothing", serverRequests.length === 0, serverRequests.join(", "));
  const during = await send({ type: "PAGE_HELLO", signedIn: true });
  check("a hello while it runs reports it running and starts no other", during.sync === "running" && meRequests() === 1);
  await sleep(200);
  const state = Object.fromEntries(storage);
  check("the sync was the unattended kind and its LinkedIn failure is recorded with a code",
    state.lastErrorCode === "linkedin-500" && /LinkedIn answered 500/.test(state.lastError) && !state.lastSyncAt, `${state.lastErrorCode}: ${state.lastError}`);
  const after = await send({ type: "PAGE_HELLO", signedIn: true });
  check("a hello soon after a failed one starts no other",
    after.sync === "recently-tried" && meRequests() === 1 && after.syncErrorCode === "linkedin-500", after.sync);

  // 3. The popup, once the retry gap has passed.
  storage.set("lastKickedSyncAt", new Date(Date.now() - 16 * 60_000).toISOString());
  const status = await send({ type: "STATUS" });
  await sleep(20);
  check("opening the popup starts a due automatic sync too", status.sync === "running" && meRequests() === 2, status.sync);
  await sleep(200);

  // Not due: synced an hour ago.
  storage.set("lastSyncAt", new Date(Date.now() - 60 * 60_000).toISOString());
  storage.set("lastKickedSyncAt", null);
  const notDue = await send({ type: "PAGE_HELLO", signedIn: true });
  await sleep(20);
  check("a hello when the last sync is recent starts nothing", notDue.sync === "not-due" && meRequests() === 2, notDue.sync);

  // 4. The failure categories.
  const errors = await import("../extension/errors.js");
  const { describeError, ServerError, ServerUnreachableError, BlockedError, LinkedInError, ExtensionStateError } = errors;
  const cases = [
    ["unreachable", new ServerUnreachableError(), /Can't reach the Challenge Sync server/],
    ["timeout", new ServerUnreachableError({ timeout: true }), /didn't answer in time/],
    ["blocked", new BlockedError(), /host blocked this request/],
    ["server-500", new ServerError({ status: 500, contentType: "application/json", serverMessage: "database error" }), /server had a problem \(500\)/],
    ["server-502", new ServerError({ status: 502, contentType: "text/html" }), /server had a problem \(502\)/],
    ["account_deleted", new ServerError({ status: 403, code: "account_deleted" }), /has been removed/],
    ["sync_token_rejected", new ServerError({ status: 401, code: "sync_token_rejected" }), /no longer accepts this browser/],
    ["session_expired", new ServerError({ status: 401, code: "session_expired" }), /sign-in has expired/],
    ["admin_use_password", new ServerError({ status: 403, code: "admin_use_password" }), /Admins sign in with their email and password/],
    ["impersonation_session", new ServerError({ status: 403, code: "impersonation_session" }), /viewing the Challenge Sync site as someone else/],
    ["unexpected-403", new ServerError({ status: 403, contentType: "application/json", serverMessage: "nope" }), /^Unexpected response from the server \(status 403, application\/json\)\.$/],
    ["unexpected-403", new ServerError({ status: 403, code: "some_future_code" }), /status 403.*some_future_code/],
    ["linkedin-signed-out", new LinkedInError("signed-out"), /not logged in to LinkedIn/],
    ["linkedin-999", new LinkedInError("http", { status: 999 }), /LinkedIn answered 999/],
    ["linkedin-unreachable", new LinkedInError("unreachable"), /Can't reach LinkedIn/],
    ["linkedin-profile", new LinkedInError("profile"), /without your profile/],
    ["not-linked", new ExtensionStateError("not-linked", "This browser isn't connected to Challenge Sync yet."), /isn't connected/],
    ["extension-error", new Error("x is not a function"), /internal error: x is not a function/],
  ];
  for (const [code, err, text] of cases) {
    const d = describeError(err);
    check(`category ${code}: its own code and message, no invite text`,
      d.code === code && text.test(d.message) && !/invite/i.test(d.message) && !/^(Error|Something went wrong)/.test(d.message), `${d.code}: ${d.message}`);
  }
  const refused = describeError(new ServerError({ status: 403, code: "join_code_invalid" }));
  check("only the server's join_code_invalid reads as an invalid invite link",
    refused.code === "join_code_invalid" && /invite link isn't valid/.test(refused.message), refused.message);
} catch (err) {
  console.error(`FAIL: ${err.stack || err.message}`);
  process.exitCode = 1;
}
if (!process.exitCode) console.log(JSON.stringify({ result: "PASS", checks: passed }));
process.exit(process.exitCode ?? 0);
