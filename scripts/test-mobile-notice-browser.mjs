#!/usr/bin/env node
// The "not available on mobile" notice (server/components/mobile-notice.tsx, chosen in
// server/app/layout.tsx by server/components/mobile.ts), in a headless Chromium on a throwaway
// profile against a debug server on a temporary database (SEED_DEMO). No extension, no LinkedIn,
// nothing on port 3312.
//
//   1. an Android phone (its user agent, Client Hints saying mobile, mobile emulation at 390px):
//      the sign-in page and a join link, signed out, show the notice and never the app shell;
//      /privacy shows the policy; signed in, / shows the notice, never mounts the shell, and asks
//      the API for nothing; a soft navigation from /privacy to / lands on the notice;
//   2. an iPhone (Safari's user agent and no Client Hints, as Safari sends none): / shows the
//      notice;
//   3. a desktop Chrome at 390px wide: / and the sign-in page render the app, and the notice never
//      appears, not even for a frame.
//
// "Never" is a MutationObserver installed before the page's scripts run, so a flash of the wrong
// one between React commits would be caught. MOBILE_NOTICE_SCREENSHOTS=<dir> also saves the
// phone's notice and /privacy as PNGs there.
//
// Requires chromium on PATH and `cargo build` in server/.
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import assert from "node:assert/strict";

const ROOT = resolve(new URL("..", import.meta.url).pathname);
const SERVER_BIN = resolve(ROOT, "server/target/debug/linkedin-challenge-server");
const CHROME = process.env.CHROME || "chromium";
const SHOTS = process.env.MOBILE_NOTICE_SCREENSHOTS;
if (!existsSync(SERVER_BIN)) throw new Error(`no server binary at ${SERVER_BIN} — run \`cargo build\` in server/ first`);

