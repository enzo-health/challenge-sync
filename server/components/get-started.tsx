// The signed-out front door. Nobody types a password: the Challenge Sync extension reads who you
// are on LinkedIn and signs you in here. This page says what is still missing and gets out of the
// way the moment the extension has done its part.
//
// It talks to the extension through `extension/bridge.js`, a content script the extension runs on
// this site. The page posts a hello; the bridge answers with what the extension can see. No answer
// means the extension is not installed (or is an old version without the bridge), or that Chrome
// has switched it off — so the page also offers the "Chrome paused it" way back (sync-paused.tsx).
import { useEffect, useState } from "react";
import { HostBlockedError } from "./host-block";
import { EXTENSION_STORE_URL } from "./links";
import { ME_FALLBACK_MS, helloDelay } from "./poll-schedule";
import { SyncPausedNotice } from "./sync-paused";

type ExtensionStatus = {
  linkedInSignedIn: boolean;
  linked: boolean;
  /** No join code in this browser: the invite link was never opened here. */
  needsInvite: boolean;
  /**
   * The server refused the join code. Undefined from extensions before 0.1.4, whose bridge did
   * not tell this apart from needsInvite (or from a request the host blocked).
   */
  inviteRefused: boolean | undefined;
  error: string | null;
  errorCode: string | null;
};

// How long the first hello may go unanswered before the page treats the extension as missing.
// A sleeping service worker can take a moment to wake; an installed one answers well inside this.
const NO_ANSWER_MS = 2000;

// A request our host blocked gets one automatic reload (a page load is something the browser can
// pass the host's challenge on; a fetch is not), remembered here so it can never loop.
const RELOADED_KEY = "challenge-sync:host-block-reload";
const RELOAD_AGAIN_AFTER_MS = 10 * 60_000;
function reloadOnceForHostBlock(): boolean {
  try {
    const at = Number(window.sessionStorage.getItem(RELOADED_KEY));
    if (at && Date.now() - at < RELOAD_AGAIN_AFTER_MS) return false;
    window.sessionStorage.setItem(RELOADED_KEY, String(Date.now()));
    return true;
  } catch {
    return false; // no sessionStorage, no way to know we already tried: don't risk a loop
  }
}
function forgetHostBlockReload() {
  try {
    window.sessionStorage.removeItem(RELOADED_KEY);
  } catch {
    // nothing to forget
  }
}

// Whether this browser has a company join code (the /join page stores it; not HttpOnly). Only
// used to read an old extension's ambiguous "needsInvite" honestly.
function hasJoinCookie(): boolean {
  return document.cookie.split(";").some((part) => part.trim().startsWith("join_code="));
}

const GENERIC_ERROR =
  "Something went wrong signing you in. We\u2019ll keep trying \u2014 if this doesn\u2019t clear in a minute, reload the page.";

/**
 * What the page says about the sign-in, as exactly one of three things, so a screenshot tells
 * them apart: "no invite link" (there is no join code), "this invite link was refused" (the
 * server said so), or a generic error with a short reason code (anything else: the host blocked
 * a request, the network, an unexpected answer). Nothing but the first two may mention invites.
 */
export function signInProblem(
  status: ExtensionStatus | null,
  { joinCookie }: { joinCookie: boolean },
): { kind: "none" } | { kind: "needs-invite" } | { kind: "invite-refused" } | { kind: "error"; code: string; detail: string | null } {
  if (!status) return { kind: "none" };
  if (status.error) return { kind: "error", code: status.errorCode || "extension-error", detail: status.error };
  if (status.inviteRefused) return { kind: "invite-refused" };
  if (status.needsInvite) {
    // 0.1.4 and later say needsInvite only when there is no code. Before that it also meant "the
    // server refused the code" and, wrongly, "the host blocked the request"; with a code in the
    // browser those can't be told apart, so say the honest generic thing.
    if (status.inviteRefused === undefined && joinCookie) {
      return { kind: "error", code: "legacy-extension", detail: null };
    }
    return { kind: "needs-invite" };
  }
  return { kind: "none" };
}

