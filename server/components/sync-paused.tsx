// "Chrome paused Challenge Sync": extension 0.1.3 asks for access to the new site address, and
// Chrome turns an extension off on an update like that until its owner approves it again. While
// it is off it neither syncs nor signs anyone in, and the page cannot tell it apart from "not
// installed". This is the one banner that sends people to switch it back on.
//
// Two places show it:
//  * every signed-in page (app/layout.tsx), when /api/auth/me says the member's last sync is more
//    than two days old or they have never synced. It goes away by itself after their next sync.
//  * the signed-out get-started page (components/get-started.tsx), when the extension does not
//    answer, worded for someone who already had it.
import { useGetMe } from "@linkedin-challenge/client/react-query";
import { EXTENSION_REENABLE_URL } from "./links";

function PausedBanner({ title, children, onOpen }: { title: string; children: React.ReactNode; onOpen?: () => void }) {
  return (
    <section className="paused-banner" role="alert">
      <div className="paused-text">
        <p className="paused-title">{title}</p>
        <p className="paused-body">{children}</p>
      </div>
      <a className="btn paused-action" href={EXTENSION_REENABLE_URL} target="_blank" rel="noreferrer" onClick={onOpen}>
        Re-enable the extension
      </a>
    </section>
  );
}

/** Top of every signed-in page while this member's sync has stopped. */
export function SyncPausedBanner() {
  // Same query (and cache entry) as the sidebar, so this costs no extra request. React Query
  // refetches it when the tab regains focus, so the banner clears soon after a sync lands.
  const { data } = useGetMe();
  const me = data?.status === 200 ? data.data : undefined;
  if (!me?.signedIn || !me.syncStale) return null;
  return (
    <PausedBanner title="Chrome paused Challenge Sync">
      The extension&rsquo;s permissions changed when we moved to a new address, so Chrome turned it off.
      Re-enable it and your stats will start syncing again.
    </PausedBanner>
  );
}

/** The get-started page's version, for someone whose extension is not answering. */
export function SyncPausedNotice({ onOpen }: { onOpen?: () => void }) {
  return (
    <PausedBanner title="Already had Challenge Sync? Chrome paused it." onOpen={onOpen}>
      Its permissions changed when we moved to a new address, so Chrome turned it off. Re-enable it,
      come back here, and you&rsquo;ll be signed in &mdash; no password needed.
    </PausedBanner>
  );
}
