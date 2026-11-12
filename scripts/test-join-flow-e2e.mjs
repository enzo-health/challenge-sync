#!/usr/bin/env node
// End-to-end check of no-password sign-in in a REAL browser: a signed-out visitor opens the
// company join link, and the extension signs them in and syncs, with nothing typed.
//
// Starts a throwaway local server on an empty temporary database, launches Chromium headless on
// the repo's dev profile (`.chromium-dev-profile`, which holds a LinkedIn login) with the unpacked
// extension loaded, and drives a tab over the DevTools protocol:
//
//   1. the get-started page, with no join link opened, says an invite link is needed;
//   2. opening `/join/<code>` signs the site in as the LinkedIn member, by itself;
//   3. the extension's first sync lands that member's posts on the local server.
//
// Requires: chromium on PATH, `just extension-dev` already run (the build targets
// http://localhost:3312, so that port must be free), the server built (`cargo build`), and the dev
// profile signed in to LinkedIn (`just dev-profile-login`). LinkedIn data goes only to the local
// temporary server, which is deleted afterwards.

import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

const ROOT = resolve(new URL("..", import.meta.url).pathname);
const PROFILE = process.env.CHROME_PROFILE || resolve(ROOT, ".chromium-dev-profile");
const UNPACKED = resolve(ROOT, "extension/dist/unpacked");
const SERVER_BIN = resolve(ROOT, "server/target/debug/linkedin-challenge-server");
const CHROME = process.env.CHROME || "chromium";
const CDP_PORT = Number(process.env.CDP_PORT || 9334);
const SERVER = "http://localhost:3312";
const JOIN_CODE = "flow-e2e-code";

const ok = (msg) => console.log(`ok   ${msg}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (!existsSync(PROFILE)) throw new Error(`no Chrome profile at ${PROFILE}`);
if (!existsSync(SERVER_BIN)) throw new Error(`no server binary at ${SERVER_BIN} — run \`cargo build\` in server/ first`);
const manifestPath = resolve(UNPACKED, "manifest.json");
if (!existsSync(manifestPath)) throw new Error(`no unpacked extension at ${UNPACKED} — run \`just extension-dev\` first`);
if (!JSON.parse(readFileSync(manifestPath, "utf8")).host_permissions.includes(`${SERVER}/*`)) {
  throw new Error(`the unpacked extension is not built for ${SERVER} — run \`just extension-dev\``);
}
if (await fetch(`${SERVER}/api/health`).then(() => true, () => false)) {
  throw new Error(`something is already listening on ${SERVER}; stop it first`);
}

for (const f of ["SingletonLock", "SingletonSocket", "SingletonCookie"]) {
  rmSync(resolve(PROFILE, f), { force: true });
}
rmSync(resolve(PROFILE, "Default", "Service Worker"), { recursive: true, force: true });

const dbDir = mkdtempSync(resolve(tmpdir(), "join-flow-e2e-"));
const server = spawn(SERVER_BIN, [], {
  cwd: resolve(ROOT, "server"),
  env: { ...process.env, DATABASE_URL: `turso:${dbDir}/test.db`, PORT: "3312", JOIN_CODE },
  stdio: ["ignore", "pipe", "pipe"],
});
let serverLog = "";
server.stdout.on("data", (d) => (serverLog += d));
server.stderr.on("data", (d) => (serverLog += d));

