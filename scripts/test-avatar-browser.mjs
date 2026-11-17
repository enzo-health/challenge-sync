#!/usr/bin/env node
// The avatar editor end to end, in a headless Chromium on a throwaway profile against a debug
// server on a temporary database (SEED_DEMO), the same way as test-prefetch-browser.mjs. No
// extension, no LinkedIn, nothing on port 3312.
//
//   1. a member opens /me/avatar, which starts from their generated look (nothing saved yet);
//   2. they pick an everyday hair style, facial hair, a hair colour, eyes, brows and a mouth: the
//      page says the changes are unsaved; Save stores them and says so;
//   3. after a reload the editor shows those choices as pressed, and GET /api/me/avatar returns them;
//   4. on an emulated phone (390px, mobile) the page lays out at 390 CSS px (the viewport meta tag
//      from app/layout.tsx), has no horizontal scroll, puts the preview above the controls, and
//      every option is a ≥40px target;
//   5. a system admin opens /admin/lottery for the current week, where that member posted: the
//      scene drew them with their saved avatar (each name tag carries the look it was drawn from in
//      `data-look`, see components/lottery/avatar.tsx), and an entrant who never saved one with
//      their generated look (bald, dot eyes, smile);
//   6. a save the server refuses shows the server's own message;
//   7. a version 1 avatar (saved before facial hair existed) still loads, upgraded, and draws.
//
// SHOTS=<dir> also saves screenshots there. CROWD=<n> (default 3) adds that many audience members
// with saved avatars (for looking at a big crowd); STAGE=<n> (default 3) more entrants who saved one.
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
const SHOTS = process.env.SHOTS ? resolve(process.env.SHOTS) : null;
const CROWD = Number(process.env.CROWD ?? 3);
const STAGE = Number(process.env.STAGE ?? 3);
if (!existsSync(SERVER_BIN)) throw new Error(`no server binary at ${SERVER_BIN} — run \`cargo build\` in server/ first`);
if (SHOTS) mkdirSync(SHOTS, { recursive: true });
const OPTIONS = JSON.parse(readFileSync(resolve(ROOT, "server/components/lottery/avatar-options.json"), "utf8"));

let passed = 0;
const check = (name, condition, detail = "") => {
  assert.ok(condition, `${name}${detail ? ` (${detail})` : ""}`);
  passed += 1;
  console.log("PASS:", name, detail ? `(${detail})` : "");
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- a throwaway server and browser ----------------------------------------------------------
const tmp = mkdtempSync(resolve(tmpdir(), "avatar-browser-"));
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
    "--no-default-browser-check", "--disable-extensions", "--window-size=1280,900",
    // WebGL in software, so the 3D scenes render without a GPU.
    "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "about:blank"],
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
await page.call("Runtime.enable");
const consoleErrors = [];
page.on("Runtime.exceptionThrown", ({ exceptionDetails }) => consoleErrors.push(exceptionDetails.exception?.description ?? exceptionDetails.text));
page.on("Runtime.consoleAPICalled", ({ type, args }) => {
  const text = args.map((a) => a.value ?? a.description).join(" ");
  // @react-three/fiber 9 still builds a THREE.Clock, which three 0.186 warns about on every canvas.
  if (type === "warning" && text.startsWith("THREE.Clock: This module has been deprecated")) return;
  if (type === "error" || type === "warning") consoleErrors.push(`${type}: ${text}`);
});

const evaluate = async (expression) => {
  const r = await page.call("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(`${expression.slice(0, 80)}: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
  return r.result.value;
};
async function waitFor(expression, what, ms = 15000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await evaluate(expression)) return;
    await sleep(80);
  }
  throw new Error(`timed out waiting for ${what}; page errors: ${consoleErrors.join(" | ") || "none"}`);
}
async function hardLoad(path) {
  const loaded = new Promise((res) => page.on("Page.loadEventFired", res));
  await page.call("Page.navigate", { url: base + path });
  await loaded;
}
async function viewport(width, height, mobile = false) {
  await page.call("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile });
}
async function shot(name, clipSelector) {
  if (!SHOTS) return;
  const params = { format: "png" };
  if (clipSelector) {
    const r = await evaluate(`(() => { const r = document.querySelector(${JSON.stringify(clipSelector)}).getBoundingClientRect(); return { x: r.x + scrollX, y: r.y + scrollY, width: r.width, height: r.height }; })()`);
    params.clip = { ...r, scale: 1 };
    params.captureBeyondViewport = true;
  }
  const { data } = await page.call("Page.captureScreenshot", params);
  const file = resolve(SHOTS, `${name}.png`);
  writeFileSync(file, Buffer.from(data, "base64"));
  console.log("shot:", file);
}
const click = (selector) => evaluate(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) throw new Error("no " + ${JSON.stringify(selector)}); el.click(); return true; })()`);
const chip = (field, value) => `#avatar-${field} + [role=group] [data-value="${value}"]`;
const pressed = (field, value) => evaluate(`document.querySelector(${JSON.stringify(chip(field, value))})?.getAttribute("aria-pressed") === "true"`);

