#!/usr/bin/env node
// The plaza page's live-connection state machine (server/components/plaza/connection.ts) under
// plain node, which strips the TypeScript types itself: fake sockets, fake timers, scripted pass
// and /health answers. Checks that each way live mode can fail ends in the state and message the
// evidence supports, which failures retry by themselves (with backoff) and which wait for a person.
import assert from "node:assert/strict";
import { PlazaConnection, backoffMs, describeProblem, healthUrlFor } from "../server/components/plaza/connection.ts";

let passed = 0;
async function check(name, fn) {
  await fn();
  passed += 1;
  console.log("PASS:", name);
}
const flush = () => new Promise((r) => setImmediate(r));

class FakeSocket {
  constructor(url) {
    this.url = url;
    this.sent = [];
    this.closed = null;
    this.onopen = this.onmessage = this.onerror = this.onclose = null;
  }
  send(data) {
    this.sent.push(JSON.parse(data));
  }
  close(code, reason) {
    this.closed = { code, reason };
  }
  open() {
    this.onopen?.({});
  }
  receive(msg) {
    this.onmessage?.({ data: JSON.stringify(msg) });
  }
  drop(code, reason = "") {
    this.onerror?.({});
    this.onclose?.({ code, reason });
  }
}

function harness({ roomUrl = "ws://127.0.0.1:9/room", pass = { ok: true, pass: "p.s" }, health = { kind: "ok", originAllowed: true } } = {}) {
  const h = { sockets: [], timers: [], states: [], messages: [], offline: 0, refused: [], healthAsked: [] };
  h.conn = new PlazaConnection(
    {
      roomUrl,
      origin: "http://127.0.0.1:3000",
      requestPass: async () => (typeof pass === "function" ? pass() : pass),
      probeHealth: async (url) => {
        h.healthAsked.push(url);
        return health;
      },
      openSocket: (url) => {
        const s = new FakeSocket(url);
        h.sockets.push(s);
        return s;
      },
      setTimer: (fn, ms) => {
        const t = { fn, ms, cleared: false };
        h.timers.push(t);
        return t;
      },
      clearTimer: (t) => (t.cleared = true),
      now: () => 0,
    },
    {
      state: (s) => h.states.push(s),
      message: (m) => h.messages.push(m),
      offline: () => (h.offline += 1),
      chatRefused: (code, message) => h.refused.push({ code, message }),
    },
  );
  h.last = () => h.sockets[h.sockets.length - 1];
  h.state = () => h.conn.state;
  return h;
}

await check("no room URL: stopped, 'not configured', no socket", async () => {
  const h = harness({ roomUrl: null });
  h.conn.start();
  assert.equal(h.state().kind, "stopped");
  assert.equal(h.state().problem.kind, "not_configured");
  assert.equal(h.sockets.length, 0);
  assert.match(describeProblem(h.state().problem), /not configured on this server/);
});

await check("pass refusals are named and wait for a person", async () => {
  for (const [problem, text] of [
    [{ kind: "signed_out", body: "sign-in required" }, /signed out .*401/],
    [{ kind: "key_missing", message: "the plaza is not configured: PLAZA_PASS_PRIVATE_KEY is not set on the server" }, /PLAZA_PASS_PRIVATE_KEY is not set/],
    [{ kind: "key_invalid", message: "the plaza is misconfigured: …" }, /misconfigured/],
    [{ kind: "pass_status", status: 404, body: "" }, /answered 404 to the pass request with no body/],
  ]) {
    const h = harness({ pass: { ok: false, problem } });
    h.conn.start();
    await flush();
    assert.equal(h.state().kind, "stopped", problem.kind);
    assert.equal(h.timers.length, 0);
    assert.match(describeProblem(h.state().problem), text);
  }
});

await check("no answer to the pass request retries with backoff", async () => {
  const h = harness({ pass: { ok: false, problem: { kind: "pass_network", detail: "Failed to fetch" } } });
  h.conn.start();
  await flush();
  assert.equal(h.state().kind, "retrying");
  assert.equal(h.timers[0].ms, 1000);
  h.timers[0].fn();
  await flush();
  assert.equal(h.timers[1].ms, 2000);
  assert.deepEqual([1, 2, 3, 4, 5, 6, 9].map(backoffMs), [1000, 2000, 4000, 8000, 16000, 30000, 30000]);
});

await check("a socket that never opens is explained by /health", async () => {
  const cases = [
    [{ kind: "unreachable", detail: "TypeError: Failed to fetch" }, "room_unreachable", true, /could not reach the room at ws:\/\/127\.0\.0\.1:9\/room/],
    [{ kind: "ok", originAllowed: false }, "origin_refused", false, /does not accept connections from http:\/\/127\.0\.0\.1:3000/],
    [{ kind: "ok", originAllowed: true }, "socket_failed", true, /reachable, but the live connection could not be opened/],
    [{ kind: "odd", detail: "HTTP 404" }, "health_odd", true, /health check answered HTTP 404/],
  ];
  for (const [health, kind, retries, text] of cases) {
    const h = harness({ health });
    h.conn.start();
    await flush();
    h.last().drop(1006);
    await flush();
    assert.deepEqual(h.healthAsked, ["http://127.0.0.1:9/health"]);
    assert.equal(h.state().kind, retries ? "retrying" : "stopped", kind);
    assert.equal(h.state().problem.kind, kind);
    assert.match(describeProblem(h.state().problem), text);
    assert.equal(h.offline, 0, "never live, so nobody to send back to wandering");
  }
});

