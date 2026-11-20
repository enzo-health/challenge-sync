// The plaza: everyone's avatar in one square. Members who aren't connected wander and bounce about
// on their own (driven here, in the browser); members who have the plaza open are live: they walk
// with the keyboard, jump, high-five and chat, and everyone with the page open sees it through the
// room (../../../plaza, a Durable Object; components/plaza/connection.ts). Live mode is optional:
// without it the plaza still loads, you can still walk about, and a note says exactly why it is
// off. Open to every signed-in member (app/middleware.rs sends everyone else to sign in).
//
// Per-frame state lives in the sim (components/plaza/sim.ts) and refs; React only re-renders when
// someone joins or leaves, the connection changes state, or the chat box opens.
import { Component, type CSSProperties, type ReactNode, Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { useGetPlazaRoster } from "@linkedin-challenge/client/react-query";
import { getCreatePlazaPassUrl, type PlazaRoster } from "@linkedin-challenge/client";
import { HostBlockedError, ServerUnreachableError, errorText } from "../../components/host-block";
import type { AvatarInput } from "../../components/lottery/avatar-model";
import {
  CHAT_MAX_CHARS, type ConnState, type Health, type PassResult, PlazaConnection, type SocketLike, describeProblem,
} from "../../components/plaza/connection";
import { PlazaSim, toWorld } from "../../components/plaza/sim";
import type { FrameStats, PlazaPerson } from "../../components/plaza/scene";

const PlazaStage = lazy(() => import("../../components/plaza/scene"));

// --- small helpers ---------------------------------------------------------------------------

const REDUCED_MOTION = "(prefers-reduced-motion: reduce)";
function useReducedMotion(): boolean {
  return useSyncExternalStore(
    (onChange) => {
      const mq = window.matchMedia(REDUCED_MOTION);
      mq.addEventListener("change", onChange);
      return () => mq.removeEventListener("change", onChange);
    },
    () => window.matchMedia(REDUCED_MOTION).matches,
    () => false,
  );
}

function detectWebGL(): boolean {
  try {
    const canvas = document.createElement("canvas");
    return Boolean(canvas.getContext("webgl2") ?? canvas.getContext("webgl"));
  } catch {
    return false;
  }
}

const DAY = 24 * 60 * 60 * 1000;
const dayFmt = new Intl.DateTimeFormat("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" });
/** "Fri 13 Nov – Thu 19 Nov" from the roster's local dates (weekEnd is the Friday after). */
function weekRange(weekStart: string, weekEnd: string): string {
  return `${dayFmt.format(Date.parse(`${weekStart}T00:00:00Z`))} – ${dayFmt.format(Date.parse(`${weekEnd}T00:00:00Z`) - DAY)}`;
}
function zoneName(timezone: string): string {
  try {
    const part = new Intl.DateTimeFormat("en-US", { timeZone: timezone, timeZoneName: "longGeneric" })
      .formatToParts(new Date())
      .find((p) => p.type === "timeZoneName")?.value;
    if (part) return part.replace(/ Time$/, " time");
  } catch {
    // an unknown zone id: shown as given
  }
  return timezone;
}

