// The official weekly lottery, public: one fixed address for every week, open without signing in
// (app/middleware.rs lets /lottery and /api/lottery through), bare and full-window like the
// presenter view (components/bare-pages.ts, components/lottery/present-frame.tsx).
//
// What it shows follows the server's clock (`GET /api/lottery`, rules in src/lottery_draw.rs):
//   party (until Friday 9:30, and from 12:00): everyone dancing, a star over who is in the coming draw;
//   frozen (9:30 – 9:35): the frozen list still dancing, its hash, and a countdown to the seed;
//   spin (9:35 – 12:00): the wheel. The server has already picked the winner from the public seed;
//     every Spin, here and in every other browser, lands on them, and Reset replays.
// Past results are a click away in every phase. Nothing is decided in this browser.
import { Component, type ReactNode, Suspense, lazy, useState } from "react";
import { useGetLottery, useGetLotteryResults } from "@linkedin-challenge/client/react-query";
import type { OfficialDraw, PublicLottery } from "@linkedin-challenge/client";
import { LotteryShow, detectWebGL, useReducedMotion } from "../../components/lottery/show";
import { PresenterTools, usePresenting } from "../../components/lottery/present-frame";
import {
  DrawDetails,
  DrawHistory,
  VerifyDraw,
  countdown,
  currentResult,
  denverTime,
  useServerNow,
  useWakeAt,
  weekLabel,
  wheelFor,
} from "../../components/lottery/official";
import type { PartyGuest } from "../../components/lottery/party";
import { errorText } from "../../components/host-block";

const PartyStage = lazy(() => import("../../components/lottery/party"));
/** Room left above the dance floor for the info card in the top-left corner. */
const INFO_CARD_HEIGHT = 190;

/** A party that fails to start (no WebGL, a failed download) drops to the plain guest list. */
class PartyBoundary extends Component<{ fallback: (why: string) => ReactNode; children: ReactNode }, { failed: string | null }> {
  state = { failed: null as string | null };
  static getDerivedStateFromError(error: unknown) {
    return { failed: error instanceof Error ? error.message || error.name : String(error) };
  }
  render() {
    return this.state.failed !== null ? this.props.fallback(`it stopped with "${this.state.failed}"`) : this.props.children;
  }
}

function Party({ guests, label }: { guests: PartyGuest[]; label: string }) {
  const reducedMotion = useReducedMotion();
  const [webgl] = useState(detectWebGL);
  const fallback = (why: string) => (
    <div className="party-fallback">
      <p>
        <strong>The dance floor can&rsquo;t run here:</strong> {why}.
      </p>
      <ul>
        {guests.map((g) => (
          <li key={g.memberId}>
            {g.starred && "★ "}
            {g.displayName}
          </li>
        ))}
      </ul>
    </div>
  );
  if (!webgl) return fallback("this browser has WebGL turned off or unavailable");
  return (
    <PartyBoundary fallback={fallback}>
      <Suspense fallback={<div className="lottery-stage loading party-stage">Setting up the dance floor…</div>}>
        <PartyStage guests={guests} reducedMotion={reducedMotion} label={label} topInset={INFO_CARD_HEIGHT} />
      </Suspense>
    </PartyBoundary>
  );
}

/** The plain label in the corner: which week, and what happens next and when. */
function InfoCard({ title, week, children }: { title: string; week: string; children: ReactNode }) {
  return (
    <section className="draw-card draw-info" aria-live="polite">
      <div className="draw-kicker">Weekly lottery</div>
      <h1 className="draw-title">{title}</h1>
      <p className="draw-week">{week}</p>
      {children}
    </section>
  );
}

function PastResults({ onClose }: { onClose: () => void }) {
  const { data, isLoading, error } = useGetLotteryResults();
  return (
    <aside className="draw-card draw-past" aria-label="Past results">
      <div className="draw-past-head">
        <h2>Past results</h2>
        <button type="button" className="lottery-present-tool" onClick={onClose}>
          Close
        </button>
      </div>
      {isLoading && <div className="spinner">Loading…</div>}
      {error && <div className="notice err">{errorText(error, `Loading the past results failed: ${error instanceof Error ? error.message : String(error)}`)}</div>}
      {data?.status === 200 &&
        (data.data.draws.length === 0 ? (
          <p className="muted">No official draws yet.</p>
        ) : (
          data.data.draws.map((d) => <DrawDetails key={d.schedule.drawDay} draw={d} />)
        ))}
      {data && data.status !== 200 && <div className="notice err">Loading the past results failed (HTTP {data.status}).</div>}
    </aside>
  );
}