// --- members, through the API -----------------------------------------------------------------
async function api(path, { method = "GET", body, cookie, token } = {}) {
  const headers = { "content-type": "application/json" };
  if (cookie) headers.cookie = `session=${cookie}`;
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await fetch(base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }
  return { status: res.status, json, text, setCookie: res.headers.get("set-cookie") };
}
const sessionOf = (r) => r.setCookie?.match(/session=([^;]+)/)?.[1];

let people = 0;
/** A new member; `post` gives them an original post right now (an entrant this week). */
async function person(name, { post = false, avatar } = {}) {
  people += 1;
  const signup = await api("/api/auth/signup", {
    method: "POST",
    body: { name, email: `avatar-browser-${people}@enzo.health`, password: "AvatarBrowser!pass123" },
  });
  const cookie = sessionOf(signup);
  assert.ok(signup.status === 200 && cookie, `signup ${name}: ${signup.status} ${signup.text.slice(0, 200)}`);
  const me = (await api("/api/auth/me", { cookie })).json;
  if (post) {
    const token = (await api("/api/auth/device/session", { method: "POST", body: { sessionToken: cookie } })).json.syncToken;
    const urn = `urn:li:activity:avatar-browser-${people}`;
    const sync = await api("/api/sync", {
      method: "POST",
      token,
      body: {
        profile: { followerCount: 10 },
        posts: [{ urn, permalink: `https://www.linkedin.com/feed/update/${urn}/`, createdAt: postedAt,
          textPreview: "avatar browser test", isRepost: false, metrics: { impressions: 1 }, comments: [] }],
      },
    });
    assert.equal(sync.status, 200, `sync for ${name}: ${sync.text.slice(0, 200)}`);
  }
  if (avatar) {
    const put = await api("/api/me/avatar", { method: "PUT", cookie, body: avatar });
    assert.equal(put.status, 200, `saving ${name}'s avatar: ${put.text.slice(0, 200)}`);
  }
  return { cookie, id: me.memberId, name };
}

// Everyone posts "now"; the lottery is asked for the week (Monday, Denver) that contains it.
const postedAt = new Date(Date.now() - 60_000).toISOString().replace(/\.\d{3}Z$/, "Z");
const denverDay = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Denver", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(postedAt));
const weekday = new Intl.DateTimeFormat("en-US", { timeZone: "America/Denver", weekday: "short" }).format(new Date(postedAt));
const back = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].indexOf(weekday);
const monday = new Date(Date.parse(`${denverDay}T00:00:00Z`) - back * 86_400_000).toISOString().slice(0, 10);

// A seeded random so extra crowd/stage people look varied but the same every run.
let seed = 7;
const rand = () => ((seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) / 2 ** 32);
const any = (list) => list[Math.floor(rand() * list.length)];
const randomAvatar = () => ({
  v: 2, facialHair: any(OPTIONS.facialHair), skin: any(OPTIONS.skin), outfit: any(OPTIONS.outfit), accent: any(OPTIONS.accent), hairColor: any(OPTIONS.hairColor),
  hair: any(OPTIONS.hair.filter((h) => h !== "none")), hat: any(OPTIONS.hat), ears: any(OPTIONS.ears), eyes: any(OPTIONS.eyes),
  brows: any(OPTIONS.brows), nose: any(OPTIONS.nose), mouth: any(OPTIONS.mouth), build: any(OPTIONS.build),
});

const tester = await person("Avery Tester", { post: true });
// Saved as version 1, before facial hair: the server upgrades it and the stage draws it.
const { facialHair: _unused, ...v1Avatar } = { ...randomAvatar(), v: 1, hair: "mohawk" };
const oldTimer = await person("Olly Version-One", { post: true, avatar: v1Avatar });
const plain = await person("Pat Plain", { post: true }); // never saves an avatar
for (let i = 0; i < STAGE; i++) await person(`Stage Friend ${i + 1}`, { post: true, avatar: randomAvatar() });
for (let i = 0; i < CROWD; i++) await person(`Crowd Fan ${i + 1}`, { avatar: randomAvatar() });
const admin = sessionOf(await api("/api/auth/login", { method: "POST", body: { email: "sysadmin@demo.test", password: "demopassword" } }));
assert.ok(admin, "the demo system admin could not sign in");

const CHOICES = { hair: "ponytail", facialHair: "goatee", hairColor: "#e4572e", eyes: "starry", mouth: "grin", brows: "arched" };

