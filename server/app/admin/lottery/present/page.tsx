// The weekly lottery's presenter view: the same draw as /admin/lottery (components/lottery/show.tsx),
// bare and filling the window, for a shared screen on a call. Opened from a link on a slide in a
// tab where an admin is signed in, so it takes the same `week`, or `from` and `to`, as the admin
// page (none = the latest complete Friday–Thursday week). The root layout renders it without the
// app shell (components/bare-pages.ts). Admin-only like the rest of /admin/**: guarded by
// app/admin/middleware.rs, and the API checks too.
import { useEffect, useState, useSyncExternalStore } from "react";
import { LotteryShow, PeriodLabel, lotteryProblem, useLotteryPeriod } from "../../../../components/lottery/show";

function useFullscreen(): boolean {
  return useSyncExternalStore(
    (onChange) => {
      document.addEventListener("fullscreenchange", onChange);
      return () => document.removeEventListener("fullscreenchange", onChange);
    },
    () => document.fullscreenElement !== null,
    () => false,
  );
}

/** Full screen (hidden while full screen; Esc leaves it) and Exit, back to the admin page. */
function PresenterTools({ exitHref }: { exitHref: string }) {
  const fullscreen = useFullscreen();
  const [failed, setFailed] = useState<string | null>(null);
  const supported = typeof document.documentElement.requestFullscreen === "function";
  const enter = () => {
    setFailed(null);
    document.documentElement.requestFullscreen().catch((error: unknown) => {
      setFailed(error instanceof Error ? error.message || error.name : String(error));
    });
  };
  return (
    <div className={`lottery-present-tools${fullscreen ? " is-fullscreen" : ""}`}>
      {supported && !fullscreen && (
        <button type="button" className="lottery-present-tool lottery-present-fullscreen" onClick={enter} title="Fill the screen (Esc to leave)">
          Full screen
        </button>
      )}
      <a
        className="lottery-present-tool lottery-present-exit"
        href={exitHref}
        onClick={() => {
          if (document.fullscreenElement) void document.exitFullscreen().catch(() => {});
        }}
        title="Back to the lottery page"
      >
        Exit
      </a>
      {failed !== null && (
        <span className="lottery-present-tool-error" role="alert">
          Full screen failed: {failed}
        </span>
      )}
    </div>
  );
}

export default function LotteryPresentPage() {
  const { week, from, to, setPeriod, data, isLoading, isPlaceholderData, error } = useLotteryPeriod();
  const search = new URLSearchParams({ ...(week ? { week } : {}), ...(from ? { from } : {}), ...(to ? { to } : {}) }).toString();
  const exitHref = `/admin/lottery${search ? `?${search}` : ""}`;

  // No document scrollbars behind the full-window stage.
  useEffect(() => {
    document.documentElement.classList.add("lottery-presenting");
    return () => document.documentElement.classList.remove("lottery-presenting");
  }, []);

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
        <PresenterTools exitHref={exitHref} />
      </div>
    );
  }

  const w = data.data;
  return (
    <div className="lottery-present">
      <LotteryShow key={`${w.isCustomRange ? "range" : "week"}:${w.firstDay}:${w.lastDay}`} week={w} stale={isPlaceholderData} presenter />
      <div className="lottery-present-top">
        <PeriodLabel w={w} />
        <PresenterTools exitHref={exitHref} />
      </div>
    </div>
  );
}
