#!/usr/bin/env node
// The signed-out get-started page, and the app's handling of a host block, in a real headless
// Chromium on a throwaway profile. No extension, no LinkedIn, nothing on port 3312.
//
// What it checks, against a debug server on a temporary database (SEED_DEMO for a system admin):
//
//   1. polling backs off: the page's extension hellos and /api/auth/me checks over 10 seconds,
//      1 minute and 10 minutes match server/components/poll-schedule.ts, nowhere near the old
//      every-3-seconds;
//   2. a hidden tab asks nothing at all, and asks straight away when it is visible again;
//   3. an extension reply saying "linked" is followed at once by a /api/auth/me check;
//   4. the three sign-in outcomes read differently: no invite link, an invite link the server
//      refused, and anything else (a generic error with a reason code that never mentions
//      invites), including an old (0.1.3) extension's ambiguous reply;
//   5. a host-blocked /api/auth/me reloads the page once, then shows the app-wide host notice
//      (with a Reload button) and stops polling;
//   6. host-blocked mutations, the password sign-in and the reported "Delete account" on the All
//      users page, show that notice instead of "Invalid email or password" or "could not be
//      deleted".
//
// Simulated, not real: the extension (an injected stand-in that answers hellos the way bridge.js
// does), hidden tabs (document.visibilityState overridden, and visibilitychange dispatched), time
// (the page's timers of a second or more run TIME_SCALE times faster), and the block itself
// (DevTools answers the request in the server's place with what Vercel sends: 403, text/html,
// `x-vercel-mitigated: challenge`). Requires chromium on PATH and `cargo build` in server/.
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import assert from "node:assert/strict";
import { ME_FALLBACK_MS, helloDelay } from "../server/components/poll-schedule.ts";

const ROOT = resolve(new URL("..", import.meta.url).pathname);
const SERVER_BIN = resolve(ROOT, "server/target/debug/linkedin-challenge-server");
const CHROME = process.env.CHROME || "chromium";
const TIME_SCALE = 200;
if (!existsSync(SERVER_BIN)) throw new Error(`no server binary at ${SERVER_BIN} — run \`cargo build\` in server/ first`);
const HOST_MESSAGE = readFileSync(resolve(ROOT, "server/components/host-block.tsx"), "utf8")
  .match(/HOST_BLOCKED_MESSAGE =\s*"([^"]+)"/)[1];

let passed = 0;
const check = (name, condition, detail = "") => {
  assert.ok(condition, `${name}${detail ? ` (${detail})` : ""}`);
  passed += 1;
  console.log("PASS:", name, detail ? `(${detail})` : "");
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const simulated = (ms) => sleep(ms / TIME_SCALE);

// --- a throwaway server and browser ----------------------------------------------------------
const tmp = mkdtempSync(resolve(tmpdir(), "signin-polling-"));
const env = { ...process.env, DATABASE_URL: `turso:${tmp}/test.db`, PORT: "0", SEED_DEMO: "1" };
delete env.DATABASE_URL_UNPOOLED;
const server = spawn(SERVER_BIN, [], {
  cwd: resolve(ROOT, "server"),
  env,
  stdio: ["ignore", "pipe", "pipe"],
});
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
const profile = resolve(tmp, "profile");
const chrome = spawn(
  CHROME,
  ["--headless=new", `--user-data-dir=${profile}`, "--remote-debugging-port=0", "--no-first-run",
    "--no-default-browser-check", "--disable-gpu", "--disable-extensions", "--window-size=1280,900", "about:blank"],
  { stdio: ["ignore", "ignore", "pipe"] },
);
let chromeErr = "";
chrome.stderr.on("data", (d) => (chromeErr += d));
const stop = () => {
  if (chrome.exitCode === null) chrome.kill("SIGTERM");
  if (server.exitCode === null) server.kill("SIGTERM");
  rmSync(tmp, { recursive: true, force: true });
};
process.on("exit", stop);

// --- CDP ---------------------------------------------------------------------------------------
async function devtoolsPort() {
  for (let i = 0; i < 100; i++) {
    try {
      return Number(readFileSync(resolve(profile, "DevToolsActivePort"), "utf8").split("\n")[0]);
    } catch {
      await sleep(100);
    }
  }
  throw new Error(`Chromium never opened DevTools:\n${chromeErr.slice(-2000)}`);
}
function connect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let id = 0;
  const pending = new Map();
  const listeners = new Map();
  ws.addEventListener("message", (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    } else if (msg.method) {
      for (const fn of listeners.get(msg.method) ?? []) fn(msg.params);
    }
  });
  const call = (method, params = {}) =>
    new Promise((res, rej) => {
      const n = ++id;
      pending.set(n, (msg) => (msg.error ? rej(new Error(`${method}: ${msg.error.message}`)) : res(msg.result)));
      ws.send(JSON.stringify({ id: n, method, params }));
    });
  const on = (method, fn) => listeners.set(method, [...(listeners.get(method) ?? []), fn]);
  return new Promise((res, rej) => {
    ws.addEventListener("open", () => res({ call, on, close: () => ws.close() }));
    ws.addEventListener("error", rej);
  });
}