function PartyView({ state, now }: { state: PublicLottery; now: number }) {
  const s = state.schedule;
  const guests: PartyGuest[] = state.party.map((p) => ({ memberId: p.memberId, displayName: p.displayName, avatar: p.avatar, starred: p.postCount > 0 }));
  const starred = guests.filter((g) => g.starred).length;
  const label = `A dance party: ${guests.length} people dancing on the lottery stage; ${starred} with a star are in the coming draw so far.`;
  return (
    <>
      <Party guests={guests} label={label} />
      <InfoCard title="Dance party" week={`Next draw: ${weekLabel(s.firstDay, s.lastDay)}`}>
        <p>
          <span className="draw-star">★</span> {starred === 0 ? "Nobody has posted for this draw yet." : `${starred} ${starred === 1 ? "person is" : "people are"} in the draw so far.`}{" "}
          One original LinkedIn post in the week gets you a star.
        </p>
        <p className="draw-next">
          The list freezes <strong>{denverTime(s.freezeAtUnix, { withDay: true })}</strong>, and the wheel spins at{" "}
          <strong>{denverTime(s.seedAtUnix)}</strong> ({zoneShort()}). <span className="draw-countdown">Freeze in {countdown(s.freezeAtUnix, now)}</span>
        </p>
      </InfoCard>
    </>
  );
}

const zoneShort = () => "Mountain time";

function FrozenView({ draw, now }: { draw: OfficialDraw; now: number }) {
  const s = draw.schedule;
  const first = draw.results[0];
  const guests: PartyGuest[] = draw.entrants.map((e) => ({ memberId: e.memberId, displayName: e.displayName, avatar: e.avatar, starred: true }));
  return (
    <>
      <Party guests={guests} label={`The frozen list: ${guests.length} people in this week's draw, dancing.`} />
      <InfoCard title="The list is frozen" week={`Draw for ${weekLabel(s.firstDay, s.lastDay)}`}>
        <p className="draw-next">
          The seed is drand round <strong>{first?.round}</strong>, published at <strong>{denverTime(first?.roundAtUnix ?? s.seedAtUnix, { seconds: true })}</strong>.{" "}
          <span className="draw-countdown">Wheel in {countdown(first?.roundAtUnix ?? s.seedAtUnix, now)}</span>
        </p>
      </InfoCard>
      <aside className="draw-card draw-frozen-list" aria-label="Who is in the draw">
        <h2>
          In the draw ({draw.entrants.length})
        </h2>
        {draw.entrants.length === 0 ? (
          <p>Nobody published an original post this week, so there is no draw.</p>
        ) : (
          <ol className="draw-names">
            {draw.entrants.map((e) => (
              <li key={e.memberId}>
                {e.displayName} <span className="muted small">{e.postCount === 1 ? "1 post" : `${e.postCount} posts`}</span>
              </li>
            ))}
          </ol>
        )}
        <div className="draw-kv">
          <span>List SHA-256</span>
          <code className="draw-hash draw-list-hash">{draw.listHash}</code>
        </div>
        <details className="draw-verify">
          <summary>The exact list text</summary>
          <pre className="draw-list-text">{draw.listText}</pre>
          <p className="small muted">{draw.listFormat}</p>
        </details>
      </aside>
    </>
  );
}

