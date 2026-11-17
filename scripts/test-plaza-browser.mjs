#!/usr/bin/env node
// The plaza page (/plaza) end to end: a real room (plaza/, under `wrangler dev`, started and
// stopped by scripts/plaza-room-harness.mjs), a debug server on a temporary database (SEED_DEMO)
// pointed at it, and a headless Chromium on a throwaway profile with TWO browser contexts signed
// in as two different demo members (Ada and Ben). Assertions read the page's read-only debug
// handle `window.__plaza` (components/plaza + app/plaza/page.tsx) and its DOM:
//
//   1. both go live and each sees the other online; Ada's view also has 38 extra (made-up)
//      roster members wandering, so the 40+ path renders, and the frame time is reported;
//   2. Ada walks with the keyboard (D held) and Ben sees her position change;
//   3. Ada opens chat with Enter and types "wasd hi" (w, a, s, d and spaces as real key events):
//      her avatar does not move or jump while typing; Enter sends; Ben sees the bubble text;
//   4. stars: the roster is answered with Ada posting this week and Ben not; the page marks
//      exactly that (debug handle and the roster list);
//   5. Ada walks up to Ben and both jump together: both pages get the room's high five;
//   6. Ben's context closes: Ada sees him go back to wandering and the online count drop;
//   7. Ada opens the plaza in a second tab: the first says it was replaced and offers "Reconnect
//      here" (and does not reconnect by itself); pressing it takes the plaza back;
//   8. live mode unavailable, from evidence: a roster whose roomUrl is a closed port still renders
//      the plaza (everyone wandering) and the note says the room could not be reached at that URL;
//      a roster with roomUrl null says live mode is not configured.
//
// SHOTS=<dir> also saves screenshots there (forty-wandering, two-online-chat-highfive, empty-room).
// Requires chromium on PATH, `cargo build` in server/, and `npm ci` in plaza/.
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import assert from "node:assert/strict";
import { DEV_PRIVATE_SEED, startRoom } from "./plaza-room-harness.mjs";

const ROOT = resolve(new URL("..", import.meta.url).pathname);
const SERVER_BIN = resolve(ROOT, "server/target/debug/linkedin-challenge-server");
const CHROME = process.env.CHROME || "chromium";
const SHOTS = process.env.SHOTS ? resolve(process.env.SHOTS) : null;
if (!existsSync(SERVER_BIN)) throw new Error(`no server binary at ${SERVER_BIN} — run \`cargo build\` in server/ first`);
if (SHOTS) mkdirSync(SHOTS, { recursive: true });
const OPTIONS = JSON.parse(readFileSync(resolve(ROOT, "server/components/lottery/avatar-options.json"), "utf8"));
const started = Date.now();

let passed = 0;
const check = (name, condition, detail = "") => {
  assert.ok(condition, `${name}${detail ? ` (${detail})` : ""}`);
  passed += 1;
  console.log("PASS:", name, detail ? `(${detail})` : "");
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- the room, a server pointed at it, a browser ----------------------------------------------------
const room = await startRoom();
const tmp = mkdtempSync(resolve(tmpdir(), "plaza-browser-"));
const env = {
  ...process.env, DATABASE_URL: `turso:${tmp}/test.db`, PORT: "0", SEED_DEMO: "1",
  PLAZA_ROOM_URL: room.wsUrl, PLAZA_PASS_PRIVATE_KEY: DEV_PRIVATE_SEED,
};
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
    "--no-default-browser-check", "--disable-extensions", "--window-size=1280,900",
    "--use-angle=swiftshader", "--enable-unsafe-swiftshader",
    // Two pages animate at once; neither may be throttled as a background tab.
    "--disable-background-timer-throttling", "--disable-renderer-backgrounding", "--disable-backgrounding-occluded-windows",
    "about:blank"],
  { stdio: ["ignore", "ignore", "pipe"] },
);
let chromeErr = "";
chrome.stderr.on("data", (d) => (chromeErr += d));
let stopped = false;
const stopAll = async () => {
  if (stopped) return;
  stopped = true;
  if (chrome.exitCode === null) chrome.kill("SIGTERM");
  if (server.exitCode === null) server.kill("SIGTERM");
  await room.stop();
  rmSync(tmp, { recursive: true, force: true });
};
process.on("exit", () => {
  if (chrome.exitCode === null) chrome.kill("SIGTERM");
  if (server.exitCode === null) server.kill("SIGTERM");
  rmSync(tmp, { recursive: true, force: true });
});

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
const browserWs = (await (await fetch(`http://127.0.0.1:${port}/json/version`)).json()).webSocketDebuggerUrl;
const browser = await connect(browserWs);