// Before any page script: faster timers, a controllable visibility, a log of hellos and
// /api/auth/me requests in simulated milliseconds, and a stand-in for the extension's bridge.
const PRELUDE = `(() => {
  const SCALE = ${TIME_SCALE};
  const nativeTimeout = window.setTimeout.bind(window);
  window.setTimeout = (fn, ms, ...rest) => nativeTimeout(fn, (ms || 0) >= 1000 ? ms / SCALE : ms, ...rest);
  let visibility = "visible";
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => visibility });
  Object.defineProperty(document, "hidden", { configurable: true, get: () => visibility !== "visible" });
  window.__setVisibility = (v) => { visibility = v; document.dispatchEvent(new Event("visibilitychange")); };
  const t0 = performance.now();
  const now = () => (performance.now() - t0) * SCALE;
  window.__log = [];
  const nativeFetch = window.fetch.bind(window);
  window.fetch = (input, init) => {
    const url = typeof input === "string" ? input : input.url;
    if (url.includes("/api/auth/me")) window.__log.push(["me", now()]);
    return nativeFetch(input, init);
  };
  window.__reply = null;
  window.addEventListener("message", (event) => {
    if (event.data?.source !== "challenge-sync-page" || event.data.type !== "HELLO") return;
    window.__log.push(["hello", now()]);
    if (window.__reply) window.postMessage({ source: "challenge-sync-extension", ...window.__reply }, location.origin);
  });
})();`;

const port = await devtoolsPort();
const target = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find((t) => t.type === "page");
const page = await connect(target.webSocketDebuggerUrl);
await page.call("Page.enable");
await page.call("Page.addScriptToEvaluateOnNewDocument", { source: PRELUDE });

// Requests the "host" answers in the server's place: a predicate on { method, url }.
let blockRule = () => false;
const blockedRequests = [];
await page.call("Fetch.enable", { patterns: [{ urlPattern: "*/api/*", requestStage: "Request" }] });
page.on("Fetch.requestPaused", ({ requestId, request }) => {
  if (blockRule(request)) {
    blockedRequests.push(`${request.method} ${new URL(request.url).pathname}`);
    const body = Buffer.from("<!doctype html><title>Vercel Security Checkpoint</title>").toString("base64");
    page.call("Fetch.fulfillRequest", {
      requestId,
      responseCode: 403,
      responseHeaders: [
        { name: "content-type", value: "text/html; charset=utf-8" },
        { name: "x-vercel-mitigated", value: "challenge" },
      ],
      body,
    }).catch(() => {});
  } else {
    page.call("Fetch.continueRequest", { requestId }).catch(() => {});
  }
});
let navigations = 0;
page.on("Page.frameNavigated", ({ frame }) => {
  if (!frame.parentId) navigations += 1;
});

