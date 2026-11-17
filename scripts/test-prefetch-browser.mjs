#!/usr/bin/env node
// The busiest pages' prefetch.rs seeds are really consumed, in a headless Chromium on a throwaway
// profile against a debug server on a temporary database (SEED_DEMO, signed in as its system
// admin). No extension, no LinkedIn, nothing on port 3312.
//
//   1. a first visit, before the shell has written the `tz` cookie, fetches the Overview's stats
//      (only those: /api/auth/me and /api/challenges were seeded); after it,
//   2. a hard load of /, /me, /challenges and /reports renders its content while requesting none
//      of the API endpoints its prefetch.rs seeds (server/scripts/test-prefetch-e2e.py checks the
//      seeds themselves): the cache was filled from the page's __nx_seeds__ tag under the keys
//      the hooks ask for, including the ones keyed by the `tz` cookie the shell writes;
//   3. a soft navigation to a seeded page gets its data from /__nx/prefetch and requests none of
//      that page's endpoints either.
//
// Requires chromium on PATH and `cargo build` in server/.
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import assert from "node:assert/strict";

const ROOT = resolve(new URL("..", import.meta.url).pathname);
const SERVER_BIN = resolve(ROOT, "server/target/debug/linkedin-challenge-server");
const CHROME = process.env.CHROME || "chromium";
if (!existsSync(SERVER_BIN)) throw new Error(`no server binary at ${SERVER_BIN} — run \`cargo build\` in server/ first`);

let passed = 0;
const check = (name, condition, detail = "") => {
  assert.ok(condition, `${name}${detail ? ` (${detail})` : ""}`);
  passed += 1;
  console.log("PASS:", name, detail ? `(${detail})` : "");
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- a throwaway server and browser ----------------------------------------------------------
const tmp = mkdtempSync(resolve(tmpdir(), "prefetch-browser-"));
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

const port = await devtoolsPort();
const target = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find((t) => t.type === "page");
const page = await connect(target.webSocketDebuggerUrl);
await page.call("Page.enable");
await page.call("Network.enable");

// Every request the page makes to our API or the prefetch endpoint, by path (+ query).
let requests = [];
page.on("Network.requestWillBeSent", ({ request }) => {
  const url = new URL(request.url);
  if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/__nx/prefetch")) {
    requests.push(url.pathname + url.search);
  }
});
const evaluate = async (expression) =>
  (await page.call("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true })).result.value;
async function waitFor(expression, what, ms = 8000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await evaluate(expression)) return;
    await sleep(50);
  }
  throw new Error(`timed out waiting for ${what}; requests: ${requests.join(", ")}`);
}
async function hardLoad(path) {
  requests = [];
  const loaded = new Promise((res) => page.on("Page.loadEventFired", res));
  await page.call("Page.navigate", { url: base + path });
  await loaded;
}

// Signed in as the demo system admin, through the browser's own cookie jar.
const login = await fetch(`${base}/api/auth/login`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ email: "sysadmin@demo.test", password: "demopassword" }),
});
const session = login.headers.get("set-cookie")?.match(/session=([^;]+)/)?.[1];
assert.ok(login.ok && session, `login failed: ${login.status}`);
await page.call("Network.setCookie", { name: "session", value: session, url: base });

try {
  // The first load writes the tz cookie; the time-zone keyed seeds need it from then on.
  // That first load had no cookie, so it fetched its stats: which also shows requests are seen.
  await hardLoad("/");
  await waitFor(`document.cookie.includes("tz=")`, "the tz cookie");
  await waitFor(`!!document.querySelector(".stats h1")`, "/ to render");
  check("first load, no tz cookie yet: / fetched its stats, and only those",
    requests.some((r) => r.startsWith("/api/stats/overview?")) &&
      !requests.some((r) => r === "/api/auth/me" || r === "/api/challenges"),
    `requested: ${requests.join(", ") || "nothing"}`);

  // Each page: what proves it rendered with its data, and the endpoints its prefetch.rs seeds.
  const pages = [
    ["/", `!!document.querySelector(".stats h1")`, ["/api/auth/me", "/api/challenges", "/api/stats/overview"]],
    ["/me", `!!document.querySelector(".who h1")`, ["/api/auth/me", "/api/challenges", "/api/me/posts"]],
    ["/challenges", `[...document.querySelectorAll("h1")].some((h) => h.innerText === "Challenges")`,
      ["/api/auth/me", "/api/challenges"]],
    ["/reports", `!!document.querySelector("h1") && document.body.innerText.includes("API keys")`,
      ["/api/auth/me", "/api/challenges", "/api/v1/posts", "/api/system/api-keys"]],
  ];
  for (const [path, rendered, seeded] of pages) {
    await hardLoad(path);
    await waitFor(rendered, `${path} to render`);
    // Let anything the first render kicked off reach the network.
    await sleep(500);
    const hit = requests.filter((r) => seeded.some((endpoint) => r.split("?")[0] === endpoint));
    check(`hard load ${path}: rendered from the seeds, none of ${seeded.join(", ")} fetched`, hit.length === 0,
      `requested: ${requests.join(", ") || "nothing"}`);
  }

  // Soft navigation from / to /me through the sidebar: the data arrives via /__nx/prefetch.
  await hardLoad("/");
  await waitFor(`!!document.querySelector(".stats h1")`, "/ to render");
  await sleep(300);
  requests = [];
  await evaluate(`document.querySelector('.side-nav a[href="/me"]').click()`);
  await waitFor(`!!document.querySelector(".who h1")`, "/me to render after the click");
  await sleep(500);
  check("soft nav / -> /me: data came from /__nx/prefetch",
    requests.some((r) => r.startsWith("/__nx/prefetch?path=%2Fme")) && !requests.includes("/api/me/posts") &&
      !requests.some((r) => r.startsWith("/api/me/posts")),
    `requested: ${requests.join(", ") || "nothing"}`);

  console.log(JSON.stringify({ result: "PASS", checks: passed }));
} finally {
  page.close();
  stop();
}
process.exit(0);
