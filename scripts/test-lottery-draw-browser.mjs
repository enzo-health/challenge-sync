#!/usr/bin/env node
// The public official draw (/lottery) in a headless Chromium on a throwaway profile, signed out,
// against a debug server on a temporary database whose clock is pinned (DEV_CLOCK_OFFSET_FILE) and
// moved through a draw Friday, with drand played by a local fake relay (LOTTERY_BEACON_URLS; nothing
// touches the network). 48 people sign up and 20 of them post in the week of 2026-11-13.
//
//   1. 09:00 Friday 2026-11-20: the dance party, everyone on the floor, a star over each of the
//      week's posters, and a label saying which draw is next and when;
//   2. 09:30: the frozen list (its names, as the API froze them) and its hash, the SHA-256 of the
//      list text, recomputed here; a countdown to the seed;
//   3. 09:35: the wheel; Spin lands on the stored winner, Reset and Spin land there again, and a
//      second browser (its own context, no shared cookies or storage) lands on the same winner;
//      the "verify this draw" disclosure shows the list, its hash, the round, the randomness and
//      the index, and its "Recompute in this browser" agrees;
//   4. 12:00: the party again, and Past results has the draw with its winner;
//   5. the admin page (/admin/lottery/official): a redraw with a reason shows up in its history,
//      and on the public page.
//
// SCREENSHOT_DIR=<dir> also saves a 1920×1080 screenshot of each step there.
// Requires chromium on PATH and `cargo build` in server/.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import assert from "node:assert/strict";

const ROOT = resolve(new URL("..", import.meta.url).pathname);
const SERVER_BIN = resolve(ROOT, "server/target/debug/linkedin-challenge-server");
const CHROME = process.env.CHROME || "chromium";
const SHOTS = process.env.SCREENSHOT_DIR ? resolve(process.env.SCREENSHOT_DIR) : null;
if (!existsSync(SERVER_BIN)) throw new Error(`no server binary at ${SERVER_BIN} — run \`cargo build\` in server/ first`);
if (SHOTS) mkdirSync(SHOTS, { recursive: true });

let passed = 0;
const check = (name, condition, detail = "") => {
  assert.ok(condition, `${name}${detail ? ` (${detail})` : ""}`);
  passed += 1;
  console.log("PASS:", name, detail ? `(${detail})` : "");
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sha256 = (text) => createHash("sha256").update(text).digest("hex");
const utc = (iso) => Math.floor(Date.parse(iso) / 1000);

// --- a fake drand relay ------------------------------------------------------------------------
const CHAIN = "52db9ba70e0cc0f6eaf7803dd07447a1f5477735fd3f661792ba94600c84e971";
const relayAsked = [];
const relay = createServer((req, res) => {
  relayAsked.push(req.url);
  const m = req.url.match(new RegExp(`^/${CHAIN}/public/(\\d+)$`));
  if (!m) {
    res.writeHead(404).end("no such path");
    return;
  }
  const round = Number(m[1]);
  const signature = Buffer.concat([
    createHash("sha256").update(`browser fake ${round}`).digest(),
    createHash("sha256").update(`browser fake tail ${round}`).digest(),
  ]).subarray(0, 48);
  const body = JSON.stringify({ round, randomness: createHash("sha256").update(signature).digest("hex"), signature: signature.toString("hex") });
  res.writeHead(200, { "content-type": "application/json" }).end(body);
});
await new Promise((r) => relay.listen(0, "127.0.0.1", r));
const relayUrl = `http://127.0.0.1:${relay.address().port}`;

// --- a throwaway server, its clock pinned --------------------------------------------------------
const tmp = mkdtempSync(resolve(tmpdir(), "lottery-draw-browser-"));
const clockFile = resolve(tmp, "clock-offset");
const setClock = (unix) => writeFileSync(clockFile, String(unix - Math.floor(Date.now() / 1000)));
setClock(utc("2026-11-10T18:00:00Z"));
const env = {
  ...process.env, DATABASE_URL: `turso:${tmp}/test.db`, PORT: "0", SEED_DEMO: "1",
  DEV_CLOCK_OFFSET_FILE: clockFile, LOTTERY_BEACON_URLS: relayUrl, DEV_BEACON_SKIP_SIGNATURE_CHECK: "1",
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
    "--no-default-browser-check", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--disable-extensions",
    "--window-size=1920,1080", "about:blank"],
  { stdio: ["ignore", "ignore", "pipe"] },
);
let chromeErr = "";
chrome.stderr.on("data", (d) => (chromeErr += d));
const stop = () => {
  if (chrome.exitCode === null) chrome.kill("SIGTERM");
  if (server.exitCode === null) server.kill("SIGTERM");
  relay.close();
  rmSync(tmp, { recursive: true, force: true });
};
process.on("exit", stop);