async function evaluate(expression) {
  const res = await page.call("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (res.exceptionDetails) throw new Error(res.exceptionDetails.exception?.description || JSON.stringify(res.exceptionDetails));
  return res.result.value;
}
async function until(expression, what, seconds = 10) {
  for (let i = 0; i < seconds * 20; i++) {
    const value = await evaluate(expression).catch(() => null);
    if (value) return value;
    await sleep(50);
  }
  throw new Error(`timed out waiting for ${what}`);
}
async function open(path) {
  await page.call("Page.navigate", { url: base + path });
  await until(`document.readyState === "complete" && Boolean(window.__log)`, `${path} to load`);
}
const log = () => evaluate("window.__log");
const count = (entries, kind, from = 0, to = Infinity) =>
  entries.filter(([k, t]) => k === kind && t >= from && t <= to).length;
const noticeText = () => evaluate(`[...document.querySelectorAll(".auth-card .notice")].map((n) => n.innerText).join(" | ")`);

// When the schedule says the hellos go out, in simulated milliseconds.
function expectedHellos(until) {
  let t = 0;
  let n = 1;
  for (let step = 0; ; step++) {
    t += helloDelay(step);
    if (t > until) return n;
    n += 1;
  }
}

try {
  // 1. Back-off, with no extension answering.
  await open("/auth/login");
  await simulated(10 * 60_000 + 10_000);
  let entries = await log();
  // Simulated time is counted from document start, and loading the app takes a good few
  // simulated seconds; the page's clock starts at its first hello. React Query's own useGetMe on
  // mount comes just before that, so /api/auth/me is counted from the start.
  const origin = entries.find(([k]) => k === "hello")?.[1] ?? 0;
  const rates = {};
  for (const [label, ms] of [["10s", 10_000], ["1min", 60_000], ["10min", 600_000]]) {
    const hellos = count(entries, "hello", 0, origin + ms);
    const me = count(entries, "me", 0, origin + ms);
    rates[label] = { hellos, me };
    const want = expectedHellos(ms);
    check(`hellos in the first ${label} follow the schedule`, Math.abs(hellos - want) <= 1, `${hellos}, schedule says ${want}; was ${Math.floor(ms / 3000) + 1}`);
    // The page's own check at open and then one per ME_FALLBACK_MS, plus React Query's one useGetMe on mount.
    const wantMe = 1 + Math.floor(ms / ME_FALLBACK_MS) + 1;
    check(`/api/auth/me requests in the first ${label} are the fallback only`, Math.abs(me - wantMe) <= 1, `${me}, expected ${wantMe}; was ${Math.floor(ms / 3000) + 1}`);
  }

  // 2. Hidden: nothing. Visible again: both, straight away.
  await evaluate(`window.__setVisibility("hidden")`);
  const hiddenAt = (await log()).length;
  await simulated(5 * 60_000);
  entries = await log();
  check("a hidden tab sends no hellos and no /api/auth/me for 5 minutes", entries.length === hiddenAt, `${entries.length - hiddenAt} sent`);
  await evaluate(`window.__setVisibility("visible")`);
  await sleep(30);
  entries = await log();
  const back = entries.slice(hiddenAt);
  check("coming back to the tab asks the extension and the site at once",
    count(back, "hello") >= 1 && count(back, "me") >= 1, JSON.stringify(back));
  rates.hidden = { hellos: 0, me: 0 };

  // 3. "Linked" from the extension: the site is asked right after the reply.
  await evaluate(`window.__reply = { linkedInSignedIn: true, linked: true, needsInvite: false, inviteRefused: false, error: null, errorCode: null }`);
  const linkedFrom = (await log()).length;
  await until(`window.__log.slice(${linkedFrom}).filter(([k]) => k === "hello").length >= 2`, "two more hellos", 10);
  entries = (await log()).slice(linkedFrom);
  const hellosAfter = entries.filter(([k]) => k === "hello");
  const followed = hellosAfter.every(([, t]) => entries.some(([k, u]) => k === "me" && u >= t && u - t < 1_500));
  check("each linked reply is followed straight away by a sign-in check", followed, JSON.stringify(entries));

  // 4. The three outcomes, as the page words them.
  const reply = async (r, { cookie = false } = {}) => {
    await evaluate(`document.cookie = "join_code=${cookie ? "some-code" : ""}; Path=/; Max-Age=${cookie ? 600 : 0}"`);
    await evaluate(`window.__reply = ${JSON.stringify(r)}; window.__setVisibility("hidden"); window.__setVisibility("visible")`);
    await sleep(100);
    return noticeText();
  };
  const base04 = { linkedInSignedIn: true, linked: false, needsInvite: false, inviteRefused: false, error: null, errorCode: null };
  let text = await reply({ ...base04, needsInvite: true });
  check("no join code: 'You need your company's invite link'", /You need your company.s invite link/.test(text) && !/valid|went wrong/.test(text), text);
  text = await reply({ ...base04, inviteRefused: true }, { cookie: true });
  check("a refused code: says this invite link isn't valid or was replaced", /invite link isn.t valid.*replaced by a newer one/.test(text) && !/You need|went wrong/.test(text), text);
  text = await reply({ ...base04, error: "Couldn't reach Challenge Sync just now. Trying again shortly.", errorCode: "blocked" }, { cookie: true });
  check("a blocked request: the generic error with its reason, no word of invites",
    /Something went wrong signing you in/.test(text) && /Reason: blocked/.test(text) && !/invite/i.test(text), text);
  text = await reply({ ...base04, error: "Server error (500).", errorCode: "http-500" }, { cookie: true });
  check("any other failure: the generic error with its status", /Something went wrong/.test(text) && /http-500/.test(text) && !/invite/i.test(text), text);
  const legacy = { linkedInSignedIn: true, linked: false, needsInvite: true, error: null }; // 0.1.3's bridge
  text = await reply(legacy, { cookie: true });
  check("0.1.3 saying needsInvite with a code in the browser: generic, not an invite message",
    /Something went wrong/.test(text) && /legacy-extension/.test(text) && !/invite/i.test(text), text);
  text = await reply(legacy, { cookie: false });
  check("0.1.3 saying needsInvite with no code: the invite-link message", /You need your company.s invite link/.test(text), text);

  // 5. The site's own check blocked: one reload, then the notice, then silence.
  await evaluate(`window.__reply = null`);
  const navigationsBefore = navigations;
  blockRule = (r) => new URL(r.url).pathname === "/api/auth/me";
  await evaluate(`window.__setVisibility("hidden"); window.__setVisibility("visible")`);
  await until(`document.body.innerText.includes(${JSON.stringify(HOST_MESSAGE)})`, "the host-block notice", 10);
  check("a blocked sign-in check reloads the page exactly once", navigations === navigationsBefore + 1, `${navigations - navigationsBefore} navigations`);
  check("then shows the host notice with a Reload button",
    await evaluate(`[...document.querySelectorAll(".host-blocked button")].some((b) => b.innerText === "Reload")`));
  const quietFrom = (await log()).length;
  await simulated(5 * 60_000);
  check("and stops polling", (await log()).length === quietFrom, `${(await log()).length - quietFrom} more`);
  blockRule = () => false;

  // 6. Blocked mutations say so, rather than each page's own failure text.
  await open("/auth/password");
  await until(`Boolean(document.getElementById("email") && document.getElementById("password"))`, "the password form");
  blockRule = (r) => r.method === "POST" && new URL(r.url).pathname === "/api/auth/login";
  await evaluate(`(() => {
    const set = (el, v) => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(el, v); el.dispatchEvent(new Event("input", { bubbles: true })); };
    set(document.getElementById("email"), "sysadmin@demo.test");
    set(document.getElementById("password"), "demopassword");
    document.querySelector("form").requestSubmit();
  })()`);
  text = await until(`document.querySelector(".auth-card .notice.err")?.innerText`, "the sign-in error", 10);
  check("a blocked password sign-in says the host paused requests, not 'Invalid email or password'",
    text === HOST_MESSAGE && !(await evaluate(`document.body.innerText.includes("Invalid email")`)), text);
  check("and the app-wide notice is up", await evaluate(`Boolean(document.querySelector(".host-blocked"))`));
  blockRule = () => false;

  // Signed in as the system admin for real, then the reported case: deleting an account.
  const signedIn = await evaluate(`fetch("/api/auth/login", { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "sysadmin@demo.test", password: "demopassword" }) }).then((r) => r.status)`);
  check("the system admin signs in when nothing is blocked", signedIn === 200);
  await open("/system");
  await until(`document.querySelectorAll(".menu-button").length > 0`, "the All users table", 15);
  const opened = await evaluate(`(async () => {
    for (const button of document.querySelectorAll(".menu-button")) {
      button.click();
      await new Promise((r) => setTimeout(r, 20));
      const item = [...document.querySelectorAll(".row-menu button")].find((b) => b.innerText.trim() === "Delete account");
      if (item) { item.click(); return true; }
      button.click();
    }
    return false;
  })()`);
  check("a member's menu offers Delete account", opened);
  blockRule = (r) => r.method === "DELETE" && new URL(r.url).pathname.startsWith("/api/system/members/");
  await until(`Boolean(document.querySelector(".modal.confirm"))`, "the confirm dialog");
  await evaluate(`[...document.querySelectorAll(".modal.confirm button")].find((b) => b.innerText.trim() === "Delete account").click()`);
  text = await until(`document.querySelector(".modal.confirm .notice.err")?.innerText`, "the dialog's error", 10);
  check("a blocked Delete account says the host paused requests, not 'could not be deleted'",
    text === HOST_MESSAGE && blockedRequests.some((r) => r.startsWith("DELETE /api/system/members/")), text);
  check("with the Reload button in the app-wide notice",
    await evaluate(`[...document.querySelectorAll(".host-blocked button")].some((b) => b.innerText === "Reload")`));

  console.log(JSON.stringify({ requestsBySimulatedTime: rates }));
} catch (err) {
  console.error(`FAIL: ${err.message}\nserver log tail:\n${serverLog.slice(-1500)}`);
  process.exitCode = 1;
} finally {
  page.close();
  stop();
}
if (!process.exitCode) console.log(JSON.stringify({ result: "PASS", checks: passed }));
