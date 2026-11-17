#!/usr/bin/env node
// The weekly lottery page's controls, in a headless Chromium on a throwaway profile against a debug
// server on a temporary database (SEED_DEMO, signed in as its system admin). The lottery API is
// answered by the test with a fixed week, so nothing depends on what is in the database; reduced
// motion is emulated so a spin takes about a second.
//
//   1. ready: one Spin button and no Reset;
//   2. a double click on Spin draws once (drawWinnerIndex is the only crypto draw on the page);
//   3. after the win there is no spin button at all, only a small Reset;
//   4. Reset brings Spin back, and only then can a second draw happen; a held Enter key (repeated
//      keydowns) on Spin draws once too;
//   5. a poster excluded from the draw is named in "Not in the draw", and is not in the draw list.
//
// Requires chromium on PATH and `cargo build` in server/. Software WebGL is asked for; without it
// the page uses its text-only draw, which has the same controls (the output says which ran).
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
const tmp = mkdtempSync(resolve(tmpdir(), "lottery-browser-"));
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
    "--no-default-browser-check", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--disable-extensions",
    "--window-size=1280,900", "about:blank"],
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

// A fixed week: five entrants, two who didn't post, and one poster excluded from the draw.
const person = (memberId, displayName) => ({ memberId, displayName });
const week = {
  weekStart: "2026-11-09", weekEnd: "2026-11-16", startsAt: "2026-11-09T00:00:00-07:00",
  endsAt: "2026-11-16T00:00:00-07:00", timezone: "America/Denver", isComplete: true,
  previousWeek: "2026-11-02", nextWeek: "2026-11-16",
  entrants: ["Ada One", "Ben Two", "Cy Three", "Di Four", "Ed Five"].map((n, i) => ({ ...person(101 + i, n), postCount: 1 + i })),
  audience: [
    { ...person(201, "Olive Organiser"), excluded: true },
    { ...person(202, "Pat Quiet"), excluded: false },
    { ...person(203, "Quin Quiet"), excluded: false },
  ],
};
await page.call("Fetch.enable", { patterns: [{ urlPattern: "*/api/admin/lottery*" }] });
page.on("Fetch.requestPaused", ({ requestId }) =>
  page.call("Fetch.fulfillRequest", {
    requestId,
    responseCode: 200,
    responseHeaders: [{ name: "content-type", value: "application/json" }],
    body: Buffer.from(JSON.stringify(week)).toString("base64"),
  }));
// Count the draws: drawWinnerIndex asks crypto for one 32-bit word per attempt.
await page.call("Page.addScriptToEvaluateOnNewDocument", {
  source: `window.__draws = 0;
    const real = crypto.getRandomValues.bind(crypto);
    crypto.getRandomValues = (buf) => { if (buf instanceof Uint32Array && buf.length === 1) window.__draws++; return real(buf); };`,
});
await page.call("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });

// Signed in as the demo system admin, through the browser's own cookie jar.
const login = await fetch(`${base}/api/auth/login`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ email: "sysadmin@demo.test", password: "demopassword" }),
});
const session = login.headers.get("set-cookie")?.match(/session=([^;]+)/)?.[1];
assert.ok(login.ok && session, `login failed: ${login.status}`);
await page.call("Network.setCookie", { name: "session", value: session, url: base });

const buttons = `[...document.querySelectorAll(".lottery-controls button")].map((b) => b.className + "|" + b.innerText.trim())`;
const won = `!!document.querySelector(".lottery-reset")`;
const ready = `!!document.querySelector(".lottery-go") && !document.querySelector(".lottery-go").disabled`;

try {
  const loaded = new Promise((res) => page.on("Page.loadEventFired", res));
  await page.call("Page.navigate", { url: `${base}/admin/lottery` });
  await loaded;
  await waitFor(ready, "the Spin button");
  // Give the lazy 3D stage a moment to mount (or fail over to the text-only draw).
  await waitFor(`!!document.querySelector(".lottery-canvas canvas") || !!document.querySelector(".lottery-fallback")`, "the stage or its fallback");
  const stage = (await evaluate(`!!document.querySelector(".lottery-canvas canvas")`)) ? "3D stage" : "text-only fallback";

  // 5. Exclusions, as the page shows them.
  const notInDraw = await evaluate(`document.querySelector(".lottery-excluded")?.innerText ?? ""`);
  check("an excluded poster is named on its own line", notInDraw === "Not in the draw: Olive Organiser", notInDraw);
  const drawList = await evaluate(`[...document.querySelectorAll(".lottery-list:not(.audience) li .who-name")].map((e) => e.innerText)`);
  check("and is not in the draw list", drawList.length === 5 && !drawList.includes("Olive Organiser"), drawList.join(", "));
  const quiet = await evaluate(`document.querySelector(".lottery-list.audience")?.innerText ?? ""`);
  check("nor among those who didn't post", quiet.includes("(2)") && !quiet.includes("Olive"), quiet.replace(/\n/g, " "));

  // 1. Ready.
  let now = await evaluate(buttons);
  check("ready: one Spin button and no Reset", now.length === 1 && now[0].includes("lottery-go") && now[0].endsWith("|Spin the wheel"),
    `${stage}; ${now.join(", ")}`);
  check("nothing was drawn on load", (await evaluate("window.__draws")) === 0);

  // 2. A double click: two clicks before React can re-render.
  await evaluate(`(() => { const b = document.querySelector(".lottery-go"); b.click(); b.click(); })()`);
  await waitFor(won, "the first result");
  check("a double click on Spin draws once", (await evaluate("window.__draws")) === 1, `draws: ${await evaluate("window.__draws")}`);

  // 3. After the win.
  now = await evaluate(buttons);
  check("after a win there is no spin button anywhere, only Reset",
    now.length === 1 && now[0].includes("lottery-reset") && now[0].endsWith("|Reset") &&
      (await evaluate(`document.querySelectorAll(".lottery-go").length`)) === 0,
    now.join(", "));
  check("Reset is not a primary button", !now[0].includes("lottery-go"));
  check("the winner is announced", (await evaluate(`document.querySelector('[role="status"]').innerText`)).startsWith("The winner is "));

  // 4. Reset, then a held Enter key on Spin.
  await evaluate(`document.querySelector(".lottery-reset").click()`);
  await waitFor(ready, "Spin to come back after Reset");
  now = await evaluate(buttons);
  check("Reset brings back Spin, and only Spin", now.length === 1 && now[0].endsWith("|Spin the wheel"), now.join(", "));
  check("Reset itself draws nothing", (await evaluate("window.__draws")) === 1);
  await evaluate(`document.querySelector(".lottery-go").focus()`);
  const enter = { key: "Enter", code: "Enter", text: "\r", unmodifiedText: "\r", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 };
  await page.call("Input.dispatchKeyEvent", { type: "keyDown", ...enter });
  for (let i = 0; i < 3; i++) await page.call("Input.dispatchKeyEvent", { type: "keyDown", autoRepeat: true, ...enter });
  await page.call("Input.dispatchKeyEvent", { type: "keyUp", ...enter });
  await waitFor(won, "the second result");
  check("a held Enter key on Spin draws once more, not once per repeat", (await evaluate("window.__draws")) === 2,
    `draws: ${await evaluate("window.__draws")}`);
  check("and again only Reset is offered", (await evaluate(`document.querySelectorAll(".lottery-go").length`)) === 0);

  console.log(JSON.stringify({ result: "PASS", checks: passed, stage }));
} finally {
  page.close();
  stop();
}
process.exit(0);