try {
  // --- 1. the editor starts from the generated look ---------------------------------------------
  await page.call("Network.enable");
  await page.call("Network.setCookie", { name: "session", value: tester.cookie, url: base });
  await viewport(1280, 900);
  await hardLoad("/me/avatar");
  await waitFor(`!!document.querySelector(".avatar-controls [data-value]")`, "the editor's controls");
  await waitFor(`!!document.querySelector(".avatar-preview-canvas canvas")`, "the 3D preview");
  check("signed in with nothing saved: the editor starts from the generated look (bald, dot eyes, smile)",
    (await pressed("hair", "none")) && (await pressed("eyes", "dot")) && (await pressed("mouth", "smile")) && (await pressed("build", "signature")));
  check("and says nothing is saved yet",
    (await evaluate(`document.querySelector(".avatar-status").innerText`)).includes("generated look"));
  check("Save is disabled until something changes", await evaluate(`document.querySelector(".avatar-save").disabled`));

  // --- 2. change a few things, save ---------------------------------------------------------------
  for (const [field, value] of Object.entries(CHOICES)) await click(chip(field, value));
  for (const [field, value] of Object.entries(CHOICES)) assert.ok(await pressed(field, value), `${field} ${value} not pressed after the click`);
  check("picking options marks them pressed and the form unsaved",
    (await evaluate(`document.querySelector(".avatar-status").dataset.state`)) === "unsaved");
  await sleep(1200); // let the preview settle for the screenshot
  await shot("editor-desktop");
  await click(".avatar-turn");
  await sleep(1200);
  await shot("editor-desktop-back", ".avatar-preview-canvas");
  await click(".avatar-save");
  await waitFor(`document.querySelector(".avatar-status").innerText.includes("Saved!")`, "the save confirmation");
  check("Save says it saved", true, await evaluate(`document.querySelector(".avatar-status").innerText`));

  // --- 3. reload: the editor and the API both have it ---------------------------------------------
  await hardLoad("/me/avatar");
  await waitFor(`!!document.querySelector(".avatar-controls [data-value]")`, "the editor after a reload");
  const shown = {};
  for (const [field, value] of Object.entries(CHOICES)) shown[field] = await pressed(field, value);
  check("after a reload the editor shows the saved choices", Object.values(shown).every(Boolean), JSON.stringify(shown));
  check("and says they're saved", (await evaluate(`document.querySelector(".avatar-status").dataset.state`)) === "saved");
  const saved = await evaluate(`fetch("/api/me/avatar").then((r) => r.json())`);
  check("GET /api/me/avatar returns them",
    saved.avatar && Object.entries(CHOICES).every(([k, v]) => saved.avatar[k] === v), JSON.stringify(saved.avatar));

  // --- 4. phone width -----------------------------------------------------------------------------
  await viewport(390, 844, true);
  await hardLoad("/me/avatar");
  await waitFor(`!!document.querySelector(".avatar-controls [data-value]")`, "the editor on a phone");
  await sleep(600);
  const layout = await evaluate(`(() => {
    const preview = document.querySelector(".avatar-preview-canvas").getBoundingClientRect();
    const controls = document.querySelector(".avatar-controls").getBoundingClientRect();
    const small = [...document.querySelectorAll(".avatar-page button")]
      .map((b) => b.getBoundingClientRect()).filter((r) => r.width < 40 || r.height < 40).length;
    const wide = [...document.querySelectorAll("body *")].filter((el) => el.getBoundingClientRect().right > innerWidth + 1).slice(0, 5).map((el) => el.tagName + "." + el.className);
    const meta = document.querySelector('head meta[name="viewport"]')?.getAttribute("content") ?? null;
    return { scroll: document.documentElement.scrollWidth, width: innerWidth, meta, previewAbove: preview.bottom <= controls.top, small, wide };
  })()`);
  check("on a 390px phone: the page lays out at 390 CSS px (viewport meta in <head>)", layout.width === 390 && layout.meta?.includes("width=device-width"), JSON.stringify({ width: layout.width, meta: layout.meta }));
  check("on a 390px phone: no horizontal scroll", layout.scroll <= layout.width, JSON.stringify(layout));
  check("on a 390px phone: the preview is above the controls", layout.previewAbove);
  check("on a 390px phone: every button is at least 40px each way", layout.small === 0, `${layout.small} smaller`);
  await shot("editor-phone");
  await evaluate(`window.scrollTo(0, document.querySelector(".avatar-controls").offsetTop)`);
  await sleep(300);
  await shot("editor-phone-controls");
  await evaluate(`window.scrollTo(0, document.querySelector("#avatar-hair").getBoundingClientRect().top + scrollY - 20)`);
  await sleep(300);
  await shot("editor-phone-hair");
  await hardLoad("/me");
  await waitFor(`!!document.querySelector(".who h1")`, "/me on a phone");
  await sleep(400);
  check("on a 390px phone: /me lays out at 390 CSS px too", (await evaluate("innerWidth")) === 390);
  await shot("phone-me");
  await hardLoad("/");
  await waitFor(`!!document.querySelector(".stats h1, h1")`, "/ on a phone");
  await sleep(800);
  await shot("phone-overview");
  await viewport(1280, 900);
  await hardLoad("/me/avatar");
  await waitFor(`!!document.querySelector(".avatar-controls [data-value]")`, "the editor again");
  await evaluate(`window.scrollTo(0, document.querySelector("#avatar-hair").getBoundingClientRect().top + scrollY - 120)`);
  await sleep(1000);
  await shot("editor-desktop-hair");
  await evaluate(`window.scrollTo(0, 0)`);

  // --- 6. a refused save shows the server's message ------------------------------------------------
  // Swap the page's fetch for one that sends an option the server doesn't know, as a page out of
  // step with the server would, then press Save.
  await click(chip("hair", "bun"));
  await evaluate(`(() => {
    const real = window.fetch;
    window.fetch = (input, init) => init && init.method === "PUT"
      ? real(input, { ...init, body: JSON.stringify({ ...JSON.parse(init.body), hair: "beehive" }) })
      : real(input, init);
    return true;
  })()`);
  await click(".avatar-save");
  await waitFor(`document.querySelector(".avatar-status").dataset.state === "error"`, "the refusal");
  const refusal = await evaluate(`document.querySelector(".avatar-status").innerText`);
  const direct = await api("/api/me/avatar", { method: "PUT", cookie: tester.cookie, body: { ...saved.avatar, hair: "beehive" } });
  check("a refused save shows the server's own message", direct.status === 400 && refusal.includes(direct.json.error), refusal);
  const still = await api("/api/me/avatar", { cookie: tester.cookie });
  check("and the saved avatar is unchanged", still.json.avatar?.hair === CHOICES.hair);

  // --- 5. the lottery scene draws it ---------------------------------------------------------------
  await page.call("Network.setCookie", { name: "session", value: admin, url: base });
  await hardLoad(`/admin/lottery?week=${monday}`);
  await waitFor(`[...document.querySelectorAll(".lottery-tag")].some((t) => t.innerText.includes(${JSON.stringify(tester.name)}))`, "the tester's name tag on stage", 30000);
  const lookOf = (name) => evaluate(`JSON.parse([...document.querySelectorAll(".lottery-tag")].find((t) => t.innerText.includes(${JSON.stringify(name)})).dataset.look)`);
  const testerLook = await lookOf(tester.name);
  check("on stage, the member is drawn with their saved avatar",
    Object.entries(CHOICES).every(([k, v]) => testerLook[k] === v), JSON.stringify(testerLook));
  const plainLook = await lookOf(plain.name);
  check("an entrant with no saved avatar keeps the generated look",
    plainLook.hair === "none" && plainLook.eyes === "dot" && plainLook.mouth === "smile" && plainLook.brows === "none" && plainLook.nose === "none",
    JSON.stringify(plainLook));
  const oldLook = await lookOf(oldTimer.name);
  check("a version 1 avatar (no facial hair) still draws, upgraded",
    oldLook.hair === "mohawk" && oldLook.facialHair === "none" && oldLook.skin === v1Avatar.skin, JSON.stringify(oldLook));
  const oldApi = await api("/api/me/avatar", { cookie: oldTimer.cookie });
  check("and the API returns it as version 2", oldApi.json.avatar?.v === 2 && oldApi.json.avatar?.facialHair === "none", JSON.stringify(oldApi.json.avatar));
  const lottery = await api(`/api/admin/lottery?week=${monday}`, { cookie: admin });
  const crowdWithAvatars = lottery.json.audience.filter((p) => p.avatar).length;
  check("the lottery API sends saved avatars for the audience too", crowdWithAvatars >= CROWD, `${crowdWithAvatars} of ${lottery.json.audience.length}`);
  await sleep(2500);
  await shot("lottery-scene");
  await viewport(390, 844, true);
  await hardLoad(`/admin/lottery?week=${monday}`);
  await waitFor(`document.querySelectorAll(".lottery-tag").length > 0`, "the lottery on a phone", 30000);
  check("on a 390px phone: /admin/lottery lays out at 390 CSS px", (await evaluate("innerWidth")) === 390);
  await sleep(2500);
  await shot("phone-lottery");
  await viewport(1280, 900);
  check("no page errors or warnings along the way", consoleErrors.length === 0, consoleErrors.join(" | "));

  console.log(JSON.stringify({ result: "PASS", checks: passed }));
} finally {
  page.close();
  stop();
}
process.exit(0);
