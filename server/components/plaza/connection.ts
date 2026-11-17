// The plaza's live connection to the room (../../../plaza, a Durable Object), as a small state
// machine with no React and no DOM of its own: the page hands it the ways to get a pass, open a
// socket, probe the room's /health and set timers, and renders `state`. That keeps every reason
// "live mode is unavailable" an explicit, testable value (scripts/test-plaza-connection.mjs runs
// this file under plain node), decided from evidence: the pass response, whether the socket ever
// opened, what /health says, and the room's close code and last error frame.
//
// Wire protocol: plaza-protocol/src/msg.rs (JSON text frames tagged on "t"); close codes and error
// codes: plaza-protocol/src/lib.rs. No imports on purpose (type-only would be fine): node strips
// the types and runs it as is.

// --- the room's messages -----------------------------------------------------------------------

export interface Presence {
  id: number;
  x: number;
  y: number;
}

export type ServerMsg =
  | { t: "welcome"; you: number; x: number; y: number; online: Presence[] }
  | { t: "join"; id: number; x: number; y: number }
  | { t: "leave"; id: number }
  | { t: "move"; id: number; x: number; y: number }
  | { t: "jump"; id: number }
  | { t: "highfive"; a: number; b: number }
  | { t: "chat"; id: number; text: string }
  | { t: "error"; code: string; message: string };

export const CLOSE_PASS_REJECTED = 4001;
export const CLOSE_REPLACED = 4002;
export const CLOSE_PROTOCOL = 4003;
export const CLOSE_ROOM_MISCONFIGURED = 4004;
export const CLOSE_HELLO_TIMEOUT = 4005;
export const CHAT_MAX_CHARS = 80;

// --- why live mode is not on ---------------------------------------------------------------------

export type Problem =
  /** The roster's roomUrl is null. */
  | { kind: "not_configured" }
  /** POST /api/plaza/pass answered 401. */
  | { kind: "signed_out"; body: string }
  /** 503 plaza_key_missing / plaza_key_invalid, with the server's own message. */
  | { kind: "key_missing"; message: string }
  | { kind: "key_invalid"; message: string }
  /** Our host's firewall answered the pass request instead of our server. */
  | { kind: "host_blocked" }
  /** The pass request got no answer at all. */
  | { kind: "pass_network"; detail: string }
  /** Any other answer to the pass request. */
  | { kind: "pass_status"; status: number; body: string }
  /** `new WebSocket(roomUrl)` threw: the URL itself is unusable. */
  | { kind: "bad_url"; url: string; detail: string }
  /** The socket never opened, and GET /health got no answer either. */
  | { kind: "room_unreachable"; url: string; detail: string }
  /** The socket never opened; /health says this page's origin is not allowed. */
  | { kind: "origin_refused"; url: string; origin: string }
  /** The socket never opened, though /health answers and allows this origin. */
  | { kind: "socket_failed"; url: string }
  /** The socket never opened, and /health answered something unexpected. */
  | { kind: "health_odd"; url: string; detail: string }
  /** Closed 4001, after an error frame naming why (pass_malformed / pass_bad_signature / pass_expired). */
  | { kind: "pass_rejected"; code: string; message: string }
  /** Closed 4002: the same member connected again elsewhere. */
  | { kind: "replaced" }
  | { kind: "room_misconfigured"; message: string }
  | { kind: "hello_timeout" }
  | { kind: "protocol"; reason: string }
  /** Closed after opening, any other code (1006 when the network dropped, 1001 room going away...). */
  | { kind: "lost"; code: number; reason: string };

/** Problems another attempt may fix without anyone changing anything (the rest wait for a person). */
export function isTransient(p: Problem): boolean {
  switch (p.kind) {
    case "pass_network":
    case "room_unreachable":
    case "socket_failed":
    case "health_odd":
    case "hello_timeout":
    case "lost":
      return true;
    case "pass_status":
      return p.status >= 500;
    case "pass_rejected":
      // A pass that expired on the way (a slow network) is fine next time; a bad one is not.
      return p.code === "pass_expired";
    default:
      return false;
  }
}

