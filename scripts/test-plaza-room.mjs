#!/usr/bin/env node
// The plaza room (plaza/, a Rust Durable Object under `wrangler dev`) over real WebSockets.
// Starts its own rooms on free ports (scripts/plaza-room-harness.mjs), signs passes with node's
// own Ed25519 and the checked-in DEV-ONLY key, and always stops wrangler and workerd on exit.
//
//   1. origins: missing or disallowed Origin gets 403 with the reason; /health reports
//      originAllowed and allows any origin to read it; the any-port dev switch, and without it
//      only the exact list (a second room, which also has a broken public key);
//   2. passes: tampered, wrong key, expired and garbage passes are refused with their code and
//      close 4001; a first message other than hello gets hello_required and 4003; a room with a
//      broken public key says room_misconfigured; a socket that never says hello gets
//      hello_timeout and a close frame (PLAZA_HELLO_TIMEOUT_MS is 1500 ms here);
//   3. two members: welcome lists who is online; join, move (clamped), jump, chat, leave reach the
//      other side and are not echoed; a member id sent by the client is ignored;
//   4. limits: a blast of 100 moves is cut to about the burst; chat too long / too fast errors go
//      to the sender only and the connection survives; malformed frames are ignored;
//   5. high fives near and within the window, none when far apart;
//   6. a second connection for the same member replaces the first (replaced + 4002) with no
//      leave/join seen by others, at the old position.
//
// Requires `npm ci` in plaza/ and cargo (the harness builds the room when its sources changed).
// Prints one line per check, the expected and the received messages on failure, and exits 1.
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { createRequire } from "node:module";
import { join } from "node:path";
import { plazaDir, signPass, startRoom } from "./plaza-room-harness.mjs";

const WebSocket = createRequire(join(plazaDir, "package.json"))("ws");
const ORIGIN = "http://localhost:3312";
const HELLO_TIMEOUT_MS = 1500;
const started = Date.now();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const nowSec = () => Math.floor(Date.now() / 1000);
const pass = (id, ttl = 60) => signPass(id, nowSec() + ttl);

// --- a small WebSocket client that queues what arrives -------------------------------------------

const clients = new Set();
function connect(url, { origin = ORIGIN, name = "client" } = {}) {
  return new Promise((resolve) => {
    const ws = new WebSocket(url, origin ? { origin } : {});
    const c = { name, ws, queue: [], all: [], closed: null, rejected: null, wake: () => {} };
    clients.add(c);
    const poke = () => c.wake();
    ws.on("message", (data, isBinary) => {
      const m = isBinary ? { binary: true } : JSON.parse(data.toString());
      c.queue.push(m);
      c.all.push(m);
      poke();
    });
    ws.on("close", (code, reason) => { c.closed = { code, reason: reason.toString() }; poke(); resolve(c); });
    ws.on("unexpected-response", (_req, res) => {
      let body = "";
      res.on("data", (d) => (body += d));
      res.on("end", () => { c.rejected = { status: res.statusCode, body }; resolve(c); });
    });
    ws.on("error", (e) => { c.error = e; poke(); });
    ws.on("open", () => resolve(c));
  });
}
const send = (c, m) => c.ws.send(typeof m === "string" ? m : JSON.stringify(m));
const show = (c) => `${c.name} received: ${c.all.map((m) => JSON.stringify(m)).join(" ") || "nothing"}` +
  (c.closed ? `; closed ${c.closed.code} ${c.closed.reason}` : "");

async function until(c, test, ms) {
  const end = Date.now() + ms;
  for (;;) {
    const r = test();
    if (r) return r;
    const left = end - Date.now();
    if (left <= 0) return null;
    await new Promise((res) => {
      const timer = setTimeout(res, left);
      c.wake = () => { clearTimeout(timer); res(); };
    });
  }
}

// Takes the first queued message matching `pred` (an object of fields, or a function).
async function take(c, pred, what = JSON.stringify(pred), ms = 3000) {
  const match = typeof pred === "function" ? pred : (m) => Object.entries(pred).every(([k, v]) => m[k] === v);
  const m = await until(c, () => {
    const i = c.queue.findIndex(match);
    return i >= 0 ? c.queue.splice(i, 1)[0] : null;
  }, ms);
  if (!m) assert.fail(`expected ${c.name} to receive ${what} within ${ms} ms; ${show(c)}`);
  return m;
}
async function none(c, pred, what = JSON.stringify(pred), ms = 300) {
  const match = typeof pred === "function" ? pred : (m) => Object.entries(pred).every(([k, v]) => m[k] === v);
  await sleep(ms);
  const bad = c.queue.filter(match);
  if (bad.length) assert.fail(`expected ${c.name} NOT to receive ${what}, got ${JSON.stringify(bad)}; ${show(c)}`);
}
async function closedWith(c, code, ms = 3000) {
  await until(c, () => c.closed, ms);
  if (!c.closed) assert.fail(`expected ${c.name} to be closed with ${code} within ${ms} ms; ${show(c)}`);
  assert.equal(c.closed.code, code, `${c.name} close code; ${show(c)}`);
}
async function closeAll() {
  const open = [...clients].filter((c) => !c.closed && !c.rejected);
  for (const c of open) c.ws.close(1000);
  await Promise.all(open.map((c) => until(c, () => c.closed, 2000)));
  clients.clear();
}

