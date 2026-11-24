// The weekly lottery's show, shared by the admin page (app/admin/lottery/page.tsx) and its
// presenter view (app/admin/lottery/present/page.tsx): the period in the URL and the API call for
// it, how the period is named, and one period's draw. The draw happens here, in the browser, with
// crypto.getRandomValues (draw.ts) BEFORE the wheel moves; the 3D stage (stage.tsx, loaded lazily
// so three.js only downloads on these pages) just performs it.
import { Component, type CSSProperties, type ReactNode, Suspense, lazy, useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { keepPreviousData } from "@tanstack/react-query";
import { parseAsString, useQueryStates } from "nuqs";
import { useGetAdminLottery } from "@linkedin-challenge/client/react-query";
import type { LotteryPeriodEntrants } from "@linkedin-challenge/client";
import { drawWinnerIndex } from "./draw";
import type { ShowPhase, SpinRequest, StageEntrant, StagePerson } from "./types";
import { errorText } from "../host-block";

const LotteryStage = lazy(() => import("./stage"));

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

/** Whether this browser can make a WebGL context at all (checked once, before mounting three.js). */
function detectWebGL(): boolean {
  try {
    const canvas = document.createElement("canvas");
    return Boolean(canvas.getContext("webgl2") ?? canvas.getContext("webgl"));
  } catch {
    return false;
  }
}

/** Height of the control bar along the stage's bottom edge; the camera keeps the scene above it. */
const BAR_HEIGHT = 76;
const BAR_HEIGHT_TWO_ROWS = 112;
const STAGE_MIN = 340;
const STAGE_MAX = 760;

/**
 * Size the stage. On the admin page: to what's left of the viewport below it (the sync banner, the
 * solo note and the week picker all push it down), so the wheel and its Spin button fit on one
 * screen. In the presenter view (`fill`): the whole window. `compact` swaps the big winner banner
 * for the line in the control bar when the stage is small or narrow.
 */
function useStageFit(fill: boolean) {
  const [state, setState] = useState({ height: 600, compact: false, narrow: false });
  const node = useRef<HTMLDivElement | null>(null);
  const measure = useCallback(() => {
    const el = node.current;
    if (!el) return;
    let height: number;
    if (fill) {
      height = window.innerHeight;
    } else {
      const top = el.getBoundingClientRect().top + window.scrollY;
      const below = window.innerHeight - top - 16;
      // Too little room under the header (phones, tall banners): take a whole screen instead, and
      // Spin scrolls the stage into view (see scrollIntoView below).
      // A narrow stage is width-bound (the scene is wider than tall), so extra height is just sky.
      const cap = Math.min(STAGE_MAX, Math.max(STAGE_MIN, el.clientWidth * 1.15 + BAR_HEIGHT_TWO_ROWS));
      height = Math.round(Math.min(cap, below >= 460 ? below : Math.max(STAGE_MIN, window.innerHeight - 24)));
    }
    const compact = el.clientWidth < 860 || height < 520;
    const narrow = el.clientWidth < 520; // the bar's winner line takes its own row
    setState((prev) =>
      prev.height === height && prev.compact === compact && prev.narrow === narrow ? prev : { height, compact, narrow },
    );
  }, [fill]);
  const ref = useCallback(
    (el: HTMLDivElement | null) => {
      node.current = el;
      measure();
    },
    [measure],
  );
  useEffect(() => {
    // Anything above the stage can change size after load (banners arrive asynchronously).
    const observer = new ResizeObserver(measure);
    const main = document.querySelector("main");
    if (main) observer.observe(main);
    window.addEventListener("resize", measure);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [measure]);
  /** Bring the whole stage, control bar included, on screen (a no-op when it already is). */
  const reveal = useCallback(() => {
    node.current?.scrollIntoView({ block: "nearest", behavior: "auto" });
  }, []);
  return { ...state, ref, reveal };
}

export const dayFmt = new Intl.DateTimeFormat("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" });

/** "Fri 13 Nov – Thu 19 Nov" from the API's local dates (both included); one day is just "Fri 20 Nov". */
export function dayRange(firstDay: string, lastDay: string): string {
  const start = Date.parse(`${firstDay}T00:00:00Z`);
  const last = Date.parse(`${lastDay}T00:00:00Z`);
  const startYear = new Date(start).getUTCFullYear();
  const lastYear = new Date(last).getUTCFullYear();
  const thisYear = new Date().getFullYear();
  const withYear = (t: number, y: number, show: boolean) => (show ? `${dayFmt.format(t)} ${y}` : dayFmt.format(t));
  const showYears = startYear !== lastYear || lastYear !== thisYear;
  if (start === last) return withYear(last, lastYear, showYears);
  return `${withYear(start, startYear, startYear !== lastYear)} – ${withYear(last, lastYear, showYears)}`;
}

/** "Mountain time" for America/Denver, from the browser's own zone names. */
export function zoneName(timezone: string): string {
  try {
    const part = new Intl.DateTimeFormat("en-US", { timeZone: timezone, timeZoneName: "longGeneric" })
      .formatToParts(new Date())
      .find((p) => p.type === "timeZoneName")?.value;
    if (part) return part.replace(/ Time$/, " time");
  } catch {
    // An unknown zone id: show it as given.
  }
  return timezone;
}

const posts = (n: number) => (n === 1 ? "1 post" : `${n} posts`);

/** How the page speaks about the period: "this week" for a Friday–Thursday week, "in this range" otherwise. */
const periodWords = (customRange: boolean) => (customRange ? "in this range" : "this week");

// --- the period ------------------------------------------------------------------------------

/**
 * The period in the URL, so a draw can be linked: `week` (a Friday), or `from` and `to` (a custom
 * range, both days included); none of them means the latest complete Friday–Thursday week. And the
 * API's answer for it.
 */
export function useLotteryPeriod() {
  const [{ week, from, to }, setPeriod] = useQueryStates({ week: parseAsString, from: parseAsString, to: parseAsString });
  const params = week || from || to ? { ...(week ? { week } : {}), ...(from ? { from } : {}), ...(to ? { to } : {}) } : undefined;
  const query = useGetAdminLottery(params, { query: { placeholderData: keepPreviousData } });
  return { week, from, to, setPeriod, ...query };
}

/** The query string naming exactly the period shown: `?week=<its Friday>` or `?from=…&to=…`. */
export function periodSearch(w: LotteryPeriodEntrants): string {
  const q = w.isCustomRange ? new URLSearchParams({ from: w.firstDay, to: w.lastDay }) : new URLSearchParams({ week: w.firstDay });
  return `?${q}`;
}

/** "custom range" · "Fri 13 Nov – Thu 19 Nov, Mountain time" · "in progress", as they apply. */
export function PeriodLabel({ w, children }: { w: LotteryPeriodEntrants; children?: ReactNode }) {
  return (
    <div className="lottery-week-label" aria-live="polite">
      {w.isCustomRange && <span className="badge brand lottery-range-badge">custom range</span>}
      <span>
        <strong>{dayRange(w.firstDay, w.lastDay)}</strong>, {zoneName(w.timezone)}
      </span>
      {!w.isComplete && <span className="badge muted">in progress</span>}
      {children}
    </div>
  );
}

/**
 * What to show instead of the draw while it loads or when the API didn't give one: the server's own
 * message for a period it refused (400), what failed for a request that didn't complete. `null`
 * once there is a period to show.
 */
export function lotteryProblem(
  query: Pick<ReturnType<typeof useLotteryPeriod>, "isLoading" | "error" | "data">,
  latest: ReactNode,
): ReactNode | null {
  const { isLoading, error, data } = query;
  if (isLoading) return <div className="spinner">Loading…</div>;
  if (error) {
    return <div className="notice err">{errorText(error, `Loading the draw failed: ${error instanceof Error ? error.message : String(error)}`)}</div>;
  }
  if (data?.status === 400) {
    return (
      <>
        <div className="notice err">{data.data.error}</div>
        {latest}
      </>
    );
  }
  if (data?.status !== 200) {
    return (
      <div className="empty">
        Your session expired. <a href="/auth/login">Log in again</a>.
      </div>
    );
  }
  return null;
}

// --- the stage, guarded ----------------------------------------------------------------------

/** Catches a stage that fails to start (no WebGL context, a failed chunk download, a GPU error). */
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

function WinnerBanner({ winner, overlay, when }: { winner: StageEntrant; overlay: boolean; when: string }) {
  return (
    <div className={`lottery-banner${overlay ? " overlay" : ""}`}>
      <div className="lottery-banner-kicker">{when === "this week" ? <>★ This week&rsquo;s winner ★</> : "★ The winner ★"}</div>
      <div className="lottery-banner-name">{winner.displayName}</div>
      <div className="lottery-banner-meta">
        {posts(winner.postCount)} {when}
      </div>
    </div>
  );
}

// --- one period's show -----------------------------------------------------------------------

/**
 * One period's draw. `presenter`: the bare full-window version (no lists, no "not in the draw"
 * line; the one-entrant and nobody-posted notes sit over the stage instead of above it).
 */
export function LotteryShow({ week, stale, presenter = false }: { week: LotteryPeriodEntrants; stale: boolean; presenter?: boolean }) {
  const reducedMotion = useReducedMotion();
  const [webgl] = useState(detectWebGL);
  const entrants: StageEntrant[] = week.entrants; // the API sorts by name: that is the wheel order
  const audience: StagePerson[] = week.audience; // the crowd, excluded posters included
  const when = periodWords(week.isCustomRange);
  // Posted in the period but left out of the draw by an admin (set on the member's page).
  const excluded = week.audience.filter((p) => p.excluded);
  const didNotPost = week.audience.filter((p) => !p.excluded);
  const [phase, setPhase] = useState<ShowPhase>("ready");
  const [spin, setSpin] = useState<SpinRequest | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const [stageError, setStageError] = useState<string | null>(null);
  const fit = useStageFit(presenter);
  const { reveal } = fit;
  const winner = spin && phase === "won" ? entrants[spin.winnerIndex] : undefined;
  const n = entrants.length;
  const showStage = webgl && stageError === null && (n > 0 || audience.length > 0);
  const spinRef = useRef(spin);
  spinRef.current = spin;
  // One draw per Reset. Set synchronously on the first Spin, so a double click or a held key
  // (several clicks before React re-renders the button as disabled) cannot start a second draw;
  // only Reset clears it.
  const drawn = useRef(false);

  const finish = useCallback(
    (index: number) => {
      const w = entrants[index];
      setPhase("won");
      setAnnouncement(`The winner is ${w.displayName}, with ${posts(w.postCount)} ${when}.`);
      reveal(); // in case something above (a late banner) pushed the stage down mid-spin
    },
    [entrants, reveal, when],
  );

  const onSpinEnd = useCallback(
    (id: number) => {
      const current = spinRef.current;
      if (current?.id === id) finish(current.winnerIndex);
    },
    [finish],
  );

  const doSpin = () => {
    if (n === 0 || stale || drawn.current) return;
    drawn.current = true;
    // The draw: uniform over the entrants, decided now; the wheel animates to it afterwards.
    const winnerIndex = drawWinnerIndex(entrants);
    const request = { id: (spinRef.current?.id ?? 0) + 1, winnerIndex };
    setSpin(request);
    if (showStage) {
      fit.reveal();
      setPhase("spinning");
      setAnnouncement("Spinning the wheel…");
    } else {
      finish(winnerIndex); // no stage to watch: straight to the result
    }
  };

  const reset = () => {
    drawn.current = false;
    setPhase("ready");
    setAnnouncement("Reset. Ready for a new draw.");
  };

  const label =
    n === 0
      ? `The lottery stage is empty: nobody posted ${when}.${audience.length ? ` ${audience.length} people wait in the crowd.` : ""}`
      : `The lottery stage: ${n === 1 ? "one entrant" : `${n} entrants`} with their names above their heads, in front of a prize wheel with a slice for each.` +
        (audience.length ? ` ${audience.length} more people watch from the crowd.` : "") +
        (winner ? ` The wheel stopped on ${winner.displayName}.` : "");

  // Spin, or after a win only a small Reset off to the side: there is deliberately no "spin again",
  // so a second draw always takes a Reset first. With a stage they sit in a bar along its bottom
  // edge, so the wheel and the button are always on screen together; the bar is outside the
  // role="img" wrapper.
  const controls = (
    <div className={`lottery-controls${showStage ? " in-stage" : ""}`}>
      {winner && (
        <div className="lottery-bar-winner" aria-hidden="true">
          <span className="star">★</span> <strong>{winner.displayName}</strong> wins! <span className="muted">{posts(winner.postCount)}</span>
        </div>
      )}
      {phase === "won" ? (
        <div className="lottery-buttons side">
          <button type="button" className="btn lottery-reset" onClick={reset} title="Clears this result; the wheel can then be spun again">
            Reset
          </button>
        </div>
      ) : (
        <div className="lottery-buttons">
          <button type="button" className="btn lottery-go" onClick={doSpin} disabled={phase === "spinning" || stale}>
            {phase === "spinning" ? "Spinning…" : n === 1 ? "Spin for the ceremony" : "Spin the wheel"}
          </button>
        </div>
      )}
    </div>
  );

  const fallback = (reason: string) => (
    <div className="lottery-fallback">
      <p>
        <strong>The 3D stage can&rsquo;t run here:</strong> {reason}. The draw works the same without it;
        the result appears below.
      </p>
      {winner && <WinnerBanner winner={winner} overlay={false} when={when} />}
    </div>
  );

  const solo = n === 1 && (
    <div className="notice lottery-solo">
      Only <strong>{entrants[0].displayName}</strong> posted {when}, so they win by default. Give the
      wheel a spin anyway, for the ceremony.
    </div>
  );
  const empty = n === 0 && (
    <div className="lottery-empty">
      <h2>{week.isCustomRange ? "No draw for this range" : "No draw this week"}</h2>
      <p>
        {excluded.length > 0
          ? `Only people left out of the draw published an original post ${when}, so the wheel stays in its box.`
          : `Nobody published an original post ${when}, so the wheel stays in its box.`}
        {audience.length > 0 && " The crowd turned up anyway."}
      </p>
    </div>
  );
  // In the presenter view the notes float over the stage's top-left corner, where the winner
  // banner later appears (the solo note gives way to it).
  const presenterNote = presenter && showStage && (empty || (!winner && solo)) && (
    <div className="lottery-present-note">{empty || solo}</div>
  );

  return (
    <>
      {!presenter && excluded.length > 0 && (
        <p className="small lottery-excluded">
          <strong>Not in the draw:</strong> {excluded.map((p) => p.displayName).join(", ")}
        </p>
      )}
      {!(presenter && showStage) && solo}
      {!(presenter && showStage) && empty}

      {showStage && (
        <div
          className={`lottery-stage-wrap${fit.compact ? " compact" : ""}${fit.narrow ? " narrow" : ""}${n > 0 ? " has-bar" : ""}`}
          ref={fit.ref}
          style={{ "--stage-h": `${fit.height}px` } as CSSProperties}
        >
          <StageBoundary
            onError={(error) => {
              // Keep the page usable: drop to the text-only draw, saying what broke.
              setStageError(error.message || error.name);
              if (phase === "spinning" && spinRef.current) finish(spinRef.current.winnerIndex);
            }}
          >
            <Suspense fallback={<div className="lottery-stage loading">Setting up the stage…</div>}>
              <LotteryStage
                entrants={entrants}
                audience={audience}
                phase={phase}
                spin={spin}
                reducedMotion={reducedMotion}
                onSpinEnd={onSpinEnd}
                label={label}
                notPosted={`didn’t post ${when}`}
                bottomInset={n === 0 ? 0 : fit.narrow && winner ? BAR_HEIGHT_TWO_ROWS : BAR_HEIGHT}
              />
            </Suspense>
          </StageBoundary>
          {presenterNote}
          {winner && <WinnerBanner winner={winner} overlay when={when} />}
          {n > 0 && controls}
        </div>
      )}
      {!showStage &&
        n > 0 &&
        fallback(stageError !== null ? `it stopped with "${stageError}"` : "this browser has WebGL turned off or unavailable")}

      {n > 0 && !showStage && controls}
      <div className="sr-only" role="status" aria-live="polite">
        {announcement}
      </div>

      {!presenter && (
        <section className="lottery-lists">
          {n > 0 && (
            <div className="panel lottery-list">
              <h2>In the draw ({n})</h2>
              <p className="small muted">One entry each, however many times they posted.</p>
              <ul>
                {entrants.map((e) => (
                  <li key={e.memberId} className={winner?.memberId === e.memberId ? "won" : undefined}>
                    <span className="who-name" title={e.displayName}>{e.displayName}</span>
                    <span className="muted small">{posts(e.postCount)}</span>
                    {winner?.memberId === e.memberId && <span className="badge brand">Winner</span>}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {didNotPost.length > 0 && (
            <div className="panel lottery-list audience">
              <h2>Didn&rsquo;t post {when} ({didNotPost.length})</h2>
              <p className="small">{didNotPost.map((p) => p.displayName).join(", ")}</p>
            </div>
          )}
        </section>
      )}
    </>
  );
}
