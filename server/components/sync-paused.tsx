// The "your stats haven't synced" banner, and the "Chrome paused Challenge Sync" notice.
//
// Extension 0.1.3 asks for access to the new site address, and Chrome turns an extension off on an
// update like that until its owner approves it again. While it is off it neither syncs nor signs
// anyone in. But a member whose last sync is old may just as well have it switched on already, and
// telling them to re-enable it then is wrong. So the signed-in banner first asks the extension, the
// same hello the get-started page sends (extension-bridge.ts), and words itself on the answer:
//
//   still asking (up to NO_ANSWER_MS)  "Checking whether Challenge Sync is running…", no button;
//   no answer                          "Chrome paused Challenge Sync" + Re-enable the extension;
//   answered, 0.1.4, syncing           "Syncing your stats…";
//   answered, LinkedIn logged out      log in to LinkedIn, then Sync now;
//   answered, last attempt failed      what failed (extension/errors.js) and its code, then Sync now;
//   answered, otherwise                "Challenge Sync is on but hasn't synced yet" + Sync now
//                                      (0.1.3 never syncs because of a hello; the popup's
//                                      "Sync now" is the immediate way).
//
// While it shows and the tab is visible, it asks /api/auth/me again on a gentle schedule
// (poll-schedule.ts BANNER_ME_DELAYS_MS), so it goes away by itself soon after a sync lands.
//
// Two places show this file's notices:
//  * every signed-in page (app/layout.tsx), when /api/auth/me says the member's last sync is more
//    than two days old or they have never synced;
//  * the signed-out get-started page (components/get-started.tsx), when the extension does not
//    answer, worded for someone who already had it.
import { useEffect, useState } from "react";
import { useGetMe } from "@linkedin-challenge/client/react-query";
import { EXTENSION_REENABLE_URL } from "./links";
import { type ExtensionStatus, readReply, sayHello } from "./extension-bridge";
import { NO_ANSWER_MS, bannerMeDelay, helloDelay } from "./poll-schedule";

function ReenableButton({ onOpen }: { onOpen?: () => void }) {
  return (
    <a className="btn paused-action" href={EXTENSION_REENABLE_URL} target="_blank" rel="noreferrer" onClick={onOpen}>
      Re-enable the extension
    </a>
  );
}

function PausedBanner({
  title,
  children,
  action,
  state,
}: {
  title: string;
  children: React.ReactNode;
  action?: React.ReactNode;
  state?: string;
}) {
  return (
    <section className="paused-banner" role="alert" data-state={state}>
      <div className="paused-text">
        <p className="paused-title">{title}</p>
        <div className="paused-body">{children}</div>
      </div>
      {action}
    </section>
  );
}

const SYNC_NOW_HINT = "Click the Challenge Sync icon in your browser’s toolbar and press Sync now.";

type Presence =
  | { kind: "checking" }
  | { kind: "absent" }
  | { kind: "unavailable"; code: string }
  | { kind: "present" } // 0.1.4 said it is here; its full answer is on the way
  | { kind: "answered"; status: ExtensionStatus };

/**
 * Whether the extension answers this page, asked only while `active`. Hellos follow the same
 * schedule as the get-started page (helloDelay), only while the tab is visible, and stop at the
 * first answer: one hello is all an answering extension needs. With 0.1.4, while it reports a
 * sync running, it is asked again at the slow end of the schedule to learn how that went (a
 * hello from a signed-in page costs 0.1.4 no network request).
 */