// Connects and says hello as `id`; returns the client with its welcome taken.
async function member(url, id, name = `member ${id}`) {
  const c = await connect(url, { name });
  assert.ok(!c.rejected, `${name} upgrade refused: ${JSON.stringify(c.rejected)}`);
  send(c, { t: "hello", pass: pass(id) });
  c.welcome = await take(c, { t: "welcome" }, "welcome");
  assert.equal(c.welcome.you, id);
  return c;
}

let passed = 0;
const failures = [];
async function check(name, fn) {
  const t = Date.now();
  try {
    await fn();
    passed++;
    console.log(`ok   ${name} (${Date.now() - t} ms)`);
  } catch (e) {
    failures.push(name);
    console.log(`FAIL ${name}\n     ${String(e.message ?? e).replaceAll("\n", "\n     ")}`);
  } finally {
    await closeAll();
  }
}

// --- run ------------------------------------------------------------------------------------------

let room, strict, silent;
try {
  // The main room (dev config, any-port switch on, short hello timeout), and a second one with a
  // broken public key and only the exact origin list.
  [room, strict] = await Promise.all([
    startRoom({ vars: { PLAZA_HELLO_TIMEOUT_MS: String(HELLO_TIMEOUT_MS) } }),
    startRoom({ vars: { PLAZA_PASS_PUBLIC_KEY: "not-a-key", PLAZA_ALLOW_LOCALHOST_ANY_PORT: "0" } }),
  ]);
  console.log(`rooms up on ${room.httpUrl} and ${strict.httpUrl} (${Date.now() - started} ms)`);
  const url = room.wsUrl;

  // Started first, checked last: a socket that never says hello.
  silent = await connect(url, { name: "silent socket" });
  clients.delete(silent); // kept open across checks on purpose
  const silentAt = Date.now();

  await check("upgrade without an Origin header is refused with 403", async () => {
    const c = await connect(url, { origin: null, name: "no-origin" });
    assert.equal(c.rejected?.status, 403, show(c));
    assert.match(c.rejected.body, /origin not allowed: the request has no Origin header/);
  });

  await check("upgrade from a disallowed origin is refused with 403 naming it", async () => {
    const c = await connect(url, { origin: "https://evil.example", name: "evil" });
    assert.equal(c.rejected?.status, 403, show(c));
    assert.match(c.rejected.body, /origin not allowed: https:\/\/evil\.example/);
    const c2 = await connect(url, { origin: "http://localhost.evil.example:3312", name: "evil2" });
    assert.equal(c2.rejected?.status, 403);
  });

  await check("/health answers ok with originAllowed for the request's Origin, readable from anywhere", async () => {
    const h = async (base, origin) => {
      const res = await fetch(`${base}/health`, { headers: origin ? { Origin: origin } : {} });
      assert.equal(res.status, 200);
      assert.equal(res.headers.get("access-control-allow-origin"), "*");
      return (await res.json());
    };
    assert.deepEqual(await h(room.httpUrl, ORIGIN), { ok: true, originAllowed: true });
    assert.deepEqual(await h(room.httpUrl, "http://127.0.0.1:41234"), { ok: true, originAllowed: true });
    assert.deepEqual(await h(room.httpUrl, "https://evil.example"), { ok: true, originAllowed: false });
    assert.deepEqual(await h(room.httpUrl, null), { ok: true, originAllowed: false });
    // Without the any-port switch only the exact list counts.
    assert.deepEqual(await h(strict.httpUrl, "http://localhost:4000"), { ok: true, originAllowed: false });
    assert.deepEqual(await h(strict.httpUrl, "http://127.0.0.1:3312"), { ok: true, originAllowed: true });
  });

  await check("any localhost port is accepted only with the dev switch", async () => {
    const ok = await connect(url, { origin: "http://localhost:45678", name: "any-port" });
    assert.ok(!ok.rejected, JSON.stringify(ok.rejected));
    const no = await connect(strict.wsUrl, { origin: "http://localhost:45678", name: "strict any-port" });
    assert.equal(no.rejected?.status, 403);
  });

  const refused = async (p, code, label) => {
    const c = await connect(url, { name: label });
    send(c, { t: "hello", pass: p });
    const e = await take(c, { t: "error" }, "an error");
    assert.equal(e.code, code, `${label}: ${JSON.stringify(e)}`);
    assert.ok(e.message, "error has a message");
    await closedWith(c, 4001);
    return e;
  };

  await check("a pass with a tampered payload is refused: pass_bad_signature, 4001", async () => {
    const [, sig] = pass(5).split(".");
    const forged = Buffer.from(`{"m":6,"exp":${nowSec() + 60}}`).toString("base64url");
    await refused(`${forged}.${sig}`, "pass_bad_signature", "tampered");
  });

  await check("a pass signed with another key is refused: pass_bad_signature, 4001", async () => {
    const der = generateKeyPairSync("ed25519").privateKey.export({ format: "der", type: "pkcs8" });
    const other = signPass(5, nowSec() + 60, { seed: der.subarray(der.length - 32) });
    await refused(other, "pass_bad_signature", "wrong key");
  });

  await check("an expired pass is refused: pass_expired, 4001", async () => {
    const e = await refused(signPass(5, nowSec() - 5), "pass_expired", "expired");
    assert.match(e.message, /expired/);
  });

  await check("garbage passes are refused: pass_malformed, 4001", async () => {
    await refused("hello", "pass_malformed", "garbage");
    await refused("a".repeat(600), "pass_malformed", "too long");
    await refused("!!!.???", "pass_malformed", "bad base64");
  });

  await check("a first message other than hello gets hello_required and 4003", async () => {
    const c = await connect(url, { name: "no-hello" });
    send(c, { t: "move", x: 1, y: 2 });
    assert.equal((await take(c, { t: "error" })).code, "hello_required");
    await closedWith(c, 4003);
  });

  await check("a room with a broken public key says room_misconfigured (not a bad pass)", async () => {
    const c = await connect(strict.wsUrl, { name: "misconfigured" });
    send(c, { t: "hello", pass: pass(5) });
    const e = await take(c, { t: "error" });
    assert.equal(e.code, "room_misconfigured", JSON.stringify(e));
    assert.match(e.message, /PLAZA_PASS_PUBLIC_KEY/);
    await closedWith(c, 4004);
  });

  await check("two members see each other: welcome, join, move, jump, chat, leave", async () => {
    const a = await member(url, 101, "A");
    assert.deepEqual(a.welcome.online, [], "A is alone");
    assert.ok(Math.abs(a.welcome.x - 1000) <= 200 && Math.abs(a.welcome.y - 600) <= 200, `spawn near centre: ${JSON.stringify(a.welcome)}`);
    const b = await member(url, 102, "B");
    assert.deepEqual(b.welcome.online, [{ id: 101, x: a.welcome.x, y: a.welcome.y }]);
    const j = await take(a, { t: "join", id: 102 });
    assert.deepEqual(j, { t: "join", id: 102, x: b.welcome.x, y: b.welcome.y });

    send(a, { t: "move", x: 250.5, y: 300 });
    assert.deepEqual(await take(b, { t: "move" }), { t: "move", id: 101, x: 250.5, y: 300 });
    send(a, { t: "move", x: -50, y: 99999 });
    assert.deepEqual(await take(b, { t: "move" }), { t: "move", id: 101, x: 0, y: 1200 }, "clamped");

    send(b, { t: "jump" });
    assert.deepEqual(await take(a, { t: "jump" }), { t: "jump", id: 102 });

    send(a, { t: "chat", text: "  hi there\n" });
    assert.deepEqual(await take(b, { t: "chat" }), { t: "chat", id: 101, text: "hi there" });
    send(a, { t: "chat", text: " \n " }); // empty after cleaning: dropped

    await none(a, (m) => ["move", "chat"].includes(m.t), "its own move/chat echoed");
    await none(b, { t: "chat" }, "an empty chat");

    a.ws.close(1000);
    assert.deepEqual(await take(b, { t: "leave" }), { t: "leave", id: 101 });
    const c = await member(url, 103, "C");
    assert.deepEqual(c.welcome.online.map((p) => p.id), [102], "A is gone, B is still there");
  });

  await check("a member id sent by the client is ignored", async () => {
    const a = await member(url, 111, "A");
    const b = await member(url, 112, "B");
    await take(a, { t: "join", id: 112 });
    send(a, { t: "move", id: 999, x: 10, y: 20 });
    assert.deepEqual(await take(b, { t: "move" }), { t: "move", id: 111, x: 10, y: 20 });
    send(a, { t: "hello", pass: pass(999) }); // a second hello changes nothing
    send(a, { t: "chat", id: 999, text: "who am i" });
    assert.deepEqual(await take(b, { t: "chat" }), { t: "chat", id: 111, text: "who am i" });
    send(a, { t: "jump", id: 999 });
    assert.deepEqual(await take(b, { t: "jump" }), { t: "jump", id: 111 });
    await none(b, (m) => m.id === 999 || m.t === "join" || m.t === "leave", "anything about member 999");
    await none(a, { t: "welcome" }, "a second welcome", 0);
  });

  await check("a blast of 100 moves reaches the other side cut to about the burst", async () => {
    const a = await member(url, 121, "A");
    const b = await member(url, 122, "B");
    await take(a, { t: "join", id: 122 });
    const t0 = Date.now();
    for (let i = 0; i < 100; i++) send(a, { t: "move", x: 100 + i, y: 100 });
    const blastMs = Date.now() - t0;
    await sleep(400);
    const got = b.queue.filter((m) => m.t === "move" && m.id === 121).length;
    const ceiling = 5 + Math.ceil((15 * (blastMs + 400)) / 1000) + 2;
    assert.ok(got >= 3 && got <= Math.min(ceiling, 20), `B received ${got} of 100 moves (sent in ${blastMs} ms; expected 3..${Math.min(ceiling, 20)})`);
    console.log(`     (${got} of 100 moves relayed; blast took ${blastMs} ms)`);
    // The bucket refills: a move a second later goes through.
    b.queue.length = 0;
    await sleep(400);
    send(a, { t: "move", x: 777, y: 555 });
    assert.deepEqual(await take(b, { t: "move" }), { t: "move", id: 121, x: 777, y: 555 });
  });

  await check("chat too long and too fast: errors to the sender only, connection survives", async () => {
    const a = await member(url, 131, "A");
    const b = await member(url, 132, "B");
    await take(a, { t: "join", id: 132 });
    send(a, { t: "chat", text: "x".repeat(81) });
    assert.equal((await take(a, { t: "error" })).code, "chat_too_long");
    send(a, { t: "chat", text: "é".repeat(80) }); // 80 scalar values is fine
    assert.equal((await take(b, { t: "chat" })).text, "é".repeat(80));
    send(a, { t: "chat", text: "two" });
    send(a, { t: "chat", text: "three" });
    send(a, { t: "chat", text: "four" }); // burst of 3 used up
    assert.equal((await take(a, { t: "error" })).code, "chat_too_fast");
    assert.equal((await take(b, { t: "chat" })).text, "two");
    assert.equal((await take(b, { t: "chat" })).text, "three");
    await none(b, (m) => m.t === "chat" || m.t === "error", "the refused chat or anyone's error", 200);
    assert.equal(a.closed, null, "A still connected");
    send(a, { t: "move", x: 42, y: 43 });
    assert.deepEqual(await take(b, { t: "move" }), { t: "move", id: 131, x: 42, y: 43 });
  });

  await check("malformed frames are ignored and the connection keeps working", async () => {
    const a = await member(url, 141, "A");
    const b = await member(url, 142, "B");
    await take(a, { t: "join", id: 142 });
    for (const f of ["not json", '{"t":"dance"}', '{"t":"move","x":1e39,"y":1}', '{"t":"move","x":"1","y":2}',
      '{"t":"move","x":null,"y":2}', '{"t":"chat"}', "[]", "null",
      JSON.stringify({ t: "chat", text: "y".repeat(1100) })]) send(a, f);
    a.ws.send(Buffer.from([1, 2, 3]), { binary: true });
    send(a, { t: "move", x: 11, y: 12 });
    assert.deepEqual(await take(b, { t: "move" }), { t: "move", id: 141, x: 11, y: 12 });
    await none(b, (m) => m.t !== "move", "anything from the malformed frames", 200);
    assert.deepEqual(b.all.filter((m) => m.t === "move"), [{ t: "move", id: 141, x: 11, y: 12 }]);
    assert.equal(a.closed, null);
    assert.deepEqual(a.queue, [], "no errors for malformed frames");
  });

  await check("high five when two members jump near each other within the window; none far apart", async () => {
    const a = await member(url, 151, "A");
    const b = await member(url, 152, "B");
    await take(a, { t: "join", id: 152 });
    send(a, { t: "move", x: 500, y: 500 });
    send(b, { t: "move", x: 600, y: 500 });
    await take(b, { t: "move", id: 151 });
    await take(a, { t: "move", id: 152 });
    send(a, { t: "jump" });
    await take(b, { t: "jump", id: 151 });
    send(b, { t: "jump" });
    assert.deepEqual(await take(a, { t: "highfive" }), { t: "highfive", a: 152, b: 151 });
    assert.deepEqual(await take(b, { t: "highfive" }), { t: "highfive", a: 152, b: 151 });

    send(a, { t: "move", x: 100, y: 100 });
    send(b, { t: "move", x: 1500, y: 1000 });
    await take(b, { t: "move", id: 151 });
    await take(a, { t: "move", id: 152 });
    send(a, { t: "jump" });
    await take(b, { t: "jump", id: 151 });
    send(b, { t: "jump" });
    await take(a, { t: "jump", id: 152 });
    await none(a, { t: "highfive" }, "a high five from far apart");
    await none(b, { t: "highfive" }, "a high five from far apart", 0);

    // Near again, but B jumps after the window closed.
    send(b, { t: "move", x: 150, y: 100 });
    await take(a, { t: "move", id: 152 });
    await sleep(750); // the far-apart jumps above are out of the window now
    send(a, { t: "jump" });
    await take(b, { t: "jump", id: 151 });
    await sleep(800);
    send(b, { t: "jump" });
    await take(a, { t: "jump", id: 152 });
    await none(a, { t: "highfive" }, "a high five after the 700 ms window");
  });

  await check("a second connection for a member replaces the first, with no leave/join for others", async () => {
    const a1 = await member(url, 161, "A (first)");
    const b = await member(url, 162, "B");
    await take(a1, { t: "join", id: 162 });
    send(a1, { t: "move", x: 300, y: 310 });
    await take(b, { t: "move", id: 161 });
    const a2 = await member(url, 161, "A (second)");
    assert.equal((await take(a1, { t: "error" })).code, "replaced");
    await closedWith(a1, 4002);
    assert.deepEqual([a2.welcome.x, a2.welcome.y], [300, 310], "keeps the old position");
    assert.deepEqual(a2.welcome.online, [{ id: 162, x: b.welcome.x, y: b.welcome.y }]);
    await none(b, (m) => (m.t === "leave" || m.t === "join") && m.id === 161, "a leave/join for the replaced member");
    send(a2, { t: "move", x: 320, y: 330 });
    assert.deepEqual(await take(b, { t: "move" }), { t: "move", id: 161, x: 320, y: 330 });
    const c = await member(url, 163, "C");
    assert.deepEqual(c.welcome.online.filter((p) => p.id === 161), [{ id: 161, x: 320, y: 330 }], "exactly one presence");
    a2.ws.close(1000);
    assert.deepEqual(await take(b, { t: "leave" }), { t: "leave", id: 161 });
    await none(b, { t: "leave", id: 161 }, "a second leave");
  });

  await check("a socket that never says hello gets hello_timeout and a close frame after the timeout", async () => {
    // Under wrangler dev (workerd 1.20261117.1) a hibernatable socket that never sent a frame does
    // not get its TCP connection ended after the close handshake, so the client's "close" event
    // only comes when it gives up. What is checked is what the room controls: the error and the
    // close frame (ws moves to CLOSING when the server's close frame arrives).
    const e = await take(silent, { t: "error" }, "an error", HELLO_TIMEOUT_MS + 3000);
    assert.equal(e.code, "hello_timeout", show(silent));
    const after = Date.now() - silentAt;
    assert.ok(after >= HELLO_TIMEOUT_MS - 100, `error came after ${after} ms`);
    await until(silent, () => silent.ws.readyState >= WebSocket.CLOSING, 1000);
    assert.ok(silent.ws.readyState >= WebSocket.CLOSING, `server close frame not received (readyState ${silent.ws.readyState}); ${show(silent)}`);
    assert.ok(!silent.all.some((m) => m.t !== "error"), `it got no broadcasts; ${show(silent)}`);
  });
} catch (e) {
  failures.push("setup");
  console.log(`FAIL setup: ${e.stack ?? e}`);
} finally {
  await closeAll();
  try { silent?.ws.terminate(); } catch {}
  await Promise.all([room?.stop(), strict?.stop()]);
}

const ms = Date.now() - started;
if (failures.length) {
  console.log(JSON.stringify({ result: "FAIL", passed, failed: failures, ms }));
  process.exit(1);
}
console.log(JSON.stringify({ result: "PASS", checks: passed, ms }));
process.exit(0); // don't wait for fetch's idle keep-alive sockets