async function login(email) {
  const res = await fetch(`${base}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password: "demopassword" }),
  });
  const session = res.headers.get("set-cookie")?.match(/session=([^;]+)/)?.[1];
  assert.ok(res.ok && session, `login as ${email} failed: ${res.status}`);
  return session;
}

/** A browser context (its own cookie jar), signed in. */
async function newContext(email) {
  const { browserContextId } = await browser.call("Target.createBrowserContext", { disposeOnDetach: false });
  return { id: browserContextId, session: await login(email) };
}

/**
 * A page in `ctx`, at /plaza, with GET /api/plaza/roster rewritten by `editRoster` (a function of
 * the server's JSON, so member ids stay real).
 */
async function openPlaza(ctx, editRoster = (r) => r, { label = "page" } = {}) {
  const { targetId } = await browser.call("Target.createTarget", { url: "about:blank", browserContextId: ctx.id });
  const page = await connect(`ws://127.0.0.1:${port}/devtools/page/${targetId}`);
  page.targetId = targetId;
  page.label = label;
  page.errors = [];
  page.rosterRequests = 0;
  await page.call("Page.enable");
  await page.call("Runtime.enable");
  page.on("Runtime.exceptionThrown", ({ exceptionDetails }) => page.errors.push(exceptionDetails.exception?.description ?? exceptionDetails.text));
  page.on("Runtime.consoleAPICalled", ({ type, args }) => {
    const text = args.map((a) => a.value ?? a.description).join(" ");
    if (type === "warning" && text.startsWith("THREE.Clock: This module has been deprecated")) return;
    if (type === "error") page.errors.push(`${type}: ${text}`);
  });
  await page.call("Emulation.setDeviceMetricsOverride", { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
  await page.call("Network.enable");
  await page.call("Network.setCookie", { name: "session", value: ctx.session, url: base });
  await page.call("Fetch.enable", { patterns: [{ urlPattern: "*/api/plaza/roster*", requestStage: "Response" }] });
  page.on("Fetch.requestPaused", async ({ requestId }) => {
    const { body, base64Encoded } = await page.call("Fetch.getResponseBody", { requestId });
    page.rosterRequests += 1;
    const roster = editRoster(JSON.parse(base64Encoded ? Buffer.from(body, "base64").toString("utf8") : body), page.rosterRequests);
    await page.call("Fetch.fulfillRequest", {
      requestId,
      responseCode: 200,
      responseHeaders: [{ name: "content-type", value: "application/json" }],
      body: Buffer.from(JSON.stringify(roster)).toString("base64"),
    });
  });
  page.evaluate = async (expression) => {
    const r = await page.call("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(`${label}: ${expression.slice(0, 80)}: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
    return r.result.value;
  };
  page.waitFor = async (expression, what, ms = 20000) => {
    const deadline = Date.now() + ms;
    let last;
    while (Date.now() < deadline) {
      try {
        last = await page.evaluate(expression);
        if (last) return last;
      } catch (e) {
        last = e.message;
      }
      await sleep(50);
    }
    throw new Error(`${label}: timed out waiting for ${what} (last: ${JSON.stringify(last)}); state: ${JSON.stringify(await page.evaluate("window.__plaza?.state ?? null").catch(() => null))}; errors: ${page.errors.join(" | ")}`);
  };
  page.key = (type, { key, code, vk, text }) =>
    page.call("Input.dispatchKeyEvent", { type, key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, ...(text ? { text, unmodifiedText: text } : {}) });
  page.hold = async (k, ms) => {
    await page.key("rawKeyDown", k);
    await sleep(ms);
    await page.key("keyUp", k);
  };
  page.tap = async (k) => {
    await page.key(k.text ? "keyDown" : "rawKeyDown", k);
    await page.key("keyUp", k);
  };
  page.shot = async (name) => {
    if (!SHOTS) return;
    const { data } = await page.call("Page.captureScreenshot", { format: "png" });
    writeFileSync(resolve(SHOTS, name), Buffer.from(data, "base64"));
    console.log("shot:", resolve(SHOTS, name));
  };
  const loaded = new Promise((res) => page.on("Page.loadEventFired", res));
  await page.call("Page.navigate", { url: `${base}/plaza` });
  await loaded;
  await page.waitFor(`!!window.__plaza && !!document.querySelector(".plaza-canvas canvas")`, "the plaza scene");
  return page;
}

const KEYS = {
  D: { key: "d", code: "KeyD", vk: 68 },
  A: { key: "a", code: "KeyA", vk: 65 },
  W: { key: "w", code: "KeyW", vk: 87 },
  S: { key: "s", code: "KeyS", vk: 83 },
  Space: { key: " ", code: "Space", vk: 32 },
  Enter: { key: "Enter", code: "Enter", vk: 13, text: "\r" },
};
const typeChar = (ch) =>
  ch === " " ? { ...KEYS.Space, text: " " } : { key: ch, code: `Key${ch.toUpperCase()}`, vk: ch.toUpperCase().charCodeAt(0), text: ch };

// Made-up members for Ada's view: a 40+ crowd, a third of them posting, half with saved avatars.
const FIRST = ["Ari", "Bea", "Cal", "Dot", "Eli", "Fay", "Gus", "Hal", "Ivy", "Jo", "Kai", "Lu", "Mo", "Nia", "Oz", "Pia", "Quin", "Rae", "Sol"];
const LAST = ["Park", "Reyes", "Stone", "Ng", "Okafor", "Lind"];
function fakeMember(i) {
  const pick = (list, salt) => list[(i * 7 + salt * 13 + ((i * salt) % 5)) % list.length];
  const avatar = i % 2 === 0 ? null : {
    v: 2, skin: pick(OPTIONS.skin, 1), outfit: pick(OPTIONS.outfit, 2), accent: pick(OPTIONS.accent, 3),
    hairColor: pick(OPTIONS.hairColor, 4), hair: pick(OPTIONS.hair.slice(0, 10), 5), facialHair: pick(OPTIONS.facialHair, 6),
    hat: i % 4 === 1 ? "none" : pick(OPTIONS.hat, 7), ears: pick(OPTIONS.ears, 8), eyes: pick(OPTIONS.eyes, 9),
    brows: pick(OPTIONS.brows, 10), nose: pick(OPTIONS.nose, 11), mouth: pick(OPTIONS.mouth, 12), build: pick(OPTIONS.build, 13),
  };
  return { id: 90001 + i, name: `${FIRST[i % FIRST.length]} ${LAST[i % LAST.length]}`, avatar, postedThisWeek: i % 3 === 0 };
}
const CROWD = Array.from({ length: 38 }, (_, i) => fakeMember(i));
const withStars = (r) => ({
  ...r,
  members: r.members.map((m) => ({ ...m, postedThisWeek: m.name === "Ada Ortiz" ? true : m.name === "Ben Cho" ? false : m.postedThisWeek })),
});

const closedPort = await new Promise((res) => {
  const s = createServer().listen(0, "127.0.0.1", () => {
    const p = s.address().port;
    s.close(() => res(p));
  });
});

const errors = [];
try {
  const ctxA = await newContext("ada@demo.test");
  const ctxB = await newContext("ben@demo.test");

  // 1. Ada alone first, with the big crowd: everyone wanders; then Ben arrives.
  const A = await openPlaza(ctxA, (r) => withStars({ ...r, members: [...r.members, ...CROWD] }), { label: "Ada" });
  await A.waitFor(`window.__plaza.state.kind === "live"`, "Ada to go live");
  const adaId = await A.evaluate("window.__plaza.me");
  const total = await A.evaluate("window.__plaza.wandering.length + 1");
  check("Ada's plaza is live and has 40+ people in it", total >= 40, `${total} people`);
  // Frame time with 40+ wanderers (software WebGL here: an upper bound, not what a GPU does).
  await sleep(2500);
  const frame40 = await A.evaluate("window.__plaza.frame");
  console.log("frame (40+ wandering, SwiftShader):", JSON.stringify(frame40));
  await A.shot("forty-wandering.png");

  // Ben's first roster is stale: it predates Ada. The room names her anyway.
  const B = await openPlaza(
    ctxB,
    (r, n) => withStars(n === 1 ? { ...r, members: r.members.filter((m) => m.name !== "Ada Ortiz") } : r),
    { label: "Ben" },
  );
  await B.waitFor(`window.__plaza.state.kind === "live"`, "Ben to go live");
  const benId = await B.evaluate("window.__plaza.me");
  await A.waitFor(`window.__plaza.online.includes(${benId})`, "Ada to see Ben online");
  await B.waitFor(`window.__plaza.online.includes(${adaId})`, "Ben to see Ada online");
  check("each sees the other online", true, `Ada ${adaId}, Ben ${benId}`);
  await B.waitFor(`document.querySelector('.plaza-tag-wrap[data-id="${adaId}"] .plaza-tag')?.textContent === "Ada Ortiz"`, "Ben's page to learn Ada's name");
  check("a member the room knows but the stale roster didn't is drawn at once, then named after a roster refetch",
    B.rosterRequests >= 2, `${B.rosterRequests} roster requests`);
  check("the status line counts both", (await A.evaluate(`document.querySelector(".plaza-status").textContent`)).includes("2 online"),
    await A.evaluate(`document.querySelector(".plaza-status").textContent`));

  // 2. Ada walks right; Ben sees it.
  const before = await B.evaluate(`window.__plaza.position(${adaId})`);
  await A.hold(KEYS.D, 700);
  await B.waitFor(`window.__plaza.position(${adaId}).x > ${before.x + 60}`, "Ben to see Ada move right");
  const after = await B.evaluate(`window.__plaza.position(${adaId})`);
  check("Ada walks with the keyboard and Ben sees her move", true, `x ${before.x.toFixed(0)} -> ${after.x.toFixed(0)}`);

  // 4. Stars.
  const starsA = await A.evaluate("window.__plaza.stars");
  check("a star over the member who posted this week, none over the one who didn't",
    starsA.includes(adaId) && !starsA.includes(benId), `stars: ${starsA.length}`);
  check("the roster list marks the same",
    (await A.evaluate(`!!document.querySelector('.plaza-roster li[data-id="${adaId}"] .plaza-star')`)) &&
      !(await A.evaluate(`!!document.querySelector('.plaza-roster li[data-id="${benId}"] .plaza-star')`)));
  check("the page says what the star means", /posted on LinkedIn this week \(\w{3} \d+ \w{3} – \w{3} \d+ \w{3}, /.test(await A.evaluate(`document.querySelector(".plaza-head").textContent`)));

  // 3. Chat: Enter opens the box; typing w/a/s/d/space types; Enter sends.
  await A.tap(KEYS.Enter);
  await A.waitFor(`document.activeElement?.getAttribute("aria-label") === "Chat message"`, "the chat box to have focus");
  const still = await A.evaluate(`window.__plaza.position(${adaId})`);
  for (const ch of "wasd hi") await A.tap(typeChar(ch));
  await sleep(300);
  const typed = await A.evaluate(`document.activeElement.value`);
  const stillAfter = await A.evaluate(`window.__plaza.position(${adaId})`);
  check("typing in the chat box types (w, a, s, d and spaces included)", typed === "wasd hi", JSON.stringify(typed));
  check("and does not move or jump the avatar",
    Math.abs(stillAfter.x - still.x) < 0.01 && Math.abs(stillAfter.y - still.y) < 0.01 && !(await A.evaluate(`window.__plaza.jumping.includes(${adaId})`)));
  await A.tap(KEYS.Enter);
  await A.waitFor(`window.__plaza.bubbles[${adaId}] === "wasd hi"`, "Ada's own bubble");
  await B.waitFor(`window.__plaza.bubbles[${adaId}] === "wasd hi"`, "Ben to see Ada's bubble");
  await B.waitFor(`document.querySelector('.plaza-tag-wrap[data-id="${adaId}"] .plaza-bubble.on')?.textContent === "wasd hi"`, "the bubble on Ben's screen");
  check("Enter sends; Ben sees the bubble over Ada", true);
  check("the box closed after sending", !(await A.evaluate(`!!document.querySelector(".plaza-chat")`)));

  // 5. Ada walks up to Ben; both jump together: a high five on both screens.
  for (let i = 0; i < 12; i++) {
    const a = await A.evaluate(`window.__plaza.position(${adaId})`);
    const b = await A.evaluate(`window.__plaza.position(${benId})`);
    const dx = b.x - 105 - a.x; // within the room's 140-unit reach, a step apart
    const dy = b.y - a.y;
    if (Math.hypot(dx, dy) < 40) break;
    // ~280 world units a second at full frame rate; slow frames walk less, so this loops.
    if (Math.abs(dx) > 20) await A.hold(dx > 0 ? KEYS.D : KEYS.A, Math.min(900, (Math.abs(dx) / 280) * 1000));
    if (Math.abs(dy) > 20) await A.hold(dy > 0 ? KEYS.S : KEYS.W, Math.min(900, (Math.abs(dy) / 280) * 1000));
    await sleep(250); // the last position reaches the room
  }
  await B.evaluate(`void 0`);
  // Ben says something first, so the shot has a bubble and a high five.
  await B.tap(KEYS.Enter);
  await B.waitFor(`document.activeElement?.getAttribute("aria-label") === "Chat message"`, "Ben's chat box");
  await B.call("Input.insertText", { text: "High five, Ada!" });
  await B.tap(KEYS.Enter);
  await A.waitFor(`window.__plaza.bubbles[${benId}] === "High five, Ada!"`, "Ada to see Ben's bubble");
  let fived = false;
  for (let attempt = 0; attempt < 4 && !fived; attempt++) {
    await B.tap(KEYS.Space);
    await sleep(120);
    await A.tap(KEYS.Space);
    try {
      await A.waitFor(`window.__plaza.highFives > 0`, "the high five", 2500);
      fived = true;
    } catch {
      await sleep(800);
    }
  }
  check("jumping next to each other at the same time is a high five (Ada's screen)", fived,
    `Ada at ${JSON.stringify(await A.evaluate(`window.__plaza.position(${adaId})`))}, Ben at ${JSON.stringify(await A.evaluate(`window.__plaza.position(${benId})`))}`);
  await B.waitFor(`window.__plaza.highFives > 0`, "Ben's high five");
  check("and on Ben's", true);
  await sleep(250);
  await A.shot("two-online-chat-highfive.png");
  check("the help states the high-five rule",
    (await A.evaluate(`document.querySelector(".plaza-help").textContent`)).includes("Jump next to someone at the same time to high five"));

  // 6. Ben leaves.
  await browser.call("Target.closeTarget", { targetId: B.targetId });
  await A.waitFor(`!window.__plaza.online.includes(${benId}) && window.__plaza.wandering.includes(${benId})`, "Ben to go back to wandering");
  await A.waitFor(`document.querySelector(".plaza-status").textContent.includes("just you online")`, "the online count to drop");
  check("closing Ben's page: Ada sees him wander off and the count drop", true);

  // 7. A second Ada tab replaces the first, which offers "Reconnect here" and waits.
  const A2 = await openPlaza(ctxA, withStars, { label: "Ada (tab 2)" });
  await A2.waitFor(`window.__plaza.state.kind === "live"`, "the second tab to go live");
  await A.waitFor(`window.__plaza.state.kind === "stopped" && window.__plaza.state.problem.kind === "replaced"`, "the first tab to be replaced");
  const note = await A.evaluate(`document.querySelector(".plaza-note").textContent`);
  check("the replaced tab says so", note.includes("you opened the plaza in another tab or window; this one is no longer live"), note);
  await sleep(1500);
  check("and does not reconnect by itself", (await A.evaluate("window.__plaza.state.kind")) === "stopped");
  await A.evaluate(`[...document.querySelectorAll(".plaza-note button")].find((b) => b.textContent === "Reconnect here").click()`);
  await A.waitFor(`window.__plaza.state.kind === "live"`, "Reconnect here");
  await A2.waitFor(`window.__plaza.state.problem?.kind === "replaced"`, "the second tab to be replaced in turn");
  check("Reconnect here takes the plaza back", true);
  await browser.call("Target.closeTarget", { targetId: A2.targetId });

  // 8. Live mode unavailable: the room's port is closed; then no room configured.
  const roomUrl = `ws://127.0.0.1:${closedPort}/room`;
  const off = await openPlaza(ctxA, (r) => ({ ...withStars(r), roomUrl }), { label: "closed port" });
  await off.waitFor(`window.__plaza.state.kind === "retrying"`, "the unreachable room");
  const offNote = await off.evaluate(`document.querySelector(".plaza-note").textContent`);
  check("an unreachable room: the plaza still renders, everyone wandering",
    (await off.evaluate(`window.__plaza.wandering.length`)) > 0 && (await off.evaluate(`!!document.querySelector(".plaza-canvas canvas")`)));
  check("and the note names the cause and the URL",
    offNote.startsWith("Live mode is unavailable: could not reach the room at " + roomUrl) && offNote.includes("Reconnecting in"), offNote);
  await browser.call("Target.closeTarget", { targetId: off.targetId });
  const none = await openPlaza(ctxA, (r) => ({ ...withStars(r), roomUrl: null }), { label: "no room" });
  await none.waitFor(`window.__plaza.state.kind === "stopped"`, "live mode off");
  const noneNote = await none.evaluate(`document.querySelector(".plaza-note").textContent`);
  check("no room configured: the note says so", noneNote.includes("live mode is not configured on this server"), noneNote);
  await browser.call("Target.closeTarget", { targetId: none.targetId });

  for (const p of [A]) errors.push(...p.errors);
  if (SHOTS) {
    await browser.call("Target.closeTarget", { targetId: A.targetId }); // a truly empty room
    const ctxC = await newContext("carmen@demo.test");
    const C = await openPlaza(ctxC, (r) => ({ ...r, members: r.members.filter((m) => m.id === r.me) }), { label: "Carmen alone" });
    await C.waitFor(`window.__plaza.state.kind === "live"`, "Carmen live");
    await sleep(800);
    await C.shot("empty-room.png");
  }

  check("no page errors", errors.length === 0, errors.join(" | "));
  console.log(JSON.stringify({ result: "PASS", checks: passed, seconds: Math.round((Date.now() - started) / 100) / 10, frame40 }));
} finally {
  await stopAll();
}
process.exit(0);