function SpinView({ draw, now }: { draw: OfficialDraw; now: number }) {
  const s = draw.schedule;
  const result = currentResult(draw);
  if (!result) return null;
  const wheel = wheelFor(draw, result);
  const ready = result.status === "drawn" && result.winnerIndex !== null;
  return (
    <>
      <LotteryShow
        key={`${s.drawDay}:${result.sequence}`}
        week={wheel}
        stale={!ready}
        presenter
        winnerIndex={ready ? result.winnerIndex ?? undefined : undefined}
      />
      <div className="draw-side">
        <InfoCard title={result.sequence > 1 ? `The draw (redraw ${result.sequence - 1})` : "The draw"} week={weekLabel(s.firstDay, s.lastDay)}>
          {draw.entrants.length === 0 ? (
            <p>Nobody published an original post this week, so there is no winner.</p>
          ) : ready ? (
            <p className="draw-next">
              Spin the wheel: it lands on the winner drawn from drand round {result.round}, the same in every browser. Open until{" "}
              {denverTime(s.closesAtUnix)}.
            </p>
          ) : result.status === "waiting" ? (
            <p className="draw-next draw-waiting">
              Waiting for the seed: drand round {result.round}, published at {denverTime(result.roundAtUnix, { seconds: true })}.{" "}
              <span className="draw-countdown">{countdown(result.roundAtUnix, now)}</span>
            </p>
          ) : (
            <p className="notice err draw-seed-problem">
              The seed is not available yet: {draw.seedProblem ?? `drand round ${result.round} has not been fetched`}. Trying again every few seconds.
            </p>
          )}
          <DrawHistory draw={draw} />
        </InfoCard>
        {draw.entrants.length > 0 && <VerifyDraw draw={draw} />}
      </div>
    </>
  );
}

/** How often to ask again: soon while waiting for a seed, else now and then (boundaries wake it too). */
function pollMs(data: PublicLottery | undefined): number {
  const r = data?.draw ? currentResult(data.draw) : undefined;
  if (data?.phase === "spin" && r && r.status !== "drawn" && r.status !== "empty") return 3000;
  return 60_000;
}

export default function OfficialLotteryPage() {
  usePresenting();
  const [showPast, setShowPast] = useState(false);
  const query = useGetLottery({ query: { refetchInterval: (q) => pollMs(q.state.data?.status === 200 ? q.state.data.data : undefined) } });
  const { data, error, isLoading, dataUpdatedAt, refetch } = query;
  const state = data?.status === 200 ? data.data : undefined;
  const now = useServerNow(state?.nowUnix, dataUpdatedAt);
  const offsetMs = state ? state.nowUnix * 1000 - dataUpdatedAt : 0;
  // Ask again the moment the next boundary (or the seed's round) comes.
  const next = !state
    ? null
    : state.phase === "party"
      ? state.schedule.freezeAtUnix > state.nowUnix
        ? state.schedule.freezeAtUnix
        : null
      : state.phase === "frozen"
        ? (state.draw?.results[0]?.roundAtUnix ?? state.schedule.seedAtUnix)
        : state.draw && currentResult(state.draw)?.status === "waiting"
          ? (currentResult(state.draw)?.roundAtUnix ?? state.schedule.closesAtUnix)
          : state.schedule.closesAtUnix;
  useWakeAt(next, offsetMs, () => void refetch());

  const tools = (
    <PresenterTools>
      <button type="button" className="lottery-present-tool draw-past-open" onClick={() => setShowPast((v) => !v)} aria-expanded={showPast}>
        Past results
      </button>
    </PresenterTools>
  );

  let body: ReactNode;
  if (isLoading) {
    body = (
      <div className="lottery-present-status">
        <div className="spinner">Loading…</div>
      </div>
    );
  } else if (error || !state) {
    const why = error
      ? errorText(error, `Loading the draw failed: ${error instanceof Error ? error.message : String(error)}`)
      : `Loading the draw failed (HTTP ${data?.status}${data && "data" in data && data.data && "error" in data.data ? `: ${String(data.data.error)}` : ""}).`;
    body = (
      <div className="lottery-present-status">
        <h1 className="lottery-title">Weekly lottery</h1>
        <div className="notice err">{why}</div>
      </div>
    );
  } else if (state.phase === "party" || !state.draw) {
    body = <PartyView state={state} now={now} />;
  } else if (state.phase === "frozen") {
    body = <FrozenView draw={state.draw} now={now} />;
  } else {
    body = <SpinView draw={state.draw} now={now} />;
  }

  return (
    <div className={`lottery-present official-draw phase-${state?.phase ?? "loading"}`} data-phase={state?.phase}>
      {body}
      <div className="lottery-present-top">{tools}</div>
      {showPast && <PastResults onClose={() => setShowPast(false)} />}
    </div>
  );
}
