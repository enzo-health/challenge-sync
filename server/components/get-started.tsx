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
import { ME_FALLBACK_MS, NO_ANSWER_MS, helloDelay } from "./poll-schedule";
import { type ExtensionStatus, readReply, sayHello } from "./extension-bridge";
import { SyncPausedNotice } from "./sync-paused";

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

// A tab left showing "Chrome paused it" while its owner switches the extension back on gets no
// bridge (Chrome only runs it in pages loaded afterwards), so coming back to it reloads it, once
// per few minutes, whether or not they used the button.
const RETURN_RELOAD_KEY = "challenge-sync:no-answer-reload";
function reloadOnceOnReturn(): boolean {
  try {
    const at = Number(window.sessionStorage.getItem(RETURN_RELOAD_KEY));
    if (at && Date.now() - at < 5 * 60_000) return false;
    window.sessionStorage.setItem(RETURN_RELOAD_KEY, String(Date.now()));
    return true;
  } catch {
    return false;
  }
}

// Whether this browser has a company join code (the /join page stores it; not HttpOnly). Only
// used to read an old extension's ambiguous "needsInvite" honestly.
function hasJoinCookie(): boolean {
  return document.cookie.split(";").some((part) => part.trim().startsWith("join_code="));
}

// What an old (0.1.3) extension's "needs an invite" means when this browser does hold a join
// code: it said the same for a refused code, a blocked request and an unreachable server.
const LEGACY_AMBIGUOUS =
  "Challenge Sync couldn\u2019t sign you in, and this older version of the extension doesn\u2019t say why: a network problem, a blocked request and a server problem all look the same to it. We\u2019ll keep trying.";

/**
 * What the page says about the sign-in, as exactly one of three things, so a screenshot tells
 * them apart: "no invite link" (there is no join code), "this invite link was refused" (the
 * server said so, with its `join_code_invalid` code), or the specific failure the extension
 * reported, with its short reason code (can't reach the server, the host blocked it, the server
 * had a problem, a stated refusal, LinkedIn, ...). Nothing but the first two may mention invites.
 */
export function signInProblem(
  status: ExtensionStatus | null,
  { joinCookie }: { joinCookie: boolean },
): { kind: "none" } | { kind: "needs-invite" } | { kind: "invite-refused" } | { kind: "error"; code: string; message: string } {
  if (!status) return { kind: "none" };
  if (status.error) {
    // 0.1.4 and later: the message already says which failure it was (extension/errors.js).
    if (status.errorCode) return { kind: "error", code: status.errorCode, message: status.error };
    // 0.1.3 sent its own text with no code: show it, and say where it came from.
    return { kind: "error", code: "extension-0.1.3", message: `Challenge Sync couldn\u2019t sign you in: ${status.error}` };
  }
  if (status.inviteRefused) return { kind: "invite-refused" };
  if (status.needsInvite) {
    // 0.1.4 and later say needsInvite only when there is no code (or the server said it got
    // none). Before that it also meant "the server refused the code" and, wrongly, "the host
    // blocked the request"; with a code in the browser those can't be told apart, so say so.
    if (status.inviteRefused === undefined && joinCookie) {
      return { kind: "error", code: "legacy-extension", message: LEGACY_AMBIGUOUS };
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
  // 0.1.4 says it is here at once; its full answer (status) can take a few seconds more.
  const [present, setPresent] = useState(false);
  // The bridge is here but the extension's worker didn't take the hello.
  const [unavailable, setUnavailable] = useState<string | null>(null);
  const [noAnswer, setNoAnswer] = useState(false);
  // The site's own sign-in check was stopped by our host; the app-wide banner says so
  // (components/host-block.tsx) and this page stops asking.
  const [hostBlocked, setHostBlocked] = useState(false);
  // Set once they click "Re-enable": Chrome only runs the extension's bridge on pages loaded after
  // it is switched back on, so this tab needs one reload when they come back to it.
  const [reenabling, setReenabling] = useState(false);

  const answered = status !== null || present;
  useEffect(() => {
    if (answered || !(reenabling || noAnswer)) return;
    const onReturn = () => {
      if (document.visibilityState !== "visible") return;
      if (reenabling || reloadOnceOnReturn()) window.location.reload();
    };
    document.addEventListener("visibilitychange", onReturn);
    return () => document.removeEventListener("visibilitychange", onReturn);
  }, [reenabling, noAnswer, answered]);

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
      sayHello();
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
      const reply = readReply(event);
      if (!reply) return;
      // Any answer at all: the extension is on, so the "Chrome paused it" notice goes, at once.
      window.clearTimeout(noAnswerTimer);
      setNoAnswer(false);
      if (reply.type === "present") {
        setPresent(true);
        return;
      }
      if (reply.type === "unavailable") {
        setUnavailable(reply.error ? `${reply.errorCode}: ${reply.error}` : reply.errorCode);
        return;
      }
      setUnavailable(null);
      const next = reply.status;
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

  const installed = answered;
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
        {!installed && !noAnswer && (
          <p className="auth-intro looking">Looking for the Challenge Sync extension…</p>
        )}
        {unavailable && !status && (
          <div className="notice err" role="alert">
            Challenge Sync is installed but its background worker didn&rsquo;t answer (it may have just updated).
            Reload this page.
            <div className="small sign-in-reason">Reason: {unavailable}</div>
          </div>
        )}

        <ol className="start-steps">
          <Step done={installed} title="Get the Challenge Sync extension">
            <a className="btn start-action" href={EXTENSION_STORE_URL} target="_blank" rel="noreferrer">
              Add to Chrome
            </a>
          </Step>
          <Step done={linkedIn} title={present && !status ? "Checking your LinkedIn sign-in\u2026" : "Log in to LinkedIn in this browser"}>
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
            {problem.message}
            {problem.code === "admin_use_password" && (
              <>
                {" "}
                <a href="/auth/password">Sign in with your email and password</a>
              </>
            )}
            <div className="small sign-in-reason">Reason: {problem.code}</div>
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
