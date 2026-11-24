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
//   5. a poster excluded from the draw is named in "Not in the draw", and is not in the draw list;
//   6. All users (/system): a user's menu has "Exclude from lottery", which marks the row with a
//      badge and stores the flag (read back from /api/system/overview), then reads "Include in
//      lottery" and undoes it; a deleted account's menu does not offer it.
//   7. the period: with no parameters the page asks the API for none and names the week it got
//      ("Fri 13 Nov – Thu 19 Nov"), with Previous/Next; a link with ?from=&to= asks the API for that
//      range, shows its people, labels it "custom range" with its dates and "in progress", has no
//      Previous/Next, and words the lists and the result "in this range"; "Back to the weekly
//      draw" drops the range from the URL; "Custom range…" with two dates and Apply puts them in
//      the URL and asks the API for them.
//   8. presenting: the page's Present link carries the period shown (week or range) and Copy link
//      copies its absolute URL, or says what failed and shows it; /admin/lottery/present (from
//      Present, or loaded with no parameters, ?week= or ?from=&to=) has no shell, banners, week
//      picker or lists and no page scroll, names the period, draws once per Reset with the winner
//      banner, and Exit goes back with the period; signed out it goes to sign-in, and a member who
//      is not an admin is turned away exactly as from /admin/lottery.
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
  firstDay: "2026-11-13", lastDay: "2026-11-19", startsAt: "2026-11-13T00:00:00-07:00",
  endsAt: "2026-11-20T00:00:00-07:00", timezone: "America/Denver", isComplete: true, isCustomRange: false,
  previousWeek: "2026-11-06", nextWeek: "2026-11-20",
  entrants: ["Ada One", "Ben Two", "Cy Three", "Di Four", "Ed Five"].map((n, i) => ({ ...person(101 + i, n), postCount: 1 + i })),
  audience: [
    { ...person(201, "Olive Organiser"), excluded: true },
    { ...person(202, "Pat Quiet"), excluded: false },
    { ...person(203, "Quin Quiet"), excluded: false },
  ],
};
// A custom range, Mon 16 to Fri 20 Nov, still in progress, with its own people.
const range = {
  firstDay: "2026-11-16", lastDay: "2026-11-20", startsAt: "2026-11-16T00:00:00-07:00",
  endsAt: "2026-11-21T00:00:00-07:00", timezone: "America/Denver", isComplete: false, isCustomRange: true,
  previousWeek: null, nextWeek: null,
  entrants: [{ ...person(301, "Rae Range"), postCount: 2 }, { ...person(302, "Sam Span"), postCount: 1 }],
  audience: [{ ...person(303, "Tia Idle"), excluded: false }],
};
// Every query string the page sent to GET /api/admin/lottery, in order ("" for none).
const asked = [];
await page.call("Fetch.enable", { patterns: [{ urlPattern: "*/api/admin/lottery*" }] });
// Only the period itself (GET /api/admin/lottery[?week= | ?from=&to=]); the exclusions route under
// it is real. A request with from/to gets the range, anything else the week.
page.on("Fetch.requestPaused", ({ requestId, request }) => {
  const url = new URL(request.url);
  if (url.pathname !== "/api/admin/lottery") return page.call("Fetch.continueRequest", { requestId });
  asked.push(url.search);
  return page.call("Fetch.fulfillRequest", {
    requestId,
    responseCode: 200,
    responseHeaders: [{ name: "content-type", value: "application/json" }],
    body: Buffer.from(JSON.stringify(url.searchParams.has("from") ? range : week)).toString("base64"),
  });
});
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

  // 7a. The default: no parameters asked for, the week's dates named.
  const periodLabel = `document.querySelector(".lottery-week-label")?.innerText.replace(/\\s+/g, " ").trim() ?? ""`;
  check("with no parameters the page asks the API for none", asked.length >= 1 && asked.every((q) => q === ""), JSON.stringify(asked));
  const weekLabel = await evaluate(periodLabel);
  check("the page names the Friday-to-Thursday week it shows", /^Fri 13 Nov – Thu 19 Nov( 2026)?, Mountain time$/.test(weekLabel), weekLabel);
  const weekButtons = `[...document.querySelectorAll(".lottery-week button")].map((b) => b.innerText.trim())`;
  const weekBar = await evaluate(weekButtons);
  check("a week has Previous, Next and Custom range…",
    weekBar.includes("← Previous") && weekBar.includes("Next →") && weekBar.includes("Custom range…"), weekBar.join(", "));

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

  // 7b. A custom range from a link: the API is asked for it, and the page says plainly what it shows.
  const hardLoad = async (path) => {
    const done = new Promise((res) => page.on("Page.loadEventFired", res));
    await page.call("Page.navigate", { url: `${base}${path}` });
    await done;
  };
  asked.length = 0;
  await hardLoad("/admin/lottery?from=2026-11-16&to=2026-11-20");
  await waitFor(`!!document.querySelector(".lottery-range-badge")`, "the range label");
  await waitFor(ready, "the Spin button in range mode");
  const rangeAsked = new URLSearchParams(asked.at(-1) ?? "");
  check("a range in the URL is what the page asks the API for",
    asked.length >= 1 && asked.every((q) => q === asked[0]) && rangeAsked.get("from") === "2026-11-16" && rangeAsked.get("to") === "2026-11-20"
      && !rangeAsked.has("week"), JSON.stringify(asked));
  const rangeLabel = await evaluate(periodLabel);
  check("the range is labelled as one, with its dates and in progress",
    /^custom range Mon 16 Nov – Fri 20 Nov( 2026)?, Mountain time in progress$/.test(rangeLabel), rangeLabel);
  const rangeDraw = await evaluate(`[...document.querySelectorAll(".lottery-list:not(.audience) li .who-name")].map((e) => e.innerText)`);
  check("the range's people are in the draw", JSON.stringify(rangeDraw) === JSON.stringify(["Rae Range", "Sam Span"]), rangeDraw.join(", "));
  const rangeQuiet = await evaluate(`document.querySelector(".lottery-list.audience h2")?.innerText ?? ""`);
  check("the lists say \"in this range\"", rangeQuiet === "Didn’t post in this range (1)", rangeQuiet);
  const rangeBar = await evaluate(weekButtons);
  check("a range has no Previous or Next, and a way back to the weekly draw",
    !rangeBar.some((t) => /Previous|Next/.test(t)) && rangeBar.includes("Back to the weekly draw") && rangeBar.includes("Change range"),
    rangeBar.join(", "));
  const unfinished = await evaluate(`[...document.querySelectorAll(".lottery-page p.small")].map((p) => p.innerText).find((t) => t.includes("isn’t over")) ?? ""`);
  check("an unfinished range says when it ends", unfinished === "This range isn’t over yet, so more people may still qualify before Fri 20 Nov ends.", unfinished);
  await evaluate(`document.querySelector(".lottery-go").click()`);
  await waitFor(won, "the range's result");
  const rangeResult = await evaluate(`document.querySelector('[role="status"]').innerText`);
  check("the result is worded for the range", /^The winner is (Rae Range|Sam Span), with \d posts? in this range\.$/.test(rangeResult), rangeResult);
  const meta = await evaluate(`document.querySelector(".lottery-banner-meta")?.innerText ?? ""`);
  check("and so is the winner banner", /^\d posts? in this range$/.test(meta), meta);

  // 7c. Back to the weekly draw: the range leaves the URL.
  asked.length = 0;
  await evaluate(`[...document.querySelectorAll(".lottery-week button")].find((b) => b.innerText.trim() === "Back to the weekly draw").click()`);
  await waitFor(`!document.querySelector(".lottery-range-badge")`, "the week to come back");
  const backUrl = new URL(await evaluate("location.href"));
  check("Back to the weekly draw drops the range from the URL", backUrl.search === "" && asked.includes(""), `${backUrl.search} ${JSON.stringify(asked)}`);
  check("and the week's dates are shown again", /^Fri 13 Nov – Thu 19 Nov/.test(await evaluate(periodLabel)));

  // 7d. Custom range…: two dates and Apply.
  await evaluate(`[...document.querySelectorAll(".lottery-week button")].find((b) => b.innerText.trim() === "Custom range…").click()`);
  await waitFor(`!!document.querySelector(".lottery-range-form")`, "the range form");
  const prefill = await evaluate(`[...document.querySelectorAll(".lottery-range-form input")].map((i) => i.value)`);
  check("the range form starts from the week shown", JSON.stringify(prefill) === JSON.stringify(["2026-11-13", "2026-11-19"]), prefill.join(", "));
  asked.length = 0;
  await evaluate(`(() => {
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
    for (const [name, value] of [["from", "2026-11-17"], ["to", "2026-11-19"]]) {
      const input = document.querySelector('.lottery-range-form input[name="' + name + '"]');
      set.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    }
  })()`);
  await evaluate(`document.querySelector(".lottery-range-apply").click()`);
  await waitFor(`!!document.querySelector(".lottery-range-badge")`, "the applied range");
  const applied = new URL(await evaluate("location.href")).searchParams;
  // (A range not asked for before, so React Query has nothing cached for it; the mock answers with
  // the same range body whatever the dates.)
  check("Apply puts the range in the URL", applied.get("from") === "2026-11-17" && applied.get("to") === "2026-11-19" && !applied.has("week"),
    applied.toString());
  check("and asks the API for it", asked.some((q) => q === "?from=2026-11-17&to=2026-11-19"), JSON.stringify(asked));

  // 8. The presenter view (/admin/lottery/present) and the main page's Present / Copy link.
  const presentHref = `document.querySelector(".lottery-present-open")?.getAttribute("href") ?? ""`;
  // (The period shown is the API's answer, which the mock gives as 16–20 Nov for any range.)
  check("Present on a custom range carries the range shown", (await evaluate(presentHref)) === "/admin/lottery/present?from=2026-11-16&to=2026-11-20",
    await evaluate(presentHref));
  await hardLoad("/admin/lottery");
  await waitFor(ready, "the Spin button on the default week");
  check("Present on the default week carries that week's Friday", (await evaluate(presentHref)) === "/admin/lottery/present?week=2026-11-13",
    await evaluate(presentHref));
  // Copy link: the clipboard gets the absolute presenter link; a refused write says what failed.
  // (navigator.clipboard.writeText is stood in for: a headless browser has no system clipboard.)
  await evaluate(`(() => { window.__copied = null; navigator.clipboard.writeText = (t) => { window.__copied = t; return Promise.resolve(); }; })()`);
  await evaluate(`document.querySelector(".lottery-present-copy").click()`);
  await waitFor(`!!document.querySelector(".lottery-present-copied")`, "the copied note");
  check("Copy link copies the absolute presenter link", (await evaluate("window.__copied")) === `${base}/admin/lottery/present?week=2026-11-13`,
    await evaluate("window.__copied"));
  await evaluate(`navigator.clipboard.writeText = () => Promise.reject(new DOMException("Write permission denied.", "NotAllowedError"))`);
  await evaluate(`document.querySelector(".lottery-present-copy").click()`);
  await waitFor(`!!document.querySelector(".lottery-present-copy-failed")`, "the copy failure");
  const copyFailed = await evaluate(`document.querySelector(".lottery-present-copy-failed").innerText.trim()`);
  const copyField = await evaluate(`document.querySelector(".lottery-present-copy-failed input")?.value ?? ""`);
  check("a failed copy says what failed and offers the link to copy by hand",
    copyFailed === "Copying the link failed: Write permission denied. Copy it from here:" && copyField === `${base}/admin/lottery/present?week=2026-11-13`,
    `${copyFailed} | ${copyField}`);

  // Present opens the bare view for the period shown (a soft navigation: the shell must go too).
  asked.length = 0;
  await evaluate(`document.querySelector(".lottery-present-open").click()`);
  await waitFor(`location.pathname === "/admin/lottery/present" && !!document.querySelector(".lottery-present .lottery-go")`, "the presenter view");
  check("Present opens the presenter view for that week", (await evaluate("location.search")) === "?week=2026-11-13", await evaluate("location.search"));
  const bare = `({ shell: !!document.querySelector(".shell, .sidebar, nav, .side-nav, main"),
    banners: document.querySelectorAll(".paused-banner, .host-blocked, .server-unreachable").length,
    picker: !!document.querySelector(".lottery-week, .lottery-range-form, .lottery-title"), lists: !!document.querySelector(".lottery-lists, .lottery-excluded"),
    scroll: document.documentElement.scrollHeight > innerHeight || document.documentElement.scrollWidth > innerWidth })`;
  const isBare = (b) => !b.shell && b.banners === 0 && !b.picker && !b.lists && !b.scroll;
  let shape = await evaluate(bare);
  check("the presenter view has no shell, sidebar, banners, week picker or lists, and no page scroll", isBare(shape), JSON.stringify(shape));
  const presentLabel = `document.querySelector(".lottery-present .lottery-week-label")?.innerText.replace(/\\s+/g, " ").trim() ?? ""`;
  check("it names the week", /^Fri 13 Nov – Thu 19 Nov( 2026)?, Mountain time$/.test(await evaluate(presentLabel)), await evaluate(presentLabel));
  check("it asked the API for that week", asked.includes("?week=2026-11-13"), JSON.stringify(asked));

  // A hard load with no parameters: the latest complete week, nothing asked for.
  asked.length = 0;
  await hardLoad("/admin/lottery/present");
  await waitFor(ready, "the presenter's Spin button");
  shape = await evaluate(bare);
  check("a hard load of the presenter view is bare too", isBare(shape), JSON.stringify(shape));
  check("with no parameters it asks the API for none", asked.length >= 1 && asked.every((q) => q === ""), JSON.stringify(asked));
  check("and names the week it got", /^Fri 13 Nov – Thu 19 Nov( 2026)?, Mountain time$/.test(await evaluate(presentLabel)), await evaluate(presentLabel));
  check("Full screen and Exit are offered; Exit goes back to the lottery page",
    (await evaluate(`!!document.querySelector(".lottery-present-fullscreen")`)) &&
      (await evaluate(`document.querySelector(".lottery-present-exit")?.getAttribute("href")`)) === "/admin/lottery");

  // The draw: one per Reset, with the winner banner, by the same rules as the main page.
  const drawsBefore = await evaluate("window.__draws");
  await evaluate(`(() => { const b = document.querySelector(".lottery-go"); b.click(); b.click(); })()`);
  await waitFor(won, "the presenter's result");
  check("a (double-clicked) spin in the presenter view draws once", (await evaluate("window.__draws")) === drawsBefore + 1,
    `draws: ${await evaluate("window.__draws")}`);
  const banner = await evaluate(`document.querySelector(".lottery-banner")?.innerText.replace(/\\s+/g, " ").trim() ?? ""`);
  check("and shows the winner banner", /^★ This week’s winner ★ (Ada One|Ben Two|Cy Three|Di Four|Ed Five) \d posts? this week$/i.test(banner), banner);
  check("after the win only Reset is offered", (await evaluate(`document.querySelectorAll(".lottery-go").length`)) === 0 &&
    (await evaluate(`!!document.querySelector(".lottery-reset")`)));
  await evaluate(`document.querySelector(".lottery-reset").click()`);
  await waitFor(ready, "Spin to come back after Reset in the presenter view");
  check("Reset brings back Spin, clears the banner and draws nothing", (await evaluate("window.__draws")) === drawsBefore + 1 &&
    !(await evaluate(`!!document.querySelector(".lottery-banner")`)));
  await evaluate(`document.querySelector(".lottery-go").click()`);
  await waitFor(won, "the presenter's second result");
  check("only then can a second spin draw", (await evaluate("window.__draws")) === drawsBefore + 2);

  // ?week= and ?from=&to= links.
  asked.length = 0;
  await hardLoad("/admin/lottery/present?week=2026-11-13");
  await waitFor(ready, "the presenter's Spin button for a week");
  check("a ?week= link asks the API for that week and names it", asked.length >= 1 && asked.every((q) => q === "?week=2026-11-13") &&
    /^Fri 13 Nov – Thu 19 Nov( 2026)?, Mountain time$/.test(await evaluate(presentLabel)), `${JSON.stringify(asked)} ${await evaluate(presentLabel)}`);
  asked.length = 0;
  await hardLoad("/admin/lottery/present?from=2026-11-16&to=2026-11-20");
  await waitFor(ready, "the presenter's Spin button for a range");
  check("a ?from=&to= link asks for the range and labels it custom range, in progress",
    asked.length >= 1 && asked.every((q) => q === "?from=2026-11-16&to=2026-11-20") &&
      /^custom range Mon 16 Nov – Fri 20 Nov( 2026)?, Mountain time in progress$/.test(await evaluate(presentLabel)),
    `${JSON.stringify(asked)} ${await evaluate(presentLabel)}`);
  check("Exit keeps the range", (await evaluate(`document.querySelector(".lottery-present-exit").getAttribute("href")`)) === "/admin/lottery?from=2026-11-16&to=2026-11-20");
  await evaluate(`document.querySelector(".lottery-present-exit").click()`);
  await waitFor(`location.pathname === "/admin/lottery" && !!document.querySelector(".sidebar") && !!document.querySelector(".lottery-range-badge")`,
    "the lottery page after Exit");
  check("Exit returns to the lottery page, with its shell, for the same range", (await evaluate("location.search")) === "?from=2026-11-16&to=2026-11-20");

  // The gate is /admin/lottery's: signed out goes to sign-in, a member who is not a system admin
  // to the home page, the same for both pages.
  const gate = async (path, cookie) => {
    const r = await fetch(`${base}${path}`, { redirect: "manual", headers: cookie ? { cookie: `session=${cookie}` } : {} });
    return `${r.status} ${r.headers.get("location") ?? ""}`;
  };
  const memberLogin = await fetch(`${base}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "ada@demo.test", password: "demopassword" }),
  });
  const memberSession = memberLogin.headers.get("set-cookie")?.match(/session=([^;]+)/)?.[1];
  assert.ok(memberLogin.ok && memberSession, `member login failed: ${memberLogin.status}`);
  for (const [who, cookie, expected] of [["signed out", null, "/auth/login"], ["a member who is not an admin", memberSession, "/"]]) {
    const main = await gate("/admin/lottery", cookie);
    const present = await gate("/admin/lottery/present?week=2026-11-13", cookie);
    check(`${who}: the presenter view redirects like the lottery page`, present === main && /^30[0-9] /.test(present) && present.endsWith(` ${expected}`),
      `${present} vs ${main}`);
  }

  // 6. The All users page's row menu.
  const toSystem = new Promise((res) => page.on("Page.loadEventFired", res));
  await page.call("Page.navigate", { url: `${base}/system` });
  await toSystem;
  await waitFor(`document.querySelectorAll("tbody tr .who").length > 1`, "the user list");
  // The first ordinary user: not an admin (Make admin in the menu), not deleted.
  const target = await evaluate(`(() => {
    const row = [...document.querySelectorAll("tbody tr")].find((r) => !r.classList.contains("deleted-row") && !r.querySelector(".badge:not(.muted)"));
    return row?.querySelector(".who span:last-child")?.innerText ?? null;
  })()`);
  assert.ok(target, "no ordinary user in the demo data");
  const rowOf = `[...document.querySelectorAll("tbody tr")].find((r) => r.querySelector(".who span:last-child")?.innerText === ${JSON.stringify(target)})`;
  const badge = `!!${rowOf}?.querySelector(".badge.muted")?.innerText.includes("excluded from lottery")`;
  const menuItems = async () => {
    await evaluate(`${rowOf}.querySelector('button[aria-label^="Actions for"]').click()`);
    await waitFor(`[...document.querySelectorAll("button")].some((b) => /in lottery|from lottery/.test(b.innerText))`, "the row menu");
    return evaluate(`[...document.querySelectorAll("button")].map((b) => b.innerText.trim()).filter((t) => /lottery/.test(t))`);
  };
  const choose = (label) => evaluate(`[...document.querySelectorAll("button")].find((b) => b.innerText.trim() === ${JSON.stringify(label)}).click()`);
  const flag = () => evaluate(`fetch("/api/system/overview").then((r) => r.json()).then((o) => o.members.find((m) => m.displayName === ${JSON.stringify(target)}).lotteryExcluded)`);

  check("an ordinary user starts included, with no badge", (await flag()) === false && !(await evaluate(badge)), target);
  check("their menu offers Exclude from lottery", JSON.stringify(await menuItems()) === JSON.stringify(["Exclude from lottery"]));
  await choose("Exclude from lottery");
  await waitFor(badge, "the excluded badge");
  check("choosing it marks the row and stores the flag", (await flag()) === true);
  check("the menu then offers Include in lottery", JSON.stringify(await menuItems()) === JSON.stringify(["Include in lottery"]));
  await choose("Include in lottery");
  await waitFor(`!(${badge})`, "the badge to go");
  check("including them again clears the badge and the flag", (await flag()) === false);

  // A deleted account: delete one through the API, then look at its menu with deleted rows shown.
  const victim = await evaluate(`fetch("/api/system/overview").then((r) => r.json()).then((o) => o.members.find((m) => !m.isSystemAdmin && m.deletedAt == null && m.displayName !== ${JSON.stringify(target)}))`);
  const deleted = await evaluate(`fetch("/api/system/members/${victim.id}", { method: "DELETE" }).then((r) => r.status)`);
  assert.equal(deleted, 200, `deleting ${victim.displayName} failed: ${deleted}`);
  const reload = new Promise((res) => page.on("Page.loadEventFired", res));
  await page.call("Page.reload");
  await reload;
  await waitFor(`document.querySelectorAll("tbody tr .who").length > 1`, "the user list after reload");
  await evaluate(`(() => { const box = [...document.querySelectorAll(".user-filters label.check input")][0]; if (!box.checked) box.click(); })()`);
  const deletedRow = `[...document.querySelectorAll("tbody tr.deleted-row")].find((r) => r.querySelector(".who span:last-child")?.innerText === ${JSON.stringify(victim.displayName)})`;
  await waitFor(`!!${deletedRow}`, "the deleted row");
  await evaluate(`${deletedRow}.querySelector('button[aria-label^="Actions for"]').click()`);
  await waitFor(`[...document.querySelectorAll("button")].some((b) => b.innerText.trim() === "Restore account")`, "the deleted row's menu");
  const offered = await evaluate(`[...document.querySelectorAll("button")].map((b) => b.innerText.trim()).filter((t) => /lottery/.test(t))`);
  check("a deleted account's menu does not offer the lottery item", offered.length === 0, offered.join(", "));

  // 8 (end). Signed out in the browser: the presenter link lands on sign-in.
  await page.call("Network.clearBrowserCookies");
  await hardLoad("/admin/lottery/present?week=2026-11-13");
  await waitFor(`location.pathname === "/auth/login"`, "the sign-in page");
  check("signed out, the presenter link is sent to sign-in", (await evaluate("location.pathname")) === "/auth/login");

  console.log(JSON.stringify({ result: "PASS", checks: passed, stage }));
} finally {
  page.close();
  stop();
}
process.exit(0);
