// The official weekly draw's pieces shared by the public page (app/lottery) and the admin page
// (app/admin/lottery/official): times on the server's clock, how a draw is checked, its redraw
// history and its full record. The rules are the server's (src/lottery_draw.rs); nothing here
// decides anything: it only shows what the API returned, and can recompute it to check.
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { DrawResult, OfficialDraw } from "@linkedin-challenge/client";
import { dayRange, zoneName } from "./show";
import type { ShowPeriod } from "./show";
import type { StageEntrant } from "./types";

export const TIMEZONE = "America/Denver";

/** "9:35:00 AM" (or "Fri 20 Nov, 9:35 AM" with `withDay`) in Denver time, from unix seconds. */
export function denverTime(unix: number, { seconds = false, withDay = false } = {}): string {
  const date = new Date(unix * 1000);
  const time = new Intl.DateTimeFormat("en-US", {
    timeZone: TIMEZONE,
    hour: "numeric",
    minute: "2-digit",
    ...(seconds ? { second: "2-digit" } : {}),
  }).format(date);
  if (!withDay) return time;
  const day = new Intl.DateTimeFormat("en-GB", { timeZone: TIMEZONE, weekday: "short", day: "numeric", month: "short" }).format(date);
  return `${day}, ${time}`;
}

/** "Fri 13 Nov – Thu 19 Nov, Mountain time". */
export function weekLabel(firstDay: string, lastDay: string): string {
  return `${dayRange(firstDay, lastDay)}, ${zoneName(TIMEZONE)}`;
}

/**
 * The server's clock, ticking: the page counts down by the server's time, not the viewer's (whose
 * clock may be off, and in tests the server's is pinned). `nowUnix` is the server's time when the
 * answer was made; `receivedAt` is when this browser got it.
 */
export function useServerNow(nowUnix: number | undefined, receivedAt: number): number {
  const [tick, setTick] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setTick(Date.now()), 250);
    return () => window.clearInterval(id);
  }, []);
  if (nowUnix === undefined) return tick / 1000;
  return nowUnix + (tick - receivedAt) / 1000;
}

/** "2:05" / "1:02:05" / "3 days 4 h" until `to` (unix seconds), never negative. */
export function countdown(to: number, now: number): string {
  const left = Math.max(0, Math.ceil(to - now));
  const d = Math.floor(left / 86400);
  const h = Math.floor((left % 86400) / 3600);
  const m = Math.floor((left % 3600) / 60);
  const s = left % 60;
  if (d > 0) return `${d} day${d === 1 ? "" : "s"} ${h} h`;
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  return `${m}:${String(s).padStart(2, "0")}`;
}

const posts = (n: number) => (n === 1 ? "1 post" : `${n} posts`);

/** The pick that stands: the last one. */
export function currentResult(draw: OfficialDraw): DrawResult | undefined {
  return draw.results[draw.results.length - 1];
}

/** The wheel for a pick: its eligible entrants, in list order (the order the index counts in). */
export function wheelFor(draw: OfficialDraw, result: DrawResult): ShowPeriod {
  const byId = new Map(draw.entrants.map((e) => [e.memberId, e]));
  const entrants: StageEntrant[] = result.eligible.flatMap((id) => {
    const e = byId.get(id);
    return e ? [{ memberId: e.memberId, displayName: e.displayName, postCount: e.postCount, avatar: e.avatar }] : [];
  });
  return { entrants, audience: [], isCustomRange: false };
}

function nameOf(draw: OfficialDraw, memberId: number): string {
  return draw.entrants.find((e) => e.memberId === memberId)?.displayName ?? `member ${memberId}`;
}

// --- checking in the browser ---------------------------------------------------------------------

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

interface Recomputed {
  listHash: string;
  listOk: boolean;
  picks: { sequence: number; digest: string; index: number; ok: boolean }[];
}

/** Recompute the list hash and every drawn pick here, with the browser's own SHA-256. */
async function recompute(draw: OfficialDraw): Promise<Recomputed> {
  const listHash = await sha256Hex(draw.listText);
  const picks = [];
  for (const r of draw.results) {
    if (!r.randomness || r.eligible.length === 0) continue;
    const digest = await sha256Hex(`${draw.listHash}:${r.randomness}:${r.sequence}`);
    const index = Number(BigInt(`0x${digest}`) % BigInt(r.eligible.length));
    picks.push({ sequence: r.sequence, digest, index, ok: index === r.winnerIndex && r.eligible[index] === r.winner?.memberId });
  }
  return { listHash, listOk: listHash === draw.listHash, picks };
}

