// When our host stops a request before it reaches the server.
//
// Vercel's automatic DDoS mitigation can put a visitor's IP under a "challenge" for a few minutes:
// every request from it is answered by Vercel, not by us, with HTTP 403, an HTML page, and the
// header `x-vercel-mitigated: challenge`. A top-level page load lets the browser solve that
// challenge; a fetch cannot. The generated API client then fails to parse the HTML as JSON, and
// each page used to show its own "could not be saved, try again", which is the wrong advice.
//
// So the app wraps `window.fetch` once (installed from app/layout.tsx, which every page renders
// inside): a same-origin `/api/` response that is a host block rejects with HostBlockedError
// instead. That is the one seam every generated query and mutation goes through. The generated
// client itself is not edited: it is gitignored output that `npm run client:release` rewrites.
//
// The app then says one thing about it, everywhere: HostBlockedBanner, with a Reload button, and
// `errorText()` for the pages that show their own error next to a form.
import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";

export const HOST_BLOCKED_MESSAGE =
  "Our host paused requests from your network for a moment. Wait a minute, then reload the page.";

const EVENT = "challenge-sync:host-blocked";

export class HostBlockedError extends Error {
  readonly status: number;
  constructor(status: number) {
    super(HOST_BLOCKED_MESSAGE);
    this.name = "HostBlockedError";
    this.status = status;
  }
}

/**
 * Whether a response came from the host's firewall rather than from our server. Our API answers
 * every error with JSON and never rate-limits, so an HTML 403 or any 429 is not ours either.
 */
export function isHostBlocked(res: Response): boolean {
  if (res.headers.has("x-vercel-mitigated")) return true;
  if (res.status === 429) return true;
  return res.status === 403 && (res.headers.get("content-type") ?? "").includes("text/html");
}

/** A page's own error text, unless the real reason is a host block. */
export function errorText(error: unknown, fallback: string): string {
  return error instanceof HostBlockedError ? HOST_BLOCKED_MESSAGE : fallback;
}

let blocked = false;
let installed = false;

function isOwnApi(input: RequestInfo | URL): boolean {
  try {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const url = new URL(raw, window.location.href);
    return url.origin === window.location.origin && url.pathname.startsWith("/api/");
  } catch {
    return false;
  }
}

export function installHostBlockDetection(): void {
  if (installed || typeof window === "undefined") return;
  installed = true;
  const nativeFetch = window.fetch.bind(window);
  window.fetch = async (input, init) => {
    const res = await nativeFetch(input, init);
    if (isOwnApi(input) && isHostBlocked(res)) {
      blocked = true;
      window.dispatchEvent(new Event(EVENT));
      throw new HostBlockedError(res.status);
    }
    return res;
  };
}

/**
 * React Query retries a failed query three times by default: three more requests into a block that
 * only time (or a reload) lifts. Called from the root layout, which renders before any page or the
 * sidebar asks for data, so their queries pick this up.
 */
export function useHostBlockRetryPolicy(): void {
  const queryClient = useQueryClient();
  useState(() => {
    const defaults = queryClient.getDefaultOptions();
    queryClient.setDefaultOptions({
      ...defaults,
      queries: {
        ...defaults.queries,
        retry: (failures, error) => !(error instanceof HostBlockedError) && failures < 3,
      },
    });
    return null;
  });
}

/** The app-wide notice, shown from the first blocked request until the page is reloaded. */
export function HostBlockedBanner() {
  const [shown, setShown] = useState(blocked);
  useEffect(() => {
    const show = () => setShown(true);
    if (blocked) show();
    window.addEventListener(EVENT, show);
    return () => window.removeEventListener(EVENT, show);
  }, []);
  if (!shown) return null;

  return (
    <div className="notice err host-blocked" role="alert">
      <span>{HOST_BLOCKED_MESSAGE}</span>{" "}
      <button className="btn sm" type="button" onClick={() => window.location.reload()}>
        Reload
      </button>
    </div>
  );
}
