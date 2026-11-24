// The official weekly draws, for admins: every week's record in full (the frozen list, its hash,
// when and how it was frozen, each drand round and its randomness, the winners and the redraw
// history with who redrew and why), and the redraw action. Linked from /admin/lottery. The draws
// themselves are public at /lottery; this page adds the redrawing admins' member ids and Redraw.
// Admin-only like the rest of /admin/** (app/admin/middleware.rs), and the APIs check too.
import { type FormEvent, useState } from "react";
import { parseAsString, useQueryState } from "nuqs";
import { useGetAdminLotteryDraws, useRedrawLottery } from "@linkedin-challenge/client/react-query";
import type { AdminDraw } from "@linkedin-challenge/client";
import { DrawDetails, currentResult, denverTime, weekLabel } from "../../../../components/lottery/official";
import { errorText } from "../../../../components/host-block";

const REASON_MAX = 500;

function RedrawForm({ draw, onDone }: { draw: AdminDraw; onDone: () => void }) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const redraw = useRedrawLottery();
  const current = currentResult(draw);
  const won = new Set(draw.results.map((r) => r.winner?.memberId).filter((id) => id !== undefined)).size;
  const blocked =
    draw.entrants.length === 0
      ? "Nobody was in this draw, so there is nothing to redraw."
      : !current?.winner
        ? `Pick ${current?.sequence} has no winner yet${draw.seedProblem ? `: ${draw.seedProblem}` : ` (drand round ${current?.round}, published ${denverTime(current?.roundAtUnix ?? 0, { seconds: true, withDay: true })})`}.`
        : won >= draw.entrants.length
          ? `Every entrant has already won (${won} of ${draw.entrants.length}); there is nobody left to draw.`
          : null;

  const submit = (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    redraw.mutate(
      { week: draw.schedule.firstDay, data: { reason } },
      {
        onSuccess: (res) => {
          if (res.status !== 200) {
            setError(res.data.error);
            return;
          }
          setReason("");
          setOpen(false);
          onDone();
        },
        onError: (e) => setError(errorText(e, `The redraw failed: ${e instanceof Error ? e.message : String(e)}`)),
      },
    );
  };

  return (
    <div className="panel draw-redraw">
      <h3>Redraw</h3>
      <p className="small">
        Draws a new winner among everyone in the frozen list who has not won this week, seeded by a drand round published a few
        seconds after you press it, so nobody can know the result in advance. The reason, your name and the result are shown
        publicly, next to the earlier winner. Nothing already recorded changes.
      </p>
      {blocked ? (
        <p className="notice">{blocked}</p>
      ) : !open ? (
        <button type="button" className="btn draw-redraw-open" onClick={() => setOpen(true)}>
          Redraw {current?.winner?.displayName}&rsquo;s win…
        </button>
      ) : (
        <form onSubmit={submit} className="draw-redraw-form">
          <label>
            <span>Reason (required, public)</span>
            <textarea
              name="reason"
              value={reason}
              maxLength={REASON_MAX}
              rows={3}
              required
              onChange={(e) => setReason(e.target.value)}
              placeholder="e.g. The winner has asked not to take part this month"
            />
          </label>
          <div className="draw-redraw-actions">
            <button type="submit" className="btn draw-redraw-submit" disabled={redraw.isPending || reason.trim() === ""}>
              {redraw.isPending ? "Recording…" : "Record the redraw"}
            </button>
            <button type="button" className="btn ghost" onClick={() => setOpen(false)}>
              Cancel
            </button>
            <span className="small muted">
              {reason.trim().length}/{REASON_MAX}
            </span>
          </div>
        </form>
      )}
      {error && (
        <div className="notice err draw-redraw-error" role="alert">
          {error}
        </div>
      )}
    </div>
  );
}