function RecomputeButton({ draw }: { draw: OfficialDraw }) {
  const [state, setState] = useState<{ result: Recomputed } | { error: string } | null>(null);
  const run = useCallback(() => {
    if (!window.crypto?.subtle) {
      setState({ error: "this page has no Web Crypto (crypto.subtle is only available over https or on localhost)" });
      return;
    }
    recompute(draw).then(
      (result) => setState({ result }),
      (error: unknown) => setState({ error: error instanceof Error ? error.message : String(error) }),
    );
  }, [draw]);
  return (
    <div className="draw-recompute">
      <button type="button" className="btn sm draw-recompute-run" onClick={run}>
        Recompute in this browser
      </button>
      {state && "error" in state && <span className="notice err">Recomputing failed: {state.error}</span>}
      {state && "result" in state && (
        <ul className="draw-recompute-out" aria-live="polite">
          <li className={state.result.listOk ? "ok" : "bad"}>
            {state.result.listOk ? "✓" : "✗"} SHA-256 of the list text is {state.result.listHash}
            {state.result.listOk ? ", the published hash." : `, not the published ${draw.listHash}.`}
          </li>
          {state.result.picks.map((p) => (
            <li key={p.sequence} className={p.ok ? "ok" : "bad"}>
              {p.ok ? "✓" : "✗"} Pick {p.sequence}: index {p.index}
              {p.ok ? ", the published winner." : ", which is not the published winner."}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// --- what a draw shows ---------------------------------------------------------------------------

/** The compact "verify this draw" disclosure: everything needed to recompute the winner. */
export function VerifyDraw({ draw, open = false }: { draw: OfficialDraw; open?: boolean }) {
  return (
    <details className="draw-verify" open={open}>
      <summary>Verify this draw</summary>
      <ol className="draw-verify-steps">
        <li>
          <strong>The list</strong>, frozen {denverTime(draw.frozenAtUnix, { seconds: true, withDay: true })}:
          <pre className="draw-list-text">{draw.listText}</pre>
          <div className="draw-kv">
            <span>SHA-256 of that text</span>
            <code className="draw-hash">{draw.listHash}</code>
          </div>
          <p className="small muted">{draw.listFormat}</p>
        </li>
        {draw.results.map((r) => (
          <li key={r.sequence}>
            <strong>{r.sequence === 1 ? "The seed" : `Redraw ${r.sequence - 1}'s seed`}</strong>: drand quicknet round{" "}
            <a href={`https://api.drand.sh/${draw.beacon.chainHash}/public/${r.round}`} target="_blank" rel="noreferrer">
              {r.round}
            </a>
            , published {denverTime(r.roundAtUnix, { seconds: true })}
            {r.randomness ? (
              <div className="draw-kv">
                <span>randomness</span>
                <code className="draw-hash">{r.randomness}</code>
              </div>
            ) : (
              <span className="muted"> (not fetched yet)</span>
            )}
            {r.pickInput && r.pickDigest && r.winnerIndex !== null && r.winner && (
              <>
                <div className="draw-kv">
                  <span>SHA-256 of</span>
                  <code className="draw-hash">{r.pickInput}</code>
                </div>
                <div className="draw-kv">
                  <span>is</span>
                  <code className="draw-hash">{r.pickDigest}</code>
                </div>
                <p className="draw-pick-line">
                  that number mod {r.eligible.length} eligible = <strong>{r.winnerIndex}</strong>, so the winner is entrant{" "}
                  {r.winnerIndex} (from 0) of {r.sequence === 1 ? "the list" : "the list without earlier winners"}:{" "}
                  <strong>{r.winner.displayName}</strong>.
                </p>
              </>
            )}
          </li>
        ))}
        <li>
          <strong>The formula</strong>: {draw.formula}
        </li>
        <li>
          <strong>The beacon</strong>: drand quicknet, chain <code className="draw-hash">{draw.beacon.chainHash}</code> (
          <a href={draw.beacon.infoUrl} target="_blank" rel="noreferrer">
            its public key and schedule
          </a>
          ). This server checked each round&rsquo;s signature against that key before using it.
        </li>
      </ol>
      <RecomputeButton draw={draw} />
    </details>
  );
}

/** Earlier winners, and who redrew and why. Nothing when there were no redraws. */
export function DrawHistory({ draw, redrawnBy }: { draw: OfficialDraw; redrawnBy?: { sequence: number; memberId: number }[] }) {
  if (draw.results.length < 2) return null;
  return (
    <div className="draw-history">
      <h3>Redraws</h3>
      <ol>
        {draw.results.slice(1).map((r) => {
          const replaced = draw.results.find((p) => p.sequence === r.redraw?.replacesSequence);
          const by = redrawnBy?.find((a) => a.sequence === r.sequence);
          return (
            <li key={r.sequence}>
              <strong>{replaced?.winner?.displayName ?? "(no winner)"}</strong>&rsquo;s win was redrawn by{" "}
              <strong>{r.redraw?.byName}</strong>
              {by && <span className="muted"> (member {by.memberId})</span>} on {denverTime(Date.parse(r.requestedAt) / 1000, { withDay: true })}:{" "}
              <q>{r.redraw?.reason}</q>
              {" → "}
              {r.winner ? <strong>{r.winner.displayName}</strong> : <span className="muted">waiting for drand round {r.round}</span>}
            </li>
          );
        })}
      </ol>
    </div>
  );
}

const FROZEN_BY: Record<string, string> = {
  cron: "by the scheduled job",
  "freeze-endpoint": "by a call to the freeze URL",
  "safety-net": "by the first page view after 9:30 (the safety net)",
};

/** One draw's full record: the past results list and the admin page. */
export function DrawDetails({
  draw,
  redrawnBy,
  verifyOpen = false,
  children,
}: {
  draw: OfficialDraw;
  redrawnBy?: { sequence: number; memberId: number }[];
  verifyOpen?: boolean;
  /** The admin page: the list open, and its own picks table and Redraw between it and the proof. */
  children?: ReactNode;
}) {
  const current = currentResult(draw);
  return (
    <article className="draw-details" data-draw-day={draw.schedule.drawDay}>
      <header>
        <h3>{weekLabel(draw.schedule.firstDay, draw.schedule.lastDay)}</h3>
        <p className="draw-winner-line">
          {draw.entrants.length === 0 ? (
            "Nobody posted that week: no winner."
          ) : current?.winner ? (
            <>
              ★ <strong className="draw-winner-name">{current.winner.displayName}</strong> won, from {draw.entrants.length}{" "}
              {draw.entrants.length === 1 ? "entrant" : "entrants"}
              {draw.results.length > 1 && ` (after ${draw.results.length - 1} redraw${draw.results.length > 2 ? "s" : ""})`}.
            </>
          ) : (
            <>No winner yet: {draw.seedProblem ? `the seed is not available (${draw.seedProblem})` : `waiting for drand round ${current?.round}`}.</>
          )}
        </p>
        <p className="small muted">
          Drawn {denverTime(draw.schedule.seedAtUnix, { withDay: true })}. List frozen{" "}
          {denverTime(draw.frozenAtUnix, { seconds: true, withDay: true })} {FROZEN_BY[draw.frozenBy] ?? `(${draw.frozenBy})`}.
        </p>
        {draw.frozenLate && (
          <p className="notice err small">This list was frozen after its seed round had been published, so the seed was public before the list was fixed.</p>
        )}
      </header>
      <DrawHistory draw={draw} redrawnBy={redrawnBy} />
      {draw.entrants.length > 0 && (
        <details className="draw-entrants" open={children !== undefined}>
          <summary>In the draw ({draw.entrants.length})</summary>
          <ul>
            {draw.entrants.map((e) => (
              <li key={e.memberId}>
                {e.displayName} <span className="muted small">{posts(e.postCount)}</span>
                {draw.results.some((r) => r.winner?.memberId === e.memberId) && <span className="badge brand">won</span>}
              </li>
            ))}
          </ul>
        </details>
      )}
      {children}
      <VerifyDraw draw={draw} open={verifyOpen} />
    </article>
  );
}

/** Names for an eligible list, for screen readers and tests. */
export function eligibleNames(draw: OfficialDraw, result: DrawResult): string[] {
  return result.eligible.map((id) => nameOf(draw, id));
}

/** A timer that calls `onDue` once the server clock passes `at` (unix seconds). */
export function useWakeAt(at: number | null, serverOffsetMs: number, onDue: () => void) {
  const due = useRef(onDue);
  due.current = onDue;
  const delay = useMemo(() => (at === null ? null : Math.max(0, at * 1000 - (Date.now() + serverOffsetMs)) + 400), [at, serverOffsetMs]);
  useEffect(() => {
    if (delay === null) return;
    const id = window.setTimeout(() => due.current(), Math.min(delay, 2 ** 31 - 1));
    return () => window.clearTimeout(id);
  }, [delay]);
}