const quote = (s: string) => `“${s}”`;

/** What the page says after "Live mode is unavailable: ". Only what the evidence shows. */
export function describeProblem(p: Problem): string {
  switch (p.kind) {
    case "not_configured":
      return "live mode is not configured on this server (it has no room URL)";
    case "signed_out":
      return `you’re signed out (the server answered 401 to the pass request${p.body ? `: ${quote(p.body)}` : ""}). Sign in again`;
    case "key_missing":
    case "key_invalid":
      return `the server can’t issue plaza passes: ${p.message}`;
    case "host_blocked":
      return "our host paused requests from your network, so no pass could be fetched. Wait a minute, then reload the page";
    case "pass_network":
      return `the Challenge Sync server could not be reached for a pass (${p.detail})`;
    case "pass_status":
      return `the server answered ${p.status} to the pass request${p.body ? `: ${quote(p.body)}` : " with no body"}`;
    case "bad_url":
      return `the room URL ${quote(p.url)} can’t be used (${p.detail})`;
    case "room_unreachable":
      return `could not reach the room at ${p.url} (${p.detail})`;
    case "origin_refused":
      return `the room at ${p.url} does not accept connections from ${p.origin}`;
    case "socket_failed":
      return `the room at ${p.url} is reachable, but the live connection could not be opened`;
    case "health_odd":
      return `the live connection to ${p.url} could not be opened, and the room’s health check answered ${p.detail}`;
    case "pass_rejected": {
      const why =
        p.code === "pass_expired"
          ? "it had expired"
          : p.code === "pass_bad_signature"
            ? "its signature does not match the room’s key"
            : p.code === "pass_malformed"
              ? "it is malformed"
              : `code ${p.code}`;
      return `the room refused this page’s pass: ${why}${p.message ? ` (${quote(p.message)})` : ""}`;
    }
    case "replaced":
      return "you opened the plaza in another tab or window; this one is no longer live";
    case "room_misconfigured":
      return `the room is misconfigured and can’t check passes${p.message ? ` (${quote(p.message)})` : ""}`;
    case "hello_timeout":
      return "the room closed the connection because this page’s greeting did not arrive in time";
    case "protocol":
      return `the room closed the connection for a protocol violation (close code 4003${p.reason ? `, ${quote(p.reason)}` : ""})`;
    case "lost":
      return `the connection to the room was lost (close code ${p.code}${p.reason ? `, ${quote(p.reason)}` : ""})`;
  }
}

/** The room's close code (and the error frame before it, if any) as a problem. */
export function closeProblem(code: number, reason: string, lastError: { code: string; message: string } | null): Problem {
  switch (code) {
    case CLOSE_PASS_REJECTED:
      return { kind: "pass_rejected", code: lastError?.code ?? "unknown", message: lastError?.message ?? reason };
    case CLOSE_REPLACED:
      return { kind: "replaced" };
    case CLOSE_PROTOCOL:
      return { kind: "protocol", reason: lastError?.message ?? reason };
    case CLOSE_ROOM_MISCONFIGURED:
      return { kind: "room_misconfigured", message: lastError?.message ?? reason };
    case CLOSE_HELLO_TIMEOUT:
      return { kind: "hello_timeout" };
    default:
      return { kind: "lost", code, reason };
  }
}

/** What GET <room>/health showed, for a socket that never opened. */
export type Health =
  | { kind: "unreachable"; detail: string }
  | { kind: "ok"; originAllowed: boolean }
  | { kind: "odd"; detail: string };

export function healthProblem(url: string, origin: string, health: Health): Problem {
  if (health.kind === "unreachable") return { kind: "room_unreachable", url, detail: health.detail };
  if (health.kind === "odd") return { kind: "health_odd", url, detail: health.detail };
  return health.originAllowed ? { kind: "socket_failed", url } : { kind: "origin_refused", url, origin };
}