/** Stage height: what is left of the window below the stage's top, within bounds. */
function useStageHeight() {
  const [height, setHeight] = useState(560);
  const node = useRef<HTMLDivElement | null>(null);
  const measure = useCallback(() => {
    const el = node.current;
    if (!el) return;
    const top = el.getBoundingClientRect().top + window.scrollY;
    // The control bar (about 66px) goes under the stage, and both should fit on screen.
    const next = Math.round(Math.min(780, Math.max(380, window.innerHeight - top - 66 - 20)));
    setHeight((prev) => (prev === next ? prev : next));
  }, []);
  const ref = useCallback(
    (el: HTMLDivElement | null) => {
      node.current = el;
      measure();
    },
    [measure],
  );
  useEffect(() => {
    const observer = new ResizeObserver(measure);
    const main = document.querySelector("main");
    if (main) observer.observe(main);
    window.addEventListener("resize", measure);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [measure]);
  return { height, ref };
}

class StageBoundary extends Component<{ onError: (error: Error) => void; children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch(error: unknown) {
    this.props.onError(error instanceof Error ? error : new Error(String(error)));
  }
  render() {
    return this.state.failed ? null : this.props.children;
  }
}

// --- the room's ways in ----------------------------------------------------------------------

/** POST /api/plaza/pass, read by hand so a signed-out 401 (text/plain from the root middleware) keeps its status. */
async function requestPass(): Promise<PassResult> {
  let res: Response;
  try {
    res = await fetch(getCreatePlazaPassUrl(), { method: "POST" });
  } catch (error) {
    if (error instanceof HostBlockedError) return { ok: false, problem: { kind: "host_blocked" } };
    const cause = error instanceof ServerUnreachableError ? error.reason : error;
    return { ok: false, problem: { kind: "pass_network", detail: cause instanceof Error ? cause.message : String(cause) } };
  }
  const text = await res.text().catch(() => "");
  let json: { pass?: unknown; error?: unknown; code?: unknown } | undefined;
  try {
    json = JSON.parse(text) as typeof json;
  } catch {
    json = undefined;
  }
  if (res.ok && typeof json?.pass === "string") return { ok: true, pass: json.pass };
  const message = typeof json?.error === "string" ? json.error : text.trim().slice(0, 200);
  if (res.status === 401) return { ok: false, problem: { kind: "signed_out", body: message } };
  if (res.status === 503 && json?.code === "plaza_key_missing") return { ok: false, problem: { kind: "key_missing", message } };
  if (res.status === 503 && json?.code === "plaza_key_invalid") return { ok: false, problem: { kind: "key_invalid", message } };
  return { ok: false, problem: { kind: "pass_status", status: res.status, body: message } };
}

async function probeHealth(url: string): Promise<Health> {
  let res: Response;
  try {
    res = await fetch(url, { mode: "cors", credentials: "omit", cache: "no-store", signal: AbortSignal.timeout(6000) });
  } catch (error) {
    return { kind: "unreachable", detail: error instanceof Error ? `${error.name}: ${error.message}` : String(error) };
  }
  const text = await res.text().catch(() => "");
  try {
    const json = JSON.parse(text) as { ok?: unknown; originAllowed?: unknown };
    if (res.ok && typeof json.originAllowed === "boolean") return { kind: "ok", originAllowed: json.originAllowed };
  } catch {
    // fall through: say what came back
  }
  return { kind: "odd", detail: `HTTP ${res.status}${text ? ` “${text.trim().slice(0, 120)}”` : " with no body"}` };
}

// --- the plaza -------------------------------------------------------------------------------

const MOVE_KEYS: Record<string, [number, number]> = {
  KeyW: [0, -1], ArrowUp: [0, -1], KeyS: [0, 1], ArrowDown: [0, 1],
  KeyA: [-1, 0], ArrowLeft: [-1, 0], KeyD: [1, 0], ArrowRight: [1, 0],
};

/** Where typing belongs to a field (the chat box, or anything else editable on the page). */
function isEditable(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement;
}
/** Enter and Space activate a focused button or link; the plaza leaves those alone. */
function isActivatable(target: EventTarget | null): boolean {
  return target instanceof HTMLButtonElement || target instanceof HTMLAnchorElement || (target instanceof HTMLElement && target.getAttribute("role") === "button");
}

declare global {
  interface Window {
    __plaza?: unknown;
  }
}

const toEntries = (roster: PlazaRoster) => roster.members.map((m) => ({ id: m.id, name: m.name, posted: m.postedThisWeek }));
/** At most one roster fetch this often for ids the room knows and the roster doesn't. */
const UNKNOWN_REFETCH_MS = 5000;

function Plaza({ roster, refetchRoster }: { roster: PlazaRoster; refetchRoster: () => void }) {
  const reducedMotion = useReducedMotion();
  const [webgl] = useState(detectWebGL);
  const [stageError, setStageError] = useState<string | null>(null);
  const fit = useStageHeight();
  // The roster as first loaded: the sim's slots and the scene's instances are laid out from it.
  // The sim is made once, from the first roster; later rosters (refetched on focus, every couple of
  // minutes, and when the room names someone this page doesn't know) update it in place, so nobody
  // jumps and the live connection carries on.
  const [sim] = useState(() => new PlazaSim(toEntries(roster), roster.me));
  const avatars = useRef(new Map<number, AvatarInput | null>());
  const peopleNow = useCallback(
    (): PlazaPerson[] => sim.people.map((p) => ({ id: p.id, name: p.name, avatar: avatars.current.get(p.id) ?? null })),
    [sim],
  );
  const [people, setPeople] = useState<PlazaPerson[]>(() => {
    for (const m of roster.members) avatars.current.set(m.id, (m.avatar as AvatarInput | null) ?? null);
    return peopleNow();
  });
  const rosterRef = useRef(roster);
  useEffect(() => {
    if (rosterRef.current === roster) return;
    rosterRef.current = roster;
    for (const m of roster.members) avatars.current.set(m.id, (m.avatar as AvatarInput | null) ?? null);
    sim.upsert(toEntries(roster));
    setPeople(peopleNow());
  }, [roster, sim, peopleNow]);
  // Someone the room knows and the roster doesn't: drawn at once (default look, no name), and the
  // roster is fetched again (also on every join, which may carry a changed avatar), at most every UNKNOWN_REFETCH_MS.
  const refetchRef = useRef(refetchRoster);
  refetchRef.current = refetchRoster;
  const unknown = useRef({ last: 0, timer: 0 });
  const noteUnknown = useCallback(() => {
    setPeople(peopleNow());
    const u = unknown.current;
    if (u.timer) return;
    const wait = Math.max(0, u.last + UNKNOWN_REFETCH_MS - Date.now());
    u.timer = window.setTimeout(() => {
      u.timer = 0;
      u.last = Date.now();
      refetchRef.current();
    }, wait);
  }, [peopleNow]);
  useEffect(() => () => window.clearTimeout(unknown.current.timer), []);
  const [stats] = useState<FrameStats>(() => ({ frames: new Float32Array(240), count: 0, drawCalls: 0, triangles: 0 }));
  const [conn, setConn] = useState<ConnState>({ kind: "idle" });
  const [onlineIds, setOnlineIds] = useState<number[]>([]);
  const [chatOpen, setChatOpen] = useState(false);
  const [chatNote, setChatNote] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const connection = useRef<PlazaConnection | null>(null);
  const stageEl = useRef<HTMLDivElement | null>(null);
  const chatInput = useRef<HTMLInputElement>(null);
  const lastSent = useRef<{ x: number; y: number } | null>(null);
  const meName = roster.members.find((m) => m.id === roster.me)?.name ?? "You";
  const nameOf = useCallback((id: number) => sim.byId.get(id)?.name || null, [sim]);
  const showStage = webgl && stageError === null;

  // The live connection (only with a stage to show it on).
  useEffect(() => {
    if (!showStage) return;
    const c = new PlazaConnection(
      {
        roomUrl: roster.roomUrl,
        origin: window.location.origin,
        requestPass,
        probeHealth,
        openSocket: (url) => new WebSocket(url) as unknown as SocketLike,
        setTimer: (fn, ms) => window.setTimeout(fn, ms),
        clearTimer: (h) => window.clearTimeout(h as number),
        now: () => Date.now(),
      },
      {
        state: (s) => {
          if (s.kind === "live") lastSent.current = null; // tell the room where we are right away
          setConn(s);
        },
        message: (msg) => {
          const ids = msg.t === "welcome" ? msg.online.map((o) => o.id) : msg.t === "highfive" ? [msg.a, msg.b] : [msg.id];
          const strangers = msg.t !== "leave" && ids.some((id) => !sim.byId.has(id));
          switch (msg.t) {
            case "welcome":
              for (const o of msg.online) sim.appear(o.id, o.x, o.y);
              setOnlineIds(msg.online.map((o) => o.id));
              break;
            case "join":
              sim.appear(msg.id, msg.x, msg.y);
              setOnlineIds((ids) => (ids.includes(msg.id) ? ids : [...ids, msg.id]));
              break;
            case "leave":
              sim.leave(msg.id);
              setOnlineIds((ids) => ids.filter((id) => id !== msg.id));
              break;
            case "move":
              sim.moveTo(msg.id, msg.x, msg.y);
              setOnlineIds((ids) => (ids.includes(msg.id) ? ids : [...ids, msg.id]));
              break;
            case "jump":
              sim.ensure(msg.id);
              sim.jump(msg.id);
              break;
            case "highfive": {
              sim.ensure(msg.a);
              sim.ensure(msg.b);
              sim.highFive(msg.a, msg.b);
              if (msg.a === sim.meId || msg.b === sim.meId) {
                const other = nameOf(msg.a === sim.meId ? msg.b : msg.a) ?? "someone";
                setAnnouncement(`High five with ${other}!`);
              }
              break;
            }
            case "chat":
              sim.say(msg.id, msg.text);
              setAnnouncement(`${nameOf(msg.id) ?? "Someone"} says: ${msg.text}`);
              break;
          }
          // A join may be someone back from /me/avatar with a new look: fetch the roster again too.
          if (strangers || msg.t === "join") noteUnknown();
        },
        offline: () => {
          sim.allLeave();
          setOnlineIds([]);
        },
        chatRefused: (code, message) => {
          // The room didn't pass it on, so nobody else saw the bubble: take it down.
          const me = sim.me;
          if (me) me.bubble = null;
          setChatNote(
            code === "chat_too_fast"
              ? `Not sent: you’re chatting too fast (the room says “${message}”).`
              : `Not sent: that message is too long (the room says “${message}”).`,
          );
        },
      },
    );
    connection.current = c;
    c.start();
    return () => {
      c.stop();
      connection.current = null;
    };
  }, [showStage, roster.roomUrl, sim, nameOf, noteUnknown]);

  // Tell the room where I am about ten times a second, only when it changed.
  useEffect(() => {
    const timer = window.setInterval(() => {
      const c = connection.current;
      if (!c || c.state.kind !== "live") return;
      const at = sim.myWorld();
      const last = lastSent.current;
      if (!at || (last && Math.abs(last.x - at.x) < 0.5 && Math.abs(last.y - at.y) < 0.5)) return;
      if (c.sendMove(at.x, at.y)) lastSent.current = at;
    }, 100);
    return () => window.clearInterval(timer);
  }, [sim]);

  // Keyboard: walk, jump, open the chat box. Never while typing in a field.
  useEffect(() => {
    const held = new Set<string>();
    const apply = () => {
      let x = 0;
      let z = 0;
      for (const k of held) {
        const d = MOVE_KEYS[k];
        if (d) {
          x += d[0];
          z += d[1];
        }
      }
      sim.input = { x: Math.sign(x), z: Math.sign(z) };
    };
    const keyOf = (e: KeyboardEvent) => (e.code in MOVE_KEYS ? e.code : e.key in MOVE_KEYS ? e.key : null);
    const down = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey || isEditable(e.target)) return;
      const k = keyOf(e);
      if (k) {
        held.add(k);
        apply();
        e.preventDefault();
        return;
      }
      if (isActivatable(e.target)) return;
      if (e.key === " " || e.code === "Space") {
        e.preventDefault();
        if (e.repeat || !sim.canJump(sim.meId)) return;
        sim.jump(sim.meId);
        connection.current?.sendJump();
      } else if (e.key === "Enter") {
        e.preventDefault();
        held.clear();
        apply();
        setChatNote(null);
        setChatOpen(true);
      }
    };
    const up = (e: KeyboardEvent) => {
      const k = keyOf(e);
      if (k && held.delete(k)) apply();
    };
    const clear = () => {
      held.clear();
      apply();
    };
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    window.addEventListener("blur", clear);
    // Typing starts in a field: let go of any held walking keys (their keyup goes to the field).
    const focusIn = (e: FocusEvent) => {
      if (isEditable(e.target)) clear();
    };
    window.addEventListener("focusin", focusIn);
    return () => {
      window.removeEventListener("focusin", focusIn);
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
      window.removeEventListener("blur", clear);
    };
  }, [sim]);

  useEffect(() => {
    if (chatOpen) chatInput.current?.focus({ preventScroll: true });
  }, [chatOpen]);

  const closeChat = () => {
    setChatOpen(false);
    stageEl.current?.focus({ preventScroll: true });
  };
  const sendChat = (raw: string) => {
    const text = raw.replace(/\p{Cc}/gu, "").trim();
    if (!text) return closeChat();
    sim.say(sim.meId, text);
    const sent = connection.current?.sendChat(text) ?? false;
    setChatNote(sent ? null : "Only you can see that: live mode is off, so it wasn’t sent to anyone.");
    closeChat();
  };

  // The read-only debug handle (tests and the curious): nothing the page doesn't already show.
  useEffect(() => {
    const world = (id: number) => {
      const p = sim.byId.get(id);
      return p ? { ...toWorld(p.x, p.z), mode: p.mode } : null;
    };
    window.__plaza = {
      get state() {
        return connection.current?.state ?? { kind: "idle" };
      },
      get note() {
        return document.querySelector(".plaza-note")?.textContent ?? "";
      },
      me: sim.meId,
      get online() {
        return sim.people.filter((p) => p.mode === "online").map((p) => p.id);
      },
      get wandering() {
        return sim.people.filter((p) => p.mode === "wander").map((p) => p.id);
      },
      position: world,
      get bubbles() {
        return Object.fromEntries(sim.people.filter((p) => p.bubble).map((p) => [p.id, p.bubble]));
      },
      /** The saved avatar this page draws someone from (null: their generated look). */
      avatarOf: (id: number) => avatars.current.get(id) ?? null,
      get stars() {
        return sim.people.filter((p) => p.posted).map((p) => p.id);
      },
      get highFives() {
        return sim.highFives;
      },
      get jumping() {
        return sim.people.filter((p) => sim.t - p.jumpAt >= 0 && sim.t - p.jumpAt < 0.62).map((p) => p.id);
      },
      get frame() {
        const n = Math.min(stats.count, stats.frames.length);
        const list = [...stats.frames.slice(0, n)].sort((a, b) => a - b);
        const at = (q: number) => (n ? Math.round(list[Math.min(n - 1, Math.floor(q * n))] * 10) / 10 : null);
        return { frames: stats.count, sampled: n, p50Ms: at(0.5), p95Ms: at(0.95), avgMs: n ? Math.round((list.reduce((a, b) => a + b, 0) / n) * 10) / 10 : null, drawCalls: stats.drawCalls, triangles: stats.triangles };
      },
    };
    return () => {
      delete window.__plaza;
    };
  }, [sim, stats]);

  const live = conn.kind === "live";
  const onlineCount = live ? onlineIds.length + 1 : 0;
  const reconnecting = (conn.kind === "connecting" && conn.attempt > 0) || conn.kind === "retrying";

  const status = live ? (
    <span className="plaza-status live">
      <span className="dot" aria-hidden="true" /> Live · {onlineCount === 1 ? "just you online" : `${onlineCount} online`}
    </span>
  ) : conn.kind === "connecting" ? (
    <span className="plaza-status">{reconnecting ? "Reconnecting…" : "Connecting…"}</span>
  ) : conn.kind === "retrying" ? (
    <span className="plaza-status off">Reconnecting…</span>
  ) : (
    <span className="plaza-status off">Not live · everyone is wandering</span>
  );

  const note =
    conn.kind === "retrying" || conn.kind === "stopped" ? (
      <div className="notice warn plaza-note" role="status">
        <strong>Live mode is unavailable:</strong> {describeProblem(conn.problem)}.{" "}
        {conn.kind === "retrying" ? (
          <>
            Reconnecting in {Math.round(conn.inMs / 1000)} s (attempt {conn.attempt + 1}).{" "}
            <button type="button" className="btn ghost sm" onClick={() => connection.current?.reconnectNow()}>
              Try now
            </button>
          </>
        ) : conn.problem.kind === "replaced" ? (
          <button type="button" className="btn sm" onClick={() => connection.current?.reconnectNow()}>
            Reconnect here
          </button>
        ) : conn.problem.kind === "not_configured" ? (
          "You can still walk around; everyone else wanders on their own."
        ) : (
          <button type="button" className="btn ghost sm" onClick={() => connection.current?.reconnectNow()}>
            Try again
          </button>
        )}
      </div>
    ) : null;

  const label = `The plaza: ${roster.members.length} members' avatars on a town square. ${
    live ? `${onlineCount} online, including you.` : "Live mode is off; everyone else wanders on their own."
  }`;

  return (
    <>
      {note}
      {showStage ? (
        <div
          className="plaza-stage-wrap"
          ref={(el) => {
            fit.ref(el);
            stageEl.current = el;
          }}
          tabIndex={-1}
          style={{ "--plaza-h": `${fit.height}px` } as CSSProperties}
        >
          <div className="plaza-stage">
            <StageBoundary onError={(e) => setStageError(e.message || e.name)}>
              <Suspense fallback={<div className="plaza-loading">Setting up the plaza…</div>}>
                <PlazaStage sim={sim} people={people} onlineIds={onlineIds} reducedMotion={reducedMotion} label={label} stats={stats} />
              </Suspense>
            </StageBoundary>
            <div className="plaza-legend" aria-hidden="true">
              <span><i className="ring me" /> you</span>
              <span><i className="ring online" /> online now</span>
              <span><i className="ring none" /> wandering on their own</span>
              <span><span className="plaza-star">★</span> posted this week</span>
            </div>
          </div>
          <div className="plaza-bar">
            {status}
            {chatOpen ? (
              <form
                className="plaza-chat"
                onSubmit={(e) => {
                  e.preventDefault();
                  sendChat(chatInput.current?.value ?? "");
                }}
              >
                <input
                  ref={chatInput}
                  type="text"
                  maxLength={CHAT_MAX_CHARS}
                  placeholder="Say something (Enter sends, Esc cancels)"
                  aria-label="Chat message"
                  autoComplete="off"
                  onKeyDown={(e) => {
                    if (e.key === "Escape") {
                      e.preventDefault();
                      closeChat();
                    }
                  }}
                  onBlur={() => setChatOpen(false)}
                />
              </form>
            ) : (
              <p className="plaza-help">
                <kbd>W</kbd><kbd>A</kbd><kbd>S</kbd><kbd>D</kbd> or arrows to walk · <kbd>Space</kbd> to jump ·{" "}
                <kbd>Enter</kbd> to chat · <strong>Jump next to someone at the same time to high five</strong>
              </p>
            )}
            {chatNote && <span className="plaza-chat-note" role="status">{chatNote}</span>}
          </div>
        </div>
      ) : (
        <div className="lottery-fallback">
          <p>
            <strong>The 3D plaza can&rsquo;t run here:</strong>{" "}
            {stageError !== null ? `it stopped with “${stageError}”` : "this browser has WebGL turned off or unavailable"}.
          </p>
        </div>
      )}
      <div className="sr-only" role="status" aria-live="polite">
        {announcement}
      </div>
      <section className="panel plaza-roster">
        <h2>Everyone here ({roster.members.length})</h2>
        <ul>
          {roster.members.map((m) => (
            <li key={m.id} data-id={m.id} className={m.id === roster.me ? "me" : onlineIds.includes(m.id) ? "online" : undefined}>
              <span className="who-name" title={m.name}>
                {m.name}
                {m.id === roster.me && <span className="muted"> (you)</span>}
              </span>
              {m.postedThisWeek && (
                <span className="plaza-star" title="Posted on LinkedIn this week" aria-label="posted on LinkedIn this week">
                  ★
                </span>
              )}
              {live && (m.id === roster.me || onlineIds.includes(m.id)) && <span className="badge ok">online</span>}
            </li>
          ))}
        </ul>
        <p className="small muted">Signed in as {meName}.</p>
      </section>
    </>
  );
}