function useExtensionPresence(active: boolean): Presence {
  const [presence, setPresence] = useState<Presence>({ kind: "checking" });

  useEffect(() => {
    if (!active) return;
    let helloTimer: number | undefined;
    let noAnswerTimer: number | undefined;
    let step = 0;
    let answered = false; // a full answer arrived
    let heard = false; // anything arrived
    let followUp = false; // 0.1.4 reported a sync running: ask again later
    const visible = () => document.visibilityState === "visible";

    const hello = () => {
      sayHello({ signedIn: true });
      if (!heard) noAnswerTimer ??= window.setTimeout(() => setPresence({ kind: "absent" }), NO_ANSWER_MS);
    };
    const schedule = () => {
      window.clearTimeout(helloTimer);
      if (!visible()) return;
      if (answered && !followUp) return;
      const delay = followUp ? helloDelay(Number.MAX_SAFE_INTEGER) : helloDelay(step);
      helloTimer = window.setTimeout(() => {
        step += 1;
        hello();
        schedule();
      }, delay);
    };
    const onMessage = (event: MessageEvent) => {
      const reply = readReply(event);
      if (!reply) return;
      heard = true;
      window.clearTimeout(noAnswerTimer);
      if (reply.type === "present") {
        setPresence((p) => (p.kind === "answered" ? p : { kind: "present" }));
        return;
      }
      if (reply.type === "unavailable") {
        setPresence({ kind: "unavailable", code: reply.errorCode });
        return;
      }
      answered = true;
      followUp = reply.status.sync === "running";
      setPresence({ kind: "answered", status: reply.status });
      schedule();
    };
    const onVisibility = () => {
      if (!visible()) {
        window.clearTimeout(helloTimer);
        return;
      }
      if (!answered || followUp) {
        step = 0;
        hello();
      }
      schedule();
    };

    window.addEventListener("message", onMessage);
    document.addEventListener("visibilitychange", onVisibility);
    if (visible()) {
      hello();
      schedule();
    }
    return () => {
      window.clearTimeout(helloTimer);
      window.clearTimeout(noAnswerTimer);
      window.removeEventListener("message", onMessage);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [active]);

  return presence;
}

/** Ask /api/auth/me again on BANNER_ME_DELAYS_MS while `active` and the tab is visible. */
function useGentleRefetch(active: boolean, refetch: () => unknown) {
  useEffect(() => {
    if (!active) return;
    let timer: number | undefined;
    let step = 0;
    const schedule = () => {
      window.clearTimeout(timer);
      if (document.visibilityState !== "visible") return;
      timer = window.setTimeout(() => {
        step += 1;
        void refetch();
        schedule();
      }, bannerMeDelay(step));
    };
    const onVisibility = () => {
      // Coming back is a focus, which React Query already answers with a refetch.
      step = 0;
      schedule();
    };
    document.addEventListener("visibilitychange", onVisibility);
    schedule();
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [active, refetch]);
}

/** Top of every signed-in page while this member's sync has stopped. */
export function SyncPausedBanner() {
  // Same query (and cache entry) as the sidebar.
  const { data, refetch } = useGetMe();
  const me = data?.status === 200 ? data.data : undefined;
  const stale = Boolean(me?.signedIn && me.syncStale);
  const presence = useExtensionPresence(stale);
  useGentleRefetch(stale, refetch);
  // After "Re-enable", this tab has no bridge until it is reloaded (Chrome only runs it in pages
  // loaded after the extension is switched on), so coming back to the tab reloads it.
  const [reenabling, setReenabling] = useState(false);
  useEffect(() => {
    if (!reenabling) return;
    const onReturn = () => {
      if (document.visibilityState === "visible") window.location.reload();
    };
    document.addEventListener("visibilitychange", onReturn);
    return () => document.removeEventListener("visibilitychange", onReturn);
  }, [reenabling]);

  if (!stale) return null;
  const neverSynced = !me?.lastSyncAt;
  const title = neverSynced ? "Your stats haven’t synced yet" : "Your stats haven’t synced in over two days";

  switch (presence.kind) {
    case "checking":
    case "present":
      return (
        <PausedBanner title={title} state="checking">
          Checking whether Challenge Sync is running in this browser&hellip;
        </PausedBanner>
      );
    case "absent":
      return (
        <PausedBanner title="Chrome paused Challenge Sync" state="absent" action={<ReenableButton onOpen={() => setReenabling(true)} />}>
          The extension&rsquo;s permissions changed when we moved to a new address, so Chrome turned it off.
          Re-enable it and your stats will start syncing again.
        </PausedBanner>
      );
    case "unavailable":
      return (
        <PausedBanner title="Challenge Sync didn’t answer" state="unavailable" action={<ReenableButton onOpen={() => setReenabling(true)} />}>
          It is installed, but its background worker didn&rsquo;t answer (it may have just updated). Reload this
          page; if this stays, re-enable the extension.
          <span className="small sign-in-reason"> Reason: {presence.code}</span>
        </PausedBanner>
      );
    case "answered": {
      const s = presence.status;
      if (s.sync === "running") {
        return (
          <PausedBanner title="Syncing your stats…" state="syncing">
            Challenge Sync is on and syncing now. This goes away by itself once it&rsquo;s done, usually within a
            couple of minutes.
          </PausedBanner>
        );
      }
      if (!s.linkedInSignedIn) {
        return (
          <PausedBanner title="Challenge Sync is on, but you’re not logged in to LinkedIn" state="linkedin">
            Log in to LinkedIn in this browser. Then {SYNC_NOW_HINT.charAt(0).toLowerCase() + SYNC_NOW_HINT.slice(1)}
          </PausedBanner>
        );
      }
      const failure = s.error ? { message: s.error, code: s.errorCode } : s.syncError ? { message: s.syncError, code: s.syncErrorCode } : null;
      if (failure) {
        return (
          <PausedBanner title="Challenge Sync is on, but its last sync failed" state="failed">
            {failure.message} {SYNC_NOW_HINT}
            {failure.code && <span className="small sign-in-reason"> Reason: {failure.code}</span>}
          </PausedBanner>
        );
      }
      return (
        <PausedBanner title="Challenge Sync is on but hasn’t synced yet" state="on">
          {SYNC_NOW_HINT}
        </PausedBanner>
      );
    }
  }
}

/** The get-started page's version, for someone whose extension is not answering. */
export function SyncPausedNotice({ onOpen }: { onOpen?: () => void }) {
  return (
    <PausedBanner title="Already had Challenge Sync? Chrome paused it." action={<ReenableButton onOpen={onOpen} />}>
      Its permissions changed when we moved to a new address, so Chrome turned it off. Re-enable it,
      come back here, and you&rsquo;ll be signed in &mdash; no password needed.
    </PausedBanner>
  );
}