/** ws://host:port/room -> http://host:port/health (wss -> https). Null for a URL that isn't ws(s). */
export function healthUrlFor(roomUrl: string): string | null {
  try {
    const u = new URL(roomUrl);
    if (u.protocol !== "ws:" && u.protocol !== "wss:") return null;
    u.protocol = u.protocol === "wss:" ? "https:" : "http:";
    u.pathname = "/health";
    u.search = "";
    u.hash = "";
    return u.toString();
  } catch {
    return null;
  }
}

/** Seconds before reconnect attempt `n` (1-based): 1, 2, 4, 8, 16, then 30. */
export function backoffMs(n: number): number {
  return Math.min(30_000, 1000 * 2 ** Math.max(0, n - 1));
}

// --- the machine -------------------------------------------------------------------------------

export type ConnState =
  /** Not started (or stopped by the page). */
  | { kind: "idle" }
  /** Getting a pass, opening the socket, or waiting for welcome. `attempt` > 0: a reconnect. */
  | { kind: "connecting"; attempt: number }
  | { kind: "live"; you: number }
  /** Waiting `inMs` from `since` before attempt `attempt`, because of `problem`. */
  | { kind: "retrying"; attempt: number; problem: Problem; since: number; inMs: number }
  /** Not trying again by itself; the page offers a button. */
  | { kind: "stopped"; problem: Problem };

/** The subset of the browser WebSocket this module uses. */
export interface SocketLike {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
  onclose: ((ev: { code: number; reason: string }) => void) | null;
}

export type PassResult = { ok: true; pass: string } | { ok: false; problem: Problem };

export interface ConnectionDeps {
  roomUrl: string | null;
  /** This page's origin, for the "does not accept connections from" message. */
  origin: string;
  requestPass: () => Promise<PassResult>;
  probeHealth: (healthUrl: string) => Promise<Health>;
  openSocket: (url: string) => SocketLike;
  setTimer: (fn: () => void, ms: number) => unknown;
  clearTimer: (handle: unknown) => void;
  now: () => number;
}

export interface ConnectionListener {
  state(state: ConnState): void;
  /** Every room message except error frames (chat refusals arrive through `chatRefused`). */
  message(msg: Exclude<ServerMsg, { t: "error" }>): void;
  /** The live connection ended (everyone who was online goes back to wandering). */
  offline(): void;
  chatRefused(code: string, message: string): void;
}

const CHAT_ERRORS = new Set(["chat_too_long", "chat_too_fast"]);

export class PlazaConnection {
  state: ConnState = { kind: "idle" };
  private socket: SocketLike | null = null;
  private timer: unknown = null;
  /** Bumped on every attempt and stop, so callbacks from an old socket or pass request are ignored. */
  private gen = 0;
  private attempt = 0;
  private readonly deps: ConnectionDeps;
  private readonly listener: ConnectionListener;

  constructor(deps: ConnectionDeps, listener: ConnectionListener) {
    this.deps = deps;
    this.listener = listener;
  }

  /** Starts connecting (no-op while connecting or live). */
  start(): void {
    if (this.state.kind === "connecting" || this.state.kind === "live") return;
    if (!this.deps.roomUrl) {
      this.set({ kind: "stopped", problem: { kind: "not_configured" } });
      return;
    }
    this.attempt = 0;
    void this.connect();
  }

  /** "Try again" / "Reconnect here": a fresh attempt right now, whatever the state. */
  reconnectNow(): void {
    this.dropSocket();
    this.attempt = 0;
    if (!this.deps.roomUrl) {
      this.set({ kind: "stopped", problem: { kind: "not_configured" } });
      return;
    }
    void this.connect();
  }

  /** Leaves the room for good (the page unmounting). */
  stop(): void {
    this.dropSocket();
    this.set({ kind: "idle" });
  }