export default function PlazaPage() {
  // Loaded once: the scene is laid out from it (a refetch would only move nothing).
  // Fetched on every visit (so an avatar just saved on /me/avatar shows), again when the window
  // regains focus and every two minutes; each answer updates the plaza in place.
  const { data, isLoading, error, refetch } = useGetPlazaRoster({
    query: { staleTime: 0, refetchOnMount: "always", refetchOnWindowFocus: true, refetchInterval: 120_000 },
  });
  const head = (week?: PlazaRoster["week"]) => (
    <div className="plaza-head">
      <h1 className="lottery-title">Plaza</h1>
      <p className="muted">
        Walk around with everyone&rsquo;s avatar. People who have this page open are live; everyone else wanders about
        on their own. <span className="plaza-star">★</span> means they posted on LinkedIn this week
        {week ? ` (${weekRange(week.weekStart, week.weekEnd)}, ${zoneName(week.timezone)})` : ""}.{" "}
        <a href="/me/avatar">Change your avatar</a>
      </p>
    </div>
  );

  if (isLoading) {
    return (
      <div className="plaza-page">
        {head()}
        <div className="spinner">Loading…</div>
      </div>
    );
  }
  if (error) {
    return (
      <div className="plaza-page">
        {head()}
        <div className="notice err">{errorText(error, `Loading the plaza failed: ${error instanceof Error ? error.message : String(error)}`)}</div>
      </div>
    );
  }
  if (data?.status === 401) {
    return (
      <div className="empty">
        Your session expired. <a href="/auth/login">Log in again</a>.
      </div>
    );
  }
  if (data?.status !== 200) {
    return (
      <div className="plaza-page">
        {head()}
        <div className="notice err">Loading the plaza failed: the server answered {String((data as { status?: number } | undefined)?.status)}.</div>
      </div>
    );
  }
  return (
    <div className="plaza-page">
      {head(data.data.week)}
      <Plaza roster={data.data} refetchRoster={() => void refetch()} />
    </div>
  );
}
