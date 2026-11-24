// The weekly lottery: everyone who published an original LinkedIn post in a week (Friday to
// Thursday, Mountain time; the draw is on a Friday) gets one entry, whatever their post count. A
// custom range of days (`?from=…&to=…`, both included) can be drawn instead of a week. The draw and
// its 3D show are components/lottery/show.tsx, shared with the presenter view (./present), which
// "Present" opens for the period shown here. The official Friday draw is not this page: it is the
// public /lottery (src/lottery_draw.rs), with its records at ./official. Admin-only: /admin/** is guarded by
// app/admin/middleware.rs and the API checks too.
import { useState } from "react";
import type { LotteryPeriodEntrants } from "@linkedin-challenge/client";
import { LotteryShow, PeriodLabel, dayFmt, lotteryProblem, periodSearch, useLotteryPeriod } from "../../../components/lottery/show";

/** Today's date in a time zone, `YYYY-MM-DD`. */
function todayIn(timezone: string): string {
  try {
    return new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
  } catch {
    return new Date().toISOString().slice(0, 10);
  }
}

// --- choosing the period ---------------------------------------------------------------------

/** Two dates (both included) and Apply: the custom range form, opened from the period bar. */
function RangeForm({
  initialFrom,
  initialTo,
  today,
  onApply,
  onCancel,
}: {
  initialFrom: string;
  initialTo: string;
  today: string;
  onApply: (from: string, to: string) => void;
  onCancel: () => void;
}) {
  const [from, setFrom] = useState(initialFrom);
  const [to, setTo] = useState(initialTo);
  return (
    <form
      className="lottery-range-form"
      onSubmit={(e) => {
        e.preventDefault();
        if (from && to) onApply(from, to);
      }}
    >
      <label>
        <span>From</span>
        <input type="date" name="from" value={from} max={today} onChange={(e) => setFrom(e.target.value)} required />
      </label>
      <label>
        <span>To (included)</span>
        <input type="date" name="to" value={to} min={from || undefined} onChange={(e) => setTo(e.target.value)} required />
      </label>
      <button type="submit" className="btn sm lottery-range-apply">
        Apply range
      </button>
      <button type="button" className="btn ghost sm" onClick={onCancel}>
        Cancel
      </button>
      <span className="small muted">Mountain time, whole days, up to 62 days.</span>
    </form>
  );
}

// --- presenting -------------------------------------------------------------------------------

/**
 * "Present" opens the presenter view (./present, bare and full-window, for a shared screen) for
 * exactly the period shown here; "Copy link" puts that link on the clipboard, for a slide.
 */
function PresentLinks({ w }: { w: LotteryPeriodEntrants }) {
  const href = `/admin/lottery/present${periodSearch(w)}`;
  const [copy, setCopy] = useState<{ ok: true } | { ok: false; why: string; url: string } | null>(null);
  const copyLink = async () => {
    const url = new URL(href, window.location.origin).toString();
    if (!navigator.clipboard) {
      // Only offered in a secure context (https or localhost).
      setCopy({ ok: false, why: "this page has no clipboard access (navigator.clipboard is unavailable here)", url });
      return;
    }
    try {
      await navigator.clipboard.writeText(url);
      setCopy({ ok: true });
    } catch (error) {
      const why = error instanceof Error ? error.message || error.name : String(error);
      setCopy({ ok: false, why: why.replace(/\.$/, ""), url });
    }
  };
  return (
    <div className="lottery-present-links">
      <a className="btn sm lottery-present-open" href={href} title="A bare, full-window draw for a shared screen">
        Present
      </a>
      <button type="button" className="btn ghost sm lottery-present-copy" onClick={copyLink}>
        Copy link
      </button>
      {copy?.ok && (
        <span className="small lottery-present-copied" role="status">
          Link copied
        </span>
      )}
      {copy && !copy.ok && (
        <div className="notice err lottery-present-copy-failed" role="alert">
          Copying the link failed: {copy.why}. Copy it from here:{" "}
          <input readOnly value={copy.url} onFocus={(e) => e.currentTarget.select()} aria-label="Presenter link" />
        </div>
      )}
    </div>
  );
}