  sendMove(x: number, y: number): boolean {
    return this.send({ t: "move", x: Math.round(x * 10) / 10, y: Math.round(y * 10) / 10 });
  }
  sendJump(): boolean {
    return this.send({ t: "jump" });
  }
  sendChat(text: string): boolean {
    return this.send({ t: "chat", text });
  }

  private send(msg: object): boolean {
    if (this.state.kind !== "live" || !this.socket) return false;
    try {
      this.socket.send(JSON.stringify(msg));
      return true;
    } catch {
      return false;
    }
  }

  private set(state: ConnState) {
    this.state = state;
    this.listener.state(state);
  }

  private dropSocket() {
    this.gen += 1;
    if (this.timer !== null) {
      this.deps.clearTimer(this.timer);
      this.timer = null;
    }
    const s = this.socket;
    this.socket = null;
    if (s) {
      s.onopen = s.onmessage = s.onerror = s.onclose = null;
      try {
        s.close(1000, "leaving");
      } catch {
        // already closed
      }
      this.listener.offline();
    }
  }

  private async connect(): Promise<void> {
    const gen = ++this.gen;
    const url = this.deps.roomUrl as string;
    this.set({ kind: "connecting", attempt: this.attempt });
    const pass = await this.deps.requestPass();
    if (gen !== this.gen) return;
    if (!pass.ok) return this.fail(pass.problem);

    let socket: SocketLike;
    try {
      socket = this.deps.openSocket(url);
    } catch (error) {
      return this.fail({ kind: "bad_url", url, detail: error instanceof Error ? error.message : String(error) });
    }
    this.socket = socket;
    let opened = false;
    let lastError: { code: string; message: string } | null = null;

    socket.onopen = () => {
      if (gen !== this.gen) return;
      opened = true;
      socket.send(JSON.stringify({ t: "hello", pass: pass.pass }));
    };
    socket.onmessage = (ev) => {
      if (gen !== this.gen) return;
      let msg: ServerMsg;
      try {
        msg = JSON.parse(String(ev.data)) as ServerMsg;
      } catch {
        return; // the room only sends JSON; anything else is ignored like the room ignores ours
      }
      if (!msg || typeof msg !== "object" || typeof msg.t !== "string") return;
      if (msg.t === "error") {
        if (CHAT_ERRORS.has(msg.code)) this.listener.chatRefused(msg.code, msg.message);
        else lastError = { code: msg.code, message: msg.message };
        return;
      }
      if (msg.t === "welcome") {
        this.attempt = 0;
        this.set({ kind: "live", you: msg.you });
      }
      this.listener.message(msg);
    };
    socket.onerror = () => {
      // Always followed by close, which decides what happened.
    };
    socket.onclose = (ev) => {
      if (gen !== this.gen) return;
      this.socket = null;
      const wasLive = this.state.kind === "live";
      if (wasLive || opened) this.listener.offline();
      if (opened) return this.fail(closeProblem(ev.code, ev.reason ?? "", lastError));
      // Never opened: the browser says nothing useful (1006), so ask the room's /health.
      const healthUrl = healthUrlFor(url);
      if (!healthUrl) return this.fail({ kind: "bad_url", url, detail: "not a ws:// or wss:// URL" });
      void this.deps.probeHealth(healthUrl).then((health) => {
        if (gen !== this.gen) return;
        this.fail(healthProblem(url, this.deps.origin, health));
      });
    };
  }

  private fail(problem: Problem) {
    if (isTransient(problem)) {
      this.attempt += 1;
      const inMs = backoffMs(this.attempt);
      const gen = this.gen;
      this.set({ kind: "retrying", attempt: this.attempt, problem, since: this.deps.now(), inMs });
      this.timer = this.deps.setTimer(() => {
        this.timer = null;
        if (gen === this.gen) void this.connect();
      }, inMs);
    } else {
      this.set({ kind: "stopped", problem });
    }
  }
}
