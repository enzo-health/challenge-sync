// The weekly lottery's presenter view: the same draw as /admin/lottery (components/lottery/show.tsx),
// bare and filling the window, for a shared screen on a call. Opened from a link on a slide in a
// tab where an admin is signed in, so it takes the same `week`, or `from` and `to`, as the admin
// page (none = the latest complete Friday–Thursday week). The root layout renders it without the
// app shell (components/bare-pages.ts). Admin-only like the rest of /admin/**: guarded by
// app/admin/middleware.rs, and the API checks too.
import { LotteryShow, PeriodLabel, lotteryProblem, useLotteryPeriod } from "../../../../components/lottery/show";
import { PresenterTools, usePresenting } from "../../../../components/lottery/present-frame";

export default function LotteryPresentPage() {
  const { week, from, to, setPeriod, data, isLoading, isPlaceholderData, error } = useLotteryPeriod();
  const search = new URLSearchParams({ ...(week ? { week } : {}), ...(from ? { from } : {}), ...(to ? { to } : {}) }).toString();
  const exitHref = `/admin/lottery${search ? `?${search}` : ""}`;

  usePresenting();

  const problem = lotteryProblem(
    { data, isLoading, error },
    <button type="button" className="btn ghost" onClick={() => void setPeriod({ week: null, from: null, to: null })}>
      Go to the latest complete week
    </button>,
  );
  if (problem !== null || data?.status !== 200) {
    return (
      <div className="lottery-present">
        <div className="lottery-present-status">
          <h1 className="lottery-title">Weekly lottery</h1>
          {problem}
        </div>
        <PresenterTools exitHref={exitHref} exitTitle="Back to the lottery page" />
      </div>
    );
  }

  const w = data.data;
  return (
    <div className="lottery-present">
      <LotteryShow key={`${w.isCustomRange ? "range" : "week"}:${w.firstDay}:${w.lastDay}`} week={w} stale={isPlaceholderData} presenter />
      <div className="lottery-present-top">
        <PeriodLabel w={w} />
        <PresenterTools exitHref={exitHref} exitTitle="Back to the lottery page" />
      </div>
    </div>
  );
}