// --- the people ----------------------------------------------------------------------------------
const api = async (path, { method = "GET", body, cookie, token } = {}) => {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { "content-type": "application/json", ...(cookie ? { cookie: `session=${cookie}` } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, json: text.startsWith("{") ? JSON.parse(text) : null, headers: res.headers };
};
const FIRST = ["Ada", "Bram", "Cleo", "Dov", "Esme", "Finn", "Gus", "Hana", "Ivo", "Juno", "Kai", "Lior", "Mila", "Nico", "Odie", "Pia",
  "Quin", "Ravi", "Suki", "Tove", "Uma", "Vik", "Wren", "Xia", "Yael", "Zed"];
const people = [];
for (let i = 0; i < 48; i++) {
  const name = `${FIRST[i % FIRST.length]} ${["Sky", "Moss"][Math.floor(i / FIRST.length)]}`;
  const email = `p${i}-draw-browser@enzo.health`;
  const signup = await api("/api/auth/signup", { method: "POST", body: { name, email, password: "DrawBrowser!pass1" } });
  assert.equal(signup.status, 200, `signup ${name}: ${JSON.stringify(signup.json)}`);
  const session = signup.headers.get("set-cookie")?.match(/session=([^;]+)/)?.[1];
  const device = await api("/api/auth/device/session", { method: "POST", body: { sessionToken: session } });
  people.push({ name, token: device.json.syncToken });
}
// 20 of them post in the week of Fri 13 – Thu 19 Nov 2026.
for (let i = 0; i < 20; i++) {
  const urn = `urn:li:activity:browser-${i}`;
  const res = await api("/api/sync", {
    method: "POST", token: people[i].token,
    body: { profile: { followerCount: 100 }, posts: [{ urn, permalink: `https://www.linkedin.com/feed/update/${urn}/`, createdAt: "2026-11-16T17:00:00Z",
      textPreview: "draw browser", isRepost: false, metrics: { impressions: 1 }, comments: [] }] },
  });
  assert.equal(res.status, 200, `sync ${i}`);
}

// --- CDP -------------------------------------------------------------------------------------------
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
  const off = (method, fn) => listeners.set(method, (listeners.get(method) ?? []).filter((f) => f !== fn));
  return new Promise((res, rej) => {
    ws.addEventListener("open", () => res({ call, on, off, close: () => ws.close() }));
    ws.addEventListener("error", rej);
  });
}
const port = await devtoolsPort();
const browser = await connect((await (await fetch(`http://127.0.0.1:${port}/json/version`)).json()).webSocketDebuggerUrl);