// --- the page --------------------------------------------------------------------------------

export default function LotteryPage() {
  const { week, setPeriod, data, isLoading, isPlaceholderData, error } = useLotteryPeriod();
  const [editingRange, setEditingRange] = useState(false);
  const showWeek = (friday: string | null) => {
    setEditingRange(false);
    void setPeriod({ week: friday, from: null, to: null });
  };
  const showRange = (first: string, last: string) => {
    setEditingRange(false);
    void setPeriod({ week: null, from: first, to: last });
  };

  const problem = lotteryProblem(
    { data, isLoading, error },
    <button type="button" className="btn ghost" onClick={() => showWeek(null)}>
      Go to the latest complete week
    </button>,
  );
  if (problem !== null || data?.status !== 200) {
    return (
      <div className="lottery-page">
        <h1 className="lottery-title">Legacy lottery</h1>
        {problem}
      </div>
    );
  }

  const w = data.data;
  const range = w.isCustomRange;
  const lastDayName = dayFmt.format(Date.parse(`${w.lastDay}T00:00:00Z`));
  return (
    <div className="lottery-page">
      <div className="lottery-head">
        <h1 className="lottery-title">Legacy lottery</h1>
        <PresentLinks w={w} />
      </div>
      <p className="notice lottery-official-note">
        The official Friday draw is the public one at <a href="/lottery">/lottery</a>: the list freezes at 9:30 Mountain time and a
        public drand beacon picks the winner at 9:35, the same for everyone. Its records and redraws are on{" "}
        <a href="/admin/lottery/official">Weekly lottery</a>. This legacy page stays as a fallback: browse any week or range and run an ad-hoc draw picked in this browser, with no public record.
      </p>
      <div className={`lottery-week${range ? " is-range" : ""}`}>
        {!range && (
          <button
            type="button"
            className="btn ghost sm"
            onClick={() => w.previousWeek && showWeek(w.previousWeek)}
            disabled={!w.previousWeek || isPlaceholderData}
            aria-label="Previous week"
          >
            ← Previous
          </button>
        )}
        <PeriodLabel w={w}>{isPlaceholderData && <span className="small muted"> Loading…</span>}</PeriodLabel>
        {!range && (
          <button
            type="button"
            className="btn ghost sm"
            onClick={() => w.nextWeek && showWeek(w.nextWeek)}
            disabled={!w.nextWeek || isPlaceholderData}
            aria-label="Next week"
          >
            Next →
          </button>
        )}
        {!range && week && (
          <button type="button" className="btn ghost sm" onClick={() => showWeek(null)} disabled={isPlaceholderData}>
            Latest complete week
          </button>
        )}
        {!editingRange && (
          <button type="button" className="btn ghost sm lottery-range-open" onClick={() => setEditingRange(true)} disabled={isPlaceholderData}>
            {range ? "Change range" : "Custom range…"}
          </button>
        )}
        {range && (
          <button type="button" className="btn ghost sm lottery-range-back" onClick={() => showWeek(null)} disabled={isPlaceholderData}>
            Back to the weekly draw
          </button>
        )}
      </div>
      {editingRange && (
        <RangeForm
          initialFrom={w.firstDay}
          initialTo={w.lastDay}
          today={todayIn(w.timezone)}
          onApply={showRange}
          onCancel={() => setEditingRange(false)}
        />
      )}
      {!w.isComplete && (
        <p className="small muted">
          {range
            ? `This range isn’t over yet, so more people may still qualify before ${lastDayName} ends.`
            : "This week isn’t over yet, so more people may still qualify before Thursday ends."}
        </p>
      )}
      <LotteryShow key={`${range ? "range" : "week"}:${w.firstDay}:${w.lastDay}`} week={w} stale={isPlaceholderData} />
    </div>
  );
}