let passed = 0;
const check = (name, condition, detail = "") => {
  assert.ok(condition, `${name}${detail ? ` (${detail})` : ""}`);
  passed += 1;
  console.log("PASS:", name, detail ? `(${detail})` : "");
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- a throwaway server and browser ----------------------------------------------------------
const tmp = mkdtempSync(resolve(tmpdir(), "mobile-notice-browser-"));
const env = { ...process.env, DATABASE_URL: `turso:${tmp}/test.db`, PORT: "0", SEED_DEMO: "1" };
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
const profile = resolve(tmp, "profile");
const chrome = spawn(
  CHROME,
  ["--headless=new", `--user-data-dir=${profile}`, "--remote-debugging-port=0", "--no-first-run",
    "--no-default-browser-check", "--disable-extensions", "--window-size=1280,900", "about:blank"],
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

const port = await devtoolsPort();
const target = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find((t) => t.type === "page");
const page = await connect(target.webSocketDebuggerUrl);
await page.call("Page.enable");
await page.call("Network.enable");
const evaluate = async (expression) =>
  (await page.call("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true })).result.value;
async function waitFor(expression, what, ms = 15000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await evaluate(expression)) return;
    await sleep(50);
  }
  throw new Error(`timed out waiting for ${what}`);
}

// API requests the page makes, since the last navigation.
let apiCalls = [];
page.on("Network.requestWillBeSent", ({ request }) => {
  const path = new URL(request.url).pathname;
  if (path.startsWith("/api/")) apiCalls.push(path);
});

// Before any of the page's own scripts: remember whether the shell or the notice was ever in the
// document, however briefly.
await page.call("Page.addScriptToEvaluateOnNewDocument", {
  source: `window.__seen = { shell: false, notice: false };
    new MutationObserver(() => {
      if (document.querySelector(".shell")) window.__seen.shell = true;
      if (document.querySelector(".mobile-notice")) window.__seen.notice = true;
    }).observe(document, { childList: true, subtree: true });`,
});

const shown = `document.querySelector(".mobile-notice") || document.querySelector(".shell")`;
async function visit(path) {
  apiCalls = [];
  const loaded = new Promise((res) => page.on("Page.loadEventFired", res));
  await page.call("Page.navigate", { url: `${base}${path}` });
  await loaded;
  await waitFor(`!!(${shown})`, `the notice or the app on ${path}`);
  // A moment for any later commit (a lazy page, a query) that could still swap one for the other.
  await sleep(400);
  return evaluate(`({
    seen: window.__seen,
    notice: !!document.querySelector(".mobile-notice"),
    shell: !!document.querySelector(".shell"),
    h1: document.querySelector("h1")?.innerText ?? null,
    text: document.querySelector(".mobile-notice")?.innerText ?? null,
    path: location.pathname,
  })`);
}
async function screenshot(name) {
  if (!SHOTS) return;
  mkdirSync(SHOTS, { recursive: true });
  const { data } = await page.call("Page.captureScreenshot", { format: "png" });
  writeFileSync(resolve(SHOTS, name), Buffer.from(data, "base64"));
  console.log("screenshot:", resolve(SHOTS, name));
}

const HEADING = "Sorry, this isn’t available on mobile";
const LINE = "You need to use a desktop for this.";
const isNotice = (r) => r.notice && !r.shell && !r.seen.shell && r.h1 === HEADING && r.text.includes(LINE);
const isApp = (r) => r.shell && !r.notice && !r.seen.notice;
const describe = (r) => JSON.stringify(r);

async function signIn() {
  const login = await fetch(`${base}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "sysadmin@demo.test", password: "demopassword" }),
  });
  const session = login.headers.get("set-cookie")?.match(/session=([^;]+)/)?.[1];
  assert.ok(login.ok && session, `login failed: ${login.status}`);
  await page.call("Network.setCookie", { name: "session", value: session, url: base });
}
const signOut = () => page.call("Network.deleteCookies", { name: "session", url: base });

const brands = [{ brand: "Chromium", version: "131" }, { brand: "Google Chrome", version: "131" }];
async function emulate({ userAgent, metadata, width, height, mobile }) {
  await page.call("Emulation.setUserAgentOverride", { userAgent, ...(metadata ? { userAgentMetadata: metadata } : {}) });
  await page.call("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: mobile ? 3 : 1, mobile });
  await page.call("Emulation.setTouchEmulationEnabled", { enabled: mobile });
}

try {
  // 1. An Android phone.
  await emulate({
    userAgent: "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36",
    metadata: { brands, fullVersion: "131.0.0.0", platform: "Android", platformVersion: "14.0.0", architecture: "", model: "Pixel 8", mobile: true },
    width: 390, height: 844, mobile: true,
  });
  let r = await visit("/auth/login");
  check("the emulated Android phone reports itself as mobile", (await evaluate("navigator.userAgentData?.mobile")) === true);
  check("phone, signed out: the sign-in page is the notice, with no app shell", isNotice(r), describe(r));
  await screenshot("phone-notice.png");
  r = await visit("/join/not-a-real-code");
  check("phone, signed out: a join link is the notice", isNotice(r), describe(r));
  r = await visit("/privacy");
  check("phone, signed out: /privacy shows the policy, not the notice", r.h1 === "Privacy policy" && !r.notice && !r.seen.notice, describe(r));
  await screenshot("phone-privacy.png");

  await signIn();
  r = await visit("/");
  check("phone, signed in: / is the notice, with no app shell", isNotice(r), describe(r));
  check("and the hidden page asked the API for nothing", apiCalls.length === 0, apiCalls.join(", "));
  r = await visit("/privacy");
  check("phone, signed in: /privacy shows the policy", r.h1 === "Privacy policy" && !r.notice, describe(r));
  await evaluate(`document.querySelector('.sidebar a[href="/"]').click()`);
  await waitFor(`location.pathname === "/" && !!document.querySelector(".mobile-notice")`, "the notice after a soft navigation to /");
  check("a soft navigation from /privacy to / lands on the notice",
    (await evaluate(`!document.querySelector(".shell") && document.querySelector("h1")?.innerText`)) === HEADING);

  // 2. An iPhone: Safari sends no Client Hints, so the user agent string decides.
  await emulate({
    userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1",
    width: 390, height: 844, mobile: true,
  });
  const hide = await page.call("Page.addScriptToEvaluateOnNewDocument", {
    source: `Object.defineProperty(Navigator.prototype, "userAgentData", { get: () => undefined, configurable: true });`,
  });
  r = await visit("/");
  check("iPhone Safari: / is the notice", isNotice(r) && (await evaluate("navigator.userAgentData")) == null, describe(r));
  await page.call("Page.removeScriptToEvaluateOnNewDocument", { identifier: hide.identifier });

  // 3. A desktop Chrome in a window as narrow as a phone.
  await emulate({
    userAgent: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    metadata: { brands, fullVersion: "131.0.0.0", platform: "Linux", platformVersion: "", architecture: "x86", model: "", mobile: false },
    width: 390, height: 844, mobile: false,
  });
  check("the narrow desktop window really is narrow", (await evaluate("window.innerWidth")) === 390);
  r = await visit("/");
  check("desktop at 390px, signed in: / renders the app and never the notice", isApp(r), describe(r));
  await signOut();
  r = await visit("/auth/login");
  check("desktop at 390px, signed out: the sign-in page renders and never the notice", isApp(r) && r.path === "/auth/login", describe(r));

  console.log(JSON.stringify({ result: "PASS", checks: passed }));
} finally {
  page.close();
  stop();
}
process.exit(0);
