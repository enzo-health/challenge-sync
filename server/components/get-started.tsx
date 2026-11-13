// The signed-out front door. Nobody types a password: the Challenge Sync extension reads who you
// are on LinkedIn and signs you in here. This page says what is still missing and gets out of the
// way the moment the extension has done its part.
//
// It talks to the extension through `extension/bridge.js`, a content script the extension runs on
// this site. The page posts a hello; the bridge answers with what the extension can see. No answer
// means the extension is not installed (or is an old version without the bridge), or that Chrome
// has switched it off — so the page also offers the "Chrome paused it" way back (sync-paused.tsx).
import { useEffect, useState } from "react";
import { EXTENSION_STORE_URL } from "./links";
import { SyncPausedNotice } from "./sync-paused";

type ExtensionStatus = {
  linkedInSignedIn: boolean;
  linked: boolean;
  needsInvite: boolean;
  error: string | null;
};

const POLL_MS = 3000;
// How long the first hello may go unanswered before the page treats the extension as missing.
// A sleeping service worker can take a moment to wake; an installed one answers well inside this.
const NO_ANSWER_MS = 2000;

function Step({ done, title, children }: { done: boolean; title: string; children?: React.ReactNode }) {
  return (
    <li className={done ? "start-step done" : "start-step"}>
      <span className="start-mark" aria-hidden="true">{done ? "✓" : ""}</span>
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
  // Set once they click "Re-enable": Chrome only runs the extension's bridge on pages loaded after
  // it is switched back on, so this tab needs one reload when they come back to it.
  const [reenabling, setReenabling] = useState(false);

  useEffect(() => {
    const timer = window.setTimeout(() => setNoAnswer(true), NO_ANSWER_MS);
    return () => window.clearTimeout(timer);
  }, []);

  useEffect(() => {
    if (!reenabling || status !== null) return;
    const onReturn = () => {
      if (document.visibilityState === "visible") window.location.reload();
    };
    document.addEventListener("visibilitychange", onReturn);
    return () => document.removeEventListener("visibilitychange", onReturn);
  }, [reenabling, status]);

  useEffect(() => {
    let stopped = false;

    const onMessage = (event: MessageEvent) => {
      if (event.source !== window || event.origin !== window.location.origin) return;
      const data = event.data;
      if (!data || data.source !== "challenge-sync-extension") return;
      setStatus({
        linkedInSignedIn: Boolean(data.linkedInSignedIn),
        linked: Boolean(data.linked),
        needsInvite: Boolean(data.needsInvite),
        error: typeof data.error === "string" ? data.error : null,
      });
    };
    window.addEventListener("message", onMessage);

    const tick = async () => {
      window.postMessage({ source: "challenge-sync-page", type: "HELLO" }, window.location.origin);
      try {
        const res = await fetch("/api/auth/me", { credentials: "same-origin" });
        const me = await res.json();
        // Hard load: the session cookie is new, so every cached query is stale.
        if (!stopped && me?.signedIn) window.location.href = "/";
      } catch {
        // Offline or mid-deploy: the next tick tries again.
      }
    };
    tick();
    const timer = window.setInterval(tick, POLL_MS);
    return () => {
      stopped = true;
      window.clearInterval(timer);
      window.removeEventListener("message", onMessage);
    };
  }, []);

  const installed = status !== null;
  const linkedIn = Boolean(status?.linkedInSignedIn);

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

        {installed && linkedIn && status?.needsInvite && (
          <div className="notice err" role="alert">
            You need your company&rsquo;s invite link. Ask whoever runs Challenge Sync at your company for it, open it
            in this browser, and you&rsquo;re in.
          </div>
        )}
        {status?.error && (
          <div className="notice err" role="alert">
            {status.error}
          </div>
        )}
        {installed && linkedIn && !status?.needsInvite && !status?.error && (
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