await check("hello, welcome, live; chat refusals keep the connection", async () => {
  const h = harness();
  h.conn.start();
  await flush();
  h.last().open();
  assert.deepEqual(h.last().sent, [{ t: "hello", pass: "p.s" }]);
  assert.equal(h.conn.sendMove(1, 2), false, "nothing is sent before welcome");
  h.last().receive({ t: "welcome", you: 7, x: 1000, y: 600, online: [{ id: 3, x: 1, y: 2 }] });
  assert.deepEqual(h.state(), { kind: "live", you: 7 });
  assert.equal(h.conn.sendMove(10.04, 20), true);
  assert.deepEqual(h.last().sent.at(-1), { t: "move", x: 10, y: 20 });
  h.last().receive({ t: "error", code: "chat_too_fast", message: "too many" });
  assert.deepEqual(h.refused, [{ code: "chat_too_fast", message: "too many" }]);
  assert.equal(h.state().kind, "live");
  assert.deepEqual(h.messages.map((m) => m.t), ["welcome"]);
});

await check("replaced: stopped, no automatic reconnect; Reconnect here starts a fresh attempt", async () => {
  const h = harness();
  h.conn.start();
  await flush();
  h.last().open();
  h.last().receive({ t: "welcome", you: 7, x: 0, y: 0, online: [] });
  h.last().receive({ t: "error", code: "replaced", message: "a newer connection" });
  h.last().drop(4002, "replaced");
  assert.equal(h.state().kind, "stopped");
  assert.equal(h.state().problem.kind, "replaced");
  assert.equal(h.timers.length, 0);
  assert.equal(h.offline, 1);
  h.conn.reconnectNow();
  await flush();
  assert.equal(h.sockets.length, 2);
  assert.equal(h.state().kind, "connecting");
});

await check("close codes after opening map to their reasons", async () => {
  const cases = [
    [4001, { code: "pass_bad_signature", message: "bad sig" }, "pass_rejected", false, /signature does not match/],
    [4001, { code: "pass_expired", message: "expired" }, "pass_rejected", true, /it had expired/],
    [4003, null, "protocol", false, /protocol violation \(close code 4003/],
    [4004, { code: "room_misconfigured", message: "no key" }, "room_misconfigured", false, /misconfigured.*no key/],
    [4005, { code: "hello_timeout", message: "late" }, "hello_timeout", true, /greeting did not arrive in time/],
    [1006, null, "lost", true, /lost \(close code 1006\)/],
    [1001, null, "lost", true, /lost \(close code 1001, “going away”\)/],
  ];
  for (const [code, error, kind, retries, text] of cases) {
    const h = harness();
    h.conn.start();
    await flush();
    h.last().open();
    if (error) h.last().receive({ t: "error", ...error });
    h.last().drop(code, code === 1001 ? "going away" : "");
    await flush();
    assert.equal(h.state().problem.kind, kind, String(code));
    assert.equal(h.state().kind, retries ? "retrying" : "stopped", String(code));
    assert.match(describeProblem(h.state().problem), text);
    assert.equal(h.healthAsked.length, 0, "an opened socket never needs /health");
  }
});

await check("a dropped live connection retries, and old sockets are ignored", async () => {
  const h = harness();
  h.conn.start();
  await flush();
  h.last().open();
  h.last().receive({ t: "welcome", you: 7, x: 0, y: 0, online: [] });
  const old = h.last();
  old.drop(1006);
  assert.equal(h.state().kind, "retrying");
  assert.equal(h.offline, 1);
  h.timers[0].fn();
  await flush();
  assert.equal(h.sockets.length, 2);
  old.receive({ t: "join", id: 9, x: 0, y: 0 });
  assert.equal(h.messages.filter((m) => m.t === "join").length, 0);
  h.last().open();
  h.last().receive({ t: "welcome", you: 7, x: 0, y: 0, online: [] });
  assert.equal(h.state().kind, "live");
});

await check("health URLs", async () => {
  assert.equal(healthUrlFor("wss://room.example.com/room?x=1"), "https://room.example.com/health");
  assert.equal(healthUrlFor("ws://127.0.0.1:8787/room"), "http://127.0.0.1:8787/health");
  assert.equal(healthUrlFor("https://room.example.com/room"), null);
  assert.equal(healthUrlFor("not a url"), null);
});

console.log(JSON.stringify({ result: "PASS", checks: passed }));
