// The bare, full-window frame of the lottery's shared-screen views: the admin presenter view
// (app/admin/lottery/present) and the public official draw (app/lottery). The root layout renders
// both without the app shell (components/bare-pages.ts); this adds what they have in common: no
// document scroll behind the stage, and a Full screen button (and Exit, where there is somewhere to go).
import { type ReactNode, useEffect, useState, useSyncExternalStore } from "react";

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

/** No document scrollbars behind the full-window stage, while the page is mounted. */
export function usePresenting() {
  useEffect(() => {
    document.documentElement.classList.add("lottery-presenting");
    return () => document.documentElement.classList.remove("lottery-presenting");
  }, []);
}

/**
 * Full screen (hidden while full screen; Esc leaves it) and, with `exitHref`, Exit (leaving full
 * screen on the way). `children` go first in the row (the public page's own buttons).
 */
export function PresenterTools({ exitHref, exitTitle, children }: { exitHref?: string; exitTitle?: string; children?: ReactNode }) {
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
      {children}
      {supported && !fullscreen && (
        <button type="button" className="lottery-present-tool lottery-present-fullscreen" onClick={enter} title="Fill the screen (Esc to leave)">
          Full screen
        </button>
      )}
      {exitHref && (
        <a
          className="lottery-present-tool lottery-present-exit"
          href={exitHref}
          onClick={() => {
            if (document.fullscreenElement) void document.exitFullscreen().catch(() => {});
          }}
          title={exitTitle}
        >
          Exit
        </a>
      )}
      {failed !== null && (
        <span className="lottery-present-tool-error" role="alert">
          Full screen failed: {failed}
        </span>
      )}
    </div>
  );
}