export default function OfficialDrawsPage() {
  const [week, setWeek] = useQueryState("week", parseAsString);
  const { data, isLoading, error, refetch } = useGetAdminLotteryDraws({
    query: {
      // While a pick waits for its seed, ask again every few seconds.
      refetchInterval: (q) => {
        const d = q.state.data?.status === 200 ? q.state.data.data : undefined;
        return d?.draws.some((dr) => dr.entrants.length > 0 && currentResult(dr)?.status !== "drawn") ? 3000 : false;
      },
    },
  });

  if (isLoading) return <div className="spinner">Loading…</div>;
  if (error) return <div className="notice err">{errorText(error, `Loading the draws failed: ${error instanceof Error ? error.message : String(error)}`)}</div>;
  if (data?.status !== 200) {
    return (
      <div className="empty">
        Your session expired. <a href="/auth/login">Log in again</a>.
      </div>
    );
  }
  const { draws, schedule, phase } = data.data;
  const selected = draws.find((d) => d.schedule.firstDay === week) ?? draws[0];

  return (
    <div className="official-draws-page">
      <p>
        <a href="/admin/lottery">← Weekly lottery</a>
      </p>
      <h1 className="lottery-title">Official draws</h1>
      <p className="lede">
        The official Friday draw is public at <a href="/lottery">/lottery</a>. Each week&rsquo;s list freezes at 9:30 Mountain time on
        the Friday after it, and the drand round published at 9:35 picks the winner. Now:{" "}
        <strong>{phase === "party" ? "between draws" : phase === "frozen" ? "the list is frozen" : "the wheel is open"}</strong>;{" "}
        {phase === "party" ? "next draw" : "today's draw"} {denverTime(schedule.seedAtUnix, { withDay: true })}, for{" "}
        {weekLabel(schedule.firstDay, schedule.lastDay)}.
      </p>
      {draws.length === 0 ? (
        <p className="empty">No official draws yet. The first is frozen at {denverTime(schedule.freezeAtUnix, { withDay: true })}.</p>
      ) : (
        <div className="official-draws">
          <nav className="panel official-draws-list" aria-label="Draws">
            <ul>
              {draws.map((d) => {
                const r = currentResult(d);
                return (
                  <li key={d.schedule.firstDay}>
                    <button
                      type="button"
                      className={`official-draw-pick${d === selected ? " active" : ""}`}
                      onClick={() => void setWeek(d.schedule.firstDay)}
                    >
                      <strong>{d.schedule.drawDay}</strong>{" "}
                      <span className="small muted">
                        {d.entrants.length === 0 ? "nobody posted" : r?.winner ? r.winner.displayName : "no winner yet"}
                        {d.results.length > 1 && ` · ${d.results.length - 1} redraw${d.results.length > 2 ? "s" : ""}`}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </nav>
          {selected && (
            <div className="official-draw-detail">
              <DrawDetails draw={selected} redrawnBy={selected.redrawnBy}>
              <div className="panel draw-rounds">
                <h3>Picks</h3>
                <table className="table">
                  <thead>
                    <tr>
                      <th>#</th>
                      <th>Asked</th>
                      <th>drand round</th>
                      <th>Randomness</th>
                      <th>Winner</th>
                    </tr>
                  </thead>
                  <tbody>
                    {selected.results.map((r) => (
                      <tr key={r.sequence}>
                        <td>{r.sequence}</td>
                        <td>{denverTime(Date.parse(r.requestedAt) / 1000, { seconds: true, withDay: true })}</td>
                        <td>
                          {r.round} <span className="small muted">({denverTime(r.roundAtUnix, { seconds: true })})</span>
                        </td>
                        <td>
                          <code className="draw-hash">{r.randomness ?? r.status}</code>
                        </td>
                        <td>{r.winner ? `${r.winner.displayName} (index ${r.winnerIndex} of ${r.eligible.length})` : r.status}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
                <RedrawForm draw={selected} onDone={() => void refetch()} />
              </DrawDetails>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