function Step({ done, title, children }: { done: boolean; title: string; children?: React.ReactNode }) {
  return (
    <li className={done ? "start-step done" : "start-step"}>
      <span className="start-mark" aria-hidden="true">{done ? "\u2713" : ""}</span>
      <div>
        <p className="start-title">{title}</p>
        {!done && children}
      </div>
    </li>
  );
}

export function GetStarted({ invited = false }: { invited?: boolean }) {
  const [status, setStatus] = useState<ExtensionStatus | null>(null);
  const [noAnswer, setNoAnswer] = useState(false);
  // The site's own sign-in check was stopped by our host; the app-wide banner says so
  // (components/host-block.tsx) and this page stops asking.
  const [hostBlocked, setHostBlocked] = useState(false);
  // Set once they click "Re-enable": Chrome only runs the extension's bridge on pages loaded after
  // it is switched back on, so this tab needs one reload when they come back to it.
  const [reenabling, setReenabling] = useState(false);

  useEffect(() => {
    if (!reenabling || status !== null) return;
    const onReturn = () => {
      if (document.visibilityState === "visible") window.location.reload();
    };
    document.addEventListener("visibilitychange", onReturn);
    return () => document.removeEventListener("visibilitychange", onReturn);
  }, [reenabling, status]);

  // The sign-in loop. See poll-schedule.ts for the cadence and why.
  useEffect(() => {
    let stopped = false; // signed in, reloading, or blocked: never ask again from this page
    let helloTimer: number | undefined;
    let meTimer: number | undefined;
    let noAnswerTimer: number | undefined;
    let step = 0;
    let checkingMe = false;
    let lastReply: string | null = null;

    const visible = () => document.visibilityState === "visible";
    const clearTimers = () => {
      window.clearTimeout(helloTimer);
      window.clearTimeout(meTimer);
      helloTimer = meTimer = undefined;
    };
    const stop = () => {
      stopped = true;
      clearTimers();
    };

    const hello = () => {
      window.postMessage({ source: "challenge-sync-page", type: "HELLO" }, window.location.origin);
      noAnswerTimer ??= window.setTimeout(() => setNoAnswer(true), NO_ANSWER_MS);
    };

    const checkMe = async () => {
      if (stopped || checkingMe) return;
      checkingMe = true;
      try {
        const res = await fetch("/api/auth/me", { credentials: "same-origin" });
        forgetHostBlockReload();
        const me = await res.json();
        if (!stopped && me?.signedIn) {
          stop();
          // Hard load: the session cookie is new, so every cached query is stale.
          window.location.href = "/";
        }
      } catch (error) {
        if (error instanceof HostBlockedError && !stopped) {
          stop();
          if (reloadOnceForHostBlock()) window.location.reload();
          else setHostBlocked(true);
        }
        // Otherwise offline or mid-deploy: the next check tries again.
      } finally {
        checkingMe = false;
      }
    };

    const scheduleHello = () => {
      window.clearTimeout(helloTimer);
      if (stopped || !visible()) return;
      helloTimer = window.setTimeout(() => {
        hello();
        step += 1;
        scheduleHello();
      }, helloDelay(step));
    };
    const scheduleMe = () => {
      window.clearTimeout(meTimer);
      if (stopped || !visible()) return;
      meTimer = window.setTimeout(() => {
        void checkMe();
        scheduleMe();
      }, ME_FALLBACK_MS);
    };
    // Ask both right now, then start the schedule over from its quick end.
    const wake = () => {
      if (stopped || !visible()) return;
      step = 0;
      hello();
      void checkMe();
      scheduleHello();
      scheduleMe();
    };

    const onMessage = (event: MessageEvent) => {
      if (event.source !== window || event.origin !== window.location.origin) return;
      const data = event.data;
      if (!data || data.source !== "challenge-sync-extension") return;
      window.clearTimeout(noAnswerTimer);
      const next: ExtensionStatus = {
        linkedInSignedIn: Boolean(data.linkedInSignedIn),
        linked: Boolean(data.linked),
        needsInvite: Boolean(data.needsInvite),
        inviteRefused: "inviteRefused" in data ? Boolean(data.inviteRefused) : undefined,
        error: typeof data.error === "string" ? data.error : null,
        errorCode: typeof data.errorCode === "string" ? data.errorCode : null,
      };
      setStatus(next);
      // Linked means the extension has just put a session cookie in this browser: see if the site
      // takes it, now rather than at the next fallback check.
      if (next.linked) void checkMe();
      // Something changed (LinkedIn logged in, the invite link opened): be quick again for a bit.
      const key = JSON.stringify(next);
      if (lastReply !== null && key !== lastReply) {
        step = 0;
        scheduleHello();
      }
      lastReply = key;
    };
    window.addEventListener("message", onMessage);

    const onVisibility = () => (visible() ? wake() : clearTimers());
    document.addEventListener("visibilitychange", onVisibility);
    wake();

    return () => {
      stop();
      window.clearTimeout(noAnswerTimer);
      window.removeEventListener("message", onMessage);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, []);

  const installed = status !== null;
  const linkedIn = Boolean(status?.linkedInSignedIn);
  const problem = signInProblem(status, { joinCookie: typeof document !== "undefined" && hasJoinCookie() });

  return (
    <div className="auth-page">
      <div className="auth-card">
        <div className="auth-brand" aria-hidden="true">
          <img src="/favicon.svg" alt="" />
        </div>
        <p className="auth-eyebrow">Challenge Sync</p>
        <h1>{invited ? "You're invited" : "Get started"}</h1>
        <p className="auth-intro">
          There is no password. Get the extension, make sure you&rsquo;re logged in to LinkedIn, and
          this page signs you in by itself.
        </p>

        {!installed && noAnswer && <SyncPausedNotice onOpen={() => setReenabling(true)} />}

        <ol className="start-steps">
          <Step done={installed} title="Get the Challenge Sync extension">
            <a className="btn start-action" href={EXTENSION_STORE_URL} target="_blank" rel="noreferrer">
              Add to Chrome
            </a>
          </Step>
          <Step done={linkedIn} title="Log in to LinkedIn in this browser">
            <a className="btn start-action" href="https://www.linkedin.com/" target="_blank" rel="noreferrer">
              Open LinkedIn
            </a>
          </Step>
        </ol>

        {!hostBlocked && problem.kind === "needs-invite" && installed && linkedIn && (
          <div className="notice err" role="alert">
            You need your company&rsquo;s invite link. Ask whoever runs Challenge Sync at your company for it, open it
            in this browser, and you&rsquo;re in.
          </div>
        )}
        {!hostBlocked && problem.kind === "invite-refused" && (
          <div className="notice err" role="alert">
            This invite link isn&rsquo;t valid, or it has been replaced by a newer one. Ask whoever runs Challenge Sync
            at your company for the current link and open it in this browser.
          </div>
        )}
        {!hostBlocked && problem.kind === "error" && (
          <div className="notice err" role="alert">
            {GENERIC_ERROR}
            <div className="small sign-in-reason">
              Reason: {problem.code}
              {problem.detail ? ` \u2014 ${problem.detail}` : ""}
            </div>
          </div>
        )}
        {!hostBlocked && problem.kind === "none" && installed && linkedIn && (
          <p className="auth-intro">Signing you in…</p>
        )}

        <p className="auth-switch">
          It reads only your own post stats and never sees your LinkedIn password.{" "}
          <a href="/privacy">Privacy</a>
        </p>
        <p className="auth-note">
          Have an email and password from before? <a href="/auth/password">Sign in with those</a>
        </p>
      </div>
    </div>
  );
}