const chrome = spawn(
  CHROME,
  [
    "--headless=new",
    `--user-data-dir=${PROFILE}`,
    `--load-extension=${UNPACKED}`,
    `--disable-extensions-except=${UNPACKED}`,
    `--remote-debugging-port=${CDP_PORT}`,
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
  if (!server.killed) server.kill("SIGTERM");
  rmSync(dbDir, { recursive: true, force: true });
};
process.on("exit", stop);

// --- CDP plumbing ------------------------------------------------------------------------------
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
    new Promise((res) => {
      const n = ++id;
      pending.set(n, res);
      ws.send(JSON.stringify({ id: n, method, params }));
    });
  return new Promise((res, rej) => {
    ws.addEventListener("open", () => res({ call, close: () => ws.close() }));
    ws.addEventListener("error", rej);
  });
}
async function evaluate(cdp, expression) {
  const res = await cdp.call("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true, timeout: 60_000 });
  if (res.result?.exceptionDetails) {
    throw new Error(res.result.exceptionDetails.exception?.description || JSON.stringify(res.result.exceptionDetails));
  }
  if (res.error) throw new Error(res.error.message);
  return res.result.result.value;
}
// Poll `expression` until it is truthy. A page mid-navigation throws; that just means "not yet".
async function until(cdp, expression, what, seconds) {
  for (let i = 0; i < seconds * 2; i++) {
    const value = await evaluate(cdp, expression).catch(() => null);
    if (value) return value;
    await sleep(500);
  }
  throw new Error(`timed out waiting for ${what}`);
}
async function waitForWorker() {
  for (let i = 0; i < 60; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json`)).json();
      const sw = list.find((t) => t.type === "service_worker" && t.url.startsWith("chrome-extension://"));
      if (sw) return sw;
    } catch {}
    await sleep(500);
  }
  throw new Error(`extension service worker never appeared. Chromium stderr:\n${chromeErr.slice(-2000)}`);
}

// Leave the profile as it was found: no local account, token, or cookie from this run.
const RESET = `(async () => {
  await chrome.storage.local.clear();
  for (const name of ["session", "join_code"]) await chrome.cookies.remove({ url: "${SERVER}", name });
  return true;
})()`;

let failed = false;
let worker = null;
try {
  for (let i = 0; i < 100; i++) {
    if (await fetch(`${SERVER}/api/health`).then((r) => r.ok, () => false)) break;
    if (server.exitCode !== null) throw new Error(`server exited:\n${serverLog.slice(-2000)}`);
    await sleep(200);
  }
  ok("local server up on an empty temporary database");

  worker = await connect((await waitForWorker()).webSocketDebuggerUrl);
  await until(worker, `globalThis.collectors ? chrome.runtime.getManifest().version : null`, "the extension worker", 20);
  await until(
    worker,
    `chrome.cookies.get({ url: "https://www.linkedin.com", name: "JSESSIONID" }).then(c => Boolean(c?.value))`,
    "the LinkedIn session (sign in with `just dev-profile-login`)",
    30,
  );
  await evaluate(worker, RESET);
  ok("extension loaded, LinkedIn session present, starting signed out");

  const target = await (
    await fetch(`http://127.0.0.1:${CDP_PORT}/json/new?${encodeURIComponent(`${SERVER}/auth/login`)}`, { method: "PUT" })
  ).json();
  const page = await connect(target.webSocketDebuggerUrl);

  // 1. Without the join link: the page sees the extension and LinkedIn, and asks for the link.
  await until(page, `document.body.innerText.includes("invite link") && document.querySelectorAll(".start-step.done").length === 2`,
    "the get-started page to report both steps done and ask for an invite link", 40);
  const signedInEarly = await evaluate(page, `fetch("/api/auth/me").then(r => r.json()).then(me => me.signedIn)`);
  if (signedInEarly) throw new Error("signed in without ever opening the join link");
  ok("get-started page detects the extension and LinkedIn, and asks for the invite link");

  // 2. Open the join link: signed in with nothing typed.
  await page.call("Page.navigate", { url: `${SERVER}/join/${JOIN_CODE}` });
  const me = await until(page, `fetch("/api/auth/me").then(r => r.json()).then(me => me.signedIn ? me : null)`,
    "the site to be signed in after opening the join link", 90);
  if (!me.displayName) throw new Error("signed in, but with no display name");
  ok(`opening the join link signed the site in as ${me.displayName}`);
  await until(page, `location.pathname !== "/join/${JOIN_CODE}" && !location.pathname.startsWith("/auth/")`,
    "the page to leave the join link for the app", 30);
  ok("the page moved on to the app by itself");

  // 3. The first sync runs unattended and lands on the local server.
  const status = await until(
    worker,
    `chrome.storage.local.get("syncToken").then(({ syncToken }) => syncToken
        ? fetch("${SERVER}/api/me/sync-status", { headers: { authorization: "Bearer " + syncToken } })
            .then(r => r.json()).then(s => s.postsCount > 0 ? s : null)
        : null)`,
    "the first sync to store posts", 240,
  );
  if (!status.linked) throw new Error("posts synced, but the account is not marked linked");
  ok(`first sync stored ${status.postsCount} posts for the new account`);
} catch (err) {
  failed = true;
  console.error(`FAIL: ${err.message}`);
  if (serverLog) console.error(`server log tail:\n${serverLog.slice(-1500)}`);
} finally {
  if (worker) await evaluate(worker, RESET).catch(() => {});
  stop();
}

console.log(failed ? "\nJOIN FLOW E2E: FAILED" : "\nJOIN FLOW E2E: PASSED");
process.exit(failed ? 1 : 0);