/** A tab, in its own browser context when `isolated` (no cookies or storage shared). */
async function openTab(isolated) {
  const params = { url: "about:blank" };
  if (isolated) params.browserContextId = (await browser.call("Target.createBrowserContext")).browserContextId;
  const { targetId } = await browser.call("Target.createTarget", params);
  const target = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find((t) => t.id === targetId);
  const tab = await connect(target.webSocketDebuggerUrl);
  await tab.call("Page.enable");
  await tab.call("Emulation.setDeviceMetricsOverride", { width: 1920, height: 1080, deviceScaleFactor: 1, mobile: false });
  await tab.call("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
  tab.evaluate = async (expression) =>
    (await tab.call("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true })).result.value;
  tab.waitFor = async (expression, what, ms = 30000) => {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      if (await tab.evaluate(expression)) return;
      await sleep(100);
    }
    const seen = await tab.evaluate(`JSON.stringify({ phase: document.querySelector(".official-draw")?.dataset.phase, go: [...document.querySelectorAll(".lottery-go")].map((b) => b.disabled), text: document.body.innerText.slice(0, 300) })`);
    throw new Error(`timed out waiting for ${what}; the page: ${seen}`);
  };
  tab.load = async (path) => {
    let fired;
    const done = new Promise((res) => (fired = res));
    tab.on("Page.loadEventFired", fired);
    await tab.call("Page.navigate", { url: `${base}${path}` });
    await done;
    tab.off("Page.loadEventFired", fired);
  };
  tab.shot = async (name) => {
    if (!SHOTS) return;
    await sleep(1200); // let the 3D scene settle a frame or two
    const { data } = await tab.call("Page.captureScreenshot", { format: "png" });
    writeFileSync(resolve(SHOTS, `${name}.png`), Buffer.from(data, "base64"));
    console.log("screenshot:", resolve(SHOTS, `${name}.png`));
  };
  return tab;
}

const text = (sel) => `document.querySelector(${JSON.stringify(sel)})?.innerText.replace(/\\s+/g, " ").trim() ?? ""`;
const phase = `(document.querySelector(".official-draw")?.dataset.phase ?? "")`;

try {
  const tab = await openTab(true);

  // 1. The party, Friday 09:00.
  setClock(utc("2026-11-20T16:00:00Z"));
  await tab.load("/lottery");
  check("/lottery opens signed out (no redirect to sign-in)", (await tab.evaluate("location.pathname")) === "/lottery");
  await tab.waitFor(`${phase} === "party"`, "the party");
  const party = (await api("/api/lottery")).json;
  const posters = party.party.filter((p) => p.postCount > 0).length;
  const info = await tab.evaluate(text(".draw-info"));
  check("the party says which draw is next and when", info.includes("Dance party") && info.includes("Next draw: Fri 13 Nov – Thu 19 Nov")
    && info.includes("Fri 20 Nov, 9:30 AM") && /Freeze in (29|30):\d\d/.test(info), info);
  check("and how many are in it so far", info.includes(`${posters} people are in the draw so far`), `${posters} posters; ${info}`);
  await tab.waitFor(`document.querySelectorAll(".party-tag").length === ${party.party.length} || !!document.querySelector(".party-fallback")`, "the dancers");
  const tags = await tab.evaluate(`[...document.querySelectorAll(".party-tag")].map((t) => [t.innerText.replace(/^★\\s*/, ""), t.classList.contains("starred")])`);
  check("everyone is on the dance floor, and only the week's posters have a star",
    tags.length === party.party.length && tags.every(([name, starred]) => starred === (party.party.find((p) => p.displayName === name)?.postCount > 0)),
    `${tags.length} dancers, ${tags.filter(([, s]) => s).length} starred`);
  check("there is a 3D canvas", await tab.evaluate(`!!document.querySelector(".party-stage canvas")`));
  check("no app shell on the public page", (await tab.evaluate(`document.querySelectorAll(".sidebar").length`)) === 0);
  await tab.shot("1-party");

  // 2. Frozen, 09:30.
  setClock(utc("2026-11-20T16:30:00Z"));
  await tab.load("/lottery");
  await tab.waitFor(`${phase} === "frozen"`, "the frozen list");
  const frozen = (await api("/api/lottery")).json.draw;
  const names = await tab.evaluate(`[...document.querySelectorAll(".draw-names li")].map((li) => li.firstChild.textContent.trim())`);
  check("the frozen list shows exactly the frozen entrants, in list order",
    JSON.stringify(names) === JSON.stringify(frozen.entrants.map((e) => e.displayName)) && names.length === 20, names.join(", "));
  const shownHash = await tab.evaluate(text(".draw-list-hash"));
  check("and the list's hash, which is the SHA-256 of the list text", shownHash === frozen.listHash && sha256(frozen.listText) === shownHash, shownHash);
  const frozenInfo = await tab.evaluate(text(".draw-info"));
  check("with a countdown to the seed round", frozenInfo.includes(`drand round ${frozen.results[0].round}`) && /Wheel in [45]:\d\d/.test(frozenInfo), frozenInfo);
  check("nothing was asked of the beacon before 09:35", relayAsked.length === 0);
  await tab.shot("2-frozen");

  // 3. The wheel, 09:35.
  setClock(utc("2026-11-20T16:35:00Z"));
  await tab.load("/lottery");
  await tab.waitFor(`${phase} === "spin" && !!document.querySelector(".lottery-go") && !document.querySelector(".lottery-go").disabled`, "the wheel");
  const drawn = (await api("/api/lottery")).json.draw;
  const winner = drawn.results[0].winner.displayName;
  const spin = async (t) => {
    await t.evaluate(`document.querySelector(".lottery-go").click()`);
    await t.waitFor(`!!document.querySelector(".lottery-reset")`, "the spin to end");
    return t.evaluate(text(".lottery-banner-name, .lottery-bar-winner strong"));
  };
  const first = await spin(tab);
  check("Spin lands on the stored winner", first === winner, `${first} / ${winner}`);
  await tab.shot("3-spin-winner");
  await tab.evaluate(`document.querySelector(".lottery-reset").click()`);
  await tab.waitFor(`!!document.querySelector(".lottery-go")`, "Spin after Reset");
  check("Reset and Spin again land on the same winner", (await spin(tab)) === winner);
  const other = await openTab(true);
  await other.load("/lottery");
  await other.waitFor(`${phase} === "spin" && !!document.querySelector(".lottery-go") && !document.querySelector(".lottery-go").disabled`, "the wheel in the second browser");
  check("a second browser, sharing nothing, lands on the same winner", (await spin(other)) === winner);
  check("the beacon was asked once for the round", relayAsked.length === 1 && relayAsked[0].endsWith(`/public/${drawn.results[0].round}`), relayAsked.join(", "));

  await tab.evaluate(`document.querySelector(".draw-verify").open = true`);
  const verify = await tab.evaluate(text(".draw-verify"));
  const r = drawn.results[0];
  check("the verify disclosure has the list, its hash, the round, the randomness, the formula and the index",
    verify.includes(drawn.listHash) && verify.includes(String(r.round)) && verify.includes(r.randomness)
      && verify.includes(r.pickDigest) && verify.includes(`mod ${r.eligible.length} eligible = ${r.winnerIndex}`)
      && verify.includes("big-endian") && (await tab.evaluate(text(".draw-verify .draw-list-text"))).startsWith("Challenge Sync weekly lottery"),
    verify.slice(0, 300));
  await tab.evaluate(`document.querySelector(".draw-recompute-run").click()`);
  await tab.waitFor(`!!document.querySelector(".draw-recompute-out")`, "the recomputation");
  const recomputed = await tab.evaluate(text(".draw-recompute-out"));
  check("recomputing in the browser agrees", recomputed.includes("the published hash") && recomputed.includes("the published winner")
    && !recomputed.includes("✗"), recomputed);
  await tab.evaluate(`document.querySelector(".draw-pick-line").scrollIntoView({ block: "center" })`);
  await tab.shot("4-verify");

  // 5. A redraw by an admin, on the admin page; then the public page shows its history.
  const admin = await openTab(true);
  const login = await api("/api/auth/login", { method: "POST", body: { email: "sysadmin@demo.test", password: "demopassword" } });
  const session = login.headers.get("set-cookie")?.match(/session=([^;]+)/)?.[1];
  await admin.call("Network.setCookie", { name: "session", value: session, url: base });
  await admin.load("/admin/lottery");
  await admin.waitFor(`!!document.querySelector(".lottery-official-note")`, "the official-draw note on the lottery page");
  check("the lottery page says the official draw is the public one, and links to it",
    await admin.evaluate(`!!document.querySelector('.lottery-official-note a[href="/lottery"]') && !!document.querySelector('.lottery-official-note a[href="/admin/lottery/official"]')`));
  await admin.load("/admin/lottery/official");
  await admin.waitFor(`!!document.querySelector(".draw-redraw-open")`, "the redraw button");
  await admin.evaluate(`document.querySelector(".draw-redraw-open").click()`);
  await admin.waitFor(`!!document.querySelector(".draw-redraw-form textarea")`, "the reason field");
  check("Record is disabled until there is a reason", await admin.evaluate(`document.querySelector(".draw-redraw-submit").disabled`));
  await admin.evaluate(`(() => { const t = document.querySelector(".draw-redraw-form textarea"); t.focus(); })()`);
  await admin.call("Input.insertText", { text: "The winner already won a prize this month" });
  await admin.evaluate(`document.querySelector(".draw-redraw-submit").click()`);
  await admin.waitFor(`document.querySelectorAll(".draw-history li").length === 1`, "the redraw in the history");
  setClock(utc("2026-11-20T16:35:12Z"));
  await admin.waitFor(`!(${text(".draw-history li")}).includes("waiting for drand")`, "the redraw's winner", 20000);
  const redrawn = (await api("/api/lottery")).json.draw.results[1];
  const history = await admin.evaluate(text(".draw-history li"));
  check("the admin page shows who redrew, why, whose win it replaced and the new winner",
    history.includes("System Operator") && history.includes("The winner already won a prize this month") && history.includes(winner)
      && history.includes(redrawn.winner.displayName) && redrawn.winner.displayName !== winner, history);
  await admin.evaluate(`window.scrollTo(0, 0)`);
  await admin.shot("6-admin-redraw");
  await tab.load("/lottery");
  await tab.waitFor(`${phase} === "spin" && !!document.querySelector(".lottery-go") && !document.querySelector(".lottery-go").disabled`, "the wheel after the redraw");
  check("the public page then spins to the new winner", (await spin(tab)) === redrawn.winner.displayName);
  const publicHistory = await tab.evaluate(text(".draw-history"));
  check("and shows the redraw's history: earlier winner, who and why", publicHistory.includes(winner)
    && publicHistory.includes("System Operator") && publicHistory.includes("The winner already won a prize this month"), publicHistory);

  // 4. Noon: the party, and the result under Past results.
  setClock(utc("2026-11-20T19:00:00Z"));
  await tab.load("/lottery");
  await tab.waitFor(`${phase} === "party"`, "the party after noon");
  const noon = await tab.evaluate(text(".draw-info"));
  check("after noon the party is about the next draw", noon.includes("Next draw: Fri 20 Nov – Thu 26 Nov"), noon);
  await tab.evaluate(`document.querySelector(".draw-past-open").click()`);
  await tab.waitFor(`!!document.querySelector(".draw-past .draw-details")`, "the past results");
  const past = await tab.evaluate(text(".draw-past .draw-details"));
  check("past results show this week's draw with its winner and its redraw", past.includes(`${redrawn.winner.displayName} won`)
    && past.includes("after 1 redraw") && past.includes("The winner already won a prize this month"), past.slice(0, 300));
  await tab.shot("5-past-results");

  console.log(JSON.stringify({ result: "PASS", checks: passed }));
} finally {
  stop();
}
